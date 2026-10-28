'use strict';

const { db } = require('../db');
const { hasSite, SITE_PERMISSIONS } = require('./permissions');

function getSitePermissionBits(userId) {
  const rows = db.prepare(
    `SELECT sr.permissions AS permissions
       FROM user_site_roles usr
       JOIN site_roles sr ON sr.id = usr.role_id
      WHERE usr.user_id = ?`
  ).all(userId);
  return rows.reduce((acc, r) => acc | r.permissions, 0);
}

function isSiteAdmin(userId) {
  return hasSite(getSitePermissionBits(userId), SITE_PERMISSIONS.VIEW_ADMIN_PANEL);
}

function canManageSites(userId) {
  return hasSite(getSitePermissionBits(userId), SITE_PERMISSIONS.MANAGE_ANY_SERVER);
}

module.exports = { getSitePermissionBits, isSiteAdmin, canManageSites };
