import { bus } from './bus.js';
import { toast } from './utils.js';
import { t } from './i18n.js';

// Sends outlive the chat pane that started them: a pane switch destroys the view, but the request
// keeps running and the entry stays here so the next pane for that scope can show it again.
const items = new Map();

export const uploads = {
  add(item) { item.progress = 0; item.controller = new AbortController(); items.set(item.key, item); },
  forScope(scopeKey) { return [...items.values()].filter((i) => i.scopeKey === scopeKey); },
  has(key) { return items.has(key); },
  remove(key) { items.delete(key); },
  abort(key) { items.get(key)?.controller.abort(); },
  progress(item, p) { item.progress = p; bus.emit('upload:progress', item); },
  finish(item, { res, err }) {
    const cancelled = !!err?.cancelled;
    if (!err || cancelled) items.delete(item.key);
    const ev = { item, res, err, cancelled, handled: false };
    bus.emit('upload:finished', ev);
    if (ev.handled || cancelled || !item.files?.length) return;
    const name = item.files?.[0]?.name || '';
    if (err) toast(t('chat.uploadFailedToast', { name }), { type: 'error' });
    else toast(t('chat.uploadFinishedToast', { name }));
  },
};
