---
title: Sites (PHP intranet)
desc: Host small PHP, HTML and JS pages inside your server, with a code editor and a visual editor.
group: Extending
order: 3
---

A **Site** is a server kind that serves a folder of PHP, HTML, CSS and JS pages inside the app instead of chat channels. It appears in the server rail for everybody (a public, auto-join server with no channels, voice or notifications) and renders in a same-origin frame. Use it for a team wiki, a duty rota, a small internal tool.

## Who can create and edit

Site staff with the **Manage Any Server** (or **Site Administrator**) permission create Sites from the **+** dialog, on the **New Site** tab. The Site's owner and site staff can edit it; everybody else just views it.

## The PHP runtime

- **Windows**: run `npm run fetch:php` once on the build machine. It downloads the portable PHP 8.4 (checksum verified) and Microsoft's Visual C++ redistributable into `runtime/php/`, and `npm run build:portable` copies it along. If PHP exits with the missing-DLL code at start, the server runs the bundled `vc_redist.x64.exe` itself (Windows shows a UAC prompt unless the server is elevated).
- **Linux and macOS**: install PHP with your package manager, or set `sites.phpPath`.

Settings in `data/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `sites.phpPath` | `""` | Explicit PHP binary. Empty means `runtime/php/php.exe`, then `php` on the PATH |
| `sites.maxWorkers` | `4` | Parallel PHP processes per Site (1 to 16). Each active worker uses roughly 20 to 30 MB |

## The editor

The **Edit** button opens a file tree with a code view (CodeMirror with HTML, PHP, JS and CSS coloring, and **Ctrl+S**) and a **visual view** (TinyMCE) in which PHP blocks stay protected as chips and are restored byte for byte. A page the visual editor cannot round-trip falls back to the code view automatically.

Allowed files: `php html htm css js json txt md svg png jpg jpeg gif webp ico`, up to 2 MB per file, 200 files and 50 MB per Site.

## External origins

A Site's settings list the extra `https://` origins its pages may load scripts, styles, images and frames from. Adding one shows a warning, because a script loaded from another origin runs with the page's privileges. Wildcards are not allowed.

## Links

Links that leave the Site (another origin, `target="_blank"`, `window.open`) open in the operating system's browser in the desktop app and in a new tab on the web.

::: danger Trust
Site pages run as part of MeshCrowd. **Anyone who can edit a Site can run code on the server** and, through same-origin JavaScript, as the people viewing it. Only give edit rights to people you would give server access.
:::
