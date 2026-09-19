/**
 * Electron main process - zero external services.
 * LLM runs locally via node-llama-cpp loading bundled ./models/model.gguf.
 * No Ollama, no Python, no network services.
 */
const path = require('path');
const fs = require('fs');

// Local modules (pure moves out of this file - no behavior change):
// fixups = deterministic translation pipeline, paths = on-disk locations,
// llm = local GGUF engine. This module keeps Electron, IPC, and orchestration.
const {
  sanitizeModelOutput,
  tokenizeArgs,
  fixupArgs,
  fixupInput,
  fixupLastTrim,
  fixupSizeLimit,
  fixupConflicts,
  ensureOutputFile,
  parseSizeLimit,
  parseHMS,
  quoteArgs,
  ffmpegFailureHint,
} = require('./fixups');
const {
  resolveModelPath,
  userDataModelsDir,
  appDataModelsDir,
  isPortableLaunch,
  portableFallbackActive,
  portableDataDir,
  dropsDir,
  msvcRuntimeStatus,
  isMsvcMissingError,
  msvcMissingHint,
  MSVC_DLLS,
  MSVC_DOWNLOAD_URL,
  defaultOutputPath,
  enforceOutputExtension,
} = require('./paths');
const {
  SYSTEM_PROMPT,
  isLlamaLoading,
  hasLlamaSession,
  getLlamaLoadError,
  llamaDiagnostics,
  llamaDiagSummary,
  getLlamaSession,
} = require('./llm');

// Electron is only fully available inside the Electron runtime. Keep this module
// require-safe (headless smoke tests) by degrading gracefully outside Electron.
let app = null;
let BrowserWindow = null;
let ipcMain = null;
let dialog = null;
let shell = null;
let Menu = null;
let isElectron = false;
try {
  const electron = require('electron');
  app = electron.app;
  BrowserWindow = electron.BrowserWindow;
  ipcMain = electron.ipcMain;
  dialog = electron.dialog;
  shell = electron.shell;
  Menu = electron.Menu;
  isElectron = !!(app && typeof app.whenReady === 'function' && process.versions && process.versions.electron);
} catch { /* plain Node (smoke tests): helpers below still work */ }

// Portable self-containment: a portable run keeps EVERYTHING next to the
// exe (model, Electron profile, drop imports) so deleting the folder leaves
// no trace. paths.js captured the real per-user data dir before this
// redirect. Must run before app.ready.
try {
  const base = portableDataDir();
  if (base && isElectron && app && typeof app.setPath === 'function') {
    app.setPath('userData', path.join(base, 'user-data'));
    try { app.setPath('sessionData', path.join(base, 'user-data')); } catch { /* older Electron */ }
  }
} catch { /* keep Electron defaults */ }

let ffmpegPath;
try {
  const rawFfmpegPath = require('ffmpeg-static');
  // Packaged apps extract the binary next to the asar (see build.asarUnpack),
  // but child_process.spawn cannot execute inside an asar archive - rewrite.
  // No-op in dev (no app.asar segment in the path).
  ffmpegPath = String(rawFfmpegPath || '').replace('app.asar', 'app.asar.unpacked');
} catch (e) {
  console.error('[main] ffmpeg-static not available:', e.message);
  ffmpegPath = null;
}

// ---------------------------------------------------------------------------
// Paths and model locations (see paths.js)
// ---------------------------------------------------------------------------

// (Moved to paths.js: resolveModelPath, userDataModelsDir, appDataModelsDir,
// isPortableLaunch, portableFallbackActive, portableDataDir, dropsDir -
// imported above and re-exported below to preserve the module contract.)

// (Moved to llm.js: llama session state, isLlamaLoading, llamaDiagnostics,
// llamaPrebuiltProbe, llamaDiagSummary, getLlamaSession - imported above and
// re-exported below to preserve the module contract.)

function notifyRenderer(line) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ffmpeg-log', { line });
    }
  } catch { /* window not ready yet */ }
}

