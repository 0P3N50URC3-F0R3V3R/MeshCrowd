import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameBuffer, RNNOISE_FRAME } from './noiseSuppression.js';

function run(blockSize, blocks, process) {
  const fb = new FrameBuffer(RNNOISE_FRAME, process, 1);
  const input = []; const output = [];
  let counter = 1;
  for (let b = 0; b < blocks; b++) {
    const inBlock = new Float32Array(blockSize).map(() => counter++);
    const outBlock = new Float32Array(blockSize);
    fb.process(inBlock, outBlock);
    input.push(...inBlock); output.push(...outBlock);
  }
  return { input, output };
}

test('with an identity processor the output is the input delayed by exactly one frame, with no gaps', () => {
  const { input, output } = run(1024, 40, () => {});
  assert.deepEqual(output.slice(0, RNNOISE_FRAME), new Array(RNNOISE_FRAME).fill(0));
  assert.deepEqual(output.slice(RNNOISE_FRAME), input.slice(0, input.length - RNNOISE_FRAME));
});

test('works for block sizes that do not divide the frame size', () => {
  for (const size of [128, 480, 700, 1024, 4096]) {
    const { input, output } = run(size, 50, () => {});
    assert.deepEqual(output.slice(RNNOISE_FRAME), input.slice(0, input.length - RNNOISE_FRAME), `block ${size}`);
  }
});

test('every processed frame has exactly the frame size and the processor result is what comes out', () => {
  const seen = [];
  const { output } = run(1024, 10, (frame) => { seen.push(frame.length); for (let i = 0; i < frame.length; i++) frame[i] *= 0.5; });
  assert.ok(seen.every((n) => n === RNNOISE_FRAME));
  assert.equal(output[RNNOISE_FRAME], 0.5, 'first real sample (1) halved');
  assert.equal(output[RNNOISE_FRAME + 9], 5);
});

test('samples are scaled to 16-bit range for the processor and back', () => {
  let first = true;
  const fb = new FrameBuffer(4, (frame) => { if (first) assert.equal(frame[0], 16384); first = false; }, 32768);
  const out = new Float32Array(4);
  fb.process(new Float32Array([0.5, 0.25, 0, 0]), out);
  fb.process(new Float32Array(4), out);
  assert.equal(out[0], 0.5);
});
