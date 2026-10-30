'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, session, desktopCapturer, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { buildTrayIconPNG } = require('./trayIcon');
const { findMcrLink, inviteTarget } = require('./inviteUrl');

// `-dev`/`--dev` is the one supported "show debugging stuff" switch: gates the DevTools shortcut
// (see setupDevToolsGate below) and the start-client.bat console window — nothing else changes.
const isDev = process.argv.includes('--dev') || process.argv.includes('-dev');

// The portable build (Client/MeshCrowd.exe, see scripts/build-client.js) keeps everything next to the
// exe instead of in %APPDATA%, so the folder can be copied between machines. Running through the
// stock electron.exe (npm run electron) keeps the normal per-user location.
if (path.basename(process.execPath).toLowerCase() !== 'electron.exe') {
  app.setPath('userData', path.join(path.dirname(process.execPath), 'data'));
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'dismesh-client-config.json');

function loadClientConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      serverUrl: null, trustedFingerprints: {}, closeToTray: false, startMinimized: false, startWithWindows: false,
      trayIconColor: null, trayBadgeColors: {}, windowBounds: null, handleInviteLinks: true,
    };
  }
}

function saveClientConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// One client per profile: a second launch (start-client.bat again while the first is hidden in the
// tray) would otherwise add a second tray icon, and every extra process is one more icon to leak.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

let clientConfig = loadClientConfig();
let mainWindow;
let pendingInvite = findMcrLink(process.argv); // an mcr:// link that started this process, handled once the window exists
let tray = null;
const recentNotifications = []; // most-recent-first, capped — feeds the tray menu's "Recent" section
let trayBadge = { status: 'online', count: 0 }; // last badge state pushed from the renderer
let trayLabels = { open: 'Open MeshCrowd', recent: 'Recent', none: 'No recent notifications', logout: 'Log Out', quit: 'Quit MeshCrowd', unread: '{count} unread' };
app.isQuitting = false;

function rebuildTrayMenu() {
  if (!tray) return;
  const recentItems = recentNotifications.length
    ? recentNotifications.map((n) => ({
      label: `${n.title}: ${n.body}`.slice(0, 60) || n.title,
      click: () => {
        mainWindow.show(); mainWindow.focus();
        mainWindow.webContents.send('dismesh:navigate-to', n);
      },
    }))
    : [{ label: trayLabels.none, enabled: false }];

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: trayLabels.open, click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: trayLabels.recent, enabled: false },
    ...recentItems,
    { type: 'separator' },
    { label: trayLabels.logout, click: () => mainWindow.webContents.send('dismesh:request-logout') },
    { label: trayLabels.quit, click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// Per-user customization (Settings > Desktop App > Tray Icon) - base circle color and/or a color
// override per presence state for the unread badge. Any field left unset in either just falls
// back to the built-in brand/status colors (see trayIcon.js's hexToRgb).
function trayTheme() {
  return { baseColor: clientConfig.trayIconColor, badgeColors: clientConfig.trayBadgeColors || {} };
}

function applyTrayBadge() {
  if (!tray) return;
  tray.setImage(nativeImage.createFromBuffer(buildTrayIconPNG(trayBadge, trayTheme())));
  tray.setToolTip(trayBadge.count > 0 ? `MeshCrowd (${trayLabels.unread.replace('{count}', trayBadge.count > 99 ? '99+' : trayBadge.count)})` : 'MeshCrowd');
}

function setupTray() {
  tray = new Tray(nativeImage.createFromBuffer(buildTrayIconPNG(trayBadge, trayTheme())));
  tray.setToolTip('MeshCrowd');
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
  rebuildTrayMenu();
}

// `certificate.data` is PEM text; hash the decoded DER bytes so this matches both
// `openssl x509 -noout -fingerprint -sha256` and the fingerprint server/lib/certs.js prints
// on boot, so a user can actually verify what they're being asked to trust.
function fingerprintOf(certificate) {
  const der = Buffer.from(certificate.data.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ''), 'base64');
  return crypto.createHash('sha256').update(der).digest('hex').match(/../g).join(':').toUpperCase();
}

