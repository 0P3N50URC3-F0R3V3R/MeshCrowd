'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { normalizeIp, parseEntry, IpSet, entryCovers } = require('../lib/security/ipMatch');
const settings = require('../lib/security/settings');
const captcha = require('../lib/security/captcha');
const guard = require('../lib/security/guard');
const blocklists = require('../lib/security/blocklists');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
test.beforeEach(() => {
  guard._test.reset();
  guard._test.resetClock();
  db.exec('DELETE FROM ip_bans; DELETE FROM ip_blocklists; DELETE FROM security_events');
  db.prepare("DELETE FROM meta WHERE key = 'security_settings'").run();
  settings.reset();
  guard.rebuild();
});

// ---- ip matching ----

test('normalizeIp unwraps IPv4-mapped IPv6 and rejects junk', () => {
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIp(' 2001:DB8::1 '), '2001:db8::1');
  assert.equal(normalizeIp('[::1]'), '::1');
  assert.equal(normalizeIp('not an ip'), '');
  assert.equal(normalizeIp(undefined), '');
});

test('parseEntry accepts addresses, CIDR and ranges and canonicalises them', () => {
  assert.deepEqual(parseEntry('10.0.0.5').entry, '10.0.0.5');
  assert.equal(parseEntry('10.0.0.5/32').kind, 'ip');
  assert.equal(parseEntry('10.0.0.0/8').entry, '10.0.0.0/8');
  assert.equal(parseEntry('10.0.0.1 - 10.0.0.9').entry, '10.0.0.1-10.0.0.9', 'spaces around the dash are tolerated');
  assert.equal(parseEntry('10.0.0.1-10.0.0.9').kind, 'range');
  assert.equal(parseEntry('2001:db8::/32').family, 6);
  for (const bad of ['', '300.1.1.1', '1.2.3.4/33', '1.2.3.4-2001::1', '::/129', 'x/8', '1.2.3.4/']) assert.equal(parseEntry(bad), null, bad);
});

test('IpSet matches single addresses, subnets, ranges and both families', () => {
  const set = new IpSet(['1.2.3.4', '10.0.0.0/8', '192.168.1.10-192.168.1.20', '2001:db8::/32'].map(parseEntry));
  for (const ip of ['1.2.3.4', '10.200.1.1', '192.168.1.15', '2001:db8:abcd::1', '::ffff:10.1.1.1']) assert.ok(set.has(ip), ip);
  for (const ip of ['1.2.3.5', '11.0.0.1', '192.168.1.21', '2001:db9::1', 'junk']) assert.ok(!set.has(ip), ip);
  assert.ok(entryCovers(parseEntry('10.0.0.0/8'), '10.9.9.9'));
});

// ---- settings ----

test('settings default to a protective configuration and validate patches', () => {
  const s = settings.load();
  assert.equal(s.captcha.mode, 'after_failures');
  assert.deepEqual(s.allowlist, ['127.0.0.1', '::1']);
  assert.throws(() => settings.update({ captcha: { mode: 'sometimes' } }), /captcha.mode/);
  assert.throws(() => settings.update({ captcha: { length: 99 } }), /captcha.length/);
  assert.throws(() => settings.update({ allowlist: ['nope'] }), /not an IP/);
  assert.throws(() => settings.update({ captcha: { type: 'words', words: { source: 'custom', custom: ['abc'] } } }), /at least 10/);
  const next = settings.update({ captcha: { mode: 'always', length: 6 } });
  assert.equal(next.captcha.mode, 'always');
  settings.reset();
  assert.equal(settings.load().captcha.length, 6, 'persisted');
  assert.equal(settings.load().captcha.difficulty, 'medium', 'untouched keys keep defaults');
});

test('custom word lists are folded to a-z0-9, deduplicated and bounded', () => {
  const { words, rejected } = settings.cleanWordList('Ház\nhaz\nALMA\nx\n  \nnagyon-hosszu-szo-ami-nem-fer-el\nkörte, szilva');
  assert.deepEqual(words, ['haz', 'alma', 'korte', 'szilva']);
  assert.equal(rejected, 3);
});

