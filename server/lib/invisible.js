'use strict';

const { db } = require('../db');

// Invisible users look offline to everyone else: no typing indicator, no read receipts, no calls
// in or out, no custom status. They still receive messages normally.
function isInvisible(userId) {
  return db.prepare('SELECT status FROM users WHERE id = ?').get(userId)?.status === 'invisible';
}

module.exports = { isInvisible };
