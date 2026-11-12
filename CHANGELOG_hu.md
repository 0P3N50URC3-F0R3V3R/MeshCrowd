# Változásnapló

A MeshCrowd minden jelentős változása. A legújabb elöl. Formátum: [Keep a Changelog](https://keepachangelog.com/).

### 2026-11-12
#### Javítva
- Chat (minden csatorna, DM és fórumszál): ha törölsz egy üzenetet, miközben egy másik szerkesztés alatt áll, a szerkesztés teljes oldalfrissítésig nem működött (a felfelé nyíl és a szerkesztés gomb nem csinált semmit, az élő frissítések megálltak). A szerkesztési állapot mostantól magától törlődik, ha a szerkesztőmező eltűnt, a törlés nem törli le a nyitott szerkesztést, és a szerkesztett üzenet törlése megszakítja a szerkesztést. Csak webes változás.
- Telefon: a privát jegyzet-csatorna író mezője külön, teljes szélességű sorba kerül, a csatolás, emoji, mentés és törlés gombok pedig alatta, a következő sorban.
- Az új fórumbejegyzés (szülő üzenet nélkül indított szál) mostantól úgy értesít, mint egy csatornaüzenet: aki a csatornát „minden üzenet" módra állította, vagy akit megemlítettek benne, asztali, tálca- és Android-értesítést kap. Eddig senkit nem értesített. Szerver-telepítés szükséges.
- Android: a privát (titkosított) jegyzethez csatolt fájlok koppintásra nem csináltak semmit. Az app blob-letöltő kapcsolata újra lekérte a visszafejtett blobot, amit a CSP tilt; a jegyzetek mostantól közvetlenül az app mentő hídjának adják át a bájtokat, a fájlnév megtartásával. Csak webes változás, APK-újraépítés nem kell.

### 2026-11-11
#### Hozzáadva
- Android: az értesítési sávban lévő értesítések eltűnnek, ha a beszélgetést egy másik eszközön elolvasod. A PC-n olvasás felébreszti a telefont (UnifiedPush) vagy a következő háttérellenőrzést, ami leszedi az olvasási pozíciódig mindent; a lekérdezés mostantól az olvasási pozíciókat is visszaadja (`read`). Szerver-telepítés és új APK szükséges.

#### Javítva
- Értesítés-lekérdezés: a szálválaszt a szál saját olvasási pozíciójához méri, nem a csatornáéhoz, így az olvasatlan válasz nem marad ki.
- Android: a PC-n (vagy bármely más eszközön) már elolvasott üzenetekről a telefon utólag, felzárkózáskor sem értesít többé. A szerver értesítés-lekérdezése kihagyja a csatorna- és DM-üzeneteket az olvasási pozíciódig; a kitűzés- és szál-események nem érintettek. Csak szerveroldali változás, APK-újraépítés nem kell.

### 2026-11-09
#### Hozzáadva
- C# asztali kliens (`ClientC#/`, WebView2 keret, egyetlen önálló exe, mellette létrejövő `data` mappával). Ugyanaz a webes felület és ugyanaz a `dismesh-client-config.json`, mint az Electron kliensnél; tálcaikon olvasatlan-villogással és legutóbbi listával, értesítések, letöltések tálcaállapottal, `mcr://` meghívó linkek, egy példány, tanúsítvány-rögzítés, bezárás a tálcára, és a lap felső sávja a címsor (minimalizálás/maximalizálás/bezárás ugyanabban a sorban). Az Electron marad a fő kliens.
- C# kliens: a WebView2 futtatókörnyezet beágyazható az exe-be (`ClientC#/bundle-webview2.ps1`, majd `dotnet publish`; az exe ~250 MB lesz). WebView2 nélküli gépeken egyszer kicsomagolja a `data/webview2-runtime` mappába; ahol van telepítve, azt használja.

### 2026-11-08
#### Javítva
- Asztali alkalmazás: a megnyitva hagyott csatorna, miközben az ablak a tálcára van rejtve vagy kis méretű, már nem számít "nézettnek", így az új üzenetei Windows-értesítést kapnak és megjelennek a tálca legutóbbi listájában. A tálca egy elemére kattintva az kikerül a listából, és pontosan arra az üzenetre ugrik. Az új asztali kliens-buildet igényli.
- Beépített ffmpeg futtatókörnyezet (`npm run fetch:ffmpeg`, a `runtime/ffmpeg/` mappába; a PATH-on lévő ffmpeg előtt ezt használja), így a videók indexképei ffmpeg telepítése nélkül is működnek a gazdagépen.
- A csatornákban közzétett videók csatornaváltáskor már nem töltődnek újra: a csatolmányok egy napig a böngésző gyorsítótárában maradnak, a videó pedig lejátszásig semmit sem tölt le. A szerver a videó első képkockáját indexképként állítja elő (ffmpeg kell a gazdagépen; nélküle a lejátszó üres marad, de semmi nem romlik el). A DM-videók titkosítva tárolódnak, ezekhez nincs indexkép.

#### Hozzáadva
- Asztali alkalmazás (Beállítások > Asztali alkalmazás): kapcsolók a megnyitott csatorna értesítéséhez, ha az app rejtett/kis méretű (be) vagy csak nincs fókuszban (ki), valamint beállítás arra, hány legutóbbi értesítést listázzon a tálcamenü (0-15, alapértelmezett 5). Csak a kliensben.
- Asztali alkalmazás: letöltésjelző a csatolmányokhoz (fájlonkénti folyamatjelző, megszakítás, Megnyitás és Megjelenítés mappában, tálcaikon-folyamat) és új Beállítások > Letöltések fül, ahol vagy minden fájlnál rákérdez a mentés helyére, vagy mindig egy választott mappába ment (Tallózás vagy beírt útvonal). Az új asztali kliens-buildet igényli.
- Automatikus távol státusz: Beállítások > Státusz (asztali) vagy Te > Állapot beállítása > Automatikus távol (Android) – a megadott tétlenségi idő után a státuszod Távol lesz, tevékenységre visszaáll Elérhetőre. A 0 kikapcsolja. Csak az automatikus váltást vonja vissza, a saját magad beállított státuszt soha.
- Csevegés betűtípusa és szövegmérete a témaszerkesztőben. Csak az üzenetek szövege és az üzenetmező változik, a felület nem. Csak rendszerbetűk.
- Android: az értesítések és az alkalmazás szövegei magyar fordítást kaptak (a telefon nyelvét követi).

#### Módosítva
- Weboldal és wiki (EN és HU): az összes képernyőkép újra készült a demóközösséggel, illusztrált, jogdíjmentes (CC0) avatarokkal és kameracsempékkel; új képek a hangeffekt-panelhez, az utolsó emojikhoz, a Mentés a jegyzetekbe funkcióhoz, a Küldés később ablakhoz, a névhatásokhoz és bioszerkesztőhöz, az automatikus távolléthez, az értesítési rácshoz, a csevegőbetűtípushoz, a tagonkénti korlátozásokhoz és a telefonos alkalmazáshoz. Mindkét bemutatóvideó újra felvételre került az új funkciókkal.
- A naplócsatornák automatikus eseményei (belépések, átnevezések stb.) csak olvasatlannak jelölik a csatornát. Csak azokat értesítik, akik a csatornát „minden üzenet" értesítésre állították, és az értesítés szövege most már lokalizált.

#### Módosítva
- Gyorsabb üzenetküldés, főleg forgólemezes lemezen: a szerver azonnal válaszol, amint az üzenet el van mentve és szét van küldve, az értesítési, Android-sor és bot munkát utána végzi (csatornákban, szálakban és privát üzenetekben); az SQLite `synchronous=NORMAL` módban fut (a commit nem vár lemezszinkronra; áramszünet esetén az utolsó pillanatok adatai elveszhetnek, de az adatbázis sosem sérül), a WAL ellenőrzőpontja időzítőről fut az üzenetküldés helyett; egy üzenet értesítési írásai egyetlen commitban vannak; a tagonkénti jogosultság-, némítás- és figyelmen kívül hagyás-lekérdezések üzenetenként egyszer futnak le tagonként kb. 15 helyett (300 tagú szerveren egy átlagos üzenetnél 73 ms helyett kb. 1 ms). A `scripts/bench-send.mjs` méri.

#### Javítva
- A hivatkozás-előnézetek sosem mutatták a képüket (pl. GitHub-linkeknél): az oldal CSP-je csak a saját eredetű képeket engedi, ezért a böngésző blokkolta a külső `og:image`-et. A képet most a szerver tölti le és szolgálja ki (`GET /api/link-preview/image`, csak bejelentkezett felhasználóknak, ugyanaz a privát címek elleni védelem, nincs átirányítás, PNG/JPEG/GIF/WebP legfeljebb 5 MB, SVG soha), asztali, webes és Android felületen.
- Asztali csevegés: az ablak átméretezése már nem tolja el a beszélgetést; az alja rögzített marad, vagy a látható üzenet a helyén marad.
- Asztali: az ugrás az utolsó üzenetre gomb minden csevegőnézetben (hangcsevegő, szálak) a csevegéshez és az üzenetmezőhöz igazodik.

### 2026-11-07
#### Hozzáadva
- Asztali, Electron és web: az emoji-választó a kategóriafülek alatt, mindig látható sorban mutatja az utolsó 10 választott emojit (közös előzmény az Android-alkalmazás legutóbbi listájával).
- Android: hangtár gomb az üzenetmezőben (szerverek csatornáiban és szálaiban): egy hangra koppintva hangüzenetként elküldődik (vagy lejátszódik a hívásban, ha azon a szerveren hangcsatornában vagy), a ▶ előhallgatja. A hangüzenetek mostantól lejátszó gombbal jelennek meg a mobilos csevegésben.
- Android: az Értesítések fülön a kuka gomb törli a teljes listát.

#### Javítva
- Android: a letöltött DM-mellékletek `<azonosító>.bin` néven mentődtek (egy APK nem telepíthető így), mert a szerver `filename*=UTF-8''…` fejlécéből a fájlnév elveszett; mostantól a valódi név kerül mentésre.
- Android: a letöltések némák voltak. Mostantól „Letöltés…” üzenet, folyamatjelző értesítés és „Letöltés kész” értesítés (új, alapértelmezett fontosságú csatornán) jelenik meg, hibánál pedig az okot mutató üzenet.
- Android: az offline gyorsítótár megújul (a gyorsítótár neve emelve), így a régi CSS-t és JS-t tartó telefonok az alkalmazásadatok törlése nélkül megkapják az új fájlokat.
- Az „Új üzenetek" vonal és az első olvasatlanra ugrás sosem jelent meg (asztali és mobil): a jogosultság-ellenőrzés a csevegés megnyitásakor 0-ra rögzült. Mostantól a megnyitáskor betöltött legújabb üzenetet használja, így a vonal azoknál az üzeneteknél jelenik meg, amelyek az eszköz offline ideje alatt érkeztek.
- Asztali: a beszélgetés a legújabb üzenetnél marad, amíg a képek és beágyazások betöltődnek (korábban az aljától elmaradva állt meg, nem ott, ahol abbahagytad), és kerek „Ugrás a legújabbhoz" gomb jelenik meg, ha el vagy görgetve az aljától.
- Jegyzetek: nagy fájl csatolásakor „Titkosítás…", majd feltöltési folyamatjelző látszik a piszkozatban ahelyett, hogy semmi sem történne; a mentés megvárja a feltöltés végét.
- Jegyzetek: a jegyzetek szövege újra kijelölhető és másolható asztali gépen.
- Android: a barátok gomb már nem mutat piros „0" jelvényt, ha nincs kérés.
- Android: a háttér-értesítések már nem jelentik be azokat az üzeneteket, amelyek az alkalmazás nyitva tartása alatt érkeztek (a lekérdezési kurzor a háttérbe váltáskor továbblép); az alkalmazáson belüli értesítési lista is kihagyja az éppen nézett beszélgetés üzeneteit.
- Android: az „Ugrás a legújabbhoz" mostantól kis kerek nyíl gomb a sarokban, a széles pirula helyett.
- Android: az animált néveffektek újra animálnak (a mobil és a közös csevegő stíluslapból is eltávolítottuk a csökkentett mozgás szabályát; a telefon mindkettőt betölti).
- A kitűzött üzenetek listája (asztali panel, fórumszál-panel és mobil Infó > Kitűzöttek) élőben frissül, amikor egy üzenetet kitűznek vagy levesznek.

### 2026-11-06
#### Eltávolítva
- A végpontok közötti titkosított DM-ek megszűntek: a beszélgetésenkénti „titkosítás bekapcsolása", a ratchet, a biztonsági számok / ellenőrző lapok, a titkosított DM-fájlok és az „Az üzenet nem fejthető vissza" állapot. Ezzel megszűnnek azok a hibák is, hogy a saját titkosított üzeneteid nem voltak visszafejthetők, és hogy a DM-értesítés beragadt, ha egy beszélgetést titkosításra váltottál. A meglévő végpontok közötti titkosított DM-előzmények csak a kliensek által olvasható titkosított szöveg volt, ezért a szerver a következő indításkor törli őket (egyszeri migráció). Az útleveled és a titkosított Jegyzet csatornák változatlanok. A DM-ek újra hagyományos üzenetek, így a szerkesztés, továbbítás, szavazás, időzítés, keresés, botok és csatolmányok minden beszélgetésben működnek.
- Az üzenetek „Megjelölés olvasatlanként" funkciója megszűnt (asztali menü és mobil lap): a megnyitott beszélgetés olvasottnak számít, így az olvasatlan vonal megjelenése után azonnal eltűnt. Használj könyvjelzőt vagy emlékeztetőt.

#### Javítva
- Fórumbejegyzések: a megnyitott bejegyzésben a kitűző gomb mostantól mutatja a piros „új kitűzés" pontot, ha valaki kitűz egy üzenetet, és a pont eltűnik, ha megnyitod a kitűzöttek listáját.
- Hangtár normál csatornákban és szálakban: egy hang kiválasztása most lejátszható hangüzenetként kerül a csatornába (kattintásra mindenkinek szól), ahelyett hogy semmit sem csinálna. Ugyanazon a szerveren hívásban továbbra is a szobának szól.
- Szövegkijelölés és kurzorok: csak az üzenetszöveg, a beviteli mezők, a kód és a profilszövegek jelölhetők ki (nem lehet többé avatárt, képeket, menüket és gombokat kijelölni), a menük és gombok pedig már nem mutatják a szövegkurzort.

#### Hozzáadva
- Jegyzetcsatornák: emoji-választó gomb az üzenetmező mellett.
- Jobb kattintás egy üzenetre > „Mentés a Jegyzetekbe" a szövegét átmásolja az egyik Jegyzetcsatornádba (több csatorna esetén almenü jelenik meg), a feladóval és az idővel. A jegyzetben erre a sorra kattintva az eredetire ugrasz; ha törölték, felugró ablak jelzi, a mentett másolatod megmarad. Egyelőre csak asztali gépen.
- Szerverenkénti tagkorlátozások: a moderátorok (Tagok moderálása) letilthatják egy tag saját névszínét, néveffektjeit, matricáit vagy bio-formázását, csak az adott szerveren (szerverbeállítások > Tagok > tagmenü > Korlátozások). A korlátozott nevek mindenkinek egyszerűen látszanak azon a szerveren, a bio sima szövegként jelenik meg a kártyán, a matricaküldést pedig elutasítja. A módosítások bekerülnek a naplóba. Más szervereket és privát üzeneteket nem érint.
- Beállítások > Hang és videó: mások hangtár-hangjainak némítása vagy hangerejük csökkentése (hívások és hangüzenetek, csak ezen az eszközön). A hangtár felugró ablakában gyors némítógomb is van ugyanehhez a beállításhoz.
- Bemutatkozás-szerkesztő: emoji-választó gomb a formázósávban.
- `/wipe <szám>` (csak adminoknak: oldal- és szerveradminisztrátorok): törli az aktuális csatorna utolsó N üzenetét (legfeljebb 1000), a fájlokkal együtt.
- Helyi szerverkonzol: a `purge` gyári állapotba állítja a szervert (fiókok, szerverek, üzenetek, privát üzenetek, feltöltések). Kell hozzá a `purgePassword` a `data/config.json`-ban és a `PURGE` beírása; előtte biztonsági mentést készít, megtartja a config.json-t, a tanúsítványokat és a mentéseket, majd újraindul. A `ban`, `unban`, `ipban`, `ipunban` és `ipbans` már korábban is léteztek.
- Asztali alkalmazás: a Beállítások > Asztali alkalmazás alatt kapcsolóval ki-be kapcsolható az F11 teljes képernyős gyorsbillentyű.
- Admin panel jelentések: a jelentett felhasználó szerint csoportosítva, Függőben / Megoldott / Elutasított / Mind fülekkel. A függőben lévő jelentés szerkeszthető marad (ok, csak adminoknak látható jegyzetek); a megoldás vagy elutasítás rögzíti, ki és mikor tette, a lezárt jelentés újranyitható, és jelentést csak megoldott vagy elutasított állapotban lehet törölni (a „Lezártak törlése" ezt tömegesen végzi, felhasználónként vagy mindenkire; a függőben lévőkhöz sosem nyúl).
- Admin panel felhasználók: a felhasználói menü „Normál felhasználó (nincs stábszerep)" pontja egyszerre elvesz minden stábszerepet, a stábszerep nélküliek pedig „Normál felhasználó"-ként látszanak.
- Névszín: mindenki beállíthatja a saját névszínét (előre megadott színek és szabad színválasztó) a Beállítások > Fiókom oldalon és a telefonos profilszerkesztőben. A szerver szerepkörének színe szerveren mindig erősebb, a moderátor által adott tagonkénti szín továbbra is mindkettőt felülírja, privát üzenetekben pedig a személyes szín látszik.
- Néveffektek: a névszín mellett mindenki animált szövegeffektet adhat a saját nevének (szivárvány, színátmenet, ragyogás, neon, pulzálás, csillogás, tűz, hullám; a csökkentett mozgást kérőknél kikapcsolva), élő előnézettel. A profilkártya mindig a saját színedet és effektedet mutatja. Szerveren a szerepkör színe (vagy a moderátortól kapott szín) elrejti az effektet és a személyes színt; színes szerepkör nélkül a saját megjelenésed látszik. Privát üzenetekben mindig látszik.
- Néveffekt-szerkesztő: az „Az effekt testreszabása" alatt saját színeket (legfeljebb ötöt; két szín a teljes szivárvány helyett kétszínű átmenetet ad) és ciklusonkénti sebességet választhatsz élő előnézettel, a Beállítások > Fiókom oldalon és a telefonos profilszerkesztőben.
- Szerepkör-effektek: a szerver szerepköre animált néveffektet kaphat (ugyanazok az effektek, színek és sebesség) a Szerverbeállítások > Szerepkörök alatt; akiknek ez a legmagasabb színes szerepkörük, azok kapják ezen a szerveren a nevükön, és a szerepkör mindig erősebb a személyes effektnél.
- Hangtár: az üzenetmező hangjegy gombja minden szerveres csatornában listázza a szerver hangjait; egyre kattintva te hallod, vagy az egész szoba, ha a szerveren hanghívásban vagy.
- Emoji, matricák és hangok: tömeges feltöltés (több fájl kijelölése, a nevek a fájlnevekből készülnek és egyediek lesznek) és kattintásos átnevezés a Szerverbeállításokban.
- Időzített üzenetek: a szerkesztő mutatja az időzónádat, élő „küldés ... múlva" sort, több gyorsválasztót (3 óra, ma este), karakterszámlálót és ellenőrzést, a függőben lévő időzített üzenet pedig szerkeszthető (szöveg és idő) a listából.
- Az Electron jobb gombos menüje (Kivágás, Másolás, Beillesztés, ...) az alkalmazás nyelvét használja.
- A privát üzenetek mellékletei is titkosítva tárolódnak: a fájlok feltöltés közben lezárásra kerülnek (64 KiB-os AES-256-GCM darabok, így a hang és a videó továbbra is tekerhető), véletlen néven tárolódnak, és csak a beszélgetés tagjainak (vagy azoknak szolgálnak ki, akik látnak egy továbbító üzenetet) jönnek le; a nevük, a szavazási opciók és a föderációs sorban álló privát események is lezárva tárolódnak. A meglévő privát fájlok és nevek a következő indításkor egyszer lezárásra kerülnek (nagy könyvtárnál néhány perc; előtte mentsd a `data/` mappát).
- Profil bio szerkesztő: félkövér, dőlt és szövegszín-paletta (meg egyéni szín) élő előnézettel, asztali gépen és mobilon. A bio továbbra is egyszerű szöveg egy apró jelöléssel (`**félkövér**`, `*dőlt*`, `[#rrggbb]szöveg[/]`), legfeljebb 200 karakter; a profilkártyák biztonságosan jelenítik meg.
- A DM-szöveg mostantól titkosítva van tárolva a szerveren: az üzenetszöveg, a hivatkozás-előnézetek, az időzített DM-ek és a DM-ekről sorban álló Android-értesítések AES-256-GCM-mel lezárva kerülnek az adatbázisba, a DM-szöveg pedig kikerül a keresési indexből (a DM-keresés visszafejti és átnézi a beszélgetés legutóbbi 5000 üzenetét). Ez az adatbázisfájlt, a mentéseit és az írási naplót védi; a futó szerver továbbra is olvassa a DM-eket (keresés, botok, moderációs jelentések). Nem kell hozzá beállítás, és minden beszélgetésben működik. A kulcs a `DISMESH_DM_KEY` (base64, 32 bájt), vagy ha nincs megadva, egy véletlen kulcs a `data/dm-at-rest.key` fájlban - **mentsd az adatbázissal együtt; nélküle a lezárt DM-ek nem olvashatók**. A frissítés utáni első indításkor a meglévő DM-ek egyszer lezárásra kerülnek, a keresési index megtisztul és az adatbázis tömörítve lesz (nagy adatbázisnál ez eltarthat egy ideig). Még nem fedett: a csatolmányok nevei és fájljai, a szavazások opciói és a föderált szerverekre továbbított üzenetek.

#### Javítva
- Egyetlen feltöltési korlát az egész szerverre: a `data/config.json` `maxUploadMb` értékét az Admin panel (Áttekintés > Melléklet-beállítások) és az SSH-konzol is ugyanazt szerkeszti, újraindítás nélkül azonnal érvénybe lép, és a felhasználók méretfigyelmeztetése ezt mutatja (a kliensek újracsatlakozáskor frissítik). Korábban az Admin panelnek volt egy második, csak csökkenteni képes korlátja, így a kettő eltérhetett. A régi Admin panel-korlát az első indításkor beolvad a konfigurációs értékbe. A Webhelyek PHP folyamataiban a feltöltés le van tiltva, ezért nincs külön korlátjuk.
- A megjelenített nevek minden írásrendszert, emojit és szimbólumot megtartanak, de kiszűrik a kinézetet vagy a logikát megzavaró karaktereket: vezérlő- és sortörő karaktereket, nulla szélességű és írásirányt váltó karaktereket, címke- és privát használatú karaktereket, árva helyettesítőket és néhány üresnek látszó kitöltőt; az egymásra halmozott kombináló jelek korlátozva vannak, és a 32 karakteres korlát egész karaktereket számol. A meglévő nevek a következő indításkor egyszer megtisztulnak.
- A szerversávból megnyitott szerver oda tér vissza, ahol abbahagytad (felhasználónként és szerverenként), nem az első csatornára.
- Az admin áttekintés statisztikái frissülnek, amíg a panel nyitva van, az üzenetszám pedig nem számolja a rendszeresemény-sorokat, így az üzenetek törlése csökkenti.
- Asztali alkalmazás: a jobb gombos menü (Kivágás / Másolás / Beillesztés / Összes kijelölése, helyesírási javaslatok, Másolás hivatkozásoknál) minden beviteli mezőben és bárhol kijelölt szövegen működik.
- A barátkérés elfogadása után a személy azonnal a barátlistára kerül asztali gépen és mobilon; mobilon az Üzenetek fülön a Barátok gombon jelvény látszik, amíg kérés vár.
- Mobil / Android: a képnézegető Mentés gombja most már működik az Android-alkalmazásban (az alkalmazás saját mentési útvonalára adja a képet, és „Mentve a Letöltések mappába" üzenettel jelez; az első változat egy hivatkozás-letöltésre támaszkodott, amit a WebView figyelmen kívül hagy).
- Mobil / Android: a képnézegető csípéssel és dupla koppintással nagyítható, húzható, van bezárás és Mentés gombja.
- A „Megjelölés olvasatlanként" azonnal megrajzolja az új üzenetek vonalát a megnyitott beszélgetésben (asztali és mobil); mobilon eddig eggyel későbbi üzenettől jelölt.
- A megjelenített nevek legfeljebb 32 karakteresek (regisztráció, profil, admin szerkesztés, föderált felhasználók), a beviteli mezők is ezt érvényesítik.
- Csatolmányok: a futtatható fájlok és szkriptek (exe, com, bat, cmd, ...) és a feltöltési korlát feletti fájlok feltöltés előtt érthető üzenettel elutasítva; a szerver a tiltott típust hibával utasítja el ahelyett, hogy csendben eldobná a fájlt és a csatolmány nélküli üzenetet közzétenné. Az /api/config már az érvényes korlátot adja.
- A feltöltés csatorna- vagy ablakváltáskor is folytatódik; visszatéréskor újra látszik az állapotával, és értesítést kapsz, ha kész vagy sikertelen. A feltöltésnek folyamatjelzője van, és megszakítható.

### 2026-11-05
#### Hozzáadva
- Értesítési rács: minden felhasználó állapotonként (Elérhető, Távol, Elfoglalt, Láthatatlan) és eseménytípusonként (privát üzenetek, privát említések, csatornaüzenetek, csatorna-említések, szálválaszok, hívások, barátkérések, kitűzések és emlékeztetők) maga dönti el, hogy szól-e hang, megjelenik-e felugró ablak, megjelenik-e a PC tálcáján, és riaszt-e Androidon. Beállítások > Értesítések asztali gépen és weben, a Te fül mobilon és az Android-alkalmazásban. Minden állapot szerkeszthető, az Elérhető is (figyelmeztetéssel „nem ajánlott", ha az Elérhető eltér az alapértékétől), a „Másolás innen…" egy másik állapotot másol át, és van visszaállítás gomb állapotonként és az összesre. A szerveren tárolódik, így minden eszközödre követ. A némított szerverek és csatornák továbbra is némák maradnak. Az alapértékek a régi viselkedést adják (Elfoglalt és Láthatatlan néma, a többi bekapcsolva).
- Biztonság: a regisztrációhoz mostantól alapból mindig captcha kell. Admin panel > Biztonság > Captcha külön módot ad a bejelentkezésre (alapérték: sikertelen próbálkozások után) és a regisztrációra (alapérték: mindig), mindkettő Soha / Sikertelen próbálkozások után / Mindig, a régi közös mód és a „Hol" jelölőnégyzetek helyett; a mentett beállítások automatikusan átállnak. A bejelentkezési és a regisztrációs hibákat a captcha külön számolja, így a sikertelen bejelentkezések már nem váltanak ki captchát regisztrációkor, és fordítva; a sikertelen bejelentkezés miatti IP-tiltás továbbra is mindkettőt számolja.
- Android-alkalmazás: háttérben „csatlakoztatva" előtér-szolgáltatás fut (CPU- és Wi-Fi-zárral), így a websocket kapcsolat néhány perc után nem szakad meg, és az alkalmazás már naprakész, amikor visszatérsz.
- Mobil oldal: a profilkártya mostantól megegyezik az asztali kártyával (borító, állapotpont, bot jelvény, szerverrang és névszín, közös szerverek, bio helyőrző).

#### Módosítva
- Az egyetlen értesítési hang legördülő (Beállítások és az egyéni állapot párbeszédablak) helyét a rács veszi át. Akik „mindig" vagy „soha" értéket választottak, automatikusan a nekik megfelelő rácsot kapják, így a hangok viselkedése nem változik. Az androidos riasztások is követik a rácsot: ha az aktuális állapot Android cellája ki van kapcsolva, a szerver már nem küldi el a riasztást.
- Mobil oldal: a piros offline sáv csak 6 másodperc kapcsolat nélküli idő után jelenik meg, és az alkalmazásba való visszatéréskor a listák és a megnyitott csevegés azonnal újratöltődnek HTTP-n, nem várva a websocketre.
- A mobil emoji-választó minden választás után nyitva marad (több emoji is hozzáadható), és csak bezáráskor csukódik be.

#### Javítva
- Biztonság: a feliratkozott IP-tiltólisták (FireHOL level 1, Spamhaus, Tor) már nem tiltják a privát, loopback, link-local és carrier-grade NAT címeket (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10). A FireHOL level 1 tartalmazza ezeket a tartományokat, ezért bekapcsolása kizárt mindenkit, aki LAN-on, VPN-en vagy reverse proxy mögött volt, az admint is. A kézi tiltások rájuk továbbra is érvényesek.
- A bejelentkező és regisztrációs oldalak görgethetők, ha magasabbak az ablaknál (a mobil oldal és az Android-alkalmazás kis képernyőn levágta az aljukat, pl. a captchát és a gombot), a kártya felett és alatt némi ráhagyással minden platformon.
- Szerverbeállítások: új szerverikon kiválasztásakor az azonnal megjelenik előnézetként, ahelyett hogy a feltöltés végéig nem látszana semmi.

### 2026-11-04
#### Hozzáadva
- A hanghívások beállítás nélkül, közvetlenül csatlakoznak LAN-on és privát VPN-eken (Radmin, ZeroTier, SoftEther, Hamachi): a közvetlen utat a STUN/TURN mellett párhuzamosan próbálja, és a legjobban működőt használja, a STUN/TURN automatikus tartalékkal weben, asztali gépen és Androidon. Opcionális `lanNetworks` beállítás (CIDR-ek JSON listája, pl. `["26.0.0.0/8","192.168.3.0/24"]`; a konzolban `config set lanNetworks ...`) kihagyja a kósza adaptereket (Docker, WSL), így a VPN-hívás gyorsabban létrejön; alapból üres.
- Admin panel > Hívások: új „LAN / VPN hálózatok" mező a `lanNetworks`-höz (soronként egy CIDR, példákkal Radminhoz, Hamachihoz, ZeroTierhez) és egy „Hogyan csatlakozik a hang" súgódoboz, amely elmagyarázza a közvetlen, STUN és TURN útvonalakat és a külső szerverek címének megadását.
- `scripts/tour/voice-ice.mjs` végpontok közötti ellenőrzések (böngészős peerek közvetlenül, erőltetett TURN relé, lanNetworks tartalék, böngésző–Electron, az Electron megjegyzi a maximalizált ablakot) és `scripts/tour/voice-ice-android.mjs` (Android emulátor és asztali peer).
- A hangminőség-pont tippje mostantól megmondja, hogyan jut el a hang (közvetlen LAN/VPN, NAT/STUN-on át, vagy továbbítva/TURN); az asztali kliens itt a gép hálózati adaptereit is felsorolja.

#### Módosítva
- A README.md a lényegre rövidült: a weboldalra és a wikire mutat, és egyértelműen kimondja, hogy a futtatókörnyezetek (Node, PHP, Electron, node_modules, APK-k) csak a Releases-ben vannak, a forrásból futtatás lépéseivel. A szerver „PHP nem érhető el" naplósora most megmondja, honnan szerezhető PHP.
- Android-alkalmazás 3.16 és újraépített asztali kliens (hang ICE és ablakállapot változások). A wiki (EN és HU) dokumentálja a csatlakozási útvonalakat, a `lanNetworks` beállítást és az asztali ablak megjegyzését.

#### Javítva
- Asztali kliens: „indítás kicsinyítve" beállítással és megjegyzett maximalizált ablakkal az ablak maximalizáltan jelent meg induláskor, ahelyett hogy a tálcára / tálcasávra ment volna. A maximalizálás mostantól csak akkor érvényesül, amikor az ablak először kerül vissza (tálcakattintás, dupla kattintás).
- Hang: az ajánlat/válasz előtt érkező ICE-jelöltek csendben elvesztek, ami hang nélküli hívást eredményezhetett; mostantól visszatartja és alkalmazza őket. A megszakadt kapcsolatot ICE-újraindítással próbálja újra (legfeljebb 3-szor), mielőtt a peert lezárná, ahelyett hogy azonnal bezárná.
- Az asztali kliens megjegyzi a maximalizált ablakot: ha maximalizálva zártad be, legközelebb is maximalizálva indul, nem a kisebb alapméretben. A normál (nem maximalizált) méret megmarad a visszaállításhoz.

### 2026-11-03
#### Hozzáadva
- A mobil oldal és az Android-alkalmazás az első látogatás után kapcsolat nélkül is működik: az utoljára megnyitott 8 szerver részletei (csatornák, rangok, tagok) is megmaradnak, így a csevegéseik offline is megnyílnak a gyorsítótárazott üzenetekkel. Az alkalmazás indulása már nem vár a nyelvlistára, ha a hálózat halott (2 másodperces korlát).
- Mobil oldal és Android-alkalmazás: az utoljára megnyitott 8 csevegés legújabb üzenetei az eszközön maradnak, és a csevegés újranyitásakor azonnal megjelennek, majd lecserélődnek a friss oldalra (a gyorsítótárazott másolat törlődik, ha elvesztetted a hozzáférést). A titkosított beszélgetések soha nem tárolódnak. A kijelentkezés vagy a lejárt munkamenet törli.
- A titkosító könyvtár (libsodium) mostantól csak a titkosítás első használatakor töltődik be, nem minden oldalindításkor, így a web és a mobil oldal gyorsabban indul.
- Gyorsabb indulás a mobil oldalon és az Android-alkalmazásban, főleg mobilhálózaton: (1) egy service worker (`web/sw.js`) a statikus fájlokat (szkriptek, stílusok, betűtípusok, nyelvfájlok, ikonok, emoji) gyorsítótárból szolgálja ki, és a háttérben frissíti; az API-hívásokat, a websocketet és a privát mellékleteket soha nem gyorsítótárazza; https-t (vagy localhostot) igényel, így a sima http szerverek kihagyják. (2) A munkamenet-ellenőrzést, az összes listát és a nyelvfájlokat most egyszerre kéri le, nem egymás után. (3) Az utolsó ismert szerverek, beszélgetések, barátok és beállítások az eszközön maradnak, és a következő indításkor azonnal kirajzolódnak, majd friss adatra cserélődnek; offline módban a gyorsítótárazott nézet marad, a kijelentkezés vagy a lejárt munkamenet törli. Az üzenetek még nincsenek gyorsítótárazva.
- Némítás és némítás feloldása a jobb gombos menüből: kattints jobb gombbal egy csatornára az oldalsávban a Csatorna némítása (15 perctől örökre) / Csatorna némításának feloldása menüponthoz, harang ikonnal és a hátralévő idővel; a némított csatornákon kis némított harang látszik. A szervermenü Szerver némítása / feloldása pontjai ugyanilyen ikonokat kaptak.
- A szerver hibaüzenetei (rossz jelszó, érvénytelen meghívó, jogosultságok, korlátok és más, kb. 330 darab) mostantól le vannak fordítva: az alkalmazás minden szerverüzenetet a választott nyelvre képez le a `lang/*.json` új `apiErrors` szekcióján keresztül (angol és magyar); az ismeretlen üzenetek úgy jelennek meg, ahogy érkeztek. Web, asztali gép és Android esetén is.
- Android: az alkalmazásikon, az adaptív/témázott ikon és az értesítési ikon mostantól a szellem.
- Android: betöltőképernyő. Egy helyi indítóképernyő (szellem, „MeshCrowd - <szervernév> betöltése" és a 3D gyűrűs betöltő az asztali kliensből) azonnal megjelenik, amíg a szerver válaszol, szürke képernyő helyett; ugyanez a betöltő látszik az oldal indulása közben. Egy szellemes rendszer-indítóképernyő fedi a hidegindítást.
- Oldalbeállítások (Site): képet tölthetsz fel a Site ikonjának (vagy eltávolíthatod), kikapcsolhatod az ikon hátterét és kiválaszthatod a színét. A kép nélküli Site földgömböt mutat, a kiválasztott színen, ha van.
- Szerverikon háttere: a Szerverbeállítások > Áttekintés alatt kikapcsolhatod a szerverikon mögötti korongot (az átlátszó ikonok ekkor egyedül látszanak, rámutatáskor és kijelöléskor is), és kiválaszthatod a színét. Az ikon nélküli szerver mindig a kezdőbetűit mutatja a korongon, a kiválasztott színnel. A meglévő szerverek megtartják jelenlegi kinézetüket (háttér bekapcsolva). Web, asztali gép és Android esetén is.
- Hívások (STUN/TURN) dinamikus nyilvános IP-vel: az Admin panel > Hívások ütemezetten (alapból 5 percenként) újraolvashatja a WAN-címet a routertől UPnP-n, egy általad megadott STUN-szervertől, vagy egy általad megadott URL-ről, így nincs szükség harmadik félre. Változáskor az új cím az `externalIp`-be kerül, a régi `previousIp`-ként megmarad, és a beépített szerver újraindul; a privát/CGNAT eredményeket elutasítja. Új `turn.autoIp*` beállítások, „Mentés és ellenőrzés most" gomb és állapotsor.
- Eszközök (Beállítások > Eszközök, Android Te fül): felsorol minden böngészőt és alkalmazást, amely be van jelentkezve a fiókodba (eszköz, IP, utolsó aktivitás, bejelentkezés ideje), és bármelyiket kijelentkeztetheted, vagy az összes többit; a visszavont eszköz azonnal kijelentkezik és élő kapcsolata megszakad.
- Admin panel > Szerverek: minden szerver tulajdonossal, tagokkal és létrehozási dátummal; azonnali törlés (megerősítéshez be kell írni a nevet) vagy időzített törlés órákban vagy napokban, futásig visszavonható. Egy háttérfolyamat hajtja végre az esedékes törléseket.
- „Egyéni állapot eltávolítása" elem az avatar állapotmenüjében (web, asztali gép és Android), amíg egyéni állapot be van állítva.
- Az eszközök kapcsolatmegszakadás után mindent újraszinkronizálnak, így az offline közben történt változások a frissítés gomb megnyomása nélkül megjelennek.
- Wiki (EN/HU): dokumentálva az eszközök, az admin Szerverek fül, az egyéni állapot eltávolítása és az automatikus eszközszinkronizálás.
- Meghívó párbeszédablak és az Android „Meghívókód másolása": ha a szervernek van egyéni (vanity) linkje, kiválaszthatod, melyiket oszd meg (az egyéni előre kijelölve) vagy a véletlen kódot.
- Avatarháttér-színválasztó az „Avatar háttérszínének megjelenítése" jelölőnégyzet mellett (web, asztali gép és Android); a szín felhasználónként tárolódik, és mindenki látja.
- „Megtekintés idegenként" gomb a profilszerkesztőben és a profil-felugró „..." menüjében (web, asztali gép és Android): pontosan úgy mutatja a profilodat, ahogy egy nem barát látja, a privát mezők nélkül.
- Admin panel: bio szerkesztése a Felhasználó szerkesztése alatt (moderáció), és egy Jelenlét oszlop, amely megmutatja, hogy az egyes felhasználók éppen online vannak-e (a láthatatlanokat is, csak itt látható).
- Egyéni állapot emoji jelvény az avatarokon a tagok listájában, a privát üzenetek listájában, a barátlistában és a felhasználósávban; a teljes egyéni állapotszöveg is megjelenik a barátlistában és a felhasználósávban (Androidon a barátlistában és a profilban is).
- Kitűzés gomb pontja: valaki más új kitűzése pontot tesz a kitűzés gombra (és az Android beszélgetésinfó-gombjára), amíg meg nem nyitod a kitűzött listát; felhasználónként a szerveren megjegyezve.
- A teljes profil-felugróban a közös szerverek mostantól a szerverikonjaikat is mutatják.
- Élő szinkron eszközök és felhasználók között oldalfrissítés nélkül (web, asztali gép, Android): a visszavont, elutasított vagy eltávolított barátkérések, egy másik eszközön történt elfogadás vagy blokkolás, és a saját beállításaid egy másik eszközön történt módosítása (téma, oldalsáv szélessége, szervermappák, értesítési szintek, privát üzenet kitűzések, becenevek/jegyzetek, könyvjelzők) most helyben frissülnek; egy másik eszközön végzett nyelvváltás „újratöltés az alkalmazáshoz" értesítést mutat. Csak az érintett részek rajzolódnak újra, így a görgetés, a piszkozatok és a megnyitott panelek megmaradnak. A blokkolás és feloldása láthatatlan marad a másik fél számára.
- „Többi eszközöm frissítése" gomb (Beállítások > Fiókom, Android Te fül) megkéri a többi bejelentkezett eszközödet, hogy olvassák újra a listáikat és beállításaikat; az eszközök egy perc után, az ablak előtérbe kerülésekor is csendben újraszinkronizálnak.
- A bio 200 karakterre korlátozva (volt 500; Androidon 190): élő számláló a Bio felirat mellett a profilszerkesztőkben (web, asztali gép, Android) és az admin Felhasználó szerkesztése párbeszédablakban; a meglévő hosszabb biók a szerver indulásakor egyszer megrövidülnek, és a szerver minden mentéskor vág.
- Olvasatlan szálak: pont a csatorna Szálak gombján, amíg egy szálban van olyan üzenet másoktól, amelyet nem olvastál el, és minden olvasatlan szálon a szálak listájában (web, asztali gép és Android); a szál megnyitása törli, és felhasználónként a szerveren megjegyzi. A szálak mostantól olvasási pozíciót is tartanak, így az éppen nézett szál soha nem világít.
- Profilkártya: a közös szerverek sora mostantól kis szerverikonokkal végződik (kezdőbetűk, ha a szervernek nincs ikonja, legfeljebb 8 plusz egy „+N" számláló); rámutatáskor megjelenik a szerver neve, kattintásra megnyílik a szerver.
- Asztali kliens tálca: olvasatlan elemeknél az egész tálcaikon halványodik (oda-vissza 350 ms) a normál szellem és egy teljes méretű, színes, a darabszámot mutató korong között (9+ kilenc felett), sötét körvonallal a kontraszt miatt; ha minden elolvasott, visszatér a normál ikonra. A `Client/` mappában lévő hordozható kliens ezzel újraépítve.
- Egy csatorna privátra állítása vagy a jogosultság-felülbírálásainak módosítása azonnal elrejti vagy megmutatja azt az érintett tagoknak; az egyéni emoji, matricák, kirúgások és tiltások ellenőrizve lettek, és már eddig is élőben frissültek.

#### Javítva (konzol QA-találatok 2026-11-01-ről)
- SSH-n a `ban`, `account disable`, `account delete` és a saját konzol-jogosultságod eltávolítása a saját fiókodra el van utasítva, és a helyi konzolon kívül senki sem távolíthatja el az utolsó engedélyezett, konzolhozzáféréssel rendelkező fiókot.
- Az SSH-n elutasított csak-helyi parancsok (`account roleperm`, `backup restore`, `ssh ...`) mostantól azt mondják: „csak a helyi szerverkonzolon érhető el"; az ismeretlen parancsok továbbra is „úgy értetted" tippet kapnak, soha rejtett parancsot.
- A konzolparancsok auditsorai (tiltások, tiltásfeloldások, IP-tiltások, közlemények, konfigurációváltozások, biztonsági mentések) warn szinten íródnak, így túlélik a `logging.level warn` beállítást; az írásvédett parancsokat nem auditálja, a `config set` a kulcsot és az értékeket naplózza, és csak a titkos kulcsokat maszkolja.
- Az SSH-kliensek, amelyek jelszót és keyboard-interactive módot is kínálnak, már nem számítják egy rossz jelszót kétszer a kizárás felé.
- Az `ipban` már nem tárolja a `--yes`-t indoklásként; a `backup delete` a kérdezés előtt ellenőrzi a nevet; a `q` megnyomása a `stats watch` és a `log tail` alatt már nem visszhangzik a promptra.
- Android (`/m/`): a csatorna olvasatlan jelzője és a Szerverek fül jelvénye mostantól élőben frissül.
- Az olvasatlan vonal és az „N új üzenet" szalag magától eltűnik, ha a teljes hátralék már a képernyőn van.

#### Módosítva
- A privát üzenetek mostantól törölhetők: a „Beszélgetés törlése" (web, asztali gép, Android) egy 1:1 beszélgetést töröl neked. A másik személy értesül, hogy a beszélgetés le lett zárva, és megkérdezi, törölje-e ő is (a Mégse csak olvasható archívumként megtartja az előzményeket; a kérdés sávként is újra megjelenik), és a lezárt beszélgetésbe küldés elutasításra kerül. Ha mindkét fél törölte, az előzmények törlődnek, így az újbóli üzenetküldés friss beszélgetést indít (ez lehet újra titkosítatlan). A „Beszélgetés bezárása" továbbra is csak elrejti.
- Láthatatlan mód: nincs gépelésjelző, az olvasási visszaigazolások („Látta") láthatatlanság alatt nem lépnek tovább és utána is rejtve maradnak, nem látszik egyéni állapot, nem lehet privát hívással csengetni, és nem lehet csatlakozni hang- vagy színpadcsatornához, sem privát hívásba (a láthatatlanra váltás elhagyja az aktuális hívást). Az üzenetek továbbra is normálisan megérkeznek. Az Admin panel továbbra is a valódi online állapotot mutatja.
- A felső sávban lévő globális értesítési harang és az Android Értesítések fül mostantól beérkezett üzenetek ikont használ, így már nem néz ki úgy, mint a csatornánkénti értesítési beállítások harangja.
- A MeshCrowd logóra kattintás a szerversáv tetején (web és asztali gép) a Barátok fület választja ki; az üres „nincs kiválasztott beszélgetés" oldal mindenhol megszűnt (induláskor és szerver vagy csoport elhagyása után is).
- A profilszerkesztések (név, avatar, avatarháttér, borító, kártya, állapot) mostantól élőben eljutnak a többi felhasználóhoz és a saját többi eszközödre; a már kirajzolt üzenetek újrarenderelés nélkül, helyben frissülnek, így a görgetési pozíció és a piszkozatok a helyükön maradnak. A privát üzenet partnerek is megkapják a profilfrissítéseket.

### 2026-11-01
#### Hozzáadva
- Admin konzol: szöveges felület a szerverablakban (bejelentkezés nélkül, helyi), és opcionálisan SSH-n (`ssh.enabled`, alapból localhost:2222, saját gazdakulcs, jelszó plusz TOTP, kizárás és sebességkorlátok). A `help` listázza a parancsokat.
- Konzolparancsok: `account` (list, info, create, passwd, delete, disable, enable, roles, grant, revoke), `ban`/`unban`/`kick`, `ipban`/`ipunban`, `config` (list, get, set, reset, path, ellenőrzéssel), `backup` (create, list, delete, verify, keep, auto, restore), `server stop|restart|cancel` visszaszámlálással, `status`, `list`, `stats` (és `stats watch`), `announce`, `log` (tail, show, level, files), `ssh status|kick`.
- **Konzol kezelése** oldaljogosultság (SSH-konzol hozzáférés; a Tulajdonosnak megvan, az Oldaladminisztrátornak önmagában nincs).
- Biztonsági mentések: zip archívumok a `data/backups/` mappában adatbázis-pillanatképpel, konfigurációval és kis médiával, manifest hash-ekkel, `backup.keep` megőrzéssel, napi ütemezéssel és visszaállítás előtti másolatokkal. A visszaállítás csak helyi, és újraindítja a szervert.
- Szintezett naplózás (`debug`/`info`/`warn`/`error`) a `data/logs/` mappába napi fájlokkal, méret szerinti rotációval és kor szerinti törléssel (`logging.level`, `logging.keepDays`, `logging.maxFileMb`); naplózott események: bejelentkezések, sikertelen bejelentkezések és 2FA-hibák IP-vel, regisztráció, jelszóváltoztatások, admin fiók- és rangműveletek, tiltások és automatikus tiltások, konzolparancsok, indítási szalagcím, föderációs munkafolyamat-hibák. A jelszavak, tokenek, kulcsok és üzenettartalom soha nem kerülnek naplózásra.
- Wiki és dokumentáció: konzol, SSH (PuTTY-lépések), biztonsági mentések és naplózás az Adminisztrációban (EN/HU), `ssh`, `backup` és `logging` kulcsok a Konfigurációban.

#### Módosítva
- A MANAGE_CONSOLE nélküli Oldaladminisztrátorok már nem szerkeszthetik, tilthatják le vagy állíthatják vissza a Tulajdonos rangú felhasználókat, és nem szerkeszthetik magát a Tulajdonos rangot (az Admin panel a 403-as üzenetet mutatja).
- Frissített telepítések: az egyszeri migráció mostantól az első fiók Tulajdonos rangját a létrehozás módja alapján találja meg, és minden oldaljogosultságot megad neki, a MANAGE_CONSOLE-t is (a régebbi Tulajdonos rangokból hiányoztak a későbbi jelzők). Az `account roleperm <rang> +console|-console` a szerverablakban minden más esetet megjavít.
- Az `account create`, `account passwd` és `config set <titkos kulcs>` után beírt beágyazott titkok már nem kerülnek a konzol parancselőzményébe.
- A `start-server.bat` szándékos leállítás (0-s kilépési kód) után bezárja az ablakot, hibáknál megtartja a szünetet.
- A `start-server.bat` és a `start-server.sh` felügyelő hurkot futtat, így a `server restart` visszahozza a szervert (42-es kilépési kód); az `npm start` ugyanezt teszi.
- A leállítás sorrendezett, komponensenkénti időkorlátokkal és őrkutyával; a visszaszámlálás alatti jelzések azonnal hatnak.
- A föderációs szívverés és a kimenő sor munkafolyamatának hibái a naplófájlokba kerülnek, nem csak a konzolra.

#### Ismert problémák
- Kézzel még nem ellenőrizve: nyilvános kulcsos bejelentkezés SSH-n, a helyi terminálkonzol és a `start-server.bat` újraindítási hurok Windowson (a felügyelői újraindítás SSH-n ellenőrizve lett). A TOTP SSH-n tesztekkel le van fedve.
- Nyitott döntés: az SSH-bejelentkezés a megerősített (osztott) bejelentkezésű fiókoknál a nyílt jelszót a titkosított SSH-csatornán belül küldi; a külön, csak konzolhoz használt jelszó az alternatíva.

### 2026-10-31
#### Build
- Android APK 3.14 (versionCode 17) elkészült (AndroidReleases/MeshCrowd-3.14.apk); a hordozható asztali kliens újraépítve az electron/ könyvtárból (csomagverzió 0.9.0, a szállított fájlok nem változtak).

#### Hozzáadva
- Az átlátszó részeket tartalmazó profilképek mögött már nem látszik az avatar háttérszíne (web, asztali gép és Android, mindenhol, ahol avatar megjelenik); a profilszerkesztőben az avatar melletti új „Avatar háttérszínének megjelenítése" jelölőnégyzet visszakapcsolja a színes kört (alapból ki, élő előnézet, szinkronizálva a többi felhasználóval); a feltöltött kép nélküli avatarok megtartják a színes kezdőbetűs kört.
- Közös táblarajz színpadcsatornákhoz és szerver hangcsatornákhoz (web, asztali gép és Android): panel tollal (fekete, fehér, piros, narancs, sárga, zöld, kék, lila), három vonalvastagsággal, radírral és mindent törlővel, egérrel, érintéssel vagy tollal rajzolható és bármilyen képernyőméretre skálázva. Színpad: a felszólalók (és a Csatornák kezelése jogosultsággal rendelkezők) rajzolnak, a közönség nézi, és a tábla alapból nyitva van; hangcsatorna: minden résztvevő rajzolhat, és a tábla magától megnyílik, ha valaki rajzol. A híváson belül mindenki élőben látja a vonásokat, a később csatlakozók megkapják az aktuális táblát, és a hívásvezérlők egyik gombja csak neked rejti el vagy mutatja. A mindent törlés a Csatornák kezelése jogosultsággal rendelkezőknek (és a színpad felszólalóinak) való. A vonások kis, szabályozott websocket kötegekben utaznak, amelyeket a szerver validál (paletta- és vastagság-fehérlista, koordináták 0..1, méret-, sebesség- és jogosultsági korlátok), és csak memóriában tart (legfeljebb 400 vonás), az utolsó résztvevő távozásakor eldobja. Új tiszta modulok: server/lib/whiteboard.js és web/js/whiteboardMath.mjs egységtesztekkel.
- Vágószerkesztő a profilképhez, a profil fejléchez és a profilháttérhez (web, asztali gép és az Android profilkép): egy kép kiválasztása vágóablakot nyit húzható kerettel, átméretező fogópontokkal, nagyítás-csúszkával, „Képarány megtartása" kapcsolóval (alapból be, megfelel az avatar körének, a 340x110-es fejlécnek és a kártya törzsének; kikapcsolva szabad vágás), nyílbillentyűs finomhangolással (a Shift+nyíl átméretez, az Enter alkalmaz, az Esc megszakít), és élő előnézettel arról, amit a kártya pontosan mutatni fog. A kivágott kép le van kicsinyítve (avatar 512 px, fejléc és kártya legfeljebb 680 px széles), megtartja a PNG átlátszóságát, és a szokásos végpontokon töltődik fel, így a szerver korlátai továbbra is érvényesek; GIF esetén van „Eredeti megtartása (animált)" gomb, mert a vágás ellapítja az animációt. Új, függőségmentes tiszta modul: web/js/cropMath.mjs egységtesztekkel; az automatikus fókuszvisszaadó segéd mostantól csak a legfelső párbeszédablakot veszi figyelembe, így nem veheti el a fókuszt a szerkesztőtől.
- Értesítés, ha valaki kitűz egy üzenetet: mindenki, aki látja (csatorna, szál vagy privát üzenet), a kitűzőt kivéve, megkapja a „<felhasználó> kitűzött egy üzenetet itt: #csatorna" értesítést a harangpanelben, az asztali tálca listájában, a rendszerértesítésekben és az Android háttérellenőrzésében; csak azok a tagok kapnak értesítést, akik az adott csatornából/privát üzenetből minden üzenetet megkapnak (a csak-említések és némított tagok, valamint a figyelmen kívül hagyott felhasználók kimaradnak). Kattintásra a kitűzött üzenethez ugrik. Az újrakitűzés vagy a kitűzés megszüntetése néma.
- Értesítés, ha egy üzenetből szál indul: annak az üzenetnek a szerzője (nem az indító, és nem akkor, ha a saját üzenetén indítasz szálat) megkapja a „<felhasználó> szálat indított az üzenetedhez" értesítést, linkkel, amely megnyitja a szálat, ugyanazon a harangon, tálcán, rendszeren és Android-kézbesítésen át; a némított csatornákat és a figyelmen kívül hagyott felhasználókat tiszteletben tartja.
- „Az új üzenetek vonalának mindig megjelenítése" beállítás (Beállítások > Megjelenés weben/asztali gépen/Androidon, plusz egy sor az Android Te fülön; felhasználónként tárolva a többi olvasatlan beállítással). Alapból ki: a piros vonal, az „N új üzenet óta" szalag és az ugrás gombja csak azokra az üzenetekre jelenik meg, amelyek akkor érkeztek, amikor az eszköznek nem volt kapcsolata. Bekapcsolva visszaáll a régi viselkedés (bármely olvasatlan üzenet).
- Fórumok: a bejegyzések mostantól szerkeszthetők (cím és nyitó üzenet, csak a szerző) és törölhetők (a szerző, az Üzenetek kezelése jogosultságúak, vagy az oldalszemélyzet a Bármely üzenet törlése jogosultsággal). Asztali/web: szerkesztés és törlés gombok a bejegyzés panelen és a bejegyzés fejlécében; Android/mobil: „..." menü a bejegyzés fejlécében. Az auditnapló rögzíti a törléseket; a többi néző élőben látja a változást.
- A szerversáv tetején lévő szellem logó (Kezdőlap) mostantól olvasatlan jelvényt és az olvasatlan privát üzenetekkel rendelkező beszélgetések számát mutatja, amely olvasáskor csökken (web és asztali gép; Androidon az Üzenetek fül már mutatja a számot).

- Matricák privát üzenetekben és csoportos csevegésekben (web, asztali gép és Android): a matricagomb mostantól minden szerkesztőben az emoji gomb mellett van, Androidon a szálakban és fórumbejegyzésekben is. Privát üzenetben mindazon szerverek matricáit használhatod, amelyeknek tagja vagy (a választó szerverenként csoportosítja őket); szerveroldalon ugyanez a szabály érvényes, így egy elhagyott szerver matricája el lesz utasítva. A végpontok közötti titkosított privát üzenetekben a matricahivatkozás a titkosított üzenetben utazik (a szerver soha nem látja, melyik matricát küldték, csak a szokásos képlekérés történik); a föderált privát üzenet a matricát képmellékletként kézbesíti. A matricák megjelennek az üzenetlistákban, a válaszidézetekben, továbbításokban, keresési eredményekben, kitűzésekben, könyvjelzőkben, privát üzenet előnézetekben („Matricát küldött"), az alkalmazáson belüli/asztali/rendszerértesítésekben és az Android háttérértesítéseiben. A matricás üzenet a szövegének szerkesztésekor is megtartja a matricát (a szöveg kiüríthető). Nem érhető el a föderált (távoli szerveres) csatornákon, amelyek nem tudják szállítani őket.

#### Javítva
- Asztali gép: az értesítések már nem maradnak a tálcán, miután elolvastad az üzeneteket. A tálca „Legutóbbi" listája és a csatornák/privát üzenetek/barátkérések rendszerfelugróit eltünteti, amint már nem olvasatlanok (az alkalmazásban vagy másik eszközön olvasva), amikor fókuszált ablakkal megnyitod, és az egész lista törlődik, amikor az ablak fókuszt kap és nincs olvasatlan; nem kell megnyitni a tálcamenüt a törléshez. Android: az alkalmazás megnyitása törli az üzenetértesítéseket az értesítési sávból.
- Asztali gép: az olvasatlan tálcaikon mostantól sokkal jobban látható, az ikon magasságának több mint felét kitöltő jelvénnyel (volt kb. harmad), nagyobb számjegyekkel és fehér körvonallal; a normál ikon változatlan.
- A `#csatorna` az üzenetekben mostantól a csatornára hivatkozik weben, asztali gépen és Androidon: a nevek kis- és nagybetű-függetlenül illeszkednek az adott szerveren látható csatornákhoz, az ékezetes vagy szóközös nevekkel együtt (korábban csak ASCII szavak), az ismeretlen nevek egyszerű szövegként maradnak, a linknek van rámutatási/képernyőolvasós felirata és billentyűzettel is használható, Androidon pedig a megérintése megnyitja a csatornát (a hang-, fórum- és jegyzetcsatornák a saját képernyőjüket nyitják).
- A privát üzenetek olvasatlan jelvénye már nem ragad be: egy privát üzenet másik eszközön való elolvasása itt is törli, a lezárt (rejtett) beszélgetés már nem tartja bekapcsolva a tálca/favicon/lap jelvényt, az újracsatlakozás frissíti az olvasási jelzőket, Androidon pedig a saját elküldött üzeneteid és egy törölt legújabb üzenet már nem hagyja olvasatlannak látszani a privát üzenetet.
- Az üzenetbeviteli mező mostantól megtartja a fókuszt küldés után (Enter vagy küldés gomb), emoji, matrica vagy reakció kiválasztása után, a választók bezárása után, a szerkesztés befejezése és a jegyzet mentése után, csatornákban, privát üzenetekben, szálakban, fórumbejegyzésekben és jegyzetekben weben, asztali gépen és Androidon. A fókuszt nem veszi el másik szövegmezőtől vagy nyitott párbeszédablaktól.
- Alkalmazásszinten: egy közös kezelő (web/js/autoRefocus.js, Androidon is) visszaadja a fókuszt abba a szövegmezőbe, amelybe írtál, az Enter vagy a mellette lévő küldés/mentés/közzététel jellegű gomb után, még akkor is, ha a képernyő újrarajzolta a mezőt (keresőmezők, gyorsválaszok, soron belüli átnevező/szerkesztő beviteli mezők, nyitva maradó űrlap-párbeszédablakok).
- A piros „új üzenetek" vonal és szalag már nem jelenik meg olyan üzenetekre, amelyek akkor érkeznek, amikor a csatornát, szálat vagy privát üzenetet éppen nézed (korábban akkor bukkant fel, ha az olvasási jelző régebbi volt az új üzenetnél).
- A piros vonal és a szalag mostantól eltűnik, amint az új üzenetek aljára görgetsz, weben, asztali gépen és Androidon, ahelyett hogy a távozásig megmaradna.
- Fórumok: egy bejegyzés válaszszáma mostantól mindenkinél élőben frissül, ha egy választ törölnek, és az újonnan létrehozott bejegyzés már nem mutat 2-es számot a többi nézőnek.
- A „<felhasználó> ír..." mostantól megjelenik a szálakban és fórumbejegyzésekben weben, asztali gépen és Androidon (a szerver korábban eldobta a szálak gépelési eseményeit, Android pedig sosem küldte őket).

#### Módosítva
- Az automatikus tiltás már nem aktiválódik néhány gyors oldalfrissítés után. Az árasztás elleni védelem mostantól csak a nem bejelentkezett látogatók dinamikus kéréseit számolja (a szkript-, stílus-, kép-, feltöltés-, vendor- és nyelvfájlok, a bejelentkezett felhasználók, a privát/loopback és engedélyezőlistás címek sosem számítanak), a szkennerszerű próbálkozásokat (/wp-login.php, /.env, *.php ...) külön számolja, és az automatikus tiltási idők rövidről indulnak, és ugyanazon cím minden korábbi automatikus tiltásával megduplázódnak 24 órán belül (felső korlát 7 nap). Alapértékek: árasztás 900 -> 1500 kérés 10 másodpercenként, első tiltás 15 -> 5 perc, sebességkorlát-megsértések 20 -> 50 5 percenként, sikertelen bejelentkezés miatti tiltás 60 -> 15 perc (továbbra is 30 sikertelen 10 percenként), új szkenner-korlát 10 5 percenként. A még a régi alapértéket tartalmazó beállítások követik az újakat; az egyéni értékek megmaradnak. A Biztonsági központ az új szkenner-korlátot mutatja.
- Zajszűrés: az RNNoise modul (~4,8 MB) mostantól az alkalmazás megnyitásakor előtöltődik (ha a beállítás be van kapcsolva) és a beállítás bekapcsolásakor, nem az első híváshoz csatlakozáskor.

### 2026-10-30
#### Javítva
- Android/mobil web: egy szerver csatornájának megnyitása az „utolsó csevegés" kezdőnézeten, mélylinken vagy meghíváson át mostantól a mögöttes fület a Szerverekre váltja, így a Vissza a szerver csatornalistájára visz, nem az Üzenetekhez.

#### Módosítva
- Profil-felugró: az Üzenet, Barát hozzáadása és (saját profilnál) a Profil szerkesztése a „..." menübe került; a műveletgombok megszűntek. A gyors üzenet beviteli mező megmarad, ha a felhasználó engedélyezi a privát üzeneteket. A menü a kártya mellett nyílik, nem fölötte, és a kártya alján már nincs szürke sáv. A mobil profillap ugyanezt a kezelést kapta: a műveletek „..." menübe kerültek, gyors üzenet beviteli mezővel, ha a privát üzenetek engedélyezettek. A saját lapodnak „..." menüje van a Profil szerkesztése ponttal (a Te fülön is megvan).

#### Hozzáadva
- „Jelentés" menüpont a felhasználókhoz a tagok listájának jobb gombos menüjében, a barátsorokban, a privát üzenet sorokban (asztali gép) és a mobil profillapon; korábban csak az üzenetmenükben és a profilkártya „..." menüjében volt.
- Regisztrációs mód a `data/config.json`-ban (`registrationMode`): `open` (alapértelmezett), `invite` (az új fiókokhoz érvényes szerver- vagy csatornameghívó link/kód kell) vagy `closed`. Az üres példány első fiókja mindig engedélyezett.
- Admin panel > Áttekintés: „Regisztráció" beállítás (oldaladminoknak), újraindítás nélkül azonnal érvénybe lép.
- Bejelentkező képernyő weben, Electronon és Androidon: meghívó mező meghívós módban (az `#invite=` linkekből előre kitöltve, beillesztett linkeket is elfogad), zárt módban értesítés a Regisztráció link helyett.
- Angol és magyar szövegek a fentiekhez.
- Az asztali/webes profilkártya mostantól Discord-stílusú felugró, amely a kattintott név/tag mellé van lehorgonyozva, nem középre helyezett modális ablak.
- A saját nevedre kattintva a saját kártyád nyílik meg „Profil szerkesztése" gombbal (megnyitja a fiókbeállításokat), ahelyett hogy egyből a beállításokba ugrana.
- Profilkártya: gyors üzenet beviteli mező (az Enter megnyitja a privát üzenetet és elküldi az üzenetet), csak akkor látszik, ha a felhasználónak lehet üzenni (barátok, vagy a privát üzenet-adatvédelmi és szerverenkénti beállításai engedik). A `GET /api/users/:id` mostantól `canMessage`-et ad vissza.

#### Javítva
- Csevegés: keskeny csevegőoszlopban az üzenet rámutatáskor megjelenő eszköztára eltakarta a szerző nevét, így a profil nem volt megnyitható; most ott a sor fölött jelenik meg.
- Android/mobil hívás csempék: az avatar túllógott az 80 px-es burkolón, így a beszédgyűrű fel-balra tolódott, és az avatar eltakarta az állapotpontot és a hangerősávot.

### 2026-10-29
#### Hozzáadva
- Csevegés: olvasatlan üzenetek sávja ugrással és olvasottnak jelöléssel, web és mobil (Android 3.13).

#### Javítva
- A perjeles parancsok felugrója a szavazási lehetőségek fölött jelenik meg.

### 2026-10-28
#### Hozzáadva
- Beállítható üzenethossz-korlát (`maxMessageChars`, alapértelmezett 15000); a korlátot meghaladó szöveget `.txt`/`.md` mellékletként ajánlja fel (legfeljebb 300 KB), web és mobil.
- A matrica-választók leírás szerint is keresnek, nem csak névre; az animált matricák csak rámutatáskor játszódnak le, az egyidejű animációk számának korlátjával.
- Üzenetlapozás korlátozott ablakkal és görgethető ugrónézetekkel, web és mobil.

#### Javítva
- A 4000 karakternél hosszabb üzenetek kétszeres elküldése; a korlát feletti küldések kliensoldalon blokkolva.
- Beragadt olvasatlan jelvény a legújabb üzenet törlése után; a saját üzenetek sosem számítanak olvasatlannak.
- A szerkesztő gombjai magas piszkozatnál a szöveg alá sorakoznak.
- Egyetlen emoji-választó gomb a rangszerkesztőben.
- Magyar megfogalmazások (üdvözlés és mások).
