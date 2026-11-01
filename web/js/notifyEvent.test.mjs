import test from 'node:test';
import assert from 'node:assert/strict';
import { eventNotice, entryTarget } from './notifyEvent.mjs';

const t = (key, p = {}) => `${key}|${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',')}`;
const base = { actor: { displayName: 'Peter' }, scopeType: 'channel', scopeId: 4, serverId: 2, serverName: 'Dev', channelName: 'general', message: { id: 9, content: 'hello' } };

test('plain messages are not events', () => {
  assert.equal(eventNotice({ ...base, actor: undefined }, t), null);
});

test('pin in a channel names the actor and the channel', () => {
  const n = eventNotice({ ...base, kind: 'pin' }, t);
  assert.equal(n.title, 'shell.notifyPinned|name=Peter,channel=general (Dev)');
  assert.equal(n.body, 'hello');
});

test('pin in a DM has no channel and hides encrypted text', () => {
  const n = eventNotice({ ...base, kind: 'pin', scopeType: 'dm', message: { id: 1, content: 'ciphertext', isEncrypted: true } }, t);
  assert.equal(n.title, 'shell.notifyPinnedDm|name=Peter');
  assert.equal(n.body, '');
});

test('thread start shows the thread title', () => {
  const n = eventNotice({ ...base, kind: 'thread', threadId: 7, threadTitle: 'Side talk' }, t);
  assert.equal(n.title, 'shell.notifyThreadStarted|name=Peter (Dev)');
  assert.equal(n.body, 'Side talk');
});

test('entryTarget opens the thread or jumps to the message', () => {
  assert.deepEqual(entryTarget({ scopeType: 'channel', scopeId: 4, serverId: 2 }), { type: 'server', serverId: 2, channelId: 4 });
  assert.deepEqual(entryTarget({ scopeType: 'channel', scopeId: 4, serverId: 2, threadId: 7, messageId: 9 }), { type: 'server', serverId: 2, channelId: 4, threadId: 7, jumpToMessageId: 9 });
  assert.deepEqual(entryTarget({ scopeType: 'dm', scopeId: 3, messageId: 5 }), { type: 'dm', dmId: 3, jumpToMessageId: 5 });
  assert.deepEqual(entryTarget({ scopeType: 'friends', scopeId: 'pending' }), { type: 'friends', tab: 'pending' });
});

test('pinning a sticker-only message says it was a sticker', () => {
  const n = eventNotice({ ...base, kind: 'pin', message: { id: 3, content: '', sticker: { id: 1, name: 'wave' } } }, t);
  assert.equal(n.body, 'sidebar.sentASticker|');
});
