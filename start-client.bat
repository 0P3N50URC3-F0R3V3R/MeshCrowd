@echo off
setlocal
title MeshCrowd Client
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron isn't installed yet. Run this once with an internet connection:
  echo   npm install
  pause
  exit /b 1
)

rem Default launch keeps no console window attached (double-click from Explorer/a shortcut
rem shouldn't flash a terminal); "start-client.bat -dev" keeps this window open and passes
rem -dev through to main.js (gates the DevTools shortcut, see electron/main.js).
if /i "%~1"=="-dev" (
  "node_modules\electron\dist\electron.exe" electron\main.js -dev
) else (
  start "" /B "node_modules\electron\dist\electron.exe" electron\main.js
)
