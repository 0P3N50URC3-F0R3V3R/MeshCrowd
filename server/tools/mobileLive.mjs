import { chromium } from '../../node_modules/playwright/index.mjs';

export const CHROME = process.env.CHROME_PATH || new URL('../../ChromePortable/GoogleChromePortable/App/Chrome-bin/chrome.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const BASE = process.env.MOBILE_LIVE_BASE || 'http://localhost:8099';
export const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

export const flows = {};

// MOBILE_LIVE_VIEWPORT="WxH" overrides the default 390x844 (e.g. 320x568, 412x915, 915x412).
export async function launch(viewport = process.env.MOBILE_LIVE_VIEWPORT || '390x844') {
  const [width, height] = viewport.split('x').map(Number);
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width, height }, userAgent: ANDROID_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  return { browser, ctx, page: await ctx.newPage() };
}

export async function register(page, name) {
  await page.goto(`${BASE}/`);
  await page.waitForURL('**/m/');
  await page.click('#auth-toggle');
  await page.fill('#f-email', `${name}@test.local`);
  await page.fill('#f-username', name);
  await page.fill('#f-display', name);
  await page.fill('#f-password', 'correct-horse-battery-1');
  await page.click('#auth-submit');
  await page.waitForSelector('#m-tabbar');
}

flows.shell = async ({ page, shots }) => {
  await page.screenshot({ path: `${shots}/m-shell.png` });
  console.log('tabs:', await page.$$eval('.m-tab-label', (n) => n.map((x) => x.textContent)));
};

export async function apiCall(page, method, url, body) {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return r.json();
  }, [method, url, body]);
}
export async function sendMsg(page, serverId, channelId, content) {
  return page.evaluate(async ([s, c, text]) => {
    const fd = new FormData(); fd.append('content', text);
    return (await fetch(`/api/servers/${s}/channels/${c}/messages`, { method: 'POST', body: fd })).json();
  }, [serverId, channelId, content]);
}

flows.servers = async ({ page, shots }) => {
  const { server } = await apiCall(page, 'POST', '/api/servers', { name: 'Live Server' });
  const detail = await apiCall(page, 'GET', `/api/servers/${server.id}`);
  await sendMsg(page, server.id, detail.channels[0].id, 'hello from live test');
  await page.reload();
  await page.waitForSelector('.m-chan');
  console.log('channels:', await page.$$eval('.m-chan b', (n) => n.map((x) => x.textContent)));
  console.log('overflow:', await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth));
  await page.screenshot({ path: `${shots}/m-servers.png` });
};

flows.chat = async ({ page, shots }) => {
  const { server } = await apiCall(page, 'POST', '/api/servers', { name: 'Chat Live' });
  const detail = await apiCall(page, 'GET', `/api/servers/${server.id}`);
  const ch = detail.channels[0];
  for (let i = 1; i <= 52; i += 1) await sendMsg(page, server.id, ch.id, `seed message ${i}`);
  await page.reload();
  await page.waitForSelector('.m-chan');
  await page.click('.m-chan');
  await page.waitForSelector('.m-msg');
  await page.waitForTimeout(500);
  console.log('initial window size:', await page.$$eval('.m-msg', (n) => n.length));
  await page.click('#c-input');
  console.log('composer focused:', await page.evaluate(() => document.activeElement.id === 'c-input'));
  await page.fill('#c-input', 'typed from the composer');
  await page.click('#c-send');
  await page.waitForFunction(() => document.body.innerText.includes('typed from the composer'));
  await sendMsg(page, server.id, ch.id, 'live arrival');
  await page.waitForFunction(() => document.body.innerText.includes('live arrival'));
  await page.evaluate(() => { document.querySelector('#m-msgs').scrollTop = 0; });
  await page.waitForFunction(() => document.querySelectorAll('.m-msg').length > 50);
  console.log('older page loaded');
  await page.screenshot({ path: `${shots}/m-chat.png` });
};

