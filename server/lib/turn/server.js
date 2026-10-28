'use strict';

// A small STUN + TURN (UDP relay) server so calls work between people behind different routers
// without any third-party service. RFC 5389 STUN, RFC 5766 TURN (Allocate, Refresh,
// CreatePermission, ChannelBind, Send/Data, ChannelData), long-term credentials from the TURN REST
// scheme (see credentials.js). IPv4 only; clients reach it over UDP or TCP, the relay itself is UDP.

const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const stun = require('./stun');
const credentials = require('./credentials');

const { ATTR, METHOD, CLASS, ERR } = stun;

const NONCE_TTL_MS = 10 * 60 * 1000;
const PERMISSION_MS = 5 * 60 * 1000;
const CHANNEL_MS = 10 * 60 * 1000;
const UNAUTH_PER_SECOND = 30;

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}
const inRange = (n, base, bits) => (bits === 0 ? true : (n >>> (32 - bits)) === (ipToInt(base) >>> (32 - bits)));

// Addresses a relay must never talk to unless the operator allows private peers: the server's own
// LAN, loopback, link-local and CGNAT. Multicast and reserved space are always refused.
function isPrivate(ip) {
  const n = ipToInt(ip);
  return inRange(n, '10.0.0.0', 8) || inRange(n, '172.16.0.0', 12) || inRange(n, '192.168.0.0', 16)
    || inRange(n, '127.0.0.0', 8) || inRange(n, '169.254.0.0', 16) || inRange(n, '100.64.0.0', 10);
}
const isNeverAllowed = (ip) => { const n = ipToInt(ip); return inRange(n, '0.0.0.0', 8) || n >= ipToInt('224.0.0.0'); };

function localIpv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

