/**
 * Deterministic correction layers for the translation pipeline.
 *
 * Pure functions, no filesystem: each takes parsed args and returns
 * { args, corrections } without throwing. They turn common LLM mistakes
 * into commands ffmpeg actually accepts, and every rewrite is reported so
 * the UI can log it. Order of application lives in runTranslationPipeline
 * below and is fixed - do not reorder the steps.
 */

function sanitizeModelOutput(raw) {
  let text = String(raw || '').trim();
  // Qwen3 hybrid models may emit a thinking trace despite non-thinking mode -
  // drop it before anything else so only the final answer is parsed.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Orphan thinking tags (unclosed block from a cut-off answer) - strip the
  // tags themselves so they can never leak into a kept content line.
  text = text.replace(/<\/?think>/gi, '').trim();
  // Strip markdown fences / backticks the model may add despite the system prompt.
  text = text.replace(/```(?:bash|sh|ffmpeg)?/gi, '').replace(/```/g, '').replace(/`/g, '').trim();
  // Split into lines, strip list markers/bullets/arrows ("- ", "*", "1.", "→").
  // A lone leading dash is only a bullet when followed by whitespace -
  // never eat the `-` of a flag like `-i`.
  const lines = text
    .split('\n')
    .map((l) => l.trim().replace(/^(?:[*→>]+|\d+[.)]|-\s+)\s*/, ''))
    .filter(Boolean);
  // Keep content lines (flags, template tokens, or media paths); drop prose ("Here is…").
  const kept = lines.filter(
    (l) => /-[a-zA-Z]/.test(l) || /\{(input|output)\}/.test(l) || /\.(mp4|mkv|webm|mov|avi|gif|mp3|png|jpe?g)\b/i.test(l)
  );
  const joined = (kept.length > 0 ? kept : lines).join(' ');
  // Drop a leading shell prompt and/or "ffmpeg" binary name - the renderer
  // prepends the binary path.
  const s = joined.replace(/^(?:(?:\$|>)\s*)?ffmpeg(?:\.exe)?\s+/i, '').trim();
  // Completeness gate: must name an input. A missing trailing output file
  // is recovered downstream (ensureOutputFile); pure prose fails here.
  const toks = s.split(/\s+/).filter(Boolean);
  if (!toks.includes('-i')) {
    throw new Error('LLM output incomplete (no input file). Try again.');
  }
  return s;
}

function looksLikeFileToken(tok) {
  const t = String(tok || '');
  return /[/\\]/.test(t) || /\.[A-Za-z0-9]{2,4}["']?$/i.test(t);
}

// Numeric flag values (2.5M, 00:00:05.000, 30) are not output filenames.
function looksLikeFlagValue(tok) {
  const t = String(tok || '').trim();
  return /^\d+(?:\.\d+)?(?:[kKmMgG%])?$/.test(t)
    || /^\d+(?::\d+){1,2}(?:\.\d+)?$/.test(t);
}

// The model works with template tokens, never real paths: the input is
// always `-i {input}` and the output is always the trailing `{output}`.
// The runner resolves both to real paths at run time.
function ensureOutputFile(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args) || args.length === 0) return { args, corrections };
  const out = [...args];
  // Truncated answer ending on a valued flag (e.g. "... -movflags" with no
  // output yet): the appended filename would be swallowed as the flag's
  // value, so drop the dangling flag first. Valueless flags (-y, -an, -vn)
  // are kept - they are complete on their own.
  const valuedFlags = new Set([
    '-i', '-ss', '-t', '-to', '-s', '-video_size', '-vf', '-filter:v',
    '-filter:a', '-filter_complex', '-c', '-c:v', '-c:a', '-b:v', '-b:a',
    '-maxrate', '-bufsize', '-ac', '-ar', '-r', '-pix_fmt', '-crf', '-preset',
    '-tune', '-movflags', '-map', '-pass', '-passlogfile', '-f', '-frames',
    '-frames:v', '-metadata', '-aspect', '-fs',
  ]);
  const dropped = [];
  while (out.length > 0 && valuedFlags.has(out[out.length - 1])) {
    dropped.unshift(out.pop());
  }
  if (dropped.length > 0) {
    corrections.push(`Dropped dangling ${dropped.join(', ')} (truncated answer left a flag with no value)`);
  }
  if (out[out.length - 1] === '{output}') return { args: out, corrections };
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  // A bare trailing filename ("out") is still an output, but a value that
  // belongs to the previous flag ("-c:v libx264", "-f mp4") is not.
  const replaceable = last
    && !String(last).startsWith('-')
    && !looksLikeFlagValue(last)
    && !(prev && valuedFlags.has(String(prev)))
    && (looksLikeFileToken(last) || !prev || !String(prev).startsWith('-'));
  if (replaceable) {
    out[out.length - 1] = '{output}';
    corrections.push(`Replaced "${last}" with {output} (paths are templated, never literal)`);
    return { args: out, corrections };
  }
  out.push('{output}');
  corrections.push('LLM omitted the output file - appended {output}');
  return { args: out, corrections };
}

const THUMBNAIL_RE = /\bthumbnails?\b|\bposter\b|\bscreenshots?\b|\bstill\s+(?:image|frame)\b|\bcover\s+(image|frame|art)\b|\bextract\s+(?:a\s+)?(?:single\s+)?frames?\b/i;

// The container named after "to/as/into/output" wins over source words:
// "convert mkv to mp4" is mp4, and "gif to mp4" is not a gif request.
function targetContainer(text) {
  const re = /\b(?:to|into|as|output(?:\s+(?:as|to))?)\s+(?:a\s+|an\s+)?(mp4|mkv|webm|mov|avi|gif|mp3|png|jpe?g)\b/gi;
  let m;
  let last = null;
  while ((m = re.exec(String(text || ''))) !== null) last = m[1].toLowerCase();
  return last;
}

function extForWord(word) {
  if (word === 'jpeg' || word === 'jpg') return '.jpg';
  return '.' + word;
}

function audioCodecForExt(ext) {
  if (ext === '.webm') return 'libopus';
  if (ext === '.mp3') return 'libmp3lame';
  return 'aac';
}

// Output container from the instruction words (plus codec hints), since the
// templated `{output}` carries no extension. Thumbnail and gif intents own
// their containers; otherwise the last explicit target wins, then source
// words, then codec hints, then .mp4.
function inferOutputExt(args, instruction) {
  const text = String(instruction || '');
  if (THUMBNAIL_RE.test(text)) {
    return /\bjpe?g\b/i.test(text) ? '.jpg' : '.png';
  }
  const target = targetContainer(text);
  if (target) return extForWord(target === 'gif' ? 'gif' : target);
  if (/\bgif\b/i.test(text)) return '.gif';
  const lower = text.toLowerCase();
  const wordExt =
    /\bmkv\b/.test(lower) ? '.mkv'
    : /\bwebm\b/.test(lower) ? '.webm'
    : /\bmp3\b|\baudio only\b|\bextract (the )?audio\b/.test(lower) ? '.mp3'
    : /\bmov\b/.test(lower) ? '.mov'
    : /\bavi\b/.test(lower) ? '.avi'
    : /\bmp4\b/.test(lower) ? '.mp4'
    : /\bpng\b/.test(lower) ? '.png'
    : /\bjpe?g\b/.test(lower) ? '.jpg'
    : null;
  const joined = (Array.isArray(args) ? args.join(' ') : '').toLowerCase();
  return wordExt
    || (joined.includes('libvpx-vp9') || joined.includes('libopus') ? '.webm' : null)
    || (joined.includes('libmp3lame') || /\s-vn(\s|$)/.test(joined + ' ') ? '.mp3' : null)
    || '.mp4';
}

// Run-time substitution of the template tokens with the run's real paths.
// Total: tokens without a provided path are left alone so the caller can
// report exactly which path is missing. Never throws.
function resolvePlaceholders(args, inputFile, outputFile) {
  if (!Array.isArray(args)) return args;
  return args.map((t) => {
    if (t === '{input}' && inputFile) return inputFile;
    if (t === '{output}' && outputFile) return outputFile;
    return t;
  });
}

function tokenizeArgs(argString) {
  // Minimal shell-aware splitter (handles single/double quotes).
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < argString.length; i++) {
    const c = argString[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  // Ensure an input is present (templated - resolved at run time).
  if (!tokens.includes('-i')) return ['-i', '{input}', ...tokens];
  return tokens;
}

// Height (p) shorthands some models emit, mapped to even-width scale filters.
const P_HEIGHTS = new Set([144, 240, 360, 480, 720, 1080, 1440, 2160]);

// Deterministic correction layer for common LLM mistakes that ffmpeg rejects,
// e.g. `-s 360p` ("Invalid frame size: 360p") or `scale=720p` inside -vf.
// Returns { args, corrections } - never throws.
function fixupArgs(args) {
  const corrections = [];
  const out = [];
  const pendingFilters = [];
  let insertAt = -1;

  const shorthandHeight = (v) => {
    const m = /^(?:(\d{3,4})[pP]|4[kK])$/.exec(String(v || '').trim());
    if (!m) return null;
    const h = m[1] ? parseInt(m[1], 10) : 2160;
    return P_HEIGHTS.has(h) ? h : null;
  };

  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    const nx = args[i + 1];
    if ((t === '-s' || t === '-video_size') && nx !== undefined) {
      const h = shorthandHeight(nx);
      if (h !== null) {
        if (insertAt === -1) insertAt = out.length;
        pendingFilters.push(`scale=-2:${h}`);
        corrections.push(`Rewrote "${t} ${nx}" as scale=-2:${h} ("${nx}" is not a valid frame size)`);
        i++; // skip the bad value
        continue;
      }
    }
    out.push(t);
  }

  // Fix scale=NNNp inside -vf / -filter:v values (valid form is scale=-2:H).
  for (let i = 0; i < out.length; i++) {
    if ((out[i] === '-vf' || out[i] === '-filter:v') && typeof out[i + 1] === 'string') {
      out[i + 1] = out[i + 1].replace(/\bscale=(\d{3,4})[pP]\b/g, (m, n) => {
        const h = parseInt(n, 10);
        if (P_HEIGHTS.has(h)) {
          corrections.push(`Rewrote "scale=${n}p" as scale=-2:${h} inside -vf`);
          return `scale=-2:${h}`;
        }
        return m;
      });
    }
  }

  // Multiple -vf/-filter:v flags: ffmpeg honors only the LAST one, silently
  // dropping the earlier chains. Merge them into a single comma-joined chain.
  {
    const seen = [];
    for (let i = 0; i < out.length; i++) {
      if ((out[i] === '-vf' || out[i] === '-filter:v') && typeof out[i + 1] === 'string') {
        seen.push({ idx: i, val: out[i + 1] });
      }
    }
    if (seen.length > 1) {
      out[seen[0].idx] = '-vf';
      out[seen[0].idx + 1] = seen.map((s) => s.val).join(',');
      for (let k = seen.length - 1; k >= 1; k--) out.splice(seen[k].idx, 2);
      corrections.push(`Merged ${seen.length} -vf chains into one (ffmpeg keeps only the last -vf)`);
    }
  }

  if (pendingFilters.length > 0) {
    const vfIdx = out.findIndex((t) => t === '-vf' || t === '-filter:v');
    if (vfIdx !== -1 && typeof out[vfIdx + 1] === 'string') {
      out[vfIdx + 1] = `${out[vfIdx + 1]},${pendingFilters.join(',')}`;
    } else if (insertAt !== -1) {
      out.splice(insertAt, 0, '-vf', pendingFilters.join(','));
    } else {
      out.push('-vf', pendingFilters.join(','));
    }
  }

  return { args: out, corrections };
}

// Bare codec words are not encoder names: ffmpeg knows libx265, not h265.
// The model often echoes the user's words into -c:v/-c:a, so normalize
// them (case-insensitive) to real encoder names. `copy` and correct values
// pass through untouched. Returns { args, corrections } - never throws.
const CODEC_ALIASES = {
  h264: 'libx264', x264: 'libx264', avc: 'libx264',
  h265: 'libx265', x265: 'libx265', hevc: 'libx265',
  vp9: 'libvpx-vp9', vp8: 'libvpx',
  mp3: 'libmp3lame', aac: 'aac', opus: 'libopus', vorbis: 'libvorbis',
  copy: 'copy',
};

function fixupCodecs(args) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    if ((out[i] === '-c:v' || out[i] === '-c:a') && typeof out[i + 1] === 'string') {
      const want = CODEC_ALIASES[String(out[i + 1]).toLowerCase()];
      if (want && out[i + 1] !== want) {
        corrections.push(`Replaced "${out[i]} ${out[i + 1]}" with "${out[i]} ${want}" (ffmpeg has no "${out[i + 1]}" encoder)`);
        out[i + 1] = want;
      }
    }
  }
  return { args: out, corrections };
}

function quoteArgs(args) {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

// The model must use the template token, never a real path: any `-i`
// value becomes `{input}`, and a missing `-i` is inserted up front.
// Returns { args, corrections } - never throws.
function fixupInput(args) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const out = [...args];
  let kept = false;
  for (let i = 0; i < out.length;) {
    if (out[i] !== '-i') { i++; continue; }
    const nx = out[i + 1];
    if (typeof nx !== 'string' || String(nx).startsWith('-')) {
      out.splice(i, 1);
      corrections.push('Removed dangling "-i" (the input path is templated, never literal)');
      continue;
    }
    if (!kept) {
      if (nx !== '{input}') {
        out[i + 1] = '{input}';
        corrections.push(`Rewrote "-i ${nx}" as "-i {input}" (paths are templated, never literal)`);
      }
      kept = true;
      i += 2;
      continue;
    }
    out.splice(i, 2);
    corrections.push(`Dropped extra "-i ${nx}" (the app runs one input file)`);
  }
  if (!kept) {
    out.unshift('-i', '{input}');
    corrections.push('Inserted missing "-i {input}" (paths are templated, never literal)');
  }
  return { args: out, corrections };
}

function parseHMS(h, m, s) {
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
}

// Failure diagnosis for environment and input problems (correct command,
// machine or file cannot do the work). Returns a hint or null.
function ffmpegFailureHint(stderr) {
  const text = String(stderr || '');
  if (/cannot allocate memory|malloc.*failed|out of memory/i.test(text)) {
    return 'Likely cause: FFmpeg ran out of memory. Rendering at high resolution and frame rate (e.g. upscaling 720p to 4K at 60fps) needs a lot of RAM and Windows Sandbox has very little. ' +
      'Note: upscaling cannot add detail beyond the source - it only makes a bigger file. ' +
      'Try a smaller target like 1080p, close other apps, or run on a machine with more memory.';
  }
  if (/error submitting packet to decoder|failed to decode frame|corrupt frame|no sequence header|invalid data found/i.test(text)) {
    return 'Likely cause: the input has corrupt frames, or a cut on stream-copy landed between keyframes. ' +
      'Re-encode instead of stream-copy (drop -c:v copy / -c copy), keep -ss/-t after -i for accurate seeking. ' +
      'If the errors persist on a plain convert, the file itself is damaged - try another file.';
  }
  return null;
}

// Parse an -ss/-t value: seconds float or [[HH:]MM:]SS[.ms].
function parseTimeVal(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.includes(':')) {
    const parts = s.split(':').map((x) => parseFloat(x));
    if (parts.some((x) => !Number.isFinite(x))) return null;
    let total = 0;
    for (const p of parts) total = total * 60 + p;
    return total;
  }
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : null;
}

function fmtSec(sec) {
  return String(Math.round(sec * 100) / 100);
}

// Shared arg-list helpers: every insertion below slots new flags before the
// trailing output token so flag/value pairs are never split apart.
function hasTrailingOutput(out) {
  if (!out.length) return false;
  const last = out[out.length - 1];
  if (last === '{output}') return true;
  if (!looksLikeFileToken(last) || looksLikeFlagValue(last)) return false;
  // `-i in.mp4` is an input pair, not an output token.
  return out[out.length - 2] !== '-i';
}

function insertBeforeOutput(out, ...tokens) {
  const at = hasTrailingOutput(out) ? out.length - 1 : out.length;
  out.splice(at, 0, ...tokens);
  return at;
}

// Time comparisons tolerate sub-second model rounding (00:00:05 vs 5).
function timesApprox(a, b, tol) {
  return a !== null && b !== null && Math.abs(a - b) < (tol === undefined ? 0.51 : tol);
}

// Read the seek/duration flags as parsed numbers.
function getTimeFlags(out) {
  const ssIdx = out.findIndex((t) => t === '-ss');
  const tIdx = out.findIndex((t) => t === '-t');
  return {
    ssIdx,
    tIdx,
    ssVal: ssIdx !== -1 ? parseTimeVal(out[ssIdx + 1]) : null,
    tVal: tIdx !== -1 ? parseTimeVal(out[tIdx + 1]) : null,
  };
}

// Set seek/duration values (formatted strings; null leaves that flag alone),
// inserting missing flags before the output token.
function setTimeFlags(out, ss, t) {
  if (ss !== null && ss !== undefined) {
    const f = getTimeFlags(out);
    if (f.ssIdx !== -1) out[f.ssIdx + 1] = ss;
    else insertBeforeOutput(out, '-ss', ss);
  }
  if (t !== null && t !== undefined) {
    const f = getTimeFlags(out);
    if (f.tIdx !== -1) out[f.tIdx + 1] = t;
    else insertBeforeOutput(out, '-t', t);
  }
}

// Drop a seek/duration flag with its value (a dangling valueless flag drops
// alone so the output token is never eaten).
function dropTimeFlag(out, flag) {
  const i = out.findIndex((t) => t === flag);
  if (i === -1) return false;
  const nx = out[i + 1];
  out.splice(i, (nx !== undefined && !String(nx).startsWith('-')) ? 2 : 1);
  return true;
}

// Repeated seeks: ffmpeg silently honors one of them (the last -ss wins for
// output seeking), so a doubled flag means a wrong window with no error.
// Keep the last occurrence - it is the one ffmpeg would honor - and report
// every dropped duplicate.
function fixupDedupeSeek(args) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const out = [...args];
  for (const flag of ['-ss', '-t']) {
    let first = out.indexOf(flag);
    let last = out.lastIndexOf(flag);
    while (first !== -1 && first < last) {
      const nx = out[first + 1];
      const val = nx !== undefined && !String(nx).startsWith('-') ? ` ${nx}` : '';
      out.splice(first, val ? 2 : 1);
      corrections.push(`Dropped duplicate "${flag}${val}" (repeated seeks keep the last window)`);
      first = out.indexOf(flag);
      last = out.lastIndexOf(flag);
    }
  }
  return { args: out, corrections };
}

// Append a filter to the single video/audio chain, creating it if missing.
function appendVideoFilter(out, filter) {
  const i = out.findIndex((t) => t === '-vf' || t === '-filter:v');
  if (i !== -1 && typeof out[i + 1] === 'string') out[i + 1] = `${out[i + 1]},${filter}`;
  else insertBeforeOutput(out, '-vf', filter);
}

function appendAudioFilter(out, filter) {
  const i = out.findIndex((t) => t === '-af' || t === '-filter:a');
  if (i !== -1 && typeof out[i + 1] === 'string') out[i + 1] = `${out[i + 1]},${filter}`;
  else insertBeforeOutput(out, '-af', filter);
}

// Drop valued flags everywhere they appear; returns what was dropped for
// the correction note (a dangling flag drops alone).
function dropValuedFlags(out, flags) {
  const dropped = [];
  for (const flag of flags) {
    let idx = out.findIndex((t) => t === flag);
    while (idx !== -1) {
      const nx = out[idx + 1];
      if (nx === undefined || String(nx).startsWith('-')) {
        out.splice(idx, 1);
        dropped.push(flag);
      } else {
        out.splice(idx, 2);
        dropped.push(`${flag} ${nx}`);
      }
      idx = out.findIndex((t) => t === flag);
    }
  }
  return dropped;
}

// File-size constraint in the instruction ("below 2GB", "under 500MB",
// "2GB file size", "500MB max") → bytes. Returns null when absent.
function parseSizeLimit(instruction) {
  const text = String(instruction || '');
  const unitScale = { gb: 1024 ** 3, g: 1024 ** 3, mb: 1024 ** 2, m: 1024 ** 2, kb: 1024, k: 1024 };
  const patterns = [
    /(?:below|under|less\s+than|at\s+most|up\s+to|max(?:imum)?|keeping?\s+it\s+(?:below|under)|no\s+(?:more|larger)\s+than)\s*(\d+(?:\.\d+)?)\s*(gb|g|mb|m|kb|k)\b/i,
    /(\d+(?:\.\d+)?)\s*(gb|mb|kb)\s*(?:file\s*size|filesize|max|limit|capped?)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return Math.floor(parseFloat(m[1]) * unitScale[m[2].toLowerCase()]);
  }
  return null;
}

function parseBitrateBps(v) {
  if (v === null || v === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(String(v));
  if (!m) return null;
  const scale = m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1;
  return Math.floor(parseFloat(m[1]) * scale);
}

// Single-pass size cap: budget (bytes*8*margin/duration - audio) into
// -b:v/-maxrate/-bufsize, and bound copied audio. One command only, so
// two-pass is never an option.
function fixupSizeLimit(args, instruction, durationSec) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const bytes = parseSizeLimit(instruction);
  if (!bytes || !(durationSec > 0)) return { args, corrections };
  // Speed changes the output duration: budget for what actually comes out
  // (slow motion stretches it, high speed shrinks it).
  const speedX = parseSpeedFactor(instruction);
  const effDuration = speedX ? durationSec / speedX : durationSec;
  const out = [...args];
  const targetExt = inferOutputExt(out, instruction);
  const hasAN = out.includes('-an');
  const hasVN = out.includes('-vn');
  const audioOnly = hasVN || targetExt === '.mp3';
  const webm = targetExt === '.webm';
  const audioCodec = audioCodecForExt(targetExt);
  let audioBits = hasAN ? 0 : 128000;
  // Copied streams have no bitrate to cap. Re-encode video, and bound audio,
  // so the size limit is a real guarantee instead of ignored flags.
  const cvIdx = out.findIndex((t) => t === '-c:v');
  if (!audioOnly && cvIdx !== -1 && String(out[cvIdx + 1]).toLowerCase() === 'copy') {
    out[cvIdx + 1] = webm ? 'libvpx-vp9' : 'libx264';
    corrections.push(`Size limit: replaced \`-c:v copy\` with \`-c:v ${out[cvIdx + 1]}\` (copied video cannot be capped)`);
  }
  const cIdx = out.findIndex((t) => t === '-c');
  if (!audioOnly && cIdx !== -1 && String(out[cIdx + 1]).toLowerCase() === 'copy') {
    const codecs = ['-c:v', webm ? 'libvpx-vp9' : 'libx264'];
    if (!hasAN && !out.some((t) => t === '-c:a')) codecs.push('-c:a', audioCodec);
    out.splice(cIdx, 2, ...codecs);
    corrections.push('Size limit: replaced `-c copy` with real encoders (copied streams cannot be capped)');
  }
  const caIdx = out.findIndex((t) => t === '-c:a');
  if (audioOnly) {
    if (hasAN) return { args: out, corrections };
    // No video stream to budget: cap the audio itself. A bare -c copy also
    // copies audio, so it must become a real encoder before -b:a means anything.
    const allCopyIdx = out.findIndex((t) => t === '-c');
    if (allCopyIdx !== -1 && String(out[allCopyIdx + 1]).toLowerCase() === 'copy') {
      out.splice(allCopyIdx, 2);
      if (!out.some((t) => t === '-c:a')) insertBeforeOutput(out, '-c:a', audioCodec);
      corrections.push(`Size limit: replaced \`-c copy\` with \`-c:a ${audioCodec}\` (copied audio has no size bound)`);
    }
    const caNow = out.findIndex((t) => t === '-c:a');
    if (caNow !== -1 && String(out[caNow + 1]).toLowerCase() === 'copy') {
      out[caNow + 1] = audioCodec;
      corrections.push(`Size limit: replaced \`-c:a copy\` with \`-c:a ${audioCodec}\` (copied audio has no size bound)`);
    }
    const audioBps = Math.max(32000, Math.floor((bytes * 8 * 0.98) / effDuration));
    const ak = Math.floor(Math.min(128000, audioBps) / 1000);
    const baIdx = out.findIndex((t) => t === '-b:a');
    if (baIdx !== -1) out[baIdx + 1] = `${ak}k`;
    else insertBeforeOutput(out, '-b:a', `${ak}k`);
    corrections.push(`Size limit: capped audio-only output at -b:a ${ak}k`);
    return { args: out, corrections };
  }
  if (!hasAN && caIdx !== -1 && String(out[caIdx + 1]).toLowerCase() === 'copy') {
    out[caIdx + 1] = audioCodec;
    out.splice(caIdx + 2, 0, '-b:a', '128k');
    audioBits = 128000;
    corrections.push(`Size limit: replaced \`-c:a copy\` with \`-c:a ${out[caIdx + 1]} -b:a 128k\` (copied audio has no size bound)`);
  } else if (!hasAN) {
    const baIdx = out.findIndex((t) => t === '-b:a');
    if (baIdx !== -1) {
      const v = parseBitrateBps(out[baIdx + 1]);
      if (v) audioBits = v;
      if (v && v > 128000) {
        out[baIdx + 1] = '128k';
        audioBits = 128000;
        corrections.push('Size limit: capped `-b:a` at 128k (audio must stay bounded)');
      }
    }
  }
  const videoBps = Math.max(100000, Math.floor((bytes * 8 * 0.98) / effDuration - audioBits));
  const vk = Math.floor(videoBps / 1000);
  const setFlag = (flag, value) => {
    const i = out.findIndex((t) => t === flag);
    if (i !== -1) {
      if (String(out[i + 1]) !== String(value)) {
        out[i + 1] = value;
        return true;
      }
      return false;
    }
    const at = out.length > 0 && !String(out[out.length - 1]).startsWith('-') ? out.length - 1 : out.length;
    out.splice(at, 0, flag, value);
    return true;
  };
  let touched = false;
  touched = setFlag('-b:v', `${vk}k`) || touched;
  touched = setFlag('-maxrate', `${vk}k`) || touched;
  touched = setFlag('-bufsize', `${vk * 2}k`) || touched;
  if (touched) {
    const human = bytes >= 1024 ** 3
      ? `${+(bytes / 1024 ** 3).toFixed(2)}GB`
      : `${+(bytes / 1024 ** 2).toFixed(1)}MB`;
    corrections.push(
      `Size limit ${human} for ${fmtSec(effDuration)}s video: capped single-pass video at -b:v ${vk}k`
    );
  }
  return { args: out, corrections };
}

