---
title: Moderáció és biztonság
desc: AutoMod, szabályok elfogadtatása, ellenőrzési szintek, korhatáros csatornák, időkizárások, tiltások, bejelentések, napló és adattisztítás.
group: Közösség üzemeltetése
order: 1
---

A MeshCrowd olyan eszközöket ad a moderátoroknak, amelyek a probléma elterjedése előtt lépnek, és utólag nyomot hagynak. A legtöbb a **Szerverbeállításokban** található.

## AutoMod

**Szerverbeállítások, AutoMod** (a **Szerver kezelése** jogosultság kell hozzá). A szabályokat a rendszer az üzenet csatornában vagy szálban való közzététele előtt, és az üzenet szerkesztésekor is ellenőrzi.

![AutoMod-szabályok](../assets/img/settings-automod.jpg)

| Szabály | Mit fog meg |
|---|---|
| Tiltott szavak | Szavak vagy kifejezések, egész szóként vagy részletként, `*` helyettesítő karakterrel |
| Linkek | Minden link tiltása, csak a listázott oldalak engedélyezése, vagy a listázott oldalak tiltása (az aldomaineket is beleértve) |
| Tömeges megemlítés | Túl sok ember vagy szerepkör egy üzenetben; az `@everyone` és `@here` mindig soknak számít |
| Spam | Túl sok üzenet egy időablakban, vagy ugyanaz az üzenet ismételve |
| Nagybetűk | A nagybetűk túl nagy aránya |

Egy találat elutasítja az üzenetet, megnevezi a szabályt a szerzőnek, naplózza (szerző, csatorna és az első 200 karakter), és ha a szabály így rendelkezik, **időkizárja a szerzőt**. Minden szabály mentesíthet szerepköröket és csatornákat. A tulajdonost és azokat, akik kezelhetik az adott csatorna üzeneteit, sosem szűri. A botokat és webhookokat nem szűri. A napló szerverenként az utolsó 500 találatot tartja meg.

::: note Nincs reguláris kifejezés
A szabályok szándékosan nem fogadnak el felhasználó által írt reguláris kifejezéseket, amelyek úgy is összeállíthatók, hogy lefagyasszák a szervert. Használj helyette helyettesítő karaktert.
:::

## Szabályok elfogadtatása (fogadás) {#rules-screening-onboarding}

Kapcsold be a **Az új tagoknak el kell fogadniuk a szabályokat** lehetőséget a **Szerverbeállítások, Fogadás** alatt. Az új tagok üdvözlőablakot látnak a szabályokkal, legfeljebb öt, szerepkört osztó kérdéssel és egy „elfogadom” jelölőnégyzettel. Az elfogadásig körülnézhetnek abban, amit a szerepköreik mutatnak, de nem írhatnak, nem reagálhatnak, nem csatolhatnak fájlt és nem csatlakozhatnak hanghoz; a **Később** választása ebben a csak megtekintő állapotban tartja őket. A már bent lévő tagokat nem érinti. A moderációs vagy kezelői jogokkal rendelkező szerepkörök kérdésekkel sosem oszthatók ki.

![Amit egy új tag lát](../assets/img/onboarding.jpg)

## Ellenőrzési szint

A **Szerverbeállítások, Áttekintés, Ellenőrzési szint** visszatartja a vadonatúj fiókokat és a frissen csatlakozókat az írástól:

| Szint | Követelmény |
|---|---|
| Nincs | Semmi |
| Alacsony | Legalább 5 perces fiók |
| Közepes | 5 perces fiók és 10 perce tag |
| Magas | 7 napos fiók és 10 perce tag |

A tulajdonost, a botokat és mindenkit, aki az @everyone-on kívül más szerepkörrel rendelkezik, sosem tartja vissza. Minden helyi: nincs e-mailes vagy telefonos ellenőrzés.

## Korhatáros csatornák

Jelöld be a **Korhatáros csatorna (18+)** lehetőséget szöveges csatorna létrehozásakor vagy szerkesztésekor. A csatorna **18+** jelvényt kap, és amikor egy tag először megnyit egyet, egyszer, az egész fiókjára megerősíti, hogy **elmúlt 18 éves**. Ez egyszerű kattintásos megerősítés: semmit nem ellenőriz, és semmit nem küld senkinek. A meg nem erősített tagok nem olvashatnak és nem írhatnak ott, és a csatorna kimarad a keresésükből.

![Korhatáros csatorna](../assets/img/age-gate.jpg)

::: warn Udvariassági korlát, nem hozzáférés-szabályozás
A korlát nem akadályozza meg, hogy a meg nem erősített tag kliense megkapja a csatorna élő eseményeit. Ha embereket akarsz kizárni egy csatornából, használj csatornajogosultságokat és privát csatornákat.
:::

## Tagok: időkizárás, kirúgás és tiltás

A tag jobb gombos menüjéből vagy a **Szerverbeállítások, Tagok** oldalról:

- Az **Időkizárás** egy időre megakadályozza, hogy valaki írjon vagy beszéljen (a **Tagok moderálása** jogosultság kell hozzá).
- A **Kirúgás** eltávolít valakit, aki meghívóval újra csatlakozhat.
- A **Tiltás** eltávolít valakit, és megakadályozza az újracsatlakozást.
- A **Lassított mód** korlátozza, milyen gyakran írhatnak az emberek egy csatornában.
- **Mindenki némítása** a hangszobákban.

## Bejelentések

Bármely tag bejelenthet egy üzenetet vagy egy embert. A bejelentések egy sorba kerülnek, amelyet a bejelentési jogosultsággal rendelkező oldaladminisztrátorok oldhatnak meg az adminpanelről.

## Napló

A **Szerverbeállítások, Naplózás** felsorolja, mit tettek a moderátorok: szerepkör- és csatornamódosításokat, kirúgásokat, tiltásokat, meghívókat, AutoMod-szabályok szerkesztését és még többet, a ki és a mikor megjelölésével.

## Adattisztítás {#data-pruning}

Egy megadott dátumnál régebbi üzenetelőzmények törlése. A **Tartalom ritkítása** jogosultsággal rendelkező szerverfelügyelők a saját szerverükön, az oldaladminisztrátorok az egész példányon végezhetik. Minden ritkítás előbb előnézetet mutat (üzenetszám, mellékletek és méret), és futhat azonnal vagy **24 órás előzetes értesítés** után, ami időt ad a tagoknak a dolgok elmentésére. Az érintett beszélgetésben mindig megjelenik egy értesítés, és a mellékletek megtarthatók vagy törölhetők.

## Bevált gyakorlat

- Kezdd egy világos szabályüzenettel és fogadással.
- Nyilvános szervereken kapcsolj be ellenőrzési szintet.
- A moderátoroknak csak a szükséges jogosultságokat adó szerepkört add.
- Időnként nézd át az AutoMod naplóját a szabályok finomhangolásához.
