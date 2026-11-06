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

### Szerverek

Az **Admin, Szerverek** lista minden szervert mutat tulajdonossal, tagszámmal és létrehozási dátummal. Kétféleképpen távolítható el egy szerver:

- A **Törlés most** azonnal törli a szervert, csatornáit, üzeneteit és fájljait. A megerősítéshez be kell írni a szerver nevét.
- A **Törlés ütemezése** időzített törlést állít be órákban vagy napokban. A szerver addig használható marad, a lista mutatja a dátumot, a **Törlés visszavonása** pedig a lefutás előtt bármikor leállítja.

Mindkettőhöz a **Bármely szerver kezelése** jogosultság kell.

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

## Az admin konzol

A konzol egy szöveges felület annak, aki a szervert üzemelteti. Elindul a szerver ablakában, ha a szervert terminálból indítod (ott nincs bejelentkezés, hiszen már te irányítod a gépet), és igény szerint SSH-n keresztül is elérhető. A `help` kiírja a parancsokat, a `help <parancs>` a részleteket. A veszélyes parancsok megerősítést kérnek; a `--yes` kihagyja ezt.

| Parancs | Mit csinál |
|---|---|
| `account list/info/create/passwd/delete/disable/enable/roles/grant/revoke/roleperm` | Fiókok és oldalszintű rangok kezelése (a `roleperm` a konzoljogosultságot adja a rangnak vagy veszi el tőle, csak a szerver ablakában) |
| `ban`, `unban`, `kick` | Fiók letiltása vagy visszaengedése, felhasználó lekapcsolása |
| `ipban`, `ipunban` | IP-cím, tartomány vagy CIDR tiltása, kívánság szerint néhány percre |
| `config list/get/set/reset/path` | A `data/config.json` olvasása és módosítása ellenőrzéssel |
| `backup create/list/delete/verify/keep/auto/restore` | Mentések (lásd lent) |
| `purge` | A szervert gyári állapotba állítja: minden fiók, szerver, üzenet, privát üzenet és feltöltés törlődik, majd újraindul. Csak a szerverablakban. Kell hozzá a `purgePassword` a `data/config.json`-ban (üresen letiltott), ezt és a `PURGE` beírását kéri, és előtte biztonsági mentést készít. A konfiguráció, a tanúsítványok és a mentések megmaradnak |
| `server stop`, `server restart`, `server cancel` | Leállítás vagy újraindítás, opcionális másodperces visszaszámlálással |
| `status`, `list`, `stats`, `stats watch` | Verzió, üzemidő, bejelentkezett felhasználók, terhelés, statisztika |
| `announce <szöveg>` | Értesítés minden bejelentkezett felhasználónak |
| `log tail/show/level/files` | Élő napló, legutóbbi bejegyzések, naplószint, naplófájlok |
| `ssh status`, `ssh kick <n>` | SSH ujjlenyomat, cím és munkamenetek |

A `server restart` a felügyelő folyamatot igényli: indítsd a szervert `npm start`, `start-server.bat` vagy `start-server.sh` paranccsal. Ezek újraindítják, ha a szerver 42-es kilépési kóddal áll le. Nélkülük a `server restart` csak leállítja a szervert.

### SSH-hozzáférés

1. Állítsd az `ssh.enabled` értékét `true`-ra (`config set ssh.enabled true`, vagy szerkeszd a `data/config.json` fájlt), majd indítsd újra a szervert. Alapból a `127.0.0.1` cím `2222`-es portján figyel, vagyis csak maga a gép érheti el.
2. Add meg a jogosultságot: a **Tulajdonos** mindig használhatja a konzolt, a stábtagoknak az oldalszintű **Manage Console** jogosultság kell. A Site Administrator ezt nem tartalmazza. Ha még senkinek nincs meg (például frissítés után), futtasd a szerver ablakában: `account roleperm Owner +console`.
3. PuTTY-ban add meg a gépet és a portot, a kapcsolat típusa SSH, majd nyisd meg. Az első kapcsolódáskor a PuTTY megmutatja a gazdakulcs ujjlenyomatát. Mielőtt az Accept gombra kattintasz, hasonlítsd össze a szerver ablakában kiadott `ssh status` eredményével (vagy a naplóban az `[ssh] listening` sorral). Ha később más ujjlenyomatot látsz, az másik szervert vagy támadást jelent.
4. Jelentkezz be a MeshCrowd felhasználóneveddel és jelszavaddal. Kétlépcsős azonosítású fióknál a jelszó után a kódot is kéri. Az a kliens, amely csak jelszót tud küldeni (billentyűzet-interaktív kérdés nélkül), nem tud belépni kétlépcsős fiókkal.

