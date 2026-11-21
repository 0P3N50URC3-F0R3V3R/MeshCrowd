// Group DM moderation against the :8099 tour server: creator edit/delete/kick, revert to 1:1. Set CDP to drive an already running Electron / C# client.
import { createRequire } from 'node:module';
import path from 'node:path';
import { Client, BASE, sleep } from './lib.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const CHROME = path.resolve(import.meta.dirname, '../../ChromePortable/GoogleChromePortable/App/Chrome-bin/chrome.exe');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const tag = Date.now().toString(36).slice(-5);
const [c, a, b, d] = ['dmc', 'dma', 'dmb', 'dmd'].map((n) => new Client(`${n}${tag}`));
for (const cl of [c, a, b, d]) await cl.register(cl.name, cl.name);
const { dmId } = await c.post('/api/dms/group', { userIds: [a.user.id, b.user.id, d.user.id], name: 'Mod group' });
const sent = await a.post(`/api/dms/${dmId}/messages`, { content: 'hello from a' });
const msgId = sent.message.id;

const CDP = process.env.CDP;
const browser = CDP ? await chromium.connectOverCDP(CDP) : await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = CDP ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1200, height: 800 }, locale: 'en-US' });
const page = CDP ? ctx.pages()[0] : await ctx.newPage();
if (CDP) await ctx.clearCookies();
await page.goto(BASE + '/');
if (await page.locator('#f-username').count() || await page.waitForSelector('#f-username', { timeout: 4000 }).catch(() => null)) {
  await page.fill('#f-username', c.name); await page.fill('#f-password', 'tourpass123');
  await page.click('#auth-submit');
  await page.waitForSelector('.auth-screen', { state: 'detached' });
}
await page.waitForSelector(`[data-dm="${dmId}"]`, { timeout: 15000 });
await page.click(`[data-dm="${dmId}"]`);
const group = page.locator(`.msg-group[data-id="${msgId}"]`);
await group.waitFor();
await group.hover();
check('creator sees edit on member message', await group.locator('[data-action="edit"]').count() === 1);
check('creator sees delete on member message', await group.locator('[data-action="delete"]').count() === 1);
check('members button present', await page.locator('#dm-members-btn').count() === 1);

await group.locator('[data-action="edit"]').click();
await page.locator('.msg-edit-box textarea').fill('moderated by creator');
await page.keyboard.press('Enter');
await page.waitForFunction((id) => /edited by|szerkesztette/.test(document.querySelector(`.msg-group[data-id="${id}"] .edited-tag`)?.textContent || ''), msgId, { timeout: 8000 }).catch(() => {});
check('tag says edited by creator', /edited by|szerkesztette/.test(await group.locator('.edited-tag').textContent().catch(() => '')), await group.locator('.edited-tag').textContent().catch(() => ''));
const aView = (await a.get(`/api/dms/${dmId}/messages`)).messages.find((m) => m.id === msgId);
check('member sees editedBy via API', aView?.editedBy?.displayName === c.name && aView.content === 'moderated by creator');
let denied = false;
try { await a.patch(`/api/messages/${(await c.post(`/api/dms/${dmId}/messages`, { content: 'creator says' })).message.id}`, { content: 'x' }); } catch { denied = true; }
check('member cannot edit creator message', denied);

