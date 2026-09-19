/**
 * Electron main process - zero external services.
 * LLM runs locally via node-llama-cpp loading bundled ./models/model.gguf.
 * No Ollama, no Python, no network services.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// Electron is only fully available inside the Electron runtime. Keep this module
// require-safe (headless smoke tests) by degrading gracefully outside Electron.
let app = null;
let BrowserWindow = null;
let ipcMain = null;
let dialog = null;
let Menu = null;
let isElectron = false;
try {
  const electron = require('electron');
  app = electron.app;
  BrowserWindow = electron.BrowserWindow;
  ipcMain = electron.ipcMain;
  dialog = electron.dialog;
  Menu = electron.Menu;
  isElectron = !!(app && typeof app.whenReady === 'function' && process.versions && process.versions.electron);
} catch { /* plain Node (smoke tests): helpers below still work */ }

let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch (e) {
  console.error('[main] ffmpeg-static not available:', e.message);
  ffmpegPath = null;
}

let fluentFfmpeg = null;
try {
  fluentFfmpeg = require('fluent-ffmpeg');
  if (ffmpegPath) fluentFfmpeg.setFfmpegPath(ffmpegPath);
} catch (e) {
  console.error('[main] fluent-ffmpeg not available:', e.message);
}

// ---------------------------------------------------------------------------
// Local LLM engine (node-llama-cpp, lazy init)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = [
  'You are an expert FFmpeg command translator. Convert the user request into FFmpeg command-line arguments.',
  '',
  'OUTPUT FORMAT (strict):',
  '- Output ONLY the FFmpeg arguments, as a single line of plain text.',
  '- NEVER include markdown, code fences, backticks, explanations, or commentary.',
  '- NEVER include the `ffmpeg` binary name - start directly with flags (usually `-i`).',
  '- Exactly ONE command. No pipes, no `&&`, no shell operators, no comments.',
  '- Always answer directly in non-thinking mode: NO thinking trace, NO <think> blocks.',
  '- A trailing `/no_think` marker on the request means the same - obey it.',
  '',
  'INPUT:',
  '- Always include the input exactly once, verbatim, as `-i <INPUT FILE PATH>` using the exact path from the user message.',
  '- If the path contains spaces, wrap it in double quotes.',
  '- Never invent, rename, shorten, or alter the input path. Never fall back to placeholders like input.mp4 when a real path was given.',
  '',
  'OUTPUT FILE (always the last token):',
  '- Always end with exactly one output file path.',
  '- Its extension must match the requested container: .mp4, .mkv, .webm, .mov, .avi, .gif, .mp3.',
  '- If no output name is requested, derive it from the input name (e.g. input "clip.mp4" → "clip-out.mkv").',
  '',
  'TIME AND TRIMMING (input duration in seconds is given when known):',
  '- Time values: plain seconds (90) or HH:MM:SS (00:01:30). Do any arithmetic yourself and output the resulting numbers.',
  '- "trim/cut the FIRST N seconds" (keep the head): `-t N`.',
  '- "trim/cut/remove/delete the LAST N seconds" (cut the tail off, keep the head): `-t (duration - N)`.',
  '- "keep/extract only the LAST N seconds" (keep the tail): `-ss (duration - N)` with NO `-t`.',
  '- "keep from second A to second B": `-ss A -t (B - A)`.',
  '- Place -ss/-t AFTER the -i flag (accurate seeking).',
  '- Never emit -ss and -t values that contradict the request (e.g. -ss 0 with -t 5 when asked for the last 5 seconds).',
  '',
  'SIZE AND RESOLUTION:',
  '- Frame sizes must be WIDTHxHEIGHT (e.g. 640x360) or a scale filter.',
  '- Resolution shorthands map to even-width scale filters: 144p→scale=-2:144, 240p→scale=-2:240, 360p→scale=-2:360, 480p→scale=-2:480, 720p→scale=-2:720, 1080p→scale=-2:1080, 2160p→scale=-2:2160.',
  '- NEVER output bare sizes like `-s 360p`, `-video_size 720p`, or `scale=720p` - ffmpeg rejects them with "Invalid frame size".',
  '- Use one -vf flag per stream; join multiple video filters with commas.',
  '',
  'CONTAINERS AND CODECS:',
  '- mp4/mov: `-c:v libx264 -c:a aac`, plus `-movflags +faststart` for mp4/mov.',
  '- mkv: `-c:v libx264 -c:a aac` (or `-c:a copy` if the audio is untouched).',
  '- webm: `-c:v libvpx-vp9 -c:a libopus`. NEVER libvpx+libvorbis.',
  '- gif: `-vf "fps=10,scale=480:-1:flags=lanczos"` and NO audio stream.',
  '- mp3 or audio-only: `-vn -c:a libmp3lame`.',
  '- Audio untouched: prefer `-c:a copy`. Mute/remove audio: `-an` (never combine `-an` with an audio codec).',
  '- Grayscale / black-and-white: `-vf hue=s=0`.',
  '',
  'SIZE LIMITS (e.g. "keep it below 2GB", "under 500MB"):',
  '- A size limit with a known duration is ALWAYS enforced with single-pass capped bitrate.',
  '- When the user message states exact numbers ("encode video at about Xk"), apply them verbatim as `-b:v Xk -maxrate Xk -bufsize 2Xk`.',
  '- Keep audio at or below 128k (`-c:a aac -b:a 128k`); use `-an` only if asked; never `-c:a copy` under a size limit.',
  '- NEVER use two-pass (-pass 1 / -pass 2): the runner executes a single ffmpeg command. Single pass with -maxrate is the only option.',
  '',
  'EXAMPLES (each answer is ONE single line ending with the output file):',
  '- "Convert /tmp/in.mp4 (duration 27.49s) to mkv, cut the last 5 seconds, make it 360p" → -i /tmp/in.mp4 -t 22.49 -vf scale=-2:360 -c:v libx264 -c:a aac /tmp/in-out.mkv',
  '- "Convert /tmp/in.mp4 to webm and mute it" → -i /tmp/in.mp4 -c:v libvpx-vp9 -an /tmp/in-out.webm',
  '- "Extract the audio of /tmp/in.mp4 as mp3" → -i /tmp/in.mp4 -vn -c:a libmp3lame /tmp/in-out.mp3',
  '- "Convert /tmp/in.mp4 (duration 60s) to 1080p mp4 below 100MB" → -i /tmp/in.mp4 -vf scale=-2:1080 -c:v libx264 -b:v 13573k -maxrate 13573k -bufsize 27146k -c:a aac -b:a 128k -movflags +faststart /tmp/in-out.mp4',
].join('\n');

