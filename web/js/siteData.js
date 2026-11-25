import { api } from './api.js';
import { t } from './i18n.js';
import { toast, apiErrorMessage, escapeHtml } from './utils.js';
import { confirmModal } from './views/modal.js';

// Clears what a site stored for this user. A trusted site runs in the app's own origin, so its IndexedDB
// databases are removed here too (the app's own notification-sound database is kept); localStorage is shared with
// the app in that mode and is left alone.
export function clearSiteData(server) {
  confirmModal({
    title: t('sites.settings.clearData'),
    message: escapeHtml(t('sites.settings.clearDataConfirm')),
    confirmLabel: t('sites.settings.clearData'),
    onConfirm: async () => {
      try {
        await api.siteClearStorage(server.id);
        if (server.site_trusted && indexedDB.databases) {
          for (const d of await indexedDB.databases()) if (d.name && d.name !== 'dismesh_notif_sound') indexedDB.deleteDatabase(d.name);
        }
        toast(t('sites.settings.clearDataDone'));
      } catch (e) {
        toast(apiErrorMessage(e, t('sites.settings.saveFailed')));
      }
    },
  });
}