// ---- captcha ----

function decodePng(dataUrl) {
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20);
  let off = 8; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (w * 3 + 1) * h);
  return { w, h, raw };
}

test('captcha images are valid PNGs and the answer is not readable from the payload', () => {
  const c = captcha.generate({ ...settings.DEFAULTS.captcha, difficulty: 'hard' });
  const { w, h } = decodePng(c.image);
  assert.ok(w >= 200 && h === 88);
  assert.ok(!Buffer.from(c.image.split(',')[1], 'base64').includes(c.answer), 'answer not embedded in the file');
  assert.equal(JSON.stringify({ id: c.id, image: c.image }).includes(c.answer), false);
});

test('captcha types follow the configured charset, length, word source and math rules', () => {
  const base = settings.DEFAULTS.captcha;
  for (let i = 0; i < 30; i++) {
    assert.match(captcha.generate({ ...base, charset: 'digits', length: 6 }).answer, /^[2-9]{6}$|^[0-9]{6}$/);
    assert.match(captcha.generate({ ...base, charset: 'letters', length: 4 }).answer, /^[A-Z]{4}$/);
    assert.match(captcha.generate({ ...base, charset: 'alphanumeric', length: 8 }).answer, /^[A-HJ-NP-Z2-9]{8}$/, 'ambiguous 0 O 1 I excluded');
    const two = captcha.generate({ ...base, type: 'words', words: { ...base.words, count: 2 } }).answer;
    assert.match(two, /^[a-z]+ [a-z]+$/);
    const custom = ['zebra', 'tulip', 'robot', 'piano', 'lemon', 'grape', 'ocean', 'cloud', 'storm', 'maple'];
    assert.ok(custom.includes(captcha.generate({ ...base, type: 'words', words: { ...base.words, source: 'custom', custom } }).answer));
    const m = captcha.generate({ ...base, type: 'math' }).answer;
    assert.ok(Number.isInteger(Number(m)) && Number(m) >= 0);
  }
});

test('a captcha is single use, case and spacing tolerant, and expires', () => {
  const cfg = { ...settings.DEFAULTS.captcha, type: 'words', words: { ...settings.DEFAULTS.captcha.words, count: 2 }, ttlSeconds: 60 };
  const c = captcha.generate(cfg);
  assert.equal(captcha.verify(c.id, c.answer.toUpperCase().replace(' ', '  ')), 'ok');
  assert.equal(captcha.verify(c.id, c.answer), 'invalid', 'second use fails');
  const w = captcha.generate(cfg);
  assert.equal(captcha.verify(w.id, 'definitely wrong'), 'wrong');
  assert.equal(captcha.verify(w.id, w.answer), 'invalid', 'a wrong guess burns the challenge');
  const e = captcha.generate({ ...cfg, ttlSeconds: 60 });
  captcha._challenges.get(e.id).expires = Date.now() - 1;
  assert.equal(captcha.verify(e.id, e.answer), 'expired');
  assert.equal(captcha.verify(undefined, 'x'), 'invalid');
});

// ---- guard: bans, allowlist, expiry ----

test('bans block addresses and ranges; the allowlist always wins; removal and expiry lift them', () => {
  guard.addBan('203.0.113.7', { reason: 'spam' });
  guard.addBan('198.51.100.0/24', { source: 'manual' });
  assert.ok(guard.check('203.0.113.7').blocked);
  assert.ok(guard.check('198.51.100.200').blocked);
  assert.ok(!guard.check('203.0.113.8').blocked);

  settings.update({ allowlist: ['127.0.0.1', '198.51.100.200'] });
  guard.rebuild();
  assert.ok(!guard.check('198.51.100.200').blocked && guard.check('198.51.100.200').allowlisted);

  const ban = db.prepare("SELECT id FROM ip_bans WHERE entry = '203.0.113.7'").get();
  assert.ok(guard.removeBan(ban.id));
  assert.ok(!guard.check('203.0.113.7').blocked);

  let t = Date.now();
  guard._test.setClock(() => t);
  guard.addBan('203.0.113.9', { minutes: 10 });
  assert.ok(guard.check('203.0.113.9').blocked);
  t += 11 * 60_000;
  assert.equal(guard.sweepExpired(), 1);
  assert.ok(!guard.check('203.0.113.9').blocked);
});

