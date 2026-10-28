import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { serverEventText } from '../../js/eventText.js';
import {
  escapeHtml, avatarHtml, formatTimestamp, formatShortTime, renderMessageContent, isEmojiOnly, formatBytes, isImageMime, isVideoMime,
} from '../../js/utils.js';
import { nameFor } from '../../js/state.js';
import { memberNameColor } from '../../js/permissions.js';
import { memberRoleIcon, roleIconHtml } from '../../js/roleIcon.js';
import { shouldCompact } from '../lib/messageList.mjs';
import { messageText } from '../lib/dmPreview.mjs';
import { e2eeFileKind } from '../lib/e2eeFiles.mjs';
import { pollHtml } from './pollCard.js';
import { voiceMessageHtml } from '../../js/voiceMessage.js';

function replyHtml(r) {
  if (!r) return '';
  const body = r.isEncrypted ? t('m.dmPreviewEncrypted') : (r.content || t('m.dmPreviewAttachment'));
  return `<div class="m-reply" data-goto="${r.id}">${icons.reply(12)}<b>${escapeHtml(r.author?.displayName || '')}</b><span>${escapeHtml(String(body).slice(0, 120))}</span></div>`;
}

function attachmentsHtml(msg) {
  const out = [];
  for (const a of msg.attachments || []) {
    const url = escapeHtml(a.url);
    if (a.voiceMs && (a.mimeType || '').startsWith('audio/')) { out.push(voiceMessageHtml(a)); continue; }
    if (isImageMime(a.mimeType)) out.push(`<img class="m-att-img" data-viewer="${url}" src="${url}" alt="${escapeHtml(a.fileName)}" loading="lazy">`);
    else if (isVideoMime(a.mimeType)) out.push(`<video class="m-att-video" src="${url}" controls preload="metadata" playsinline></video>`);
    else if ((a.mimeType || '').startsWith('audio/')) out.push(`<audio class="m-att-audio" src="${url}" controls preload="none"></audio>`);
    else out.push(`<a class="m-att-file" href="${url}" download="${escapeHtml(a.fileName)}">${icons.file(18)}<span class="m-grow"><b>${escapeHtml(a.fileName)}</b><small>${formatBytes(a.sizeBytes)}</small></span></a>`);
  }
  for (const f of msg.e2eeFiles || []) {
    if (e2eeFileKind(f) === 'image') out.push(`<img class="m-att-img" data-e2ee-img="${escapeHtml(f.id)}" alt="${escapeHtml(f.name)}">`);
    else out.push(`<button class="m-att-file" data-e2ee-dl="${escapeHtml(f.id)}">${icons.lock(16)}<span class="m-grow"><b>${escapeHtml(f.name)}</b><small>${formatBytes(f.size)}</small></span></button>`);
  }
  return out.length ? `<div class="m-atts">${out.join('')}</div>` : '';
}

function embedHtml(e) {
  if (!e || !e.url) return '';
  let host = '';
  try { host = new URL(e.url).hostname; } catch { /* keep empty */ }
  return `<a class="link-embed m-embed" href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">
    <div class="link-embed-site">${escapeHtml(e.siteName || host)}</div>
    ${e.title ? `<div class="link-embed-title">${escapeHtml(e.title)}</div>` : ''}
    ${e.description ? `<div class="link-embed-desc">${escapeHtml(e.description)}</div>` : ''}
    ${e.image ? `<img class="link-embed-image" src="${escapeHtml(e.image)}" alt="" loading="lazy">` : ''}</a>`;
}

function reactionGlyph(emoji, customEmoji) {
  const m = /^:([a-zA-Z0-9_]{2,32}):$/.exec(emoji);
  const custom = m && (customEmoji || []).find((e) => e.name.toLowerCase() === m[1].toLowerCase());
  return custom ? `<img class="custom-emoji" src="${escapeHtml(custom.image_path)}" alt="${escapeHtml(emoji)}">` : escapeHtml(emoji);
}

function reactionsHtml(msg, meId, customEmoji) {
  if (!msg.reactions?.length) return '';
  return `<div class="m-reacts">${msg.reactions.map((r) => `
    <button class="m-react${r.userIds.includes(meId) ? ' mine' : ''}" data-react="${escapeHtml(r.emoji)}">${reactionGlyph(r.emoji, customEmoji)} <span>${r.userIds.length}</span></button>`).join('')}</div>`;
}

export function authorDisplay(msg, detail) {
  const member = detail?.members?.find((m) => m.user.id === msg.author.id);
  return member?.nickname || nameFor(msg.author) || msg.author.username;
}

