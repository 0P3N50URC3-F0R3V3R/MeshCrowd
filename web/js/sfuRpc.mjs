// Request/response over the app WebSocket for the SFU engine (`sfu_request` -> `sfu_response`).
// Ids come from one counter shared by every instance: responses reach every rpc of the tab, so a
// late reply for a stopped engine must never match a request of the engine that replaced it.
let nextId = 1;

function rpcError(code) {
  const err = new Error(`sfu: ${code}`);
  err.code = code;
  return err;
}

export function createRpc(send, { timeoutMs = 10000 } = {}) {
  const pending = new Map(); // id -> { resolve, reject, timer }
  let closed = false;

  function request(op, data = {}) {
    if (closed) return Promise.reject(rpcError('closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(rpcError('timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ id, op, data });
    });
  }

  function handleResponse(msg) {
    const p = pending.get(msg?.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.data ?? {});
    else p.reject(rpcError(msg.error || 'internal'));
  }

  function close() {
    closed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(rpcError('closed'));
    }
    pending.clear();
  }

  return { request, handleResponse, close };
}
