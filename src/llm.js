/**
 * Local LLM engine (node-llama-cpp, lazy init).
 *
 * Loads the GGUF model from the resolved path, owns the session state, and
 * reports load diagnostics. No Electron dependency - the main process
 * orchestrates calls and forwards progress to the renderer.
 */
const path = require('path');
const fs = require('fs');
const { resolveModelPath, existsSyncSafe, msvcRuntimeStatus } = require('./paths');

const SYSTEM_PROMPT = [
  'You are an expert FFmpeg command translator. Convert the user request into FFmpeg command-line arguments.',
  '',
  'OUTPUT FORMAT (strict):',
  '- Output ONLY the FFmpeg arguments, as a single line of plain text.',
  '- NEVER include markdown, code fences, backticks, explanations, or commentary.',
  '- NEVER include the `ffmpeg` binary name - start directly with flags (usually `-i`).',
  '- Exactly ONE command. No pipes, no `&&`, no shell operators, no comments.',
  '- Always answer directly in non-thinking mode: NO thinking trace, NO <think> blocks.',
  '- A trailing `/no_think` marker on the request means the same - obey it.',
  '',
  'INPUT:',
  '- Always include the input exactly once, verbatim, as `-i <INPUT FILE PATH>` using the exact path from the user message.',
  '- If the path contains spaces, wrap it in double quotes.',
  '- Never invent, rename, shorten, or alter the input path. Never fall back to placeholders like input.mp4 when a real path was given.',
  '',
  'OUTPUT FILE (always the last token):',
  '- Always end with exactly one output file path.',
  '- Its extension must match the requested container: .mp4, .mkv, .webm, .mov, .avi, .gif, .mp3.',
  '- If no output name is requested, derive it from the input name (e.g. input "clip.mp4" → "clip-out.mkv").',
  '',
  'TIME AND TRIMMING (input duration in seconds is given when known):',
  '- Time values: plain seconds (90) or HH:MM:SS (00:01:30). Do any arithmetic yourself and output the resulting numbers.',
  '- "trim/cut the FIRST N seconds" (keep the head): `-t N`.',
  '- "trim/cut/remove/delete the LAST N seconds" (cut the tail off, keep the head): `-t (duration - N)`.',
  '- "keep/extract only the LAST N seconds" (keep the tail): `-ss (duration - N)` with NO `-t`.',
  '- "keep/extract the MIDDLE N seconds" (center cut): `-ss (duration - N)/2 -t N`.',
  '- "keep from second A to second B": `-ss A -t (B - A)`.',
  '- Place -ss/-t AFTER the -i flag (accurate seeking).',
  '- Never emit -ss and -t values that contradict the request (e.g. -ss 0 with -t 5 when asked for the last 5 seconds).',
  '',
  'SIZE AND RESOLUTION:',
  '- Frame sizes must be WIDTHxHEIGHT (e.g. 640x360) or a scale filter.',
  '- Resolution shorthands map to even-width scale filters: 144p→scale=-2:144, 240p→scale=-2:240, 360p→scale=-2:360, 480p→scale=-2:480, 720p→scale=-2:720, 1080p→scale=-2:1080, 2160p→scale=-2:2160.',
  '- NEVER output bare sizes like `-s 360p`, `-video_size 720p`, or `scale=720p` - ffmpeg rejects them with "Invalid frame size".',
  '- Use one -vf flag per stream; join multiple video filters with commas.',
  '',
  'CONTAINERS AND CODECS:',
  '- mp4/mov: `-c:v libx264 -c:a aac`, plus `-movflags +faststart` for mp4/mov.',
  '- h265/HEVC: `-c:v libx265` (mp4/mov keep `-c:a aac -movflags +faststart`).',
  '- mkv: `-c:v libx264 -c:a aac` (or `-c:a copy` if the audio is untouched).',
  '- webm: `-c:v libvpx-vp9 -c:a libopus`. NEVER libvpx+libvorbis.',
  '- gif: `-vf "fps=10,scale=480:-1:flags=lanczos"` and NO audio stream.',
  '- mp3 or audio-only: `-vn -c:a libmp3lame`.',
  '- Audio untouched: prefer `-c:a copy`. Mute/remove audio: `-an` (never combine `-an` with an audio codec).',
  '- Grayscale / black-and-white: `-vf hue=s=0`.',
  '',
  'SIZE LIMITS (e.g. "keep it below 2GB", "under 500MB"):',
  '- A size limit with a known duration is ALWAYS enforced with single-pass capped bitrate.',
  '- When the user message states exact numbers ("encode video at about Xk"), apply them verbatim as `-b:v Xk -maxrate Xk -bufsize 2Xk`.',
  '- Keep audio at or below 128k (`-c:a aac -b:a 128k`); use `-an` only if asked; never `-c:a copy` under a size limit.',
  '- NEVER use two-pass (-pass 1 / -pass 2): the runner executes a single ffmpeg command. Single pass with -maxrate is the only option.',
  '',
  'EXAMPLES (each answer is ONE single line ending with the output file):',
  '- "Convert /tmp/in.mp4 (duration 27.49s) to mkv, cut the last 5 seconds, make it 360p" → -i /tmp/in.mp4 -t 22.49 -vf scale=-2:360 -c:v libx264 -c:a aac /tmp/in-out.mkv',
  '- "Convert /tmp/in.mp4 to webm and mute it" → -i /tmp/in.mp4 -c:v libvpx-vp9 -an /tmp/in-out.webm',
  '- "Extract the audio of /tmp/in.mp4 as mp3" → -i /tmp/in.mp4 -vn -c:a libmp3lame /tmp/in-out.mp3',
  '- "Convert /tmp/in.mp4 (duration 60s) to 1080p mp4 below 100MB" → -i /tmp/in.mp4 -vf scale=-2:1080 -c:v libx264 -b:v 13573k -maxrate 13573k -bufsize 27146k -c:a aac -b:a 128k -movflags +faststart /tmp/in-out.mp4',
  '- "Keep the middle 5 seconds of /tmp/in.mp4 (duration 60s), mute it" → -i /tmp/in.mp4 -ss 27.5 -t 5 -an /tmp/in-out.mp4',
].join('\n');

