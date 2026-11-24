'use strict';

const express = require('express');
const { rateLimit } = require('../middleware/rateLimit');
const config = require('../lib/config');
const { worker } = require('../lib/swarmWorker');

const router = express.Router();
const REFRESH_AFTER = 30_000;
let lastKick = 0;

router.get('/list', rateLimit({ windowMs: 60_000, max: 60 }), (req, res) => {
  if (config.load().swarm.advertise && Date.now() - lastKick > REFRESH_AFTER) {
    lastKick = Date.now();
    worker.runPass();
  }
  res.json(worker.getList());
});

module.exports = router;
