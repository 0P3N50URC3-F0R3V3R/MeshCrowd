// Phone UI (/m/) group DM moderation + admin edit, on the :8099 tour server. Set CDP (e.g. http://localhost:9222 for the Android WebView/Chrome) or run headless with a 390px mobile viewport.
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client, BASE, sleep } from './lib.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const CHROME = path.resolve(import.meta.dirname, '../../ChromePortable/GoogleChromePortable/App/Chrome-bin/chrome.exe');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const tag = Date.now().toString(36).slice(-5);
const [c, a, b, d] = ['mdc', 'mda', 'mdb', 'mdd'].map((n) => new Client(`${n}${tag}`));
for (const cl of [c, a, b, d]) await cl.register(cl.name, cl.name);
const { dmId } = await c.post('/api/dms/group', { userIds: [a.user.id, b.user.id, d.user.id], name: 'Phone group' });
const msgId = (await a.post(`/api/dms/${dmId}/messages`, { content: 'phone hello' })).message.id;
const { server } = await c.post('/api/servers', { name: 'MEdit ' + tag, visibility: 'private' });
const det = await c.get('/api/servers/' + server.id);
await a.post('/api/servers/join', { inviteCode: det.server.invite_code });
const chId = det.channels[0].id;
const chMsg = (await a.post(`/api/servers/${server.id}/channels/${chId}/messages`, { content: 'channel by a' })).message.id;

const CDP = process.env.CDP;
const browser = CDP ? await chromium.connectOverCDP(CDP) : await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = CDP ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, locale: 'en-US' });
const page = CDP ? (ctx.pages()[0] || await ctx.newPage()) : await ctx.newPage();
if (CDP) { await ctx.clearCookies(); await page.bringToFront(); }
await page.goto(BASE + '/m/');
await page.evaluate(async ([u, p]) => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }); }, [c.name, 'tourpass123']);
await page.goto(BASE + '/m/');
const longPress = async (sel) => { const l = page.locator(sel); await l.dispatchEvent('pointerdown'); await sleep(700); await l.dispatchEvent('pointerup'); };
const sheetItems = async () => page.locator('.m-sheet-item').evaluateAll((els) => els.map((e) => e.dataset.id));

await page.waitForSelector(`[data-dm="${dmId}"]`, { timeout: 20000 });
await page.click(`[data-dm="${dmId}"]`);
await page.waitForSelector(`.m-msg[data-id="${msgId}"]`);
await longPress(`.m-msg[data-id="${msgId}"]`);
await page.waitForSelector('.m-sheet-item');
let items = await sheetItems();
check('creator sheet has edit', items.includes('edit'), items.join(','));
check('creator sheet has delete', items.includes('delete'));
await page.click('.m-sheet-item[data-id="edit"]');
await page.fill('#c-input', 'phone moderated');
await page.click('#c-send');
await page.waitForFunction((id) => /edited by|szerkesztette/.test(document.querySelector(`.m-msg[data-id="${id}"] .m-edited`)?.textContent || ''), msgId, { timeout: 8000 }).catch(() => {});
check('phone tag says edited by creator', /edited by|szerkesztette/.test(await page.locator(`.m-msg[data-id="${msgId}"] .m-edited`).textContent().catch(() => '')), await page.locator(`.m-msg[data-id="${msgId}"] .m-edited`).textContent().catch(() => ''));

check('group settings button present', await page.locator('#m-dm-members').count() === 1);
const kick = async (target) => {
  await page.click('#m-dm-members');
  await page.waitForSelector('.m-sheet-item');
  await page.click(`.m-sheet-item[data-id="${target.user.id}"]`);
  await page.waitForSelector('.m-confirm-row .btn-danger, .m-confirm-row button:last-child');
  await page.locator('.m-confirm-row button').last().click();
  await sleep(1500);
};
await kick(d);
check('still a group after first kick', (await c.get('/api/dms')).dms.find((x) => x.id === dmId).isGroup === true);
await kick(b);
check('reverted to 1:1', (await c.get('/api/dms')).dms.find((x) => x.id === dmId).isGroup === false);
await page.waitForSelector(`.m-msg[data-id="${msgId}"]`);
await sleep(800);
check('settings button gone after revert', await page.locator('#m-dm-members').count() === 0);
await longPress(`.m-msg[data-id="${msgId}"]`);
await page.waitForSelector('.m-sheet-item');
items = await sheetItems();
check('no edit/delete on others message after revert', !items.includes('edit') && !items.includes('delete'), items.join(','));
await page.keyboard.press('Escape');
await page.mouse.click(5, 5);

// admin edit on a channel message through the phone UI
await page.goto(BASE + '/m/');
await page.waitForSelector('.m-tab');
await page.click('[data-tab="servers"]');
await page.waitForSelector(`[data-sid="${server.id}"]`, { timeout: 10000 }).catch(() => {});
await page.locator(`[data-sid="${server.id}"]`).first().click().catch(() => {});
await page.waitForSelector(`[data-cid="${chId}"]`, { timeout: 10000 }).catch(() => {});
await page.locator(`[data-cid="${chId}"]`).first().click().catch(() => {});
await page.waitForSelector(`.m-msg[data-id="${chMsg}"]`, { timeout: 10000 });
await longPress(`.m-msg[data-id="${chMsg}"]`);
await page.waitForSelector('.m-sheet-item');
items = await sheetItems();
check('owner sheet has edit on member channel message', items.includes('edit'), items.join(','));
await page.click('.m-sheet-item[data-id="edit"]');
await page.fill('#c-input', 'owner edit on phone');
await page.click('#c-send');
await page.waitForFunction((id) => /edited by|szerkesztette/.test(document.querySelector(`.m-msg[data-id="${id}"] .m-edited`)?.textContent || ''), chMsg, { timeout: 8000 }).catch(() => {});
check('channel tag says edited by owner on phone', /edited by|szerkesztette/.test(await page.locator(`.m-msg[data-id="${chMsg}"] .m-edited`).textContent().catch(() => '')));
await page.screenshot({ path: process.env.TMPDIR ? `${process.env.TMPDIR}/mdm.png` : 'mdm.png' });
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
