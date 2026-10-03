// The key that protects what the reader stores on this device.
//
// A random master key encrypts everything. It is itself stored only wrapped
// (encrypted) by a key stretched from your passphrase, so the stored form is
// useless without the passphrase. Unlocking unwraps it into memory; locking,
// or closing the page, drops it. Nothing here ever leaves the device.
//
//   passphrase --PBKDF2 (600,000 rounds)--> wrapping key --unwraps--> master key
//   master key --HKDF--> one key for encrypting (AES-256-GCM), one for naming (HMAC)
//
// Browsers only offer this cryptography on HTTPS pages (and on localhost).
const META = 'hub:vault', ROUNDS = 600000;
const te = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const subtle = globalThis.crypto?.subtle;

let encKey = null, macKey = null;

function meta() {
  try { return JSON.parse(localStorage.getItem(META)); } catch { return null; }
}
const wrappingKey = async (passphrase, salt, rounds) => {
  const base = await subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
// From the master key, the two working keys. Neither can be read back out of the browser.
async function open(master) {
  const base = await subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  const derive = (label, alg, uses) => subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(label) }, base, alg, false, uses);
  encKey = await derive('hub encrypt', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
  macKey = await derive('hub names', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  master.fill(0);
}

export const vault = {
  available: !!subtle && globalThis.isSecureContext,
  get enabled() { return !!meta(); },
  get unlocked() { return !!encKey; },

  // Turn protection on with a new passphrase.
  async create(passphrase) {
    const master = crypto.getRandomValues(new Uint8Array(32)), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv }, await wrappingKey(passphrase, salt, ROUNDS), master);
    localStorage.setItem(META, JSON.stringify({ v: 1, rounds: ROUNDS, salt: b64(salt), iv: b64(iv), wrapped: b64(wrapped) }));
    await open(master);
  },
  // False for a wrong passphrase: the wrapped key fails its integrity check.
  async unlock(passphrase) {
    const m = meta();
    if (!m) return false;
    try {
      const master = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv) }, await wrappingKey(passphrase, unb64(m.salt), m.rounds), unb64(m.wrapped));
      await open(new Uint8Array(master));
      return true;
    } catch { return false; }
  },
  lock() { encKey = macKey = null; },
  remove() { this.lock(); localStorage.removeItem(META); },

  // Encrypt bytes. `label` ties the result to where it is stored, so a record
  // moved to another place fails to open. Output: 12-byte nonce, then ciphertext.
  async seal(bytes, label) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(label) }, encKey, bytes);
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv);
    out.set(new Uint8Array(ct), 12);
    return out;
  },
  async open(sealed, label) {
    const all = new Uint8Array(sealed);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: te.encode(label) }, encKey, all.subarray(12)));
  },
  // What a record is stored under: a keyed hash, so file names are not readable either.
  async name(text) {
    return [...new Uint8Array(await subtle.sign('HMAC', macKey, te.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  },
};
