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

// One transfer at a time: a board also needs sockets, internal RAM and airtime
// for audio. PDF/engine files are cached when used, rather than all at install.
self.addEventListener('install', (e) => e.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  for (const key of SHELL) {
    const response = await refresh(cache, key, null);
    if (!response.ok) throw new Error(`Shell file unavailable: ${key}`);
  }
  await self.skipWaiting();
})()));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // PDF.js's character maps and standard typefaces: many small files, of which a PDF needs one or two. Each is kept the
  // first time it is fetched, so a PDF kept on the device that needs it is drawn right without the server. The two
  // reading typefaces likewise (/vendor/fonts/): the one chosen is kept once it has been used.
  if (e.request.method === 'GET' && url.origin === location.origin && (url.pathname.startsWith('/vendor/pdfjs/') || url.pathname.startsWith('/vendor/fonts/'))) {
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
let refreshTail = Promise.resolve();
const refreshing = new Map();
function refresh(cache, key, held) {
  if (refreshing.has(key)) return refreshing.get(key);
  const previous = held && held.clone(); // the browser may consume held while this waits
  const pending = refreshTail.then(() => refreshOne(cache, key, previous));
  refreshTail = pending.catch(() => {});
  refreshing.set(key, pending);
  pending.then(() => refreshing.delete(key), () => refreshing.delete(key));
  return pending;
}
async function refreshOne(cache, key, held) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), WAIT);
  try {
    // 'no-cache': the browser asks the server whether its copy is still current, and only a changed file is sent again.
    const r = await fetch(key, { signal: ctl.signal, cache: 'no-cache' });
    if (!r.ok) return r;
    await cache.put(key, r.clone());
    const was = held && held.headers.get('etag'), now = r.headers.get('etag');
    // Tags describe a representation (gzip/plain, timestamps), not firmware.
    // Fetch decodes gzip: compare actual bytes before claiming a page update.
    if (held && was && now && was !== now) {
      const before = new Uint8Array(await held.arrayBuffer()), after = new Uint8Array(await r.clone().arrayBuffer());
      if (held.headers.get('content-security-policy') !== r.headers.get('content-security-policy') ||
          before.length !== after.length || before.some((b, i) => b !== after[i]))
        for (const c of await self.clients.matchAll()) c.postMessage({ type: 'page-updated', path: key });
    }
    return r;
  } finally { clearTimeout(timer); }
}