// (Moved to llm.js and paths.js: llamaDiagnostics, existsSyncSafe,
// MSVC_DLLS, MSVC_DOWNLOAD_URL, msvcRuntimeStatus, msvcMissingHint,
// isMsvcMissingError, llamaPrebuiltProbe, llamaDiagSummary, getLlamaSession.)

// First-launch model fetch (thin installer): resumable download into the
// resolved model path with progress events to the renderer. Concurrent calls
// share one flight. Errors are returned, never thrown to the UI as a crash.
let modelDownloadPromise = null;

async function handleDownloadModel(event, payload) {
  if (modelDownloadPromise) return modelDownloadPromise;
  modelDownloadPromise = (async () => {
    // Consent gate: a portable that cannot write next to its exe would store
    // 1.3 GB in app data, where deleting the portable folder leaves it
    // behind. That write needs explicit confirmation - refuse without it.
    const consent = !!(payload && payload.consent);
    let dest = resolveModelPath();
    if (isPortableLaunch() && portableDataDir() === null) {
      const appData = appDataModelsDir();
      const fallbackDest = appData ? path.join(appData, 'model.gguf') : dest;
      if (!consent) {
        return {
          ok: false,
          needsConsent: true,
          dest: fallbackDest,
          error: 'Portable folder is not writable - storing the model in app data needs confirmation.',
        };
      }
      dest = fallbackDest;
    }
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* ignore */ }
    const sender = event && event.sender;
    const emit = (payload) => {
      try {
        if (sender && !sender.isDestroyed()) sender.send('model-download-progress', payload);
      } catch { /* window closed */ }
    };
    let downloader;
    try {
      // Shipped inside the packaged app (see package.json build.files).
      downloader = require(path.join(__dirname, '..', 'scripts', 'download-model.js'));
    } catch (e) {
      throw new Error('model downloader not available in this install.');
    }
    const onProgress = ({ done, total }) => emit({
      state: 'downloading',
      done,
      total,
      pct: total > 0 ? Math.min(99, (done / total) * 100) : null,
    });
    let lastErr = null;
    for (const url of downloader.SOURCES) {
      try {
        emit({ state: 'downloading', url, done: 0, total: 0, pct: null });
        const { bytes } = await downloader.downloadTo(url, dest, { onProgress, expectMagic: 'GGUF' });
        if (bytes < (downloader.MIN_BYTES || 0)) {
          throw new Error(`downloaded file smaller than expected (${bytes} bytes).`);
        }
        emit({ state: 'complete', done: bytes, total: bytes, pct: 100 });
        modelStatCache = { at: 0, path: null, exists: false, size: 0 };
        preloadLlm(); // warm the engine so the badge flips to ready on its own
        return { ok: true, path: dest, size: bytes };
      } catch (err) {
        lastErr = err;
      }
    }
    const message = lastErr && lastErr.message ? lastErr.message : String(lastErr);
    console.error('[main] model download failed:', message);
    emit({ state: 'error', error: message });
    return { ok: false, error: message };
  })();
  try {
    return await modelDownloadPromise;
  } finally {
    modelDownloadPromise = null;
  }
}

// Fire-and-forget background preload at boot: the window is already up, so
// the user can pick a video and type while the ~GB model loads underneath.
// A translation requested mid-load simply awaits the same promise.
function preloadLlm() {
  getLlamaSession().then(
    () => notifyRenderer('LLM ready in the background - translations start instantly.'),
    (err) => {
      const message = err && err.message ? err.message : String(err);
      console.error('[main] background LLM preload failed:', message);
      if (isMsvcMissingError(err)) {
        const hint = msvcMissingHint();
        console.error('[main] ' + hint);
        notifyRenderer(`LLM background load failed: ${message}.`);
        notifyRenderer(hint + ' See logs below for details.');
      } else {
        notifyRenderer(`LLM background load failed: ${message} - will retry on next translation. See logs below for details.`);
      }
    }
  );
}

// (Moved to fixups.js: sanitizeModelOutput, looksLikeFileToken,
// ensureOutputFile, tokenizeArgs, P_HEIGHTS, fixupArgs, quoteArgs,
// fixupInput - imported above and re-exported below.)

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;

