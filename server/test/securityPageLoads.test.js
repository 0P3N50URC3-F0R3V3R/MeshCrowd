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
const settings = require('../lib/security/settings');
const guard = require('../lib/security/guard');
const { isPrivateIp } = require('../lib/security/ipMatch');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n).lastInsertRowid);

let server; let base; let member;
test.before(async () => {
  member = mkUser('pl_member');
  guard.start();
  const app = express();
  app.set('trust proxy', true);
  app.use(guard.ipGuard);
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    next();
  });
  app.use(guard.floodGuard);
  app.post('/api/auth/login', guard.gate('login', { requireCaptcha: false }), (req, res) => res.status(401).json({ error: 'bad credentials' }));
  app.get('/api/config', (req, res) => res.json({ ok: true }));
  app.get('/api/auth/me', (req, res) => res.status(401).json({ error: 'not signed in' }));
  app.use((req, res) => res.status(req.path === '/' || /\.(js|css|png|json|svg)$/.test(req.path) ? 200 : 404).send('x'));
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

const get = (url, ip, uid) => fetch(base + url, {
  method: url.startsWith('/api/auth/login') ? 'POST' : 'GET',
  headers: { 'x-forwarded-for': ip, ...(uid ? { 'x-uid': String(uid) } : {}), 'content-type': 'application/json' },
  body: url.startsWith('/api/auth/login') ? JSON.stringify({ username: 'x', password: 'y' }) : undefined,
}).then(async (r) => { await r.text(); return r.status; });

async function pageLoad(ip, uid) {
  const statuses = [await get('/', ip, uid)];
  const assets = [];
  for (let i = 0; i < 150; i++) assets.push(get(`/js/mod${i}.js`, ip, uid));
  for (let i = 0; i < 20; i++) assets.push(get(`/uploads/emoji/e${i}.png`, ip, uid), get(`/lang/en${i}.json`, ip, uid));
  assets.push(get('/vendor/dompurify/purify.min.js', ip, uid), get('/favicon.ico', ip, uid), get('/css/app.css', ip, uid));
  statuses.push(...await Promise.all(assets));
  statuses.push(await get('/api/config', ip, uid), await get('/api/auth/me', ip, uid));
  statuses.push(guard.isUpgradeBlocked({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip } }, true) ? 403 : 101);
  return statuses;
}

test('10 fast page loads from one address are not banned with default settings', async () => {
  const ip = '203.0.113.101';
  for (let i = 0; i < 10; i++) {
    const statuses = await pageLoad(ip);
    assert.ok(!statuses.includes(403), `load ${i + 1} saw a 403`);
  }
  assert.ok(!guard.check(ip).blocked);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ip_bans").get().n, 0);
});

test('signed-in users and private addresses are never flood-banned, even at extreme volume', async () => {
  settings.update({ protection: { requestsPerWindow: 20, windowSeconds: 30 } });
  for (let i = 0; i < 60; i++) assert.equal(await get('/api/config', '203.0.113.102', member), 200);
  assert.ok(!guard.check('203.0.113.102').blocked);
  for (let i = 0; i < 60; i++) guard.noteRequest('192.168.1.20');
  assert.ok(!guard.check('192.168.1.20').blocked);
  assert.ok(isPrivateIp('10.1.2.3') && isPrivateIp('172.20.0.1') && isPrivateIp('fd00::1') && isPrivateIp('::1'));
  assert.ok(!isPrivateIp('172.32.0.1') && !isPrivateIp('203.0.113.5'));
});

test('real abuse is still banned: failed-login bursts, scanner paths, dynamic floods', async () => {
  const login = '203.0.113.103';
  for (let i = 0; i < 40; i++) await get('/api/auth/login', login);
  assert.ok(guard.check(login).blocked, 'failed logins');

  const scan = '203.0.113.104';
  for (const p of ['/wp-login.php', '/.env', '/phpmyadmin/index.php', '/xmlrpc.php', '/.git/config', '/cgi-bin/x.cgi', '/wp-admin/setup.php', '/admin.php', '/shell.php', '/backup.sql', '/config.bak']) await get(p, scan);
  assert.ok(guard.check(scan).blocked, 'scanner paths');

  const flood = '203.0.113.105';
  settings.update({ protection: { requestsPerWindow: 100, windowSeconds: 10 } });
  for (let i = 0; i < 130; i++) await get('/api/config', flood);
  assert.ok(guard.check(flood).blocked, 'dynamic flood');
});

test('auto-ban length starts short and doubles on repeat offences', () => {
  const ip = '203.0.113.106';
  const ms = () => {
    const row = db.prepare('SELECT created_at, expires_at FROM ip_bans WHERE entry = ?').get(ip);
    return Math.round((Date.parse(row.expires_at) - Date.parse(row.created_at)) / 60_000);
  };
  const trip = () => { for (let i = 0; i < 30; i++) guard.noteFailure(ip); };
  trip();
  assert.equal(ms(), 15);
  guard.removeBan(db.prepare('SELECT id FROM ip_bans WHERE entry = ?').get(ip).id);
  trip();
  assert.equal(ms(), 30);
});

test('old default values saved by the Security Center follow the new defaults', () => {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('security_settings', ?)").run(JSON.stringify({
    protection: { requestsPerWindow: 900, banMinutes: 15, rateLimitStrikes: 20, failedLoginBan: { threshold: 30, windowMinutes: 10, banMinutes: 60 } },
  }));
  settings.reset();
  const p = settings.load().protection;
  assert.deepEqual([p.requestsPerWindow, p.banMinutes, p.rateLimitStrikes, p.failedLoginBan.banMinutes], [1500, 5, 50, 15]);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('security_settings', ?)").run(JSON.stringify({ protection: { requestsPerWindow: 2000 } }));
  settings.reset();
  assert.equal(settings.load().protection.requestsPerWindow, 2000, 'custom values are kept');
});
