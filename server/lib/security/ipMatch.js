'use strict';

const net = require('node:net');

// "::ffff:1.2.3.4" is the same client as 1.2.3.4; store and compare one spelling.
function normalizeIp(ip) {
  if (typeof ip !== 'string') return '';
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1];
  return net.isIP(s) ? s.toLowerCase() : '';
}

// Accepts "1.2.3.4", "2001:db8::1", "10.0.0.0/8", "2001:db8::/32" and "1.2.3.4-1.2.3.99".
// Returns { entry, kind, family, ... } with the entry in canonical spelling, or null.
function parseEntry(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 100) return null;

  const slash = text.indexOf('/');
  if (slash !== -1) {
    const ip = normalizeIp(text.slice(0, slash));
    const bitsText = text.slice(slash + 1);
    if (!ip || !/^\d{1,3}$/.test(bitsText)) return null;
    const family = net.isIPv4(ip) ? 4 : 6;
    const bits = Number(bitsText);
    if (bits > (family === 4 ? 32 : 128)) return null;
    if (bits === (family === 4 ? 32 : 128)) return { entry: ip, kind: 'ip', family, ip };
    return { entry: `${ip}/${bits}`, kind: 'cidr', family, ip, bits };
  }

  const dash = text.indexOf('-');
  if (dash !== -1) {
    const a = normalizeIp(text.slice(0, dash));
    const b = normalizeIp(text.slice(dash + 1));
    if (!a || !b || net.isIP(a) !== net.isIP(b)) return null;
    const family = net.isIPv4(a) ? 4 : 6;
    return { entry: `${a}-${b}`, kind: 'range', family, from: a, to: b };
  }

  const ip = normalizeIp(text);
  if (!ip) return null;
  return { entry: ip, kind: 'ip', family: net.isIPv4(ip) ? 4 : 6, ip };
}

// A set of parsed entries with a membership test. Rebuilt wholesale when the list changes.
class IpSet {
  constructor(entries = []) {
    this.list = new net.BlockList();
    this.size = 0;
    for (const e of entries) this.add(e);
  }

  add(parsed) {
    if (!parsed) return false;
    const type = parsed.family === 4 ? 'ipv4' : 'ipv6';
    try {
      if (parsed.kind === 'ip') this.list.addAddress(parsed.ip, type);
      else if (parsed.kind === 'cidr') this.list.addSubnet(parsed.ip, parsed.bits, type);
      else this.list.addRange(parsed.from, parsed.to, type);
    } catch {
      return false;
    }
    this.size += 1;
    return true;
  }

  has(ip) {
    const n = normalizeIp(ip);
    if (!n || this.size === 0) return false;
    return this.list.check(n, net.isIPv4(n) ? 'ipv4' : 'ipv6');
  }
}

// Does `parsed` cover `ip`? Used to refuse a ban that would lock out the admin making it.
function entryCovers(parsed, ip) {
  return new IpSet([parsed]).has(ip);
}

module.exports = { normalizeIp, parseEntry, IpSet, entryCovers };
