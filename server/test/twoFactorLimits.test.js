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
const totp = require('../lib/totp');

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

async function userWith2fa(name) {
  const reg = await call('POST', '/api/auth/register', { username: name, email: `${name}@t.co`, password: 'password123' });
  const setup = await call('POST', '/api/auth/2fa/setup', {}, reg.cookie);
  const secret = setup.body.secret;
  const enable = await call('POST', '/api/auth/2fa/enable', { code: totp.totpAt(secret, Date.now()), currentPassword: 'password123' }, reg.cookie);
  return { secret, cookie: reg.cookie, recovery: enable.body.recoveryCodes };
}

const wrong = (secret) => {
  const good = new Set([-1, 0, 1].map((w) => totp.totpAt(secret, Date.now() + w * 30_000)));
  for (let i = 0; i < 1000; i++) { const c = String(100000 + i); if (!good.has(c)) return c; }
};

test('a TOTP code cannot be replayed within its window', async () => {
  const { secret } = await userWith2fa('tf_replay');
  const step = Math.floor(Date.now() / 30_000);
  const code = totp.totpAt(secret, (step + 1) * 30_000);
  const first = await call('POST', '/api/auth/login', { username: 'tf_replay', password: 'password123' });
  const ok = await call('POST', '/api/auth/login/2fa', { pendingToken: first.body.pendingToken, code });
  assert.equal(ok.status, 200);
  const second = await call('POST', '/api/auth/login', { username: 'tf_replay', password: 'password123' });
  const replay = await call('POST', '/api/auth/login/2fa', { pendingToken: second.body.pendingToken, code });
  assert.equal(replay.status, 401);
});

test('repeated wrong 2FA codes lock the account even across fresh pending tokens', async () => {
  const { secret } = await userWith2fa('tf_lock');
  for (let i = 0; i < 5; i++) {
    const p = await call('POST', '/api/auth/login', { username: 'tf_lock', password: 'password123' });
    const r = await call('POST', '/api/auth/login/2fa', { pendingToken: p.body.pendingToken, code: wrong(secret) });
    assert.equal(r.status, 401);
  }
  const p = await call('POST', '/api/auth/login', { username: 'tf_lock', password: 'password123' });
  const good = await call('POST', '/api/auth/login/2fa', { pendingToken: p.body.pendingToken, code: totp.totpAt(secret, Date.now() + 30_000) });
  assert.equal(good.status, 429);
});

test('2fa/disable is locked after repeated wrong codes', async () => {
  const { secret, cookie } = await userWith2fa('tf_dis');
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/2fa/disable', { code: wrong(secret) }, cookie)).status, 400);
  assert.equal((await call('POST', '/api/auth/2fa/disable', { code: totp.totpAt(secret, Date.now() + 30_000) }, cookie)).status, 429);
});

test('2FA cannot be enabled from a session without the password', async () => {
  const reg = await call('POST', '/api/auth/register', { username: 'tf_stolen', email: 'tf_stolen@t.co', password: 'password123' });
  const setup = await call('POST', '/api/auth/2fa/setup', {}, reg.cookie);
  const code = totp.totpAt(setup.body.secret, Date.now());
  assert.equal((await call('POST', '/api/auth/2fa/enable', { code }, reg.cookie)).status, 401);
  assert.equal((await call('POST', '/api/auth/2fa/enable', { code, currentPassword: 'wrong-password' }, reg.cookie)).status, 401);
  assert.equal(db.prepare("SELECT totp_enabled FROM users WHERE username = 'tf_stolen'").get().totp_enabled, 0);
  assert.equal((await call('POST', '/api/auth/2fa/enable', { code, currentPassword: 'password123' }, reg.cookie)).status, 200);
});

test('a recovery code still logs in while the TOTP guess limit is hit', async () => {
  const { secret, recovery } = await userWith2fa('tf_recover');
  for (let i = 0; i < 5; i++) {
    const p = await call('POST', '/api/auth/login', { username: 'tf_recover', password: 'password123' });
    await call('POST', '/api/auth/login/2fa', { pendingToken: p.body.pendingToken, code: wrong(secret) });
  }
  const p = await call('POST', '/api/auth/login', { username: 'tf_recover', password: 'password123' });
  assert.equal((await call('POST', '/api/auth/login/2fa', { pendingToken: p.body.pendingToken, code: totp.totpAt(secret, Date.now() + 30_000) })).status, 429);
  const ok = await call('POST', '/api/auth/login/2fa', { pendingToken: p.body.pendingToken, code: recovery[0] });
  assert.equal(ok.status, 200);
});