// Self-signed certs are expected (Dismesh servers generate their own). Instead of blindly
// trusting them, pin the fingerprint per-host on first connect and warn loudly if it ever
// changes (same trust-on-first-use model Element/Matrix clients use for homeservers).
function setupCertHandling() {
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    const host = new URL(url).host;
    const fp = fingerprintOf(certificate);
    const known = clientConfig.trustedFingerprints[host];

    if (known === fp) {
      callback(true);
      return;
    }

    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: known ? 'warning' : 'question',
      buttons: known ? ['Cancel (recommended)', 'Trust new certificate anyway'] : ['Cancel', 'Trust this server'],
      defaultId: 0,
      cancelId: 0,
      title: known ? 'Server certificate changed!' : 'Untrusted server certificate',
      message: known
        ? `The certificate for ${host} has changed since you last connected. This could mean the server was reinstalled, or it could mean someone is intercepting your connection.`
        : `${host} is using a self-signed certificate (normal for a MeshCrowd server on your own network).`,
      detail: `Fingerprint (SHA-256): ${fp}\n\nOnly trust this if you recognize the server.`,
    });

    const trust = choice === 1;
    if (trust) {
      clientConfig.trustedFingerprints[host] = fp;
      saveClientConfig(clientConfig);
    }
    callback(trust);
  });
}

// Reuses the same hand-rolled PNG generator the tray icon already uses (count:0 draws just the
// plain brand circle, no badge) — a real branded icon with zero new asset files to maintain.
function appIconImage() {
  const brand = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  if (!brand.isEmpty()) return brand;
  return nativeImage.createFromBuffer(buildTrayIconPNG({ status: 'online', count: 0 }, trayTheme()));
}

// `windowBounds` is the user's last manually-resized/moved size+position (Settings has no UI for
// this — it's saved automatically). Never persisted while maximized/minimized: restoring into a
// maximized state would otherwise "stick" the window maximized with no stored un-maximize size.
function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  clientConfig.windowBounds = mainWindow.getBounds();
  saveClientConfig(clientConfig);
}

function onScreenBounds(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !b.width || !b.height) return false;
  const wa = screen.getDisplayMatching(b).workArea;
  return b.x < wa.x + wa.width - 100 && b.x + b.width > wa.x + 100 && b.y >= wa.y - 10 && b.y < wa.y + wa.height - 50;
}

