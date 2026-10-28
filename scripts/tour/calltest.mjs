// Desktop check of call persistence, the one-call limit and the sidebar voice roster. Usage: node calltest.mjs <shotsDir> [chrome|electron]
import fs from 'node:fs';
import { launch } from './rec.mjs';
import { BASE, sleep, PASSWORD } from './lib.mjs';

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
const target = process.argv[3] || 'chrome';
let browser, page, electronApp;
if (target === 'electron') {
  const { _electron } = await import('playwright');
  const os = await import('node:os');
  const path = await import('node:path');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-electron-'));
  fs.writeFileSync(path.join(ud, 'dismesh-client-config.json'), JSON.stringify({ serverUrl: BASE, trustedFingerprints: {}, closeToTray: false, startWithWindows: false }));
  electronApp = await _electron.launch({
    executablePath: path.resolve(import.meta.dirname, '../../Client/MeshCrowd.exe'),
    args: [`--user-data-dir=${ud}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 }).catch(() => {});
  browser = { close: () => electronApp.close() };
} else {
  ({ browser, page } = await launch({ width: 1200, height: 800, headless: process.env.HEADED ? false : true, video: false }));
}
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(BASE + '/');
await page.waitForSelector('#f-username');
await page.fill('#f-username', 'mara'); await page.fill('#f-password', PASSWORD);
await page.click('#auth-submit');
await page.waitForSelector('.auth-screen', { state: 'detached' });
await sleep(1500);
await page.locator('[data-server]').first().click(); await sleep(1500);
const list = page.locator('#sh-channel-list');
const open = async (n) => { await list.getByText(n, { exact: true }).first().click(); await sleep(1200); };
const ok = (name, cond) => console.log(cond ? 'PASS' : 'FAIL', name);

await open('Lounge');
await page.click('#vc-join'); await sleep(2500);
ok('joined (leave button visible)', await page.locator('#vc-leave').isVisible());
await page.screenshot({ path: `${out}/1-joined.png` });
ok('sidebar roster shows self in Lounge', await page.locator('.ch-voice-user').count() >= 1);

await open('general');
ok('call bar visible on text channel', await page.locator('#s-callbar #cb-leave').isVisible());
await page.screenshot({ path: `${out}/2-textchannel.png` });

await open('Game night');
await page.click('#vc-join'); await sleep(1500);
ok('second join blocked (no leave button)', !(await page.locator('#vc-leave').isVisible()));
ok('blocked toast shown', await page.locator('.toast').count() > 0);
await page.screenshot({ path: `${out}/3-blocked.png` });

await page.click('#cb-return'); await sleep(1500);
ok('call bar returns to Lounge with live call', await page.locator('#vc-leave').isVisible());
await page.screenshot({ path: `${out}/4-returned.png` });

await page.click('#cb-leave'); await sleep(1500);
ok('bar gone after disconnect', await page.locator('#s-callbar').isHidden());
ok('join button back', await page.locator('#vc-join').isVisible());
await browser.close();
