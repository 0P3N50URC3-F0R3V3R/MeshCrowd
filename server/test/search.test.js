'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const { db } = require('../db');
const { buildFtsQuery, searchMessages } = require('../lib/search');

function makeUser(username) {
  return db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, `${username}@test.local`, 'hash', username).lastInsertRowid;
}
function makeMessage(scopeType, scopeId, authorId, content) {
  return db.prepare('INSERT INTO messages (scope_type, scope_id, author_id, content) VALUES (?, ?, ?, ?)')
    .run(scopeType, scopeId, authorId, content).lastInsertRowid;
}

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('buildFtsQuery quotes each term as a prefix match, neutralizing FTS operators', () => {
  assert.equal(buildFtsQuery('hello world'), '"hello"* "world"*');
  assert.equal(buildFtsQuery('  '), null);
  assert.equal(buildFtsQuery(''), null);
  // A raw NOT/AND/OR or a bare quote would otherwise be interpreted as FTS5 query syntax.
  assert.equal(buildFtsQuery('NOT "quoted'), '"NOT"* """quoted"*');
});

test('search finds a message by a whole word and by prefix, stays scoped to the given ids', () => {
  const userId = makeUser('search1');
  makeMessage('channel', 1, userId, 'the quick brown fox jumps');
  makeMessage('channel', 1, userId, 'nothing relevant here');
  makeMessage('channel', 2, userId, 'a fox in a different channel');

  const inChannel1 = searchMessages('channel', [1], 'fox');
  assert.equal(inChannel1.length, 1);
  assert.match(inChannel1[0].content, /quick brown fox/);

  const prefix = searchMessages('channel', [1], 'jum');
  assert.equal(prefix.length, 1);

  const acrossBoth = searchMessages('channel', [1, 2], 'fox');
  assert.equal(acrossBoth.length, 2);

  const excluded = searchMessages('channel', [1], 'different');
  assert.equal(excluded.length, 0, 'channel 2 content must not leak into a channel-1-only search');
});

test('editing a message updates the index; deleting removes it', () => {
  const userId = makeUser('search2');
  const msgId = makeMessage('channel', 3, userId, 'original wording');
  assert.equal(searchMessages('channel', [3], 'original').length, 1);

  db.prepare("UPDATE messages SET content = ? WHERE id = ?").run('completely different wording', msgId);
  assert.equal(searchMessages('channel', [3], 'original').length, 0, 'stale content must not still match after edit');
  assert.equal(searchMessages('channel', [3], 'different').length, 1);

  db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
  assert.equal(searchMessages('channel', [3], 'different').length, 0, 'deleted message must drop out of the index');
});

test('search returns nothing for an empty query or an empty scope list', () => {
  const userId = makeUser('search3');
  makeMessage('channel', 4, userId, 'some content');
  assert.deepEqual(searchMessages('channel', [4], ''), []);
  assert.deepEqual(searchMessages('channel', [], 'content'), []);
});

test('mentions field matches @username tokens only, not plain text or longer names', () => {
  const userId = makeUser('search4');
  makeMessage('channel', 5, userId, 'hey @alexander check this');
  makeMessage('channel', 5, userId, 'alexander said hi');
  makeMessage('channel', 5, userId, 'ping @alexanderthegreat');
  makeMessage('channel', 5, userId, 'mail me at bob@alexander.com');

  const hits = searchMessages('channel', [5], 'alexander', { fields: { mentions: true } });
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /^hey @alexander/);
  assert.equal(searchMessages('channel', [5], '@Alexander', { fields: { mentions: true } }).length, 1, 'leading @ and case are ignored');
  assert.equal(searchMessages('channel', [5], 'alexander', { fields: { text: true } }).length, 4, 'text field unaffected');
});
