'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { PERMISSIONS, SITE_PERMISSIONS, OWNER_PERMISSIONS, hasSite } = require('../lib/permissions');

test.after(async () => {
  db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const mkUser = (n, isBot = 0) => Number(db.prepare(
  'INSERT INTO users (username, email, password_hash, display_name, is_bot) VALUES (?, ?, ?, ?, ?)'
).run(n, `${n}@t.local`, 'h', n, isBot).lastInsertRowid);
const mkServer = (owner) => Number(db.prepare(
  'INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)'
).run('S', owner, `inv${Math.random()}`).lastInsertRowid);
const mkProvider = () => Number(db.prepare(
  "INSERT INTO ai_providers (name, kind, base_url) VALUES (?, 'ollama', 'http://127.0.0.1:11434')"
).run(`p${Math.random()}`).lastInsertRowid);
const mkBot = (userId, serverId, providerId) => Number(db.prepare(
  'INSERT INTO bots (user_id, server_id, provider_id, model) VALUES (?, ?, ?, ?)'
).run(userId, serverId, providerId, 'm').lastInsertRowid);

test('users.is_bot exists and defaults to 0', () => {
  const id = mkUser('plain');
  assert.equal(db.prepare('SELECT is_bot FROM users WHERE id = ?').get(id).is_bot, 0);
  assert.equal(db.prepare('SELECT is_bot FROM users WHERE id = ?').get(mkUser('robot', 1)).is_bot, 1);
});

test('ai_providers has the spec defaults', () => {
  const id = mkProvider();
  const row = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id);
  assert.equal(row.scope, 'site');
  assert.equal(row.owner_server_id, null);
  assert.equal(row.timeout_s, 120);
  assert.equal(row.concurrency, 1);
  assert.equal(row.enabled, 1);
  assert.equal(row.server_admin_usable, 0);
  assert.equal(row.models, '[]');
});

test('ai_providers rejects an unknown kind and a duplicate name', () => {
  assert.throws(() => db.prepare("INSERT INTO ai_providers (name, kind, base_url) VALUES ('x', 'weird', 'http://a')").run());
  db.prepare("INSERT INTO ai_providers (name, kind, base_url) VALUES ('Dup', 'ollama', 'http://a')").run();
  assert.throws(() => db.prepare("INSERT INTO ai_providers (name, kind, base_url) VALUES ('dup', 'ollama', 'http://b')").run());
});

test('bots defaults', () => {
  const owner = mkUser('o1');
  const bot = mkBot(mkUser('b1', 1), mkServer(owner), mkProvider());
  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(bot);
  assert.equal(row.mention_enabled, 1);
  assert.equal(row.dm_enabled, 0);
  assert.equal(row.context_messages, 12);
  assert.equal(row.persona, '');
});

test('a provider that bots use cannot be deleted', () => {
  const owner = mkUser('o2');
  const providerId = mkProvider();
  mkBot(mkUser('b2', 1), mkServer(owner), providerId);
  assert.throws(() => db.prepare('DELETE FROM ai_providers WHERE id = ?').run(providerId));
});

test('deleting a bot row disables its user', () => {
  const owner = mkUser('o3');
  const userId = mkUser('b3', 1);
  const botId = mkBot(userId, mkServer(owner), mkProvider());
  db.prepare('DELETE FROM bots WHERE id = ?').run(botId);
  assert.equal(db.prepare('SELECT is_disabled FROM users WHERE id = ?').get(userId).is_disabled, 1);
});

test('deleting a server cascades the bot row and disables the bot user', () => {
  const owner = mkUser('o4');
  const userId = mkUser('b4', 1);
  const serverId = mkServer(owner);
  mkBot(userId, serverId, mkProvider());
  db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bots WHERE user_id = ?').get(userId).c, 0);
  assert.equal(db.prepare('SELECT is_disabled FROM users WHERE id = ?').get(userId).is_disabled, 1);
});

test('new permission bits are distinct and owner/site-admin imply them', () => {
  assert.equal(PERMISSIONS.MANAGE_BOTS, 1 << 16);
  assert.equal(SITE_PERMISSIONS.MANAGE_AI, 1 << 8);
  const values = Object.values(PERMISSIONS);
  assert.equal(new Set(values).size, values.length);
  const siteValues = Object.values(SITE_PERMISSIONS);
  assert.equal(new Set(siteValues).size, siteValues.length);
  assert.ok(OWNER_PERMISSIONS & PERMISSIONS.MANAGE_BOTS);
  assert.ok(hasSite(SITE_PERMISSIONS.SITE_ADMINISTRATOR, SITE_PERMISSIONS.MANAGE_AI));
  assert.ok(!hasSite(SITE_PERMISSIONS.VIEW_ADMIN_PANEL, SITE_PERMISSIONS.MANAGE_AI));
});
