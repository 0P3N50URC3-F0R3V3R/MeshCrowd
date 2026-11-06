'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../lib/notifyGrid');

test('statuses, events and surfaces are fixed and ordered', () => {
  assert.deepEqual(g.STATUSES, ['online', 'idle', 'dnd', 'invisible']);
  assert.deepEqual(g.EVENTS, ['dmMessage', 'dmMention', 'channelMessage', 'channelMention', 'thread', 'call', 'friend', 'pinReminder']);
  assert.deepEqual(g.SURFACES, ['sound', 'popup', 'tray', 'android']);
});

test('defaults reproduce today: busy and invisible are silent, everything else on', () => {
  const d = g.defaults();
  for (const s of g.STATUSES) for (const e of g.EVENTS) for (const f of g.SURFACES) {
    const expected = !((s === 'dnd' || s === 'invisible') && f === 'sound');
    assert.equal(d[s][e][f], expected, `${s}.${e}.${f}`);
  }
});

test('effective merges overrides over the defaults without touching the rest', () => {
  assert.deepEqual(g.effective(null), g.defaults());
  const e = g.effective({ dnd: { dmMention: { sound: true } } });
  assert.equal(e.dnd.dmMention.sound, true);
  assert.equal(e.dnd.dmMessage.sound, false);
  assert.equal(e.online.dmMention.sound, true);
  assert.notEqual(g.effective(null), g.effective(null));
});

test('validate accepts partial grids and rejects anything unknown or not boolean', () => {
  assert.deepEqual(g.validate({}), {});
  assert.deepEqual(g.validate({ dnd: { dmMessage: { popup: false } } }), { dnd: { dmMessage: { popup: false } } });
  for (const bad of [null, [], 'x', { foo: {} }, { dnd: { nope: {} } }, { dnd: { dmMessage: { nope: true } } }, { dnd: { dmMessage: { sound: 'yes' } } }, { dnd: { call: { android: true } } }, { dnd: { dmMessage: true } }]) {
    assert.throws(() => g.validate(bad), Error, JSON.stringify(bad));
  }
});

test('the sound mode of earlier versions migrates without changing anyone\'s behavior', () => {
  assert.equal(g.migrateSoundMode('auto'), null);
  assert.equal(g.migrateSoundMode(undefined), null);
  const never = g.effective(g.migrateSoundMode('never'));
  const always = g.effective(g.migrateSoundMode('always'));
  for (const s of g.STATUSES) for (const e of g.EVENTS) {
    assert.equal(never[s][e].sound, false, `never ${s}.${e}`);
    assert.equal(always[s][e].sound, true, `always ${s}.${e}`);
    assert.equal(never[s][e].popup, true);
  }
});

test('classify sorts every event into one row', () => {
  const alice = { username: 'alice' };
  const dm = (content, extra = {}) => ({ scopeType: 'dm', mentioned: true, message: { scopeType: 'dm', content, ...extra }, recipient: alice });
  assert.equal(g.classify(dm('hi there')), 'dmMessage');
  assert.equal(g.classify(dm('hey @alice look')), 'dmMention');
  assert.equal(g.classify(dm('hey @alicebob look')), 'dmMessage');
  const ch = (mentioned, message = { scopeType: 'channel' }, kind) => ({ scopeType: 'channel', mentioned, kind, message, recipient: alice });
  assert.equal(g.classify(ch(true)), 'channelMention');
  assert.equal(g.classify(ch(false)), 'channelMessage');
  assert.equal(g.classify(ch(false, { scopeType: 'thread' })), 'thread');
  assert.equal(g.classify(ch(true, { scopeType: 'thread' })), 'channelMention', 'a mention inside a thread pings as a mention');
  assert.equal(g.classify(ch(true, { scopeType: 'channel' }, 'thread')), 'thread');
  assert.equal(g.classify(ch(false, { scopeType: 'channel' }, 'pin')), 'pinReminder');
});

test('allows reads one cell of the grid', () => {
  const grid = g.effective({ idle: { thread: { tray: false } } });
  assert.equal(g.allows(grid, 'idle', 'thread', 'tray'), false);
  assert.equal(g.allows(grid, 'idle', 'thread', 'popup'), true);
  assert.equal(g.allows(grid, 'dnd', 'call', 'sound'), false);
  assert.equal(g.allows(grid, 'nonsense', 'call', 'sound'), true, 'unknown status never blocks');
});
