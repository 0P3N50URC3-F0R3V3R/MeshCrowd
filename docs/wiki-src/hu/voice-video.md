---
title: Hang, videó és színpadok
desc: Hogyan működnek a hívások, minőség-előbeállítások, kamera és képernyőmegosztás, színpadcsatornák, zajszűrés és hibaelhárítás.
group: A MeshCrowd használata
order: 4
---

![Egy hangcsatorna kamerás csempékkel](../assets/img/voice-call.jpg)

## Hogyan működnek a hívások

A szerver kétféle módban futtathat hívásokat, az adminisztrátor választ (**Adminpanel, Hívások, Hangmotor**). Minden hangcsatornára, színpadra és DM-hívásra vonatkozik, és a szoba létrehozásakor rögzül, így a váltás csak az utána létrehozott szobákat érinti.

- **Mesh** (alapértelmezett): a hang és videó **közvetlen WebRTC**. Minden résztvevő közvetlenül kapcsolódik minden másikhoz, a szerver pedig csak a jelzéseket továbbítja ugyanazon a WebSocketen, amelyet a csevegéshez is használunk. Nincs médiaszerver, amit üzemeltetni kellene.
- **SFU** (szelektív továbbítás): minden résztvevő a streamjét **egyszer** küldi el a szerver beépített médiaútválasztójának (mediasoup, a szerverfolyamaton belül fut), amely továbbítja a többieknek. A feltöltési igény nem nő a hívás méretével, ami megszünteti a szaggatást nagyobb vagy videós szobákban és gyenge feltöltésű felhasználóknál.

::: note Tervezz a hívás méretével
Mesh módban mindenki egyszer tölti fel a streamjét minden más résztvevőnek. Egy nagyjából nyolc vagy több fős, videós hívás sok feltöltési sávszélességet kér mindenkitől. A csak hangos szobák sokkal tovább skálázódnak, az SFU mód pedig megszünteti a korlátot.
:::

::: note Adatvédelem SFU módban
Mesh módban a szerver soha nem lát médiát. SFU módban a szerver lezárja a titkosított hívásfolyamokat a továbbításhoz, így technikailag vissza tudja fejteni őket. Csak megbízható szerveren válaszd. Az admin panel figyelmeztetést mutat erről.
:::

Hívás közben használhatsz más csatornákat, így szöveges csatornákat is; a hívás az alsó sávban folytatódik. Egyszerre egy hangszobában lehetsz: egy másikba belépve az elsőt elhagyod. Ha ugyanazt a hívást egy második lapon vagy eszközön nyitod meg, a hívás odaköltözik, az elsőn pedig értesítéssel véget ér.

## Csatlakozás

Kattints egy hangcsatornára és nyomd meg a **Csatlakozás a hangcsatornához** gombot. Engedélyezd a mikrofonhozzáférést, amikor a böngésző kéri. A vezérlőkkel némíthatsz, süketíthetsz, bekapcsolhatod a kamerát, megoszthatod a képernyődet, megnyithatod a hangpultot vagy kiléphetsz. A hívásokhoz **HTTPS vagy localhost** kell, a különböző hálózatokon lévőknek pedig STUN- vagy TURN-szerver (lásd: [Konfiguráció](configuration.html)).

Minden résztvevő csempéjén van beszédjelző gyűrű és élő szintcsík. Mindenkinek saját hangerőcsúszkája van a csempéjén.

A résztvevők rácsa nagy csempéket használ, és görgethető, ha megtelik a szoba. Egy hangcsatornában a hívási panel a szöveges csevegés fölött van; a kettő közötti **elválasztót húzva** fel vagy le, a szobának vagy a csevegésnek adhatsz több helyet. A magasságot a böngésző megjegyzi. A színpadcsatornák ugyanezeket a nagy, görgethető csempéket használják. Telefonon a hívás egy teljes képernyős, kétoszlopos csempenézet, a szöveges csevegés egy koppintásra van.

## Minőség-előbeállítások

Az előbeállítást a létrehozó választja a csatorna létrehozásakor. Utána rögzül: módosításához töröld a csatornát és hozz létre egy újat.

