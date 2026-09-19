# PlainFFmpeg - Agent Guide

Self-contained offline Electron video editor. Plain English instruction is translated to FFmpeg args by a local GGUF model (`Qwen3-1.7B` via `node-llama-cpp`), corrected by deterministic layers, then run via bundled `ffmpeg-static`. 100% offline: no Ollama, no Python, no cloud, no accounts.

## Stack

- Node.js 20 LTS (matches Electron 33 runtime), Electron 33, CommonJS in `src/main.js`
- `node-llama-cpp` v3 is pure ESM. Main process is CJS, so load it only via `await import('node-llama-cpp')`. Never `require('node-llama-cpp')` (throws ERR_REQUIRE_ESM).
- `ffmpeg-static` + `fluent-ffmpeg` (spawned directly so arbitrary LLM flags run verbatim)
- Vanilla JS renderer, no framework. `src/preload.js` is the only IPC bridge (contextIsolation, no nodeIntegration).
- Model lives at `models/model.gguf` in dev (~1.3 GB, gitignored). Never commit `*.gguf`.

## Commands

| Command | Use |
| --- | --- |
| `npm start` | Launch app (window first, LLM preloads in background) |
| `npm test` | Syntax check all JS files (`node --check`) |
| `npm run test:headless` | Full headless suite `scripts/smoke-test.js`, no GUI or model needed |
| `npm run download-model` | (Re)download GGUF from Hugging Face (resumable) |
| `npm run fetch-vc-redist` | Fetch MSVC redist into `assets/` for the Windows installer |
| `npm run dist:win` | Build Windows NSIS installer + portable exe (`dist/`) |
| `npm run dist:linux` | Build Linux AppImage (`dist/`) |
| `npm run install:win` | Windows-safe install: CPU-only binaries, long-paths, MSVC check |

Run `npm test` plus `npm run test:headless` after every change. Smoke test is the contract: helpers, prompt content, IPC surface, branding, CSS theme, and UX copy.

## Layout

```
src/main.js              Main process: LLM engine, SYSTEM_PROMPT, fixup layers, probe, run, IPC handlers
src/preload.js           contextBridge API, must mirror IPC channels 1:1
src/renderer/renderer.js UI logic: load, probe, translate, run, drag-drop, modals, badges, model download
src/renderer/index.html  UI structure, frameless titlebar, split progress bars, model download card
src/renderer/styles.css  Warm-charcoal theme, no gradients
scripts/download-model.js GGUF fetcher, resumable (TARGET is models/model.gguf, shared by main via downloadTo)
scripts/fetch-vc-redist.js MSVC redist fetcher for the installer (not committed)
assets/vc-redist.nsh     NSIS hooks: silent MSVC redist install (`customInstall`, needs vc_redist.x64.exe beside it at build) and uninstall cleanup (`customUnInstall` removes `%APPDATA%\PlainFFmpeg` and the staged copy `%LOCALAPPDATA%\plainffmpeg-updater`)
.github/workflows/release.yml Windows CI: install, checks, dist:win, dist:linux, upload exes
scripts/install-windows.js CPU-only install helper
scripts/smoke-test.js    Headless contract, asserts behavior not just syntax
models/                  Weights only (gitignored). Keep models/.gitkeep.
```

## Translation pipeline (src/main.js)

Order is fixed in `handleTranslatePrompt`:

1. `sanitizeModelOutput` - strip think traces/fences/backticks, rejoin lines, drop prose, require `-i`. Pure prose throws.
2. `tokenizeArgs` - shell-aware split, preserves quotes.
3. `fixupArgs` - rewrite invalid sizes: `-s 360p` and `scale=720p` become `scale=-2:H`. Merge into existing `-vf`; merge duplicate `-vf` chains (ffmpeg keeps only the last one).
4. `fixupInput` - replace placeholder/missing `-i` (e.g. `input.mp4`) with the loaded video path. Existing real file is untouched.
5. `fixupConflicts` - strip `-pass`/`-passlogfile` (single-shot runner), drop audio flags under `-an`, fix `-c:v copy` + video filters via container-aware codec. Needs instruction words, not the output token.
6. `ensureOutputFile` - drop trailing valued flags left by truncation (else the output is swallowed as a flag value), then append `output.<ext>` if missing. Ext comes from instruction words, else codec hints, else `.mp4`. Runs BEFORE trim/size so their insertions slot before a real trailing output (never split a flag/value pair).
7. `fixupLastTrim` - needs `duration`. "trim/cut/remove the last N" keeps `[0, D-N]` via `-t`. "keep/extract only the last N" keeps tail via `-ss D-N`, no `-t`.
8. `fixupSizeLimit` - "below 2GB / under 500MB" enforces single-pass capped bitrate `-b:v Xk -maxrate Xk -bufsize 2Xk`, audio bounded to `-c:a aac -b:a 128k` (oversized `-b:a` is capped). Never two-pass. `-an` stays muted.

## Critical invariants

