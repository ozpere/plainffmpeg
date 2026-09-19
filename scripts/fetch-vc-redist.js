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

async function main() {
  try {
    const st = fs.statSync(DEST);
    if (st.isFile() && st.size > 1024 * 1024) {
      console.log('[fetch-vc-redist] already present, skipping.');
      return;
    }
  } catch { /* missing - download below */ }
  console.log(`[fetch-vc-redist] fetching ${SOURCE}`);
  const res = await fetch(SOURCE, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${SOURCE}`);
  const file = fs.createWriteStream(DEST);
  const reader = res.body.getReader();
  let done = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    done += value.length;
    await new Promise((resolve, reject) => file.write(value, (e) => (e ? reject(e) : resolve())));
  }
  await new Promise((resolve) => file.close(resolve));
  console.log(`[fetch-vc-redist] saved ${DEST} (${(done / 1e6).toFixed(1)} MB)`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[fetch-vc-redist] failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
module.exports = { DEST, SOURCE };
