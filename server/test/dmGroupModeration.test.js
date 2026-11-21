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

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);
const mkDm = (creator, others, group) => {
  const id = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (?, ?)').run(group ? 1 : 0, creator).lastInsertRowid);
  for (const u of [creator, ...others]) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, u);
  return id;
};
const msg = (dm, author) => Number(db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)').run('dm', dm, author, 'hi').lastInsertRowid);
const row = (id) => db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(id);

async function withApp(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    next();
  });
  app.use('/api/dms', require('../routes/dms'));
  app.use('/api/messages', require('../routes/messages'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (uid, method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-uid': String(uid) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try { await fn(call); } finally { server.close(); }
}

test('group creator edits and deletes any message; edit is credited; members and 1:1 peers cannot', async () => {
  const c = mkUser('c'); const a = mkUser('a'); const b = mkUser('b');
  const dm = mkDm(c, [a, b], true);
  await withApp(async (call) => {
    const m1 = msg(dm, a);
    assert.equal((await call(a, 'PATCH', `/api/messages/${msg(dm, b)}`, { content: 'x' })).status, 403);
    assert.equal((await call(b, 'DELETE', `/api/messages/${m1}`)).status, 403);
    const ed = await call(c, 'PATCH', `/api/messages/${m1}`, { content: 'fixed' });
    assert.equal(ed.status, 200);
    assert.equal(ed.data.message.editedBy.id, c);
    assert.equal((await call(c, 'DELETE', `/api/messages/${m1}`)).status, 200);

    const solo = mkDm(c, [a], false);
    const m2 = msg(solo, a);
    assert.equal((await call(c, 'PATCH', `/api/messages/${m2}`, { content: 'x' })).status, 403);
    assert.equal((await call(c, 'DELETE', `/api/messages/${m2}`)).status, 403);
  });
});

test('creator kicks down to a 1:1, which then loses moderation and the creator role', async () => {
  const c = mkUser('c'); const a = mkUser('a'); const b = mkUser('b'); const d = mkUser('d');
  const dm = mkDm(c, [a, b, d], true);
  await withApp(async (call) => {
    assert.equal((await call(a, 'DELETE', `/api/dms/${dm}/members/${b}`)).status, 403);
    assert.equal((await call(c, 'DELETE', `/api/dms/${dm}/members/${c}`)).status, 400);
    const first = await call(c, 'DELETE', `/api/dms/${dm}/members/${d}`);
    assert.equal(first.status, 200);
    assert.equal(first.data.reverted, false);
    assert.equal(row(dm).is_group, 1);
    const second = await call(c, 'DELETE', `/api/dms/${dm}/members/${b}`);
    assert.equal(second.data.reverted, true);
    assert.equal(row(dm).is_group, 0);
    assert.deepEqual(db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ? ORDER BY user_id').all(dm).map((r) => r.user_id), [c, a].sort((x, y) => x - y));
    assert.equal((await call(c, 'DELETE', `/api/dms/${dm}/members/${a}`)).status, 403);
    assert.equal((await call(c, 'DELETE', `/api/messages/${msg(dm, a)}`)).status, 403);
  });
});

test('creator leaving destroys the group; a member leaving to two reverts it to a 1:1', async () => {
  const c = mkUser('c'); const a = mkUser('a'); const b = mkUser('b');
  const gone = mkDm(c, [a, b], true);
  const kept = mkDm(c, [a, b], true);
  await withApp(async (call) => {
    msg(gone, a);
    const res = await call(c, 'DELETE', `/api/dms/${gone}/members/me`);
    assert.equal(res.data.deleted, true);
    assert.equal(row(gone), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE scope_type = ? AND scope_id = ?').get('dm', gone).n, 0);

    await call(b, 'DELETE', `/api/dms/${kept}/members/me`);
    assert.equal(row(kept).is_group, 0);
  });
});
