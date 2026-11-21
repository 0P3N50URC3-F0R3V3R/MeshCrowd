---
title: Föderáció
desc: Szerverek összepárosítása, hogy az emberek elérjék egymást, mit osztanak meg, és milyen biztonsági szabályok állnak mögötte.
group: Bővítés
order: 4
---

A **föderáció** lehetővé teszi, hogy MeshCrowd szerverek megbízzanak egymásban, így az embereik kapcsolatba léphetnek. Annyi szerverrel párosíthatsz, amennyivel csak szeretnél: minden párosítást külön kell létrehozni és elfogadni, és a bizalom sosem adódik tovább egy harmadik szerveren keresztül. **Alapból kikapcsolt**: egy önálló szerver nem nyit föderációs útvonalat és nem futtat föderációs munkafolyamatot. Az Útlevéllel való bejelentkezés enélkül is működik.

## Bekapcsolás

Állítsd a `"federation": { "enabled": true }` értéket a `data/config.json` fájlban és indítsd újra. Megjelenik egy **Föderáció** oldal az adminpanelen.

## Párosítás

1. Egy oldaladminisztrátor beállítja a föderációs admin jelszót az első alkalommal (bejelentkezve, vagy a szervergépről). Egy névtelen látogató nem foglalhatja le.
2. Hozz létre egy **meghívólinket** az egyik szerveren, és **váltsd be** a másikon. Ismételd meg minden további szerverrel, amelyhez csatlakozni szeretnél.
3. Mindkét oldalnak kifejezetten **el kell fogadnia** a másikat az **Admin, Föderáció** oldalon. A függőben lévő partner semmit nem tehet, csak befejezheti vagy megszakíthatja a saját párosítását.
4. **Vond vissza** bármikor. A visszavonás az adott párosítás mindkét oldalán megszünteti a bizalmat, a többi párosításodat nem érinti.

## Mit oszt meg a föderáció

- **Barátkérések és privát üzenetek** a párosított szerverek emberei között.
- **Felfedezés**: minden párosított példány nyilvános szerverei megjelennek a könyvtárban.
- **Csatlakozás**: egy másik példányon lévő szerverhez `kód@domain` meghívóval csatlakozhatsz. A távoli szerverek megjelennek a szerversávodban, és egyszerűsített nézetben nyílnak meg szöveges csatornákkal, előzményekkel, írással, szerkesztéssel, törléssel és reakciókkal.

A távoli szerverek **élőben, proxyn át** jelennek meg a tulajdonos példányról: semmi nem másolódik. Elhalványulnak, amíg az a példány offline.

## Amit még nem tud

- A távoli szervereknek csak szöveges csatornáik vannak: nincs melléklet, szál, hang vagy taglista.
- A föderált privát üzenetek a TLS-en túl nem titkosítottak, a partnerszerver pedig a saját példányát úgy tárolja, ahogy jónak látja.

## Biztonsági szabályok

- A partnerekben **csak az azonosság** tekintetében bízik. A jogosultságokat mindig az a példány dönti el, amelyik a szervert birtokolja.
- A példányok közötti hívások aláírtak és sebességkorlátozottak.
- A kimenő hívások elutasítják az átirányításokat és rögzítik az ellenőrzött címet, így egy párosított partner nem irányíthatja a szerveredet a belső hálózatodra.
