# MeshCrowd release notes (draft)

Draft for the first public release. Version number to be decided (package.json is at 0.9.0).

## Highlights

- **Self-hosted chat for communities**: servers, text, forum, notes, voice, stage and Sites (PHP intranet) channels, threads,
  polls, reactions, search, roles with per-channel overrides, onboarding, AutoMod and verification levels.
- **Private by design**: split-password sign-in so the server never sees your password, portable Passport identity,
  end-to-end encrypted DMs and notes, TOTP two-factor, and no third-party services.
- **Calls that work**: WebRTC voice, video and screen sharing with a built-in STUN/TURN server for NAT traversal.
- **Federation**: pair servers so people can add friends, exchange DMs and join public servers across instances.
  Off by default; peers are trusted for identity only.
- **Bots and AI**: Bot API, webhooks, slash commands, and AI bots with your own providers.
- **Every screen**: web, Electron desktop client, phone UI at `/m/` and an Android app, all served by one portable
  server (bundled Node and PHP, nothing to install).

## New: invite links

Every invite works as `https://host:port/i/<code>`: a join page with the server name and icon, **Join in browser** and
**Open in app** (`mcr://`, handled by the desktop client and Android app 3.9, always asking before joining). Download
and project links come from the new `downloads` block in `data/config.json`. Also fixed: live updates (and the red
"Connection lost" banner) when the server is reached by an address other than `publicHost`.

## New: Security Center

Admin Panel, Security Center (site administrators):

- A **captcha** generated on your own server for sign-in and sign-up: never, after failed attempts, or always;
  random characters, dictionary words (built-in English and Hungarian or your own list) or a simple sum; adjustable distortion.
- **Flood protection** with automatic temporary bans, and an **under attack mode** that forces a captcha everywhere.
- **IP bans** (addresses, ranges, CIDR, IPv4 and IPv6, timed or permanent), subscribable **blocklists**
  (Spamhaus DROP, Tor exits, FireHOL or your own URL), an **allowlist**, bot traps, a sign-up cap per address,
  an IP check tool and an event log.
- English and Hungarian translations.

## Upgrade notes

- The captcha defaults to "after 3 failed attempts". Set it to Never in the Captcha tab to keep the old behaviour.
- Behind a reverse proxy, set `trustProxy` in `config.json` so per-address limits see the real visitor address.
- Scripts that call `/api/auth/login` or `/api/auth/register` directly must send `captchaId` and `captchaAnswer`
  when `GET /api/auth/captcha/status?kind=login` returns `required: true`.

## Known limitations

See [CHECKLIST.md](../CHECKLIST.md#known-limitations).
