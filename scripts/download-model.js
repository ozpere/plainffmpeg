/**
 * Helper: auto-download GGUF model into ./models/ using Node built-in fetch.
 * Usage:
 *   npm run download-model
 *
 * Downloads Qwen3-1.7B-Q4_K_M.gguf from Hugging Face and
 * saves a copy as ./models/model.gguf (the path the Electron main process loads).
 * Skips download if the file already exists. `--check-only` exits 1 when missing.
 */
const fs = require('fs');
const path = require('path');

const MODEL_DIR = path.join(__dirname, '..', 'models');
const TARGET = path.join(MODEL_DIR, 'model.gguf');
const ALIAS = path.join(MODEL_DIR, 'Qwen_Qwen3-1.7B-Q4_K_M.gguf');

// Canonical HF sources (Q4_K_M quant, ~1.28GB).
const SOURCES = [
  'https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf?download=true',
  'https://huggingface.co/lmstudio-community/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf?download=true',
];

const MIN_BYTES = 800 * 1024 * 1024; // ~1.28GB expected; warn if smaller

function exists(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 1024;
  } catch {
    return false;
  }
}

// True when the file starts with the given magic bytes.
function fileHasMagic(filePath, magic) {
  const want = Buffer.from(String(magic));
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      head = Buffer.alloc(want.length);
      fs.readSync(fd, head, 0, want.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* unreadable counts as mismatch */ }
  return head.equals(want);
}

