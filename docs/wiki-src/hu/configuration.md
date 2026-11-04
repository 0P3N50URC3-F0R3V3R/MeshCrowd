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
| `lanNetworks` | `[]` | Opcionális LAN és VPN alhálózatok (CIDR) a hanghoz. Lásd: [LAN és VPN hálózatok](#lan-s-vpn-h-l-zatok). |
| `turn` | lásd lent | A beépített STUN/TURN szerver, alapból kikapcsolva. Lásd: [STUN és TURN](#stun-s-turn). |
| `sites` | `{"phpPath": "", "maxWorkers": 4}` | PHP futtatókörnyezet és munkafolyamat-szám az [Oldalakhoz](sites.html). |
| `logging` | `{"level": "info", "keepDays": 30, "maxFileMb": 10}` | Naplószint (`debug`, `info`, `warn`, `error`), hány napig maradnak meg a `data/logs/` fájljai, és mekkora méret után indul új fájl. Futás közben a `log level` és a `config set` is módosíthatja. |
| `ssh` | `{"enabled": false, "port": 2222, "listenAddress": "127.0.0.1", "maxSessions": 3, "idleTimeoutMinutes": 15, "allowPublicKeys": false}` | SSH-hozzáférés az admin konzolhoz. Alapból kikapcsolt és csak localhoston figyel. Az `allowPublicKeys` fenntartott kulcs, egyelőre nincs hatása (csak jelszavas belépés). Lásd: [Adminisztráció](administration.html#ssh-hozz-f-r-s). |
| `backup` | `{"keep": 7, "schedule": "", "maxFileMb": 5, "includeSecrets": false, "preRestoreKeep": 3}` | Mentések a konzolról: hány maradjon meg, a napi `ÓÓ:PP` ütemezés (üres: ki), a mentésbe kerülő legnagyobb médiafájl, bekerüljenek-e a konfiguráció titkai, és hány visszaállítás előtti másolat maradjon. Lásd: [Adminisztráció](administration.html#ment-sek-a-konzolr-l). |

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

### Dinamikus nyilvános IP

Ha a szolgáltatód időnként megváltoztatja a nyilvános címedet, és nincs hozzá domainneved, kapcsold be **A nyilvános IP automatikus felismerése** opciót az **Admin felület, Hívások** oldalon. A MeshCrowd ekkor ütemezetten (alapból 5 percenként) újraolvassa a címet. Ha az eltér a tárolt `externalIp`-től, elmenti az újat, a régit `previousIp` néven megőrzi, és újraindítja a beépített szervert, hogy a kliensek az új címet kapják. Amíg a cím nem változik, nem történik semmi.

Te választod meg, honnan jön a cím, így nem kell külső szolgáltatótól függned:

- **A router megkérdezése (UPnP)**: az alapértelmezett. A router megmondja a saját WAN-címét, semmi nem hagyja el a hálózatodat. A routeren be kell kapcsolni az UPnP-t.
- **Általam választott STUN-szerver**: egy általad megbízhatónak tartott STUN-szerver `host` vagy `host:port` címe, például a saját szervered.
- **Általam megadott URL beolvasása**: egy http(s) cím, amelynek válasza tartalmazza a nyilvános IPv4-címedet, például a router állapotoldala vagy egy saját szerveren futó kis oldal. A válasz első nyilvános IPv4-címét használja.

Ha az eredmény nem nyilvános cím (például egy második router vagy szolgáltatói NAT mögött), elveti, és a tárolt cím marad. Az állapotsor mutatja az utolsó ellenőrzést és az esetleges hibát, a **Mentés és ellenőrzés most** gomb azonnal ellenőriz.

### Beállítások

A `data/config.json` `turn` szakasza:

| Kulcs | Alapérték | Jelentés |
|---|---|---|
| `enabled` | `false` | A beépített szerver futtatása. |
| `port` | `3478` | UDP- és TCP-port, ahová az ügyfelek csatlakoznak. |
| `tcp` | `true` | TCP fogadása is, ami szigorú tűzfal mögött segít. Maga a továbbító UDP. |
| `externalIp` | `""` | A gép nyilvános IPv4-címe. Állítsd be, ha a szerver router mögött van. |
| `autoIp` | `false` | Rendszeresen újraolvassa a nyilvános IPv4-címet, és változáskor frissíti az `externalIp`-t. |
| `autoIpSource` | `"upnp"` | `upnp` (a router megkérdezése), `stun` (az `autoIpStun` használata) vagy `http` (az `autoIpUrl` használata). |
| `autoIpStun`, `autoIpUrl` | `""` | A választott forráshoz tartozó STUN-szerver (`host:port`) vagy URL. |
| `autoIpIntervalMinutes` | `5` | Ellenőrzés gyakorisága (1-1440). |
| `previousIp`, `ipChangedAt` | `""` | Automatikusan karbantartva: az utolsó változás előtti cím és a változás ideje. |
| `advertisedHost` | `""` | Az ügyfeleknek megadott gépnév. Üresen az `externalIp`-t, majd a `publicHost`-ot használja. |
| `relayPortMin`, `relayPortMax` | `49152`, `49999` | A továbbított folyamok UDP-portjai. |
| `credentialTtlSeconds` | `86400` | A felhasználónkénti hitelesítő adatok élettartama. |
| `allowPrivatePeers` | `false` | Továbbítás engedélyezése privát címekre. Ki van kapcsolva, hogy a továbbító ne érje el a LAN-odat. |
| `maxAllocations`, `maxAllocationsPerUser` | `500`, `20` | Korlátok. |
| `maxKbps` | `0` | Sávszélesség-korlát továbbításonként, `0` = nincs. |

A bejelentkezett felhasználók rövid életű, magától lejáró hitelesítő adatokat kapnak, így nem tárolódik semmi, és egy kiszivárgott hamar használhatatlan lesz. Az IPv6-továbbítás nem támogatott.

### LAN és VPN hálózatok

Az azonos LAN-on vagy privát VPN-en (Radmin, ZeroTier, SoftEther, Hamachi) lévők hívásai beállítás nélkül, közvetlenül kapcsolódnak, és sem STUN-ra, sem TURN-ra nincs szükségük. Hagyd üresen, hacsak a felhasználóknak nincs extra hálózati adapterük (Docker, WSL, virtuális gépek), amitől lassan indulnak a hívások. Ekkor add meg azokat az alhálózatokat, amelyeken az embereknek egymást el kell érniük, az **Adminpanel, Hívások, LAN / VPN hálózatok** alatt (soronként egyet) vagy a `lanNetworks` kulcsban:

```json
"lanNetworks": ["26.0.0.0/8", "192.168.3.0/24"]
```

Gyakori tartományok: `26.0.0.0/8` Radmin VPN, `25.0.0.0/8` Hamachi, `10.147.17.0/24` ZeroTier (a tiéd a vezérlőpultján látszik). A listán kívüli privát címeket kihagyja; a nyilvános címeket, a STUN-t és a TURN-t soha nem blokkolja. A beállítás újraindítás nélkül érvényes az új hívásokra.

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