Más gépről való eléréshez állítsd be az `ssh.listenAddress` értékét (például `0.0.0.0`), és nyisd meg a portot a tűzfalon. Ha tudod, inkább VPN-t vagy SSH-alagutat használj, és hagyd localhoston; a szerver figyelmeztetést naplóz, ha nem visszacsatolási címen figyel.

::: warn Biztonsági megjegyzések
Az erősített bejelentkezésű fiókok jelszava a weben sosem jut el a szerverig, de SSH-nál nincs böngésző, amely a kulcsot levezetné. Ezért SSH-n a szerver a jelszót nyers szövegként kapja meg a titkosított SSH-csatornán belül, a memóriában levezeti belőle a kulcsot, ellenőrzi, majd eldobja. Sosem tárolja és nem naplózza. Öt sikertelen belépés után egy címet 10 percre zárol (egy NAT mögötti hálózat közös zárat kap, így egy támadó egy időre kizárhat; ilyenkor a szerver ablakából tudsz dolgozni). A munkamenet `ssh.idleTimeoutMinutes` tétlenség után megszakad, és egyszerre legfeljebb `ssh.maxSessions` fut.
:::

### Mentések a konzolról

A `backup create` a `data/backups/backup-<UTC idő>-<manual|scheduled|pre-restore>.zip` fájlt írja, benne egy konzisztens adatbázis-pillanatkép, a `config.json` és a kis méretű média (avatarok, bannerek, emojik, matricák, hangok, ikonok; a `backup.maxFileMb` fölötti fájlok kimaradnak). Nem kerül bele: a csevegés mellékletei, a Sites, a tanúsítványok és az SSH gazdakulcs. A titkok (például a TURN titok) helyőrzőre cserélődnek, hacsak a `backup.includeSecrets` értéke nem igaz. A `backup verify` az archívumot a hash-eihez képest ellenőrzi.

A legfrissebb `backup.keep` mentés marad meg (alapból 7), a régebbieket minden mentés után törli. A visszaállítás előtti másolatokat külön tartja (`backup.preRestoreKeep`). A `backup auto 03:30` naponta ütemez mentést a szerver helyi idejében, a `backup auto off` kikapcsolja.

A `backup restore <név>` csak a szerver ablakában működik, SSH-n soha. Ellenőrzi az archívumot, a jelenlegi adatbázisról pre-restore mentést készít, lecseréli az adatbázist, a médiát és a konfigurációt, majd újraindítja a szervert. Az élő titkok és a tanúsítványok megmaradnak.

### Naplók

A naplók a `data/logs/dismesh-ÉÉÉÉ-HH-NN.log` fájlokba kerülnek, naponta egy, és új sorszámozott fájl indul, ha az egyik túlnő a `logging.maxFileMb` méreten; a `logging.keepDays` napnál régebbi fájlok törlődnek. A szintek: `debug`, `info`, `warn`, `error`; a `log level warn` azonnal átállítja és el is menti. Naplózódik a bejelentkezés és a sikertelen bejelentkezés (IP-címmel), a fiók- és rangmódosítás, a tiltás, a konzolparancsok és a szerver életciklusa. Jelszó, token, kulcs és üzenettartalom soha.

## Frissítés

Készíts mentést, állítsd le a szervert, cseréld le a programfájlokat (a `data/` megtartásával) és indítsd újra. Az adatbázis-módosítások automatikusan lefutnak. Lásd: [Telepítés](installation.html).

## Felügyelet

A szerver a szabványos kimenetre naplóz: tanúsítvány-ujjlenyomatok, migrációk, figyelmeztetések és hibák. Figyeld ezt a naplót a szolgáltatáskezelőddel. Egy egyszerű állapotellenőrzés a bejelentkező oldal lekérése.

## Költözés új gépre

Másold a `data/` mappát az új gépre és indítsd ott a szervert. Ha a cím változik, frissítsd a `publicHost` értékét és töröld a `data/certs/` mappát, hogy új tanúsítványt kapj. Az a kliens, amelyik a régi tanúsítványban megbízott, újra rá fog kérdezni.
