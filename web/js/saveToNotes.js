import { api } from './api.js';
import { bus } from './bus.js';
import { state, getServerDetail } from './state.js';
import { getNotesKey, encryptNote, packNote } from './e2ee/notes.js';
import { toast, apiErrorMessage } from './utils.js';
import { t } from './i18n.js';

// Notes channels the user can save into, one entry per notes channel across the loaded servers.
export function notesTargets() {
  const out = [];
  for (const server of state.servers) {
    for (const ch of getServerDetail(server.id)?.channels || []) {
      if (ch.type === 'notes') out.push({ serverId: server.id, serverName: server.name, channelId: ch.id, channelName: ch.name });
    }
  }
  return out;
}

// ids: channel -> [serverId, channelId], thread -> [serverId, channelId, threadId], dm -> [dmId]
export function refFor(scope, msg) {
  const kind = scope.kind;
  const ids = kind === 'dm' ? [scope.dmId] : kind === 'thread' ? [scope.serverId, scope.channelId, scope.threadId] : [scope.serverId, scope.channelId];
  return { kind, ids, messageId: msg.id, author: msg.author.displayName, postedAt: msg.createdAt };
}

export function openRef(ref) {
  const [a, b, c] = ref.ids;
  if (ref.kind === 'dm') bus.emit('ui:navigate', { type: 'dm', dmId: a, jumpToMessageId: ref.messageId });
  else if (ref.kind === 'thread') bus.emit('ui:navigate', { type: 'server', serverId: a, channelId: b, threadId: c, jumpToMessageId: ref.messageId });
  else bus.emit('ui:navigate', { type: 'server', serverId: a, channelId: b, jumpToMessageId: ref.messageId });
}

export async function saveMessageToNotes(msg, scope, target) {
  try {
    const key = await getNotesKey(state.me);
    if (!key) return toast(t('notes.noKey'), { type: 'error' });
    const text = (msg.content || '').slice(0, 3900);
    const noteScope = `${location.origin}|${target.serverId}|${state.me.id}`;
    const payload = { ...(await encryptNote(key, target.channelId, packNote(text, [], refFor(scope, msg)), noteScope)), fileIds: [] };
    await api.createNote(target.serverId, target.channelId, payload);
    toast(t('msgMenu.savedToNotesToast', { channel: target.channelName }));
  } catch (err) {
    toast(apiErrorMessage(err, t('msgMenu.couldNotSaveToNotes')), { type: 'error' });
  }
}
