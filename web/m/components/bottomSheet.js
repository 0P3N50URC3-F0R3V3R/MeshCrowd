import { escapeHtml, toast } from '../../js/utils.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';

let current = null; // { back, onClose }

export const hasOpenSheet = () => !!current;

function removeCurrent() {
  if (!current) return;
  const c = current;
  current = null;
  c.back.classList.remove('open');
  setTimeout(() => c.back.remove(), 200);
  c.onClose?.();
}

export function closeTopSheet() {
  if (!current) return false;
  removeCurrent();
  return true;
}

export function openSheet({ title = '', html = '', full = false, onMount, onClose } = {}) {
  removeCurrent();
  const back = document.createElement('div');
  back.className = `m-sheet-back${full ? ' full' : ''}`;
  back.innerHTML = `
    <div class="m-sheet" role="dialog">
      <div class="m-sheet-grip"></div>
      ${title ? `<div class="m-sheet-title">${escapeHtml(title)}</div>` : ''}
      <div class="m-sheet-body">${html}</div>
    </div>`;
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add('open'));
  current = { back, onClose };
  back.addEventListener('click', (e) => { if (e.target === back) closeTopSheet(); });
  const body = back.querySelector('.m-sheet-body');
  onMount?.(body, closeTopSheet);
  return { close: closeTopSheet, body };
}

// items: [{ id, icon?, label, sub?, danger? }] -> resolves with the chosen id, or null if dismissed.
// `header` is raw HTML shown above the items; any [data-id] inside it is selectable too.
export function actionSheet({ title = '', items, header = '' }) {
  return new Promise((resolve) => {
    let chosen = null;
    openSheet({
      title,
      html: header + items.map((it) => `
        <button class="m-sheet-item${it.danger ? ' danger' : ''}" data-id="${escapeHtml(it.id)}">
          ${it.icon ? `<span class="m-sheet-icon">${it.icon}</span>` : ''}
          <span class="m-sheet-label"><b>${escapeHtml(it.label)}</b>${it.sub ? `<small>${escapeHtml(it.sub)}</small>` : ''}</span>
        </button>`).join(''),
      onMount: (body, close) => body.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-id]');
        if (!btn) return;
        chosen = btn.dataset.id;
        close();
      }),
      onClose: () => resolve(chosen),
    });
  });
}

export function confirmSheet(message, { danger = true, okLabel } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    openSheet({
      html: `<p class="m-confirm-text">${escapeHtml(message)}</p>
        <div class="m-confirm-row">
          <button class="btn btn-secondary" data-no>${t('m.cancel')}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(okLabel || t('m.delete'))}</button>
        </div>`,
      onMount: (body, close) => {
        body.querySelector('[data-no]').addEventListener('click', close);
        body.querySelector('[data-yes]').addEventListener('click', () => { ok = true; close(); });
      },
      onClose: () => resolve(ok),
    });
  });
}

export function promptSheet({ title = '', placeholder = '', okLabel, value = '', multiline = false, allowEmpty = false } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const field = multiline
      ? `<textarea class="m-input" rows="3" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
      : `<input class="m-input" type="text" enterkeyhint="done" autocomplete="off" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">`;
    openSheet({
      title,
      html: `${field}<div class="m-confirm-row" style="margin-top:12px">
        <button class="btn btn-secondary" data-no>${t('m.cancel')}</button>
        <button class="btn btn-primary" data-yes>${escapeHtml(okLabel || t('m.save'))}</button></div>`,
      onMount: (body, close) => {
        const input = body.querySelector('.m-input');
        const submit = () => { result = input.value.trim(); close(); };
        body.querySelector('[data-no]').addEventListener('click', close);
        body.querySelector('[data-yes]').addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) { e.preventDefault(); submit(); } });
        setTimeout(() => input.focus(), 250);
      },
      onClose: () => resolve(result || (allowEmpty && result === '' ? '' : null)),
    });
  });
}

export function openImageViewer(url, name = '') {
  openSheet({
    full: true,
    html: `<div class="m-viewer"><img class="m-viewer-img" src="${escapeHtml(url)}" alt="" draggable="false">
      <button class="m-viewer-btn m-viewer-close" aria-label="${t('m.cancel')}">${icons.x(22)}</button>
      <button class="m-viewer-btn m-viewer-save" aria-label="${t('m.saveImage')}">${icons.download(22)}</button></div>`,
    onMount: (body, close) => {
      const stage = body.querySelector('.m-viewer');
      const img = body.querySelector('.m-viewer-img');
      let scale = 1; let x = 0; let y = 0;
      const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
      const clamp = () => {
        const maxX = Math.max(0, (img.clientWidth * scale - stage.clientWidth) / 2);
        const maxY = Math.max(0, (img.clientHeight * scale - stage.clientHeight) / 2);
        x = Math.min(maxX, Math.max(-maxX, x)); y = Math.min(maxY, Math.max(-maxY, y));
      };
      const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      let pinch = null; let drag = null; let lastTap = 0;
      stage.addEventListener('touchstart', (e) => {
        if (e.target.closest('.m-viewer-btn')) return;
        if (e.touches.length === 2) { pinch = { d: dist(e.touches[0], e.touches[1]), scale }; drag = null; }
        else if (e.touches.length === 1) {
          const now = Date.now();
          if (now - lastTap < 300) { scale = scale > 1 ? 1 : 2.5; x = 0; y = 0; apply(); }
          lastTap = now;
          drag = { px: e.touches[0].clientX, py: e.touches[0].clientY };
        }
      }, { passive: true });
      stage.addEventListener('touchmove', (e) => {
        if (pinch && e.touches.length === 2) {
          scale = Math.min(6, Math.max(1, pinch.scale * dist(e.touches[0], e.touches[1]) / pinch.d));
          clamp(); apply();
        } else if (drag && e.touches.length === 1 && scale > 1) {
          x += e.touches[0].clientX - drag.px; y += e.touches[0].clientY - drag.py;
          drag.px = e.touches[0].clientX; drag.py = e.touches[0].clientY;
          clamp(); apply();
        }
      }, { passive: true });
      stage.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) pinch = null;
        if (e.touches.length === 0) drag = null;
        if (scale <= 1) { scale = 1; x = 0; y = 0; apply(); }
      });
      body.querySelector('.m-viewer-close').addEventListener('click', close);
      // Android: hand the bytes to the app's own save bridge (an anchor download is ignored by the WebView); browsers: ordinary download.
      body.querySelector('.m-viewer-save').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) throw new Error(String(res.status));
          const blob = await res.blob();
          const fileName = (name || url.split('?')[0].split('/').pop() || 'image').replace(/^[0-9a-f]{12,32}-/i, '');
          if (typeof window.MeshCrowdAndroid?.saveFile === 'function') {
            const b64 = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
              fr.onerror = reject;
              fr.readAsDataURL(blob);
            });
            if (!window.MeshCrowdAndroid.saveFile(b64, fileName, blob.type || 'image/png')) throw new Error('save');
            toast(t('m.imageSaved'));
          } else {
            const href = URL.createObjectURL(blob);
            const a = Object.assign(document.createElement('a'), { href, download: fileName });
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(href), 60000);
          }
        } catch { toast(t('m.saveImageFailed'), { type: 'error' }); }
        btn.disabled = false;
      });
    },
  });
}
