'use strict';

const express = require('express');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const { version: APP_VERSION } = require('../package.json');
const { db, DATA_DIR } = require('./db');
const { load: loadConfig } = require('./lib/config');
const { ensureCert } = require('./lib/certs');
const { attachUser } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');
const { errorHandler } = require('./middleware/errorHandler');
const { startPruneWorker } = require('./lib/prune');
const socket = require('./socket');
const logger = require('./lib/logger');
const { buildCsp } = require('./lib/csp');
const guard = require('./lib/security/guard');

guard.start();
require('./lib/security/blocklists').startWorker();

startPruneWorker();
require('./lib/reminders').startReminderWorker();
require('./lib/scheduledMessages').startWorker();

// Both of these otherwise crash the process with only a stack trace flying past in the terminal
// (unrecoverable by the time anyone can scroll back) — data/logs/ keeps a copy to read/copy later.
process.on('uncaughtException', (err) => { logger.error('uncaughtException:', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.error('unhandledRejection:', reason); });

const config = loadConfig();
const turnManager = require('./lib/turn/manager');
require('./lib/phpRuntime').init(config).catch((err) => logger.error('[php] init failed:', err));
require('./lib/siteProcesses').configure({ maxWorkers: Math.min(16, Math.max(1, Number(config.sites && config.sites.maxWorkers) || 4)) });
require('./lib/passportOrigin').configure(config);
for (const line of require('./lib/passportOrigin').bootLines(config)) {
  if (line.includes('WARNING')) logger.warn(line); else logger.log(line);
}
const app = express();
app.set('trust proxy', config.trustProxy);
const CSP = buildCsp(fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8'));

app.disable('x-powered-by');
app.use(guard.ipGuard);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});
// Sites stream their request bodies straight to PHP, so this must sit before express.json (and it
// overrides the frame/CSP headers set above for its own responses).
app.use('/site', rateLimit({ windowMs: 60_000, max: 1200 }), require('./routes/siteProxy'));
// Federated DMs carry attachments inline (base64); the sender caps the total well below this.
app.use('/federation/api/inbox', express.json({ limit: '12mb' }));
// Same for remote-channel attachment uploads (capped at REMOTE_ATTACHMENT_MAX_BYTES before base64).
app.use('/federation/api/rpc', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(attachUser);

// Only the upload subfolders are served publicly, never the whole data/ dir (db, certs, config live there too).
app.use('/uploads/avatars', express.static(path.join(DATA_DIR, 'avatars')));
app.use('/uploads/servericons', express.static(path.join(DATA_DIR, 'servericons')));
app.use('/uploads/channelicons', express.static(path.join(DATA_DIR, 'channelicons')));
app.use('/uploads/roleicons', express.static(path.join(DATA_DIR, 'roleicons')));
app.use('/uploads/foldericons', express.static(path.join(DATA_DIR, 'foldericons')));
app.use('/uploads/banners', express.static(path.join(DATA_DIR, 'banners')));
app.use('/uploads/cards', express.static(path.join(DATA_DIR, 'cards')));
app.use('/uploads/emoji', express.static(path.join(DATA_DIR, 'emoji')));
app.use('/uploads/stickers', express.static(path.join(DATA_DIR, 'stickers')));
app.use('/uploads/sounds', express.static(path.join(DATA_DIR, 'sounds')));
app.use('/uploads/webhookicons', express.static(path.join(DATA_DIR, 'webhookicons')));
app.use('/uploads/threadicons', express.static(path.join(DATA_DIR, 'threadicons')));

app.use('/vendor/libsodium-core', express.static(path.join(__dirname, '..', 'node_modules', 'libsodium-sumo', 'dist', 'modules-sumo-esm')));
app.use('/vendor/libsodium', express.static(path.join(__dirname, '..', 'node_modules', 'libsodium-wrappers-sumo', 'dist', 'modules-sumo-esm')));
app.use('/vendor/highlightjs', express.static(path.join(__dirname, '..', 'node_modules', '@highlightjs', 'cdn-assets')));
app.use('/vendor/rnnoise', express.static(path.join(__dirname, '..', 'node_modules', '@shiguredo', 'rnnoise-wasm', 'dist')));
app.use('/vendor/dompurify', express.static(path.join(__dirname, '..', 'node_modules', 'dompurify', 'dist')));
app.use('/vendor/codemirror', express.static(path.join(__dirname, '..', 'node_modules', 'codemirror')));
app.use('/vendor/tinymce', express.static(path.join(__dirname, '..', 'node_modules', 'tinymce')));

// Attachments can be any file type a user uploaded; force download instead of inline rendering
// so a served file (even one that slipped past the extension blocklist) can never execute as
// active content in this origin. Common raster image types are exempted so chat image previews
// keep working — <img>/<video> embedding isn't affected by Content-Disposition, only direct
// navigation/Save-As is, and raster formats can't carry script the way SVG/HTML can.
const INLINE_SAFE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
// Encrypted-DM blobs live under attachments/e2ee but are only ever served by routes/dms.js.
app.use('/uploads/attachments', (req, res, next) => {
  let first;
  try { first = path.posix.normalize(`/${decodeURIComponent(req.path).replace(/\\/g, '/')}`).split('/').filter(Boolean)[0]; } catch { return res.status(400).end(); }
  if (first && first.toLowerCase().replace(/[. ]+$/, '') === 'e2ee') return res.status(404).end();
  next();
});
app.use('/uploads/attachments', express.static(path.join(DATA_DIR, 'attachments'), {
  setHeaders(res, filePath) {
    if (!INLINE_SAFE_EXT.has(path.extname(filePath).toLowerCase())) {
      res.setHeader('Content-Disposition', 'attachment');
    }
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  },
}));

const authLimiter = rateLimit({ windowMs: 60_000, max: 20 });
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/login-params', rateLimit({ windowMs: 60_000, max: 30 }));
app.use('/api/auth/upgrade-credentials', rateLimit({ windowMs: 60_000, max: 10 }));

const writeLimiter = rateLimit({ windowMs: 60_000, max: 60 });
app.use('/api/servers/:id/channels/:channelId/messages', writeLimiter);
app.use('/api/servers/:id/channels/:channelId/threads/:threadId/messages', writeLimiter);
app.use('/api/dms/:dmId/messages', writeLimiter);
app.use('/api/polls', writeLimiter);
app.use('/api/scheduled', rateLimit({ windowMs: 60_000, max: 60 }));
app.use('/api/templates', rateLimit({ windowMs: 60_000, max: 20 }));
app.use('/api/push', rateLimit({ windowMs: 60_000, max: 30 }));
app.use('/api/messages/:id/forward', writeLimiter);
app.use('/api/friends/request', rateLimit({ windowMs: 60_000, max: 20 }));
app.use('/api/reports', rateLimit({ windowMs: 60_000, max: 20 }));
app.use('/api/link-preview', rateLimit({ windowMs: 60_000, max: 30 }));
app.use('/api/servers/join', rateLimit({ windowMs: 60_000, max: 20 }));
app.use('/api/auth/2fa', rateLimit({ windowMs: 60_000, max: 20 }));
app.use('/api/auth/login/2fa', rateLimit({ windowMs: 60_000, max: 20 }));
app.use('/api/auth/change-password', rateLimit({ windowMs: 60_000, max: 10 }));
app.use('/api/auth/verify-password', rateLimit({ windowMs: 60_000, max: 10 }));
const passportLimiter = rateLimit({ windowMs: 60_000, max: 30 });
app.use('/api/passport', passportLimiter);
// The only unauthenticated write endpoint in the app — token-in-URL is the only gate, so this
// is the one place an IP-keyed limiter is load-bearing rather than a courtesy.
app.use('/api/webhooks/:webhookId/:token', rateLimit({ windowMs: 60_000, max: 20 }));

app.use('/api/auth/captcha', rateLimit({ windowMs: 60_000, max: 40 }), require('./routes/captcha'));
// Captcha, honeypot and failure tracking in front of every sign-in / sign-up route.
app.post('/api/auth/login', guard.gate('login'));
app.post('/api/auth/register', guard.gate('register'));
app.post('/api/auth/login/2fa', guard.gate('login', { requireCaptcha: false }));
app.post('/api/passport/register', guard.gate('register'));
app.post('/api/passport/login', guard.gate('login'));
app.post('/api/passport/recover', guard.gate('login'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/passport', require('./routes/passport'));
app.use('/api/languages', require('./routes/languages'));
app.use('/lang', require('./routes/langFiles'));
app.use('/api/users', require('./routes/users'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/servers/:id', require('./routes/serverBots'));
app.use('/api/servers/:id/channels/:channelId/messages', require('./routes/channelMessages'));
app.use('/api/servers/:id/channels/:channelId/invites', require('./routes/channelInvites'));
app.use('/api/servers/:id/invites', require('./routes/serverInvites'));
app.use('/api/scheduled', require('./routes/scheduled'));
app.use('/api/push', require('./routes/push'));
app.use('/api/servers/:id/automod', require('./routes/automod'));
app.use('/api/servers/:id/commands', require('./routes/botCommands'));
app.use('/api/servers/:id/insights', require('./routes/insights'));
app.use('/api/servers/:id/templates', require('./routes/serverTemplates').serverRouter);
app.use('/api/templates', require('./routes/serverTemplates').codeRouter);
app.use('/api/servers/:id/onboarding', require('./routes/onboarding'));
app.use('/api/servers/:id/reaction-roles', require('./routes/reactionRoles'));
require('./lib/noteFiles').sweepNoteFiles();
app.use('/api/servers/:id/channels/:channelId/notes', require('./routes/notes'));
app.use('/api/servers/:id/channels/:channelId/threads', require('./routes/threads'));
app.use('/api/sites', require('./routes/sites'));
app.use('/api/servers', require('./routes/servers'));
// Every /api/remote call fans out to a peer instance, so writes get a much tighter per-user budget
// than reads on top of the general one.
const remoteWriteLimit = rateLimit({ windowMs: 60_000, max: 60 });
app.use('/api/remote', rateLimit({ windowMs: 60_000, max: 600 }),
  (req, res, next) => (req.method === 'GET' ? next() : remoteWriteLimit(req, res, next)),
  require('./routes/remote'));
require('./lib/dmFiles').sweepDmFiles();
app.use('/api/dms', require('./routes/dms'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/polls', require('./routes/polls'));
app.use('/api/admin/ai', require('./routes/adminAi'));
app.use('/api/bot', require('./routes/botApi'));
app.use('/api/admin/languages', require('./routes/adminLanguages'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/link-preview', require('./routes/linkPreview'));
app.use('/api/notification-prefs', require('./routes/notificationPrefs'));
app.use('/api/server-prefs', require('./routes/serverPrefs'));
app.use('/api', require('./routes/personal'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/read-state', require('./routes/readState'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/search', require('./routes/globalSearch'));
if (config.federation && config.federation.enabled) {
  app.use('/federation/api/inbox', rateLimit({ windowMs: 60_000, max: 120 }));
  app.use('/federation/api/handshake', rateLimit({ windowMs: 60_000, max: 10 }));
  app.use('/federation/api/redeem-invite', rateLimit({ windowMs: 60_000, max: 20 }));
  app.use('/federation/api/rpc', rateLimit({ windowMs: 60_000, max: 600 }));
  app.use('/federation/admin/login', rateLimit({ windowMs: 60_000, max: 10 }));
  app.use('/federation/admin', require('./routes/federationAdmin').router);
  app.use('/federation/api', require('./routes/federationApi'));
}

// Signed-in users get their ICE servers here: operator-defined external ones plus this server's own
// STUN/TURN with a short-lived credential. /api/config below only ever shows credential-free entries.
app.get('/api/voice/ice', rateLimit({ windowMs: 60_000, max: 60 }), require('./middleware/auth').requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { iceServers, ttlMs, builtIn } = turnManager.iceServersFor(req.user, req.hostname);
  res.json({ iceServers, ttlMs, builtIn });
});

const { httpsLink } = require('./lib/httpsLink');

{
  const invitePublic = require('./routes/invitePublic')({ downloads: () => config.downloads || {} });
  const inviteLimit = rateLimit({ windowMs: 60_000, max: 30 });
  app.use('/api/invites', inviteLimit, invitePublic.api);
  app.use('/i', inviteLimit, invitePublic.page);
}

app.get('/api/config', (req, res) => {
  const dl = config.downloads || {};
  const downloads = { clientDesktop: httpsLink(dl.clientDesktop), clientAndroid: httpsLink(dl.clientAndroid), website: httpsLink(dl.website) };
  res.json({ maxUploadMb: config.maxUploadMb, maxMessageChars: require('./lib/messageLimits').maxMessageChars(), publicHost: config.publicHost, iceServers: turnManager.publicIceServers(), version: APP_VERSION, federationEnabled: !!(config.federation && config.federation.enabled), downloads });
});

const WEB_DIR = path.join(__dirname, '..', 'web');
app.use(require('./lib/uiRouting').uiMiddleware(WEB_DIR));
app.use(express.static(WEB_DIR));
app.get(/^(?!\/api|\/uploads|\/ws|\/federation|\/site).*/, require('./lib/uiRouting').fallbackHandler(WEB_DIR));

app.use(errorHandler);

let server;
if (config.useHttps) {
  let key, cert;
  try {
    ({ key, cert } = ensureCert(config.publicHost, { serverCrt: config.serverCrt, serverKey: config.serverKey }));
  } catch (err) {
    logger.error('[certs] failed to load/generate TLS certificate:', err);
    process.exit(1);
  }
  server = https.createServer({ key, cert }, app);
  server.on('error', (err) => logger.error('[MeshCrowd] HTTPS server error:', err));
  server.on('tlsClientError', (err, socket) => {
    if (!process.env.MESHCROWD_TLS_DEBUG) return;
    logger.warn(`[MeshCrowd] TLS handshake failed from ${socket.remoteAddress}: ${err.reason || err.code}`);
  });
  server.listen(config.httpsPort, () => {
    logger.log(`[MeshCrowd] HTTPS server listening on port ${config.httpsPort}`);
  });

  // Plain HTTP server too, purely to redirect to HTTPS (LAN clients typing http://).
  const redirectServer = http.createServer((req, res) => {
    const host = (req.headers.host || config.publicHost).split(':')[0];
    res.writeHead(301, { Location: `https://${host}:${config.httpsPort}${req.url}` });
    res.end();
  });
  redirectServer.on('error', (err) => logger.error('[MeshCrowd] HTTP redirect server error:', err));
  redirectServer.listen(config.port, () => {
    logger.log(`[MeshCrowd] HTTP redirect server listening on port ${config.port} -> https`);
  });
} else {
  server = http.createServer(app);
  server.on('error', (err) => logger.error('[MeshCrowd] HTTP server error:', err));
  server.listen(config.port, () => {
    logger.log(`[MeshCrowd] HTTP server listening on port ${config.port} (unencrypted, LAN/dev only)`);
  });
}

socket.attach(server);
turnManager.start(logger);

if (config.federation && config.federation.enabled) {
  require('./lib/federationOutboxWorker').startOutboxWorker();
  require('./lib/federationHeartbeat').startHeartbeat();
}

// Closing the last connection checkpoints and deletes the -wal/-shm files; a bare process.exit leaves them behind.
process.on('exit', () => { try { db.close(); } catch {} });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => process.exit(0));
}
