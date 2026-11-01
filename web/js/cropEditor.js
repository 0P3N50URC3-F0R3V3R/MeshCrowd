import { t } from './i18n.js';
import { escapeHtml } from './utils.js';
import { nextZIndex } from './zstack.js';
import { CROP_SPECS, HANDLES, applyRatio, boxToSource, fitBox, moveBox, outputSize, outputType, resizeBox, zoomBox } from './cropMath.mjs';

const ZOOM_STEPS = 100;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

function drawCover(canvas, img, src) {
  const ctx = canvas.getContext('2d');
  const s = Math.max(canvas.width / src.w, canvas.height / src.h);
  const dw = src.w * s;
  const dh = src.h * s;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, src.x, src.y, src.w, src.h, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
}

function previewHtml(kind, user) {
  const name = escapeHtml(user?.displayName || user?.username || '');
  const handle = user?.username ? `@${escapeHtml(user.username)}` : '';
  if (kind === 'avatar') {
    return `<div class="crop-prev-avatars"><canvas class="crop-prev crop-round" data-w="160" data-h="160" style="width:80px;height:80px"></canvas>
      <canvas class="crop-prev crop-round" data-w="80" data-h="80" style="width:40px;height:40px"></canvas></div>`;
  }
  if (kind === 'banner') {
    return `<div class="crop-prev-card"><canvas class="crop-prev" data-w="680" data-h="220" style="width:340px;height:110px"></canvas></div>
      <div class="crop-prev-sub">${t('cropEditor.previewPopover')}</div>
      <div class="crop-prev-card"><canvas class="crop-prev" data-w="680" data-h="120" style="width:340px;height:60px"></canvas></div>`;
  }
  return `<div class="crop-prev-card crop-prev-body">
      <canvas class="crop-prev" data-w="680" data-h="400" style="width:340px;height:200px"></canvas>
      <div class="crop-prev-shade"></div>
      <div class="crop-prev-text"><div class="crop-prev-dot"></div><strong>${name}</strong><span>${handle}</span></div>
    </div>`;
}

