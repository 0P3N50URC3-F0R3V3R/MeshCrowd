'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const wb = require('../lib/whiteboard');
const voice = require('../socket/voice');

const draw = { participant: true, canDraw: true, canClear: false };
const mod = { participant: true, canDraw: true, canClear: true };
let room = 9000;
const msg = (over = {}) => ({ strokeId: 's1', color: 'red', width: 5, points: [0.1, 0.2, 0.3, 0.4], ...over });

test('valid stroke is accepted, normalized and broadcast payload returned', () => {
  const r = wb.applyStroke(++room, 1, msg({ points: [0.123456, 0.2] }), draw);
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload.points, [0.1235, 0.2]);
  assert.equal(r.payload.userId, 1);
});

test('invalid color, width, ids and points are rejected', () => {
  const id = ++room;
  const bad = [
    msg({ color: 'pink' }), msg({ color: '#ff0000' }), msg({ color: undefined }), msg({ width: 3 }), msg({ width: '5' }),
    msg({ strokeId: '' }), msg({ strokeId: 'x'.repeat(25) }), msg({ strokeId: 'a b' }), msg({ strokeId: 5 }),
    msg({ points: [] }), msg({ points: [0.1] }), msg({ points: 'no' }), msg({ points: [NaN, 0.1] }), msg({ points: [Infinity, 0.1] }),
    msg({ points: [1.01, 0.1] }), msg({ points: [-0.01, 0.1] }), msg({ points: ['0.1', 0.1] }), msg({ points: [null, 0.1] }),
  ];
  for (const m of bad) assert.equal(wb.applyStroke(id, 1, m, draw).ok, false, JSON.stringify(m));
  assert.equal(wb.applyStroke(id, 1, null, draw).ok, false);
  assert.equal(wb.strokeCount(id), 0);
});

test('eraser is accepted as a color', () => {
  assert.equal(wb.applyStroke(++room, 1, msg({ color: 'eraser' }), draw).ok, true);
});

test('oversized batches are rejected, max-size accepted', () => {
  const id = ++room;
  const big = Array.from({ length: (wb.MAX_POINTS_PER_MESSAGE + 1) * 2 }, () => 0.5);
  assert.equal(wb.applyStroke(id, 1, msg({ points: big }), draw).ok, false);
  assert.equal(wb.applyStroke(id, 1, msg({ points: big.slice(2) }), draw).ok, true);
});

test('non-participant and non-drawer are rejected', () => {
  const id = ++room;
  assert.equal(wb.applyStroke(id, 1, msg(), { participant: false, canDraw: true }).reason, 'not_participant');
  assert.equal(wb.applyStroke(id, 1, msg(), { participant: true, canDraw: false }).reason, 'forbidden');
  assert.equal(wb.applyClear(id, 1, { participant: false, canClear: true }).reason, 'not_participant');
  assert.equal(wb.applyClear(id, 1, draw).reason, 'forbidden');
  assert.equal(wb.snapshot(id, { participant: false }), null);
  assert.equal(wb.strokeCount(id), 0);
});

test('draw/clear permission rules for voice and stage', () => {
  assert.equal(wb.canDraw({ isStage: false, isSpeaker: false, canManage: false }), true);
  assert.equal(wb.canDraw({ isStage: true, isSpeaker: false, canManage: false }), false);
  assert.equal(wb.canDraw({ isStage: true, isSpeaker: true, canManage: false }), true);
  assert.equal(wb.canDraw({ isStage: true, isSpeaker: false, canManage: true }), true);
  assert.equal(wb.canClear({ isStage: false, isSpeaker: false, canManage: false }), false);
  assert.equal(wb.canClear({ isStage: false, isSpeaker: false, canManage: true }), true);
  assert.equal(wb.canClear({ isStage: true, isSpeaker: true, canManage: false }), true);
  assert.equal(wb.canClear({ isStage: true, isSpeaker: false, canManage: false }), false);
});

test('continuation appends to own stroke only, with consistent color and width', () => {
  const id = ++room;
  wb.applyStroke(id, 1, msg({ points: [0.1, 0.1] }), draw);
  assert.equal(wb.applyStroke(id, 1, msg({ points: [0.2, 0.2] }), draw).ok, true);
  assert.equal(wb.applyStroke(id, 2, msg({ points: [0.3, 0.3] }), draw).ok, false);
  assert.equal(wb.applyStroke(id, 1, msg({ color: 'blue' }), draw).ok, false);
  const snap = wb.snapshot(id, draw);
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0].points, [0.1, 0.1, 0.2, 0.2]);
});

