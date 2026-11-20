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

// The server answers an over-length message with { error, code: 'message_too_long', maxChars } (400 or 413).
export function isMessageTooLong(err) {
  return err?.body?.code === 'message_too_long' || (err?.status === 413 && /too long/i.test(err?.body?.error || ''));
}

// Lowers the client's idea of the limit to what the server just reported; returns the limit to use.
export function adoptServerLimit(config, err) {
  const n = Math.floor(Number(err?.body?.maxChars));
  if (Number.isFinite(n) && n > 0) config.maxMessageChars = n;
  return config.maxMessageChars || 15000;
}

// Forum post whose opening text is over the limit: the post is created with `placeholder` as its
// opening message and the real text follows as a .txt attachment. Resolves null when the user
// declines the file name prompt (the draft stays in the form). Over-length is detected up front
// from config.maxMessageChars and, if the server's limit is lower, from its message_too_long reply.
export async function createThreadAllowingLongText({ createThread, sendThreadMessage, config, title, content, placeholder, askName, tooLargeError }) {
  for (;;) {
    const limit = config.maxMessageChars || 15000;
    if (content.length <= limit) {
      try { return await createThread({ title, content }); } catch (err) {
        if (isMessageTooLong(err) && content.length > adoptServerLimit(config, err)) continue;
        throw err;
      }
    }
    if (textByteLength(content) > MAX_TEXT_FILE_BYTES) throw new Error(tooLargeError);
    const name = await askName();
    if (name === null) return null;
    const res = await createThread({ title, content: placeholder });
    await sendThreadMessage(res.thread.id, { content: '', files: [textToFile(content, name)] });
    return res;
  }
}
