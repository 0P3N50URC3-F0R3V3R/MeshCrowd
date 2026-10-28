# MeshCrowd 
<img width="64" height="64" alt="logo" src="https://github.com/user-attachments/assets/71f3a79b-d700-4d38-b396-de1ea6bdf50d" /> 

Visit the Project's Webpage: https://0p3n50urc3-f0r3v3r.github.io/MeshCrowd/index.html

**A self-hosted chat platform you run on your own machine or network.**

MeshCrowd gives a group of people servers, channels, roles, DMs, voice/video calls and screen
sharing without any third-party service. One Node.js process serves everything: the API, the
realtime WebSocket, and the web client. Data lives in a single SQLite file. The server has no
native npm addons and ships with its own Node runtime, so you can copy it to an offline machine
and start it with a double-click.


Not secret, that this project is partially VIBE-Coded and made with AI assisted tools, but it is 
underwent a supervision/testing/fixing too by human beings also.

## Screenshots
<img width="320" height="200" alt="chat-dev" src="https://github.com/user-attachments/assets/2377b699-ceed-48b5-9dbe-7a47e89ec89c" />
<img width="320" height="200" alt="chat-general" src="https://github.com/user-attachments/assets/5c4af736-0fed-4e98-9eab-66609b10e935" />
<img width="320" height="200" alt="settings-roles" src="https://github.com/user-attachments/assets/560c49ee-d56b-4754-bc7c-0ab64993b553" />
<img width="320" height="200" alt="theme-light" src="https://github.com/user-attachments/assets/e7fc1a14-d1b1-48ad-b8c9-016621a73040" />
<img width="320" height="200" alt="theme-sunset" src="https://github.com/user-attachments/assets/cb564015-903b-434c-afa0-484217243d59" />

## Mobile Screenshots
<img width="206" height="400" alt="m-chat" src="https://github.com/user-attachments/assets/f5e847b7-987e-4e6f-b627-2b633a676085" />
<img width="206" height="400" alt="m-servers" src="https://github.com/user-attachments/assets/a3a91864-238c-4a46-a261-dec97a8a6b34" />
<img width="206" height="400" alt="m-answer" src="https://github.com/user-attachments/assets/1d8dc09f-4f41-454f-8313-6db8f9acdec4" />


## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [TLS certificates](#tls-certificates)
- [Clients](#clients)
- [Portable install](#portable-install)
- [Administration](#administration)
- [Running the tests](#running-the-tests)
- [Project layout](#project-layout)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Known limitations and roadmap](#known-limitations-and-roadmap)
- [Further documentation](#further-documentation)

## Features

**Passport (portable identity)**
- Your account is anchored to a Passport: a key pair created in your browser. Export it as an
  encrypted `.mcpass` file to sign in with the file, recover a forgotten password, or register on
  another MeshCrowd server with the same identity. One account per Passport per server. Federation
  between servers is off by default.
- Strengthened sign-in: new web accounts derive a sign-in key and a separate seed-wrapping key from
  the password in the browser; the server never sees the password. Older accounts opt in under
  Settings -> Passport.

**End-to-end encrypted DMs**
- Any 1:1 DM between two users of the same server can be switched to end-to-end encryption with the
  lock button in the conversation header. It is one-way: to go back, delete the conversation and
  start a new one. The server stores only ciphertext; editing, forwarding, polls and attachments
  are disabled in encrypted conversations. Keys come from your Passport, and decrypted history is
  cached on the device (see the design spec for the limits).
- **Safety numbers**: an encrypted DM has a Verify shield that shows a 60-digit number both people
  can compare over a trusted channel. Each device pins the other person's key the first time it
  talks to them; if that key later changes, sending is blocked until you review and accept the new
  key. Pinning and verification are per device.

**Federation (mesh between instances, off by default)**
- Two MeshCrowd servers pair with an invite link. Each side explicitly accepts or rejects the other
  in **Admin -> Federation**, and revoking drops trust on both sides. A pending peer can do nothing
  except finish or cancel its own pairing.
- Paired servers share friend requests and DMs, list each other's public servers in discovery, and
  you can join a server on another instance with a `code@domain` invite. Remote servers appear in
  your server rail and open in a simplified view with text channels, history, posting, editing,
  deleting and reactions. They are proxied live from the owning instance (nothing is copied), so
  they grey out while it is offline. Attachments, threads, voice and member lists are not available
  for remote servers yet.
- All calls between instances are signed, rate-limited and go through a connection that refuses
  redirects and pins the validated address, so a paired peer cannot point this server at your
  internal network.

**Servers & channels**
- Join by invite code, by a direct invite from someone's profile card, or from a discoverable
  public-server directory.
- Eight channel types: public and private text, announcement, read-only, voice, stage, forum, and
  **Notes**.
- **Notes** channels give every member a private notebook inside the server, with text and up to 5
  attachments per note. Everything is encrypted in the browser with a key derived from your
  Passport, so the database and the admins cannot read it; admins can only delete notes older than
  a date. Losing your Passport means losing your notes. Notes cannot be searched, forwarded or
  converted to another channel type.
- Categories with drag-and-drop reordering of both channels and categories.
- Per-role and per-user channel permission overrides; channel-scoped invites.
- Slowmode, channel icons and topics, welcome screen, personal server-rail folders.

**Roles & permissions**
- Fully editable role bitflags per server, plus a separate site-wide staff-rank
  system for the admin panel. Nothing is hardcoded.
- Per-member name color override that beats the member's role color.
- Server-enforced rule: nobody can grant a permission they don't hold themselves.

**Messaging**
- Edit, delete, reply, forward, react, pin, polls, custom emoji and stickers, link previews.
- Up to 5 attachments per message. Non-ASCII file names are preserved. Still images can be resized
  before upload (Original / 1920 / 1280 / 800 px), and animated GIFs get a play/pause button.
- `@mention` and `#channel` autocomplete, slash commands (`/help` lists them).
- Threads off any message, plus forum channels made entirely of threaded posts. A **Threads panel**
  lists every thread in a channel. A thread's creator or a channel manager can give it an icon or
  delete it.
- **Search** docked in the right-hand panel, with checkboxes for which fields to match: message
  text (SQLite FTS5), usernames, channel names, and attachment file names.
- Incoming webhooks for scripts and CI.

**Voice, video & screen sharing**
- Peer-to-peer WebRTC voice and stage channels, plus private DM and group calls.
- Camera and screen share as separate tiles, with a **fullscreen** button on any video tile.
- Per-participant volume, input-device picker, a speaking ring and a **live volume strip** on
  every tile.
- **Moderator "Mute for Everyone"** (needs `MODERATE_MEMBERS`): the target cannot unmute
  themselves until a moderator lifts it.
- Server soundboard.

**Social**
- Friends (request, accept, block), 1:1 DMs and group DMs of up to 10 people.
- Presence (online / idle / do not disturb / invisible), custom status, per-status notification
  sound rules.
- Group DM creators can delete the whole conversation or prune its history. A DM is deleted
  automatically once its last member leaves.

**Moderation & administration**
- Kick, ban, timeout, audit log, user reports queue.
- Site admin panel: stats, user management, staff ranks, instance-wide server management.
- Runtime-adjustable **attachment size limit** and an optional **file-extension allowlist**.
- **Data pruning**: delete message history older than a chosen date, per server (by server
  moderators) or instance-wide (by site admins). Attachments can be kept or deleted too. Runs
  immediately or after a 24-hour notice period, and always posts a notice in the affected
  conversation.

**Personalization & layout**
- Per-user color and font themes with shareable presets, plus an optional background gradient
  (start color, end color, angle) across the sidebar, chat and member list.
- Drag-to-resize channel sidebar and member-list panel (saved per account).
- Avatar, banner, profile card, bio.

**Clients**
- Browser client with nothing to install.
- Optional Electron desktop app: tray badge with **customizable colors** and a translated tray
  menu, native notifications, certificate pinning, system screen picker.
- Android app: a thin WebView shell around the phone UI the server itself serves (`/m/`), with local
  background notifications (no Google Play Services needed). Android browsers get the same UI.

**Security**
- HTTPS by default: a self-signed certificate is generated automatically, or you can
  **use your own certificate and key files**.
- TOTP two-factor authentication with recovery codes, bcrypt password hashing, revocable
  server-side sessions, sandboxed uploads, rate limiting.

For the full description of every feature, see [docs/FEATURES.md](docs/FEATURES.md).

## Requirements

- **Node.js 22.5 or newer** (the server uses the built-in `node:sqlite` module). A suitable
  `node.exe` is already bundled under `runtime/`, and the start scripts prefer it, so on Windows
  you don't need to install Node at all.
- A modern Chromium-, Firefox- or Safari-based browser for the web client.
- Optional: internet access once, to run `npm install` for the Electron desktop client.

## Quick start

For the most part: Go to the releases, download all portable stuff and extract and play,
but if you want to mess around:

```
npm install
npm start
```

Or double-click `start-server.bat` (Windows) / run `start-server.sh` (Linux/macOS). Both use the
bundled runtime when it's present.

On first boot the server creates:

| Path | What it is |
|---|---|
| `data/dismesh.db` | The SQLite database (all users, servers, messages) |
| `data/config.json` | Server configuration, filled with defaults (see [Configuration](#configuration)) |
| `data/certs/` | The auto-generated self-signed TLS certificate (unless you configure your own) |
| `data/attachments/`, `data/avatars/`, … | Uploaded files |

Open `https://localhost:8443`, accept the self-signed certificate warning once, and register.
**The first account created becomes the Owner**, with full site-admin permissions.

Other npm scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Starts the server with `node --watch` (auto-restart on file changes) |
| `npm run electron` | Launches the Electron desktop client |
| `npm run build:portable` | Builds the portable bundle (see [Portable install](#portable-install)) |
| `npm test` | Runs the server test suite |

## Configuration

`data/config.json` is created on first run and rewritten on every start, so any key missing
from it gets its default. Restart the server after editing it.

| Key | Default | Meaning |
|---|---|---|
| `port` | `8080` | Plain-HTTP port. With HTTPS on, it only redirects to HTTPS; with `useHttps: false`, it serves the app. |
| `httpsPort` | `8443` | Main HTTPS port. |
| `publicHost` | `"localhost"` | Hostname/IP the **self-signed** certificate is issued for. Set it to your real LAN IP or domain *before* the first boot. Ignored when you use your own certificate. |
| `useHttps` | `true` | Set `false` to run plain HTTP (LAN/dev only; voice/video and notifications need HTTPS in most browsers unless you use `localhost`). |
| `serverCrt` | `""` | Path to your own PEM certificate. Empty = use the self-signed one. See [TLS certificates](#tls-certificates). |
| `serverKey` | `""` | Path to the matching PEM private key. Empty = use the self-signed one. |
| `maxUploadMb` | `25` | Hard upper limit on attachment size. The admin panel can lower this at runtime, but never raise it above this value. |
| `federation` | `{"enabled": false}` | Mesh federation between instances. Off by default: a stand-alone server opens no federation route or worker. Passport sign-in works regardless. |
| `passportOrigins` | `[]` | Extra origins (e.g. `"https://chat.example.com"`) a Passport proof may be signed for. See [Passport origins](#passport-origins). |
| `trustProxy` | `false` | Express `trust proxy` value (`true`, a hop count or a subnet string). Set it behind a reverse proxy so the request scheme/IP are the real ones. Use a hop count or subnet; `true` on a directly exposed server lets clients spoof `X-Forwarded-For` (defeats rate limits and audit IPs). |
| `pushAllowPrivateEndpoints` | `false` | Let the server send UnifiedPush wake-ups to addresses on private networks (a ntfy on your LAN). Off by default because users supply those addresses. |
| `iceServers` | `[]` | External STUN/TURN servers for WebRTC, e.g. `[{"urls":"stun:stun.l.google.com:19302"}]`. Empty = calls only connect peers who can reach each other directly (same LAN). Entries with a `username`/`credential` are only given to signed-in users. Editable in Admin Panel > Calls. |
| `turn` | see below | The built-in STUN/TURN server. Off by default. See [Calls across routers and NAT](#calls-across-routers-and-nat). |

Example:

```json
{
  "port": 8080,
  "httpsPort": 8443,
  "publicHost": "chat.example.com",
  "useHttps": true,
  "serverCrt": ".\\cert\\chat.example.com.crt",
  "serverKey": ".\\cert\\chat.example.com.key",
  "maxUploadMb": 25,
  "iceServers": [{ "urls": "stun:stun.l.google.com:19302" }]
}
```

The older `federationEnabled` and `federationPublicUrl` keys, if present, are ignored; use `federation.enabled`.

### Calls across routers and NAT

Chat and call signaling always travel through the MeshCrowd server. Only the audio and video between participants (a direct WebRTC mesh) needs STUN/TURN, and only when two people cannot reach each other directly. On one LAN calls work with nothing configured. Across routers and NAT they need a STUN server (to learn the public address) and, behind strict or symmetric NAT, a TURN server (to relay the media).

MeshCrowd ships both in one built-in server (`server/lib/turn/`, no extra software). It is **off by default**, so a LAN-only install never opens a UDP port.

**Setup:** run `setup-turn.bat` (Windows, asks for administrator rights once) or `./setup-turn.sh` (Linux/macOS, use `sudo` to let it open ufw/firewalld). It asks for your public IP (it can detect it with one request to a public STUN server), writes `data/config.json`, opens the firewall, prints the router forwarding table and proves a relay can be allocated. `--status`, `--disable` and `--remove-firewall` are also available. The same settings, a live status and a **Test** button are in **Admin Panel > Calls** (site administrators); changes apply without a restart.

**Router:** when the server sits behind a router, forward **UDP and TCP 3478** and **UDP 49152-49999** to it. Nothing else changes: chat keeps using 8080/8443.

| `turn` key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Run the built-in STUN/TURN server. |
| `port` | `3478` | UDP and TCP port clients connect to. |
| `tcp` | `true` | Also accept TCP (helps behind strict firewalls); the relay itself is UDP. |
| `externalIp` | `""` | Public IPv4 of the machine. Empty = the first public address of a local interface. Set it behind NAT. |
| `advertisedHost` | `""` | Host name handed to clients. Empty = `externalIp`, then `publicHost`, then the address the browser used. |
| `listenAddress` | `"0.0.0.0"` | Interface to bind. |
| `relayPortMin` / `relayPortMax` | `49152` / `49999` | UDP ports used for relayed streams, one per stream. |
| `credentialTtlSeconds` | `86400` | Lifetime of the per-user credentials. |
| `allowPrivatePeers` | `false` | Allow relaying to private addresses. Off so the relay cannot reach into your LAN. |
| `maxAllocations` / `maxAllocationsPerUser` | `500` / `20` | Relay limits. |
| `maxKbps` | `0` | Bandwidth cap per relay in kbit/s, `0` = unlimited. |
| `secret` | generated | Signs the short-lived credentials. Rotate it in Admin > Calls. Never shared. |

Signed-in users get credentials from `GET /api/voice/ice`: a username that carries its own expiry plus an HMAC password, so a leaked credential dies on its own and nothing is stored. IPv6 relaying is not supported.

### Passport origins

A Passport proof is signed for the server origin, and the server only accepts an origin it
recognises (the Host header is client-controlled). Accepted origins are: loopback hosts
(`localhost`, `127.0.0.1`, `[::1]`) on any port; `http://<publicHost>[:port]` and
`https://<publicHost>[:httpsPort]` built from `publicHost`, `port` and `httpsPort` (the port is omitted
when it is 80 / 443); and every entry of `passportOrigins`. Anything else is refused with
"unrecognised server address". So a LAN or domain deployment must set `publicHost` to the name or
IP users type in the browser, or list the exact origin (scheme + host + port, no path) in
`passportOrigins`, e.g. a proxy's public name. Loopback hosts are trusted only for a loopback peer
whose request carries none of the proxy headers (`X-Forwarded-For`, `X-Forwarded-Host`,
`X-Forwarded-Proto`, `X-Real-IP`, `Forwarded`, `Via`), so a same-host reverse proxy cannot make remote
clients pass as loopback even with `trustProxy` unset. Behind a TLS-terminating reverse proxy also set
`"trustProxy": true` (or the hop count) and forward `Host` and `X-Forwarded-Proto`, otherwise the
server sees `http://` and the browser's `https://` proof will not match.

Site-wide settings that aren't in this file (session lifetime, the runtime upload limit, the
extension allowlist) live in the database and are changed from the in-app admin panel. See
[docs/FEATURES.md](docs/FEATURES.md#admin-panel).

## TLS certificates

### Option 1: self-signed (default)

Leave `serverCrt` and `serverKey` empty. On first boot the server generates a 10-year
self-signed certificate for `publicHost`, `localhost` and `127.0.0.1` under `data/certs/`, and
reuses it on every later start.

To move to a new host/IP, change `publicHost`, delete `data/certs/`, and restart. A new
certificate is generated. Clients that trusted the old one will show a "certificate changed"
warning once.

### Option 2: your own certificate

Set both `serverCrt` and `serverKey` to PEM files, for example a certificate from your company CA
or Let's Encrypt:

```json
"serverCrt": ".\\cert\\domain.crt",
"serverKey": ".\\cert\\domain.key"
```

- Paths can be absolute, or relative to the **project root** (the folder that contains `server/`
  and `data/`). Both `\` and `/` separators work on every OS. In JSON, write a backslash as
  `\\`, or just use `/`.
- A **full-chain** file (your certificate followed by intermediate certificates, like Let's
  Encrypt's `fullchain.pem`) is supported and recommended, so clients can build the whole chain.
- The key must match the certificate and be at least 2048-bit RSA (or an equivalent EC key).
- **Both** values must be set. Setting only one is an error.
- The files are read once at startup, so **restart the server after renewing** the certificate.

If something is wrong (missing file, invalid PEM, key doesn't match the certificate, key too
weak) the server logs a clear `[certs] ...` error and exits instead of starting without TLS.

### Checking the fingerprint

Every start logs the certificate's SHA-256 fingerprint:

```
[certs] SHA-256 fingerprint: 3B:BE:D4:94:...
```

It matches `openssl x509 -noout -fingerprint -sha256 -in <cert>` and the fingerprint the
Electron and Android clients show in their trust dialogs. Compare it out of band before trusting
a server you don't recognize.

## Clients

**Mobile UI.** Android browsers (and the upcoming Android app) are served a phone-first interface at `/m/`; use `/?ui=mobile` or `/?ui=desktop` to switch. See [docs/FEATURES.md](docs/FEATURES.md#mobile-ui-m). The phone UI covers every channel type (including forum, notes and Sites), server and user settings, the admin panel and federated servers; the settings screens reuse the desktop pages in a phone layout.

### Web (primary)

Open the server URL in any modern browser. Nothing to install, and every feature is available.

### Electron desktop app

```
npm install        (one-time, needs internet; downloads the Electron runtime)
npm run electron
```

Or `start-client.bat` / `start-client.sh`. On first launch it asks for a server address such as
`https://192.168.1.10:8443`. It loads the same web UI and adds:

- A tray icon with a live unread-count badge colored by your presence. Colors can be customized
  under **Settings → Desktop App → Tray Icon**.
- Native desktop notifications, close-to-tray, start with Windows.
- The operating system's screen/window picker for screen sharing.
- **Trust-on-first-use certificate pinning** for self-signed servers: the first time, you confirm
  the fingerprint; if it ever changes, you get a warning. A certificate from a publicly trusted
  CA is accepted normally, with no prompt.

### Android app

A thin app in `android/` (Kotlin, Android 8.0+, one universal APK, no native libraries) that wraps the
server's own phone UI (`/m/`). The whole interface is served by your server, so updating the server
updates every phone and no new APK is needed. Plain Android browsers get the same UI.

- **First launch**: enter the server address (`chat.example.com`, `192.168.1.44:8080`, or with
  `http(s)://`). https is tried first. A self-signed certificate is trusted once by its SHA-256
  fingerprint; a plain `http` address is allowed with a warning.
- **Soft keyboard and files**: tapping a field raises the keyboard (`adjustResize`), attachments use
  the system file picker, downloads (including decrypted encrypted-DM files) go to the Downloads
  folder with a notification.
- **Local notifications, no Firebase**: the app polls `GET /api/notifications/poll` itself. Normal mode
  uses WorkManager (battery friendly, every 15 minutes or more); **fast mode** (You, Android app)
  runs a foreground service with a permanent notification and polls every 1-1440 minutes. The
  interval is adjustable; the app restarts the check after a reboot. While the app is open,
  messages arrive instantly over the WebSocket. Encrypted DMs show a generic "New encrypted message".
  Tapping a notification opens that conversation.
- **Back button**: closes sheets and screens first, exits at the top level.
- Voice and video are not part of the phone UI yet.

Build (JDK 17 and the Android SDK with platform 35 / build-tools 35; set `sdk.dir` in
`android/local.properties`):

```
cd android
./gradlew collectApk
```

`collectApk` builds the release APK and copies it to
`AndroidReleases/MeshCrowd-<version>.apk`, the only place a finished APK is put. Release builds are
signed with `android/meshcrowd.jks` configured by `android/keystore.properties` (both git-ignored;
keep a backup, an update must use the same key). `./gradlew testDebugUnitTest` runs the unit tests.

## Portable install

Go to the releases and download everything, extract and start to use... 

OR: if you want to mess around:
```
npm run build:portable
```

This produces `dist/dismesh-portable/`: the bundled `node.exe`, all server and web code, the
vendored `node_modules`, and an empty `data/` skeleton (an existing database or config is never
copied). Copy the folder to any machine with the same OS/architecture, even one with no internet,
and run `start-server.bat` or `start-server.sh`. Then edit `data/config.json` if the port or host
needs to change.

## Administration

- **Admin panel**: shown only to accounts with a site staff rank. The Owner can create ranks and
  hand out specific permissions (user management, reports, server management, data pruning, …).
- **Federation** (Admin → Federation, only when `federation.enabled` is true): set the federation
  admin password (a signed-in site admin or someone on the server machine can do this the first
  time), create an invite link, redeem another server's link, and accept, reject or revoke peers.
- **Attachment settings** (Admin → Overview): lower the upload size limit at runtime, and
  optionally restrict uploads to an allowlist of extensions (e.g. `.png, .jpg, .pdf`).
  Executables, HTML and SVG are always blocked.
- **Data pruning**:
  - Server moderators with the `PRUNE_CONTENT` role permission can prune their own server's
    channels (and those channels' threads) from **Server Settings**.
  - Site admins with the `PRUNE_DATA` rank permission can prune any server's channels or any DM
    from the admin panel. Conversations are listed by size, and message content is never shown.
  - Group DM creators can prune their own group.
  - Every prune shows a preview (message count, attachment count and size) first. It can run
    now, or after a 24-hour notice period that gives members time to save anything they need.
- **Backups**: stop the server and copy the whole `data/` folder. It contains the database, the
  config, the certificate and every uploaded file.

## Sites (PHP intranet)

A **Site** is a server kind that serves a folder of PHP, HTML, CSS and JS pages inside the app instead
of chat channels. It appears in the server rail for every user (a public, auto-join server with no
channels, voice or notifications) and renders in a same-origin iframe.

- **Who**: users with the site-staff permission `MANAGE_ANY_SERVER` (or `SITE_ADMINISTRATOR`) create
  Sites from the **+** dialog (the **New Site** tab). The Site's owner and site staff can edit it;
  everyone else just views it.
- **Runtime**: run `npm run fetch:php` once on the build machine. It downloads the portable Windows
  PHP 8.4 (checksum-verified) and Microsoft's Visual C++ redistributable into `runtime/php/`, and
  `npm run build:portable` copies it along. If PHP exits with the missing-DLL code at start-up, the
  server runs the bundled `vc_redist.x64.exe` itself (Windows shows a UAC prompt unless the server
  is elevated). On other systems install PHP with the package manager or set `sites.phpPath`.
- **Config** (`data/config.json`): `sites.phpPath` (explicit PHP binary; empty means
  `runtime/php/php.exe`, then `php` on PATH) and `sites.maxWorkers` (parallel PHP processes per
  Site, default 4, 1-16; each active worker is roughly 20-30 MB).
- **Editor**: the **Edit** button opens a file tree plus a code view (CodeMirror, HTML/PHP/JS/CSS
  colouring, Ctrl+S) and a visual view (TinyMCE) where PHP blocks stay protected as chips and are
  restored byte-for-byte. A page the visual editor cannot round-trip falls back to the code view.
  Files: `php html htm css js json txt md svg png jpg jpeg gif webp ico`, 2 MB per file, 200 files,
  50 MB per Site.
- **Trust**: Site pages run as part of MeshCrowd. Anyone who can edit a Site can run code on the
  server and, through same-origin JavaScript, as the people viewing it. Only give edit rights to
  people you would give server access.
- **External origins**: a Site's settings list the extra `https://` origins its pages may load
  scripts, styles, images and frames from. Adding one shows a warning, because a script loaded from
  another origin runs with the page's privileges. No wildcards.
- **Links**: links that leave the Site (other origin, `target="_blank"`, `window.open`) open in the
  OS browser in the Electron client and in a new tab on the web.

## AI bots

A **bot** is an AI chat participant backed by Ollama or any OpenAI-compatible service. It answers
when you @mention it in a channel or thread, and in a private 1:1 DM when DM mode is on. Both modes
are optional per bot. Bots show a BOT badge and cannot log in.

- **Providers (site admin)**: Admin Panel > AI. A provider is a kind (Ollama or OpenAI-compatible),
  a base URL (localhost, LAN, VPN or VPS), an optional API key (stored encrypted, never shown
  again), an optional model allowlist (press **Test connection** to fetch the model list), a
  timeout and a parallel-request limit. Tick **Server admins may use this provider** to offer it to
  server admins.
- **Bots**: the site admin creates bots for any server in Admin Panel > AI. Server admins (the
  **Manage Bots** permission) create bots for their own server in Server Settings > Bots, choosing
  from the providers offered to them. A bot has a name, avatar, provider and model, a persona (the
  system prompt), mention on/off, DM on/off and how many recent messages it sees.
- **Hardware**: on a CPU-only host use small models (about 3-4B parameters), or point the provider
  at an Ollama running on a stronger machine.
- **Privacy**: everything a bot is asked is sent to its provider. Bots never read end-to-end
  encrypted DMs, group DMs or Notes channels, and only see channels their role can view. Their
  output cannot mention anyone and has no tools or actions.
- **Limits**: one request per provider at a time by default, at most 5 waiting, a 10 s cooldown per
  user and bot, replies capped at 4000 characters.
- **API and webhooks (n8n, scripts)**: the AI provider is optional, and any bot can additionally get an
  API token and an outgoing, HMAC-signed webhook. The webhook delivers mentions, replies and DMs (or
  every message the bot can see); the bot answers through `POST /api/bot/messages`. One bot can do
  both jobs. Details, payload and an n8n recipe: [docs/API.md](docs/API.md#bot-api-and-outgoing-webhooks).
- **Slash commands**: a bot with a webhook can publish slash commands (`/roll <sides> [note]`). Members pick
  them from the composer's `/` list; the bot gets a signed `command` event and answers as a normal message
  ("Mem used /roll") or as an **ephemeral** answer only the person who ran it sees (never stored). See
  [docs/API.md](docs/API.md#slash-commands-for-bots).

## Age-restricted channels, verification levels and role icons

- **Age-restricted channels**: tick "Age-restricted channel (18+)" on a text channel. Members confirm once
  per account that they are 18 or older (a plain click-through, nothing is verified or sent anywhere).
  Unconfirmed members cannot read or post there and the channel is left out of their search.
- **Verification level**: Server Settings > Overview holds back brand-new accounts and recent joiners from
  posting (account 5 minutes / member 10 minutes / account 7 days). The owner, bots and anyone with a role
  are exempt. Purely local rules.
- **Role icons**: a role can have an emoji or an uploaded image, shown next to the names of members whose
  highest icon role it is.

## Running the tests

```
npm test
```

Runs the server-side suite with `node --test` (no test framework dependency): permission math,
channel access, threads, search, TOTP, invites, categories and pins, read state, notifications,
data pruning, the voice registry and more. Each test uses its own temporary data folder. The web
client has no automated browser test suite; it is plain HTML/CSS/JS with no build step, and is
verified by using it in a real browser.

## Project layout

```
server/      Node.js backend: Express REST API, ws WebSocket, SQLite (node:sqlite)
  routes/    one file per API resource
  lib/       shared logic: permissions, search, certificates, pruning, uploads, ...
  socket/    realtime hub and voice-room registry
  test/      node:test suite
web/         browser client: plain HTML/CSS/JS ES modules, no build step, no CDN
electron/    optional desktop shell around the web client
android/     Android WebView shell (Kotlin) around the /m/ phone UI; APKs go to AndroidReleases/
scripts/     build-portable.js
runtime/     bundled Node runtime used by the start scripts
data/        created at runtime: database, config, certificates, uploads
docs/        FEATURES.md, API.md, ARCHITECTURE.md
```

## Security notes

- All traffic is TLS-encrypted (HTTPS/WSS), with either the auto-generated self-signed
  certificate or your own.
- Passwords are hashed with bcrypt (12 rounds). Optional TOTP 2FA with single-use recovery codes.
- Sessions are opaque server-side tokens in an httpOnly cookie, individually revocable. They are
  not JWTs. Disabling an account ends its sessions and live connections immediately.
- Uploads are extension-filtered and size-capped, and served as downloads under a sandboxed
  Content-Security-Policy, so an uploaded file can never run as script in the app's origin.
- Security headers and a Content-Security-Policy are set on every response, and sensitive
  endpoints are rate-limited.
- If a reverse proxy terminates TLS in front of MeshCrowd, set `"trustProxy"` in `data/config.json`
  to the hop count or proxy subnet of your deployment, or session cookies are issued without the
  `Secure` flag and Passport proofs, which are bound to the request origin, will not match (see
  [Passport origins](#passport-origins)). Do not set `true` on a directly exposed server: clients can
  then spoof `X-Forwarded-For`, which defeats the rate limits and the audit IPs.
- Passport: the server stores public keys and a seed backup wrapped with a key derived from your
  login password. For accounts with **strengthened (split) sign-in**, which is every account created
  in the web client, the browser derives two keys from the password: `authKey` is sent and stored
  as a bcrypt hash, `wrapKey` wraps the seed backup and never leaves the browser. The server no
  longer sees the password of such an account, so logs, a database copy or a curious operator
  cannot read the password or unwrap the seed without guessing the password offline. Residual
  risks: whoever serves the web client is trusted to serve honest JavaScript (a malicious operator
  can ship code that captures the password or seed); `authKey` is a password-equivalent on that
  server, so TLS is required; and a weak password can be guessed offline from `authKey`. Legacy
  accounts (created by the Android app) still send the plain password and keep the old wrapping until
  the user strengthens them in Settings -> Passport. **Android apps older than 3.0 cannot sign in to a
  strengthened account** (it shows "invalid credentials. If you strengthened your sign-in, use the web
  app or an updated app.") until it is updated. Failed Passport proofs lock that ID for 15 minutes
  after 5 failures (password login is unaffected).

- **Security Center** (Admin -> Security Center): a locally generated captcha on sign-in and sign-up (never, after failed attempts, or always; characters, dictionary words or a sum), automatic bans for request floods and repeated failures, manual IP and range bans, subscribable blocklists, an allowlist, bot traps and an event log. See [docs/FEATURES.md](docs/FEATURES.md#security-center-admin-panel).
- Notes channels and encrypted DMs are encrypted in the browser. A malicious operator who serves
  modified JavaScript could still capture keys, the same trust assumption as the Passport above.
  Safety numbers let two people detect a swapped DM key.
- Federation peers are trusted only for identity: permissions are always evaluated by the instance
  that owns the server. Peers must be approved before they can do anything, calls to peers refuse
  redirects and non-public addresses, and the first federation admin password cannot be claimed by
  an anonymous visitor.

Full detail: [docs/ARCHITECTURE.md#security-model](docs/ARCHITECTURE.md#security-model).

## Troubleshooting

| Symptom | What to check |
|---|---|
| Browser warns about the certificate | Expected with the self-signed certificate: accept it once. For no warning, configure a CA-issued certificate with `serverCrt`/`serverKey`. |
| Warning says the certificate doesn't match the address | `publicHost` didn't match the address you're using when the certificate was generated. Fix `publicHost`, delete `data/certs/`, restart. |
| Server exits with `[certs] ...` | Your `serverCrt`/`serverKey` is missing, invalid, doesn't match, or only one of them is set. The message names the file and the reason. |
| Voice/video connects on the LAN but not across networks | Run `setup-turn.bat`/`setup-turn.sh` or turn on **Admin Panel > Calls**, then forward UDP/TCP 3478 and UDP 49152-49999 on the router. Press **Test** there; join from a phone on mobile data to check from outside. |
| `Cannot find module 'node:sqlite'` | Your Node is older than 22.5. Use the bundled `runtime/node.exe` or the start scripts. |
| Port already in use | Change `port`/`httpsPort` in `data/config.json`. |

## Known limitations and roadmap

- Voice is a full peer-to-peer mesh with no media server, so large calls (roughly 8+ people with
  video) put a lot of load on each participant's upload bandwidth.
- Federation: remote servers support text channels only (no attachments, threads, voice or member
  list), federated DMs are not end-to-end encrypted, and federation is off unless
  `federation.enabled` is set.
- End-to-end encrypted DMs work reliably from one device at a time (two devices sending into the
  same conversation can collide and show "Unable to decrypt"), do not carry attachments, are
  local-only (1:1 between users of the same server), and a new or cleared device cannot read
  history it never saw.
- Notes attachments are encrypted per file but their encryption is not bound to the file id.
- Not yet implemented: SMTP email verification (2FA is TOTP-based instead).

## Further documentation

- **[docs/FEATURES.md](docs/FEATURES.md)**: how each feature works and where it lives in the code
- **[docs/API.md](docs/API.md)**: complete REST and WebSocket API reference
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**: data model, permission engine, realtime layer,
  voice mesh, security model
