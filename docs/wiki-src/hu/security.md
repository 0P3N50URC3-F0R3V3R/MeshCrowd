---
title: Biztonság és adatvédelem
desc: Hogyan védi a MeshCrowd a fiókokat és az adatokat, mit fed a végponttól végpontig tartó titkosítás, és hol vannak az őszinte korlátok.
group: Szerver üzemeltetése
order: 2
---

## Mi van védve, és hogyan

- **Átvitel**: HTTPS és WSS mindenhol, generált vagy saját tanúsítvánnyal.
- **Jelszavak**: bcrypt 12 körrel. A megerősített fiókoknál a szerver csak egy származtatott kulcsot lát, a jelszót sosem.
- **Munkamenetek**: átlátszatlan szerveroldali tokenek httpOnly sütiben, egyenként visszavonhatók, nem JWT-k.
- **Kétlépcsős azonosítás**: TOTP egyszer használható helyreállító kódokkal.
- **Feltöltések**: kiterjesztés szerint szűrve, méretkorláttal, és letöltésként, homokozó Content-Security-Policy alatt kiszolgálva.
- **Fejlécek és korlátok**: biztonsági fejlécek és Content-Security-Policy minden válaszon, valamint sebességkorlátozás az érzékeny végpontokon.
- **Nincsenek harmadik felek**: a webes kliens semmit nem tölt be CDN-ről, és nincs analitika.

## Biztonsági központ

Az Admin panel **Biztonsági központ** oldala (csak oldaladminisztrátoroknak) tartalmazza a botok és elárasztásos támadások elleni eszközöket. Minden a saját szervereden fut, harmadik fél captcha- vagy hírnévszolgáltatásához nem kerül semmi.

- **Captcha**: torzított kép a bejelentkezésnél és regisztrációnál; megjelenhet soha, adott számú sikertelen próbálkozás után vagy mindig. Választhatsz véletlen karaktereket, szótári szavakat (beépített angol és magyar, vagy a szerkesztőbe írt saját lista) vagy egyszerű számolást, és állítható a torzítás. A captcha egyszer használható, hibás tipp után új kép kell.
- **Elárasztás elleni védelem**: az a cím, amelyik túl sok kérést küld, folyton a kérésszám-korlátba ütközik vagy újra meg újra sikertelenül jelentkezik be, egy időre tiltást kap. Az ilyen tiltások hirtelen sokasodása bekapcsolja a **támadási módot**, amely minden bejelentkezéshez és regisztrációhoz captchát kér.
- **IP-tiltások**: címek, tartományok (`1.2.3.4-1.2.3.9`) és hálózatok (`10.0.0.0/8`), IPv4 és IPv6, végleg vagy időre. A saját címedet nem tilthatod ki.
- **Tiltólisták**: iratkozz fel ismert rossz címek nyilvános listáira (Spamhaus DROP, Tor kilépőpontok, FireHOL) vagy saját URL-re. A frissítés ütemezett, sikertelen frissítésnél a régi másolat marad.
- **Engedélyezőlista**: soha nem tiltott és nem korlátozott címek. Alapból maga a gép is rajta van.
- **Botcsapdák** (rejtett mező és sebességellenőrzés az űrlapokon), **regisztrációk korlátja címenként**, **IP-ellenőrző** eszköz és **eseménynapló**.

Ha a MeshCrowd fordított proxy mögött fut, állítsd be a `trustProxy` értéket a `config.json`-ban, különben minden látogató a proxynak látszik, és a címenkénti korlátok nem tudják megkülönböztetni az embereket.

## Végponttól végpontig titkosított privát üzenetek

Bármely, azonos szerveren lévő két ember közötti kettesben folyó privát beszélgetés átkapcsolható végponttól végpontig titkosításra a zár gombbal. **Egyirányú**: a visszalépéshez töröld a beszélgetést és indíts újat. A szerver csak titkosított szöveget tárol. A kulcsok mindenki Útlevelétől származnak.

