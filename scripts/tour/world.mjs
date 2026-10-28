// Seeds a demo community ("Nightowls") on a throwaway server and then stays up as the webhook
// receiver for the demo slash-command bot. Usage: node world.mjs  (TOUR_BASE defaults to :8099)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Client, BASE, sleep } from './lib.mjs';

const PEOPLE = [
  ['mara', 'Mara Voss'], ['kai', 'Kai Tanaka'], ['priya', 'Priya Nair'], ['jonas', 'Jonas Weber'],
  ['lena', 'Lena Fischer'], ['nova', 'Nova Reyes'], ['tomas', 'Tomas Silva'],
];
const HOOK_PORT = 8765;

const c = {};
for (const [u, d] of PEOPLE) { c[u] = new Client(u); await c[u].register(u, d); }
const mara = c.mara;

const { server } = await mara.post('/api/servers', { name: 'Nightowls', description: 'A cozy corner for builders, gamers and night owls.', visibility: 'private' });
const sid = server.id;
const detail0 = await mara.get(`/api/servers/${sid}`);
const inviteCode = detail0.server.invite_code;
for (const [u] of PEOPLE.slice(1)) await c[u].post('/api/servers/join', { inviteCode });

const cat = async (name) => (await mara.post(`/api/servers/${sid}/categories`, { name })).category;
const catInfo = await cat('Info');
const catCom = await cat('Community');
const catBuild = await cat('Build');
const catVoice = await cat('Voice');
const ch = async (name, type, categoryId, extra = {}) => (await mara.post(`/api/servers/${sid}/channels`, { name, type, categoryId, ...extra })).channel;

const general0 = detail0.channels.find((x) => x.name === 'general');
await mara.patch(`/api/servers/${sid}/channels/${general0.id}`, { categoryId: catCom.id, topic: 'Hang out, say hi, share what you are up to.' });
const welcome = await ch('welcome', 'readonly', catInfo.id, { topic: 'Start here.' });
const news = await ch('announcements', 'announcement', catInfo.id, { topic: 'Server news from the team.' });
const memes = await ch('memes', 'public', catCom.id);
const music = await ch('music', 'public', catCom.id, { topic: 'What is on your playlist?' });
const afterDark = await ch('after-dark', 'public', catCom.id, { nsfw: true, topic: 'Adults only.' });
const dev = await ch('dev-talk', 'public', catBuild.id, { topic: 'Code, bugs, builds.' });
const design = await ch('design', 'public', catBuild.id);
const ideas = await ch('ideas', 'forum', catBuild.id);
await ch('journal', 'notes', catBuild.id);
const lounge = await ch('Lounge', 'voice', catVoice.id, { voiceQuality: 'high' });
const game = await ch('Game night', 'voice', catVoice.id);
const town = await ch('Town hall', 'stage', catVoice.id);

const role = async (name, color, permissions, iconEmoji) => {
  const r = (await mara.post(`/api/servers/${sid}/roles`, { name, color, permissions })).role;
  if (iconEmoji) await mara.patch(`/api/servers/${sid}/roles/${r.id}`, { iconEmoji });
  return r;
};
const builder = await role('Builder', '#2ecc71', 3 | 2048, '🛠️');
const admin = await role('Admin', '#e74c3c', 4095 & ~4096 | 8192 | 16384, '🛡️');
const mod = await role('Moderator', '#e67e22', 3 | 4 | 16384, '🔨');
const give = (u, r) => mara.put(`/api/servers/${sid}/members/${c[u].user.id}/roles/${r.id}`);
await give('mara', admin); await give('kai', builder); await give('priya', builder); await give('lena', mod);
await mara.patch(`/api/servers/${sid}/members/${c.kai.user.id}/nickname`, { nickname: 'Kai Tanaka' }).catch(() => {});

const wav = (freq, secs) => {
  const rate = 8000; const n = Math.floor(rate * secs); const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 9000 * (1 - i / n)), 44 + i * 2);
  return buf;
};
for (const [name, emoji, freq] of [['Airhorn', '📯', 660], ['Drumroll', '🥁', 220], ['Tada', '🎉', 880], ['Sad_trombone', '🎺', 330]]) {
  const fd = new FormData();
  fd.append('name', name); fd.append('emoji', emoji);
  fd.append('audio', new Blob([wav(freq, 0.5)], { type: 'audio/wav' }), `${name}.wav`);
  await mara.req('POST', `/api/servers/${sid}/sounds`, fd);
}

const say = async (u, channel, content, extra = {}) => (await c[u].post(`/api/servers/${sid}/channels/${channel.id}/messages`, { content, ...extra })).message;
const react = (u, m, emoji) => c[u].put(`/api/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`);

await say('mara', welcome, '**Welcome to Nightowls!** Be kind, keep it fun, and read the pinned rules in #announcements.');
const rules = await say('mara', news, '**Rules of the nest**\n1. Be kind.\n2. No spam.\n3. Voice channels are for chatting, not shouting.\n\nFriday: game night at 20:00 in the Game night room.');
await mara.put(`/api/messages/${rules.id}/pin`).catch(() => {});
for (const u of ['kai', 'priya', 'jonas', 'lena']) await react(u, rules, '👍');
await react('nova', rules, '🎉');

