/**
 * Deterministic correction layers for the translation pipeline.
 *
 * Pure functions (plus one fs existence check in fixupInput): each takes
 * parsed args and returns { args, corrections } without throwing. They turn
 * common LLM mistakes into commands ffmpeg actually accepts, and every
 * rewrite is reported so the UI can log it. Order of application lives in
 * runTranslationPipeline below and is fixed - do not reorder the steps.
 */
const fs = require('fs');

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
  // Keep content lines (flags or media paths); drop prose ("Here is…").
  const kept = lines.filter(
    (l) => /-[a-zA-Z]/.test(l) || /\.(mp4|mkv|webm|mov|avi|gif|mp3|png|jpe?g)\b/i.test(l)
  );
  const joined = (kept.length > 0 ? kept : lines).join(' ');
  // Drop a leading "ffmpeg" binary name - renderer prepends the binary path.
  const s = joined.replace(/^ffmpeg\s+/, '').trim();
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

// The model sometimes stops right before the output filename (trailing
// flags like `-movflags +faststart` and EOS). Recover deterministically:
// append `output.<ext>` with the container derived from the instruction
// (else codec hints, else .mp4). The runner swaps in the real destination
// path at run time; only the extension matters downstream.
function ensureOutputFile(args, instruction) {
  const corrections = [];
  if (!Array.isArray(args) || args.length === 0) return { args, corrections };
  const out = [...args];
  // Truncated answer ending on a valued flag (e.g. "... -movflags" with no
  // output yet): the appended filename would be swallowed as the flag's
  // value, so drop the dangling flag first. Valueless flags (-y, -an, -vn)
  // are kept - they are complete on their own.
  const valuedFlags = new Set([
    '-i', '-ss', '-t', '-s', '-video_size', '-vf', '-filter:v', '-filter:a',
    '-filter_complex', '-c', '-c:v', '-c:a', '-b:v', '-b:a', '-maxrate',
    '-bufsize', '-ac', '-ar', '-r', '-pix_fmt', '-crf', '-preset', '-tune',
    '-movflags', '-map', '-pass', '-passlogfile', '-f', '-frames:v',
  ]);
  const dropped = [];
  while (out.length > 0 && valuedFlags.has(out[out.length - 1])) {
    dropped.unshift(out.pop());
  }
  if (dropped.length > 0) {
    corrections.push(`Dropped dangling ${dropped.join(', ')} (truncated answer left a flag with no value)`);
  }
  if (looksLikeFileToken(out[out.length - 1])) return { args: out, corrections };
  const text = String(instruction || '').toLowerCase();
  const wordExt =
    /\bmkv\b/.test(text) ? '.mkv'
    : /\bwebm\b/.test(text) ? '.webm'
    : /\bgif\b/.test(text) ? '.gif'
    : /\bmp3\b|\baudio only\b|\bextract (the )?audio\b/.test(text) ? '.mp3'
    : /\bmov\b/.test(text) ? '.mov'
    : /\bavi\b/.test(text) ? '.avi'
    : /\bmp4\b/.test(text) ? '.mp4'
    : /\bpng\b/.test(text) ? '.png'
    : /\bjpe?g\b/.test(text) ? '.jpg'
    : null;
  const joined = out.join(' ').toLowerCase();
  const hintExt = wordExt
    || (joined.includes('libvpx-vp9') || joined.includes('libopus') ? '.webm' : null)
    || (joined.includes('libmp3lame') || /\s-vn(\s|$)/.test(joined + ' ') ? '.mp3' : null)
    || '.mp4';
  out.push(`output${hintExt}`);
  corrections.push(`LLM omitted the output file - appended output${hintExt}`);
  return { args: out, corrections };
}

