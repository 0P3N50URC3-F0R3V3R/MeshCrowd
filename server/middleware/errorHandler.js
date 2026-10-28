'use strict';

const logger = require('../lib/logger');

// A body-parser SyntaxError carries the raw request text in .body, which for the auth routes is a
// password or authKey: such errors are answered 400 and never logged, and no other error is logged
// with anything beyond its message and stack.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err && err.name === 'MulterError') return res.status(400).json({ error: err.message });
  if (err && (err.type === 'entity.parse.failed' || err.status === 400 || (err instanceof SyntaxError && 'body' in err))) {
    return res.status(400).json({ error: 'invalid request body' });
  }
  // body-parser/raw-body's PayloadTooLargeError (express.json({ limit })) — a clean 413 for a
  // client mistake, not an opaque 500. Narrowly matched on the stable `type` raw-body sets,
  // not a blanket `err.status` passthrough, which would risk turning unrelated errors that
  // happen to carry a numeric `.status` property into unintended client-facing status codes.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request entity too large' });
  }
  logger.error(err instanceof Error ? (err.stack || err.message) : String(err && err.message));
  res.status(500).json({ error: 'internal server error' });
}

module.exports = { errorHandler };