class TurnServer extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = {
      realm: 'meshcrowd',
      secret: '',
      listenAddress: '0.0.0.0',
      port: 3478,
      tcp: true,
      externalIp: '',
      relayPortMin: 49152,
      relayPortMax: 49999,
      allowPrivatePeers: false,
      maxAllocations: 500,
      maxAllocationsPerUser: 20,
      defaultLifetime: 600,
      maxLifetime: 3600,
      maxKbps: 0,
      logger: null,
      ...opts,
    };
    this.udp = null;
    this.tcpServer = null;
    this.allocations = new Map(); // client key -> allocation
    this.sweeper = null;
    this.unauth = new Map(); // ip -> { n, at }
    this.stats = { bytesRelayed: 0, allocationsTotal: 0, bindings: 0 };
    this.running = false;
  }

  log(level, ...args) { this.opts.logger?.[level]?.('[turn]', ...args); }

  // ---------- lifecycle ----------
  async start() {
    if (this.running) return;
    const { listenAddress, port } = this.opts;
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    await new Promise((resolve, reject) => {
      this.udp.once('error', reject);
      this.udp.bind(port, listenAddress, () => { this.udp.removeListener('error', reject); resolve(); });
    });
    this.udp.on('error', (err) => this.log('warn', 'udp error:', err.message));
    this.udp.on('message', (msg, rinfo) => {
      const client = { transport: 'udp', ip: rinfo.address, port: rinfo.port, key: `u:${rinfo.address}:${rinfo.port}`, send: (b) => this.udp.send(b, rinfo.port, rinfo.address) };
      this.onPacket(msg, client);
    });
    this.port = this.udp.address().port;
    if (this.opts.tcp) {
      this.tcpServer = net.createServer((sock) => this.onTcp(sock));
      await new Promise((resolve, reject) => {
        this.tcpServer.once('error', reject);
        this.tcpServer.listen(this.port, listenAddress, () => { this.tcpServer.removeListener('error', reject); resolve(); });
      }).catch((err) => { this.log('warn', `TCP listener not started: ${err.message}`); this.tcpServer = null; });
      this.tcpServer?.on('error', (err) => this.log('warn', 'tcp error:', err.message));
    }
    this.sweeper = setInterval(() => this.sweep(), 5000);
    this.sweeper.unref?.();
    this.running = true;
    this.log('log', `listening on ${listenAddress}:${this.port} (udp${this.tcpServer ? '+tcp' : ''}), relay ports ${this.opts.relayPortMin}-${this.opts.relayPortMax}`);
  }

  async stop() {
    clearInterval(this.sweeper);
    for (const a of [...this.allocations.values()]) this.drop(a);
    await new Promise((r) => (this.udp ? this.udp.close(r) : r()));
    await new Promise((r) => (this.tcpServer ? this.tcpServer.close(() => r()) : r()));
    for (const s of this.tcpSockets || []) s.destroy();
    this.udp = null; this.tcpServer = null; this.running = false;
  }

  status() {
    return {
      running: this.running,
      port: this.port || this.opts.port,
      tcp: !!this.tcpServer,
      allocations: this.allocations.size,
      bytesRelayed: this.stats.bytesRelayed,
      allocationsTotal: this.stats.allocationsTotal,
      relayPorts: [this.opts.relayPortMin, this.opts.relayPortMax],
    };
  }

  // ---------- transports ----------
  onTcp(sock) {
    this.tcpSockets = this.tcpSockets || new Set();
    this.tcpSockets.add(sock);
    const client = { transport: 'tcp', ip: sock.remoteAddress?.replace('::ffff:', '') || '', port: sock.remotePort, key: `t:${sock.remoteAddress}:${sock.remotePort}`, sock };
    client.send = (b) => { if (!sock.destroyed) sock.write(b); };
    let buf = Buffer.alloc(0);
    sock.setTimeout(5 * 60 * 1000, () => sock.destroy());
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        let total;
        if (stun.isChannelData(buf)) total = 4 + stun.padded(buf.readUInt16BE(2));
        else if ((buf[0] & 0xc0) === 0 && buf.length >= 20) total = 20 + buf.readUInt16BE(2);
        else if ((buf[0] & 0xc0) === 0) return;
        else { sock.destroy(); return; }
        if (buf.length < total) return;
        const frame = buf.subarray(0, stun.isChannelData(buf) ? 4 + buf.readUInt16BE(2) : total);
        buf = buf.subarray(total);
        this.onPacket(Buffer.from(frame), client);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      this.tcpSockets.delete(sock);
      const a = this.allocations.get(client.key);
      if (a) this.drop(a);
    });
  }

  onPacket(buf, client) {
    try {
      if (stun.isChannelData(buf)) return this.onChannelData(buf, client);
      const msg = stun.parse(buf);
      if (!msg) return;
      if (msg.cls === CLASS.INDICATION) { if (msg.method === METHOD.SEND) this.onSend(msg, client); return; }
      if (msg.cls !== CLASS.REQUEST) return;
      if (msg.method === METHOD.BINDING) return this.onBinding(msg, client);
      if (!this.rateOk(client.ip)) return;
      switch (msg.method) {
        case METHOD.ALLOCATE: return this.onAllocate(msg, client);
        case METHOD.REFRESH: return this.onRefresh(msg, client);
        case METHOD.CREATE_PERMISSION: return this.onCreatePermission(msg, client);
        case METHOD.CHANNEL_BIND: return this.onChannelBind(msg, client);
        default: return this.reply(client, msg, ERR.BAD_REQUEST);
      }
    } catch (err) {
      this.log('warn', 'packet error:', err.message);
    }
  }

  rateOk(ip) {
    const now = Date.now();
    const e = this.unauth.get(ip);
    if (!e || now - e.at > 1000) { this.unauth.set(ip, { n: 1, at: now }); return true; }
    e.n += 1;
    return e.n <= UNAUTH_PER_SECOND;
  }

  // ---------- replies ----------
  reply(client, msg, err, extra = [], key = null) {
    const type = stun.typeOf(msg.method, err ? CLASS.ERROR : CLASS.SUCCESS);
    const attrs = err
      ? [{ type: ATTR.ERROR_CODE, value: stun.encodeError(err[0], err[1]) }, ...extra]
      : extra;
    client.send(stun.build(type, msg.tid, [...attrs, { type: ATTR.SOFTWARE, value: Buffer.from('MeshCrowd TURN') }], { key: err ? null : key }));
  }

  challenge(client, msg, err = ERR.UNAUTHORIZED) {
    this.reply(client, msg, err, [
      { type: ATTR.REALM, value: Buffer.from(this.opts.realm) },
      { type: ATTR.NONCE, value: Buffer.from(this.makeNonce()) },
    ]);
  }

  makeNonce() {
    const ts = Date.now().toString(36);
    return `${ts}-${crypto.createHmac('sha256', this.opts.secret).update(`nonce${ts}`).digest('hex').slice(0, 24)}`;
  }

  nonceState(nonce) {
    const i = nonce.indexOf('-');
    if (i < 1) return 'bad';
    const ts = nonce.slice(0, i);
    const want = crypto.createHmac('sha256', this.opts.secret).update(`nonce${ts}`).digest('hex').slice(0, 24);
    if (nonce.slice(i + 1) !== want) return 'bad';
    return Date.now() - parseInt(ts, 36) > NONCE_TTL_MS ? 'stale' : 'ok';
  }

  // Resolves to { key, label } for an authenticated request, or null after answering with a challenge.
  authenticate(msg, client) {
    const mi = msg.attrs.get(ATTR.MESSAGE_INTEGRITY);
    if (!mi) { this.challenge(client, msg); return null; }
    const username = msg.attrs.get(ATTR.USERNAME)?.toString('utf8');
    const realm = msg.attrs.get(ATTR.REALM)?.toString('utf8');
    const nonce = msg.attrs.get(ATTR.NONCE)?.toString('utf8');
    if (!username || !realm || !nonce) { this.reply(client, msg, ERR.BAD_REQUEST); return null; }
    const ns = this.nonceState(nonce);
    if (ns === 'bad') { this.challenge(client, msg); return null; }
    if (ns === 'stale') { this.challenge(client, msg, ERR.STALE_NONCE); return null; }
    const label = credentials.labelOf(username);
    if (label === null) { this.challenge(client, msg); return null; }
    const key = stun.longTermKey(username, this.opts.realm, credentials.passwordFor(this.opts.secret, username));
    if (!stun.checkIntegrity(msg, key)) { this.challenge(client, msg); return null; }
    return { key, label, username };
  }

  // ---------- STUN ----------
  onBinding(msg, client) {
    this.stats.bindings += 1;
    this.reply(client, msg, null, [{ type: ATTR.XOR_MAPPED_ADDRESS, value: stun.encodeXorAddress(client.ip, client.port) }]);
  }

  // ---------- TURN ----------
  relayIpFor(clientIp) {
    const locals = localIpv4s();
    const bound = this.opts.listenAddress;
    if (bound !== '0.0.0.0' && bound !== '::') return bound;
    if (isPrivate(clientIp)) {
      const sameNet = locals.find((l) => ipToInt(l) >>> 8 === ipToInt(clientIp) >>> 8);
      if (clientIp.startsWith('127.')) return '127.0.0.1';
      return sameNet || locals.find((l) => isPrivate(l)) || locals[0] || '127.0.0.1';
    }
    return this.opts.externalIp || locals.find((l) => !isPrivate(l)) || locals[0] || '127.0.0.1';
  }

  async bindRelay() {
    const { relayPortMin: lo, relayPortMax: hi, listenAddress } = this.opts;
    for (let i = 0; i < 60; i++) {
      const p = lo + crypto.randomInt(hi - lo + 1);
      const sock = dgram.createSocket('udp4');
      const ok = await new Promise((resolve) => {
        sock.once('error', () => resolve(false));
        sock.bind(p, listenAddress, () => resolve(true));
      });
      if (ok) { sock.removeAllListeners('error'); sock.on('error', () => {}); return { sock, port: p }; }
      try { sock.close(); } catch { /* already failed to bind */ }
    }
    return null;
  }

  async onAllocate(msg, client) {
    const auth = this.authenticate(msg, client);
    if (!auth) return;
    if (this.allocations.has(client.key)) return this.reply(client, msg, ERR.ALLOCATION_MISMATCH);
    const transport = msg.attrs.get(ATTR.REQUESTED_TRANSPORT);
    if (!transport || transport[0] !== 17) return this.reply(client, msg, ERR.UNSUPPORTED_TRANSPORT);
    const fam = msg.attrs.get(ATTR.REQUESTED_ADDRESS_FAMILY);
    if (fam && fam[0] !== 0x01) return this.reply(client, msg, ERR.ADDRESS_FAMILY);
    if (msg.attrs.has(ATTR.EVEN_PORT) || msg.attrs.has(ATTR.RESERVATION_TOKEN)) {
      return this.reply(client, msg, ERR.UNKNOWN_ATTRIBUTE, [{ type: ATTR.UNKNOWN_ATTRIBUTES, value: Buffer.from([0x00, msg.attrs.has(ATTR.EVEN_PORT) ? 0x18 : 0x22]) }]);
    }
    const mine = [...this.allocations.values()].filter((a) => a.label === auth.label).length;
    if (this.allocations.size >= this.opts.maxAllocations || mine >= this.opts.maxAllocationsPerUser) return this.reply(client, msg, ERR.QUOTA);
    const relay = await this.bindRelay();
    if (!relay) return this.reply(client, msg, ERR.INSUFFICIENT_CAPACITY);
    if (this.allocations.has(client.key)) { relay.sock.close(); return this.reply(client, msg, ERR.ALLOCATION_MISMATCH); }
    const lifetime = this.clampLifetime(msg.attrs.get(ATTR.LIFETIME));
    const relayIp = this.relayIpFor(client.ip);
    const a = {
      client, label: auth.label, relay: relay.sock, relayIp, relayPort: relay.port, expires: Date.now() + lifetime * 1000,
      perms: new Map(), channels: new Map(), byPeer: new Map(), tokens: this.opts.maxKbps ? this.opts.maxKbps * 125 : Infinity, tokenAt: Date.now(),
    };
    relay.sock.on('message', (data, rinfo) => this.onPeerData(a, data, rinfo));
    this.allocations.set(client.key, a);
    this.stats.allocationsTotal += 1;
    this.reply(client, msg, null, [
      { type: ATTR.XOR_RELAYED_ADDRESS, value: stun.encodeXorAddress(relayIp, relay.port) },
      { type: ATTR.LIFETIME, value: stun.u32(lifetime) },
      { type: ATTR.XOR_MAPPED_ADDRESS, value: stun.encodeXorAddress(client.ip, client.port) },
    ], auth.key);
    this.emit('allocate', { label: auth.label, client: client.ip });
  }

  clampLifetime(v) {
    const want = v && v.length === 4 ? v.readUInt32BE(0) : this.opts.defaultLifetime;
    return Math.max(want === 0 ? 0 : 60, Math.min(want, this.opts.maxLifetime));
  }

  onRefresh(msg, client) {
    const auth = this.authenticate(msg, client);
    if (!auth) return;
    const a = this.allocations.get(client.key);
    if (!a) return this.reply(client, msg, ERR.ALLOCATION_MISMATCH);
    const lifetime = this.clampLifetime(msg.attrs.get(ATTR.LIFETIME));
    if (lifetime === 0) { this.drop(a); return this.reply(client, msg, null, [{ type: ATTR.LIFETIME, value: stun.u32(0) }], auth.key); }
    a.expires = Date.now() + lifetime * 1000;
    this.reply(client, msg, null, [{ type: ATTR.LIFETIME, value: stun.u32(lifetime) }], auth.key);
  }

  peerAllowed(ip) {
    if (isNeverAllowed(ip)) return false;
    return this.opts.allowPrivatePeers || !isPrivate(ip);
  }

  peersOf(msg) {
    return msg.list.filter((x) => x.type === ATTR.XOR_PEER_ADDRESS).map((x) => stun.decodeXorAddress(x.value));
  }

  onCreatePermission(msg, client) {
    const auth = this.authenticate(msg, client);
    if (!auth) return;
    const a = this.allocations.get(client.key);
    if (!a) return this.reply(client, msg, ERR.ALLOCATION_MISMATCH);
    const peers = this.peersOf(msg);
    if (!peers.length || peers.some((p) => !p)) return this.reply(client, msg, ERR.BAD_REQUEST);
    if (peers.some((p) => p.family !== 4)) return this.reply(client, msg, ERR.PEER_FAMILY);
    if (peers.some((p) => !this.peerAllowed(p.ip))) return this.reply(client, msg, ERR.FORBIDDEN);
    for (const p of peers) a.perms.set(p.ip, Date.now() + PERMISSION_MS);
    this.reply(client, msg, null, [], auth.key);
  }

  onChannelBind(msg, client) {
    const auth = this.authenticate(msg, client);
    if (!auth) return;
    const a = this.allocations.get(client.key);
    if (!a) return this.reply(client, msg, ERR.ALLOCATION_MISMATCH);
    const cn = msg.attrs.get(ATTR.CHANNEL_NUMBER);
    const peers = this.peersOf(msg);
    if (!cn || cn.length < 4 || peers.length !== 1 || !peers[0]) return this.reply(client, msg, ERR.BAD_REQUEST);
    const num = cn.readUInt16BE(0);
    if (num < 0x4000 || num > 0x7ffe) return this.reply(client, msg, ERR.BAD_REQUEST);
    const peer = peers[0];
    if (peer.family !== 4) return this.reply(client, msg, ERR.PEER_FAMILY);
    if (!this.peerAllowed(peer.ip)) return this.reply(client, msg, ERR.FORBIDDEN);
    const pk = `${peer.ip}:${peer.port}`;
    const existing = a.channels.get(num);
    if (existing && `${existing.ip}:${existing.port}` !== pk && existing.expires > Date.now()) return this.reply(client, msg, ERR.BAD_REQUEST);
    const boundTo = a.byPeer.get(pk);
    if (boundTo !== undefined && boundTo !== num && a.channels.get(boundTo)?.expires > Date.now()) return this.reply(client, msg, ERR.BAD_REQUEST);
    a.channels.set(num, { ip: peer.ip, port: peer.port, expires: Date.now() + CHANNEL_MS });
    a.byPeer.set(pk, num);
    a.perms.set(peer.ip, Date.now() + PERMISSION_MS);
    this.reply(client, msg, null, [], auth.key);
  }

  // ---------- relaying ----------
  allow(a, bytes) {
    if (a.tokens === Infinity) return true;
    const now = Date.now();
    a.tokens = Math.min(this.opts.maxKbps * 125, a.tokens + ((now - a.tokenAt) / 1000) * this.opts.maxKbps * 125);
    a.tokenAt = now;
    if (a.tokens < bytes) return false;
    a.tokens -= bytes;
    return true;
  }

  onSend(msg, client) {
    const a = this.allocations.get(client.key);
    if (!a) return;
    const data = msg.attrs.get(ATTR.DATA);
    const pa = msg.attrs.get(ATTR.XOR_PEER_ADDRESS);
    const peer = pa && stun.decodeXorAddress(pa);
    if (!data || !peer || peer.family !== 4) return;
    if ((a.perms.get(peer.ip) || 0) < Date.now()) return;
    this.toPeer(a, data, peer.ip, peer.port);
  }

  onChannelData(buf, client) {
    const a = this.allocations.get(client.key);
    if (!a || buf.length < 4) return;
    const num = buf.readUInt16BE(0);
    const len = buf.readUInt16BE(2);
    const ch = a.channels.get(num);
    if (!ch || ch.expires < Date.now() || buf.length < 4 + len) return;
    this.toPeer(a, buf.subarray(4, 4 + len), ch.ip, ch.port);
  }

  toPeer(a, data, ip, port) {
    if (!this.allow(a, data.length)) return;
    this.stats.bytesRelayed += data.length;
    a.relay.send(data, port, ip);
  }

  onPeerData(a, data, rinfo) {
    if (this.allocations.get(a.client.key) !== a) return;
    if ((a.perms.get(rinfo.address) || 0) < Date.now()) return;
    if (!this.allow(a, data.length)) return;
    this.stats.bytesRelayed += data.length;
    const num = a.byPeer.get(`${rinfo.address}:${rinfo.port}`);
    const ch = num !== undefined ? a.channels.get(num) : null;
    if (ch && ch.expires > Date.now()) {
      const head = Buffer.alloc(4);
      head.writeUInt16BE(num, 0);
      head.writeUInt16BE(data.length, 2);
      const frame = Buffer.concat([head, data]);
      a.client.send(a.client.transport === 'tcp' && frame.length % 4 ? Buffer.concat([frame, Buffer.alloc(4 - (frame.length % 4))]) : frame);
    } else {
      a.client.send(stun.build(stun.typeOf(METHOD.DATA, CLASS.INDICATION), stun.newTid(), [
        { type: ATTR.XOR_PEER_ADDRESS, value: stun.encodeXorAddress(rinfo.address, rinfo.port) },
        { type: ATTR.DATA, value: data },
      ]));
    }
  }

  // ---------- cleanup ----------
  drop(a) {
    this.allocations.delete(a.client.key);
    try { a.relay.close(); } catch { /* already closed */ }
  }

  sweep() {
    const now = Date.now();
    for (const a of [...this.allocations.values()]) if (a.expires < now) this.drop(a);
    for (const [ip, e] of this.unauth) if (now - e.at > 5000) this.unauth.delete(ip);
  }
}

module.exports = { TurnServer, isPrivate, isNeverAllowed };
