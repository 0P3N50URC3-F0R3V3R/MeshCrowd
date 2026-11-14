@echo off
setlocal
cd /d "%~dp0"
echo Building Launcher.exe ...
dotnet publish Launcher.csproj -c Release -o dist -nologo
if errorlevel 1 exit /b 1
copy /y dist\Launcher.exe ..\Launcher.exe >nul
echo Done: %~dp0..\Launcher.exe
