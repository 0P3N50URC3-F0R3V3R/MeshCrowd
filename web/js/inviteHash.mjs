// `#invite=<code>` links come from the public /i/<code> landing page. The code may be percent-encoded
// (federated codes carry an `@domain`).
export function parseInviteHash(hash) {
  const m = /^#invite=([^&]{1,200})$/.exec(hash || '');
  if (!m) return null;
  let code;
  try { code = decodeURIComponent(m[1]); } catch { return null; }
  return /^[A-Za-z0-9_.@-]{1,128}$/.test(code) ? code : null;
}

export const inviteLinkFor = (code, origin = location.origin) => `${origin}/i/${encodeURIComponent(code)}`;
