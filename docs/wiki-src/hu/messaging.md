---
title: Üzenetküldés és keresés
desc: Írás, szerkesztés, válaszok, szálak, fórumok, szavazások, hang- és időzített üzenetek, mellékletek és keresés.
group: A MeshCrowd használata
order: 3
---

![Egy csatorna képpel, kódrészlettel és szavazással](../assets/img/chat-general.jpg)

## Az alapok

Írj az alul lévő mezőbe és nyomj **Entert**. Új sorhoz használd a **Shift+Entert**. Egy üzenet fölé víve megjelennek a műveletei: válasz, reakció, szál, szerkesztés, kitűzés, továbbítás és még több. Üres mezőben a **Fel** billentyű az utolsó üzenetedet szerkeszti.

### Formázás

- `**félkövér**`, `*dőlt*`, `` `kód` `` és nyelvvel megjelölt kódblokkok a kiemeléshez.
- `||spoiler||` addig rejti a szöveget, amíg rá nem kattintanak.
- Gépelj `:` majd nevet az emoji-rövidkódokhoz, `@`-ot a megemlítésekhez és `#`-ot a csatornákhoz.
- A linkek előnézeti kártyát kapnak, kivéve a titkosított privát üzenetekben.

### Megemlítések

Az `@felhasználónév` egy embert értesít, az `@szerepkörnév` egy szerepkört (egyszavas nevek), az `@everyone` vagy `@here` pedig mindenkit, illetve az online lévőket. A botok sosem pingelhetik az egész szervert.

## Válaszok, szálak és fórumok

- A **Válasz** idézi az üzenetet. A **Továbbítás** egy üzenetet másik beszélgetésbe másol.
- A **Szálak** bármely üzenetből indulnak, és saját előzményük van. A **Szálak** panel egy csatorna összes szálát listázza. A szál létrehozója vagy egy csatornakezelő ikont adhat neki vagy törölheti.
- A **Fórum** csatornák teljesen bejegyzésekből állnak, mindegyiknek saját szála van. A bejegyzések kártyaként jelennek meg a szerzővel, a nyitóüzenet előnézetével, egy képes bélyegképpel, a reakciók és a válaszok számával. A keresőmező bejegyzést keres vagy indít, rendezhetsz **Legutóbbi aktivitás** vagy **Legújabb bejegyzések** szerint, a lezárt bejegyzéseken **Lezárt** jelvény áll, és csak moderátorok írhatnak beléjük. Széles képernyőn a kiválasztott bejegyzés a lista mellett nyílik meg, telefonon teljes képernyőn.

![Fórumcsatorna](../assets/img/forum.jpg)

## Reakciók, szavazások és kitűzések

Kattints egy reakcióra, hogy a tiéd is megjelenjen. A **szavazások** kérdést és opciókat kapnak, és élő százalékokat mutatnak; ha a szavazás engedi, több opciót is választhatsz. A kitűzött üzenetek a kitűzési panelen láthatók.

## Mellékletek

Üzenetenként legfeljebb öt melléklet. A képek feltöltés előtt átméretezhetők (Eredeti, 1920, 1280 vagy 800 pixel), az animált GIF-ek lejátszás- és szünetgombot kapnak, és az ékezetes fájlnevek megmaradnak. A méretkorlát a konfiguráció `maxUploadMb` értékéből és az adminpanelből jön; néhány fájltípus (futtathatók, HTML, SVG) mindig tiltott.

## Hangüzenetek

Az üzenetmező **mikrofon** gombja legfeljebb öt percet rögzít. Egy piros sáv mutatja az időt; a szemetes elveti a felvételt, a küldés gomb pedig kis lejátszóval (lejátszás, haladás, tekerés) elküldi. Opusként rögzül a böngészőben, az asztali alkalmazásban vagy az Android-alkalmazásban, és mikrofonengedélyt, valamint HTTPS-t vagy `localhost`-ot igényel. A hangüzenetek nem érhetők el a végponttól végpontig titkosított privát üzenetekben.

## Időzített üzenetek

Az üzenetmező melletti **óra** gomb megnyitja a **Küldés később** ablakot a beírt szöveghez. Válassz időpontot vagy egy előbeállítást, például holnap 9:00-t. Az üzenet abban a pillanatban a nevedben megy ki, ugyanazokkal az ellenőrzésekkel, mint egy normál üzenet, így még elutasítható, például ha időkizárt vagy az AutoMod kifogásolja. A sikertelenek a listádban maradnak az okukkal, és bármit megszakíthatsz, amit időzítettél. A telefonos felületen tartsd lenyomva a küldés gombot.

A titkosított privát üzenetek, a Jegyzetcsatornák és a más szervereken lévő partnerekkel folytatott privát üzenetek nem időzíthetők.

## Perjeles parancsok

Gépelj `/` jelet, hogy lásd az elérhető parancsokat. A beépített parancsok közé tartozik a `/me`, `/nick`, `/shrug`, `/spoiler`, `/thread`, `/topic` és `/help`. A botok sajátot is hozzáadhatnak; lásd: [Perjeles parancsok](slash-commands.html).

## Keresés

A keresést a nagyítóval nyithatod meg. Jelöld be, mely mezőkre keressen: **üzenetszöveg** (teljes szöveges keresés), **felhasználónevek**, **csatornanevek** és **mellékletek fájlnevei**. Az eredmények az üzenetnél nyílnak meg a csatornájában. A keresés csak azokat a beszélgetéseket fedi, amelyeket látsz; a Jegyzetcsatornák és a titkosított privát üzenetek nem kereshetők, a korhatáros csatornák pedig kimaradnak, amíg nem erősíted meg a korodat.

![Keresési találatok](../assets/img/search.jpg)

## Értesítések

Minden csatorna és privát beszélgetés elnémítható, beállítható csak megemlítésekre vagy mindenre (az alapérték csatornáknál a megemlítések, privát üzeneteknél minden). Az asztali értesítések a böngészőt vagy az asztali alkalmazást használják. Az asztali alkalmazás tálcaikonja olvasatlan jelvényt mutat. Androidon lásd az [Android-alkalmazás](android.html) oldalt. Az olvasatlan üzenetekkel megnyitott csevegésben egy piros **Új** vonal jelöli az elsőt; a beállításait lásd a [Profilok, állapot és témák](personalization.html#olvasatlan-zenetek) oldalon.

## Bejövő webhookok

A csatornakezelő a csatorna beállításai alatt **bejövő webhookokat** hozhat létre. Egy szkript JSON-t küld a webhook URL-jére, és a webhook nevével és avatárjával megjelenik egy üzenet. Lásd: [Botok, API és webhookok](bots-api.html).
