---
title: Oldalak (PHP intranet)
desc: Üzemeltess kisebb PHP, HTML és JS oldalakat a szervereden belül, kódszerkesztővel és vizuális szerkesztővel.
group: Bővítés
order: 3
---

Az **Oldal** (Site) olyan szervertípus, amely csatornák helyett PHP, HTML, CSS és JS oldalak egy mappáját szolgálja ki az alkalmazáson belül. Mindenki szerversávjában megjelenik (nyilvános, automatikusan csatlakozós szerver csatornák, hang és értesítések nélkül), és azonos eredetű keretben jelenik meg. Használd csapat-wikihez, beosztáshoz, egy kis belső eszközhöz.

## Ki hozhat létre és szerkeszthet

A **Bármely szerver kezelése** (vagy **Oldal-adminisztrátor**) jogosultsággal rendelkező oldalszemélyzet hozhat létre Oldalakat a **+** párbeszédablakból, az **Új oldal** fülön. Az Oldal tulajdonosa és az oldalszemélyzet szerkesztheti; mindenki más csak megtekinti.

## A PHP futtatókörnyezet

- **Windows**: futtasd egyszer az `npm run fetch:php` parancsot az építő gépen. Letölti a hordozható PHP 8.4-et (ellenőrzőösszeggel ellenőrizve) és a Microsoft Visual C++ terjeszthető csomagját a `runtime/php/` mappába, és az `npm run build:portable` magával viszi. Ha a PHP a hiányzó DLL kódjával lép ki induláskor, a szerver maga futtatja a mellékelt `vc_redist.x64.exe` fájlt (a Windows UAC-kérést mutat, hacsak a szerver nem emelt jogú).
- **Linux és macOS**: telepítsd a PHP-t a csomagkezelőddel, vagy állítsd be a `sites.phpPath` értéket.

Beállítások a `data/config.json` fájlban:

| Kulcs | Alapérték | Jelentés |
|---|---|---|
| `sites.phpPath` | `""` | Kifejezett PHP-bináris. Üresen a `runtime/php/php.exe`, majd a PATH-beli `php` |
| `sites.maxWorkers` | `4` | Párhuzamos PHP-folyamatok Oldalanként (1-16). Egy aktív munkafolyamat nagyjából 20-30 MB-ot használ |

## A szerkesztő

A **Szerkesztés** gomb fájlfát nyit kódnézettel (CodeMirror HTML-, PHP-, JS- és CSS-színezéssel, valamint **Ctrl+S**-sel) és **vizuális nézettel** (TinyMCE), amelyben a PHP-blokkok védett chipek maradnak, és bájtról bájtra visszaállnak. Azt az oldalt, amelyet a vizuális szerkesztő nem tud körbejáratni, automatikusan a kódnézet veszi át.

Engedélyezett fájlok: `php html htm css js json txt md svg png jpg jpeg gif webp ico`, fájlonként legfeljebb 2 MB, 200 fájl és Oldalanként 50 MB.

## Külső eredetek

Az Oldal beállításai felsorolják azokat a további `https://` eredeteket, amelyekről az oldalai szkripteket, stíluslapokat, képeket és kereteket tölthetnek be. Hozzáadáskor figyelmeztetést mutat, mert egy másik eredetről betöltött szkript az oldal jogosultságaival fut. Helyettesítő karakter nem engedélyezett.

## Linkek

Az Oldalból kivezető linkek (másik eredet, `target="_blank"`, `window.open`) az asztali alkalmazásban az operációs rendszer böngészőjében, a weben új lapon nyílnak meg.

::: danger Bizalom
Az Oldalak a MeshCrowd részeként futnak. **Aki szerkeszthet egy Oldalt, az kódot futtathat a szerveren**, és azonos eredetű JavaScripten át azok nevében is, akik megnézik. Csak olyanoknak adj szerkesztési jogot, akiknek szerverhozzáférést is adnál.
:::
