'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { rateLimit } = require('../middleware/rateLimit');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

test.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('federation inbox is rate-limited past a small burst', async () => {
  const app = express();
  app.use(express.json());
  app.use('/federation/api/inbox', rateLimit({ windowMs: 60_000, max: 3 }));
  app.post('/federation/api/inbox', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const results = [];
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${base}/federation/api/inbox`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    results.push(res.status);
  }
  assert.ok(results.includes(429));
  server.close();
});
