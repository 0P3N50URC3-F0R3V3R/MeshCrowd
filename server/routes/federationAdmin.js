'use strict';

const express = require('express');
const {
  isFederationAdminConfigured, setFederationAdminPassword, verifyFederationAdminPassword,
  createFederationAdminSession, getFederationAdminSession, destroyFederationAdminSession,
} = require('../lib/federationAdminAuth');

const { peerIsTrustedLoopback } = require('../lib/passportOrigin');

const router = express.Router();
const COOKIE = 'dismesh_federation_admin';

// Copied from server/middleware/auth.js rather than imported — this module is deliberately
// isolated from the main app's auth machinery (separate credential, session table, cookie),
// and importing from there would pull in its whole require-graph (session.js, siteAuth.js,
// permissions.js, db) for the sake of this one small, stateless, side-effect-free function.
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function setCookie(req, res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/federation; HttpOnly;${req.secure ? ' Secure;' : ''} SameSite=Strict; Max-Age=43200`);
}

function requireFederationAdmin(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  const session = getFederationAdminSession(token);
  if (!session) return res.status(401).json({ error: 'not authenticated' });
  req.federationAdminToken = token;
  next();
}

router.get('/status', (req, res) => {
  res.json({ configured: isFederationAdminConfigured(), authenticated: !!getFederationAdminSession(parseCookies(req)[COOKIE]) });
});

// First-claim is a takeover risk on an internet-facing instance: only a signed-in site admin, or
// someone on the machine itself (no proxy headers), may set the very first password.
router.post('/setup', (req, res) => {
  if (isFederationAdminConfigured()) return res.status(403).json({ error: 'already configured' });
  if (!req.user?.isSiteAdmin && !peerIsTrustedLoopback(req)) return res.status(403).json({ error: 'site admin required' });
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length < 12) {
    return res.status(400).json({ error: 'password must be at least 12 characters' });
  }
  setFederationAdminPassword(password);
  const { token } = createFederationAdminSession();
  setCookie(req, res, token);
  res.json({ ok: true });
});

router.post('/login', (req, res) => {
  if (!isFederationAdminConfigured()) return res.status(403).json({ error: 'not configured yet' });
  const { password } = req.body || {};
  if (typeof password !== 'string' || !verifyFederationAdminPassword(password)) {
    return res.status(401).json({ error: 'invalid password' });
  }
  const { token } = createFederationAdminSession();
  setCookie(req, res, token);
  res.json({ ok: true });
});

router.post('/logout', requireFederationAdmin, (req, res) => {
  destroyFederationAdminSession(req.federationAdminToken);
  res.json({ ok: true });
});

const crypto = require('node:crypto');
const { db } = require('../db');
const { logFederationAudit } = require('../lib/federationAuditLog');
const { load: loadConfig } = require('../lib/config');
const { enqueueEvent } = require('../lib/federationOutbox');
const { ownDomain } = require('../lib/federationOutboxWorker');
const { isSafePeerUrl, safeFetch } = require('../lib/federationSsrf');
const { getOrCreateKeypair, signPayload } = require('../lib/federationCrypto');
const { notifySiteAdmins } = require('../socket/hub');

const peerUpdated = () => notifySiteAdmins({ type: 'federation_peer_update' });

function ownPublicUrl() {
  const config = loadConfig();
  return (config.federationPublicUrl || `${config.useHttps ? 'https' : 'http'}://${config.publicHost}`).replace(/\/$/, '');
}

router.post('/invites', requireFederationAdmin, (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min, single-use
  db.prepare('INSERT INTO federation_invites (token, expires_at) VALUES (?, ?)').run(token, expiresAt);
  res.status(201).json({ token, url: `/federation/invite/${token}`, fullUrl: `${ownPublicUrl()}/federation/invite/${token}` });
});

router.get('/peers', requireFederationAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, domain, public_url, display_name, status, direction, created_at, last_seen_at FROM federation_peers ORDER BY id DESC').all();
  res.json({ peers: rows });
});

router.delete('/peers/:id', requireFederationAdmin, (req, res) => {
  const peer = db.prepare('SELECT * FROM federation_peers WHERE id = ?').get(req.params.id);
  if (!peer) return res.status(404).json({ error: 'peer not found' });
  if (peer.status !== 'revoked') enqueueEvent(peer.id, 'peer_revoke', {});
  db.prepare(`UPDATE federation_peers SET status = 'revoked' WHERE id = ?`).run(peer.id);
  db.prepare('DELETE FROM remote_memberships WHERE peer_id = ?').run(peer.id);
  logFederationAudit('federation_peer_revoke', 'federation_peer', peer.id, { domain: peer.domain });
  peerUpdated();
  res.json({ ok: true });
});

