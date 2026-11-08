'use strict';

// Runs per-recipient work (notifications, outbox rows, bots) after the HTTP response has gone out, so the
// sender is not kept waiting on a fan-out that grows with the member count. A failure only gets logged: the
// message is already stored and broadcast.
function afterResponse(label, fn) {
  setImmediate(() => {
    const fail = (err) => console.error(`[${label}] deferred work failed:`, err?.message || err);
    try {
      const out = fn();
      if (out && typeof out.catch === 'function') out.catch(fail);
    } catch (err) { fail(err); }
  });
}

module.exports = { afterResponse };