// Size and position that keep the whole window on a screen: never larger than the display's work
// area, and shifted back in when a saved position hangs off an edge. Without the clamp a saved
// (or default) size bigger than the screen is centered with a negative x, so the left side - and
// the rail with it - ends up off-screen.
function fitBoundsToScreen(saved) {
  const hasPosition = onScreenBounds(saved);
  const wa = (hasPosition ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay()).workArea;
  const width = Math.min(saved?.width || 1280, wa.width);
  const height = Math.min(saved?.height || 820, wa.height);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  return {
    width,
    height,
    x: hasPosition ? clamp(saved.x, wa.x, wa.x + wa.width - width) : wa.x + Math.round((wa.width - width) / 2),
    y: hasPosition ? clamp(saved.y, wa.y, wa.y + wa.height - height) : wa.y + Math.round((wa.height - height) / 2),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...fitBoundsToScreen(clientConfig.windowBounds),
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#313338',
    show: false,
    icon: appIconImage(),
    // Frameless but still a real, native-feeling window: no custom title bar to hand-roll,
    // dragging/double-click-to-maximize on the topbar's own -webkit-app-region:drag strip
    // (web/css/shell.css) is native Chromium behavior, and titleBarOverlay keeps real
    // minimize/maximize/close buttons (Windows/Linux only - macOS gets its own native traffic
    // lights via hiddenInset instead, no overlay concept there).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1e1f22', symbolColor: '#dbdee1', height: 38 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!clientConfig.startMinimized) mainWindow.show();
    else if (!clientConfig.closeToTray) { mainWindow.showInactive(); mainWindow.minimize(); }
  });

  let saveBoundsTimer = null;
  const scheduleSaveBounds = () => { clearTimeout(saveBoundsTimer); saveBoundsTimer = setTimeout(saveWindowBounds, 500); };
  mainWindow.on('resize', scheduleSaveBounds);
  mainWindow.on('move', scheduleSaveBounds);

  // A monitor unplugged or a resolution change can strand the window off-screen: pull it back.
  const refit = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isFullScreen() || !mainWindow.isVisible()) return;
    const fitted = fitBoundsToScreen(mainWindow.getBounds());
    const cur = mainWindow.getBounds();
    if (fitted.x !== cur.x || fitted.y !== cur.y || fitted.width !== cur.width || fitted.height !== cur.height) mainWindow.setBounds(fitted);
  };
  screen.on('display-removed', refit);
  screen.on('display-metrics-changed', refit);

  // DevTools (what most people mean by "the console") only open when launched with -dev/--dev —
  // blocks the shortcut outright rather than just not auto-opening, so it can't be reached by
  // accident in a normal production run.
  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const isF12 = input.key === 'F12';
      const isCtrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i';
      const isCmdOptI = input.meta && input.alt && input.key.toLowerCase() === 'i';
      if (isF12 || isCtrlShiftI || isCmdOptI) event.preventDefault();
    });
  }

  // Posted links render with target="_blank" (see web/js/utils.js renderMessageContent) — open
  // those in the system browser instead of a second Electron window, and refuse any attempt to
  // navigate the main window itself away from the configured server.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const isLocalFile = target.protocol === 'file:';
    const isConfiguredServer = clientConfig.serverUrl && target.origin === new URL(clientConfig.serverUrl).origin;
    if (!isLocalFile && !isConfiguredServer) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  // Site pages live in an iframe: keep them on the configured server, send anything else to the OS browser.
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    let target;
    try { target = new URL(event.url); } catch { return; }
    if (target.protocol === 'about:' || target.protocol === 'data:' || target.protocol === 'blob:') return;
    const serverOrigin = clientConfig.serverUrl && new URL(clientConfig.serverUrl).origin;
    if (target.origin !== serverOrigin) {
      event.preventDefault();
      if (['http:', 'https:', 'mailto:'].includes(target.protocol)) shell.openExternal(target.href);
    }
  });

  // Logoff/shutdown: Windows ends the process without a normal quit, so clean up here.
  mainWindow.on('session-end', destroyTray);

  mainWindow.on('close', (event) => {
    clearTimeout(saveBoundsTimer);
    saveWindowBounds();
    if (!app.isQuitting && clientConfig.closeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // A renderer crash or hang otherwise leaves whatever was on screen frozen (often a blank page
  // mid-navigation) with no way back short of quitting — reload the configured target instead.
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    if (details.reason !== 'clean-exit') loadTarget();
  });
  mainWindow.webContents.on('unresponsive', () => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Wait', 'Reload'],
      defaultId: 1,
      title: 'MeshCrowd is not responding',
      message: 'The window has stopped responding.',
    });
    if (choice === 1) loadTarget();
  });

  mainWindow.webContents.on('did-navigate', (event, url) => {
    if (!url.startsWith('file:')) clearTimeout(connectTimer);
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || validatedURL.startsWith('file:')) return;
    clearTimeout(connectTimer);
    showConnectPage(validatedURL, true);
  });

  loadTarget();
}

const CONNECT_TIMEOUT_MS = 20000;
let connectTimer = null;

function showConnectPage(url, failed) {
  let host = '';
  try { host = new URL(url).host; } catch { /* leave blank */ }
  const query = failed ? { host, failed: '1' } : { host };
  return mainWindow.loadFile(path.join(__dirname, 'renderer', 'connecting.html'), { query }).catch(() => {});
}

// A dead server leaves Chromium waiting on the old (blank) page for a long time: show a spinner
// while the real load is pending, and a retry / change-server page when it fails or stalls.
async function loadServer(url) {
  clearTimeout(connectTimer);
  await showConnectPage(url, false);
  mainWindow.loadURL(url).catch(() => {});
  connectTimer = setTimeout(() => {
    mainWindow.webContents.stop();
    showConnectPage(url, true);
  }, CONNECT_TIMEOUT_MS);
}

function loadTarget() {
  if (clientConfig.serverUrl) {
    loadServer(clientConfig.serverUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'connect.html'));
  }
}

ipcMain.handle('dismesh:get-config', () => clientConfig);

ipcMain.handle('dismesh:open-external', (event, rawUrl) => {
  try {
    const u = new URL(String(rawUrl));
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return false;
    shell.openExternal(u.href);
    return true;
  } catch { return false; }
});

