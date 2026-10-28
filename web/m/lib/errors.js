import { bus } from '../../js/bus.js';
import { toast, apiErrorMessage } from '../../js/utils.js';
import { t } from '../../js/i18n.js';

// One place for "an action failed": a 401 means the session is gone (main.js reloads into sign-in
// exactly once); anything else is a toast with the server's own message.
export function handleError(err, fallbackKey = 'm.sendFailed') {
  if (err && err.status === 401) { bus.emit('m:unauthorized'); return; }
  toast(apiErrorMessage(err, t(fallbackKey)), { type: 'error' });
}
