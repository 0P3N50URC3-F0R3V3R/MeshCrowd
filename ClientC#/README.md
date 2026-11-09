# MeshCrowd C# client

WebView2 shell around the web client; feature parity target is `electron/main.js`. Shares `electron/renderer/*` and `electron/icon.*` (linked, not copied).

Build one exe: `dotnet publish MeshCrowd.Client -c Release -o dist` -> `dist/MeshCrowd.exe` (self-contained, single file). Config and the WebView2 profile live in `data/` beside the exe. Needs the WebView2 Evergreen runtime on the machine.

`--dev` enables DevTools. The page's 38px top bar is the title bar (drag, double-click to maximize); min/max/close are drawn over its right end like Electron's titleBarOverlay.