function resolveModelPath() {
  // MODEL_PATH env override (custom location; also used by smoke tests).
  if (process.env.MODEL_PATH) return process.env.MODEL_PATH;
  // Packaged installs cannot write inside app.asar - the model lives in the
  // per-user data dir there (and first-launch downloads go to it as well).
  const names = [
    'model.gguf',
    'Qwen_Qwen3-1.7B-Q4_K_M.gguf',
    'Qwen3-1.7B-Q4_K_M.gguf',
    // Previous generation - keep working for users who already downloaded it.
    'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf',
  ];
  const dirs = [];
  const userDir = userDataModelsDir();
  if (userDir) dirs.push(userDir);
  dirs.push(path.join(__dirname, '..', 'models'));
  try {
    // app.getAppPath() only exists inside Electron runtime
    if (isElectron && app && typeof app.getAppPath === 'function') {
      const appPath = app.getAppPath();
      if (appPath) dirs.push(path.join(appPath, 'models'));
    }
  } catch { /* ignore: required outside Electron (smoke tests) */ }
  for (const d of dirs) {
    for (const n of names) {
      try {
        const p = path.join(d, n);
        if (fs.existsSync(p) && fs.statSync(p).size > 1024) return p;
      } catch { /* ignore */ }
    }
  }
  return path.join(dirs[0], names[0]);
}

// Writable per-user models dir for packaged installs (null in plain Node).
function userDataModelsDir() {
  try {
    if (isElectron && app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'models');
    }
  } catch { /* ignore */ }
  return null;
}

let llamaInitPromise = null;
let llamaSession = null;
let llamaSequence = null;
let llamaModel = null;
let llamaContext = null;
let llamaLoadError = null;

function isLlamaLoading() {
  return llamaSession === null && llamaInitPromise !== null;
}

function notifyRenderer(line) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ffmpeg-log', { line });
    }
  } catch { /* window not ready yet */ }
}

// Snapshot of everything the LLM load depends on: runtime ABIs, model file,
// and the on-disk native binary packages. Never throws - meant to turn
// "it doesn't load" into a pasteable answer.
async function llamaDiagnostics() {
  const d = { ok: !!llamaSession };
  try { d.node = process.versions.node || null; } catch { d.node = null; }
  try { d.modules = process.versions.modules || null; } catch { d.modules = null; }
  try { d.electron = (process.versions && process.versions.electron) || null; } catch { d.electron = null; }
  try { d.insideAsar = __filename.includes('.asar'); } catch { d.insideAsar = null; }
  try {
    const mp = resolveModelPath();
    d.modelPath = mp;
    try {
      const st = fs.statSync(mp);
      d.modelExists = st.isFile();
      d.modelSize = st.size;
    } catch { d.modelExists = false; d.modelSize = 0; }
  } catch (e) { d.modelError = String((e && e.message) || e); }
  try { d.llamaResolved = require.resolve('node-llama-cpp'); }
  catch (e) { d.llamaResolveError = String((e && e.message) || e); }
  try {
    // Works both dev (src/../node_modules) and packaged (app.asar/node_modules).
    const binsRoot = path.join(__dirname, '..', 'node_modules', '@node-llama-cpp');
    d.binsPkgs = fs.readdirSync(binsRoot);
  } catch (e) { d.binsError = String((e && e.message) || e); }
  try {
    const llamaDir = path.join(__dirname, '..', 'node_modules', 'node-llama-cpp', 'llama');
    d.llamaDir = fs.readdirSync(llamaDir).slice(0, 25);
  } catch (e) { d.llamaDirError = String((e && e.message) || e); }
  d.prebuilt = await llamaPrebuiltProbe();
  return d;
}