flows.actions = async ({ page, shots }) => {
  const { server } = await apiCall(page, 'POST', '/api/servers', { name: 'Actions Live' });
  const detail = await apiCall(page, 'GET', `/api/servers/${server.id}`);
  await sendMsg(page, server.id, detail.channels[0].id, 'long press me');
  await page.reload();
  await page.waitForSelector('.m-chan');
  await page.click('.m-chan');
  await page.waitForSelector('.m-msg');
  const press = async () => { await page.waitForSelector('.m-sheet-back', { state: 'detached' }).catch(() => {}); const b = await (await page.$('.m-msg')).boundingBox(); await page.mouse.move(b.x + 80, b.y + 12); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up(); };
  await press();
  await page.waitForSelector('.m-sheet');
  await page.click('.m-quick-btn >> nth=0');
  await page.waitForSelector('.m-react.mine');
  console.log('reaction ok');
  await press(); await page.click('[data-id="reply"]');
  console.log('reply banner:', await page.textContent('#c-banner'));
  await page.fill('#c-input', 'a reply'); await page.click('#c-send');
  await page.waitForSelector('.m-reply');
  console.log('reply rendered');
  await press(); await page.click('[data-id="edit"]');
  await page.fill('#c-input', 'edited text'); await page.click('#c-send');
  await page.waitForFunction(() => document.body.innerText.includes('edited text'));
  console.log('edit ok');
  await page.click('.m-composer-row #c-plus');
  await page.click('[data-id="poll"]');
  await page.fill('#p-q', 'Pick one');
  const opts = await page.$$('.p-opt'); await opts[0].fill('Alpha'); await opts[1].fill('Beta');
  await page.click('#p-go');
  await page.waitForSelector('.m-poll-opt');
  await page.click('.m-poll-opt >> nth=0');
  await page.waitForSelector('.m-poll-opt.mine');
  console.log('poll vote ok');
  await page.screenshot({ path: `${shots}/m-actions.png` });
  await press(); await page.click('[data-id="delete"]'); await page.click('[data-yes]');
  await page.waitForFunction(() => !document.body.innerText.includes('edited text'));
  console.log('delete ok');
};

flows.threads = async ({ page, shots }) => {
  const { server } = await apiCall(page, 'POST', '/api/servers', { name: 'Threads Live' });
  const detail = await apiCall(page, 'GET', `/api/servers/${server.id}`);
  await sendMsg(page, server.id, detail.channels[0].id, 'thread parent');
  await page.reload();
  await page.waitForSelector('.m-chan');
  await page.click('.m-chan');
  await page.waitForSelector('.m-msg');
  await page.waitForSelector('.m-sheet-back', { state: 'detached' }).catch(() => {});
  const b = await (await page.$('.m-msg')).boundingBox();
  await page.mouse.move(b.x + 80, b.y + 12); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
  await page.click('[data-id="thread"]');
  await page.waitForTimeout(600);
  await page.fill('.m-sheet .m-input', 'My thread');
  await page.click('.m-sheet [data-yes]');
  await page.waitForFunction(() => document.querySelector('.m-screen:not([hidden]) #m-title')?.textContent === 'My thread');
  console.log('thread chat opened');
  await page.fill('.m-screen:not([hidden]) #c-input', 'inside thread'); await page.click('.m-screen:not([hidden]) #c-send');
  await page.waitForFunction(() => document.body.innerText.includes('inside thread'));
  await page.goBack();
  await page.click('#m-threads');
  await page.waitForSelector('.m-thread');
  console.log('threads list:', await page.$$eval('.m-thread b', (n) => n.map((x) => x.textContent)));
  await page.screenshot({ path: `${shots}/m-threads.png` });
  await page.goBack();
  console.log('back to channel chat:', await page.evaluate(() => document.querySelector('.m-screen:not([hidden]) #m-title')?.textContent));
};

