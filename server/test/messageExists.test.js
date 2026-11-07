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

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const KEY = Buffer.alloc(32, 7).toString('base64');
const makeUser = (username) => db.prepare('INSERT INTO users (username, email, password_hash, display_name, e2ee_public_key) VALUES (?, ?, ?, ?, ?)')
  .run(username, `${username}@test.local`, 'hash', username, KEY).lastInsertRowid;

async function withApp(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-test-user']);
    if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    next();
  });
  app.use('/api/messages', require('../routes/messages'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (userId, method, url) => fetch(base + url, { method, headers: { 'x-test-user': String(userId) } });
  try { await fn(call); } finally { server.close(); }
}

test('GET /api/messages/:id/exists is true for a visible message, false once deleted or when not a DM member', async () => {
  const alice = makeUser('ex_alice');
  const bob = makeUser('ex_bob');
  const eve = makeUser('ex_eve');
  const dm = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(alice).lastInsertRowid;
  for (const u of [alice, bob]) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dm, u);
  const msg = db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'hi')").run(dm, alice).lastInsertRowid;
  await withApp(async (call) => {
    assert.deepEqual(await (await call(bob, 'GET', `/api/messages/${msg}/exists`)).json(), { exists: true });
    assert.deepEqual(await (await call(eve, 'GET', `/api/messages/${msg}/exists`)).json(), { exists: false });
    db.prepare('DELETE FROM messages WHERE id = ?').run(msg);
    assert.deepEqual(await (await call(bob, 'GET', `/api/messages/${msg}/exists`)).json(), { exists: false });
  });
});
