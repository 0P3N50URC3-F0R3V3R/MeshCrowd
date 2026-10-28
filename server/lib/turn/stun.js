'use strict';

// STUN (RFC 5389) message codec plus the TURN (RFC 5766) message and attribute numbers the relay
// uses. Only what the server needs: IPv4 addresses, HMAC-SHA1 integrity, FINGERPRINT.

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const MAGIC = 0x2112a442;
const HEADER = 20;

const METHOD = { BINDING: 0x001, ALLOCATE: 0x003, REFRESH: 0x004, SEND: 0x006, DATA: 0x007, CREATE_PERMISSION: 0x008, CHANNEL_BIND: 0x009 };
const CLASS = { REQUEST: 0x0000, INDICATION: 0x0010, SUCCESS: 0x0100, ERROR: 0x0110 };

const ATTR = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  UNKNOWN_ATTRIBUTES: 0x000a,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_ADDRESS_FAMILY: 0x0017,
  EVEN_PORT: 0x0018,
  REQUESTED_TRANSPORT: 0x0019,
  DONT_FRAGMENT: 0x001a,
  XOR_MAPPED_ADDRESS: 0x0020,
  RESERVATION_TOKEN: 0x0022,
  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028,
};

const ERR = {
  BAD_REQUEST: [400, 'Bad Request'],
  UNAUTHORIZED: [401, 'Unauthorized'],
  FORBIDDEN: [403, 'Forbidden'],
  UNKNOWN_ATTRIBUTE: [420, 'Unknown Attribute'],
  ALLOCATION_MISMATCH: [437, 'Allocation Mismatch'],
  STALE_NONCE: [438, 'Stale Nonce'],
  ADDRESS_FAMILY: [440, 'Address Family not Supported'],
  WRONG_CREDENTIALS: [441, 'Wrong Credentials'],
  UNSUPPORTED_TRANSPORT: [442, 'Unsupported Transport Protocol'],
  PEER_FAMILY: [443, 'Peer Address Family Mismatch'],
  QUOTA: [486, 'Allocation Quota Reached'],
  INSUFFICIENT_CAPACITY: [508, 'Insufficient Capacity'],
};

// STUN type = method bits interleaved with the two class bits (RFC 5389 section 6).
const typeOf = (method, cls) => ((method & 0xf80) << 2) | ((method & 0x070) << 1) | (method & 0x00f) | cls;
const methodOf = (type) => ((type & 0x3e00) >> 2) | ((type & 0x00e0) >> 1) | (type & 0x000f);
const classOf = (type) => type & 0x0110;

const isStun = (buf) => buf.length >= HEADER && (buf[0] & 0xc0) === 0 && buf.readUInt32BE(4) === MAGIC;
const isChannelData = (buf) => buf.length >= 4 && buf[0] >= 0x40 && buf[0] <= 0x7f;

const padded = (n) => (n + 3) & ~3;

// Returns { type, method, cls, tid, attrs: Map<number, Buffer>, list: [{type, value, offset}], raw } or null.
function parse(buf) {
  if (!isStun(buf)) return null;
  const length = buf.readUInt16BE(2);
  if (length % 4 !== 0 || HEADER + length > buf.length) return null;
  const type = buf.readUInt16BE(0);
  const list = [];
  const attrs = new Map();
  let off = HEADER;
  const end = HEADER + length;
  while (off + 4 <= end) {
    const t = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    if (off + 4 + len > end) return null;
    const value = buf.subarray(off + 4, off + 4 + len);
    list.push({ type: t, value, offset: off });
    if (!attrs.has(t)) attrs.set(t, value);
    off += 4 + padded(len);
  }
  return { type, method: methodOf(type), cls: classOf(type), tid: Buffer.from(buf.subarray(8, 20)), attrs, list, raw: buf.subarray(0, end) };
}

const hmac = (key, data) => crypto.createHmac('sha1', key).update(data).digest();

