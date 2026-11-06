'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmp;
const fileSeal = require('../lib/fileSeal');

const collect = async (stream) => { const parts = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts); };

for (const size of [0, 1, 65535, 65536, 65537, 200000]) {
  test(`round trip and ranges for ${size} bytes`, async () => {
    const plain = crypto.randomBytes(size);
    const file = path.join(tmp, `f${size}.bin`);
    const written = await fileSeal.sealStreamTo(Readable.from([plain]), file);
    assert.equal(written, size);
    assert.ok(fileSeal.isSealedFile(file));
    assert.equal(fileSeal.plainSize(file), size);
    assert.ok(size < 16 || !fs.readFileSync(file).includes(plain.subarray(0, Math.min(32, size))));
    assert.deepEqual(fileSeal.readAll(file), plain);
    if (size > 10) {
      const start = Math.floor(size / 3);
      const end = Math.min(size - 1, start + 70000);
      assert.deepEqual(await collect(fileSeal.readSealedRange(file, start, end)), plain.subarray(start, end + 1));
    }
  });
}

test('a flipped byte is detected', async () => {
  const file = path.join(tmp, 'tamper.bin');
  await fileSeal.sealBufferTo(Buffer.from('hello world'), file);
  const raw = fs.readFileSync(file);
  raw[raw.length - 20] ^= 1;
  fs.writeFileSync(file, raw);
  assert.throws(() => fileSeal.readAll(file));
});

test('readAll passes legacy plain files through', () => {
  const file = path.join(tmp, 'plain.txt');
  fs.writeFileSync(file, 'plain');
  assert.equal(fileSeal.readAll(file).toString(), 'plain');
  assert.equal(fileSeal.isSealedFile(file), false);
});
