// Scenario 8: Admin Panel > Calls > Voice engine in EN and HU: selector, status numbers, privacy
// notice, restart hint, warnings (LAN address, connect failures), auto-restart line, invalid port
// ranges, rollback to mesh with a conflicting stored range. Plus a static EN/HU key check.
import * as H from './lib.mjs';
const { check, section, sleep, waitFor } = H;

function flat(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') flat(v, `${prefix}${k}.`, out); else out[`${prefix}${k}`] = v;
  }
  return out;
}
const fill = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
const textOf = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

H.run('admin', async () => {
  section('8a. EN/HU key parity for the new SFU strings');
  const en = flat(H.en), hu = flat(H.hu);
  const sfuKeys = Object.keys(en).filter((k) => /^(admin\.calls\.(voice|warn_sfu)|voice\.(sfu|update|callMoved|noAccess|cameraShare|screenShare|pathSfu))/.test(k));
  const missing = sfuKeys.filter((k) => !(k in hu));
  const same = sfuKeys.filter((k) => k in hu && hu[k] === en[k] && en[k].length > 12);
  check(`all ${sfuKeys.length} SFU keys exist in hu.json`, missing.length === 0, missing.join(', '));
  check('no SFU key left untranslated (identical to EN)', same.length === 0, same.join(', '));
  const placeholders = sfuKeys.filter((k) => k in hu && JSON.stringify((en[k].match(/\{\w+\}/g) || []).sort()) !== JSON.stringify((hu[k].match(/\{\w+\}/g) || []).sort()));
  check('placeholders match between EN and HU', placeholders.length === 0, placeholders.join(', '));

  // turn.port 46071 overlaps the stored SFU range 46070..46073: a conflict already in the config file
  const srv = await H.startServer({ port: 8077, sfuPort: 46070, announcedHost: '', extra: { turn: { autoIp: false, externalIp: '', port: 46071 } } });
  const { apis, server, ch } = await H.world(srv, { users: ['alice', 'bob'], voice: ['Lounge'] });
  const { alice, bob } = apis;
  const pa = await H.openPage('alice'), pb = await H.openPage('bob');
  await H.loginPage(pa, srv, alice); await H.loginPage(pb, srv, bob);
  await H.joinVoice(pa, server.id, ch.Lounge.id);
  await H.joinVoice(pb, server.id, ch.Lounge.id);

  const pm = await H.openPage('alice-admin');
  await H.loginPage(pm, srv, alice);
  async function openCalls(p) {
    await p.evaluate(() => import('/js/views/admin.js').then((m) => m.openAdminPanel()));
    await p.click('[data-tab="calls"]');
    await p.waitForSelector('#vc-mode', { timeout: 10000 });
  }
  const panelText = (p) => p.evaluate(() => document.querySelector('#calls-body')?.innerText || '');
  const voiceSection = async (p) => { const t = await panelText(p); return t; };

  section('8b. EN: selector, status, privacy, LAN warning');
  await openCalls(pm);
  const L = flat(H.en).constructor === Object ? flat(H.en) : null;
  let txt = await voiceSection(pm);
  check('mode selector shows sfu', (await pm.$eval('#vc-mode', (s) => s.value)) === 'sfu');
  check('status line shows 1 room and 4 transports', txt.includes(textOf(fill(en['admin.calls.voiceStatusOn'], { workers: 1, rooms: 1, transports: 4, in: '', out: '' })).split('·')[0].trim().slice(0, 10)) && /\b1\b/.test(txt) && /\b4\b/.test(txt), txt.split('\n').find((l) => /worker/i.test(l)));
  H.note('EN status line:', txt.split('\n').find((l) => /worker/i.test(l)));
  check('privacy notice shown', txt.includes(textOf(en['admin.calls.voicePrivacy']).slice(0, 40)));
  check('LAN-address warning shown (no public address configured)', txt.includes(textOf(en['admin.calls.warn_sfuLan']).slice(0, 40)));
  check('firewall hint shows the port range 46070-46070 (1 worker)', txt.includes('46070-46070') || txt.includes('46070–46070') || /46070\D+46070/.test(txt), txt.split('\n').find((l) => /46070/.test(l)));
  check('no raw i18n keys in the panel', !/admin\.calls\.|voice\.[a-z]+[A-Z]/.test(txt), (txt.match(/admin\.calls\.\w+/g) || []).join(','));

  section('8c. connect-failure warning, restart hint, auto-restart line');
  const raw = await H.rawSocket(srv, bob);
  // bob's raw socket is a second socket of bob: use alice's own room membership via a third user instead
  await raw.close();
  await H.wsSend(pb, { type: 'sfu_request', id: 'rf1', channelId: ch.Lounge.id, op: 'report_failure', data: { direction: 'send' } });
  await sleep(500);
  await pm.click('[data-tab="calls"]');
  await pm.waitForSelector('#vc-mode');
  txt = await voiceSection(pm);
  check('connect-failure warning shown after a report_failure', txt.includes(textOf(fill(en['admin.calls.warn_sfuConnectFailures'], { count: 1, lo: 46070, hi: 46073 })).slice(0, 30)), txt.slice(0, 600));
  await alice.patch('/api/admin/calls', { turn: { externalIp: '127.0.0.1' } });
  await waitFor(async () => (await alice.sfuStatus()).lastAutoRestart?.ok, 15000);
  await pm.click('[data-tab="calls"]');
  await pm.waitForSelector('#vc-mode');
  txt = await voiceSection(pm);
  const ar = (await alice.sfuStatus()).lastAutoRestart;
  check('auto-restart line shows the address change', ar && txt.includes(ar.to) && txt.includes(textOf(en['admin.calls.voiceAutoRestart']).split('{')[0].trim().slice(0, 15)), JSON.stringify(ar));
  check('LAN warning gone after moving to a public (configured) address', !txt.includes(textOf(en['admin.calls.warn_sfuLan']).slice(0, 40)));
  const f = await H.waitFlowing([pa, pb], [1, 1], 20000);
  check('the live call recovered from the restart', f.ok, H.fmt(f.last));
  await pm.fill('#vc-kbps', '500');
  await pm.uncheck('#vc-tcp');
  await pm.click('#vc-save');
  await waitFor(() => pm.evaluate(() => window.__toasts.length > 0), 5000);
  txt = await voiceSection(pm);
  check('saving a TCP change shows the restart-required hint', txt.includes(textOf(en['admin.calls.voiceRestart']).slice(0, 30)), await pm.$eval('#vc-err', (e) => e.textContent));

  section('8d. invalid port ranges and rollback to mesh');
  await pm.fill('#vc-port', '65534');
  await pm.fill('#vc-workers', '4');
  await pm.click('#vc-save');
  const err1 = await waitFor(() => pm.$eval('#vc-err', (e) => e.textContent.trim()), 5000);
  check('65534 + 4 workers: clear error shown', !!err1 && /65535/.test(err1), err1);
  await pm.fill('#vc-port', '8077');
  await pm.fill('#vc-workers', '1');
  await pm.click('#vc-save');
  const err2 = await waitFor(async () => { const e = await pm.$eval('#vc-err', (x) => x.textContent.trim()); return e && e !== err1 && e; }, 5000);
  check('port = HTTP port: clear error', !!err2 && /8077|HTTP/i.test(err2), err2);
  await pm.fill('#vc-port', '46071');
  await pm.click('#vc-save');
  const err3 = await waitFor(async () => { const e = await pm.$eval('#vc-err', (x) => x.textContent.trim()); return e && e !== err2 && e; }, 5000);
  check('port overlapping the TURN port: clear error', !!err3 && /TURN/i.test(err3), err3);
  check('the UI is not wedged (save button enabled, inputs editable)', await pm.$eval('#vc-save', (b) => !b.disabled) && await pm.$eval('#vc-port', (i) => !i.disabled));
  const stored = (await alice.calls()).voice.sfu;
  check('nothing was stored by the refused saves', stored.port === 46070, JSON.stringify(stored));
  // reload the tab so the form shows the stored (conflicting: turn 46071 inside 46070..46071) range, then roll back
  await pm.click('[data-tab="calls"]');
  await pm.waitForSelector('#vc-mode');
  await pm.selectOption('#vc-mode', 'mesh');
  check('choosing mesh hides the SFU options', await pm.$eval('#vc-sfu-opts', (e) => e.style.display === 'none'));
  await pm.click('#vc-save');
  await sleep(1500);
  const errM = await pm.$eval('#vc-err', (e) => e.textContent.trim());
  const after = await alice.calls();
  check('rollback to mesh saves despite the stored conflicting range', !errM && after.voice.mode === 'mesh', `${errM} mode=${after.voice.mode}`);
  check('effective mode is now mesh', after.voice.effectiveMode === 'mesh');
  await pm.selectOption('#vc-mode', 'sfu');
  await pm.click('#vc-save');
  await sleep(1500);
  check('switching back to sfu works', (await alice.calls()).voice.mode === 'sfu', await pm.$eval('#vc-err', (e) => e.textContent.trim()));
  const refused = pm.__errors.filter((e) => /status of 400/.test(e)).length;
  check('only the 3 refused saves logged a 400', refused === 3, String(refused));
  pm.__errors = pm.__errors.filter((e) => !/status of 400/.test(e));
  H.checkNoPageErrors([pa, pb, pm]);

  section('8e. HU');
  await alice.put('/api/users/me/language', { code: 'hu' });
  await pm.reload();
  await pm.waitForSelector('[data-server]');
  await openCalls(pm);
  txt = await voiceSection(pm);
  check('HU: voice engine title in Hungarian', txt.includes(hu['admin.calls.voiceTitle']), hu['admin.calls.voiceTitle']);
  check('HU: privacy notice in Hungarian', txt.includes(textOf(hu['admin.calls.voicePrivacy']).slice(0, 40)));
  check('HU: restart hint in Hungarian', txt.includes(textOf(hu['admin.calls.voiceRestart']).slice(0, 30)));
  check('HU: auto-restart line in Hungarian', txt.includes(textOf(hu['admin.calls.voiceAutoRestart']).split('{')[0].trim().slice(0, 12)));
  check('HU: no raw keys', !/admin\.calls\.\w+/.test(txt));
  await pm.fill('#vc-port', '65534');
  await pm.fill('#vc-workers', '4');
  await pm.click('#vc-save');
  const errHu = await waitFor(() => pm.$eval('#vc-err', (e) => e.textContent.trim()), 5000);
  H.note('HU port error text:', errHu);
  check('HU: the port-range error is shown in Hungarian', !!errHu && errHu.startsWith('Az SFU porttartomány'), errHu);
  await pm.fill('#vc-port', '46071'); await pm.fill('#vc-workers', '1');
  await pm.click('#vc-save');
  const errHu2 = await waitFor(async () => { const e = await pm.$eval('#vc-err', (x) => x.textContent.trim()); return e && e !== errHu && e; }, 5000);
  check('HU: the TURN overlap error is shown in Hungarian', !!errHu2 && /TURN porttal/.test(errHu2), errHu2);
  pm.__errors = pm.__errors.filter((e) => !/status of 400/.test(e));
  if (process.env.HUNT_SHOTS) await pm.screenshot({ path: `${process.env.HUNT_SHOTS}/admin-calls-hu.png` }).catch(() => {});
  H.checkNoPageErrors([pm]);
  await H.stopServer(srv);
  check('server log has no exceptions', srv.problems.length === 0, srv.problems.slice(0, 3).join(' | '));
});
