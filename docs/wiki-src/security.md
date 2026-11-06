---
title: Security and privacy
desc: How MeshCrowd protects accounts and data, how DMs and Notes are protected and where the honest limits are.
group: Operating a server
order: 2
---

## What is protected, and how

- **Transport**: HTTPS and WSS everywhere, with a generated certificate or your own.
- **Passwords**: bcrypt with 12 rounds. For strengthened accounts the server only ever sees a derived key, not the password.
- **Sessions**: opaque server-side tokens in an httpOnly cookie, individually revocable, not JWTs.
- **Two-factor**: TOTP with single-use recovery codes.
- **Uploads**: extension filtered, size capped and served as downloads under a sandboxing Content-Security-Policy.
- **Headers and limits**: security headers and a Content-Security-Policy on every response, and rate limiting on sensitive endpoints.
- **No third parties**: the web client loads nothing from a CDN, and there is no analytics.

## Security Center

Admin Panel, **Security Center** (site administrators only) holds the tools against bots and floods. It all runs on your server; nothing is sent to a third-party captcha or reputation service.

- **Captcha**: a distorted picture on sign-in and sign-up. Each has its own mode: never, after a number of failed attempts, or always. Sign-in defaults to after failed attempts and sign-up to always, so new accounts always need a captcha unless you change it. Failed sign-in and sign-up attempts are counted separately. Pick random characters, dictionary words (built-in English and Hungarian, or your own list typed into the editor) or a simple sum, and tune the distortion. A captcha works once, so a wrong guess needs a new picture.
- **Flood protection**: an address that sends too many requests, keeps hitting the rate limits or keeps failing to sign in is banned for a while. A burst of such bans turns on **under attack mode**, which requires a captcha for every sign-in and sign-up.
- **IP bans**: addresses, ranges (`1.2.3.4-1.2.3.9`) and networks (`10.0.0.0/8`), IPv4 and IPv6, permanent or timed. You cannot ban your own address.
- **Blocklists**: subscribe to public lists of known bad addresses (Spamhaus DROP, Tor exit nodes, FireHOL) or your own URL. Updates run on a schedule and a failed update keeps the old copy. Lists never apply to private, loopback, link-local or carrier-grade NAT addresses (`10.0.0.0/8`, `192.168.0.0/16`, `127.0.0.0/8`, `100.64.0.0/10` and so on), because some lists such as FireHOL level 1 contain them and would lock out everyone on your LAN, VPN or reverse proxy. Manual bans still apply to them.
- **Allowlist**: addresses that are never banned or limited. This machine itself is on it by default.
- **Bot traps** (a hidden field and a speed check on the forms), a **sign-up cap per address**, an **IP check** tool and an **event log**.

If MeshCrowd runs behind a reverse proxy, set `trustProxy` in `config.json`; otherwise every visitor looks like the proxy and the per-address limits cannot tell people apart.

## Encrypted DMs at rest

DM message text, link-preview cards, scheduled DMs and queued Android notifications for DMs are stored encrypted (AES-256-GCM) in the server database. This protects the database file, its backups and its write-ahead log. It is **not** end-to-end: the server holds the key, so search, bots and moderation reports keep working, and anyone with both the running server and the key can read DMs.

The key is `DISMESH_DM_KEY` (base64, 32 bytes) in the environment, or a random key the server creates at `data/dm-at-rest.key`. Back it up together with the database; without it, stored DMs cannot be read. DM search decrypts and scans the newest 5000 messages of a conversation.

Not covered: attachment file names and files, poll options, and messages relayed to federated servers.

Earlier versions had per-conversation end-to-end encryption. It was removed and the encrypted history deleted.

## Notes channels

Notes are encrypted in the browser with a key derived from your Passport, so neither the database nor the admins can read them. Losing your Passport means losing your notes.

## What the operator can see

The server operator can read ordinary channel messages and uploads, because the server stores them. Notes are the exception: they are encrypted in your browser. DM text is stored encrypted, but the server holds that key, so the operator can still read DMs. Bots send what they are asked to their AI provider, so choose providers you trust.

## The trust assumption in the web client

Whoever serves the web client is trusted to serve honest JavaScript. A malicious operator could ship code that captures a password or a key. This is true of every web-based end-to-end design. Host your own server, or use a server run by people you trust, and compare certificate fingerprints.

## Passport and strengthened sign-in

For web accounts the browser derives two keys from your password: `authKey` is sent and stored as a bcrypt hash, and `wrapKey` wraps your Passport seed and never leaves the browser. Residual risks: `authKey` acts like a password on that server so TLS is required, and a weak password can be guessed offline from `authKey`. Failed Passport proofs lock that identity for 15 minutes after five failures. The phone interface asks for your password again before it opens the Admin Panel or Server Settings; that check is rate limited and locks out after repeated wrong answers.

## Federation

Peers are trusted only for identity, permissions are always decided by the owning instance, peers must be approved first, and calls to peers refuse redirects and non-public addresses. See [Federation](federation.html).

## Reporting a vulnerability

Please report security problems privately to the project maintainers rather than in a public issue, and give them a reasonable time to fix them before you publish.

## Hardening checklist

- Use a certificate from a real authority and keep it renewed.
- Behind a proxy set `trustProxy` to a hop count, never `true` on an exposed server.
- Keep Node.js and the server up to date.
- Restrict who can create Sites and bots, since both can run code or send data outward.
- Give moderators only the permissions they need and review the audit log.
- Back up `data/` and test restoring it.
