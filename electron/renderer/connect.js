const STR = {
  en: {
    title: 'Connect to a MeshCrowd server', sub: 'Enter the address of the server you want to connect to.',
    known: 'Your servers', addr: 'Server address', connect: 'Connect', remove: 'Remove', add: 'Add',
    hint: "This is the same address you'd type into a browser to reach the MeshCrowd web client on that machine. Self-signed certificates are supported — you'll be asked to confirm trust on first connect.",
    publicHeading: 'Public servers', show: 'Show the public server list', privacy: 'Asking the trackers shows them your IP address. Off by default.',
    trackers: 'Trackers', loading: 'Loading…', empty: 'No public servers listed.', unreachable: 'No tracker could be reached.',
    online: 'online', updated: 'updated', now: 'just now', min: (n) => `${n} min ago`, hour: (n) => `${n} h ago`, day: (n) => `${n} d ago`,
    open: 'Open registration', invite: 'Invite only', closed: 'Registration closed', never: 'never used', badTracker: 'Enter an https address.',
  },
  hu: {
    title: 'Csatlakozás MeshCrowd szerverhez', sub: 'Add meg annak a szervernek a címét, amelyhez csatlakozni szeretnél.',
    known: 'Szervereid', addr: 'Szerver címe', connect: 'Csatlakozás', remove: 'Eltávolítás', add: 'Hozzáadás',
    hint: 'Ugyanazt a címet add meg, amelyet böngészőben írnál be a MeshCrowd webes kliens eléréséhez. Az önaláírt tanúsítványok támogatottak, az első csatlakozáskor meg kell erősítened a bizalmat.',
    publicHeading: 'Nyilvános szerverek', show: 'Nyilvános szerverlista megjelenítése', privacy: 'A trackerek lekérdezése megmutatja nekik az IP-címedet. Alapból kikapcsolva.',
    trackers: 'Trackerek', loading: 'Betöltés…', empty: 'Nincs listázott nyilvános szerver.', unreachable: 'Egyik tracker sem érhető el.',
    online: 'online', updated: 'frissítve', now: 'most', min: (n) => `${n} perce`, hour: (n) => `${n} órája`, day: (n) => `${n} napja`,
    open: 'Nyitott regisztráció', invite: 'Csak meghívóval', closed: 'Regisztráció zárva', never: 'még nem használt', badTracker: 'Adj meg egy https címet.',
  },
};
const T = navigator.language && navigator.language.toLowerCase().startsWith('hu') ? STR.hu : STR.en;
const $ = (id) => document.getElementById(id);
for (const [id, key] of [['t-title', 'title'], ['t-sub', 'sub'], ['t-known', 'known'], ['t-addr', 'addr'], ['t-connect', 'connect'], ['t-hint', 'hint'], ['t-public', 'publicHeading'], ['t-show', 'show'], ['t-privacy', 'privacy'], ['t-trackers', 'trackers'], ['tracker-add', 'add']]) $(id).textContent = T[key];

const ago = (ms) => {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return T.now;
  if (mins < 60) return T.min(mins);
  const hours = Math.round(mins / 60);
  return hours < 48 ? T.hour(hours) : T.day(Math.round(hours / 24));
};

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n[k] = v; }
  for (const k of kids) if (k) n.append(k);
  return n;
}

async function connect(url) {
  const errorEl = $('error');
  errorEl.textContent = '';
  const result = await window.dismeshClient.setServer(url);
  if (!result.ok) errorEl.textContent = result.error;
}

$('connect-form').addEventListener('submit', (e) => {
  e.preventDefault();
  connect($('url').value.trim());
});

function icon(src) {
  return src ? el('img', { class: 'icon', src, alt: '' }) : el('span', { class: 'icon' });
}

function renderKnown(list) {
  $('known').hidden = !list.length;
  const box = $('known-list');
  box.replaceChildren(...list.map((s) => {
    const rm = el('button', { class: 'small ghost', text: T.remove, title: T.remove });
    rm.addEventListener('click', async (e) => { e.stopPropagation(); renderKnown(await window.dismeshClient.forgetKnownServer(s.url)); });
    const row = el('div', { class: 'row' }, icon(s.icon), el('div', { class: 'main' }, el('div', { class: 'name', text: s.name }), el('div', { class: 'meta', text: s.url })), rm);
    row.addEventListener('click', () => connect(s.url));
    return row;
  }));
}

let swarm = { show: false, trackers: [] };
let loadToken = 0;

function renderTrackers() {
  $('trackers').replaceChildren(...swarm.trackers.map((t) => {
    const rm = el('button', { class: 'small ghost', text: T.remove });
    rm.addEventListener('click', async () => { swarm = await window.dismeshClient.setSwarmSettings({ trackers: swarm.trackers.filter((x) => x !== t) }); renderTrackers(); loadPublic(); });
    return el('div', { class: 'tracker' }, el('code', { text: t }), rm);
  }));
}

async function loadPublic() {
  const mine = ++loadToken;
  const list = $('swarm-list');
  const status = $('swarm-status');
  list.replaceChildren();
  if (!swarm.trackers.length) { status.textContent = T.unreachable; return; }
  status.textContent = T.loading;
  const { servers, errors } = await window.MeshSwarm.loadList({ trackers: swarm.trackers });
  if (mine !== loadToken || !swarm.show) return;
  status.textContent = servers.length ? '' : (errors.length === swarm.trackers.length ? T.unreachable : T.empty);
  list.replaceChildren(...servers.map((s) => {
    const meta = `${s.url} · ${T.online} ${ago(s.lastSeen)} · ${T.updated} ${ago(s.updated)}`;
    const row = el('div', { class: 'row' }, icon(s.icon), el('div', { class: 'main' },
      el('div', { class: 'name', text: s.name }),
      s.description ? el('div', { class: 'meta', text: s.description }) : null,
      el('div', { class: 'meta', text: meta })), el('span', { class: `badge ${s.registration}`, text: T[s.registration] }));
    row.addEventListener('click', () => connect(s.url));
    return row;
  }));
}

function applySwarmVisibility() {
  $('swarm').hidden = !swarm.show;
  $('swarm-show').checked = swarm.show;
  if (swarm.show) { renderTrackers(); loadPublic(); } else loadToken++;
}

$('swarm-show').addEventListener('change', async (e) => {
  swarm = await window.dismeshClient.setSwarmSettings({ show: e.target.checked });
  applySwarmVisibility();
});

$('tracker-add').addEventListener('click', async () => {
  const err = $('tracker-error');
  err.textContent = '';
  const value = $('tracker-new').value.trim();
  if (!/^https:\/\/[^\s/?#@]+/i.test(value)) { err.textContent = T.badTracker; return; }
  swarm = await window.dismeshClient.setSwarmSettings({ trackers: [...swarm.trackers, value] });
  $('tracker-new').value = '';
  renderTrackers();
  loadPublic();
});

(async () => {
  const [known, config] = await Promise.all([window.dismeshClient.getKnownServers(), window.dismeshClient.getConfig()]);
  renderKnown(known || []);
  swarm = { show: false, trackers: ['https://nexnet.hu:19898'], ...((config && config.swarm) || {}) };
  applySwarmVisibility();
})();
