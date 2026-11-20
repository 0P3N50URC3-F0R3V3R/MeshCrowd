import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTextFileName, textByteLength, MAX_TEXT_FILE_BYTES } from './longText.js';

test('safeTextFileName generates a name when none given', () => {
  assert.equal(safeTextFileName('', () => 'abc123'), 'message-abc123.txt');
  assert.equal(safeTextFileName('   ', () => 'zz'), 'message-zz.txt');
});

test('safeTextFileName strips paths and odd characters and forces a text extension', () => {
  assert.equal(safeTextFileName('readme'), 'readme.txt');
  assert.equal(safeTextFileName('README.md'), 'README.md');
  assert.equal(safeTextFileName('../../etc/passwd'), 'passwd.txt');
  assert.equal(safeTextFileName('evil.html'), 'evil.html.txt');
  assert.equal(safeTextFileName('a b<c>.exe'), 'a_b_c_.exe.txt');
  assert.equal(safeTextFileName('.hidden'), 'hidden.txt');
});

test('textByteLength counts UTF-8 bytes', () => {
  assert.equal(textByteLength('aé'), 3);
  assert.equal(MAX_TEXT_FILE_BYTES, 307200);
});

import { isMessageTooLong, adoptServerLimit } from './longText.js';

test('isMessageTooLong recognises the server error shape', () => {
  assert.equal(isMessageTooLong({ status: 400, body: { error: 'message too long', code: 'message_too_long', maxChars: 15000 } }), true);
  assert.equal(isMessageTooLong({ status: 413, body: { error: 'message too long' } }), true);
  assert.equal(isMessageTooLong({ status: 413, body: { error: 'file too large' } }), false);
  assert.equal(isMessageTooLong({ status: 400, body: { error: 'content is required' } }), false);
  assert.equal(isMessageTooLong(new Error('x')), false);
  assert.equal(isMessageTooLong(null), false);
});

test('adoptServerLimit takes the reported maxChars, else keeps the configured one', () => {
  const cfg = { maxMessageChars: 15000 };
  assert.equal(adoptServerLimit(cfg, { body: { maxChars: 8000 } }), 8000);
  assert.equal(cfg.maxMessageChars, 8000);
  assert.equal(adoptServerLimit(cfg, { body: {} }), 8000);
  assert.equal(adoptServerLimit({}, { body: { maxChars: 'x' } }), 15000);
});

import { createThreadAllowingLongText } from './longText.js';

test('createThreadAllowingLongText sends a normal post unchanged', async () => {
  const calls = [];
  const res = await createThreadAllowingLongText({
    createThread: async (b) => { calls.push(b); return { thread: { id: 1 } }; }, sendThreadMessage: async () => { throw new Error('no'); },
    config: { maxMessageChars: 100 }, title: 'T', content: 'hello', placeholder: 'P', askName: async () => 'x', tooLargeError: 'big',
  });
  assert.deepEqual(calls, [{ title: 'T', content: 'hello' }]);
  assert.equal(res.thread.id, 1);
});

test('createThreadAllowingLongText posts an over-length text as a file', async () => {
  const created = []; const sent = [];
  const long = 'a'.repeat(101);
  const res = await createThreadAllowingLongText({
    createThread: async (b) => { created.push(b); return { thread: { id: 7 } }; },
    sendThreadMessage: async (id, b) => { sent.push([id, b]); },
    config: { maxMessageChars: 100 }, title: 'T', content: long, placeholder: 'see file', askName: async () => 'notes', tooLargeError: 'big',
  });
  assert.deepEqual(created, [{ title: 'T', content: 'see file' }]);
  assert.equal(sent[0][0], 7);
  assert.equal(sent[0][1].files[0].name, 'notes.txt');
  assert.equal(await sent[0][1].files[0].text(), long);
  assert.equal(res.thread.id, 7);
});

test('createThreadAllowingLongText keeps the draft when the prompt is cancelled', async () => {
  let created = false;
  const res = await createThreadAllowingLongText({
    createThread: async () => { created = true; }, sendThreadMessage: async () => {},
    config: { maxMessageChars: 10 }, title: 'T', content: 'x'.repeat(11), placeholder: 'p', askName: async () => null, tooLargeError: 'big',
  });
  assert.equal(res, null);
  assert.equal(created, false);
});

test('createThreadAllowingLongText falls back to a file when the server limit is lower than configured', async () => {
  const created = []; const cfg = { maxMessageChars: 100 };
  const res = await createThreadAllowingLongText({
    createThread: async (b) => {
      created.push(b);
      if (b.content.length > 50) { const e = new Error('x'); e.status = 400; e.body = { code: 'message_too_long', maxChars: 50 }; throw e; }
      return { thread: { id: 3 } };
    },
    sendThreadMessage: async () => {}, config: cfg, title: 'T', content: 'y'.repeat(60), placeholder: 'p', askName: async () => '', tooLargeError: 'big',
  });
  assert.equal(cfg.maxMessageChars, 50);
  assert.equal(created.length, 2);
  assert.equal(res.thread.id, 3);
});

test('createThreadAllowingLongText refuses text beyond the file limit', async () => {
  await assert.rejects(createThreadAllowingLongText({
    createThread: async () => {}, sendThreadMessage: async () => {},
    config: { maxMessageChars: 10 }, title: 'T', content: 'z'.repeat(MAX_TEXT_FILE_BYTES + 1), placeholder: 'p', askName: async () => 'n', tooLargeError: 'big',
  }), /big/);
});
