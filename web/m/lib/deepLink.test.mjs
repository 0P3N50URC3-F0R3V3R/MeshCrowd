import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLink } from './deepLink.mjs';

test('parseDeepLink: dm, channel and thread links with optional message ids', () => {
  assert.deepEqual(parseDeepLink('#open=dm:11:60'), { kind: 'dm', dmId: 11, jumpToMessageId: 60 });
  assert.deepEqual(parseDeepLink('#open=dm:11'), { kind: 'dm', dmId: 11, jumpToMessageId: undefined });
  assert.deepEqual(parseDeepLink('#open=channel:2:3:50'), { kind: 'channel', serverId: 2, channelId: 3, jumpToMessageId: 50 });
  assert.deepEqual(parseDeepLink('#open=thread:2:3:9:70'), { kind: 'thread', serverId: 2, channelId: 3, threadId: 9, jumpToMessageId: 70 });
});

test('parseDeepLink: anything else is ignored', () => {
  for (const bad of ['', '#', '#open=', '#open=dm:abc', '#open=channel:1', '#open=nope:1:2', '#msg=channel:1:2:3', '#open=dm:1:2:3', 'open=dm:1', null, undefined]) {
    assert.equal(parseDeepLink(bad), null, String(bad));
  }
});
