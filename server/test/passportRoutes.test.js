'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { attachUser } = require('../middleware/auth');
const { buildChallengeMessage, passportIdFromPublicKey } = require('../lib/passportCrypto');
const challenges = require('../lib/passportChallenges');
const http = require('node:http');

const app = express();
app.use(express.json());
app.use(attachUser);
app.use('/api/passport', require('../routes/passport'));
app.use('/api/auth', require('../routes/auth'));
app.use('/api/users', require('../routes/users'));
let server; let base;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
test.beforeEach(() => challenges._resetForTests());

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

function newIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, publicKeyB64: raw.toString('base64'), id: passportIdFromPublicKey(raw) };
}
async function proof(identity, purpose, overrides = {}) {
  const ch = (await call('POST', '/api/passport/challenge')).body;
  const fields = { purpose, origin: ch.origin, nonce: ch.nonce, issuedAt: ch.issuedAt, ...overrides };
  const signature = crypto.sign(null, Buffer.from(buildChallengeMessage(fields)), identity.privateKey).toString('base64');
  return { nonce: ch.nonce, issuedAt: ch.issuedAt, signature };
}
const backup = { encryptedKey: 'enc', salt: 'salt', nonce: 'nonce' };
const AUTH_KEY = Buffer.alloc(32, 9).toString('base64');
const AUTH_SALT = Buffer.alloc(16, 9).toString('base64');
const NEW_AUTH_KEY = Buffer.alloc(32, 10).toString('base64');
const NEW_AUTH_SALT = Buffer.alloc(16, 10).toString('base64');
const splitBackup = { encryptedKey: 'enc', salt: 'split:v1', nonce: 'nonce' };
async function register(identity, name, extra = {}) {
  return call('POST', '/api/passport/register', {
    username: name, email: `${name}@t.co`, authKey: AUTH_KEY, authSalt: AUTH_SALT, backup: splitBackup,
    passportPublicKey: identity.publicKeyB64, e2eePublicKey: Buffer.alloc(32, 1).toString('base64'),
    ...(await proof(identity, 'register')), ...extra,
  });
}

test('challenge returns a nonce bound to this server origin', async () => {
  const r = await call('POST', '/api/passport/challenge');
  assert.equal(r.status, 200);
  assert.match(r.body.nonce, /^[0-9a-f]{64}$/);
  assert.equal(r.body.origin, base);
});

test('register with a valid proof creates a passport-bound account and a session', async () => {
  const idn = newIdentity();
  const r = await register(idn, 'pr_one');
  assert.equal(r.status, 201);
  assert.equal(r.body.user.passportId, idn.id);
  assert.ok(r.cookie.startsWith('dismesh_session='));
  const row = db.prepare('SELECT passport_id FROM users WHERE username = ?').get('pr_one');
  assert.equal(row.passport_id, idn.id);
  assert.equal((await call('GET', '/api/auth/me', null, r.cookie)).status, 200);
});

test('register rejects a replayed nonce, another origin, another purpose and a foreign key', async () => {
  const idn = newIdentity();
  const p = await proof(idn, 'register');
  const body = { username: 'pr_rep', email: 'pr_rep@t.co', authKey: AUTH_KEY, authSalt: AUTH_SALT, backup: splitBackup, passportPublicKey: idn.publicKeyB64, e2eePublicKey: Buffer.alloc(32, 1).toString('base64'), ...p };
  assert.equal((await call('POST', '/api/passport/register', body)).status, 201);
  const replay = await call('POST', '/api/passport/register', { ...body, username: 'pr_rep2', email: 'pr_rep2@t.co' });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error, 'invalid passport proof');
  const other = newIdentity();
  assert.equal((await register(other, 'pr_o1', await proof(other, 'register', { origin: 'https://evil.example' }))).status, 401);
  assert.equal((await register(other, 'pr_o2', await proof(other, 'login'))).status, 401);
  const stranger = newIdentity();
  assert.equal((await register(other, 'pr_o3', await proof(stranger, 'register'))).status, 401);
});