// Single source of truth for trim intent: exactly one kind per instruction
// (middle wins ties; bare "the last N s" keeps the tail). Range returns
// {kind, a, b, rawA, rawB} (kept seconds [a, b]).
function parseTrimIntent(instruction) {
  const instr = String(instruction || '');
  const num = (re) => {
    const m = re.exec(instr);
    return m ? { n: parseFloat(m[1]), raw: m[1] } : null;
  };
  const SEC = '\\s*s(?:ec(?:ond)?s?)?';
  const mid = num(new RegExp('middle\\s+(\\d+(?:\\.\\d+)?)' + SEC, 'i'));
  if (mid && mid.n > 0) {
    // "Remove/cut the middle N" is not a single contiguous window; the
    // pipeline rejects it instead of silently keeping the middle.
    const keepMid = /\b(?:keep|keeping|extract|only|just)\b[^.]{0,16}\bmiddle\b/i.test(instr)
      || /\b(?:trim|cut|shorten)\b[^.]{0,40}\b(?:to|down\s+to|until)\s+(?:the\s+)?middle\b/i.test(instr);
    const removeMid = !keepMid
      && /\b(?:remove|delete|cut|drop|strip|trim|skip|omit|exclude)\b[^.]{0,30}\bmiddle\b/i.test(instr);
    return { kind: removeMid ? 'middle-remove' : 'middle', n: mid.n, raw: mid.raw };
  }
  const last = num(new RegExp('last\\s+(\\d+(?:\\.\\d+)?)' + SEC, 'i'));
  if (last && last.n > 0) {
    // Explicit keep-the-tail phrasing beats removal verbs. "Without audio"
    // describes the stream, not a cut, so it never implies removal.
    const keepTail = /\b(?:keep|keeping|extract|only|just)\b[^.]{0,16}\blast\s+\d/i.test(instr)
      || /\b(?:trim|cut|shorten)\b[^.]{0,40}\b(?:to|down\s+to|until)\s+(?:the\s+)?last\s+\d/i.test(instr);
    const exceptLast = /\b(?:everything|all)\b[^.]{0,30}\b(?:except|but(?:\s+not)?)\b[^.]{0,30}\blast\s+\d/i.test(instr);
    const removal = exceptLast || (!keepTail
      && /\b(?:remove|removing|delete|delet|trim|trimming|cut|cutting|drop|strip|skip|omit|exclude)\b/i.test(instr));
    return { kind: removal ? 'last-remove' : 'last-keep', n: last.n, raw: last.raw };
  }
  const first = num(new RegExp('\\bfirst\\s+(\\d+(?:\\.\\d+)?)' + SEC, 'i'));
  if (first && first.n > 0) {
    // "Trim it to the first N" keeps the head, while "remove the first N"
    // cuts it. "Keep everything except the first N" is a first-remove.
    const keepHead = /\b(?:keep|keeping|extract|only|just)\b[^.]{0,16}\bfirst\s+\d/i.test(instr)
      || /\b(?:trim|cut|shorten)\b[^.]{0,40}\b(?:to|down\s+to|until)\s+(?:the\s+)?first\s+\d/i.test(instr);
    const exceptFirst = /\b(?:everything|all)\b[^.]{0,30}\b(?:except|but(?:\s+not)?)\b[^.]{0,30}\bfirst\s+\d/i.test(instr);
    const removal = exceptFirst || (!keepHead
      && /\b(?:remove|removing|delete|delet|trim|trimming|cut|cutting|drop|strip|skip|omit|exclude)\b/i.test(instr));
    return { kind: removal ? 'first-remove' : 'first-keep', n: first.n, raw: first.raw };
  }
  // Range forms require a time unit, an explicit "seconds" word, or a
  // keep/extract/cut verb. Resolutions, frame rates, and bitrates never
  // become a time window.
  const A = '(\\d+(?::\\d+){0,2}(?:\\.\\d+)?)';
  const U = '\\s*(?:s(?:ec(?:ond)?s?)?)';
  const rangePatterns = [
    new RegExp(`\\bfrom\\s+${A}${U}?\\s*(?:to|until|-)\\s*${A}${U}\\b`, 'i'),
    new RegExp(`\\bfrom\\s+${A}${U}\\s*(?:to|until|-)\\s*${A}\\b`, 'i'),
    new RegExp(`\\bbetween\\s+${A}${U}?\\s*(?:and|to)\\s*${A}${U}\\b`, 'i'),
    new RegExp(`\\bseconds?\\s+${A}\\s*(?:to|until|-)\\s*${A}\\b`, 'i'),
    new RegExp(`\\b(?:keep|extract|cut)\\s+(?:from\\s+)?${A}\\s*(?:to|until|-)\\s*${A}\\s*(?!\\s*(?:fps|mbps|kbps|kb|mb|gb|px|p\\b|%))`, 'i'),
    new RegExp(`\\b${A}${U}\\s*(?:to|until|-)\\s*${A}${U}\\b`, 'i'),
  ];
  for (const re of rangePatterns) {
    const m = re.exec(instr);
    if (!m) continue;
    const a = parseTimeVal(m[1]);
    const b = parseTimeVal(m[2]);
    if (a !== null && b !== null && a >= 0 && b > a) {
      return { kind: 'range', a, b, rawA: m[1], rawB: m[2] };
    }
  }
  return { kind: 'none', n: 0, raw: '' };
}

