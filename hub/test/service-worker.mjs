// Run with node test/service-worker.mjs. No server or live browser storage.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const events = {}, messages = [], held = new Map();
let active = 0, peak = 0, calls = 0, body = 'same bytes', tag = 'new-gzip-tag', status = 200;
let policy = null;
const cache = {
  match: async (key) => held.get(key)?.clone(),
  put: async (key, response) => { held.set(key, response); },
};
const context = vm.createContext({
  Response, URL, Uint8Array, AbortController, setTimeout, clearTimeout,
  location: { origin: 'https://hub.test' },
  caches: { open: async () => cache },
  self: {
    addEventListener: (name, fn) => { events[name] = fn; },
    clients: { matchAll: async () => [{ postMessage: (m) => messages.push(m) }] },
    skipWaiting: async () => {},
  },
  fetch: async () => {
    calls++; peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return new Response(body, { status, headers: { etag: tag, ...(policy ? { 'content-security-policy': policy } : {}) } });
  },
});
vm.runInContext(await readFile(new URL('../sw.js', import.meta.url), 'utf8'), context);
context.cache = cache;
context.heldResponse = new Response(body, { headers: { etag: 'old-plain-tag' } });
await vm.runInContext("refresh(cache, '/app.js', heldResponse)", context);
assert.equal(messages.length, 0, 'representation-only tag change must stay quiet');
policy = "connect-src 'self' https://other-hub.test";
await vm.runInContext("refresh(cache, '/app.js', heldResponse)", context);
assert.equal(messages.length, 1, 'policy change must still announce an update');
policy = null; messages.length = 0;
body = 'changed script';
await vm.runInContext("refresh(cache, '/app.js', heldResponse)", context);
assert.equal(messages.length, 1, 'changed bytes must announce an update');
assert.equal(messages[0].path, '/app.js');
calls = 0;
await vm.runInContext("Promise.all([refresh(cache, '/a', null), refresh(cache, '/b', null), refresh(cache, '/a', null)])", context);
assert.equal(peak, 1, 'background transfers must be serialized');
assert.equal(calls, 2, 'concurrent requests for one asset share a refresh');
calls = 0;
let installing;
events.install({ waitUntil: (promise) => { installing = promise; } });
await installing;
assert.equal(calls, 11, 'install fetches shell only; engine stays lazy');
status = 503;
events.install({ waitUntil: (promise) => { installing = promise; } });
await assert.rejects(installing, /Shell file unavailable/);
console.log('Service worker: 7 checks passed');