test('the same passport cannot register twice on one server; the 409 names the existing account', async () => {
  const idn = newIdentity();
  assert.equal((await register(idn, 'pr_dup1')).status, 201);
  const second = await register(idn, 'pr_dup2');
  assert.equal(second.status, 409);
  assert.equal(second.body.username, 'pr_dup1');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users WHERE username = ?').get('pr_dup2').c, 0);
});

test('a free passport with a taken username or email gets a 409 and no account', async () => {
  assert.equal((await register(newIdentity(), 'pr_taken')).status, 201);
  const r = await register(newIdentity(), 'pr_taken');
  assert.equal(r.status, 409);
  assert.equal(r.body.username, undefined);
});

test('login with a valid proof creates a session; wrong key, replay and unknown id all get the same generic 401', async () => {
  const idn = newIdentity();
  await register(idn, 'pr_login');
  const ok = await call('POST', '/api/passport/login', { passportId: idn.id, ...(await proof(idn, 'login')) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.username, 'pr_login');
  const p = await proof(idn, 'login');
  await call('POST', '/api/passport/login', { passportId: idn.id, ...p });
  const replay = await call('POST', '/api/passport/login', { passportId: idn.id, ...p });
  const wrongKey = await call('POST', '/api/passport/login', { passportId: idn.id, ...(await proof(newIdentity(), 'login')) });
  const unknown = newIdentity();
  const unknownRes = await call('POST', '/api/passport/login', { passportId: unknown.id, ...(await proof(unknown, 'login')) });
  for (const r of [replay, wrongKey, unknownRes]) {
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'invalid passport proof');
  }
});

test('five bad proofs lock the id out, even for a later valid proof', async () => {
  const idn = newIdentity();
  await register(idn, 'pr_lock');
  for (let i = 0; i < 5; i++) await call('POST', '/api/passport/login', { passportId: idn.id, ...(await proof(newIdentity(), 'login')) });
  const locked = await call('POST', '/api/passport/login', { passportId: idn.id, ...(await proof(idn, 'login')) });
  assert.equal(locked.status, 429);
});

test('login for a TOTP account returns a pending token instead of a session, and a disabled account is refused', async () => {
  const idn = newIdentity();
  await register(idn, 'pr_totp');
  db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE username = ?').run('JBSWY3DPEHPK3PXP', 'pr_totp');
  const r = await call('POST', '/api/passport/login', { passportId: idn.id, ...(await proof(idn, 'login')) });
  assert.equal(r.body.requiresTotp, true);
  assert.ok(r.body.pendingToken);
  assert.equal(r.cookie, '');
  db.prepare('UPDATE users SET totp_enabled = 0, is_disabled = 1 WHERE username = ?').run('pr_totp');
  const d = await call('POST', '/api/passport/login', { passportId: idn.id, ...(await proof(idn, 'login')) });
  assert.equal(d.status, 403);
});

test('recover sets a new password and wrapped seed, kills old sessions and logs the user in', async () => {
  const idn = newIdentity();
  const reg = await register(idn, 'pr_rec');
  const newBackup = { encryptedKey: 'enc2', salt: 'split:v1', nonce: 'n2' };
  const r = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: newBackup, ...(await proof(idn, 'recover')) });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/auth/me', null, reg.cookie)).status, 401);
  assert.equal((await call('GET', '/api/auth/me', null, r.cookie)).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { username: 'pr_rec', authKey: NEW_AUTH_KEY })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { username: 'pr_rec', authKey: AUTH_KEY })).status, 401);
  assert.equal(db.prepare('SELECT encrypted_key FROM e2ee_key_backups WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('pr_rec').encrypted_key, 'enc2');
});

