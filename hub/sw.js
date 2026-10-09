// The service worker: it keeps a copy of the page itself (the HTML, its
// scripts, the icons) so the reader opens at once, and opens when the server
// is out of reach. Documents, notes and media are not its business; app.js
// keeps those.
//
// A file it holds is handed over immediately. Behind that, the server is
// asked whether the file has changed; if it has, the new one is kept for the
// next load and the open page is told, so it can offer "reload". So every
// start is instant, with the server near, far or absent, and a change to the
// page shows one load later than it used to.
const CACHE = 'hub-shell-v1';
const SHELL = ['/', '/app.js', '/local.js', '/vault.js', '/vendor/marked.js', '/vendor/highlight.js', '/vendor/purify.js',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
// What a PDF is drawn with: kept as well, so a PDF kept on the device opens without the server. The reader installs
// without them if they cannot be had (a server from before it had them); they are then kept the first time one is drawn.
// The document engine too (selecting and highlighting on a PDF's pages): its modules, its two workers and its WebAssembly.
const ENGINE = ['index', 'client', 'worker', 'wasm/marginalia_wasm', 'selection', 'selection-engine', 'frame', 'geometry', 'overlay', 'surfaces', 'caret', 'dom', 'themes', 'recolor', 'recolor-worker']
  .map((m) => `/vendor/marginalia/${m}.js`).concat('/vendor/marginalia/ui.css', '/vendor/marginalia/wasm/marginalia_wasm_bg.wasm');
const LATER = ['/vendor/pdf.mjs', '/vendor/pdf.worker.mjs', ...ENGINE, '/js/engine-worker.js'];
const WAIT = 8000;   // how long the check behind a served file may take

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).then(() => Promise.all(LATER.map((u) => c.add(u).catch(() => {}))))).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // PDF.js's character maps and standard typefaces: many small files, of which a PDF needs one or two. Each is kept the
  // first time it is fetched, so a PDF kept on the device that needs it is drawn right without the server.
  if (e.request.method === 'GET' && url.origin === location.origin && url.pathname.startsWith('/vendor/pdfjs/')) {
    e.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(url.pathname)) || fetch(url.pathname).then((r) => { if (r.ok) cache.put(url.pathname, r.clone()); return r; })));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || !(SHELL.includes(url.pathname) || LATER.includes(url.pathname))) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE), held = await cache.match(url.pathname);
    if (!held) return refresh(cache, url.pathname, null);   // nothing kept yet: wait for the server
    e.waitUntil(refresh(cache, url.pathname, held).catch(() => {}));
    return held;
  })());
});

// Fetch a file from the server and keep it. If it differs from the copy that
// was just served, tell the open pages.
async function refresh(cache, key, held) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), WAIT);
  try {
    // 'no-cache': the browser asks the server whether its copy is still current, and only a changed file is sent again.
    const r = await fetch(key, { signal: ctl.signal, cache: 'no-cache' });
    if (!r.ok) return r;
    await cache.put(key, r.clone());
    const was = held && held.headers.get('etag'), now = r.headers.get('etag');
    if (held && was && now && was !== now) for (const c of await self.clients.matchAll()) c.postMessage({ type: 'page-updated' });
    return r;
  } finally { clearTimeout(timer); }
}
