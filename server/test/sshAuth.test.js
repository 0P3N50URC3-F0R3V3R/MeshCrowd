'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const accounts = require('../lib/accounts');
const totp = require('../lib/totp');
const logger = require('../lib/logger');
const sshAuth = require('../console/sshAuth');
const { SITE_PERMISSIONS } = require('../lib/permissions');

const logged = [];
logger.subscribe((e) => logged.push(e));

const PW = 'correct horse battery';
const mkRole = (name, perms) => Number(db.prepare('INSERT INTO site_roles (name, color, permissions, position) VALUES (?, ?, ?, ?)')
  .run(name, '#000000', perms, 1).lastInsertRowid);
const assign = (uid, rid) => db.prepare('INSERT INTO user_site_roles (user_id, role_id) VALUES (?, ?)').run(uid, rid);
const mk = async (username, extra = {}) => (await accounts.createAccount({ username, email: `${username}@t.local`, password: PW, ...extra })).userId;

let now = 1_000_000;
let ownerId;
test.before(async () => {
  sshAuth._test.setClock(() => now);
});
test.beforeEach(() => {
  sshAuth._test.reset();
  sshAuth._test.setLimiter({ capacity: 1000, refillPerSec: 1000 });
  now += 3_600_000;
});
test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const login = (o) => sshAuth.authenticate({ ip: '10.0.0.2', password: PW, ...o });

test('empty database is denied', async () => {
  const r = await sshAuth.authenticate({ username: 'x', password: PW, ip: '10.0.0.3' });
  assert.deepEqual(r, { ok: false });
  ownerId = await mk('owner1');
});

test('owner with the legacy password is accepted', async () => {
  const r = await login({ username: 'owner1' });
  assert.equal(r.ok, true);
  assert.equal(r.user.id, ownerId);
  assert.equal(r.user.username, 'owner1');
});

test('wrong password and unknown user are denied the same way', async () => {
  assert.deepEqual(await login({ username: 'owner1', password: 'nope-nope-nope' }), { ok: false });
  assert.deepEqual(await login({ username: 'ghost' }), { ok: false });
  assert.deepEqual(await login({ username: 'owner1', password: 12345 }), { ok: false });
  assert.deepEqual(await login({ username: 'o'.repeat(500) }), { ok: false });
});

test('disabled account, account without the flag, Admin with only SITE_ADMINISTRATOR are denied', async () => {
  const dis = await mk('dis1');
  assign(dis, mkRole('R_dis', SITE_PERMISSIONS.MANAGE_CONSOLE));
  assert.equal((await login({ username: 'dis1' })).ok, true);
  db.prepare('UPDATE users SET is_disabled = 1 WHERE id = ?').run(dis);
  assert.deepEqual(await login({ username: 'dis1' }), { ok: false });

  await mk('plain1');
  assert.deepEqual(await login({ username: 'plain1' }), { ok: false });

  const adm = await mk('admin1');
  assign(adm, mkRole('R_adm', SITE_PERMISSIONS.SITE_ADMINISTRATOR));
  assert.deepEqual(await login({ username: 'admin1' }), { ok: false });
});

test('split account: the authKey is derived from the password like the browser does', async () => {
  const { deriveAuthKeys } = await import('../../web/js/e2ee/crypto.mjs');
  const authSalt = crypto.randomBytes(16).toString('base64');
  const { authKey } = await deriveAuthKeys(PW, authSalt);
  const uid = await mk('split1', { password: undefined, authKey, authSalt });
  assign(uid, mkRole('R_split', SITE_PERMISSIONS.MANAGE_CONSOLE));
  assert.equal(db.prepare('SELECT auth_mode FROM users WHERE id = ?').get(uid).auth_mode, 'split');
  assert.equal((await login({ username: 'split1' })).ok, true);
  assert.deepEqual(await login({ username: 'split1', password: 'wrong-wrong-wrong' }), { ok: false });
  assert.deepEqual(await login({ username: 'split1', password: authKey }), { ok: false });
});