test('request floods auto-ban an address once, never an allowlisted one, and only in protect mode', () => {
  settings.update({ protection: { requestsPerWindow: 20, windowSeconds: 10, banMinutes: 5 } });
  let banned = false;
  for (let i = 0; i < 25; i++) banned = guard.noteRequest('203.0.113.50') || banned;
  assert.ok(banned);
  assert.ok(guard.check('203.0.113.50').blocked);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ip_bans WHERE source = 'auto'").get().n, 1);

  for (let i = 0; i < 100; i++) guard.noteRequest('127.0.0.1');
  assert.ok(!guard.check('127.0.0.1').blocked, 'loopback is allowlisted by default');

  settings.update({ protection: { mode: 'detect' } });
  for (let i = 0; i < 25; i++) guard.noteRequest('203.0.113.51');
  assert.ok(!guard.check('203.0.113.51').blocked, 'detect mode only records');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM security_events WHERE type = 'threat_detected'").get().n >= 1);
});

test('repeated failed sign-ins and rate-limit strikes trigger temporary bans', () => {
  settings.update({ protection: { failedLoginBan: { threshold: 5, windowMinutes: 10, banMinutes: 30 }, rateLimitStrikes: 4 } });
  for (let i = 0; i < 5; i++) guard.noteFailure('203.0.113.60');
  assert.ok(guard.check('203.0.113.60').blocked);
  for (let i = 0; i < 4; i++) guard.noteRateLimited('203.0.113.61');
  assert.ok(guard.check('203.0.113.61').blocked);
  const row = db.prepare("SELECT expires_at FROM ip_bans WHERE entry = '203.0.113.60'").get();
  assert.ok(Date.parse(row.expires_at) > Date.now() + 25 * 60_000);
});

test('a burst of auto-bans switches on under-attack mode, which forces captcha everywhere', () => {
  settings.update({ captcha: { mode: 'off' }, protection: { failedLoginBan: { threshold: 3, windowMinutes: 10, banMinutes: 5 }, underAttack: { trigger: 3, windowMinutes: 5, durationMinutes: 20 } } });
  assert.equal(guard.captchaRequired('203.0.113.1', 'login'), false);
  for (const n of [70, 71, 72]) for (let i = 0; i < 3; i++) guard.noteFailure(`203.0.113.${n}`);
  assert.ok(guard.isUnderAttack());
  assert.equal(guard.captchaRequired('203.0.113.1', 'login'), true);
  assert.equal(guard.captchaRequired('203.0.113.1', 'register'), true);
  guard.setUnderAttack(0);
  assert.equal(guard.captchaRequired('203.0.113.1', 'login'), false);
});

test('captcha policy: off, always, or after N failures inside the window, per scope', () => {
  const ip = '203.0.113.80';
  settings.update({ captcha: { mode: 'after_failures', failureThreshold: 3, failureWindowMinutes: 15 } });
  assert.equal(guard.captchaRequired(ip, 'login'), false);
  guard.noteFailure(ip); guard.noteFailure(ip);
  assert.equal(guard.captchaRequired(ip, 'login'), false);
  guard.noteFailure(ip);
  assert.equal(guard.captchaRequired(ip, 'login'), true);
  assert.equal(guard.captchaRequired('203.0.113.81', 'login'), false, 'per address');
  guard.clearFailures(ip);
  assert.equal(guard.captchaRequired(ip, 'login'), false);

  settings.update({ captcha: { mode: 'always', applyTo: { register: false } } });
  assert.equal(guard.captchaRequired(ip, 'login'), true);
  assert.equal(guard.captchaRequired(ip, 'register'), false);
  settings.update({ captcha: { mode: 'off' } });
  assert.equal(guard.captchaRequired(ip, 'login'), false);

  let t = Date.now();
  guard._test.setClock(() => t);
  settings.update({ captcha: { mode: 'after_failures', failureThreshold: 2, failureWindowMinutes: 5, applyTo: { register: true } } });
  guard.noteFailure(ip); guard.noteFailure(ip);
  assert.equal(guard.captchaRequired(ip, 'login'), true);
  t += 6 * 60_000;
  assert.equal(guard.captchaRequired(ip, 'login'), false, 'failures age out');
});

