// Calls handler(targetEl, event) after a still press of `ms`; swallows the click that follows.
export function onLongPress(root, selector, handler, ms = 450) {
  let timer = null;
  let fired = false;
  let sx = 0;
  let sy = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  root.addEventListener('pointerdown', (e) => {
    const target = e.target.closest(selector);
    if (!target) return;
    fired = false; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { fired = true; handler(target, e); }, ms);
  });
  root.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clear(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) root.addEventListener(ev, clear);
  root.addEventListener('contextmenu', (e) => { if (e.target.closest(selector)) e.preventDefault(); });
  root.addEventListener('click', (e) => { if (fired) { fired = false; e.stopPropagation(); e.preventDefault(); } }, true);
}