test('recover rejects a malformed new key and requires the 2FA code when 2FA is on', async () => {
  const idn = newIdentity();
  await register(idn, 'pr_rec2');
  const short = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: 'short', newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, ...(await proof(idn, 'recover')) });
  assert.equal(short.status, 400);
  db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ?, totp_recovery_codes = ? WHERE username = ?').run('JBSWY3DPEHPK3PXP', JSON.stringify(['rec1-code']), 'pr_rec2');
  const noCode = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, ...(await proof(idn, 'recover')) });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.body.requiresTotp, true);
  const withCode = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, code: 'rec1-code', ...(await proof(idn, 'recover')) });
  assert.equal(withCode.status, 200);
});

test('attach needs the current password (and the 2FA code when enabled) besides a session and a proof', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'pr_att', email: 'pr_att@t.co', password: 'password123' });
  const idn = newIdentity();
  const body = { passportPublicKey: idn.publicKeyB64, e2eePublicKey: Buffer.alloc(32, 2).toString('base64'), backup, currentPassword: 'password123' };
  assert.equal((await call('POST', '/api/passport/attach', { ...body, ...(await proof(idn, 'attach')) })).status, 401); // no session
  const noPw = await call('POST', '/api/passport/attach', { ...body, currentPassword: undefined, ...(await proof(idn, 'attach')) }, reg.cookie);
  assert.equal(noPw.status, 401);
  assert.equal(noPw.body.error, 'invalid passport proof');
  assert.equal((await call('POST', '/api/passport/attach', { ...body, currentPassword: 'wrong-pass-1', ...(await proof(idn, 'attach')) }, reg.cookie)).status, 401);
  const ok = await call('POST', '/api/passport/attach', { ...body, ...(await proof(idn, 'attach')) }, reg.cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.passportId, idn.id);
  assert.equal((await call('POST', '/api/passport/attach', { ...body, ...(await proof(idn, 'attach')) }, reg.cookie)).status, 409);
  const reg2 = await call('POST', '/api/auth/register', { username: 'pr_att2', email: 'pr_att2@t.co', password: 'password123' });
  assert.equal((await call('POST', '/api/passport/attach', { ...body, ...(await proof(idn, 'attach')) }, reg2.cookie)).status, 409);

  const reg3 = await call('POST', '/api/auth/register', { username: 'pr_att3', email: 'pr_att3@t.co', password: 'password123' });
  db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ?, totp_recovery_codes = ? WHERE username = ?').run('JBSWY3DPEHPK3PXP', JSON.stringify(['att3-code']), 'pr_att3');
  const idn3 = newIdentity();
  const body3 = { ...body, passportPublicKey: idn3.publicKeyB64 };
  assert.equal((await call('POST', '/api/passport/attach', { ...body3, ...(await proof(idn3, 'attach')) }, reg3.cookie)).status, 401);
  assert.equal((await call('POST', '/api/passport/attach', { ...body3, code: 'att3-code', ...(await proof(idn3, 'attach')) }, reg3.cookie)).status, 200);
});

test('a forged Host header cannot mint a challenge or make a proof for that origin valid', async () => {
  const port = server.address().port;
  const raw = (pathname, host, payload) => new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : '';
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
    });
    req.on('error', reject); req.end(data);
  });
  const forged = await raw('/api/passport/challenge', 'evil.example');
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error, 'unrecognised server address');

  const idn = newIdentity();
  await register(idn, 'pr_host');
  const ch = (await call('POST', '/api/passport/challenge')).body;
  const signature = crypto.sign(null, Buffer.from(buildChallengeMessage({ purpose: 'login', origin: 'http://evil.example', nonce: ch.nonce, issuedAt: ch.issuedAt })), idn.privateKey).toString('base64');
  const r = await raw('/api/passport/login', 'evil.example', { passportId: idn.id, nonce: ch.nonce, issuedAt: ch.issuedAt, signature });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'invalid passport proof');
});

