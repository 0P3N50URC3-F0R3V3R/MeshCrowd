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
const { PERMISSIONS, SITE_PERMISSIONS } = require('../lib/permissions');
const hub = require('../socket/hub');

hub.broadcastToChannel = () => {};
hub.broadcastToDm = () => {};

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);

let w; let server; let base; const sitePerms = {};
test.before(async () => {
  const owner = mkUser('owner');
  const sid = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, 'inv-edit').lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(sid, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES);
  const editorRole = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 1)').run(sid, 'Editor', PERMISSIONS.EDIT_MESSAGES).lastInsertRowid);
  const adminRole = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 2)').run(sid, 'Admin', PERMISSIONS.ADMINISTRATOR).lastInsertRowid);
  const modRole = Number(db.prepare('INSERT INTO roles (server_id, name, permissions, position) VALUES (?, ?, ?, 3)').run(sid, 'Mod', PERMISSIONS.MANAGE_MESSAGES).lastInsertRowid);
  const ch = Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'general', 'text').lastInsertRowid);
  const mk = (name, role) => {
    const id = mkUser(name);
    db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(sid, id);
    if (role) db.prepare('INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(sid, id, role);
    return id;
  };
  const author = mk('author'); const other = mk('other'); const editor = mk('editor', editorRole);
  const admin = mk('admin', adminRole); const mod = mk('mod', modRole); const siteEditor = mk('siteeditor');
  sitePerms[siteEditor] = SITE_PERMISSIONS.EDIT_ANY_MESSAGE;
  w = { sid, ch, owner, author, other, editor, admin, mod, siteEditor };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = sitePerms[uid] || 0; }
    next();
  });
  app.use('/api/messages', require('../routes/messages'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const call = async (method, url, uid, json) => {
  const res = await fetch(base + url, { method, headers: { 'x-uid': String(uid), 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const post = (authorId) => Number(db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)').run('channel', w.ch, authorId, 'orig').lastInsertRowid);

test('plain members and MANAGE_MESSAGES holders cannot edit others', async () => {
  const id = post(w.author);
  assert.equal((await call('PATCH', `/api/messages/${id}`, w.other, { content: 'x' })).status, 403);
  assert.equal((await call('PATCH', `/api/messages/${id}`, w.mod, { content: 'x' })).status, 403);
});

test('EDIT_MESSAGES role, server administrator, owner and site EDIT_ANY_MESSAGE can edit and are credited', async () => {
  for (const [who, name] of [[w.editor, 'editor'], [w.admin, 'admin'], [w.owner, 'owner'], [w.siteEditor, 'siteeditor']]) {
    const id = post(w.author);
    const res = await call('PATCH', `/api/messages/${id}`, who, { content: `by ${name}` });
    assert.equal(res.status, 200, name);
    assert.equal(res.data.message.content, `by ${name}`);
    assert.equal(res.data.message.editedBy.id, who);
    assert.equal(res.data.message.author.id, w.author);
  }
});

test('the author editing again clears the editor credit and gets no editedBy', async () => {
  const id = post(w.author);
  await call('PATCH', `/api/messages/${id}`, w.editor, { content: 'edited by editor' });
  const res = await call('PATCH', `/api/messages/${id}`, w.author, { content: 'back' });
  assert.equal(res.data.message.editedBy, null);
  assert.ok(res.data.message.editedAt);
});

test('self edits carry no editedBy and DMs stay author-only even for site editors', async () => {
  const own = post(w.author);
  assert.equal((await call('PATCH', `/api/messages/${own}`, w.author, { content: 'mine' })).data.message.editedBy, null);

  const dm = Number(db.prepare('INSERT INTO dm_channels (is_group, created_by) VALUES (0, ?)').run(w.author).lastInsertRowid);
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dm, w.author);
  db.prepare('INSERT INTO dm_members (dm_channel_id, user_id) VALUES (?, ?)').run(dm, w.other);
  const dmMsg = Number(db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)').run('dm', dm, w.author, 'secret').lastInsertRowid);
  assert.equal((await call('PATCH', `/api/messages/${dmMsg}`, w.siteEditor, { content: 'hax' })).status, 403);
  assert.equal((await call('PATCH', `/api/messages/${dmMsg}`, w.other, { content: 'hax' })).status, 403);
});
