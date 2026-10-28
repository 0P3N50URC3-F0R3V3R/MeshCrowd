'use strict';

const crypto = require('node:crypto');
const { db } = require('../db');

// The only event types a not-yet-active (pending) or just-revoked peer may send or receive: they
// complete or cancel a pairing, so they must flow before/after the peer is 'active'.
const CONTROL_EVENT_TYPES = new Set(['peer_accept', 'peer_reject', 'peer_revoke']);

function enqueueEvent(peerId, type, payload) {
  const statusClause = CONTROL_EVENT_TYPES.has(type) ? '' : ` AND status = 'active'`;
  const peer = db.prepare(`SELECT id FROM federation_peers WHERE id = ?${statusClause}`).get(peerId);
  if (!peer) return; // unknown peer, or a non-control event for a pending/revoked peer: nothing to send
  db.prepare('INSERT INTO federation_outbox (peer_id, event_id, type, payload_json) VALUES (?, ?, ?, ?)')
    .run(peerId, crypto.randomUUID(), type, JSON.stringify(payload));
  // Required lazily: the worker itself requires this module for CONTROL_EVENT_TYPES.
  if (type === 'remote_channel_event') setImmediate(() => require('./federationOutboxWorker').kickOutboxWorker());
}

module.exports = { enqueueEvent, CONTROL_EVENT_TYPES };
