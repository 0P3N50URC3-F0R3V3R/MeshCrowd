---
title: Fiókok, Útlevél és bejelentkezés
desc: Regisztráció, az Útlevél-azonosítófájl, megerősített bejelentkezés, kétlépcsős azonosítás és helyreállítás.
group: A MeshCrowd használata
order: 1
---

## Regisztráció és bejelentkezés

Bárki regisztrálhat, aki eléri a szervert, e-mail-címmel, felhasználónévvel és jelszóval. **Az első fiók lesz a Tulajdonos.** Bejelentkezhetsz az e-mail-címeddel vagy a felhasználóneveddel is.

A munkamenetek átlátszatlan tokenek, amelyeket a szerver tart nyilván egy httpOnly sütiben. Nem JWT-k, ezért mindegyik visszavonható, egy fiók letiltása pedig azonnal megszünteti a munkameneteit és az élő kapcsolatait.

## Útlevél: a hordozható azonosságod

Amikor a webes kliensben regisztrálsz, a böngésző létrehoz egy **Útlevelet**: egy kulcspárt, amelyhez a fiókod kötődik.

- **Exportáld** a **Beállítások, Útlevél** oldalon titkosított `.mcpass` fájlként.
- **Jelentkezz be a fájllal** és a jelmondatával; így állíthatod helyre az elfelejtett jelszót is.
- **Regisztrálj egy másik MeshCrowd szerveren** ugyanazzal az azonossággal. Szerverenként egy Útlevélhez egy fiók tartozik.

::: warn Őrizd meg a fájlt
Az Útleveled védi a végponttól végpontig titkosított privát üzeneteidet és a privát Jegyzetcsatornáidat is. Ha az Útlevélfájlt és a jelszavadat is elveszted, a titkosított tartalmat senki nem tudja helyreállítani.
:::

## Megerősített bejelentkezés

A webes kliensben létrehozott fiókok a jelszavadból **a böngészőben** két kulcsot származtatnak. Az egyiket elküldi a szervernek, ahol bcrypt-hash-ként tárolódik. A másik az Útlevél-magodat csomagolja be, és sosem hagyja el a böngészőt. A szerver így sosem látja egy ilyen fiók jelszavát, ezért a naplók, egy adatbázis-másolat vagy egy kíváncsi üzemeltető nem tudja elolvasni.

A régebbi fiókok, köztük a nagyon régi Android-alkalmazásokkal létrehozottak, a **Beállítások, Útlevél** oldalon kapcsolhatják be. A 3.0 előtti Android-alkalmazások nem tudnak bejelentkezni egy megerősített fiókba, és frissíteni kell őket.

A sikertelen Útlevél-igazolások öt hiba után 15 percre zárolják az adott azonosságot. A jelszavas bejelentkezést ez nem érinti.

## Kétlépcsős azonosítás

Kapcsold be a TOTP-t a **Beállítások, Fiókom** oldalon. Olvasd be a QR-kódot egy hitelesítő alkalmazással, és tárold biztonságos helyen a **helyreállító kódokat**: mindegyik csak egyszer használható. Az e-mailes ellenőrzés nincs megvalósítva; a kétlépcsős azonosítás TOTP-alapú.

## A jelszavad módosítása

Használd a **Beállítások, Fiókom, Jelszó módosítása** lehetőséget. A megerősített fiókoknál a böngésző újracsomagolja az Útleveledet az új jelszóval.

## Profil

Az avatárod, bannered, bemutatkozásod, egyéni státuszod és jelenléted a [Profilok, státusz és témák](personalization.html) oldalon szerepel. Az adatvédelmi beállítások döntik el, ki küldhet neked privát üzenetet, és ki láthatja a profilkártyádat.

## Barátok és privát üzenetek

Barátkérést felhasználónév alapján küldhetsz. A barátok indíthatnak kettesben folyó privát beszélgetést; a csoportos privát üzenetekben legfeljebb tíz ember lehet. Egy kettesben folyó beszélgetés a beszélgetés fejlécében lévő zár gombbal átkapcsolható végponttól végpontig titkosítottra, ami nem vonható vissza: a visszalépéshez töröld a beszélgetést és indíts újat. A részleteket a [Biztonság és adatvédelem](security.html) oldalon találod.
