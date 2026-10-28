'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { PERMISSIONS } = require('../lib/permissions');
const automod = require('../lib/automod');

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
  return id;
};
const mkChannel = (sid, name = 'general') => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, name, 'public').lastInsertRowid);
const addMember = (sid, uid) => db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, uid);

function world() {
  const owner = mkUser('owner');
  const sid = mkServer(owner);
  const ch = mkChannel(sid);
  const member = mkUser('member');
  addMember(sid, member);
  return {
    owner, sid, ch, member,
    channel: db.prepare('SELECT * FROM channels WHERE id = ?').get(ch),
    user: db.prepare('SELECT * FROM users WHERE id = ?').get(member),
    ownerUser: db.prepare('SELECT * FROM users WHERE id = ?').get(owner),
  };
}
const rule = (w, body) => automod.createRule(w.sid, body);
const check = (w, content, extra = {}) => automod.evaluate({ channel: w.channel, user: w.user, content, ...extra });

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/servers/:id/automod', require('../routes/automod'));
  app.use('/api/servers/:id/channels/:channelId/messages', require('../routes/channelMessages'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
test.beforeEach(() => automod._reset());

const call = async (method, url, uid, json) => {
  const res = await fetch(base + url, { method, headers: { 'x-uid': String(uid), ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

test('keywords: whole-word matching ignores case and does not hit inside other words', () => {
  const w = world();
  rule(w, { name: 'Bad words', kind: 'keywords', config: { words: ['badword', 'two words'], wholeWord: true } });
  assert.ok(check(w, 'this is a BadWord here'));
  assert.ok(check(w, 'say two   words'.replace('   ', ' ')));
  assert.equal(check(w, 'a badwords list'), null);
  assert.equal(check(w, 'unbadwordish'), null);
  assert.equal(check(w, 'perfectly fine'), null);
});

test('keywords: substring mode and wildcards', () => {
  const w = world();
  rule(w, { name: 'Sub', kind: 'keywords', config: { words: ['spam*me'], wholeWord: false } });
  assert.ok(check(w, 'please spamallme now'));
  assert.ok(check(w, 'spamme'));
  assert.equal(check(w, 'spa mme'), null);
});

test('keywords: special characters in a word are matched literally (no regex injection)', () => {
  const w = world();
  rule(w, { name: 'Lit', kind: 'keywords', config: { words: ['a.c', '(x+)+'], wholeWord: false } });
  assert.ok(check(w, 'a.c'));
  assert.equal(check(w, 'abc'), null);
  assert.ok(check(w, 'look (x+)+ here'));
});

test('links: block all, allowlist and blocklist', () => {
  const w = world();
  const all = rule(w, { name: 'No links', kind: 'links', config: { mode: 'block_all' } });
  assert.ok(check(w, 'see https://example.com/x'));
  assert.ok(check(w, 'see www.example.com'));
  assert.equal(check(w, 'no link, just text.example'), null);
  automod.updateRule(w.sid, all.id, { config: { mode: 'allowlist', domains: ['github.com'] } });
  assert.equal(check(w, 'https://github.com/a/b'), null);
  assert.equal(check(w, 'https://gist.github.com/a'), null);
  assert.ok(check(w, 'https://notgithub.com/a'));
  assert.ok(check(w, 'https://evil.test and https://github.com'));
  automod.updateRule(w.sid, all.id, { config: { mode: 'blocklist', domains: ['evil.test'] } });
  assert.ok(check(w, 'https://sub.evil.test/x'));
  assert.equal(check(w, 'https://fine.example/x'), null);
});

test('mentions: counts people and roles and treats @everyone as the whole limit', () => {
  const w = world();
  const a = mkUser('ana'); const b = mkUser('bela'); const c = mkUser('cili');
  for (const u of [a, b, c]) addMember(w.sid, u);
  const names = [a, b, c].map((id) => db.prepare('SELECT username FROM users WHERE id = ?').get(id).username);
  rule(w, { name: 'Mentions', kind: 'mentions', config: { max: 2 } });
  assert.equal(check(w, `@${names[0]} @${names[1]} hi`), null);
  assert.ok(check(w, names.map((x) => `@${x}`).join(' ')));
  assert.ok(check(w, '@everyone look'));
});

test('spam: a flood and repeated identical messages are caught, edits are not counted', () => {
  const w = world();
  rule(w, { name: 'Flood', kind: 'spam', config: { maxMessages: 4, windowSeconds: 30, duplicates: 3 } });
  assert.equal(check(w, 'one'), null);
  assert.equal(check(w, 'two'), null);
  assert.equal(check(w, 'three'), null);
  assert.ok(check(w, 'four'), 'the 4th message inside the window trips the limit');
  automod._reset();
  assert.equal(check(w, 'same'), null);
  assert.equal(check(w, 'same'), null);
  assert.ok(check(w, ' SAME '), 'normalised duplicates');
  automod._reset();
  for (let i = 0; i < 10; i++) assert.equal(check(w, `edit ${i}`, { track: false }), null);
});

test('caps: needs enough letters and a high enough share of capitals', () => {
  const w = world();
  rule(w, { name: 'Caps', kind: 'caps', config: { minLetters: 10, maxPercent: 70 } });
  assert.ok(check(w, 'THIS IS WAY TOO LOUD NOW'));
  assert.equal(check(w, 'OK THANKS'), null, 'too short to judge');
  assert.equal(check(w, 'This Is A Normal Sentence With Some Capitals'), null);
  assert.equal(check(w, '1234567890 !!!! ????'), null);
});

test('owner, message managers, exempt roles and exempt channels are never filtered', () => {
  const w = world();
  rule(w, { name: 'Words', kind: 'keywords', config: { words: ['forbidden'] } });
  assert.equal(automod.evaluate({ channel: w.channel, user: w.ownerUser, content: 'forbidden' }), null);

  const role = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 1, 0)').run(w.sid, 'Mods', PERMISSIONS.MANAGE_MESSAGES).lastInsertRowid);
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(w.sid, w.member, role);
  assert.equal(check(w, 'forbidden'), null, 'Manage Messages bypasses');
  db.prepare('DELETE FROM member_roles WHERE user_id = ?').run(w.member);
  assert.ok(check(w, 'forbidden'));

  const vip = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, 0, 1, 0)').run(w.sid, 'VIP').lastInsertRowid);
  const r = automod.listRules(w.sid)[0];
  automod.updateRule(w.sid, r.id, { exemptRoles: [vip] });
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(w.sid, w.member, vip);
  assert.equal(check(w, 'forbidden'), null, 'exempt role');
  db.prepare('DELETE FROM member_roles WHERE user_id = ?').run(w.member);
  automod.updateRule(w.sid, r.id, { exemptRoles: [], exemptChannels: [w.ch] });
  assert.equal(check(w, 'forbidden'), null, 'exempt channel');
  const other = db.prepare('SELECT * FROM channels WHERE id = ?').get(mkChannel(w.sid, 'other'));
  assert.ok(automod.evaluate({ channel: other, user: w.user, content: 'forbidden' }));
});

test('a disabled rule does nothing; the timeout action times the member out and logs the hit', () => {
  const w = world();
  const r = rule(w, { name: 'Strict', kind: 'keywords', config: { words: ['nope'] }, action: 'timeout', timeoutMinutes: 15 });
  automod.updateRule(w.sid, r.id, { enabled: false });
  assert.equal(check(w, 'nope'), null);
  automod.updateRule(w.sid, r.id, { enabled: true });
  const hit = check(w, 'nope');
  assert.match(hit.message, /Strict/);
  const until = db.prepare('SELECT timeout_until FROM server_members WHERE server_id = ? AND user_id = ?').get(w.sid, w.member).timeout_until;
  assert.ok(new Date(until) - Date.now() > 14 * 60_000);
  const log = automod.listLog(w.sid);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'timeout 15 min');
  assert.equal(log[0].excerpt, 'nope');
  assert.equal(log[0].channelName, 'general');
});

test('rule validation', () => {
  const w = world();
  const bad = (body) => assert.throws(() => automod.createRule(w.sid, body), (e) => e instanceof automod.AutomodError && e.status === 400, JSON.stringify(body));
  bad({ name: '', kind: 'keywords', config: { words: ['x'] } });
  bad({ name: 'x', kind: 'nope', config: {} });
  bad({ name: 'x', kind: 'keywords', config: { words: [] } });
  bad({ name: 'x', kind: 'links', config: { mode: 'allowlist', domains: [] } });
  bad({ name: 'x', kind: 'mentions', config: { max: 0 } });
  bad({ name: 'x', kind: 'spam', config: { maxMessages: 1 } });
  bad({ name: 'x', kind: 'caps', config: { maxPercent: 10 } });
  bad({ name: 'x', kind: 'keywords', config: { words: ['a'] }, action: 'ban' });
  bad({ name: 'x', kind: 'keywords', config: { words: ['a'] }, timeoutMinutes: 999999 });
  for (let i = 0; i < automod.MAX_RULES; i++) automod.createRule(w.sid, { name: `r${i}`, kind: 'mentions', config: { max: 5 } });
  assert.throws(() => automod.createRule(w.sid, { name: 'one too many', kind: 'mentions', config: {} }), (e) => e.status === 409);
});

test('the API needs Manage Server and keeps servers apart', async () => {
  const w = world();
  const other = world();
  assert.equal((await call('GET', `/api/servers/${w.sid}/automod`, w.member)).status, 403);
  assert.equal((await call('POST', `/api/servers/${w.sid}/automod/rules`, w.member, { name: 'x', kind: 'mentions' })).status, 403);
  const created = await call('POST', `/api/servers/${w.sid}/automod/rules`, w.owner, { name: 'Max 3', kind: 'mentions', config: { max: 3 } });
  assert.equal(created.status, 201);
  const id = created.data.rule.id;
  assert.equal((await call('PATCH', `/api/servers/${other.sid}/automod/rules/${id}`, other.owner, { enabled: false })).status, 404);
  assert.equal((await call('PATCH', `/api/servers/${w.sid}/automod/rules/${id}`, w.owner, { enabled: false })).data.rule.enabled, false);
  const list = await call('GET', `/api/servers/${w.sid}/automod`, w.owner);
  assert.equal(list.data.rules.length, 1);
  assert.equal((await call('DELETE', `/api/servers/${w.sid}/automod/rules/${id}`, w.owner)).status, 200);
  assert.equal((await call('DELETE', `/api/servers/${w.sid}/automod/rules/${id}`, w.owner)).status, 404);
});

test('posting through the real route is blocked, logged and never stored', async () => {
  const w = world();
  automod.createRule(w.sid, { name: 'Words', kind: 'keywords', config: { words: ['forbidden'] } });
  const post = async (uid, content) => {
    const res = await fetch(`${base}/api/servers/${w.sid}/channels/${w.ch}/messages`, { method: 'POST', headers: { 'x-uid': String(uid), 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
    return { status: res.status, data: await res.json() };
  };
  const bad = await post(w.member, 'this is forbidden talk');
  assert.equal(bad.status, 403);
  assert.equal(bad.data.automod, true);
  assert.match(bad.data.error, /AutoMod/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE scope_id = ?').get(w.ch).n, 0);
  assert.equal(automod.listLog(w.sid).length, 1);
  assert.equal((await post(w.member, 'a fine message')).status, 201);
  assert.equal((await post(w.owner, 'forbidden but I own this place')).status, 201);
});
