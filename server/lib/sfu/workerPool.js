'use strict';

const os = require('node:os');

function createWorkerPool({ workers = 0, port, announcedHost, enableTcp = true, logger } = {}) {
  const mediasoup = require('mediasoup');
  const size = workers > 0 ? workers : Math.min(os.cpus().length, 4);
  const slots = new Array(size).fill(null);
  const diedCbs = [];
  let next = 0;
  let stopped = false;

  async function spawn(i) {
    const worker = await mediasoup.createWorker({ logLevel: 'warn' });
    if (stopped) {
      worker.close();
      throw new Error('pool stopped');
    }
    const listenInfos = [{ protocol: 'udp', ip: '0.0.0.0', announcedAddress: announcedHost, port: port + i }];
    if (enableTcp) listenInfos.push({ protocol: 'tcp', ip: '0.0.0.0', announcedAddress: announcedHost, port: port + i });
    let webRtcServer;
    try {
      webRtcServer = await worker.createWebRtcServer({ listenInfos });
    } catch (err) {
      worker.close();
      throw err;
    }
    if (stopped) {
      worker.close();
      throw new Error('pool stopped');
    }
    const slot = { worker, webRtcServer, index: i };
    worker.on('died', () => {
      if (stopped || slots[i] !== slot) return;
      logger?.error?.(`[sfu] worker ${i} died, replacing`);
      replace(i);
    });
    slots[i] = slot;
    return slot;
  }

  async function replace(i) {
    for (let attempt = 0; attempt < 5 && !stopped; attempt++) {
      try {
        await spawn(i);
        break;
      } catch (err) {
        if (stopped) return;
        logger?.error?.(`[sfu] could not replace worker ${i}: ${err.message}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (stopped) return;
    for (const cb of diedCbs) {
      try { cb(i); } catch (err) { logger?.error?.(`[sfu] onDied callback failed: ${err.message}`); }
    }
  }

  return {
    size,
    async start() {
      try {
        for (let i = 0; i < size; i++) await spawn(i);
      } catch (err) {
        await this.stop();
        throw err;
      }
    },
    pick() {
      for (let n = 0; n < size; n++) {
        const i = next++ % size;
        if (slots[i] && !slots[i].worker.closed) return slots[i];
      }
      throw new Error('no live sfu worker');
    },
    async stop() {
      stopped = true;
      for (let i = 0; i < size; i++) {
        slots[i]?.worker.close();
        slots[i] = null;
      }
    },
    alive() {
      return !stopped && slots.some((s) => s && !s.worker.closed);
    },
    onDied(cb) { diedCbs.push(cb); },
  };
}

module.exports = { createWorkerPool };
