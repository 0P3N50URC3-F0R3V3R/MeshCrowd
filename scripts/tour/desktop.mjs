// Records the desktop tour. Usage: node desktop.mjs <outDir> [en|hu] [shotsDir]
// Needs the seeded server from world.mjs. Peers stay logged in from a second headless browser so
// the member list shows presence, and some of them join voice so the voice scenes show a real room.
import fs from 'node:fs';
import { launch, Actor } from './rec.mjs';
import { BASE, sleep, PASSWORD } from './lib.mjs';

const outDir = process.argv[2];
const lang = process.argv[3] || 'en';
const shots = process.argv[4];
fs.mkdirSync(outDir, { recursive: true });
const hu = lang === 'hu';
const L = (en, h) => (hu ? h : en);
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

async function login(page, user) {
  await page.goto(BASE + '/');
  await page.waitForSelector('#f-username');
  await page.fill('#f-username', user); await page.fill('#f-password', PASSWORD);
  await page.click('#auth-submit');
  await page.waitForSelector('.auth-screen', { state: 'detached' });
  await sleep(1200);
}
const openChannel = async (page, name) => {
  await page.locator('#sh-channel-list').getByText(name, { exact: true }).first().click();
};

// ---- peers ----
const peers = await launch({ width: 1000, height: 700, headless: true, video: false });
async function startPeer(user, { voice = false, camera = false } = {}) {
  const ctx = await peers.browser.newContext({ viewport: { width: 1000, height: 700 }, permissions: ['microphone', 'camera'] });
  const p = await ctx.newPage();
  await login(p, user);
  await p.locator('[data-server]').first().click();
  if (voice) {
    await p.locator('#sh-channel-list').getByText('Lounge', { exact: true }).first().click();
    await p.click('#vc-join'); await sleep(1500);
    if (camera) await p.click('#vc-camera');
  }
  return p;
}
for (const u of ['jonas', 'lena', 'nova', 'tomas']) await startPeer(u);

// ---- main recording ----
const { browser, ctx, page } = await launch({ width: 1280, height: 720, videoDir: outDir, lang });
const a = new Actor(page);
const scene = async (name, fn) => {
  const t = Date.now();
  try { await fn(); console.log(`ok   ${name} ${((Date.now() - t) / 1000).toFixed(0)}s`); }
  catch (e) { console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); await shot(page, `fail-${name}`); }
};
const esc = async (n = 600) => { await page.keyboard.press('Escape'); await sleep(n); };

await scene('login', async () => {
  await page.goto(BASE + '/');
  await page.waitForSelector('#f-username');
  await sleep(1800);
  await a.type('#f-username', 'mara');
  await a.type('#f-password', PASSWORD, 70);
  await a.click('#auth-submit', 2500);
  await page.waitForSelector('.auth-screen', { state: 'detached' });
  await sleep(3000);
  await shot(page, 'home');
});

await scene('friends-dm', async () => {
  await a.click('#nav-friends', 2500);
  await shot(page, 'friends');
  await a.click('#hs-dm-list >> text=Kai Tanaka', 2200);
  await shot(page, 'dm');
  await a.type('#composer-input', L('Sounds good, see you in the lounge! :tada:', 'Rendben, találkozunk a Lounge-ban! :tada:'));
  await page.keyboard.press('Enter'); await sleep(2500);
});

await scene('server-general', async () => {
  await a.click('[data-server]', 1800);
  await openChannel(page, 'general');
  await sleep(2500);
  await a.scroll('#msg-scroll', -500, 12, 1500);
  await a.scroll('#msg-scroll', 700, 12, 1200);
  await shot(page, 'general');
});

await scene('message-menu', async () => {
  await a.rightClick('#msg-list > * >> nth=-3', 1800);
  await shot(page, 'message-menu');
  await esc(800);
});

await scene('emoji-send', async () => {
  await a.click('#btn-emoji', 1500);
  await shot(page, 'emoji');
  await esc(600);
  await a.type('#composer-input', L('Thanks all! Quick test from the tour :wave:', 'Köszi mindenkinek! Gyors teszt a bemutatóból :wave:'));
  await page.keyboard.press('Enter'); await sleep(2500);
});

await scene('slash', async () => {
  await a.click('#composer-input', 400);
  await page.keyboard.type('/', { delay: 100 }); await sleep(2200);
  await shot(page, 'slash');
  await page.keyboard.type('roll 20', { delay: 90 }); await sleep(1200);
  await page.keyboard.press('Enter'); await sleep(3500);
  await shot(page, 'slash-answer');
  await page.keyboard.type('/coinflip', { delay: 70 }); await sleep(900);
  await page.keyboard.press('Enter'); await sleep(900); await page.keyboard.press('Enter'); await sleep(3000);
});

