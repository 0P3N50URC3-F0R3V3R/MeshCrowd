import test from 'node:test';
import assert from 'node:assert/strict';
import { friendVoiceView } from './friendVoice.mjs';

test('full entry is navigable', () => {
  assert.deepEqual(friendVoiceView({ id: 3, name: 'lounge', serverId: 2, serverName: 'Home' }), { generic: false, channelId: 3, serverId: 2, name: 'lounge', serverName: 'Home' });
});

test('entry without server name keeps an empty one', () => {
  assert.equal(friendVoiceView({ id: 3, name: 'lounge', serverId: 2 }).serverName, '');
});

test('generic or malformed entries never yield undefined fields', () => {
  for (const ch of [undefined, null, {}, { generic: true }, { hidden: true }, { name: 'x' }, { id: 1, serverId: 1 }, { id: 'a', name: 'n', serverId: 1 }]) {
    assert.deepEqual(friendVoiceView(ch), { generic: true });
  }
});
