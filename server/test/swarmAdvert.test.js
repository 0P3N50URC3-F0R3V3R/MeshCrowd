'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-advert-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const advert = require('../lib/swarmAdvert');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const fields = { url: 'https://chat.example.com:8443', name: 'Home', description: 'Our place', icon: null, registration: 'open', updated: 1700000000000 };
const swap = (str, from, to) => {
  const [p, s] = str.split('.');
  const json = Buffer.from(p, 'base64url').toString('utf8').replace(from, to);
  return `${Buffer.from(json).toString('base64url')}.${s}`;
};

test('the key is created once and reused', () => {
  const a = advert.loadOrCreateKey().publicKey;
  assert.equal(advert.loadOrCreateKey().publicKey, a);
  assert.ok(fs.existsSync(path.join(tmpDir, 'instance-key.json')));
});

test('build and verify round-trip', () => {
  const r = advert.verify(advert.build(fields));
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.advert, pub: undefined, v: undefined }, { ...fields, pub: undefined, v: undefined });
  assert.equal(r.advert.pub, advert.loadOrCreateKey().publicKey);
});

test('tampering, a swapped key, bad shapes and oversize are all refused', () => {
  const good = advert.build(fields);
  assert.equal(advert.verify(swap(good, '"Home"', '"Evil"')).ok, false);
  const other = require('node:crypto').generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  assert.equal(advert.verify(swap(good, advert.loadOrCreateKey().publicKey, other)).ok, false);
  assert.equal(advert.verify(advert.build({ ...fields, url: 'http://x.example.com' })).ok, false);
  assert.equal(advert.verify(advert.build({ ...fields, registration: 'maybe' })).ok, false);
  assert.equal(advert.verify(advert.build({ ...fields, description: 'x'.repeat(40000) })).ok, false);
  assert.equal(advert.verify('nonsense').ok, false);
  assert.equal(advert.verify(42).ok, false);
});

function custom(fields) {
  const key = advert.loadOrCreateKey();
  const payload = Buffer.from(JSON.stringify({ v: 1, url: 'https://a.example.com', name: 'A', description: '', icon: null, registration: 'open', updated: 1, pub: key.publicKey, ...fields }));
  return `${payload.toString('base64url')}.${key.sign(payload).toString('base64url')}`;
}

test('only the known fields survive; a __proto__ or extra key is dropped', () => {
  const r = advert.verify(custom({ extra: 'x'.repeat(1000), nested: { a: 1 } }).replace(/^/, ''));
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.advert).sort(), ['description', 'icon', 'name', 'pub', 'registration', 'updated', 'url']);
  const proto = Buffer.from('{"v":1,"url":"https://a.example.com","name":"A","description":"","icon":null,"registration":"open","updated":1,"pub":"' + advert.loadOrCreateKey().publicKey + '","__proto__":{"polluted":true}}');
  const str = `${proto.toString('base64url')}.${advert.loadOrCreateKey().sign(proto).toString('base64url')}`;
  const p = advert.verify(str);
  assert.equal(p.ok, true);
  assert.equal(Object.keys(p.advert).includes('__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('the url must be a string, and control or bidi characters in text are refused', () => {
  assert.equal(advert.verify(custom({ url: ['https://a.example.com'] })).ok, false);
  assert.equal(advert.verify(custom({ name: 'a‮b' })).ok, false);
  assert.equal(advert.verify(custom({ description: 'line\nbreak' })).ok, false);
  assert.equal(advert.verify(custom({ name: 'a\u0007b' })).ok, false);
});
