// Live input level for the voice-activation sensitivity slider. Same 0-255 byte-frequency-average
// scale as views/voice.js's readLevel(), and taken before the input-gain node like the real VAD is,
// so the bar and the slider threshold are directly comparable.
export async function startMicMeter(deviceId, onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false,
  });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const timer = setInterval(() => {
    analyser.getByteFrequencyData(data);
    onLevel(data.reduce((a, b) => a + b, 0) / data.length);
  }, 50);
  return () => {
    clearInterval(timer);
    stream.getTracks().forEach((tr) => tr.stop());
    ctx.close().catch(() => {});
  };
}
