'use strict';

// Minimal in-memory sliding-window limiter. Fine for a single-process self-hosted instance.
function rateLimit({ windowMs, max }) {
  const hits = new Map(); // key -> [timestamps]

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    const now = Date.now();
    const cutoff = now - windowMs;
    const times = (hits.get(key) || []).filter((t) => t > cutoff);
    if (times.length >= max) {
      if (!req.user && !String(req.originalUrl || '').startsWith('/federation/')) require('../lib/security/guard').noteRateLimited(req.ip);
      return res.status(429).json({ error: 'too many requests, slow down' });
    }
    times.push(now);
    hits.set(key, times);
    next();
  };
}

module.exports = { rateLimit };
