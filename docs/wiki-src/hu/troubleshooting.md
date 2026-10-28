---
title: Hibaelhárítás és GYIK
desc: Gyakori problémák tanúsítványokkal, portokkal, hanggal, bejelentkezéssel és értesítésekkel, plusz ismert korlátok és gyakran ismételt kérdések.
group: Szerver üzemeltetése
order: 3
---

## Gyors megoldások

| Tünet | Mit ellenőrizz |
|---|---|
| A böngésző tanúsítvány miatt figyelmeztet | Az önaláírt tanúsítványnál ez várható: fogadd el egyszer. Figyelmeztetés nélkül használj valódi hatóság tanúsítványát a `serverCrt` és `serverKey` beállításokkal. |
| A figyelmeztetés szerint a tanúsítvány nem egyezik a címmel | A `publicHost` nem egyezett azzal a címmel, amelyet a tanúsítvány generálásakor használtál. Javítsd a `publicHost` értékét, töröld a `data/certs/` mappát és indítsd újra. |
| A szerver `[certs]` üzenettel kilép | A `serverCrt` vagy `serverKey` hiányzik, érvénytelen, nem illeszkedik, túl gyenge, vagy csak az egyik van megadva. Az üzenet megnevezi a fájlt és az okot. |
| `Cannot find module 'node:sqlite'` | A Node.js régebbi, mint 22.5. Használd a mellékelt futtatókörnyezetet vagy az indítószkripteket. |
| A port már használatban van | Módosítsd a `port` vagy `httpsPort` értékét a `data/config.json` fájlban. |
| A hang LAN-on működik, hálózatok között nem | Futtasd a `setup-turn.bat`-ot vagy a `setup-turn.sh`-t, vagy kapcsold be az **Adminpanel, Hívások** oldalt, majd a routeren irányítsd át a 3478 UDP és TCP, valamint a 49152-49999 UDP portokat. Nyomd meg a **Próba** gombot a Hívásoknál, és próbáld mobiladatos telefonnal. Lásd: [STUN és TURN](configuration.html#stun-s-turn). |
| Piros „Megszakadt a kapcsolat. Újracsatlakozás…” sáv, amely nem tűnik el | Az élő frissítések WebSocketet használnak. A régebbi szerverek csak akkor fogadták el, ha az oldalt a `publicHost`, `localhost` vagy `127.0.0.1` címen nyitották meg, így más cím (LAN IP, második név, az Android-emulátor `10.0.2.2` címe) HTTP 403-at kapott. Frissítsd a szervert; régebbin állítsd a `publicHost` értékét arra a címre, amelyet az emberek használnak. Fordított proxy mögött továbbítsd a `Host` fejlécet és állítsd be a `trustProxy` értéket. |
| Nincs mikrofon- vagy kamerakérés | Az oldal nem HTTPS-en vagy localhoston van. |
| „Ismeretlen szervercím” Útlevéllel való bejelentkezéskor | Állítsd a `publicHost` értékét arra a címre, amit az emberek begépelnek, vagy vedd fel a pontos eredetet a `passportOrigins` közé. |
| A bejelentkezés körbe-körbe jár fordított proxy mögött | Állítsd a `trustProxy` értékét az ugrásszámra, és továbbítsd a `Host` és `X-Forwarded-Proto` fejléceket. |
| A sütik nincsenek Secure jelölve proxy mögött | Ugyanaz: a `trustProxy` nincs beállítva. |
| Az Android-alkalmazás „érvénytelen hitelesítő adatokat” mond megerősített fiókra | Frissítsd az alkalmazást 3.0 vagy újabb verzióra, vagy használd a webes klienst. |
| Nincs értesítés Androidon | Nézd meg az alkalmazás akkumulátor-beállításait, az értesítési módot a **Te, Android-alkalmazás** alatt, és hogy a szerver elérhető-e HTTPS-en. |
| A UnifiedPush nem csinál semmit a LAN-on futó ntfy-jal | Állítsd a `pushAllowPrivateEndpoints` értékét `true`-ra a szerveren. |
| `TLS client error` vagy `SSL alert bad certificate` sorok a naplóban | A régebbi verziók minden sikertelen TLS-kézfogást naplóztak. Ezek a portot letapogató szkennerektől és botoktól származnak, ártalmatlanok; az újabb verziók csendben maradnak. A `MESHCROWD_TLS_DEBUG=1` környezeti változóval kapcsolhatod be a naplózást: sikertelen kézfogásonként egy sor, a kliens címével. Ha valódi felhasználót érint, ellenőrizd, hogy a tanúsítvány lefedi-e az általa használt gazdanevet, és hogy a `serverCrt` a teljes láncot tartalmazza-e. |
| „Nem sikerült visszafejteni” egy titkosított privát üzenetben | Két eszköz írt ugyanabba a beszélgetésbe, vagy ez az eszköz sosem látta azt az előzményt. Használj egyszerre egy eszközt. |
| Egy Oldal PHP-hibát mutat hiányzó DLL miatt | Futtasd az `npm run fetch:php` parancsot és a mellékelt szervert használd, vagy telepítsd a Visual C++ terjeszthető csomagot. |

## GYIK

**Tényleg ingyenes?**
Igen. Szabad szoftver a GNU General Public License alatt, és nincsenek fizetős csomagjai.

**Kell domainnév?**
LAN-hoz nem. A hálózatodon kívüli embereknek érdemes egyet beszerezni, plusz valódi tanúsítványt.

**Hány embert bír el?**
A hardvertől függ. A szöveges csevegés könnyű. A hang közvetlen, így a hívások korlátja az egyes emberek feltöltési sávszélessége, nem a szerver. Nagyjából nyolc vagy több ember videóval egy szobában a legtöbb otthoni kapcsolatot megterheli.

**Importálhatok másik chatszolgáltatásból?**
Egyelőre nem.

**Futtathatom Dockerrel?**
Még nincs hivatalos image. Egyetlen Node.js folyamat, így a becsomagolása egyszerű.

**Van e-mailes ellenőrzés vagy e-mailes jelszó-visszaállítás?**
Nincs. A helyreállítás az Útlevélfájlt használja, a kétlépcsős azonosítás pedig TOTP-t.

**Hazatelefonál?**
Nem. Nincs telemetria, nincs analitika, és a webes kliens semmit nem tölt be CDN-ről. Kimenő kapcsolatok csak akkor jönnek létre, ha beállítod őket: MI-szolgáltatók, webhookok, föderáció, UnifiedPush és azok a linkelőnézetek, amelyeket a szerver az emberek által közzétett linkekhez lekér.

**Hogyan költözhetek másik gépre?**
Másold át a `data/` mappát. Lásd: [Adminisztráció](administration.html).

## Ismert korlátok

- A hívások teljes közvetlen hálót használnak médiaszerver nélkül, így a nagy, videós hívások nehezek minden résztvevőnek.
- A föderáció a távoli szervereken csak szöveges csatornákat támogat; a föderált privát üzenetek nem végponttól végpontig titkosítottak.
- A végponttól végpontig titkosított privát üzenetek megbízhatóan egyszerre egy eszközről működnek, nem visznek mellékleteket, és egy szerverre korlátozódnak.
- A Jegyzetek mellékleteit fájlonként titkosítja, de a titkosításuk nincs a fájlazonosítóhoz kötve.
- A botok perjeles parancsai csak szervercsatornákban működnek.
- Az e-mailes ellenőrzés nincs megvalósítva.