function tokenizeArgs(argString, inputFile) {
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
  // Ensure an input is present.
  if (!tokens.includes('-i') && inputFile) return ['-y', '-i', inputFile, ...tokens];
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

function quoteArgs(args) {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

// The model sometimes echoes the prompt's placeholder (`-i input.mp4`)
// instead of the real selected file. Since the input always comes from the
// loaded video, rewrite a missing/placeholder/nonexistent -i value with it.
// Returns { args, corrections } - never throws.
function fixupInput(args, inputFile) {
  const corrections = [];
  if (!inputFile || !Array.isArray(args)) return { args, corrections };
  const out = [...args];
  const iIdx = out.findIndex((t) => t === '-i');
  if (iIdx === -1 || typeof out[iIdx + 1] !== 'string') return { args: out, corrections };
  const cur = out[iIdx + 1];
  const isPlaceholder = /^input(\.\w+)?$/i.test(cur);
  let exists = false;
  try {
    exists = fs.existsSync(cur);
  } catch { exists = false; }
  if (cur !== inputFile && (isPlaceholder || !exists)) {
    out[iIdx + 1] = inputFile;
    corrections.push(`Rewrote "-i ${cur}" as the loaded video (placeholder/missing file)`);
  }
  return { args: out, corrections };
}

function parseHMS(h, m, s) {
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
}

// Environment diagnosis for machine-level failures (correct command,
// machine cannot do the work). Returns a hint or null.
function ffmpegFailureHint(stderr) {
  const text = String(stderr || '');
  if (/cannot allocate memory|malloc.*failed|out of memory/i.test(text)) {
    return 'Likely cause: FFmpeg ran out of memory. Rendering at high resolution and frame rate (e.g. upscaling 720p to 4K at 60fps) needs a lot of RAM and Windows Sandbox has very little. ' +
      'Note: upscaling cannot add detail beyond the source - it only makes a bigger file. ' +
      'Try a smaller target like 1080p, close other apps, or run on a machine with more memory.';
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
function insertBeforeOutput(out, ...tokens) {
  const at = out.length > 0 && !String(out[out.length - 1]).startsWith('-') ? out.length - 1 : out.length;
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

// Single-pass size cap: video bitrate from (bytes*8*margin/duration - audio).
// Replaces/derives -b:v/-maxrate/-bufsize and bounds copied audio, because a
// limit is a guarantee, not a suggestion. Our runner executes ONE ffmpeg
// command, so two-pass (-pass 1/2) is never an option.
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
  const hasAN = out.includes('-an');
  let audioBits = hasAN ? 0 : 128000;
  const caIdx = out.findIndex((t) => t === '-c:a');
  if (!hasAN && caIdx !== -1 && String(out[caIdx + 1]).toLowerCase() === 'copy') {
    out[caIdx + 1] = 'aac';
    out.splice(caIdx + 2, 0, '-b:a', '128k');
    audioBits = 128000;
    corrections.push('Size limit: replaced `-c:a copy` with `-c:a aac -b:a 128k` (copied audio has no size bound)');
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

// Single source of truth for trim intent: exactly one kind per instruction,
// so trim layers are mutually exclusive structurally. Priority: middle, then
// last, then first, then range (a pathological multi-trim instruction gets
// the most specific match). Standing default preserved: bare "the last N s"
// with no verb keeps the tail. Single-N kinds return {kind, n, raw}; range
// returns {kind, a, b, rawA, rawB} (kept seconds [a, b]).
function parseTrimIntent(instruction) {
  const instr = String(instruction || '');
  const num = (re) => {
    const m = re.exec(instr);
    return m ? { n: parseFloat(m[1]), raw: m[1] } : null;
  };
  const SEC = '\\s*s(?:ec(?:ond)?s?)?';
  const mid = num(new RegExp('middle\\s+(\\d+(?:\\.\\d+)?)' + SEC, 'i'));
  if (mid && mid.n > 0) return { kind: 'middle', n: mid.n, raw: mid.raw };
  const last = num(new RegExp('last\\s+(\\d+(?:\\.\\d+)?)' + SEC, 'i'));
  if (last && last.n > 0) {
    // Explicit keep-the-tail phrasing beats everything ("keep/extract/only the last N").
    const keepTail = /\b(keep|keeping|extract|only|just)\b[\w\s]{0,12}\blast\s+\d/i.test(instr);
    // Otherwise trim/cut/remove/delete/drop = cut those seconds off.
    const removal = !keepTail
      && /(remove|removing|delete|delet|trim|trimming|cut|cutting|drop|strip|without)/i.test(instr);
    return { kind: removal ? 'last-remove' : 'last-keep', n: last.n, raw: last.raw };
  }
  const first = num(new RegExp('\\bfirst\\s+(\\d+(?:\\.\\d+)?)' + SEC, 'i'));
  if (first && first.n > 0) {
    // Mirror of the last-N verbs: "keep the first N" keeps the head [0, N],
    // "remove the first N" cuts the head off and keeps [N, end].
    const keepHead = /\b(keep|keeping|extract|only|just)\b[\w\s]{0,12}\bfirst\s+\d/i.test(instr);
    const removal = !keepHead
      && /(remove|removing|delete|delet|trim|trimming|cut|cutting|drop|strip|without)/i.test(instr);
    return { kind: removal ? 'first-remove' : 'first-keep', n: first.n, raw: first.raw };
  }
  const rangeM = /(?:\bfrom\s+|\bbetween\s+)(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:ond)?s?)?\s*)?(?:to|and|-)\s*(\d+(?:\.\d+)?)(?:\s*s(?:ec(?:ond)?s?)?)?\b/i.exec(instr)
    || /\b(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:ond)?s?)?\s*)?(?:to|-)\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b/i.exec(instr)
    || /\bseconds?\s+(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\b/i.exec(instr);
  // Keyword form ("from/between A to B") and leading-seconds form
  // ("seconds A to B") need no trailing unit; the bare form requires one
  // (so "720 to 1080" resolutions never match, and the b>a guard below
  // rejects them anyway).
  if (rangeM) {
    const a = parseFloat(rangeM[1]);
    const b = parseFloat(rangeM[2]);
    if (a >= 0 && b > a) return { kind: 'range', a, b, rawA: rangeM[1], rawB: rangeM[2] };
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
// Aggressive per the standing rule - any recognizable range request is
// normalized to exactly those values.
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

// Contradictions ffmpeg rejects outright (or that violate runner contracts):
// two-pass flags (single-shot runner), audio-codec flags combined with -an,
// and `-c:v copy` paired with video filters (filtering requires re-encoding).
// Runs BEFORE size-limit insertions so flag/value pairs are still adjacent
// (inserting between `-pass` and `1` would orphan the value). The container
// for the stream-copy fix comes from the instruction words, mirroring
// ensureOutputFile (whose .mp4 default matches the libx264 default here).
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
  // Stream-copy cannot filter: any video filter requires re-encoding.
  // Explicit remux intent ("without re-encoding") wins over the filters -
  // they are dropped. Otherwise the copy is replaced with a real encoder.
  const hasVideoFilter = out.includes('-vf') || out.includes('-filter:v') || out.includes('-filter_complex');
  const cvIdx = out.findIndex((t) => t === '-c:v');
  if (hasVideoFilter && cvIdx !== -1 && String(out[cvIdx + 1]).toLowerCase() === 'copy') {
    const text = String(instruction || '').toLowerCase();
    const remux = /\bremux\b|without\s+re[\s-]?encod|no\s+re[\s-]?encod|\bstream\s*copy\b|just\s+(change|convert)\s+the\s+container|keep\s+the\s+(video\s+)?codecs?\b/i.test(text);
    if (remux) {
      const dropped = dropValuedFlags(out, ['-vf', '-filter:v', '-filter_complex']);
      corrections.push(`Removed ${dropped.join(', ')} (remux requested: stream copy cannot filter)`);
    } else if (/\bwebm\b/.test(text)) {
      out[cvIdx + 1] = 'libvpx-vp9';
      corrections.push('Replaced `-c:v copy` with `-c:v libvpx-vp9` (filters cannot stream-copy)');
    } else if (/\bgif\b/.test(text)) {
      out.splice(cvIdx, 2);
      corrections.push('Removed `-c:v copy` (gif output uses its default encoder with filters)');
    } else {
      out[cvIdx + 1] = 'libx264';
      corrections.push('Replaced `-c:v copy` with `-c:v libx264` (filters cannot stream-copy)');
    }
  }
  return { args: out, corrections };
}

// Playback speed factor from the instruction ("2x faster", "half speed",
// "slow down"). Bare "speed up" defaults to 2x, bare "slow down" to 0.5x.
// Returns null when no speed intent is recognizable. Capped at 16x.
function parseSpeedFactor(instruction) {
  const instr = String(instruction || '');
  const m = /(\d+(?:\.\d+)?)\s*[x×]\s*(?:faster|speed|quicker|slow(?:er)?|motion)/i.exec(instr);
  if (m) {
    const x = parseFloat(m[1]);
    if (x > 0 && x <= 16) return x;
    return null;
  }
  if (/\bhalf\s+speed\b|\bslow\s+motion\b/i.test(instr)) return 0.5;
  if (/\bdouble\s+speed\b/i.test(instr)) return 2;
  if (/\bspeed\b[\w\s]{0,12}\bup\b/i.test(instr)) return 2;
  if (/\bslow\b[\w\s]{0,12}\bdown\b/i.test(instr)) return 0.5;
  return null;
}

function fmtTempo(v) {
  return String(Math.round(v * 100) / 100);
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

// Speed change: video via setpts, audio matched via atempo so A/V stay in
// sync (a lone setpts silences nothing but desyncs everything). The factor
// comes from the instruction when explicit, else from the model's own setpts
// (then only the audio side is derived). Muted output needs no audio side.
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
  const wantVf = `setpts=${fmtTempo(1 / x)}*PTS`;
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
  const m = /rotat(?:e|ing)?\s*(?:by\s*)?(90|180|270)(?:\s*(?:degrees?|°))?/i.exec(instr);
  const ccw = /counter|ccw|anti[\s-]?clockwise/i.test(instr);
  if (m) {
    const d = parseInt(m[1], 10);
    if (d === 180) return 'transpose=2,transpose=2';
    if (d === 90) return ccw ? 'transpose=2' : 'transpose=1';
    return ccw ? 'transpose=1' : 'transpose=2';
  }
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

// Volume factor from the instruction ("boost volume", "half volume",
// "150%"): bare louder/quieter need no volume word, vaguer verbs do.
// Returns null when no volume intent is recognizable. Mute stays on the
// -an path (the model emits it, conflicts enforces it).
function parseVolume(instruction) {
  const instr = String(instruction || '');
  const pct = /(?:volume\s*)?(\d+(?:\.\d+)?)\s*%/i.exec(instr);
  if (pct) {
    const v = Math.round((parseFloat(pct[1]) / 100) * 100) / 100;
    return v > 0 && v <= 4 ? v : null;
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
  if (!/\bgif\b/i.test(String(instruction || ''))) return { args, corrections };
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
  const droppedCodecs = dropValuedFlags(out, ['-c:v', '-preset', '-tune', '-crf', '-pix_fmt']);
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

// Thumbnail / poster frame: a single frame as a still image. Owns seeking
// only when no trim intent is present (a trim owns -ss/-t then); always owns
// the frame count, the image container, and the bitrate flags (a still has
// no bitrate). Time defaults to the middle with a known duration, else 0.
function parseThumbTime(instruction, duration) {
  const instr = String(instruction || '');
  const at = /at\s+(\d+(?::\d+){0,2}(?:\.\d+)?)/i.exec(instr);
  if (at) {
    const v = parseTimeVal(at[1]);
    if (v !== null && v >= 0) return fmtSec(v);
  }
  if (duration > 0) return fmtSec(duration / 2);
  const any = /(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b/i.exec(instr);
  if (any) return fmtSec(parseFloat(any[1]));
  return '0';
}

function fixupThumbnail(args, instruction, duration) {
  const corrections = [];
  if (!Array.isArray(args)) return { args, corrections };
  const instr = String(instruction || '');
  if (!/\bthumbnails?\b|\bposter\b|\bcover\s+(image|frame|art)\b|\bextract\s+(a\s+)?frames?\b/i.test(instr)) {
    return { args, corrections };
  }
  const out = [...args];
  // A still takes the image container's default encoder: an explicit video
  // codec (or tuning for it) either fails the run or writes a corrupt file,
  // so it goes. -pix_fmt stays - it is valid for stills.
  const droppedCodecs = dropValuedFlags(out, ['-c:v', '-preset', '-tune', '-crf']);
  if (droppedCodecs.length > 0) {
    corrections.push(`Thumbnail: dropped encoder settings (${droppedCodecs.join(', ')}) - the image container picks its encoder`);
  }
  if (parseTrimIntent(instr).kind === 'none') {
    setTimeFlags(out, parseThumbTime(instr, duration), null);
    if (dropTimeFlag(out, '-t')) corrections.push('Thumbnail: dropped -t (a still needs no duration window)');
    corrections.push(`Thumbnail: seeking to ${parseThumbTime(instr, duration)}s`);
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
  const last = out[out.length - 1];
  if (last && !String(last).startsWith('-')) {
    const m = /^(.*)\.(mp4|mkv|webm|mov|avi|m4v)$/i.exec(String(last));
    if (m) {
      const wantExt = /\bjpe?g\b/i.test(instr) ? '.jpg' : '.png';
      out[out.length - 1] = m[1] + wantExt;
      corrections.push(`Thumbnail: single frame uses ${wantExt} (was .${m[2].toLowerCase()})`);
    }
  }
  const droppedRates = dropValuedFlags(out, ['-b:v', '-maxrate', '-bufsize']);
  if (droppedRates.length > 0) {
    corrections.push(`Thumbnail: dropped bitrate flags (${droppedRates.join(', ')}) - a still has no bitrate`);
  }
  return { args: out, corrections };
}

// Prompt-injection builders: exact numbers pre-computed deterministically so
// the model only has to apply them verbatim (was inline in main.js).
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
    `Use exactly -vf setpts=${fmtTempo(1 / x)}*PTS -af ${atempoChain(x)}.\n`;
}

// Fixed translation order in one place (was chained by hand in main.js and
// re-implemented by the smoke-test pipe helper): token fixes, filter
// construction (so fixupConflicts below sees every filter), input,
// conflicts, output placeholder, trims, size cap, thumbnail last (it owns
// the frame count, container, and bitrate flags of a still).
function runTranslationPipeline(tokens, context) {
  const { instruction, inputFile, duration } = context || {};
  const steps = [
    (a) => fixupArgs(a),
    (a) => fixupSpeed(a, instruction),
    (a) => fixupFps(a, instruction),
    (a) => fixupWidthScale(a, instruction),
    (a) => fixupRotate(a, instruction),
    (a) => fixupVolume(a, instruction),
    (a) => fixupGif(a, instruction),
    (a) => fixupInput(a, inputFile),
    (a) => fixupConflicts(a, instruction),
    (a) => ensureOutputFile(a, instruction),
    (a) => fixupLastTrim(a, instruction, duration),
    (a) => fixupMiddleTrim(a, instruction, duration),
    (a) => fixupFirstTrim(a, instruction, duration),
    (a) => fixupRangeTrim(a, instruction),
    (a) => fixupSizeLimit(a, instruction, duration),
    (a) => fixupThumbnail(a, instruction, duration),
  ];
  const corrections = [];
  let args = Array.isArray(tokens) ? [...tokens] : tokens;
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
  tokenizeArgs,
  P_HEIGHTS,
  fixupArgs,
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
