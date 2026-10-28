// Records the Android tour on the emulator. Usage: node android.mjs <outDir> [shotsDir]
// The app must already be installed, pointed at http://localhost:8099 and logged in as mara
// (adb reverse tcp:8099 tcp:8099). Coordinates are in a 900x2000 space (the 1080x2400 screen / 1.2),
// because the WebView exposes no text to uiautomator.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { tapXY, shot as rawShot, swipe, key, typeText, startRecord, pull, sh } from './droid.mjs';
import { sleep } from './lib.mjs';

const outDir = process.argv[2];
const shots = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });
const D = (x, y, p = 1500) => tapXY(x * 1.2, y * 1.2, p);
const snap = (n) => { if (shots) rawShot(`${shots}/a-${n}.png`); };
const S = (x1, y1, x2, y2, ms = 700, p = 1400) => swipe(x1 * 1.2, y1 * 1.2, x2 * 1.2, y2 * 1.2, ms, p);
const TAB = { servers: 112, messages: 338, notifications: 563, you: 789 };
const tab = (n, p = 1800) => D(TAB[n], 1900, p);
const send = async (text) => { await D(400, 1890, 900); await typeText(text, 700); await D(835, 1890, 2600); };
const back = (p = 1400) => D(73, 177, p);
let segStart = Date.now();
const step = async (name, fn) => {
  if (Date.now() - segStart > 140000) {
    await stops.pop()();
    beginSeg(); segStart = Date.now(); await sleep(1500);
  }
  try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, e.message); snap(`fail-${name}`); }
};
const TOP = { general: 738, memes: 860, music: 983, afterDark: 1105, dev: 1320, design: 1442, ideas: 1564 };

sh('settings put system show_touches 1');
sh('settings put system pointer_location 0');
const segments = [];
let seg = 0;
const stops = [];
const beginSeg = () => { const name = `tour${seg++}`; segments.push(name); stops.push(startRecord(name)); return name; };
beginSeg();
await sleep(2500);

await step('servers', async () => {
  await tab('servers', 2000);
  snap('servers');
  await S(450, 1500, 450, 600, 900, 1600);
  await S(450, 700, 450, 1500, 900, 1600);
});

await step('general', async () => {
  await D(300, TOP.general, 3000);
  snap('general');
  await S(450, 500, 450, 1500, 800, 1500);
  await S(450, 1500, 450, 500, 800, 1500);
  await send('Hello from the phone');
  await D(400, 1890, 900); await typeText('/', 600); await sleep(2200);
  snap('slash');
  await typeText('roll', 600); await sleep(1000);
  await typeText('%s20', 400);
  await D(835, 1890, 3500);
  snap('slash-answer');
});

await step('members-search', async () => {
  await D(827, 177, 2500);
  snap('members');
  await key('KEYCODE_BACK', 1500);
  await D(636, 177, 1500);
  await typeText('game night', 800); await key('KEYCODE_ENTER', 2500);
  snap('search');
  await key('KEYCODE_BACK', 800); await key('KEYCODE_BACK', 1200);
  await back(1500);
});

await step('threads', async () => {
  await D(300, TOP.dev, 3000);
  snap('dev');
  await D(730, 177, 2200);
  snap('threads');
  await key('KEYCODE_BACK', 1200);
  await back(1500);
});

await step('poll', async () => {
  await D(300, TOP.music, 3000);
  snap('music');
  await back(1500);
});

await step('age-gate', async () => {
  await D(300, TOP.afterDark, 3000);
  snap('agegate');
  await back(1500);
});

await step('dm', async () => {
  await tab('messages', 2200);
  snap('messages');
  await D(450, 510, 3000);
  snap('dm');
  await send('Ready for the call test!');
  await back(1500);
});

await step('voice', async () => {
  await tab('servers', 1500);
  await S(450, 1600, 450, 400, 700, 1500);
  const peerProc = spawn('node', [new URL('./peers.mjs', import.meta.url).pathname.slice(1)], { stdio: 'ignore' });
  await D(300, 1529, 3000);
  snap('voice-0');
  await D(450, 1881, 2500);
  await sleep(14000);
  snap('voice-1');
  await S(450, 700, 450, 400, 600, 1500);
  await S(450, 400, 450, 700, 600, 1500);
  await D(406, 1866, 3500);
  snap('voice-cam');
  await D(669, 177, 2500);
  snap('voice-chat');
  await key('KEYCODE_BACK', 2000);
  await D(450, 1880, 1500);
  peerProc.kill();
  await key('KEYCODE_BACK', 1500);
});

await step('stage', async () => {
  await tab('servers', 1500);
  await S(450, 1600, 450, 400, 700, 1500);
  await D(300, 1773, 3000);
  snap('stage');
  await back(1500);
});

await step('profile', async () => {
  await tab('notifications', 2200);
  snap('notifications');
  await tab('you', 2500);
  snap('you');
  await tab('servers', 2000);
});

await sleep(1500);
await stops.pop()();
for (const s of segments) pull(s, `${outDir}/${s}.mp4`);
console.log('segments', segments.join(','));
