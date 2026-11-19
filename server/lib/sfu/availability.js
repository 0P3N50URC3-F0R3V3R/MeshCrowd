'use strict';

const fs = require('node:fs');
const path = require('node:path');

function probe({ root } = {}) {
  try {
    const base = root || __dirname;
    let pkgDir = path.dirname(require.resolve('mediasoup', { paths: [base] }));
    while (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
      const up = path.dirname(pkgDir);
      if (up === pkgDir) throw new Error('mediasoup package root not found');
      pkgDir = up;
    }
    const pkgPath = path.join(pkgDir, 'package.json');
    const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    const bin = process.platform === 'win32' ? 'mediasoup-worker.exe' : 'mediasoup-worker';
    const workerPath = path.join(pkgDir, 'worker', 'out', 'Release', bin);
    if (!fs.existsSync(workerPath)) return { ok: false, reason: `mediasoup worker binary missing: ${workerPath}` };
    return { ok: true, version, workerPath };
  } catch (e) {
    return { ok: false, reason: `mediasoup not available: ${e.message}` };
  }
}

module.exports = { probe };