function resolveIncoming(action, status) {
  return (req, res) => {
    const peer = db.prepare('SELECT * FROM federation_peers WHERE id = ?').get(req.params.id);
    if (!peer) return res.status(404).json({ error: 'peer not found' });
    if (peer.status !== 'pending' || peer.direction !== 'inbound') {
      return res.status(409).json({ error: 'not an incoming pending request' });
    }
    db.prepare('UPDATE federation_peers SET status = ? WHERE id = ?').run(status, peer.id);
    enqueueEvent(peer.id, `peer_${action}`, {});
    logFederationAudit(`federation_peer_${action}`, 'federation_peer', peer.id, { domain: peer.domain });
    peerUpdated();
    res.json({ ok: true });
  };
}

router.post('/peers/:id/accept', requireFederationAdmin, resolveIncoming('accept', 'active'));
router.post('/peers/:id/reject', requireFederationAdmin, resolveIncoming('reject', 'revoked'));

router.post('/redeem-invite', requireFederationAdmin, async (req, res) => {
  const { invite, target } = req.body || {};
  if (typeof invite !== 'string' || !invite.trim()) return res.status(400).json({ error: 'invite required' });

  let origin;
  let token = invite.trim();
  try {
    const parsed = new URL(token);
    token = parsed.pathname.split('/').filter(Boolean).pop();
    origin = parsed.origin;
  } catch {
    try { origin = new URL(target).origin; } catch { return res.status(400).json({ error: 'target required when redeeming a bare token' }); }
  }
  if (!token) return res.status(400).json({ error: 'invalid invite' });
  if (!(await isSafePeerUrl(origin))) return res.status(400).json({ error: 'target is not a permitted federation target' });

  const { publicKeyPem } = getOrCreateKeypair();
  const payload = { token, domain: ownDomain(), publicUrl: ownPublicUrl(), pubkey: publicKeyPem };
  let remote;
  try {
    const hsRes = await safeFetch(`${origin}/federation/api/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, signature: signPayload(payload) }),
      signal: AbortSignal.timeout(10_000),
    });
    remote = await hsRes.json().catch(() => ({}));
    if (!hsRes.ok) return res.status(502).json({ error: remote.error || `peer rejected the invite (${hsRes.status})` });
  } catch {
    return res.status(502).json({ error: 'could not reach the other instance' });
  }
  if (typeof remote.domain !== 'string' || typeof remote.pubkey !== 'string') {
    return res.status(502).json({ error: 'malformed handshake response' });
  }

  const known = db.prepare('SELECT their_pubkey FROM federation_peers WHERE domain = ?').get(remote.domain);
  if (remote.domain !== new URL(origin).host || remote.domain === ownDomain() || (known && known.their_pubkey !== remote.pubkey)) {
    return res.status(502).json({ error: 'the other instance identified itself inconsistently' });
  }

  db.prepare(
    `INSERT INTO federation_peers (domain, public_url, their_pubkey, status, direction, last_seen_at) VALUES (?, ?, ?, 'pending', 'outbound', ?)
     ON CONFLICT(domain) DO UPDATE SET
       public_url = excluded.public_url, their_pubkey = excluded.their_pubkey,
       status = CASE WHEN federation_peers.status = 'active' AND federation_peers.their_pubkey = excluded.their_pubkey THEN 'active' ELSE excluded.status END,
       direction = CASE WHEN federation_peers.status = 'active' AND federation_peers.their_pubkey = excluded.their_pubkey THEN federation_peers.direction ELSE excluded.direction END,
       last_seen_at = excluded.last_seen_at`
  ).run(remote.domain, origin, remote.pubkey, new Date().toISOString());
  const peerRow = db.prepare('SELECT id FROM federation_peers WHERE domain = ?').get(remote.domain);
  logFederationAudit('federation_redeem_invite', 'federation_peer', peerRow.id, { domain: remote.domain });
  peerUpdated();
  res.status(201).json({ ok: true, id: peerRow.id, domain: remote.domain });
});

module.exports = { router, requireFederationAdmin };
