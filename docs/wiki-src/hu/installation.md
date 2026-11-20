---
title: Telepítés és frissítés
desc: Követelmények, a hordozható csomag, futtatás forrásból, portok, mentések és a frissítés menete.
group: Kezdd itt
order: 2
---

## Követelmények

| Rész | Szükséges |
|---|---|
| Szerver | **Node.js 22.5 vagy újabb** (a beépített `node:sqlite` modult használja). Windowson megfelelő `node.exe` mellékelve van. |
| Memória és lemez | Egy kis közösséghez néhány száz MB RAM, és elég lemez a feltöltéseknek. |
| Böngésző | Aktuális Chromium-, Firefox- vagy Safari-alapú böngésző. |
| Hang és videó | HTTPS (vagy `localhost`), plusz a beépített STUN/TURN szerver (vagy egy külső) a különböző hálózaton lévőknek. Lásd: [STUN és TURN](configuration.html#stun-s-turn). Az opcionális SFU hangmotorral helyette a 40000-40003 UDP és TCP port kell, lásd: [SFU hangmotor](configuration.html#sfu-hangmotor). |

## Windows: a hordozható csomag

A csomag tartalmazza a szervert, a webes klienst, egy Node.js futtatókörnyezetet és egy üres `data/` vázat. Másold át bármely, azonos operációs rendszerű gépre, még internet nélkülire is.

1. Csomagold ki bárhová.
2. Futtasd a `start-server.bat` fájlt.
3. Szükség esetén szerkeszd a `data/config.json` fájlt (ha a hosztot vagy a portokat módosítani kell), majd indítsd újra.

## Linux és macOS: forrásból

```
node --version     # 22.5 vagy újabb kell
npm install
npm start
```

A `./start-server.sh` ugyanezt teszi, és ha van mellékelt futtatókörnyezet, azt részesíti előnyben. Fejlesztéskor használd az `npm run dev` parancsot; az újraindítja a szervert, ha a fájlok változnak.

## Mit hoz létre az első indítás

| Elérési út | Mi ez |
|---|---|
| `data/dismesh.db` | Az SQLite adatbázis: felhasználók, szerverek, üzenetek |
| `data/config.json` | A konfiguráció, minden indításkor az alapértékekkel kiegészítve |
| `data/certs/` | A generált önaláírt tanúsítvány (hacsak nem állítasz be sajátot) |
| `data/attachments/`, `data/avatars/` és hasonlók | Feltöltött fájlok |

## Portok

Alapból a HTTPS a `8443`-on figyel. A sima `8080` port csak HTTPS-re irányít át. Módosításukhoz használd a `data/config.json` fájl `httpsPort` és `port` kulcsait. Lásd: [Konfiguráció](configuration.html).

A bekapcsolt SFU hangmotornak a `voice.sfu.port` – `port + workers - 1` portokra (alapból `40000`-`40003`) is szüksége van nyitva UDP-n és TCP-n, lásd: [SFU hangmotor](configuration.html#sfu-hangmotor).

## Futtatás szolgáltatásként

Futtasd az indítószkriptet a kedvenc szolgáltatáskezelőd alatt (systemd, Windows-szolgáltatás burkoló, ütemezett feladat). A folyamat a naplóját a szabványos kimenetre írja. Normál leállító jellel állítsd le; az adatbázis tisztán bezárul.

## Mentések

::: note A mentés egy mappa
Állítsd le a szervert és másold le az egész `data/` mappát. Tartalmazza az adatbázist, a konfigurációt, a tanúsítványt és minden feltöltött fájlt. Visszaállításkor tedd vissza a mappát.
:::

Ne másold egyedül a `data/dismesh.db` fájlt, miközben a szerver fut, mert a feltöltéseknek és az adatbázisnak egyeznie kell.

## Frissítés

1. Készíts mentést.
2. Állítsd le a szervert.
3. Cseréld le a programfájlokat az újra, a `data/` mappádat megtartva.
4. Indítsd el a szervert. Az adatbázis-módosítások indításkor automatikusan lefutnak.

**Frissítés SFU hangmotoros verzióra.** A szokásos programfájlokon (`server/`, `web/`, `lang/`, `scripts/`, `package.json`, `package-lock.json`) túl másold át a **teljes `node_modules/` mappát** is: már tartalmazza a `mediasoup`-ot (a natív workerével) és a függőségeit, amelyekre a szervernek indításkor szüksége van. A `runtime/` (PHP, ffmpeg) ebben a kiadásban nem változik. A szerver a korábbiak szerint indul, a `voice.mode` értéke `mesh`; az SFU használatához kövesd az [SFU hangmotor](configuration.html#sfu-hangmotor) leírását: nyisd meg a médiaportokat, add meg a nyilvános címet, és válts módot az Adminpanel, Hívások alatt. `node_modules/` másolása helyett csak akkor futtass `npm install`-t, ha a szerver más operációs rendszeren fut, mint amelyen a mappa készült (ilyenkor Linuxon vagy macOS-en az `npm run fetch:mediasoup` is kell).

A webes klienst és a telefonos felületet a szerver szolgálja ki, így a szerver frissítése mindenhol frissíti őket. Az asztali és az Android-alkalmazásnak csak akkor kell új kiadás, ha a saját natív kódjuk változik.

## A hordozható csomag saját építése

```
npm run build:portable
```

Ez a `dist/dismesh-portable/` mappát hozza létre. Az Oldalakhoz (Sites) futtasd egyszer az `npm run fetch:php` parancsot az építő gépen, hogy Windowsra PHP futtatókörnyezet kerüljön a csomagba. Lásd: [Oldalak](sites.html). Futtasd egyszer az `npm run fetch:ffmpeg` parancsot is, hogy az ffmpeg is a csomagba kerüljön: ez adja a közzétett videók első képkockás előnézetét (nélküle telepítsd az ffmpeg-et a szerverre, különben a videó lejátszásig üres lejátszót mutat).
