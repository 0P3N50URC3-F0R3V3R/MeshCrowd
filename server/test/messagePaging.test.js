'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { listMessages } = require('../lib/messages');

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('listMessages pages forward with `after`, oldest-first, capped, and exactly complements `before`', () => {
  const ownerId = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('pager', 'pager@test.local', 'hash', 'pager').lastInsertRowid;
  const serverId = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run('S', ownerId, 'invp').lastInsertRowid;
  const channelId = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(serverId, 'general', 'public').lastInsertRowid;
  const ids = [];
  for (let i = 0; i < 12; i++) {
    ids.push(db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
      .run('channel', channelId, ownerId, `m${i}`).lastInsertRowid);
  }

  const next = listMessages('channel', channelId, { after: ids[3], limit: 5 });
  assert.deepEqual(next.map((m) => m.id), ids.slice(4, 9));

  const tail = listMessages('channel', channelId, { after: ids[8], limit: 50 });
  assert.deepEqual(tail.map((m) => m.id), ids.slice(9));

  assert.equal(listMessages('channel', channelId, { after: ids[11] }).length, 0);

  const prev = listMessages('channel', channelId, { before: ids[4], limit: 3 });
  assert.deepEqual(prev.map((m) => m.id), ids.slice(1, 4));
});
