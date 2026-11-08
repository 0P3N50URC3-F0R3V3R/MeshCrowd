// Android stills for the website/wiki. Usage: node dshots.mjs <outDir>. App logged in as mara on :8099.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { tapXY, shot, swipe, key, typeText, sh } from './droid.mjs';
import { sleep } from './lib.mjs';
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const D = (x, y, p = 1500) => tapXY(x * 1.2, y * 1.2, p);
const S = (x1, y1, x2, y2, ms = 700, p = 1400) => swipe(x1 * 1.2, y1 * 1.2, x2 * 1.2, y2 * 1.2, ms, p);
const snap = (n) => shot(`${out}/${n}.png`);
const TAB = { servers: 112, messages: 338, notifications: 563, you: 789 };
const tab = (n, p = 2000) => D(TAB[n], 1900, p);
const step = async (n, fn) => { try { await fn(); console.log('ok  ', n); } catch (e) { console.log('FAIL', n, e.message); snap(`fail-${n}`); } };
const back = (p = 1400) => D(73, 177, p);

await tab('servers'); snap('servers');
await step('general', async () => { await D(300, 738, 3000); snap('general'); });
await step('soundboard', async () => { await D(381, 1890, 2000); snap('soundboard'); await key('KEYCODE_BACK', 1000); });
await step('slash', async () => { await D(400, 1785, 800); await typeText('/', 600); await sleep(2000); snap('slash'); await key('KEYCODE_BACK', 800); });
await key('KEYCODE_BACK', 800); await back(1200);
await tab('you', 2500); snap('you-0');
for (let i = 1; i <= 5; i++) { await S(450, 1500, 450, 500, 800, 1500); snap(`you-${i}`); }
