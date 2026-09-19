/**
 * Headless smoke test: verifies the app initializes without missing
 * deps or syntax crashes - no Electron GUI / no model download required.
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const required = [
  'package.json',
  'src/main.js',
  'src/preload.js',
  'src/renderer/index.html',
  'src/renderer/renderer.js',
  'src/renderer/styles.css',
  'scripts/download-model.js',
  'scripts/fetch-vc-redist.js',
  'assets/logo.png',
  'assets/icon.ico',
  'assets/icon.icns',
  'assets/vc-redist.nsh',
  '.github/workflows/release-win.yml',
];

async function main() {
  for (const f of required) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', f)), `missing file: ${f}`);
  }
  console.log('[smoke] project files OK');

  // syntax is also covered file-by-file via `npm test`; here require pure helpers.
  const mainMod = require('../src/main.js');
  assert.strictEqual(typeof mainMod.sanitizeModelOutput, 'function');
  assert.strictEqual(typeof mainMod.tokenizeArgs, 'function');
  assert.strictEqual(typeof mainMod.handleTranslatePrompt, 'function');
  assert.strictEqual(mainMod.fallbackTranslate, undefined, 'silent fallback must be removed');

  // sanitize: strip fences + leading binary name
  assert.strictEqual(
    mainMod.sanitizeModelOutput('```bash\nffmpeg -y -i in.mp4 -ss 5 out.webm\n```'),
    '-y -i in.mp4 -ss 5 out.webm'
  );
  assert.strictEqual(
    mainMod.sanitizeModelOutput('ffmpeg -y -i a.mp4 b.mp4'),
    '-y -i a.mp4 b.mp4'
  );
  // wrapped multi-line answers are rejoined, not chopped
  assert.strictEqual(
    mainMod.sanitizeModelOutput('-i in.mp4 -c:v libx264\n-c:a aac\nout.mkv'),
    '-i in.mp4 -c:v libx264 -c:a aac out.mkv'
  );
  assert.strictEqual(
    mainMod.sanitizeModelOutput('Here is your command:\n→ -i in.mp4 out.mkv'),
    '-i in.mp4 out.mkv'
  );
  // truncated answers (dangling flags, no output yet) pass through for
  // downstream recovery; pure prose with no input fails loudly
  assert.strictEqual(
    mainMod.sanitizeModelOutput('-i in.mp4 -c:v libx264 -c:a aac'),
    '-i in.mp4 -c:v libx264 -c:a aac'
  );
  assert.throws(() => mainMod.sanitizeModelOutput('Sure, I can help with that.'), /incomplete/);
  // Qwen3 hybrid thinking traces are stripped before parsing
  assert.strictEqual(
    mainMod.sanitizeModelOutput('<think>let me reason about codecs</think>\n-i in.mp4 out.mkv'),
    '-i in.mp4 out.mkv'
  );
  assert.strictEqual(
    mainMod.sanitizeModelOutput('<think>line one\nline two</think>-i in.mp4 -c:v libx264 out.mkv'),
    '-i in.mp4 -c:v libx264 out.mkv'
  );
  // orphan thinking tag from a cut-off answer cannot leak into the command
  assert.strictEqual(
    mainMod.sanitizeModelOutput('<think>-i in.mp4 out.mkv'),
    '-i in.mp4 out.mkv'
  );
  // missing output file is recovered deterministically (container from words/codecs)
  assert.strictEqual(typeof mainMod.ensureOutputFile, 'function');
  let eo = mainMod.ensureOutputFile(['-i', 'in.mp4', '-c:v', 'libvpx-vp9', '-an'], 'convert to webm and mute it');
  assert.deepStrictEqual(eo.args, ['-i', 'in.mp4', '-c:v', 'libvpx-vp9', '-an', 'output.webm']);
  assert.strictEqual(eo.corrections.length, 1);
  eo = mainMod.ensureOutputFile(['-i', 'in.mp4', '-c:v', 'libx264'], 'make it smaller');
  assert.deepStrictEqual(eo.args, ['-i', 'in.mp4', '-c:v', 'libx264', 'output.mp4']);
  eo = mainMod.ensureOutputFile(['-i', 'in.mp4', 'out.mkv'], 'convert to mkv');
  assert.deepStrictEqual(eo.args, ['-i', 'in.mp4', 'out.mkv'], 'complete commands untouched');
  assert.strictEqual(eo.corrections.length, 0);

  // tokenizer: quotes preserved
  assert.deepStrictEqual(
    mainMod.tokenizeArgs('-y -i in.mp4 -vf "scale=-2:720" out.mp4', 'in.mp4'),
    ['-y', '-i', 'in.mp4', '-vf', 'scale=-2:720', 'out.mp4']
  );
  // correction layer: bare "360p"-style sizes must never reach ffmpeg
  assert.strictEqual(typeof mainMod.fixupArgs, 'function');
  let r = mainMod.fixupArgs(['-y', '-i', 'in.mp4', '-s', '360p', 'out.mkv']);
  assert.deepStrictEqual(r.args, ['-y', '-i', 'in.mp4', '-vf', 'scale=-2:360', 'out.mkv']);
  assert.ok(r.corrections.length === 1, 'must report the rewrite');
  // merges into an existing -vf instead of duplicating the flag
  r = mainMod.fixupArgs(['-i', 'in.mp4', '-vf', 'fps=10', '-s', '720p', 'out.mkv']);
  assert.deepStrictEqual(r.args, ['-i', 'in.mp4', '-vf', 'fps=10,scale=-2:720', 'out.mkv']);
  // scale=720p inside -vf values
  r = mainMod.fixupArgs(['-i', 'in.mp4', '-vf', 'scale=720p', 'out.mkv']);
  assert.deepStrictEqual(r.args, ['-i', 'in.mp4', '-vf', 'scale=-2:720', 'out.mkv']);
  // valid sizes pass through untouched
  r = mainMod.fixupArgs(['-i', 'in.mp4', '-s', '640x360', '-vf', 'scale=-2:360', 'out.mkv']);
  assert.deepStrictEqual(r.args, ['-i', 'in.mp4', '-s', '640x360', '-vf', 'scale=-2:360', 'out.mkv']);
  assert.strictEqual(r.corrections.length, 0, 'valid args must not be rewritten');
  // duplicate -vf chains merge (ffmpeg keeps only the last -vf)
  r = mainMod.fixupArgs(['-i', 'in.mp4', '-vf', 'fps=10', '-vf', 'scale=-2:360', 'out.mkv']);
  assert.deepStrictEqual(r.args, ['-i', 'in.mp4', '-vf', 'fps=10,scale=-2:360', 'out.mkv']);
  assert.strictEqual(r.corrections.length, 1, 'must report the merge');
  r = mainMod.fixupArgs(['-i', 'in.mp4', '-filter:v', 'hue=s=0', '-vf', 'scale=-2:720', 'out.mkv']);
  assert.deepStrictEqual(r.args, ['-i', 'in.mp4', '-vf', 'hue=s=0,scale=-2:720', 'out.mkv']);
  console.log('[smoke] fixupArgs OK');

  // input fixup: a literal "-i input.mp4" (or any missing file) must be
  // replaced with the loaded video - this was the real Windows failure.
  assert.strictEqual(typeof mainMod.fixupInput, 'function');
  let fi = mainMod.fixupInput(['-i', 'input.mp4', 'out.mkv'], 'C:\\vids\\clip.mp4');
  assert.deepStrictEqual(fi.args, ['-i', 'C:\\vids\\clip.mp4', 'out.mkv']);
  assert.ok(fi.corrections.length === 1, 'must report the input rewrite');
  fi = mainMod.fixupInput(['-i', 'nope-missing.mp4', 'out.mkv'], '/v/clip.mp4');
  assert.deepStrictEqual(fi.args, ['-i', '/v/clip.mp4', 'out.mkv']);
  const realTmp = path.join(__dirname, 'smoke-in.tmp');
  fs.writeFileSync(realTmp, 'x');
  try {
    fi = mainMod.fixupInput(['-i', realTmp, 'out.mkv'], '/v/clip.mp4');
    assert.deepStrictEqual(fi.args, ['-i', realTmp, 'out.mkv'], 'an existing -i file must be left alone');
    assert.strictEqual(fi.corrections.length, 0);
  } finally {
    fs.rmSync(realTmp, { force: true });
  }
  fi = mainMod.fixupInput(['-i', 'input.mp4', 'out.mkv'], null);
  assert.deepStrictEqual(fi.args, ['-i', 'input.mp4', 'out.mkv'], 'no loaded video → nothing to rewrite with');
  // "trim the last N seconds" = CUT them (removal): keep [0, D-N]
  assert.strictEqual(typeof mainMod.fixupLastTrim, 'function');
  assert.strictEqual(typeof mainMod.probeMedia, 'function');
  let lt = mainMod.fixupLastTrim(
    ['-i', 'in.mp4', '-ss', '00:00:00', '-t', '00:00:05', '-vf', 'scale=-2:360', 'out.mkv'],
    'Convert to mkv, trim the last 5 seconds, make it 360p',
    27.49
  );
  assert.deepStrictEqual(lt.args,
    ['-i', 'in.mp4', '-t', '22.49', '-vf', 'scale=-2:360', 'out.mkv']);
  assert.ok(lt.corrections.length === 1, 'must report the trim=cut rewrite');
  // "keep the last N seconds" keeps the tail instead
  lt = mainMod.fixupLastTrim(
    ['-i', 'in.mp4', '-ss', '00:00:00', '-t', '00:00:05', 'out.mkv'],
    'keep the last 5 seconds',
    27.49
  );
  assert.deepStrictEqual(lt.args, ['-i', 'in.mp4', '-ss', '22.49', 'out.mkv']);
  // removal phrasing keeps the beginning instead
  lt = mainMod.fixupLastTrim(['-i', 'in.mp4', 'out.mkv'], 'remove the last 5 seconds', 27.49);
  assert.deepStrictEqual(lt.args, ['-i', 'in.mp4', '-t', '22.49', 'out.mkv']);
  // "cut the last N" trims like trim
  lt = mainMod.fixupLastTrim(['-i', 'in.mp4', '-ss', '0', '-t', '5', 'out.mkv'], 'cut the last 5 seconds', 27.49);
  assert.deepStrictEqual(lt.args, ['-i', 'in.mp4', '-t', '22.49', 'out.mkv']);
  // a keep-tail command under trim phrasing is normalized to keep-the-head
  lt = mainMod.fixupLastTrim(['-i', 'in.mp4', '-ss', '22.49', 'out.mkv'], 'trim the last 5 seconds', 27.49);
  assert.deepStrictEqual(lt.args, ['-i', 'in.mp4', '-t', '22.49', 'out.mkv']);
  assert.strictEqual(lt.corrections.length, 1);
  // right start but -t truncates the tail → drop -t, keep to the end
  lt = mainMod.fixupLastTrim(['-i', 'in.mp4', '-ss', '22.49', '-t', '2', 'out.mkv'], 'keep the last 5 seconds', 27.49);
  assert.deepStrictEqual(lt.args, ['-i', 'in.mp4', '-ss', '22.49', 'out.mkv']);
  assert.strictEqual(lt.corrections.length, 1);
  // unknown duration or no last-N → untouched
  lt = mainMod.fixupLastTrim(['-i', 'in.mp4', '-ss', '0', '-t', '5', 'out.mkv'], 'trim the last 5 seconds', null);
  assert.deepStrictEqual(lt.args, ['-i', 'in.mp4', '-ss', '0', '-t', '5', 'out.mkv']);
  // contradictions ffmpeg rejects: two-pass, -an with audio flags, copy with filters
  assert.strictEqual(typeof mainMod.fixupConflicts, 'function');
  let cf = mainMod.fixupConflicts(['-i', 'in.mp4', '-c:v', 'libx264', '-pass', '1', 'out.mp4']);
  assert.deepStrictEqual(cf.args, ['-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4']);
  assert.ok(cf.corrections.length >= 1, 'two-pass must be stripped');
  cf = mainMod.fixupConflicts(['-i', 'in.mp4', '-c:v', 'libvpx-vp9', '-an', '-c:a', 'libopus', '-b:a', '128k', 'out.webm']);
  assert.deepStrictEqual(cf.args, ['-i', 'in.mp4', '-c:v', 'libvpx-vp9', '-an', 'out.webm']);
  assert.ok(cf.corrections.length === 2, 'each contradicting audio flag is reported');
  cf = mainMod.fixupConflicts(['-i', 'in.mp4', '-vf', 'scale=-2:360', '-c:v', 'copy', '-c:a', 'aac', 'out.mkv']);
  assert.deepStrictEqual(cf.args, ['-i', 'in.mp4', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-c:a', 'aac', 'out.mkv']);
  cf = mainMod.fixupConflicts(['-i', 'in.mp4', '-vf', 'scale=-2:360', '-c:v', 'copy', 'out.webm'], 'convert to webm');
  assert.ok(cf.args.includes('libvpx-vp9') && !cf.args.includes('copy'), 'webm copy+filter uses the webm codec');
  cf = mainMod.fixupConflicts(['-i', 'in.mp4', '-c:v', 'libx264', '-c:a', 'aac', 'out.mp4']);
  assert.deepStrictEqual(cf.args, ['-i', 'in.mp4', '-c:v', 'libx264', '-c:a', 'aac', 'out.mp4']);
  assert.strictEqual(cf.corrections.length, 0, 'sane commands untouched');
  // pipeline order: contradictions stripped and output ensured before any
  // insertion, so flag/value pairs stay adjacent (insertions slot before output)
  const pipe = (a, instr, dur) => {
    const s1 = mainMod.fixupArgs(a);
    const s2 = mainMod.fixupInput(s1.args, '/v/clip.mp4');
    const s3 = mainMod.fixupConflicts(s2.args, instr);
    const s4 = mainMod.ensureOutputFile(s3.args, instr);
    const s5 = mainMod.fixupLastTrim(s4.args, instr, dur);
    return mainMod.fixupSizeLimit(s5.args, instr, dur).args;
  };
  const pr = pipe(
    ['-i', '/v/clip.mp4', '-c:v', 'libvpx-vp9', '-an', '-c:a', 'libopus', '-pass', '1'],
    'convert to webm below 50MB and mute it', 60
  );
  assert.ok(!pr.includes('-pass') && !pr.includes('1'), 'no orphan pass value: ' + pr.join(' '));
  assert.ok(pr.includes('-an') && pr[pr.length - 1] === 'output.webm', 'mute intact, output kept');
  assert.strictEqual(pr[pr.indexOf('-b:v') + 1], '6850k', 'size cap value stays paired with its flag');
  // size limits: parsing, math, and single-pass enforcement
  assert.strictEqual(typeof mainMod.parseSizeLimit, 'function');
  assert.strictEqual(typeof mainMod.fixupSizeLimit, 'function');
  assert.strictEqual(mainMod.parseSizeLimit('Convert to 1080p while keeping it below 2GB'), 2 * 1024 ** 3);
  assert.strictEqual(mainMod.parseSizeLimit('under 500MB'), 500 * 1024 ** 2);
  assert.strictEqual(mainMod.parseSizeLimit('max 100mb file size'), 100 * 1024 ** 2);
  assert.strictEqual(mainMod.parseSizeLimit('make it 720p'), null, 'resolutions are not sizes');
  assert.strictEqual(mainMod.parseSizeLimit('trim 5 seconds'), null, 'durations are not sizes');
  // 100MB / 60s → ~13573k video (128k reserved for audio)
  let sz = mainMod.fixupSizeLimit(
    ['-i', 'in.mp4', '-vf', 'scale=-2:1080', '-c:v', 'libx264', '-c:a', 'aac', 'out.mp4'],
    'Convert to 1080p mp4 below 100MB', 60
  );
  assert.deepStrictEqual(sz.args,
    ['-i', 'in.mp4', '-vf', 'scale=-2:1080', '-c:v', 'libx264', '-c:a', 'aac', '-b:v', '13573k', '-maxrate', '13573k',
      '-bufsize', '27146k', 'out.mp4']);
  assert.ok(sz.corrections.length >= 1, 'must report the cap');
  // existing -b:v is recomputed, not kept
  sz = mainMod.fixupSizeLimit(['-i', 'in.mp4', '-b:v', '8000k', 'out.mp4'], 'under 100MB', 60);
  assert.ok(sz.args.includes('13573k') && !sz.args.includes('8000k'), 'model bitrate must be recomputed');
  // -c:a copy is bounded (copied audio has no size bound)
  sz = mainMod.fixupSizeLimit(['-i', 'in.mp4', '-c:v', 'libx264', '-c:a', 'copy', 'out.mkv'], 'below 50MB', 60);
  assert.ok(sz.args.includes('aac') && sz.args.includes('128k') && !sz.args.includes('copy'), 'copied audio must be bounded');
  // -an respected: no audio flags injected
  sz = mainMod.fixupSizeLimit(['-i', 'in.mp4', '-c:v', 'libvpx-vp9', '-an', 'out.webm'], 'below 50MB', 60);
  assert.ok(!sz.args.includes('-b:a') && sz.args.includes('-an'), 'muted output stays muted');
  // oversized -b:a is capped so the limit stays a guarantee
  sz = mainMod.fixupSizeLimit(['-i', 'in.mp4', '-c:v', 'libx264', '-b:a', '320k', 'out.mp4'], 'below 50MB', 60);
  assert.ok(sz.args.includes('128k') && !sz.args.includes('320k'), 'audio bitrate must be bounded under a size limit');
  // no duration → untouched (cannot do the math)
  sz = mainMod.fixupSizeLimit(['-i', 'in.mp4', 'out.mp4'], 'below 50MB', null);
  assert.deepStrictEqual(sz.args, ['-i', 'in.mp4', 'out.mp4']);
  console.log('[smoke] fixupSizeLimit OK');

  // probeMedia against a real generated clip (fast, local, no model)
  try {
    const ffmpeg = require('../node_modules/ffmpeg-static');
    const { execFileSync } = require('child_process');
    const clip = path.join(__dirname, 'smoke-clip.mp4');
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=10',
      '-pix_fmt', 'yuv420p', clip], { stdio: 'pipe' });
    const meta = await mainMod.probeMedia(clip);
    assert.ok(Math.abs(meta.duration - 2) < 0.5, 'probed duration ≈ 2s, got ' + meta.duration);
    assert.strictEqual(meta.width, 640);
    assert.strictEqual(meta.height, 360);
    fs.rmSync(clip, { force: true });
    console.log('[smoke] probeMedia OK');
  } catch (e) {
    console.log('[smoke] probeMedia SKIPPED:', e.message);
  }

  // node-llama-cpp v3 is pure ESM: main.js must load it via dynamic import(),
  // never require() (ERR_REQUIRE_ESM otherwise - the exact Windows failure).
  const mainSrc = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.ok(
    mainSrc.includes("await import('node-llama-cpp')"),
    'main.js must dynamically import node-llama-cpp'
  );
  assert.ok(
    !mainSrc.includes("require('node-llama-cpp')") && !mainSrc.includes('require("node-llama-cpp")'),
    'main.js must not require() node-llama-cpp (ESM-only)'
  );

  // preload/renderer/html sources (declared early - used by several blocks below)
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

  // failure diagnostics: what the load depends on, in one pasteable object
  assert.strictEqual(typeof mainMod.llamaDiagnostics, 'function');
  const diagProbe = await mainMod.llamaDiagnostics();
  for (const k of ['ok', 'node', 'modules', 'modelExists']) {
    assert.ok(k in diagProbe, `diagnostics must include ${k}`);
  }
  // llamaResolved exists post-install; pre-install only the resolve error does.
  assert.ok('llamaResolved' in diagProbe || 'llamaResolveError' in diagProbe,
    'diagnostics must report the llama resolution outcome either way');
  assert.strictEqual(diagProbe.modules, process.versions.modules, 'reported ABI must be real');
  assert.ok(Array.isArray(diagProbe.binsPkgs) || typeof diagProbe.binsError === 'string');
  assert.ok(diagProbe.prebuilt && typeof diagProbe.prebuilt === 'object', 'diagnostics must include the prebuilt probe');
  if (diagProbe.prebuilt.importOk) {
    assert.ok(diagProbe.prebuilt.binsDir, 'probe must report the bins dir');
    const folderNames = Object.keys(diagProbe.prebuilt.folders || {});
    assert.ok(folderNames.length > 0, 'probe must list binding folders');
    assert.ok('nodeInAsar' in diagProbe.prebuilt.folders[folderNames[0]], 'probe must check binary presence');
  } else {
    assert.ok(typeof diagProbe.prebuilt.importError === 'string', 'failed probe must explain itself');
  }
  // failed translations carry a one-line diag summary (MODEL_PATH is bogus here)
  process.env.MODEL_PATH = path.join(__dirname, 'definitely-not-a-model.gguf');
  const failRes = await mainMod.handleTranslatePrompt({ instruction: 'x', inputFile: 'x.mp4' });
  assert.strictEqual(failRes.ok, false, 'translate must report failure, not fallback');
  assert.ok(failRes.error && failRes.error.length > 0, 'failure must carry an error message');
  assert.ok(typeof failRes.diag === 'string' && failRes.diag.includes('modules='), 'failure must carry diag summary');
  console.log('[smoke] failure diagnostics OK');

  // errors stay in-app: no native popups, jargon translated for humans
  for (const f of ['src/renderer/renderer.js', 'src/renderer/index.html']) {
    const content = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!content.includes('window.alert'), `${f} must not use native alerts`);
  }
  assert.ok(renderer.includes('prettyLlmError'), 'known errors must be translated to plain language');
  assert.ok(renderer.includes('NoBinaryFoundError'), 'binary-missing must have a friendly message');
  assert.ok(renderer.includes('showBanner'), 'errors must surface through the themed banner');
  console.log('[smoke] themed errors OK');

  // optional deps resolve (warn only)
  for (const dep of ['electron', 'node-llama-cpp', 'ffmpeg-static', 'fluent-ffmpeg']) {
    try {
      require.resolve(dep, { paths: [path.join(__dirname, '..')] });
      console.log(`[smoke] dep resolvable: ${dep}`);
    } catch {
      console.log(`[smoke] dep NOT installed yet (ok pre-install): ${dep}`);
    }
  }

  // preload/renderer reference matching IPC channels + error UI
  for (const ch of ['translatePrompt', 'runFfmpeg', 'modelStatus', 'pickFile', 'pickOutput', 'probeMedia', 'outputExists', 'saveDroppedFile', 'openPath', 'downloadModel', 'windowMin', 'windowMax', 'windowClose']) {
    assert.ok(preload.includes(ch), `preload missing ${ch}`);
  }
  assert.ok(!preload.includes('confirmOverwrite'), 'native confirm dialog must be gone (in-app modal instead)');
  assert.ok(html.includes('errorBanner'), 'UI must have an error banner');
  assert.ok(renderer.includes('errorBanner'), 'renderer must surface LLM errors, not fallback');
  console.log('[smoke] IPC surface OK');

  // output destination: default is output.<ext> next to the input
  assert.strictEqual(typeof mainMod.defaultOutputPath, 'function');
  assert.strictEqual(
    mainMod.defaultOutputPath('/vids/clip.mp4', ['-y', '-i', '/vids/clip.mp4', 'out.mkv']),
    path.join('/vids', 'output.mkv')
  );
  assert.strictEqual(
    mainMod.defaultOutputPath('/vids/clip.mp4', ['-y', '-i', '/vids/clip.mp4']),
    path.join('/vids', 'output.ext'),
    'pre-translation default must be output.ext, never a guessed container'
  );
  // extension enforcement: manual name yields to the translated container
  assert.strictEqual(typeof mainMod.enforceOutputExtension, 'function');
  let e = mainMod.enforceOutputExtension('/v/output.mp4', ['-i', 'in.mp4', 'out.mkv']);
  assert.strictEqual(e.path, '/v/output.mkv');
  assert.strictEqual(e.changed, true);
  e = mainMod.enforceOutputExtension('/v/output.mkv', ['-i', 'in.mp4', 'out.mkv']);
  assert.strictEqual(e.changed, false);
  e = mainMod.enforceOutputExtension('/v/output', ['-i', 'in.mp4', 'out.mkv']);
  assert.strictEqual(e.path, '/v/output.mkv');
  console.log('[smoke] output extension enforcement OK');
  // main must force overwrite (-y) - tested via source since spawn needs ffmpeg
  assert.ok(mainSrc.includes("finalArgs.unshift('-y')"), 'run must force -y overwrite');
  // no File/Edit/View menu bar
  assert.ok(mainSrc.includes('setApplicationMenu(null)'), 'default menu bar must be removed');
  console.log('[smoke] output + menu OK');

  // branding: PlainFFmpeg everywhere, new labels present
  assert.ok(html.includes('<title>PlainFFmpeg</title>'), 'title must be PlainFFmpeg');
  assert.ok(!html.includes('VideoEditTranslator') && !html.includes('FFmpeg Translator'), 'old brand must be gone from UI');
  assert.ok(html.includes('100% offline'), 'subtitle must stress offline/local');
  assert.ok(html.includes('no accounts.'), 'subtitle must match approved copy');
  assert.ok(renderer.includes('Load a different video'), 'browse button must relabel after load');
  assert.ok(renderer.includes('Translate &amp; Run FFmpeg') || html.includes('Translate &amp; Run FFmpeg'),
    'primary button must read Translate & Run FFmpeg');
  // app icon: window/taskbar icon wired per platform, art in the UI + package
  assert.ok(mainSrc.includes('icon.ico') && mainSrc.includes('logo.png'), 'window icon must be platform-aware');
  assert.ok(html.includes('assets/logo.png'), 'title bar and header must use the logo art');
  console.log('[smoke] app icon OK');
  console.log('[smoke] branding OK');

  // background preload: boot must kick off the LLM load without blocking,
  // and status must expose the live loading state for badge polling.
  assert.ok(mainSrc.includes('preloadLlm()'), 'boot must kick off background LLM preload');
  assert.ok(mainSrc.includes('LLM background load failed'), 'preload failures must reach the terminal');
  assert.ok(mainSrc.includes('isLlamaLoading'), 'load-in-flight state must be tracked');
  const st = mainMod.handleModelStatus();
  assert.strictEqual(typeof st.loading, 'boolean', 'status must expose loading flag');
  assert.ok('loadError' in st, 'status must expose loadError');
  assert.strictEqual(st.ready, false, 'ready must be false before any session exists');
  assert.ok(renderer.includes('Loading LLM engine locally'), 'badge must show background loading');
  assert.ok(renderer.includes('Last LLM load failed'), 'failed loads must explain themselves in the UI');
  assert.ok(renderer.includes('setTimeout(refreshStatus'), 'badge must poll until ready');
  console.log('[smoke] background preload OK');

  // badge copy: capitalized Engine, proper-case states
  assert.ok(renderer.includes('Engine: ${s.engine}'), 'badge must read "Engine: …"');
  assert.ok(renderer.includes('Loading LLM engine locally'), 'badge loading copy');
  assert.ok(!renderer.includes('engine: ${s.engine}'), 'lowercase badge prefix must be gone');
  assert.ok(mainSrc.includes("'Loading LLM engine locally…'"), 'main status copy');
  assert.ok(!mainSrc.includes('LLM UNAVAILABLE') && !mainSrc.includes('LLM NOT LOADED'), 'shouting status must be gone');
  // overwrite consent + copy
  assert.ok(!mainSrc.includes('handleConfirmOverwrite'), 'native confirm dialog must be gone');
  assert.strictEqual(typeof mainMod.handleSaveDroppedFile, 'function');
  const dropBytes = Buffer.from('fake-video-bytes');
  const dropPath = await mainMod.handleSaveDroppedFile({ name: 'clip.mp4', buffer: dropBytes });
  assert.strictEqual(fs.readFileSync(dropPath).toString(), 'fake-video-bytes', 'dropped bytes round-trip');
  fs.rmSync(dropPath, { force: true });
  try { fs.rmdirSync(path.dirname(dropPath)); } catch { /* keep temp dir */ }
  const owTmp = path.join(__dirname, 'smoke-out.tmp');
  fs.writeFileSync(owTmp, 'x');
  try {
    assert.strictEqual(mainMod.handleOutputExists(owTmp), true, 'existing file detected');
    assert.strictEqual(mainMod.handleOutputExists(owTmp + '.nope'), false, 'missing file detected');
    assert.strictEqual(mainMod.handleOutputExists(null), false, 'null path safe');
  } finally {
    fs.rmSync(owTmp, { force: true });
  }
  assert.ok(renderer.includes('confirmOverwriteUI'), 'renderer must ask via in-app modal');
  assert.ok(renderer.includes('already exists in that directory'), 'overwrite prompt must name file and directory');
  assert.ok(html.includes('id="confirmOverlay"'), 'UI must have the confirm modal');
  assert.ok(renderer.includes('diagnoseDrop'), 'drop must log flavor diagnostics');
  assert.ok(renderer.includes('arrayBuffer'), 'pathless drops must import bytes');
  // environment failures get plain-language hints, not bare exit codes
  assert.strictEqual(typeof mainMod.ffmpegFailureHint, 'function');
  const oomHint = mainMod.ffmpegFailureHint('x264 [error]: malloc of size 44008576 failed\nCannot allocate memory');
  assert.ok(oomHint && oomHint.includes('out of memory'), 'OOM must be diagnosed');
  assert.ok(oomHint.includes('1080p'), 'OOM hint must suggest a smaller target');
  assert.strictEqual(mainMod.ffmpegFailureHint('Invalid frame size: 360p'), null, 'ordinary errors get no hint');
  assert.ok(renderer.includes("terminal.hidden = false"), 'failures must auto-expand the logs');
  console.log('[smoke] failure UX OK');

  // first-launch model download card (thin installer: weights are fetched
  // in-app, never bundled)
  assert.ok(html.includes('id="modelDl"'), 'UI must have the first-launch download card');
  assert.ok(html.includes('id="modelDlBtn"'), 'UI must have the model download button');
  assert.ok(html.includes('id="barModel"'), 'UI must have the model progress bar');
  assert.ok(renderer.includes('downloadModel'), 'renderer must wire the model download');
  assert.ok(renderer.includes('onModelDownload'), 'renderer must show download progress');
  assert.ok(renderer.includes('setModelDlVisible'), 'download card must follow engine status');
  console.log('[smoke] model download UI OK');

  // windows packaging: thin installer (model fetched on first launch)
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build && pkg.build.appId === 'com.ozpere.plainffmpeg', 'build must declare the app id');
  const winTargets = (pkg.build.win && pkg.build.win.target) || [];
  assert.ok(winTargets.some((t) => t.target === 'nsis'), 'windows build must produce an NSIS installer');
  assert.ok(winTargets.some((t) => t.target === 'portable'), 'windows build must produce a portable exe');
  assert.ok((pkg.build.asarUnpack || []).some((p) => p.includes('@node-llama-cpp')), 'native LLM bins must be unpacked from asar');
  assert.ok((pkg.build.asarUnpack || []).some((p) => p.includes('ffmpeg-static')), 'ffmpeg binary must be unpacked from asar');
  assert.ok(!(pkg.build.files || []).some((f) => f.includes('.gguf')), 'installer stays thin - no model weights bundled');
  assert.ok((pkg.build.files || []).includes('scripts/download-model.js'), 'first-launch downloader must ship in the app');
  assert.strictEqual(pkg.build.nsis && pkg.build.nsis.include, 'assets/vc-redist.nsh', 'installer must bundle the MSVC redist step');
  assert.ok(pkg.scripts['dist:win'] && pkg.scripts['fetch-vc-redist'], 'dist scripts must exist');
  const linuxTargets = (pkg.build.linux && pkg.build.linux.target) || [];
  assert.ok(linuxTargets.some((t) => t.target === 'AppImage'), 'linux build must produce an AppImage');
  assert.ok(pkg.scripts['dist:linux'], 'linux dist script must exist');
  assert.strictEqual(typeof mainMod.handleDownloadModel, 'function');
  assert.strictEqual(typeof mainMod.userDataModelsDir, 'function');
  assert.strictEqual(typeof mainMod.appDataModelsDir, 'function');
  assert.strictEqual(typeof mainMod.portableDataDir, 'function');
  // portable data dir: next to the exe when writable, nowhere otherwise
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  assert.strictEqual(mainMod.portableDataDir(), null, 'no env means no portable dir');
  const os = require('os');
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-portable-'));
  try {
    process.env.PORTABLE_EXECUTABLE_DIR = pdir;
    assert.strictEqual(mainMod.portableDataDir(), path.join(pdir, 'PlainFFmpegData'));
    process.env.PORTABLE_EXECUTABLE_DIR = path.join(pdir, 'missing');
    assert.strictEqual(mainMod.portableDataDir(), null, 'missing exe dir falls back to app data');
    const notDir = path.join(pdir, 'file.txt');
    fs.writeFileSync(notDir, 'x');
    process.env.PORTABLE_EXECUTABLE_DIR = notDir;
    assert.strictEqual(mainMod.portableDataDir(), null, 'non-directory exe path falls back');
  } finally {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    fs.rmSync(pdir, { recursive: true, force: true });
  }
  assert.ok(mainSrc.includes('PORTABLE_EXECUTABLE_DIR'), 'main must detect portable launches');
  // portable resolve branch: exe-side home, app data last, nothing after it
  assert.strictEqual(typeof mainMod.isPortableLaunch, 'function');
  assert.strictEqual(typeof mainMod.portableFallbackActive, 'function');
  delete process.env.MODEL_PATH; // bogus override from the failure test above
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  assert.strictEqual(mainMod.isPortableLaunch(), false, 'no env means no portable launch');
  assert.strictEqual(mainMod.portableFallbackActive(), false, 'no fallback outside portable');
  const phome = fs.mkdtempSync(path.join(os.tmpdir(), 'pfm-home-'));
  try {
    process.env.PORTABLE_EXECUTABLE_DIR = phome;
    assert.strictEqual(mainMod.isPortableLaunch(), true, 'portable launch detected');
    const exeModels = path.join(phome, 'PlainFFmpegData', 'models');
    assert.strictEqual(
      mainMod.resolveModelPath(), path.join(exeModels, 'model.gguf'),
      'portable default is the exe-side home'
    );
    fs.mkdirSync(exeModels, { recursive: true });
    fs.writeFileSync(path.join(exeModels, 'model.gguf'), Buffer.alloc(2048));
    assert.strictEqual(mainMod.resolveModelPath(), path.join(exeModels, 'model.gguf'), 'exe-side copy wins');
    assert.strictEqual(mainMod.portableFallbackActive(), false, 'exe-side home needs no notice');
    // unwritable exe home + no consent: refuse before touching the network
    process.env.PORTABLE_EXECUTABLE_DIR = path.join(phome, 'missing');
    const refused = await mainMod.handleDownloadModel(undefined);
    assert.strictEqual(refused.ok, false, 'fallback write without consent must refuse');
    assert.strictEqual(refused.needsConsent, true, 'refusal must flag the consent gate');
  } finally {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    fs.rmSync(phome, { recursive: true, force: true });
  }
  // consent gate + persistent fallback notice in the UI
  assert.ok(renderer.includes('needsConsent'), 'renderer must handle the consent gate');
  assert.ok(renderer.includes('confirmDialog'), 'consent must reuse the themed modal');
  assert.ok(renderer.includes('portableNote'), 'renderer must show the fallback notice');
  assert.ok(renderer.includes('fallbackToAppData'), 'notice must follow engine status');
  assert.ok(html.includes('id="portableNote"'), 'UI must have the fallback notice element');
  // instruction label + example copy, output folder shortcut
  assert.ok(html.includes('Instruction in plain English'), 'instruction label must stress plain English');
  assert.ok(html.includes('Convert to mp4,'), 'example copy must use mp4');
  assert.ok(html.includes('id="openFolderBtn"'), 'UI must have the open-folder button');
  assert.ok(html.includes('>Open folder<'), 'open-folder button must be labeled');
  assert.ok(renderer.includes('openFolderBtn'), 'renderer must wire the open-folder button');
  assert.ok(renderer.includes('No output folder to open yet.'), 'empty output must explain the disabled shortcut');
  assert.strictEqual(typeof mainMod.handleOpenPath, 'function');
  await assert.rejects(mainMod.handleOpenPath({}), /No folder/, 'empty path rejected');
  await assert.rejects(mainMod.handleOpenPath({ dirPath: '/no/such/dir-plainffmpeg' }), /not found/, 'missing dir rejected');
  const nsh = fs.readFileSync(path.join(__dirname, '../assets/vc-redist.nsh'), 'utf8');
  assert.ok(nsh.includes('customUnInstall'), 'installer must clean up on uninstall');
  assert.ok(nsh.includes('RMDir /r "$APPDATA\\PlainFFmpeg"'), 'uninstall must remove the model data dir');
  assert.ok(renderer.includes('AI model path:'), 'resolved model path must be logged at boot');
  console.log('[smoke] packaging OK');

  // resumable downloader: seeded .part file must resume, not restart
  {
    const http = require('http');
    const PAYLOAD = Buffer.alloc(256 * 1024, 0xab);
    const srv = http.createServer((req, res) => {
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      if (m) {
        const start = parseInt(m[1], 10);
        const slice = PAYLOAD.slice(start);
        res.writeHead(206, {
          'Content-Length': slice.length,
          'Content-Range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
          'Accept-Ranges': 'bytes',
        });
        res.end(slice);
      } else {
        res.writeHead(200, { 'Content-Length': PAYLOAD.length, 'Accept-Ranges': 'bytes' });
        res.end(PAYLOAD);
      }
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const dest = path.join(__dirname, 'smoke-model.tmp');
    try {
      fs.writeFileSync(dest + '.part', PAYLOAD.slice(0, PAYLOAD.length / 2));
      const dl = require('../scripts/download-model.js');
      const seen = [];
      const { bytes } = await dl.downloadTo(`http://127.0.0.1:${srv.address().port}/model.gguf`, dest, {
        onProgress: (p) => seen.push(p),
      });
      assert.strictEqual(bytes, PAYLOAD.length, 'resumed download must total the full payload');
      assert.deepStrictEqual(fs.readFileSync(dest), PAYLOAD, 'resumed bytes must match exactly');
      assert.ok(seen.length > 0 && seen[0].done >= PAYLOAD.length / 2, 'progress must resume from the partial file');
      assert.ok(!fs.existsSync(dest + '.part'), 'no leftover .part file');
    } finally {
      fs.rmSync(dest, { force: true });
      fs.rmSync(dest + '.part', { force: true });
      srv.close();
    }
    console.log('[smoke] resumable download OK');
  }
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  assert.ok(css.includes('.model-dl[hidden]'), 'download card must honor hidden');
  assert.ok(css.includes('#barModel'), 'model progress bar must be styled');
  assert.ok(css.includes('.note.warn'), 'fallback notice must be styled');
  assert.ok(css.includes('max-height: 320px'), 'video preview must be size-capped');
  assert.ok(css.includes('position: sticky'), 'title bar must stay frozen while scrolling');
  assert.ok(/\.badge\.loading\s*{[^}]*#f2b8b0/i.test(css), 'loading badge must be pastel red');
  assert.ok(/\.badge\.ready\s*{[^}]*#bfe3b8/i.test(css), 'ready badge must be pastel green');
  assert.ok(css.includes('.overlay') && css.includes('.modal'), 'modal styles must exist');
  assert.ok(html.includes('We ask before overwriting an existing file.'), 'hint must promise the ask');
  // terminal starts empty (nothing is ready before the LLM is)
  const termMatch = /<pre id="terminal"[^>]*>([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(termMatch && termMatch[1].trim() === '', 'terminal must not start with "ready"');
  // engineNote success line removed (corrections note stays)
  assert.ok(!renderer.includes("engineNote.textContent = 'Translated locally"),
    'plain "Translated locally" line must be gone');
  assert.ok(renderer.includes('auto-correction(s) applied'), 'corrections note stays');
  console.log('[smoke] copy + consent OK');

  // no long dashes anywhere user- or dev-visible (house style: short hyphen).
  // NOTE: built from a char code so this file stays clean of the banned char.
  const bannedDash = String.fromCharCode(0x2014);
  for (const f of ['src/main.js', 'src/preload.js', 'src/renderer/index.html',
    'src/renderer/renderer.js', 'src/renderer/styles.css', 'package.json',
    'scripts/download-model.js', 'scripts/fetch-vc-redist.js', 'scripts/install-windows.js']) {
    const content = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!content.includes(bannedDash), `${f} must not contain em-dashes`);
  }
  // loading badge copy (no trailing "you can already type")
  assert.ok(renderer.includes("'Loading LLM engine locally…'"), 'badge loading copy');
  assert.ok(!renderer.includes('you can already type'), 'badge must not nag');
  // collapsible logs, collapsed by default
  assert.ok(html.includes('id="toggleLogsBtn"'), 'logs toggle must exist');
  assert.ok(/<pre id="terminal" class="terminal" hidden>/.test(html), 'terminal must start collapsed');
  assert.ok(renderer.includes("toggleLogsBtn.addEventListener('click'"), 'toggle must be wired');
  // capitalized statuses
  for (const s of ["'Translating…'", "'Running…'", "'Failed'", "'Done'", "'Cancelled'", '>Idle<']) {
    assert.ok(renderer.includes(s) || html.includes(s), `status copy must include ${s}`);
  }
  for (const s of ["'translating…'", "'running…'", "'failed'", "'done'", "'cancelled'", '>idle<']) {
    assert.ok(!renderer.includes(s) && !html.includes(s), `lowercase status must be gone: ${s}`);
  }
  console.log('[smoke] style copy OK');

  // system prompt: thorough rules the translator depends on
  assert.ok(mainMod.SYSTEM_PROMPT.includes('ONLY the FFmpeg arguments'), 'prompt must demand args-only output');
  assert.ok(mainMod.SYSTEM_PROMPT.includes('scale=-2:720'), 'prompt must teach scale shorthands');
  assert.ok(mainMod.SYSTEM_PROMPT.includes('duration - N'), 'prompt must teach last-N arithmetic');
  assert.ok(mainMod.SYSTEM_PROMPT.includes('libvpx-vp9'), 'prompt must pin webm codecs');
  assert.ok(mainMod.SYSTEM_PROMPT.includes('EXAMPLES'), 'prompt must carry few-shot examples');
  assert.ok(mainMod.SYSTEM_PROMPT.includes('Never invent'), 'prompt must forbid inventing paths');
  assert.ok(mainMod.SYSTEM_PROMPT.includes('non-thinking mode'), 'prompt must disable Qwen3 thinking traces');
  console.log('[smoke] system prompt OK');

  // button order: Translate only | Translate & Run FFmpeg | Run FFmpeg
  const order = ['translateOnlyBtn', 'translateBtn', 'runBtn'].map((id) => html.indexOf(`id="${id}"`));
  assert.ok(order.every((i) => i !== -1), 'all three action buttons must exist');
  assert.ok(order[0] < order[1] && order[1] < order[2], 'buttons must be ordered Translate only, Translate & Run, Run');
  console.log('[smoke] button order OK');

  // primary button glyph: monochrome mark, never the clashing color emoji
  assert.ok(html.includes('✦ Translate'), 'primary button must use the monochrome glyph');
  assert.ok(!html.includes('✨'), 'color-emoji sparkle must be gone');
  // frameless window + themed title bar
  assert.ok(mainSrc.includes('frame: false'), 'window must be frameless');
  for (const fn of ['handleWindowMin', 'handleWindowMax', 'handleWindowClose']) {
    assert.strictEqual(typeof mainMod[fn], 'function', `${fn} must exist`);
  }
  for (const id of ['titlebar', 'minBtn', 'maxBtn', 'closeBtn']) {
    assert.ok(html.includes(`id="${id}"`), `UI must have #${id}`);
  }
  assert.ok(css.includes('-webkit-app-region: drag'), 'title bar must be draggable');
  assert.ok(css.includes('-webkit-app-region: no-drag'), 'window buttons must be clickable');
  assert.ok(renderer.includes('windowMax'), 'renderer must wire window controls');
  console.log('[smoke] title bar OK');

  // dropzone must not advertise clickability; split progress bars must exist
  assert.ok(!/#dropzone\s*{[^}]*cursor:\s*pointer/.test(css), 'dropzone must not use pointer cursor');
  for (const id of ['barTranslate', 'translateStatus', 'barFfmpeg', 'ffmpegStatus']) {
    assert.ok(html.includes(`id="${id}"`), `UI must have #${id}`);
  }
  assert.ok(css.includes('@keyframes pulse'), 'indeterminate progress animation must exist');
  // anti-vibe palette lock: no purple/indigo gradients, no glow
  assert.ok(!css.includes('linear-gradient'), 'theme must not use gradient fills');
  for (const stale of ['#6c8cff', '#9d7bff', '#4a6cf7', '#8b5cf6', 'text-transform: uppercase']) {
    assert.ok(!css.toLowerCase().includes(stale), `vibe-coded leftover must be gone: ${stale}`);
  }
  assert.ok(renderer.includes('coerceExt'), 'renderer must coerce output extension');
  assert.ok(/\.btn-row\s*{[^}]*justify-content:\s*center/.test(css), 'action buttons must be centered');
  assert.ok(renderer.includes('pathsFromUriList'), 'drop must fall back to text/uri-list');
  assert.ok(renderer.includes('probeMedia'), 'renderer must probe media at load');
  assert.ok(renderer.includes('toFileUrl'), 'preview URLs must be safely encoded');
  assert.ok(renderer.includes('preview.src = toFileUrl(p)'), 'preview must use encoded URLs');
  assert.ok(renderer.includes('Load a video first'), 'translate must require a loaded video');
  assert.ok(renderer.includes('getAsFile'), 'drop must handle DataTransfer.items');
  assert.ok(renderer.includes('dropEffect'), 'drop must advertise copy effect');
  console.log('[smoke] cursor + split progress OK');
  console.log('[smoke] ALL CHECKS PASSED');
}

main().catch((e) => {
  console.error('[smoke] FAILED:', e);
  process.exit(1);
});
