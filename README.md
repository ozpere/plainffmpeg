# <img src="assets/logo.png" alt="logo" width="32" height="32"> PlainFFmpeg

Self-contained video editor using plain English - describe the edit, the app translates it into an FFmpeg command with a local LLM and runs it. 100% offline: no Ollama, no Python, no cloud, no accounts.

## How it works

1. Load a video (drag & drop, or *Browse…*).
2. Type an instruction, e.g. *"Convert to mp4, trim the last 5 seconds, make it 360p"*.
3. The bundled GGUF model (`Qwen3-1.7B` via `node-llama-cpp`)
   translates it to FFmpeg arguments, which run through a bundled
   `ffmpeg-static` binary with live logs.

LLM problems never run a guessed command - they surface as a clear error
instead. No silent fallbacks, anywhere.

## Prerequisites

- **Node.js 24 LTS** - https://nodejs.org (matches the Electron 44 runtime)
- **Git** - https://git-scm.com (Windows: then run
  `git config --global core.longpaths true` once)
- **Windows only:** Microsoft Visual C++ Redistributable (x64) -
  https://aka.ms/vs/17/release/vc_redist.x64.exe (required by the
  prebuilt LLM binary)
- ~3 GB free (dependencies + the ~1.3 GB model)

## Install & run

```bash
# Linux / macOS
npm install
npm start
```

```cmd
:: Windows (extract the source somewhere short, e.g. C:\plainffmpeg)
npm run install:win
npm start
```

`install:win` forces CPU-only LLM binaries (skipping the Vulkan dead end),
runs the preflight checks, and verifies the native binary loads. It skips
the ~1.3 GB model fetch by default (fast, offline-friendly installs) -
first launch downloads it in-app, or run `npm run download-model` anytime
(`SKIP_MODEL_DOWNLOAD=0` fetches during install). Plain `npm install`
still fetches via `postinstall`, skipped when offline.

## Windows installer

```cmd
npm run fetch-vc-redist
npm run dist:win
```

Builds a per-user NSIS installer and a portable exe in `dist/`. The
installer is thin (no ~1.3 GB model bundled) and sets up the MSVC runtime
silently - declining its admin prompt still installs the app, but
translation needs that runtime. The installer is branded with the app icon
and the warm-charcoal sidebar/header art (full NSIS color theming is not
possible, so pages keep the native layout). The portable keeps everything
(model, profile, imports) in `PlainFFmpegData` next to the exe, so deleting
the folder leaves nothing behind. If the exe folder is not writable, the
portable asks before using Windows app data instead; if it simply finds an
existing model in app data (from an install or an earlier run), it reuses it
and says so without claiming the folder is unwritable. First launch
downloads the model in-app (resumable, with progress), then works fully
offline. Releases are built by CI on demand or `v*` tags; unsigned builds
trigger SmartScreen until code-signed.

## Scripts

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `npm start`            | Launch the app                                            |
| `npm test`             | Syntax-check every JS file                                |
| `npm run test:headless`| Full headless suite (no GUI, no model needed)             |
| `npm run download-model` | (Re)download the GGUF model into `models/` (resumable) |
| `npm run fetch-vc-redist` | Fetch the MSVC redist into `assets/` (build-time only) |
| `npm run dist:win` | Build the Windows installer + portable exe into `dist/` |
| `npm run dist:linux` | Build the Linux AppImage into `dist/` |
| `npm run install:win`  | Windows-safe install with preflight checks                |

## Project layout

```
src/
  main.js              Electron main process: window, IPC, translate/run
                       orchestration (re-exports fixups/paths/llm)
  fixups.js            Deterministic FFmpeg argument correction layers
  paths.js             Model, portable, and output locations; MSVC detection
  llm.js               Local GGUF engine (prompt, session, diagnostics)
  preload.js           Minimal context-bridge API (sandboxed renderer)
  renderer/
    index.html         UI structure, model download card, open-folder shortcut
    renderer.js        UI logic (load → probe → translate → run, model download)
    styles.css         Warm-charcoal theme
scripts/
  download-model.js    GGUF fetcher (Hugging Face, resumable, format-checked)
  fetch-vc-redist.js   MSVC redist fetcher (build-time only, not committed)
  install-windows.js   Windows install helper (CPU-only, long paths, MSVC check)
  smoke-test.js        Headless verification suite
  translate-cases.js   Regression corpus (raw model output → final args)
assets/                Logo, platform icons, branded installer art, NSIS hooks
models/                GGUF weights live here (gitignored, never committed)
```

## Notes

- The engine badge polls the LLM state: unavailable → loading → ready
  (or failed, with the cause in the logs). A translation requested
  mid-load simply waits for it.
- Translation and FFmpeg step statuses are color- and icon-coded (Idle,
  Translating.../Running..., Done, Failed, Cancelled), so outcomes read at
  a glance.
- "Trim the last N seconds" means *cutting* those seconds off
  (`-t duration-N`); "keep the last N" keeps the tail; "keep the middle N"
  keeps the center cut (`-ss (duration-N)/2 -t N`).
- Size limits ("below 2GB") are enforced with single-pass capped
  bitrate computed from the probed duration - two-pass is never used.
- Output extensions always follow the translated container, and the app
  asks before overwriting an existing file.
- Open folder jumps to the output directory (disabled until a destination
  exists).

## License

MIT - see [LICENSE](LICENSE).
