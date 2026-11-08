// Still screenshots of newer features for the website/wiki. Usage: node shots.mjs <outDir>
// Needs the seeded server (world.mjs). TOUR_CAMS = dir with <user>.mjpeg fake camera feeds.
import fs from 'node:fs';
import { launch } from './rec.mjs';
import { BASE, sleep, PASSWORD } from './lib.mjs';
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const CAMS = process.env.TOUR_CAMS;
const W = 1280, H = 800;
async function login(page, user) {
  await page.goto(BASE + '/'); await page.waitForSelector('#f-username');
  await page.fill('#f-username', user); await page.fill('#f-password', PASSWORD); await page.click('#auth-submit');
  await page.waitForSelector('.auth-screen', { state: 'detached' }); await sleep(1500);
}
const open = async (page, n) => { await page.locator('#sh-channel-list').getByText(n, { exact: true }).first().click(); await sleep(1800); };
const peers = [];
async function peer(user, { voice = false, cam = false } = {}) {
  const r = await launch({ width: 1000, height: 700, headless: true, video: false, cam: cam && CAMS ? `${CAMS}/${user}.mjpeg` : null });
  peers.push(r.browser);
  await login(r.page, user);
  await r.page.locator('[data-server]').first().click();
  if (voice) { await open(r.page, 'Lounge'); await r.page.click('#vc-join'); await sleep(1500); if (cam) await r.page.click('#vc-camera'); }
}
for (const u of ['jonas', 'lena', 'tomas']) await peer(u);
const { browser, page } = await launch({ width: W, height: H, video: false, headless: true, cam: CAMS ? `${CAMS}/mara.mjpeg` : null });
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const step = async (n, fn) => { try { await fn(); console.log('ok  ', n); } catch (e) { console.log('FAIL', n, e.message.split('\n')[0]); await shot(`fail-${n}`); } };
const noToast = () => page.evaluate(() => document.querySelectorAll('[class*=toast]').forEach((e) => e.remove()));
await login(page, 'mara');
await page.locator('[data-server]').first().click(); await sleep(1500);

