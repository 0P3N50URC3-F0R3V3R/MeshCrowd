'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;
const { db } = require('../db');
const federationApiRouter = require('../routes/federationApi');
const { canonicalize } = require('../lib/federationCrypto');
const { isSafePeerUrl } = require('../lib/federationSsrf');
const { sanitizeFilename } = require('../lib/uploads');
const { errorHandler } = require('../middleware/errorHandler');
const { resolveOrCreateRemoteUser } = require('../lib/federationUsers');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

// Mirrors server/index.js:44's `app.use(express.json({ limit: '1mb' }))` exactly — it's a bare
// magic string there (no shared constant/config value to import), so this is the one place that
// value could silently drift from what this suite actually exercises. If index.js's limit ever
// changes, update this literal to match.
const PRODUCTION_JSON_LIMIT = '1mb';

async function withServer(fn) {
  const app = express();
  app.use(express.json({ limit: PRODUCTION_JSON_LIMIT }));
  app.use('/federation/api', federationApiRouter);
  // The real server/index.js mounts this last, after the federation router (index.js:141) — mounted
  // here too so a body-parser error actually goes through the same client-visible path production
  // does, instead of falling through to Express's own default handler (which happens to pass through
  // err.status and would mask a real gap in errorHandler itself; see the oversized-payload test).
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

function makePeer(domain, pubkeyPem, status = 'active') {
  return db.prepare(`INSERT INTO federation_peers (domain, public_url, their_pubkey, status) VALUES (?, 'https://x', ?, ?)`)
    .run(domain, pubkeyPem, status).lastInsertRowid;
}

test('replayed event outside the window is rejected', async () => {
  // Task 9's own federationInbox.test.js already covers this; re-driven here, for real, against a
  // live withServer instance so this file's claim to be "a single place to point at during
  // /security-review" is actually true rather than an `assert.ok(true)` placeholder.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  makePeer('replay.example', pubkeyPem);

  const stale = {
    event_id: 'replay-1', type: 'noop', origin_domain: 'replay.example',
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min old, outside the real 5-minute window
    payload: {},
  };
  const signature = crypto.sign(null, Buffer.from(canonicalize(stale)), privateKey).toString('base64');

  await withServer(async (base) => {
    const res = await fetch(`${base}/federation/api/inbox`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...stale, signature }),
    });
    assert.equal(res.status, 401);
  });
});

test('SSRF: private/loopback peer URLs are never accepted', async () => {
  for (const url of ['https://127.0.0.1/', 'https://10.0.0.5/', 'https://192.168.0.1/', 'https://169.254.1.1/']) {
    assert.equal(await isSafePeerUrl(url), false);
  }
});

test('path traversal: attachment filenames are neutralized before touching the filesystem', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..\\..\\windows\\system32\\evil.exe'), 'evil.exe');
});

test('oversized inbox payload is rejected before processing', async () => {
  await withServer(async (base) => {
    // Sized to exceed the REAL production limit (1mb), not an inflated test-only one — this
    // actually exercises server/index.js:44's configured value rather than proving Express's own
    // body-parser works in the abstract.
    const bigPayload = { data: 'x'.repeat(2 * 1024 * 1024) }; // 2MB, over the real 1mb limit
    const res = await fetch(`${base}/federation/api/inbox`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload: bigPayload }),
    });
    // withServer now mounts the real errorHandler (as server/index.js does), so this is the actual
    // client-visible outcome in production, not Express's default fallback handler's behavior.
    // errorHandler explicitly maps raw-body's PayloadTooLargeError (`err.type === 'entity.too.large'`)
    // to a clean 413 — previously it fell through to the generic branch and answered 500.
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error, 'request entity too large');
  });
});

test('forged author: a peer cannot assert an identity under a different domain\'s namespace', async () => {
  const peerId = makePeer('p.example', crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  const peer = { id: peerId, domain: 'p.example' };

  // The real adversarial case: a malicious peer, authenticated as p.example, sends a `username`
  // deliberately crafted to look like a full federated identity on a DIFFERENT, real domain —
  // exactly the string a genuine user of that other domain would have as their own federated_uid.
  const forgedUsername = 'victim@real-other-domain.example';
  const forged = resolveOrCreateRemoteUser(peer, { remoteId: 1, username: forgedUsername });

  // resolveOrCreateRemoteUser always string-concatenates the AUTHENTICATED peer's own domain on
  // (federationUsers.js:10: `${remoteUser.username}@${peer.domain}`), with no validation that
  // `username` itself doesn't already contain '@'. The resulting federated_uid is therefore the
  // literal two-'@' string below, not the real other-domain user's actual one-'@' identity.
  assert.equal(forged.federated_uid, 'victim@real-other-domain.example@p.example');

  // Simulate the real other-domain user actually existing (as a separate, legitimately-namespaced
  // row) and confirm the forged row is a structurally distinct DB entity: different id, and a
  // lookup by the real user's exact federated_uid does not and cannot return the forged row —
  // SQLite's exact-string-equality unique index on federated_uid (db/index.js's
  // idx_users_federated_uid) means a one-'@' string and a two-'@' string never collide.
  const realPeerId = makePeer('real-other-domain.example', crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  const realPeer = { id: realPeerId, domain: 'real-other-domain.example' };
  const real = resolveOrCreateRemoteUser(realPeer, { remoteId: 2, username: 'victim' });

  assert.equal(real.federated_uid, 'victim@real-other-domain.example');
  assert.notEqual(forged.id, real.id);
  const lookedUpByRealUid = db.prepare('SELECT id FROM users WHERE federated_uid = ?').get('victim@real-other-domain.example');
  assert.equal(lookedUpByRealUid.id, real.id); // never the forged row

  // `resolveParticipant` (federationApi.js) is the other place an '@'-bearing identity string from
  // a peer gets parsed: `usernameOrFederated.split('@')` on a crafted 'victim@real-other-domain.example@p.example'
  // yields domain === 'real-other-domain.example' (the SECOND split segment, not 'p.example'), which
  // fails the `domain !== peer.domain` check against the authenticated peer ('p.example') and is
  // rejected (returns null) rather than silently resolving under any domain's namespace. The source
  // match below is a cheap smoke check that the guard line still exists at all; the real behavioral
  // proof — that it's actually reachable and enforced on a live request — is the next test.
  const federationApiSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'federationApi.js'), 'utf8');
  assert.match(federationApiSrc, /if \(domain !== peer\.domain\) return null;/);
});

