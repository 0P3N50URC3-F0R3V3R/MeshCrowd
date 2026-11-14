// Real-DOM tests for the checklist form (web/js/checklist.js): the module is loaded unchanged in
// headless Chrome from a throwaway static server, with /api/checklists mocked at the network layer.
// Skipped when no Chrome is available (e.g. CI without the portable build or a Playwright browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const webDir = path.resolve(import.meta.dirname, '..');
const portableChrome = path.resolve(import.meta.dirname, '../../ChromePortable/GoogleChromePortable/App/Chrome-bin/chrome.exe');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html' };

const FIXTURE = `<!doctype html><body><div id="host"></div><script type="module">
  import { openChecklistForm } from '/js/checklist.js';
  window.openChecklistForm = openChecklistForm;
  window.openPanel = ({ html, onMount }) => { const h = document.getElementById('host'); h.innerHTML = html; onMount(h, () => { window.__closed = true; }); };
</script></body>`;

let server; let browser; let page; let base;
const calls = [];
let skipReason = null;

test.before(async () => {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { skipReason = 'playwright not installed'; return; }
  try {
    browser = await chromium.launch(fs.existsSync(portableChrome) ? { executablePath: portableChrome } : {});
  } catch { skipReason = 'no Chrome available'; return; }
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/fixture.html') { res.setHeader('content-type', 'text/html'); return res.end(FIXTURE); }
    const file = path.join(webDir, path.normalize(url.pathname));
    if (!file.startsWith(webDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  page = await browser.newPage();
  await page.route('**/api/checklists**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    calls.push(`${req.method()} ${u.pathname}`);
    // POST .../items answers with the list as the server would, so the form can pick up the new item id.
    const items = u.pathname.endsWith('/items') && req.method() === 'POST' ? [{ id: 1 }, { id: 2 }, { id: 9 }] : [{ id: 1 }, { id: 2 }];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: { checklist: { items } } }) });
  });
  await page.goto(`${base}/fixture.html`);
  await page.waitForFunction(() => typeof window.openChecklistForm === 'function');
});

test.after(async () => {
  await browser?.close();
  server?.close();
});

test.beforeEach(async () => {
  calls.length = 0;
  if (page) await page.evaluate(() => { window.__closed = false; document.getElementById('host').innerHTML = ''; });
});

test('Notes form (local mode) opens with two empty rows when there are no items yet', async (t) => {
  if (skipReason) return t.skip(skipReason);
  await page.evaluate(() => window.openChecklistForm({ openPanel: window.openPanel, mode: 'local', items: [], onSave: () => {} }));
  assert.equal(await page.locator('#cl-rows input').count(), 2);
  assert.equal(await page.locator('#cl-title').count(), 0, 'no title field: the note text is the title');
  assert.equal(await page.locator('#cl-helpers').count(), 0, 'no helper picker for a single-owner note');
});

test('Notes form (local mode) keeps existing items and their checked state on save', async (t) => {
  if (skipReason) return t.skip(skipReason);
  await page.evaluate(() => {
    window.__saved = null;
    window.openChecklistForm({ openPanel: window.openPanel, mode: 'local', items: [{ id: 'a', text: 'one', checked: true }, { id: 'b', text: 'two', checked: false }], onSave: (items) => { window.__saved = items; } });
  });
  assert.equal(await page.locator('#cl-rows input').count(), 2);
  await page.click('#cl-save');
  assert.deepEqual(await page.evaluate(() => window.__saved), [{ id: 'a', text: 'one', checked: true }, { id: 'b', text: 'two', checked: false }]);
});

test('edit mode saves through the API even when the host passes no onDone callback (phone sheet)', async (t) => {
  if (skipReason) return t.skip(skipReason);
  await page.evaluate(() => window.openChecklistForm({
    openPanel: window.openPanel, mode: 'edit', meId: 5,
    message: { content: 'Shopping', checklist: { id: 1, creatorId: 5, editors: [], items: [{ id: 1, label: 'milk', checked: false }, { id: 2, label: 'eggs', checked: false }] } },
  }));
  await page.locator('#cl-rows input').nth(1).fill('free-range eggs');
  await page.click('#cl-add');
  await page.locator('#cl-rows input').nth(2).fill('bread');
  await page.click('#cl-save');
  await page.waitForFunction(() => window.__closed === true);
  assert.ok(calls.includes('POST /api/checklists/1/items'), calls.join(' | '));
  assert.ok(calls.includes('PATCH /api/checklists/1/items/2'), calls.join(' | '));
  assert.ok(calls.includes('PUT /api/checklists/1/order'), calls.join(' | '));
  assert.ok(!calls.includes('PATCH /api/checklists/1'), 'unchanged title is not re-sent');
});
