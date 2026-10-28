// Joins Kai (camera), Priya and Nova to the Lounge voice room and stays until killed.
import { launch } from './rec.mjs';
import { BASE, sleep, PASSWORD } from './lib.mjs';

const list = process.argv.slice(2).length ? process.argv.slice(2) : ['kai:cam', 'priya', 'nova'];
const { browser } = await launch({ width: 1000, height: 700, headless: true, video: false });
for (const entry of list) {
  const [user, cam] = entry.split(':');
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, permissions: ['microphone', 'camera'] });
  const p = await ctx.newPage();
  await p.goto(BASE + '/');
  await p.waitForSelector('#f-username');
  await p.fill('#f-username', user); await p.fill('#f-password', PASSWORD);
  await p.click('#auth-submit');
  await p.waitForSelector('.auth-screen', { state: 'detached' });
  await sleep(1000);
  await p.locator('[data-server]').first().click();
  await p.locator('#sh-channel-list').getByText('Lounge', { exact: true }).first().click();
  await p.click('#vc-join'); await sleep(1500);
  if (cam) await p.click('#vc-camera');
}
console.log('peers ready');
await new Promise(() => {});
