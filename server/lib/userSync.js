'use strict';

const { notifyUser } = require('../socket/hub');

// Tells a user's own live connections (all devices) that one of their stored settings changed, so each
// client re-reads just that piece. `what` names the piece: theme, ui_prefs, language, layout,
// annotations, dm_prefs, bookmarks, notification_prefs, server_prefs, friends, or all.
function syncUser(userId, what) {
  notifyUser(userId, { type: 'user_sync', what });
}

// Express middleware: after a successful write, sync the caller's other devices.
function syncAfter(what) {
  return (req, res, next) => {
    res.on('finish', () => { if (res.statusCode < 300 && req.user) syncUser(req.user.id, what); });
    next();
  };
}

module.exports = { syncUser, syncAfter };
