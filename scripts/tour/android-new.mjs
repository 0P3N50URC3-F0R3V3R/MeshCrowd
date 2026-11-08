// Extra Android segment for the newer features: soundboard, status + auto away, notification grid, profile editor.
// Usage: node android-new.mjs <outDir>. App logged in as mara on :8099, any tab.
import { tapXY, swipe, key, startRecord, pull, sh } from './droid.mjs';
import { sleep } from './lib.mjs';
const out = process.argv[2];
const D = (x, y, p = 1500) => tapXY(x * 1.2, y * 1.2, p);
const S = (x1, y1, x2, y2, ms = 700, p = 1400) => swipe(x1 * 1.2, y1 * 1.2, x2 * 1.2, y2 * 1.2, ms, p);
const top = async () => { await D(789, 1900, 1500); for (let i = 0; i < 3; i++) await S(450, 500, 450, 1600, 500, 500); };
sh('settings put system show_touches 1');
const stop = startRecord('tour1'); await sleep(2000);
await D(112, 1900, 2000); await D(300, 738, 3000);
await D(381, 1890, 2500); await S(450, 1700, 450, 1300, 700, 1500); await D(804, 1496, 1500); await sleep(1200); await key('KEYCODE_BACK', 1500);
await key('KEYCODE_BACK', 1000); await D(73, 177, 1500);
await top(); await D(450, 526, 2500); await sleep(1500); await key('KEYCODE_BACK', 1500);
await top(); await D(450, 649, 2500); await S(450, 1500, 450, 800, 800, 2000); await key('KEYCODE_BACK', 1500);
await top(); await S(450, 1500, 450, 500, 800, 1500); await D(450, 1039, 2500);
await D(341, 457, 1500); await D(544, 665, 1200); await D(426, 782, 1200); await S(450, 1500, 450, 800, 700, 1800);
await key('KEYCODE_BACK', 1500); await sleep(1000);
await stop();
pull('tour1', `${out}/tour1.mp4`);
