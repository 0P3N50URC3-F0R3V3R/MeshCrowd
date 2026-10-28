'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const { enqueueEvent } = require('../lib/federationOutbox');
const { drainOnce } = require('../lib/federationOutboxWorker');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('successful delivery marks delivered; failure schedules backoff', async () => {
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('c.example', 'https://c.example/', 'PEM', 'active')`).run().lastInsertRowid;
  enqueueEvent(peerId, 'ping', { n: 1 });

  let calls = 0;
  const okFetch = async () => { calls += 1; return { ok: true, status: 200 }; };
  await drainOnce(okFetch);
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT status FROM federation_outbox').get().status, 'delivered');

  enqueueEvent(peerId, 'ping', { n: 2 });
  const failFetch = async () => ({ ok: false, status: 500 });
  await drainOnce(failFetch);
  const row = db.prepare(`SELECT * FROM federation_outbox WHERE status = 'pending'`).get();
  assert.equal(row.attempt_count, 1);
  assert.ok(new Date(row.next_attempt_at).getTime() > Date.now());
});

test('one in-flight request per peer: second pending event waits for the first', async () => {
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('d.example', 'https://d.example/', 'PEM', 'active')`).run().lastInsertRowid;
  enqueueEvent(peerId, 'ping', { n: 1 });
  enqueueEvent(peerId, 'ping', { n: 2 });

  let deliveredOrder = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    deliveredOrder.push(body.payload.n);
    return { ok: true, status: 200 };
  };
  assert.equal(await drainOnce(fetchImpl), 1); // first pass delivers only event 1 (FIFO, one per peer per pass)
  assert.equal(await drainOnce(fetchImpl), 1); // second pass delivers event 2
  assert.equal(await drainOnce(fetchImpl), 0); // nothing left: the periodic worker stops re-draining on 0
  assert.deepEqual(deliveredOrder, [1, 2]);
});

test('drainOnce guards against overlapping invocations: a concurrent call is skipped, not queued', async () => {
  const peerId = db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES ('e.example', 'https://e.example/', 'PEM', 'active')`).run().lastInsertRowid;
  enqueueEvent(peerId, 'ping', { n: 1 });

  let calls = 0;
  let resolveFetch;
  const slowFetch = async () => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };

  const first = drainOnce(slowFetch); // not awaited: fetch is now pending
  await drainOnce(slowFetch); // concurrent call must return immediately without calling fetch again
  assert.equal(calls, 1);

  resolveFetch({ ok: true, status: 200 });
  await first;
  assert.equal(db.prepare('SELECT status FROM federation_outbox WHERE peer_id = ?').get(peerId).status, 'delivered');
});
