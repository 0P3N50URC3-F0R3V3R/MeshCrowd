'use strict';

// Browsers always send Origin on a WebSocket upgrade, so it is what stops another site's page from
// opening a socket with the visitor's cookie. Accepted: no Origin (non-browser clients), the configured
// publicHost or loopback, and a page served by this very server (Origin host == the host the request
// was addressed to), so reaching it by LAN IP, a second hostname or the Android emulator's 10.0.2.2
// works without a config edit. The session cookie is scoped to that host, so DNS rebinding gains nothing.
function isAllowedWsOrigin(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.hostname === config.publicHost || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
  const forwarded = config.trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const requested = (forwarded || String(req.headers.host || '')).toLowerCase();
  return !!requested && u.host.toLowerCase() === requested;
}

module.exports = { isAllowedWsOrigin };
