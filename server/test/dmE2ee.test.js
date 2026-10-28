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
const { SITE_PERMISSIONS } = require('../lib/permissions');
const { isValidEnvelope } = require('../lib/e2eeEnvelope');
const { searchMessages } = require('../lib/search');
const { pollOutbox } = require('../lib/notifications');
const prune = require('../lib/prune');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const KEY = Buffer.alloc(32, 7).toString('base64');
const NONCE = Buffer.alloc(24, 1).toString('base64');
const envelope = (chainIndex = 0, text = 'ciphertext-body-0123456789') => JSON.stringify({
  v: 1, chainIndex, nonce: NONCE, ciphertext: Buffer.from(text + 'x'.repeat(16)).toString('base64'),
});

function makeUser(username, { key = KEY, home = null } = {}) {
  return db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name, e2ee_public_key, home_instance_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, `${username}@test.local`, 'hash', username, key, home).lastInsertRowid;
}

function makeDm(a, b, { group = false } = {}) {
  const id = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (?, ?)').run(group ? 1 : 0, a).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(id, a, id, b);
  return id;
}

async function withApp(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-test-user']);
    if (uid) {
      req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      req.sitePermissions = req.headers['x-test-admin'] ? SITE_PERMISSIONS.VIEW_ADMIN_PANEL | SITE_PERMISSIONS.MANAGE_REPORTS : 0;
    }
    next();
  });
  app.use('/api/dms', require('../routes/dms'));
  app.use('/api/messages', require('../routes/messages'));
  app.use('/api/polls', require('../routes/polls'));
  app.use('/api/reports', require('../routes/reports'));
  app.use('/api/link-preview', require('../routes/linkPreview'));
  app.use('/api/admin', require('../routes/admin'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (userId, method, url, body, extra = {}) => fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': String(userId), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try { await fn(call, base); } finally { server.close(); }
}

test('isValidEnvelope accepts v1 envelopes only', () => {
  assert.ok(isValidEnvelope(envelope()));
  assert.ok(!isValidEnvelope('hello'));
  assert.ok(!isValidEnvelope('{}'));
  assert.ok(!isValidEnvelope(JSON.stringify({ v: 2, chainIndex: 0, nonce: NONCE, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAA' })));
  assert.ok(!isValidEnvelope(JSON.stringify({ ...JSON.parse(envelope()), extra: 1 })));
  assert.ok(!isValidEnvelope(JSON.stringify({ ...JSON.parse(envelope()), nonce: 'short' })));
  assert.ok(!isValidEnvelope(JSON.stringify({ ...JSON.parse(envelope()), chainIndex: -1 })));
  assert.ok(!isValidEnvelope(JSON.stringify({ ...JSON.parse(envelope()), ciphertext: 'not base64!' })));
});

test('enable: rules for groups, federation and missing keys', async () => {
  const a = makeUser('e2e_a1');
  const b = makeUser('e2e_b1');
  const noKey = makeUser('e2e_nokey', { key: null });
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('e2e.example', 'https://r', 'PEM', 'active')`).run().lastInsertRowid;
  const remote = makeUser('e2e_remote', { home: peerId });
  const group = makeDm(a, b, { group: true });
  const fed = makeDm(a, remote);
  const missingPeer = makeDm(a, noKey);
  const missingOwn = makeDm(noKey, a);
  await withApp(async (call) => {
    assert.equal((await call(a, 'POST', `/api/dms/${group}/encryption/enable`)).status, 400);
    const f = await call(a, 'POST', `/api/dms/${fed}/encryption/enable`);
    assert.equal(f.status, 400);
    assert.equal((await f.json()).code, 'e2ee_federated');
    const p = await call(a, 'POST', `/api/dms/${missingPeer}/encryption/enable`);
    assert.equal(p.status, 400);
    assert.equal((await p.json()).code, 'e2ee_peer_key_missing');
    const o = await call(noKey, 'POST', `/api/dms/${missingOwn}/encryption/enable`);
    assert.equal((await o.json()).code, 'e2ee_own_key_missing');
    assert.equal((await call(makeUser('e2e_stranger'), 'POST', `/api/dms/${missingPeer}/encryption/enable`)).status, 403);
  });
  for (const id of [group, fed, missingPeer, missingOwn]) {
    assert.equal(db.prepare('SELECT e2ee_enabled FROM dm_channels WHERE id = ?').get(id).e2ee_enabled, 0);
  }
});

test('enable posts one system notice, is idempotent, and is exposed on the DM list', async () => {
  const a = makeUser('e2e_a2');
  const b = makeUser('e2e_b2');
  const dm = makeDm(a, b);
  await withApp(async (call) => {
    assert.equal((await call(a, 'POST', `/api/dms/${dm}/encryption/enable`)).status, 200);
    assert.equal((await call(b, 'POST', `/api/dms/${dm}/encryption/enable`)).status, 200);
    const list = await (await call(b, 'GET', '/api/dms')).json();
    assert.equal(list.dms.find((d) => d.id === dm).e2eeEnabled, true);
  });
  const events = db.prepare("SELECT * FROM messages WHERE scope_type = 'dm' AND scope_id = ? AND event_type = 'e2ee_enabled'").all(dm);
  assert.equal(events.length, 1);
  assert.equal(events[0].is_encrypted, 0);
  const row = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(dm);
  assert.equal(row.e2ee_enabled_by, a);
  assert.ok(row.e2ee_enabled_at);
});

test('no route can switch encryption back off', () => {
  for (const file of ['dms.js', 'messages.js', 'admin.js', 'users.js', 'reports.js', 'polls.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
    assert.ok(!/e2ee_enabled\s*=\s*0/.test(src), `${file} must never clear e2ee_enabled`);
  }
  const ratchetFree = fs.readFileSync(path.join(__dirname, '..', 'routes', 'dms.js'), 'utf8');
  assert.equal([...ratchetFree.matchAll(/e2ee_enabled\s*=/g)].length, 1);
});

test('encrypted DM rejects plaintext, bad envelopes, uploads, edits, forwards and polls', async () => {
  const a = makeUser('e2e_a3');
  const b = makeUser('e2e_b3');
  const plain = makeDm(a, makeUser('e2e_c3'));
  const dm = makeDm(a, b);
  await withApp(async (call, base) => {
    await call(a, 'POST', `/api/dms/${dm}/encryption/enable`);

    for (const content of ['hello plaintext', '{}', undefined, JSON.stringify({ v: 1 })]) {
      assert.equal((await call(a, 'POST', `/api/dms/${dm}/messages`, { content })).status, 400);
    }
    const form = new FormData();
    form.append('content', envelope());
    form.append('files', new Blob(['x'], { type: 'text/plain' }), 'n.txt');
    const upload = await fetch(`${base}/api/dms/${dm}/messages`, { method: 'POST', headers: { 'x-test-user': String(a) }, body: form });
    assert.equal(upload.status, 400);

    const ok = await call(a, 'POST', `/api/dms/${dm}/messages`, { content: envelope(0) });
    assert.equal(ok.status, 201);
    const { message } = await ok.json();
    assert.equal(message.isEncrypted, true);
    assert.equal(db.prepare('SELECT is_encrypted FROM messages WHERE id = ?').get(message.id).is_encrypted, 1);

    assert.equal((await call(a, 'PATCH', `/api/messages/${message.id}`, { content: 'edited' })).status, 400);
    const plainMsg = db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'old plain')").run(dm, a).lastInsertRowid;
    assert.equal((await call(a, 'PATCH', `/api/messages/${plainMsg}`, { content: 'edited' })).status, 400);
    assert.equal((await call(a, 'POST', `/api/messages/${message.id}/forward`, { scopeType: 'dm', scopeId: plain })).status, 400);

    const unenc = db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'to forward')").run(plain, a).lastInsertRowid;
    assert.equal((await call(a, 'POST', `/api/messages/${unenc}/forward`, { scopeType: 'dm', scopeId: dm })).status, 400);
    assert.equal((await call(a, 'POST', '/api/polls', { scopeType: 'dm', scopeId: dm, question: 'q?', options: ['a', 'b'] })).status, 400);

    assert.equal((await call(a, 'PUT', `/api/messages/${message.id}/reactions/${encodeURIComponent('👍')}`)).status, 200);
    assert.equal((await call(b, 'PUT', `/api/messages/${message.id}/pin`)).status, 200);
    assert.equal((await call(a, 'POST', `/api/dms/${plain}/messages`, { content: 'still plaintext elsewhere' })).status, 201);
  });
});

test('notifications never carry ciphertext and search skips encrypted rows', async () => {
  const a = makeUser('e2e_a4');
  const b = makeUser('e2e_b4');
  const dm = makeDm(a, b);
  const env = envelope(0, 'searchable-marker-zzz');
  await withApp(async (call) => {
    await call(a, 'POST', `/api/dms/${dm}/encryption/enable`);
    await call(a, 'POST', `/api/dms/${dm}/messages`, { content: env });
    const search = await (await call(b, 'GET', `/api/dms/${dm}/search?q=chainIndex&fields=text,usernames`)).json();
    assert.deepEqual(search.messages.filter((m) => m.isEncrypted), []);
  });
  const { notifications } = pollOutbox(b, 0, 50);
  assert.equal(notifications.length, 1);
  assert.ok(!JSON.stringify(notifications[0].message).includes('ciphertext'));
  assert.equal(notifications[0].message.content, 'New encrypted message from e2e_a4');
  assert.deepEqual(searchMessages('dm', [dm], 'ciphertext', { fields: { text: true } }), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE scope_id = ? AND is_encrypted = 1').get(dm).n, 1);
});

test('reports: plaintext evidence only for encrypted messages from a participant; admins never see ciphertext', async () => {
  const a = makeUser('e2e_a5');
  const b = makeUser('e2e_b5');
  const outsider = makeUser('e2e_o5');
  const admin = makeUser('e2e_admin5');
  const dm = makeDm(a, b);
  await withApp(async (call) => {
    await call(a, 'POST', `/api/dms/${dm}/encryption/enable`);
    const { message } = await (await call(a, 'POST', `/api/dms/${dm}/messages`, { content: envelope() })).json();
    const plainId = db.prepare("INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES ('dm', ?, ?, 'visible text')").run(dm, a).lastInsertRowid;

    const file = (user, messageId, evidence) => call(user, 'POST', '/api/reports', {
      reportedUserId: a, reason: 'harassment', messageId, plaintextEvidence: evidence,
    });
    assert.equal((await file(b, message.id, 'the decrypted insult')).status, 201);
    assert.equal((await file(b, message.id, undefined)).status, 201);
    assert.equal((await file(outsider, message.id, 'forged evidence')).status, 201);
    assert.equal((await file(b, plainId, 'ignored for plaintext')).status, 201);
    assert.equal((await file(b, message.id, 'x'.repeat(5000))).status, 201);

    const rows = db.prepare('SELECT message_id, plaintext_evidence FROM reports WHERE reported_user_id = ? ORDER BY id').all(a);
    assert.equal(rows[0].plaintext_evidence, 'the decrypted insult');
    assert.equal(rows[1].plaintext_evidence, null);
    assert.equal(rows[2].plaintext_evidence, null);
    assert.equal(rows[3].plaintext_evidence, null);
    assert.equal(rows[4].plaintext_evidence.length, 4000);

    const adminRes = await call(admin, 'GET', '/api/admin/reports', undefined, { 'x-test-admin': '1' });
    const adminBody = await adminRes.json();
    const { reports } = adminBody;
    const byMsg = reports.filter((r) => r.message?.id === message.id).sort((x, y) => x.id - y.id);
    assert.equal(byMsg[0].message.content, 'the decrypted insult');
    assert.equal(byMsg[0].message.encrypted, true);
    assert.equal(byMsg[0].message.hasEvidence, true);
    assert.equal(byMsg[1].message.content, '');
    assert.equal(byMsg[1].message.hasEvidence, false);
    assert.ok(!JSON.stringify(reports).includes('ciphertext'));
    const plainReport = reports.find((r) => r.message?.id === plainId);
    assert.equal(plainReport.message.content, 'visible text');
    assert.equal(plainReport.message.encrypted, undefined);
  });
});

test('link-preview endpoint requires auth shape and refuses private hosts', async () => {
  const a = makeUser('e2e_a6');
  await withApp(async (call, base) => {
    assert.equal((await call(a, 'POST', '/api/link-preview', { url: 'ftp://x' })).status, 400);
    assert.equal((await call(a, 'POST', '/api/link-preview', {})).status, 400);
    const res = await call(a, 'POST', '/api/link-preview', { url: 'http://127.0.0.1:1/' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).embed, null);
    const anon = await fetch(`${base}/api/link-preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"https://example.com"}' });
    assert.equal(anon.status, 401);
  });
});

test('pruning and deleting encrypted messages is row-level', async () => {
  const a = makeUser('e2e_a7');
  const b = makeUser('e2e_b7');
  const dm = makeDm(a, b);
  await withApp(async (call) => {
    await call(a, 'POST', `/api/dms/${dm}/encryption/enable`);
    const { message } = await (await call(a, 'POST', `/api/dms/${dm}/messages`, { content: envelope() })).json();
    assert.equal((await call(a, 'DELETE', `/api/messages/${message.id}`)).status, 200);
    assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(message.id), undefined);
    await call(a, 'POST', `/api/dms/${dm}/messages`, { content: envelope(1) });
    prune.wipeScope('dm', dm);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE scope_type = 'dm' AND scope_id = ?").get(dm).n, 0);
  });
});
