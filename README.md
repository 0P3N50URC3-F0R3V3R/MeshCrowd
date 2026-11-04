<div align="center"><img width="960" height="333" alt="MeshCrowd" src="https://github.com/user-attachments/assets/52f4e9ac-1f9f-477b-88be-70f5d428da46" />

# MeshCrowd

**A self-hosted chat platform you run on your own machine or network.**
Servers, channels, roles, DMs, voice/video calls and screen sharing, with no third-party service.

[![Webpage](https://img.shields.io/badge/Webpage-Visit%20MeshCrowd-10b981?style=for-the-badge&logo=google-chrome&logoColor=white)](https://0p3n50urc3-f0r3v3r.github.io/MeshCrowd/)
[![Wiki](https://img.shields.io/badge/Wiki-Read%20the%20docs-3b82f6?style=for-the-badge&logo=readthedocs&logoColor=white)](https://0p3n50urc3-f0r3v3r.github.io/MeshCrowd/wiki/index.html)
[![Releases](https://img.shields.io/badge/Releases-Download-orange?style=for-the-badge&logo=github&logoColor=white)](https://github.com/0P3N50URC3-F0R3V3R/MeshCrowd/releases)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=for-the-badge&logo=gnu&logoColor=white)](LICENSE)
</div>

## Start here

Everything about MeshCrowd (features, screenshots, installation, configuration, administration, troubleshooting) lives on the website:

**https://0p3n50urc3-f0r3v3r.github.io/MeshCrowd/**

To **use** MeshCrowd, download the ready-made portable packages from the [Releases](https://github.com/0P3N50URC3-F0R3V3R/MeshCrowd/releases) page: the server, the Windows desktop client and the Android app. Extract, double-click `start-server.bat`, done.

## This repository is the source code only

The **runtimes are not in this repository.** The bundled Node.js, the portable PHP used by Sites, the Electron desktop runtime, the vendored `node_modules` and the built Android APKs are only published in the [Releases](https://github.com/0P3N50URC3-F0R3V3R/MeshCrowd/releases). The `runtime/`, `node_modules/` and `data/` folders in the GitHub repository are empty on purpose. (A downloaded release package already contains all of it: just run `start-server.bat` / `start-server.sh`.)

To run from source anyway:

```
npm install
npm start
```

- You need **Node.js 22.5 or newer** installed yourself (the server uses the built-in `node:sqlite`).
- **Sites (PHP) need a PHP binary.** Chat, voice and everything else work without it. On Windows run `npm run fetch:php` once (downloads the portable PHP into `runtime/php/`); on Linux and macOS install PHP with your package manager, or point `sites.phpPath` in `data/config.json` at a binary. Without PHP the server logs `[php] unavailable` and only Site pages with PHP fail.
- Desktop client from source: `npm run electron`. Portable builds: `npm run build:client`, `npm run build:portable`. Tests: `npm test`.
- Open `https://localhost:8443`, accept the self-signed certificate once, and register. The first account is the Owner.

## Good to know

- Licensed under the [GNU GPL v3](LICENSE).
- Not a secret: this project is partially vibe-coded with AI-assisted tools, and has been supervised, tested and fixed by humans too.
- Status: in development. Known limitations are listed in the wiki's troubleshooting page.

## Do you like my work?

You can support the development if you want to.

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-%23FFDD00.svg?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/meshcrowd)