let llamaInitPromise = null;
let llamaSession = null;
let llamaSequence = null;
let llamaModel = null;
let llamaContext = null;
let llamaLoadError = null;

function isLlamaLoading() {
  return llamaSession === null && llamaInitPromise !== null;
}

function hasLlamaSession() {
  return llamaSession !== null;
}

function getLlamaLoadError() {
  return llamaLoadError;
}

// Snapshot of everything the LLM load depends on: runtime ABIs, model file,
// and the on-disk native binary packages. Never throws - meant to turn
// "it doesn't load" into a pasteable answer.
async function llamaDiagnostics() {
  const d = { ok: !!llamaSession };
  try { d.node = process.versions.node || null; } catch { d.node = null; }
  try { d.modules = process.versions.modules || null; } catch { d.modules = null; }
  try { d.electron = (process.versions && process.versions.electron) || null; } catch { d.electron = null; }
  try { d.insideAsar = __filename.includes('.asar'); } catch { d.insideAsar = null; }
  try {
    const mp = resolveModelPath();
    d.modelPath = mp;
    try {
      const st = fs.statSync(mp);
      d.modelExists = st.isFile();
      d.modelSize = st.size;
    } catch { d.modelExists = false; d.modelSize = 0; }
  } catch (e) { d.modelError = String((e && e.message) || e); }
  try { d.llamaResolved = require.resolve('node-llama-cpp'); }
  catch (e) { d.llamaResolveError = String((e && e.message) || e); }
  try {
    // Works both dev (src/../node_modules) and packaged (app.asar/node_modules).
    const binsRoot = path.join(__dirname, '..', 'node_modules', '@node-llama-cpp');
    d.binsPkgs = fs.readdirSync(binsRoot);
  } catch (e) { d.binsError = String((e && e.message) || e); }
  try {
    const llamaDir = path.join(__dirname, '..', 'node_modules', 'node-llama-cpp', 'llama');
    d.llamaDir = fs.readdirSync(llamaDir).slice(0, 25);
  } catch (e) { d.llamaDirError = String((e && e.message) || e); }
  try { d.msvc = msvcRuntimeStatus(); } catch (e) { d.msvcError = String((e && e.message) || e); }
  d.prebuilt = await llamaPrebuiltProbe();
  return d;
}

