---
title: TLS and reverse proxies
desc: The self-signed certificate, bringing your own, checking fingerprints and running behind nginx or Caddy.
group: Start here
order: 4
---

MeshCrowd serves HTTPS by default. Browsers only allow microphones, cameras and notifications on secure origins, so TLS matters for voice and video.

## Option 1: the self-signed certificate

Leave `serverCrt` and `serverKey` empty. On the first start the server creates a ten-year certificate for `publicHost`, `localhost` and `127.0.0.1` under `data/certs/` and reuses it afterwards. Browsers warn once because no authority vouches for it.

To move to a new host or IP, change `publicHost`, delete `data/certs/` and restart. Clients that trusted the old certificate show a "certificate changed" warning once.

## Option 2: your own certificate

Set both values to PEM files, for example from Let's Encrypt or your company CA:

```json
"serverCrt": "/etc/letsencrypt/live/chat.example.com/fullchain.pem",
"serverKey": "/etc/letsencrypt/live/chat.example.com/privkey.pem"
```

- Paths are absolute, or relative to the project root.
- A **full chain** file is recommended so clients can build the whole chain.
- The key must match the certificate and be at least 2048-bit RSA or an equivalent EC key.
- **Restart after renewing**: the files are read once at start.

If anything is wrong (missing file, invalid PEM, mismatch, weak key) the server logs a clear `[certs]` error and exits instead of starting without TLS.

## Checking the fingerprint

Every start prints the certificate's SHA-256 fingerprint:

```
[certs] SHA-256 fingerprint: 3B:BE:D4:94:...
```

It matches `openssl x509 -noout -fingerprint -sha256 -in cert.pem` and the fingerprint the desktop and Android clients show when you connect to a self-signed server. Compare it out of band before you trust a server you do not recognize.

## Behind a reverse proxy

If nginx, Caddy or another proxy terminates TLS in front of MeshCrowd:

1. Run MeshCrowd with `"useHttps": false` on a local port, or keep HTTPS between the proxy and the server.
2. Set `"trustProxy"` to the number of proxies in front (for example `1`) or to their subnet.
3. Forward `Host` and `X-Forwarded-Proto`, and allow WebSocket upgrades on `/ws`.
4. Set `publicHost` to the public name, or add the exact public origin to `passportOrigins`.

```
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

::: warn Why the hop count matters
Without `trustProxy` the server sees every visitor as the proxy, and session cookies are issued without the `Secure` flag. With `trustProxy: true` on a directly exposed server, clients can fake their address and defeat rate limits and audit logs. Use a hop count or subnet.
:::

## Calls across networks

Voice and video use WebRTC directly between people. Turn on the built-in STUN/TURN server or add your own to `iceServers` (see [STUN and TURN](configuration.html#stun-and-turn)). The proxy does not carry media.
