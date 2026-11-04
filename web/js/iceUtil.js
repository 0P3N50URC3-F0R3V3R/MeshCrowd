// Pure helpers for WebRTC candidate handling in voice calls. No DOM, no state: unit-tested in
// server/test/iceUtil.test.js.

function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

export function parseCidr(cidr) {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) return null;
  const base = ipv4ToInt(m[1]);
  const bits = Number(m[2]);
  if (base === null || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

export function inCidr(ip, cidr) {
  const n = ipv4ToInt(ip);
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  return n !== null && !!c && ((n & c.mask) >>> 0) === c.base;
}

export function isPrivateIPv4(ip) {
  return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'].some((c) => inCidr(ip, c));
}

export function isLinkLocalIPv4(ip) {
  return inCidr(ip, '169.254.0.0/16');
}

export function candidateAddress(candidate) {
  if (!candidate) return null;
  if (candidate.address) return candidate.address;
  const parts = String(candidate.candidate || '').split(' ');
  return parts.length > 4 ? parts[4] : null;
}

export function candidateType(candidate) {
  const m = / typ (\w+)/.exec(String(candidate?.candidate || ''));
  return m ? m[1] : null;
}

// Whether a candidate received from a peer is worth handing to the connection. Link-local
// (169.254.x.x) addresses are never a useful path. With an operator-set `lanNetworks` list, a
// private-range host candidate outside every listed subnet (Docker, WSL, an unrelated adapter) is
// skipped so ICE does not spend its checks on it; public, relay, srflx, mDNS and IPv6 candidates are
// always kept, and an empty list filters nothing (the zero-config default).
export function shouldAcceptRemoteCandidate(candidate, lanNetworks = []) {
  const addr = candidateAddress(candidate);
  if (!addr) return true;
  if (isLinkLocalIPv4(addr)) return false;
  if (candidateType(candidate) !== 'host' || !lanNetworks.length) return true;
  if (!isPrivateIPv4(addr)) return true;
  return lanNetworks.some((c) => inCidr(addr, c));
}

// 'direct' = both ends on the same LAN/VPN/public path, 'stun' = NAT-traversed, 'relay' = through
// TURN. Derived from the selected candidate pair in an RTCPeerConnection.getStats() report.
export function connectionPath(report) {
  let pair = null;
  const byId = new Map();
  report.forEach((s) => {
    byId.set(s.id, s);
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = s.selectedCandidatePairId;
  });
  let selected = pair ? byId.get(pair) : null;
  if (!selected) report.forEach((s) => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.selected || s.nominated)) selected = s; });
  if (!selected) return null;
  // A reflexive candidate (srflx from a STUN server, prflx from a connectivity check) whose address
  // is private or loopback means no NAT sat in between - e.g. a STUN server on the same LAN reports
  // the LAN address - so it is the same direct LAN/VPN path as a host candidate, not a traversal.
  const types = [byId.get(selected.localCandidateId), byId.get(selected.remoteCandidateId)].map((c) => {
    const addr = c?.address || c?.ip || '';
    if ((c?.candidateType === 'prflx' || c?.candidateType === 'srflx') && (isPrivateIPv4(addr) || inCidr(addr, '127.0.0.0/8'))) return 'host';
    // Chrome hides the address of a peer-reflexive remote candidate; one that answered our host
    // candidate directly is a plain peer-to-peer path.
    if (c?.candidateType === 'prflx' && !addr && byId.get(selected.localCandidateId)?.candidateType === 'host') return 'host';
    return c?.candidateType;
  });
  if (types.includes('relay')) return 'relay';
  if (types.includes('srflx') || types.includes('prflx')) return 'stun';
  return 'direct';
}