// Trim kinds that cannot be resolved without the probed duration. The renderer
// duration gate duplicates this list (browser cannot require this module) -
// a smoke test asserts the two stay in sync.
function trimNeedsDuration(kind) {
  return kind === 'last-remove' || kind === 'last-keep' || kind === 'middle';
}

// "last N seconds" needs the input duration to resolve. Removal phrasing
// ("trim/cut/remove/delete the last N s") keeps [0, D-N]; anything else
// ("keep/extract the last N s") keeps [D-N, end], always normalized to
// exactly -ss D-N (a wrong lone -ss or -t would keep the wrong window).
function fixupLastTrim(args, instruction, durationSec) {
  const corrections = [];
  if (!durationSec || !(durationSec > 0) || !Array.isArray(args)) return { args, corrections };
  const intent = parseTrimIntent(instruction);
  if (intent.kind !== 'last-remove' && intent.kind !== 'last-keep') return { args, corrections };
  const N = intent.n;
  if (!(N > 0) || N >= durationSec) return { args, corrections };

  const out = [...args];
  if (intent.kind === 'last-remove') {
    // Keep [0, D-N]: strip any -ss, ensure -t D-N. A mid-file -ss would
    // contradict keeping the beginning, and -ss 0 is a no-op anyway.
    const want = fmtSec(durationSec - N);
    let changed = false;
    if (dropTimeFlag(out, '-ss')) changed = true;
    const f = getTimeFlags(out);
    if (f.tIdx !== -1) {
      if (!timesApprox(f.tVal, durationSec - N)) {
        out[f.tIdx + 1] = want;
        changed = true;
      }
    } else {
      insertBeforeOutput(out, '-t', want);
      changed = true;
    }
    if (changed) corrections.push(`"last ${intent.raw}s" cut from ${fmtSec(durationSec)}s - keeping [0, ${want}s]`);
    return { args: out, corrections };
  }

  // Keep [D-N, end]: needs -ss D-N and no -t. Always normalized: a wrong
  // -ss alone or a lone -t would otherwise keep the wrong window silently.
  const want = fmtSec(durationSec - N);
  const wantNum = durationSec - N;
  const f = getTimeFlags(out);
  if (f.ssIdx !== -1 && timesApprox(f.ssVal, wantNum) && f.tIdx === -1) {
    return { args: out, corrections };
  }
  setTimeFlags(out, want, null);
  dropTimeFlag(out, '-t');
  corrections.push(`"last ${intent.raw}s" of ${fmtSec(durationSec)}s starts at ${want}s - keeping everything from ${want}s to the end`);
  return { args: out, corrections };
}

