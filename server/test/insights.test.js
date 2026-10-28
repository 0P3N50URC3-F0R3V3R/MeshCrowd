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
const { PERMISSIONS } = require('../lib/permissions');
const insights = require('../lib/insights');

let n = 0;
const mkUser = (name, isBot = 0) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name, is_bot) VALUES (?, ?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name, isBot).lastInsertRowid);
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
  return id;
};
const mkChannel = (sid, name) => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, name, 'public').lastInsertRowid);
const daysAgo = (d, hour = 12) => { const t = new Date(Date.now() - d * 86400_000); t.setUTCHours(hour, 30, 0, 0); return t.toISOString(); };
const say = (scopeType, scopeId, author, at, extra = {}) => db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content, created_at, event_type, is_encrypted, webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .run(scopeType, scopeId, author, 'hi', at, extra.event ?? null, extra.enc ?? 0, extra.webhook ?? null);

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/servers/:id/insights', require('../routes/insights'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
test.beforeEach(() => insights._reset());

const get = async (url, uid) => {
  const res = await fetch(base + url, { headers: { 'x-uid': String(uid) } });
  return { status: res.status, data: await res.json().catch(() => null) };
};

function world() {
  const owner = mkUser('owner');
  const sid = mkServer(owner);
  const general = mkChannel(sid, 'general');
  const random = mkChannel(sid, 'random');
  const ann = mkUser('ann'); const bob = mkUser('bob');
  for (const u of [ann, bob]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, u);
  return { owner, sid, general, random, ann, bob };
}

test('counts messages per day and hour, fills empty days with zero and ranks channels and members', async () => {
  const w = world();
  say('channel', w.general, w.ann, daysAgo(0, 9)); say('channel', w.general, w.ann, daysAgo(0, 9)); say('channel', w.general, w.bob, daysAgo(1, 20));
  say('channel', w.random, w.ann, daysAgo(3, 9));
  const res = await get(`/api/servers/${w.sid}/insights?days=7`, w.owner);
  assert.equal(res.status, 200);
  const ins = res.data.insights;
  assert.equal(ins.days, 7);
  assert.equal(ins.messages.byDay.length, 7);
  assert.equal(ins.messages.total, 4);
  assert.equal(ins.messages.byDay.at(-1).count, 2, 'today');
  assert.equal(ins.messages.byDay.at(-2).count, 1, 'yesterday');
  assert.equal(ins.messages.byDay.at(-3).count, 0, 'a quiet day is present with zero');
  assert.equal(ins.messages.byHour[9], 3);
  assert.equal(ins.messages.byHour[20], 1);
  assert.deepEqual(ins.topChannels.map((c) => [c.name, c.count]), [['general', 3], ['random', 1]]);
  assert.deepEqual(ins.topMembers.map((m) => [m.username.replace(/\d+$/, ''), m.count]), [['ann', 3], ['bob', 1]]);
  assert.equal(ins.activeMembers.last7, 2);
});

test('threads of the server count, other servers, DMs, system events, webhooks, bots and encrypted messages do not', async () => {
  const w = world();
  const thread = Number(db.prepare("INSERT INTO threads (channel_id, title, created_by) VALUES (?, 't', ?)").run(w.general, w.ann).lastInsertRowid);
  say('thread', thread, w.ann, daysAgo(0));
  const other = world();
  say('channel', other.general, other.ann, daysAgo(0));
  const dm = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(w.ann).lastInsertRowid);
  say('dm', dm, w.ann, daysAgo(0));
  say('channel', w.general, w.ann, daysAgo(0), { event: 'member_join' });
  say('channel', w.general, w.ann, daysAgo(0), { enc: 1 });
  const bot = mkUser('robot', 1);
  say('channel', w.general, bot, daysAgo(0));
  const ins = (await get(`/api/servers/${w.sid}/insights?days=7`, w.owner)).data.insights;
  assert.equal(ins.messages.total, 1);
  assert.equal(ins.messages.byDay.at(-1).count, 1);
});

test('messages older than the range are ignored and the range falls back to 30 days', async () => {
  const w = world();
  say('channel', w.general, w.ann, daysAgo(40));
  say('channel', w.general, w.ann, daysAgo(10));
  assert.equal((await get(`/api/servers/${w.sid}/insights?days=7`, w.owner)).data.insights.messages.total, 0);
  const d30 = (await get(`/api/servers/${w.sid}/insights?days=12345`, w.owner)).data.insights;
  assert.equal(d30.days, 30);
  assert.equal(d30.messages.total, 1);
  assert.equal((await get(`/api/servers/${w.sid}/insights?days=90`, w.owner)).data.insights.messages.total, 2);
});

test('member growth: total excludes bots, joins are bucketed by day', async () => {
  const w = world();
  db.prepare('UPDATE server_members SET joined_at = ? WHERE user_id = ?').run(daysAgo(2), w.ann);
  db.prepare('UPDATE server_members SET joined_at = ? WHERE user_id = ?').run(daysAgo(20), w.bob);
  const bot = mkUser('robot', 1);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(w.sid, bot);
  const ins = (await get(`/api/servers/${w.sid}/insights?days=30`, w.owner)).data.insights;
  assert.equal(ins.members.total, 3);
  assert.equal(ins.members.joinedByDay.find((d) => d.day === daysAgo(2).slice(0, 10)).count, 1);
  assert.equal(ins.members.joinedByDay.find((d) => d.day === daysAgo(20).slice(0, 10)).count, 1);
  assert.equal(ins.members.joinedLast7 >= 1, true);
});

test('only members with Manage Server can read insights, and results are cached briefly', async () => {
  const w = world();
  assert.equal((await get(`/api/servers/${w.sid}/insights`, w.ann)).status, 403);
  assert.equal((await get(`/api/servers/${w.sid}/insights`, mkUser('stranger'))).status, 403);
  say('channel', w.general, w.ann, daysAgo(0));
  const first = (await get(`/api/servers/${w.sid}/insights?days=7`, w.owner)).data.insights;
  say('channel', w.general, w.ann, daysAgo(0));
  const cached = (await get(`/api/servers/${w.sid}/insights?days=7`, w.owner)).data.insights;
  assert.equal(cached.messages.total, first.messages.total);
  insights._reset();
  assert.equal((await get(`/api/servers/${w.sid}/insights?days=7`, w.owner)).data.insights.messages.total, first.messages.total + 1);
});
