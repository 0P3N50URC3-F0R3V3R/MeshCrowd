'use strict';

// Downloads a static ffmpeg (Windows x64, gyan.dev release essentials) into runtime/ffmpeg/. Run once on
// the build machine: `npm run fetch:ffmpeg`. build-portable.js copies runtime/ wholesale, so the result
// ships with the portable build. Used for first-frame video posters (server/lib/videoPoster.js).

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const OUT = path.join(__dirname, '..', 'runtime', 'ffmpeg');
const ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const SHA_URL = `${ZIP_URL}.sha256`;

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'meshcrowd-fetch-ffmpeg' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(get(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} -> HTTP ${res.statusCode}`)); }
      resolve(res);
    }).on('error', reject);
  });
}

async function fetchText(url) {
  const res = await get(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function download(url, dest) {
  const res = await get(url);
  await new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    res.pipe(f);
    f.on('finish', resolve);
    f.on('error', reject);
    res.on('error', reject);
  });
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function ps(command, env) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`powershell failed (${r.status}): ${command}`);
}

const EXTRACT = [
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  '$z = [IO.Compression.ZipFile]::OpenRead($env:FF_ZIP)',
  'try {',
  '  foreach ($e in $z.Entries) {',
  "    $keep = $e.FullName.EndsWith('/bin/ffmpeg.exe') -or (($e.FullName -split '/').Count -eq 2 -and @('LICENSE', 'README.txt') -contains $e.Name)",
  '    if ($keep) { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $env:FF_OUT $e.Name), $true) }',
  '  }',
  '} finally { $z.Dispose() }',
].join(String.fromCharCode(10));

async function main() {
  if (process.platform !== 'win32') {
    console.log('[fetch-ffmpeg] The bundled ffmpeg is Windows-only. On this OS install ffmpeg with your package manager.');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });

  const expected = (await fetchText(SHA_URL)).trim().split(/\s+/)[0].toLowerCase();
  const zipPath = path.join(OUT, 'ffmpeg.zip');
  console.log('[fetch-ffmpeg] downloading ffmpeg release essentials');
  await download(ZIP_URL, zipPath);
  if (sha256(zipPath).toLowerCase() !== expected) {
    fs.rmSync(zipPath, { force: true });
    throw new Error('ffmpeg zip checksum mismatch; download discarded');
  }
  ps(EXTRACT, { FF_ZIP: zipPath, FF_OUT: OUT });
  fs.rmSync(zipPath, { force: true });

  const exe = path.join(OUT, 'ffmpeg.exe');
  const r = spawnSync(exe, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('extracted ffmpeg.exe does not run');
  const version = (r.stdout.split('\n')[0] || '').trim();
  fs.writeFileSync(path.join(OUT, 'VERSION.txt'), `${version}\n`);
  console.log(`[fetch-ffmpeg] done: ${exe} (${version})`);
}

main().catch((err) => { console.error('[fetch-ffmpeg] failed:', err.message); process.exit(1); });
