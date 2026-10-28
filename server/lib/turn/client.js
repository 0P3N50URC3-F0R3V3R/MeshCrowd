'use strict';

// A minimal UDP TURN/STUN client. Used by the setup tool and the admin "test" button to prove the
// relay really allocates, and by the tests.

const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const stun = require('./stun');

const { ATTR, METHOD, CLASS } = stun;

class TurnClient extends EventEmitter {
  constructor({ host, port, username = '', credential = '', timeoutMs = 3000 }) {
    super();
    Object.assign(this, { host, port, username, credential, timeoutMs });
    this.sock = dgram.createSocket('udp4');
    this.pending = new Map();
    this.realm = null;
    this.nonce = null;
    this.key = null;
    this.ready = new Promise((resolve) => this.sock.bind(0, () => resolve()));
    this.sock.on('message', (buf) => this.onMessage(buf));
    this.sock.on('error', () => {});
  }

  onMessage(buf) {
    if (stun.isChannelData(buf)) {
      const len = buf.readUInt16BE(2);
      this.emit('data', { channel: buf.readUInt16BE(0), data: buf.subarray(4, 4 + len) });
      return;
    }
    const msg = stun.parse(buf);
    if (!msg) return;
    if (msg.cls === CLASS.INDICATION && msg.method === METHOD.DATA) {
      const peer = stun.decodeXorAddress(msg.attrs.get(ATTR.XOR_PEER_ADDRESS));
      this.emit('data', { peer, data: msg.attrs.get(ATTR.DATA) });
      return;
    }
    const p = this.pending.get(msg.tid.toString('hex'));
    if (p) { this.pending.delete(msg.tid.toString('hex')); clearTimeout(p.timer); p.resolve(msg); }
  }

  raw(type, attrs, key) {
    const tid = stun.newTid();
    const buf = stun.build(type, tid, attrs, { key });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(tid.toString('hex')); reject(new Error('timeout')); }, this.timeoutMs);
      this.pending.set(tid.toString('hex'), { resolve, timer });
      this.sock.send(buf, this.port, this.host);
    });
  }

  async binding() {
    await this.ready;
    const res = await this.raw(stun.typeOf(METHOD.BINDING, CLASS.REQUEST), []);
    const a = res.attrs.get(ATTR.XOR_MAPPED_ADDRESS);
    return a ? stun.decodeXorAddress(a) : null;
  }

  // Authenticated request: the first try draws the 401 challenge, the second carries the credentials.
  async authed(method, attrs) {
    await this.ready;
    const type = stun.typeOf(method, CLASS.REQUEST);
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      if (!this.key) {
        res = await this.raw(type, attrs);
      } else {
        res = await this.raw(type, [
          ...attrs,
          { type: ATTR.USERNAME, value: Buffer.from(this.username) },
          { type: ATTR.REALM, value: Buffer.from(this.realm) },
          { type: ATTR.NONCE, value: Buffer.from(this.nonce) },
        ], this.key);
      }
      const err = res.attrs.get(ATTR.ERROR_CODE);
      const code = err ? stun.decodeError(err) : 0;
      if ((code === 401 || code === 438) && res.attrs.has(ATTR.NONCE)) {
        this.realm = res.attrs.get(ATTR.REALM).toString();
        this.nonce = res.attrs.get(ATTR.NONCE).toString();
        this.key = stun.longTermKey(this.username, this.realm, this.credential);
        if (code === 401 && attempt >= 1 && this.key) { res.code = 401; return res; }
        continue;
      }
      res.code = code;
      return res;
    }
    throw new Error('authentication did not settle');
  }

  async allocate() {
    const res = await this.authed(METHOD.ALLOCATE, [{ type: ATTR.REQUESTED_TRANSPORT, value: Buffer.from([17, 0, 0, 0]) }]);
    if (res.code) return { ok: false, code: res.code };
    const relayed = stun.decodeXorAddress(res.attrs.get(ATTR.XOR_RELAYED_ADDRESS));
    const mapped = stun.decodeXorAddress(res.attrs.get(ATTR.XOR_MAPPED_ADDRESS));
    const lifetime = res.attrs.get(ATTR.LIFETIME)?.readUInt32BE(0);
    return { ok: true, relayed, mapped, lifetime };
  }

  async refresh(seconds) {
    const res = await this.authed(METHOD.REFRESH, [{ type: ATTR.LIFETIME, value: stun.u32(seconds) }]);
    return { ok: !res.code, code: res.code };
  }

  async createPermission(ip) {
    const res = await this.authed(METHOD.CREATE_PERMISSION, [{ type: ATTR.XOR_PEER_ADDRESS, value: stun.encodeXorAddress(ip, 0) }]);
    return { ok: !res.code, code: res.code };
  }

  async channelBind(channel, ip, port) {
    const cn = Buffer.alloc(4);
    cn.writeUInt16BE(channel, 0);
    const res = await this.authed(METHOD.CHANNEL_BIND, [
      { type: ATTR.CHANNEL_NUMBER, value: cn },
      { type: ATTR.XOR_PEER_ADDRESS, value: stun.encodeXorAddress(ip, port) },
    ]);
    return { ok: !res.code, code: res.code };
  }

  sendTo(ip, port, data) {
    const msg = stun.build(stun.typeOf(METHOD.SEND, CLASS.INDICATION), stun.newTid(), [
      { type: ATTR.XOR_PEER_ADDRESS, value: stun.encodeXorAddress(ip, port) },
      { type: ATTR.DATA, value: data },
    ]);
    this.sock.send(msg, this.port, this.host);
  }

  sendChannel(channel, data) {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(channel, 0);
    head.writeUInt16BE(data.length, 2);
    this.sock.send(Buffer.concat([head, data]), this.port, this.host);
  }

  close() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    try { this.sock.close(); } catch { /* already closed */ }
  }
}

module.exports = { TurnClient };
