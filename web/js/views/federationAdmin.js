import { api } from '../api.js';
import { escapeHtml, toast, apiErrorMessage } from '../utils.js';
import { confirmModal } from './modal.js';
import { t } from '../i18n.js';
import { bus } from '../bus.js';

// Federation admin tab. Federation has its own credential (the dismesh_federation_admin cookie),
// separate from the site-admin session this panel is opened with, so the tab gates itself behind
// its own setup/sign-in before showing any peer data.
export function renderFederationTab(inner) {
  inner.innerHTML = `<h2>${t('federation.heading')}</h2><div id="fed-body"></div>`;
  const body = inner.querySelector('#fed-body');
  let inviteLink = '';
  let showingPeers = false;

  async function load({ quiet = false } = {}) {
    if (!quiet) body.innerHTML = `<div class="panel-loading" style="height:80px"><div class="spinner"></div></div>`;
    try {
      const status = await api.federationStatus();
      if (!status.authenticated) return renderAuth(status.configured);
      const { peers } = await api.federationPeers();
      renderPeers(peers);
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('federation.couldNotLoad')))}</p></div>`;
    }
  }

  function renderAuth(configured) {
    showingPeers = false;
    body.innerHTML = `
      <form id="fed-auth">
        <p class="hint">${t(configured ? 'federation.loginIntro' : 'federation.setupIntro')}</p>
        <div class="field">
          <label for="fed-password">${t('federation.passwordLabel')}</label>
          <input class="input" id="fed-password" type="password" autocomplete="${configured ? 'current-password' : 'new-password'}" style="max-width:320px" required>
        </div>
        <button type="submit" class="btn btn-primary">${t(configured ? 'federation.loginButton' : 'federation.setupButton')}</button>
      </form>`;
    body.querySelector('#fed-auth').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = body.querySelector('#fed-password').value;
      try {
        await (configured ? api.federationLogin(password) : api.federationSetup(password));
        load();
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });
  }

  function peerRow(peer, actions) {
    const seen = peer.last_seen_at ? t('federation.lastSeen', { when: new Date(peer.last_seen_at).toLocaleString() }) : t('federation.neverSeen');
    return `
      <tr>
        <td>${escapeHtml(peer.domain)}<div class="hint">${escapeHtml(seen)}</div></td>
        <td style="text-align:right;white-space:nowrap">${actions.map(([act, label, cls]) => `<button type="button" class="btn ${cls}" data-act="${act}" data-id="${peer.id}" data-domain="${escapeHtml(peer.domain)}">${t(label)}</button>`).join(' ')}</td>
      </tr>`;
  }

  function peerSection(titleKey, peers, actions, id) {
    return `
      <h3>${t(titleKey)}</h3>
      <div id="${id}">${peers.length
        ? `<table class="admin-table"><tbody>${peers.map((p) => peerRow(p, actions)).join('')}</tbody></table>`
        : `<p class="hint">${t('federation.noneYet')}</p>`}</div>`;
  }

  function renderPeers(peers) {
    const active = peers.filter((p) => p.status === 'active');
    const incoming = peers.filter((p) => p.status === 'pending' && p.direction === 'inbound');
    const outgoing = peers.filter((p) => p.status === 'pending' && p.direction === 'outbound');
    const redeemEl = body.querySelector('#fed-redeem-input');
    const redeemDraft = redeemEl?.value || '';
    const redeemFocused = !!redeemEl && document.activeElement === redeemEl;
    showingPeers = true;

    body.innerHTML = `
      ${peerSection('federation.incomingHeading', incoming, [['accept', 'federation.acceptButton', 'btn-primary'], ['reject', 'federation.rejectButton', 'btn-danger']], 'fed-incoming')}
      ${peerSection('federation.activeHeading', active, [['revoke', 'federation.revokeButton', 'btn-danger']], 'fed-active')}
      ${peerSection('federation.outgoingHeading', outgoing, [['revoke', 'federation.cancelRequestButton', 'btn-secondary']], 'fed-outgoing')}
      <div class="divider"></div>
      <h3>${t('federation.inviteHeading')}</h3>
      <p class="hint">${t('federation.inviteHint')}</p>
      <button type="button" class="btn btn-primary" id="fed-invite-gen">${t('federation.generateInvite')}</button>
      ${inviteLink ? `
        <div class="field" style="margin-top:12px">
          <div style="display:flex;gap:8px">
            <input class="input" id="fed-invite-link" type="text" readonly value="${escapeHtml(inviteLink)}">
            <button type="button" class="btn btn-secondary" id="fed-invite-copy">${t('federation.copyButton')}</button>
          </div>
        </div>` : ''}
      <div class="divider"></div>
      <h3>${t('federation.redeemHeading')}</h3>
      <form id="fed-redeem">
        <div class="field">
          <label for="fed-redeem-input">${t('federation.redeemHint')}</label>
          <input class="input" id="fed-redeem-input" type="text" placeholder="${escapeHtml(t('federation.redeemPlaceholder'))}" value="${escapeHtml(redeemDraft)}" required>
        </div>
        <button type="submit" class="btn btn-primary">${t('federation.redeemButton')}</button>
      </form>
      <div class="divider"></div>
      <button type="button" class="btn btn-ghost" id="fed-logout">${t('federation.logoutButton')}</button>`;
    if (redeemFocused) body.querySelector('#fed-redeem-input').focus();

    body.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => onPeerAction(btn.dataset.act, Number(btn.dataset.id), btn.dataset.domain));
    });

    body.querySelector('#fed-invite-gen').addEventListener('click', async () => {
      try {
        inviteLink = (await api.federationCreateInvite()).fullUrl;
        renderPeers(peers);
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });

    body.querySelector('#fed-invite-copy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(inviteLink);
        toast(t('federation.linkCopied'));
      } catch { body.querySelector('#fed-invite-link').select(); }
    });

    body.querySelector('#fed-redeem').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await api.federationRedeemInvite(body.querySelector('#fed-redeem-input').value.trim());
        toast(t('federation.redeemSent', { domain: res.domain }));
        load();
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });

    body.querySelector('#fed-logout').addEventListener('click', async () => {
      try { await api.federationLogout(); load(); } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });
  }

  async function onPeerAction(act, id, domain) {
    const run = async (call, doneKey) => {
      try {
        await call(id);
        toast(t(doneKey));
        load();
      } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    };
    if (act === 'accept') return run(api.federationAcceptPeer, 'federation.accepted');
    if (act === 'reject') return run(api.federationRejectPeer, 'federation.rejected');
    confirmModal({
      title: t('federation.confirmRevokeTitle'),
      message: t('federation.confirmRevokeMessage', { domain: escapeHtml(domain) }),
      confirmLabel: t('federation.revokeButton'),
      onConfirm: () => run(api.federationRevokePeer, 'federation.revoked'),
    });
  }

  // Site admins get a content-free nudge on any peer status change; the refetch itself still goes
  // through the federation-admin credential.
  const off = bus.on('ws:federation_peer_update', () => {
    if (!body.isConnected) return off();
    if (showingPeers) load({ quiet: true });
  });

  load();
}
