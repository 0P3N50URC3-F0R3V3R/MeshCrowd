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

test('icon: only a real PNG up to 16384 bytes and 128x128 is accepted', () => {
  assert.throws(() => profile.setIcon(png(64, 64, 16385)), { status: 413 });
  assert.throws(() => profile.setIcon(png(129, 128)), { status: 400 });
  assert.throws(() => profile.setIcon(png(128, 129)), { status: 400 });
  assert.throws(() => profile.setIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), { status: 400 });
  assert.throws(() => profile.setIcon(png(64, 64).subarray(0, 14)), { status: 400 });
  assert.equal(profile.get().hasIcon, false);
  profile.setIcon(png(64, 64, 2000));
  assert.equal(profile.get().hasIcon, true);
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