flows.dm = async ({ page, shots, browser }) => {
  const me = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user);
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: ANDROID_UA, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  const name2 = `peer${Date.now() % 100000}`;
  await register(p2, name2);
  const peer = await p2.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user);
  // friend request from the first user through the UI
  await page.click('[data-tab="messages"]');
  await page.click('#m-addfriend');
  await page.waitForTimeout(500);
  await page.fill('.m-sheet .m-input', name2);
  await page.click('.m-sheet [data-yes]');
  await p2.reload();
  await p2.waitForSelector('#m-tabbar');
  await p2.click('[data-tab="messages"]');
  await p2.click('#m-friends');
  await p2.waitForSelector('[data-a="accept"]');
  await p2.click('[data-a="accept"]');
  await p2.waitForSelector('[data-a="dm"]');
  console.log('friend accepted; peer sees Online/Offline section');
  const dm = await apiCall(p2, 'POST', '/api/dms', { userId: me.id });
  await p2.evaluate(async (dmId) => { const fd = new FormData(); fd.append('content', 'hello from the peer'); await fetch(`/api/dms/${dmId}/messages`, { method: 'POST', body: fd }); }, dm.dmId);
  await page.waitForSelector('.m-dm.unread');
  console.log('unread DM row:', await page.$$eval('.m-dm b', (n) => n.map((x) => x.textContent)));
  await page.screenshot({ path: `${shots}/m-dms.png` });
  await page.click('.m-dm');
  await page.waitForFunction(() => document.body.innerText.includes('hello from the peer'));
  await page.fill('.m-screen:not([hidden]) #c-input', 'hello dm'); await page.click('.m-screen:not([hidden]) #c-send');
  await p2.waitForFunction(() => true);
  await page.waitForFunction(() => document.body.innerText.includes('hello dm'));
  console.log('dm send ok; peer is', peer.username);
  await ctx2.close();
};

flows.search = async ({ page, shots }) => {
  const me = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user);
  const { server } = await apiCall(page, 'POST', '/api/servers', { name: 'Search Live' });
  const detail = await apiCall(page, 'GET', `/api/servers/${server.id}`);
  const ch = detail.channels[0];
  await sendMsg(page, server.id, ch.id, `hey @${me.username} look`);
  await sendMsg(page, server.id, ch.id, 'nothing here');
  await sendMsg(page, server.id, ch.id, `${me.username} said hi`);
  await page.reload();
  await page.waitForSelector('.m-chan');
  await page.click('.m-chan');
  await page.waitForSelector('.m-msg');
  await page.click('#m-search');
  await page.waitForSelector('.m-filter');
  await page.click('[data-f="mentions"]');
  await page.click('[data-f="text"]');
  await page.fill('#m-q', me.username);
  await page.waitForSelector('.m-result');
  console.log('results:', await page.$$eval('.m-result-text', (n) => n.map((x) => x.textContent.trim())));
  await page.screenshot({ path: `${shots}/m-search.png` });
  await page.click('.m-result');
  await page.waitForFunction(() => document.querySelector('.m-screen:not([hidden]) .m-flash'));
  console.log('jumped to result with highlight');
  await page.goBack();
  await page.fill('#m-q', '');
  await page.press('#m-q', 'Enter');
  await page.waitForTimeout(600);
  console.log('history entries:', await page.$$eval('[data-h]', (n) => n.length));
};

flows.you = async ({ page, shots, browser }) => {
  await page.click('[data-tab="you"]');
  await page.click('[data-id="status"]');
  await page.click('[data-id="dnd"]');
  await page.waitForFunction(() => document.querySelector('[data-id="status"] small')?.textContent.length > 0);
  console.log('status sub-text:', await page.textContent('[data-id="status"] small'));
  await page.click('[data-id="profile"]');
  await page.waitForTimeout(600);
  await page.fill('#p-name', 'Renamed Live');
  await page.click('#p-save');
  await page.waitForFunction(() => document.querySelector('.m-you-name')?.textContent === 'Renamed Live');
  console.log('profile rename ok; android row without bridge:', await page.$('[data-id="android"]') !== null);
  await page.screenshot({ path: `${shots}/m-you.png` });
  const me = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user);
  const { server } = await apiCall(page, 'POST', '/api/servers', { name: 'Notif Live' });
  const detail = await apiCall(page, 'GET', `/api/servers/${server.id}`);
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: ANDROID_UA, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => { window.MeshCrowdAndroid = { getSettings: () => '{"pollMinutes":15,"fastMode":false}', setPollMinutes() {}, setFastMode() {} }; });
  await register(p2, `ment${Date.now() % 100000}`);
  await apiCall(p2, 'POST', '/api/servers/join', { inviteCode: detail.server.invite_code });
  await sendMsg(p2, server.id, detail.channels[0].id, `ping @${me.username} please`);
  await page.waitForSelector('[data-tab="notifications"] .m-badge');
  await page.click('[data-tab="notifications"]');
  await page.waitForSelector('.m-notif');
  console.log('notification:', await page.$$eval('.m-notif small', (n) => n.map((x) => x.textContent)));
  await page.screenshot({ path: `${shots}/m-notifs.png` });
  await page.click('.m-notif');
  await page.waitForFunction(() => document.body.innerText.includes('please'));
  await p2.click('[data-tab="you"]');
  console.log('android row with bridge:', await p2.$('[data-id="android"]') !== null);
  await ctx2.close();
};