- No silent fallbacks anywhere. LLM failure returns `{ ok: false, error, diag }` and UI shows banner. Never run a guessed command. `fallbackTranslate` must not exist.
- `-y` is forced at run time (`finalArgs.unshift('-y')`). Overwrite consent is asked beforehand via in-app modal.
- Output extension always follows the translated container (`enforceOutputExtension`, `coerceExt`). `defaultOutputPath` is `output.<ext>` next to input, `output.ext` before translation. Never guess a container.
- Probe uses `ffmpeg -i` stderr parse (no ffprobe dep). `run-ffmpeg` replaces trailing output token with explicit `outputFile`.
- `resolveModelPath` honors `MODEL_PATH` env. Portable branch is deliberately short: exe-side `PlainFFmpegData` home, then per-user data dir as the LAST fallback (nothing after it). Other flows: preferred write target, then any dir holding an existing download, then Qwen alias filenames.
- Thin installer: no `*.gguf` is ever bundled (`build.files` excludes models). First launch shows `#modelDl`; `download-model` IPC streams `model-download-progress` and warms the engine on success.
- `llamaDiagnostics` + `llamaPrebuiltProbe` must keep working: they turn load failures into a pasteable answer. Keep `handleModelStatus` fields stable: `ready, loading, loadError, exists, size, engine, portable, fallbackToAppData`.
- Portable app-data fallback is consent-gated: `handleDownloadModel` returns `needsConsent` without it, the renderer asks via the themed `confirmDialog` modal, and `#portableNote` stays visible while the fallback is active.
- Temp drop imports go to `os.tmpdir()/plainffmpeg-drops`, capped at 500 MB (enforced in main and renderer).
- Spawned binaries must resolve beside the asar (`app.asar.unpacked`): `child_process.spawn` is not asar-patched, so asarUnpack alone is not enough (see `ffmpegPath`).

## IPC and UI

- Channels (preload must expose all): `modelStatus, translatePrompt, downloadModel, pickFile, pickOutput, outputExists, saveDroppedFile, openPath, windowMin, windowMax, windowClose, probeMedia, runFfmpeg` plus `ffmpeg-log` / `ffmpeg-progress` / `model-download-progress` events.
- Frameless window (`frame: false`), custom `#titlebar` with `#minBtn #maxBtn #closeBtn`, `-webkit-app-region: drag` with `no-drag` on controls.
- Errors surface via `#errorBanner` + `showBanner` + `prettyLlmError`. Never `window.alert` or native `confirm`. Overwrite uses `#confirmOverlay` + `confirmOverwriteUI`; storage consent reuses the same modal via `confirmDialog`.
- Badge flow: `unavailable > loading > ready`, polled via `setTimeout(refreshStatus)`. Terminal `#terminal` starts empty and collapsed (`hidden`).
- Renderer path helpers handle `/` and `\`. Preview URLs use `toFileUrl`. Drops handle `DataTransfer.files`, `items.getAsFile`, and `text/uri-list` fallback.

## Style and copy (enforced by smoke test)

- House style: short hyphen `-` only. Do not introduce U+2014 in source, styles, or UI copy.
- No `linear-gradient`, no glow, no purple/indigo (`#6c8cff #9d7bff #4a6cf7 #8b5cf6`), no `text-transform: uppercase`. Pastel badges: loading `#f2b8b0`, ready `#bfe3b8`. Centered `.btn-row`, preview capped at `max-height: 320px`, sticky titlebar.
- Button order in `index.html`: `translateOnlyBtn`, `translateBtn` (`✦ Translate & Run FFmpeg`, monochrome glyph, never color emoji), `runBtn`.
- Copy: title `PlainFFmpeg`, subtitle stresses `100% offline`, statuses capitalized (`Translating...`, `Running...`, `Failed`, `Done`, `Cancelled`, `Idle`), badge prefix `Engine: ...`.

## Windows and install quirks

- `install-windows.js` forces `NODE_LLAMA_CPP_GPU=false` (skips Vulkan dead end), enables `git core.longpaths true`, warns if project path is long (use `C:\plainffmpeg`), checks MSVC DLLs, verifies native binary loads with dynamic `import()`.
- `SKIP_MODEL_DOWNLOAD=1` skips the ~1 GB fetch for offline/CI smoke runs.
- Windows releases (`.github/workflows/release.yml`, manual or `v*` tag): `fetch-vc-redist`, `install:win`, checks, `dist:win`, upload exes (artifacts expire via `retention-days`: 14 manual, 1 on tags). Linux AppImage (`dist:linux`) builds in the same workflow on `ubuntu-22.04`. Tag pushes additionally publish a permanent Release (`publish-release` job, tag-only gate); manual runs never publish. electron-builder config lives in `package.json` (`build`): NSIS per-user + portable x64, AppImage x64, `asarUnpack` for `@node-llama-cpp` and `ffmpeg-static`, `npmRebuild: false`, NSIS `include` runs the bundled `vc_redist` silently. The unsigned build triggers SmartScreen; signing is a future paid step.

## Adding a fixup

- Pure function `(args, context) => { args, corrections }`. Never throw, never silently drop flags. Push a human-readable string per rewrite (surfaced in logs).
- Add cases to `scripts/smoke-test.js` alongside the change. Follow existing `assert.deepStrictEqual` patterns for args and `corrections.length`.