test('passportOrigin allows configured hosts, extra origins and loopback only', () => {
  const o = require('../lib/passportOrigin');
  o.configure({ publicHost: 'Chat.Example.com', port: 8080, httpsPort: 443, passportOrigins: ['https://alt.example.org:9000/'] });
  try {
    assert.equal(o.isAllowedOrigin('https://chat.example.com'), true);
    assert.equal(o.isAllowedOrigin('http://chat.example.com:8080'), true);
    assert.equal(o.isAllowedOrigin('https://alt.example.org:9000'), true);
    assert.equal(o.isAllowedOrigin('https://chat.example.com:8443'), false);
    assert.equal(o.isAllowedOrigin('https://evil.example'), false);
    const fakeReq = (remoteAddress, trustProxy = false) => ({ socket: { remoteAddress }, app: { get: () => trustProxy } });
    for (const addr of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1']) {
      assert.equal(o.isAllowedOrigin('http://localhost:5555', fakeReq(addr)), true, addr);
    }
    assert.equal(o.isAllowedOrigin('http://[::1]:5555', fakeReq('::1')), true);
    assert.equal(o.isAllowedOrigin('http://localhost:5555'), false);
    assert.equal(o.isAllowedOrigin('http://localhost:5555', fakeReq('203.0.113.9')), false);
    assert.equal(o.isAllowedOrigin('http://127.0.0.1:5555', fakeReq('::ffff:10.0.0.1')), false);
    assert.equal(o.isAllowedOrigin('http://localhost:5555', fakeReq('127.0.0.1', true)), false);
    assert.equal(o.isAllowedOrigin('http://localhost:5555', fakeReq('127.0.0.1', 1)), false);
    for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via']) {
      const req = { ...fakeReq('127.0.0.1'), headers: { host: 'localhost:5555', [h]: '203.0.113.9' } };
      assert.equal(o.isAllowedOrigin('http://localhost:5555', req), false, h);
    }
    assert.equal(o.isAllowedOrigin('http://localhost:5555', { ...fakeReq('127.0.0.1'), headers: { host: 'localhost:5555' } }), true);
  } finally {
    o.configure({});
  }
});

test('a loopback Host is refused when the request carries proxy headers', async () => {
  const port = server.address().port;
  const post = (extra) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/passport/challenge', method: 'POST', headers: { host: `localhost:${port}`, 'content-type': 'application/json', 'content-length': 0, ...extra } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(await post({}), 200);
  assert.equal(await post({ 'X-Forwarded-For': '203.0.113.9' }), 400);
});

test('register refuses the identity-point (small-order) passport key', async () => {
  const r = await call('POST', '/api/passport/register', {
    username: 'pr_weak', email: 'pr_weak@t.co', authKey: AUTH_KEY, authSalt: AUTH_SALT, backup: splitBackup,
    passportPublicKey: Buffer.from('01' + '00'.repeat(31), 'hex').toString('base64'),
    e2eePublicKey: Buffer.alloc(32, 1).toString('base64'),
    ...(await proof(newIdentity(), 'register')),
  });
  assert.equal(r.status, 400);
});

test('a nonce issued for one origin cannot be used through another origin', async () => {
  const idn = newIdentity();
  await register(idn, 'pr_xorigin');
  const ch = (await call('POST', '/api/passport/challenge')).body;
  const other = 'http://localhost:1';
  const signature = crypto.sign(null, Buffer.from(buildChallengeMessage({ purpose: 'login', origin: other, nonce: ch.nonce, issuedAt: ch.issuedAt })), idn.privateKey).toString('base64');
  const url = new URL(base);
  const status = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ passportId: idn.id, nonce: ch.nonce, issuedAt: ch.issuedAt, signature });
    const req = http.request({ host: url.hostname, port: url.port, path: '/api/passport/login', method: 'POST', headers: { host: 'localhost:1', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(data);
  });
  assert.equal(status, 401);
});

