---
title: Botok, API és webhookok
desc: MI-botok, bot-tokenek, a bot API, aláírt kimenő webhookok, bejövő webhookok és egy n8n-recept.
group: Bővítés
order: 1
---

A **bot** egy különleges fiók, amely egyetlen szerverhez tartozik. A nevén **BOT** jelvény látszik, és nem tud bejelentkezni. Egy bot két feladatot láthat el egyszerre:

- **MI-beszélgetőtárs**, amelyet Ollama vagy bármely OpenAI-kompatibilis szolgáltatás hajt. A megemlítésekre válaszol, és ha engedélyezed, privát üzenetekre is.
- **Integráció**, amelyet a **Bot API** és az **aláírt webhookok** vezérelnek az n8n, szkriptek és saját eszközeid számára.

![Botok a Szerverbeállításokban](../assets/img/settings-bots.jpg)

## Bot létrehozása

A **Botok kezelése** jogosultsággal rendelkező szerveradminisztrátorok a **Szerverbeállítások, Botok** alatt hozhatnak létre botot. Az oldaladminisztrátorok az adminpanelről bármely szerverhez is létrehozhatnak. A botnak van neve, avatárja, opcionális MI-szolgáltatója és modellje, személyisége (a rendszerprompt), megemlítés be vagy ki, privát üzenet mód be vagy ki, és hogy hány friss üzenetet lát. **Hagyd üresen a szolgáltatót az csak API-s botnál.**

## MI-botok

A szolgáltatókat egy oldaladminisztrátor állítja be az **Admin, AI** alatt: típus (Ollama vagy OpenAI-kompatibilis), alap URL, opcionális API-kulcs (titkosítva tárolva, és soha nem jelenik meg újra), opcionális modell-engedélyezőlista (a **Kapcsolat tesztelése** gombbal kérhető le a lista), időkorlát és párhuzamos kérések korlátja. Jelöld be a **A szerveradminok használhatják ezt a szolgáltatót** lehetőséget, hogy a szerveradminoknak is felkínáld.

::: warn Adatvédelem
Mindent, amit egy botnak elküldenek, a szolgáltatója kap meg. A botok sosem olvasnak végponttól végpontig titkosított privát üzeneteket, csoportos privát üzeneteket vagy Jegyzetcsatornákat, és csak azokat a csatornákat látják, amelyeket a szerepkörük láthat. A kimenetük nem említhet meg senkit, és nincsenek eszközeik vagy műveleteik.
:::

Csak CPU-s gépen használj kis modelleket (nagyjából 3-4 milliárd paraméterest), vagy irányítsd a szolgáltatót egy erősebb gépen futó Ollamára. Korlátok: alapból egyszerre egy kérés szolgáltatónként, legfeljebb öt várakozik, tíz másodperc várakozás felhasználónként és botonként, a válaszok legfeljebb 4000 karakteresek.

## A bot tokenje

Nyiss meg egy botot és nyomd meg a **Token létrehozása** gombot. A token (`mcb_` előtaggal kezdődik) **egyszer** jelenik meg; csak az SHA-256 hash-e tárolódik. Újragenerálása leállítja a régit. Fejlécként küldd:

```
Authorization: Bot mcb_xxxxxxxxxxxxxxxxxxxxxxxx
```

A bot csak a saját szerverét látja, csak azt, amit a szerepköre enged, sosem látja a Jegyzetcsatornákat, és sosem látja a titkosított vagy csoportos privát üzeneteket. Korlátok: botonként percenként 120 kérés és 30 írás (`429` `Retry-After` fejléccel). Az `@everyone` és `@here` a bot üzeneteiben hatástalanított.

## Bot API

| Kérés | Cél |
|---|---|
| `GET /api/bot/me` | Ki a bot és mi a webhookjának állapota |
| `GET /api/bot/channels` | A botnak látható csatornák |
| `GET /api/bot/messages?scopeType=channel&scopeId=7&limit=50` | A legrégebbivel kezdődő üzenetoldal olvasása |
| `POST /api/bot/messages` | Üzenet küldése |
| `PATCH /api/bot/messages/:id` | A bot saját üzenetének szerkesztése |
| `DELETE /api/bot/messages/:id` | A bot saját üzenetének törlése |
| `PUT /api/bot/commands` | Perjeles parancsok közzététele: lásd [Perjeles parancsok](slash-commands.html) |
| `POST /api/bot/interactions/:id/respond` | Perjeles parancs megválaszolása |