| Előbeállítás | Mintavétel | Bitráta | Mire jó |
|---|---|---|---|
| Mobil | 8 kHz | 12 kbps | Gyenge kapcsolatok és mobilnetes telefonok |
| Alacsony | 16 kHz | 24 kbps | Beszéd gyenge vonalon |
| Közepes | 24 kHz | 48 kbps | Az alapértelmezett |
| Magas | 48 kHz | 96 kbps | Tiszta beszéd |
| HD / Zene | 48 kHz sztereó | 192 kbps | Zene és megosztott hang |

## Kamera és képernyőmegosztás

A kamera és a képernyőmegosztás külön csempe, így mindkettőt mutathatod egyszerre. Bármely videócsempének van **teljes képernyő** gombja. Az asztali alkalmazás a rendszer képernyő- és ablakválasztóját használja; böngészőben a böngésző saját választója jelenik meg. Telefonon a kameránál van **váltás** gomb, a képernyőmegosztás pedig nem érhető el.

## Színpadcsatornák

A színpad **előadókra** és **hallgatóságra** osztott hangszoba. A hallgatóság néma, amíg egy előadó vagy moderátor meg nem hívja. A hallgatók **felemelhetik a kezüket**; a moderátor beszélni hívhatja őket, vagy visszahelyezheti a hallgatósághoz. A színpad jól működik városházi ülésekhez és bejelentésekhez.

## Moderátori eszközök

A **Tagok moderálása** jogosultsággal rendelkezők **mindenki számára némíthatnak** valakit a csempéjéről. A célszemély kliense leállítja a hang küldését, a saját némításfeloldó gombja pedig le van tiltva, amíg egy moderátor fel nem oldja; egy jelvény látszik a csempén. Mesh módban ez a célszemély kliensének utasításával működik; SFU módban a szerver a személy streamjét is szünetelteti, így módosított klienssel sem hallható.

## Privát hívások

A privát és csoportos privát üzenetek is támogatnak hívásokat. Egy privát hívás sosem jelenik meg a taglista „hívásban van” jelzőjén vagy a privát beszélgetés tagjain kívül bárhol máshol.

## Hangpult

A szervernek lehet rövid hangklipekből álló hangpultja, amelyet a jogosult tagok lejátszhatnak a hívásba. A **Szerverbeállítások, Hangtár** alatt kezelheted.

Ha zavarnak mások hangklipjei, a **Beállítások, Hang és videó** alatt pipáld be a **Mások hangtár-hangjainak némítása** opciót, vagy vedd lejjebb a **Hangtár hangerejét**. Ez a hívásokban lejátszott klipekre és a csevegésekben küldött hangüzenetekre vonatkozik, csak ezen az eszközön. A hangtár felugró ablakában egy hangszóró gomb is van a gyors némításhoz.

![A hangeffekt-panel egy hangszobában](../assets/img/voice-soundboard.jpg)

## Zajszűrés

A **Beállítások, Hang és videó, Fejlett zajszűrés (RNNoise)** a mikrofonodat egy WebAssemblyre fordított kis neurális hálózaton engedi át, ami eltávolítja a billentyűzet-, ventilátor- és háttérzajt. A saját eszközödön működik, nagyjából tíz milliszekundum késleltetést ad, és alapból ki van kapcsolva. A modul (kb. 5 MB) csak akkor töltődik le, amikor először indul hívás bekapcsolt állapotban. Ha nem tud elindulni, a hívás egyszerűen nélküle folytatódik.

## Beviteli mód, nyomd és beszélj, visszhangcsökkentés

A mikrofonodon mindig be van kapcsolva a böngésző **visszhangszűrése**, **zajszűrése** és **automatikus erősítésszabályozása**. A **Beállítások, Hang és videó, Bemeneti mód** alatt választod ki, hogyan nyíljon meg a mikrofon:

- **Mindig bekapcsolva**: a mikrofon él, amíg nem némítod.
- **Hangaktivitás**: a mikrofon csak akkor küld, ha hangosabb vagy az **Érzékenység** csúszkánál.
- **Nyomd és beszélj**: tartsd lenyomva a kiválasztott gombot a beszédhez. Két további opció jelenik meg:
  - **Elengedési késleltetés (ms)**, 0 és 2000 között: a gomb elengedése után ennyi ideig nyitva marad a mikrofon, így a mondat vége nem vágódik le. Ha a késleltetés alatt újra megnyomod a gombot, nyitva marad.
  - **Hangaktivitás a nyomd és beszélj mellett**: a mikrofon akkor is megnyílik, ha az érzékenységi küszöbnél hangosabban beszélsz, a gomb nyomása nélkül. A gomb nyomva tartása továbbra is mindig működik.

