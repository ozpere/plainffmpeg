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

- **Node.js 20 LTS** - https://nodejs.org (matches the Electron 33 runtime)
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
runs the preflight checks, and verifies the native binary loads.
The model downloads automatically on first install via `postinstall`
(`npm run download-model` anytime).

## Windows installer

```cmd
npm run fetch-vc-redist
npm run dist:win
```

This builds a per-user NSIS installer (`PlainFFmpeg-Setup-*.exe`) and a
portable exe (`PlainFFmpeg-Portable-*.exe`) in `dist/`. The installer is
thin: the ~1.3 GB model is not bundled. On first launch the app shows a
Download card and fetches the model itself (resumable, with progress),
then works fully offline. Installed copies keep the model in the per-user
app data folder, so no admin rights are needed. Uninstalling removes it.
The portable instead keeps its data in a `PlainFFmpegData` folder next to
the exe (when that location is writable) - deleting the folder removes
everything, no leftovers. If the exe folder is not writable, the portable
asks before downloading the model to Windows app data instead, and keeps a
visible note while that fallback is active. Either way the resolved model path is logged on
boot so the ~1.3 GB is always findable.

Notes:

- `fetch-vc-redist` downloads the Microsoft C++ runtime so the installer
  can set it up silently (the local AI engine needs it on stock Windows).
- Windows releases are also built by CI (`.github/workflows/release.yml`,
  manual run or a `v*` tag) and uploaded as artifacts.
- `npm run dist:linux` builds an `x86_64.AppImage` (also built by CI).
  No extra runtime is needed on Linux.
- Unsigned builds trigger a Windows SmartScreen warning on first run -
  expected until releases are code-signed.

## Scripts

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `npm start`            | Launch the app                                            |
| `npm test`             | Syntax-check every JS file                                |
| `npm run test:headless`| Full headless suite (no GUI, no model needed)             |
| `npm run download-model` | (Re)download the GGUF model into `models/` (resumable) |
| `npm run fetch-vc-redist` | Fetch the MSVC redist into `assets/` (build-time only) |
| `npm run dist:win` | Build the Windows installer + portable exe into `dist/` |
| `npm run install:win`  | Windows-safe install with preflight checks                |

## Project layout

```
src/
  main.js              Electron main process: window, local LLM engine,
                       argument correction layers, ffmpeg runner, IPC
  preload.js           Minimal context-bridge API (sandboxed renderer)
  renderer/
    index.html         UI structure
    renderer.js        UI logic (load → probe → translate → run)
    styles.css         Warm-charcoal theme
scripts/
  download-model.js    GGUF fetcher (Hugging Face, resumable layout)
  install-windows.js   Windows install helper (CPU-only, long paths, MSVC check)
  smoke-test.js        Headless verification suite
assets/                Logo + platform icons
models/                GGUF weights live here (gitignored, never committed)
```

## Notes

- The engine badge polls the LLM state: unavailable → loading → ready.
  A translation requested mid-load simply waits for it.
- "Trim the last N seconds" means *cutting* those seconds off
  (`-t duration-N`); "keep the last N" keeps the tail.
- Size limits ("below 2GB") are enforced with single-pass capped
  bitrate computed from the probed duration - two-pass is never used.
- Output extensions always follow the translated container, and the app
  asks before overwriting an existing file.

## License

MIT - see [LICENSE](LICENSE).
