'use strict';

const CODE_RE = /^[A-Za-z0-9_.@-]{1,128}$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])$/;

// `mcr://host[:port]/<invite code>` -> { host: 'host[:port]', code }, or null for anything else.
// The link comes from a web page or another app, so it is treated as untrusted input.
function parseMcrUrl(arg) {
  if (typeof arg !== 'string' || !/^mcr:\/\//i.test(arg) || arg.length > 300) return null;
  let u;
  try { u = new URL(arg); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  const hostname = u.hostname.toLowerCase();
  if (!HOST_RE.test(hostname)) return null;
  if (u.port && !(Number(u.port) >= 1 && Number(u.port) <= 65535)) return null;
  let code;
  try { code = decodeURIComponent(u.pathname.replace(/^\/+/, '').replace(/\/+$/, '')); } catch { return null; }
  if (!CODE_RE.test(code)) return null;
  return { host: u.port ? `${hostname}:${u.port}` : hostname, code };
}

const findMcrLink = (argv) => {
  for (const a of argv || []) { const link = parseMcrUrl(a); if (link) return link; }
  return null;
};

// Where to open the invite: the configured server when the host matches (keeps its http/https), else
// https://host. `sameServer` tells the caller whether switching servers needs confirming.
function inviteTarget(link, serverUrl) {
  let origin = `https://${link.host}`;
  let sameServer = false;
  try {
    const cur = serverUrl && new URL(serverUrl);
    if (cur && cur.host.toLowerCase() === link.host) { origin = cur.origin; sameServer = true; }
  } catch { /* unparsable stored URL: treat as a different server */ }
  return { origin, sameServer, url: `${origin}/#invite=${encodeURIComponent(link.code)}` };
}

module.exports = { parseMcrUrl, findMcrLink, inviteTarget };
