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

const uniq = () => Math.random().toString(36).slice(2, 8);
const mkUser = (n, createdAgoMs = 0) => Number(db.prepare("INSERT INTO users (username, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)")
  .run(n, `${n}@t.local`, 'h', n, new Date(Date.now() - createdAgoMs).toISOString()).lastInsertRowid);
const join = (sid, uid, joinedAgoMs = 0) => db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(sid, uid, new Date(Date.now() - joinedAgoMs).toISOString());
function mkServer(owner) {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random()}`).lastInsertRowid);
  join(id, owner, 1e9);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.READ_MESSAGE_HISTORY);
  return id;
}
const mkChannel = (sid, name, nsfw = 0) => Number(db.prepare('INSERT INTO channels (server_id, name, type, nsfw) VALUES (?, ?, ?, ?)').run(sid, name, 'public', nsfw).lastInsertRowid);

let httpServer; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/users', require('../routes/users'));
  app.use('/api/servers/:id/channels/:channelId/messages', require('../routes/channelMessages'));
  app.use('/api/servers', require('../routes/servers'));
  httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
test.after(() => { httpServer.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const call = async (method, url, uid, body) => {
  const res = await fetch(base + url, { method, headers: { 'x-uid': String(uid), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('age-restricted channels need a one-time confirmation before reading or posting', async () => {
  const owner = mkUser(`o${uniq()}`);
  const sid = mkServer(owner);
  const ch = mkChannel(sid, 'spicy', 1);
  const plain = mkChannel(sid, 'plain');
  const member = mkUser(`m${uniq()}`);
  join(sid, member, 1e9);
  const msgs = (c) => `/api/servers/${sid}/channels/${c}/messages`;

  let res = await call('GET', msgs(ch), member);
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'nsfw');
  assert.equal((await call('POST', msgs(ch), member, { content: 'hi' })).status, 403);
  assert.equal((await call('GET', msgs(plain), member)).status, 200);

  assert.equal((await call('POST', '/api/users/me/age-confirmation', member)).status, 200);
  assert.equal((await call('GET', msgs(ch), member)).status, 200);
  assert.equal((await call('POST', msgs(ch), member, { content: 'hi' })).status, 201);
  // the confirmation is per account, not per channel
  const ch2 = mkChannel(sid, 'spicy2', 1);
  assert.equal((await call('GET', msgs(ch2), member)).status, 200);
  assert.ok(db.prepare('SELECT nsfw_ack_at FROM users WHERE id = ?').get(member).nsfw_ack_at);
});

test('the nsfw flag is set when a channel is created and can be changed later', async () => {
  const owner = mkUser(`o${uniq()}`);
  const sid = mkServer(owner);
  let res = await call('POST', `/api/servers/${sid}/channels`, owner, { name: 'adults', nsfw: true });
  assert.equal(res.status, 201);
  assert.equal(res.json.channel.nsfw, 1);
  const id = res.json.channel.id;
  res = await call('PATCH', `/api/servers/${sid}/channels/${id}`, owner, { nsfw: false });
  assert.equal(res.json.channel.nsfw, 0);
  res = await call('PATCH', `/api/servers/${sid}/channels/${id}`, owner, { nsfw: true });
  assert.equal(res.json.channel.nsfw, 1);
});

test('verification levels hold back new accounts and recent joiners, but not owners or role holders', async () => {
  const owner = mkUser(`o${uniq()}`);
  const sid = mkServer(owner);
  const ch = mkChannel(sid, 'talk');
  const url = `/api/servers/${sid}/channels/${ch}/messages`;
  const MIN = 60_000; const DAY = 24 * 60 * MIN;
  const fresh = mkUser(`f${uniq()}`); join(sid, fresh);
  const fiveMinAccount = mkUser(`a${uniq()}`, 6 * MIN); join(sid, fiveMinAccount);
  const oldJoin = mkUser(`j${uniq()}`, 6 * MIN); join(sid, oldJoin, 11 * MIN);
  const weekOld = mkUser(`w${uniq()}`, 8 * DAY); join(sid, weekOld, 11 * MIN);
  const threeDay = mkUser(`t${uniq()}`, 3 * DAY); join(sid, threeDay, 11 * MIN);
  const vetted = mkUser(`v${uniq()}`); join(sid, vetted);
  const roleId = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, 0, 1)').run(sid, 'Member').lastInsertRowid);
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, vetted, roleId);
  const say = async (uid) => call('POST', url, uid, { content: 'x' });

  assert.equal((await say(fresh)).status, 201, 'level 0 lets everyone in');

  assert.equal((await call('PATCH', `/api/servers/${sid}`, owner, { verificationLevel: 9 })).status, 400);
  assert.equal((await call('PATCH', `/api/servers/${sid}`, fresh, { verificationLevel: 1 })).status, 403);
  assert.equal((await call('PATCH', `/api/servers/${sid}`, owner, { verificationLevel: 1 })).json.server.verification_level, 1);
  let res = await say(fresh);
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'verification');
  assert.match(res.json.error, /account is too new/);
  assert.ok(res.json.retryAfterMs > 0);
  assert.equal((await say(fiveMinAccount)).status, 201);
  assert.equal((await say(owner)).status, 201);
  assert.equal((await say(vetted)).status, 201, 'a role holder is exempt');

  await call('PATCH', `/api/servers/${sid}`, owner, { verificationLevel: 2 });
  res = await say(fiveMinAccount);
  assert.equal(res.status, 403);
  assert.match(res.json.error, /joined this server too recently/);
  assert.equal((await say(oldJoin)).status, 201);

  await call('PATCH', `/api/servers/${sid}`, owner, { verificationLevel: 3 });
  assert.equal((await say(threeDay)).status, 403);
  assert.equal((await say(weekOld)).status, 201);

  await call('PATCH', `/api/servers/${sid}`, owner, { verificationLevel: 0 });
  assert.equal((await say(fresh)).status, 201);
});

test('roles take an emoji or an uploaded image as their icon', async () => {
  const owner = mkUser(`o${uniq()}`);
  const sid = mkServer(owner);
  const role = (await call('POST', `/api/servers/${sid}/roles`, owner, { name: 'Gamer' })).json.role;
  const patch = (body) => call('PATCH', `/api/servers/${sid}/roles/${role.id}`, owner, body);

  assert.equal((await patch({ iconEmoji: '🎮' })).json.role.icon_emoji, '🎮');
  assert.equal((await patch({ iconEmoji: 'abc' })).status, 400);
  assert.equal((await patch({ iconEmoji: '🎮x' })).status, 400);
  assert.equal((await patch({ iconEmoji: '👨‍👩‍👧' })).status, 200);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('icon', new Blob([png], { type: 'image/png' }), 'i.png');
  const up = await fetch(`${base}/api/servers/${sid}/roles/${role.id}/icon`, { method: 'POST', headers: { 'x-uid': String(owner) }, body: form });
  const upJson = await up.json();
  assert.equal(up.status, 200);
  assert.match(upJson.role.icon_path, /^\/uploads\/roleicons\/\d+-[0-9a-f]+\.png$/);
  assert.equal(upJson.role.icon_emoji, null, 'an image replaces the emoji');
  assert.ok(fs.existsSync(path.join(tmpDir, 'roleicons', path.basename(upJson.role.icon_path))));

  assert.equal((await patch({ iconEmoji: '🎲' })).json.role.icon_path, null, 'an emoji replaces the image');
  const del = await call('DELETE', `/api/servers/${sid}/roles/${role.id}/icon`, owner);
  assert.equal(del.json.role.icon_emoji, null);

  const everyone = db.prepare('SELECT id FROM roles WHERE server_id = ? AND is_default = 1').get(sid).id;
  const r = await call('PATCH', `/api/servers/${sid}/roles/${everyone}`, owner, { iconEmoji: '🎮' });
  assert.equal(r.json.role.icon_emoji, null, '@everyone has no icon');
});
