const DB = 'mc_state';
const STORE = 'snapshot';
const KEY = 'last';
const MESSAGES = 'messages';
const KEEP_CHATS = 8;
const KEEP_MESSAGES = 40;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      for (const name of [STORE, MESSAGES]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn, store = STORE) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
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
  try { await run('readwrite', (s) => s.clear(), MESSAGES); } catch { /* nothing to clear */ }
}

// Newest messages of the chats opened last, keyed `<userId>:<scope>:<id>`. Plain (unencrypted)
// conversations only; the caller never passes encrypted ones.
export async function readMessages(key) {
  try {
    const row = await run('readonly', (s) => s.get(key), MESSAGES);
    return row && Array.isArray(row.messages) ? row.messages : null;
  } catch { return null; }
}

export async function writeMessages(key, messages) {
  try {
    await run('readwrite', (s) => s.put({ messages: messages.slice(-KEEP_MESSAGES), savedAt: Date.now() }, key), MESSAGES);
    const keys = await run('readonly', (s) => s.getAllKeys(), MESSAGES);
    if (keys.length <= KEEP_CHATS) return;
    const rows = await Promise.all(keys.map(async (k) => [k, (await run('readonly', (s) => s.get(k), MESSAGES))?.savedAt || 0]));
    rows.sort((a, b) => a[1] - b[1]);
    for (const [k] of rows.slice(0, keys.length - KEEP_CHATS)) await run('readwrite', (s) => s.delete(k), MESSAGES);
  } catch { /* storage unavailable or full */ }
}

export async function deleteMessages(key) {
  try { await run('readwrite', (s) => s.delete(key), MESSAGES); } catch { /* nothing to delete */ }
}
