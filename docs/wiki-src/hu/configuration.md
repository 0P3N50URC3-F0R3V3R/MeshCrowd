---
title: Konfiguráció
desc: A data/config.json minden kulcsa elmagyarázva, példával.
group: Kezdd itt
order: 3
---

A `data/config.json` az első indításkor jön létre, és minden indításkor újraíródik, így minden hiányzó kulcs megkapja az alapértékét. **A szerkesztés után indítsd újra a szervert.** Az olykor változó beállítások (munkamenet-élettartam, feltöltési korlátok, engedélyezett fájltípusok) az adatbázisban élnek, és az adminpanelről módosíthatók.

## Kulcsok

| Kulcs | Alapérték | Jelentés |
|---|---|---|
| `port` | `8080` | Sima HTTP port. HTTPS mellett csak átirányít; `useHttps: false` esetén ez szolgálja ki az alkalmazást. |
| `httpsPort` | `8443` | A fő HTTPS port. |
| `registrationMode` | `"open"` | Ki hozhat létre fiókot: `open` (bárki), `invite` (érvényes szerver- vagy csatornameghívó link vagy kód kell) vagy `closed` (senki). Az üres példány első fiókja mindig engedélyezett. Az Admin panel Áttekintés oldalán újraindítás nélkül módosítható. |
| `publicHost` | `"localhost"` | A név vagy IP, amelyre az **önaláírt** tanúsítvány kiállításra kerül. Állítsd arra a címre, amit az emberek begépelnek, az első indítás előtt. |
| `useHttps` | `true` | Állítsd `false`-ra a sima HTTP-hez megbízható LAN-on vagy fejlesztéshez. A hanghoz, videóhoz és értesítésekhez a legtöbb böngészőben HTTPS kell, `localhost` kivételével. |
| `serverCrt` | `""` | A saját PEM tanúsítványod elérési útja. Üresen az önaláírtat használja. |
| `serverKey` | `""` | A hozzá tartozó privát kulcs elérési útja. Mindkettőt együtt kell megadni. |
| `maxUploadMb` | `25` | A mellékletek méretének felső korlátja. Az adminpanel futás közben csökkentheti, de ennél az értéknél sosem növelheti. |
| `federation` | `{"enabled": false}` | Föderáció szerverek között. Alapból kikapcsolt. Lásd: [Föderáció](federation.html). |
| `downloads` | `{"server": "https://#", "clientDesktop": "https://#", "clientAndroid": "https://#", "website": "https://#"}` | A webes felületen (letöltés ablak) és a meghívóoldalakon megjelenő linkek. A bejelentkezőképernyő a `website` linket mutatja. A `server` csak rögzítve van. Csak `https://` címek számítanak. Cseréld le a `https://#` helyőrzőket, és indítsd újra a szervert. |
| `passportOrigins` | `[]` | További eredetek, amelyekre egy Útlevél-igazolás aláírható. Lásd alább. |
| `trustProxy` | `false` | Az Express `trust proxy` értéke. Fordított proxy mögött állítsd be. |
| `pushAllowPrivateEndpoints` | `false` | Engedi, hogy a szerver UnifiedPush ébresztéseket küldjön magánhálózati címekre, például egy LAN-on futó ntfy-nak. |
| `iceServers` | `[]` | Külső STUN- és TURN-szerverek a hálózatok közötti WebRTC-hívásokhoz. |
| `turn` | lásd lent | A beépített STUN/TURN szerver, alapból kikapcsolva. Lásd: [STUN és TURN](#stun-s-turn). |
| `sites` | `{"phpPath": "", "maxWorkers": 4}` | PHP futtatókörnyezet és munkafolyamat-szám az [Oldalakhoz](sites.html). |

## Példa

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

JSON-ban a fordított perjelet `\\` alakban kell írni, vagy egyszerűen használj normál perjelet, ami minden operációs rendszeren működik.

## Útlevél-eredetek

Az Útlevél-igazolást a szerver eredetére írják alá, és a szerver csak olyan eredetet fogad el, amelyet felismer. Az elfogadott eredetek:

- a visszacsatolási hosztok (`localhost`, `127.0.0.1`, `[::1]`) bármely porton;
- a `publicHost`, `port` és `httpsPort` értékéből képzett `http://<publicHost>` és `https://<publicHost>`;
- a `passportOrigins` minden eleme.

Egy LAN-os vagy domainnel működő beállításban tehát a `publicHost` értékét arra a címre kell állítani, amit a felhasználók begépelnek, vagy a pontos eredetet (séma, hoszt és port, útvonal nélkül) fel kell venni a `passportOrigins` közé.

## STUN és TURN

A csevegés és a hívások jelzései mindig a MeshCrowd szerveren mennek át. Csak az emberek közötti hang és videó igényel STUN-t vagy TURN-t, és csak akkor, ha ketten nem érik el közvetlenül egymást. Egy hálózaton a hívás magától működik. Routereken és NAT-on át a **STUN**-szerver megmondja a böngészőnek a nyilvános címét, szigorú NAT mögött pedig egy **TURN**-átjátszó viszi a médiát.

A MeshCrowdban mindkettő be van építve, nem kell semmit telepíteni. Alapból **ki van kapcsolva**, így egy csak LAN-os szerver sosem nyit meg plusz portot.

### Gyors beállítás

1. Futtasd a **`setup-turn.bat`**-ot (Windows, egyszer rendszergazdai jogot kér) vagy a **`./setup-turn.sh`**-t (Linux és macOS; használj `sudo`-t, hogy megnyithassa az ufw-t vagy a firewalld-t).
2. Válaszolj a kérdésekre. A nyilvános IP-címedet egyetlen kéréssel képes felismerni egy nyilvános STUN-szervertől, de csak ha beleegyezel. Elmenti a beállításokat, megnyitja a tűzfalat ezen a gépen, kiírja a routerhez szükséges átirányítási táblát, és bizonyítja, hogy tud továbbítót foglalni.
3. A routeren irányítsd át ide a **3478 UDP és TCP**, valamint a **49152-49999 UDP** portokat.
4. Indítsd újra a MeshCrowdot. Kívülről úgy próbálhatod ki, hogy mobiladatról csatlakozol egy híváshoz.

Ugyanezek a beállítások az **Adminpanel, Hívások** oldalon is megvannak (webhelyadminisztrátoroknak): a szerver ki- és bekapcsolása, a külső IP-cím **Felismerés** gombbal, portok, élő állapot és egy **Próba** gomb. A változtatások újraindítás nélkül életbe lépnek. Elérhető a `setup-turn --status`, a `--disable` és a `--remove-firewall` is.

### Beállítások

A `data/config.json` `turn` szakasza:

| Kulcs | Alapérték | Jelentés |
|---|---|---|
| `enabled` | `false` | A beépített szerver futtatása. |
| `port` | `3478` | UDP- és TCP-port, ahová az ügyfelek csatlakoznak. |
| `tcp` | `true` | TCP fogadása is, ami szigorú tűzfal mögött segít. Maga a továbbító UDP. |
| `externalIp` | `""` | A gép nyilvános IPv4-címe. Állítsd be, ha a szerver router mögött van. |
| `advertisedHost` | `""` | Az ügyfeleknek megadott gépnév. Üresen az `externalIp`-t, majd a `publicHost`-ot használja. |
| `relayPortMin`, `relayPortMax` | `49152`, `49999` | A továbbított folyamok UDP-portjai. |
| `credentialTtlSeconds` | `86400` | A felhasználónkénti hitelesítő adatok élettartama. |
| `allowPrivatePeers` | `false` | Továbbítás engedélyezése privát címekre. Ki van kapcsolva, hogy a továbbító ne érje el a LAN-odat. |
| `maxAllocations`, `maxAllocationsPerUser` | `500`, `20` | Korlátok. |
| `maxKbps` | `0` | Sávszélesség-korlát továbbításonként, `0` = nincs. |

A bejelentkezett felhasználók rövid életű, magától lejáró hitelesítő adatokat kapnak, így nem tárolódik semmi, és egy kiszivárgott hamar használhatatlan lesz. Az IPv6-továbbítás nem támogatott.

### Külső szerverek

Használhatsz máshol futtatott vagy bérelt szervereket is, az **Adminpanel, Hívások** oldalon vagy az `iceServers` között:

```json
"iceServers": [
  { "urls": "stun:stun.example.org:3478" },
  { "urls": "turn:turn.example.org:3478", "username": "user", "credential": "secret" }
]
```

A felhasználónévvel és jelszóval rendelkező bejegyzéseket csak bejelentkezett felhasználók kapják meg.

::: warn Fordított proxyk
TLS-t lezáró proxy mögött a `trustProxy` értékét az **ugrásszámra vagy az alhálózatra** állítsd, ne `true`-ra. A közvetlenül elérhető szerveren a `true` lehetővé teszi, hogy a kliensek meghamisítsák az `X-Forwarded-For` fejlécet. Lásd: [TLS és fordított proxyk](tls.html).
:::
