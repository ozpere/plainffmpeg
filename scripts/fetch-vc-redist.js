/**
 * Helper: fetch the Microsoft Visual C++ Redistributable (x64) into ./assets/.
 *
 * The redist is required by the node-llama-cpp prebuilt binary on stock
 * Windows. It is NOT committed (see .gitignore) - the release workflow and
 * `npm run dist:win` fetch it at build time so electron-builder can bundle
 * it into the NSIS installer (see assets/vc-redist.nsh).
 *
 * Usage:
 *   npm run fetch-vc-redist
 *
 * Skips download if the file already exists.
 */
const fs = require('fs');
const path = require('path');

const DEST = path.join(__dirname, '..', 'assets', 'vc_redist.x64.exe');
const SOURCE = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
// Real file is ~25 MB - anything far smaller is a truncated download.
const MIN_BYTES = 10 * 1024 * 1024;

// Plausibility gate for an executable that will later run elevated: right
// size and an MZ header. Catches HTML error pages and wrong-arch files
// before they are bundled into the installer.
function assertPlausibleExe(filePath) {
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* unreadable counts as mismatch below */ }
  const size = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
  const hasMZ = head.length === 2 && head[0] === 0x4d && head[1] === 0x5a;
  if (size < MIN_BYTES || !hasMZ) {
    throw new Error(`implausible redist executable (${size} bytes, MZ header ${hasMZ ? 'ok' : 'missing'}).`);
  }
}

// Present redist usable as-is (size and MZ header), or false. A stale or
// wrong file is removed so the fetch below heals it.
function existingRedistUsable() {
  try {
    assertPlausibleExe(DEST);
    return true;
  } catch {
    try { fs.rmSync(DEST, { force: true }); } catch { /* ignore */ }
    return false;
  }
}

async function main() {
  if (existingRedistUsable()) {
    console.log('[fetch-vc-redist] already present, skipping.');
    return;
  }
  // Small file, but aka.ms blips fail the whole Windows release job alone -
  // retry a few times with backoff before giving up.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fetchOnce();
      return;
    } catch (e) {
      lastErr = e;
      console.error(`[fetch-vc-redist] attempt ${attempt} failed: ${(e && e.message) || e}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

async function fetchOnce() {
  console.log(`[fetch-vc-redist] fetching ${SOURCE}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, 120000);
  let res;
  try {
    res = await fetch(SOURCE, { redirect: 'follow', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${SOURCE}`);
  if (!res.body) throw new Error(`empty response body for ${SOURCE}`);
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  // Write to .part and rename only on success: an interrupted download must
  // never pass the skip check above as a corrupt exe.
  const tmp = DEST + '.part';
  const file = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  let done = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    done += value.length;
    await new Promise((resolve, reject) => file.write(value, (e) => (e ? reject(e) : resolve())));
  }
  await new Promise((resolve) => file.close(resolve));
  if (done < MIN_BYTES) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(`downloaded file smaller than expected (${done} bytes).`);
  }
  assertPlausibleExe(tmp);
  fs.renameSync(tmp, DEST);
  console.log(`[fetch-vc-redist] saved ${DEST} (${(done / 1e6).toFixed(1)} MB)`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[fetch-vc-redist] failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
module.exports = { DEST, SOURCE, MIN_BYTES, assertPlausibleExe, existingRedistUsable };