await step('voice', async () => {
  await open(page, 'Lounge'); await page.click('#vc-join'); await sleep(1500);
  await peer('kai', { voice: true, cam: true }); await peer('priya', { voice: true, cam: true }); await peer('nova', { voice: true, cam: true });
  await page.click('#vc-camera'); await sleep(3500);
  await page.setViewportSize({ width: 1760, height: 1000 }); await sleep(1500);
  const sp = await page.locator('#voice-splitter').boundingBox();
  const cx = sp.x + sp.width / 2;
  await page.mouse.move(cx, sp.y + 4); await page.mouse.down(); await page.mouse.move(cx, 690, { steps: 15 }); await page.mouse.up(); await sleep(1500);
  await shot('voice-call');
  await page.click('#vc-soundboard'); await sleep(1200); await shot('voice-soundboard'); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: W, height: H });
  await page.click('#vc-leave'); await sleep(1000);
});
await step('chat', async () => { await open(page, 'general'); await shot('chat-general'); });
await step('emoji', async () => {
  await page.click('#btn-emoji'); await sleep(800);
  for (const i of [3, 12, 20, 33]) { await page.locator('.emoji-picker button, [class*=emoji] button >> visible=true').nth(i).click().catch(() => {}); await sleep(250); }
  await page.keyboard.press('Escape'); await sleep(400);
  await page.click('#btn-emoji'); await sleep(900); await shot('emoji-recents'); await page.keyboard.press('Escape');
});
await step('profile', async () => {
  await page.locator('.member-item', { hasText: 'Kai Tanaka' }).first().click(); await sleep(1500); await noToast(); await shot('profile-card'); await page.keyboard.press('Escape');
});
await step('notes', async () => {
  await open(page, 'general');
  await page.locator('#msg-list > * >> nth=-2').click({ button: 'right' }); await sleep(900); await shot('msg-menu-notes');
  await page.getByText('Save to Notes').click(); await sleep(1500);
  await open(page, 'journal'); await sleep(1500); await shot('notes-saved'); await open(page, 'general');
});
await step('schedule', async () => {
  await page.click('#composer-input'); await page.keyboard.type('Friday reminder: game night at 20:00');
  await page.locator('#btn-schedule').click(); await sleep(1200); await shot('schedule'); await page.keyboard.press('Escape');
});
await step('slash', async () => {
  await open(page, 'general');
  await page.click('#composer-input'); await page.keyboard.type('/', { delay: 100 }); await sleep(2000); await shot('slash-popup');
  await page.keyboard.type('roll 20', { delay: 90 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(3500); await shot('slash-answer');
});
await step('dm', async () => { await page.mouse.click(36, 75); await sleep(1200); await page.click('#nav-friends'); await sleep(1500); await page.locator('#hs-dm-list').getByText('Kai Tanaka').click(); await sleep(2000); await shot('dm'); await page.locator('[data-server]').first().click(); await sleep(1200); });
await step('forum', async () => { await open(page, 'ideas'); await shot('forum'); });
await step('thread', async () => { await open(page, 'dev-talk'); await page.click('#threads-btn'); await sleep(1500); await page.locator('#s-members').getByText('Voice layout feedback').click(); await sleep(2500); await shot('thread-open'); });
await step('search', async () => { await open(page, 'announcements'); await page.click('#search-btn'); await sleep(800); await page.keyboard.type('game night', { delay: 80 }); await page.keyboard.press('Enter'); await sleep(2500); await shot('search'); await page.click('#search-btn'); });
await step('agegate', async () => { await open(page, 'after-dark'); await sleep(1500); await shot('age-gate'); });
await step('stage', async () => { await open(page, 'Town hall'); await sleep(1000); await shot('stage'); });
await step('poll', async () => { await open(page, 'music'); await shot('poll'); });
await page.click('#ub-settings'); await sleep(1500);
const nav = (t) => page.locator('.snav-item', { hasText: t }).first().click().then(() => sleep(1200));
await step('account', async () => { await nav('My Account'); await page.getByText('Customize the effect').click(); await sleep(800); await noToast(); await shot('my-account'); });
await step('status', async () => { await nav('Status'); await page.locator('input[type=number]').first().fill('300'); await sleep(500); await shot('status-autoaway'); });
await step('notif', async () => {
  await nav('Notifications'); await page.getByText('Idle', { exact: true }).first().click(); await sleep(600);
  await page.evaluate(() => document.querySelector('main, .settings-content, #settings-content')?.scrollBy(0, 250));
  await sleep(500); await shot('notif-grid');
});
await step('appearance', async () => {
  await nav('Appearance');
  for (let i = 0; i < 4; i++) { await page.mouse.move(700, 400); await page.mouse.wheel(0, 650); await sleep(500); }
  const sels = page.locator('select');
  const n = await sels.count();
  for (let i = n - 1; i >= 0; i--) { const o = await sels.nth(i).locator('option').allInnerTexts(); if (o.length > 3 && o[0] === 'Default') { await sels.nth(i).selectOption({ index: 3 }); break; } }
  await sleep(600); await shot('appearance-2');
  for (let i = n - 1; i >= 0; i--) { const o = await sels.nth(i).locator('option').allInnerTexts(); if (o.length > 3 && o[0] === 'Default') { await sels.nth(i).selectOption({ index: 0 }); break; } }
});
await step('voice-settings', async () => { await nav('Voice & Video'); await page.mouse.move(700, 400); await page.mouse.wheel(0, 700); await sleep(600); await shot('voice-settings'); });
await page.keyboard.press('Escape'); await sleep(800);
await step('ss', async () => {
  await open(page, 'general'); await page.click('#sh-header'); await sleep(600);
  await page.getByText('Server Settings').first().click(); await sleep(1500);
  const items = await page.locator('.snav-item').allInnerTexts(); console.log(items.join(' | '));
  await page.locator('.snav-item', { hasText: /^Roles/ }).first().click(); await sleep(1200);
  await page.getByText('Builder', { exact: true }).first().click(); await sleep(900);
  const sel = page.locator('select').filter({ hasText: 'No effect' }).first();
  await sel.selectOption({ label: 'Neon' }).catch(async () => { await sel.selectOption({ index: 4 }); });
  await sleep(1200); await shot('ss-roles-effect');
  await page.locator('.snav-item', { hasText: /^Members/ }).first().click(); await sleep(1200);
  await page.mouse.click(896, 210); await sleep(900); await shot('ss-members-menu');
  await page.getByText('Restrictions').first().click(); await sleep(1200); await shot('ss-restrictions');
});
await page.keyboard.press('Escape'); await sleep(800);
await step('themes', async () => {
  for (const [label, name] of [['Midnight Purple', 'theme-purple'], ['Forest', 'theme-forest'], ['Sunset', 'theme-sunset'], ['MeshCrowd Light', 'theme-light'], ['MeshCrowd Dark', null]]) {
    await page.click('#ub-settings'); await sleep(1200); await nav('Appearance');
    await page.getByText(label, { exact: true }).first().click(); await sleep(900);
    await page.keyboard.press('Escape'); await sleep(900);
    if (name) { await open(page, 'general'); await sleep(800); await shot(name); }
  }
});
await browser.close(); for (const b of peers) await b.close().catch(() => {});
