import { api } from '../api.js';
import { icons } from '../icons.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { confirmModal, promptModal } from './modal.js';
import { t } from '../i18n.js';
import {
  splitDocument, joinDocument, protectPhp, restorePhp, relativeAsset, isVisualCandidate, modeForPath, canonicalHtml,
} from '../siteDoc.js';

const CM = '/vendor/codemirror/';
const TINY = '/vendor/tinymce';
const loaded = new Map();

function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { loaded.delete(src); reject(new Error(`failed to load ${src}`)); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(src);
}

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

async function loadCodeMirror() {
  loadCss(`${CM}lib/codemirror.css`);
  loadCss(`${CM}theme/material-darker.css`);
  await loadScript(`${CM}lib/codemirror.js`);
  for (const m of ['mode/xml/xml.js', 'mode/javascript/javascript.js', 'mode/css/css.js', 'mode/htmlmixed/htmlmixed.js',
    'mode/clike/clike.js', 'mode/php/php.js', 'addon/edit/matchbrackets.js', 'addon/selection/active-line.js']) {
    await loadScript(CM + m);
  }
}

const loadTiny = () => loadScript(`${TINY}/tinymce.min.js`);
// The app has its own themes, so judge by the rendered page background rather than the OS preference.
function isDark() {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
  if (!m) return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) < 128;
}

