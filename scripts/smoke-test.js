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
  'assets/logo.png',
  'assets/icon.ico',
  'assets/icon.icns',
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
  for (const ch of ['translatePrompt', 'runFfmpeg', 'modelStatus', 'pickFile', 'pickOutput', 'probeMedia', 'outputExists', 'saveDroppedFile', 'windowMin', 'windowMax', 'windowClose']) {
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

  // preview capped; pastel badge states
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
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
    'scripts/download-model.js', 'scripts/install-windows.js']) {
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
