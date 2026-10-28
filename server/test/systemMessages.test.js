'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { postServerEvent, SERVER_EVENT_TYPES } = require('../lib/systemMessages');

function makeUser(username, isBot = 0) {
  return db.prepare('INSERT INTO users (username, email, password_hash, display_name, is_bot) VALUES (?, ?, ?, ?, ?)')
    .run(username, `${username}@test.local`, 'hash', username, isBot).lastInsertRowid;
}

const admin = makeUser('sm_admin');
const member = makeUser('sm_member');
const bot = makeUser('sm_bot', 1);
const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('LogServer', admin, 'smlog1').lastInsertRowid;
const logChannel = db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'log', 'announcement')").run(serverId).lastInsertRowid;
db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'chat', 'public')").run(serverId);

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const posted = () => db.prepare("SELECT * FROM messages WHERE scope_type = 'channel' AND scope_id = ? ORDER BY id").all(logChannel);

test('join posts a join line and a default greeting', () => {
  postServerEvent(serverId, 'member_join', member);
  const rows = posted();
  assert.deepEqual(rows.map((r) => r.event_type), ['member_join', 'member_greeting']);
  assert.equal(rows[0].content, 'sm_member joined the server.');
  assert.equal(rows[1].content, 'Welcome to LogServer, sm_member!');
});

test('greeting uses the server welcome message with placeholders when enabled', () => {
  db.prepare('UPDATE servers SET welcome_enabled = 1, welcome_message = ? WHERE id = ?').run('Hi {name}, glad you found {server}!', serverId);
  postServerEvent(serverId, 'member_join', member);
  assert.equal(posted().at(-1).content, 'Hi sm_member, glad you found LogServer!');
});

test('bots get a join line but no greeting', () => {
  const before = posted().length;
  postServerEvent(serverId, 'member_join', bot);
  assert.deepEqual(posted().slice(before).map((r) => r.event_type), ['member_join']);
});

test('moderation events credit the actor', () => {
  postServerEvent(serverId, 'member_ban', member, { reason: 'spam' }, admin);
  const row = posted().at(-1);
  assert.equal(row.content, 'sm_member was banned from the server by sm_admin. Reason: spam');
  assert.equal(row.author_id, admin);
});

test('channel and server edits are logged', () => {
  postServerEvent(serverId, 'channel_create', null, { channel: 'rules' }, admin);
  postServerEvent(serverId, 'channel_rename', null, { from: 'rules', channel: 'info' }, admin);
  postServerEvent(serverId, 'server_rename', null, { from: 'Old' }, admin);
  assert.deepEqual(posted().slice(-3).map((r) => r.content), [
    'sm_admin created the channel #rules.',
    'sm_admin renamed the channel #rules to #info.',
    'sm_admin renamed the server from Old to LogServer.',
  ]);
});

test('event_data carries the structured params for client-side translation', () => {
  postServerEvent(serverId, 'channel_rename', null, { from: 'a', channel: 'b' }, admin);
  const row = posted().at(-1);
  assert.deepEqual(JSON.parse(row.event_data), { target: null, actor: 'sm_admin', server: 'LogServer', from: 'a', channel: 'b' });
});

test('channel event_filter skips disabled event types', () => {
  db.prepare('UPDATE channels SET event_filter = ? WHERE id = ?').run(JSON.stringify(['category_create']), logChannel);
  const before = posted().length;
  postServerEvent(serverId, 'category_create', null, { category: 'Text' }, admin);
  postServerEvent(serverId, 'category_delete', null, { category: 'Text' }, admin);
  assert.deepEqual(posted().slice(before).map((r) => r.event_type), ['category_delete']);
});

test('every event type is translated and offered in the channel settings', () => {
  const root = path.join(__dirname, '..', '..');
  const groups = fs.readFileSync(path.join(root, 'web', 'js', 'eventText.js'), 'utf8');
  for (const lang of ['en', 'hu']) {
    const log = JSON.parse(fs.readFileSync(path.join(root, 'lang', `${lang}.json`), 'utf8')).serverLog;
    for (const type of SERVER_EVENT_TYPES) {
      assert.ok(type in log || `${type}NoActor` in log, `${lang}: serverLog.${type} missing`);
      assert.ok(`${type}Title` in log, `${lang}: serverLog.${type}Title missing`);
      assert.ok(groups.includes(`'${type}'`), `${type} missing from EVENT_GROUPS`);
    }
  }
});
