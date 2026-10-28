import test from 'node:test';
import assert from 'node:assert/strict';

// utils.js / i18n.js / icons.js touch the DOM only inside functions, so the pure helpers import cleanly.
const { formatClock, pickRecorderFormat } = await import('./voiceMessage.js');

test('formatClock shows minutes and zero-padded seconds', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(7300), '0:07');
  assert.equal(formatClock(61_000), '1:01');
  assert.equal(formatClock(300_000), '5:00');
  assert.equal(formatClock(-5), '0:00');
});

test('pickRecorderFormat prefers Opus in WebM, then Ogg, then MP4', () => {
  const supports = (...list) => (m) => list.includes(m);
  assert.deepEqual(pickRecorderFormat(supports('audio/webm;codecs=opus', 'audio/ogg;codecs=opus')), { mime: 'audio/webm;codecs=opus', ext: 'webm' });
  assert.deepEqual(pickRecorderFormat(supports('audio/ogg;codecs=opus')), { mime: 'audio/ogg;codecs=opus', ext: 'ogg' });
  assert.deepEqual(pickRecorderFormat(supports('audio/mp4')), { mime: 'audio/mp4', ext: 'm4a' });
  assert.equal(pickRecorderFormat(supports()), null);
});
