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

const { db, migrateNotifyGrid } = require('../db');
const grid = require('../lib/notifyGrid');
const { toPublicUser } = require('../lib/publicUser');

const mkUser = (n, mode = 'auto') => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name, notify_sound_mode) VALUES (?, ?, ?, ?, ?)').run(n, `${n}@t.local`, 'h', n, mode).lastInsertRowid);
const row = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

let httpServer; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = row(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/users', require('../routes/users'));
  httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${httpServer.address().port}`;
});
test.after(() => { httpServer.close(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const call = async (method, url, uid, body) => {
  const res = await fetch(base + url, { method, headers: { 'x-uid': String(uid), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('an unedited user sees exactly the defaults on their own object and not on others', () => {
  const id = mkUser('ng_plain');
  assert.deepEqual(toPublicUser(row(id), { viewerIsSelf: true }).notifyGrid, grid.defaults());
  assert.equal(toPublicUser(row(id), { viewerIsSelf: false }).notifyGrid, undefined);
  assert.equal(toPublicUser(row(id), { viewerIsSelf: true }).notifySoundMode, undefined);
});

test('a partial grid is stored, merged over the defaults and returned in full', async () => {
  const id = mkUser('ng_edit');
  const r = await call('PUT', '/api/users/me/notify-grid', id, { grid: { dnd: { dmMention: { sound: true } } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.notifyGrid.dnd.dmMention.sound, true);
  assert.equal(r.json.notifyGrid.dnd.dmMessage.sound, false);
  const r2 = await call('PUT', '/api/users/me/notify-grid', id, { grid: { idle: { thread: { tray: false } } } });
  assert.equal(r2.json.notifyGrid.dnd.dmMention.sound, true, 'earlier edits are kept');
  assert.equal(r2.json.notifyGrid.idle.thread.tray, false);
  assert.deepEqual(toPublicUser(row(id), { viewerIsSelf: true }).notifyGrid, r2.json.notifyGrid);
});

test('hostile or malformed bodies are rejected and change nothing', async () => {
  const id = mkUser('ng_bad');
  await call('PUT', '/api/users/me/notify-grid', id, { grid: { dnd: { dmMessage: { popup: false } } } });
  const before = row(id).notify_grid;
  for (const body of [{}, { grid: null }, { grid: [] }, { grid: { foo: {} } }, { grid: { dnd: { nope: {} } } }, { grid: { dnd: { dmMessage: { sound: 'yes' } } } }, { grid: { dnd: { call: { android: true } } } }, { reset: 'nope' }]) {
    const r = await call('PUT', '/api/users/me/notify-grid', id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(row(id).notify_grid, before);
  }
});

test('reset restores one status or everything', async () => {
  const id = mkUser('ng_reset');
  await call('PUT', '/api/users/me/notify-grid', id, { grid: { dnd: { dmMessage: { popup: false } }, online: { call: { sound: false } } } });
  const one = await call('PUT', '/api/users/me/notify-grid', id, { reset: 'dnd' });
  assert.equal(one.json.notifyGrid.dnd.dmMessage.popup, true);
  assert.equal(one.json.notifyGrid.online.call.sound, false);
  const all = await call('PUT', '/api/users/me/notify-grid', id, { reset: 'all' });
  assert.deepEqual(all.json.notifyGrid, grid.defaults());
  assert.equal(row(id).notify_grid, null);
});

test('the old sound mode is still accepted by the status route and ignored', async () => {
  const id = mkUser('ng_old');
  const r = await call('PUT', '/api/users/me/status', id, { notifySoundMode: 'never' });
  assert.equal(r.status, 200);
  assert.equal(row(id).notify_grid, null);
  assert.equal((await call('PUT', '/api/users/me/status', id, { notifySoundMode: 'bogus', status: 'dnd' })).status, 200);
  assert.equal(row(id).status, 'dnd');
});

test('the one-time migration keeps each user\'s old sound behavior', () => {
  const never = mkUser('ng_never', 'never');
  const always = mkUser('ng_always', 'always');
  const auto = mkUser('ng_auto', 'auto');
  db.prepare("DELETE FROM meta WHERE key = 'notify_grid_migrated'").run();
  migrateNotifyGrid();
  const n = grid.effective(JSON.parse(row(never).notify_grid));
  const a = grid.effective(JSON.parse(row(always).notify_grid));
  for (const s of grid.STATUSES) for (const e of grid.EVENTS) {
    assert.equal(n[s][e].sound, false);
    assert.equal(a[s][e].sound, true);
  }
  assert.equal(row(auto).notify_grid, null);
  db.prepare('UPDATE users SET notify_sound_mode = ? WHERE id = ?').run('never', auto);
  migrateNotifyGrid();
  assert.equal(row(auto).notify_grid, null, 'runs only once');
});
