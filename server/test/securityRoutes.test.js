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
const { OWNER_SITE_PERMISSIONS, SITE_PERMISSIONS } = require('../lib/permissions');
const settings = require('../lib/security/settings');
const captcha = require('../lib/security/captcha');
const guard = require('../lib/security/guard');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);

let server; let base; let admin; let staff;
test.before(async () => {
  admin = mkUser('sec_admin');
  staff = mkUser('sec_staff');
  guard.start();
  const app = express();
  app.set('trust proxy', true);
  app.use(guard.ipGuard);
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) {
      req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      req.sitePermissions = uid === admin ? OWNER_SITE_PERMISSIONS : SITE_PERMISSIONS.VIEW_ADMIN_PANEL;
    }
    next();
  });
  app.use('/api/auth/captcha', require('../routes/captcha'));
  app.post('/api/auth/login', guard.gate('login'));
  app.post('/api/auth/register', guard.gate('register'));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/admin', require('../routes/admin'));
  app.use(require('../middleware/errorHandler').errorHandler);
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await new Promise((r) => setTimeout(r, 100)); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
test.beforeEach(() => {
  guard._test.reset();
  db.exec('DELETE FROM ip_bans; DELETE FROM security_events');
  db.prepare("DELETE FROM meta WHERE key = 'security_settings'").run();
  settings.reset();
  guard.rebuild();
});

let ipCounter = 10;
const freshIp = () => `203.0.113.${ipCounter++}`;

const call = async (method, url, { uid, ip, json } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(uid ? { 'x-uid': String(uid) } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}), ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, text };
};

const solve = async (ip) => {
  const c = (await call('POST', '/api/auth/captcha', { ip })).data;
  const answer = captcha._challenges.get(c.id).answer;
  return { captchaId: c.id, captchaAnswer: answer };
};

test('security admin routes are for site administrators only', async () => {
  for (const [m, u] of [['GET', '/overview'], ['GET', '/settings'], ['PATCH', '/settings'], ['GET', '/bans'], ['POST', '/bans'], ['GET', '/events'], ['GET', '/lookup?ip=1.2.3.4'], ['GET', '/blocklists']]) {
    assert.equal((await call(m, `/api/admin/security${u}`, { uid: staff, json: m === 'GET' ? undefined : {} })).status, 403, u);
  }
  const overview = await call('GET', '/api/admin/security/overview', { uid: admin, ip: '198.51.100.1' });
  assert.equal(overview.status, 200);
  assert.equal(overview.data.yourIp, '198.51.100.1');
});

