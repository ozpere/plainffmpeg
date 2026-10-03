# <img src="assets/logo.png" alt="logo" width="32" height="32"> PlainFFmpeg

Edit videos by describing what you want in plain English. Type *"convert to mp4, trim the last 5 seconds, and make it 720p"* and the app does it. Everything runs on your own computer, so your videos never leave your PC.

How it works: a small built-in LLM turns your sentence into instructions for FFmpeg - the free, open-source video engine behind much of the world's most popular video editing software - and the app runs them for you.

## Download

**[Get the latest release](https://github.com/ozpere/plainffmpeg/releases)**

### Windows

- **Setup - recommended!** (`PlainFFmpeg-Setup.exe`) - installs the app and everything it needs.
- **Portable** (`PlainFFmpeg-Portable.exe`) - no install, runs from any folder or USB stick. It cannot install the Microsoft Visual C++ Redistributable (x64) that it needs, so on PCs that lack it, you need to install that first (the app informs you and gives you the link).

SmartScreen may show a blue *"Windows protected your PC"* warning since the app is not code-signed yet - click **More info**, then **Run anyway**.

### Linux

Just one file: the `.AppImage`. Make it executable and run it.

### macOS

No Mac build yet - but you can build it yourself from source, see below.

## Your first video in 3 steps

1. **Load a video** - drag a file onto the window, or press *Browse*.
2. **Type what you want** and press **Translate & Run FFmpeg**.
3. **Find the edited video** next to the original, with `-out` added to its name. If that file already exists, the app asks before overwriting it.

One instruction can do several things at once - paste any of these to see:

- *"Convert to mp4, trim the last 5 seconds, and make it 720p"*
- *"Keep only the middle 10 seconds and remove the sound"*
- *"Make a gif of the first 3 seconds"*
- *"Convert to mkv and boost the volume to 150%"*

### One thing to know first

The translations require downloading the local LLM (about 1.3 GB, once) - press **Download local LLM** and stay online until it finishes. Everything works offline after that.

## If something goes wrong

- **"Translation failed"** - press **Show logs** at the bottom and read the last lines. The most common cause is simply that the assistant above has not been downloaded yet.
- **The app mentions a missing Microsoft Visual C++ Redistributable (x64)** (portable version) - install it from the link shown, restart the app, and try again.
- **Your finished video has no sound** - check your instruction: words like *"mute"* (and gif, which has no sound at all) remove the audio on purpose.
- **The result is not what you asked for** - be exact with seconds and name one container (*"trim the last 5 seconds"*, not *"tidy it up"*). Vague wishes do not map to anything concrete.
- **Your file will not load** - try a common format such as mp4, mkv, webm, mov, or avi.

## Technical details

### Install & run from source

You need:

- **Node.js 24 LTS** - https://nodejs.org
- **Git** - https://git-scm.com (Windows: then run
  `git config --global core.longpaths true` once)
- **Windows only:** Microsoft Visual C++ Redistributable (x64) -
  https://aka.ms/vs/17/release/vc_redist.x64.exe (required by the
  prebuilt LLM binary)
- ~3 GB free (dependencies + the ~1.3 GB model)

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

`install:win` forces CPU-only LLM binaries,
runs the preflight checks, and verifies the native binary loads. It skips
the ~1.3 GB model fetch by default (fast, offline-friendly installs) -
first launch downloads it in-app, or run `npm run download-model` anytime
(`SKIP_MODEL_DOWNLOAD=0` fetches during install). Plain `npm install`
still fetches via `postinstall`, skipped when offline.

To build distributables: `npm run dist:win` produces the thin installer + portable
exe into `dist/` (fetches the MSVC redist itself, installs it silently),
`npm run dist:linux` the AppImage. Unsigned Windows builds trigger
SmartScreen until code-signed.

### Scripts

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
    index.html         UI structure, model download card, open-folder shortcut, editable command box
    renderer.js        UI logic (load → probe → translate → run, model download, editable command box)
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

How a plain-English instruction becomes exact FFmpeg flags (pipeline order, placeholders, run-time substitution) is documented in `AGENTS.md`, enforced by `scripts/smoke-test.js`, with regression cases in `scripts/translate-cases.js`.

## License

MIT - see [LICENSE](LICENSE).
