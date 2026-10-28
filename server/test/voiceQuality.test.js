'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { VOICE_QUALITIES, DEFAULT_VOICE_QUALITY } = require('../lib/voiceQuality');

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('server preset ids match the client preset table', async () => {
  const web = await import('../../web/js/voiceQuality.js');
  assert.deepEqual([...VOICE_QUALITIES], web.VOICE_QUALITY_IDS);
  assert.equal(DEFAULT_VOICE_QUALITY, web.DEFAULT_VOICE_QUALITY);
});

test('channels default to medium voice quality', () => {
  const owner = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run('vq', 'vq@test.local', 'h', 'vq').lastInsertRowid;
  const serverId = db.prepare('INSERT INTO servers (name, owner_id) VALUES (?, ?)').run('s', owner).lastInsertRowid;
  const id = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, 'v', 'voice').lastInsertRowid;
  assert.equal(db.prepare('SELECT voice_quality FROM channels WHERE id = ?').get(id).voice_quality, 'medium');
});
