'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

// What the chat UI needs from Chromium: calls and screen share, desktop notifications, paste/copy of
// sanitized clipboard data, fullscreen video, output device selection. Everything else (geolocation,
// midi, hid, serial, usb, clipboard-read, openExternal, ...) is refused.
const SERVER_PERMISSIONS = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection']);

function originOf(url) {
  try { return new URL(String(url)).origin; } catch { return null; }
}

function isServerOrigin(url, serverUrl) {
  if (!serverUrl) return false;
  const server = originOf(serverUrl);
  const origin = originOf(url);
  return !!server && server !== 'null' && origin === server;
}

// Only pages of the configured server get anything; the local connect/connecting pages get nothing.
function isPermissionAllowed(permission, requestingUrl, serverUrl) {
  return SERVER_PERMISSIONS.has(permission) && isServerOrigin(requestingUrl, serverUrl);
}

// True for the app's own bundled pages (electron/renderer/*.html), never for a remote page.
function isLocalAppPage(url, rendererDir) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'file:') return false;
    const rel = path.relative(path.resolve(rendererDir), path.resolve(fileURLToPath(u)));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

module.exports = { isPermissionAllowed, isServerOrigin, isLocalAppPage, SERVER_PERMISSIONS };
