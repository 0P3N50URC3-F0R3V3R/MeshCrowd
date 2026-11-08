import { tapXY, shot, swipe, key } from './droid.mjs';
const out = process.argv[2];
const D = (x, y, p = 1500) => tapXY(x * 1.2, y * 1.2, p);
const S = (x1, y1, x2, y2, ms = 700, p = 1400) => swipe(x1 * 1.2, y1 * 1.2, x2 * 1.2, y2 * 1.2, ms, p);
const snap = (n) => shot(`${out}/${n}.png`);
const top = async () => { await D(789, 1900, 1500); for (let i = 0; i < 3; i++) await S(450, 500, 450, 1600, 500, 500); };
await top(); await D(450, 526, 2200); snap('m-status'); await S(450, 1500, 450, 900, 600, 1200); snap('m-status-2'); await key('KEYCODE_BACK', 1500);
await top(); await D(450, 649, 2500); snap('m-profile'); await S(450, 1500, 450, 600, 800, 1300); snap('m-profile-2'); await S(450, 1500, 450, 600, 800, 1300); snap('m-profile-3'); await key('KEYCODE_BACK', 1500);
await top(); await S(450, 1500, 450, 500, 800, 1500); await D(450, 1039, 2500); snap('m-notif'); await S(450, 1500, 450, 800, 700, 1300); snap('m-notif-2'); await key('KEYCODE_BACK', 1500);
