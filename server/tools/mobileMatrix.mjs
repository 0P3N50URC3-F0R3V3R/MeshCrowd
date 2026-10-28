import { launch, register, apiCall, sendMsg } from './mobileLive.mjs';

const SIZES = [
  [320, 568], [360, 640], [360, 800], [390, 844], [412, 915], [600, 960], [768, 1024],
].flatMap(([w, h]) => [[w, h], [h, w]]); // every size in portrait AND landscape
const shots = process.argv[2] || '.';
const LONG_WORD = 'x'.repeat(120);
const failures = [];

async function overflowReport(page, label) {
  const bad = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
    for (const el of document.querySelectorAll('.m-screen:not([hidden]) *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('.m-tabs, .m-media-grid')) { out.push(`${el.className || el.tagName} right=${Math.round(r.right)} > ${vw}`); break; }
    }
    return out;
  });
  if (bad.length) failures.push(`${label}: ${bad.join('; ')}`);
}

const { browser, page } = await launch(`${SIZES[0][0]}x${SIZES[0][1]}`);
await register(page, `mx${Date.now() % 100000}`);
const { server } = await apiCall(page, 'POST', '/api/servers', { name: `A very long server name ${LONG_WORD}` });
const detail = await apiCall(page, 'GET', `/api/servers/${server.id}`);
const ch = detail.channels[0];
await apiCall(page, 'PATCH', `/api/servers/${server.id}/channels/${ch.id}`, { name: 'long-channel-name-for-the-matrix-test' });
await sendMsg(page, server.id, ch.id, `unbroken word ${LONG_WORD}`);
await sendMsg(page, server.id, ch.id, 'a normal sentence '.repeat(30));
await sendMsg(page, server.id, ch.id, `https://example.com/a/very/long/link/${'path/'.repeat(30)}`);
await apiCall(page, 'POST', '/api/polls', { scopeType: 'channel', scopeId: ch.id, question: 'Pick one', options: ['Option A '.repeat(8), 'B'], multiSelect: false });
await page.reload();
await page.waitForSelector('#m-tabbar');

for (const [w, h] of SIZES) {
  for (const fontScale of [100, 200]) {
    await page.setViewportSize({ width: w, height: h });
    await page.addStyleTag({ content: `html{font-size:${fontScale}% !important}` });
    const tag = `${w}x${h}@${fontScale}`;
    for (const tab of ['servers', 'messages', 'notifications', 'you']) {
      await page.click(`[data-tab="${tab}"]`);
      await page.waitForTimeout(120);
      await overflowReport(page, `${tag} tab:${tab}`);
    }
    await page.click('[data-tab="servers"]');
    await page.waitForSelector('.m-chan');
    await page.click('.m-chan');
    await page.waitForSelector('.m-msg');
    await overflowReport(page, `${tag} chat`);
    if (fontScale === 100) await page.screenshot({ path: `${shots}/matrix-${w}x${h}-chat.png` });
    await page.goBack();
    await page.waitForSelector('[data-tab="servers"]');
  }
}

// rotation keeps the draft
await page.setViewportSize({ width: 390, height: 844 });
await page.click('[data-tab="servers"]');
await page.click('.m-chan');
await page.waitForSelector('.m-screen:not([hidden]) #c-input');
await page.fill('.m-screen:not([hidden]) #c-input', 'draft survives rotation');
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(300);
const draft = await page.inputValue('.m-screen:not([hidden]) #c-input');
if (draft !== 'draft survives rotation') failures.push('rotation lost the composer draft');

await browser.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`matrix ok: ${SIZES.length} sizes x 2 font scales`);
