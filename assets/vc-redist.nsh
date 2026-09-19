; NSIS custom install hook for PlainFFmpeg (referenced by package.json build.nsis.include).
; Installs the bundled MSVC redistributable silently: the node-llama-cpp
; prebuilt binary fails to load without it on stock Windows (ERR_DLOPEN_FAILED).
; Exit codes are intentionally ignored: 0 = installed, 1638 = a newer version
; is already present, 3010 = installed, reboot required (/norestart defers it).
!macro customInstall
  File /oname=$PLUGINSDIR\vc_redist.x64.exe "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart'
!macroend

; Uninstall must not orphan the 1.3 GB model in the per-user app data dir,
; nor the builder-staged installer copy in Local (see below).
; (The portable needs no hook: its data lives next to the exe by default.)
!macro customUnInstall
  RMDir /r "$APPDATA\PlainFFmpeg"
  RMDir /r "$LOCALAPPDATA\plainffmpeg-updater"
!macroend