await scene('members-panel', async () => {
  await a.click('#toggle-members', 1800);
  await a.click('#toggle-members', 1800);
  await shot(page, 'members');
});

await scene('thread', async () => {
  await openChannel(page, 'dev-talk');
  await sleep(2000);
  await a.click('#threads-btn', 2200);
  await shot(page, 'threads');
  await a.click('#s-members >> text=Voice layout feedback', 3000);
  await shot(page, 'thread-open');
});

await scene('pins-search', async () => {
  await openChannel(page, 'announcements');
  await sleep(1500);
  await a.click('#pins-btn', 2500);
  await a.click('#search-btn', 1000);
  await page.keyboard.type('game night', { delay: 90 }); await page.keyboard.press('Enter'); await sleep(2800);
  await shot(page, 'search');
  await a.click('#search-btn', 800);
});

await scene('forum-poll', async () => {
  await openChannel(page, 'ideas');
  await sleep(2500);
  await shot(page, 'forum');
  await openChannel(page, 'music');
  await sleep(2500);
  await shot(page, 'poll');
  await a.click('#btn-poll', 1800);
  await shot(page, 'poll-dialog');
  await esc(800);
});

await scene('age-gate', async () => {
  await openChannel(page, 'after-dark');
  await sleep(3000);
  await shot(page, 'agegate');
  await a.click('.age-gate .btn-primary', 2000);
  await sleep(1500);
});

await scene('voice', async () => {
  await openChannel(page, 'Lounge');
  await sleep(1500);
  await a.click('#vc-join', 2000);
  const kai = await startPeer('kai', { voice: true, camera: true });
  const priya = await startPeer('priya', { voice: true });
  const nova = await startPeer('nova', { voice: true });
  await sleep(3500);
  await shot(page, 'voice-1');
  const sp = await page.locator('#voice-splitter').boundingBox();
  const cx = sp.x + sp.width / 2;
  await a.drag({ x: cx, y: sp.y + 4 }, { x: cx, y: sp.y + 150 });
  await sleep(1500);
  await shot(page, 'voice-resized');
  await a.scroll('#vc-grid', 360, 10, 1500);
  await a.scroll('#vc-grid', -360, 10, 1000);
  await a.click('#vc-camera', 2500);
  await a.drag({ x: cx, y: sp.y + 154 }, { x: cx, y: sp.y - 40 });
  await a.type('#composer-input', L('Audio is crisp on my end!', 'Nálam tiszta a hang!'));
  await page.keyboard.press('Enter'); await sleep(2500);
  await a.click('#vc-soundboard', 1800);
  await shot(page, 'soundboard');
  await esc(500);
  await a.click('#vc-leave', 1500);
  for (const p of [kai, priya, nova]) await p.context().close();
});

await scene('stage', async () => {
  await openChannel(page, 'Town hall');
  await sleep(2000);
  await shot(page, 'stage');
  await a.click('#vc-join', 2500);
  await shot(page, 'stage-joined');
  await a.click('#vc-leave', 1500);
});

await scene('settings-themes', async () => {
  await a.click('#ub-settings', 2000);
  await shot(page, 'settings');
  await a.click(`text=${L('Appearance', 'Megjelenés')}`, 1500);
  for (const i of [1, 2, 3, 4, 0]) { await a.click(`.theme-preset-btn >> nth=${i}`, 1700); if (i === 2) await shot(page, 'theme-purple'); }
  await a.click(`text=${L('Voice & Video', 'Hang és videó')}`, 2000);
  await shot(page, 'settings-voice');
  await esc(1000);
});

await scene('server-settings', async () => {
  await openChannel(page, 'general');
  await a.click('#sh-header', 1200);
  await a.click(`text=${L('Server Settings', 'Szerver beállításai')}`, 2000);
  await shot(page, 'ss-overview');
  for (const i of [5, 6, 9, 10, 11, 12, 13, 14, 15]) {
    await a.click(`.snav-item >> nth=${i}`, 2000);
    await shot(page, `ss-${i}`);
  }
  await esc(1000);
});

await scene('finish', async () => {
  await openChannel(page, 'general');
  await sleep(3000);
});

await sleep(1500);
const video = page.video();
await ctx.close();
const vp = await video.path();
fs.renameSync(vp, `${outDir}/tour-desktop-${lang}.webm`);
await browser.close(); await peers.browser.close();
console.log('saved', `${outDir}/tour-desktop-${lang}.webm`);
