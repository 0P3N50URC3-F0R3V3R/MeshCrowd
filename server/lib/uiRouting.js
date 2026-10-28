'use strict';

const path = require('node:path');

const COOKIE_MAX_AGE = 31536000;

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Electron is always desktop. An explicit ui cookie (set by "Open desktop/mobile version") beats
// the UA, so the APK WebView, whose UA carries MeshCrowdAndroid/, can still be sent to desktop.
function pickUi({ userAgent = '', cookie = '' } = {}) {
  if (/Electron\//i.test(userAgent)) return 'desktop';
  const pref = cookieValue(cookie, 'ui');
  if (pref === 'desktop' || pref === 'mobile') return pref;
  return /Android|MeshCrowdAndroid\//i.test(userAgent) ? 'mobile' : 'desktop';
}

function uiMiddleware(webDir) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path !== '/' && req.path !== '/index.html') return next();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'User-Agent, Cookie');
    const forced = req.query && req.query.ui;
    const isElectron = /Electron\//i.test(req.headers['user-agent'] || '');
    if ((forced === 'mobile' && !isElectron) || forced === 'desktop') {
      // The APK WebView has no URL bar to undo a choice, so there the cookie only lasts the session.
      const inApp = /MeshCrowdAndroid\//.test(req.headers['user-agent'] || '');
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `ui=${forced};${inApp ? '' : ` Max-Age=${COOKIE_MAX_AGE};`} Path=/; SameSite=Lax${secure ? '; Secure' : ''}`);
      return res.redirect(302, forced === 'mobile' ? '/m/' : '/');
    }
    const ui = pickUi({ userAgent: req.headers['user-agent'], cookie: req.headers.cookie });
    if (ui === 'mobile') return res.redirect(302, '/m/');
    return res.sendFile(path.join(webDir, 'index.html'));
  };
}

// Catch-all for paths the static handler did not serve: same UI choice as `/`, URL kept.
function fallbackHandler(webDir) {
  return (req, res) => {
    const ui = pickUi({ userAgent: req.headers['user-agent'], cookie: req.headers.cookie });
    res.sendFile(ui === 'mobile' ? path.join(webDir, 'm', 'index.html') : path.join(webDir, 'index.html'));
  };
}

module.exports = { pickUi, uiMiddleware, fallbackHandler };
