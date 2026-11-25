import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBrand, renderInstanceInfo, renderSwarmList } from './authInstance.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const t = (k, p) => (p ? `${k}|${p.n}` : k);
const MARK = '<svg class="mark"></svg>';

test('brand falls back to MeshCrowd and the default mark', () => {
  const out = renderBrand({ name: '', hasLogo: false }, esc, MARK);
  assert.match(out, />MeshCrowd</);
  assert.ok(out.includes(MARK));
  assert.ok(!out.includes('/instance/logo'));
});

test('brand shows the logo and the escaped instance name', () => {
  const out = renderBrand({ name: '<img onerror=x>', hasLogo: true }, esc, MARK);
  assert.ok(out.includes('/instance/logo'));
  assert.ok(!out.includes('<img onerror=x>'));
  assert.ok(out.includes('&lt;img onerror=x&gt;'));
  assert.ok(!out.includes(MARK));
});

test('without a logo the instance icon replaces the default mark', () => {
  const out = renderBrand({ name: 'X', hasLogo: false, hasIcon: true }, esc, MARK);
  assert.ok(out.includes('/instance/icon'));
  assert.ok(!out.includes(MARK));
  const both = renderBrand({ name: 'X', hasLogo: true, hasIcon: true }, esc, MARK);
  assert.ok(both.includes('/instance/logo') && !both.includes('/instance/icon'));
});

test('info shows the escaped description and a badge for each registration state', () => {
  const info = (reg) => renderInstanceInfo({ description: '<b>hi</b>' }, reg, t, esc);
  assert.ok(info('open').includes('&lt;b&gt;hi&lt;/b&gt;'));
  const badges = ['open', 'invite', 'closed'].map((r) => info(r));
  assert.equal(new Set(badges).size, 3);
  assert.equal(renderInstanceInfo({ description: '' }, 'open', t, esc).includes('auth-instance-desc'), false);
});

test('swarm list is empty when disabled or empty, and escapes every field', () => {
  const now = 10_000_000;
  assert.equal(renderSwarmList({ enabled: false, servers: [{}] }, t, esc, now), '');
  assert.equal(renderSwarmList({ enabled: true, servers: [] }, t, esc, now), '');
  assert.equal(renderSwarmList(null, t, esc, now), '');
  const out = renderSwarmList({ enabled: true, servers: [{ url: 'https://x.example.com:8443', name: '<script>', description: 'a"b', icon: 'data:image/png;base64,AAAA', registration: 'invite', lastSeen: now - 120_000, updated: now - 3 * 86_400_000 }] }, t, esc, now);
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('rel="noopener noreferrer"'));
  assert.ok(out.includes('class="swarm-scroll"'));
  assert.ok(out.includes('href="https://x.example.com:8443"'));
  assert.ok(out.includes('auth.swarmMinutes|2'));
  assert.ok(out.includes('auth.swarmDays|3'));
});

test('the server name link carries the address for the desktop client switch', () => {
  const out = renderSwarmList({ enabled: true, servers: [{ url: 'https://x.example.com:8443', name: 'X', description: '', icon: null, registration: 'open', lastSeen: 1, updated: 1 }] }, t, esc, 10);
  assert.ok(out.includes('data-switch="https://x.example.com:8443"'));
});

test('a non-https url from a tracker is never made a link', () => {
  const out = renderSwarmList({ enabled: true, servers: [{ url: 'javascript:alert(1)', name: 'Bad', description: '', icon: null, registration: 'open', lastSeen: 1, updated: 1 }] }, t, esc, 10);
  assert.equal(out, '');
});
