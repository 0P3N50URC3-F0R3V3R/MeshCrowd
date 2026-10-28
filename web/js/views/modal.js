import { icons } from '../icons.js';
import { escapeHtml, toast } from '../utils.js';
import { nextZIndex } from '../zstack.js';
import { t } from '../i18n.js';

// Generic centered modal. `render(bodyEl, close)` fills in the body; footer/header are strings/nodes.
// `title` is always plain text (escaped here) — callers that need markup should render it themselves
// inside `render()` instead.
export function openModal({ title, wide = false, onClose, render, footer }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.style.zIndex = nextZIndex();
  overlay.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>${escapeHtml(title)}</h2>
        <button class="btn-icon" data-close aria-label="${t('common.close')}">${icons.x(18)}</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-footer hidden"></div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-close]').addEventListener('click', close);

  const body = overlay.querySelector('.modal-body');
  render?.(body, close);

  if (footer) {
    const footerEl = overlay.querySelector('.modal-footer');
    footerEl.classList.remove('hidden');
    if (typeof footer === 'string') footerEl.innerHTML = footer;
    else footerEl.appendChild(footer);
  }

  return { close, overlay, body };
}

// `message` is raw HTML, unlike openModal's `title` — every caller that embeds user-controlled
// text (a display name, server/channel/role name) into it MUST escapeHtml() that piece itself.
export function confirmModal({ title, message, confirmLabel = t('common.confirm'), danger = true, onConfirm }) {
  const m = openModal({
    title,
    render(body) {
      body.innerHTML = `<p style="color:var(--text-secondary);font-size:15px;line-height:1.4">${message}</p>`;
    },
  });
  const footer = document.createElement('div');
  footer.style.display = 'flex';
  footer.style.gap = '8px';
  footer.style.justifyContent = 'flex-end';
  footer.style.width = '100%';
  footer.innerHTML = `
    <button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button>
    <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirmLabel}</button>`;
  const footerHost = m.overlay.querySelector('.modal-footer');
  footerHost.classList.remove('hidden');
  footerHost.appendChild(footer);
  footer.querySelector('[data-cancel]').addEventListener('click', m.close);
  footer.querySelector('[data-ok]').addEventListener('click', async () => {
    await onConfirm?.();
    m.close();
  });
  return m;
}

// Single-line text input modal — a replacement for `window.prompt()`, which Electron's renderer
// never implements (it returns null immediately instead of showing a dialog). Resolves to the
// trimmed input, or null if cancelled/empty (with allowEmpty, an empty confirm resolves to '').
export function promptModal({ title, label, value = '', placeholder = '', confirmLabel = t('common.ok'), allowEmpty = false }) {
  return new Promise((resolve) => {
    let resolved = false;
    const m = openModal({
      title,
      onClose: () => { if (!resolved) resolve(null); },
      render(body) {
        body.innerHTML = `
          <div class="field">
            ${label ? `<label for="prompt-input">${escapeHtml(label)}</label>` : ''}
            <input class="input" id="prompt-input" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">
          </div>`;
      },
    });
    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.style.justifyContent = 'flex-end';
    footer.style.width = '100%';
    footer.innerHTML = `
      <button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button>
      <button class="btn btn-primary" data-ok>${escapeHtml(confirmLabel)}</button>`;
    const footerHost = m.overlay.querySelector('.modal-footer');
    footerHost.classList.remove('hidden');
    footerHost.appendChild(footer);

    const input = m.overlay.querySelector('#prompt-input');
    input.focus();
    input.select();

    const submit = () => {
      resolved = true;
      const val = input.value.trim();
      m.close();
      resolve(val || (allowEmpty ? '' : null));
    };
    const cancel = () => { resolved = true; m.close(); resolve(null); };
    footer.querySelector('[data-ok]').addEventListener('click', submit);
    footer.querySelector('[data-cancel]').addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  });
}

