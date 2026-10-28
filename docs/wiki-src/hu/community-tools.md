---
title: Közösségi eszközök
desc: Meghívók és egyedi linkek, sablonok, reakciószerepkörök, időzített események és statisztika.
group: Közösség üzemeltetése
order: 2
---

## Meghívók és egyedi linkek

A **Szerverbeállítások, Meghívók** további meghívólinkeket hoz létre, mindegyik saját lejárattal és használati korláttal. Az **Áttekintésben** lévő állandó meghívókód továbbra is működik.

![Meghívók és az egyedi link](../assets/img/settings-invites.jpg)

- **Lejárat**: egy perctől 90 napig, vagy soha.
- **Legnagyobb használatszám**: 1 és 1000 között, vagy korlátlan. Egy használat csak akkor számít, ha valaki ténylegesen csatlakozik.
- **Korlátok**: tagonként legfeljebb 25, szerverenként legfeljebb 100 aktív meghívó.
- **Egyedi link**: egy rövid név (3-32 betű, számjegy és kötőjel), amit kód helyett be lehet gépelni. Soha nem jár le; töröld, ha le akarod állítani.
- **Közvetlen meghívók** küldhetők valaki profilkártyájáról, a csatornameghívók pedig csak egyetlen csatornához adnak hozzáférést.

A lejárt vagy elhasznált meghívó ezt közli, ahelyett hogy csendben meghiúsulna.

## Szerversablonok

A **Szerverbeállítások, Sablonok** a szerver szerkezetét megosztható kóddal ellátott sablonként menti: szerepkörök jogosultságokkal, kategóriák, csatornák, csatornajogosultságok és a szabályszöveg. Aki a szerver létrehozásakor beilleszti a kódot a **Sablonkód** mezőbe, egy vadonatúj privát szervert kap ezzel a szerkezettel, és ő lesz a tulajdonosa.

A tagok, üzenetek, emodzsik, botok és meghívók **sosem** másolódnak. A szervered módosítása után a **Frissítés** frissíti a sablont.

## Reakció szerepkörök

**Szerverbeállítások, Reakció szerepkörök** (a **Szerepkörök kezelése** jogosultság kell hozzá). Válassz egy csatornát és az egyik friss üzenetét, egy emodzsit és egy szerepkört. Aki ezzel az emodzsival reagál, megkapja a szerepkört, és elveszti, ha visszavonja a reakciót. Az emodzsit a rendszer helyezi el az üzeneten.

- Jelöld be a **Kizárólagos** lehetőséget, hogy egy üzenet emodzsijai egyetlen választásként viselkedjenek.
- A moderációs vagy kezelői jogokkal rendelkező szerepkörök nem használhatók.
- Azok a tagok, akiknek még el kell fogadniuk a szerver szabályait, nem reagálhatnak.

![Reakció szerepkörök](../assets/img/settings-reactionroles.jpg)

## Fogadás

Lásd: [Moderáció és biztonság](moderation.html#rules-screening-onboarding): szabályok, szerepköröket osztó kérdések és elfogadás az írás előtt.

## Időzített események

Hozz létre szerveresemény nevet, leírást, helyet, opcionális hozzárendelt csatornát, kezdő és záró időpontot adva. A tagok **érdekli** jelölést adhatnak, a módosítások élőben közvetítődnek.

## Statisztika

A **Szerverbeállítások, Statisztika** (a **Szerver kezelése** jogosultság kell hozzá) mutatja a tagszámot és a növekedést, a napi és a napszak szerinti üzenetszámot, a legforgalmasabb csatornákat, a legaktívabb tagokat, és hogy hányan voltak aktívak ezen a héten, az utolsó 7, 14, 30 vagy 90 napra.

![Statisztika](../assets/img/settings-insights.jpg)

Minden a már meglévő üzenetekből és tagságokból számolódik. Semmit nem követ külön. Az időpontok UTC szerintiek, a számok nagyjából percenként frissülnek.

## Üdvözlőképernyő

Emelj ki néhány csatornát egy-egy rövid leírással, hogy az új tag tudja, hol kezdje. Nyisd meg a **Szerverbeállítások, Üdvözlőképernyő** oldalt.

## Egyéni emodzsik, matricák és hangpult

Tölts fel saját emodzsikat és matricákat (képeket), valamint rövid hangklipekből álló **hangpultot** a **Szerverbeállításokban**. Az emodzsik az üzenetekben és reakciókban működnek; a matricák üzenetként mennek ki; a hangpult a hangszobákban játszik le. Az animált matricák (GIF, APNG, animált WebP) a választóban és a matricaszerkesztőkben állóképként jelennek meg, amíg rájuk nem viszed az egeret; a csevegésben egyszerre csak a képernyőn lévő hat legújabb mozog, bármelyiket lejátszhatod az egérrel.
