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

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name, name_color, name_effect) VALUES (?, ?, ?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n, '#ff0000', 'glow').lastInsertRowid);
const join = (sid, uid) => db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, uid);

let httpServer; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
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

function setup() {
  const owner = mkUser(`o${Math.random().toString(36).slice(2, 8)}`);
  const mod = mkUser(`d${Math.random().toString(36).slice(2, 8)}`);
  const member = mkUser(`m${Math.random().toString(36).slice(2, 8)}`);
  const sid = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random()}`).lastInsertRowid);
  for (const u of [owner, mod, member]) join(sid, u);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)')
    .run(sid, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.READ_MESSAGE_HISTORY);
  const roleId = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 1, 0)')
    .run(sid, 'Mod', PERMISSIONS.MODERATE_MEMBERS).lastInsertRowid);
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, mod, roleId);
  const ch = Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'general', 'public').lastInsertRowid);
  const sticker = Number(db.prepare('INSERT INTO stickers (server_id, name, image_path) VALUES (?, ?, ?)').run(sid, 'wave', '/x.png').lastInsertRowid);
  return { owner, mod, member, sid, ch, sticker };
}

test('a moderator restricts a member: personal name look is blanked in this server and stickers are refused', async () => {
  const { owner, mod, member, sid, ch, sticker } = setup();
  const url = `/api/servers/${sid}/members/${member}/restrictions`;
  const msgs = `/api/servers/${sid}/channels/${ch}/messages`;

  assert.equal((await call('POST', msgs, member, { content: '', stickerId: sticker })).status, 201);
  assert.equal((await call('PUT', url, member, { restrictions: ['stickers'] })).status, 403);
  assert.equal((await call('PUT', `/api/servers/${sid}/members/${owner}/restrictions`, mod, { restrictions: ['stickers'] })).status, 400);
  assert.equal((await call('PUT', url, mod, { restrictions: ['bogus'] })).status, 400);

  const set = await call('PUT', url, mod, { restrictions: ['stickers', 'name_color', 'name_effect', 'bio_style'] });
  assert.equal(set.status, 200);

  const detail = (await call('GET', `/api/servers/${sid}`, owner)).json;
  const m = detail.members.find((x) => x.user.id === member);
  assert.deepEqual(m.restrictions.sort(), ['bio_style', 'name_color', 'name_effect', 'stickers']);
  assert.equal(m.user.nameColor, null);
  assert.equal(m.user.nameEffect, '');
  assert.equal(detail.members.find((x) => x.user.id === mod).user.nameColor, '#ff0000');

  const blocked = await call('POST', msgs, member, { content: '', stickerId: sticker });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error, 'stickers are restricted for you on this server');
  assert.equal((await call('POST', msgs, member, { content: 'plain text still works' })).status, 201);

  assert.equal((await call('PUT', url, mod, { restrictions: [] })).status, 200);
  assert.equal((await call('POST', msgs, member, { content: '', stickerId: sticker })).status, 201);
});

test('restrictions are per server', async () => {
  const a = setup();
  const b = setup();
  join(b.sid, a.member);
  const other = Number(db.prepare('INSERT INTO stickers (server_id, name, image_path) VALUES (?, ?, ?)').run(b.sid, 'hi', '/y.png').lastInsertRowid);
  await call('PUT', `/api/servers/${a.sid}/members/${a.member}/restrictions`, a.mod, { restrictions: ['stickers'] });
  assert.equal((await call('POST', `/api/servers/${b.sid}/channels/${b.ch}/messages`, a.member, { content: '', stickerId: other })).status, 201);
});
