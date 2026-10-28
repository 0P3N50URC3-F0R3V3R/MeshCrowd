'use strict';

const { db } = require('../db');
const { getSession } = require('../lib/session');
const { getSitePermissionBits } = require('../lib/siteAuth');
const { hasSite, SITE_PERMISSIONS } = require('../lib/permissions');

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

function attachUser(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.dismesh_session;
  const session = getSession(token);
  if (session) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (user && !user.is_disabled) {
      req.user = user;
      req.sessionToken = token;
      req.sitePermissions = getSitePermissionBits(user.id);
      req.user.isSiteAdmin = hasSite(req.sitePermissions, SITE_PERMISSIONS.VIEW_ADMIN_PANEL);
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  next();
}

function requireSiteAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  if (!req.user.isSiteAdmin) return res.status(403).json({ error: 'site admin required' });
  next();
}

module.exports = { attachUser, requireAuth, requireSiteAdmin, parseCookies };
