// RNNoise (a small neural noise suppressor, WebAssembly) between the microphone and the call. It
// runs on the main thread through a ScriptProcessorNode: RNNoise wants 480-sample frames at 48 kHz,
// the node delivers bigger blocks, so FrameBuffer re-slices them. The ~4.8 MB module is only loaded
// when the user turns the option on.

export const RNNOISE_SAMPLE_RATE = 48000;
export const RNNOISE_FRAME = 480;
const PCM16 = 32768; // RNNoise expects 16-bit-scale samples, Web Audio uses -1..1

// Collects input blocks, runs complete frames through `processFrame` (in place) and hands back the
// same number of samples, delayed by one frame (10 ms).
export class FrameBuffer {
  constructor(frameSize, processFrame, scale = PCM16) {
    this.frameSize = frameSize;
    this.processFrame = processFrame;
    this.scale = scale;
    this.pending = new Float32Array(0);
    // One frame of silence up front keeps the supply ahead of the demand, so later blocks never run dry.
    this.ready = new Float32Array(frameSize);
  }

  process(input, output) {
    const merged = new Float32Array(this.pending.length + input.length);
    merged.set(this.pending); merged.set(input, this.pending.length);
    let offset = 0;
    const done = [this.ready];
    while (merged.length - offset >= this.frameSize) {
      const frame = merged.slice(offset, offset + this.frameSize);
      for (let i = 0; i < frame.length; i++) frame[i] *= this.scale;
      this.processFrame(frame);
      for (let i = 0; i < frame.length; i++) frame[i] /= this.scale;
      done.push(frame);
      offset += this.frameSize;
    }
    this.pending = merged.slice(offset);
    const all = new Float32Array(done.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const a of done) { all.set(a, at); at += a.length; }
    const take = Math.min(output.length, all.length);
    output.fill(0);
    output.set(all.subarray(0, take), output.length - take);
    this.ready = all.slice(take);
  }
}

let rnnoisePromise = null;
const loadRnnoise = () => {
  if (!rnnoisePromise) rnnoisePromise = import('/vendor/rnnoise/rnnoise.js').then((m) => m.Rnnoise.load()).catch((err) => { rnnoisePromise = null; throw err; });
  return rnnoisePromise;
};

// Returns { input, output, destroy } to splice between a source node and the next node of the graph.
// The AudioContext must run at 48 kHz.
export async function createDenoiser(audioCtx) {
  if (audioCtx.sampleRate !== RNNOISE_SAMPLE_RATE) throw new Error('RNNoise needs a 48 kHz audio context');
  const rnnoise = await loadRnnoise();
  const state = rnnoise.createDenoiseState();
  const buffer = new FrameBuffer(rnnoise.frameSize || RNNOISE_FRAME, (frame) => state.processFrame(frame));
  const node = audioCtx.createScriptProcessor(1024, 1, 1);
  node.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const output = e.outputBuffer.getChannelData(0);
    buffer.process(input, output);
  };
  return {
    input: node,
    output: node,
    destroy() { node.onaudioprocess = null; try { node.disconnect(); } catch { /* already disconnected */ } state.destroy(); },
  };
}
