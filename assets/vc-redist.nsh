; NSIS custom install hook for PlainFFmpeg (referenced by package.json build.nsis.include).
; Installs the bundled MSVC redistributable silently: the node-llama-cpp
; prebuilt binary fails to load without it on stock Windows (ERR_DLOPEN_FAILED).
; Only 0 (installed), 1638 (a newer version is already present), and 3010
; (installed, reboot required - /norestart defers it) mean success. Anything
; else (1603 fatal, 1619 package, 1625 policy-blocked, 5 access-denied, 1223
; UAC-cancelled, ...) leaves the runtime missing, so warn instead of going
; green silently. The app itself is installed either way.
!macro customInstall
  File /oname=$PLUGINSDIR\vc_redist.x64.exe "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $0
  StrCmp $0 0 plainffmpegVcRedistDone
  StrCmp $0 1638 plainffmpegVcRedistDone
  StrCmp $0 3010 plainffmpegVcRedistDone
  ; The per-user installer cannot elevate itself: only this bundled runtime
  ; needs admin rights. A declined prompt (1223 cancelled, 5 denied) installs
  ; the app fine but leaves translation broken - say exactly that.
  StrCmp $0 1223 plainffmpegVcRedistDenied
  StrCmp $0 5 plainffmpegVcRedistDenied
  MessageBox MB_OK|MB_ICONEXCLAMATION "PlainFFmpeg installed, but the Microsoft Visual C++ Redistributable (x64) failed to install (exit code $0). Translation needs it: install it from https://aka.ms/vs/17/release/vc_redist.x64.exe, then restart the app."
  Goto plainffmpegVcRedistDone
  plainffmpegVcRedistDenied:
  MessageBox MB_OK|MB_ICONEXCLAMATION "PlainFFmpeg installed, but the admin prompt for the Microsoft Visual C++ Redistributable (x64) was declined, so translation will not work yet. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe (needs admin once), then restart the app."
  plainffmpegVcRedistDone:
!macroend

; Uninstall removes the per-user app data dir (including the 1.3 GB model).
; (The portable needs no hook: its data lives next to the exe by default.)
!macro customUnInstall
  RMDir /r "$APPDATA\PlainFFmpeg"
!macroend
