---
title: Perjeles parancsok
desc: Beépített parancsok, hogyan tesznek közzé sajátot a botok, opciók, privát válaszok és egy teljes példa.
group: Bővítés
order: 2
---

Gépelj `/` jelet egy szervercsatornában, hogy lásd a használható parancsokat. A lista a **beépített parancsokat** keveri a **botok** által közzétettekkel. A telefonos felületen a találó parancsok chipekként jelennek meg az üzenetmező fölött.

![A perjeles parancsok felugró listája](../assets/img/slash-popup.jpg)

## Beépített parancsok

| Parancs | Mit csinál |
|---|---|
| `/me <művelet>` | Dőlt betűs cselekvést küld |
| `/nick [név]` | Módosítja a becenevedet ezen a szerveren |
| `/shrug`, `/tableflip`, `/unflip` | Hozzáadja a klasszikus szövegarcokat |
| `/spoiler <szöveg>` | Spoiler mögé rejtett szöveget küld |
| `/thread <név>` | Szálat indít |
| `/topic [szöveg]` | Megmutatja vagy beállítja a csatorna témáját (jogosultsággal) |
| `/dm`, `/msg <felhasználónév> [üzenet]` | Privát üzenetet nyit vagy ír |
| `/afk [üzenet]` | Üzenettel tétlenre állít |
| `/invite` | Meghívót mutat |
| `/ping`, `/help` | Kapcsolatellenőrzés és a parancsok listája |

## Egy bot parancsának használata

Válassz egy parancsot a felugró listából (nyílbillentyűkkel és **Tab**bal, vagy kattintással). Az opciókat sorrendben kell megadni, és az **utolsó szöveges opció a sor hátralévő részét kapja**, így idézőjel nem kell:

```
/roll 20 raid boss
```

Bármely opciót névvel is megadhatod: `/roll sides:20 note:raid boss`. Ha hiányzik egy kötelező opció, megmondja, melyik, és a szöveged megmarad. Ha két botnak ugyanaz a parancsneve, a felugró lista `név@botnév` alakot mutat.

Az Enter megnyomásakor a parancs a botnak megy, amely kétféleképpen válaszolhat:

- **Normál üzenet**, amelyet a bot küld, „Mara Voss használta: /roll” fejléccel.
- **Privát (átmeneti) válasz**, amelyet csak te látsz. A csatornában „Csak te látod ezt” felirattal jelenik meg, **sosem tárolódik**, és az **Elrejtés** megnyomásakor vagy újratöltéskor eltűnik.

![Egy nyilvános és egy privát válasz](../assets/img/slash-answer.jpg)

## Parancsok közzététele (botfejlesztőknek)

A botnak **tokenre** és **működő webhookra** van szüksége (lásd: [Botok, API és webhookok](bots-api.html)). Csak az engedélyezett webhookkal rendelkező botok jelennek meg a felugró listában, mert így értesülnek egy használatról.

```
PUT /api/bot/commands
Authorization: Bot <token>

{ "commands": [
  { "name": "roll", "description": "Dobj egy kockával",
    "options": [
      { "name": "sides", "type": "integer", "required": true },
      { "name": "note", "type": "string" } ] },
  { "name": "whisper", "description": "A választ csak te látod",
    "options": [ { "name": "text", "type": "string", "required": true } ] } ] }
```

A hívás **az egész listát lecseréli**. Szabályok: legfeljebb 25 parancs, parancsonként legfeljebb 10 opcióval; a nevek `a-z`, `0-9`, `_` és `-` karaktereket használnak, legfeljebb 32 hosszan; az opció `type` értéke `string` (alapértelmezett), `integer` vagy `boolean`; a kötelező opciók legyenek elöl.

### Egy használat fogadása

A webhook `command` típusú eseményt kap:

```json
{ "type": "command",
  "bot": { "id": 3, "userId": 41, "username": "dicey" },
  "server": { "id": 1, "name": "Nightowls" },
  "channel": { "id": 7, "name": "general", "type": "public" },
  "user": { "id": 5, "username": "mara", "displayName": "Mara Voss" },
  "command": "roll",
  "options": { "sides": 20, "note": "raid boss" },
  "interaction": { "id": "9f2c...", "expiresAt": "2026-10-19T12:00:00.000Z" } }
```

Az opciók már a típusuknak megfelelően átalakítva érkeznek, és a szerver ellenőrizte, hogy a kötelezők megvannak.

### Válaszolás

```
POST /api/bot/interactions/<interakció azonosító>/respond
Authorization: Bot <token>

{ "content": "17-est dobtál", "ephemeral": false }
```

Az `"ephemeral": true` privát választ ad. Az interakció **15 percig** érvényes és legfeljebb **öt** választ fogad, így a bot küldhet nyugtázást és utólagos választ is.

### Egy teljes példa

```js
import http from 'node:http';
const TOKEN = process.env.BOT_TOKEN, BASE = 'https://chat.example.com';

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    res.end('ok');                       // előbb a webhookra válaszolj
    const event = JSON.parse(body);      // éles kódban ellenőrizd az aláírást
    if (event.type !== 'command' || event.command !== 'roll') return;
    const n = 1 + Math.floor(Math.random() * event.options.sides);
    await fetch(`${BASE}/api/bot/interactions/${event.interaction.id}/respond`, {
      method: 'POST',
      headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `${event.user.displayName} dobása: ${n}` }),
    });
  });
}).listen(3000);
```

## Korlátok

- A parancsok szervercsatornákban működnek, szálakban és privát üzenetekben nem.
- A tagnak üzenetküldési jogosultság kell a csatornában, és nem lehet időkizárt vagy ellenőrzési szint által visszatartott.
- A parancshasználat személyenként 10 másodpercenként legfeljebb 10 lehet.
