// Keeps animated GIF/APNG/WebP stickers from all animating at once (dozens of decoding animations
// stall the page). Opt in by class on an <img>:
//   anim-hover — frozen on its first frame, plays only while the pointer is over it (or its
//                nearest button/.list-row ancestor): sticker picker, sticker editors.
//   anim-limit — plays only if it is among the MAX_PLAYING newest on-screen ones (or hovered);
//                the rest show their first frame: chat messages.
// A MutationObserver picks images up wherever they are rendered, so call sites only add the class.

const MAX_PLAYING = 6;
const ANIMATABLE = /\.(gif|png|apng|webp)(\?|#|$)/i;

const info = new Map(); // url -> Promise<{ animated: boolean, still: string|null }>
const visible = new Set();
const hovered = new WeakSet();

async function sniffAnimated(url) {
  if (/\.gif(\?|#|$)/i.test(url)) return true;
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const head = new TextDecoder('latin1').decode(buf.subarray(0, Math.min(buf.length, 4096)));
  if (buf[0] === 0x89) return head.includes('acTL'); // PNG: animation control chunk precedes IDAT
  return head.includes('ANIM'); // WebP
}

function captureStill(url) {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = probe.naturalWidth; c.height = probe.naturalHeight;
        c.getContext('2d').drawImage(probe, 0, 0);
        resolve(c.toDataURL('image/png'));
      } catch { resolve(null); }
    };
    probe.onerror = () => resolve(null);
    probe.src = url;
  });
}

function analyze(url) {
  if (!info.has(url)) {
    info.set(url, (async () => {
      try {
        if (!(await sniffAnimated(url))) return { animated: false, still: null };
        return { animated: true, still: await captureStill(url) };
      } catch { return { animated: false, still: null }; }
    })());
  }
  return info.get(url);
}

function setPlaying(img, playing) {
  const want = playing ? img.dataset.animSrc : img.dataset.animStill;
  if (want && img.getAttribute('src') !== want) img.src = want;
}

function reconcile() {
  const imgs = [...visible].filter((i) => i.isConnected && i.dataset.animStill);
  imgs.sort((a, b) => (b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  let budget = MAX_PLAYING;
  for (const img of imgs) {
    if (img.classList.contains('anim-limit')) {
      const play = hovered.has(img) || budget > 0;
      if (play && !hovered.has(img)) budget--;
      setPlaying(img, play);
    }
  }
}
let queued = false;
const scheduleReconcile = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; reconcile(); });
};

const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
  for (const e of entries) (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target));
  scheduleReconcile();
});

async function setup(img) {
  if (img.dataset.animReady) return;
  img.dataset.animReady = '1';
  const url = img.getAttribute('src');
  if (!url || url.startsWith('data:') || !ANIMATABLE.test(url)) return;
  const { animated, still } = await analyze(url);
  if (!animated || !still || !img.isConnected || img.getAttribute('src') !== url) return;
  img.dataset.animSrc = url;
  img.dataset.animStill = still;
  const target = img.closest('button, .list-row') || img;
  const hover = img.classList.contains('anim-hover');
  target.addEventListener('mouseenter', () => { hovered.add(img); setPlaying(img, true); });
  target.addEventListener('mouseleave', () => {
    hovered.delete(img);
    if (hover) setPlaying(img, false); else scheduleReconcile();
  });
  if (hover) setPlaying(img, false);
  else if (io) io.observe(img);
  else setPlaying(img, false);
}

function scan(node) {
  if (node.nodeType !== 1) return;
  if (node.matches('img.anim-hover, img.anim-limit')) setup(node);
  node.querySelectorAll?.('img.anim-hover, img.anim-limit').forEach(setup);
}

if (typeof document !== 'undefined') {
  new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach(scan);
    for (const m of muts) m.removedNodes.forEach((n) => {
      if (n.nodeType === 1) n.querySelectorAll?.('img').forEach((i) => visible.delete(i));
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan(document.documentElement);
}
