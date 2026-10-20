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
// size plus MZ and PE headers. Catches HTML error pages and wrong-arch files
// before they are bundled into the installer.
function assertPlausibleExe(filePath) {
  let head = Buffer.alloc(0);
  let peSig = Buffer.alloc(0);
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
    const fd = fs.openSync(filePath, 'r');
    try {
      head = Buffer.alloc(64);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      head = head.slice(0, read);
      if (head.length >= 0x40) {
        const peOff = head.readUInt32LE(0x3c);
        if (peOff > 0 && peOff + 4 <= size) {
          peSig = Buffer.alloc(4);
          fs.readSync(fd, peSig, 0, 4, peOff);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* unreadable counts as mismatch below */ }
  const hasMZ = head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
  const hasPE = peSig.length === 4 && peSig.toString('latin1') === 'PE\u0000\u0000';
  if (size < MIN_BYTES || !hasMZ || !hasPE) {
    throw new Error(`implausible redist executable (${size} bytes, MZ ${hasMZ ? 'ok' : 'missing'}, PE ${hasPE ? 'ok' : 'missing'}).`);
  }
}

// Present redist usable as-is (size, MZ, and PE header), or false. A stale
// file is removed so a bad fetch heals instead of passing the skip check.
function existingRedistUsable(dest = DEST) {
  try {
    assertPlausibleExe(dest);
    return true;
  } catch {
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dest + '.part', { force: true }); } catch { /* ignore */ }
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
  // Cover the body too: a stalled read must abort instead of hanging the job.
  const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, 120000);
  const tmp = DEST + '.part';
  let file = null;
  try {
    const res = await fetch(SOURCE, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'Accept-Encoding': 'identity' },
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} ${res.statusText} for ${SOURCE}`);
    if (!res.body) throw new Error(`empty response body for ${SOURCE}`);
    fs.mkdirSync(path.dirname(DEST), { recursive: true });
    // Write to .part and rename only on success: an interrupted download must
    // never pass the skip check above as a corrupt exe.
    file = fs.createWriteStream(tmp);
    let fileErr = null;
    file.on('error', (e) => { fileErr = e; });
    const reader = res.body.getReader();
    let done = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      done += value.length;
      await new Promise((resolve, reject) => file.write(value, (e) => (e ? reject(e) : resolve())));
    }
    await new Promise((resolve) => file.close(resolve));
    file = null;
    if (fileErr) throw fileErr;
    const expected = Number(res.headers.get('content-length') || 0);
    if (expected > 0 && done !== expected) {
      throw new Error(`incomplete redist download (${done} of ${expected} bytes).`);
    }
    if (done < MIN_BYTES) throw new Error(`downloaded file smaller than expected (${done} bytes).`);
    assertPlausibleExe(tmp);
    fs.renameSync(tmp, DEST);
    console.log(`[fetch-vc-redist] saved ${DEST} (${(done / 1e6).toFixed(1)} MB)`);
  } catch (e) {
    try { if (file) file.destroy(); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[fetch-vc-redist] failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
module.exports = { DEST, SOURCE, MIN_BYTES, assertPlausibleExe, existingRedistUsable };
