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
| Hang és videó | HTTPS (vagy `localhost`), plusz a beépített STUN/TURN szerver (vagy egy külső) a különböző hálózaton lévőknek. Lásd: [STUN és TURN](configuration.html#stun-s-turn). |

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

A webes klienst és a telefonos felületet a szerver szolgálja ki, így a szerver frissítése mindenhol frissíti őket. Az asztali és az Android-alkalmazásnak csak akkor kell új kiadás, ha a saját natív kódjuk változik.

## A hordozható csomag saját építése

```
npm run build:portable
```

Ez a `dist/dismesh-portable/` mappát hozza létre. Az Oldalakhoz (Sites) futtasd egyszer az `npm run fetch:php` parancsot az építő gépen, hogy Windowsra PHP futtatókörnyezet kerüljön a csomagba. Lásd: [Oldalak](sites.html).