const kick = async (target) => {
  if (!(await page.locator('[data-kick]').count())) await page.click('#dm-members-btn');
  await page.locator(`[data-kick="${target.user.id}"]`).click();
  await page.getByRole('button', { name: /^(Remove|Eltávolítás)$/ }).last().click();
  await sleep(1200);
};
await kick(d);
check('still a group after first kick', (await c.get('/api/dms')).dms.find((x) => x.id === dmId).isGroup === true);
check('kicked user lost the dm', !(await d.get('/api/dms')).dms.some((x) => x.id === dmId));
check('kick button for one fewer member', await page.locator('[data-kick]').count() === 2);
await kick(b);
await sleep(800);
check('reverted to 1:1 server side', (await c.get('/api/dms')).dms.find((x) => x.id === dmId).isGroup === false);
check('members button gone after revert', await page.locator('#dm-members-btn').count() === 0);
await page.locator(`.msg-group[data-id="${msgId}"]`).hover();
check('edit gone for others message after revert', await page.locator(`.msg-group[data-id="${msgId}"] [data-action="edit"]`).count() === 0);
check('delete gone for others message after revert', await page.locator(`.msg-group[data-id="${msgId}"] [data-action="delete"]`).count() === 0);
let kickDenied = false;
try { await c.req('DELETE', `/api/dms/${dmId}/members/${a.user.id}`); } catch { kickDenied = true; }
check('cannot kick from the 1:1', kickDenied);

// ---- phase 2: server owner / EDIT_MESSAGES role / plain member editing channel messages ----
const { server } = await c.post('/api/servers', { name: 'Edit ' + tag, visibility: 'private' });
const sid = server.id;
const det = await c.get('/api/servers/' + sid);
await a.post('/api/servers/join', { inviteCode: det.server.invite_code });
await b.post('/api/servers/join', { inviteCode: det.server.invite_code });
const chId = det.channels[0].id;
const role = (await c.post('/api/servers/' + sid + '/roles', { name: 'Editors', color: '#ff8800', permissions: (1 << 0) | (1 << 1) | (1 << 19) })).role;
await c.patch('/api/servers/' + sid + '/roles/' + role.id, { permissions: (1 << 0) | (1 << 1) | (1 << 19) });
await c.put('/api/servers/' + sid + '/members/' + b.user.id + '/roles/' + role.id);
const say = async (cl, text) => (await cl.post('/api/servers/' + sid + '/channels/' + chId + '/messages', { content: text })).message.id;
const m1 = await say(a, 'channel msg by a');
await page.reload();
await page.waitForSelector('[data-server="' + sid + '"]', { timeout: 15000 });
await page.click('[data-server="' + sid + '"]');
await page.waitForSelector('[data-channel="' + chId + '"]');
await page.click('[data-channel="' + chId + '"]');
const g1 = page.locator('.msg-group[data-id="' + m1 + '"]');
await g1.waitFor();
await g1.hover();
check('owner sees edit on member channel message', await g1.locator('[data-action="edit"]').count() === 1);
await g1.locator('[data-action="edit"]').click();
await page.locator('.msg-edit-box textarea').fill('owner edited this');
await page.keyboard.press('Enter');
await page.waitForFunction((id) => /edited by|szerkesztette/.test(document.querySelector('.msg-group[data-id="' + id + '"] .edited-tag')?.textContent || ''), m1, { timeout: 8000 }).catch(() => {});
check('channel tag says edited by owner', /edited by|szerkesztette/.test(await g1.locator('.edited-tag').textContent().catch(() => '')));
const m2 = await say(a, 'second by a');
const r2 = await b.patch('/api/messages/' + m2, { content: 'role holder edit' });
check('EDIT_MESSAGES role holder can edit via API', r2.message.editedBy?.id === b.user.id);
let plain = false;
try { await a.patch('/api/messages/' + (await say(c, 'owner msg')), { content: 'x' }); } catch { plain = true; }
check('plain member cannot edit owner message', plain);
const m3 = await say(b, 'by b');
let noPerm = false;
const x = new Client('dmx' + tag); await x.register(x.name, x.name); await x.post('/api/servers/join', { inviteCode: det.server.invite_code });
try { await x.patch('/api/messages/' + m3, { content: 'x' }); } catch { noPerm = true; }
check('member without permission cannot edit', noPerm);
await page.screenshot({ path: process.env.TMPDIR ? `${process.env.TMPDIR}/dmgroup.png` : 'dmgroup.png' });
await browser.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
