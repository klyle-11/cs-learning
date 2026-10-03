// The service worker: it keeps a copy of the page itself (the HTML, its
// scripts, the icons) so the reader opens when the server is out of reach.
// Documents, notes and media are not its business; app.js keeps those.
//
// The server is always asked first, so a change to the page shows up on the
// next load. Only if it does not answer within a few seconds is the kept copy
// used, and then for a while without asking again, so that a start without
// the server waits once rather than once per file.
const CACHE = 'hub-shell-v1';
const SHELL = ['/', '/app.js', '/local.js', '/vault.js', '/vendor/marked.js', '/vendor/highlight.js', '/vendor/purify.js',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const WAIT = 2500, QUIET = 15000;
let downUntil = 0;

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(url.pathname)) return;
  e.respondWith(answer(url.pathname));
});

async function answer(key) {
  const cache = await caches.open(CACHE);
  if (Date.now() < downUntil) { const hit = await cache.match(key); if (hit) return hit; }
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), WAIT);
  try {
    const r = await fetch(key, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    downUntil = 0;
    if (r.ok) await cache.put(key, r.clone());
    return r;
  } catch (err) {
    clearTimeout(timer);
    downUntil = Date.now() + QUIET;
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}
