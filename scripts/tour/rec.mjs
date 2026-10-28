// Recording helpers: a headed Chrome with video capture, a visible fake cursor (video capture
// never includes the real one) and human-paced pointer/typing helpers.
import { createRequire } from 'node:module';
import path from 'node:path';
import { sleep } from './lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('../../node_modules/playwright');

export const CHROME = path.resolve(import.meta.dirname, '../../ChromePortable/GoogleChromePortable/App/Chrome-bin/chrome.exe');
const MEDIA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];

const CURSOR_JS = `
(() => {
  if (window.__cur) return;
  const mk = () => {
    if (!document.body) return requestAnimationFrame(mk);
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:transform 0.04s linear';
    d.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #14b8a6;z-index:2147483646;pointer-events:none;opacity:0;transform:scale(0.3)';
    document.body.append(r, d);
    window.__cur = d;
    addEventListener('mousemove', (e) => { d.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
    addEventListener('mousedown', (e) => {
      r.style.transition = 'none'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; r.style.opacity = '0.9'; r.style.transform = 'scale(0.3)';
      requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transition = 'all 0.45s ease-out'; r.style.opacity = '0'; r.style.transform = 'scale(1.3)'; }));
    }, true);
  };
  mk();
})();`;

export async function launch({ width, height, videoDir, mobile = false, headless = false, lang = 'en', video = true }) {
  const browser = await chromium.launch({ executablePath: CHROME, headless, args: MEDIA_ARGS });
  const ctx = await browser.newContext({
    viewport: { width, height },
    permissions: ['microphone', 'camera'],
    locale: lang === 'hu' ? 'hu-HU' : 'en-US',
    ...(video ? { recordVideo: { dir: videoDir, size: { width, height } } } : {}),
    ...(mobile ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
  });
  await ctx.addInitScript(CURSOR_JS);
  await ctx.addInitScript((l) => { try { localStorage.setItem('dismesh_lang', l); } catch { /* ignore */ } }, lang);
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

export class Actor {
  constructor(page) { this.page = page; this.x = 640; this.y = 360; }

  async moveTo(x, y, steps = 18) {
    await this.page.mouse.move(x, y, { steps });
    this.x = x; this.y = y;
  }

  async box(target) {
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const b = await loc.boundingBox();
    return { loc, b };
  }

  async hover(target, pause = 500) {
    const { b } = await this.box(target);
    await this.moveTo(b.x + b.width / 2, b.y + b.height / 2);
    await sleep(pause);
  }

  async click(target, pause = 900) {
    const { loc, b } = await this.box(target);
    await this.moveTo(b.x + b.width / 2, b.y + Math.min(b.height / 2, 24));
    await sleep(180);
    await loc.click({ position: { x: b.width / 2, y: Math.min(b.height / 2, 24) } });
    await sleep(pause);
  }

  async rightClick(target, pause = 900) {
    const { loc, b } = await this.box(target);
    await this.moveTo(b.x + b.width / 2, b.y + b.height / 2);
    await sleep(150);
    await loc.click({ button: 'right', position: { x: b.width / 2, y: b.height / 2 } });
    await sleep(pause);
  }

  async type(target, text, delay = 55) {
    await this.click(target, 250);
    await this.page.keyboard.type(text, { delay });
    await sleep(350);
  }

  async scroll(target, dy, steps = 12, pause = 1000) {
    const { b } = await this.box(target);
    await this.moveTo(b.x + b.width / 2, b.y + b.height / 2);
    for (let i = 0; i < steps; i++) { await this.page.mouse.wheel(0, dy / steps); await sleep(45); }
    await sleep(pause);
  }

  async drag(from, to, steps = 22) {
    await this.moveTo(from.x, from.y);
    await this.page.mouse.down();
    await this.page.mouse.move(to.x, to.y, { steps });
    await this.page.mouse.up();
    this.x = to.x; this.y = to.y;
    await sleep(500);
  }
}
