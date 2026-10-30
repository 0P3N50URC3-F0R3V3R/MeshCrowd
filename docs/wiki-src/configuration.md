---
title: Configuration
desc: Every key in data/config.json explained, with an example.
group: Start here
order: 3
---

`data/config.json` is created on the first start and rewritten on every start, so any key that is missing gets its default. **Restart the server after editing it.** Settings that change often (session lifetime, upload limits, allowed file types) live in the database and are changed from the admin panel.

## Keys

| Key | Default | Meaning |
|---|---|---|
| `port` | `8080` | Plain HTTP port. With HTTPS on it only redirects; with `useHttps: false` it serves the app. |
| `httpsPort` | `8443` | Main HTTPS port. |
| `registrationMode` | `"open"` | Who may create an account: `open` (anyone), `invite` (a valid server or channel invite link or code is required) or `closed` (nobody). The first account on an empty instance is always allowed. Changeable in the Admin Panel, Overview, without a restart. |
| `publicHost` | `"localhost"` | The name or IP the **self-signed** certificate is issued for. Set it to the address people type, before the first start. |
| `useHttps` | `true` | Set `false` for plain HTTP on a trusted LAN or for development. Voice, video and notifications need HTTPS in most browsers except on `localhost`. |
| `serverCrt` | `""` | Path to your own PEM certificate. Empty means use the self-signed one. |
| `serverKey` | `""` | Path to the matching private key. Both must be set together. |
| `maxUploadMb` | `25` | Upper limit on attachment size. The admin panel can lower it at runtime but never raise it above this value. |
| `federation` | `{"enabled": false}` | Federation between servers. Off by default. See [Federation](federation.html). |
| `downloads` | `{"server": "https://#", "clientDesktop": "https://#", "clientAndroid": "https://#", "website": "https://#"}` | Links shown in the web interface (download window) and on invite pages. The login screen shows `website`. `server` is only recorded. Only `https://` addresses are used. Replace the `https://#` placeholders and restart the server. |
| `passportOrigins` | `[]` | Extra origins a Passport proof may be signed for. See below. |
| `trustProxy` | `false` | Express `trust proxy` value. Set it behind a reverse proxy. |
| `pushAllowPrivateEndpoints` | `false` | Let the server send UnifiedPush wake-ups to private network addresses, such as a ntfy on your LAN. |
| `iceServers` | `[]` | External STUN and TURN servers for WebRTC calls across networks. |
| `turn` | see below | The built-in STUN/TURN server, off by default. See [STUN and TURN](#stun-and-turn). |
| `sites` | `{"phpPath": "", "maxWorkers": 4}` | PHP runtime and worker count for [Sites](sites.html). |

## Example

```json
{
  "port": 8080,
  "httpsPort": 8443,
  "publicHost": "chat.example.com",
  "useHttps": true,
  "serverCrt": "/etc/letsencrypt/live/chat.example.com/fullchain.pem",
  "serverKey": "/etc/letsencrypt/live/chat.example.com/privkey.pem",
  "maxUploadMb": 25,
  "iceServers": [{ "urls": "stun:stun.l.google.com:19302" }]
}
```

In JSON a backslash must be written as `\\`, or simply use forward slashes, which work on every operating system.

## Passport origins

A Passport proof is signed for the server's origin, and the server only accepts an origin it recognizes. Accepted origins are:

- loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) on any port;
- `http://<publicHost>` and `https://<publicHost>` built from `publicHost`, `port` and `httpsPort`;
- every entry of `passportOrigins`.

So a LAN or domain setup must set `publicHost` to the address users type, or list the exact origin (scheme, host and port, no path) in `passportOrigins`.

## STUN and TURN

Chat and call signaling always go through your MeshCrowd server. Only the audio and video between people needs STUN or TURN, and only when two of them cannot reach each other directly. On one network calls just work. Across routers and NAT a **STUN** server tells each browser its public address, and behind strict NAT a **TURN** relay carries the media.

MeshCrowd has both built in, with nothing to install. It is **off by default**, so a LAN-only server never opens an extra port.

### Quick setup

1. Run **`setup-turn.bat`** (Windows, it asks for administrator rights once) or **`./setup-turn.sh`** (Linux and macOS; use `sudo` so it can open ufw or firewalld).
2. Answer the questions. It can detect your public IP with a single request to a public STUN server, and only if you agree. It saves the settings, opens the firewall on this machine, shows the router forwarding table and proves a relay can be allocated.
3. On your router forward **UDP and TCP 3478** and **UDP 49152-49999** to this machine.
4. Restart MeshCrowd. To check from outside, join a call from a phone on mobile data.

The same settings live in **Admin Panel, Calls** (site administrators): enable or disable the server, the external IP with a **Detect** button, ports, a live status, and a **Test** button. Changes apply without a restart. `setup-turn --status`, `--disable` and `--remove-firewall` are also available.

### Settings

The `turn` section of `data/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Run the built-in server. |
| `port` | `3478` | UDP and TCP port clients connect to. |
| `tcp` | `true` | Also accept TCP, which helps behind strict firewalls. The relay itself is UDP. |
| `externalIp` | `""` | The machine's public IPv4 address. Set it when the server is behind a router. |
| `advertisedHost` | `""` | Host name given to clients. Empty uses `externalIp`, then `publicHost`. |
| `relayPortMin`, `relayPortMax` | `49152`, `49999` | UDP ports used for relayed streams. |
| `credentialTtlSeconds` | `86400` | Lifetime of the per-user credentials. |
| `allowPrivatePeers` | `false` | Allow relaying to private addresses. Off so the relay cannot reach into your LAN. |
| `maxAllocations`, `maxAllocationsPerUser` | `500`, `20` | Limits. |
| `maxKbps` | `0` | Bandwidth cap per relay, `0` for none. |

Signed-in users receive short-lived credentials that expire by themselves, so nothing is stored and a leaked one soon stops working. IPv6 relaying is not supported.

### External servers

You can also use servers you run or rent elsewhere, in **Admin Panel, Calls** or in `iceServers`:

```json
"iceServers": [
  { "urls": "stun:stun.example.org:3478" },
  { "urls": "turn:turn.example.org:3478", "username": "user", "credential": "secret" }
]
```

Entries with a user name and password are only given to signed-in users.

::: warn Reverse proxies
Behind a proxy that terminates TLS set `trustProxy` to the **hop count or subnet**, not `true`. `true` on a directly exposed server lets clients spoof `X-Forwarded-For`. See [TLS and reverse proxies](tls.html).
:::
