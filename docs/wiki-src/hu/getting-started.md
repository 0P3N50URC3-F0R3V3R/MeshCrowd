---
title: Első lépések
desc: Tízperces körút: indíts el egy szervert, hozz létre fiókot, készítsd el az első szerveredet és hívj meg valakit.
group: Kezdd itt
order: 1
---

Ez az oldal a semmitől egy működő közösségig visz el. Minden lépés mélyebb oldalra mutat tovább.

## Mire lesz szükséged

- Egy számítógépre, amelyik bekapcsolva marad, amíg az emberek használják: egy félretett PC-re, egy kis szerverre vagy egy bérelt VPS-re.
- Windowson semmi másra: a szervercsomag saját Node.js-szel érkezik. Linuxon és macOS-en telepítsd a **Node.js 22.5 vagy újabb** verzióját.
- Egy modern böngészőre.

## 1. Indítsd el a szervert

Windowson csomagold ki a szervercsomagot és kattints duplán a `start-server.bat` fájlra. Linuxon vagy macOS-en:

```
npm install
npm start
```

Az első indítás létrehoz egy `data/` mappát az adatbázissal, egy konfigurációs fájllal és egy önaláírt tanúsítvánnyal. A hordozható csomagról és a frissítésekről a [Telepítés](installation.html) oldalon olvashatsz.

## 2. Nyisd meg és hozd létre a tulajdonosi fiókot

Nyisd meg a `https://localhost:8443` címet, és fogadd el egyszer a tanúsítvány-figyelmeztetést. A figyelmeztetés várható: a tanúsítványt a saját szervered generálta. Regisztrálj. **Az első fiók lesz a Tulajdonos**, teljes adminisztrátori jogokkal.

![A csevegőnézet bejelentkezés után](../assets/img/chat-general.jpg)

## 3. Hozd létre az első szerveredet

Kattints a bal oldali sávban a zöld **+** gombra, és válaszd a **Szerver létrehozása** lehetőséget. Adj neki nevet. Egy `general` szöveges csatornát már kapsz. Több csatornát a **Csatornák** melletti **+** gombbal vehetsz fel, a **Szerverbeállításokat** pedig a lista tetején lévő szervernévre kattintva nyithatod meg.

::: note Indulj sablonból
Ha valaki megosztott veled egy sablonkódot, illeszd be a **Sablonkód** mezőbe a szerver létrehozásakor, hogy az ő szerkezetéből indulj. Lásd: [Közösségi eszközök](community-tools.html).
:::

## 4. Hívj meg embereket

Nyisd meg a **Szerverbeállítások, Meghívók** oldalt, hozz létre egy meghívót és küldd el a linket (a **Link másolása** egy `https://192.168.1.10:8443/i/<kód>` formájú címet ad, amely egy csatlakozóoldalt nyit meg; a sima kód továbbra is működik a **Csatlakozás** fülön). A hálózatodon lévők használhatják a LAN-címedet. A hálózatodon kívüliekhez domainnév és rendes tanúsítvány kell: lásd [TLS és fordított proxyk](tls.html).

::: warn Először a publicHost
Ha más eszközök is csatlakozni fognak, állítsd a `publicHost` értékét a `data/config.json` fájlban arra a címre, amelyet az emberek be fognak gépelni, **még az első indítás előtt**, hogy a tanúsítvány arra készüljön. Későbbi módosítása a `data/certs/` törlését és újraindítást jelent.
:::

## 5. Vegyél fel egy hangcsatornát

Hozz létre egy **Hang** típusú csatornát. Most válassz minőség-előbeállítást: a csatorna létrejötte után már nem módosítható. Csatlakozz az oldalsávból, és engedélyezd a mikrofonhozzáférést. A hívásokhoz HTTPS vagy `localhost` kell. Lásd: [Hang, videó és színpadok](voice-video.html).

## 6. Válaszd ki a klienseidet

- **Böngésző**: nincs mit telepíteni.
- **Asztali alkalmazás**: hordozható Windows-kliens. Lásd: [Kliensek](clients.html).
- **Android**: lásd az [Android-alkalmazás](android.html) útmutatót.

## Merre tovább

- Ismerd meg a jogosultságok működését a [Szerverek, csatornák és szerepkörök](servers-channels.html) oldalon.
- Védd meg a közösségedet a [Moderáció és biztonság](moderation.html) segítségével.
- Automatizálj a [Botok, API és webhookok](bots-api.html) oldal alapján.
- Mentsd el egyetlen mappa másolásával: [Adminisztráció](administration.html).
