// Favicon + tab-title unread badge — the browser-tab equivalent of the Electron tray icon's
// presence-colored badge (electron/trayIcon.js draws the same concept server-side with a
// hand-rolled PNG encoder; here we just have a real <canvas> so it's much simpler).
const BRAND = '#0d9488';
const EYE = '#1e1f22';
const LOGO_PATH = 'M6 8c0-2.2 2.7-4 6-4s6 1.8 6 4v6.5c0 3.6-3.1 5.5-6 5.5s-6-1.9-6-5.5z';
const STATUS_COLORS = { online: '#23a55a', idle: '#f0b232', dnd: '#f23f43', invisible: '#80848e', offline: '#80848e' };

const SIZE = 64;
let canvas = null;
let ctx = null;
let linkEl = null;
const baseTitle = document.title;

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  ctx = canvas.getContext('2d');
}

function ensureLink() {
  if (linkEl) return linkEl;
  linkEl = document.querySelector('link[rel="icon"]') || document.createElement('link');
  linkEl.rel = 'icon';
  if (!linkEl.isConnected) document.head.appendChild(linkEl);
  return linkEl;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Redraws the favicon (Meshcord mark, plus a presence-colored badge when there's something
// unread) and re-prefixes the tab title with the count — same signal the Electron tray icon
// shows, mirrored here so a plain browser tab (no tray) still surfaces "something's waiting"
// without the tab being focused.
export function updateBadge({ count = 0, status = 'online' } = {}) {
  ensureCanvas();
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.save();
  ctx.scale(SIZE / 24, SIZE / 24);
  ctx.fillStyle = BRAND;
  ctx.fill(new Path2D(LOGO_PATH));
  ctx.fillStyle = EYE;
  ctx.beginPath(); ctx.arc(9.5, 12, 1.3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(14.5, 12, 1.3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  if (count > 0) {
    const label = count > 99 ? '99+' : String(count);
    const pillH = 26;
    const pillW = Math.max(pillH, label.length * 15 + 12);
    const x = SIZE - pillW - 1;
    const y = SIZE - pillH - 1;
    ctx.fillStyle = STATUS_COLORS[status] || STATUS_COLORS.online;
    roundRect(x, y, pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px -apple-system, "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + pillW / 2, y + pillH / 2 + 1);
  }

  ensureLink().href = canvas.toDataURL('image/png');
  document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${baseTitle}` : baseTitle;
}