flows.info = async ({ page, shots }) => {
  const { server } = await apiCall(page, 'POST', '/api/servers', { name: 'Info Live' });
  const detail = await apiCall(page, 'GET', `/api/servers/${server.id}`);
  const ch = detail.channels[0];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const sent = await page.evaluate(async ([s, c, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (x) => x.charCodeAt(0));
    const fd = new FormData(); fd.append('content', 'see https://example.com/page'); fd.append('files', new Blob([bytes], { type: 'image/png' }), 'dot.png');
    return (await (await fetch(`/api/servers/${s}/channels/${c}/messages`, { method: 'POST', body: fd })).json());
  }, [server.id, ch.id, png]);
  await apiCall(page, 'PUT', `/api/messages/${sent.message.id}/pin`);
  await page.reload();
  await page.waitForSelector('.m-chan');
  await page.click('.m-chan');
  await page.waitForSelector('.m-msg');
  await page.click('#m-info');
  await page.waitForSelector('.m-tabchip');
  console.log('members:', await page.$$eval('[data-u] b', (n) => n.length));
  await page.click('[data-t="media"]'); await page.waitForSelector('.m-media-cell');
  console.log('media cells:', await page.$$eval('.m-media-cell', (n) => n.length));
  await page.click('[data-t="links"]'); await page.waitForSelector('a.m-row');
  console.log('links:', await page.$$eval('a.m-row b', (n) => n.map((x) => x.textContent)));
  await page.click('[data-t="pins"]'); await page.waitForFunction(() => document.querySelector('.m-screen:not([hidden]) #m-pane')?.innerText.includes('example.com'));
  console.log('pins ok');
  await page.click('[data-q="mute"]');
  await page.waitForFunction(() => document.querySelector('[data-q="mute"] span')?.textContent.length > 0);
  await page.screenshot({ path: `${shots}/m-info.png` });
  const vc = await apiCall(page, 'POST', `/api/servers/${server.id}/channels`, { name: 'voice-room', type: 'voice' });
  await page.goBack(); await page.goBack();
  await page.reload(); await page.waitForSelector('.m-chan');
  await page.click('.m-chan >> nth=1');
  console.log('placeholder card:', await page.$('.m-placeholder') !== null);
};

flows.jump = async ({ page, shots }) => {
  const { server } = await apiCall(page, 'POST', '/api/servers', { name: 'Jump Live' });
  const detail = await apiCall(page, 'GET', `/api/servers/${server.id}`);
  const ch = detail.channels[0];
  await sendMsg(page, server.id, ch.id, 'ancient-needle first message');
  for (let i = 1; i <= 55; i += 1) await sendMsg(page, server.id, ch.id, `filler ${i}`);
  await page.reload();
  await page.waitForSelector('.m-chan');
  await page.click('.m-chan');
  await page.waitForSelector('.m-msg');
  await page.click('#m-search');
  await page.fill('#m-q', 'ancient-needle');
  await page.waitForSelector('.m-result');
  await page.click('.m-result');
  await page.waitForFunction(() => document.querySelector('.m-screen:not([hidden]) .m-flash'));
  await sendMsg(page, server.id, ch.id, 'brand new live message');
  await page.waitForTimeout(800);
  const appended = await page.evaluate(() => document.querySelector('.m-screen:not([hidden]) #m-msgs').innerText.includes('brand new live message'));
  const jumpVisible = await page.evaluate(() => !document.querySelector('.m-screen:not([hidden]) #m-jump').hidden);
  console.log('live message appended after a gap:', appended, '| jump button visible:', jumpVisible);
  await page.click('.m-screen:not([hidden]) #m-jump');
  await page.waitForFunction(() => document.querySelector('.m-screen:not([hidden]) #m-msgs').innerText.includes('brand new live message'));
  console.log('jump button loaded the latest page');
  await page.screenshot({ path: `${shots}/m-jump.png` });
  if (appended || !jumpVisible) process.exitCode = 1;
};

