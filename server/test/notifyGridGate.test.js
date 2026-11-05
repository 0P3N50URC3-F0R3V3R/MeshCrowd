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
const pushEndpoints = require('../lib/pushEndpoints');
const { notifyChannelMessage, notifyDmMessage, notifyThreadStarted, setPref, pollOutbox } = require('../lib/notifications');
const { DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');

const mkUser = (n, status = 'online', grid = null) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name, status, notify_grid) VALUES (?, ?, ?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n, status, grid ? JSON.stringify(grid) : null).lastInsertRowid);

let sent; let woken;
const realNotify = hub.notifyUser; const realWake = pushEndpoints.wake;
test.beforeEach(() => {
  sent = []; woken = [];
  hub.notifyUser = (userId, payload) => sent.push({ userId, payload });
  pushEndpoints.wake = (userId) => woken.push(userId);
});
test.after(() => { hub.notifyUser = realNotify; pushEndpoints.wake = realWake; db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function dmBetween(author, other) {
  const id = db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(author).lastInsertRowid;
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?), (?, ?)').run(id, author, id, other);
  return db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(id);
}
function channelWith(author, ...members) {
  const sid = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S', author, `i${Math.random()}`).lastInsertRowid);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(sid, '@everyone', DEFAULT_EVERYONE_PERMISSIONS);
  for (const u of [author, ...members]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, u);
  const cid = Number(db.prepare("INSERT INTO channels (server_id, name, type) VALUES (?, 'general', 'public')").run(sid).lastInsertRowid);
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(cid);
}
const noMentions = { userIds: [], roleIds: [], everyone: false, here: false };

test('a busy user with Android off for DMs still gets the live notify, tagged, but no outbox row and no wake', () => {
  const a = mkUser('gg_a1'); const b = mkUser('gg_b1', 'dnd', { dnd: { dmMessage: { android: false } } });
  notifyDmMessage(dmBetween(a, b), { id: 1, author: { id: a }, content: 'hello' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.gridEvent, 'dmMessage');
  assert.equal(pollOutbox(b, 0).notifications.length, 0);
  assert.deepEqual(woken, []);
});

test('the same cell turned on records the row and wakes the phone', () => {
  const a = mkUser('gg_a2'); const b = mkUser('gg_b2', 'dnd', { dnd: { dmMessage: { android: true } } });
  notifyDmMessage(dmBetween(a, b), { id: 1, author: { id: a }, content: 'hello' });
  assert.equal(pollOutbox(b, 0).notifications.length, 1);
  assert.deepEqual(woken, [b]);
});

test('the status in force picks the tab: invisible is judged by its own cells', () => {
  const a = mkUser('gg_a3'); const b = mkUser('gg_b3', 'invisible', { dnd: { dmMessage: { android: false } } });
  notifyDmMessage(dmBetween(a, b), { id: 1, author: { id: a }, content: 'hi' });
  assert.equal(pollOutbox(b, 0).notifications.length, 1);
});

test('a user who never edited anything gets today\'s behavior in every status', () => {
  const a = mkUser('gg_a4');
  const dm = (n) => dmBetween(a, n);
  for (const [i, status] of ['online', 'idle', 'dnd', 'invisible'].entries()) {
    const b = mkUser(`gg_b4${i}`, status);
    notifyDmMessage(dm(b), { id: 1, author: { id: a }, content: 'hi' });
    assert.equal(pollOutbox(b, 0).notifications.length, 1, status);
  }
});

test('a DM that @-mentions the recipient is tagged dmMention', () => {
  const a = mkUser('gg_a5'); const b = mkUser('gg_b5');
  notifyDmMessage(dmBetween(a, b), { id: 1, author: { id: a }, content: 'psst @gg_b5' });
  assert.equal(sent[0].payload.gridEvent, 'dmMention');
});

test('channel messages are tagged by mention and a muted channel stays muted whatever the grid says', () => {
  const a = mkUser('gg_a6'); const b = mkUser('gg_b6'); const c = mkUser('gg_c6', 'online', { online: { channelMention: { android: true, popup: true, sound: true, tray: true } } });
  const ch = channelWith(a, b, c);
  setPref(c, 'channel', ch.id, 'mute');
  setPref(b, 'channel', ch.id, 'all');
  notifyChannelMessage(ch, { id: 1, author: { id: a }, content: 'plain' }, noMentions);
  notifyChannelMessage(ch, { id: 2, author: { id: a }, content: 'hey @gg_b6' }, { ...noMentions, userIds: [b] });
  assert.equal(sent.filter((s) => s.userId === c).length, 0);
  assert.deepEqual(sent.filter((s) => s.userId === b).map((s) => s.payload.gridEvent), ['channelMessage', 'channelMention']);
  assert.equal(pollOutbox(c, 0).notifications.length, 0);
});

test('a thread started on your message is tagged thread and obeys the Android cell', () => {
  const author = mkUser('gg_a7'); const owner = mkUser('gg_b7', 'online', { online: { thread: { android: false } } });
  const ch = channelWith(author, owner);
  notifyThreadStarted(ch, { id: 5, title: 'T' }, { author_id: owner }, { id: 9, content: 'x', scopeType: 'thread' }, { id: author, displayName: 'a' });
  assert.equal(sent[0].payload.gridEvent, 'thread');
  assert.equal(pollOutbox(owner, 0).notifications.length, 0);
});
