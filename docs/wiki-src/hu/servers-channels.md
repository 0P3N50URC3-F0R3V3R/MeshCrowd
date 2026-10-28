---
title: Szerverek, csatornák és szerepkörök
desc: Csatornatípusok, kategóriák, a jogosultsági rendszer, csatorna-felülbírálások, szerepkör-ikonok és Jegyzetcsatornák.
group: A MeshCrowd használata
order: 2
---

## Szerverek

A **szerver** egy közösség: tagok, csatornák, szerepkörök és beállítások. Az emberek meghívókóddal, valaki profilkártyájáról küldött közvetlen meghívóval vagy a nyilvános szerverek könyvtárából csatlakozhatnak. A szerver lehet **privát** (csak meghívóval) vagy **nyilvános** (a felfedezésben listázva, opcionálisan automatikus csatlakozással).

A **Szerverbeállításokat** a csatornalista tetején lévő szervernévből nyithatod meg.

![Szerverbeállítások, Áttekintés](../assets/img/settings-overview.jpg)

### Meghívólinkek

Minden meghívókód linkként is működik: `https://a-te-szervered:8443/i/<kód>`. Ez egy kis oldalt nyit meg a szerver nevével és ikonjával (nyilvános szervernél a tagok számával is), egy **Csatlakozás böngészőben** és egy **Megnyitás az alkalmazásban** gombbal, valamint a szerver tulajdonosa által megadott letöltési linkekkel. Az oldal megnyitása nem használ el meghívót, a csatlakozás pedig mindig megerősítést kér.

- A **Link másolása** a meghívóablakban a **Másolás** mellett, a **Szerverbeállítások, Meghívók** alatt pedig minden meghívónál és az egyedi linknél megtalálható.
- A **Csatlakozás böngészőben** előbb bejelentkeztet vagy regisztráltat, majd megkérdezi: „Csatlakozol ehhez a szerverhez?".
- A **Megnyitás az alkalmazásban** egy `mcr://a-te-szervered:8443/<kód>` címet használ. A Windowsos asztali alkalmazás és az Android-alkalmazás megnyitja, másik szerverre váltás előtt rákérdez, csatlakozás előtt pedig újra. Lásd: [Asztali alkalmazás](clients.html#asztali-alkalmaz-s-windows) és [Android-alkalmazás](android.html).
- A régi mód is működik: illeszd be a kódot a **Szerver hozzáadása, Csatlakozás meghívóval** ablakba. A csatornameghívók és a föderált szerverek `kód@domain` meghívói is működnek linkként.

## Csatornatípusok

| Típus | Mi ez |
|---|---|
| Nyilvános szöveges | Aki láthatja a szervert, olvashat és írhat |
| Privát szöveges | Csak azoknak a tagoknak látható, akiket egy szerepkör vagy felülbírálás beenged |
| Közlemény | Olvasható csatorna, amelybe csak a kezelők írhatnak |
| Csak olvasható | Mint a közlemény, szabályoknak és információknak |
| Hang | Hangszoba kamerával és képernyőmegosztással |
| Színpad | Előadókra és hallgatóságra osztott hangszoba |
| Fórum | Szálas bejegyzésekből álló csatorna |
| Jegyzetek | Privát, titkosított jegyzetfüzet minden tagnak |

Csatornát a **Csatornák** melletti **+** gombbal hozhatsz létre, és **kategóriákba** rendezheted húzással. A csatornának lehet ikonja, témája és **lassított módja**. A szöveges csatorna **korhatárosnak** is megjelölhető; lásd: [Moderáció és biztonság](moderation.html).

::: note A hangminőség a létrehozáskor rögzül
A hang- és színpadcsatornák létrehozáskor kapnak minőség-előbeállítást (Mobil, Alacsony, Közepes, Magas vagy HD Zene). Módosításához töröld a csatornát és hozz létre egy újat.
:::

## Szerepkörök és jogosultságok

A szerepkörök jogosultsági jelzők halmazai. Mindenki megkapja a beépített **@everyone** szerepkört, és tetszőleges számú továbbit hozhatsz létre. A tag jogosultságai a szerepköreinek egyesítései.

![A Szerepkörök fül](../assets/img/settings-roles.jpg)

| Jogosultság | Mit enged |
|---|---|
| Csatorna megtekintése, Üzenetküldés, Fájlcsatolás | Alapvető olvasás, írás és feltöltés |
| Üzenetek kezelése | Más üzeneteinek törlése és kitűzése |
| Csatornák kezelése | Csatornák, kategóriák és csatornawebhookok létrehozása, szerkesztése és törlése |
| Szerepkörök kezelése | Szerepkörök létrehozása és kiosztása |
| Szerver kezelése | A szerver átnevezése, meghívók, fogadás, AutoMod, sablonok, statisztika |
| Tagok kirúgása, Tagok tiltása | Emberek eltávolítása |
| Tagok moderálása | Időkizárás, lassított mód, némítás hangban |
| Meghívó létrehozása, Becenév módosítása, Becenevek kezelése | Meghívók és megjelenített nevek |
| Napló megtekintése | A moderátori műveletek naplójának olvasása |
| Tartalom ritkítása | Régi előzmények törlése ezen a szerveren |
| Botok kezelése | A szerver botjainak létrehozása és szerkesztése |
| Adminisztrátor | Minden |

**Senki nem adhat olyan jogosultságot, amellyel ő maga nem rendelkezik.** A tulajdonos mindig minden jogosultsággal rendelkezik, és ezt a szabályt a szerver érvényesíti, nem a felület.

### Szerepkörszínek és ikonok

Minden szerepkörnek van színe és **szerepkör-ikonja**: emoji vagy feltöltött kép. A tag legmagasabb, ikonnal rendelkező szerepkörének ikonja jelenik meg a neve mellett a csevegésben és a taglistában. A tagonkénti **névszín** felülbírálása erősebb a szerepkörszínnél.

### Csatorna-felülbírálások

Nyisd meg a csatorna beállításait, és engedélyezz vagy tiltsz jogosultságokat egy szerepkörnek vagy egyetlen tagnak, csak ebben a csatornában. A csatornán megadott tiltás erősebb a szerepkörből kapott engedélynél.

## Jegyzetcsatornák

A **Jegyzet** csatorna minden tagnak privát jegyzetfüzetet ad a szerveren belül, szöveggel és jegyzetenként legfeljebb öt melléklettel. Minden a böngészőben, az Útleveledből származtatott kulccsal titkosított, így az adatbázis és az adminok nem tudják elolvasni. Az adminok csak egy dátumnál régebbi jegyzeteket törölhetnek. A jegyzetek nem kereshetők, nem továbbíthatók és nem alakíthatók más csatornatípussá, az Útlevél elvesztése pedig a jegyzetek elvesztését jelenti.

## Szerversáv és mappák

A szerversávod személyes: húzd a szervereket **mappákba**, saját ikonnal és színnel. Egy szervert vagy csatornát elnémíthatsz, vagy az értesítéseket csak a megemlítésekre korlátozhatod a jobb gombos menüből.

## Üdvözlőképernyő és események

Az üdvözlőképernyő kiemelt csatornákat listáz az új tagoknak. Az **időzített események** neve, leírása, helye, kezdete és vége van, és jelentkezési (érdekel) követés.

## Tovább

- Tedd a szabályokat az újonnan érkezők elé a [Közösségi eszközökkel](community-tools.html).
- Tarts rendet a [Moderáció és biztonság](moderation.html) segítségével.
