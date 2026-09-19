/* global window, document */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const dropzone = $('dropzone');
  const browseBtn = $('browseBtn');
  const dzPrompt = $('dzPrompt');
  const fileLabel = $('fileLabel');
  const preview = $('preview');
  const instruction = $('instruction');
  const outputPath = $('outputPath');
  const chooseOutputBtn = $('chooseOutputBtn');
  const translateBtn = $('translateBtn');
  const translateOnlyBtn = $('translateOnlyBtn');
  const runBtn = $('runBtn');
  const cmdOut = $('cmdOut');
  const errorBanner = $('errorBanner');
  const engineNote = $('engineNote');
  const engineBadge = $('engineBadge');
  const confirmOverlay = $('confirmOverlay');
  const confirmMsg = $('confirmMsg');
  const confirmOk = $('confirmOk');
  const confirmCancel = $('confirmCancel');
  const barTranslate = $('barTranslate');
  const translateStatus = $('translateStatus');
  const barFfmpeg = $('barFfmpeg');
  const ffmpegStatus = $('ffmpegStatus');
  const toggleLogsBtn = $('toggleLogsBtn');
  const minBtn = $('minBtn');
  const maxBtn = $('maxBtn');
  const closeBtn = $('closeBtn');
  const titlebar = $('titlebar');
  const terminal = $('terminal');

  let inputFile = null;
  let mediaDuration = null; // seconds, probed at load; resolves "last N seconds"
  let outputFile = null;   // explicit destination; null = use computed default
  let outputManual = false;
  let lastArgs = null;

  function log(line) {
    terminal.textContent += line + '\n';
    terminal.scrollTop = terminal.scrollHeight;
  }

  function showBanner(text) {
    errorBanner.textContent = text;
    errorBanner.hidden = false;
    log(text);
  }

  // Raw engine errors are jargon - translate the known ones into plain
  // language for the banner. Technical detail always stays in the logs.
  function prettyLlmError(msg) {
    const m = String(msg || 'unknown error');
    if (/NoBinaryFoundError/i.test(m)) {
      return 'Could not start the local AI engine: its native component was not found or is incompatible with this install. ' +
        'Reinstalling the app usually fixes this. Full technical details are in the logs below.';
    }
    if (/model file not found/i.test(m)) {
      return 'Model file not found. Reinstall the app or run `npm run download-model`, then try again.';
    }
    return m;
  }

  function showError(msg) {
    engineNote.textContent = 'Translation failed - nothing was executed.';
    engineNote.classList.add('error');
    showBanner('⚠ ' + prettyLlmError(msg));
    log('LLM ERROR (technical): ' + String(msg || 'unknown error'));
  }

  function clearError() {
    errorBanner.hidden = true;
    errorBanner.textContent = '';
    engineNote.classList.remove('error');
  }

  // --- path helpers (no node:path in the renderer; handle / and \) ---
  function dirname(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(0, i) : '';
  }
  function extname(p) {
    const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i) : '';
  }
  function joinDir(dir, file) {
    if (!dir) return file;
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir + (dir.endsWith('/') || dir.endsWith('\\') ? '' : sep) + file;
  }

  // Default output: same directory as the input, named `output.<ext>`.
  // <ext> comes from the translated command; until translated it is
  // literally `output.ext` - we never guess a container upfront.
  function defaultOutput() {
    if (!inputFile) return '';
    let ext = '.ext';
    if (lastArgs && lastArgs.length > 0) {
      const last = String(lastArgs[lastArgs.length - 1]);
      // Only a translated *output* determines the container - the input
      // path itself (or a flag) means "not translated yet" → output.ext.
      if (!last.startsWith('-') && last !== inputFile) {
        const e = extname(last);
        if (e) ext = e;
      }
    }
    return joinDir(dirname(inputFile), 'output' + ext);
  }

  function refreshOutputDisplay() {
    let shown = outputManual && outputFile ? outputFile : defaultOutput();
    // The translated command dictates the container extension - a manual
    // `output.mp4` for an mkv command is coerced to .mkv.
    const coerced = coerceExt(shown);
    if (coerced !== shown) {
      shown = coerced;
      if (outputManual) {
        outputFile = coerced;
        log(`output extension follows the command → ${shown}`);
      }
    }
    outputPath.value = shown;
    outputPath.placeholder = inputFile
      ? 'Defaults to output.ext next to the input'
      : 'Defaults to output.ext next to the input after translating';
  }

  // Extension the translated command produces ('' if unknown yet).
  function translatedExt() {
    if (lastArgs && lastArgs.length > 0) {
      const last = String(lastArgs[lastArgs.length - 1]);
      if (!last.startsWith('-')) return extname(last).toLowerCase();
    }
    return '';
  }

  function coerceExt(p) {
    const want = translatedExt();
    if (!p || !want) return p;
    const cur = extname(p).toLowerCase();
    if (cur === want || !cur) return cur ? p : p + want;
    return p.slice(0, p.length - cur.length) + want;
  }

  function effectiveOutput() {
    const v = (outputPath.value || '').trim();
    return v || null;
  }

  function setBadge(state, text) {
    engineBadge.textContent = text;
    engineBadge.classList.toggle('ready', state === 'ready');
    engineBadge.classList.toggle('loading', state === 'loading');
    engineBadge.classList.toggle('warn', state === 'warn');
  }

  // In-app overwrite confirm (themed modal, not a native popup).
  // Resolves true on Overwrite, false on Cancel / Esc / backdrop click.
  function confirmOverwriteUI(outputPath) {
    return new Promise((resolve) => {
      const dir = dirname(String(outputPath));
      confirmMsg.textContent = `File "${basename(outputPath)}" already exists in that directory:\n${dir}\n\nOverwrite it?`;
      confirmOverlay.hidden = false;
      const done = (v) => {
        confirmOverlay.hidden = true;
        confirmOk.removeEventListener('click', onOk);
        confirmCancel.removeEventListener('click', onCancel);
        window.removeEventListener('keydown', onKey);
        confirmOverlay.removeEventListener('click', onBackdrop);
        resolve(v);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      const onBackdrop = (e) => { if (e.target === confirmOverlay) done(false); };
      confirmOk.addEventListener('click', onOk);
      confirmCancel.addEventListener('click', onCancel);
      window.addEventListener('keydown', onKey);
      confirmOverlay.addEventListener('click', onBackdrop);
      try { confirmCancel.focus(); } catch { /* ignore */ }
    });
  }

  function basename(p) {
    return String(p).slice(Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\')) + 1);
  }

  // file:// URL that survives spaces, unicode, and Windows backslashes.
  function toFileUrl(p) {
    const parts = String(p).replace(/\\/g, '/').split('/');
    const encoded = parts
      .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
      .join('/');
    return 'file://' + (encoded.startsWith('/') ? '' : '/') + encoded;
  }

  function setFile(p) {
    inputFile = p;
    mediaDuration = null;
    outputManual = false;
    if (!p) {
      fileLabel.textContent = 'No file selected';
      fileLabel.classList.remove('loaded');
      browseBtn.textContent = 'Browse…';
      dzPrompt.innerHTML = '<strong>Drag &amp; drop a video here</strong> or';
      preview.hidden = true;
      preview.removeAttribute('src');
      refreshOutputDisplay();
      return;
    }
    fileLabel.textContent = '✓ Loaded: ' + p;
    fileLabel.classList.add('loaded');
    browseBtn.textContent = 'Load a different video';
    dzPrompt.innerHTML = '<strong>Video loaded.</strong> Drop another file to replace it, or';
    try {
      preview.src = toFileUrl(p);
      preview.hidden = false;
    } catch { /* ignore preview errors */ }
    log(`input: ${p}`);
    refreshOutputDisplay();
    // Probe duration/resolution in the background: shown in the label and
    // used to resolve "last N seconds" at translate time.
    window.api.probeMedia(p).then(
      (meta) => {
        if (inputFile !== p || !meta) return;
        mediaDuration = meta.duration;
        const bits = [];
        if (meta.duration) bits.push(meta.duration.toFixed(1) + 's');
        if (meta.width && meta.height) bits.push(meta.width + '×' + meta.height);
        if (bits.length > 0) fileLabel.textContent = `✓ Loaded: ${p} (${bits.join(' · ')})`;
        log(`probed: ${bits.join(' · ') || 'no metadata'}`);
      },
      (err) => log('probe failed: ' + (err && err.message ? err.message : err))
    );
  }

  // Polls until the background LLM load finishes: the badge goes
  // unavailable → loading (red) → ready (green) without blocking the UI.
  async function refreshStatus() {
    let repollMs = 0;
    try {
      const s = await window.api.modelStatus();
      if (s.ready) {
        setBadge('ready', `Engine: ${s.engine} · ${(s.size / 1e6).toFixed(1)} MB`);
        if (engineNote.textContent.startsWith('Last LLM load failed')) {
          engineNote.textContent = '';
          engineNote.classList.remove('error');
        }
      } else if (s.exists && s.loading) {
        setBadge('loading', 'Loading LLM engine locally…');
        repollMs = 2000;
      } else if (s.exists) {
        setBadge('warn', 'LLM not loaded yet - it loads on first translation');
        // Surface the last load failure (if any) instead of badge-shrugging.
        if (s.loadError) {
          engineNote.textContent = `Last LLM load failed - will retry on first translation. ${prettyLlmError(s.loadError)}`;
          engineNote.classList.add('error');
        }
        repollMs = 3000;
      } else {
        setBadge('warn', 'Engine: LLM unavailable - run `npm run download-model`');
        repollMs = 10000;
      }
    } catch (e) {
      setBadge('warn', 'Engine: unknown');
      repollMs = 5000;
    }
    if (repollMs > 0) setTimeout(refreshStatus, repollMs);
  }

  async function translate() {
    const text = instruction.value.trim();
    if (!inputFile) {
      showBanner('Load a video first - drag & drop a file onto the card or press Browse.');
      return null;
    }
    if (!text) {
      log('Type an instruction first, e.g. "Convert to mkv, trim the last 5 seconds, make it 360p".');
      return null;
    }
    clearError();
    translateBtn.disabled = true;
    barTranslate.classList.add('indeterminate');
    barTranslate.style.width = '100%';
    translateStatus.textContent = 'Translating…';
    log(`translating: "${text}" …`);
    try {
      const res = await window.api.translatePrompt({ instruction: text, inputFile, duration: mediaDuration });
      if (!res || res.ok === false) {
        // LLM failure: never execute anything.
        lastArgs = null;
        runBtn.disabled = true;
        cmdOut.textContent = '-';
        barTranslate.classList.remove('indeterminate');
        barTranslate.style.width = '0%';
        translateStatus.textContent = 'Failed';
        showError((res && res.error) || 'unknown error');
        return null;
      }
      lastArgs = res.args;
      cmdOut.textContent = 'ffmpeg ' + res.argsString;
      if (res.corrections && res.corrections.length > 0) {
        for (const c of res.corrections) log('auto-corrected: ' + c);
        engineNote.textContent =
          `${res.corrections.length} auto-correction(s) applied - see log.`;
      } else {
        engineNote.textContent = '';
      }
      log(`translated [${res.engine}]: ffmpeg ${res.argsString}`);
      refreshOutputDisplay();
      log(`output → ${effectiveOutput() || '(none yet - select an input video)'}`);
      barTranslate.classList.remove('indeterminate');
      barTranslate.style.width = '100%';
      translateStatus.textContent = 'Done';
      runBtn.disabled = !lastArgs;
      return res;
    } catch (e) {
      lastArgs = null;
      runBtn.disabled = true;
      barTranslate.classList.remove('indeterminate');
      barTranslate.style.width = '0%';
      translateStatus.textContent = 'Failed';
      showError((e && e.message ? e.message : e) || 'unknown error');
      return null;
    } finally {
      translateBtn.disabled = false;
    }
  }

  async function run() {
    if (!lastArgs) {
      log('Nothing to run - translate first.');
      return;
    }
    if (!inputFile) {
      log('Select an input video first.');
      return;
    }
    const out = effectiveOutput();
    if (!out) {
      log('No output destination - this should not happen.');
      return;
    }
    // Ask (in-app modal) before overwriting an existing file.
    try {
      if (await window.api.outputExists(out)) {
        log(`output already exists: ${out}`);
        const go = await confirmOverwriteUI(out);
        if (!go) {
          ffmpegStatus.textContent = 'Cancelled';
          log('run cancelled - existing file kept.');
          return;
        }
      }
    } catch (e) {
      log('overwrite check unavailable, continuing: ' + (e && e.message ? e.message : e));
    }
    runBtn.disabled = true;
    barFfmpeg.classList.remove('indeterminate');
    barFfmpeg.style.width = '0%';
    ffmpegStatus.textContent = 'Running…';
    log(`running ffmpeg → ${out}…`);
    try {
      const res = await window.api.runFfmpeg({ args: lastArgs, outputFile: out });
      barFfmpeg.style.width = '100%';
      ffmpegStatus.textContent = 'Done';
      log('done → ' + (res && res.output ? res.output : 'ok'));
    } catch (e) {
      ffmpegStatus.textContent = 'Failed';
      // Failures surface themselves: expand the collapsed-by-default logs.
      terminal.hidden = false;
      toggleLogsBtn.textContent = 'Hide logs';
      terminal.scrollTop = terminal.scrollHeight;
      log('ffmpeg failed: ' + (e && e.message ? e.message : e));
    } finally {
      runBtn.disabled = false;
    }
  }

  // Drag and drop: DataTransfer.items fallback, copy effect,
  // flicker-free highlight, terminal diagnostics, plus a window-level
  // guard so a missed drop never navigates the app away.
  function filesFromDrop(e) {
    const dt = e.dataTransfer;
    if (!dt) return [];
    if (dt.files && dt.files.length > 0) return Array.from(dt.files);
    const out = [];
    if (dt.items) {
      for (const item of dt.items) {
        if (item && item.kind === 'file') {
          const f = item.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  // One compact diagnostics line per drop: shows exactly which flavors the
  // OS offered (types, files, items, readable data) to debug pathless drops.
  function diagnoseDrop(e) {
    const dt = e.dataTransfer;
    const info = [];
    try {
      info.push('types=[' + (dt.types ? Array.from(dt.types).join(',') : '?') + ']');
    } catch { info.push('types=?'); }
    try {
      info.push('files=' + (dt.files ? dt.files.length : '?'));
    } catch { info.push('files=?'); }
    try {
      const kinds = [];
      if (dt.items) {
        for (const it of dt.items) kinds.push(it.kind + ':' + (it.type || '?'));
      }
      info.push('items=[' + kinds.join(',') + ']');
    } catch { info.push('items=?'); }
    for (const fl of ['text/uri-list', 'text/plain', 'Text', 'URL']) {
      try {
        const v = dt.getData(fl);
        if (v) info.push(fl + '=' + JSON.stringify(String(v).slice(0, 100)));
      } catch { /* flavor unreadable */ }
    }
    log('drop diagnostics: ' + info.join(' '));
  }

  // Last resort for pathless drops: the bytes are still readable, so import
  // a temp copy via the main process (capped to avoid renderer OOM).
  async function importPathlessDrop(f) {
    const sizeMB = f.size / 1048576;
    if (!Number.isFinite(f.size) || f.size <= 0) {
      log('drop ignored: the dragged item exposed no path and no data (drag from File Explorer).');
      return;
    }
    if (sizeMB > 500) {
      log(`drop too large to import without a path (${sizeMB.toFixed(0)} MB) - use "Load a different video" instead.`);
      return;
    }
    log(`drop has no path; importing ${sizeMB.toFixed(1)} MB copy…`);
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const p = await window.api.saveDroppedFile(f.name || 'dropped-video', buf);
      log(`drop imported to temp copy: ${p}`);
      log('Note: outputs default next to the temp copy - use Choose to relocate them.');
      setFile(p);
    } catch (err) {
      log('drop import failed: ' + (err && err.message ? err.message : err));
    }
  }

  // file:///C:/dir/file.mp4 → C:\dir\file.mp4 (or POSIX as-is).
  function pathsFromUriList(dt) {
    const out = [];
    let text = '';
    try {
      text = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
    } catch { return out; }
    for (let line of String(text).split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      if (/^file:\/\//i.test(line)) {
        let p = line.replace(/^file:\/\/(localhost\/)?/i, '');
        try { p = decodeURI(p); } catch { /* keep raw */ }
        if (/^[A-Za-z]:\//.test(p)) p = p.replace(/\//g, '\\');
        out.push(p);
      } else if (/^[A-Za-z]:[\\/]/.test(line) || line.startsWith('\\\\')) {
        out.push(line);
      }
    }
    return out;
  }

  let dragDepth = 0;
  dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    try { e.dataTransfer.dropEffect = 'copy'; } catch { /* ignore */ }
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch { /* ignore */ }
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('over');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    dropzone.classList.remove('over');
    diagnoseDrop(e);
    const files = filesFromDrop(e);
    if (files.length > 0 && files[0] && files[0].path) {
      log(`drop received: ${files[0].name || files[0].path}`);
      setFile(files[0].path);
      return;
    }
    if (files.length > 0) {
      log(`drop received: ${files[0] && files[0].name ? files[0].name : '(unnamed file)'}`);
    }
    // No path on the File object? Try the uri-list flavor…
    const viaUri = pathsFromUriList(e.dataTransfer);
    if (viaUri.length > 0) {
      log(`drop resolved via uri-list: ${viaUri[0]}`);
      setFile(viaUri[0]);
      return;
    }
    // …then fall back to importing the bytes.
    if (files.length > 0 && files[0]) {
      importPathlessDrop(files[0]);
      return;
    }
    log('drop received but contained no files.');
  });
  // Never let a file drop navigate away / blank the app.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  dropzone.addEventListener('keydown', (e) => {
    // Only when the card itself is focused - a focused button already
    // activates natively, and firing twice would open two dialogs.
    if ((e.key === 'Enter' || e.key === ' ') && e.target === dropzone) {
      e.preventDefault();
      browseBtn.click();
    }
  });

  browseBtn.addEventListener('click', async () => {
    const p = await window.api.pickFile();
    if (p) setFile(p);
  });

  chooseOutputBtn.addEventListener('click', async () => {
    const current = effectiveOutput() || defaultOutput();
    const ext = translatedExt().replace(/^\./, '');
    const p = await window.api.pickOutput({ defaultPath: current || undefined, extension: ext || undefined });
    if (p) {
      outputFile = p;
      outputManual = true;
      refreshOutputDisplay();
      if (outputPath.value !== p) {
        log(`output set to: ${outputPath.value} (extension follows the translated command)`);
      } else {
        log(`output set to: ${p}`);
      }
    }
  });

  translateOnlyBtn.addEventListener('click', translate);
  minBtn.addEventListener('click', () => { try { window.api.windowMin(); } catch { /* ignore */ } });
  maxBtn.addEventListener('click', async () => {
    try {
      const maximized = await window.api.windowMax();
      maxBtn.textContent = maximized ? '❐' : '▢';
    } catch { /* ignore */ }
  });
  closeBtn.addEventListener('click', () => { try { window.api.windowClose(); } catch { /* ignore */ } });
  titlebar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tb-controls')) return;
    maxBtn.click();
  });
  toggleLogsBtn.addEventListener('click', () => {
    const collapsed = !terminal.hidden;
    terminal.hidden = collapsed;
    toggleLogsBtn.textContent = collapsed ? 'Show logs' : 'Hide logs';
    if (!collapsed) terminal.scrollTop = terminal.scrollHeight;
  });
  translateBtn.addEventListener('click', async () => {
    const res = await translate();
    if (res) await run();
  });
  runBtn.addEventListener('click', run);

  window.api.onLog(({ line }) => log(line));
  window.api.onProgress((p) => {
    if (!p) return;
    if (p.done) {
      barFfmpeg.style.width = '100%';
      if (ffmpegStatus.textContent === 'Running…') {
        ffmpegStatus.textContent = p.code === 0 ? 'Done' : `Failed (code ${p.code})`;
      }
    } else if (typeof p.pct === 'number') {
      const pct = Math.max(0, Math.min(100, p.pct));
      barFfmpeg.style.width = pct + '%';
      ffmpegStatus.textContent = `${Math.floor(pct)}%`;
    } else {
      // No duration known: creep forward so the bar still feels alive.
      const cur = parseFloat(barFfmpeg.style.width) || 0;
      barFfmpeg.style.width = Math.min(96, cur + 2) + '%';
    }
  });

  refreshOutputDisplay();
  refreshStatus();
})();
