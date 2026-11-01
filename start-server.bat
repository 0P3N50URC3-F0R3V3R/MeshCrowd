@echo off
setlocal
title MeshCrowd Server
cd /d "%~dp0"
echo Starting MeshCrowd server...
echo.
:run
if exist "runtime\node.exe" (
  "runtime\node.exe" server\supervisor.js
) else (
  node server\supervisor.js
)
if %errorlevel%==42 goto run
if %errorlevel%==0 exit /b 0
echo.
echo Server stopped.
pause