function existsSyncSafe(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// Replicates the loader's own lookup step by step: dynamic-import the
// platform bins package, read getBinsDir(), and check the binding binary in
// both the asar and the unpacked location. Whatever link breaks in a
// packaged app shows up here as false.
async function llamaPrebuiltProbe() {
  const out = { importOk: false };
  try {
    const plat = process.platform === 'win32' ? 'win-x64'
      : process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
        : (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64');
    out.package = `@node-llama-cpp/${plat}`;
    const mod = await import(`@node-llama-cpp/${plat}`);
    const { binsDir, packageVersion } = (mod && mod.getBinsDir && mod.getBinsDir()) || {};
    out.importOk = true;
    out.binsDir = binsDir || null;
    out.packageVersion = packageVersion || null;
    out.folders = {};
    let subs = [];
    try { subs = binsDir ? fs.readdirSync(binsDir) : []; }
    catch (e) { out.binsError = String((e && e.message) || e); }
    for (const sub of subs.slice(0, 10)) {
      const asarNode = path.join(binsDir, sub, 'llama-addon.node');
      const unpNode = asarNode.split('.asar' + path.sep).join('.asar.unpacked' + path.sep);
      const asarMeta = path.join(binsDir, sub, '_nlcBuildMetadata.json');
      const unpMeta = asarMeta.split('.asar' + path.sep).join('.asar.unpacked' + path.sep);
      out.folders[sub] = {
        nodeInAsar: existsSyncSafe(asarNode),
        nodeUnpacked: existsSyncSafe(unpNode),
        metaInAsar: existsSyncSafe(asarMeta),
        metaUnpacked: existsSyncSafe(unpMeta),
      };
    }
  } catch (e) {
    out.importError = String((e && e.message) || e);
  }
  return out;
}

async function llamaDiagSummary() {
  try {
    const d = await llamaDiagnostics();
    const bins = Array.isArray(d.binsPkgs) ? d.binsPkgs.join(',') : 'none';
    return `node=${d.node || '?'} modules=${d.modules || '?'} electron=${d.electron || 'n/a'} ` +
      `model=${d.modelExists ? d.modelSize + 'B' : 'missing'} bins=[${bins}]`;
  } catch { return 'diagnostics unavailable'; }
}

async function getLlamaSession() {
  if (llamaSession) return llamaSession;
  if (llamaInitPromise) return llamaInitPromise;

  llamaInitPromise = (async () => {
    const modelPath = resolveModelPath();
    if (!fs.existsSync(modelPath)) {
      throw new Error(
        `Model file not found at ${modelPath}. Run "npm run download-model" first.`
      );
    }
    // node-llama-cpp v3 is pure ESM ("type": "module"), so it cannot be
    // require()d from this CommonJS main process - dynamic import() works
    // everywhere, including inside Electron's main process.
    const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    const llama = await getLlama();
    llamaModel = await llama.loadModel({ modelPath });
    llamaContext = await llamaModel.createContext();
    llamaSequence = llamaContext.getSequence();
    llamaSession = new LlamaChatSession({
      contextSequence: llamaSequence,
      systemPrompt: SYSTEM_PROMPT,
    });
    console.log('[main] node-llama-cpp model loaded:', modelPath);
    return llamaSession;
  })();

  try {
    const session = await llamaInitPromise;
    llamaLoadError = null;
    return session;
  } catch (err) {
    llamaInitPromise = null;
    llamaLoadError = err && err.message ? err.message : String(err);
    throw err;
  }
}

// First-launch model fetch (thin installer): resumable download into the
// resolved model path with progress events to the renderer. Concurrent calls
// share one flight. Errors are returned, never thrown to the UI as a crash.
let modelDownloadPromise = null;

async function handleDownloadModel(event) {
  if (modelDownloadPromise) return modelDownloadPromise;
  modelDownloadPromise = (async () => {
    const dest = resolveModelPath();
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
        const { bytes } = await downloader.downloadTo(url, dest, { onProgress });
        if (bytes < (downloader.MIN_BYTES || 0)) {
          throw new Error(`downloaded file smaller than expected (${bytes} bytes).`);
        }
        emit({ state: 'complete', done: bytes, total: bytes, pct: 100 });
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
      notifyRenderer(`LLM background load failed: ${message} - will retry on first translation.`);
    }
  );
}

function sanitizeModelOutput(raw) {
  let text = String(raw || '').trim();
  // Qwen3 hybrid models may emit a thinking trace despite non-thinking mode -
  // drop it before anything else so only the final answer is parsed.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Orphan thinking tags (unclosed block from a cut-off answer) - strip the
  // tags themselves so they can never leak into a kept content line.
  text = text.replace(/<\/?think>/gi, '').trim();
  // Strip markdown fences / backticks the model may add despite the system prompt.
  text = text.replace(/```(?:bash|sh|ffmpeg)?/gi, '').replace(/```/g, '').replace(/`/g, '').trim();
  // Split into lines, strip list markers/bullets/arrows ("- ", "*", "1.", "→").
  // A lone leading dash is only a bullet when followed by whitespace -
  // never eat the `-` of a flag like `-i`.
  const lines = text
    .split('\n')
    .map((l) => l.trim().replace(/^(?:[*→>]+|\d+[.)]|-\s+)\s*/, ''))
    .filter(Boolean);
  // Keep content lines (flags or media paths); drop prose ("Here is…").
  const kept = lines.filter(
    (l) => /-[a-zA-Z]/.test(l) || /\.(mp4|mkv|webm|mov|avi|gif|mp3)\b/i.test(l)
  );
  const joined = (kept.length > 0 ? kept : lines).join(' ');
  // Drop a leading "ffmpeg" binary name - renderer prepends the binary path.
  const s = joined.replace(/^ffmpeg\s+/, '').trim();
  // Completeness gate: must name an input. A missing trailing output file
  // is recovered downstream (ensureOutputFile); pure prose fails here.
  const toks = s.split(/\s+/).filter(Boolean);
  if (!toks.includes('-i')) {
    throw new Error('LLM output incomplete (no input file). Try again.');
  }
  return s;
}

function looksLikeFileToken(tok) {
  const t = String(tok || '');
  return /[/\\]/.test(t) || /\.[A-Za-z0-9]{2,4}["']?$/i.test(t);
}

// The model sometimes stops right before the output filename (trailing
// flags like `-movflags +faststart` and EOS). Recover deterministically:
// append `output.<ext>` with the container derived from the instruction
// (else codec hints, else .mp4). The runner swaps in the real destination
// path at run time; only the extension matters downstream.
function ensureOutputFile(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args) || args.length === 0) return { args, corrections };
  if (looksLikeFileToken(args[args.length - 1])) return { args, corrections };
  const text = String(instruction || '').toLowerCase();
  const wordExt =
    /\bmkv\b/.test(text) ? '.mkv'
    : /\bwebm\b/.test(text) ? '.webm'
    : /\bgif\b/.test(text) ? '.gif'
    : /\bmp3\b|\baudio only\b|\bextract (the )?audio\b/.test(text) ? '.mp3'
    : /\bmov\b/.test(text) ? '.mov'
    : /\bavi\b/.test(text) ? '.avi'
    : /\bmp4\b/.test(text) ? '.mp4'
    : null;
  const joined = args.join(' ').toLowerCase();
  const hintExt = wordExt
    || (joined.includes('libvpx-vp9') || joined.includes('libopus') ? '.webm' : null)
    || (joined.includes('libmp3lame') || /\s-vn(\s|$)/.test(joined + ' ') ? '.mp3' : null)
    || '.mp4';
  const out = [...args, `output${hintExt}`];
  corrections.push(`LLM omitted the output file - appended output${hintExt}`);
  return { args: out, corrections };
}

function tokenizeArgs(argString, inputFile) {
  // Minimal shell-aware splitter (handles single/double quotes).
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < argString.length; i++) {
    const c = argString[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  // Ensure an input is present.
  if (!tokens.includes('-i') && inputFile) return ['-y', '-i', inputFile, ...tokens];
  return tokens;
}

// Height (p) shorthands some models emit, mapped to even-width scale filters.
const P_HEIGHTS = new Set([144, 240, 360, 480, 720, 1080, 1440, 2160]);

// Deterministic correction layer for common LLM mistakes that ffmpeg rejects,
// e.g. `-s 360p` ("Invalid frame size: 360p") or `scale=720p` inside -vf.
// Returns { args, corrections } - never throws.
function fixupArgs(args) {
  const corrections = [];
  const out = [];
  const pendingFilters = [];
  let insertAt = -1;

  const shorthandHeight = (v) => {
    const m = /^(?:(\d{3,4})[pP]|4[kK])$/.exec(String(v || '').trim());
    if (!m) return null;
    const h = m[1] ? parseInt(m[1], 10) : 2160;
    return P_HEIGHTS.has(h) ? h : null;
  };

  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    const nx = args[i + 1];
    if ((t === '-s' || t === '-video_size') && nx !== undefined) {
      const h = shorthandHeight(nx);
      if (h !== null) {
        if (insertAt === -1) insertAt = out.length;
        pendingFilters.push(`scale=-2:${h}`);
        corrections.push(`Rewrote "${t} ${nx}" as scale=-2:${h} ("${nx}" is not a valid frame size)`);
        i++; // skip the bad value
        continue;
      }
    }
    out.push(t);
  }

  // Fix scale=NNNp inside -vf / -filter:v values (valid form is scale=-2:H).
  for (let i = 0; i < out.length; i++) {
    if ((out[i] === '-vf' || out[i] === '-filter:v') && typeof out[i + 1] === 'string') {
      out[i + 1] = out[i + 1].replace(/\bscale=(\d{3,4})[pP]\b/g, (m, n) => {
        const h = parseInt(n, 10);
        if (P_HEIGHTS.has(h)) {
          corrections.push(`Rewrote "scale=${n}p" as scale=-2:${h} inside -vf`);
          return `scale=-2:${h}`;
        }
        return m;
      });
    }
  }

  // Multiple -vf/-filter:v flags: ffmpeg honors only the LAST one, silently
  // dropping the earlier chains. Merge them into a single comma-joined chain.
  {
    const seen = [];
    for (let i = 0; i < out.length; i++) {
      if ((out[i] === '-vf' || out[i] === '-filter:v') && typeof out[i + 1] === 'string') {
        seen.push({ idx: i, val: out[i + 1] });
      }
    }
    if (seen.length > 1) {
      out[seen[0].idx] = '-vf';
      out[seen[0].idx + 1] = seen.map((s) => s.val).join(',');
      for (let k = seen.length - 1; k >= 1; k--) out.splice(seen[k].idx, 2);
      corrections.push(`Merged ${seen.length} -vf chains into one (ffmpeg keeps only the last -vf)`);
    }
  }

  if (pendingFilters.length > 0) {
    const vfIdx = out.findIndex((t) => t === '-vf' || t === '-filter:v');
    if (vfIdx !== -1 && typeof out[vfIdx + 1] === 'string') {
      out[vfIdx + 1] = `${out[vfIdx + 1]},${pendingFilters.join(',')}`;
    } else if (insertAt !== -1) {
      out.splice(insertAt, 0, '-vf', pendingFilters.join(','));
    } else {
      out.push('-vf', pendingFilters.join(','));
    }
  }

  return { args: out, corrections };
}

function quoteArgs(args) {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

// The model sometimes echoes the prompt's placeholder (`-i input.mp4`)
// instead of the real selected file. Since the input always comes from the
// loaded video, rewrite a missing/placeholder/nonexistent -i value with it.
// Returns { args, corrections } - never throws.
function fixupInput(args, inputFile) {
  const corrections = [];
  if (!inputFile || !Array.isArray(args)) return { args, corrections };
  const out = [...args];
  const iIdx = out.findIndex((t) => t === '-i');
  if (iIdx === -1 || typeof out[iIdx + 1] !== 'string') return { args: out, corrections };
  const cur = out[iIdx + 1];
  const isPlaceholder = /^input(\.\w+)?$/i.test(cur);
  let exists = false;
  try {
    exists = fs.existsSync(cur);
  } catch { exists = false; }
  if (cur !== inputFile && (isPlaceholder || !exists)) {
    out[iIdx + 1] = inputFile;
    corrections.push(`Rewrote "-i ${cur}" as the loaded video (placeholder/missing file)`);
  }
  return { args: out, corrections };
}

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
function handleModelStatus() {
  const modelPath = resolveModelPath();
  let exists = false;
  let size = 0;
  try {
    const st = fs.statSync(modelPath);
    exists = st.isFile() && st.size > 1024;
    size = st.size;
  } catch { exists = false; }
  let llamaAvailable = false;
  try {
    require.resolve('node-llama-cpp');
    llamaAvailable = true;
  } catch { llamaAvailable = false; }
  const loading = isLlamaLoading();
  const ready = exists && llamaAvailable && llamaSession !== null;
  let engine;
  if (ready) engine = 'node-llama-cpp (local GGUF)';
  else if (!exists) engine = 'LLM unavailable';
  else if (loading) engine = 'Loading LLM engine locally…';
  else engine = 'LLM not loaded';
  return {
    modelPath,
    exists,
    size,
    llamaAvailable,
    loading,
    loadError: llamaLoadError,
    ffmpegPath: ffmpegPath || null,
    engine,
    ready,
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
    return {
      ok: false,
      engine: 'node-llama-cpp',
      error: message,
      diag,
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

// Default output: same directory as the input, named `output.<ext>` where
// <ext> comes from the translated command's output. Until translated it is
// literally `output.ext` - never a guessed container.
function defaultOutputPath(inputFile, args) {
  const dir = inputFile ? path.dirname(inputFile) : process.cwd();
  let ext = '';
  if (Array.isArray(args) && args.length > 0) {
    const last = args[args.length - 1];
    // Only a translated *output* determines the container - the input
    // path itself (or a flag) means "not translated yet" → output.ext.
    if (last && !String(last).startsWith('-') && String(last) !== String(inputFile || '')) {
      const e = path.extname(String(last));
      if (e) ext = e;
    }
  }
  if (!ext) ext = '.ext';
  return path.join(dir, `output${ext}`);
}

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

// Pathless drag import: when the OS exposes file bytes but no path,
// the renderer sends the bytes and we materialize a temp copy.
async function handleSaveDroppedFile({ name, buffer } = {}) {
  if (!buffer || buffer.byteLength === 0) throw new Error('Empty dropped file.');
  const dir = path.join(os.tmpdir(), 'plainffmpeg-drops');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'dropped-video').replace(/[^\w.\-() ]+/g, '_').slice(-120) || 'dropped-video';
  const target = path.join(dir, safe);
  fs.writeFileSync(target, Buffer.from(buffer));
  return target;
}

// The output extension always follows the translated command: if the user
// picked `output.mp4` but the translation produces mkv, the path is coerced
// to .mkv (container/codec mismatch otherwise fails or misbehaves).
// Returns { path, changed } - never throws.
function enforceOutputExtension(chosenPath, args) {
  const result = { path: chosenPath, changed: false };
  if (!chosenPath || !Array.isArray(args) || args.length === 0) return result;
  const last = String(args[args.length - 1] || '');
  if (last.startsWith('-')) return result;
  const want = path.extname(last).toLowerCase();
  if (!want) return result;
  const cur = path.extname(String(chosenPath)).toLowerCase();
  if (cur === want) return result;
  const base = String(chosenPath).slice(0, String(chosenPath).length - cur.length);
  result.path = (base || String(chosenPath)) + want;
  result.changed = true;
  return result;
}

function parseHMS(h, m, s) {
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
}

// Environment diagnosis for machine-level failures (correct command,
// machine cannot do the work). Returns a hint or null.
function ffmpegFailureHint(stderr) {
  const text = String(stderr || '');
  if (/cannot allocate memory|malloc.*failed|out of memory/i.test(text)) {
    return 'Likely cause: FFmpeg ran out of memory. Rendering at high resolution and frame rate (e.g. upscaling 720p to 4K at 60fps) needs a lot of RAM and Windows Sandbox has very little. ' +
      'Note: upscaling cannot add detail beyond the source - it only makes a bigger file. ' +
      'Try a smaller target like 1080p, close other apps, or run on a machine with more memory.';
  }
  return null;
}

// Parse an -ss/-t value: seconds float or [[HH:]MM:]SS[.ms].
function parseTimeVal(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.includes(':')) {
    const parts = s.split(':').map((x) => parseFloat(x));
    if (parts.some((x) => !Number.isFinite(x))) return null;
    let total = 0;
    for (const p of parts) total = total * 60 + p;
    return total;
  }
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : null;
}

function fmtSec(sec) {
  return String(Math.round(sec * 100) / 100);
}

// File-size constraint in the instruction ("below 2GB", "under 500MB",
// "2GB file size", "500MB max") → bytes. Returns null when absent.
function parseSizeLimit(instruction) {
  const text = String(instruction || '');
  const unitScale = { gb: 1024 ** 3, g: 1024 ** 3, mb: 1024 ** 2, m: 1024 ** 2, kb: 1024, k: 1024 };
  const patterns = [
    /(?:below|under|less\s+than|at\s+most|up\s+to|max(?:imum)?|keeping?\s+it\s+(?:below|under)|no\s+(?:more|larger)\s+than)\s*(\d+(?:\.\d+)?)\s*(gb|g|mb|m|kb|k)\b/i,
    /(\d+(?:\.\d+)?)\s*(gb|mb|kb)\s*(?:file\s*size|filesize|max|limit|capped?)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return Math.floor(parseFloat(m[1]) * unitScale[m[2].toLowerCase()]);
  }
  return null;
}

function parseBitrateBps(v) {
  if (v === null || v === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(v));
  if (!m) return null;
  const scale = m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1;
  return Math.floor(parseFloat(m[1]) * scale);
}

// Single-pass size cap: video bitrate from (bytes*8*margin/duration - audio).
// Replaces/derives -b:v/-maxrate/-bufsize and bounds copied audio, because a
// limit is a guarantee, not a suggestion. Our runner executes ONE ffmpeg
// command, so two-pass (-pass 1/2) is never an option.
function fixupSizeLimit(args, instruction, durationSec) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const bytes = parseSizeLimit(instruction);
  if (!bytes || !(durationSec > 0)) return { args, corrections };
  const out = [...args];
  const hasAN = out.includes('-an');
  let audioBits = hasAN ? 0 : 128000;
  const caIdx = out.findIndex((t) => t === '-c:a');
  if (!hasAN && caIdx !== -1 && String(out[caIdx + 1]).toLowerCase() === 'copy') {
    out[caIdx + 1] = 'aac';
    out.splice(caIdx + 2, 0, '-b:a', '128k');
    audioBits = 128000;
    corrections.push('Size limit: replaced `-c:a copy` with `-c:a aac -b:a 128k` (copied audio has no size bound)');
  } else if (!hasAN) {
    const baIdx = out.findIndex((t) => t === '-b:a');
    if (baIdx !== -1) {
      const v = parseBitrateBps(out[baIdx + 1]);
      if (v) audioBits = v;
      if (v && v > 128000) {
        out[baIdx + 1] = '128k';
        audioBits = 128000;
        corrections.push('Size limit: capped `-b:a` at 128k (audio must stay bounded)');
      }
    }
  }
  const videoBps = Math.max(100000, Math.floor((bytes * 8 * 0.98) / durationSec - audioBits));
  const vk = Math.floor(videoBps / 1000);
  const setFlag = (flag, value) => {
    const i = out.findIndex((t) => t === flag);
    if (i !== -1) {
      if (String(out[i + 1]) !== String(value)) {
        out[i + 1] = value;
        return true;
      }
      return false;
    }
    const at = out.length > 0 && !String(out[out.length - 1]).startsWith('-') ? out.length - 1 : out.length;
    out.splice(at, 0, flag, value);
    return true;
  };
  let touched = false;
  touched = setFlag('-b:v', `${vk}k`) || touched;
  touched = setFlag('-maxrate', `${vk}k`) || touched;
  touched = setFlag('-bufsize', `${vk * 2}k`) || touched;
  if (touched) {
    const human = bytes >= 1024 ** 3
      ? `${+(bytes / 1024 ** 3).toFixed(2)}GB`
      : `${+(bytes / 1024 ** 2).toFixed(1)}MB`;
    corrections.push(
      `Size limit ${human} for ${fmtSec(durationSec)}s video: capped single-pass video at -b:v ${vk}k`
    );
  }
  return { args: out, corrections };
}

// "last N seconds" needs the input duration to resolve. Removal phrasing
// ("trim/cut/remove/delete the last N s") keeps [0, D-N]; anything else
// ("keep/extract the last N s") keeps [D-N, end]. Rewrites only the
// clear-cut wrong shape and leaves sane commands alone.
function fixupLastTrim(args, instruction, durationSec) {
  const corrections = [];
  if (!durationSec || !(durationSec > 0) || !Array.isArray(args)) return { args, corrections };
  const m = /last\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i.exec(String(instruction || ''));
  if (!m) return { args, corrections };
  const N = parseFloat(m[1]);
  if (!(N > 0) || N >= durationSec) return { args, corrections };
  const instr = String(instruction || '');
  // Explicit keep-the-tail phrasing beats everything ("keep/extract/only the last N").
  const keepTail = /\b(keep|keeping|extract|only|just)\b[\w\s]{0,12}\blast\s+\d/i.test(instr);
  // Otherwise trim/cut/remove/delete/drop = cut those seconds off.
  const removal = !keepTail
    && /(remove|removing|delete|delet|trim|trimming|cut|cutting|drop|strip|without)/i.test(instr);

  const out = [...args];
  const ssIdx = out.findIndex((t) => t === '-ss');
  const tIdx = out.findIndex((t) => t === '-t');
  const ssVal = ssIdx !== -1 ? parseTimeVal(out[ssIdx + 1]) : null;
  const tVal = tIdx !== -1 ? parseTimeVal(out[tIdx + 1]) : null;
  const approx = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.51;
  const startsAtZero = ssIdx === -1 || ssVal === null || ssVal < 0.51;

  if (removal) {
    // Keep [0, D-N]: strip any -ss, ensure -t D-N. A mid-file -ss would
    // contradict keeping the beginning, and -ss 0 is a no-op anyway.
    const want = fmtSec(durationSec - N);
    let changed = false;
    let sIdx = out.findIndex((t) => t === '-ss');
    if (sIdx !== -1) {
      out.splice(sIdx, 2);
      changed = true;
    }
    const ttIdx = out.findIndex((t) => t === '-t');
    if (ttIdx !== -1) {
      if (!approx(parseTimeVal(out[ttIdx + 1]), durationSec - N)) {
        out[ttIdx + 1] = want;
        changed = true;
      }
    } else {
      const at = out.length > 0 && !String(out[out.length - 1]).startsWith('-') ? out.length - 1 : out.length;
      out.splice(at, 0, '-t', want);
      changed = true;
    }
    if (changed) corrections.push(`"last ${m[1]}s" cut from ${fmtSec(durationSec)}s - keeping [0, ${want}s]`);
    return { args: out, corrections };
  }

  // Keep [D-N, end]: needs -ss D-N and no -t.
  const want = fmtSec(durationSec - N);
  const wantNum = durationSec - N;
  if (ssIdx !== -1 && approx(ssVal, wantNum) && tIdx !== -1 && tVal !== null
      && (ssVal + tVal) < durationSec - 0.51) {
    // Right start, but -t truncates the kept tail - drop it, keep to the end.
    out.splice(tIdx, 2);
    corrections.push(`-t cut the kept "last ${m[1]}s" short - keeping everything from ${want}s to the end`);
  } else if (ssIdx !== -1 && tIdx !== -1 && startsAtZero && approx(tVal, N)) {
    out[ssIdx + 1] = want;
    const tAt = out.findIndex((t) => t === '-t');
    out.splice(tAt, 2);
    corrections.push(`"last ${m[1]}s" of ${fmtSec(durationSec)}s starts at ${want}s - rewrote -ss/-t`);
  } else if (ssIdx === -1 && tIdx !== -1 && approx(tVal, N)) {
    out.splice(tIdx, 2, '-ss', want);
    corrections.push(`"last ${m[1]}s" of ${fmtSec(durationSec)}s starts at ${want}s - replaced -t with -ss`);
  }
  return { args: out, corrections };
}

// Contradictions ffmpeg rejects outright (or that violate runner contracts):
// two-pass flags (single-shot runner), audio-codec flags combined with -an,
// and `-c:v copy` paired with video filters (filtering requires re-encoding).
// Runs BEFORE size-limit insertions so flag/value pairs are still adjacent
// (inserting between `-pass` and `1` would orphan the value). The container
// for the stream-copy fix comes from the instruction words, mirroring
// ensureOutputFile (whose .mp4 default matches the libx264 default here).
// Returns { args, corrections } - never throws.
function fixupConflicts(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const out = [...args];
  // Drop a valued flag everywhere it appears. A flag with no consumable value
  // (end of args, or another flag follows) is dropped alone.
  const dropValued = (flag, reason) => {
    let idx = out.findIndex((t) => t === flag);
    while (idx !== -1) {
      const nx = out[idx + 1];
      if (nx === undefined || String(nx).startsWith('-')) {
        out.splice(idx, 1);
        corrections.push(`Removed dangling "${flag}" (${reason})`);
      } else {
        out.splice(idx, 2);
        corrections.push(`Removed "${flag} ${nx}" (${reason})`);
      }
      idx = out.findIndex((t) => t === flag);
    }
  };
  // Two-pass needs two runner invocations - we only ever run one command.
  const twoPass = 'two-pass is unsupported, the runner executes a single command';
  dropValued('-pass', twoPass);
  dropValued('-passlogfile', twoPass);
  // Mute contradicts any audio encoding setting.
  if (out.includes('-an')) {
    const muted = 'contradicts -an (muted output has no audio stream)';
    for (const f of ['-c:a', '-b:a', '-ac', '-ar', '-af', '-filter:a']) dropValued(f, muted);
  }
  // Stream-copy cannot filter: any video filter requires re-encoding.
  const hasVideoFilter = out.includes('-vf') || out.includes('-filter:v') || out.includes('-filter_complex');
  const cvIdx = out.findIndex((t) => t === '-c:v');
  if (hasVideoFilter && cvIdx !== -1 && String(out[cvIdx + 1]).toLowerCase() === 'copy') {
    const text = String(instruction || '').toLowerCase();
    if (/\bwebm\b/.test(text)) {
      out[cvIdx + 1] = 'libvpx-vp9';
      corrections.push('Replaced `-c:v copy` with `-c:v libvpx-vp9` (filters cannot stream-copy)');
    } else if (/\bgif\b/.test(text)) {
      out.splice(cvIdx, 2);
      corrections.push('Removed `-c:v copy` (gif output uses its default encoder with filters)');
    } else {
      out[cvIdx + 1] = 'libx264';
      corrections.push('Replaced `-c:v copy` with `-c:v libx264` (filters cannot stream-copy)');
    }
  }
  return { args: out, corrections };
}

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
  if (!fluentFfmpeg) throw new Error('fluent-ffmpeg not available.');
  if (!Array.isArray(args) || args.length === 0) throw new Error('No FFmpeg args provided.');

  const sender = event.sender;
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
  ipcMain.handle('download-model', async (event) => handleDownloadModel(event));
  ipcMain.handle('pick-file', async () => handlePickFile());
  ipcMain.handle('pick-output', async (_e, payload) => handlePickOutput(payload || {}));
  ipcMain.handle('output-exists', async (_e, outputPath) => handleOutputExists(outputPath));
  ipcMain.handle('save-dropped-file', async (_e, payload) => handleSaveDroppedFile(payload || {}));
  ipcMain.handle('window-min', async () => handleWindowMin());
  ipcMain.handle('window-max', async () => handleWindowMax());
  ipcMain.handle('window-close', async () => handleWindowClose());
  ipcMain.handle('probe-media', async (_e, inputFile) => probeMedia(inputFile));
  ipcMain.handle('run-ffmpeg', async (event, payload) => handleRunFfmpeg(event, payload || {}));
}

module.exports = {
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
  enforceOutputExtension,
  resolveModelPath,
  userDataModelsDir,
  handleDownloadModel,
  defaultOutputPath,
  handleModelStatus,
  handleTranslatePrompt,
  handleOutputExists,
  handleSaveDroppedFile,
  llamaDiagnostics,
  ffmpegFailureHint,
  handleWindowMin,
  handleWindowMax,
  handleWindowClose,
  SYSTEM_PROMPT,
};
