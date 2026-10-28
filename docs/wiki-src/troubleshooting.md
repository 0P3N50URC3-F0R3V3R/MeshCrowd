---
title: Troubleshooting and FAQ
desc: Common problems with certificates, ports, voice, sign-in and notifications, plus known limitations and frequently asked questions.
group: Operating a server
order: 3
---

## Quick fixes

| Symptom | What to check |
|---|---|
| Browser warns about the certificate | Expected with the self-signed certificate: accept it once. For no warning use a certificate from a real authority with `serverCrt` and `serverKey`. |
| The warning says the certificate does not match the address | `publicHost` did not match the address you use when the certificate was generated. Fix `publicHost`, delete `data/certs/` and restart. |
| The server exits with `[certs]` | Your `serverCrt` or `serverKey` is missing, invalid, mismatched, too weak, or only one of them is set. The message names the file and the reason. |
| `Cannot find module 'node:sqlite'` | Node.js is older than 22.5. Use the bundled runtime or the start scripts. |
| Port already in use | Change `port` or `httpsPort` in `data/config.json`. |
| Voice works on the LAN but not across networks | Run `setup-turn.bat` or `setup-turn.sh`, or turn on **Admin Panel, Calls**, then forward UDP and TCP 3478 and UDP 49152-49999 on the router. Press **Test** in Calls, and try a phone on mobile data. See [STUN and TURN](configuration.html#stun-and-turn). |
| A red "Connection lost. Reconnecting..." banner that never goes away | Live updates use a WebSocket. Older servers only accepted it when the page was opened through `publicHost`, `localhost` or `127.0.0.1`, so another address (a LAN IP, a second name, the Android emulator's `10.0.2.2`) was refused with HTTP 403. Update the server; on older ones set `publicHost` to the address people use. Behind a reverse proxy also forward `Host` and set `trustProxy`. |
| No microphone or camera prompt | The page is not on HTTPS or localhost. |
| "Unrecognised server address" when signing in with a Passport | Set `publicHost` to the address people type, or add the exact origin to `passportOrigins`. |
| Sign-in loops behind a reverse proxy | Set `trustProxy` to the hop count and forward `Host` and `X-Forwarded-Proto`. |
| Cookies not marked Secure behind a proxy | Same: `trustProxy` is not set. |
| The Android app says "invalid credentials" for a strengthened account | Update the app to 3.0 or newer, or use the web client. |
| No notifications on Android | Check the battery settings for the app, the notification mode in **You, Android app**, and that the server is reachable over HTTPS. |
| UnifiedPush does nothing with a ntfy on the LAN | Set `pushAllowPrivateEndpoints` to `true` on the server. |
| Lines like `TLS client error` or `SSL alert bad certificate` in the log | Older versions logged every failed TLS handshake. These come from scanners and bots probing the port and are harmless; newer versions stay silent. Set the environment variable `MESHCROWD_TLS_DEBUG=1` to log one line per failed handshake with the client address. If a real user is affected, check that the certificate covers the hostname they use and that `serverCrt` contains the full chain. |
| "Unable to decrypt" in an encrypted DM | Two devices wrote into the same conversation, or this device never saw that history. Use one device at a time. |
| A Site shows a PHP error about a missing DLL | Run `npm run fetch:php` and use the bundled server, or install the Visual C++ redistributable. |

## FAQ

**Is it really free?**
Yes. It is free software under the GNU General Public License and has no paid tiers.

**Do I need a domain name?**
Not for a LAN. For people outside your network you want one, plus a real certificate.

**How many people can it host?**
It depends on your hardware. Text chat is light. Voice is peer to peer, so the limit for calls is each person's upload bandwidth, not the server. Roughly eight or more people with video in one room strains most home connections.

**Can I import from another chat service?**
Not at the moment.

**Can I run it with Docker?**
There is no official image yet. It is a single Node.js process, so wrapping it is straightforward.

**Is there email verification or password reset by email?**
No. Recovery uses your Passport file, and two-factor uses TOTP.

**Does it phone home?**
No. There is no telemetry, no analytics and the web client loads nothing from a CDN. Outgoing connections happen only when you configure them: AI providers, webhooks, federation, UnifiedPush and the link previews the server fetches for links people post.

**How do I move to another machine?**
Copy the `data/` folder. See [Administration](administration.html).

## Known limitations

- Calls are a full peer-to-peer mesh with no media server, so large calls with video are heavy for each participant.
- Federation supports text channels only on remote servers; federated DMs are not end-to-end encrypted.
- End-to-end encrypted DMs work reliably from one device at a time, carry no attachments and are local to one server.
- Notes attachments are encrypted per file, but their encryption is not bound to the file id.
- Bot slash commands work in server channels only.
- Email verification is not implemented.