// Two-step confirmation for irreversible bulk actions (data pruning): a summary dialog, then a
// second dialog requiring the exact target name to be typed before `onConfirm` ever runs.
export function confirmTypedModal({ title, message, expectedText, confirmLabel = t('common.deleteForever'), onConfirm }) {
  confirmModal({
    title,
    message,
    confirmLabel: t('common.confirm'),
    danger: true,
    onConfirm: async () => {
      const typed = await promptModal({
        title: t('common.typeToConfirm'),
        label: t('common.typeToConfirmLabel', { expected: expectedText }),
        placeholder: expectedText,
        confirmLabel,
      });
      if (typed === null) return;
      if (typed !== expectedText) {
        toast(t('common.typeMismatch', { expected: expectedText }), { type: 'error' });
        return;
      }
      await onConfirm?.();
    },
  });
}

// Right-click / kebab context menu. `items`: [{label, icon?, danger?, onClick} | 'sep']
// Item shapes: 'sep' | { emojiRow: [emoji...], onPick(emoji) } | { label, icon, danger, onClick, sub (small second line), checked (renders a
// checkbox), disabled, submenu: [items] (opens to the side on hover/click instead of onClick) }.
export function openContextMenu(x, y, items) {
  document.querySelectorAll('.context-menu').forEach((n) => n.remove());
  const menus = [];

  function build(list, px, py, level) {
    while (menus.length > level) menus.pop().remove();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.zIndex = nextZIndex();
    menu.innerHTML = list.map((it, idx) => {
      if (it === 'sep') return '<div class="cm-sep"></div>';
      if (it.emojiRow) return `<div class="cm-emoji-row" data-idx="${idx}">${it.emojiRow.map((e) => `<button type="button" class="cm-emoji" data-emoji="${escapeHtml(e)}">${escapeHtml(e)}</button>`).join('')}</div>`;
      const trailing = it.submenu ? icons.chevronRight(16)
        : typeof it.checked === 'boolean' ? `<span class="cm-check ${it.checked ? 'on' : ''}">${it.checked ? icons.check(14) : ''}</span>`
          : it.icon ? it.icon(16) : '';
      return `<div class="cm-item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}" data-idx="${idx}">
        <span class="cm-label">${escapeHtml(it.label)}${it.sub ? `<small class="cm-sub">${escapeHtml(it.sub)}</small>` : ''}</span>${trailing}
      </div>`;
    }).join('');
    document.body.appendChild(menu);
    menus.push(menu);

    // offsetWidth/Height, not getBoundingClientRect: the pop-in animation scales the menu, so its
    // bounding box is smaller than the real size for the first frames and the clamp came up short.
    const rect = { width: menu.offsetWidth, height: menu.offsetHeight };
    const overflows = px + rect.width > window.innerWidth - 8;
    const left = !overflows ? px : level ? menus[level - 1].getBoundingClientRect().left - rect.width - 2 : window.innerWidth - rect.width - 8;
    const top = Math.min(py, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    // Emoji glyphs and fonts can still change the height after the first measurement; settle once more.
    requestAnimationFrame(() => {
      const h = menu.offsetHeight;
      const maxTop = window.innerHeight - h - 8;
      if (parseFloat(menu.style.top) > maxTop) menu.style.top = `${Math.max(8, maxTop)}px`;
    });

    menu.querySelectorAll('.cm-emoji').forEach((btn) => {
      btn.addEventListener('click', () => {
        list[Number(btn.parentElement.dataset.idx)].onPick?.(btn.dataset.emoji);
        remove();
      });
    });

    menu.querySelectorAll('.cm-item').forEach((node) => {
      const item = list[Number(node.dataset.idx)];
      const openSub = () => {
        const r = node.getBoundingClientRect();
        build(item.submenu, r.right + 2, r.top - 6, level + 1);
      };
      node.addEventListener('mouseenter', () => {
        if (item.submenu && !item.disabled) openSub();
        else while (menus.length > level + 1) menus.pop().remove();
      });
      node.addEventListener('click', () => {
        if (item.disabled) return;
        if (item.submenu) { openSub(); return; }
        item.onClick?.();
        remove();
      });
    });
    return menu;
  }

  function remove() {
    while (menus.length) menus.pop().remove();
    document.removeEventListener('mousedown', onDocClick);
    document.removeEventListener('keydown', onKey);
  }
  function onDocClick(e) { if (!menus.some((m) => m.contains(e.target))) remove(); }
  function onKey(e) { if (e.key === 'Escape') remove(); }

  build(items, x, y, 0);
  setTimeout(() => {
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
  }, 0);

  return { remove };
}
