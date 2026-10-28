---
title: Adminisztráció és mentések
desc: Az adminpanel, személyzeti rangok, feltöltési korlátok, ritkítás, nyelvek, mentések és a mindennapi üzemeltetés.
group: Szerver üzemeltetése
order: 1
---

## Az adminpanel

Az adminpanel csak az **oldalszemélyzeti ranggal** rendelkező fiókoknak látszik. A **Tulajdonos** (az első fiók) minden jogosultsággal rendelkezik, és rangokat hozhat létre, valamint konkrét jogosultságokat oszthat ki.

| Jogosultság | Mit enged |
|---|---|
| Adminpanel megtekintése | A panel látása |
| Felhasználók kezelése | Fiókok letiltása és engedélyezése, bármely profil szerkesztése |
| Oldalrangok kezelése | Személyzeti rangok létrehozása és kiosztása |
| Bármely üzenet törlése | Tartalom eltávolítása bárhol |
| Bármely szerver kezelése | Bármely szerver törlése vagy átruházása, Oldalak létrehozása |
| Bejelentések kezelése | A felhasználói bejelentési sor feldolgozása |
| Adatok ritkítása | Előzmények tömeges törlése dátum szerint |
| MI kezelése | MI-szolgáltatók és botok beállítása bármely szerveren |
| Oldal-adminisztrátor | Megkerüli az összes oldaljogosultság-ellenőrzést |

A panel példányszintű statisztikákat is mutat, és lehetővé teszi a felhasználók és szerverek kezelését.

## Mellékletek

Az **Admin, Áttekintés** alatt futás közben csökkentheted a feltöltési méretkorlátot (a konfiguráció `maxUploadMb` értéke fölé sosem), és opcionálisan engedélyezőlistára korlátozhatod a feltöltéseket olyan kiterjesztésekkel, mint `.png, .jpg, .pdf`. A futtathatók, a HTML és az SVG mindig tiltottak, a fájlokat pedig letöltésként, homokozó Content-Security-Policy alatt szolgálja ki a rendszer, így a feltöltés sosem futhat szkriptként az alkalmazás eredetében.

## Munkamenetek

A munkamenet-élettartam oldalszintű beállítás. Az egyes munkamenetek visszavonhatók, egy fiók letiltása pedig azonnal megszünteti a munkameneteit és az élő kapcsolatait.

## Adatok ritkítása

- A **Tartalom ritkítása** jogosultsággal rendelkező szerverfelügyelők a saját szerverük csatornáit és szálait ritkíthatják a **Szerverbeállításokból**.
- Az **Adatok ritkítása** jogosultsággal rendelkező oldaladminisztrátorok bármely szerver csatornáit vagy bármely privát beszélgetést ritkíthatják az adminpanelről. A beszélgetések méret szerint vannak listázva, az üzenetek tartalma pedig sosem jelenik meg.
- A csoportos privát beszélgetés létrehozói a saját csoportjukat ritkíthatják.

Minden ritkítás előbb előnézetet mutat, és futhat azonnal vagy 24 órás előzetes értesítés után. Lásd: [Moderáció és biztonság](moderation.html#data-pruning).

## Nyelvek

A felület angolul és magyarul érkezik. Az adminisztrátorok nyelvi fájlokat vehetnek fel az adminpanelről. A szövegek sima JSON-ban vannak, így egy fordítás az angol fájl másolata megváltoztatott értékekkel.

## Mentések

::: note A mentés egy mappa
Állítsd le a szervert és másold le az egész `data/` mappát: az adatbázist, a konfigurációt, a tanúsítványt és minden feltöltött fájlt. Visszaállításhoz tedd vissza a mappát.
:::

Ütemezd az általad választott eszközzel. Ha nem tudod leállítani a szervert, másolj egy csendes pillanatban, és tarts meg több generációt. Egyszer próbáld ki a visszaállítást.

## Frissítés

Készíts mentést, állítsd le a szervert, cseréld le a programfájlokat (a `data/` megtartásával) és indítsd újra. Az adatbázis-módosítások automatikusan lefutnak. Lásd: [Telepítés](installation.html).

## Felügyelet

A szerver a szabványos kimenetre naplóz: tanúsítvány-ujjlenyomatok, migrációk, figyelmeztetések és hibák. Figyeld ezt a naplót a szolgáltatáskezelőddel. Egy egyszerű állapotellenőrzés a bejelentkező oldal lekérése.

## Költözés új gépre

Másold a `data/` mappát az új gépre és indítsd ott a szervert. Ha a cím változik, frissítsd a `publicHost` értékét és töröld a `data/certs/` mappát, hogy új tanúsítványt kapj. Az a kliens, amelyik a régi tanúsítványban megbízott, újra rá fog kérdezni.