**Biztonsági számok**: a titkosított privát beszélgetésnek van Ellenőrzés pajzsa, amely egy 60 számjegyes számot mutat, amit mindketten összevethettek megbízható csatornán. Minden eszköz **rögzíti** a másik ember kulcsát, amikor először beszélget vele; ha ez a kulcs később megváltozik, a küldés le van tiltva, amíg át nem nézed és el nem fogadod az újat. A rögzítés és az ellenőrzés eszközönkénti.

A titkosított beszélgetésben a szerkesztés, továbbítás, szavazások, hangüzenetek, időzítés és mellékletek le vannak tiltva.

### Tudnivaló korlátok

- Megbízhatóan egyszerre egy eszközről működik; ha két eszköz ír ugyanabba a beszélgetésbe, ütközhetnek, és „Nem sikerült visszafejteni” jelenhet meg.
- Csak helyi: kettesben, ugyanazon a szerveren lévők között. A föderált privát üzenetek nem titkosítottak.
- Az új vagy törölt eszköz nem olvashatja az előzményeket, amelyeket sosem látott.
- A visszafejtett előzmények gyorsítótárazódnak az eszközön.

## Jegyzetcsatornák

A Jegyzetek a böngészőben, az Útleveledből származtatott kulccsal titkosítottak, így sem az adatbázis, sem az adminok nem tudják elolvasni őket. Az Útlevél elvesztése a jegyzeteid elvesztését jelenti.

## Mit láthat az üzemeltető

A szerver üzemeltetője olvashatja a szokásos csatornaüzeneteket és feltöltéseket, mert a szerver tárolja őket. A végponttól végpontig titkosított privát üzenetek és a Jegyzetek kivételek. A botok azt küldik a MI-szolgáltatójuknak, amit kérdeznek tőlük, ezért olyan szolgáltatókat válassz, akiknek megbízol.

## A webes kliens bizalmi feltevése

Abban bíznak, hogy aki a webes klienst kiszolgálja, őszinte JavaScriptet szolgál ki. Egy rosszindulatú üzemeltető olyan kódot szállíthat, amely elfogja a jelszót vagy egy kulcsot. Ez minden webalapú végponttól végpontig tartó megoldásra igaz. Üzemeltesd a saját szervered, vagy használj olyat, amelyet megbízható emberek üzemeltetnek, és vesd össze a tanúsítvány-ujjlenyomatokat.

## Útlevél és megerősített bejelentkezés

A webes fiókoknál a böngésző két kulcsot származtat a jelszavadból: az `authKey` elmegy és bcrypt-hash-ként tárolódik, a `wrapKey` pedig becsomagolja az Útlevél-magodat és sosem hagyja el a böngészőt. Fennmaradó kockázatok: az `authKey` az adott szerveren jelszóként viselkedik, ezért TLS kell, és egy gyenge jelszó offline kitalálható az `authKey` alapján. A sikertelen Útlevél-igazolások öt hiba után 15 percre zárolják az adott azonosságot. A telefonos felület az Adminpanel vagy a Szerver beállításainak megnyitása előtt újra kéri a jelszavadat; az ellenőrzés sebességkorlátozott, és ismételt hibás válasz után zárol.

## Föderáció

A partnerekben csak az azonosság tekintetében bíznak, a jogosultságokat mindig a birtokló példány dönti el, a partnereknek előbb jóvá kell hagyni őket, és a partnerek felé irányuló hívások elutasítják az átirányításokat és a nem nyilvános címeket. Lásd: [Föderáció](federation.html).

## Sebezhetőség bejelentése

Kérjük, a biztonsági problémákat privátban jelezd a projekt karbantartóinak, ne nyilvános hibajegyben, és adj nekik észszerű időt a javításra, mielőtt közzéteszed.

## Megerősítési ellenőrzőlista

- Használj valódi hatóság által kiállított tanúsítványt, és tartsd megújítva.
- Proxy mögött a `trustProxy` értékét ugrásszámra állítsd, sosem `true`-ra egy kitett szerveren.
- Tartsd naprakészen a Node.js-t és a szervert.
- Korlátozd, kik hozhatnak létre Oldalakat és botokat, mert mindkettő kódot futtathat vagy adatot küldhet kifelé.
- A moderátoroknak csak a szükséges jogosultságokat add, és nézd át a naplót.
- Készíts mentést a `data/` mappáról, és próbáld ki a visszaállítást.
