// adb helpers for the Android tour: tap elements by their visible text via a uiautomator dump.
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { sleep } from './lib.mjs';

export const ADB = 'E:/android-tools/sdk/platform-tools/adb.exe';
export const adb = (...args) => spawnSync(ADB, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
export const sh = (cmd) => adb('shell', cmd).stdout;

export function dump() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/u.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/u.xml').stdout;
  const nodes = [];
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const n = m[0];
    const get = (k) => (n.match(new RegExp(` ${k}="([^"]*)"`)) || [])[1] || '';
    const b = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    nodes.push({ text: get('text'), desc: get('content-desc'), id: get('resource-id'), x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] });
  }
  return nodes;
}

export function find(nodes, label, { nth = 0, exact = false } = {}) {
  const hit = nodes.filter((n) => {
    const t = `${n.text}|${n.desc}`;
    return exact ? n.text === label || n.desc === label : t.toLowerCase().includes(label.toLowerCase());
  });
  return hit[nth < 0 ? hit.length + nth : nth];
}

export const tapXY = async (x, y, pause = 1200) => { sh(`input tap ${Math.round(x)} ${Math.round(y)}`); await sleep(pause); };

export async function tapText(label, opts = {}) {
  const pause = opts.pause ?? 1400;
  for (let i = 0; i < 6; i++) {
    const n = find(dump(), label, opts);
    if (n) { await tapXY((n.x1 + n.x2) / 2, (n.y1 + n.y2) / 2, pause); return n; }
    await sleep(700);
  }
  throw new Error(`no element "${label}"`);
}

export async function typeText(s, pause = 800) {
  sh(`input text '${s.replace(/ /g, '%s').replace(/'/g, '')}'`);
  await sleep(pause);
}

export async function swipe(x1, y1, x2, y2, ms = 450, pause = 1000) { sh(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`); await sleep(pause); }
export const key = async (k, pause = 800) => { sh(`input keyevent ${k}`); await sleep(pause); };
export const shot = (path) => fs.writeFileSync(path, spawnSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 }).stdout);

// screenrecord is capped at 180 s per file, so a recording is a list of segments.
export function startRecord(name) {
  const p = spawn(ADB, ['shell', 'screenrecord', '--size', '720x1600', '--bit-rate', '6000000', '--time-limit', '175', `/sdcard/${name}.mp4`], { stdio: 'ignore' });
  return async () => { adb('shell', 'pkill', '-2', 'screenrecord'); await sleep(2500); p.kill(); };
}
export const pull = (name, dest) => adb('pull', `/sdcard/${name}.mp4`, dest);