test('registration limit is per address and skips allowlisted ones', () => {
  settings.update({ protection: { registrationLimit: { enabled: true, max: 2, windowHours: 24 } } });
  guard.noteRegistration('203.0.113.90'); guard.noteRegistration('203.0.113.90');
  assert.ok(guard.registrationBlocked('203.0.113.90'));
  assert.ok(!guard.registrationBlocked('203.0.113.91'));
  guard.noteRegistration('127.0.0.1'); guard.noteRegistration('127.0.0.1'); guard.noteRegistration('127.0.0.1');
  assert.ok(!guard.registrationBlocked('127.0.0.1'));
});

test('lookup reports bans, subscribed lists and recent events for an address', () => {
  guard.addBan('203.0.113.0/24', { reason: 'bad net' });
  const id = Number(db.prepare("INSERT INTO ip_blocklists (name, url, entries, entry_count) VALUES ('L', 'https://x.test/l', '203.0.113.5', 1)").run().lastInsertRowid);
  guard.rebuild();
  guard.event('captcha_failed', '203.0.113.5', { kind: 'login' });
  const info = guard.lookup('::ffff:203.0.113.5');
  assert.equal(info.ip, '203.0.113.5');
  assert.ok(info.blocked);
  assert.equal(info.bans.length, 1);
  assert.deepEqual(info.blocklists.map((l) => l.id), [id]);
  assert.equal(info.events[0].type, 'captcha_failed');
  assert.equal(guard.lookup('bogus'), null);
});

// ---- blocklists ----

test('blocklist parsing handles comments, trailing notes, duplicates and junk', () => {
  const { entries, skipped } = blocklists.parseList('# header\n1.2.3.0/24 ; SBL123\n1.2.3.0/24\n\n8.8.8.8 # dns\nnot-an-ip\n2001:db8::/32\n// c\n');
  assert.deepEqual(entries, ['1.2.3.0/24', '8.8.8.8', '2001:db8::/32']);
  assert.equal(skipped, 1);
});

test('blocklist URLs must be https and without credentials', () => {
  assert.throws(() => blocklists.validateUrl('http://example.com/l.txt'), /https/);
  assert.throws(() => blocklists.validateUrl('https://user:pw@example.com/l.txt'), /credentials/);
  assert.throws(() => blocklists.validateUrl('nonsense'), /valid URL/);
  assert.equal(blocklists.validateUrl('https://example.com/l.txt'), 'https://example.com/l.txt');
});

test('a blocklist is fetched, applied, and kept when a later refresh fails', async () => {
  process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK = '1';
  const http = require('node:http');
  let body = '# test list\n192.0.2.0/24\n198.51.100.9\n'; let status = 200;
  const srv = http.createServer((req, res) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(body); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const id = blocklists.addList({ name: 'local', url: `http://127.0.0.1:${srv.address().port}/list.txt` });
    const result = await blocklists.refreshList(id);
    assert.equal(result.entries, 2);
    assert.ok(guard.check('192.0.2.77').blocked);
    assert.ok(!guard.check('192.0.3.1').blocked);

    status = 500;
    await assert.rejects(blocklists.refreshList(id), /500/);
    assert.ok(guard.check('192.0.2.77').blocked, 'previous copy still enforced');
    assert.match(blocklists.listAll()[0].last_error, /500/);

    db.prepare('UPDATE ip_blocklists SET enabled = 0 WHERE id = ?').run(id);
    guard.rebuild();
    assert.ok(!guard.check('192.0.2.77').blocked, 'disabled list is not enforced');
  } finally {
    srv.close();
    delete process.env.DISMESH_FEDERATION_ALLOW_LOOPBACK;
  }
});
