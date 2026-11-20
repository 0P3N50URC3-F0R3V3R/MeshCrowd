const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');
const { posterMiddleware } = require('../lib/videoPoster');

const BUNDLED = path.join(__dirname, '..', '..', 'runtime', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const FFMPEG = fs.existsSync(BUNDLED) ? BUNDLED : 'ffmpeg';
let hasFfmpeg = true;
try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }

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
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=5:duration=1', '-pix_fmt', 'yuv420p', path.join(root, 'channel-1', 'v.mp4')]);
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

test('a playlist or concat script disguised as an mp4 is not followed, a real mp4 still gets its poster', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not available');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-evil-'));
  fs.mkdirSync(path.join(root, 'channel-1'));
  const dir = path.join(root, 'channel-1');
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=5:duration=1', '-pix_fmt', 'yuv420p', path.join(dir, 'real.mp4')]);
  let fetched = 0;
  const bait = http.createServer((req, res) => { fetched++; res.end(); }).listen(0);
  const baitPort = bait.address().port;
  fs.writeFileSync(path.join(dir, 'concat.mp4'), `ffconcat version 1.0\nfile '${path.join(dir, 'real.mp4').replace(/\\/g, '/')}'\n`);
  fs.writeFileSync(path.join(dir, 'hls.mp4'), `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${baitPort}/seg.ts\n#EXT-X-ENDLIST\n`);
  fs.writeFileSync(path.join(dir, 'sdp.mp4'), `v=0\nm=video ${baitPort} RTP/AVP 96\nc=IN IP4 127.0.0.1\n`);
  const app = express();
  app.use('/uploads/attachments', posterMiddleware(root));
  app.use((req, res) => res.sendStatus(418));
  const srv = app.listen(0);
  t.after(() => { srv.close(); bait.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const port = srv.address().port;

  for (const name of ['concat', 'hls', 'sdp']) {
    assert.strictEqual((await get(port, `/uploads/attachments/channel-1/${name}.mp4.poster.jpg`)).status, 404, name);
    assert.ok(!fs.existsSync(path.join(dir, `${name}.mp4.poster.jpg`)), name);
  }
  assert.strictEqual(fetched, 0, 'ffmpeg must not fetch anything named in an uploaded file');
  const ok = await get(port, '/uploads/attachments/channel-1/real.mp4.poster.jpg');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body[0], 0xff);
});
