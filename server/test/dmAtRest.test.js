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
const { isSealed } = require('../lib/atRest');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function makeUser(username) {
  return db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}
function makeDm(a, b, { group = false, extra = [] } = {}) {
  const id = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (?, ?)').run(group ? 1 : 0, a).lastInsertRowid;
  for (const u of [a, b, ...extra]) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, u);
  return id;
}

async function withApp(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-test-user']);
    if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    next();
  });
  app.use('/api/dms', require('../routes/dms'));
  app.use('/api/messages', require('../routes/messages'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (userId, method, url, body) => fetch(base + url, {
    method, headers: { 'content-type': 'application/json', 'x-test-user': String(userId) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  try { await fn(call); } finally { server.close(); }
}


const alice = makeUser('ar_alice');
const bob = makeUser('ar_bob');
const raw = (id) => db.prepare('SELECT content, embed FROM messages WHERE id = ?').get(id);

test('DM text is stored sealed, served in the clear, and kept out of the FTS index', async () => {
  const dm = makeDm(alice, bob);
  await withApp(async (call) => {
    const sent = await (await call(alice, 'POST', `/api/dms/${dm}/messages`, { content: 'the pineapple plan' })).json();
    assert.equal(sent.message.content, 'the pineapple plan');
    assert.ok(isSealed(raw(sent.message.id).content));
    assert.ok(!raw(sent.message.id).content.includes('pineapple'));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM messages_fts WHERE messages_fts MATCH 'pineapple'").get().c, 0);

    const listed = await (await call(bob, 'GET', `/api/dms/${dm}/messages`)).json();
    assert.equal(listed.messages[0].content, 'the pineapple plan');

    const found = await (await call(bob, 'GET', `/api/dms/${dm}/search?q=pineap`)).json();
    assert.deepEqual(found.messages.map((m) => m.id), [sent.message.id]);
    assert.equal((await (await call(bob, 'GET', `/api/dms/${dm}/search?q=nothing`)).json()).messages.length, 0);

    const edited = await (await call(alice, 'PATCH', `/api/messages/${sent.message.id}`, { content: 'now a mango plan' })).json();
    assert.equal(edited.message.content, 'now a mango plan');
    assert.ok(isSealed(raw(sent.message.id).content));
    assert.equal((await (await call(bob, 'GET', `/api/dms/${dm}/search?q=mango`)).json()).messages.length, 1);
    assert.equal((await (await call(bob, 'GET', `/api/dms/${dm}/search?q=pineapple`)).json()).messages.length, 0);

    const reply = await (await call(bob, 'POST', `/api/dms/${dm}/messages`, { content: 'sure', replyToMessageId: sent.message.id })).json();
    assert.equal(reply.message.replyTo.content, 'now a mango plan');

    const forwarded = await (await call(bob, 'POST', `/api/messages/${sent.message.id}/forward`, { scopeType: 'dm', scopeId: dm, comment: 'fyi' })).json();
    assert.equal(forwarded.message.forwardedFrom.content, 'now a mango plan');
    assert.equal(forwarded.message.content, 'fyi');
  });
});

test('channel messages stay plain and indexed', () => {
  const owner = alice;
  const sid = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('ARS', owner, 'ar-inv').lastInsertRowid;
  const ch = db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'g', 'public')").run(sid).lastInsertRowid;
  const id = db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('channel', ?, ?, 'open guava talk')").run(ch, owner).lastInsertRowid;
  assert.equal(raw(id).content, 'open guava talk');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM messages_fts WHERE messages_fts MATCH 'guava'").get().c, 1);
});

test('startup migration seals legacy plaintext DMs and removes them from the FTS index', () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-legacy-'));
  const env = { ...process.env, DISMESH_DATA_DIR: dir };
  const dbModule = path.join(__dirname, '..', 'db').split(path.sep).join('/');
  execFileSync(process.execPath, ['-e', `
    const { db } = require('${dbModule}');
    for (const n of ['ai', 'ad', 'au']) db.exec('DROP TRIGGER messages_fts_' + n);
    db.exec(\`CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content); END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content); END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content); INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content); END;\`);
    db.exec("INSERT INTO users (id, username, email, password_hash, display_name) VALUES (900, 'lg', 'lg@t', 'h', 'lg')");
    db.exec("INSERT INTO dm_channels (id, is_group, created_by) VALUES (900, 0, 900)");
    db.exec("INSERT INTO messages (id, scope_type, scope_id, author_id, content) VALUES (9001, 'dm', 900, 900, 'legacy kiwi secret')");
    db.exec("INSERT INTO messages (id, scope_type, scope_id, author_id, content) VALUES (9002, 'channel', 900, 900, 'public kiwi note')");
    db.exec("DELETE FROM meta WHERE key = 'dm_at_rest_v1'");
    db.close();
  `], { env });
  const out = execFileSync(process.execPath, ['-e', `
    const { db } = require('${dbModule}');
    const { open } = require('${path.join(__dirname, '..', 'lib', 'atRest').split(path.sep).join('/')}');
    const dm = db.prepare('SELECT content FROM messages WHERE id = 9001').get().content;
    const hits = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'kiwi'").all().map((r) => r.rowid);
    console.log(JSON.stringify({ sealed: dm.startsWith('enc1:'), clear: open(dm), hits }));
    db.close();
  `], { env }).toString().trim().split('\n').pop();
  const res = JSON.parse(out);
  assert.equal(res.sealed, true);
  assert.equal(res.clear, 'legacy kiwi secret');
  assert.deepEqual(res.hits, [9002]);
  fs.rmSync(dir, { recursive: true, force: true });
});
