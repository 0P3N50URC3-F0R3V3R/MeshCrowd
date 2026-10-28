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
const { attachUser } = require('../middleware/auth');
const challenges = require('../lib/passportChallenges');

const app = express();
app.use(express.json());
app.use(attachUser);
app.use('/api/auth', require('../routes/auth'));
let server; let base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
test.beforeEach(() => challenges._resetForTests());

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const backup = { encryptedKey: 'newenc', salt: 'ns', nonce: 'nn' };

test('changing the password with the right current password works and old password stops working', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'cp_one', email: 'cp1@t.co', password: 'password123' });
  const r = await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'another-pass-9' }, reg.cookie);
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/api/auth/login', { username: 'cp_one', password: 'password123' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'cp_one', password: 'another-pass-9' })).status, 200);
});

test('a wrong current password changes nothing', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'cp_two', email: 'cp2@t.co', password: 'password123' });
  const r = await call('POST', '/api/auth/change-password', { currentPassword: 'nope-nope-1', newPassword: 'another-pass-9' }, reg.cookie);
  assert.equal(r.status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'cp_two', password: 'password123' })).status, 200);
});

test('too-short new passwords and unauthenticated calls are refused', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'cp_three', email: 'cp3@t.co', password: 'password123' });
  assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'short' }, reg.cookie)).status, 400);
  assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'another-pass-9' })).status, 401);
});

test('an account with a passport must supply the re-wrapped seed and it is stored with the new hash', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'cp_four', email: 'cp4@t.co', password: 'password123' });
  const uid = db.prepare('SELECT id FROM users WHERE username = ?').get('cp_four').id;
  db.prepare("UPDATE users SET passport_id = ?, passport_public_key = 'pk' WHERE id = ?").run('mc1' + 'd'.repeat(52), uid);
  db.prepare("INSERT INTO e2ee_key_backups (user_id, encrypted_key, salt, nonce) VALUES (?, 'old', 's', 'n')").run(uid);
  const missing = await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'another-pass-9' }, reg.cookie);
  assert.equal(missing.status, 400);
  assert.equal((await call('POST', '/api/auth/login', { username: 'cp_four', password: 'password123' })).status, 200);
  const ok = await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'another-pass-9', backup }, reg.cookie);
  assert.equal(ok.status, 200);
  assert.equal(db.prepare('SELECT encrypted_key FROM e2ee_key_backups WHERE user_id = ?').get(uid).encrypted_key, 'newenc');
});

test('other sessions are signed out but the current one survives', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'cp_five', email: 'cp5@t.co', password: 'password123' });
  const other = await call('POST', '/api/auth/login', { username: 'cp_five', password: 'password123' });
  await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'another-pass-9' }, reg.cookie);
  assert.equal((await call('GET', '/api/auth/me', null, reg.cookie)).status, 200);
  assert.equal((await call('GET', '/api/auth/me', null, other.cookie)).status, 401);
});

test('changing the password closes the account\'s live sockets so signed-out sessions stop receiving events', async () => {
  const presence = require('../lib/presence');
  const reg = await call('POST', '/api/auth/register', { username: 'cp_six', email: 'cp6@t.co', password: 'password123' });
  const uid = db.prepare('SELECT id FROM users WHERE username = ?').get('cp_six').id;
  const closed = [];
  presence.registerConnection(uid, { readyState: 1, OPEN: 1, send() {}, close(code) { closed.push(code); } });
  await call('POST', '/api/auth/change-password', { currentPassword: 'wrong-pass-1', newPassword: 'another-pass-9' }, reg.cookie);
  assert.deepEqual(closed, []);
  await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'another-pass-9' }, reg.cookie);
  assert.deepEqual(closed, [4002]);
});

test('dropBackup discards the server-side backup instead of requiring a re-wrapped one, and never touches passport_id', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'cp_seven', email: 'cp7@t.co', password: 'password123' });
  const uid = db.prepare('SELECT id FROM users WHERE username = ?').get('cp_seven').id;
  const passportId = 'mc1' + 'e'.repeat(52);
  db.prepare("UPDATE users SET passport_id = ?, passport_public_key = 'pk' WHERE id = ?").run(passportId, uid);
  db.prepare("INSERT INTO e2ee_key_backups (user_id, encrypted_key, salt, nonce) VALUES (?, 'old', 's', 'n')").run(uid);
  // dropBackup alone, no backup field: skips the re-wrapped-backup requirement entirely.
  const r = await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'another-pass-9', dropBackup: true }, reg.cookie);
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM e2ee_key_backups WHERE user_id = ?').get(uid), undefined);
  assert.equal(db.prepare('SELECT passport_id FROM users WHERE id = ?').get(uid).passport_id, passportId);
  assert.equal((await call('POST', '/api/auth/login', { username: 'cp_seven', password: 'another-pass-9' })).status, 200);
});

test('five wrong current passwords lock change-password for that user; a correct one afterward still stalls until it clears', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'cp_eight', email: 'cp8@t.co', password: 'password123' });
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: 'wrong-pass-1', newPassword: 'another-pass-9' }, reg.cookie)).status, 401);
  }
  const locked = await call('POST', '/api/auth/change-password', { currentPassword: 'password123', newPassword: 'another-pass-9' }, reg.cookie);
  assert.equal(locked.status, 429);
  assert.equal((await call('POST', '/api/auth/login', { username: 'cp_eight', password: 'password123' })).status, 200);
});

test('verify-password accepts the right password, rejects a wrong one, and changes nothing', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'vp_one', email: 'vp1@t.co', password: 'password123' });
  assert.equal((await call('POST', '/api/auth/verify-password', { currentPassword: 'password123' }, reg.cookie)).status, 200);
  assert.equal((await call('POST', '/api/auth/verify-password', { currentPassword: 'wrong-wrong-1' }, reg.cookie)).status, 401);
  assert.equal((await call('POST', '/api/auth/verify-password', { currentPassword: 'password123' })).status, 401);
  assert.equal((await call('GET', '/api/auth/me', null, reg.cookie)).status, 200);
});
