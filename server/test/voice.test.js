'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const voice = require('../socket/voice');

test('join/leave tracks participants per channel', () => {
  voice.join(101, 1);
  voice.join(101, 2);
  assert.deepEqual(voice.participants(101).sort(), [1, 2]);
  assert.equal(voice.isParticipant(101, 1), true);
  assert.equal(voice.isParticipant(101, 3), false);

  voice.leave(101, 1);
  assert.deepEqual(voice.participants(101), [2]);

  voice.leave(101, 2);
  assert.deepEqual(voice.participants(101), []);
});

test('leaveAll removes a user from every room they were in and reports affected channels', () => {
  voice.join(201, 5);
  voice.join(202, 5);
  voice.join(202, 6);

  const affected = voice.leaveAll(5).sort();
  assert.deepEqual(affected, [201, 202]);
  assert.equal(voice.isParticipant(201, 5), false);
  assert.deepEqual(voice.participants(202), [6]);
});

test('leaveAll on a user with no rooms returns an empty list', () => {
  assert.deepEqual(voice.leaveAll(999), []);
});

test('inOtherRoom detects membership in a different room only', () => {
  voice.join(301, 7);
  assert.equal(voice.inOtherRoom(301, 7), false);
  assert.equal(voice.inOtherRoom(302, 7), true);
  assert.equal(voice.inOtherRoom('dm:1', 8), false);
  voice.leaveAll(7);
});