// "middle N seconds" needs the input duration to resolve: keep the center
// cut [S, S+N] where S = (D-N)/2, via `-ss S -t N`. Rewrites only the
// clear-cut wrong shape and leaves sane commands alone.
function fixupMiddleTrim(args, instruction, durationSec) {
  const corrections = [];
  if (!durationSec || !(durationSec > 0) || !Array.isArray(args)) return { args, corrections };
  const intent = parseTrimIntent(instruction);
  if (intent.kind !== 'middle') return { args, corrections };
  const N = intent.n;
  if (!(N > 0) || N >= durationSec) return { args, corrections };
  const wantSs = fmtSec((durationSec - N) / 2);
  const wantT = fmtSec(N);

  const out = [...args];
  const f = getTimeFlags(out);
  if (f.ssIdx !== -1 && f.tIdx !== -1
      && timesApprox(f.ssVal, (durationSec - N) / 2) && timesApprox(f.tVal, N)) {
    return { args: out, corrections };
  }
  setTimeFlags(out, wantSs, wantT);
  corrections.push(`"middle ${intent.raw}s" of ${fmtSec(durationSec)}s - keeping [${wantSs}s, ${fmtSec((durationSec - N) / 2 + N)}s]`);
  return { args: out, corrections };
}

// "first N seconds" needs no duration: the head cut is self-contained.
// "keep the first N" keeps [0, N] via -t N (any -ss contradicts the head);
// "remove the first N" keeps [N, end] via -ss N (any -t truncates the rest).
// A known duration only validates N against it - never blocks the rewrite.
function fixupFirstTrim(args, instruction, durationSec) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const intent = parseTrimIntent(instruction);
  if (intent.kind !== 'first-keep' && intent.kind !== 'first-remove') return { args, corrections };
  const N = intent.n;
  if (!(N > 0)) return { args, corrections };
  if (durationSec > 0 && N >= durationSec) return { args, corrections };

  const out = [...args];
  const want = fmtSec(N);
  if (intent.kind === 'first-keep') {
    let changed = false;
    if (dropTimeFlag(out, '-ss')) changed = true;
    const f = getTimeFlags(out);
    if (f.tIdx !== -1) {
      if (!timesApprox(f.tVal, N)) { out[f.tIdx + 1] = want; changed = true; }
    } else {
      insertBeforeOutput(out, '-t', want);
      changed = true;
    }
    if (changed) corrections.push(`"first ${intent.raw}s" - keeping [0, ${want}s]`);
    return { args: out, corrections };
  }
  let changed = false;
  const f = getTimeFlags(out);
  if (f.ssIdx !== -1) {
    if (!timesApprox(f.ssVal, N)) { out[f.ssIdx + 1] = want; changed = true; }
  } else {
    insertBeforeOutput(out, '-ss', want);
    changed = true;
  }
  if (getTimeFlags(out).tIdx !== -1) {
    dropTimeFlag(out, '-t');
    changed = true;
  }
  if (changed) corrections.push(`"first ${intent.raw}s" removed - keeping everything from ${want}s to the end`);
  return { args: out, corrections };
}

// "seconds A to B" needs no duration: keep [A, B] via `-ss A -t (B-A)`.
// Aggressive normalization: any recognizable range request becomes
// exactly those values.
function fixupRangeTrim(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const intent = parseTrimIntent(instruction);
  if (intent.kind !== 'range') return { args, corrections };
  const { a, b } = intent;
  if (!(a >= 0) || !(b > a)) return { args, corrections };

  const out = [...args];
  const wantSs = fmtSec(a);
  const wantT = fmtSec(b - a);
  let changed = false;
  const f = getTimeFlags(out);
  if (f.ssIdx !== -1) {
    if (!timesApprox(f.ssVal, a)) { out[f.ssIdx + 1] = wantSs; changed = true; }
  } else {
    insertBeforeOutput(out, '-ss', wantSs);
    changed = true;
  }
  const g = getTimeFlags(out);
  if (g.tIdx !== -1) {
    if (!timesApprox(g.tVal, b - a)) { out[g.tIdx + 1] = wantT; changed = true; }
  } else {
    insertBeforeOutput(out, '-t', wantT);
    changed = true;
  }
  if (changed) corrections.push(`"seconds ${intent.rawA}-${intent.rawB}" - keeping [${wantSs}s, ${fmtSec(b)}s]`);
  return { args: out, corrections };
}

