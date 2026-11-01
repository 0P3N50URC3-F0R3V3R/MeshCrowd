'use strict';

const { db } = require('../db');

// Site-level trail of passport and credential events (passport_audit), success and failure alike.
// actorUserId is set when someone other than the subject acted (an admin reset).
function authAudit(userId, passportId, action, ok, req, actorUserId) {
  db.prepare('INSERT INTO passport_audit (user_id, passport_id, action, ok, ip, actor_user_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId || null, passportId || null, action, ok ? 1 : 0, req.ip || null, actorUserId || null);
}

// Request-less variant for the admin console; actorUserId is null for the local console.
function authAuditConsole(userId, action, ok, actorUserId) {
  const user = userId ? db.prepare('SELECT passport_id FROM users WHERE id = ?').get(userId) : null;
  authAudit(userId, user && user.passport_id, action, ok, {}, actorUserId);
}

module.exports = { authAudit, authAuditConsole };
