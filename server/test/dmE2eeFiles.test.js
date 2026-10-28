'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const siteSettings = require('../lib/siteSettings');
const prune = require('../lib/prune');
const { dmFilePath, sweepDmFiles } = require('../lib/dmFiles');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const KEY = Buffer.alloc(32, 7).toString('base64');
const NONCE = Buffer.alloc(24, 1).toString('base64');
let chain = 0;
const envelope = () => JSON.stringify({ v: 1, chainIndex: chain++, nonce: NONCE, ciphertext: Buffer.alloc(40, 3).toString('base64') });
const blobId = () => crypto.randomBytes(16).toString('hex');

function makeUser(username) {
  return db.prepare('INSERT INTO users (username, email, password_hash, display_name, e2ee_public_key) VALUES (?, ?, ?, ?, ?)')
    .run(username, `${username}@test.local`, 'hash', username, KEY).lastInsertRowid;
}

function makeDm(a, b, { encrypted = true } = {}) {
  const id = db.prepare('INSERT INTO dm_channels (is_group, created_by, e2ee_enabled) VALUES (0, ?, ?)').run(a, encrypted ? 1 : 0).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(id, a, id, b);
  return id;
}

async function withApp(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-test-user']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/dms', require('../routes/dms'));
  app.use('/api/messages', require('../routes/messages'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = {
    json: (userId, method, url, body) => fetch(base + url, {
      method, headers: { 'content-type': 'application/json', 'x-test-user': String(userId) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    upload: (userId, dmId, id, bytes) => fetch(`${base}/api/dms/${dmId}/e2ee-files/${id}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-test-user': String(userId) }, body: bytes,
    }),
    download: (userId, dmId, id) => fetch(`${base}/api/dms/${dmId}/e2ee-files/${id}`, { headers: { 'x-test-user': String(userId) } }),
  };
  try { await fn(api); } finally { server.close(); }
}

const send = (api, user, dm, fileIds) => api.json(user, 'POST', `/api/dms/${dm}/messages`, { content: envelope(), fileIds });

test('upload and download are member-only and scoped to their own DM', async () => {
  const a = makeUser('ef_a1');
  const b = makeUser('ef_b1');
  const c = makeUser('ef_c1');
  const dm = makeDm(a, b);
  const otherDm = makeDm(c, b);
  const plainDm = makeDm(a, c, { encrypted: false });
  const blob = crypto.randomBytes(100);
  await withApp(async (api) => {
    const id = blobId();
    assert.equal((await api.upload(c, dm, id, blob)).status, 403, 'non-member upload');
    assert.equal((await api.upload(a, plainDm, blobId(), blob)).status, 400, 'unencrypted DM');
    assert.equal((await api.upload(a, dm, 'NOT-A-HEX-ID', blob)).status, 400, 'bad blob id');
    assert.equal((await api.upload(a, dm, blobId(), crypto.randomBytes(10))).status, 400, 'shorter than AEAD overhead');

    const up = await api.upload(a, dm, id, blob);
    assert.equal(up.status, 201);
    assert.deepEqual((await up.json()).file, { id, size: 100 });
    assert.equal((await api.upload(a, dm, id, blob)).status, 409, 'blob id reuse');
    const row = db.prepare('SELECT * FROM dm_e2ee_files WHERE blob_id = ?').get(id);
    assert.equal(row.message_id, null);
    assert.deepEqual(Object.keys(row).sort(), ['blob_id', 'created_at', 'dm_id', 'id', 'message_id', 'size', 'user_id']);
    assert.ok(dmFilePath(dm, id).startsWith(path.join(tmpDir, 'attachments')));

    assert.equal((await api.download(b, dm, id)).status, 404, 'unsent upload is private to the uploader');
    assert.equal((await api.download(a, dm, id)).status, 200);

    assert.equal((await send(api, b, dm, [id])).status, 400, 'peer cannot claim my upload');
    const sent = await send(api, a, dm, [id]);
    assert.equal(sent.status, 201);
    const { message } = await sent.json();
    assert.equal(db.prepare('SELECT message_id FROM dm_e2ee_files WHERE blob_id = ?').get(id).message_id, message.id);
    assert.equal((await send(api, a, dm, [id])).status, 400, 'already attached');

    const got = await api.download(b, dm, id);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.equal(got.headers.get('content-disposition'), 'attachment');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), blob);

    assert.equal((await api.download(c, dm, id)).status, 403, 'non-member download');
    assert.equal((await api.download(c, otherDm, id)).status, 404, "another DM's blob through my own DM");
    assert.equal((await api.download(b, otherDm, id)).status, 404, 'member of both DMs, wrong DM path');
  });
});

test('fileIds are validated on send', async () => {
  const a = makeUser('ef_a2');
  const b = makeUser('ef_b2');
  const dm = makeDm(a, b);
  const elsewhere = makeDm(a, makeUser('ef_c2'));
  await withApp(async (api) => {
    const foreign = blobId();
    await api.upload(a, elsewhere, foreign, crypto.randomBytes(40));
    assert.equal((await send(api, a, dm, [foreign])).status, 400, 'blob from another DM');
    assert.equal((await send(api, a, dm, [blobId()])).status, 400, 'unknown blob');
    assert.equal((await send(api, a, dm, 'nope')).status, 400);
    assert.equal((await send(api, a, dm, [1, 2])).status, 400);
    const ids = [];
    for (let i = 0; i < 6; i++) { const id = blobId(); ids.push(id); await api.upload(a, dm, id, crypto.randomBytes(40)); }
    assert.equal((await send(api, a, dm, ids)).status, 400, 'more than five');
    assert.equal((await send(api, a, dm, ids.slice(0, 5))).status, 201);
    assert.equal((await send(api, a, dm, undefined)).status, 201, 'text-only messages unchanged');
  });
});

test('size is capped by the site upload limit and unsent uploads are bounded', async () => {
  const a = makeUser('ef_a3');
  const b = makeUser('ef_b3');
  const dm = makeDm(a, b);
  siteSettings.setMaxUploadMb(1);
  try {
    await withApp(async (api) => {
      const max = 1024 * 1024 + 28;
      assert.equal((await api.upload(a, dm, blobId(), Buffer.alloc(max + 1))).status, 413);
      assert.equal((await api.upload(a, dm, blobId(), Buffer.alloc(max))).status, 201);
      for (let i = 0; i < 9; i++) await api.upload(a, dm, blobId(), Buffer.alloc(40));
      assert.equal((await api.upload(a, dm, blobId(), Buffer.alloc(40))).status, 429);
      assert.equal((await api.upload(b, dm, blobId(), Buffer.alloc(40))).status, 201, 'the cap is per uploader');
    });
  } finally {
    siteSettings.setMaxUploadMb(25);
  }
});

test('unsent uploads can be withdrawn by their uploader only', async () => {
  const a = makeUser('ef_a4');
  const b = makeUser('ef_b4');
  const dm = makeDm(a, b);
  await withApp(async (api) => {
    const id = blobId();
    await api.upload(a, dm, id, crypto.randomBytes(40));
    assert.equal((await api.json(b, 'DELETE', `/api/dms/${dm}/e2ee-files/${id}`)).status, 404);
    assert.equal((await api.json(a, 'DELETE', `/api/dms/${dm}/e2ee-files/${id}`)).status, 200);
    assert.ok(!fs.existsSync(dmFilePath(dm, id)));
    const sentId = blobId();
    await api.upload(a, dm, sentId, crypto.randomBytes(40));
    await send(api, a, dm, [sentId]);
    assert.equal((await api.json(a, 'DELETE', `/api/dms/${dm}/e2ee-files/${sentId}`)).status, 404, 'sent blobs go with their message');
  });
});

test('blobs are removed with their message, by prune and when the DM is wiped', async () => {
  const a = makeUser('ef_a5');
  const b = makeUser('ef_b5');
  const dm = makeDm(a, b);
  await withApp(async (api) => {
    const upSend = async () => {
      const id = blobId();
      await api.upload(a, dm, id, crypto.randomBytes(40));
      const { message } = await (await send(api, a, dm, [id])).json();
      return { id, messageId: message.id };
    };
    const gone = (id) => !fs.existsSync(dmFilePath(dm, id)) && !db.prepare('SELECT 1 FROM dm_e2ee_files WHERE blob_id = ?').get(id);

    const deleted = await upSend();
    assert.ok(fs.existsSync(dmFilePath(dm, deleted.id)));
    assert.equal((await api.json(a, 'DELETE', `/api/messages/${deleted.messageId}`)).status, 200);
    assert.ok(gone(deleted.id));

    const pruned = await upSend();
    const future = new Date(Date.now() + 60_000).toISOString();
    const pairs = prune.resolveScopePairs('dm', [dm]);
    assert.equal(prune.previewPrune(pairs, future, true).attachmentCount, 1);
    prune.executePrune({ scopeKind: 'dm', ids: [dm], cutoffAt: future, purgeAttachments: false, notify: 'immediate', requestedBy: a, serverId: null });
    assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(pruned.messageId), 'kept when attachments are not purged');
    assert.ok(!gone(pruned.id));
    prune.executePrune({ scopeKind: 'dm', ids: [dm], cutoffAt: future, purgeAttachments: true, notify: 'immediate', requestedBy: a, serverId: null });
    assert.ok(gone(pruned.id));

    const kept = await upSend();
    const unsent = blobId();
    await api.upload(b, dm, unsent, crypto.randomBytes(40));
    prune.wipeScope('dm', dm);
    assert.ok(gone(kept.id));
    assert.ok(gone(unsent));
  });
});

test('startup sweep drops stale unsent uploads and orphaned files', async () => {
  const a = makeUser('ef_a6');
  const dm = makeDm(a, makeUser('ef_b6'));
  await withApp(async (api) => {
    const stale = blobId();
    const fresh = blobId();
    await api.upload(a, dm, stale, crypto.randomBytes(40));
    await api.upload(a, dm, fresh, crypto.randomBytes(40));
    db.prepare("UPDATE dm_e2ee_files SET created_at = '2000-01-01T00:00:00.000Z' WHERE blob_id = ?").run(stale);
    const orphan = dmFilePath(dm, blobId());
    fs.writeFileSync(orphan, 'x');
    sweepDmFiles();
    assert.ok(!fs.existsSync(dmFilePath(dm, stale)));
    assert.ok(!fs.existsSync(orphan));
    assert.ok(fs.existsSync(dmFilePath(dm, fresh)));
  });
});
