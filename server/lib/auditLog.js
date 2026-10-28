'use strict';

const { db } = require('../db');

function logAudit(serverId, actorId, action, targetType, targetId, details) {
  db.prepare(
    `INSERT INTO audit_log (server_id, actor_id, action, target_type, target_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(serverId, actorId, action, targetType || null, targetId || null, details ? JSON.stringify(details) : null);
}

module.exports = { logAudit };
