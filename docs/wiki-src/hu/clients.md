---
title: Web, asztali és telefonos kliensek
desc: Mit kínál az egyes kliens, hogyan rögzíti a tanúsítványokat az asztali alkalmazás, és hogyan szolgálja ki a szerver a telefonos felületet.
group: A MeshCrowd használata
order: 6
---

Minden kliens ugyanahhoz a szerverhez beszél, és ugyanazokat az adatokat mutatja. Válaszd azt, amelyik az adott pillanatban kézre áll.

| Kliens | Mire a legjobb | Megjegyzések |
|---|---|---|
| Web | Mindenre, nincs mit telepíteni | Minden funkció, bármely modern böngészőben |
| Asztali (Windows) | Mindennapi használat az asztalnál | Tálcajelvény, natív értesítések, tanúsítvány-rögzítés |
| Asztali, könnyű (Windows) | Kisebb letöltés | Egyetlen exe WebView2-n, ugyanazok a funkciók |
| Android | Útközben | Telefonos felület, helyi értesítések, opcionális UnifiedPush |

## Web

Nyisd meg a szerver címét. Jelentkezz be, és minden funkciót megkapsz. Ha szeretnéd, add hozzá a kezdőképernyőhöz a böngészőmenüből. A telefonos böngészők automatikusan a telefonos felületet kapják; a váltáshoz írd a cím végére a `?ui=desktop` vagy `?ui=mobile` részt.

## Asztali alkalmazás (Windows)

Hordozható alkalmazás: csomagold ki és futtasd a `MeshCrowd.exe` fájlt. Az első indításkor szervercímet kér, például `https://192.168.1.10:8443`, majd ugyanazt a felületet tölti be, mint a böngésző, és kiegészíti:

- **Tálcaikonnal** élő olvasatlan jelvénnyel, a jelenléted színével. A színek a **Beállítások, Asztali alkalmazás, Tálcaikon** alatt testreszabhatók.
- **Csatlakozási képernyővel**, amely pörgő jelzést mutat, amíg a szerver válaszol. Ha nem érhető el (vagy 20 másodpercnél tovább tart), üres ablak helyett az **Újrapróbálás** és a **Szerver módosítása** gombot kínálja.
- **Natív értesítésekkel**, tálcára zárással és indítással a Windowsszal.
- **F11 teljes képernyő**, amely a **Beállítások, Asztali alkalmazás** alatt kikapcsolható.
- **Tálca értesítési lista**: a tálcaikonra jobb gombbal kattintva látod a legutóbbi értesítéseidet (hányat, 0 és 15 között, azt a **Beállítások, Asztali alkalmazás** adja meg, alapértelmezetten 5). Egyre kattintva az kikerül a listából, és pontosan arra az üzenetre ugrik. A megnyitva hagyott csatorna akkor is értesít, ha az app a tálcára van rejtve vagy kis méretű; egy másik kapcsoló ugyanezt teszi, ha az ablak csak nincs fókuszban.
- **Letöltésjelzővel**: minden csatolmány-letöltésnél a jobb alsó sarokban és a tálcaikonon folyamatjelző látszik (méret, százalék, Mégse); a végén a **Megnyitás** és a **Megjelenítés mappában** egy kattintásra van.
- **Letöltési hellyel**: a **Beállítások, Letöltések** alatt választhatsz, hogy minden fájlnál rákérdezzen a mentés helyére, vagy mindig egy mappába mentsen. A mappát a **Tallózással** választhatod ki, vagy beírhatod a teljes útvonalat; üresen a rendszer Letöltések mappája él. Meglévő fájlt soha nem ír felül, helyette sorszámot fűz a névhez.
- **Ablak-memóriával**: a méretet, a pozíciót és a teljes képernyős (maximalizált) állapotot a következő indításkor visszaállítja.
- **Megjegyzett szerverek**: a csatlakozási képernyő felsorolja a használt szervereket (a szerver neve és ikonja), egykattintásos csatlakozással és eltávolítással. Megmutathatja a MeshSwarm követők **nyilvános szerverlistáját** is, ami alapból ki van kapcsolva, mert a követő lekérdezésekor az megkapja az IP-címedet; a követők listája szerkeszthető. Egy bejelentkezési oldal nyilvános listáján egy szerverre kattintva natív megerősítés után az app átvált rá.
- **Bejelentkezve maradás**: a bejelentkezés kijelentkezésig megmarad, újraindítások között is; "maradjak bejelentkezve" kérdés nincs.
- **Gyorsítótár törlése**: a **Beállítások, Asztali alkalmazás, Gyorsítótár törlése** törli a HTTP-gyorsítótárat, az IndexedDB-t, a CacheStorage-ot, a service workereket, a fájlrendszer- és WebSQL-adatokat, hogy lemezhelyet szabadíts fel. A sütik és a localStorage megmaradnak, így bejelentkezve maradsz és a beállításaid is megvannak (az egyéni értesítési hang az IndexedDB-ben van, azt újra be kell állítani). Az app megmutatja, hány MB szabadult fel.
- **Tálcaszám színe és pulzálás**: a **Beállítások, Asztali alkalmazás, Tálcaikon** alatt kiválaszthatod a tálcaikon számjegyeinek színét és azt, hogy pulzáljon-e. Ha a szerverkapcsolat megszakad, a tálca- és a tálcagomb-ikon piros tiltó jelet mutat, amíg vissza nem áll.
- Az operációs rendszer **képernyő- és ablakválasztójával** a képernyőmegosztáshoz.
- **Meghívólinkek**: a meghívóoldalról érkező `mcr://` linkek az alkalmazásban nyílnak meg. Az alkalmazás minden indításkor regisztrálja magát hozzájuk, ami a mappa áthelyezése után is helyreállítja a bejegyzést; kikapcsolható a **Beállítások, Asztali alkalmazás** alatt. A linkek szerverváltás és csatlakozás előtt mindig rákérdeznek. A `MeshCrowd.exe` melletti `register-mcr-protocol.bat` és `unregister-mcr-protocol.bat` kézzel ugyanezt teszi.
- **Első használatkori tanúsítvány-rögzítéssel** önaláírt szerverekhez: először megerősíted az ujjlenyomatot, egy későbbi változás pedig figyelmeztetést vált ki. A nyilvános hatóság által kiállított tanúsítványt a rendes módon elfogadja.

