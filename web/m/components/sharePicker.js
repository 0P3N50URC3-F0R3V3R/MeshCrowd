import { api } from '../../js/api.js';
import { state, nameFor, dmPrefFor } from '../../js/state.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, toast, formatBytes, apiErrorMessage, avatarHtml, serverIconHtml } from '../../js/utils.js';
import { PERMISSIONS, has, memberPermissionBits, channelPermissionBits } from '../../js/permissions.js';
import { ensureServerDetail } from '../data.js';
import { openSheet, closeTopSheet } from './bottomSheet.js';
import { androidBridge } from '../lib/androidBridge.js';
import { getPref, setPref } from '../lib/prefs.js';
import { dmTitle } from '../lib/dmPreview.mjs';
import { buildTargets, filterTargets, buildMessage, pushRecent, parseKey } from '../lib/shareTargets.mjs';

const RECENTS_PREF = 'shareRecents';

function readRecents() {
  try { const v = JSON.parse(getPref(RECENTS_PREF, '[]')); return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []; } catch { return []; }
}

// Every text channel of every server of this instance that the user may write in, plus all direct messages.
async function loadTargets() {
  const servers = [];
  for (const s of state.servers.filter((x) => x.kind !== 'site')) {
    let detail;
    try { detail = await ensureServerDetail(s.id); } catch { continue; }
    const isOwner = detail.server.owner_id === state.me.id;
    const me = detail.members.find((m) => m.user.id === state.me.id);
    const memberBits = memberPermissionBits(detail.server, detail.roles, me, state.me.id);
    const timedOut = !!(me?.timeoutUntil && new Date(me.timeoutUntil) > new Date());
    servers.push({
      id: s.id,
      name: s.name,
      server: s,
      channels: detail.channels.map((c) => ({ id: c.id, name: c.name, type: c.type, canSend: !timedOut && has(channelPermissionBits(c, detail.roles, me, memberBits, isOwner), PERMISSIONS.SEND_MESSAGES) })),
    });
  }
  const dms = state.dms.map((d) => ({ id: d.id, title: dmTitle(d, nameFor), who: d.isGroup ? { id: d.id, displayName: dmTitle(d, nameFor) } : d.members[0], lastId: d.lastMessage?.id || 0, pinned: !!dmPrefFor(d.id).pinned, hidden: !!dmPrefFor(d.id).hidden }));
  return buildTargets({ dms, servers, recents: readRecents() });
}

function previewHtml(share) {
  const parts = [];
  if (share.subject) parts.push(`<div class="m-share-subject">${escapeHtml(share.subject)}</div>`);
  if (share.text) parts.push(`<div class="m-share-text">${escapeHtml(share.text.length > 400 ? `${share.text.slice(0, 400)}…` : share.text)}</div>`);
  if (share.files.length) {
    parts.push(`<div class="m-share-files">${share.files.map((f) => (/^image\//i.test(f.mime)
      ? `<img class="m-share-thumb" src="/__mcshare/${encodeURIComponent(f.id)}" alt="">`
      : `<span class="m-file-chip">${escapeHtml(f.name)}${f.size >= 0 ? ` · ${escapeHtml(formatBytes(f.size))}` : ''}</span>`)).join('')}</div>`);
  }
  return `<div class="m-share-preview">${parts.join('')}</div>`;
}

async function fetchFiles(share) {
  const limit = (state.config.maxUploadMb || 25) * 1024 * 1024;
  for (const f of share.files) if (f.size > limit) throw new Error(t('m.shareFileTooLarge', { name: f.name, mb: state.config.maxUploadMb || 25 }));
  const out = [];
  for (const f of share.files) {
    const res = await fetch(`/__mcshare/${encodeURIComponent(f.id)}`);
    if (!res.ok) throw new Error(t('m.shareFileUnreadable', { name: f.name }));
    const blob = await res.blob();
    if (blob.size > limit) throw new Error(t('m.shareFileTooLarge', { name: f.name, mb: state.config.maxUploadMb || 25 }));
    out.push(new File([blob], f.name, { type: f.mime || blob.type }));
  }
  return out;
}

async function send(share, target, note, onProgress) {
  const files = await fetchFiles(share);
  const content = buildMessage({ text: share.text, subject: share.subject, note }, state.config.maxMessageChars || 15000);
  if (!content && !files.length) throw new Error(t('m.shareEmpty'));
  const o = { content, files, onProgress };
  if (target.kind === 'dm') return api.sendDmMessage(target.dmId, o);
  return api.sendChannelMessage(target.serverId, target.channelId, o);
}

function parseShare(raw) {
  try {
    const s = JSON.parse(raw);
    return {
      text: String(s.text || ''), subject: String(s.subject || ''), target: typeof s.target === 'string' ? s.target : '',
      files: (Array.isArray(s.files) ? s.files : []).map((f) => ({ id: String(f.id), name: String(f.name || 'file'), mime: String(f.mime || ''), size: Number(f.size) })),
    };
  } catch { return null; }
}