test('settings can be changed and bad values are refused', async () => {
  const bad = await call('PATCH', '/api/admin/security/settings', { uid: admin, json: { captcha: { mode: 'banana' } } });
  assert.equal(bad.status, 400);
  const ok = await call('PATCH', '/api/admin/security/settings', { uid: admin, json: { captcha: { mode: 'always', type: 'math' } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.captcha.mode, 'always');
  assert.equal((await call('GET', '/api/admin/security/settings', { uid: admin })).data.captcha.type, 'math');
});

test('captcha preview renders unsaved settings and reveals the answer to admins only', async () => {
  const res = await call('POST', '/api/admin/security/captcha/preview', { uid: admin, json: { captcha: { type: 'words', difficulty: 'hard' } } });
  assert.equal(res.status, 200);
  assert.match(res.data.image, /^data:image\/png;base64,/);
  assert.match(res.data.answer, /^[a-z]+$/);
  assert.equal(settings.load().captcha.type, 'text', 'preview does not save');
});

test('words/check cleans an editor draft', async () => {
  const res = await call('POST', '/api/admin/security/words/check', { uid: admin, json: { text: 'Alma\nkörte\nx\nalma' } });
  assert.deepEqual(res.data.words, ['alma', 'korte']);
  assert.equal(res.data.rejected, 2);
});

test('manual bans: create, list, refuse self-ban, block traffic, remove', async () => {
  const target = freshIp();
  const created = await call('POST', '/api/admin/security/bans', { uid: admin, json: { entry: target, reason: 'bot' } });
  assert.equal(created.status, 201);
  assert.equal((await call('GET', '/api/auth/captcha/status?kind=login', { ip: target })).status, 403);
  assert.equal((await call('GET', '/api/auth/captcha/status?kind=login', { ip: freshIp() })).status, 200);

  const me = freshIp();
  const self = await call('POST', '/api/admin/security/bans', { uid: admin, ip: me, json: { entry: `${me.split('.').slice(0, 3).join('.')}.0/24` } });
  assert.equal(self.status, 400);
  assert.match(self.data.error, /your own address/);

  assert.equal((await call('POST', '/api/admin/security/bans', { uid: admin, json: { entry: 'nope' } })).status, 400);
  const list = await call('GET', '/api/admin/security/bans?q=bot', { uid: admin });
  assert.equal(list.data.bans.length, 1);
  assert.equal((await call('DELETE', `/api/admin/security/bans/${list.data.bans[0].id}`, { uid: admin })).status, 200);
  assert.equal((await call('GET', '/api/auth/captcha/status?kind=login', { ip: target })).status, 200);
  assert.equal((await call('DELETE', '/api/admin/security/bans/9999', { uid: admin })).status, 404);
});

test('bulk import adds valid lines and reports the rest', async () => {
  const res = await call('POST', '/api/admin/security/bans/import', { uid: admin, json: { text: '192.0.2.1\n192.0.2.0/28 # net\ngarbage\n' } });
  assert.equal(res.data.added, 2);
  assert.deepEqual(res.data.invalid, ['garbage']);
});

test('lookup answers for an address and rejects garbage', async () => {
  const bad = await call('GET', '/api/admin/security/lookup?ip=zzz', { uid: admin });
  assert.equal(bad.status, 400);
  guard.addBan('192.0.2.77', { reason: 'x' });
  const res = await call('GET', '/api/admin/security/lookup?ip=192.0.2.77', { uid: admin });
  assert.equal(res.data.blocked, true);
  assert.equal(res.data.bans.length, 1);
});

test('blocklist URLs are validated on add', async () => {
  const res = await call('POST', '/api/admin/security/blocklists', { uid: admin, json: { url: 'http://insecure.example/list.txt' } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /https/);
});

test('login: captcha appears after the configured failures and then must be solved', async () => {
  const ip = freshIp();
  settings.update({ captcha: { mode: 'after_failures', failureThreshold: 2 } });
  const status = async () => (await call('GET', '/api/auth/captcha/status?kind=login', { ip })).data.required;
  const login = (extra = {}) => call('POST', '/api/auth/login', { ip, json: { username: 'nobody', password: 'wrongpassword', ...extra } });

  assert.equal(await status(), false);
  assert.equal((await login()).status, 401);
  assert.equal(await status(), false);
  assert.equal((await login()).status, 401);
  assert.equal(await status(), true);

  const missing = await login();
  assert.equal(missing.status, 403);
  assert.equal(missing.data.code, 'captcha_required');

  const wrong = await login({ captchaId: (await call('POST', '/api/auth/captcha', { ip })).data.id, captchaAnswer: 'nope' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.code, 'captcha_invalid');

  const solved = await login(await solve(ip));
  assert.equal(solved.status, 401, 'with a correct captcha the request reaches the real credential check');
  assert.match(solved.data.error, /^invalid credentials/);

  const reused = await login({ captchaId: 'replayed', captchaAnswer: 'x' });
  assert.equal(reused.data.code, 'captcha_invalid');
});

test('a successful login clears the failure count', async () => {
  const ip = freshIp();
  settings.update({ captcha: { mode: 'after_failures', failureThreshold: 3 } });
  await call('POST', '/api/auth/register', { ip: freshIp(), json: { username: 'sec_real', email: 'sec_real@t.local', password: 'a-long-enough-password' } });
  const wrong = () => call('POST', '/api/auth/login', { ip, json: { username: 'sec_real', password: 'wrongwrongwrong' } });
  await wrong(); await wrong();
  assert.equal((await call('POST', '/api/auth/login', { ip, json: { username: 'sec_real', password: 'a-long-enough-password' } })).status, 200);
  assert.equal(guard.failureCount(ip, 15), 0);
  await wrong();
  assert.equal(guard.captchaRequired(ip, 'login'), false);
});

test('always mode needs a captcha for sign-up and sign-in; off mode never asks', async () => {
  const ip = freshIp();
  settings.update({ captcha: { mode: 'always' } });
  const reg = { username: 'sec_new1', email: 'sec_new1@t.local', password: 'a-long-enough-password' };
  assert.equal((await call('POST', '/api/auth/register', { ip, json: reg })).data.code, 'captcha_required');
  assert.equal((await call('POST', '/api/auth/register', { ip, json: { ...reg, ...(await solve(ip)) } })).status, 201);
  settings.update({ captcha: { mode: 'off' } });
  assert.equal((await call('POST', '/api/auth/register', { ip: freshIp(), json: { ...reg, username: 'sec_new2', email: 'sec_new2@t.local' } })).status, 201);
});

test('honeypot field and instant form submits are rejected without touching the account system', async () => {
  settings.update({ captcha: { mode: 'off' } });
  const ip = freshIp();
  const reg = { username: 'sec_bot', email: 'sec_bot@t.local', password: 'a-long-enough-password' };
  assert.equal((await call('POST', '/api/auth/register', { ip, json: { ...reg, website: 'http://spam' } })).data.code, 'rejected');
  assert.equal((await call('POST', '/api/auth/register', { ip, json: { ...reg, formMs: 120 } })).data.code, 'rejected');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'sec_bot'").get().n, 0);
  assert.equal((await call('POST', '/api/auth/register', { ip, json: { ...reg, formMs: 4000 } })).status, 201);
  settings.update({ protection: { honeypot: false } });
  assert.equal((await call('POST', '/api/auth/register', { ip: freshIp(), json: { ...reg, username: 'sec_bot2', email: 'sec_bot2@t.local', website: 'x' } })).status, 201);
});

test('sign-ups per address are capped', async () => {
  settings.update({ captcha: { mode: 'off' }, protection: { registrationLimit: { enabled: true, max: 2, windowHours: 24 } } });
  const ip = freshIp();
  for (const n of [1, 2]) {
    assert.equal((await call('POST', '/api/auth/register', { ip, json: { username: `sec_cap${n}`, email: `sec_cap${n}@t.local`, password: 'a-long-enough-password' } })).status, 201);
  }
  const third = await call('POST', '/api/auth/register', { ip, json: { username: 'sec_cap3', email: 'sec_cap3@t.local', password: 'a-long-enough-password' } });
  assert.equal(third.status, 429);
  assert.equal(third.data.code, 'registration_limited');
});

test('a flooding client is banned and then refused everywhere', async () => {
  settings.update({ protection: { requestsPerWindow: 20, windowSeconds: 30 } });
  const ip = freshIp();
  let blocked = 0;
  for (let i = 0; i < 40; i++) {
    const res = await call('GET', '/api/auth/captcha/status?kind=login', { ip });
    if (res.status === 403) blocked += 1;
  }
  assert.ok(blocked > 0 && blocked < 40, `blocked ${blocked}`);
  assert.equal((await call('GET', '/api/auth/captcha/status?kind=login', { ip })).text, 'Access denied');
  assert.equal((await call('GET', '/api/auth/captcha/status?kind=login', { ip: freshIp() })).status, 200, 'other clients are unaffected');
  const events = await call('GET', '/api/admin/security/events?type=ban_auto', { uid: admin });
  assert.equal(events.data.events.length, 1);
  assert.equal(events.data.events[0].ip, ip);
});

test('under-attack mode can be switched on and off by an admin and forces captcha', async () => {
  settings.update({ captcha: { mode: 'off' } });
  const ip = freshIp();
  assert.equal((await call('GET', '/api/auth/captcha/status?kind=login', { ip })).data.required, false);
  const on = await call('POST', '/api/admin/security/under-attack', { uid: admin, json: { enabled: true, minutes: 30 } });
  assert.equal(on.data.active, true);
  assert.equal((await call('GET', '/api/auth/captcha/status?kind=login', { ip })).data.required, true);
  assert.equal((await call('POST', '/api/admin/security/under-attack', { uid: admin, json: { enabled: true, minutes: 0 } })).status, 400);
  await call('POST', '/api/admin/security/under-attack', { uid: admin, json: { enabled: false } });
  assert.equal((await call('GET', '/api/auth/captcha/status?kind=login', { ip })).data.required, false);
});

test('captcha issuing does not leak the answer', async () => {
  const res = await call('POST', '/api/auth/captcha', { ip: freshIp() });
  assert.deepEqual(Object.keys(res.data).sort(), ['expiresInSeconds', 'id', 'image']);
});