// MESSAGE-INTEGRITY covers the message up to the attribute, with the header length already
// counting the 24-byte attribute itself.
function integrityOf(raw, offset, key) {
  const head = Buffer.from(raw.subarray(0, offset));
  head.writeUInt16BE(offset - HEADER + 24, 2);
  return hmac(key, head);
}

function checkIntegrity(msg, key) {
  const mi = msg.list.find((a) => a.type === ATTR.MESSAGE_INTEGRITY);
  if (!mi || mi.value.length !== 20) return false;
  const want = integrityOf(msg.raw, mi.offset, key);
  return crypto.timingSafeEqual(want, mi.value);
}

function attrBuffer(type, value) {
  const len = value.length;
  const out = Buffer.alloc(4 + padded(len));
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(len, 2);
  value.copy(out, 4);
  return out;
}

// attrs: [{ type, value: Buffer }]. opts.key adds MESSAGE-INTEGRITY, opts.fingerprint adds FINGERPRINT.
function build(type, tid, attrs, { key = null, fingerprint = true } = {}) {
  const body = Buffer.concat(attrs.map((a) => attrBuffer(a.type, a.value)));
  const head = Buffer.alloc(HEADER);
  head.writeUInt16BE(type, 0);
  head.writeUInt32BE(MAGIC, 4);
  tid.copy(head, 8);
  let msg = Buffer.concat([head, body]);
  if (key) {
    msg.writeUInt16BE(msg.length - HEADER + 24, 2);
    const mi = attrBuffer(ATTR.MESSAGE_INTEGRITY, hmac(key, msg));
    msg = Buffer.concat([msg, mi]);
  }
  if (fingerprint) {
    msg.writeUInt16BE(msg.length - HEADER + 8, 2);
    const fp = Buffer.alloc(4);
    fp.writeUInt32BE(((zlib.crc32(msg) ^ 0x5354554e) >>> 0), 0);
    msg = Buffer.concat([msg, attrBuffer(ATTR.FINGERPRINT, fp)]);
  } else {
    msg.writeUInt16BE(msg.length - HEADER, 2);
  }
  return msg;
}

function ipv4ToBuf(ip) {
  const p = ip.split('.').map(Number);
  return Buffer.from(p);
}
const bufToIpv4 = (b) => `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;

function encodeAddress(ip, port) {
  const v = Buffer.alloc(8);
  v[1] = 0x01;
  v.writeUInt16BE(port, 2);
  ipv4ToBuf(ip).copy(v, 4);
  return v;
}

function encodeXorAddress(ip, port) {
  const v = encodeAddress(ip, port);
  v.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(MAGIC, 0);
  for (let i = 0; i < 4; i++) v[4 + i] ^= cookie[i];
  return v;
}

// Returns { family: 4|6, ip, port } or null. IPv6 is decoded only far enough to be refused.
function decodeXorAddress(v) {
  if (v.length < 8) return null;
  const family = v[1] === 0x01 ? 4 : v[1] === 0x02 ? 6 : 0;
  if (!family) return null;
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  if (family === 6) return { family, ip: null, port };
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(MAGIC, 0);
  const ip = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) ip[i] = v[4 + i] ^ cookie[i];
  return { family, ip: bufToIpv4(ip), port };
}

function encodeError(code, reason) {
  const text = Buffer.from(reason, 'utf8');
  const v = Buffer.alloc(4 + text.length);
  v[2] = Math.floor(code / 100);
  v[3] = code % 100;
  text.copy(v, 4);
  return v;
}

function decodeError(v) {
  return v.length >= 4 ? (v[2] & 0x07) * 100 + v[3] : 0;
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };

// Long-term credential key (RFC 5389 section 15.4): MD5(username ":" realm ":" password).
const longTermKey = (username, realm, password) => crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest();

const newTid = () => crypto.randomBytes(12);

module.exports = {
  MAGIC, HEADER, METHOD, CLASS, ATTR, ERR,
  typeOf, methodOf, classOf, isStun, isChannelData, padded,
  parse, build, checkIntegrity, attrBuffer,
  encodeAddress, encodeXorAddress, decodeXorAddress, encodeError, decodeError, u32, longTermKey, newTid, bufToIpv4,
};
