// Phone-sized smoke test for the /m/ UI against the seeded demo server. Usage: node mtest.mjs <shotsDir> <scenario>
import fs from 'node:fs';
import { launch } from './rec.mjs';
import { BASE, sleep, PASSWORD } from './lib.mjs';

const out = process.argv[2];
const scenario = process.argv[3] || 'forum';
fs.mkdirSync(out, { recursive: true });
const { browser, page } = await launch({ width: 390, height: 780, mobile: true, headless: true, video: false });
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
await page.goto(BASE + '/m/');
await page.waitForSelector('#f-username');
await page.fill('#f-username', 'mara'); await page.fill('#f-password', PASSWORD);
await page.click('#auth-submit');
await page.waitForSelector('.m-tabs, .m-servers', { timeout: 20000 });
await sleep(1500);
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const open = async (name) => { await page.locator('.m-chan', { hasText: name }).first().click(); await sleep(1500); };

if (scenario === 'forum') {
  await open('ideas'); await shot('forum');
  await page.click('#m-new'); await sleep(600);
  await page.fill('#fp-title', 'Mobile test post'); await page.fill('#fp-content', 'Created from the phone UI.');
  await shot('forum-new');
  await page.click('[data-yes]'); await sleep(2000); await shot('forum-post');
  await page.goBack(); await sleep(1200); await shot('forum-after');
}
if (scenario === 'notes') { await open('journal'); await shot('notes'); }
if (scenario === 'settings') {
  await page.locator('#m-srv-menu').click(); await sleep(500); await shot('srvmenu');
  await page.locator('.m-sheet-item', { hasText: 'Server Settings' }).click(); await sleep(1500); await shot('srvsettings');
  console.log(await page.locator('.snav-item').allInnerTexts()); await page.locator('.snav-item', { hasText: /^Roles$/ }).click({ timeout: 5000 }); await sleep(800); await shot('srvroles');
  await page.locator('.settings-close').click(); await sleep(500);
  await page.getByText('You', { exact: true }).last().click(); await sleep(800);
  await page.locator('[data-id="tab:appearance"]').click(); await sleep(1200); await shot('appearance');
  await page.locator('.settings-close').click(); await sleep(400);
  await page.locator('[data-id="tab:voice"]').click(); await sleep(1200); await shot('voice');
  await page.locator('.settings-close').click(); await sleep(400);
  await page.locator('[data-id="admin"]').click(); await sleep(1500); await shot('admin');
}
if (scenario === 'extras') {
  await page.getByText('You', { exact: true }).last().click(); await sleep(800);
  await page.locator('[data-id="scheduled"]').click(); await sleep(1200); await shot('scheduled');
  await page.keyboard.press('Escape');
  await page.locator('.modal-overlay .modal-close, .modal .close, [data-close]').first().click({ timeout: 2000 }).catch(() => {});
  await page.locator('[data-id="saved"]').click({ timeout: 3000 }).catch(() => {}); await sleep(1000); await shot('saved');
}
await browser.close();
