import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTargets, filterTargets, buildMessage, pushRecent, parseKey, dmKey, channelKey } from './shareTargets.mjs';

const servers = [
  { id: 1, name: 'Home', server: { id: 1, name: 'Home' }, channels: [{ id: 10, name: 'general', type: 'public', canSend: true }, { id: 11, name: 'news', type: 'announcement', canSend: false }, { id: 12, name: 'Lounge', type: 'voice', canSend: true }, { id: 13, name: 'secret', type: 'private', canSend: true }, { id: 14, name: 'wiki', type: 'forum', canSend: true }] },
  { id: 2, name: 'Work', channels: [{ id: 20, name: 'dev', type: 'public', canSend: true }] },
];
const dms = [{ id: 5, title: 'Anna', lastId: 50 }, { id: 6, title: 'Bela', lastId: 90 }, { id: 7, title: 'Pinned Pete', lastId: 1, pinned: true, who: { id: 70 } }, { id: 8, title: 'Hidden', lastId: 99, hidden: true }];

test('targets: only writable text channels, DMs by pin then recency, hidden DMs left out', () => {
  const t = buildTargets({ dms, servers });
  assert.deepEqual(t.map((x) => x.key), ['dm:7', 'dm:6', 'dm:5', 'ch:1:10', 'ch:1:13', 'ch:2:20']);
  assert.equal(t[3].title, '#general');
  assert.equal(t[3].sub, 'Home');
  assert.equal(t[3].server, servers[0].server);
  assert.equal(t[0].who, dms[2].who);
});

test('recents move to the front once, ignore stale keys, keep their order', () => {
  const t = buildTargets({ dms, servers, recents: ['ch:2:20', 'dm:5', 'dm:999', 'ch:2:20'] });
  assert.deepEqual(t.slice(0, 2).map((x) => [x.key, x.section]), [['ch:2:20', 'recent'], ['dm:5', 'recent']]);
  assert.equal(t.filter((x) => x.key === 'dm:5').length, 1);
  assert.equal(t.length, 6);
});

test('search matches names and server names, case-insensitively, every word', () => {
  const t = buildTargets({ dms, servers });
  assert.deepEqual(filterTargets(t, 'ANNA').map((x) => x.key), ['dm:5']);
  assert.deepEqual(filterTargets(t, 'work dev').map((x) => x.key), ['ch:2:20']);
  assert.deepEqual(filterTargets(t, 'home').map((x) => x.key), ['ch:1:10', 'ch:1:13']);
  assert.equal(filterTargets(t, '  ').length, t.length);
  assert.deepEqual(filterTargets(t, 'zzz'), []);
});

test('message text: note, subject only when it adds something, then the text, within the limit', () => {
  assert.equal(buildMessage({ text: 'https://x.example.com', subject: 'Great article', note: '  look  ' }), 'look\nGreat article\nhttps://x.example.com');
  assert.equal(buildMessage({ text: 'Great article here', subject: 'Great article' }), 'Great article here');
  assert.equal(buildMessage({ text: '', subject: '', note: '' }), '');
  assert.equal(buildMessage({ text: 'x'.repeat(20000) }, 15000).length, 15000);
});

test('recents list: newest first, no duplicates, capped', () => {
  let r = [];
  for (let i = 0; i < 12; i++) r = pushRecent(r, `dm:${i}`);
  assert.equal(r.length, 8);
  assert.equal(r[0], 'dm:11');
  r = pushRecent(r, 'dm:5');
  assert.equal(r[0], 'dm:5');
  assert.equal(new Set(r).size, r.length);
});

test('keys round-trip and bad keys are refused', () => {
  assert.deepEqual(parseKey(dmKey(5)), { kind: 'dm', dmId: 5 });
  assert.deepEqual(parseKey(channelKey(3, 9)), { kind: 'channel', serverId: 3, channelId: 9 });
  for (const bad of ['', null, 'dm:', 'dm:x', 'ch:1', 'ch:1:2:3', 'javascript:1', 'dm:1;drop', 'DM:1', 'dm:1234567890123']) assert.equal(parseKey(bad), null, String(bad));
});