ipcMain.handle('dismesh:set-server', (event, rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad protocol');
  } catch {
    return { ok: false, error: 'Enter a valid URL, e.g. https://192.168.1.10:8443' };
  }

  if (url.protocol === 'http:') {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Connect anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unencrypted connection',
      message: `${url.host} is plain HTTP, not HTTPS.`,
      detail: 'Your login and messages would be sent unencrypted, and this skips certificate '
        + 'verification entirely. Only do this for local testing on a server you control.',
    });
    if (choice !== 1) return { ok: false, error: 'Connection cancelled.' };
  }

  clientConfig.serverUrl = url.toString();
  saveClientConfig(clientConfig);
  loadTarget();
  return { ok: true };
});

ipcMain.handle('dismesh:retry-connect', () => { loadTarget(); return { ok: true }; });

ipcMain.handle('dismesh:forget-server', () => {
  clearTimeout(connectTimer);
  clientConfig.serverUrl = null;
  saveClientConfig(clientConfig);
  loadTarget();
  return { ok: true };
});

ipcMain.handle('dismesh:get-app-settings', () => ({
  closeToTray: !!clientConfig.closeToTray,
  startMinimized: !!clientConfig.startMinimized,
  startWithWindows: !!clientConfig.startWithWindows,
  handleInviteLinks: clientConfig.handleInviteLinks !== false,
  trayIconColor: clientConfig.trayIconColor || null,
  trayBadgeColors: clientConfig.trayBadgeColors || {},
}));

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TRAY_BADGE_STATES = ['online', 'idle', 'dnd', 'offline'];

// Whitelist of keys the renderer is allowed to touch here — anything else in the payload is
// silently dropped rather than merged into clientConfig, so a new settings key can't be added to
// this object without an explicit decision about whether the renderer should control it.
const APP_SETTINGS_KEYS = ['closeToTray', 'startMinimized', 'startWithWindows', 'trayIconColor', 'trayBadgeColors', 'handleInviteLinks'];

ipcMain.handle('dismesh:set-app-settings', (event, settings) => {
  if (!settings || typeof settings !== 'object') return { ok: false, error: 'invalid settings' };
  for (const key of APP_SETTINGS_KEYS) {
    if (settings[key] === undefined) continue;
    if (key === 'closeToTray') clientConfig.closeToTray = !!settings.closeToTray;
    if (key === 'startMinimized') clientConfig.startMinimized = !!settings.startMinimized;
    if (key === 'startWithWindows') {
      clientConfig.startWithWindows = !!settings.startWithWindows;
      app.setLoginItemSettings({ openAtLogin: clientConfig.startWithWindows });
    }
    if (key === 'handleInviteLinks') {
      clientConfig.handleInviteLinks = !!settings.handleInviteLinks;
      setProtocolRegistered(clientConfig.handleInviteLinks);
    }
    // null clears back to the default brand/status color; anything else must be a clean 6-digit
    // hex or it's silently ignored rather than reaching the tray-icon pixel buffer malformed.
    if (key === 'trayIconColor') {
      if (settings.trayIconColor === null || HEX_COLOR_RE.test(settings.trayIconColor)) {
        clientConfig.trayIconColor = settings.trayIconColor;
      }
    }
    if (key === 'trayBadgeColors' && typeof settings.trayBadgeColors === 'object') {
      const cleaned = {};
      for (const state of TRAY_BADGE_STATES) {
        const v = settings.trayBadgeColors[state];
        if (v === null || HEX_COLOR_RE.test(v)) cleaned[state] = v;
        else if (clientConfig.trayBadgeColors?.[state]) cleaned[state] = clientConfig.trayBadgeColors[state];
      }
      clientConfig.trayBadgeColors = cleaned;
    }
  }
  saveClientConfig(clientConfig);
  applyTrayBadge();
  return {
    ok: true,
    closeToTray: !!clientConfig.closeToTray,
    startMinimized: !!clientConfig.startMinimized,
    startWithWindows: !!clientConfig.startWithWindows,
    handleInviteLinks: clientConfig.handleInviteLinks !== false,
    trayIconColor: clientConfig.trayIconColor || null,
    trayBadgeColors: clientConfig.trayBadgeColors || {},
  };
});

// mcr:// invite links (see docs/superpowers/specs/2026-10-27-invite-links-design.md). On unless the
// user turned it off in Settings. A dev run through electron.exe needs the app path as an argument.
function protocolArgs() {
  return process.defaultApp && process.argv[1] ? [path.resolve(process.argv[1])] : [];
}

function setProtocolRegistered(on) {
  if (on) app.setAsDefaultProtocolClient('mcr', process.execPath, protocolArgs());
  else app.removeAsDefaultProtocolClient('mcr', process.execPath, protocolArgs());
}