function totpNow(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

test('totp account needs a valid code', async () => {
  const uid = await mk('totp1');
  assign(uid, mkRole('R_totp', SITE_PERMISSIONS.MANAGE_CONSOLE));
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?').run(secret, uid);
  const noCode = await login({ username: 'totp1' });
  assert.equal(noCode.ok, false);
  assert.equal(noCode.needTotp, true);
  assert.deepEqual(await login({ username: 'totp1', totp: '000000' }), { ok: false });
  assert.equal((await login({ username: 'totp1', totp: totpNow(secret) })).ok, true);
  assert.deepEqual(await login({ username: 'totp1', password: 'wrong-wrong-wrong', totp: totpNow(secret) }), { ok: false });
});

test('five failures from one ip lock it out for ten minutes, other ips are unaffected', async () => {
  const bad = { username: 'owner1', password: 'wrong-wrong-wrong', ip: '10.9.9.9' };
  for (let i = 0; i < 5; i++) assert.deepEqual(await sshAuth.authenticate(bad), { ok: false });
  assert.deepEqual(await sshAuth.authenticate({ username: 'owner1', password: PW, ip: '10.9.9.9' }), { ok: false });
  assert.equal((await sshAuth.authenticate({ username: 'owner1', password: PW, ip: '10.9.9.8' })).ok, true);
  now += 9 * 60_000;
  assert.deepEqual(await sshAuth.authenticate({ username: 'owner1', password: PW, ip: '10.9.9.9' }), { ok: false });
  now += 2 * 60_000;
  assert.equal((await sshAuth.authenticate({ username: 'owner1', password: PW, ip: '10.9.9.9' })).ok, true);
});

test('failures outside the window do not accumulate', async () => {
  const bad = { username: 'owner1', password: 'wrong-wrong-wrong', ip: '10.8.8.8' };
  for (let i = 0; i < 4; i++) await sshAuth.authenticate(bad);
  now += 11 * 60_000;
  for (let i = 0; i < 4; i++) await sshAuth.authenticate(bad);
  assert.equal((await sshAuth.authenticate({ username: 'owner1', password: PW, ip: '10.8.8.8' })).ok, true);
});

test('failed logins are logged without the password, username is sanitized', async () => {
  logged.length = 0;
  await login({ username: 'evil\x1b[2Jname', password: 'sup3r-secret-pw-xyz', ip: '10.7.7.7' });
  await login({ username: 'owner1', password: PW, ip: '10.7.7.7' });
  const text = logged.map((e) => `${e.level} ${e.category} ${e.message}`).join('\n');
  assert.match(text, /warn ssh \[ssh\] login failed user=evil\?\[2Jname ip=10\.7\.7\.7 reason=\w+/);
  assert.match(text, /info ssh .*owner1/);
  assert.ok(!text.includes('sup3r-secret-pw-xyz'));
  assert.ok(!text.includes(PW));
  assert.ok(!text.includes('\x1b'));
});

const guard = require('../lib/security/guard');
const splitAuth = require('../lib/splitAuth');
const noted = [];
const realNote = guard.noteFailure;
const realCheck = guard.check;
guard.noteFailure = (ip) => { noted.push(ip); };
test.after(() => { guard.noteFailure = realNote; guard.check = realCheck; });
const malformed = (o) => sshAuth.authenticate({ username: 'owner1', password: 5, ...o });
const wrong = (ip, username = 'owner1') => sshAuth.authenticate({ username, password: 'wrong-wrong-wrong', ip });
const lines = () => logged.map((e) => e.message);

test('a banned address is refused before any password work', async () => {
  const realLogin = splitAuth.checkLogin;
  let calls = 0;
  splitAuth.checkLogin = (...a) => { calls++; return realLogin(...a); };
  guard.check = () => ({ blocked: true, source: 'ban' });
  try {
    assert.deepEqual(await sshAuth.authenticate({ username: 'owner1', password: PW, ip: '10.4.4.4' }), { ok: false });
    assert.equal(calls, 0);
    guard.check = realCheck;
    assert.equal((await sshAuth.authenticate({ username: 'owner1', password: PW, ip: '10.4.4.4' })).ok, true);
    assert.equal(calls, 1);
  } finally {
    guard.check = realCheck;
    splitAuth.checkLogin = realLogin;
  }
});

test('failed logins feed the site failure tracking, successes do not', async () => {
  noted.length = 0;
  await wrong('10.3.3.3');
  await login({ username: 'owner1', ip: '10.3.3.4' });
  assert.deepEqual(noted, ['10.3.3.3']);
});

test('ipv6 addresses lock out per /64 and mapped ipv4 shares the ipv4 bucket', async () => {
  assert.equal(sshAuth.ipBucket('2001:db8:1:2:aaaa::1'), sshAuth.ipBucket('2001:0db8:0001:0002::ffff'));
  assert.notEqual(sshAuth.ipBucket('2001:db8:1:2::1'), sshAuth.ipBucket('2001:db8:1:3::1'));
  assert.equal(sshAuth.ipBucket('::ffff:10.1.1.1'), sshAuth.ipBucket('10.1.1.1'));
  for (let i = 1; i <= 5; i++) await wrong(`2001:db8:7:7::${i}`);
  assert.deepEqual(await sshAuth.authenticate({ username: 'owner1', password: PW, ip: '2001:db8:7:7:dead:beef::9' }), { ok: false });
  assert.equal((await sshAuth.authenticate({ username: 'owner1', password: PW, ip: '2001:db8:7:8::9' })).ok, true);
});

test('a full lockout table evicts idle entries but never active lockouts, refuses new work when all are locked, loopback is exempt', async () => {
  sshAuth._test.setLimits({ ips: 2 });
  await wrong('10.2.0.1');
  await wrong('10.2.0.2');
  assert.equal((await login({ ip: '10.2.0.3', username: 'owner1' })).ok, true);
  sshAuth._test.reset();
  sshAuth._test.setLimiter({ capacity: 1000, refillPerSec: 1000 });
  sshAuth._test.setLimits({ ips: 2 });
  for (const ip of ['10.2.1.1', '10.2.1.2']) for (let i = 0; i < 5; i++) await wrong(ip, 'ghost');
  assert.deepEqual(await login({ ip: '10.2.1.3', username: 'owner1' }), { ok: false });
  assert.deepEqual(await login({ ip: '10.2.1.1', username: 'owner1' }), { ok: false });
  assert.deepEqual(await login({ ip: '10.2.1.2', username: 'owner1' }), { ok: false });
  assert.equal((await login({ ip: '127.0.0.1', username: 'owner1' })).ok, true);
  now += 11 * 60_000;
  assert.equal((await login({ ip: '10.2.1.3', username: 'owner1' })).ok, true);
});

test('the verification limiter allows a burst of 3, then one per second', async () => {
  sshAuth._test.setLimiter({ capacity: 3, refillPerSec: 1 });
  const realLogin = splitAuth.checkLogin;
  let calls = 0;
  splitAuth.checkLogin = (...a) => { calls++; return realLogin(...a); };
  try {
    for (let i = 1; i <= 10; i++) await sshAuth.authenticate({ username: 'ghost', password: PW, ip: `10.0.9.${i}` });
    assert.equal(calls, 3);
    now += 1000;
    await sshAuth.authenticate({ username: 'ghost', password: PW, ip: '10.0.9.50' });
    assert.equal(calls, 4);
    await sshAuth.authenticate({ username: 'ghost', password: PW, ip: '10.0.9.51' });
    assert.equal(calls, 4);
    now += 5000;
    for (let i = 60; i < 70; i++) await sshAuth.authenticate({ username: 'ghost', password: PW, ip: `10.0.9.${i}` });
    assert.equal(calls, 7);
  } finally {
    splitAuth.checkLogin = realLogin;
  }
});

test('limiter refusals and malformed requests do not feed lockouts or the site failure tracking', async () => {
  sshAuth._test.setLimiter({ capacity: 3, refillPerSec: 1 });
  noted.length = 0;
  logged.length = 0;
  for (let i = 0; i < 10; i++) await wrong('10.8.1.1', `ghost${i}`);
  assert.equal(lines().filter((l) => /reason=busy/.test(l)).length, 7);
  assert.equal(noted.length, 3);
  now += 10_000;
  assert.equal((await login({ ip: '10.8.1.1', username: 'owner1' })).ok, true);

  sshAuth._test.setLimiter({ capacity: 1000, refillPerSec: 1000 });
  noted.length = 0;
  for (let i = 1; i <= 30; i++) await malformed({ ip: `10.8.2.${i % 3}` });
  assert.equal(noted.length, 0);
  assert.equal((await login({ ip: '10.8.2.1', username: 'owner1' })).ok, true);
});

test('a username that keeps failing from many addresses is refused for the window, warned about once; loopback and allowlisted addresses are exempt', async () => {
  logged.length = 0;
  for (let i = 1; i <= 25; i++) await wrong(`10.6.6.${i}`);
  assert.equal(lines().filter((l) => /user=owner1 refused/.test(l)).length, 1);
  assert.deepEqual(await login({ ip: '10.6.7.1', username: 'owner1' }), { ok: false });
  guard.check = (ip) => ({ blocked: false, allowlisted: ip === '10.6.7.9' });
  try {
    assert.deepEqual(await login({ ip: '10.6.7.8', username: 'owner1' }), { ok: false });
    assert.equal((await login({ ip: '10.6.7.9', username: 'owner1' })).ok, true);
  } finally {
    guard.check = realCheck;
  }
  for (let i = 1; i <= 20; i++) await wrong(`10.6.8.${i}`);
  assert.deepEqual(await login({ ip: '10.6.7.1', username: 'owner1' }), { ok: false });
  assert.equal((await login({ ip: '127.0.0.1', username: 'owner1' })).ok, true);
  for (let i = 1; i <= 20; i++) await wrong(`10.6.9.${i}`);
  assert.equal((await login({ ip: '::1', username: 'owner1' })).ok, true);
  now += 11 * 60_000;
  assert.equal((await login({ ip: '10.6.7.1', username: 'owner1' })).ok, true);
});

test('cleanName strips bidi controls, zero-width characters and lone surrogates', () => {
  const c = (n) => String.fromCharCode(n);
  const dirty = `a${c(0x202e)}b${c(0x2066)}c${c(0x200b)}d${c(0x200f)}e${c(0xd800)}f${c(0x2069)}g`;
  assert.equal(sshAuth.cleanName(dirty), 'a?b?c?d?e?f?g');
  assert.equal(sshAuth.cleanName('plain-User_1'), 'plain-User_1');
});
