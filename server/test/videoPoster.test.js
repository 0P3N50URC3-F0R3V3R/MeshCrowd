const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');
const { posterMiddleware } = require('../lib/videoPoster');

let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('poster middleware', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-'));
  fs.mkdirSync(path.join(root, 'channel-1'));
  fs.mkdirSync(path.join(root, 'dm-1'));
  fs.writeFileSync(path.join(root, 'channel-1', 'x.txt'), 'hi');
  fs.writeFileSync(path.join(root, 'dm-1', 'v.mp4'), 'x');
  if (hasFfmpeg) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=5:duration=1', '-pix_fmt', 'yuv420p', path.join(root, 'channel-1', 'v.mp4')]);
  }
  const app = express();
  app.use('/uploads/attachments', posterMiddleware(root));
  app.use((req, res) => res.sendStatus(418));
  const srv = app.listen(0);
  const port = srv.address().port;
  t.after(() => { srv.close(); fs.rmSync(root, { recursive: true, force: true }); });

  assert.strictEqual((await get(port, '/uploads/attachments/channel-1/x.txt.poster.jpg')).status, 418);
  assert.strictEqual((await get(port, '/uploads/attachments/dm-1/v.mp4.poster.jpg')).status, 418);
  assert.strictEqual((await get(port, '/uploads/attachments/channel-1/..%2F..%2Fx.mp4.poster.jpg')).status, 418);
  if (hasFfmpeg) {
    const r = await get(port, '/uploads/attachments/channel-1/v.mp4.poster.jpg');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.type, 'image/jpeg');
    assert.strictEqual(r.body[0], 0xff);
  }
  assert.strictEqual((await get(port, '/uploads/attachments/channel-1/gone.mp4.poster.jpg')).status, 404);
});
