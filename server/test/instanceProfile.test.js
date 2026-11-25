'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-instance-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const config = require('../lib/config');
const profile = require('../lib/instanceProfile');
const { makePng, noise } = require('./pngFixture');
const { decode } = require('../lib/pngResize');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function png(w, h, size = 0) {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  return size > head.length ? Buffer.concat([head, Buffer.alloc(size - head.length)]) : head;
}

test('name and description are single-line, trimmed and clamped', () => {
  const out = profile.update({ name: `  My\nHome ${'x'.repeat(100)}`, description: `a\r\nb ${'y'.repeat(400)}` });
  assert.ok(!out.name.includes('\n'));
  assert.equal(out.name.length, 60);
  assert.ok(!out.description.includes('\n'));
  assert.equal(out.description.length, 300);
  assert.equal(config.load().instance.name, out.name);
  assert.throws(() => profile.update({ name: 5 }), { status: 400 });
});

test('icon: any PNG is re-encoded to at most 128x128 and 16 KB; anything else is refused', () => {
  assert.throws(() => profile.setIcon(Buffer.alloc(1024 * 1024 + 1)), { status: 413 });
  assert.throws(() => profile.setIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), { status: 400 });
  assert.throws(() => profile.setIcon(makePng(64, 64).subarray(0, 40)), { status: 400 });
  assert.throws(() => profile.setIcon(makePng(10, 10, { interlace: 1 })), { status: 400 });
  assert.equal(profile.get().hasIcon, false);
  profile.setIcon(makePng(500, 300, { pixel: noise }));
  assert.equal(profile.get().hasIcon, true);
  const stored = fs.readFileSync(profile.iconFile().file);
  assert.ok(stored.length <= 16384, String(stored.length));
  const img = decode(stored);
  assert.ok(img.width <= 128 && img.height <= 128);
  assert.match(profile.iconDataUri(), /^data:image\/png;base64,/);
  assert.equal(profile.iconFile().mime, 'image/png');
  profile.clearIcon();
  assert.equal(profile.get().hasIcon, false);
  assert.equal(profile.iconDataUri(), null);
  assert.equal(fs.existsSync(path.join(tmpDir, 'instance', 'icon.png')), false);
});

test('logo: image types only, up to 1 MB, replacing removes the old file', () => {
  assert.throws(() => profile.setLogo(Buffer.from('<svg/>'), 'image/svg+xml'), { status: 400 });
  assert.throws(() => profile.setLogo(Buffer.alloc(1024 * 1024 + 1), 'image/png'), { status: 413 });
  profile.setLogo(png(300, 100, 500), 'image/png');
  assert.equal(profile.logoFile().mime, 'image/png');
  const first = profile.logoFile().file;
  assert.throws(() => profile.setLogo(Buffer.from('<html></html>'), 'image/png'), { status: 400 });
  profile.setLogo(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]), 'image/jpeg');
  assert.equal(fs.existsSync(first), false);
  assert.equal(profile.logoFile().mime, 'image/jpeg');
  profile.clearLogo();
  assert.equal(profile.get().hasLogo, false);
  assert.equal(profile.logoFile(), null);
});

test('a hand-edited config cannot point the logo or icon outside the instance files', () => {
  profile.setIcon(makePng(64, 64));
  profile.setLogo(png(300, 100, 500), 'image/png');
  for (const bad of ['..', '.', '../config.json', 'sub/icon.png', 'other.png', '']) {
    config.save({ instance: { iconPath: bad } });
    assert.equal(profile.iconFile(), null, `icon ${bad}`);
    assert.equal(profile.iconDataUri(), null);
    config.save({ instance: { logoPath: bad } });
    assert.equal(profile.logoFile(), null, `logo ${bad}`);
  }
  config.save({ instance: { iconPath: 'logo.png' } });
  assert.equal(profile.iconFile(), null);
  config.save({ instance: { iconPath: 'icon.png', logoPath: 'logo.png' } });
  assert.ok(profile.iconFile());
  assert.ok(profile.logoFile());
  config.save({ instance: { name: `  ${'x'.repeat(200)}\ny`, description: 'a\r\nb' } });
  const got = profile.get();
  assert.equal(got.name.length, 60);
  assert.ok(!got.description.includes('\n'));
});
