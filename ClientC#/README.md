# MeshCrowd C# client

WebView2 shell around the web client; feature parity target is `electron/main.js`. Shares `electron/renderer/*` and `electron/icon.*` (linked, not copied).

Build one exe: `dotnet publish MeshCrowd.Client -c Release -o dist` -> `dist/MeshCrowd.exe` (self-contained, single file). Config and the WebView2 profile live in `data/` beside the exe. Machines with the WebView2 Evergreen runtime use it. For machines without it, run `powershell -File bundle-webview2.ps1` (packs the installed runtime, trimmed, into `MeshCrowd.Client/webview2-runtime.bin`, ~200 MB, gitignored) before `dotnet publish`: the exe (~250 MB) then unpacks it once into `data/webview2-runtime` when none is installed. `--bundled-webview2` forces the bundled copy.

`--dev` enables DevTools. The page's 38px top bar is the title bar (drag, double-click to maximize); min/max/close are drawn over its right end like Electron's titleBarOverlay.
