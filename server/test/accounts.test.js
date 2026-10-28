'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const accounts = require('../lib/accounts');
const { checkSecondFactor } = require('../lib/secondFactor');
const { sessionCookie } = require('../lib/session');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('validateNewAccount mirrors the registration rules', () => {
  assert.equal(accounts.validateNewAccount({ username: 'okname', email: 'a@b.co', password: 'password1' }), null);
  assert.match(accounts.validateNewAccount({ username: 'a', email: 'a@b.co', password: 'password1' }), /username/);
  assert.match(accounts.validateNewAccount({ username: 'okname', email: 'nope', password: 'password1' }), /email/);
  assert.match(accounts.validateNewAccount({ username: 'okname', email: 'a@b.co', password: 'short' }), /password/);
});

test('the first real account becomes the site owner, the second does not', () => {
  const first = accounts.createAccount({ username: 'acc_first', email: 'f@t.co', password: 'password1', displayName: '' });
  const second = accounts.createAccount({ username: 'acc_second', email: 's@t.co', password: 'password1', displayName: 'Two' });
  const roles = (id) => db.prepare('SELECT COUNT(*) AS c FROM user_site_roles WHERE user_id = ?').get(id).c;
  assert.equal(roles(first.userId), 1);
  assert.equal(roles(second.userId), 0);
  assert.equal(db.prepare('SELECT display_name FROM users WHERE id = ?').get(first.userId).display_name, 'acc_first');
  assert.equal(db.prepare('SELECT display_name FROM users WHERE id = ?').get(second.userId).display_name, 'Two');
});

test('findConflict is case-insensitive on username and email', () => {
  accounts.createAccount({ username: 'Acc_Conflict', email: 'C@T.co', password: 'password1' });
  assert.equal(accounts.findConflict({ username: 'acc_conflict', email: 'x@y.co' }), true);
  assert.equal(accounts.findConflict({ username: 'someone', email: 'c@t.CO' }), true);
  assert.equal(accounts.findConflict({ username: 'someone', email: 'x@y.co' }), false);
});

test('createAccount stores passport columns and the wrapped seed when given a passport', () => {
  const { userId } = accounts.createAccount({
    username: 'acc_pp', email: 'pp@t.co', password: 'password1',
    passport: { id: 'mc1' + 'c'.repeat(52), publicKey: 'PK', e2eePublicKey: 'EK', backup: { encryptedKey: 'e', salt: 's', nonce: 'n' } },
  });
  const u = db.prepare('SELECT passport_id, passport_public_key, e2ee_public_key FROM users WHERE id = ?').get(userId);
  assert.deepEqual({ ...u }, { passport_id: 'mc1' + 'c'.repeat(52), passport_public_key: 'PK', e2ee_public_key: 'EK' });
  assert.equal(db.prepare('SELECT encrypted_key FROM e2ee_key_backups WHERE user_id = ?').get(userId).encrypted_key, 'e');
});

test('checkSecondFactor consumes a recovery code exactly once', () => {
  const { userId } = accounts.createAccount({ username: 'acc_2fa', email: '2fa@t.co', password: 'password1' });
  db.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ?, totp_recovery_codes = ? WHERE id = ?')
    .run('JBSWY3DPEHPK3PXP', JSON.stringify(['aaaa-bbbb']), userId);
  const user = () => db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  assert.equal(checkSecondFactor(user(), 'AAAA-BBBB'), true);
  assert.equal(checkSecondFactor(user(), 'aaaa-bbbb'), false);
  assert.equal(checkSecondFactor(user(), '000000'), false);
});

test('sessionCookie is HttpOnly, SameSite=Lax and only Secure over https', () => {
  assert.match(sessionCookie({ secure: false }, 'tok'), /^dismesh_session=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  assert.match(sessionCookie({ secure: true }, 'tok'), /; Secure$/);
});

test('createAccount is atomic: a failure after the users insert leaves no half-created account', () => {
  assert.throws(() => accounts.createAccount({
    username: 'acc_atomic', email: 'atomic@t.co', password: 'password1',
    passport: { id: 'mc1' + 'e'.repeat(52), publicKey: 'PK', e2eePublicKey: 'EK', backup: { salt: 's', nonce: 'n' } },
  }));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users WHERE username = ?').get('acc_atomic').c, 0);
  assert.equal(accounts.findConflict({ username: 'acc_atomic', email: 'atomic@t.co' }), false);
});

test('isUniqueViolation recognises a duplicate passport_id from the database', () => {
  const mk = (u) => accounts.createAccount({
    username: u, email: `${u}@t.co`, password: 'password1',
    passport: { id: 'mc1' + 'f'.repeat(52), publicKey: 'PK', e2eePublicKey: 'EK', backup: { encryptedKey: 'e', salt: 's', nonce: 'n' } },
  });
  mk('acc_u1');
  let caught;
  try { mk('acc_u2'); } catch (err) { caught = err; }
  assert.equal(accounts.isUniqueViolation(caught), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users WHERE username = ?').get('acc_u2').c, 0);
});

test('createAccount posts the auto-join announcement exactly once, after the account is committed', () => {
  const owner = accounts.createAccount({ username: 'acc_aj_owner', email: 'ajo@t.co', password: 'password1' }).userId;
  const sid = db.prepare("INSERT INTO servers (name, owner_id, invite_code, visibility, auto_join) VALUES ('AJ', ?, 'ajcode', 'public', 1)").run(owner).lastInsertRowid;
  const cid = db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'log', 'announcement')").run(sid).lastInsertRowid;
  const { userId } = accounts.createAccount({ username: 'acc_aj_user', email: 'aju@t.co', password: 'password1' });
  const rows = db.prepare("SELECT author_id FROM messages WHERE scope_type = 'channel' AND scope_id = ? AND event_type = 'member_join'").all(cid);
  assert.deepEqual(rows.map((r) => r.author_id), [userId]);
  assert.throws(() => accounts.createAccount({ username: 'acc_aj_user', email: 'aju2@t.co', password: 'password1' }));
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE scope_id = ? AND event_type = 'member_join'").get(cid).c, 1);
});
