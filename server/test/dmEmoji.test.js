'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const accounts = require('../lib/accounts');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const uid = Number(req.headers['x-uid']);
  if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  next();
});
app.use('/api/dms', require('../routes/dms'));
app.use(require('../middleware/errorHandler').errorHandler);
let server; let base;
const ids = {};

const get = async (url, who) => {
  const res = await fetch(base + url, { headers: { 'x-uid': String(ids[who]) } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const n of ['de_a', 'de_b', 'de_c']) ids[n] = accounts.createAccount({ username: n, email: `${n}@t.co`, password: 'password123' }).userId;
});
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function makeServer(name, owner, members, emoji) {
  const sid = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run(name, ids[owner], `inv-${name}`).lastInsertRowid;
  for (const m of members) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, ids[m]);
  db.prepare('INSERT INTO custom_emoji (server_id, name, image_path, created_by) VALUES (?, ?, ?, ?)').run(sid, emoji, `/uploads/emoji/${name}.png`, ids[owner]);
  return Number(sid);
}

test('a DM lists the custom emoji of its members, each with who may use it', async () => {
  const dmId = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(ids.de_a).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(dmId, ids.de_a, dmId, ids.de_b);
  makeServer('shared', 'de_a', ['de_a', 'de_b'], 'both');
  makeServer('only-b', 'de_b', ['de_b'], 'bee');
  makeServer('only-c', 'de_c', ['de_c'], 'sea');

  const { status, body } = await get(`/api/dms/${dmId}/emoji`, 'de_a');
  assert.equal(status, 200);
  const byName = Object.fromEntries(body.emoji.map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(byName).sort(), ['bee', 'both']);
  assert.deepEqual(byName.both.userIds.slice().sort(), [ids.de_a, ids.de_b].sort());
  assert.deepEqual(byName.bee.userIds, [ids.de_b]);
  assert.equal(byName.both.image_path, '/uploads/emoji/shared.png');

  assert.notEqual((await get(`/api/dms/${dmId}/emoji`, 'de_c')).status, 200);
});