test('the nonce is consumed first: unknown id and known id with a bad signature behave the same and neither nonce is reusable', async () => {
  const idn = newIdentity();
  await register(idn, 'pr_oracle');
  const unknown = newIdentity();
  const results = [];
  for (const target of [unknown, idn]) {
    const p = await proof(newIdentity(), 'login');
    results.push(await call('POST', '/api/passport/login', { passportId: target.id, ...p }));
    const replay = await call('POST', '/api/passport/register', {
      username: `pr_or_${results.length}`, email: `pr_or${results.length}@t.co`, authKey: AUTH_KEY, authSalt: AUTH_SALT, backup: splitBackup,
      passportPublicKey: unknown.publicKeyB64, e2eePublicKey: Buffer.alloc(32, 1).toString('base64'),
      nonce: p.nonce, issuedAt: p.issuedAt, signature: crypto.sign(null, Buffer.from(buildChallengeMessage({ purpose: 'register', origin: base, nonce: p.nonce, issuedAt: p.issuedAt })), unknown.privateKey).toString('base64'),
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error, 'invalid passport proof');
  }
  assert.deepEqual(results.map((r) => [r.status, r.body.error]), [[401, 'invalid passport proof'], [401, 'invalid passport proof']]);
});

test('recover: malformed bodies do not burn the challenge; wrong 2FA codes count toward the lockout and success clears it', async () => {
  const idn = newIdentity();
  await register(idn, 'pr_rec3');
  const p = await proof(idn, 'recover');
  assert.equal((await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: 'short', newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, ...p })).status, 400);
  assert.equal((await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: {}, ...p })).status, 400);
  db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ?, totp_recovery_codes = ? WHERE username = ?').run('JBSWY3DPEHPK3PXP', JSON.stringify(['rec3-code']), 'pr_rec3');
  const same = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, code: '000000', ...p });
  assert.equal(same.status, 401);
  assert.equal(same.body.requiresTotp, true); // the same nonce was still fresh after the 400s
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, code: '000000', ...(await proof(idn, 'recover')) });
    assert.equal(r.status, 401);
  }
  const locked = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, code: 'rec3-code', ...(await proof(idn, 'recover')) });
  assert.equal(locked.status, 429);

  const idn2 = newIdentity();
  await register(idn2, 'pr_rec4');
  db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ?, totp_recovery_codes = ? WHERE username = ?').run('JBSWY3DPEHPK3PXP', JSON.stringify(['rec4-code']), 'pr_rec4');
  for (let i = 0; i < 3; i++) await call('POST', '/api/passport/recover', { passportId: idn2.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, code: '000000', ...(await proof(idn2, 'recover')) });
  assert.equal((await call('POST', '/api/passport/recover', { passportId: idn2.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, code: 'rec4-code', ...(await proof(idn2, 'recover')) })).status, 200);
  for (let i = 0; i < 4; i++) await call('POST', '/api/passport/login', { passportId: idn2.id, ...(await proof(newIdentity(), 'login')) });
  assert.equal((await call('POST', '/api/passport/login', { passportId: idn2.id, ...(await proof(newIdentity(), 'login')) })).status, 401); // 5th failure only, counter had been cleared
});