Üzenet küldése:

```
curl -X POST https://chat.example.com/api/bot/messages \
  -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
  -d '{"scopeType":"channel","scopeId":7,"content":"A 214-es build sikeres"}'
```

A `scopeType` értéke `channel`, `thread` vagy `dm` (privát üzenethez a bot privát üzenet módja kell). A tartalom legfeljebb 4000 karakter. A teljes referencia a tároló `docs/API.md` fájljában található.

## Kimenő webhookok

Adj a botnak egy **webhook URL-t**, és a MeshCrowd aláírt JSON-eseményt küld rá, valahányszor történik valami, amiről hallania kell. A bot beállításaiban válaszd ki, mely üzenetek számítanak: **megemlítések** (egy @megemlítés, egy válasz a botnak, vagy egy privát üzenet) vagy **minden** üzenet a bot által látott csatornákban.

Az **aláíró titkot** a **Titok cseréje** gombbal hozd létre; egyszer jelenik meg. Minden kézbesítés egy `POST` a következő fejlécekkel:

| Fejléc | Jelentés |
|---|---|
| `X-MeshCrowd-Event` | `message_create`, `command` vagy `ping` |
| `X-MeshCrowd-Delivery` | A kézbesítés egyedi azonosítója |
| `X-MeshCrowd-Timestamp` | Unix-másodperc |
| `X-MeshCrowd-Signature` | `sha256=` majd a `<időbélyeg>.<nyers törzs>` HMAC-SHA256 értéke a titokkal kulcsolva |

Ellenőrizd az aláírást, és utasítsd el azokat a kézbesítéseket, amelyek időbélyege néhány percnél régebbi:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', secret)
  .update(timestamp + '.' + rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
```

Egy üzenetesemény így néz ki:

```json
{ "type": "message_create", "trigger": "mention",
  "bot": { "id": 4, "userId": 12, "username": "relay_bot" },
  "server": { "id": 2, "name": "Hooks" },
  "channel": { "id": 7, "name": "general", "type": "public" },
  "message": { "id": 91, "content": "@relay_bot foglald ezt össze",
    "author": { "id": 3, "username": "anna", "displayName": "Anna", "isBot": false } } }
```

A botok által írt üzenetek sosem váltanak ki kézbesítést, így a botok nem tudnak végtelen ciklust csinálni. Egy bot eseményei sorrendben érkeznek. Az 5xx, 429, 408 vagy hálózati hibát újrapróbálja (összesen háromszor, nagyjából 0, 5 és 30 másodperc után); más 4xx válaszokat nem; botonként legfeljebb 50 esemény vár. Az URL tartalmazhat útvonalat és lekérdezést, de hitelesítő adatot nem, az átirányításokat nem követi, és magáncímet (localhost vagy LAN) csak akkor enged, ha egy **oldaladminisztrátor** mentette az URL-t. A fogadód kipróbálásához használd a **Teszt esemény küldése** gombot.

## n8n-recept

1. Vegyél fel egy **Webhook** indító csomópontot (módszer: `POST`), és illeszd be az éles URL-jét a botba.
2. Opcionálisan ellenőrizd az aláírást egy Code csomópontban.
3. Válaszolj egy **HTTP Request** csomóponttal: `POST https://a-te-hosztod/api/bot/messages`, fejléc `Authorization: Bot <token>`, JSON-törzs `{"scopeType": "channel", "scopeId": {{ $json.body.channel.id }}, "content": "...", "replyToMessageId": {{ $json.body.message.id }}}`.

Szálhoz használd a `scopeType: "thread"` értéket az esemény `threadId` mezőjével, privát üzenethez pedig a `scopeType: "dm"` értéket a `dmId` mezővel.

## Bejövő webhookok

Egyszerűbb eszköz az olyan szkriptekhez, amelyeknek csak posztolni kell: a csatornakezelő a csatorna beállításaiban létrehoz egy **bejövő webhookot**, és kap egy URL-t. Küldj rá JSON-t `POST`-tal, és megjelenik egy üzenet a webhook nevével és avatárjával. Se bot, se token nem kell hozzá.

## Bevált gyakorlat

- Ne tartsd a tokeneket és titkokat tárolókban; ha kiszivárognak, cseréld őket.
- Olyan szerepkört adj a botnak, amely csak a szükséges csatornákat látja.
- A `429`-et kezeld úgy, hogy megvárod a `Retry-After` időt.
