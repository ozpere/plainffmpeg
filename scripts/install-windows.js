/**
 * Windows installer helper.
 *
 * Usage (from the project root):
 *   npm run install:win
 *
 * Why this exists: on stock Windows (e.g. Windows Sandbox) a plain
 * `npm install` can fail inside node-llama-cpp's postinstall because:
 *   1. it first tries a Vulkan GPU prebuilt binary (absent SDK/GPU -> incompatible),
 *   2. the CPU prebuilt then fails to load without the MSVC runtime
 *      (ERR_DLOPEN_FAILED, "The specified module could not be found"),
 *   3. it falls back to building llama.cpp from source via git, which fails
 *      with "Filename too long" once node_modules paths exceed MAX_PATH.
 *
 * This script avoids all three:
 *   - forces CPU-only binaries via NODE_LLAMA_CPP_GPU=false
 *     (no Vulkan attempt, no source build, no git clone of llama.cpp),
 *   - enables git long paths as a safety net,
 *   - warns about long project paths and a missing MSVC runtime,
 *   - verifies the native binary loads after install.
 *
 * Options:
 *   --check   run all preflight checks without installing (safe, fast)
 *   --clean   delete node_modules first (fixes EPERM/locked-dir retries)
 */
const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const CLEAN = args.has('--clean');
const IS_WIN = process.platform === 'win32';

function log(msg) {
  console.log(`[install:win] ${msg}`);
}
function warn(msg) {
  console.warn(`[install:win] WARNING: ${msg}`);
}

function run(cmd, opts = {}) {
  const res = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, ...opts });
  return res.status === 0;
}

// --- preflight: project path length -----------------------------------------
const MAX_SAFE_ROOT_LEN = 30; // e.g. C:\plainffmpeg
if (ROOT.length > MAX_SAFE_ROOT_LEN) {
  warn(
    `project path is ${ROOT.length} chars ("${ROOT}"). ` +
      'Windows MAX_PATH failures ("Filename too long") are likely. ' +
      'Extract the zip to a short path such as C:\plainffmpeg and retry.'
  );
} else {
  log(`project path OK (${ROOT})`);
}

// --- preflight: git long paths (safety net for any git clone) ----------------
try {
  const val = execSync('git config --global core.longpaths', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  log(`git core.longpaths=${val || '(unset)'}`);
  if (val !== 'true') throw new Error('not enabled');
} catch {
  log('enabling git long paths (core.longpaths=true)...');
  const ok = run('git config --global core.longpaths true');
  if (!ok) warn('could not set git core.longpaths. Run "git config --global core.longpaths true" manually.');
}

// --- preflight: MSVC runtime hint --------------------------------------------
if (IS_WIN) {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const crt = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'].map((d) =>
    path.join(sysRoot, 'System32', d)
  );
  const missing = crt.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    warn(
      'MSVC runtime DLLs not found. node-llama-cpp prebuilt binaries need the ' +
        '"Microsoft Visual C++ Redistributable (x64)". Install it from ' +
        'https://aka.ms/vs/17/release/vc_redist.x64.exe and re-run.'
    );
  } else {
    log('MSVC runtime DLLs present.');
  }
} else {
  log(`non-Windows platform (${process.platform}); checks only, install flags still apply.`);
}

// --- optional clean ------------------------------------------------------------
if (CLEAN && !CHECK_ONLY) {
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm)) {
    log('removing node_modules (fixes EPERM / locked-dir retries)...');
    try {
      fs.rmSync(nm, { recursive: true, force: true });
    } catch (e) {
      console.error(`[install:win] could not remove node_modules: ${(e && e.message) || e}`);
      console.error('[install:win] Close editors and terminals holding files open, then re-run with --clean.');
      process.exit(1);
    }
  }
}

if (CHECK_ONLY) {
  log('--check: preflight done, skipping install.');
  process.exit(0);
}

// --- install (CPU-only llama binaries, no Vulkan, no source build) ------------
// The ~1.3 GB model fetch is off by default: installs stay fast and work
// offline, and first launch (or `npm run download-model`) covers it.
// Export SKIP_MODEL_DOWNLOAD=0 to fetch during install anyway.
const env = {
  ...process.env,
  NODE_LLAMA_CPP_GPU: 'false',
  SKIP_MODEL_DOWNLOAD: process.env.SKIP_MODEL_DOWNLOAD ?? '1',
};
log('running npm install with NODE_LLAMA_CPP_GPU=false (CPU-only prebuilt binary)...');
if (env.SKIP_MODEL_DOWNLOAD === '1') {
  log('SKIP_MODEL_DOWNLOAD=1 (model fetch deferred to first launch; export SKIP_MODEL_DOWNLOAD=0 to fetch now).');
}
const npmCmd = IS_WIN ? 'npm.cmd install' : 'npm install';
const child = spawnSync(npmCmd, {
  shell: true,
  stdio: 'inherit',
  cwd: ROOT,
  env,
});
if (child.status !== 0) {
  console.error('[install:win] npm install failed. Common fixes:');
  console.error('  1. Move the project to a short path like C:\plainffmpeg');
  console.error('  2. Run: git config --global core.longpaths true');
  console.error('  3. Install vc_redist.x64.exe, then re-run with --clean:');
  console.error('     npm run install:win -- --clean');
  process.exit(child.status || 1);
}

// --- verify: native binary loads (no model needed) -----------------------------
log('verifying node-llama-cpp native binary loads...');
const verify = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', "import('node-llama-cpp').then(async (m) => { const l = await m.getLlama(); console.log('[install:win] LLM native binary OK'); })"],
  { shell: false, stdio: 'inherit', cwd: ROOT, env }
);
if (verify.status !== 0) {
  warn(
    'native binary did not load (often a missing MSVC runtime). ' +
      'Install https://aka.ms/vs/17/release/vc_redist.x64.exe and re-run. ' +
      'Video loading, probing, and FFmpeg runs still work; translations will report a clear error until the binary loads.'
  );
} else {
  log('done. Next: model downloads automatically (postinstall), then run "npm start".');
}