// No-op seeks with no trim intent: drop `-ss 0` always; drop `-t` at the
// input duration even under a speed change (slow motion stretches the output,
// so a source-length -t would truncate it). Runs after the trims, before the
// thumbnail.
function fixupNoopSeek(args, instruction, durationSec) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const intent = parseTrimIntent(instruction);
  if (intent.kind !== 'none') return { args, corrections };
  const out = [...args];
  const f = getTimeFlags(out);
  if (f.ssIdx !== -1 && f.ssVal !== null && Math.abs(f.ssVal) < 0.005) {
    out.splice(f.ssIdx, 2);
    corrections.push('Dropped `-ss 0` (seeks nowhere)');
  }
  if (durationSec > 0) {
    const g = getTimeFlags(out);
    if (g.tIdx !== -1 && timesApprox(g.tVal, durationSec, 0.51)) {
      const val = out[g.tIdx + 1];
      out.splice(g.tIdx, 2);
      corrections.push(`Dropped "-t ${val}" (covers the whole video)`);
    }
  }
  return { args: out, corrections };
}

// Contradictions ffmpeg rejects outright (or that violate runner contracts):
// two-pass flags (single-shot runner), audio-codec flags combined with -an,
// stream-copy paired with filters or trims (filtering and accurate cuts
// require re-encoding). Bare `-c copy` is handled too, not just `-c:v copy`.
// Runs before size-limit insertions (flag/value pairs must stay adjacent).
// Returns { args, corrections } - never throws.
function fixupConflicts(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const out = [...args];
  // Drop a valued flag everywhere it appears. A flag with no consumable value
  // (end of args, or another flag follows) is dropped alone.
  const dropValued = (flag, reason) => {
    let idx = out.findIndex((t) => t === flag);
    while (idx !== -1) {
      const nx = out[idx + 1];
      if (nx === undefined || String(nx).startsWith('-')) {
        out.splice(idx, 1);
        corrections.push(`Removed dangling "${flag}" (${reason})`);
      } else {
        out.splice(idx, 2);
        corrections.push(`Removed "${flag} ${nx}" (${reason})`);
      }
      idx = out.findIndex((t) => t === flag);
    }
  };
  // Two-pass needs two runner invocations - we only ever run one command.
  const twoPass = 'two-pass is unsupported, the runner executes a single command';
  dropValued('-pass', twoPass);
  dropValued('-passlogfile', twoPass);
  // Mute contradicts any audio encoding setting.
  if (out.includes('-an')) {
    const muted = 'contradicts -an (muted output has no audio stream)';
    for (const f of ['-c:a', '-b:a', '-ac', '-ar', '-af', '-filter:a']) dropValued(f, muted);
  }
  const text = String(instruction || '').toLowerCase();
  const remux = /\bremux\b|without\s+re[\s-]?encod|no\s+re[\s-]?encod|\bstream\s*copy\b|just\s+(change|convert)\s+the\s+container|keep\s+the\s+(video\s+)?codecs?\b/i.test(text);
  const trimKind = parseTrimIntent(instruction).kind;
  const hasVideoFilter = out.includes('-vf') || out.includes('-filter:v') || out.includes('-filter_complex');
  const hasAudioFilter = out.includes('-af') || out.includes('-filter:a');
  const targetExt = inferOutputExt(out, instruction);
  const videoCodec = targetExt === '.webm' ? 'libvpx-vp9' : targetExt === '.gif' ? null : 'libx264';
  const audioCodec = audioCodecForExt(targetExt);

  // Bare -c copy covers both streams: any filter or accurate trim makes the
  // single command need real encoders. Explicit remux still wins and drops
  // the filters, exactly like the -c:v copy path below.
  const cIdx = out.findIndex((t) => t === '-c');
  if (cIdx !== -1 && String(out[cIdx + 1]).toLowerCase() === 'copy') {
    if (remux) {
      if (hasVideoFilter || hasAudioFilter) {
        const dropped = dropValuedFlags(out, ['-vf', '-filter:v', '-filter_complex', '-af', '-filter:a']);
        corrections.push(`Removed ${dropped.join(', ')} (remux requested: stream copy cannot filter)`);
      }
    } else if (hasVideoFilter || hasAudioFilter || trimKind !== 'none') {
      if (!videoCodec) {
        out.splice(cIdx, 2);
        corrections.push('Removed `-c copy` (gif output uses its default encoder)');
      } else {
        const codecs = ['-c:v', videoCodec];
        if (!out.includes('-an') && !out.some((t) => t === '-c:a')) codecs.push('-c:a', audioCodec);
        out.splice(cIdx, 2, ...codecs);
        corrections.push(`Replaced \`-c copy\` with \`${codecs.join(' ')}\` (filtering/trimming cannot stream-copy)`);
      }
    }
  }

  // Stream-copy video cannot filter. Explicit remux intent wins over the
  // filters - they are dropped. Otherwise the copy is replaced.
  let cvIdx = out.findIndex((t) => t === '-c:v');
  if (hasVideoFilter && cvIdx !== -1 && String(out[cvIdx + 1]).toLowerCase() === 'copy') {
    if (remux) {
      const dropped = dropValuedFlags(out, ['-vf', '-filter:v', '-filter_complex']);
      corrections.push(`Removed ${dropped.join(', ')} (remux requested: stream copy cannot filter)`);
    } else if (!videoCodec) {
      out.splice(cvIdx, 2);
      corrections.push('Removed `-c:v copy` (gif output uses its default encoder with filters)');
    } else {
      out[cvIdx + 1] = videoCodec;
      corrections.push(`Replaced \`-c:v copy\` with \`-c:v ${videoCodec}\` (filters cannot stream-copy)`);
    }
  }
  // Accurate cuts cannot stream-copy: a trim between keyframes corrupts the
  // cut, so a trim intent re-encodes. Explicit remux keeps copy as asked.
  cvIdx = out.findIndex((t) => t === '-c:v');
  if (trimKind !== 'none' && cvIdx !== -1 && String(out[cvIdx + 1]).toLowerCase() === 'copy' && !remux) {
    if (!videoCodec) {
      out.splice(cvIdx, 2);
      corrections.push('Removed `-c:v copy` (gif output uses its default encoder with a trim)');
    } else {
      out[cvIdx + 1] = videoCodec;
      corrections.push(`Replaced \`-c:v copy\` with \`-c:v ${videoCodec}\` (trimming cannot stream-copy accurately)`);
    }
  }
  // Audio filters require audio re-encoding; copied audio cannot be filtered.
  const caIdx = out.findIndex((t) => t === '-c:a');
  if (hasAudioFilter && caIdx !== -1 && String(out[caIdx + 1]).toLowerCase() === 'copy') {
    out[caIdx + 1] = audioCodec;
    corrections.push(`Replaced \`-c:a copy\` with \`-c:a ${audioCodec}\` (audio filters require re-encoding)`);
  }
  return { args: out, corrections };
}

// Playback speed factor from the instruction. "2x slower" and "slow motion
// 2x" mean half speed; "slow down to 0.25x" is a direct playback factor;
// "slow down by 2x" is half speed. Percent forms name direction ("50%
// faster" = 1.5x, "50% speed" = 0.5x). Bare "speed up" defaults to 2x and
// bare "slow down" to 0.5x. Returns null when no speed intent is recognizable.
function parseSpeedFactor(instruction) {
  const instr = String(instruction || '');
  const bounded = (x) => (Number.isFinite(x) && x > 0 && x <= 16 ? x : null);
  // A playback factor below 1 is already slow; a "slower" factor above 1
  // is a reduction (2x slower = 0.5x playback).
  const slow = (n) => bounded(n >= 1 ? 1 / n : n);
  // Percent forms name their direction: "50% faster" is 1.5x, while
  // "50% speed" is 0.5x. Parse these before the generic word/number forms.
  let m = /(\d+(?:\.\d+)?)\s*%\s*(faster|slower|quicker|slow(?:er)?)/i.exec(instr);
  if (m) {
    const p = parseFloat(m[1]) / 100;
    return bounded(/slow/i.test(m[2]) ? 1 - p : 1 + p);
  }
  m = /(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:the\s+)?(?:original\s+|normal\s+)?(?:speed|playback)/i.exec(instr);
  if (m) return bounded(parseFloat(m[1]) / 100);
  m = /\b(?:to|at)\s+(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:the\s+)?(?:original\s+|normal\s+)?(?:speed|playback)?/i.exec(instr);
  if (m && /\b(?:speed|slow|fast|play|motion)\b/i.test(instr)) return bounded(parseFloat(m[1]) / 100);
  m = /\b(?:speed|playback)\b\s*(?:at|to|of)\s*(\d+(?:\.\d+)?)\s*%/i.exec(instr);
  if (m) return bounded(parseFloat(m[1]) / 100);
  m = /\b(?:speed(?:ing)?\s+(?:it\s+)?up|speed\s+up|faster|quicker|increase\s+(?:the\s+)?speed)\b[^.\d]{0,20}(\d+(?:\.\d+)?)\s*%/i.exec(instr);
  if (m) return bounded(1 + parseFloat(m[1]) / 100);
  m = /\b(?:slow(?:ing)?\s+(?:it\s+)?down|slow\s+down|slower|(?:reduce|decrease)\s+(?:the\s+)?speed)\b[^.\d]{0,20}(\d+(?:\.\d+)?)\s*%/i.exec(instr);
  if (m) return bounded(1 - parseFloat(m[1]) / 100);
  m = /(\d+(?:\.\d+)?)\s*(?:x|×|times?)\s*(?:slower|slow(?:er)?|slow[\s-]*motion|motion)/i.exec(instr);
  if (m) return slow(parseFloat(m[1]));
  m = /(\d+(?:\.\d+)?)\s*(?:x|×|times?)\s*(?:faster|speed|quicker)/i.exec(instr);
  if (m) return bounded(parseFloat(m[1]));
  m = /\bto\s+(\d+(?:\.\d+)?)\s*(?:x|×|times?)\b/i.exec(instr);
  if (m && /\b(?:speed|slow|fast|play|motion)\b/i.test(instr)) return bounded(parseFloat(m[1]));
  m = /\b(?:slow(?:ing)?\s+(?:it\s+)?down|slow\s+down|slower)\b[^.\d]{0,20}(\d+(?:\.\d+)?)\s*(?:x|×|times?)?/i.exec(instr);
  if (m) {
    const between = instr.slice(m.index, m.index + m[0].length);
    const x = parseFloat(m[1]);
    return bounded(/\b(?:to|at)\b/i.test(between) ? x : slow(x));
  }
  m = /\b(?:speed(?:ing)?\s+(?:it\s+)?up|speed\s+up|faster|fast[\s-]*forward)\b[^.\d]{0,20}(\d+(?:\.\d+)?)\s*(?:x|×|times?)?/i.exec(instr);
  if (m) return bounded(parseFloat(m[1]));
  m = /\bslow[\s-]*(?:motion|mo)\b[^.\d]{0,20}(\d+(?:\.\d+)?)\s*(?:x|×|times?)/i.exec(instr);
  if (m) return slow(parseFloat(m[1]));
  m = /(\d+(?:\.\d+)?)\s*(?:x|×|times?)\b/i.exec(instr);
  if (m) return bounded(parseFloat(m[1]));
  if (/\bhalf\s+(?:the\s+)?speed\b|\bhalf\s+as\s+fast\b|\bslow\s+motion\b|\bslow[\s-]*mo\b/i.test(instr)) return 0.5;
  if (/\bquarter\s+(?:the\s+)?speed\b/i.test(instr)) return 0.25;
  if (/\bdouble\s+(?:the\s+)?speed\b|\btwice\s+as\s+fast\b|\btime[\s-]*lapse\b/i.test(instr)) return 2;
  if (/\bspeed\b[\w\s]{0,12}\bup\b|\bfaster\b/i.test(instr)) return 2;
  if (/\bslow\b[\w\s]{0,12}\bdown\b|\bslower\b/i.test(instr)) return 0.5;
  return null;
}

