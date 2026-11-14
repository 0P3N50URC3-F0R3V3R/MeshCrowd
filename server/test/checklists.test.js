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
const { PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS } = require('../lib/permissions');

const mkUser = (n) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
  .run(n, `${n}@t.local`, 'h', n).lastInsertRowid);

function mkServer(owner, members, type = 'public') {
  const sid = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('S', owner, `i${Math.random()}`).lastInsertRowid);
  const everyone = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(sid, '@everyone', DEFAULT_EVERYONE_PERMISSIONS).lastInsertRowid);
  for (const u of [owner, ...members]) db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, u);
  const cid = Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'c', type).lastInsertRowid);
  return { sid, cid, everyone };
}
function grant(sid, userId, bits) {
  const rid = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 1)').run(sid, `r${Math.random()}`, bits).lastInsertRowid);
  db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, userId, rid);
}
function mkDm(users, isGroup = 0, e2ee = 0) {
  const id = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by, e2ee_enabled) VALUES (?, ?, ?)').run(isGroup, users[0], e2ee).lastInsertRowid);
  for (const u of users) db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(id, u);
  return id;
}

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    next();
  });
  app.use('/api/checklists', require('../routes/checklists'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method, url, uid, json) {
  const headers = { 'x-uid': String(uid) };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data };
}
const body = (scopeType, scopeId, extra = {}) => ({ scopeType, scopeId, title: 'Shopping', items: ['milk', 'eggs'], ...extra });

test('public channel: plain member cannot create, member with CREATE_CHECKLISTS or mod can', async () => {
  const owner = mkUser('c1_owner'); const plain = mkUser('c1_plain'); const granted = mkUser('c1_granted'); const mod = mkUser('c1_mod');
  const { sid, cid } = mkServer(owner, [plain, granted, mod]);
  grant(sid, granted, PERMISSIONS.CREATE_CHECKLISTS);
  grant(sid, mod, PERMISSIONS.MANAGE_MESSAGES);
  assert.equal((await call('POST', '/api/checklists', plain, body('channel', cid))).status, 403);
  assert.equal((await call('POST', '/api/checklists', granted, body('channel', cid))).status, 201);
  assert.equal((await call('POST', '/api/checklists', mod, body('channel', cid))).status, 201);
  assert.equal((await call('POST', '/api/checklists', owner, body('channel', cid))).status, 201);
});

test('private channel and DMs: any member creates; e2ee DM refused; non-member refused', async () => {
  const a = mkUser('c2_a'); const b = mkUser('c2_b'); const outsider = mkUser('c2_o');
  const { cid } = mkServer(a, [b], 'private');
  assert.equal((await call('POST', '/api/checklists', b, body('channel', cid))).status, 403, 'private channel hides it from members without explicit view');
  db.prepare('INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, 0)').run(cid, b, PERMISSIONS.VIEW_CHANNEL);
  assert.equal((await call('POST', '/api/checklists', b, body('channel', cid))).status, 201, 'invited private-channel member needs no CREATE_CHECKLISTS');
  const dm = mkDm([a, b]); const group = mkDm([a, b, outsider], 1); const enc = mkDm([a, b], 0, 1);
  assert.equal((await call('POST', '/api/checklists', b, body('dm', dm))).status, 201);
  assert.equal((await call('POST', '/api/checklists', b, body('dm', group))).status, 201);
  assert.equal((await call('POST', '/api/checklists', b, body('dm', enc))).status, 403);
  const lone = mkDm([a, b]);
  assert.equal((await call('POST', '/api/checklists', outsider, body('dm', lone))).status, 403);
});

test('validation: title, item count, duplicates trimmed', async () => {
  const a = mkUser('c3_a'); const b = mkUser('c3_b'); const dm = mkDm([a, b]);
  assert.equal((await call('POST', '/api/checklists', a, body('dm', dm, { title: '  ' }))).status, 400);
  assert.equal((await call('POST', '/api/checklists', a, body('dm', dm, { items: [] }))).status, 400);
  assert.equal((await call('POST', '/api/checklists', a, body('dm', dm, { items: Array.from({ length: 51 }, (_, i) => `i${i}`) }))).status, 400);
  const ok = await call('POST', '/api/checklists', a, body('dm', dm, { items: ['x', ' ', 'y'] }));
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.data.message.checklist.items.map((i) => i.label), ['x', 'y']);
  assert.equal(ok.data.message.checklist.allChecked, false);
});

