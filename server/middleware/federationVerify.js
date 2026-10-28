'use strict';

const { db } = require('../db');
const { verifyPayload } = require('../lib/federationCrypto');

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

// Authentication only: a 'pending' peer is cryptographically who it claims to be, but what it may
// DO is the inbox dispatcher's call (federationApi.js limits pending peers to pairing-control events).
function verifyFederationRequest(req, res, next) {
  const { event_id, type, origin_domain, created_at, payload, signature } = req.body || {};
  if (!event_id || !type || !origin_domain || !created_at || !signature) {
    return res.status(401).json({ error: 'invalid request' });
  }
  const age = Date.now() - new Date(created_at).getTime();
  if (!Number.isFinite(age) || age < -30_000 || age > REPLAY_WINDOW_MS) {
    return res.status(401).json({ error: 'invalid request' });
  }
  const peer = db.prepare(`SELECT * FROM federation_peers WHERE domain = ? AND status IN ('active', 'pending')`).get(origin_domain);
  if (!peer) return res.status(401).json({ error: 'invalid request' });

  const signedPayload = { event_id, type, origin_domain, created_at, payload: payload ?? {} };
  if (!verifyPayload(signedPayload, signature, peer.their_pubkey)) {
    return res.status(401).json({ error: 'invalid request' });
  }
  req.federationPeer = peer;
  next();
}

module.exports = { verifyFederationRequest };
