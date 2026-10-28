import { api } from '../../js/api.js';
import { icons } from '../../js/icons.js';
import { t } from '../../js/i18n.js';
import { escapeHtml, toast } from '../../js/utils.js';
import { state, nameFor } from '../../js/state.js';
import { nav } from '../router.js';
import { handleError } from '../lib/errors.js';
import { actionSheet, confirmSheet, promptSheet } from './bottomSheet.js';
import { openEmojiSheet, QUICK_EMOJI } from './emojiSheet.js';
import { copyText } from '../views/serversTab.js';

async function toggleReaction(msg, emoji) {
  const mine = msg.reactions.find((r) => r.emoji === emoji)?.userIds.includes(state.me.id);
  try { await (mine ? api.removeReaction(msg.id, emoji) : api.addReaction(msg.id, emoji)); } catch (err) { handleError(err); }
}

async function forwardTargets() {
  const targets = state.dms.map((d) => ({
    id: `dm:${d.id}`,
    label: d.isGroup ? (d.name || d.members.map((u) => nameFor(u)).join(', ')) : nameFor(d.members[0]),
  }));
  for (const [serverId, detail] of state.serverDetail) {
    for (const c of detail.channels) if (['public', 'private', 'announcement'].includes(c.type)) targets.push({ id: `channel:${c.id}`, label: `${detail.server.name} #${c.name}`, serverId });
  }
  return targets;
}

async function forward(msg) {
  const targets = await forwardTargets();
  const pick = await actionSheet({ title: t('m.forwardTo'), items: targets.map((x) => ({ id: x.id, label: x.label })) });
  if (!pick) return;
  const [scopeType, scopeId] = pick.split(':');
  try { await api.forwardMessage(msg.id, { scopeType, scopeId: Number(scopeId) }); toast(t('m.forwardSent')); } catch (err) { handleError(err); }
}

async function report(msg) {
  const reason = await actionSheet({ title: t('m.actReport'), items: [
    { id: 'spam', label: t('m.reportReasonSpam') }, { id: 'harassment', label: t('m.reportReasonHarassment') }, { id: 'other', label: t('m.reportReasonOther') },
  ] });
  if (!reason) return;
  try { await api.fileReport({ reportedUserId: msg.author.id, reason, messageId: msg.id }); toast(t('m.reportSent')); } catch (err) { handleError(err); }
}

async function createThread(msg, ctx) {
  const title = await promptSheet({ title: t('m.actThread'), placeholder: t('m.threadTitlePh'), value: (msg.content || '').slice(0, 60), okLabel: t('m.threadCreate') });
  if (!title) return;
  try {
    const res = await api.createThread(ctx.params.serverId, ctx.params.channelId, {
      title, content: t('chat.startedFromTemplate', { snippet: (msg.content || '').slice(0, 200) }), parentMessageId: msg.id,
    });
    nav.push('chat', { kind: 'thread', serverId: ctx.params.serverId, channelId: ctx.params.channelId, threadId: res.thread.id });
  } catch (err) { handleError(err); }
}

export async function openMessageSheet(msg, ctx) {
  const mine = msg.author.id === state.me.id;
  const enc = !!ctx.dm?.e2eeEnabled;
  const marked = state.bookmarkIds.has(msg.id);
  const items = [
    { id: 'react', icon: icons.smile(20), label: t('m.actReact') },
    ctx.canSend && { id: 'reply', icon: icons.reply(20), label: t('m.actReply') },
    !msg.decryptFailed && msg.content && { id: 'copy', icon: icons.copy(20), label: t('m.actCopy') },
    mine && !enc && ctx.canSend && { id: 'edit', icon: icons.edit(20), label: t('m.actEdit') },
    (ctx.kind === 'dm' || ctx.canManage) && { id: msg.pinnedAt ? 'unpin' : 'pin', icon: icons.pin(20), label: msg.pinnedAt ? t('m.actUnpin') : t('m.actPin') },
    ctx.kind === 'channel' && ctx.canSend && { id: 'thread', icon: icons.messageSquare(20), label: t('m.actThread') },
    !enc && { id: 'forward', icon: icons.forward(20), label: t('m.actForward') },
    { id: marked ? 'unbookmark' : 'bookmark', icon: icons.bookmark(20), label: marked ? t('m.actUnbookmark') : t('m.actBookmark') },
    ctx.kind !== 'thread' && { id: 'unread', icon: icons.bell(20), label: t('m.actMarkUnread') },
    !mine && { id: 'report', icon: icons.flag(20), label: t('m.actReport') },
    (mine || ctx.canManage) && { id: 'delete', icon: icons.trash(20), label: t('m.actDelete'), danger: true },
  ].filter(Boolean);
  const header = `<div class="m-quick">${QUICK_EMOJI.map((e) => `<button class="m-quick-btn" data-id="emoji:${escapeHtml(e)}">${e}</button>`).join('')}</div>`;
  const id = await actionSheet({ items, header });
  if (!id) return;
  if (id.startsWith('emoji:')) return toggleReaction(msg, id.slice(6));
  try {
    switch (id) {
      case 'react': { const e = await openEmojiSheet(ctx.detail?.customEmoji || []); if (e) await toggleReaction(msg, e); break; }
      case 'reply': ctx.composer.setReply(msg); break;
      case 'copy': await copyText(msg.content); toast(t('m.copied')); break;
      case 'edit': ctx.composer.setEdit(msg); break;
      case 'pin': await api.pinMessage(msg.id); break;
      case 'unpin': await api.unpinMessage(msg.id); break;
      case 'thread': await createThread(msg, ctx); break;
      case 'forward': await forward(msg); break;
      case 'bookmark': await api.addBookmark(msg.id); state.bookmarkIds.add(msg.id); break;
      case 'unbookmark': await api.removeBookmark(msg.id); state.bookmarkIds.delete(msg.id); break;
      case 'unread': await api.markUnreadFrom(ctx.scopeType, ctx.scopeId, msg.id); break;
      case 'report': await report(msg); break;
      case 'delete': if (await confirmSheet(t('m.deleteConfirm'))) await api.deleteMessage(msg.id); break;
      default: break;
    }
  } catch (err) { handleError(err); }
}
