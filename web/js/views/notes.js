import { api } from '../api.js';
import { icons } from '../icons.js';
import { state } from '../state.js';
import { escapeHtml, formatTimestamp, apiErrorMessage, toast } from '../utils.js';
import { confirmModal, promptModal } from './modal.js';
import { getNotesKey, encryptNote, decryptNote, encryptBytes, decryptBytes, newFileTag, packNote, unpackNote } from '../e2ee/notes.js';
import { t } from '../i18n.js';

const MAX_FILES = 5;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Personal encrypted notes (channel type 'notes'): each member only ever sees their own entries,
// decrypted here with a key derived from their Passport seed. The server holds ciphertext only,
// attachments included — name/type/size live inside the encrypted note body.
export function mountNotes(container, { serverId, channelId, channelName, canTrim }) {
  let notes = [];
  let key = null;
  let editingId = null;
  let draftFiles = [];
  let destroyed = false;
  const imageUrls = new Map();
  let hasMore = false;
  let loadingOlder = false;
  const PAGE = 100;

  container.innerHTML = `
    <div class="notes-view" style="flex:1;display:flex;flex-direction:column;min-height:0">
      <div class="notes-list" id="notes-list" style="flex:1;overflow-y:auto;padding:16px"></div>
      <div class="notes-composer" id="notes-composer" style="padding:12px 16px;border-top:1px solid var(--border-subtle)">
        <div id="notes-draft-files" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px"></div>
        <div style="display:flex;gap:8px;align-items:flex-end">
          <button class="btn btn-secondary" id="notes-attach" title="${escapeHtml(t('notes.attachTitle'))}">${icons.paperclip(16)}</button>
          <input type="file" id="notes-file-input" multiple style="display:none">
          <textarea class="textarea" id="notes-input" rows="2" maxlength="4000" style="flex:1;resize:none" placeholder="${escapeHtml(t('notes.placeholder', { channel: channelName || '' }))}"></textarea>
          <button class="btn btn-primary" id="notes-send">${t('notes.saveButton')}</button>
          ${canTrim ? `<button class="btn btn-secondary" id="notes-trim" title="${escapeHtml(t('notes.trimTitle'))}">${icons.trash(16)}</button>` : ''}
        </div>
      </div>
    </div>`;

  const listEl = container.querySelector('#notes-list');
  const input = container.querySelector('#notes-input');
  const sendBtn = container.querySelector('#notes-send');
  const fileInput = container.querySelector('#notes-file-input');
  const draftEl = container.querySelector('#notes-draft-files');

  init();

  async function init() {
    key = await getNotesKey(state.me);
    if (destroyed) return;
    if (!key) {
      listEl.innerHTML = `<div class="empty-state"><p>${t('notes.noKey')}</p></div>`;
      container.querySelector('#notes-composer').style.display = 'none';
      return;
    }
    try {
      const res = await api.listNotes(serverId, channelId);
      notes = await decryptAll(res.notes);
      hasMore = res.notes.length >= PAGE;
    } catch (err) {
      listEl.innerHTML = `<p style="color:var(--danger)">${escapeHtml(apiErrorMessage(err, t('notes.loadError')))}</p>`;
      return;
    }
    render(true);
  }

  const scope = `${location.origin}|${serverId}|${state.me.id}`;
  const decryptAll = (rows) => Promise.all(rows.map(async (n) => ({ ...n, body: unpackNote(await decryptNote(key, channelId, n, scope)) })));

  async function loadOlder() {
    if (!hasMore || loadingOlder || !notes.length) return;
    loadingOlder = true;
    try {
      const res = await api.listNotes(serverId, channelId, notes[0].id);
      hasMore = res.notes.length >= PAGE;
      const older = await decryptAll(res.notes);
      if (destroyed) return;
      const prevHeight = listEl.scrollHeight;
      notes = [...older, ...notes];
      render(false);
      listEl.scrollTop = listEl.scrollHeight - prevHeight;
    } catch (err) {
      toast(apiErrorMessage(err, t('notes.loadError')), { type: 'error' });
    } finally { loadingOlder = false; }
  }
  listEl.addEventListener('scroll', () => { if (listEl.scrollTop < 40) loadOlder(); });

  async function fetchPlain(file) {
    const blob = await api.downloadNoteFile(serverId, channelId, file.id);
    return decryptBytes(key, channelId, blob, file.fk ? { scope, fk: file.fk } : undefined);
  }

  async function saveFile(file) {
    try {
      const bytes = await fetchPlain(file);
      if (!bytes) throw new Error('decrypt');
      const url = URL.createObjectURL(new Blob([bytes], { type: file.type || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      toast(apiErrorMessage(err, t('notes.fileError')), { type: 'error' });
    }
  }

  async function showInlineImage(file, imgEl) {
    try {
      let url = imageUrls.get(file.id);
      if (!url) {
        const bytes = await fetchPlain(file);
        if (!bytes || destroyed) return;
        url = URL.createObjectURL(new Blob([bytes], { type: file.type }));
        imageUrls.set(file.id, url);
      }
      imgEl.src = url;
      imgEl.style.display = '';
    } catch { /* the download chip still works */ }
  }

  function render(scrollDown) {
    if (destroyed) return;
    if (notes.length === 0) {
      listEl.innerHTML = `<div class="channel-intro"><div class="intro-icon">${icons.book(34)}</div><h2>${escapeHtml(channelName || t('notes.defaultName'))}</h2><p>${t('notes.emptyState')}</p></div>`;
      return;
    }
    listEl.innerHTML = notes.map((n) => `
      <div class="note-entry" data-id="${n.id}" style="padding:8px 10px;margin-bottom:8px;border-radius:var(--radius-md);background:var(--bg-hover)">
        <div style="display:flex;gap:8px;align-items:center;color:var(--text-muted);font-size:12px">
          <span>${escapeHtml(formatTimestamp(n.createdAt))}${n.editedAt ? ` · ${t('notes.edited')}` : ''}</span>
          <span style="flex:1"></span>
          <button class="btn-icon" data-edit title="${t('notes.editTitle')}">${icons.edit(14)}</button>
          <button class="btn-icon" data-del title="${t('notes.deleteTitle')}">${icons.trash(14)}</button>
        </div>
        <div class="note-text" style="white-space:pre-wrap;word-break:break-word"></div>
        <div class="note-files" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px"></div>
      </div>`).join('');
    listEl.querySelectorAll('.note-entry').forEach((el) => {
      const n = notes.find((x) => x.id === Number(el.dataset.id));
      const textEl = el.querySelector('.note-text');
      const filesEl = el.querySelector('.note-files');
      if (n.body === null) {
        textEl.textContent = t('notes.undecryptable'); textEl.style.fontStyle = 'italic'; textEl.style.color = 'var(--text-muted)';
      } else {
        textEl.textContent = n.body.text;
        for (const f of n.body.files) {
          const chip = document.createElement('div');
          chip.style.cssText = 'display:flex;flex-direction:column;gap:4px;align-items:flex-start';
          if (INLINE_IMAGE_TYPES.has(f.type) && f.size <= 8 * 1024 * 1024) {
            const img = document.createElement('img');
            img.style.cssText = 'display:none;max-width:320px;max-height:240px;border-radius:var(--radius-md);cursor:pointer';
            img.alt = f.name;
            img.addEventListener('click', () => saveFile(f));
            chip.appendChild(img);
            showInlineImage(f, img);
          }
          const btn = document.createElement('button');
          btn.type = 'button'; btn.className = 'btn btn-secondary btn-sm';
          btn.innerHTML = `${icons.download(14)} `;
          btn.append(`${f.name} (${formatSize(f.size)})`);
          btn.addEventListener('click', () => saveFile(f));
          chip.appendChild(btn);
          filesEl.appendChild(chip);
        }
      }
      el.querySelector('[data-edit]').addEventListener('click', () => startEdit(n));
      el.querySelector('[data-del]').addEventListener('click', () => confirmModal({
        title: t('notes.deleteTitle'), message: t('notes.deleteMessage'), confirmLabel: t('notes.deleteTitle'),
        onConfirm: async () => {
          try { await api.deleteNote(serverId, channelId, n.id); notes = notes.filter((x) => x.id !== n.id); if (editingId === n.id) cancelEdit(); render(); }
          catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
        },
      }));
    });
    if (scrollDown) listEl.scrollTop = listEl.scrollHeight;
  }

  function renderDraft() {
    draftEl.innerHTML = '';
    draftFiles.forEach((f, i) => {
      const chip = document.createElement('span');
      chip.className = 'pill-static';
      chip.style.cssText = 'display:inline-flex;gap:6px;align-items:center';
      chip.append(`${f.name} (${formatSize(f.size)})`);
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'btn-icon'; rm.innerHTML = icons.x(12);
      rm.addEventListener('click', () => removeDraft(i));
      chip.appendChild(rm);
      draftEl.appendChild(chip);
    });
  }

  function removeDraft(i) {
    const [f] = draftFiles.splice(i, 1);
    // Uploaded but never attached: free the server copy right away. Files of a note being edited are
    // only released once the edit is saved.
    if (f && !f.attached) api.deleteNoteFile(serverId, channelId, f.id).catch(() => {});
    renderDraft();
  }

  fileInput.addEventListener('change', async () => {
    const picked = [...fileInput.files];
    fileInput.value = '';
    const maxBytes = (state.config.maxUploadMb || 25) * 1024 * 1024;
    for (const file of picked) {
      if (draftFiles.length >= MAX_FILES) { toast(t('notes.tooManyFiles', { count: MAX_FILES }), { type: 'error' }); break; }
      if (file.size > maxBytes) { toast(t('notes.fileTooLarge', { name: file.name, mb: state.config.maxUploadMb || 25 }), { type: 'error' }); continue; }
      try {
        const fk = newFileTag();
        const blob = await encryptBytes(key, channelId, new Uint8Array(await file.arrayBuffer()), { scope, fk });
        const { file: up } = await api.uploadNoteFile(serverId, channelId, blob);
        if (destroyed) { api.deleteNoteFile(serverId, channelId, up.id).catch(() => {}); return; }
        draftFiles.push({ id: up.id, name: file.name, type: file.type || 'application/octet-stream', size: file.size, fk });
        renderDraft();
      } catch (err) {
        toast(apiErrorMessage(err, t('notes.fileError')), { type: 'error' });
      }
    }
  });
  container.querySelector('#notes-attach').addEventListener('click', () => fileInput.click());

  function startEdit(n) {
    if (n.body === null) return;
    for (const f of draftFiles) if (!f.attached) api.deleteNoteFile(serverId, channelId, f.id).catch(() => {});
    editingId = n.id; input.value = n.body.text;
    draftFiles = n.body.files.map((f) => ({ ...f, attached: true }));
    renderDraft(); input.focus(); sendBtn.textContent = t('notes.updateButton');
  }
  function cancelEdit() {
    for (const f of draftFiles) if (!f.attached) api.deleteNoteFile(serverId, channelId, f.id).catch(() => {});
    editingId = null; draftFiles = []; input.value = ''; renderDraft(); sendBtn.textContent = t('notes.saveButton');
  }

  async function submit() {
    const text = input.value.trim();
    if ((!text && draftFiles.length === 0) || !key || sendBtn.disabled) return;
    sendBtn.disabled = true;
    try {
      const files = draftFiles.map(({ id, name, type, size, fk }) => ({ id, name, type, size, ...(fk ? { fk } : {}) }));
      const payload = { ...(await encryptNote(key, channelId, packNote(text, files), scope)), fileIds: files.map((f) => f.id) };
      const body = { v: 1, text, files };
      if (editingId) {
        const { note } = await api.updateNote(serverId, channelId, editingId, payload);
        const idx = notes.findIndex((n) => n.id === editingId);
        if (idx !== -1) notes[idx] = { ...note, body };
        editingId = null; draftFiles = []; input.value = ''; renderDraft(); sendBtn.textContent = t('notes.saveButton');
        render();
      } else {
        const { note } = await api.createNote(serverId, channelId, payload);
        notes.push({ ...note, body });
        draftFiles = []; input.value = ''; renderDraft(); render(true);
      }
    } catch (err) {
      toast(apiErrorMessage(err, t('notes.saveError')), { type: 'error' });
    } finally { sendBtn.disabled = false; }
  }

  sendBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape' && editingId) cancelEdit();
  });

  container.querySelector('#notes-trim')?.addEventListener('click', async () => {
    const answer = await promptModal({ title: t('notes.trimTitle'), label: t('notes.trimPrompt'), value: '90', confirmLabel: t('notes.trimButton') });
    if (answer === null || answer === undefined) return;
    const days = Number(answer);
    if (!Number.isFinite(days) || days < 0) return;
    const before = new Date(Date.now() - days * 86400000).toISOString();
    confirmModal({
      title: t('notes.trimTitle'), message: t('notes.trimConfirm', { days }), confirmLabel: t('notes.trimButton'),
      onConfirm: async () => {
        try {
          const res = await api.trimNotes(serverId, channelId, { before });
          toast(t('notes.trimDone', { count: res.deleted }));
          init();
        } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
      },
    });
  });

  return {
    destroy() {
      destroyed = true;
      for (const u of imageUrls.values()) URL.revokeObjectURL(u);
      for (const f of draftFiles) if (!f.attached) api.deleteNoteFile(serverId, channelId, f.id).catch(() => {});
    },
  };
}
