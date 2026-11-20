'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const bcrypt = require('bcryptjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { attachUser } = require('../middleware/auth');
const challenges = require('../lib/passportChallenges');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(attachUser);
app.use('/api/auth', require('../routes/auth'));
let server; let base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
test.beforeEach(() => challenges._resetForTests());

const hash = bcrypt.hashSync('correct-horse', 4);
let seq = 0;
function makeUser() {
  const name = `ll${++seq}`;
  const id = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(name, `${name}@t.co`, hash, name).lastInsertRowid;
  return { id, name };
}
const login = async (username, password, ip) => {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ username, password }) });
  return { status: res.status, body: await res.json() };
};
const guess = async (username, ip, n) => { for (let i = 0; i < n; i++) await login(username, 'wrong-guess', ip); };
const seenFrom = (userId, ip) => db.prepare('INSERT INTO sessions (token, user_id, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?)')
  .run(`tok-${userId}-${ip}`, userId, new Date(Date.now() + 86400000).toISOString(), 'ua', ip);

test('five failures lock that IP for the account, the right password is then refused too, other IPs are unaffected', async () => {
  const u = makeUser();
  await guess(u.name, '10.0.0.1', 5);
  const locked = await login(u.name, 'correct-horse', '10.0.0.1');
  assert.equal(locked.status, 429);
  assert.deepEqual(locked.body, { error: 'too many attempts, try again later' });
  assert.equal((await login(u.name, 'correct-horse', '10.0.0.2')).status, 200, 'the owner on another address still gets in');
});

test('an attacker guessing from one address cannot lock the owner out', async () => {
  const u = makeUser();
  await guess(u.name, '10.1.0.1', 12);
  assert.equal((await login(u.name, 'wrong-guess', '10.1.0.1')).status, 429);
  assert.equal((await login(u.name, 'correct-horse', '10.1.0.9')).status, 200);
});

test('a success clears the IP counter', async () => {
  const u = makeUser();
  await guess(u.name, '10.2.0.1', 4);
  assert.equal((await login(u.name, 'correct-horse', '10.2.0.1')).status, 200);
  await guess(u.name, '10.2.0.1', 4);
  assert.equal((await login(u.name, 'correct-horse', '10.2.0.1')).status, 200);
});

test('failures spread over many IPs trip the account cap: only IPs that already signed in may still log in', async () => {
  const u = makeUser();
  seenFrom(u.id, '10.3.0.200');
  for (let i = 0; i < 20; i++) await login(u.name, 'wrong-guess', `10.3.1.${i}`);
  const stranger = await login(u.name, 'correct-horse', '10.3.2.1');
  assert.equal(stranger.status, 429);
  assert.deepEqual(stranger.body, { error: 'too many attempts, try again later' });
  assert.equal((await login(u.name, 'wrong-guess', '10.3.0.200')).status, 401, 'a known IP is still checked, not locked');
  assert.equal((await login(u.name, 'correct-horse', '10.3.0.200')).status, 200);
});

test('the account cap lifts after the window', async () => {
  const u = makeUser();
  for (let i = 0; i < 20; i++) await login(u.name, 'wrong-guess', `10.4.1.${i}`);
  assert.equal((await login(u.name, 'correct-horse', '10.4.2.1')).status, 429);
  challenges._backdateFailure(`login-acct:u${u.id}`, 16 * 60_000);
  assert.equal((await login(u.name, 'correct-horse', '10.4.2.1')).status, 200);
});

test('unknown names are locked exactly like existing accounts', async () => {
  await guess('nobody-here', '10.5.0.1', 5);
  const locked = await login('nobody-here', 'whatever1', '10.5.0.1');
  assert.equal(locked.status, 429);
  assert.deepEqual(locked.body, { error: 'too many attempts, try again later' });
  for (let i = 0; i < 20; i++) await login('nobody-here', 'wrong-guess', `10.5.1.${i}`);
  assert.equal((await login('nobody-here', 'whatever1', '10.5.2.1')).status, 429);
});

test('username and e-mail identify the same account for the IP counter', async () => {
  const u = makeUser();
  await guess(u.name, '10.6.0.1', 3);
  await guess(`${u.name}@t.co`, '10.6.0.1', 2);
  assert.equal((await login(u.name, 'correct-horse', '10.6.0.1')).status, 429);
});
