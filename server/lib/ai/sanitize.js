'use strict';

const MAX_REPLY_CHARS = 4000;

// A zero-width space after "@" stops both the mention parser and the client's mention renderer
// from treating model output as a mention. "<" is defused only where the server renders raw HTML.
function cleanReply(text, { rawHtml = false } = {}) {
  let out = String(text ?? '').replace(/\r\n/g, '\n');
  out = out.replace(/@(?=[a-zA-Z0-9_.]{3,32})/g, '@​');
  if (rawHtml) out = out.replace(/</g, '<​');
  return out.slice(0, MAX_REPLY_CHARS);
}

module.exports = { cleanReply, MAX_REPLY_CHARS };