await say('kai', general0, 'Morning, owls! Anyone up for a quick build review later?');
await sleep(150);
await say('priya', general0, 'Count me in. I just pushed the new dark theme, it looks great on the phone too.');
const photo = await say('jonas', general0, 'Back in 10, coffee run. Save me a seat!');
await react('mara', photo, '☕'); await react('kai', photo, '😄');
await say('lena', general0, 'Reminder: **game night** is on Friday at 20:00. Bring snacks and good vibes.');
const nice = await say('mara', general0, 'Love this crew. Since we are all here: `/roll` works now, try it!');
for (const u of ['kai', 'priya', 'lena', 'tomas']) await react(u, nice, '❤️');
await say('tomas', general0, 'Rolling for initiative, I have a good feeling about this one.');
await say('nova', general0, '> Love this crew.\nSame. Also the new voice layout is so much better.', { replyToMessageId: nice.id });

await say('kai', memes, 'when the build passes on the first try');
const poll = await c.priya.post('/api/polls', { scopeType: 'channel', scopeId: music.id, question: 'Best coding music?', options: ['Lo-fi beats', 'Synthwave', 'Metal', 'Silence'], multiSelect: false });
await c.kai.put(`/api/polls/${poll.message.poll.id}/vote/${poll.message.poll.options[1].id}`).catch(() => {});
await say('lena', music, 'Currently looping a synthwave mix, 3 hours deep.');

const m1 = await say('kai', dev, 'The new Android voice screen is live. Tiles are bigger and the divider is draggable on desktop.');
await react('priya', m1, '🔥'); await react('mara', m1, '🚀');
await say('priya', dev, 'Tested on the emulator: two columns, scrolls fine with a bunch of people in the room.');
const th = await c.mara.post(`/api/servers/${sid}/channels/${dev.id}/threads`, { title: 'Voice layout feedback', content: 'Drop any layout feedback here so it stays in one place.', parentMessageId: m1.id });
await c.kai.post(`/api/servers/${sid}/channels/${dev.id}/threads/${th.thread.id}/messages`, { content: 'Could the divider remember its position per device?' });
await c.mara.post(`/api/servers/${sid}/channels/${dev.id}/threads/${th.thread.id}/messages`, { content: 'It does, saved in the browser. Nice catch though.' });
await say('priya', design, 'New palette draft: teal brand, soft slate backgrounds. Thoughts?');
for (const [t, b] of [['Shared soundboard clips', 'Let every server upload short clips and trigger them in voice.'], ['Dark/light schedule', 'Switch the theme automatically at sunset.']]) {
  await c.nova.post(`/api/servers/${sid}/channels/${ideas.id}/threads`, { title: t, content: b });
}

// Friends and DMs for the DM scenes
for (const u of ['kai', 'priya']) { await c[u].post('/api/friends/request', { username: 'mara' }); await mara.post(`/api/friends/${c[u].user.id}/accept`); }
await c.jonas.post('/api/friends/request', { username: 'mara' });
const dm = (await mara.post('/api/dms', { userId: c.kai.user.id })).dmId;
await c.kai.post(`/api/dms/${dm}/messages`, { content: 'Hey! Want to test the call quality before Friday?' });
await mara.post(`/api/dms/${dm}/messages`, { content: 'Sure, give me five minutes. Hop into Lounge when ready.' });
const dm2 = (await mara.post('/api/dms', { userId: c.priya.user.id })).dmId;
await c.priya.post(`/api/dms/${dm2}/messages`, { content: 'Sent you the palette file 🎨' });

// Slash-command bot: a webhook receiver that answers /roll and /coinflip
const botRes = await mara.post(`/api/servers/${sid}/bots`, { displayName: 'Dicey', persona: '', mentionEnabled: false });
const bot = botRes.bot;
const tok = (await mara.post(`/api/servers/${sid}/bots/${bot.id}/token`)).token;
const secret = (await mara.post(`/api/servers/${sid}/bots/${bot.id}/webhook/secret`)).secret;
await mara.patch(`/api/servers/${sid}/bots/${bot.id}`, { webhookUrl: `http://127.0.0.1:${HOOK_PORT}/hook`, webhookScope: 'mention', webhookEnabled: true });
const botReq = (m, p, b) => fetch(BASE + p, { method: m, headers: { authorization: `Bot ${tok}`, 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then((r) => r.json());
await botReq('PUT', '/api/bot/commands', { commands: [
  { name: 'roll', description: 'Roll a die', options: [{ name: 'sides', description: 'Number of sides', type: 'integer' }] },
  { name: 'coinflip', description: 'Flip a coin' },
  { name: 'secret', description: 'A private answer only you can see' },
] });

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', async () => {
    res.writeHead(200).end('ok');
    let ev; try { ev = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
    if (ev.type !== 'command') return;
    const id = ev.interaction.id;
    const who = ev.user.displayName;
    if (ev.command === 'roll') await botReq('POST', `/api/bot/interactions/${id}/respond`, { content: `${who} rolled a **${1 + crypto.randomInt(ev.options?.sides || 6)}** (d${ev.options?.sides || 6})` });
    else if (ev.command === 'coinflip') await botReq('POST', `/api/bot/interactions/${id}/respond`, { content: `${who} flipped a coin: **${crypto.randomInt(2) ? 'heads' : 'tails'}**` });
    else await botReq('POST', `/api/bot/interactions/${id}/respond`, { content: 'Psst, only you can see this message.', ephemeral: true });
  });
}).listen(HOOK_PORT, '127.0.0.1');

fs.writeFileSync(new URL('./world.json', import.meta.url), JSON.stringify({ sid, general: general0.id, lounge: lounge.id, town: town.id, inviteCode, password: 'tourpass123', afterDark: afterDark.id, dev: dev.id, music: music.id }, null, 1));
console.log('world ready', sid);