export function mountSiteEditor(container, { server, onClose }) {
  const id = server.id;
  const tabs = new Map(); // path -> { path, doc, mtimeMs, binary }
  let files = [];
  let active = null;
  let cm = null;
  let visual = null; // { ed, split, blocks, tab }

  container.innerHTML = `
    <div class="se-wrap">
      <div class="se-tree">
        <div class="se-tree-head">
          <strong>${t('sites.editor.files')}</strong><div class="spacer"></div>
          <button class="btn-icon" data-act="new-file" title="${t('sites.editor.newFile')}">${icons.file(16)}</button>
          <button class="btn-icon" data-act="new-dir" title="${t('sites.editor.newFolder')}">${icons.plus(16)}</button>
          <button class="btn-icon" data-act="upload" title="${t('sites.editor.upload')}">${icons.paperclip(16)}</button>
          <input type="file" id="se-upload" hidden multiple>
        </div>
        <div class="se-tree-list" id="se-list"></div>
      </div>
      <div class="se-main">
        <div class="se-bar">
          <div class="se-tabs" id="se-tabs"></div>
          <button class="btn btn-secondary" id="se-toggle" hidden>${t('sites.editor.visual')}</button>
          <button class="btn btn-primary" id="se-save">${t('sites.editor.save')}</button>
          <button class="btn btn-secondary" id="se-preview">${t('sites.editor.preview')}</button>
        </div>
        <div class="se-notice">${escapeHtml(t('sites.editor.notice'))}</div>
        <div class="se-host">
          <div id="se-cm" hidden></div>
          <div id="se-visual" hidden><textarea id="se-ta"></textarea></div>
          <div class="se-empty" id="se-empty">${t('sites.editor.empty')}</div>
        </div>
      </div>
    </div>`;
  const $ = (sel) => container.querySelector(sel);

  async function refreshTree() {
    try { files = (await api.siteFiles(id)).files; } catch (e) { toast(apiErrorMessage(e, t('sites.editor.loadFailed')), { type: 'error' }); return; }
    $('#se-list').innerHTML = files.map((f) => {
      const depth = f.path.split('/').length - 1;
      const name = f.path.split('/').pop();
      return `<div class="se-node ${f.path === active ? 'active' : ''}" data-path="${escapeHtml(f.path)}" data-type="${f.type}" style="padding-left:${8 + depth * 14}px">
        ${f.type === 'dir' ? icons.chevronRight(14) : icons.file(14)}<span>${escapeHtml(name)}</span>
        <span class="se-actions">
          <button class="btn-icon" data-act="rename" title="${t('sites.editor.rename')}">${icons.edit(14)}</button>
          <button class="btn-icon" data-act="delete" title="${t('sites.editor.delete')}">${icons.trash(14)}</button>
        </span></div>`;
    }).join('');
  }

  function renderTabs() {
    for (const tab of tabs.values()) tab.shownDirty = !!tab.doc && !tab.doc.isClean();
    $('#se-tabs').innerHTML = [...tabs.values()].map((tab) => `
      <div class="se-tab ${tab.path === active ? 'active' : ''}" data-tab="${escapeHtml(tab.path)}">
        ${escapeHtml(tab.path.split('/').pop())}${tab.doc && !tab.doc.isClean() ? '<span class="dirty">●</span>' : ''}
        <span data-close="${escapeHtml(tab.path)}">${icons.x(12)}</span>
      </div>`).join('');
    const tab = tabs.get(active);
    $('#se-toggle').hidden = !(tab && !tab.binary && isVisualCandidate(tab.path));
    $('#se-toggle').textContent = visual ? t('sites.editor.code') : t('sites.editor.visual');
  }

  async function ensureCm() {
    if (cm) return;
    await loadCodeMirror();
    cm = window.CodeMirror($('#se-cm'), {
      lineNumbers: true, indentUnit: 2, tabSize: 2, indentWithTabs: false, matchBrackets: true, styleActiveLine: true,
      theme: isDark() ? 'material-darker' : 'default', lineWrapping: false, value: '',
    });
    cm.on('change', () => {
      const tab = tabs.get(active);
      if (tab && tab.doc && !tab.doc.isClean() !== !!tab.shownDirty) renderTabs();
    });
  }

  function syncFromVisual() {
    if (!visual) return;
    if (visual.ed.isDirty()) {
      const body = restorePhp(visual.ed.getContent(), visual.blocks);
      const next = joinDocument({ ...visual.split, body });
      if (next !== visual.tab.doc.getValue()) visual.tab.doc.setValue(next);
      visual.ed.setDirty(false);
    }
  }

  function leaveVisual({ apply }) {
    if (!visual) return;
    if (apply) syncFromVisual();
    visual.ed.remove();
    visual = null;
    $('#se-visual').hidden = true;
    $('#se-cm').hidden = false;
    cm?.refresh();
  }

  async function show(path) {
    if (visual) leaveVisual({ apply: true });
    active = path;
    const tab = tabs.get(path);
    $('#se-empty').hidden = !!tab;
    $('#se-cm').hidden = !tab || tab.binary;
    if (tab && !tab.binary) { await ensureCm(); cm.swapDoc(tab.doc); cm.refresh(); cm.focus(); }
    if (tab && tab.binary) { $('#se-empty').hidden = false; $('#se-empty').textContent = t('sites.editor.binaryNote'); }
    else $('#se-empty').textContent = t('sites.editor.empty');
    renderTabs();
    $('#se-list').querySelectorAll('.se-node').forEach((n) => n.classList.toggle('active', n.dataset.path === path));
  }

  async function openFile(path) {
    if (!tabs.has(path)) {
      try {
        const res = await api.siteReadFile(id, path);
        await ensureCm();
        if (res.binary) tabs.set(path, { path, binary: true, mtimeMs: res.mtimeMs });
        else tabs.set(path, { path, binary: false, mtimeMs: res.mtimeMs, doc: window.CodeMirror.Doc(res.content, modeForPath(path)) });
      } catch (e) { toast(apiErrorMessage(e, t('sites.editor.loadFailed')), { type: 'error' }); return; }
    }
    await show(path);
  }

  async function closeTab(path) {
    const tab = tabs.get(path);
    if (tab && tab.doc && !tab.doc.isClean() && !window.confirm(t('sites.editor.unsaved'))) return;
    if (active === path && visual) leaveVisual({ apply: false });
    tabs.delete(path);
    if (active === path) await show([...tabs.keys()].pop() || null);
    else renderTabs();
  }

  async function save(force = false) {
    const tab = tabs.get(active);
    if (!tab || tab.binary) return;
    syncFromVisual();
    try {
      const res = await api.siteWriteFile(id, tab.path, tab.doc.getValue(), { mtimeMs: tab.mtimeMs, force });
      tab.mtimeMs = res.mtimeMs;
      tab.doc.markClean();
      renderTabs();
      toast(t('sites.editor.saved'));
    } catch (e) {
      if (e.status === 409) {
        confirmModal({ title: t('sites.editor.save'), message: escapeHtml(t('sites.editor.saveConflict')), confirmLabel: t('sites.editor.overwrite'), onConfirm: () => save(true) });
      } else toast(apiErrorMessage(e, t('sites.editor.saveFailed')), { type: 'error' });
    }
  }

  async function uploadAsset(blob, name) {
    const safe = `${Date.now()}-${name.replace(/[^\p{L}\p{N}._-]/gu, '_')}`;
    const path = `assets/${safe}`;
    await api.siteWriteFile(id, path, blob, { force: true });
    await refreshTree();
    return path;
  }

  async function enterVisual(tab) {
    await loadTiny();
    const split = splitDocument(tab.doc.getValue());
    const { html, blocks } = protectPhp(split.body);
    $('#se-cm').hidden = true;
    $('#se-visual').hidden = false;
    $('#se-ta').value = html;
    const dark = isDark();
    const [ed] = await window.tinymce.init({
      target: $('#se-ta'), base_url: TINY, suffix: '.min',
      license_key: 'gpl', menubar: false, branding: false, promotion: false, statusbar: false,
      skin: dark ? 'oxide-dark' : 'oxide', content_css: dark ? 'dark' : 'default',
      plugins: 'lists link image table autolink',
      toolbar: 'undo redo | blocks | bold italic underline | alignleft aligncenter alignright | bullist numlist | link image table | removeformat',
      convert_urls: false, relative_urls: false, remove_script_host: false, verify_html: false,
      entity_encoding: 'raw', element_format: 'html', allow_unsafe_link_target: true,
      content_style: '.php-ph{background:#fde68a;color:#78350f;border-radius:3px;padding:0 4px;font:12px monospace}',
      images_upload_handler: async (blobInfo) => relativeAsset(tab.path, await uploadAsset(blobInfo.blob(), blobInfo.filename())),
    });
    if (canonicalHtml(ed.getContent()) !== canonicalHtml(html)) {
      ed.remove();
      $('#se-visual').hidden = true;
      $('#se-cm').hidden = false;
      toast(t('sites.editor.visualUnsupported'), { type: 'error', ttl: 8000 });
      return;
    }
    ed.setDirty(false);
    visual = { ed, split, blocks, tab };
  }

  $('#se-toggle').addEventListener('click', async () => {
    const tab = tabs.get(active);
    if (!tab) return;
    if (visual) leaveVisual({ apply: true });
    else await enterVisual(tab);
    renderTabs();
  });
  $('#se-save').addEventListener('click', () => save());
  $('#se-preview').addEventListener('click', () => {
    if ([...tabs.values()].some((tab) => tab.doc && !tab.doc.isClean()) && !window.confirm(t('sites.editor.unsaved'))) return;
    onClose?.();
  });

  $('#se-tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) return closeTab(close.dataset.close);
    const tabEl = e.target.closest('[data-tab]');
    if (tabEl) show(tabEl.dataset.tab);
  });

  async function newEntry(kind, dir) {
    const name = await promptModal({ title: kind === 'dir' ? t('sites.editor.newFolder') : t('sites.editor.newFile'), label: t('sites.editor.namePrompt') });
    if (!name) return;
    const p = dir ? `${dir}/${name.trim()}` : name.trim();
    try {
      if (kind === 'dir') await api.siteMkdir(id, p);
      else await api.siteWriteFile(id, p, '', { force: true });
      await refreshTree();
      if (kind === 'file') await openFile(p);
    } catch (e) { toast(apiErrorMessage(e, t('sites.editor.saveFailed')), { type: 'error' }); }
  }

  container.querySelector('.se-tree-head').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const selected = files.find((f) => f.path === active);
    const dir = selected ? (selected.type === 'dir' ? selected.path : selected.path.split('/').slice(0, -1).join('/')) : '';
    if (act === 'new-file') newEntry('file', dir);
    else if (act === 'new-dir') newEntry('dir', dir);
    else if (act === 'upload') $('#se-upload').click();
  });
  $('#se-upload').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      try { await api.siteWriteFile(id, file.name, file, { force: true }); } catch (err) { toast(apiErrorMessage(err, t('sites.editor.saveFailed')), { type: 'error' }); }
    }
    e.target.value = '';
    await refreshTree();
  });

  $('#se-list').addEventListener('click', async (e) => {
    const node = e.target.closest('.se-node');
    if (!node) return;
    const path = node.dataset.path;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'rename') {
      const to = await promptModal({ title: t('sites.editor.rename'), label: t('sites.editor.namePrompt'), value: path });
      if (!to || to === path) return;
      try { await api.siteRename(id, path, to.trim()); tabs.delete(path); await refreshTree(); renderTabs(); } catch (err) { toast(apiErrorMessage(err, t('sites.editor.saveFailed')), { type: 'error' }); }
    } else if (act === 'delete') {
      confirmModal({
        title: t('sites.editor.delete'), message: escapeHtml(t('sites.editor.deleteFileConfirm', { name: path })),
        confirmLabel: t('sites.editor.delete'),
        async onConfirm() {
          try { await api.siteRemoveFile(id, path); for (const k of [...tabs.keys()]) if (k === path || k.startsWith(`${path}/`)) tabs.delete(k); await refreshTree(); if (!tabs.has(active)) await show([...tabs.keys()].pop() || null); } catch (err) { toast(apiErrorMessage(err, t('sites.editor.saveFailed')), { type: 'error' }); }
        },
      });
    } else if (node.dataset.type === 'file') openFile(path);
  });

  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
  document.addEventListener('keydown', onKey);

  refreshTree();
  renderTabs();
  return {
    destroy() {
      document.removeEventListener('keydown', onKey);
      if (visual) { visual.ed.remove(); visual = null; }
      container.innerHTML = '';
    },
  };
}
