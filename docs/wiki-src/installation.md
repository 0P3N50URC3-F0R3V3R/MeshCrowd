---
title: Installation and updates
desc: Requirements, the portable bundle, running from source, ports, backups and how to update.
group: Start here
order: 2
---

## Requirements

| Part | Needs |
|---|---|
| Server | **Node.js 22.5 or newer** (it uses the built-in `node:sqlite` module). A suitable `node.exe` is bundled on Windows. |
| Memory and disk | A few hundred MB of RAM for a small community, and enough disk for uploads. |
| Browser | A current Chromium, Firefox or Safari based browser. |
| Voice and video | HTTPS (or `localhost`), plus the built-in STUN/TURN server (or an external one) for people on different networks. See [STUN and TURN](configuration.html#stun-and-turn). |

## Windows: the portable bundle

The bundle contains the server, the web client, a Node.js runtime and an empty `data/` skeleton. Copy it to any machine with the same operating system, even one without internet access.

1. Unzip it anywhere.
2. Run `start-server.bat`.
3. Edit `data/config.json` if the host or ports need to change, then restart.

## Linux and macOS: from source

```
node --version     # must be 22.5 or newer
npm install
npm start
```

`./start-server.sh` does the same and prefers a bundled runtime when there is one. Use `npm run dev` while developing; it restarts the server when files change.

## What the first start creates

| Path | What it is |
|---|---|
| `data/dismesh.db` | The SQLite database: users, servers, messages |
| `data/config.json` | The configuration, written with defaults on every start |
| `data/certs/` | The generated self-signed certificate (unless you configure your own) |
| `data/attachments/`, `data/avatars/` and similar | Uploaded files |

## Ports

By default HTTPS listens on `8443`. The plain `8080` port only redirects to HTTPS. Change them with `httpsPort` and `port` in `data/config.json`. See [Configuration](configuration.html).

## Running as a service

Run the start script under your service manager of choice (systemd, a Windows service wrapper, a scheduled task). The process writes its log to standard output. Stop it with a normal termination signal; the database closes cleanly.

## Backups

::: note One folder
Stop the server and copy the whole `data/` folder. It contains the database, the configuration, the certificate and every uploaded file. Restore by putting the folder back.
:::

Do not copy `data/dismesh.db` alone while the server runs, because uploads and the database must match.

## Updating

1. Take a backup.
2. Stop the server.
3. Replace the program files with the new version, keeping your `data/` folder.
4. Start the server. Database changes are applied automatically on start.

The web client and the phone interface are served by the server, so updating the server updates them everywhere. Desktop and Android apps only need a new release when their own native code changes.

## Building the portable bundle yourself

```
npm run build:portable
```

This produces `dist/dismesh-portable/`. For Sites, run `npm run fetch:php` once on the build machine to bundle a PHP runtime for Windows. See [Sites](sites.html).