// Platform-aware app icon: .ico on Windows (taskbar/title), PNG elsewhere.
function appIcon() {
  try {
    const ico = path.join(__dirname, '..', 'assets', 'icon.ico');
    const png = path.join(__dirname, '..', 'assets', 'logo.png');
    if (process.platform === 'win32' && fs.existsSync(ico)) return ico;
    if (fs.existsSync(png)) return png;
  } catch { /* ignore */ }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 800,
    title: 'PlainFFmpeg',
    backgroundColor: '#16130f',
    autoHideMenuBar: true,
    frame: false,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // No File/Edit/View menu bar.
  try {
    mainWindow.setMenu(null);
  } catch { /* ignore */ }
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Electron bootstrap + IPC - skipped when required in plain Node (smoke tests).
if (isElectron) {
  // Remove the default application menu (File, Edit, View, ...) entirely.
  try {
    if (Menu) Menu.setApplicationMenu(null);
  } catch { /* ignore */ }
  app.whenReady().then(() => {
    createWindow();
    // Window first (instant UI), LLM right after in the background.
    preloadLlm();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
let modelStatCache = { at: 0, path: null, exists: false, size: 0 };

function handleModelStatus() {
  const modelPath = resolveModelPath();
  // The badge polls every few seconds; a stat per poll is cheap but
  // pointless, so cache briefly. Reset on successful downloads below.
  const now = Date.now();
  let exists = false;
  let size = 0;
  if (modelStatCache.path !== modelPath || now - modelStatCache.at > 5000) {
    try {
      const st = fs.statSync(modelPath);
      exists = st.isFile() && st.size > 1024;
      size = st.size;
    } catch { exists = false; }
    modelStatCache = { at: now, path: modelPath, exists, size };
  } else {
    ({ exists, size } = modelStatCache);
  }
  let llamaAvailable = false;
  try {
    require.resolve('node-llama-cpp');
    llamaAvailable = true;
  } catch { llamaAvailable = false; }
  const loading = isLlamaLoading();
  const hasSession = hasLlamaSession();
  const loadError = getLlamaLoadError();
  const ready = exists && llamaAvailable && hasSession;
  let msvc = null;
  try { msvc = msvcRuntimeStatus(); } catch { msvc = null; }
  const failed = exists && !hasSession && loadError && !loading;
  const msvcMissing = !!(failed && isMsvcMissingError(loadError));
  let engine;
  if (ready) engine = 'node-llama-cpp (local GGUF)';
  else if (!exists) engine = 'LLM unavailable';
  else if (loading) engine = 'Loading LLM engine locally…';
  else if (failed) engine = 'LLM failed to load';
  else engine = 'LLM not loaded';
  return {
    modelPath,
    exists,
    size,
    llamaAvailable,
    loading,
    loadError,
    loadErrorKind: !failed ? null : (msvcMissing ? 'msvc-missing' : 'load-failed'),
    msvc,
    ffmpegPath: ffmpegPath || null,
    engine,
    ready,
    portable: isPortableLaunch(),
    fallbackToAppData: portableFallbackActive(),
  };
}

async function handleTranslatePrompt({ instruction, inputFile, duration }) {
  const durLine = duration && duration > 0 ? `Input duration: ${duration} seconds.\n` : '';
  // Size-limit math, done deterministically so the model only has to apply it:
  // video bitrate that fits <limit> bytes into <duration> seconds.
  let sizeLine = '';
  const sizeBytes = parseSizeLimit(instruction);
  if (sizeBytes && duration > 0) {
    const audioBits = 128000;
    const vk = Math.floor(Math.max(100000, Math.floor((sizeBytes * 8 * 0.98) / duration - audioBits)) / 1000);
    sizeLine = `Size limit: ${(sizeBytes / 1024 ** 3 >= 1
      ? `${+(sizeBytes / 1024 ** 3).toFixed(2)}GB`
      : `${+(sizeBytes / 1024 ** 2).toFixed(1)}MB`)} max for this ${duration}s video. ` +
      `Encode video at about ${vk}k: use exactly -b:v ${vk}k -maxrate ${vk}k -bufsize ${vk * 2}k, ` +
      `audio -c:a aac -b:a 128k, single pass only.\n`;
  }
  const userPrompt = `Input file: ${inputFile || 'input.mp4'}\n${durLine}${sizeLine}Task: ${instruction || ''}\nFFmpeg args:\n/no_think`;
  // No silent fallback: any LLM problem is returned as an error so the UI
  // can alert the user instead of running a guessed-up command.
  try {
    if (isLlamaLoading()) {
      notifyRenderer('LLM is still loading in the background - holding your translation until it is ready…');
    }
    const session = await getLlamaSession();
    const raw = await session.prompt(userPrompt, {
      maxTokens: 256,
      temperature: 0.1,
    });
    const cleaned = sanitizeModelOutput(raw);
    if (!cleaned) throw new Error('LLM returned empty output.');
    const tokens = tokenizeArgs(cleaned, inputFile);
    const fixed = fixupArgs(tokens);
    const withInput = fixupInput(fixed.args, inputFile);
    const withConflicts = fixupConflicts(withInput.args, instruction);
    // Output placeholder first: trim/size insertions slot in before the
    // trailing output token, which keeps flag/value pairs adjacent.
    const withOutput = ensureOutputFile(withConflicts.args, instruction);
    const withTrim = fixupLastTrim(withOutput.args, instruction, duration);
    const withSize = fixupSizeLimit(withTrim.args, instruction, duration);
    const args = withSize.args;
    const corrections = fixed.corrections.concat(
      withInput.corrections, withConflicts.corrections, withOutput.corrections, withTrim.corrections,
      withSize.corrections
    );
    return {
      ok: true,
      engine: 'node-llama-cpp',
      raw,
      argsString: quoteArgs(args),
      args,
      corrections,
    };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[main] LLM translate failed:', message);
    let diag = '';
    try {
      notifyRenderer('LLM diagnostics: ' + JSON.stringify(await llamaDiagnostics()));
      diag = await llamaDiagSummary();
    } catch { /* diagnostics must never break error reporting */ }
    if (isMsvcMissingError(err)) {
      const hint = msvcMissingHint();
      console.error('[main] ' + hint);
      try { notifyRenderer(hint + ' See logs below for details.'); } catch { /* window closed */ }
      return {
        ok: false,
        engine: 'node-llama-cpp',
        error: message,
        diag,
        errorKind: 'msvc-missing',
        hint,
      };
    }
    return {
      ok: false,
      engine: 'node-llama-cpp',
      error: message,
      diag,
      errorKind: 'load-failed',
    };
  }
}

function validWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function handleWindowMin() {
  const w = validWindow();
  if (w) w.minimize();
}

function handleWindowMax() {
  const w = validWindow();
  if (!w) return false;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
  return w.isMaximized();
}

function handleWindowClose() {
  const w = validWindow();
  if (w) w.close();
}

async function handlePickFile() {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
}

// (Moved to paths.js: defaultOutputPath - imported above and re-exported below.)

async function handlePickOutput({ defaultPath, extension } = {}) {
  const filters = [{ name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'gif', 'mp3'] }];
  // Put the translated container first: the save dialog auto-appends the
  // selected filter's extension when the user omits one.
  const ext = String(extension || '').replace(/^\./, '').toLowerCase();
  if (ext) filters.unshift({ name: `Video (*.${ext})`, extensions: [ext] });
  filters.push({ name: 'All files', extensions: ['*'] });
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath || undefined,
    filters,
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
}

function handleOutputExists(outputPath) {
  try {
    return !!outputPath && fs.existsSync(outputPath) && fs.statSync(outputPath).isFile();
  } catch {
    return false;
  }
}

// Reveal a directory in the OS file manager (the "Open folder" button).
// The directory must exist - use the output's parent dir, not the file.
async function handleOpenPath({ dirPath } = {}) {
  const dir = String(dirPath || '');
  if (!dir) throw new Error('No folder to open yet.');
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw new Error(`Folder not found: ${dir}`);
  if (!shell || typeof shell.openPath !== 'function') {
    throw new Error('OS file manager unavailable in this context.');
  }
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return { ok: true, dir };
}

// Pathless drag import: when the OS exposes file bytes but no path,
// the renderer sends the bytes and we materialize a temp copy.
async function handleSaveDroppedFile({ name, buffer } = {}) {
  if (!buffer || buffer.byteLength === 0) throw new Error('Empty dropped file.');
  // Same 500 MB cap as the renderer's importPathlessDrop - direct IPC callers
  // bypass the renderer check, so the main process enforces it too.
  const MAX_DROP_BYTES = 500 * 1024 * 1024;
  if (buffer.byteLength > MAX_DROP_BYTES) {
    throw new Error(`Dropped file too large (${(buffer.byteLength / 1048576).toFixed(0)} MB) - 500 MB max.`);
  }
  const dir = dropsDir();
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'dropped-video').replace(/[^\w.\-() ]+/g, '_').slice(-120) || 'dropped-video';
  const target = path.join(dir, safe);
  fs.writeFileSync(target, Buffer.from(buffer));
  return target;
}

// (Moved to paths.js: enforceOutputExtension. Moved to fixups.js: parseHMS,
// ffmpegFailureHint, parseTimeVal, fmtSec, parseSizeLimit, parseBitrateBps,
// fixupSizeLimit, fixupLastTrim, fixupConflicts - all imported above.)

// Quick media probe via `ffmpeg -i` (no ffprobe dependency): duration,
// resolution. Used to display file info and to resolve "last N seconds".
async function probeMedia(inputFile) {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not available.');
  if (!inputFile) throw new Error('No input file to probe.');
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', inputFile], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error('probe timed out'));
    }, 20000);
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', () => {
      clearTimeout(timer);
      // `ffmpeg -i` with no output always exits nonzero - parse anyway.
      const dur = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (!dur) {
        reject(new Error('Could not probe media (no Duration found). Is this a video file?'));
        return;
      }
      const vid = stderr.match(/Stream[^:]*:.*Video:.*?(\d{2,5})x(\d{2,5})/);
      resolve({
        duration: parseHMS(dur[1], dur[2], dur[3]),
        width: vid ? parseInt(vid[1], 10) : null,
        height: vid ? parseInt(vid[2], 10) : null,
      });
    });
  });
}

