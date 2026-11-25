'use strict';

const express = require('express');
const { rateLimit } = require('../middleware/rateLimit');
const config = require('../lib/config');
const { worker } = require('../lib/swarmWorker');

const router = express.Router();
const REFRESH_AFTER = 30_000;
let lastKick = 0;

// A cold cache (just after a restart) would show the first visitor an empty list, so the first request waits a
// few seconds for the pass that is already running; later requests only kick a background refresh.
router.get('/list', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
  if (config.load().swarm.advertise) {
    if (!worker.hasData()) {
      let timer;
      await Promise.race([worker.runPass(), new Promise((r) => { timer = setTimeout(r, 4000); })]);
      clearTimeout(timer);
    } else if (Date.now() - lastKick > REFRESH_AFTER) {
      lastKick = Date.now();
      worker.runPass();
    }
  }
  res.json(worker.getList());
});

module.exports = router;
