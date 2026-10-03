// Everything the reader keeps on this device goes through here: small values
// (`store`, in localStorage) and document copies and files waiting to be sent
// (`idb`, in IndexedDB). With protection off they are stored as they are. With
// it on (see vault.js) they are stored encrypted, under names that are hashed,
// and can only be read while the reader is unlocked.
import { vault } from './vault.js';
export { vault };

// How the reader looks is not private, and is needed before unlocking.
const PLAIN = new Set(['theme', 'font', 'view', 'hlType']);
const VAULT_META = 'hub:vault';
const te = new TextEncoder(), td = new TextDecoder();

let mode = 'plain';      // 'plain': no protection.  'locked': protected, no key.  'open': protected, unlocked.
const cache = new Map(); // private values, decrypted, while unlocked (JSON text by key)
let tail = Promise.resolve(); // encrypted writes happen one after another, in order
const later = (job) => (tail = tail.then(job).catch(() => {}));

// A very small wrapper over IndexedDB. If the browser refuses storage, every
// call quietly does nothing and the reader simply keeps no copies.
const db = {
  open() {
    return (this.db ||= new Promise((resolve) => {
      try {
        const req = indexedDB.open('hub', 2);
        req.onupgradeneeded = () => { for (const name of ['docs', 'files', 'kv']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'key' }); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    }));
  },
  async run(name, how, fn) {
    const d = await this.open();
    if (!d) return null;
    return new Promise((resolve) => {
      const tx = d.transaction(name, how), req = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve(req ? req.result : null);
      tx.onerror = tx.onabort = () => resolve(null);
    });
  },
  get: (name, key) => db.run(name, 'readonly', (s) => s.get(key)),
  put: (name, value) => db.run(name, 'readwrite', (s) => s.put(value)),
  del: (name, key) => db.run(name, 'readwrite', (s) => s.delete(key)),
  keys: (name) => db.run(name, 'readonly', (s) => s.getAllKeys()),
  all: (name) => db.run(name, 'readonly', (s) => s.getAll()),
  clear: (name) => db.run(name, 'readwrite', (s) => s.clear()),
};

const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

async function putKv(k, json) {
  const key = await vault.name('kv|' + k);
  await db.put('kv', { key, data: await vault.seal(te.encode(JSON.stringify({ k, json })), key) });
}

export const store = {
  get(k) {
    if (PLAIN.has(k) || mode === 'plain') return lsGet(k);
    try { return cache.has(k) ? JSON.parse(cache.get(k)) : null; } catch { return null; }
  },
  set(k, v) {
    if (PLAIN.has(k) || mode === 'plain') return lsSet(k, v);
    const json = JSON.stringify(v);
    cache.set(k, json);
    if (mode === 'open') later(() => putKv(k, json)); // while locked, nothing private is written at all
  },
};

// A record with an optional Blob, as one run of bytes: length of the JSON part, the JSON, then the blob.
async function pack(value) {
  const { blob, ...rest } = value;
  const head = te.encode(JSON.stringify({ ...rest, blobType: blob ? blob.type : null }));
  const body = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
  const out = new Uint8Array(4 + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(body, 4 + head.length);
  return out;
}
function unpack(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const { blobType, ...rest } = JSON.parse(td.decode(bytes.subarray(4, 4 + n)));
  if (blobType != null) rest.blob = new Blob([bytes.slice(4 + n)], { type: blobType });
  return rest;
}
const index = (name) => store.get('idx:' + name) || [];

// Document copies ("docs") and files waiting to be sent ("files"). Records are
// { key, …, text or blob }; the caller never sees whether they are encrypted.
export const idb = {
  async get(name, key) {
    if (mode === 'plain') return db.get(name, key);
    if (mode !== 'open') return null;
    await tail;
    const hashed = await vault.name(name + '|' + key), rec = await db.get(name, hashed);
    if (!rec) return null;
    try { return unpack(await vault.open(rec.data, hashed)); } catch { return null; }
  },
  async put(name, value) {
    if (mode === 'plain') return db.put(name, value);
    if (mode !== 'open') return null;
    const hashed = await vault.name(name + '|' + value.key);
    await db.put(name, { key: hashed, data: await vault.seal(await pack(value), hashed) });
    if (!index(name).includes(value.key)) store.set('idx:' + name, [...index(name), value.key]);
    return null;
  },
  async del(name, key) {
    if (mode === 'plain') return db.del(name, key);
    if (mode !== 'open') return null;
    await db.del(name, await vault.name(name + '|' + key));
    store.set('idx:' + name, index(name).filter((k) => k !== key));
    return null;
  },
  async keys(name) {
    if (mode === 'plain') return db.keys(name);
    return mode === 'open' ? index(name) : [];
  },
};

const privateKeys = () => Object.keys(localStorage).filter((k) => !PLAIN.has(k) && k !== VAULT_META);

export const local = {
  get mode() { return mode; },
  get canProtect() { return vault.available; },
  // Call first. Says whether a passphrase is needed before anything can be read.
  start() { return (mode = vault.enabled ? 'locked' : 'plain'); },

  async unlock(passphrase) {
    if (!(await vault.unlock(passphrase))) return false;
    cache.clear();
    for (const rec of (await db.all('kv')) || []) {
      try { const { k, json } = JSON.parse(td.decode(await vault.open(rec.data, rec.key))); cache.set(k, json); } catch {}
    }
    mode = 'open';
    return true;
  },
  // Forget the key and start again from the lock screen, so nothing decrypted stays on the page.
  lock() { vault.lock(); location.reload(); },
  whenSaved: () => tail,

  // Turn protection on: everything stored so far is encrypted and the readable form removed.
  async protect(passphrase) {
    const values = privateKeys().map((k) => [k, localStorage.getItem(k)]);
    const records = { docs: (await db.all('docs')) || [], files: (await db.all('files')) || [] };
    await vault.create(passphrase);
    mode = 'open';
    for (const [k, json] of values) { cache.set(k, json); later(() => putKv(k, json)); localStorage.removeItem(k); }
    for (const name of ['docs', 'files']) {
      for (const rec of records[name]) {
        if (rec.data) continue;
        await idb.put(name, rec);
        await db.del(name, rec.key);
      }
    }
    await tail;
  },
  // Turn protection off (needs it unlocked): everything is stored readable again.
  async unprotect() {
    if (mode !== 'open') return;
    await tail;
    const records = { docs: [], files: [] };
    for (const name of ['docs', 'files']) for (const key of index(name)) { const rec = await idb.get(name, key); if (rec) records[name].push(rec); }
    const values = [...cache].filter(([k]) => !k.startsWith('idx:'));
    for (const name of ['docs', 'files', 'kv']) await db.clear(name);
    vault.remove();
    mode = 'plain';
    cache.clear();
    for (const [k, json] of values) { try { localStorage.setItem(k, json); } catch {} }
    for (const name of ['docs', 'files']) for (const rec of records[name]) await db.put(name, rec);
  },
  // Remove every copy and every private value from this device. The server's data is untouched.
  async forget() {
    for (const name of ['docs', 'files', 'kv']) await db.clear(name);
    for (const k of privateKeys()) localStorage.removeItem(k);
    vault.remove();
    cache.clear();
    mode = 'plain';
  },
};
