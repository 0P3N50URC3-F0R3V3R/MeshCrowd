'use strict';

const express = require('express');
const invites = require('../lib/serverInvites');
const { httpsLink } = require('../lib/httpsLink');

const STRINGS = {
  en: {
    invited: 'You have been invited to join', invitedGeneric: 'You have been invited to a server', members: (n) => `${n} member${n === 1 ? '' : 's'}`,
    channel: (c) => `Channel: #${c}`, join: 'Join in browser', app: 'Open in app', getApp: 'Get the app', desktop: 'Desktop client', android: 'Android app', website: 'Project website',
    notFound: 'This invite is invalid', expired: 'This invite has expired or reached its use limit', ogDesc: (n) => `Join ${n} on MeshCrowd`,
  },
  hu: {
    invited: 'Meghívtak ide:', invitedGeneric: 'Meghívtak egy szerverre', members: (n) => `${n} tag`,
    channel: (c) => `Csatorna: #${c}`, join: 'Csatlakozás böngészőben', app: 'Megnyitás az alkalmazásban', getApp: 'Alkalmazás letöltése', desktop: 'Asztali kliens', android: 'Android alkalmazás', website: 'Projekt weboldala',
    notFound: 'Ez a meghívó érvénytelen', expired: 'Ez a meghívó lejárt vagy elérte a használati korlátot', ogDesc: (n) => `Csatlakozz ide: ${n} – MeshCrowd`,
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1f22;color:#dbdee1;font-family:system-ui,sans-serif}
.card{background:#313338;border-radius:8px;padding:32px;width:min(420px,calc(100vw - 32px));text-align:center;box-shadow:0 8px 24px #0006}
.icon{width:72px;height:72px;border-radius:50%;margin:0 auto 16px;background:#0d9488;color:#fff;font-size:32px;font-weight:700;display:flex;align-items:center;justify-content:center;overflow:hidden}
.icon img{width:100%;height:100%;object-fit:cover}h1{font-size:22px;margin:4px 0;color:#fff}.sub{color:#b5bac1;font-size:14px;margin:4px 0}
.btn{display:block;margin-top:12px;padding:12px;border-radius:4px;background:#0d9488;color:#fff;text-decoration:none;font-weight:600}
.btn.alt{background:#4e5058}.links{margin-top:20px;font-size:13px;color:#949ba4}.links a{color:#00a8fc;margin:0 6px}`;

function createRouters({ downloads }) {
  const api = express.Router();
  const page = express.Router();

  api.get('/:code', (req, res) => {
    if (req.params.code.includes('@')) return res.status(404).json({ error: 'invalid invite code' });
    const peek = invites.peekCode(req.params.code);
    if (!peek) return res.status(404).json({ error: 'invalid invite code' });
    if (peek.dead) return res.status(peek.dead.status).json({ error: peek.dead.message });
    res.json(invites.publicInfo(peek));
  });

  page.get('/:code', (req, res) => {
    const code = req.params.code;
    const s = /^hu\b/i.test(String(req.headers['accept-language'] || '')) ? STRINGS.hu : STRINGS.en;
    const federated = code.includes('@');
    const peek = federated ? null : invites.peekCode(code);
    const status = federated || (peek && !peek.dead) ? 200 : peek ? peek.dead.status : 404;
    const info = peek && !peek.dead ? invites.publicInfo(peek) : null;

    const host = req.get('host') || '';
    const origin = `${req.protocol}://${host}`;
    const enc = encodeURIComponent(code);
    const dl = downloads();
    const links = [['clientDesktop', s.desktop], ['clientAndroid', s.android], ['website', s.website]]
      .map(([k, label]) => [httpsLink(dl[k]), label]).filter(([u]) => u && u !== 'https://#')
      .map(([u, label]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`).join('');

    let title = 'MeshCrowd';
    let body;
    if (status === 200) {
      title = info ? info.name : s.invitedGeneric;
      const icon = info && info.iconPath ? `<img src="${esc(info.iconPath)}" alt="">` : esc((title[0] || 'M').toUpperCase());
      body = `<div class="icon">${icon}</div>
        <div class="sub">${esc(info ? s.invited : s.invitedGeneric)}</div>
        ${info ? `<h1>${esc(info.name)}</h1>` : ''}
        ${info && info.memberCount !== null ? `<div class="sub">${esc(s.members(info.memberCount))}</div>` : ''}
        ${info && info.channelName ? `<div class="sub">${esc(s.channel(info.channelName))}</div>` : ''}
        <a class="btn" href="/#invite=${esc(enc)}">${esc(s.join)}</a>
        <a class="btn alt" href="mcr://${esc(host)}/${esc(enc)}">${esc(s.app)}</a>
        ${links ? `<div class="links">${esc(s.getApp)}:${links}</div>` : ''}`;
    } else {
      body = `<div class="icon">?</div><h1>${esc(status === 410 ? s.expired : s.notFound)}</h1>${links ? `<div class="links">${links}</div>` : ''}`;
    }

    const og = status === 200 && info
      ? `<meta property="og:title" content="${esc(info.name)}"><meta property="og:description" content="${esc(s.ogDesc(info.name))}">${info.iconPath ? `<meta property="og:image" content="${esc(origin + info.iconPath)}">` : ''}`
      : '';

    res.status(status);
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
    });
    res.send(`<!doctype html><html lang="${s === STRINGS.hu ? 'hu' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${og}<style>${CSS}</style></head><body><div class="card">${body}</div></body></html>`);
  });

  return { api, page };
}

module.exports = createRouters;
