; NSIS custom install hook for PlainFFmpeg (referenced by package.json build.nsis.include).
; Installs the bundled MSVC redistributable silently: the node-llama-cpp
; prebuilt binary fails to load without it on stock Windows (ERR_DLOPEN_FAILED).
; Exit codes are intentionally ignored: 0 = installed, 1638 = a newer version
; is already present, 3010 = installed, reboot required (/norestart defers it).
!macro customInstall
  File /oname=$PLUGINSDIR\vc_redist.x64.exe "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart'
!macroend