Az alkalmazás a beállításait a futtatható fájl melletti `data` mappában tárolja, így az egész mappa élhet egy pendrive-on. Nincs benne szerver és webes fájl: a szerver frissítése a felületet is frissíti.

Fejlesztéshez forrásból: `npm install`, majd `npm run electron`.

## C# asztali kliens (Windows)

Az Electron-alkalmazás alternatívája: egyetlen `MeshCrowd.exe`, amely a bundlelt Chromium helyett a rendszer WebView2 böngészőmotorjára épül, ezért sokkal kisebb. Ugyanazt a felületet tölti be és ugyanazt a `dismesh-client-config.json` fájlt olvassa, és tudja a tálcát olvasatlan-villogással és legutóbbi listával, a natív értesítéseket, a letöltéseket tálcás folyamatjelzővel, az `mcr://` meghívólinkeket, az egyetlen futó példányt, a tanúsítvány-rögzítést, a tálcára zárást, a megjegyzett szervereket az opcionális nyilvános listával és a **Gyorsítótár törlését**. A beállítások az exe melletti `data` mappában vannak. A fő asztali kliens továbbra is az Electron; ezt akkor válaszd, ha könnyebb alkalmazást szeretnél.

Ahol már megvan a WebView2 futtatókörnyezet (bármely friss Windows 10 vagy 11), ott azt használja. A futtatókörnyezetet beágyazó változat nagyjából 250 MB, és ott, ahol nincs, egyszer kicsomagolja a `data/webview2-runtime` mappába.

## Telefonos felület

A szerver telefonra tervezett felületet szolgál ki a `/m/` címen, amelyet az Android-böngészők és az Android-alkalmazás használ. Négy füle van (Szerverek, Üzenetek, Értesítések, Te), hosszú nyomásos menüi, alsó lapjai, hangüzenetei, szavazásai, időzítése a küldés gomb lenyomva tartásával, perjeles parancs chipjei és hívásai. Telepítésről és értesítésekről az [Android-alkalmazás](android.html) útmutatóban olvashatsz.

![A telefonos felület](../assets/img/m-chat.jpg)

## Nyelv és témák

A nyelv és a téma fiókonként mentődik, ezért kliensről kliensre követ.
