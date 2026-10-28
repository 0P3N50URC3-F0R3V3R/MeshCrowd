// Over-length messages go out as a text attachment instead of being cut off.
export const MAX_TEXT_FILE_BYTES = 300 * 1024;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'log', 'csv', 'json']);

export function textByteLength(text) {
  return new TextEncoder().encode(text).length;
}

// Only [A-Za-z0-9._-] survives, no path parts, and the extension is forced to a plain-text one so
// the upload can never be served as HTML or script.
export function safeTextFileName(input, randomId = () => Math.random().toString(36).slice(2, 8)) {
  const base = String(input || '').trim().split(/[\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 80);
  if (!base) return `message-${randomId()}.txt`;
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return TEXT_EXTENSIONS.has(ext) ? base : `${base}.txt`;
}

export function textToFile(text, name) {
  const fileName = safeTextFileName(name);
  const type = fileName.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain';
  return new File([text], fileName, { type });
}
