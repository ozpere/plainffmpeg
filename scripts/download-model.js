/**
 * Helper: auto-download GGUF model into ./models/ using Node built-in fetch.
 * Usage:
 *   npm run download-model
 *
 * Downloads Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf from Hugging Face and
 * saves a copy as ./models/model.gguf (the path the Electron main process loads).
 * Skips download if the file already exists. `--check-only` exits 1 when missing.
 */
const fs = require('fs');
const path = require('path');

const MODEL_DIR = path.join(__dirname, '..', 'models');
const TARGET = path.join(MODEL_DIR, 'model.gguf');
const ALIAS = path.join(MODEL_DIR, 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf');

// Canonical HF source (Q4_K_M quant).
const SOURCES = [
  'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf?download=true',
];

const MIN_BYTES = 500 * 1024 * 1024; // ~0.9-1.1GB expected; warn if smaller

function exists(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 1024;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  console.log(`[download-model] fetching ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const file = fs.createWriteStream(tmp);
  let done = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    done += value.length;
    await new Promise((resolve, reject) => file.write(value, (e) => (e ? reject(e) : resolve())));
    if (total && done % (50 * 1024 * 1024) < value.length) {
      console.log(`[download-model] ${(done / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`);
    }
  }
  await new Promise((resolve) => file.close(resolve));
  fs.renameSync(tmp, dest);
  console.log(`[download-model] saved ${dest} (${(done / 1e6).toFixed(1)} MB)`);
  return done;
}

async function main() {
  const checkOnly = process.argv.includes('--check-only');
  if (exists(TARGET) || exists(ALIAS)) {
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
      const bytes = await download(url, TARGET);
      if (bytes < MIN_BYTES) {
        console.warn(`[download-model] WARNING: file smaller than expected (${bytes} bytes).`);
      }
      // Canonical path is ./models/model.gguf (what main.js loads).
      // Do NOT duplicate the ~1.1GB file under its upstream name.
      console.log('[download-model] done.');
      return;
    } catch (e) {
      lastErr = e;
      console.error('[download-model] failed:', e.message);
    }
  }
  console.error('[download-model] All sources failed. Translations will report an error until a model is present.');
  console.error('[download-model] Manually place a GGUF at ./models/model.gguf');
  process.exitCode = 1;
  if (process.env.CI) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[download-model] failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
module.exports = { TARGET, ALIAS, SOURCES };
