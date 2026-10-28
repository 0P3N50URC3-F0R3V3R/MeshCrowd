import { api } from '../api.js';
import { escapeHtml, toast, apiErrorMessage, debounce } from '../utils.js';
import { t } from '../i18n.js';
import { confirmModal } from './modal.js';

const L = (key, params) => t(`admin.security.${key}`, params);
const SECTIONS = ['overview', 'captcha', 'protection', 'bans', 'blocklists', 'lookup', 'events'];
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const check = (id, on, label) => `<label class="check-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;
const num = (id, v, min, max, w = 120) => `<input class="input" id="${id}" type="number" min="${min}" max="${max}" value="${v}" style="max-width:${w}px">`;
const select = (id, value, options) => `<select class="input" id="${id}" style="max-width:260px">${options.map(([v, label]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
const card = (n, label) => `<div class="admin-stat-card" style="min-width:120px"><div class="num">${n}</div><div class="lbl">${label}</div></div>`;

// Admin Panel > Security Center: captcha, flood protection, IP bans and blocklists.
export function renderSecurityTab(inner) {
  let section = 'overview';

  function frame() {
    inner.innerHTML = `
      <h2>${L('title')}</h2>
      <div class="sec-subnav" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">
        ${SECTIONS.map((s) => `<button type="button" class="btn ${s === section ? 'btn-primary' : 'btn-secondary'}" data-sec="${s}">${L(`nav_${s}`)}</button>`).join('')}
      </div>
      <div id="sec-body"><div class="panel-loading" style="height:80px"><div class="spinner"></div></div></div>`;
    inner.querySelectorAll('[data-sec]').forEach((b) => b.addEventListener('click', () => { section = b.dataset.sec; frame(); }));
    const body = inner.querySelector('#sec-body');
    const view = { overview, captcha, protection, bans, blocklists, lookup, events }[section];
    view(body).catch((err) => { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(apiErrorMessage(err, L('loadError')))}</p></div>`; });
  }

  const saveFail = (box, err) => { box.textContent = apiErrorMessage(err, t('admin.couldNotSave')); };

  // ---------------- overview ----------------
  async function overview(body) {
    const o = await api.adminSecOverview();
    const ua = o.underAttack;
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${L('intro')}</p>
      <div class="admin-stat-card" style="max-width:none;text-align:left;margin-bottom:16px;${ua.active ? 'border:1px solid var(--danger)' : ''}">
        <b>${ua.active ? L('underAttackOn', { until: escapeHtml(when(ua.until)) }) : L('underAttackOff')}</b>
        <div class="hint" style="margin:6px 0 10px">${L('underAttackHint')}</div>
        ${ua.active
          ? `<button class="btn btn-secondary" id="ua-off" type="button">${L('underAttackStop')}</button>`
          : `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${num('ua-min', 60, 1, 1440, 100)} <span>${L('minutes')}</span><button class="btn btn-danger" id="ua-on" type="button">${L('underAttackStart')}</button></div>`}
      </div>
      <div class="admin-stats-row" style="flex-wrap:wrap">
        ${card(o.bans.manual, L('statManualBans'))}${card(o.bans.auto, L('statAutoBans'))}
        ${card(o.blocklists.entries, L('statListEntries'))}${card(o.sinceStart.blockedRequests, L('statBlocked'))}
      </div>
      <h3 style="margin:0 0 8px">${L('last24h')}</h3>
      <div class="admin-stats-row" style="flex-wrap:wrap">
        ${card(o.last24h.autoBans, L('statAutoBansNew'))}${card(o.last24h.threats, L('statThreats'))}
        ${card(o.last24h.captchaFailed, L('statCaptchaFailed'))}${card(o.last24h.honeypot, L('statHoneypot'))}
        ${card(o.last24h.registrationLimited, L('statSignupLimited'))}
      </div>
      <div class="hint" style="margin-bottom:16px">${L('sinceStart', { issued: o.sinceStart.captchaIssued, solved: o.sinceStart.captchaSolved, failed: o.sinceStart.captchaFailed })} &middot; ${L('yourIp', { ip: escapeHtml(o.yourIp || '?') })}</div>
      <h3 style="margin:0 0 8px">${L('recentEvents')}</h3>
      ${eventTable(o.recentEvents)}`;
    body.querySelector('#ua-on')?.addEventListener('click', async () => {
      try { await api.adminSecUnderAttack(true, Number(body.querySelector('#ua-min').value)); frame(); } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });
    body.querySelector('#ua-off')?.addEventListener('click', async () => { await api.adminSecUnderAttack(false); frame(); });
  }

  function eventTable(events) {
    if (!events.length) return `<div class="hint">${L('noEvents')}</div>`;
    return `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>${L('colTime')}</th><th>${L('colEvent')}</th><th>${L('colIp')}</th><th>${L('colDetail')}</th></tr></thead><tbody>
      ${events.map((e) => `<tr><td>${escapeHtml(when(e.ts))}</td><td>${escapeHtml(eventLabel(e.type))}</td><td>${escapeHtml(e.ip || '')}</td><td class="hint">${escapeHtml(detailText(e.detail))}</td></tr>`).join('')}
    </tbody></table></div>`;
  }
  const eventLabel = (type) => { const k = `admin.security.ev_${type}`; const s = t(k); return s === k ? type : s; };
  const detailText = (d) => (d ? Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${v}`).join(', ') : '');

  // ---------------- captcha ----------------
  async function captcha(body) {
    const cfg = (await api.adminSecSettings()).captcha;
    const words = cfg.words;
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${L('captchaIntro')}</p>
      <div class="field"><label>${L('captchaMode')}</label>
        ${select('c-mode', cfg.mode, [['off', L('modeOff')], ['after_failures', L('modeAfterFailures')], ['always', L('modeAlways')]])}</div>
      <div id="c-fail" class="field">
        <label>${L('captchaAfter')}</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${num('c-threshold', cfg.failureThreshold, 1, 100, 90)} <span>${L('failuresWithin')}</span> ${num('c-window', cfg.failureWindowMinutes, 1, 1440, 100)} <span>${L('minutes')}</span></div>
        <div class="hint">${L('captchaAfterHint')}</div></div>
      <div class="field"><label>${L('captchaApply')}</label>
        ${check('c-login', cfg.applyTo.login, L('applyLogin'))}${check('c-register', cfg.applyTo.register, L('applyRegister'))}</div>
      <div class="divider"></div>
      <h3 style="margin:0 0 8px">${L('captchaLook')}</h3>
      <div class="field"><label>${L('captchaType')}</label>
        ${select('c-type', cfg.type, [['text', L('typeText')], ['words', L('typeWords')], ['math', L('typeMath')]])}</div>
      <div id="c-text">
        <div class="field"><label>${L('captchaCharset')}</label>
          ${select('c-charset', cfg.charset, [['digits', L('charsetDigits')], ['letters', L('charsetLetters')], ['alphanumeric', L('charsetAlnum')]])}</div>
        <div class="field"><label>${L('captchaLength')}</label>${num('c-length', cfg.length, 3, 10, 90)}</div>
        ${check('c-ambig', cfg.excludeAmbiguous, L('excludeAmbiguous'))}
      </div>
      <div id="c-words">
        <div class="field"><label>${L('wordSource')}</label>
          ${select('c-wsource', words.source, [['builtin', L('sourceBuiltin')], ['custom', L('sourceCustom')], ['both', L('sourceBoth')]])}</div>
        <div class="field" id="c-wlists"><label>${L('wordLanguages')}</label>
          ${check('c-wl-en', words.lists.includes('en'), 'English')}${check('c-wl-hu', words.lists.includes('hu'), 'Magyar')}</div>
        <div class="field"><label>${L('wordCount')}</label>${num('c-wcount', words.count, 1, 3, 90)}<div class="hint">${L('wordCountHint')}</div></div>
        <div class="field" id="c-wcustom"><label>${L('customWords')}</label>
          <textarea class="input" id="c-wtext" rows="8" spellcheck="false" style="font-family:var(--font-mono);max-width:420px" placeholder="alma&#10;korte&#10;harbor">${escapeHtml(words.custom.join('\n'))}</textarea>
          <div class="hint" id="c-wcount"></div><div class="hint">${L('customWordsHint')}</div></div>
      </div>
      <div class="field"><label>${L('difficulty')}</label>
        ${select('c-diff', cfg.difficulty, [['easy', L('diffEasy')], ['medium', L('diffMedium')], ['hard', L('diffHard')]])}</div>
      <div class="field"><label>${L('captchaTtl')}</label>${num('c-ttl', cfg.ttlSeconds, 30, 1800, 110)} <span class="hint">${L('seconds')}</span></div>
      <div class="admin-stat-card" style="max-width:none;text-align:left;margin-bottom:12px">
        <b>${L('preview')}</b>
        <div id="c-preview" style="margin-top:8px"><span class="hint">${L('previewHint')}</span></div>
        <button class="btn btn-secondary" id="c-preview-btn" type="button" style="margin-top:8px">${L('previewButton')}</button>
      </div>
      <div class="error-text" id="c-err"></div>
      <button class="btn btn-primary" id="c-save" type="button">${t('common.save')}</button>`;

    const $ = (id) => body.querySelector(id);
    const collect = () => ({
      mode: $('#c-mode').value, failureThreshold: Number($('#c-threshold').value), failureWindowMinutes: Number($('#c-window').value),
      applyTo: { login: $('#c-login').checked, register: $('#c-register').checked },
      type: $('#c-type').value, charset: $('#c-charset').value, length: Number($('#c-length').value), excludeAmbiguous: $('#c-ambig').checked,
      difficulty: $('#c-diff').value, ttlSeconds: Number($('#c-ttl').value),
      words: {
        source: $('#c-wsource').value, count: Number($('#c-wcount').value), custom: $('#c-wtext').value,
        lists: ['en', 'hu'].filter((l) => $(`#c-wl-${l}`).checked),
      },
    });
    const toggle = () => {
      $('#c-fail').style.display = $('#c-mode').value === 'after_failures' ? '' : 'none';
      $('#c-text').style.display = $('#c-type').value === 'text' ? '' : 'none';
      $('#c-words').style.display = $('#c-type').value === 'words' ? '' : 'none';
      const src = $('#c-wsource').value;
      $('#c-wlists').style.display = src === 'custom' ? 'none' : '';
      $('#c-wcustom').style.display = src === 'builtin' ? 'none' : '';
    };
    body.querySelectorAll('select').forEach((s) => s.addEventListener('change', toggle));
    toggle();

    const countWords = debounce(async () => {
      try {
        const r = await api.adminSecCheckWords($('#c-wtext').value);
        $('#c-wcount').textContent = L('wordsCounted', { count: r.count, rejected: r.rejected, max: r.max });
      } catch { /* the hint is optional */ }
    }, 300);
    $('#c-wtext').addEventListener('input', countWords);
    countWords();

    $('#c-preview-btn').addEventListener('click', async () => {
      const btn = $('#c-preview-btn');
      btn.disabled = true;
      try {
        const r = await api.adminSecCaptchaPreview(collect());
        $('#c-preview').innerHTML = `<img src="${r.image}" alt="" style="max-width:100%;border-radius:6px;background:#fff"><div class="hint" style="margin-top:4px">${L('previewAnswer')}: <b>${escapeHtml(r.answer)}</b></div>`;
      } catch (err) { $('#c-preview').textContent = apiErrorMessage(err); }
      btn.disabled = false;
    });
    $('#c-save').addEventListener('click', async () => {
      $('#c-err').textContent = '';
      try { await api.adminSecUpdateSettings({ captcha: collect() }); toast(L('saved')); frame(); } catch (err) { saveFail($('#c-err'), err); }
    });
  }

  // ---------------- protection ----------------
  async function protection(body) {
    const s = await api.adminSecSettings();
    const p = s.protection;
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${L('protectionIntro')}</p>
      <div class="field"><label>${L('protMode')}</label>
        ${select('p-mode', p.mode, [['protect', L('protProtect')], ['detect', L('protDetect')], ['off', L('protOff')]])}
        <div class="hint">${L('protModeHint')}</div></div>
      <div class="field"><label>${L('floodLimit')}</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${num('p-req', p.requestsPerWindow, 20, 1000000, 110)} <span>${L('requestsIn')}</span> ${num('p-win', p.windowSeconds, 1, 300, 90)} <span>${L('seconds')}</span></div>
        <div class="hint">${L('floodHint')}</div></div>
      <div class="field"><label>${L('banLength')}</label>${num('p-ban', p.banMinutes, 1, 525600, 110)} <span class="hint">${L('minutes')}</span></div>
      <div class="field"><label>${L('strikes')}</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${num('p-strikes', p.rateLimitStrikes, 3, 10000, 90)} <span>${L('strikesIn')}</span> ${num('p-swin', p.strikeWindowMinutes, 1, 1440, 90)} <span>${L('minutes')}</span></div>
        <div class="hint">${L('strikesHint')}</div></div>
      <div class="field"><label>${L('failedBan')}</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${num('p-fthr', p.failedLoginBan.threshold, 3, 10000, 90)} <span>${L('failuresWithin')}</span> ${num('p-fwin', p.failedLoginBan.windowMinutes, 1, 1440, 90)} <span>${L('minutes')}</span> &rarr; <span>${L('banFor')}</span> ${num('p-fban', p.failedLoginBan.banMinutes, 1, 525600, 100)} <span>${L('minutes')}</span></div></div>
      <div class="field"><label>${L('signupLimit')}</label>
        ${check('p-reg-on', p.registrationLimit.enabled, L('signupLimitOn'))}
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${num('p-reg-max', p.registrationLimit.max, 1, 1000, 90)} <span>${L('signupsPer')}</span> ${num('p-reg-h', p.registrationLimit.windowHours, 1, 720, 90)} <span>${L('hours')}</span></div></div>
      <div class="field">${check('p-honey', p.honeypot, L('honeypot'))}<div class="hint">${L('honeypotHint')}</div></div>
      <div class="field"><label>${L('autoAttack')}</label>
        ${check('p-ua-auto', p.underAttack.auto, L('autoAttackOn'))}
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${num('p-ua-trig', p.underAttack.trigger, 2, 1000, 90)} <span>${L('autoBansIn')}</span> ${num('p-ua-win', p.underAttack.windowMinutes, 1, 120, 90)} <span>${L('minutes')}</span> &rarr; <span>${L('forDuration')}</span> ${num('p-ua-dur', p.underAttack.durationMinutes, 1, 1440, 100)} <span>${L('minutes')}</span></div>
        <div class="hint">${L('autoAttackHint')}</div></div>
      <div class="divider"></div>
      <div class="field"><label>${L('allowlist')}</label>
        <textarea class="input" id="p-allow" rows="5" spellcheck="false" style="font-family:var(--font-mono);max-width:360px">${escapeHtml(s.allowlist.join('\n'))}</textarea>
        <div class="hint">${L('allowlistHint')}</div></div>
      <div class="error-text" id="p-err"></div>
      <button class="btn btn-primary" id="p-save" type="button">${t('common.save')}</button>`;
    const $ = (id) => body.querySelector(id);
    $('#p-save').addEventListener('click', async () => {
      $('#p-err').textContent = '';
      const v = (id) => Number($(id).value);
      try {
        await api.adminSecUpdateSettings({
          protection: {
            mode: $('#p-mode').value, requestsPerWindow: v('#p-req'), windowSeconds: v('#p-win'), banMinutes: v('#p-ban'),
            rateLimitStrikes: v('#p-strikes'), strikeWindowMinutes: v('#p-swin'), honeypot: $('#p-honey').checked,
            failedLoginBan: { threshold: v('#p-fthr'), windowMinutes: v('#p-fwin'), banMinutes: v('#p-fban') },
            registrationLimit: { enabled: $('#p-reg-on').checked, max: v('#p-reg-max'), windowHours: v('#p-reg-h') },
            underAttack: { auto: $('#p-ua-auto').checked, trigger: v('#p-ua-trig'), windowMinutes: v('#p-ua-win'), durationMinutes: v('#p-ua-dur') },
          },
          allowlist: $('#p-allow').value.split(/[\r\n,]+/).map((x) => x.trim()).filter(Boolean),
        });
        toast(L('saved'));
        frame();
      } catch (err) { saveFail($('#p-err'), err); }
    });
  }

  // ---------------- bans ----------------
  async function bans(body) {
    let source = '';
    let q = '';
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${L('bansIntro')}</p>
      <div class="field"><label>${L('banAdd')}</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input class="input" id="b-entry" placeholder="203.0.113.7" style="flex:2;min-width:220px">
          <input class="input" id="b-reason" placeholder="${L('banReason')}" style="flex:2;min-width:160px">
          ${select('b-dur', '', [['', L('durPermanent')], ['60', L('dur1h')], ['1440', L('dur1d')], ['10080', L('dur7d')], ['43200', L('dur30d')]])}
          <button class="btn btn-primary" id="b-add" type="button">${L('banButton')}</button>
        </div><div class="hint">${L('banHint')}</div><div class="error-text" id="b-err"></div></div>
      <details style="margin-bottom:16px"><summary style="cursor:pointer">${L('banImport')}</summary>
        <textarea class="input" id="b-import" rows="5" spellcheck="false" style="font-family:var(--font-mono);max-width:420px;margin-top:8px" placeholder="203.0.113.7&#10;198.51.100.0/24"></textarea>
        <div style="margin-top:8px"><button class="btn btn-secondary" id="b-import-btn" type="button">${L('banImportButton')}</button></div><div id="b-import-out" class="hint"></div></details>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        ${select('b-src', '', [['', L('srcAll')], ['manual', L('srcManual')], ['auto', L('srcAuto')]])}
        <input class="input" id="b-q" placeholder="${L('searchPlaceholder')}" style="max-width:240px">
        <button class="btn btn-secondary" id="b-clear-auto" type="button">${L('clearAuto')}</button>
      </div>
      <div id="b-list"></div>`;
    const $ = (id) => body.querySelector(id);

    async function loadList() {
      const { bans: rows } = await api.adminSecBans({ source, q });
      $('#b-list').innerHTML = rows.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>${L('colEntry')}</th><th>${L('colSource')}</th><th>${L('colReason')}</th><th>${L('colAdded')}</th><th>${L('colExpires')}</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td style="font-family:var(--font-mono)">${escapeHtml(r.entry)}</td><td>${r.source === 'auto' ? L('srcAuto') : L('srcManual')}${r.created_by ? ` <span class="hint">(${escapeHtml(r.created_by)})</span>` : ''}</td><td>${escapeHtml(r.reason)}</td><td>${escapeHtml(when(r.created_at))}</td><td>${r.expires_at ? escapeHtml(when(r.expires_at)) : L('never')}</td><td><button class="btn btn-danger" data-unban="${r.id}" type="button">${L('unban')}</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="hint">${L('noBans')}</div>`;
    }
    $('#b-list').addEventListener('click', async (e) => {
      const id = e.target.closest('[data-unban]')?.dataset.unban;
      if (!id) return;
      try { await api.adminSecRemoveBan(id); await loadList(); } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });
    $('#b-add').addEventListener('click', async () => {
      $('#b-err').textContent = '';
      try {
        await api.adminSecAddBan({ entry: $('#b-entry').value.trim(), reason: $('#b-reason').value.trim(), durationMinutes: $('#b-dur').value ? Number($('#b-dur').value) : null });
        $('#b-entry').value = ''; $('#b-reason').value = '';
        await loadList();
      } catch (err) { $('#b-err').textContent = apiErrorMessage(err); }
    });
    $('#b-import-btn').addEventListener('click', async () => {
      try {
        const r = await api.adminSecImportBans($('#b-import').value);
        $('#b-import-out').textContent = L('importResult', { added: r.added, invalid: r.invalid.length }) + (r.invalid.length ? `: ${r.invalid.slice(0, 5).join(', ')}` : '');
        await loadList();
      } catch (err) { $('#b-import-out').textContent = apiErrorMessage(err); }
    });
    $('#b-src').addEventListener('change', (e) => { source = e.target.value; loadList(); });
    $('#b-q').addEventListener('input', debounce((e) => { q = e.target.value; loadList(); }, 250));
    $('#b-clear-auto').addEventListener('click', () => confirmModal({
      title: L('clearAuto'), message: L('clearAutoConfirm'), confirmLabel: L('clearAuto'),
      onConfirm: async () => { await api.adminSecClearBans('auto'); await loadList(); },
    }));
    await loadList();
  }

  // ---------------- blocklists ----------------
  async function blocklists(body) {
    const { lists, presets } = await api.adminSecBlocklists();
    const have = new Set(lists.map((l) => l.url));
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${L('listsIntro')}</p>
      ${lists.length ? `<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>${L('colName')}</th><th>${L('colEntries')}</th><th>${L('colFetched')}</th><th>${L('colEvery')}</th><th>${L('colOn')}</th><th></th></tr></thead><tbody>
        ${lists.map((l) => `<tr><td><b>${escapeHtml(l.name)}</b><div class="hint" style="word-break:break-all">${escapeHtml(l.url)}</div>${l.last_error ? `<div class="hint" style="color:var(--danger)">${escapeHtml(l.last_error)}</div>` : ''}</td>
          <td>${l.entry_count}</td><td>${escapeHtml(when(l.last_fetched_at))}</td><td>${l.refresh_hours} ${L('hours')}</td>
          <td><input type="checkbox" data-toggle="${l.id}" ${l.enabled ? 'checked' : ''}></td>
          <td style="white-space:nowrap"><button class="btn btn-secondary" data-refresh="${l.id}" type="button">${L('refreshNow')}</button> <button class="btn btn-danger" data-remove="${l.id}" type="button">${t('common.remove')}</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="hint" style="margin-bottom:12px">${L('noLists')}</div>`}
      <h3 style="margin:16px 0 8px">${L('addList')}</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        ${presets.filter((p) => !have.has(p.url)).map((p) => `<button class="btn btn-secondary" data-preset="${escapeHtml(p.id)}" type="button">+ ${escapeHtml(p.name)}</button>`).join('')}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="input" id="l-name" placeholder="${L('listName')}" style="max-width:180px">
        <input class="input" id="l-url" placeholder="https://example.com/blocklist.txt" style="flex:1;min-width:240px">
        ${num('l-hours', 24, 1, 720, 90)}<span style="align-self:center">${L('hours')}</span>
        <button class="btn btn-primary" id="l-add" type="button">${L('addButton')}</button>
      </div>
      <div class="hint">${L('listsHint')}</div><div class="error-text" id="l-err"></div>`;
    const $ = (id) => body.querySelector(id);
    const reload = () => blocklists(body);
    const add = async (payload, btn) => {
      $('#l-err').textContent = '';
      if (btn) btn.disabled = true;
      try {
        const r = await api.adminSecAddBlocklist(payload);
        if (r.refreshError) toast(L('firstFetchFailed', { error: r.refreshError }), { type: 'error' });
        await reload();
      } catch (err) { $('#l-err').textContent = apiErrorMessage(err); if (btn) btn.disabled = false; }
    };
    body.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      const p = presets.find((x) => x.id === b.dataset.preset);
      add({ name: p.name, url: p.url, refreshHours: 24 }, b);
    }));
    $('#l-add').addEventListener('click', (e) => add({ name: $('#l-name').value, url: $('#l-url').value.trim(), refreshHours: Number($('#l-hours').value) }, e.currentTarget));
    body.querySelectorAll('[data-toggle]').forEach((c) => c.addEventListener('change', async () => { await api.adminSecUpdateBlocklist(c.dataset.toggle, { enabled: c.checked }); }));
    body.querySelectorAll('[data-refresh]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await api.adminSecRefreshBlocklist(b.dataset.refresh); toast(L('refreshed', { count: r.entries })); } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
      reload();
    }));
    body.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => confirmModal({
      title: L('removeListTitle'), message: L('removeListConfirm'), confirmLabel: t('common.remove'),
      onConfirm: async () => { await api.adminSecRemoveBlocklist(b.dataset.remove); reload(); },
    })));
  }

  // ---------------- lookup ----------------
  async function lookup(body) {
    body.innerHTML = `
      <p class="hint" style="margin:0 0 12px">${L('lookupIntro')}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <input class="input" id="k-ip" placeholder="203.0.113.7" style="max-width:260px">
        <button class="btn btn-primary" id="k-go" type="button">${L('lookupButton')}</button>
        <button class="btn btn-secondary" id="k-ban" type="button" hidden>${L('banThis')}</button>
      </div>
      <div id="k-out"></div>`;
    const $ = (id) => body.querySelector(id);
    const go = async () => {
      const out = $('#k-out');
      try {
        const r = await api.adminSecLookup($('#k-ip').value.trim());
        $('#k-ban').hidden = r.blocked || r.allowlisted;
        $('#k-ban').dataset.ip = r.ip;
        out.innerHTML = `
          <div class="admin-stat-card" style="max-width:none;text-align:left;margin-bottom:12px">
            <b style="font-family:var(--font-mono)">${escapeHtml(r.ip)}</b> &mdash;
            ${r.allowlisted ? L('lkAllowlisted') : r.blocked ? `<span style="color:var(--danger)">${L('lkBlocked')}</span>` : L('lkClean')}
            <div class="hint" style="margin-top:6px">${L('lkFailures', { count: r.recentFailures })} &middot; ${r.captchaRequired ? L('lkCaptchaYes') : L('lkCaptchaNo')}</div>
            ${r.bans.length ? `<div style="margin-top:6px">${L('lkBans')}: ${r.bans.map((b) => `<code>${escapeHtml(b.entry)}</code> (${b.source === 'auto' ? L('srcAuto') : L('srcManual')}${b.reason ? `, ${escapeHtml(b.reason)}` : ''})`).join('; ')}</div>` : ''}
            ${r.blocklists.length ? `<div style="margin-top:6px">${L('lkLists')}: ${r.blocklists.map((l) => escapeHtml(l.name)).join(', ')}</div>` : ''}
          </div>
          <h3 style="margin:0 0 8px">${L('lkEvents')}</h3>${eventTable(r.events.map((e) => ({ ...e, ip: r.ip })))}`;
      } catch (err) { out.innerHTML = `<div class="error-text">${escapeHtml(apiErrorMessage(err))}</div>`; $('#k-ban').hidden = true; }
    };
    $('#k-go').addEventListener('click', go);
    $('#k-ip').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    $('#k-ban').addEventListener('click', async () => {
      try { await api.adminSecAddBan({ entry: $('#k-ban').dataset.ip, reason: L('bannedFromLookup') }); toast(L('banned')); go(); } catch (err) { toast(apiErrorMessage(err), { type: 'error' }); }
    });
  }

  // ---------------- events ----------------
  async function events(body) {
    let type = '';
    body.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
        <select class="input" id="e-type" style="max-width:240px"></select>
        <button class="btn btn-secondary" id="e-clear" type="button">${L('clearEvents')}</button>
      </div>
      <div id="e-list"></div>`;
    const $ = (id) => body.querySelector(id);
    async function load() {
      const r = await api.adminSecEvents({ type, limit: 200 });
      $('#e-type').innerHTML = [['', L('allEvents')], ...r.types.map((x) => [x, eventLabel(x)])].map(([v, label]) => `<option value="${escapeHtml(v)}" ${v === type ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
      $('#e-list').innerHTML = eventTable(r.events);
    }
    $('#e-type').addEventListener('change', (e) => { type = e.target.value; load(); });
    $('#e-clear').addEventListener('click', () => confirmModal({ title: L('clearEvents'), message: L('clearEventsConfirm'), confirmLabel: L('clearEvents'), onConfirm: async () => { await api.adminSecClearEvents(); load(); } }));
    await load();
  }

  frame();
}
