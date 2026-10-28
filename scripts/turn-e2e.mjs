// End-to-end proof that calls work through the built-in TURN server: boots a throwaway MeshCrowd
// server with TURN on, then makes two browser peer connections that are FORCED to relay
// (iceTransportPolicy 'relay') and checks that a data channel opens and carries data.
// Usage: node scripts/turn-e2e.mjs [--tcp]   (--tcp offers only the TCP TURN url)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(root, 'node_modules/playwright'));
const CHROME = path.join(root, 'ChromePortable/GoogleChromePortable/App/Chrome-bin/chrome.exe');

const TCP_ONLY = process.argv.includes('--tcp');
const HTTP = 18123;
const TURN_PORT = 13478;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-turn-e2e-'));
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  useHttps: false, port: HTTP,
  turn: { enabled: true, port: TURN_PORT, listenAddress: '127.0.0.1', allowPrivatePeers: true, relayPortMin: 54000, relayPortMax: 54100 },
}));
const server = spawn('node', [path.join(root, 'server/index.js')], { env: { ...process.env, DISMESH_DATA_DIR: data }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${HTTP}/api/config`)).ok) break; } catch { /* booting */ } await sleep(250); }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`http://localhost:${HTTP}/`);
  const result = await page.evaluate(async (tcpOnly) => {
    const reg = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'turnuser', password: 'turnpass123', email: 'turn@example.com' }) });
    if (!reg.ok) return { error: `register ${reg.status}` };
    const ice = await (await fetch('/api/voice/ice')).json();
    const servers = tcpOnly ? ice.iceServers.map((x) => ({ ...x, urls: x.urls.filter((u) => u.startsWith('turn:') && u.endsWith('tcp')) })).filter((x) => x.urls.length) : ice.iceServers;
    const cfg = { iceServers: servers, iceTransportPolicy: 'relay' };
    const a = new RTCPeerConnection(cfg); const b = new RTCPeerConnection(cfg);
    const kinds = new Set();
    for (const pc of [a, b]) pc.onicecandidate = (e) => { if (e.candidate) { kinds.add(e.candidate.type); (pc === a ? b : a).addIceCandidate(e.candidate); } };
    const got = new Promise((resolve) => { b.ondatachannel = (e) => { e.channel.onmessage = (m) => resolve(m.data); }; });
    const dc = a.createDataChannel('t');
    dc.onopen = () => dc.send('relayed hello');
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    const msg = await Promise.race([got, new Promise((r) => setTimeout(() => r('TIMEOUT'), 15000))]);
    return { builtIn: ice.builtIn, urls: ice.iceServers.map((s) => s.urls), kinds: [...kinds], msg };
  }, TCP_ONLY);
  console.log(JSON.stringify(result));
  failed = !(result.msg === 'relayed hello' && result.kinds.length === 1 && result.kinds[0] === 'relay');
  await browser.close();
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  server.kill();
}
console.log(failed ? 'FAIL' : 'PASS: browser peers connected through the built-in TURN relay');
process.exit(failed ? 1 : 0);