export async function cropImage(file, kind, { user } = {}) {
  const spec = CROP_SPECS[kind];
  if (!spec || !file || !/^image\//.test(file.type)) return file;
  let loaded;
  try { loaded = await loadImage(file); } catch { return file; }
  const { img, url } = loaded;
  const full = { w: img.naturalWidth, h: img.naturalHeight };
  const isGif = file.type === 'image/gif';

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay crop-overlay';
    overlay.style.zIndex = nextZIndex();
    overlay.innerHTML = `
      <div class="modal crop-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(t(`cropEditor.title.${kind}`))}">
        <div class="modal-header"><h2>${escapeHtml(t(`cropEditor.title.${kind}`))}</h2></div>
        <div class="modal-body crop-body">
          <div class="crop-stage" tabindex="0" aria-label="${escapeHtml(t('cropEditor.stageLabel'))}">
            <img class="crop-img" alt="" draggable="false" src="${url}">
            <div class="crop-box${spec.round ? ' crop-box-round' : ''}">${HANDLES.map((h) => `<span class="crop-handle" data-h="${h}"></span>`).join('')}</div>
          </div>
          <div class="crop-controls">
            <label class="crop-zoom">${t('cropEditor.zoom')}<input type="range" class="crop-zoom-input" min="0" max="${ZOOM_STEPS}" value="0" aria-label="${escapeHtml(t('cropEditor.zoom'))}"></label>
            <label class="crop-lock"><input type="checkbox" class="crop-lock-input" checked> ${t('cropEditor.keepRatio')}</label>
          </div>
          <div class="crop-hint">${t('cropEditor.hint')}</div>
          <div class="crop-preview-title">${t('cropEditor.preview')}</div>
          <div class="crop-previews">${previewHtml(kind, user)}</div>
          ${isGif ? `<div class="crop-gif">${t('cropEditor.gifNote')} <button type="button" class="btn btn-secondary crop-keep" data-no-refocus>${t('cropEditor.keepOriginal')}</button></div>` : ''}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost crop-cancel" data-no-refocus>${t('common.cancel')}</button>
          <button type="button" class="btn btn-primary crop-apply" data-no-refocus>${t('cropEditor.apply')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const stage = overlay.querySelector('.crop-stage');
    const imgEl = overlay.querySelector('.crop-img');
    const boxEl = overlay.querySelector('.crop-box');
    const zoomEl = overlay.querySelector('.crop-zoom-input');
    const lockEl = overlay.querySelector('.crop-lock-input');
    const previews = [...overlay.querySelectorAll('.crop-prev')];
    for (const c of previews) { c.width = Number(c.dataset.w); c.height = Number(c.dataset.h); }

    let ratio = spec.ratio;
    let box = fitBox(full, ratio);
    let scale = 1;
    let drag = null;

    const fitStage = () => {
      const maxW = Math.max(120, stage.clientWidth || 360);
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.42, 420));
      scale = Math.min(maxW / full.w, maxH / full.h);
      imgEl.style.width = `${full.w * scale}px`;
      imgEl.style.height = `${full.h * scale}px`;
    };

    const zoomToSlider = () => {
      const max = fitBox(full, ratio);
      const f = Math.min(1, Math.max(0, (box.w - 24) / Math.max(1, max.w - 24)));
      zoomEl.value = String(Math.round((1 - f) * ZOOM_STEPS));
    };

    const paint = () => {
      boxEl.style.left = `${box.x * scale}px`;
      boxEl.style.top = `${box.y * scale}px`;
      boxEl.style.width = `${box.w * scale}px`;
      boxEl.style.height = `${box.h * scale}px`;
      const src = boxToSource(box, full);
      for (const c of previews) drawCover(c, img, src);
    };

    fitStage();
    paint();
    stage.focus({ preventScroll: true });

    let closed = false;
    const finish = (result) => {
      if (closed) return;
      closed = true;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      overlay.remove();
      URL.revokeObjectURL(url);
      resolve(result);
    };

    const apply = () => {
      const src = boxToSource(box, full);
      const out = outputSize(src.w, src.h, spec.maxW, spec.maxH);
      const { type, ext, quality } = outputType(isGif ? 'image/png' : file.type);
      const canvas = document.createElement('canvas');
      canvas.width = out.w;
      canvas.height = out.h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, src.x, src.y, src.w, src.h, 0, 0, out.w, out.h);
      canvas.toBlob((blob) => {
        if (!blob) { finish(file); return; }
        finish(new File([blob], `${kind}.${ext}`, { type: blob.type || type }));
      }, type, quality);
    };

    const onResize = () => { fitStage(); paint(); };
    window.addEventListener('resize', onResize);

    zoomEl.addEventListener('input', () => {
      const max = fitBox(full, ratio);
      const f = 1 - Number(zoomEl.value) / ZOOM_STEPS;
      const targetW = 24 + f * Math.max(0, max.w - 24);
      box = zoomBox(box, targetW / box.w, full, ratio);
      paint();
    });

    lockEl.addEventListener('change', () => {
      ratio = lockEl.checked ? spec.ratio : null;
      if (ratio) box = applyRatio(box, full, ratio);
      paint();
      zoomToSlider();
    });

    stage.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest?.('.crop-handle');
      if (!handle && !e.target.closest('.crop-box')) return;
      e.preventDefault();
      stage.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, box, handle: handle ? handle.dataset.h : null };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = (e.clientX - drag.x) / scale;
      const dy = (e.clientY - drag.y) / scale;
      box = drag.handle ? resizeBox(drag.box, drag.handle, dx, dy, full, ratio) : moveBox(drag.box, dx, dy, full);
      paint();
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      zoomToSlider();
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    overlay.querySelector('.crop-cancel').addEventListener('click', () => finish(null));
    overlay.querySelector('.crop-apply').addEventListener('click', apply);
    overlay.querySelector('.crop-keep')?.addEventListener('click', () => finish(file));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });

    // Captured on window so the Settings modal's own document-level Escape handler never sees it.
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(null); return; }
      if (e.key === 'Tab') {
        const items = [...overlay.querySelectorAll('button, input, [tabindex="0"]')].filter((el) => !el.disabled);
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key === 'Enter') {
        if (e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        apply();
        return;
      }
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (dir && e.target.type !== 'range') {
        e.preventDefault();
        const step = Math.max(1, Math.round(Math.max(full.w, full.h) / 200)) * (e.altKey ? 10 : 1);
        if (e.shiftKey) box = resizeBox(box, 'se', dir[0] * step, dir[1] * step, full, ratio);
        else box = moveBox(box, dir[0] * step, dir[1] * step, full);
        paint();
        zoomToSlider();
        return;
      }
      if ((e.key === '+' || e.key === '=' || e.key === '-') && e.target.type !== 'range') {
        box = zoomBox(box, e.key === '-' ? 1.1 : 1 / 1.1, full, ratio);
        paint();
        zoomToSlider();
      }
    }
    window.addEventListener('keydown', onKey, true);
  });
}
