// Hides emoji this device's fonts cannot draw, so the picker never offers empty "tofu" boxes
// (older Windows builds lack the newest Unicode emoji). Detection is a canvas probe: an emoji
// is unsupported if it renders identically to a guaranteed-missing glyph, or — for ZWJ/modifier
// sequences the font only half knows — if it falls apart into several glyphs (much wider than one).
const SIZE = 32;
let probe = null;

function makeProbe() {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * 3;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.font = `${SIZE - 8}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textBaseline = 'middle';
  const draw = (text) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillText(text, 2, SIZE / 2);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const sameAs = (a, b) => {
    for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) return false;
    return true;
  };
  return { ctx, draw, sameAs, tofu: draw('\u{10FFFE}'), oneWidth: ctx.measureText('😀').width };
}

export function isEmojiSupported(emoji) {
  try {
    probe = probe || makeProbe();
    if (probe.ctx.measureText(emoji).width > probe.oneWidth * 1.6) return false;
    return !probe.sameAs(probe.draw(emoji), probe.tofu);
  } catch {
    return true; // canvas unavailable — show everything rather than hide it all
  }
}
