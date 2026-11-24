const REG_KEY = { open: 'auth.registrationOpen', invite: 'auth.registrationInvite', closed: 'auth.registrationClosed' };

export function renderBrand(instance, esc, markHtml) {
  const name = instance && instance.name ? esc(instance.name) : 'MeshCrowd';
  const logo = instance && instance.hasLogo ? '<img class="auth-logo" src="/instance/logo" alt="">' : `<div class="mark">${markHtml}</div>`;
  return `<div class="auth-brand">${logo}<div class="name">${name}</div></div>`;
}

export function renderInstanceInfo(instance, regMode, t, esc) {
  const desc = instance && instance.description ? `<p class="auth-instance-desc">${esc(instance.description)}</p>` : '';
  const key = REG_KEY[regMode] || REG_KEY.open;
  return `${desc}<div class="auth-reg-badge ${esc(regMode in REG_KEY ? regMode : 'open')}">${esc(t(key))}</div>`;
}

function ago(ms, now, t) {
  const mins = Math.max(0, Math.round((now - ms) / 60_000));
  if (mins < 1) return t('auth.swarmJustNow');
  if (mins < 60) return t('auth.swarmMinutes', { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 48) return t('auth.swarmHours', { n: hours });
  return t('auth.swarmDays', { n: Math.round(hours / 24) });
}

export function renderSwarmList(swarm, t, esc, now) {
  if (!swarm || !swarm.enabled || !Array.isArray(swarm.servers) || !swarm.servers.length) return '';
  const rows = swarm.servers.filter((s) => typeof s.url === 'string' && /^https:\/\//i.test(s.url)).map((s) => {
    const name = `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name || s.url)}</a>`;
    const icon = typeof s.icon === 'string' && s.icon.startsWith('data:image/png;base64,') ? `<img class="swarm-icon" src="${esc(s.icon)}" alt="">` : '<span class="swarm-icon"></span>';
    const reg = REG_KEY[s.registration] ? esc(t(REG_KEY[s.registration])) : '';
    return `<div class="swarm-row">${icon}<div class="swarm-main"><div class="swarm-name">${name}</div><div class="swarm-desc">${esc(s.description || '')}</div>`
      + `<div class="swarm-meta">${esc(s.url)} · ${reg} · ${esc(t('auth.swarmOnline'))} ${esc(ago(s.lastSeen, now, t))} · ${esc(t('auth.swarmUpdated'))} ${esc(ago(s.updated, now, t))}</div></div></div>`;
  }).join('');
  if (!rows) return '';
  return `<div class="auth-swarm"><h3>${esc(t('auth.swarmHeading'))}</h3>${rows}</div>`;
}