// Present model usable as-is, or null. A present-but-wrong file (HTML error
// page, truncated junk) is removed so the download below heals it instead
// of the skip gate trusting it forever.
function takeUsableModel() {
  for (const p of [TARGET, ALIAS]) {
    if (!exists(p)) continue;
    if (fileHasMagic(p, 'GGUF')) return p;
    console.log(`[download-model] ${p} failed format check - removing.`);
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
  return null;
}

async function downloadTo(url, dest, { onProgress, expectMagic, _retried } = {}) {
  console.log(`[download-model] fetching ${url}`);
  const tmp = dest + '.part';
  const sidecar = dest + '.source';
  // Resume a previous partial download when the server honors ranges.
  let start = 0;
  try {
    const st = fs.statSync(tmp);
    if (st.isFile() && st.size > 0) start = st.size;
  } catch { /* no partial file - start from zero */ }
  if (start > 0) {
    // A partial from a DIFFERENT source must never be resumed: the origins
    // serve different bytes, so resuming splices a corrupt file.
    let owner = null;
    try { owner = fs.readFileSync(sidecar, 'utf8'); } catch { /* legacy part - assume same source */ }
    if (owner !== null && owner !== url) {
      console.log('[download-model] partial file is from another source - restarting.');
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      start = 0;
    }
  }
  try { fs.writeFileSync(sidecar, url); } catch { /* tracking only - download works without it */ }
  // Stall watchdog: a hung CDN connection aborts so the caller retries and
  // resumes instead of hanging forever. Always cleared in the finally below.
  const ctrl = new AbortController();
  let lastActivity = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > 60000) { try { ctrl.abort(); } catch { /* ignore */ } }
  }, 5000);
  if (watchdog.unref) watchdog.unref();
  try {
    const headers = {};
    if (start > 0) headers.Range = `bytes=${start}-`;
    const res = await fetch(url, { redirect: 'follow', headers, signal: ctrl.signal });
    if (res.status === 416) {
      // Range unsatisfiable (remote file changed) - restart from zero.
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      return downloadTo(url, dest, { onProgress, expectMagic });
    }
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    if (!res.body) throw new Error(`empty response body for ${url}`);
    let resume = res.status === 206;
    if (resume && start > 0 && !_retried) {
      // The server must continue where asked - a 206 starting elsewhere would
      // splice corrupt bytes on append, so restart once instead.
      const m = /bytes\s+(\d+)-/i.exec(res.headers.get('content-range') || '');
      if (m && parseInt(m[1], 10) !== start) {
        console.log(`[download-model] server resumed at ${m[1]} instead of ${start} - restarting.`);
        try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* ignore */ }
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        return downloadTo(url, dest, { onProgress, expectMagic, _retried: true });
      }
    }
    if (!resume && start > 0) {
      // Server ignored Range - restarting avoids a corrupt splice.
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      start = 0;
    }
    const remaining = Number(res.headers.get('content-length') || 0);
    const total = remaining > 0 ? start + remaining : 0;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(tmp, { flags: resume && start > 0 ? 'a' : 'w' });
    let done = start;
    const report = () => {
      lastActivity = Date.now();
      if (typeof onProgress === 'function') {
        try { onProgress({ done, total }); } catch { /* progress must never break the download */ }
      }
    };
    report();
    const reader = res.body.getReader();
    let streamErr = null;
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        done += value.length;
        await new Promise((resolve, reject) => file.write(value, (e) => (e ? reject(e) : resolve())));
        if (total && done % (50 * 1024 * 1024) < value.length) {
          console.log(`[download-model] ${(done / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
        }
        report();
      }
    } catch (e) {
      streamErr = e;
    }
    await new Promise((resolve) => file.close(resolve));
    if (total > 0 && done !== total) {
      throw new Error(`incomplete download (${done} of ${total} bytes) - try again to resume.`);
    }
    if (streamErr) throw streamErr;
    if (expectMagic) {
      // Cheap format gate: a GGUF model starts with "GGUF". An HTML error page
      // or wrong file fails here instead of confusing the LLM loader later.
      if (!fileHasMagic(tmp, expectMagic)) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        throw new Error(`downloaded file failed format check (no "${expectMagic}" header) - removed.`);
      }
    }
    fs.renameSync(tmp, dest);
    try { fs.rmSync(sidecar, { force: true }); } catch { /* ignore */ }
    console.log(`[download-model] saved ${dest} (${(done / 1e6).toFixed(1)} MB)`);
    report();
    return { bytes: done, total };
  } finally {
    clearInterval(watchdog);
  }
}

async function main() {
  const checkOnly = process.argv.includes('--check-only');
  const bestEffort = process.argv.includes('--best-effort');
  const present = takeUsableModel();
  if (present) {
    console.log('[download-model] model already present, skipping.');
    return;
  }
  if (checkOnly) {
    console.error('[download-model] model missing.');
    process.exit(1);
  }
  // Allow offline / smoke-test environments to skip the ~1GB download.
  if (process.env.SKIP_MODEL_DOWNLOAD === '1') {
    console.log('[download-model] SKIP_MODEL_DOWNLOAD=1, skipping.');
    fs.mkdirSync(MODEL_DIR, { recursive: true });
    return;
  }
  let lastErr = null;
  for (const url of SOURCES) {
    try {
      const { bytes } = await downloadTo(url, TARGET, { expectMagic: 'GGUF' });
      if (bytes < MIN_BYTES) {
        // Undersized means truncated/corrupt - remove it so it is never
        // mistaken for a present model, then try the next source.
        try { fs.rmSync(TARGET, { force: true }); } catch { /* ignore */ }
        throw new Error(`file smaller than expected (${bytes} bytes) - removed.`);
      }
      // Canonical path is ./models/model.gguf (what main.js loads).
      // Do NOT duplicate the ~1.3GB file under its upstream name.
      console.log('[download-model] done.');
      return;
    } catch (e) {
      lastErr = e;
      console.error('[download-model] failed:', e.message);
    }
  }
  console.error('[download-model] All sources failed. Translations will report an error until a model is present.');
  console.error('[download-model] Manually place a GGUF at ./models/model.gguf');
  if (bestEffort) {
    // Postinstall path: the app works model-less (probe/FFmpeg run fine),
    // so an offline install must warn and continue instead of failing.
    console.error('[download-model] --best-effort: continuing without a model.');
    return;
  }
  process.exitCode = 1;
  if (process.env.CI) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[download-model] failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
module.exports = { TARGET, ALIAS, SOURCES, MIN_BYTES, downloadTo, fileHasMagic, takeUsableModel };