// Replicates the loader's own lookup step by step: dynamic-import the
// platform bins package, read getBinsDir(), and check the binding binary in
// both the asar and the unpacked location. Whatever link breaks in a
// packaged app shows up here as false.
async function llamaPrebuiltProbe() {
  const out = { importOk: false };
  try {
    const plat = process.platform === 'win32' ? 'win-x64'
      : process.platform === 'darwin'
        ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
        : (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64');
    out.package = `@node-llama-cpp/${plat}`;
    const mod = await import(`@node-llama-cpp/${plat}`);
    const { binsDir, packageVersion } = (mod && mod.getBinsDir && mod.getBinsDir()) || {};
    out.importOk = true;
    out.binsDir = binsDir || null;
    out.packageVersion = packageVersion || null;
    out.folders = {};
    let subs = [];
    try { subs = binsDir ? fs.readdirSync(binsDir) : []; }
    catch (e) { out.binsError = String((e && e.message) || e); }
    for (const sub of subs.slice(0, 10)) {
      const asarNode = path.join(binsDir, sub, 'llama-addon.node');
      const unpNode = asarNode.split('.asar' + path.sep).join('.asar.unpacked' + path.sep);
      const asarMeta = path.join(binsDir, sub, '_nlcBuildMetadata.json');
      const unpMeta = asarMeta.split('.asar' + path.sep).join('.asar.unpacked' + path.sep);
      out.folders[sub] = {
        nodeInAsar: existsSyncSafe(asarNode),
        nodeUnpacked: existsSyncSafe(unpNode),
        metaInAsar: existsSyncSafe(asarMeta),
        metaUnpacked: existsSyncSafe(unpMeta),
      };
    }
  } catch (e) {
    out.importError = String((e && e.message) || e);
  }
  return out;
}

async function llamaDiagSummary() {
  try {
    const d = await llamaDiagnostics();
    const bins = Array.isArray(d.binsPkgs) ? d.binsPkgs.join(',') : 'none';
    let msvcBit = ' msvc=n/a';
    try {
      const m = d.msvc;
      if (m && m.applicable) msvcBit = ` msvc=${m.present ? 'ok' : 'missing:' + (m.missing || []).join(',')}`;
    } catch { /* keep n/a */ }
    return `node=${d.node || '?'} modules=${d.modules || '?'} electron=${d.electron || 'n/a'} ` +
      `model=${d.modelExists ? d.modelSize + 'B' : 'missing'} bins=[${bins}]${msvcBit}`;
  } catch { return 'diagnostics unavailable'; }
}

async function getLlamaSession() {
  if (llamaSession) return llamaSession;
  if (llamaInitPromise) return llamaInitPromise;

  llamaInitPromise = (async () => {
    const modelPath = resolveModelPath();
    if (!fs.existsSync(modelPath)) {
      throw new Error(
        `Model file not found at ${modelPath}. Run "npm run download-model" first.`
      );
    }
    // node-llama-cpp v3 is pure ESM ("type": "module"), so it cannot be
    // require()d from this CommonJS main process - dynamic import() works
    // everywhere, including inside Electron's main process.
    const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    const llama = await getLlama();
    llamaModel = await llama.loadModel({ modelPath });
    llamaContext = await llamaModel.createContext();
    llamaSequence = llamaContext.getSequence();
    llamaSession = new LlamaChatSession({
      contextSequence: llamaSequence,
      systemPrompt: SYSTEM_PROMPT,
    });
    console.log('[main] node-llama-cpp model loaded:', modelPath);
    return llamaSession;
  })();

  try {
    const session = await llamaInitPromise;
    llamaLoadError = null;
    return session;
  } catch (err) {
    llamaInitPromise = null;
    llamaLoadError = err && err.message ? err.message : String(err);
    throw err;
  }
}

module.exports = {
  SYSTEM_PROMPT,
  isLlamaLoading,
  hasLlamaSession,
  getLlamaLoadError,
  llamaDiagnostics,
  llamaPrebuiltProbe,
  llamaDiagSummary,
  getLlamaSession,
};