test('levels: stranger none, check helper ticks only, edit helper edits, only creator sets helpers', async () => {
  const a = mkUser('c4_a'); const chk = mkUser('c4_chk'); const ed = mkUser('c4_ed'); const none = mkUser('c4_none');
  const dm = mkDm([a, chk, ed, none], 1);
  const created = await call('POST', '/api/checklists', a, body('dm', dm, { editors: [{ userId: chk, level: 'check' }, { userId: ed, level: 'edit' }] }));
  const list = created.data.message.checklist; const [i1, i2] = list.items;
  const L = `/api/checklists/${list.id}`;
  assert.equal((await call('PUT', `${L}/items/${i1.id}/check`, none)).status, 403);
  assert.equal((await call('PUT', `${L}/items/${i1.id}/check`, chk)).status, 200);
  assert.equal((await call('POST', `${L}/items`, chk, { label: 'z' })).status, 403);
  assert.equal((await call('PUT', `${L}/editors`, ed, { editors: [] })).status, 403);
  assert.equal((await call('POST', `${L}/items`, ed, { label: 'z' })).status, 200);
  assert.equal((await call('PATCH', `${L}`, ed, { title: 'Groceries' })).data.message.content, 'Groceries');
  const done = await call('PUT', `${L}/items/${i2.id}/check`, a);
  assert.equal(done.data.message.checklist.items.find((i) => i.id === i2.id).checked, true);
  assert.equal(done.data.message.checklist.allChecked, false, 'the added item is still open');
  const un = await call('DELETE', `${L}/items/${i1.id}/check`, a);
  assert.equal(un.data.message.checklist.items.find((i) => i.id === i1.id).checked, false);
});

test('all items checked flips allChecked; delete/reorder/rename rules', async () => {
  const a = mkUser('c5_a'); const b = mkUser('c5_b'); const dm = mkDm([a, b]);
  const c = (await call('POST', '/api/checklists', a, body('dm', dm))).data.message.checklist;
  const L = `/api/checklists/${c.id}`;
  for (const i of c.items) await call('PUT', `${L}/items/${i.id}/check`, a);
  const [i1, i2] = c.items;
  assert.equal((await call('PUT', `${L}/items/${i1.id}/check`, a)).data.message.checklist.allChecked, true);
  assert.equal((await call('PUT', `${L}/order`, a, { itemIds: [i2.id, i1.id] })).data.message.checklist.items[0].id, i2.id);
  assert.equal((await call('PUT', `${L}/order`, a, { itemIds: [i2.id, 99999] })).status, 400);
  assert.equal((await call('PUT', `${L}/order`, a, { itemIds: [i2.id] })).status, 400);
  assert.equal((await call('PATCH', `${L}/items/${i1.id}`, a, { label: 'oat milk' })).data.message.checklist.items.find((i) => i.id === i1.id).label, 'oat milk');
  assert.equal((await call('DELETE', `${L}/items/${i1.id}`, a)).status, 200);
  assert.equal((await call('DELETE', `${L}/items/${i2.id}`, a)).status, 400, 'last item cannot be removed');
});

test('helpers must be able to view the scope; helper who left the DM can no longer act', async () => {
  const a = mkUser('c6_a'); const b = mkUser('c6_b'); const out = mkUser('c6_out');
  const dm = mkDm([a, b]);
  assert.equal((await call('POST', '/api/checklists', a, body('dm', dm, { editors: [{ userId: out, level: 'check' }] }))).status, 400);
  const c = (await call('POST', '/api/checklists', a, body('dm', dm, { editors: [{ userId: b, level: 'check' }] }))).data.message.checklist;
  db.prepare('DELETE FROM dm_members WHERE dm_channel_id = ? AND user_id = ?').run(dm, b);
  assert.equal((await call('PUT', `/api/checklists/${c.id}/items/${c.items[0].id}/check`, b)).status, 403);
});

test('deleted message hides its checklist; unknown ids 404', async () => {
  const a = mkUser('c7_a'); const b = mkUser('c7_b'); const dm = mkDm([a, b]);
  const m = (await call('POST', '/api/checklists', a, body('dm', dm))).data.message;
  db.prepare("UPDATE messages SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(m.id);
  assert.equal((await call('PUT', `/api/checklists/${m.checklist.id}/items/${m.checklist.items[0].id}/check`, a)).status, 404);
  assert.equal((await call('PATCH', '/api/checklists/99999', a, { title: 'x' })).status, 404);
});