export function messageHtml(msg, ctx) {
  if (msg.eventType) return `<div class="m-event" data-id="${msg.id}">${escapeHtml(serverEventText(msg) || msg.content || '')}</div>`;
  const compact = shouldCompact(ctx.prev, msg);
  const member = ctx.detail?.members?.find((m) => m.user.id === msg.author.id);
  const color = member ? memberNameColor(ctx.detail.roles, member) : null;
  const hidden = messageText(msg, null) === null;
  const text = hidden
    ? `<i class="m-decrypt-failed">${t('m.decryptFailed')}</i>`
    : (msg.content ? `<div class="m-text${isEmojiOnly(msg.content, ctx.detail?.customEmoji) ? ' m-emoji-only' : ''}">${renderMessageContent(msg.content, { channels: ctx.detail?.channels, customEmoji: ctx.detail?.customEmoji, rawHtmlEnabled: !!ctx.detail?.server?.raw_html_enabled })}</div>` : '');
  return `
  <div class="m-msg${compact ? ' compact' : ''}${msg.author.id === ctx.meId ? ' mine' : ''}" data-id="${msg.id}">
    <div class="m-msg-avatar" ${compact ? '' : `data-user="${msg.author.id}"`}>${compact ? '' : avatarHtml(msg.author, 36)}</div>
    <div class="m-msg-body">
      ${msg.interaction ? `<div class="m-interaction">${icons.messageSquare(12)} ${t('slash.usedCommand', { user: escapeHtml(msg.interaction.user?.displayName || '?'), command: escapeHtml(msg.interaction.command) })}</div>` : ''}
      ${compact ? '' : `<div class="m-msg-head"><b class="m-msg-name" data-user="${msg.author.id}" ${color ? `style="color:${escapeHtml(color)}"` : ''}>${escapeHtml(authorDisplay(msg, ctx.detail))}</b>${member ? roleIconHtml(memberRoleIcon(ctx.detail.roles, member)) : ''}
        <time title="${escapeHtml(formatTimestamp(msg.createdAt))}">${formatShortTime(msg.createdAt)}</time>${msg.pinnedAt ? `<span class="m-pin" title="${t('m.pinnedBadge')}">${icons.pin(12)}</span>` : ''}</div>`}
      ${msg.forwardedFrom ? `<div class="m-forwarded">${icons.forward(12)} ${t('m.forwardedFrom')}</div>` : ''}
      ${replyHtml(msg.replyTo)}
      ${text}${msg.editedAt ? `<span class="m-edited">${t('m.edited')}</span>` : ''}
      ${msg.sticker ? `<img class="m-sticker anim-limit" src="${escapeHtml(msg.sticker.imagePath)}" alt="${escapeHtml(msg.sticker.name)}">` : ''}
      ${attachmentsHtml(msg)}${msg.poll ? pollHtml(msg.poll, ctx.meId, msg.id) : ''}${embedHtml(msg.embed)}${reactionsHtml(msg, ctx.meId, ctx.detail?.customEmoji)}
    </div>
  </div>`;
}

export function pendingHtml(p, me) {
  return `<div class="m-msg mine pending${p.failed ? ' failed' : ''}" data-pending="${p.key}">
    <div class="m-msg-avatar">${avatarHtml(me, 36)}</div>
    <div class="m-msg-body"><div class="m-text">${escapeHtml(p.text)}</div>
      ${p.files?.length ? `<div class="m-atts">${p.files.map((f) => `<div class="m-att-file">${icons.file(16)}<span class="m-grow"><b>${escapeHtml(f.name)}</b></span></div>`).join('')}</div>` : ''}
      ${p.failed ? `<div class="m-failed"><span>${escapeHtml(p.error || t('m.sendFailed'))}. ${t('m.tapToRetry')}</span>
        <button class="btn btn-secondary" data-retry="${p.key}">${t('m.retry')}</button>
        <button class="btn btn-secondary" data-cancel="${p.key}">${t('m.cancel')}</button></div>` : ''}
    </div></div>`;
}

// A private answer to a slash command: shown only to the person who ran it, never stored.
export function ephemeralHtml(e) {
  return `<div class="m-msg m-ephemeral" data-eph="${escapeHtml(e.id)}">
    <div class="m-msg-avatar">${avatarHtml({ id: e.bot.id, username: e.bot.username, displayName: e.bot.displayName, avatarPath: e.bot.avatarPath }, 36)}</div>
    <div class="m-msg-body">
      <div class="m-msg-head"><b class="m-msg-name">${escapeHtml(e.bot.displayName)}</b><span class="bot-badge">${t('bots.badge')}</span></div>
      <div class="m-text">${renderMessageContent(e.content, {})}</div>
      <div class="m-eph-note">${t('slash.onlyYou')} - <a href="#" data-eph-dismiss="${escapeHtml(e.id)}">${t('slash.dismiss')}</a></div>
    </div>
  </div>`;
}