flows.minors = async ({ page, ctx }) => {
  const { server } = await apiCall(page, 'POST', '/api/servers', { name: 'Minors Live' });
  const detail = await apiCall(page, 'GET', `/api/servers/${server.id}`);
  await sendMsg(page, server.id, detail.channels[0].id, 'minor check');
  await page.reload();
  await page.waitForSelector('.m-chan');
  await page.click('.m-chan');
  await page.waitForSelector('.m-msg');
  const scope = () => page.evaluate(async () => (await import('/js/state.js')).state.mOpenScope);
  console.log('open scope while viewing chat:', await scope());
  await page.click('#m-info');
  await page.waitForSelector('.m-tabchip');
  console.log('open scope while info is on top:', await scope());
  // session dies while the app is open: the websocket drops and the app must return to sign-in by itself
  await apiCall(page, 'POST', '/api/auth/logout');
  await page.evaluate(async () => (await import('/js/ws.js')).ws.disconnect()); // the websocket drops and cannot come back
  await page.waitForSelector('#auth-submit', { timeout: 60000 });
  console.log('returned to sign-in after the session was killed');
};

flows.e2ee = async ({ page, shots, browser }) => {
  const me = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user);
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: ANDROID_UA, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  await register(p2, `enc${Date.now() % 100000}`);
  const dm = await apiCall(p2, 'POST', '/api/dms', { userId: me.id });
  const en = await apiCall(p2, 'POST', `/api/dms/${dm.dmId}/encryption/enable`);
  console.log('encryption enabled:', JSON.stringify(en).slice(0, 80));
  await page.reload(); await page.waitForSelector('#m-tabbar');
  await page.click('[data-tab="messages"]');
  await page.waitForSelector('.m-dm');
  await page.click('.m-dm');
  await page.waitForSelector('.m-screen:not([hidden]) #c-input');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('.m-screen:not([hidden]) #c-file-media', { name: 'dot.png', mimeType: 'image/png', buffer: png });
  await page.fill('.m-screen:not([hidden]) #c-input', 'secret text with an image');
  await page.click('.m-screen:not([hidden]) #c-send');
  await page.waitForFunction(() => document.querySelector('.m-screen:not([hidden]) #m-msgs').innerText.includes('secret text with an image'));
  await page.waitForFunction(() => { const i = document.querySelector('.m-screen:not([hidden]) img[data-e2ee-img]'); return i && i.src.startsWith('blob:'); });
  console.log('encrypted send with image shows plaintext + decrypted image');
  // the peer reads it
  await p2.reload(); await p2.waitForSelector('#m-tabbar');
  await p2.click('[data-tab="messages"]'); await p2.waitForSelector('.m-dm'); await p2.click('.m-dm');
  await p2.waitForFunction(() => document.querySelector('.m-screen:not([hidden]) #m-msgs').innerText.includes('secret text with an image'));
  await p2.waitForFunction(() => { const i = document.querySelector('.m-screen:not([hidden]) img[data-e2ee-img]'); return i && i.src.startsWith('blob:'); });
  console.log('peer decrypted text and image; ciphertext visible:', await p2.evaluate(() => document.body.innerText.includes('"v":')));
  await page.click('.m-screen:not([hidden]) #m-verify');
  await page.waitForSelector('.m-safety-number');
  console.log('safety number sheet:', (await page.textContent('.m-safety-number')).slice(0, 40));
  await page.screenshot({ path: `${shots}/m-e2ee.png` });
  await ctx2.close();
};

// Later tasks add `flows.<name>` entries above this runner; usage: node mobileLive.mjs <shotsDir> [flow]
if (process.argv[1] && process.argv[1].endsWith('mobileLive.mjs')) {
  const shots = process.argv[2] || '.';
  const { browser, ctx, page } = await launch();
  await register(page, `live${Date.now() % 100000}`);
  await flows[process.argv[3] || 'shell']({ page, ctx, browser, shots });
  await browser.close();
}
