// Entry for the Site IndexedDB shim, bundled by scripts/build-vendor.js into server/assets/site-idb.js.
// fake-indexeddb is a pure JS IndexedDB that lives in memory; this file makes it behave as the page's
// IndexedDB: the viewer's snapshot is restored from the server before the first open, and every committed
// write transaction schedules a debounced, serialized dump of all databases back to the server.
import {
  indexedDB, IDBCursor, IDBCursorWithValue, IDBDatabase, IDBFactory, IDBIndex, IDBKeyRange,
  IDBObjectStore, IDBOpenDBRequest, IDBRequest, IDBTransaction, IDBVersionChangeEvent,
} from 'fake-indexeddb';

const S = window.__mcSite;
if (S) install(S);

function install(site) {
  const ENDPOINT = `${site.p}/__idb`;
  const MAX_BYTES = S.iq || 20 * 1024 * 1024;
  const proto = IDBFactory.prototype;
  const rawOpen = proto.open;
  const rawDelete = proto.deleteDatabase;
  const rawDatabases = proto.databases;
  const rawTransaction = IDBDatabase.prototype.transaction;

  let ready = false;
  let overQuota = false;
  const waiting = [];
  const whenReady = () => (ready ? Promise.resolve() : new Promise((r) => waiting.push(r)));

  // ---- structured-clone-ish JSON codec (values and keys) ----
  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const TYPED = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };

  async function enc(v, seen) {
    if (v === undefined) return { $u: 1 };
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? { $n: '-0' } : v) : { $n: String(v) };
    if (typeof v === 'bigint') return { $bi: v.toString() };
    if (typeof v !== 'object') throw new Error('unsupported value');
    if (seen.has(v)) throw new Error('cyclic value');
    seen.add(v);
    try {
      if (v instanceof Date) return { $d: v.getTime() };
      if (v instanceof RegExp) return { $r: [v.source, v.flags] };
      if (v instanceof ArrayBuffer) return { $ab: b64(new Uint8Array(v)) };
      if (ArrayBuffer.isView(v)) {
        if (v instanceof DataView) return { $dv: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
        return { $ta: [v.constructor.name, b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))] };
      }
      if (typeof Blob !== 'undefined' && v instanceof Blob) {
        const data = b64(new Uint8Array(await v.arrayBuffer()));
        return typeof File !== 'undefined' && v instanceof File ? { $file: [data, v.type, v.name, v.lastModified] } : { $blob: [data, v.type] };
      }
      if (v instanceof Map) { const o = []; for (const [k, x] of v) o.push([await enc(k, seen), await enc(x, seen)]); return { $m: o }; }
      if (v instanceof Set) { const o = []; for (const x of v) o.push(await enc(x, seen)); return { $s: o }; }
      if (v instanceof Error) return { $e: [v.name, v.message] };
      if (Array.isArray(v)) { const o = []; for (let i = 0; i < v.length; i++) o.push(await enc(v[i], seen)); return o; }
      const o = {};
      let wrap = false;
      for (const k of Object.keys(v)) { if (k.charAt(0) === '$') wrap = true; o[k] = await enc(v[k], seen); }
      return wrap ? { $o: o } : o;
    } finally { seen.delete(v); }
  }

  function dec(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(dec);
    if ('$u' in v) return undefined;
    if ('$n' in v) return v.$n === '-0' ? -0 : Number(v.$n);
    if ('$bi' in v) return BigInt(v.$bi);
    if ('$d' in v) return new Date(v.$d);
    if ('$r' in v) return new RegExp(v.$r[0], v.$r[1]);
    if ('$ab' in v) return unb64(v.$ab).buffer;
    if ('$dv' in v) return new DataView(unb64(v.$dv).buffer);
    if ('$ta' in v) { const u8 = unb64(v.$ta[1]); const C = TYPED[v.$ta[0]] || Uint8Array; return new C(u8.buffer, 0, Math.floor(u8.byteLength / C.BYTES_PER_ELEMENT)); }
    if ('$blob' in v) return new Blob([unb64(v.$blob[0])], { type: v.$blob[1] });
    if ('$file' in v) return new File([unb64(v.$file[0])], v.$file[2], { type: v.$file[1], lastModified: v.$file[3] });
    if ('$m' in v) return new Map(v.$m.map(([k, x]) => [dec(k), dec(x)]));
    if ('$s' in v) return new Set(v.$s.map(dec));
    if ('$e' in v) { const e = new Error(v.$e[1]); e.name = v.$e[0]; return e; }
    const src = '$o' in v ? v.$o : v;
    const o = {};
    for (const k of Object.keys(src)) o[k] = dec(src[k]);
    return o;
  }

  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted')); });

  // ---- dump / restore through the public API of the raw factory ----
  async function dump() {
    const dbs = [];
    for (const info of await rawDatabases.call(indexedDB)) {
      const db = await reqP(rawOpen.call(indexedDB, info.name));
      try {
        const stores = [];
        const names = Array.from(db.objectStoreNames);
        if (names.length) {
          const tx = rawTransaction.call(db, names, 'readonly');
          const done = txDone(tx);
          const loaded = names.map((n) => {
            const os = tx.objectStore(n);
            const records = [];
            return new Promise((res, rej) => {
              const c = os.openCursor();
              c.onsuccess = () => {
                const cur = c.result;
                if (!cur) { res(); return; }
                records.push([cur.key, cur.value]);
                cur.continue();
              };
              c.onerror = () => rej(c.error);
            }).then(() => ({
              name: n, keyPath: os.keyPath, autoIncrement: os.autoIncrement, records,
              indexes: Array.from(os.indexNames).map((i) => { const ix = os.index(i); return { name: i, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }; }),
            }));
          });
          stores.push(...await Promise.all(loaded));
          await done;
        }
        dbs.push({ name: info.name, version: db.version, stores });
      } finally { db.close(); }
    }
    const out = [];
    for (const d of dbs) {
      out.push({
        name: d.name, version: d.version,
        stores: await Promise.all(d.stores.map(async (s) => ({
          ...s, records: await Promise.all(s.records.map(async ([k, v]) => [await enc(k, new Set()), await enc(v, new Set())])),
        }))),
      });
    }
    return JSON.stringify({ v: 1, dbs: out });
  }

  async function restore(snapshot) {
    for (const d of snapshot.dbs || []) {
      const req = rawOpen.call(indexedDB, d.name, d.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        const tx = req.transaction;
        for (const s of d.stores) {
          const os = db.createObjectStore(s.name, { keyPath: s.keyPath === null ? undefined : s.keyPath, autoIncrement: !!s.autoIncrement });
          for (const ix of s.indexes) os.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
          for (const [k, v] of s.records) {
            if (s.keyPath === null || s.keyPath === undefined) os.put(dec(v), dec(k));
            else os.put(dec(v));
          }
        }
        void tx;
      };
      const db = await reqP(req);
      db.close();
    }
  }

  // ---- persistence ----
  let dirty = false;
  let timer = 0;
  let saving = Promise.resolve();
  function markDirty() {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 700);
  }
  function save(keepalive) {
    timer = 0;
    if (!dirty) return saving;
    dirty = false;
    saving = saving.then(async () => {
      try {
        const text = await dump();
        overQuota = text.length > MAX_BYTES;
        if (overQuota) return;
        await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text, keepalive: keepalive === true && text.length < 60000 });
      } catch (e) { dirty = true; }
    });
    return saving;
  }
  addEventListener('pagehide', () => { if (dirty) save(true); });

  function watch(tx) { tx.addEventListener('complete', markDirty); }

  // ---- patched factory ----
  function quotaError() { return new DOMException('The IndexedDB quota for this site was exceeded.', 'QuotaExceededError'); }

  IDBDatabase.prototype.transaction = function (stores, mode, opts) {
    if (mode === 'readwrite' && overQuota) throw quotaError();
    const tx = rawTransaction.call(this, stores, mode, opts);
    if (mode === 'readwrite') watch(tx);
    return tx;
  };

  function hookOpen(req) {
    req.addEventListener('upgradeneeded', () => { if (req.transaction) watch(req.transaction); });
  }

  // Until the snapshot is restored, an open() gets a placeholder request that relays the real one's events.
  function relay(ours, real) {
    const copy = () => { ours.result = real.result; ours.error = real.error; ours.readyState = real.readyState; ours.transaction = real.transaction; ours.source = real.source; };
    for (const type of ['blocked', 'upgradeneeded', 'success', 'error']) {
      real.addEventListener(type, (e) => {
        copy();
        // a fresh event: the one being dispatched on the real request cannot be dispatched again
        const ev = new IDBVersionChangeEvent(type, { oldVersion: e.oldVersion, newVersion: e.newVersion });
        ours.dispatchEvent(ev);
      });
    }
  }

  proto.open = function (name, version) {
    if (ready) { const r = rawOpen.apply(this, arguments); hookOpen(r); return r; }
    const ours = new IDBOpenDBRequest();
    const self = this;
    const args = arguments;
    whenReady().then(() => {
      let real;
      try { real = rawOpen.apply(self, args); } catch (e) { ours.error = e; ours.readyState = 'done'; ours.dispatchEvent(new IDBVersionChangeEvent('error')); return; }
      hookOpen(real);
      relay(ours, real);
    });
    void name; void version;
    return ours;
  };
  proto.deleteDatabase = function (name) {
    if (ready) { const r = rawDelete.apply(this, arguments); r.addEventListener('success', markDirty); return r; }
    const ours = new IDBOpenDBRequest();
    const self = this;
    const args = arguments;
    whenReady().then(() => {
      const real = rawDelete.apply(self, args);
      real.addEventListener('success', markDirty);
      relay(ours, real);
    });
    void name;
    return ours;
  };
  proto.databases = function () { return whenReady().then(() => rawDatabases.call(this)); };

  // ---- globals ----
  const globals = { indexedDB, IDBFactory, IDBDatabase, IDBObjectStore, IDBIndex, IDBCursor, IDBCursorWithValue, IDBTransaction, IDBRequest, IDBOpenDBRequest, IDBKeyRange, IDBVersionChangeEvent };
  for (const [k, v] of Object.entries(globals)) {
    try { Object.defineProperty(window, k, { configurable: true, enumerable: false, writable: true, value: v }); } catch (e) { /* keep native */ }
  }

  // ---- start ----
  const finish = () => { ready = true; for (const r of waiting.splice(0)) r(); };
  if (!site.idb) finish();
  else {
    fetch(ENDPOINT).then((r) => (r.ok ? r.text() : null)).then((text) => (text ? restore(JSON.parse(text)) : null)).catch((e) => console.warn('Site IndexedDB restore failed', e)).then(finish);
  }
}
