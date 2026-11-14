# MeshCrowd Launcher

Optional WinForms control panel for the server (config editor, supervised start/stop/restart, console, logs, crash reports, doctor). Not needed to run the server.

Build: `build.bat` -> publishes a self-contained single file and copies it to `..\Launcher.exe` (next to start-server.bat).

Server hooks used: `MESHCROWD_FORCE_CONSOLE=1` (local console on piped stdin) and `quiet` console commands (stats/status/list are not logged).

`Resources\commands.json` is generated: `DISMESH_DATA_DIR=<tmp> node tools/dump-commands.js`, rerun when console commands change.

Test options: `--root <server folder>`, `--page <Dashboard|Console|...>`, env `DISMESH_DATA_DIR`.
