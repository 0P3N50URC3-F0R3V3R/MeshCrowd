'use strict';

const { db } = require('../db');

function logFederationAudit(action, targetType, targetId, details) {
  db.prepare(
    `INSERT INTO federation_audit_log (action, target_type, target_id, details) VALUES (?, ?, ?, ?)`
  ).run(action, targetType || null, targetId || null, details ? JSON.stringify(details) : null);
}

module.exports = { logFederationAudit };