// Direct Share: the four most recent destinations appear in the system share sheet.
export async function publishShareTargets() {
  const bridge = androidBridge();
  if (!bridge || !bridge.hasShareSupport) return;
  const recents = readRecents();
  if (!recents.length) { bridge.setShareTargets([]); return; }
  const byKey = new Map((await loadTargets()).map((x) => [x.key, x]));
  bridge.setShareTargets(recents.map((k) => byKey.get(k)).filter(Boolean).slice(0, 4).map((x) => ({ id: x.key, label: x.sub ? `${x.title} · ${x.sub}` : x.title })));
}

let open = false;

export async function openSharePicker(share) {
  if (open) return;
  open = true;
  const bridge = androidBridge();
  let sent = false;
  const targets = await loadTargets();
  let selected = parseKey(share.target) && targets.find((x) => x.key === share.target) ? share.target : null;
  let query = '';
  let busy = false;
  const sectionLabel = { recent: t('m.shareRecent'), dms: t('m.shareDms'), channels: t('m.shareChannels') };

  openSheet({
    title: t('m.shareTitle'),
    onClose: () => { open = false; if (!sent) bridge?.finishShare(); },
    html: `${previewHtml(share)}
      <input class="m-input" id="m-share-q" type="search" autocomplete="off" placeholder="${escapeHtml(t('m.shareSearchPh'))}">
      <div class="m-share-list" id="m-share-list"></div>
      <textarea class="m-input" id="m-share-note" rows="2" maxlength="2000" placeholder="${escapeHtml(t('m.shareNotePh'))}"></textarea>
      <div class="error-text" id="m-share-err"></div>
      <button class="btn btn-primary btn-block" id="m-share-send" disabled>${escapeHtml(t('m.shareSend'))}</button>`,
    onMount: (body) => {
      const list = body.querySelector('#m-share-list');
      const sendBtn = body.querySelector('#m-share-send');
      const err = body.querySelector('#m-share-err');
      const paint = () => {
        const shown = filterTargets(targets, query);
        let last = '';
        list.innerHTML = shown.length ? shown.map((x) => {
          const head = x.section !== last ? `<div class="m-section">${escapeHtml(sectionLabel[x.section])}</div>` : '';
          last = x.section;
          return `${head}<button class="m-row${x.key === selected ? ' selected' : ''}" data-key="${escapeHtml(x.key)}">${x.kind === 'dm' ? avatarHtml(x.who, 32) : `<span class="m-share-srv">${serverIconHtml(x.server, 32)}</span>`}<span class="m-grow"><b>${escapeHtml(x.title)}</b>${x.sub ? `<small>${escapeHtml(x.sub)}</small>` : ''}</span>${x.key === selected ? '<span class="m-share-check">✓</span>' : ''}</button>`;
        }).join('') : `<div class="m-empty">${escapeHtml(t('m.shareNoTargets'))}</div>`;
        sendBtn.disabled = !selected || busy;
      };
      list.addEventListener('click', (e) => { const row = e.target.closest('[data-key]'); if (row && !busy) { selected = row.dataset.key; paint(); } });
      body.querySelector('#m-share-q').addEventListener('input', (e) => { query = e.target.value; paint(); });
      sendBtn.addEventListener('click', async () => {
        const target = parseKey(selected);
        if (!target || busy) return;
        busy = true; err.textContent = ''; sendBtn.disabled = true;
        sendBtn.textContent = t('m.shareSending');
        try {
          await send(share, target, body.querySelector('#m-share-note').value, (p) => { if (typeof p === 'number') sendBtn.textContent = `${t('m.shareSending')} ${Math.round(p * 100)}%`; });
          setPref(RECENTS_PREF, JSON.stringify(pushRecent(readRecents(), selected)));
          const name = targets.find((x) => x.key === selected)?.title || '';
          sent = true;
          toast(t('m.shareSentTo', { name }));
          closeTopSheet();
          publishShareTargets().catch(() => {});
          bridge?.finishShare();
        } catch (e) {
          err.textContent = apiErrorMessage(e, e?.message || t('m.shareFailed'));
          busy = false; sendBtn.textContent = t('m.shareSend'); paint();
        }
      });
      paint();
    },
  });
}

// Android hands over what other apps shared ("Send to MeshCrowd"): once the app is up, and again whenever a new share
// arrives while it is open.
export function initShare() {
  const bridge = androidBridge();
  if (!bridge || !bridge.hasShareSupport) return;
  const check = () => {
    const raw = bridge.takeShare();
    if (!raw) return;
    const share = parseShare(raw);
    if (share && (share.text || share.files.length)) openSharePicker(share);
  };
  window.addEventListener('mc-share', check);
  check();
  setTimeout(() => publishShareTargets().catch(() => {}), 5000);
}
