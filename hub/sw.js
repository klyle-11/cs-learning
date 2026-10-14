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
// v3: a board sent v2 under a policy that left it unable to fetch or keep anything, and a browser keeps a worker
// until its file changes; the new name also drops whatever v2 kept.
const CACHE = 'hub-shell-v3';
const SHELL = ['/', '/app.js', '/local.js', '/vault.js', '/js/store.js', '/vendor/marked.js', '/vendor/highlight.js', '/vendor/purify.js',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
// What a PDF is drawn with: kept as well, so a PDF kept on the device opens without the server. The reader installs
// without them if they cannot be had (a server from before it had them); they are then kept the first time one is drawn.
// The document engine too (selecting and highlighting on a PDF's pages): its modules, its two workers and its WebAssembly.
const ENGINE = ['index', 'client', 'worker', 'wasm/marginalia_wasm', 'selection', 'selection-engine', 'frame', 'geometry', 'overlay', 'surfaces', 'caret', 'dom', 'themes', 'recolor', 'recolor-worker']
  .map((m) => `/vendor/marginalia/${m}.js`).concat('/vendor/marginalia/ui.css', '/vendor/marginalia/wasm/marginalia_wasm_bg.wasm');
const LATER = ['/vendor/pdf.mjs', '/vendor/pdf.worker.mjs', ...ENGINE, '/js/engine-worker.js'];
const WAIT = 8000;   // how long the check behind a served file may take
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mediaKind = (url) => /\.(png|jpe?g|gif|webp|svg)(?:[?#]|$)/i.test(url) ? 'image'
  : /\.(mp4|m4v|mov|webm|ogv)(?:[?#]|$)/i.test(url) ? 'video'
  : /\.(mp3|m4a|wav|ogg)(?:[?#]|$)/i.test(url) ? 'audio' : 'page';

// The full server makes this page. In store mode the worker makes the small
// equivalent after the reader has asked permission to load the remote media.
async function storeCards(url, password) {
  const path = url.pathname.slice('/cards/'.length).split('/').map(decodeURIComponent).join('/');
  const headers = new Headers({ Authorization: 'Bearer ' + password });
  const source = await fetch('/raw/' + path.split('/').map(encodeURIComponent).join('/'), { headers });
  if (!source.ok) return source;
  const found = [...(await source.text()).matchAll(/https?:\/\/[^\s"'<>()[\]{}]+/gi)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
  let links = [...new Set(found)].slice(0, 200);
  if (url.searchParams.get('rev') === '1') links.reverse();
  const colour = (name, fallback) => /^[0-9a-f]{6}$/i.test(url.searchParams.get(name) || '') ? '#' + url.searchParams.get(name) : fallback;
  const size = Math.min(420, Math.max(70, Number(url.searchParams.get('size')) || 150));
  const cards = links.map((link, i) => {
    const safe = escapeHtml(link), kind = mediaKind(link), media = kind === 'image' ? `<img loading="lazy" src="${safe}" alt="">`
      : kind === 'video' ? `<video controls preload="metadata" src="${safe}"></video>`
      : kind === 'audio' ? `<audio controls preload="none" src="${safe}"></audio>` : '';
    return `<article id="item-${i}">${media}<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a></article>`;
  }).join('');
  const html = `<!doctype html><meta name="viewport" content="width=device-width"><style>
    :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:12px;background:${colour('paper', '#fdfcf7')};color:${colour('ink', '#1d1b16')};font:14px system-ui}.tools{position:sticky;top:0;padding:6px;background:${colour('shade', '#f4f1e8')};z-index:1}button{font:inherit}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(${size}px,1fr));gap:12px}article{min-width:0;border:1px solid ${colour('rule', '#ddd8ca')};padding:8px}img,video{display:block;width:100%;max-height:55vh;object-fit:contain;margin-bottom:6px}audio{width:100%;margin-bottom:6px}a{color:${colour('accent', '#8c2f1b')};overflow-wrap:anywhere}</style>
    <div class="tools"><button id="reverse">reverse</button></div><main class="cards">${cards || '<p>No web addresses found.</p>'}</main><script>
    reverse.onclick=()=>parent.postMessage({cardsReversed:${url.searchParams.get('rev') === '1' ? 'false' : 'true'}},location.origin);
    const wanted=new URL(location.href).searchParams.get('item');if(/^\\d+$/.test(wanted||''))document.getElementById('item-'+wanted)?.scrollIntoView();
    </script>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; img-src https:; media-src https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; navigate-to https:" } });
}

// Installing keeps the page itself. The rest is kept as each file is first used (see fetch, below), and, when the page
// asks (from a computer: see loadUploadLimit in app.js), fetched now, one file at a time: all at once they filled a
// board's four connections and its Wi-Fi for minutes, and the page's own first requests waited behind them.
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
const storePasswords = new Map();
self.addEventListener('message', (e) => {
  // Media elements and PDF.js fetch /raw files themselves, outside app.js's
  // request helper. Keep the store password only in this worker's memory and
  // add it to those requests; a restarted worker is told again by store.js.
  if (e.data?.type === 'store-password') {
    if (e.data.password) storePasswords.set(e.data.origin, e.data.password);
    else storePasswords.delete(e.data.origin);
    return;
  }
  if (e.data?.type !== 'keep-the-rest') return;
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const u of LATER) if (!(await c.match(u))) await c.add(u).catch(() => {});
  })());
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && url.pathname.startsWith('/cards/') && storePasswords.has(url.origin)) {
    e.respondWith(storeCards(url, storePasswords.get(url.origin)));
    return;
  }
  if (e.request.method === 'GET' && url.pathname.startsWith('/raw/') && storePasswords.has(url.origin)) {
    const headers = new Headers(e.request.headers);
    headers.set('Authorization', 'Bearer ' + storePasswords.get(url.origin));
    e.respondWith(fetch(new Request(e.request, { headers })));
    return;
  }
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
