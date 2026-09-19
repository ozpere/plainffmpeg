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

async function main() {
  try {
    const st = fs.statSync(DEST);
    if (st.isFile() && st.size > MIN_BYTES) {
      console.log('[fetch-vc-redist] already present, skipping.');
      return;
    }
  } catch { /* missing - download below */ }
  console.log(`[fetch-vc-redist] fetching ${SOURCE}`);
  const res = await fetch(SOURCE, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${SOURCE}`);
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
module.exports = { DEST, SOURCE, MIN_BYTES, assertPlausibleExe };
