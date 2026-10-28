import test from 'node:test';
import assert from 'node:assert/strict';
import { roomKey, isJoinedTo, shouldKeepAlive, callBarModel } from './callRoom.mjs';

const voice = (o = {}) => ({ serverId: null, channelId: null, dmId: null, muted: false, ...o });

test('roomKey tells channels and DMs apart', () => {
  assert.equal(roomKey({ kind: 'channel', channelId: 7 }), 'ch:7');
  assert.equal(roomKey({ kind: 'dm', dmId: 3 }), 'dm:3');
  assert.equal(roomKey({ dmId: 3 }), 'dm:3');
});

test('isJoinedTo matches only the room the voice state points at', () => {
  assert.equal(isJoinedTo('ch:7', voice({ channelId: 7 })), true);
  assert.equal(isJoinedTo('ch:7', voice({ channelId: 8 })), false);
  assert.equal(isJoinedTo('dm:3', voice({ dmId: 3 })), true);
  assert.equal(isJoinedTo('dm:3', voice({ channelId: 3 })), false);
  assert.equal(isJoinedTo('ch:7', voice()), false);
  assert.equal(isJoinedTo(null, voice({ channelId: 7 })), false);
});

test('a room is only kept alive in the background while joined', () => {
  assert.equal(shouldKeepAlive('ch:7', voice({ channelId: 7 })), true);
  assert.equal(shouldKeepAlive('ch:7', voice()), false);
});

test('call bar shows only while joined and the room screen is not on top', () => {
  const v = voice({ channelId: 7, muted: true });
  assert.deepEqual(callBarModel({ key: 'ch:7', voice: v, screenVisible: false, label: 'talk' }), { label: 'talk', muted: true });
  assert.equal(callBarModel({ key: 'ch:7', voice: v, screenVisible: true, label: 'talk' }), null);
  assert.equal(callBarModel({ key: 'ch:7', voice: voice(), screenVisible: false, label: 'talk' }), null);
});
