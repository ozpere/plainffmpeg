/**
 * Filesystem locations: model resolution, portable dirs, output paths.
 *
 * Everything the app stores on disk is decided here. Portable runs prefer a
 * folder next to the exe; installed copies use the per-user app data dir.
 * Require-safe in plain Node (smoke tests): Electron access degrades to
 * nulls outside the Electron runtime.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// Electron is only fully available inside the Electron runtime.
let app = null;
let isElectron = false;
try {
  const electron = require('electron');
  app = electron.app;
  isElectron = !!(app && typeof app.whenReady === 'function' && process.versions && process.versions.electron);
} catch { /* plain Node (smoke tests) */ }

// Real per-user data dir, captured before main.js redirects the Electron
// profile exe-side for portable runs - the portable "last fallback" and the
// fallback notice must keep pointing at the genuine app-data location.
let defaultUserDataDir = null;
try {
  if (isElectron && app && typeof app.getPath === 'function') {
    defaultUserDataDir = app.getPath('userData');
  }
} catch { defaultUserDataDir = null; }

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
  if (isPortableLaunch()) {
    // Portable flow, deliberately short: exe-side home, then app data as the
    // LAST fallback (nothing after it - data must never hide in dev dirs).
    // Reads use existence (a copy on read-only media still counts); only a
    // NEW download needs a writable home (see portableDataDir + the consent
    // gate in handleDownloadModel).
    const exeModels = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'PlainFFmpegData', 'models');
    dirs.push(exeModels);
    const appData = appDataModelsDir();
    if (appData && !dirs.includes(appData)) dirs.push(appData);
  } else {
    // Preferred write target first (exe-side for portable, else app data),
    // then every location an existing download could already live in - an
    // older copy keeps working instead of triggering a re-download.
    const preferred = userDataModelsDir();
    if (preferred) dirs.push(preferred);
    const appData = appDataModelsDir();
    if (appData && !dirs.includes(appData)) dirs.push(appData);
    dirs.push(path.join(__dirname, '..', 'models'));
    try {
      // app.getAppPath() only exists inside Electron runtime
      if (isElectron && app && typeof app.getAppPath === 'function') {
        const appPath = app.getAppPath();
        if (appPath) dirs.push(path.join(appPath, 'models'));
      }
    } catch { /* ignore: required outside Electron (smoke tests) */ }
  }
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

// Writable per-user models dir.
// Portable builds prefer a folder next to the exe (deleting the folder then
// removes the 1.3 GB download too - a portable app should leave no trace).
// Installed copies use the per-user app data dir. Falls back to app data when
// the exe dir is missing or read-only. Null in plain Node (smoke tests).
function userDataModelsDir() {
  const portableBase = portableDataDir();
  if (portableBase) return path.join(portableBase, 'models');
  return appDataModelsDir();
}

// Per-user app data models dir (null in plain Node). Uses the data dir
// captured before the portable redirect, so the portable "last fallback"
// and the fallback notice keep pointing at the real app-data location.
function appDataModelsDir() {
  try {
    if (defaultUserDataDir) return path.join(defaultUserDataDir, 'models');
    if (isElectron && app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'models');
    }
  } catch { /* ignore */ }
  return null;
}

// True for portable-launcher runs (electron-builder sets this env var).
function isPortableLaunch() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

// True when a portable run stores (or would store) the model in app data.
// Drives the persistent fallback notice in the UI.
function portableFallbackActive() {
  if (!isPortableLaunch()) return false;
  const appData = appDataModelsDir();
  if (!appData) return false;
  return resolveModelPath().startsWith(appData + path.sep);
}

// Exe-side data dir for portable launches (set by the portable launcher), or
// null when it cannot be used. Never creates anything - the downloader makes
// the dir when a download actually starts.
function portableDataDir() {
  try {
    const exeDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (!exeDir) return null;
    if (!fs.statSync(exeDir).isDirectory()) return null;
    fs.accessSync(exeDir, fs.constants.W_OK);
    return path.join(exeDir, 'PlainFFmpegData');
  } catch { /* not usable - fall back to app data */ }
  return null;
}

// Drop-import staging dir: exe-side for portable runs (deleting the folder
// removes them), OS temp otherwise. Never throws.
function dropsDir() {
  try {
    const base = portableDataDir();
    if (base) return path.join(base, 'drops');
  } catch { /* fall through to OS temp */ }
  return path.join(os.tmpdir(), 'plainffmpeg-drops');
}

function existsSyncSafe(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// MSVC runtime DLLs the node-llama-cpp prebuilt binary needs on Windows.
// The NSIS installer installs them silently (assets/vc-redist.nsh); the
// portable build cannot, so stock Windows fails with NoBinaryFoundError /
// ERR_DLOPEN_FAILED. Detect it so the UI can name the real cause instead
// of "not loaded yet".
const MSVC_DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
const MSVC_DOWNLOAD_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

function msvcRuntimeStatus() {
  if (process.platform !== 'win32') return { applicable: false, present: true, missing: [] };
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const sys32 = path.join(sysRoot, 'System32');
  const missing = MSVC_DLLS.filter((dll) => !existsSyncSafe(path.join(sys32, dll)));
  return { applicable: true, present: missing.length === 0, missing };
}

function msvcMissingHint() {
  const m = msvcRuntimeStatus();
  const missing = (m.missing && m.missing.length > 0) ? m.missing.join(', ') : 'MSVC runtime DLLs';
  return `Missing system component (${missing}) - install "Microsoft Visual C++ Redistributable (x64)" from ${MSVC_DOWNLOAD_URL}, then restart the app. The portable build does not install it for you.`;
}

// True when a load error looks like the missing-MSVC case: native binding
// not found / failed to load AND the redist DLLs are absent. Never throws.
function isMsvcMissingError(err) {
  if (process.platform !== 'win32') return false;
  const m = String((err && err.message) || err || '');
  if (!/NoBinaryFoundError|ERR_DLOPEN_FAILED|DLOPEN.*failed|specified module could not be found|vcruntime|msvcp140/i.test(m)) return false;
  try { return !msvcRuntimeStatus().present; } catch { return false; }
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

module.exports = {
  resolveModelPath,
  userDataModelsDir,
  appDataModelsDir,
  isPortableLaunch,
  portableFallbackActive,
  portableDataDir,
  dropsDir,
  existsSyncSafe,
  MSVC_DLLS,
  MSVC_DOWNLOAD_URL,
  msvcRuntimeStatus,
  msvcMissingHint,
  isMsvcMissingError,
  defaultOutputPath,
  enforceOutputExtension,
};
