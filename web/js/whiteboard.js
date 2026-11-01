import { icons } from './icons.js';
import { t } from './i18n.js';
import { escapeHtml } from './utils.js';
import {
  PALETTE, ERASER, WIDTHS, SEND_INTERVAL_MS, toNormalized, createBatcher, createStore, drawPoints, newStrokeId,
} from './whiteboardMath.mjs';

const WIDTH_NAMES = ['wbWidthThin', 'wbWidthMedium', 'wbWidthThick'];

// `send(msg)` ships a ws message for this room; `canDraw()` / `canClear()` are re-read on every
// pointer/render so a stage speaker being moved to the audience loses the pen immediately (the
// server enforces the same rules, this only keeps the UI honest).
export function createWhiteboard({ send, canDraw, canClear }) {
  const store = createStore();
  const batcher = createBatcher();
  let color = 'black';
  let widthIdx = 1;
  let tool = 'pen';
  let drawing = null; // { id, color, width, pointerId, prev, timer }

  const el = document.createElement('div');
  el.className = 'wb-panel';
  el.innerHTML = `
    <div class="wb-toolbar" role="toolbar" aria-label="${escapeHtml(t('voice.wbToolbar'))}">
      <div class="wb-group" role="group" aria-label="${escapeHtml(t('voice.wbColors'))}">
        ${PALETTE.map((c) => `<button type="button" class="wb-color" data-color="${c.id}" style="--wb-c:${c.hex}" title="${escapeHtml(t(`voice.wbColor_${c.id}`))}" aria-label="${escapeHtml(t(`voice.wbColor_${c.id}`))}" aria-pressed="false"></button>`).join('')}
      </div>
      <div class="wb-group" role="group" aria-label="${escapeHtml(t('voice.wbWidths'))}">
        ${WIDTHS.map((w, i) => `<button type="button" class="wb-width" data-width="${i}" title="${escapeHtml(t(`voice.${WIDTH_NAMES[i]}`))}" aria-label="${escapeHtml(t(`voice.${WIDTH_NAMES[i]}`))}" aria-pressed="false"><span style="--wb-d:${2 + i * 3}px"></span></button>`).join('')}
      </div>
      <div class="wb-group">
        <button type="button" class="wb-tool" data-tool="eraser" title="${escapeHtml(t('voice.wbEraser'))}" aria-label="${escapeHtml(t('voice.wbEraser'))}" aria-pressed="false">${icons.eraser(18)}</button>
        <button type="button" class="wb-tool" data-tool="clear" title="${escapeHtml(t('voice.wbClear'))}" aria-label="${escapeHtml(t('voice.wbClear'))}">${icons.trash(18)}</button>
      </div>
      <span class="wb-note" role="status"></span>
    </div>
    <div class="wb-board"><canvas class="wb-canvas" aria-label="${escapeHtml(t('voice.wbCanvas'))}"></canvas></div>`;
  const canvas = el.querySelector('.wb-canvas');
  const board = el.querySelector('.wb-board');
  const note = el.querySelector('.wb-note');
  const ctx = canvas.getContext('2d');

  function paintToolbar() {
    const draw = canDraw();
    el.classList.toggle('wb-readonly', !draw);
    for (const b of el.querySelectorAll('.wb-color')) {
      const on = tool === 'pen' && b.dataset.color === color;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !draw;
    }
    for (const b of el.querySelectorAll('.wb-width')) {
      const on = Number(b.dataset.width) === widthIdx;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !draw;
    }
    const eraser = el.querySelector('[data-tool="eraser"]');
    eraser.classList.toggle('active', tool === 'eraser');
    eraser.setAttribute('aria-pressed', String(tool === 'eraser'));
    eraser.disabled = !draw;
    el.querySelector('[data-tool="clear"]').hidden = !canClear();
    note.textContent = draw ? '' : t('voice.wbViewOnly');
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of store.strokes) drawPoints(ctx, s, s.points, canvas.width, canvas.height, null);
  }

  function fit() {
    const w = Math.round(board.clientWidth * (window.devicePixelRatio || 1));
    const h = Math.round(board.clientHeight * (window.devicePixelRatio || 1));
    if (w < 2 || h < 2 || (canvas.width === w && canvas.height === h)) return;
    canvas.width = w;
    canvas.height = h;
    redraw();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  ro?.observe(board);

  function flush() {
    if (!drawing) return;
    let chunk;
    while ((chunk = batcher.take())) {
      send({ type: 'wb_stroke', strokeId: drawing.id, color: drawing.color, width: drawing.width, points: chunk });
    }
  }

  function addPoint(e) {
    const p = toNormalized(e.clientX, e.clientY, canvas.getBoundingClientRect());
    if (!p || !batcher.add(p[0], p[1])) return;
    const { stroke, prev } = store.append({ strokeId: drawing.id, color: drawing.color, width: drawing.width, points: p });
    drawPoints(ctx, stroke, p, canvas.width, canvas.height, prev);
  }

  function endStroke() {
    if (!drawing) return;
    clearInterval(drawing.timer);
    flush();
    drawing = null;
    batcher.reset();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (drawing || !canDraw() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const erase = tool === ERASER;
    drawing = {
      id: newStrokeId(), color: erase ? ERASER : color, width: WIDTHS[widthIdx], pointerId: e.pointerId,
      timer: setInterval(flush, SEND_INTERVAL_MS),
    };
    batcher.reset();
    addPoint(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || e.pointerId !== drawing.pointerId) return;
    const events = e.getCoalescedEvents?.() || [];
    for (const ev of events.length ? events : [e]) addPoint(ev);
  });
  const stop = (e) => { if (drawing && e.pointerId === drawing.pointerId) endStroke(); };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('lostpointercapture', stop);

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    if (btn.dataset.color) { color = btn.dataset.color; tool = 'pen'; }
    else if (btn.dataset.width) widthIdx = Number(btn.dataset.width);
    else if (btn.dataset.tool === 'eraser') tool = tool === 'eraser' ? 'pen' : 'eraser';
    else if (btn.dataset.tool === 'clear') { send({ type: 'wb_clear' }); return; }
    paintToolbar();
  });

  return {
    el,
    refresh: paintToolbar,
    fit,
    applyStroke(msg) {
      const { stroke, prev } = store.append(msg);
      drawPoints(ctx, stroke, msg.points, canvas.width, canvas.height, prev);
    },
    applyState(strokes) {
      endStroke();
      store.replace(strokes);
      redraw();
    },
    applyClear() {
      endStroke();
      store.clear();
      redraw();
    },
    hasContent: () => store.size() > 0,
    reset() {
      endStroke();
      store.clear();
      redraw();
    },
    destroy() {
      endStroke();
      ro?.disconnect();
    },
  };
}
