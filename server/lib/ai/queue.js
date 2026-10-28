'use strict';

// Per-provider FIFO with a concurrency limit. In memory on purpose: requests are interactive,
// so dropping the queue on restart is fine.
class ProviderQueue {
  constructor({ maxWaiting = 5 } = {}) {
    this.maxWaiting = maxWaiting;
    this.state = new Map();
  }

  _slot(providerId) {
    let s = this.state.get(providerId);
    if (!s) { s = { active: 0, concurrency: 1, waiting: [] }; this.state.set(providerId, s); }
    return s;
  }

  _pump(s) {
    while (s.active < s.concurrency && s.waiting.length) {
      s.active++;
      s.waiting.shift()();
    }
  }

  // Returns a promise for the task's result, or null when the provider is saturated.
  submit(providerId, concurrency, task) {
    const s = this._slot(providerId);
    s.concurrency = concurrency;
    if (s.active >= concurrency && s.waiting.length >= this.maxWaiting) return null;
    return new Promise((resolve, reject) => {
      s.waiting.push(() => {
        let running;
        try { running = Promise.resolve(task()); } catch (err) { running = Promise.reject(err); }
        running.then(resolve, reject).finally(() => {
          s.active--;
          this._pump(s);
        });
      });
      this._pump(s);
    });
  }

  reset() { this.state.clear(); }
}

module.exports = { ProviderQueue };
