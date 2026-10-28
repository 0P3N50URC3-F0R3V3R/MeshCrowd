@echo off
setlocal
title MeshCrowd - STUN/TURN setup
cd /d "%~dp0"

rem Opening firewall ports needs administrator rights; ask Windows (UAC) once.
net session >nul 2>&1
if errorlevel 1 (
  echo Administrator rights are needed to open the firewall. Windows will ask for permission.
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
  exit /b
)

if exist "runtime\node.exe" (
  "runtime\node.exe" server\tools\setupTurn.js %*
) else (
  node server\tools\setupTurn.js %*
)
echo.
pause
