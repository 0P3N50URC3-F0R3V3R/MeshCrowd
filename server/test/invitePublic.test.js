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
const invites = require('../lib/serverInvites');

const owner = Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run('own', 'own@t.local', 'h', 'own').lastInsertRowid);
const mkServer = (name, visibility, code) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code, visibility) VALUES (?, ?, ?, ?)').run(name, owner, code, visibility).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  return id;
};
const pub = mkServer('Public One', 'public', 'pubcode1');
const priv = mkServer('<script>alert(1)</script>', 'private', 'privcode');

let server; let base; let downloads = { clientDesktop: 'https://example.com/d', clientAndroid: 'https://#', website: 'javascript:alert(1)' };
test.before(async () => {
  const app = express();
  const r = require('../routes/invitePublic')({ downloads: () => downloads });
  app.use('/api/invites', r.api);
  app.use('/i', r.page);
  await new Promise((ok) => { server = http.createServer(app).listen(0, '127.0.0.1', ok); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('peekCode resolves every code kind without consuming a use', () => {
  const inv = invites.createInvite({ serverId: pub, userId: owner, maxUses: 3 });
  assert.equal(invites.peekCode('pubcode1').kind, 'server');
  assert.equal(invites.peekCode(inv.code).kind, 'server');
  invites.peekCode(inv.code);
  assert.equal(db.prepare('SELECT uses FROM server_invites WHERE id = ?').get(inv.id).uses, 0);
  invites.setVanity(pub, 'public-one');
  assert.equal(invites.peekCode('public-one').server.id, pub);
  const ch = Number(db.prepare('INSERT INTO channels (server_id, name) VALUES (?, ?)').run(pub, 'general').lastInsertRowid);
  db.prepare('INSERT INTO channel_invites (channel_id, code, created_by) VALUES (?, ?, ?)').run(ch, 'abcdef123456', owner);
  const p = invites.peekCode('abcdef123456');
  assert.equal(p.kind, 'channel');
  assert.equal(invites.publicInfo(p).channelName, 'general');
  assert.equal(invites.peekCode('nope'), null);
});

test('peekCode reports expired and exhausted invites', () => {
  const inv = invites.createInvite({ serverId: pub, userId: owner, maxUses: 1 });
  db.prepare('UPDATE server_invites SET uses = 1 WHERE id = ?').run(inv.id);
  assert.equal(invites.peekCode(inv.code).dead.status, 410);
  db.prepare('INSERT INTO server_invites (server_id, code, created_by, expires_at) VALUES (?, ?, ?, ?)').run(pub, 'oldcode1', owner, '2000-01-01T00:00:00.000Z');
  assert.equal(invites.peekCode('oldcode1').dead.status, 410);
});

test('publicInfo hides the member count of private servers', () => {
  assert.equal(invites.publicInfo(invites.peekCode('pubcode1')).memberCount, 1);
  assert.equal(invites.publicInfo(invites.peekCode('privcode')).memberCount, null);
});

test('GET /api/invites/:code statuses and shape', async () => {
  const ok = await fetch(`${base}/api/invites/pubcode1`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(Object.keys(body).sort(), ['channelName', 'description', 'iconPath', 'kind', 'memberCount', 'name']);
  assert.equal((await fetch(`${base}/api/invites/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/api/invites/abc@other.example`)).status, 404);
  assert.equal((await fetch(`${base}/api/invites/oldcode1`)).status, 410);
});

test('GET /i/:code renders an escaped landing page with safe headers and links', async () => {
  const res = await fetch(`${base}/i/privcode`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  assert.ok(html.includes('href="/#invite=privcode"'));
  assert.ok(html.includes('mcr://127.0.0.1:'));
  assert.ok(html.includes('og:title'));
  assert.ok(html.includes('https://example.com/d'));
  assert.ok(!html.includes('https://#"'));
  assert.ok(!html.includes('javascript:'));
});

test('GET /i/:code dead, unknown and federated codes', async () => {
  assert.equal((await fetch(`${base}/i/oldcode1`)).status, 410);
  assert.equal((await fetch(`${base}/i/zzzzzzzz`)).status, 404);
  const fed = await fetch(`${base}/i/abc@other.example`);
  assert.equal(fed.status, 200);
  assert.ok(!(await fed.text()).includes('og:title'));
  const hu = await (await fetch(`${base}/i/privcode`, { headers: { 'accept-language': 'hu-HU' } })).text();
  assert.ok(hu.includes('Csatlakozás böngészőben'));
});