// Run at every start: the registry entry points at one exe path, so a moved folder or a deleted key
// is repaired by the next launch of the client from its new place.
function ensureProtocolRegistered() {
  if (clientConfig.handleInviteLinks === false) return;
  if (!app.isDefaultProtocolClient('mcr', process.execPath, protocolArgs())) setProtocolRegistered(true);
}

// A link never joins anything by itself: switching to another server needs an explicit OK showing the
// host, and the web UI then asks again before the join.
function handleInviteLink(link) {
  if (!mainWindow || mainWindow.isDestroyed()) { pendingInvite = link; return; }
  const target = inviteTarget(link, clientConfig.serverUrl);
  if (!target.sameServer) {
    mainWindow.show(); mainWindow.focus();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Cancel', 'Open this server'],
      defaultId: 0,
      cancelId: 0,
      title: 'Invite link',
      message: `Open an invite to ${link.host}?`,
      detail: `This client will switch to https://${link.host} and ask before joining. Only continue if you trust whoever sent you the link.`,
    });
    if (choice !== 1) return;
    clientConfig.serverUrl = target.origin;
    saveClientConfig(clientConfig);
  }
  loadServer(target.url);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Pushed from the renderer every time it decides a desktop notification is warranted (see
// web/js/views/shell.js onNotify) — keeps the tray's "Recent" menu in sync even while the
// window is hidden in the background.
ipcMain.on('dismesh:push-notification', (event, n) => {
  recentNotifications.unshift(n);
  recentNotifications.length = Math.min(recentNotifications.length, 5);
  rebuildTrayMenu();
});

// Pushed from the renderer whenever the global unread count or the user's own presence status
// changes (see web/js/views/shell.js pushUnreadBadge) — redraws the tray icon in place.
ipcMain.on('dismesh:set-tray-labels', (event, labels) => {
  if (!labels || typeof labels !== 'object') return;
  for (const k of Object.keys(trayLabels)) {
    if (typeof labels[k] === 'string' && labels[k].length < 80) trayLabels[k] = labels[k];
  }
  rebuildTrayMenu();
  applyTrayBadge();
});

ipcMain.on('dismesh:set-tray-badge', (event, { status, count } = {}) => {
  trayBadge = { status: status || 'online', count: Number(count) || 0 };
  applyTrayBadge();
});

// Screen sharing (web/js/views/voice.js's getDisplayMedia() call) is a no-op in Electron's
// Chromium without this — there's no browser chrome to show a picker, so Electron needs to be
// told how to satisfy the request itself. `useSystemPicker` hands it to the OS's own native
// screen/window picker on platforms that support one (Windows 10+, macOS); the handler function
// is the fallback for wherever that isn't available, defaulting to the first available screen
// rather than presenting a custom in-app chooser (not built — the native picker covers the
// common case, and this is the one part of the video/screen-share feature not live-verified in
// this session, since headless dev environments can't meaningfully exercise OS screen capture).
function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      callback({ video: sources[0], audio: 'loopback' });
    } catch {
      callback({});
    }
  }, { useSystemPicker: true });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  const link = findMcrLink([url]);
  if (link) handleInviteLink(link);
});

app.on('second-instance', (event, argv) => {
  const link = findMcrLink(argv);
  if (link) return handleInviteLink(link);
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  setupCertHandling();
  setupDisplayMediaHandler();
  createWindow();
  setupTray();
  app.setLoginItemSettings({ openAtLogin: !!clientConfig.startWithWindows });
  ensureProtocolRegistered();
  if (pendingInvite) { const link = pendingInvite; pendingInvite = null; handleInviteLink(link); }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Windows only removes a tray icon when its owner deletes it (or the user hovers over a dead one),
// so every way this process can end has to run this: quit, signals, logoff/shutdown, crashes.
function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch { /* already gone */ }
  tray = null;
}

app.on('before-quit', () => {
  app.isQuitting = true;
  destroyTray();
});
app.on('will-quit', destroyTray);
app.on('quit', destroyTray);
process.on('exit', destroyTray);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { app.isQuitting = true; destroyTray(); app.quit(); });
}
process.on('uncaughtException', (err) => {
  destroyTray();
  dialog.showErrorBox('MeshCrowd', String((err && err.stack) || err));
  app.exit(1);
});