A **visszhangcsökkentés** (külön jelölőnégyzet) hangszóró vagy nyitott mikrofon esetén segít: amíg a mikrofonod a hangodat érzékeli, mindenki más lejátszása adott számú decibellel halkabb lesz, alapból 10-zel. Írj be 1 és 30 közötti értéket, vagy használd a fel és le nyilakat. Ugyanazt az érzékenységi küszöböt használja, mint a hangaktivitás, és csak akkor érvényes, amikor valóban adsz.

Mindez azon az eszközön marad meg, amelyen beállítod.

![Beállítások > Hang és videó](../assets/img/voice-settings.jpg)

## Hogyan választ útvonalat a kapcsolat

Nincs mit beállítani: mindenki alkalmazása egyszerre kipróbál minden címet, amivel rendelkezik (LAN, VPN például Radmin, ZeroTier, SoftEther vagy Hamachi, és nyilvános), és a leggyorsabb működőt használja, így az azonos LAN-on vagy privát VPN-en lévők STUN vagy TURN szerver nélkül, közvetlenül kapcsolódnak. A STUN és a TURN automatikus tartalékként marad a különböző hálózatokon lévőknek.

Ha egy csempén a színes minőségjelző pont fölé viszed az egeret, látod az útvonalat: **közvetlen (LAN/VPN)**, **NAT-on át (STUN)** vagy **továbbítva (TURN)**. Az asztali alkalmazás itt a gép hálózati adaptereit is felsorolja. A megszakadt hívást (VPN újracsatlakozás, Wi-Fi váltás) az alkalmazás automatikusan újrapróbálja, mielőtt lezárná.

A szerver tulajdonosa opcionálisan megadhatja a LAN és VPN alhálózatokat, lásd: [LAN és VPN hálózatok](configuration.html#lan-s-vpn-h-l-zatok).

## Hívások hibaelhárítása

| Tünet | Mit ellenőrizz |
|---|---|
| Nincs mikrofonkérés | Az oldal nem HTTPS-en vagy localhoston van |
| LAN-on csatlakozik, hálózatok között nem | Kapcsold be a beépített STUN/TURN szervert (`setup-turn.bat`, vagy Adminpanel, Hívások), és irányítsd át a portokat a routeren, lásd: [STUN és TURN](configuration.html#stun-s-turn) |
| Az azonos Radmin/ZeroTier/LAN hálózaton lévők lassan vagy továbbításon át kapcsolódnak | A minőségjelző pont fölé víve látszik az útvonal. Add meg a VPN alhálózatot az **Adminpanel, Hívások, LAN / VPN hálózatok** alatt, hogy a többi adapter (Docker, WSL) ki legyen hagyva, és ellenőrizd, hogy a VPN átengedi az UDP-t a tagok között |
| Valakit nem hallani | A böngészője letiltotta a mikrofont, vagy rossz a bemeneti eszköze az eszközválasztóban |
| Szaggatott hang nagy hívásban | Állítsd a szervert SFU módra (Adminpanel, Hívások, Hangmotor), vagy csökkentsd az előbeállítást, és kérd meg az embereket, hogy kapcsolják ki a kamerát |
| SFU mód: „a tűzfal blokkolhatja” értesítés | Nyisd meg az SFU-portsávot UDP-n és TCP-n a szerver tűzfalán és a routeren, és ellenőrizd, hogy a hirdetett cím a nyilvános, lásd: [SFU hangmotor](configuration.html#sfu-hangmotor) |
| SFU mód be van állítva, de a hívások mesh módúak | Az SFU nem tudott elindulni (nincs worker ehhez az operációs rendszerhez, vagy foglaltak a portjai). Nézd meg az állapotsort az Adminpanel, Hívások, Hangmotor alatt; a szerver `[sfu]` sorokat naplóz |
