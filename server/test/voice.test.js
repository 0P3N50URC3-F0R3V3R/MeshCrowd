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

test('modeOf is fixed at creation and cleared when the room empties', () => {
  assert.equal(voice.modeOf(401), null);
  voice.join(401, 1, 'sfu');
  assert.equal(voice.modeOf(401), 'sfu');
  voice.join(401, 2);
  assert.equal(voice.modeOf(401), 'sfu');
  voice.leave(401, 1);
  assert.equal(voice.modeOf(401), 'sfu');
  voice.leave(401, 2);
  assert.equal(voice.modeOf(401), null);

  voice.join(402, 3, 'sfu');
  voice.leaveAll(3);
  assert.equal(voice.modeOf(402), null);

  voice.join(403, 4);
  voice.setMode(403, 'mesh');
  assert.equal(voice.modeOf(403), 'mesh');
  voice.leaveAll(4);
  assert.equal(voice.modeOf(403), null);
});

test("join(room, user, 'sfu') on an existing mesh room keeps mesh", () => {
  voice.join(411, 1, 'mesh');
  voice.join(411, 2, 'sfu');
  assert.equal(voice.modeOf(411), 'mesh');
  voice.leaveAll(1);
  voice.leaveAll(2);
});

test('evict keeps force-mutes for a rejoin within the deadline and a later normal empty-out clears them', () => {
  voice.join(901, 1, 'sfu');
  voice.join(901, 2);
  voice.forceMute(901, 2);
  assert.deepEqual(voice.evict(901, 60_000).sort(), [1, 2]);
  assert.deepEqual(voice.participants(901), []);
  assert.equal(voice.modeOf(901), null);
  voice.join(901, 2, 'mesh');
  assert.equal(voice.isForceMuted(901, 2), true);
  voice.leave(901, 2);
  voice.join(901, 2);
  assert.equal(voice.isForceMuted(901, 2), false);
  voice.leave(901, 2);
});

test('force-mutes kept by evict expire: a room recreated after the deadline starts clean', () => {
  voice.join(902, 3);
  voice.forceMute(902, 3);
  voice.evict(902, -1);
  voice.join(902, 3);
  assert.equal(voice.isForceMuted(902, 3), false);
  voice.leave(902, 3);
  voice.join(902, 3);
  assert.equal(voice.isForceMuted(902, 3), false);
  voice.leave(902, 3);
});