test('forged author: resolveParticipant\'s domain guard is enforced on a real signed dm_message_create', async () => {
  // Unlike the source-match above, this drives a real signed request through the real
  // /federation/api/inbox endpoint and asserts on resulting DB state — it would catch a refactor
  // that preserves the guard's literal text while making it unreachable or dead.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  makePeer('attacker.example', pubkeyPem);

  // A genuine local user, so a real DM channel actually gets created (the legitimate recipient).
  const localInfo = db.prepare(
    `INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)`
  ).run('local_recipient', 'local_recipient@test.invalid', 'x', 'Local Recipient');
  const localUserId = localInfo.lastInsertRowid;

  // The genuine other-domain victim, cached as if from a real prior handshake with victim.example —
  // this is the row the forged participant string below is impersonating.
  const victimPeerId = makePeer('victim.example', crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  const realVictim = resolveOrCreateRemoteUser({ id: victimPeerId, domain: 'victim.example' }, { remoteId: 9, username: 'victim' });

  const event = {
    event_id: 'dm-forge-1', type: 'dm_message_create', origin_domain: 'attacker.example',
    created_at: new Date().toISOString(),
    payload: {
      fromRemoteId: 1, fromUsername: 'attacker', content: 'hi', dmMessageId: 1,
      // 'attacker@attacker.example' resolves normally (same domain as the authenticated peer);
      // 'local_recipient' is a bare local username; 'victim@victim.example' is the forged entry —
      // a cross-domain identity asserted by a peer with no authority over victim.example.
      participants: ['attacker@attacker.example', 'local_recipient', 'victim@victim.example'],
    },
  };
  const signature = crypto.sign(null, Buffer.from(canonicalize(event)), privateKey).toString('base64');

  await withServer(async (base) => {
    const res = await fetch(`${base}/federation/api/inbox`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...event, signature }),
    });
    assert.equal(res.status, 200);
  });

  const channelRow = db.prepare('SELECT dm_channel_id FROM dm_members WHERE user_id = ?').get(localUserId);
  assert.ok(channelRow, 'the legitimate local recipient must have been added to a real DM channel');
  const members = db.prepare('SELECT user_id FROM dm_members WHERE dm_channel_id = ?').all(channelRow.dm_channel_id);

  // The guard's entire job: the forged 'victim@victim.example' participant must never resolve, so
  // the real victim.example row can never be linked into a channel created from attacker.example's
  // say-so alone.
  assert.ok(!members.some((m) => m.user_id === realVictim.id), 'victim.example\'s real user must never be linked into this channel');
  assert.equal(members.length, 2); // attacker + local_recipient only — the forged entry was dropped
});

// Display-level spoofing check (grepped by hand, not just asserted): does anything parse or
// render `federated_uid` in a way a crafted embedded '@' could make a user see a domain that
// isn't real?
//   - server/lib/publicUser.js's toPublicUser() — the only shape sent to API/socket clients —
//     never includes federated_uid or home_instance_id at all; it exposes `username` (the random
//     local placeholder for a remote row, e.g. `remote_a1b2c3`) and `displayName` (free-text,
//     already spoofable by any user via profile settings, pre-existing and unrelated to this).
//   - `web/js/**` has zero references to federated_uid/home_instance anywhere (grepped the whole
//     client tree) — the client never receives or renders this field.
//   - server/routes/friends.js's remoteUsernameOf() uses `lastIndexOf('@')`, which is safe against
//     an embedded '@' in a different way than resolveParticipant: it always recovers everything up
//     to the REAL (authenticated peer's) domain suffix. Its only two call sites send the result
//     back to `other.home_instance_id` — the very peer that supplied the forged username in the
//     first place, so nothing is disclosed that peer didn't already know.
//   - server/routes/dms.js:43 uses `federated_uid.split('@')[0]` (first '@', not last) — a
//     correctness inconsistency (an embedded '@' truncates the recovered "bare username" wrong)
//     but not a display-spoofing path: this value is never shown to any user, only placed into an
//     outbound federation protocol payload sent back to that same row's own home peer.
// Conclusion: no genuine display-level spoofing path found. No production fix made for this; the
// forged-author test above is a hardened assertion against DB-level confusion only, per the task's
// own instruction for this case.
test('forged federated_uid is never exposed to API/socket clients', () => {
  const publicUserSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'publicUser.js'), 'utf8');
  assert.doesNotMatch(publicUserSrc, /federated_uid/);
  assert.doesNotMatch(publicUserSrc, /home_instance/);
});

test('revoked peer requests are rejected', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  makePeer('q.example', pubkeyPem, 'revoked');
  const good = { event_id: 'r1', type: 'noop', origin_domain: 'q.example', created_at: new Date().toISOString(), payload: {} };
  const signature = crypto.sign(null, Buffer.from(canonicalize(good)), privateKey).toString('base64');
  await withServer(async (base) => {
    const res = await fetch(`${base}/federation/api/inbox`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...good, signature }) });
    assert.equal(res.status, 401);
  });
});
