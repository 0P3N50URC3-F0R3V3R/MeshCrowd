import { bus } from '../bus.js';
import { api } from '../api.js';
import { icons } from '../icons.js';
import { escapeHtml, toast, apiErrorMessage, formatTimestamp } from '../utils.js';
import { openModal, confirmModal } from './modal.js';
import { t } from '../i18n.js';

// Server-wide scheduled events. Not embedded in the main server-detail payload (unlike emoji/
// stickers/sounds) since they're only ever needed when this modal is actually open — a lazy
// fetch here instead of bloating every server load.
export function openEventsModal(server, { canManage, channels } = {}) {
  let events = null; // null = loading
  const voiceLikeChannels = (channels || []).filter((c) => c.type === 'voice' || c.type === 'stage');

  const m = openModal({
    title: t('events.modalTitle', { server: server.name }),
    wide: true,
    onClose() {
      offAdd(); offUpdate(); offRemove(); offRsvp();
    },
    render(body) {
      body.innerHTML = `<div class="panel-loading" style="height:120px"><div class="spinner"></div></div>`;
    },
  });

  // event_add/event_update broadcasts never carry a trustworthy amInterested for anyone but the
  // actor who triggered them (server strips it before sending — see servers.js) — refetch rather
  // than trust the payload. event_rsvp_update is a lean count-only patch, safe to apply in place.
  const offAdd = bus.on('ws:event_add', ({ event }) => { if (event.serverId === server.id) load(); });
  const offUpdate = bus.on('ws:event_update', ({ event }) => { if (event.serverId === server.id) load(); });
  const offRemove = bus.on('ws:event_remove', ({ serverId }) => { if (serverId === server.id) load(); });
  const offRsvp = bus.on('ws:event_rsvp_update', ({ eventId, rsvpCount }) => {
    if (!events) return;
    const ev = events.find((e) => e.id === eventId);
    if (ev) { ev.rsvpCount = rsvpCount; renderList(); }
  });

  async function load() {
    try {
      const res = await api.listEvents(server.id);
      events = res.events;
      renderList();
    } catch (err) {
      m.body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, t('events.loadError')))}</p></div>`;
    }
  }

  function renderList() {
    const now = Date.now();
    const upcoming = events.filter((e) => e.status !== 'cancelled' && new Date(e.startTime).getTime() >= now);
    const past = events.filter((e) => e.status === 'cancelled' || new Date(e.startTime).getTime() < now);
    upcoming.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    past.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    m.body.innerHTML = `
      ${canManage ? `<button class="btn btn-secondary" id="ev-new" style="margin-bottom:16px">${icons.plus(16)} ${t('events.createEventButton')}</button>` : ''}
      <div class="field"><label>${t('events.upcomingLabel')}</label><div id="ev-upcoming"></div></div>
      ${past.length ? `<div class="field"><label>${t('events.pastCancelledLabel')}</label><div id="ev-past"></div></div>` : ''}`;

    const upcomingEl = m.body.querySelector('#ev-upcoming');
    upcomingEl.innerHTML = upcoming.length ? upcoming.map((e) => renderCard(e)).join('') : `<div class="empty-state" style="height:auto;padding:16px 0"><p>${t('events.nothingScheduled')}</p></div>`;
    const pastEl = m.body.querySelector('#ev-past');
    if (pastEl) pastEl.innerHTML = past.map((e) => renderCard(e, { faded: true })).join('');

    m.body.querySelector('#ev-new')?.addEventListener('click', () => openEventEditor(null));
    wireCardActions(m.body);
  }

  function renderCard(e, { faded } = {}) {
    const where = e.channelId ? `#${escapeHtml(e.channelName || t('events.deletedChannelFallback'))}` : escapeHtml(e.location || t('events.external'));
    return `
      <div class="list-row" style="align-items:flex-start;flex-wrap:wrap;${faded ? 'opacity:0.6' : ''}" data-event="${e.id}">
        <div style="width:40px;flex-shrink:0;text-align:center;color:var(--text-muted)">${icons.calendar(24)}</div>
        <div class="lr-main">
          <div class="lr-title">${escapeHtml(e.name)}${e.status === 'cancelled' ? ` <span class="hint">${t('events.cancelledSuffix')}</span>` : ''}</div>
          <div class="lr-sub">${formatTimestamp(e.startTime)}${e.endTime ? ` – ${formatTimestamp(e.endTime)}` : ''} · ${where}</div>
          ${e.description ? `<div style="margin-top:6px;font-size:13px;color:var(--text-secondary);white-space:pre-wrap">${escapeHtml(e.description)}</div>` : ''}
        </div>
        <div class="lr-actions" style="align-items:center">
          ${e.status !== 'cancelled' ? `
            <button class="btn btn-sm ${e.amInterested ? 'btn-primary' : 'btn-secondary'}" data-rsvp="${e.id}" data-interested="${e.amInterested ? '1' : '0'}">
              ${e.amInterested ? `✓ ${t('events.interested')}` : t('events.interested')} (${e.rsvpCount})
            </button>` : `<span class="hint">${t('events.interestedCountSuffix', { count: e.rsvpCount })}</span>`}
          ${canManage ? `
            <button class="btn-icon" data-event-edit="${e.id}" title="${t('events.editTitle')}">${icons.edit(16)}</button>
            <button class="btn-icon" data-event-delete="${e.id}" title="${t('events.deleteTitle')}">${icons.trash(16)}</button>` : ''}
        </div>
      </div>`;
  }

  function wireCardActions(body) {
    body.querySelectorAll('[data-rsvp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const eventId = Number(btn.dataset.rsvp);
        const interested = btn.dataset.interested === '1';
        try {
          const res = interested ? await api.unrsvpEvent(server.id, eventId) : await api.rsvpEvent(server.id, eventId);
          const idx = events.findIndex((e) => e.id === eventId);
          if (idx !== -1) events[idx] = res.event;
          renderList();
        } catch (err) { toast(apiErrorMessage(err, t('events.couldNotUpdateRsvp')), { type: 'error' }); }
      });
    });
    body.querySelectorAll('[data-event-edit]').forEach((btn) => {
      btn.addEventListener('click', () => openEventEditor(events.find((e) => e.id === Number(btn.dataset.eventEdit))));
    });
    body.querySelectorAll('[data-event-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const event = events.find((e) => e.id === Number(btn.dataset.eventDelete));
        confirmModal({
          title: t('events.deleteEventTitle'),
          message: t('events.deleteEventMessage', { name: escapeHtml(event.name) }),
          confirmLabel: t('events.deleteTitle'),
          async onConfirm() {
            try { await api.deleteEvent(server.id, event.id); await load(); }
            catch (err) { toast(apiErrorMessage(err, t('events.couldNotDeleteEvent')), { type: 'error' }); }
          },
        });
      });
    });
  }

  // datetime-local inputs work in the viewer's local time with no timezone suffix — new
  // Date(value) parses that as local time, and .toISOString() below converts it to UTC for the
  // server, so this round-trips correctly without the user ever thinking about timezones.
  function toLocalInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function openEventEditor(event) {
    let locationMode = event ? (event.channelId ? 'channel' : 'external') : (voiceLikeChannels.length ? 'channel' : 'external');
    const em = openModal({
      title: event ? t('events.editEventTitle') : t('events.createEventButton'),
      render(ebody) {
        ebody.innerHTML = `
          <div class="field">
            <label>${t('events.nameLabel')}</label>
            <input class="input" id="ev-name" value="${escapeHtml(event?.name || '')}" maxlength="100" placeholder="${t('events.namePlaceholder')}">
          </div>
          <div class="field">
            <label>${t('events.descriptionLabel')} <span class="hint">${t('events.optional')}</span></label>
            <textarea class="input textarea" id="ev-desc" rows="3" maxlength="1000">${escapeHtml(event?.description || '')}</textarea>
          </div>
          <div class="field">
            <label>${t('events.startsLabel')}</label>
            <input class="input" id="ev-start" type="datetime-local" value="${toLocalInputValue(event?.startTime) || ''}">
          </div>
          <div class="field">
            <label>${t('events.endsLabel')} <span class="hint">${t('events.optional')}</span></label>
            <input class="input" id="ev-end" type="datetime-local" value="${toLocalInputValue(event?.endTime)}">
          </div>
          <div class="field">
            <label>${t('events.locationLabel')}</label>
            <div class="tabs-row">
              <button type="button" class="tab-btn ${locationMode === 'channel' ? 'active' : ''}" id="ev-loc-channel" ${voiceLikeChannels.length ? '' : 'disabled'}>${t('events.voiceStageChannelTab')}</button>
              <button type="button" class="tab-btn ${locationMode === 'external' ? 'active' : ''}" id="ev-loc-external">${t('events.external')}</button>
            </div>
            <div id="ev-loc-body" style="margin-top:10px"></div>
          </div>
          <div class="error-text" id="ev-err"></div>`;

        function drawLocationBody() {
          const host = ebody.querySelector('#ev-loc-body');
          host.innerHTML = locationMode === 'channel'
            ? `<select class="input" id="ev-channel">${voiceLikeChannels.map((c) => `<option value="${c.id}" ${event?.channelId === c.id ? 'selected' : ''}>#${escapeHtml(c.name)} (${c.type})</option>`).join('')}</select>`
            : `<input class="input" id="ev-location" value="${escapeHtml(event?.location || '')}" maxlength="100" placeholder="${t('events.locationPlaceholder')}">`;
        }
        drawLocationBody();
        ebody.querySelector('#ev-loc-channel').addEventListener('click', () => { locationMode = 'channel'; drawLocationBody(); ebody.querySelector('#ev-loc-channel').classList.add('active'); ebody.querySelector('#ev-loc-external').classList.remove('active'); });
        ebody.querySelector('#ev-loc-external').addEventListener('click', () => { locationMode = 'external'; drawLocationBody(); ebody.querySelector('#ev-loc-external').classList.add('active'); ebody.querySelector('#ev-loc-channel').classList.remove('active'); });
      },
    });
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;width:100%';
    footer.innerHTML = `<button class="btn btn-ghost" data-cancel>${t('common.cancel')}</button><button class="btn btn-primary" data-save>${event ? t('common.save') : t('events.createEventButton')}</button>`;
    const footerHost = em.overlay.querySelector('.modal-footer');
    footerHost.classList.remove('hidden');
    footerHost.appendChild(footer);
    footer.querySelector('[data-cancel]').addEventListener('click', em.close);
    footer.querySelector('[data-save]').addEventListener('click', async () => {
      const name = em.body.querySelector('#ev-name').value.trim();
      const description = em.body.querySelector('#ev-desc').value.trim();
      const startVal = em.body.querySelector('#ev-start').value;
      const endVal = em.body.querySelector('#ev-end').value;
      const errEl = em.body.querySelector('#ev-err');
      if (!name) { errEl.textContent = t('events.nameRequired'); return; }
      if (!startVal) { errEl.textContent = t('events.startTimeRequired'); return; }
      const payload = {
        name, description,
        startTime: new Date(startVal).toISOString(),
        endTime: endVal ? new Date(endVal).toISOString() : null,
      };
      if (locationMode === 'channel') {
        const sel = em.body.querySelector('#ev-channel');
        if (!sel) { errEl.textContent = t('events.noVoiceChannelAvailable'); return; }
        payload.channelId = Number(sel.value);
      } else {
        const loc = em.body.querySelector('#ev-location').value.trim();
        if (!loc) { errEl.textContent = t('events.locationRequired'); return; }
        payload.location = loc;
      }
      try {
        if (event) await api.updateEvent(server.id, event.id, payload);
        else await api.createEvent(server.id, payload);
        em.close();
        await load();
      } catch (err) { errEl.textContent = apiErrorMessage(err, t('events.couldNotSaveEvent')); }
    });
  }

  load();
}