function fmtTempo(v) {
  return String(Math.round(v * 10000) / 10000);
}

// setpts exact expression: integral inverse stays "N*PTS", integral playback
// factor stays "PTS/N"; other factors keep enough decimals for A/V sync.
function setptsExpr(x) {
  if (Math.abs(x - 2) < 1e-9) return 'setpts=0.5*PTS';
  const inv = 1 / x;
  if (Math.abs(inv - Math.round(inv)) < 1e-9) return `setpts=${Math.round(inv)}*PTS`;
  if (Math.abs(x - Math.round(x)) < 1e-9) return `setpts=PTS/${Math.round(x)}`;
  return `setpts=PTS/${fmtTempo(x)}`;
}

// atempo accepts 0.5-2.0 per instance - chain it for wider factors.
function atempoChain(x) {
  const parts = [];
  let v = x;
  let guard = 0;
  while (v > 2 && guard++ < 8) { parts.push('2'); v /= 2; }
  while (v < 0.5 && guard++ < 16) { parts.push('0.5'); v *= 2; }
  parts.push(fmtTempo(v));
  return parts.map((p) => `atempo=${p}`).join(',');
}

// Speed change: video via setpts, audio matched via atempo (a lone setpts
// desyncs). Factor from the instruction when explicit, else the model's own
// setpts. Muted output needs no audio side.
function fixupSpeed(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const explicit = parseSpeedFactor(instruction);
  let videoX = null;
  const joined = args.join(' ');
  let m = /setpts=([\d.]+)\*PTS/.exec(joined);
  if (m && parseFloat(m[1]) > 0) videoX = 1 / parseFloat(m[1]);
  else {
    m = /setpts=PTS\/([\d.]+)/.exec(joined);
    if (m && parseFloat(m[1]) > 0) videoX = parseFloat(m[1]);
  }
  const x = explicit !== null ? explicit : videoX;
  if (x === null || !(x > 0) || x > 16 || x === 1) return { args, corrections };

  const out = [...args];
  const wantVf = setptsExpr(x);
  const vfIdx = out.findIndex((t) => t === '-vf' || t === '-filter:v');
  if (vfIdx !== -1 && typeof out[vfIdx + 1] === 'string' && /setpts=/.test(out[vfIdx + 1])) {
    const nv = out[vfIdx + 1].replace(/setpts=[^,]*/g, wantVf);
    if (nv !== out[vfIdx + 1]) {
      out[vfIdx + 1] = nv;
      corrections.push(`Speed ${fmtTempo(x)}x: normalized video to ${wantVf}`);
    }
  } else {
    appendVideoFilter(out, wantVf);
    corrections.push(`Speed ${fmtTempo(x)}x: video runs at ${wantVf}`);
  }
  if (!out.includes('-an')) {
    const wantAf = atempoChain(x);
    const afIdx = out.findIndex((t) => t === '-af' || t === '-filter:a');
    if (afIdx !== -1 && typeof out[afIdx + 1] === 'string' && /atempo=/.test(out[afIdx + 1])) {
      // Rebuild the chain around the wanted atempo: replacing textually
      // would duplicate it when other filters sit between atempo parts.
      const kept = out[afIdx + 1].split(',').filter((p) => !/^atempo=/.test(p.trim()));
      kept.push(wantAf);
      const nv = kept.join(',');
      if (nv !== out[afIdx + 1]) {
        out[afIdx + 1] = nv;
        corrections.push(`Speed ${fmtTempo(x)}x: matched audio with ${wantAf} (keeps A/V in sync)`);
      }
    } else {
      appendAudioFilter(out, wantAf);
      corrections.push(`Speed ${fmtTempo(x)}x: matched audio with ${wantAf} (keeps A/V in sync)`);
    }
  }
  return { args: out, corrections };
}

// Frame-rate cap from the instruction ("30fps", "cap at 24 fps").
function parseFps(instruction) {
  const m = /(\d+(?:\.\d+)?)\s*fps/i.exec(String(instruction || ''));
  if (!m) return null;
  const n = Math.round(parseFloat(m[1]));
  return n >= 1 && n <= 120 ? n : null;
}

function fixupFps(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const n = parseFps(instruction);
  if (n === null) return { args, corrections };
  const out = [...args];
  // An explicit -r overrides the fps filter; the instruction names the cap.
  const droppedRates = dropValuedFlags(out, ['-r']);
  if (droppedRates.length > 0) {
    corrections.push(`Frame rate: dropped ${droppedRates.join(', ')} (it would override fps=${n})`);
  }
  const vfIdx = out.findIndex((t) => t === '-vf' || t === '-filter:v');
  if (vfIdx !== -1 && typeof out[vfIdx + 1] === 'string' && /fps=/.test(out[vfIdx + 1])) {
    const nv = out[vfIdx + 1].replace(/fps=[\d.]*/g, `fps=${n}`);
    if (nv !== out[vfIdx + 1]) {
      out[vfIdx + 1] = nv;
      corrections.push(`Frame rate: normalized -vf to fps=${n}`);
    }
  } else {
    appendVideoFilter(out, `fps=${n}`);
    corrections.push(`Frame rate: capped at fps=${n}`);
  }
  return { args: out, corrections };
}

// Target width from the instruction ("640 wide"): scale=W:-2, W evened down.
// A width intent replaces any other scale= filter (it names the geometry).
function parseWidth(instruction) {
  const m = /(\d{3,5})\s*(?:px|pixels?)?\s*wide/i.exec(String(instruction || ''));
  if (!m) return null;
  let w = parseInt(m[1], 10);
  if (w < 16 || w > 7680) return null;
  if (w % 2 === 1) w -= 1;
  return w;
}

function fixupWidthScale(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const w = parseWidth(instruction);
  if (w === null) return { args, corrections };
  const out = [...args];
  // -s/-video_size overrides the scale filter; the instruction owns geometry.
  const droppedSizes = dropValuedFlags(out, ['-s', '-video_size']);
  if (droppedSizes.length > 0) {
    corrections.push(`Width ${w}px: dropped ${droppedSizes.join(', ')} (it would override scale=${w}:-2)`);
  }
  const vfIdx = out.findIndex((t) => t === '-vf' || t === '-filter:v');
  if (vfIdx !== -1 && typeof out[vfIdx + 1] === 'string' && /scale=/.test(out[vfIdx + 1])) {
    const nv = out[vfIdx + 1].replace(/scale=[^,]*/g, `scale=${w}:-2`);
    if (nv !== out[vfIdx + 1]) {
      out[vfIdx + 1] = nv;
      corrections.push(`Width ${w}px: replaced scale filter with scale=${w}:-2`);
    }
  } else {
    appendVideoFilter(out, `scale=${w}:-2`);
    corrections.push(`Width ${w}px: scaling with scale=${w}:-2 (aspect kept)`);
  }
  return { args: out, corrections };
}

// Rotation / flip from the instruction: 90 CW → transpose=1, 270 (or 90
// CCW) → transpose=2, 180 → transpose=2,transpose=2, flips → hflip/vflip.
function parseRotate(instruction) {
  const instr = String(instruction || '');
  const m = /rotat(?:e|ed|ing|ion)?(?:\s+(?:it|video|the\s+video|this(?:\s+(?:video|clip))?|(?:the\s+)?clip))?(?:\s+(?:counter[\s-]?clockwise|anti[\s-]?clockwise|ccw|clockwise|cw))?\s*(?:by|to)?\s*(90|180|270)(?!\d|\.\d)(?:\s*(?:degrees?|°))?/i.exec(instr);
  const ccw = /counter|ccw|anti[\s-]?clockwise/i.test(instr);
  if (m) {
    const d = parseInt(m[1], 10);
    if (d === 180) return 'transpose=2,transpose=2';
    if (d === 90) return ccw ? 'transpose=2' : 'transpose=1';
    return ccw ? 'transpose=1' : 'transpose=2';
  }
  // An explicit non-right angle (45, 90.5, 360) is not a transpose edit.
  // Refuse to turn it into the nearest right angle.
  if (/rotat\w*[^.\d]{0,30}\d/i.test(instr)) return null;
  if (/\brotat/i.test(instr)) return ccw ? 'transpose=2' : 'transpose=1';
  if (/\bflip\s+horiz/i.test(instr)) return 'hflip';
  if (/\bflip\s+vert/i.test(instr)) return 'vflip';
  return null;
}

