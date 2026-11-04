'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cand = (ip, type = 'host') => ({ candidate: `candidate:1 1 udp 2122260223 ${ip} 50000 typ ${type}`, address: ip });

test('inCidr and private detection', async () => {
  const u = await import('../../web/js/iceUtil.js');
  assert.equal(u.inCidr('26.1.2.3', '26.0.0.0/8'), true);
  assert.equal(u.inCidr('192.168.4.9', '192.168.3.0/24'), false);
  assert.equal(u.inCidr('1.2.3.4', '0.0.0.0/0'), true);
  assert.equal(u.isPrivateIPv4('172.20.0.5'), true);
  assert.equal(u.isPrivateIPv4('172.32.0.5'), false);
  assert.equal(u.isPrivateIPv4('8.8.8.8'), false);
});

test('shouldAcceptRemoteCandidate: zero-config keeps everything but link-local', async () => {
  const u = await import('../../web/js/iceUtil.js');
  assert.equal(u.shouldAcceptRemoteCandidate(cand('192.168.1.5')), true);
  assert.equal(u.shouldAcceptRemoteCandidate(cand('169.254.3.3')), false);
  assert.equal(u.shouldAcceptRemoteCandidate({ candidate: 'candidate:1 1 udp 1 abc.local 5 typ host' }), true);
});

test('shouldAcceptRemoteCandidate: lanNetworks drops stray private hosts only', async () => {
  const u = await import('../../web/js/iceUtil.js');
  const lan = ['26.0.0.0/8', '192.168.3.0/24'];
  assert.equal(u.shouldAcceptRemoteCandidate(cand('26.4.4.4'), lan), true);
  assert.equal(u.shouldAcceptRemoteCandidate(cand('192.168.3.20'), lan), true);
  assert.equal(u.shouldAcceptRemoteCandidate(cand('172.17.0.2'), lan), false);
  assert.equal(u.shouldAcceptRemoteCandidate(cand('203.0.113.9'), lan), true);
  assert.equal(u.shouldAcceptRemoteCandidate(cand('172.17.0.2', 'srflx'), lan), true);
  assert.equal(u.shouldAcceptRemoteCandidate(cand('172.17.0.2', 'relay'), lan), true);
});

test('connectionPath classifies the selected pair', async () => {
  const u = await import('../../web/js/iceUtil.js');
  const mk = (l, r) => new Map([
    ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }],
    ['p', { id: 'p', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' }],
    ['l', { id: 'l', type: 'local-candidate', candidateType: l }],
    ['r', { id: 'r', type: 'remote-candidate', candidateType: r }],
  ]);
  assert.equal(u.connectionPath(mk('host', 'host')), 'direct');
  assert.equal(u.connectionPath(mk('srflx', 'host')), 'stun');
  assert.equal(u.connectionPath(mk('host', 'relay')), 'relay');
  const prflx = (addr) => { const m = mk('host', 'prflx'); m.get('r').address = addr; return m; };
  assert.equal(u.connectionPath(prflx('192.168.1.7')), 'direct');
  assert.equal(u.connectionPath(prflx('203.0.113.7')), 'stun');
  const srflx = (addr) => { const m = mk('host', 'srflx'); m.get('r').address = addr; return m; };
  assert.equal(u.connectionPath(srflx('192.168.1.44')), 'direct');
  assert.equal(u.connectionPath(srflx('127.0.0.1')), 'direct');
  assert.equal(u.connectionPath(srflx('198.51.100.9')), 'stun');
  assert.equal(u.connectionPath(prflx('')), 'direct');
  assert.equal(u.connectionPath(new Map()), null);
});

test('lanNetworks config validates CIDRs', () => {
  const schema = require('../lib/configSchema');
  assert.deepEqual(schema.coerce('lanNetworks', '["26.0.0.0/8","192.168.3.0/24"]'), ['26.0.0.0/8', '192.168.3.0/24']);
  for (const bad of ['["nope"]', '["1.2.3.4"]', '["300.1.1.1/8"]', '["1.2.3.4/33"]', '[5]', '{}']) {
    assert.throws(() => schema.coerce('lanNetworks', bad), undefined, bad);
  }
});
