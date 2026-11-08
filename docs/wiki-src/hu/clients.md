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
- Az operációs rendszer **képernyő- és ablakválasztójával** a képernyőmegosztáshoz.
- **Meghívólinkek**: a meghívóoldalról érkező `mcr://` linkek az alkalmazásban nyílnak meg. Az alkalmazás minden indításkor regisztrálja magát hozzájuk, ami a mappa áthelyezése után is helyreállítja a bejegyzést; kikapcsolható a **Beállítások, Asztali alkalmazás** alatt. A linkek szerverváltás és csatlakozás előtt mindig rákérdeznek. A `MeshCrowd.exe` melletti `register-mcr-protocol.bat` és `unregister-mcr-protocol.bat` kézzel ugyanezt teszi.
- **Első használatkori tanúsítvány-rögzítéssel** önaláírt szerverekhez: először megerősíted az ujjlenyomatot, egy későbbi változás pedig figyelmeztetést vált ki. A nyilvános hatóság által kiállított tanúsítványt a rendes módon elfogadja.

Az alkalmazás a beállításait a futtatható fájl melletti `data` mappában tárolja, így az egész mappa élhet egy pendrive-on. Nincs benne szerver és webes fájl: a szerver frissítése a felületet is frissíti.

Fejlesztéshez forrásból: `npm install`, majd `npm run electron`.

## Telefonos felület

A szerver telefonra tervezett felületet szolgál ki a `/m/` címen, amelyet az Android-böngészők és az Android-alkalmazás használ. Négy füle van (Szerverek, Üzenetek, Értesítések, Te), hosszú nyomásos menüi, alsó lapjai, hangüzenetei, szavazásai, időzítése a küldés gomb lenyomva tartásával, perjeles parancs chipjei és hívásai. Telepítésről és értesítésekről az [Android-alkalmazás](android.html) útmutatóban olvashatsz.

![A telefonos felület](../assets/img/m-chat.jpg)

## Nyelv és témák

A nyelv és a téma fiókonként mentődik, ezért kliensről kliensre követ.
