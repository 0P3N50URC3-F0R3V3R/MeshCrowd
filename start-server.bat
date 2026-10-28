@echo off
setlocal
title MeshCrowd Server
cd /d "%~dp0"
echo Starting MeshCrowd server...
echo.
if exist "runtime\node.exe" (
  "runtime\node.exe" server\index.js
) else (
  node server\index.js
)
echo.
echo Server stopped.
pause
