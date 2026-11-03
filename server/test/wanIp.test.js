'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismesh-test-'));
process.env.DISMESH_DATA_DIR = tmpDir;

const config = require('../lib/config');
const wanIp = require('../lib/turn/wanIp');
const manager = require('../lib/turn/manager');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

test('http source takes the first public IPv4 and skips private ones', async () => {
  const { s, url } = await serve((req, res) => res.end('<p>LAN 192.168.1.1 gateway 10.0.0.1 WAN 203.0.113.7 dns 8.8.8.8</p>'));
  assert.equal(await wanIp.httpExternalIp(url), '203.0.113.7');
  s.close();
});

test('http source fails clearly on a reply without a public address or a bad status', async () => {
  const { s, url } = await serve((req, res) => { if (req.url === '/bad') { res.statusCode = 500; res.end('x'); } else res.end('only 192.168.0.9'); });
  await assert.rejects(wanIp.httpExternalIp(url), /no public IPv4/);
  await assert.rejects(wanIp.httpExternalIp(`${url}/bad`), /HTTP 500/);
  s.close();
});

test('UPnP: reads the external address from the router\'s WAN service', async () => {
  let soapAction = '';
  const { s, url } = await serve((req, res) => {
    if (req.method === 'GET') {
      res.end(`<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></root>`);
    } else {
      soapAction = req.headers.soapaction;
      res.end('<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>198.51.100.23</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>');
    }
  });
  assert.equal(await wanIp.igdExternalIp(`${url}/rootDesc.xml`), '198.51.100.23');
  assert.match(soapAction, /WANIPConnection:1#GetExternalIPAddress/);
  s.close();
});

test('detectWanIp refuses private/CGNAT results and unknown sources', async () => {
  const { s, url } = await serve((req, res) => res.end('100.64.3.4'));
  await assert.rejects(wanIp.detectWanIp({ autoIpSource: 'http', autoIpUrl: url }), /no public IPv4/);
  s.close();
  await assert.rejects(wanIp.detectWanIp({ autoIpSource: 'nope' }), /unknown source/);
  await assert.rejects(wanIp.detectWanIp({ autoIpSource: 'stun', autoIpStun: '' }), /host or host:port/);
});

test('checkWanIp keeps the old address as previousIp, changes only on difference', async () => {
  config.save({ turn: { enabled: false, externalIp: '198.51.100.1', autoIp: true } });
  const same = await manager.checkWanIp({ detect: async () => '198.51.100.1' });
  assert.equal(same.changed, false);
  assert.equal(config.load().turn.previousIp, '');

  const changed = await manager.checkWanIp({ detect: async () => '203.0.113.50' });
  assert.equal(changed.changed, true);
  const t = config.load().turn;
  assert.equal(t.externalIp, '203.0.113.50');
  assert.equal(t.previousIp, '198.51.100.1');
  assert.ok(t.ipChangedAt);
  assert.equal(manager.status().autoIp.error, null);
});

test('checkWanIp leaves the stored address alone when detection fails', async () => {
  const r = await manager.checkWanIp({ detect: async () => { throw new Error('router silent'); } });
  assert.equal(r.error, 'router silent');
  assert.equal(config.load().turn.externalIp, '203.0.113.50');
  assert.equal(manager.status().autoIp.error, 'router silent');
});

test('a change while the built-in server runs restarts it on the new address', async () => {
  config.save({ turn: { enabled: true, port: 0, listenAddress: '127.0.0.1', relayPortMin: 53300, relayPortMax: 53400, externalIp: '203.0.113.50' } });
  await manager.start();
  assert.equal(manager.status().running, true);
  const r = await manager.checkWanIp({ detect: async () => '198.51.100.77' });
  assert.equal(r.changed, true);
  assert.equal(manager.status().running, true);
  assert.equal(manager.iceServersFor({ id: 1 }, 'x').iceServers.some((i) => i.urls.some((u) => u.includes('198.51.100.77'))), true);
  await manager.stop();
});
