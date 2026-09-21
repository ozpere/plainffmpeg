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
    (l) => /-[a-zA-Z]/.test(l) || /\.(mp4|mkv|webm|mov|avi|gif|mp3)\b/i.test(l)
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
    '-movflags', '-map', '-pass', '-passlogfile', '-f',
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
  const videoBps = Math.max(100000, Math.floor((bytes * 8 * 0.98) / durationSec - audioBits));
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
      `Size limit ${human} for ${fmtSec(durationSec)}s video: capped single-pass video at -b:v ${vk}k`
    );
  }
  return { args: out, corrections };
}

// Single source of truth for trim intent: exactly one kind per instruction,
// so trim layers are mutually exclusive structurally. A "middle" request wins
// over a "last" one when both appear (it runs later in the pipeline anyway).
// Standing default preserved: bare "the last N s" with no verb keeps the tail.
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
// ("keep/extract the last N s") keeps [D-N, end]. Rewrites only the
// clear-cut wrong shape and leaves sane commands alone.
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

  // Keep [D-N, end]: needs -ss D-N and no -t.
  const want = fmtSec(durationSec - N);
  const wantNum = durationSec - N;
  const f = getTimeFlags(out);
  const startsAtZero = f.ssIdx === -1 || f.ssVal === null || f.ssVal < 0.51;
  if (f.ssIdx !== -1 && timesApprox(f.ssVal, wantNum) && f.tIdx !== -1 && f.tVal !== null
      && (f.ssVal + f.tVal) < durationSec - 0.51) {
    // Right start, but -t truncates the kept tail - drop it, keep to the end.
    dropTimeFlag(out, '-t');
    corrections.push(`-t cut the kept "last ${intent.raw}s" short - keeping everything from ${want}s to the end`);
  } else if (f.ssIdx !== -1 && f.tIdx !== -1 && startsAtZero && timesApprox(f.tVal, N)) {
    out[f.ssIdx + 1] = want;
    dropTimeFlag(out, '-t');
    corrections.push(`"last ${intent.raw}s" of ${fmtSec(durationSec)}s starts at ${want}s - rewrote -ss/-t`);
  } else if (f.ssIdx === -1 && f.tIdx !== -1 && timesApprox(f.tVal, N)) {
    out[f.tIdx] = '-ss';
    out[f.tIdx + 1] = want;
    corrections.push(`"last ${intent.raw}s" of ${fmtSec(durationSec)}s starts at ${want}s - replaced -t with -ss`);
  }
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
  const hasVideoFilter = out.includes('-vf') || out.includes('-filter:v') || out.includes('-filter_complex');
  const cvIdx = out.findIndex((t) => t === '-c:v');
  if (hasVideoFilter && cvIdx !== -1 && String(out[cvIdx + 1]).toLowerCase() === 'copy') {
    const text = String(instruction || '').toLowerCase();
    if (/\bwebm\b/.test(text)) {
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

// Prompt-injection builders: exact numbers pre-computed deterministically so
// the model only has to apply them verbatim (was inline in main.js).
function buildSizeLine(instruction, duration) {
  const sizeBytes = parseSizeLimit(instruction);
  if (!sizeBytes || !(duration > 0)) return '';
  const audioBits = 128000;
  const vk = Math.floor(Math.max(100000, Math.floor((sizeBytes * 8 * 0.98) / duration - audioBits)) / 1000);
  return `Size limit: ${(sizeBytes / 1024 ** 3 >= 1
    ? `${+(sizeBytes / 1024 ** 3).toFixed(2)}GB`
    : `${+(sizeBytes / 1024 ** 2).toFixed(1)}MB`)} max for this ${duration}s video. ` +
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

// Fixed translation order in one place (was chained by hand in main.js and
// re-implemented by the smoke-test pipe helper): token fixes, input,
// conflicts, output placeholder, trims, size cap.
function runTranslationPipeline(tokens, context) {
  const { instruction, inputFile, duration } = context || {};
  const steps = [
    (a) => fixupArgs(a),
    (a) => fixupInput(a, inputFile),
    (a) => fixupConflicts(a, instruction),
    (a) => ensureOutputFile(a, instruction),
    (a) => fixupLastTrim(a, instruction, duration),
    (a) => fixupMiddleTrim(a, instruction, duration),
    (a) => fixupSizeLimit(a, instruction, duration),
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
  parseTrimIntent,
  trimNeedsDuration,
  parseSizeLimit,
  parseBitrateBps,
  fixupSizeLimit,
  fixupLastTrim,
  fixupMiddleTrim,
  fixupConflicts,
  buildSizeLine,
  buildMiddleLine,
  runTranslationPipeline,
};