test('every outcome class writes a passport_audit row with the right ok flag', async () => {
  const last = () => db.prepare('SELECT action, ok FROM passport_audit ORDER BY id DESC LIMIT 1').get();
  const expectAudit = (action, ok) => assert.deepEqual({ ...last() }, { action, ok });

  const idn = newIdentity();
  await register(idn, 'pr_aud');
  expectAudit('register', 1);
  await register(idn, 'pr_aud_dup');
  expectAudit('register', 0);

  await call('POST', '/api/passport/login', { passportId: idn.id, ...(await proof(idn, 'login')) });
  expectAudit('login', 1);
  await call('POST', '/api/passport/login', { passportId: idn.id, ...(await proof(newIdentity(), 'login')) });
  expectAudit('login', 0);

  db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE username = ?').run('JBSWY3DPEHPK3PXP', 'pr_aud');
  await call('POST', '/api/passport/login', { passportId: idn.id, ...(await proof(idn, 'login')) });
  expectAudit('login_totp_pending', 1);
  db.prepare('UPDATE users SET totp_enabled = 0, is_disabled = 1 WHERE username = ?').run('pr_aud');
  await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, ...(await proof(idn, 'recover')) });
  expectAudit('recover', 0);
  assert.equal((await call('POST', '/api/passport/login', { passportId: idn.id, ...(await proof(idn, 'login')) })).status, 403);
  expectAudit('login', 0);

  db.prepare('UPDATE users SET is_disabled = 0 WHERE username = ?').run('pr_aud');
  const rec = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, ...(await proof(idn, 'recover')) });
  assert.equal(rec.status, 200);
  expectAudit('recover', 1);

  const locked = newIdentity();
  await register(locked, 'pr_aud_lock');
  for (let i = 0; i < 5; i++) await call('POST', '/api/passport/login', { passportId: locked.id, ...(await proof(newIdentity(), 'login')) });
  assert.equal((await call('POST', '/api/passport/login', { passportId: locked.id, ...(await proof(locked, 'login')) })).status, 429);
  expectAudit('login_locked', 0);

  const reg = await call('POST', '/api/auth/register', { username: 'pr_aud_att', email: 'pr_aud_att@t.co', password: 'password123' });
  const a = newIdentity();
  const attachBody = { passportPublicKey: a.publicKeyB64, e2eePublicKey: Buffer.alloc(32, 2).toString('base64'), backup, currentPassword: 'password123' };
  await call('POST', '/api/passport/attach', { ...attachBody, currentPassword: 'nope-nope-1', ...(await proof(a, 'attach')) }, reg.cookie);
  expectAudit('attach', 0);
  await call('POST', '/api/passport/attach', { ...attachBody, ...(await proof(a, 'attach')) }, reg.cookie);
  expectAudit('attach', 1);
  await call('POST', '/api/passport/attach', { ...attachBody, ...(await proof(a, 'attach')) }, reg.cookie);
  expectAudit('attach', 0); // already has a passport
});

test('PUT /api/users/me/e2ee-backup validates and bounds the body', async () => {
  const reg = await register(newIdentity(), 'pr_bk');
  const put = (b) => call('PUT', '/api/users/me/e2ee-backup', b, reg.cookie);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ encryptedKey: '', salt: 's', nonce: 'n' })).status, 400);
  assert.equal((await put({ encryptedKey: 'x'.repeat(4097), salt: 's', nonce: 'n' })).status, 400);
  assert.equal((await put({ encryptedKey: 'e', salt: 's', nonce: 'n' })).status, 400); // split account refuses a legacy backup
  assert.equal((await put({ encryptedKey: 'e', salt: 'split:v1', nonce: 'n' })).status, 200);
  db.prepare("UPDATE users SET auth_mode = 'password' WHERE username = 'pr_bk'").run();
  assert.equal((await put({ encryptedKey: 'e', salt: 'split:v1', nonce: 'n' })).status, 400); // legacy account refuses the split tag
  assert.equal((await put({ encryptedKey: 'e', salt: 's', nonce: 'n' })).status, 200);
});

test('passportOrigin.bootLines lists accepted origins and warns on a default publicHost with a custom cert or trustProxy', () => {
  const o = require('../lib/passportOrigin');
  try {
    o.configure({ publicHost: 'chat.example.com', port: 8080, httpsPort: 443 });
    const ok = o.bootLines({ publicHost: 'chat.example.com', port: 8080, httpsPort: 443 });
    assert.equal(ok.length, 1);
    assert.ok(ok[0].includes('http://chat.example.com:8080, https://chat.example.com'));
    o.configure({ serverCrt: 'x.crt' });
    assert.match(o.bootLines({ serverCrt: 'x.crt' })[1], /WARNING.*publicHost/);
    o.configure({ trustProxy: 1 });
    assert.equal(o.bootLines({ trustProxy: 1 }).length, 2);
    o.configure({});
    assert.equal(o.bootLines({}).length, 1);
  } finally {
    o.configure({});
  }
});

