'use strict';

// The only URLs the OS is ever asked to open on a page's behalf: anything else (file:, smb:, ms-msdt:,
// custom app schemes) can launch local programs or leak NTLM credentials.
function externalUrl(raw) {
  try {
    const u = new URL(String(raw));
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

module.exports = { externalUrl };