function fixupRotate(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const filter = parseRotate(instruction);
  if (!filter) return { args, corrections };
  const out = [...args];
  const vfIdx = out.findIndex((t) => t === '-vf' || t === '-filter:v');
  const chain = vfIdx !== -1 && typeof out[vfIdx + 1] === 'string' ? out[vfIdx + 1] : '';
  const isPair = filter === 'transpose=2,transpose=2';
  const present = isPair ? /transpose=2.*transpose=2/.test(chain) : chain.includes(filter);
  if (vfIdx !== -1 && typeof out[vfIdx + 1] === 'string' && present) {
    return { args: out, corrections };
  }
  if (/transpose=/.test(filter) && /transpose=/.test(chain)) {
    // Rotation owns the transpose chain: replace, never stack (a stacked
    // transpose=2,transpose=1 cancels out to no rotation at all).
    const nv = chain.replace(/transpose=[12](,transpose=[12])*/g, filter);
    if (nv !== chain) {
      out[vfIdx + 1] = nv;
      corrections.push(`Rotation: normalized to ${filter} (stacked transposes would overshoot)`);
      return { args: out, corrections };
    }
  }
  appendVideoFilter(out, filter);
  corrections.push(`Rotation: applied ${filter}`);
  return { args: out, corrections };
}

// Volume factor from the instruction ("boost volume by 50%" = 1.5,
// "volume at 50%" = 0.5, "half volume" = 0.5). Mute stays on the -an path.
// Percentages only count when the surrounding words are about audio - a file
// size like "make it 50% smaller" must never become a volume change.
function parseVolume(instruction) {
  const instr = String(instruction || '');
  const pctRe = /(\d+(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = pctRe.exec(instr)) !== null) {
    const context = instr.slice(Math.max(0, m.index - 36), m.index + m[0].length + 24);
    if (!/\b(volume|audio|sound|louder|quieter|loud|boost|reduce|increase|lower|raise)\b/i.test(context)) continue;
    const p = parseFloat(m[1]);
    if (!(p > 0)) continue;
    if (/\b(?:reduce|lower|decrease|quieter|turn\s+(?:it\s+)?down)\b/i.test(context)) {
      const v = Math.round((p / 100) * 100) / 100;
      if (v > 0 && v <= 4) return v;
    }
    if (/\bby\b/i.test(context) || /\b(?:boost|increase|raise|louder|turn\s+(?:it\s+)?up)\b/i.test(context)) {
      const v = Math.round((1 + p / 100) * 100) / 100;
      if (v > 0 && v <= 4) return v;
    }
    const v = Math.round((p / 100) * 100) / 100;
    if (v > 0 && v <= 4) return v;
  }
  if (/\blouder\b/i.test(instr)) return 1.5;
  if (/\bquieter\b|\bhalf\s+volume\b/i.test(instr)) return 0.5;
  const VOL = '(volume|audio|sound)';
  const up = new RegExp(`\\bboost\\b[\\w\\s]{0,12}${VOL}|${VOL}[\\w\\s]{0,12}\\bup\\b|\\bturn\\s+up\\b[\\w\\s]{0,12}${VOL}|\\bincrease\\b[\\w\\s]{0,12}${VOL}`, 'i');
  if (up.test(instr)) return 1.5;
  const down = new RegExp(`${VOL}[\\w\\s]{0,12}\\bdown\\b|\\bturn\\s+down\\b[\\w\\s]{0,12}${VOL}|\\blower\\b[\\w\\s]{0,12}${VOL}`, 'i');
  if (down.test(instr)) return 0.5;
  return null;
}

function fixupVolume(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const v = parseVolume(instruction);
  if (v === null) return { args, corrections };
  const out = [...args];
  if (out.includes('-an')) return { args: out, corrections };
  // Copied audio cannot pass through the volume filter.
  const caIdx = out.findIndex((t) => t === '-c:a');
  if (caIdx !== -1 && String(out[caIdx + 1]).toLowerCase() === 'copy') {
    const codec = audioCodecForExt(inferOutputExt(out, instruction));
    out[caIdx + 1] = codec;
    corrections.push(`Volume: replaced \`-c:a copy\` with \`-c:a ${codec}\` (audio filters require re-encoding)`);
  }
  const want = `volume=${v}`;
  const afIdx = out.findIndex((t) => t === '-af' || t === '-filter:a');
  if (afIdx !== -1 && typeof out[afIdx + 1] === 'string' && /volume=/.test(out[afIdx + 1])) {
    const nv = out[afIdx + 1].replace(/volume=[\d.]*/g, want);
    if (nv !== out[afIdx + 1]) {
      out[afIdx + 1] = nv;
      corrections.push(`Volume: normalized audio to ${want}`);
    }
  } else {
    appendAudioFilter(out, want);
    corrections.push(`Volume: adjusted audio with ${want}`);
  }
  return { args: out, corrections };
}

// GIF output: small looping-friendly defaults (explicit fps wins), and no
// audio stream ever - gif has none, so audio flags become -an.
function fixupGif(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  // "gif to mp4" mentions gif but targets mp4 - only a gif container gets
  // GIF defaults.
  if (inferOutputExt(args, instruction) !== '.gif') return { args, corrections };
  const out = [...args];
  const vfIdx = out.findIndex((t) => t === '-vf' || t === '-filter:v');
  const chain = vfIdx !== -1 && typeof out[vfIdx + 1] === 'string' ? out[vfIdx + 1] : '';
  if (!/fps=/.test(chain)) {
    appendVideoFilter(out, 'fps=10');
    corrections.push('GIF: capped at fps=10 (small files, wide support)');
  }
  const chainAfter = (() => {
    const i = out.findIndex((t) => t === '-vf' || t === '-filter:v');
    return i !== -1 && typeof out[i + 1] === 'string' ? out[i + 1] : '';
  })();
  if (!/scale=/.test(chainAfter)) {
    appendVideoFilter(out, 'scale=480:-1:flags=lanczos');
    corrections.push('GIF: scaled with scale=480:-1:flags=lanczos');
  }
  // The gif container takes only its default encoder - an explicit -c:v (or
  // tuning for it) fails the run, so it goes.
  const droppedCodecs = dropValuedFlags(out, ['-c', '-c:v', '-preset', '-tune', '-crf', '-pix_fmt']);
  if (droppedCodecs.length > 0) {
    corrections.push(`GIF: dropped encoder settings (${droppedCodecs.join(', ')}) - gif uses its default encoder`);
  }
  if (!out.includes('-an')) {
    const dropped = dropValuedFlags(out, ['-c:a', '-b:a', '-ac', '-ar', '-af', '-filter:a']);
    insertBeforeOutput(out, '-an');
    corrections.push(`GIF: ${dropped.length > 0 ? `dropped audio (${dropped.join(', ')}) and ` : ''}muted with -an (gif has no audio stream)`);
  }
  return { args: out, corrections };
}

// Thumbnail: one frame as a still image. Owns seeking only with no trim
// intent (a trim owns -ss/-t then); always owns frame count, container,
// and bitrate. Time defaults to the middle with a known duration, else 0.
function parseThumbTime(instruction, duration) {
  const instr = String(instruction || '');
  // Percentages need the duration: "thumbnail at 50%". Tie the number to the
  // still request so a later "50% volume" cannot become the timestamp.
  const pct = /\b(?:thumbnails?|poster|screenshots?|still|cover|frames?)\b[^.]{0,16}?(\d+(?:\.\d+)?)\s*%/i.exec(instr)
    || /\bat\s+(?:the\s+)?(\d+(?:\.\d+)?)\s*%/i.exec(instr);
  if (pct && duration > 0) {
    return fmtSec(duration * (parseFloat(pct[1]) / 100));
  }
  const at = /\bat\s+(?:the\s+)?(\d+(?::\d+){0,2}(?:\.\d+)?)(?:\s*(?:s(?:ec(?:ond)?s?)?))?(?:\s+(?:mark|point))?/i.exec(instr);
  if (at) {
    const v = parseTimeVal(at[1]);
    if (v !== null && v >= 0) return fmtSec(v);
  }
  const inAt = /(\d+(?::\d+){0,2}(?:\.\d+)?)\s*(?:s(?:ec(?:ond)?s?)?)\s+(?:in|into)\b/i.exec(instr);
  if (inAt) {
    const v = parseTimeVal(inAt[1]);
    if (v !== null && v >= 0) return fmtSec(v);
  }
  const after = /\bafter\s+(\d+(?::\d+){0,2}(?:\.\d+)?)\s*(?:s(?:ec(?:ond)?s?)?)\b/i.exec(instr);
  if (after) {
    const v = parseTimeVal(after[1]);
    if (v !== null && v >= 0) return fmtSec(v);
  }
  const any = /(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b/i.exec(instr);
  if (any) return fmtSec(parseFloat(any[1]));
  if (duration > 0) return fmtSec(duration / 2);
  return '0';
}

function fixupThumbnail(args, instruction, duration) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const instr = String(instruction || '');
  if (!THUMBNAIL_RE.test(instr)) {
    return { args, corrections };
  }
  const out = [...args];
  // A still takes the image container's default encoder: an explicit video
  // codec (or tuning for it) either fails the run or writes a corrupt file,
  // so it goes. Bare -c copy and audio codecs go too. -pix_fmt stays - it is
  // valid for stills.
  const droppedCodecs = dropValuedFlags(out, ['-c', '-c:v', '-c:a', '-preset', '-tune', '-crf']);
  if (droppedCodecs.length > 0) {
    corrections.push(`Thumbnail: dropped encoder settings (${droppedCodecs.join(', ')}) - the image container picks its encoder`);
  }
  if (parseTrimIntent(instr).kind === 'none') {
    const thumbTime = parseThumbTime(instr, duration);
    setTimeFlags(out, thumbTime, null);
    if (dropTimeFlag(out, '-t')) corrections.push('Thumbnail: dropped -t (a still needs no duration window)');
    corrections.push(`Thumbnail: seeking to ${thumbTime}s`);
  }
  const fIdx = out.findIndex((t) => t === '-frames:v');
  if (fIdx !== -1) {
    if (String(out[fIdx + 1]) !== '1') {
      out[fIdx + 1] = '1';
      corrections.push('Thumbnail: rendering a single frame (-frames:v 1)');
    }
  } else {
    insertBeforeOutput(out, '-frames:v', '1');
    corrections.push('Thumbnail: rendering a single frame (-frames:v 1)');
  }
  // The container stays `{output}` - inferOutputExt picks .png/.jpg from
  // the instruction words after the pipeline.
  const droppedRates = dropValuedFlags(out, ['-b:v', '-maxrate', '-bufsize']);
  if (droppedRates.length > 0) {
    corrections.push(`Thumbnail: dropped bitrate flags (${droppedRates.join(', ')}) - a still has no bitrate`);
  }
  return { args: out, corrections };
}

