'use strict';

// Ensures the prebuilt mediasoup worker for this platform is present in node_modules. Run on the build
// machine before `npm run build:portable`: `npm run fetch:mediasoup`. The server never downloads anything itself.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { probe } = require('../server/lib/sfu/availability');

const ROOT = path.join(__dirname, '..');

let r = probe({ root: ROOT });
if (!r.ok) {
  console.log('[fetch-mediasoup]', r.reason, '- running mediasoup postinstall');
  const script = path.join(ROOT, 'node_modules', 'mediasoup', 'npm-scripts.mjs');
  const s = spawnSync(process.execPath, [script, 'postinstall'], { cwd: path.join(ROOT, 'node_modules', 'mediasoup'), stdio: 'inherit' });
  if (s.error) console.error('[fetch-mediasoup]', s.error.message);
  r = probe({ root: ROOT });
}
if (!r.ok) {
  console.error('[fetch-mediasoup] FAILED:', r.reason);
  process.exit(1);
}
console.log(`[fetch-mediasoup] mediasoup ${r.version} worker ready: ${r.workerPath}`);
