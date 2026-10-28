'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const hub = require('../socket/hub');
const { notifyChannelMessage, setPref, getPref } = require('../lib/notifications');
const { setServerPref, listServerPrefs, resolveChannelPref } = require('../lib/serverPrefs');
const { canDm } = require('../routes/dms');
const { DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');

const makeUser = (n) => db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid;
function makeServer(name, ownerId, members) {
  const id = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run(name, ownerId, `inv-${name}`).lastInsertRowid;
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  for (const m of members) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, m);
  const ch = db.prepare("INSERT INTO channels (server_id, name, type, position) VALUES (?, 'general', 'public', 0)").run(id).lastInsertRowid;
  return { id, ch };
}

let sent;
const realNotifyUser = hub.notifyUser;
test.beforeEach(() => { sent = []; hub.notifyUser = (userId, payload) => sent.push({ userId, payload }); });
test.after(() => { hub.notifyUser = realNotifyUser; db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const post = (serverId, channelId, authorId, content) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  notifyChannelMessage(channel, { id: 1, content, author: { id: authorId } }, { userIds: [], roleIds: [], everyone: false, here: false });
};

test('server notification level applies to channels without their own setting; a channel setting wins', () => {
  const a = makeUser('sp_a'); const b = makeUser('sp_b');
  const s = makeServer('SP1', a, [a, b]);
  assert.equal(getPref(b, 'channel', s.ch), 'mentions');
  setServerPref(b, s.id, { notifLevel: 'all' });
  assert.equal(getPref(b, 'channel', s.ch), 'all');
  post(s.id, s.ch, a, 'hello');
  assert.equal(sent.length, 1);
  setPref(b, 'channel', s.ch, 'mentions');
  assert.equal(getPref(b, 'channel', s.ch), 'mentions');
});

test('a server mute silences every channel until it expires; forever never expires', () => {
  const a = makeUser('sp_c'); const b = makeUser('sp_d');
  const s = makeServer('SP2', a, [a, b]);
  setPref(b, 'channel', s.ch, 'all');
  setServerPref(b, s.id, { mutedUntil: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(getPref(b, 'channel', s.ch), 'mute');
  post(s.id, s.ch, a, 'x');
  assert.equal(sent.length, 0);
  setServerPref(b, s.id, { mutedUntil: new Date(Date.now() - 1000).toISOString() });
  assert.equal(getPref(b, 'channel', s.ch), 'all');
  setServerPref(b, s.id, { mutedUntil: null });
  assert.equal(resolveChannelPref(b, s.id, null, 'mentions'), 'mentions');
});

test('setServerPref keeps untouched fields and listServerPrefs reports booleans', () => {
  const a = makeUser('sp_e');
  const s = makeServer('SP3', a, [a]);
  setServerPref(a, s.id, { hideMutedChannels: true });
  setServerPref(a, s.id, { showAllChannels: false });
  assert.deepEqual(listServerPrefs(a).find((p) => p.serverId === s.id),
    { serverId: s.id, notifLevel: null, mutedUntil: null, hideMutedChannels: true, showAllChannels: false, allowDms: true });
});

test('allowDms=false blocks DMs only when every shared server is closed and they are not friends', () => {
  const a = makeUser('sp_f'); const b = makeUser('sp_g');
  const s1 = makeServer('SP4', a, [a, b]);
  const s2 = makeServer('SP5', a, [a, b]);
  const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  assert.equal(canDm(userRow(a), userRow(b)), true);
  setServerPref(b, s1.id, { allowDms: false });
  assert.equal(canDm(userRow(a), userRow(b)), true);
  setServerPref(b, s2.id, { allowDms: false });
  assert.equal(canDm(userRow(a), userRow(b)), false);
  const c = makeUser('sp_h');
  assert.equal(canDm(userRow(c), userRow(b)), true);
});
