---
title: TLS és fordított proxyk
desc: Az önaláírt tanúsítvány, saját tanúsítvány használata, ujjlenyomatok ellenőrzése és futtatás nginx vagy Caddy mögött.
group: Kezdd itt
order: 4
---

A MeshCrowd alapból HTTPS-t szolgáltat. A böngészők mikrofont, kamerát és értesítéseket csak biztonságos eredeten engednek, ezért a TLS a hanghoz és videóhoz számít.

## 1. lehetőség: az önaláírt tanúsítvány

Hagyd üresen a `serverCrt` és `serverKey` értékét. Az első indításkor a szerver tízéves tanúsítványt készít a `publicHost`, a `localhost` és a `127.0.0.1` névre a `data/certs/` alatt, és ezt használja tovább. A böngészők egyszer figyelmeztetnek, mert semmilyen hatóság nem kezeskedik érte.

Új hosztra vagy IP-re váltáshoz módosítsd a `publicHost` értékét, töröld a `data/certs/` mappát és indítsd újra. Az a kliens, amelyik a régi tanúsítványban megbízott, egyszer „a tanúsítvány megváltozott” figyelmeztetést mutat.

## 2. lehetőség: saját tanúsítvány

Állítsd mindkét értéket PEM-fájlokra, például Let's Encrypt vagy a céged CA-jának tanúsítványára:

```json
"serverCrt": "/etc/letsencrypt/live/chat.example.com/fullchain.pem",
"serverKey": "/etc/letsencrypt/live/chat.example.com/privkey.pem"
```

- Az elérési utak abszolútak, vagy a projekt gyökeréhez viszonyítottak.
- **Teljes láncot** tartalmazó fájl ajánlott, hogy a kliensek fel tudják építeni a teljes láncot.
- A kulcsnak illeszkednie kell a tanúsítványhoz, és legalább 2048 bites RSA-nak vagy egyenértékű EC-kulcsnak kell lennie.
- **Megújítás után indítsd újra**: a fájlokat a szerver csak induláskor olvassa be.

Ha bármi hibás (hiányzó fájl, érvénytelen PEM, eltérés, gyenge kulcs), a szerver egyértelmű `[certs]` hibát naplóz és kilép, ahelyett hogy TLS nélkül indulna.

## Az ujjlenyomat ellenőrzése

Minden indításkor kiírja a tanúsítvány SHA-256 ujjlenyomatát:

```
[certs] SHA-256 fingerprint: 3B:BE:D4:94:...
```

Megegyezik az `openssl x509 -noout -fingerprint -sha256 -in cert.pem` kimenetével, és azzal az ujjlenyomattal, amit az asztali és az Android-kliens mutat, amikor önaláírt szerverhez csatlakozol. Vesd össze más csatornán, mielőtt megbízol egy általad nem ismert szerverben.

## Fordított proxy mögött

Ha nginx, Caddy vagy másik proxy zárja le a TLS-t a MeshCrowd előtt:

1. Futtasd a MeshCrowdot `"useHttps": false` beállítással egy helyi porton, vagy tarts HTTPS-t a proxy és a szerver között.
2. Állítsd a `"trustProxy"` értékét a mögötted lévő proxyk számára (például `1`) vagy azok alhálózatára.
3. Továbbítsd a `Host` és `X-Forwarded-Proto` fejléceket, és engedélyezd a WebSocket-váltást a `/ws` útvonalon.
4. Állítsd a `publicHost` értékét a nyilvános névre, vagy vedd fel a pontos nyilvános eredetet a `passportOrigins` közé.

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

::: warn Miért számít az ugrásszám
`trustProxy` nélkül a szerver minden látogatót a proxyként lát, és a munkamenet-sütik `Secure` jelző nélkül készülnek. Közvetlenül elérhető szerveren a `trustProxy: true` lehetővé teszi, hogy a kliensek meghamisítsák a címüket, és kijátsszák a sebességkorlátokat és a naplókat. Használj ugrásszámot vagy alhálózatot.
:::

## Hívások hálózatok között

A hang és videó WebRTC-vel, közvetlenül az emberek között megy. Kapcsold be a beépített STUN/TURN szervert, vagy vegyél fel sajátot az `iceServers` közé (lásd: [STUN és TURN](configuration.html#stun-s-turn)). A proxy nem viszi a médiát.
