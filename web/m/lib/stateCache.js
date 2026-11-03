const DB = 'mc_state';
const STORE = 'snapshot';
const KEY = 'last';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function readSnapshot() {
  try { return (await run('readonly', (s) => s.get(KEY))) || null; } catch { return null; }
}

export async function writeSnapshot(snapshot) {
  try { await run('readwrite', (s) => s.put(snapshot, KEY)); } catch { /* storage unavailable or full */ }
}

export async function clearSnapshot() {
  try { await run('readwrite', (s) => s.delete(KEY)); } catch { /* nothing to clear */ }
}