test('late joiner gets a snapshot copy of the current board', () => {
  const id = ++room;
  wb.applyStroke(id, 1, msg({ strokeId: 'a' }), draw);
  wb.applyStroke(id, 2, msg({ strokeId: 'b', color: 'blue' }), draw);
  const snap = wb.snapshot(id, { participant: true });
  assert.deepEqual(snap.map((s) => s.strokeId), ['a', 'b']);
  snap[0].points.push(0.9, 0.9);
  assert.equal(wb.snapshot(id, { participant: true })[0].points.length, 4);
});

test('clear empties the board for moderators', () => {
  const id = ++room;
  wb.applyStroke(id, 1, msg(), draw);
  assert.equal(wb.applyClear(id, 2, mod).ok, true);
  assert.deepEqual(wb.snapshot(id, draw), []);
});

test('board is dropped when the last participant leaves', () => {
  const id = ++room;
  voice.join(id, 1);
  voice.join(id, 2);
  wb.applyStroke(id, 1, msg(), draw);
  voice.leave(id, 1);
  assert.equal(voice.participants(id).length, 1);
  assert.equal(wb.strokeCount(id), 1);
  voice.leave(id, 2);
  wb.dropBoard(id);
  assert.equal(wb.strokeCount(id), 0);
  assert.deepEqual(wb.snapshot(id, draw), []);
});

test('oldest strokes are evicted at the stroke cap', () => {
  const id = ++room;
  let now = 1_000_000;
  for (let i = 0; i < wb.MAX_STROKES + 10; i++) {
    now += 1000;
    assert.equal(wb.applyStroke(id, 1, msg({ strokeId: `k${i}`, points: [0.5, 0.5] }), draw, now).ok, true);
  }
  assert.equal(wb.strokeCount(id), wb.MAX_STROKES);
  assert.equal(wb.snapshot(id, draw)[0].strokeId, 'k10');
});

test('oldest strokes are evicted at the board point cap', () => {
  const id = ++room;
  const pts = Array.from({ length: wb.MAX_POINTS_PER_MESSAGE * 2 }, () => 0.5);
  let now = 2_000_000;
  const strokes = Math.ceil(wb.MAX_BOARD_POINTS / wb.MAX_POINTS_PER_MESSAGE) + 5;
  for (let i = 0; i < strokes; i++) {
    now += 1000;
    wb.applyStroke(id, 1, msg({ strokeId: `p${i}`, points: pts }), draw, now);
  }
  const snap = wb.snapshot(id, draw);
  const total = snap.reduce((n, s) => n + s.points.length / 2, 0);
  assert.ok(total <= wb.MAX_BOARD_POINTS);
  assert.notEqual(snap[0].strokeId, 'p0');
});

test('rate limit rejects a flood and recovers over time', () => {
  const id = ++room;
  const t0 = 3_000_000;
  let accepted = 0;
  for (let i = 0; i < 300; i++) if (wb.applyStroke(id, 1, msg({ strokeId: `r${i}`, points: [0.5, 0.5] }), draw, t0).ok) accepted++;
  assert.ok(accepted >= 90 && accepted <= 110, String(accepted));
  assert.equal(wb.applyStroke(id, 1, msg({ strokeId: 'later', points: [0.5, 0.5] }), draw, t0 + 1000).ok, true);
  assert.equal(wb.applyStroke(id, 2, msg({ strokeId: 'other', points: [0.5, 0.5] }), draw, t0).ok, true);
});

test('per-stroke point cap', () => {
  const id = ++room;
  const pts = Array.from({ length: wb.MAX_POINTS_PER_MESSAGE * 2 }, () => 0.5);
  let now = 4_000_000;
  let last;
  for (let i = 0; i < Math.ceil(wb.MAX_POINTS_PER_STROKE / wb.MAX_POINTS_PER_MESSAGE) + 2; i++) {
    now += 1000;
    last = wb.applyStroke(id, 1, msg({ strokeId: 'long', points: pts }), draw, now);
  }
  assert.equal(last.ok, false);
});
