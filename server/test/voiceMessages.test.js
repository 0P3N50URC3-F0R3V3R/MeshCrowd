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
const voice = require('../lib/voiceMessages');

let n = 0;
const mkUser = (name) => Number(db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(`${name}${++n}`, `${name}${n}@t.local`, 'h', name).lastInsertRowid);
const mkServer = (owner) => {
  const id = Number(db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)').run('Srv', owner, `i${Math.random().toString(36).slice(2, 10)}`).lastInsertRowid);
  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(id, owner);
  db.prepare('INSERT INTO roles (server_id, name, permissions, position, is_default) VALUES (?, ?, ?, 0, 1)').run(id, '@everyone', PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.ATTACH_FILES);
  return id;
};
const mkChannel = (sid) => Number(db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(sid, 'general', 'public').lastInsertRowid);

let server; let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-uid']);
    if (uid) { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid); req.sitePermissions = 0; }
    next();
  });
  app.use('/api/servers/:id/channels/:channelId/messages', require('../routes/channelMessages'));
  await new Promise((r) => { server = http.createServer(app).listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close(); db.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function world() {
  const owner = mkUser('owner');
  const sid = mkServer(owner);
  return { owner, sid, ch: mkChannel(sid) };
}
async function send(w, { duration, files = [{ name: 'voice-message.webm', type: 'audio/webm;codecs=opus', bytes: 2000 }], content = '' }) {
  const fd = new FormData();
  fd.append('content', content);
  if (duration !== undefined) fd.append('voiceDurationMs', String(duration));
  for (const f of files) fd.append('files', new Blob([Buffer.alloc(f.bytes, 1)], { type: f.type }), f.name);
  const res = await fetch(`${base}/api/servers/${w.sid}/channels/${w.ch}/messages`, { method: 'POST', headers: { 'x-uid': String(w.owner) }, body: fd });
  return { status: res.status, data: await res.json() };
}

test('parseVoiceUpload: ordinary messages pass through, voice ones are validated', () => {
  const file = (o = {}) => ({ mimetype: 'audio/webm;codecs=opus', size: 1000, ...o });
  assert.equal(voice.parseVoiceUpload({}, [file()]), null);
  assert.equal(voice.parseVoiceUpload({ voiceDurationMs: '' }, []), null);
  assert.equal(voice.parseVoiceUpload({ voiceDurationMs: '4200' }, [file()]), 4200);
  const bad = (body, files) => assert.throws(() => voice.parseVoiceUpload(body, files), voice.VoiceMessageError);
  bad({ voiceDurationMs: '4200' }, []);
  bad({ voiceDurationMs: '4200' }, [file(), file()]);
  bad({ voiceDurationMs: '4200' }, [file({ mimetype: 'image/png' })]);
  bad({ voiceDurationMs: '4200' }, [file({ mimetype: 'video/webm' })]);
  bad({ voiceDurationMs: '4200' }, [file({ size: voice.MAX_BYTES + 1 })]);
  bad({ voiceDurationMs: '100' }, [file()]);
  bad({ voiceDurationMs: String(voice.MAX_DURATION_MS + 1) }, [file()]);
  bad({ voiceDurationMs: '12.5' }, [file()]);
  bad({ voiceDurationMs: 'abc' }, [file()]);
});

test('a voice message is stored with its length, a clean mime type and no text', async () => {
  const w = world();
  const res = await send(w, { duration: 7300 });
  assert.equal(res.status, 201);
  const att = res.data.message.attachments[0];
  assert.equal(att.voiceMs, 7300);
  assert.equal(att.mimeType, 'audio/webm');
  assert.equal(res.data.message.content, '');
  const row = db.prepare('SELECT * FROM attachments WHERE message_id = ?').get(res.data.message.id);
  assert.equal(row.voice_ms, 7300);
  assert.ok(fs.existsSync(path.join(tmpDir, row.file_path.replace('/uploads/', ''))));
});

test('invalid voice uploads are refused and leave no file behind', async () => {
  const w = world();
  const dir = path.join(tmpDir, 'attachments', `channel-${w.ch}`);
  const before = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
  const start = before();
  assert.equal((await send(w, { duration: 7300, files: [{ name: 'a.png', type: 'image/png', bytes: 100 }] })).status, 400);
  assert.equal((await send(w, { duration: 7300, files: [] })).status, 400);
  assert.equal((await send(w, { duration: 50 })).status, 400);
  assert.equal((await send(w, { duration: 7300, files: [{ name: 'a.webm', type: 'audio/webm', bytes: 10 }, { name: 'b.webm', type: 'audio/webm', bytes: 10 }] })).status, 400);
  assert.equal(before(), start, 'refused uploads are deleted again');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE scope_id = ?').get(w.ch).n, 0);
});

test('an audio file sent without a duration is just an attachment, not a voice message', async () => {
  const w = world();
  const res = await send(w, { files: [{ name: 'song.webm', type: 'audio/webm', bytes: 500 }], content: 'my song' });
  assert.equal(res.status, 201);
  assert.equal(res.data.message.attachments[0].voiceMs, null);
});
