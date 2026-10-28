---
title: Android-alkalmazás
desc: Az APK telepítése, csatlakozás önaláírt szerverhez, értesítési módok a UnifiedPush-sal együtt, és saját építés.
group: A MeshCrowd használata
order: 7
---

Az Android-alkalmazás egy vékony Kotlin-burok (Android 8.0 vagy újabb, egyetlen univerzális APK, natív könyvtárak nélkül) a szervered által a `/m/` címen kiszolgált telefonos felület körül. Mivel az egész felület a szerveredtől jön, **a szerver frissítése minden telefont frissít**, és új APK csak akkor kell, ha maga a burok változik.

## Telepítés

1. Töltsd le az APK-t a telefonodra és nyisd meg. Az Android egyszer megkér, hogy engedélyezd a telepítést a böngészőből vagy a fájlkezelőből.
2. Nyisd meg az alkalmazást és írd be a szervered címét: `chat.example.com`, `192.168.1.44:8080`, vagy `http://` vagy `https://` előtaggal. Először HTTPS-t próbál.
3. Az **önaláírt tanúsítványt** egyszer, az SHA-256 ujjlenyomata alapján fogadod el. Elfogadás előtt vesd össze azzal, amit a szerver indításkor kiír.
4. A sima `http` cím figyelmeztetéssel megengedett. A hívásokhoz és az értesítésekhez HTTPS kell.

## Használat

- **Billentyűzet és fájlok**: egy mezőre koppintva megjelenik a billentyűzet; a mellékletek a rendszer fájlválasztóját használják; a letöltések (a visszafejtett privát üzenetes fájlokat is beleértve) a Letöltések mappába kerülnek értesítéssel.
- **Meghívólinkek**: egy `mcr://` link (a meghívóoldal **Megnyitás az alkalmazásban** gombja) megnyitja az alkalmazást. Ha arra a szerverre szól, amelyre az app be van állítva, rákérdez a csatlakozásra; másik szervernél előbb rákérdez, megmutatja a csatlakozási képernyőt kitöltött címmel, majd kapcsolódás után kérdez a csatlakozásról. 3.9-es vagy újabb verziót igényel.
- **Vissza gomb**: előbb a lapokat és képernyőket zárja be. Más fülről a Szerverek fülre lép vissza, a Szerverekről pedig kilép.
- **Hívások**: a hang, a kamera és a privát hívások működnek a telefonos felületen. Az alkalmazás csak a te szerveredhez kér mikrofon- és kamera-engedélyt.
- **Szerverváltás**: a **Te** fülön van lehetőség a lecsatlakozásra és másik cím megadására.
- **Kezdőnézet**: a **Te** fülön, az **Indításkor megnyílik** alatt választhatod ki, melyik fülön nyíljon az alkalmazás (Szerverek, Üzenetek, Értesítések vagy Te), vagy az utoljára megnyitott csevegésen.
- **Üzenetstílus**: a **Te** fülön választhatsz sima csevegés és csevegőbuborékok között.
- **Az adminisztráció jelszót kér**: az Adminpanel vagy a Szerver beállításai megnyitása előtt meg kell erősítened a jelszavadat, így egy feloldva hagyott telefon nem adja ki az adminisztrációs képernyőket.

## Mi működik a telefonon

A telefonos felület ugyanazokat a funkciókat fedi le, mint az asztali:

- **Üzenetküldés**: csatornák, szálak (az egyedi csatorna- és szálikonok látszanak a listákban és a csevegés fejlécében), fórumcsatornák (kártyák kereséssel, rendezéssel és előnézettel, amelyeket szálként nyitsz meg), titkosított közvetlen és csoportos csevegések, reakciók, válaszok, szavazások, hangüzenetek, matricák, perjeles parancsok, ütemezett és mentett üzenetek. Az emoji gomb a teljes választót nyitja kategóriákkal, kereséssel, legutóbbiakkal, egyedi emojikkal és `:rövidkód:` javaslatokkal, a matricaválasztóban pedig keresni is lehet. Egy csevegés megnyitásakor piros **Új** vonal jelöli az első olvasatlan üzenetet; lásd: [Olvasatlan üzenetek](personalization.html#olvasatlan-zenetek).
- A **Jegyzetcsatornák** (a titkosított naplód) és a **Webhelyek** teljes képernyőn nyílnak meg.
- **Hang**: hangszobák és színpadok, kamera, hangpult, és a csatorna alatt élőben látszik, ki van a szobában.
- **Szerverkezelés**: a szervermenüben Események, Szerver beállításai (szerepkörök, csatornák, tagok, meghívók, AutoMod, botok, üdvözlés, naplózás és a többi), Csatorna létrehozása és Kategória létrehozása található, csak a jogosultsággal rendelkezőknek.
- **A fiókod**: a **Te** fül megnyitja a fiók-, megjelenés- (témák), hang- és videó-, adatvédelmi, Útlevél- és biztonsági beállításokat, a mentett és ütemezett üzeneteket, valamint a webhelyadminisztrátoroknak az **Adminpanelt**, a föderációval együtt.
- A párosított példányok **föderált szerverei** földgömb-jelvénnyel jelennek meg a szerverlistában; hosszan nyomva elhagyhatod őket.

A beállítási és admin képernyők ugyanazok az oldalak, mint az asztali alkalmazásban, görgethető fülsávval felül és a tartalommal alatta.

## Értesítések Google-szolgáltatások nélkül

Az alkalmazás maga kérdezi le a szerveredet, ezért nincs szüksége Firebase-re vagy Google Play Szolgáltatásokra. Három mód van, mind a **Te, Android-alkalmazás** alatt választható:

| Mód | Hogyan működik | Akkumulátor |
|---|---|---|
| Időszakos ellenőrzés | WorkManager 15 percenként vagy ritkábban | Nagyon kímélő |
| Gyors mód (alapból be van kapcsolva) | Előtér-szolgáltatás állandó értesítéssel, 1 és 1440 perc közötti lekérdezéssel | Terhelőbb |
| UnifiedPush | A szerver egy elosztó alkalmazáson, például az ntfy-n át ébreszti a telefont | Kímélő és azonnali |

A gyors mód állandó értesítése magától visszatér, ha elhúzod (az Android 14 és újabb engedi az elvetését). Amíg az alkalmazás nyitva van, az üzenetek azonnal megérkeznek a WebSocketen. A titkosított privát üzenetek csak általános „Új titkosított üzenet” értesítést mutatnak. Az értesítésre koppintva az adott beszélgetés nyílik meg.

### UnifiedPush

1. Telepíts egy UnifiedPush-elosztót, például az **ntfy**-t (saját üzemeltetésű vagy nyilvános).
2. Az alkalmazásban nyisd meg a **Te, Android-alkalmazás, Push értesítések** részt, kapcsold be, és válaszd ki az elosztódat.
3. A szerver ezután rögzített ébresztést (`{"t":"wake"}`) küld arra a címre, amit az elosztó az alkalmazásnak adott. Az üzenet szövege sosem halad át az elosztón: az alkalmazás felébred, és maga kéri le az értesítéseket.

::: note A saját hálózatodon futó ntfy
A magánhálózati címeket alapból elutasítja a szerver, mert azokat a felhasználók adják meg. Ha az ntfy-d a LAN-odon fut, állítsd a `pushAllowPrivateEndpoints` értékét `true`-ra a `data/config.json` fájlban.
:::

Az időszakos ellenőrzés biztonsági hálóként tovább fut, ezért UnifiedPush használatakor állítsd hosszú időközre.

## Az APK saját építése

JDK 17 és az Android SDK kell (35-ös platform és build-tools). Állítsd be az `sdk.dir` értéket az `android/local.properties` fájlban, majd:

```
cd android
./gradlew collectApk
```

A `collectApk` felépíti a kiadási APK-t, és az `AndroidReleases/MeshCrowd-<verzió>.apk` helyre másolja. A kiadási buildeket egy általad létrehozott kulccsal írják alá (`meshcrowd.jks`, az `keystore.properties` fájlban beállítva; mindkettő kimarad a verziókezelésből). **Készíts biztonsági másolatot a kulcsról**: a frissítést ugyanazzal kell aláírni. A `./gradlew testDebugUnitTest` futtatja az egységteszteket.

## Ismert korlátok

- A régebbi alkalmazások (3.0 előttiek) nem tudnak bejelentkezni megerősített bejelentkezésű fiókba. Frissítsd az alkalmazást.
- A képernyőmegosztás telefonon nem érhető el.