// Prompt builders: exact numbers pre-computed deterministically so the
// model only has to apply them verbatim.
function buildSizeLine(instruction, duration) {
  const sizeBytes = parseSizeLimit(instruction);
  if (!sizeBytes || !(duration > 0)) return '';
  const speedX = parseSpeedFactor(instruction);
  const effDuration = speedX ? duration / speedX : duration;
  const audioBits = 128000;
  const vk = Math.floor(Math.max(100000, Math.floor((sizeBytes * 8 * 0.98) / effDuration - audioBits)) / 1000);
  return `Size limit: ${(sizeBytes / 1024 ** 3 >= 1
    ? `${+(sizeBytes / 1024 ** 3).toFixed(2)}GB`
    : `${+(sizeBytes / 1024 ** 2).toFixed(1)}MB`)} max for this ${effDuration}s video. ` +
    `Encode video at about ${vk}k: use exactly -b:v ${vk}k -maxrate ${vk}k -bufsize ${vk * 2}k, ` +
    `audio -c:a aac -b:a 128k, single pass only.\n`;
}

function buildMiddleLine(instruction, duration) {
  const intent = parseTrimIntent(instruction);
  if (intent.kind !== 'middle' || !(duration > 0)) return '';
  if (!(intent.n > 0) || intent.n >= duration) return '';
  return `Center cut: keep the middle ${intent.raw}s of this ${duration}s video. ` +
    `Use exactly -ss ${fmtSec((duration - intent.n) / 2)} -t ${fmtSec(intent.n)}, placed after -i.\n`;
}

function buildRangeLine(instruction) {
  const intent = parseTrimIntent(instruction);
  if (intent.kind !== 'range') return '';
  if (!(intent.a >= 0) || !(intent.b > intent.a)) return '';
  return `Range: keep seconds ${intent.rawA} to ${intent.rawB}. ` +
    `Use exactly -ss ${fmtSec(intent.a)} -t ${fmtSec(intent.b - intent.a)}, placed after -i.\n`;
}

function buildSpeedLine(instruction) {
  const x = parseSpeedFactor(instruction);
  if (x === null || !(x > 0) || x > 16 || x === 1) return '';
  return `Speed: play at ${fmtTempo(x)}x. ` +
    `Use exactly -vf ${setptsExpr(x)} -af ${atempoChain(x)}.\n`;
}

// The simple filter layers append -vf/-af. A model-supplied -filter_complex
// cannot be combined with those flags, so the pipeline refuses with an
// actionable error instead of letting ffmpeg fail later or silently ignore
// half the request. Users can still edit the command manually.
function filterGraphConflict(args, instruction) {
  if (!Array.isArray(args) || !args.includes('-filter_complex')) return null;
  const text = String(instruction || '');
  const speed = parseSpeedFactor(text);
  const wants = (speed !== null && speed !== 1)
    || parseFps(text) !== null
    || parseWidth(text) !== null
    || parseRotate(text) !== null
    || parseVolume(text) !== null
    || inferOutputExt(args, text) === '.gif'
    || /(?:^|\s)-s\s+\d{3,4}p/i.test(args.join(' '));
  if (!wants) return null;
  return 'This request needs a simple -vf/-af filter, but the model returned -filter_complex. '
    + 'Edit the command box manually or rephrase without a custom filter graph.';
}

// Container/codec agreement: mp4/mov cannot carry VP9/Opus, webm cannot carry
// H.264/AAC. Copy is left alone (an explicit remux intent owns that choice).
function fixupContainerCodecs(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const ext = inferOutputExt(args, instruction);
  const out = [...args];
  let videoFrom;
  let videoTo;
  let audioFrom;
  let audioTo;
  if (ext === '.webm') {
    videoFrom = new Set(['libx264', 'libx265', 'mpeg4', 'h264', 'h265']);
    videoTo = 'libvpx-vp9';
    audioFrom = new Set(['aac', 'libmp3lame', 'mp3']);
    audioTo = 'libopus';
  } else if (ext === '.mp3') {
    const idx = out.findIndex((t) => t === '-c:a');
    if (idx !== -1 && new Set(['aac', 'libopus', 'libvorbis', 'vorbis', 'opus']).has(String(out[idx + 1]).toLowerCase())) {
      out[idx + 1] = 'libmp3lame';
      corrections.push('Container .mp3: replaced the audio codec with libmp3lame');
    }
    return { args: out, corrections };
  } else if (ext === '.mp4' || ext === '.mov') {
    videoFrom = new Set(['libvpx-vp9', 'libvpx']);
    videoTo = 'libx264';
    audioFrom = new Set(['libopus', 'libvorbis', 'vorbis', 'opus']);
    audioTo = 'aac';
  } else {
    return { args: out, corrections };
  }
  for (const [flag, from, to] of [['-c:v', videoFrom, videoTo], ['-c:a', audioFrom, audioTo]]) {
    const idx = out.findIndex((t) => t === flag);
    if (idx === -1) continue;
    const cur = String(out[idx + 1]).toLowerCase();
    if (from.has(cur)) {
      out[idx + 1] = to;
      corrections.push(`Container ${ext}: replaced \`${flag} ${cur}\` with \`${flag} ${to}\``);
    }
  }
  return { args: out, corrections };
}

// Fixed translation order in one place: token fixes, filter construction
// (so fixupConflicts sees every filter), input/output templating,
// trims, size cap, thumbnail last. The pipeline never sees real paths:
// `-i {input}` and the trailing `{output}` are resolved to real paths by
// the runner at run time (see resolvePlaceholders).
function runTranslationPipeline(tokens, context) {
  const { instruction, duration } = context || {};
  const steps = [
    (a) => fixupArgs(a),
    (a) => fixupCodecs(a),
    (a) => fixupContainerCodecs(a, instruction),
    (a) => fixupDedupeSeek(a),
    (a) => fixupSpeed(a, instruction),
    (a) => fixupFps(a, instruction),
    (a) => fixupWidthScale(a, instruction),
    (a) => fixupRotate(a, instruction),
    (a) => fixupVolume(a, instruction),
    (a) => fixupGif(a, instruction),
    (a) => fixupInput(a),
    (a) => fixupConflicts(a, instruction),
    (a) => ensureOutputFile(a, instruction),
    (a) => fixupLastTrim(a, instruction, duration),
    (a) => fixupMiddleTrim(a, instruction, duration),
    (a) => fixupFirstTrim(a, instruction, duration),
    (a) => fixupRangeTrim(a, instruction),
    (a) => fixupNoopSeek(a, instruction, duration),
    (a) => fixupSizeLimit(a, instruction, duration),
    (a) => fixupThumbnail(a, instruction, duration),
  ];
  const corrections = [];
  let args = Array.isArray(tokens) ? [...tokens] : tokens;
  const trimIntent = parseTrimIntent(instruction);
  if (trimIntent.kind === 'middle-remove') {
    return {
      args,
      corrections,
      error: 'Removing the middle is not a single contiguous cut, so this request is unsupported. '
        + 'Ask to keep the first and last parts separately instead.',
    };
  }
  const conflict = filterGraphConflict(args, instruction);
  if (conflict) return { args, corrections, error: conflict };
  for (const step of steps) {
    const r = step(args);
    args = r.args;
    for (const c of r.corrections) corrections.push(c);
  }
  return { args, corrections };
}

module.exports = {
  sanitizeModelOutput,
  looksLikeFileToken,
  ensureOutputFile,
  inferOutputExt,
  resolvePlaceholders,
  tokenizeArgs,
  P_HEIGHTS,
  fixupArgs,
  fixupCodecs,
  fixupContainerCodecs,
  filterGraphConflict,
  quoteArgs,
  fixupInput,
  parseHMS,
  ffmpegFailureHint,
  parseTimeVal,
  fmtSec,
  insertBeforeOutput,
  timesApprox,
  getTimeFlags,
  setTimeFlags,
  dropTimeFlag,
  appendVideoFilter,
  appendAudioFilter,
  parseTrimIntent,
  trimNeedsDuration,
  parseSizeLimit,
  parseBitrateBps,
  fixupSizeLimit,
  fixupLastTrim,
  fixupMiddleTrim,
  fixupFirstTrim,
  fixupRangeTrim,
  fixupDedupeSeek,
  fixupNoopSeek,
  fixupSpeed,
  fixupFps,
  fixupWidthScale,
  fixupRotate,
  fixupVolume,
  fixupGif,
  fixupThumbnail,
  parseSpeedFactor,
  parseFps,
  parseWidth,
  parseRotate,
  parseVolume,
  parseThumbTime,
  atempoChain,
  fixupConflicts,
  buildSizeLine,
  buildMiddleLine,
  buildRangeLine,
  buildSpeedLine,
  runTranslationPipeline,
};
