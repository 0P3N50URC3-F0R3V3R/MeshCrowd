import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, toast } from '../../js/utils.js';
import { state, nameFor } from '../../js/state.js';
import { actionSheet } from './bottomSheet.js';
import { onLongPress } from '../lib/longPress.js';
import { canRecordVoice, openRecorderBar } from '../../js/voiceMessage.js';

export function mountComposer(host, opts) {
  if (!opts.canSend) {
    host.innerHTML = `<div class="m-readonly">${escapeHtml(opts.readOnlyText || t('m.readOnly'))}</div>`;
    return { setReply() {}, getReply: () => null, setEdit() {}, clearAfterSend() {}, focus() {}, destroy() {} };
  }
  let reply = null;
  let editing = null;
  let files = [];
  let lastTyping = 0;
  host.innerHTML = `
    <div class="m-composer">
      <div class="m-banner" id="c-banner" hidden></div>
      <div class="m-files" id="c-files" hidden></div>
      <div class="m-composer-row">
        <textarea id="c-input" rows="1" enterkeyhint="enter" autocomplete="off" autocapitalize="sentences" spellcheck="true"
          placeholder="${escapeHtml(opts.placeholder)}"></textarea>
        <div class="m-composer-actions">
        ${opts.attachEnabled ? `<button class="m-icon-btn" id="c-plus" aria-label="${t('m.attach')}">${icons.plus(22)}</button>` : ''}
        ${opts.onEmoji ? `<button class="m-icon-btn" id="c-emoji" aria-label="${t('m.emoji')}">${icons.smile(22)}</button>` : ''}
        ${opts.onSticker ? `<button class="m-icon-btn" id="c-sticker" aria-label="${t('m.stickers')}">${icons.sticker(22)}</button>` : ''}
        ${opts.onVoice && canRecordVoice() ? `<button class="m-icon-btn" id="c-mic" aria-label="${t('voiceMsg.record')}">${icons.mic(22)}</button>` : ''}
        <span class="m-grow"></span>
        <button class="m-send" id="c-send" aria-label="${t('m.send')}" disabled>${icons.send(20)}</button>
        </div>
      </div>
      <input type="file" id="c-file-media" accept="image/*,video/*" multiple hidden>
      <input type="file" id="c-file-any" multiple hidden>
    </div>`;
  const input = host.querySelector('#c-input');
  const sendBtn = host.querySelector('#c-send');
  const banner = host.querySelector('#c-banner');
  const tray = host.querySelector('#c-files');

  const refresh = () => {
    sendBtn.disabled = !input.value.trim() && !files.length;
    const mic = host.querySelector('#c-mic');
    if (mic) mic.hidden = !!input.value.trim() || !!files.length || !!editing;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    banner.hidden = !reply && !editing;
    if (editing) banner.innerHTML = `<span>${t('m.editingMessage')}</span><button class="m-icon-btn" data-clear>${icons.x(16)}</button>`;
    else if (reply) banner.innerHTML = `<span>${escapeHtml(t('m.replyingTo', { name: nameFor(reply.author) }))}</span><button class="m-icon-btn" data-clear>${icons.x(16)}</button>`;
    tray.hidden = !files.length;
    tray.innerHTML = files.map((f, i) => `<span class="m-file-chip">${escapeHtml(f.name)}<button data-rm="${i}" aria-label="${t('m.cancel')}">${icons.x(12)}</button></span>`).join('');
  };

  function addFiles(list) {
    const max = (state.config.maxUploadMb || 25) * 1024 * 1024;
    for (const f of list) {
      if (f.size > max) { toast(t('m.fileTooBig', { mb: state.config.maxUploadMb || 25 }), { type: 'error' }); continue; }
      files.push(f);
    }
    refresh();
  }

  function clearAfterSend() { input.value = ''; files = []; reply = null; refresh(); }

  async function submit() {
    const text = input.value.trim();
    if (!text && !files.length) return;
    sendBtn.disabled = true;
    if (editing) {
      const ok = await opts.onEdit(editing, text);
      if (ok) { editing = null; input.value = ''; }
    } else {
      // onSend reads the pending reply through getReply(); clearAfterSend() below resets it.
      const ok = await opts.onSend({ text, files: files.slice() });
      if (ok) clearAfterSend();
    }
    refresh();
    input.focus(); // inside the tap gesture, so the soft keyboard stays up
  }

  input.addEventListener('input', () => {
    refresh();
    opts.onInput?.(input.value);
    const now = Date.now();
    if (opts.onTyping && input.value && now - lastTyping > 3000) { lastTyping = now; opts.onTyping(); }
  });
  sendBtn.addEventListener('click', submit);
  banner.addEventListener('click', (e) => { if (e.target.closest('[data-clear]')) { reply = null; if (editing) { editing = null; input.value = ''; } refresh(); } });
  tray.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { files.splice(Number(b.dataset.rm), 1); refresh(); } });
  host.querySelector('#c-file-media').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  host.querySelector('#c-file-any').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  host.querySelector('#c-plus')?.addEventListener('click', async () => {
    const id = await actionSheet({ title: t('m.attach'), items: [
      { id: 'media', icon: icons.image(20), label: t('m.attachPhoto') },
      { id: 'file', icon: icons.file(20), label: t('m.attachFile') },
      opts.onPoll && { id: 'poll', icon: icons.users(20), label: t('m.attachPoll') },
    ].filter(Boolean) });
    if (id === 'media') host.querySelector('#c-file-media').click();
    else if (id === 'file') host.querySelector('#c-file-any').click();
    else if (id === 'poll') opts.onPoll();
  });
  function insertText(text) {
    const a = input.selectionStart ?? input.value.length;
    const b = input.selectionEnd ?? a;
    input.value = input.value.slice(0, a) + text + input.value.slice(b);
    input.setSelectionRange(a + text.length, a + text.length);
    refresh();
    input.focus();
    opts.onInput?.(input.value);
  }
  host.querySelector('#c-emoji')?.addEventListener('click', async () => {
    const e = await opts.onEmoji();
    if (e) insertText(e);
  });
  host.querySelector('#c-sticker')?.addEventListener('click', () => opts.onSticker());
  host.querySelector('#c-mic')?.addEventListener('click', async () => {
    const barHost = host.querySelector('#c-banner');
    if (host.querySelector('.voice-recorder')) return;
    banner.hidden = false;
    await openRecorderBar(barHost, {
      onSend: async (clip) => { await opts.onVoice({ ...clip, replyToMessageId: reply?.id }); reply = null; refresh(); },
      onError: () => toast(t('voiceMsg.noMic'), { type: 'error' }),
    });
    if (!barHost.querySelector('.voice-recorder')) refresh();
  });
  // Holding the send button offers "send later" for what is typed (never while editing).
  if (opts.onSchedule) {
    onLongPress(host.querySelector('.m-composer-row'), '#c-send', async () => {
      const text = input.value.trim();
      if (!text || editing) return;
      if (await opts.onSchedule({ text, replyToMessageId: reply?.id })) clearAfterSend();
    });
  }
  refresh();

  return {
    setReply(msg) { editing = null; reply = msg; refresh(); if (msg) input.focus(); },
    getReply: () => reply,
    setEdit(msg) { reply = null; editing = msg; input.value = msg ? msg.content : ''; refresh(); if (msg) input.focus(); },
    clearAfterSend,
    focus: () => input.focus(),
    insertText,
    getText: () => input.value,
    setText(value) { input.value = value; refresh(); input.focus(); opts.onInput?.(value); },
    destroy() {},
  };
}
