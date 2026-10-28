'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { toPublicUser } = require('../lib/publicUser');
const config = require('../lib/config');

test.after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const insert = (name, passportId) => db.prepare(
  'INSERT INTO users (username, email, password_hash, display_name, passport_id, passport_public_key) VALUES (?, ?, ?, ?, ?, ?)',
).run(name, `${name}@t.local`, 'h', name, passportId, passportId ? 'pk' : null).lastInsertRowid;

test('many users may have no passport, but a passport id is unique', () => {
  insert('pp_a', null);
  insert('pp_b', null);
  insert('pp_c', 'mc1' + 'a'.repeat(52));
  assert.throws(() => insert('pp_d', 'mc1' + 'a'.repeat(52)), /UNIQUE/);
});

test('toPublicUser exposes the passport id', () => {
  const id = insert('pp_e', 'mc1' + 'b'.repeat(52));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  assert.equal(toPublicUser(user, { viewerIsSelf: true }).passportId, 'mc1' + 'b'.repeat(52));
  assert.equal(toPublicUser({ ...user, passport_id: null }, {}).passportId, null);
});

test('passport_audit accepts rows and keeps them when the user is deleted', () => {
  const id = insert('pp_f', null);
  db.prepare('INSERT INTO passport_audit (user_id, passport_id, action, ok, ip) VALUES (?, ?, ?, ?, ?)').run(id, null, 'login', 0, '1.2.3.4');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  const row = db.prepare('SELECT * FROM passport_audit WHERE action = ?').get('login');
  assert.equal(row.user_id, null);
});

test('federation is off by default in the loaded config', () => {
  assert.equal(config.load().federation.enabled, false);
});
