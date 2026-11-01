// Crop boxes are {x, y, w, h} in source-image pixels; `img` is {w, h}; `ratio` is width/height or null for free.

export const MIN_BOX = 24;

// Ratios and caps match the profile card CSS: .fp-banner 340x110, .fp-card 340 wide with ~200px of body,
// avatar is a circle. Outputs are capped at 2x the displayed width so the card stays sharp on hi-dpi.
export const CROP_SPECS = {
  avatar: { ratio: 1, maxW: 512, maxH: 512, round: true },
  banner: { ratio: 340 / 110, maxW: 680, maxH: 680 },
  card: { ratio: 340 / 200, maxW: 680, maxH: 680 },
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function minSize(img, ratio) {
  const m = Math.min(MIN_BOX, img.w, img.h);
  if (!ratio) return { w: m, h: m };
  const w = Math.min(Math.max(m, m * ratio), img.w, img.h * ratio);
  return { w, h: w / ratio };
}

export function moveBox(box, dx, dy, img) {
  return { ...box, x: clamp(box.x + dx, 0, img.w - box.w), y: clamp(box.y + dy, 0, img.h - box.h) };
}

export function clampBox(box, img, ratio = null) {
  const min = minSize(img, ratio);
  let w = clamp(box.w, min.w, img.w);
  let h = clamp(box.h, min.h, img.h);
  if (ratio) {
    w = Math.min(w, h * ratio, img.w);
    h = w / ratio;
  }
  return { x: clamp(box.x, 0, img.w - w), y: clamp(box.y, 0, img.h - h), w, h };
}

export function fitBox(img, ratio) {
  if (!ratio) return { x: 0, y: 0, w: img.w, h: img.h };
  const w = Math.min(img.w, img.h * ratio);
  const h = w / ratio;
  return { x: (img.w - w) / 2, y: (img.h - h) / 2, w, h };
}

export function applyRatio(box, img, ratio) {
  if (!ratio) return clampBox(box, img);
  const w = Math.min(box.w, box.h * ratio);
  const h = w / ratio;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return clampBox({ x: cx - w / 2, y: cy - h / 2, w, h }, img, ratio);
}

export function zoomBox(box, factor, img, ratio = null) {
  const f = Math.min(factor, img.w / box.w, img.h / box.h);
  const w = box.w * f;
  const h = box.h * f;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return clampBox({ x: cx - w / 2, y: cy - h / 2, w, h }, img, ratio);
}

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function resizeBox(box, handle, dx, dy, img, ratio = null) {
  const min = minSize(img, ratio);
  const hasW = handle.includes('w');
  const hasE = handle.includes('e');
  const hasN = handle.includes('n');
  const hasS = handle.includes('s');
  const anchorX = hasW ? box.x + box.w : box.x;
  const anchorY = hasN ? box.y + box.h : box.y;

  if (!ratio) {
    let left = box.x;
    let right = box.x + box.w;
    let top = box.y;
    let bottom = box.y + box.h;
    if (hasW) left = clamp(left + dx, 0, right - min.w);
    if (hasE) right = clamp(right + dx, left + min.w, img.w);
    if (hasN) top = clamp(top + dy, 0, bottom - min.h);
    if (hasS) bottom = clamp(bottom + dy, top + min.h, img.h);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  const corner = (hasW || hasE) && (hasN || hasS);
  let w;
  if (corner) {
    const wFromX = box.w + (hasE ? dx : -dx);
    const hFromY = box.h + (hasS ? dy : -dy);
    w = Math.max(wFromX, hFromY * ratio);
    const roomX = hasE ? img.w - anchorX : anchorX;
    const roomY = hasS ? img.h - anchorY : anchorY;
    w = Math.min(w, roomX, roomY * ratio);
  } else if (hasW || hasE) {
    w = box.w + (hasE ? dx : -dx);
    const roomX = hasE ? img.w - anchorX : anchorX;
    const cy = box.y + box.h / 2;
    w = Math.min(w, roomX, 2 * Math.min(cy, img.h - cy) * ratio);
  } else {
    const h = box.h + (hasS ? dy : -dy);
    w = h * ratio;
    const roomY = hasS ? img.h - anchorY : anchorY;
    const cx = box.x + box.w / 2;
    w = Math.min(w, roomY * ratio, 2 * Math.min(cx, img.w - cx));
  }
  w = Math.max(w, min.w);
  const h = w / ratio;

  let x;
  let y;
  if (corner) {
    x = hasW ? anchorX - w : anchorX;
    y = hasN ? anchorY - h : anchorY;
  } else if (hasW || hasE) {
    x = hasW ? anchorX - w : anchorX;
    y = box.y + box.h / 2 - h / 2;
  } else {
    x = box.x + box.w / 2 - w / 2;
    y = hasN ? anchorY - h : anchorY;
  }
  return clampBox({ x, y, w, h }, img, ratio);
}

export function boxToSource(box, img) {
  const x = clamp(Math.round(box.x), 0, img.w - 1);
  const y = clamp(Math.round(box.y), 0, img.h - 1);
  return { x, y, w: clamp(Math.round(box.w), 1, img.w - x), h: clamp(Math.round(box.h), 1, img.h - y) };
}

export function outputSize(srcW, srcH, maxW, maxH) {
  const s = Math.min(1, maxW / srcW, maxH / srcH);
  return { w: Math.max(1, Math.round(srcW * s)), h: Math.max(1, Math.round(srcH * s)) };
}

export function outputType(mime) {
  if (mime === 'image/png' || mime === 'image/gif') return { type: 'image/png', ext: 'png', quality: undefined };
  if (mime === 'image/webp') return { type: 'image/webp', ext: 'webp', quality: 0.92 };
  return { type: 'image/jpeg', ext: 'jpg', quality: 0.9 };
}