async function handleRunFfmpeg(event, { args, outputFile }) {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not available.');
  if (!Array.isArray(args) || args.length === 0) throw new Error('No FFmpeg args provided.');

  const sender = event && event.sender;
  if (!sender || typeof sender.send !== 'function') {
    throw new Error('run-ffmpeg must be called from the app window.');
  }
  const emit = (channel, payload) => {
    try { sender.send(channel, payload); } catch { /* window closed */ }
  };

  // Spawn the binary directly so arbitrary LLM flags run verbatim,
  // while streaming logs to the renderer.
  const { spawn } = require('child_process');
  let finalArgs = [...args];
  if (outputFile) {
    // Replace trailing non-flag token (output path) with explicit outputFile.
    const last = finalArgs[finalArgs.length - 1];
    if (last && !last.startsWith('-')) finalArgs[finalArgs.length - 1] = outputFile;
    else finalArgs.push(outputFile);
  }
  // -y keeps non-interactive runs from hanging on an overwrite prompt;
  // user consent is gathered beforehand via the overwrite dialog.
  if (!finalArgs.includes('-y') && !finalArgs.includes('-n')) finalArgs.unshift('-y');
  // Enforce the translated container extension on the chosen destination.
  const enforced = enforceOutputExtension(finalArgs[finalArgs.length - 1], finalArgs);
  if (enforced.changed) {
    emit('ffmpeg-log', { line: `output extension follows the command: ${finalArgs[finalArgs.length - 1]} → ${enforced.path}` });
    finalArgs[finalArgs.length - 1] = enforced.path;
  }
  const output = finalArgs[finalArgs.length - 1];

  await new Promise((resolve, reject) => {
    emit('ffmpeg-log', { line: `$ ${ffmpegPath} ${finalArgs.join(' ')}` });
    emit('ffmpeg-progress', { pct: 0 });
    const proc = spawn(ffmpegPath, finalArgs, { windowsHide: true });
    let stderr = '';
    let totalSec = 0;
    proc.stderr.on('data', (d) => {
      const line = d.toString();
      stderr += line;
      for (const l of line.split('\n')) {
        if (l.trim()) emit('ffmpeg-log', { line: l.trim() });
        // Total duration appears once in the header: "Duration: 00:00:27.49, ..."
        const dur = l.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        if (dur && !totalSec) totalSec = parseHMS(dur[1], dur[2], dur[3]);
        const m = l.match(/time=(\d+):(\d+):([\d.]+)/);
        if (m) {
          if (totalSec > 0) {
            const pct = Math.min(99, (parseHMS(m[1], m[2], m[3]) / totalSec) * 100);
            emit('ffmpeg-progress', { pct, raw: l.trim() });
          } else {
            emit('ffmpeg-progress', { raw: l.trim() });
          }
        }
      }
    });
    proc.stdout.on('data', (d) => emit('ffmpeg-log', { line: d.toString().trim() }));
    proc.on('error', (e) => {
      emit('ffmpeg-log', { line: `ERROR: ${e.message}` });
      reject(e);
    });
    proc.on('close', (code) => {
      emit('ffmpeg-log', { line: `ffmpeg exited with code ${code}` });
      emit('ffmpeg-progress', { done: true, code });
      if (code === 0) resolve();
      else {
        const hint = ffmpegFailureHint(stderr);
        reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-2000)}${hint ? `\n\n${hint}` : ''}`));
      }
    });
  });

  return { ok: true, output };
}

if (isElectron && ipcMain) {
  ipcMain.handle('model-status', async () => handleModelStatus());
  ipcMain.handle('translate-prompt', async (_e, payload) => handleTranslatePrompt(payload || {}));
  ipcMain.handle('download-model', async (event, payload) => handleDownloadModel(event, payload || {}));
  ipcMain.handle('pick-file', async () => handlePickFile());
  ipcMain.handle('pick-output', async (_e, payload) => handlePickOutput(payload || {}));
  ipcMain.handle('output-exists', async (_e, outputPath) => handleOutputExists(outputPath));
  ipcMain.handle('save-dropped-file', async (_e, payload) => handleSaveDroppedFile(payload || {}));
  ipcMain.handle('open-path', async (_e, payload) => handleOpenPath(payload || {}));
  ipcMain.handle('window-min', async () => handleWindowMin());
  ipcMain.handle('window-max', async () => handleWindowMax());
  ipcMain.handle('window-close', async () => handleWindowClose());
  ipcMain.handle('probe-media', async (_e, inputFile) => probeMedia(inputFile));
  ipcMain.handle('run-ffmpeg', async (event, payload) => handleRunFfmpeg(event, payload || {}));
}

module.exports = {
  // Module contract: orchestration above plus the split modules' members.
  // userDataModelsDir, MSVC_DLLS, MSVC_DOWNLOAD_URL, defaultOutputPath and
  // SYSTEM_PROMPT are imported solely for re-export (see header comment).
  sanitizeModelOutput,
  tokenizeArgs,
  fixupArgs,
  fixupInput,
  fixupLastTrim,
  fixupSizeLimit,
  fixupConflicts,
  ensureOutputFile,
  parseSizeLimit,
  probeMedia,
  handleRunFfmpeg,
  enforceOutputExtension,
  resolveModelPath,
  userDataModelsDir,
  appDataModelsDir,
  portableDataDir,
  isPortableLaunch,
  portableFallbackActive,
  dropsDir,
  handleDownloadModel,
  defaultOutputPath,
  handleModelStatus,
  handleTranslatePrompt,
  handleOutputExists,
  handleSaveDroppedFile,
  handleOpenPath,
  llamaDiagnostics,
  llamaDiagSummary,
  msvcRuntimeStatus,
  isMsvcMissingError,
  msvcMissingHint,
  MSVC_DLLS,
  MSVC_DOWNLOAD_URL,
  ffmpegFailureHint,
  handleWindowMin,
  handleWindowMax,
  handleWindowClose,
  SYSTEM_PROMPT,
};