test('split register: a password field, a missing key or a legacy-wrapped backup is refused; the account is split', async () => {
  const idn = newIdentity();
  const fields = { username: 'pr_sp', email: 'pr_sp@t.co', passportPublicKey: idn.publicKeyB64, e2eePublicKey: Buffer.alloc(32, 1).toString('base64') };
  const reg = async (extra) => call('POST', '/api/passport/register', { ...fields, ...extra, ...(await proof(idn, 'register')) });
  assert.equal((await reg({ password: 'password123', backup: splitBackup })).status, 400);
  assert.equal((await reg({ password: 'password123', authKey: AUTH_KEY, authSalt: AUTH_SALT, backup: splitBackup })).status, 400);
  assert.equal((await reg({ authKey: AUTH_KEY, authSalt: AUTH_SALT, backup })).status, 400);
  const ok = await reg({ authKey: AUTH_KEY, authSalt: AUTH_SALT, backup: splitBackup });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.authMode, 'split');
  assert.equal((await call('POST', '/api/auth/login', { username: 'pr_sp', password: 'password123' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'pr_sp', authKey: AUTH_KEY })).status, 200);
});

test('recover turns a legacy account split: plaintext sign-in stops and only a split:v1 backup is accepted', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'pr_rl', email: 'pr_rl@t.co', password: 'password123' });
  const idn = newIdentity();
  const attached = await call('POST', '/api/passport/attach', {
    passportPublicKey: idn.publicKeyB64, e2eePublicKey: Buffer.alloc(32, 2).toString('base64'), backup, currentPassword: 'password123',
    ...(await proof(idn, 'attach')),
  }, reg.cookie);
  assert.equal(attached.status, 200);
  const legacyTagged = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup, ...(await proof(idn, 'recover')) });
  assert.equal(legacyTagged.status, 400);
  const r = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, ...(await proof(idn, 'recover')) });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.authMode, 'split');
  assert.equal((await call('POST', '/api/auth/login', { username: 'pr_rl', password: 'password123' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'pr_rl', authKey: NEW_AUTH_KEY })).status, 200);
});

test('attach for a split account needs currentAuthKey and a split:v1 backup; a wrong credential still burns the nonce', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'pr_sa', email: 'pr_sa@t.co', authKey: AUTH_KEY, authSalt: AUTH_SALT });
  assert.equal(reg.status, 201);
  const idn = newIdentity();
  const fields = { passportPublicKey: idn.publicKeyB64, e2eePublicKey: Buffer.alloc(32, 2).toString('base64'), backup: splitBackup };
  const attach = (body) => call('POST', '/api/passport/attach', body, reg.cookie);
  assert.equal((await attach({ ...fields, backup, currentAuthKey: AUTH_KEY, ...(await proof(idn, 'attach')) })).status, 400);
  assert.equal((await attach({ ...fields, currentPassword: 'password123', ...(await proof(idn, 'attach')) })).status, 401);
  const p = await proof(idn, 'attach');
  assert.equal((await attach({ ...fields, currentAuthKey: NEW_AUTH_KEY, ...p })).status, 401);
  assert.equal((await attach({ ...fields, currentAuthKey: AUTH_KEY, ...p })).status, 401); // same nonce, already consumed
  const ok = await attach({ ...fields, currentAuthKey: AUTH_KEY, ...(await proof(idn, 'attach')) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.passportId, idn.id);
});

test('recover kills a pending 2FA login minted before it', async () => {
  const pendingLogin = require('../lib/pendingLogin');
  const idn = newIdentity();
  const reg = await register(idn, 'pr_pend');
  assert.equal(reg.status, 201);
  const uid = db.prepare("SELECT id FROM users WHERE username = 'pr_pend'").get().id;
  const t = pendingLogin.create(uid);
  const r = await call('POST', '/api/passport/recover', { passportId: idn.id, newAuthKey: NEW_AUTH_KEY, newAuthSalt: NEW_AUTH_SALT, backup: splitBackup, ...(await proof(idn, 'recover')) });
  assert.equal(r.status, 200);
  assert.equal(pendingLogin.peek(t), null);
});
