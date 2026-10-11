// The ESP32 is a file store, not the full hub server. This adapter presents
// the small store API as the endpoints the reader already uses. It is dormant
// unless /api/device explicitly says `store: true`.

const JSON_TYPE = { 'Content-Type': 'application/json' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { ...JSON_TYPE, ...headers } });
const error = (status, message) => json({ error: message }, status);
const ext = (path) => (path.match(/\.[^.\/]+$/)?.[0] || '').toLowerCase();
const READABLE = new Set(['.md', '.html', '.htm', '.xhtml', '.c', '.h', '.cpp', '.hpp', '.cc', '.py', '.js', '.ts', '.rs', '.go', '.java', '.sh']);
const MEDIA = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.m4v', '.mov', '.webm', '.ogv', '.mp3', '.m4a', '.wav', '.ogg']);
const LINKS = new Set(['.txt', '.json', '.jsonl', '.ndjson', '.csv']);
const basename = (path) => path.split('/').pop() || path;
const folderOf = (path) => path.split('/').slice(0, -1).join('/');
const rawUrl = (path) => '/raw/' + path.split('/').map(encodeURIComponent).join('/');
const h1 = (text) => text.match(/^#[ \t]+(.+?)\s*$/m)?.[1]?.trim() || '';
const htmlTitle = (text) => {
  try { return new DOMParser().parseFromString(text, 'text/html').querySelector('title,h1')?.textContent?.trim() || ''; }
  catch { return ''; }
};
const titleOf = (path, text) => ext(path) === '.md' ? h1(text) : /\.x?html?$/.test(path) ? htmlTitle(text) : basename(path);
const stampPart = (field) => field === 'text' ? 'text' : field === 'type' ? 'type' : ['quote', 'heading', 'headingText', 'anchor', 'mg'].includes(field) ? 'place' : null;
const linkKind = (url) => /\.(png|jpe?g|gif|webp|svg)(?:[?#]|$)/i.test(url) ? 'image'
  : /\.(mp4|m4v|mov|webm|ogv)(?:[?#]|$)/i.test(url) ? 'video'
  : /\.(mp3|m4a|wav|ogg)(?:[?#]|$)/i.test(url) ? 'audio' : 'page';
function linksIn(text) {
  const urls = [...text.matchAll(/https?:\/\/[^\s"'<>()[\]{}]+/gi)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
  return [...new Set(urls)].slice(0, 200).map((url) => {
    const kind = linkKind(url), media = kind === 'page' ? [] : [{ url, kind }];
    return { title: '', thumb: kind === 'image' ? url : '', preview: '', page: kind === 'page' ? url : '', media };
  });
}

// A separate, tiny database keeps only listing metadata. It does not mix title
// records with the document copies managed by local.js.
const titles = {
  open() {
    return (this.promise ||= new Promise((resolve) => {
      try {
        const request = indexedDB.open('hub-store', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('titles', { keyPath: 'key' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch { resolve(null); }
    }));
  },
  async run(mode, action) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction('titles', mode), request = action(tx.objectStore('titles'));
      tx.oncomplete = () => resolve(request?.result ?? null);
      tx.onerror = tx.onabort = () => resolve(null);
    });
  },
  get(key) { return this.run('readonly', (s) => s.get(key)); },
  put(value) { return this.run('readwrite', (s) => s.put(value)); },
};

function cleanConfig(value, origin) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (!Array.isArray(config.side)) config.side = [];
  if (!Array.isArray(config.ignore)) config.ignore = ['CLAUDE.md'];
  if (!Array.isArray(config.highlights) || !config.highlights.length) config.highlights = [
    { id: 'yellow', name: 'Highlight', color: '#fbeeb0' },
    { id: 'question', name: 'Question', color: '#b9dcff' },
    { id: 'unclear', name: 'Unclear', color: '#ffc8c8' },
  ];
  config.root = 'store:' + origin;
  config.workspace = 'store';
  return config;
}

function applyNote(notes, method, id, body) {
  if (method === 'POST') {
    const found = notes.find((n) => n.id === body.id);
    if (found) return found;
    const note = { heading: '', headingText: '', quote: '', type: '', text: '', ...body };
    delete note.at;
    note.status ||= note.text ? 'open' : 'highlight';
    if (body.at) note.stamps = { text: body.at, type: body.at, place: body.at };
    notes.push(note);
    return note;
  }
  const at = notes.findIndex((n) => n.id === id);
  if (at < 0) return null;
  if (method === 'DELETE') { notes.splice(at, 1); return { ok: true }; }
  const note = notes[at], when = body.at;
  for (const [field, value] of Object.entries(body)) {
    const part = stampPart(field);
    if (!part) continue;
    if (when && note.stamps?.[part] && when <= note.stamps[part]) continue;
    note[field] = value;
    if (when) (note.stamps ||= {})[part] = when;
  }
  if (note.status === 'highlight' && note.text) note.status = 'open';
  return note;
}

export class StoreMode {
  constructor(settings, copies = null) {
    this.settings = settings;
    this.copies = copies;
    this.active = false;
    this.device = null;
    this.origin = '';
    this.password = '';
    this.change = 0;
    this.pollTimer = 0;
  }

  get key() { return 'store:password:' + this.origin; }

  async detect(origin, fetcher = fetch) {
    this.active = false;
    this.origin = origin || location.origin;
    try {
      const response = await fetcher((origin || '') + '/api/device', { cache: 'no-store' });
      if (!response.ok) return false;
      const device = await response.json();
      if (device?.store !== true) return false;
      this.active = true;
      this.device = device;
      this.change = Number(device.changes) || 0;
      this.password = this.settings.get(this.key) || '';
      this.tellWorker();
      return true;
    } catch { return false; }
  }

  tellWorker() {
    if (!this.active || !('serviceWorker' in navigator)) return;
    const message = { type: 'store-password', origin: new URL(this.origin, location.href).origin, password: this.password };
    navigator.serviceWorker.controller?.postMessage(message);
    navigator.serviceWorker.ready.then((r) => r.active?.postMessage(message)).catch(() => {});
  }

  rememberPassword(password) {
    this.password = password;
    this.settings.set(this.key, password);
    this.tellWorker();
  }

  forgetPassword() {
    this.rememberPassword('');
  }

  // The page supplies its existing gate helpers; all store-specific wording
  // and password/setup behaviour remains in this module.
  askPassword({ showGate, field, onEnter, closeGate }) {
    const setup = !this.device?.passwordSet;
    showGate(setup ? 'Set up this store' : 'Unlock this store', (card) => {
      const rows = [], msg = document.createElement('p'), go = document.createElement('button');
      msg.className = 'say';
      go.className = 'main';
      go.textContent = setup ? 'Set password' : 'Unlock';
      let code, pass, again;
      if (setup) {
        let row;
        [row, code] = field('Setup code'); rows.push(row);
        code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.placeholder = '000000';
      }
      let row;
      [row, pass] = field(setup ? 'New password' : 'Password', 'password'); rows.push(row);
      if (setup) { [row, again] = field('The same password again', 'password'); rows.push(row); pass.autocomplete = again.autocomplete = 'new-password'; }
      const submit = async () => {
        msg.textContent = '';
        if (pass.value.length < 8 || pass.value.length > 128) return (msg.textContent = 'Use 8 to 128 characters.');
        if (setup && pass.value !== again.value) return (msg.textContent = 'The two passwords do not match.');
        go.disabled = true;
        try {
          if (setup) {
            const response = await fetch(this.origin + '/api/password', { method: 'POST', headers: JSON_TYPE, body: JSON.stringify({ code: code.value, password: pass.value }) });
            if (!response.ok) { msg.textContent = response.status === 403 ? 'That setup code is not the one on the board.' : 'The board did not accept that password.'; return; }
          } else {
            const response = await fetch(this.origin + '/api/list?path=', { headers: { Authorization: 'Bearer ' + pass.value } });
            if (!response.ok) { msg.textContent = response.status === 401 ? 'That password is not right.' : 'The board did not accept it.'; return; }
          }
          this.rememberPassword(pass.value);
          closeGate();
          location.reload();
        } catch { msg.textContent = 'The store is not reachable.'; }
        finally { go.disabled = false; }
      };
      go.onclick = submit;
      onEnter(setup ? again : pass, submit);
      card.append(document.createElement('p'), ...rows, go, msg);
      card.firstChild.textContent = setup
        ? 'Enter the six-digit code shown on the board, then choose the password this browser will keep for it.'
        : 'Enter the password for this board. This browser keeps it with this hub’s other settings.';
    }, false);
  }

  headers(opts = {}) {
    return { ...opts.headers, ...(this.password ? { Authorization: 'Bearer ' + this.password } : {}) };
  }

  async direct(path, opts, fetcher) {
    return fetcher(this.origin + path, { ...opts, headers: this.headers(opts) });
  }

  async read(path, fetcher) {
    const response = await this.direct(rawUrl(path), {}, fetcher);
    return { response, etag: response.headers.get('etag') || '', text: response.ok ? await response.text() : '' };
  }

  async write(path, body, etag, fetcher, type = 'application/octet-stream') {
    const headers = { 'Content-Type': type, ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) };
    return this.direct(rawUrl(path), { method: 'PUT', headers, body }, fetcher);
  }

  async jsonFile(path, fallback, fetcher) {
    const got = await this.read(path, fetcher);
    if (got.response.status === 404) return { value: structuredClone(fallback), etag: '' };
    if (!got.response.ok) throw Object.assign(new Error('could not read ' + path), { status: got.response.status });
    try { return { value: JSON.parse(got.text), etag: got.etag }; }
    catch { throw Object.assign(new Error(path + ' is not valid JSON'), { status: 500 }); }
  }

  async updateJson(path, fallback, change, fetcher) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.jsonFile(path, fallback, fetcher), value = change(current.value);
      const response = await this.write(path, JSON.stringify(value, null, 2) + '\n', current.etag, fetcher, 'application/json');
      if (response.status === 412) continue;
      return { response, value };
    }
    return { response: error(409, 'the file kept changing; try again') };
  }

  async list(path, fetcher, hidden = false) {
    const query = '/api/list?path=' + encodeURIComponent(path) + (hidden ? '&hidden=1' : '');
    const response = await this.direct(query, {}, fetcher);
    if (!response.ok) throw Object.assign(new Error('could not list ' + (path || 'the store')), { status: response.status });
    return response.json();
  }

  async walk(fetcher, start = '') {
    const files = [], queue = [start];
    while (queue.length) {
      const folder = queue.shift(), entries = await this.list(folder, fetcher);
      for (const entry of entries) {
        const path = folder ? folder + '/' + entry.name : entry.name;
        if (entry.dir) { if (entry.name !== 'notes' && entry.name !== 'node_modules' && !entry.name.startsWith('.')) queue.push(path); }
        else files.push({ ...entry, path });
      }
    }
    return files;
  }

  async startOf(file, fetcher) {
    const response = await this.direct(rawUrl(file.path), { headers: { Range: 'bytes=0-4095' } }, fetcher);
    return response.ok ? response.text() : '';
  }

  async bookDocs(file, side) {
    const key = this.origin + '|' + file.path, cached = await titles.get(key);
    if (cached?.size === file.size && cached?.mtime === file.mtime && Array.isArray(cached.pages)) return cached.pages;
    let engine = null;
    try {
      const { Engine } = await import('/vendor/marginalia/index.js');
      engine = new Engine(() => new Worker('/js/engine-worker.js', { type: 'module' }));
      const summary = await engine.open({ url: this.origin + rawUrl(file.path) }, { fingerprint: '0'.repeat(64) });
      const bookTitle = summary.info?.title || basename(file.path).replace(/\.epub$/i, '');
      const pages = (summary.units || []).filter((unit) => unit.href).map((unit) => ({
        path: file.path + '/' + unit.href,
        group: file.path,
        title: unit.title || unit.label || basename(unit.href).replace(/\.x?html?$/i, ''),
        bookTitle,
        side,
        front: false,
      }));
      await titles.put({ key, path: file.path, size: file.size, mtime: file.mtime, title: bookTitle, pages });
      return pages;
    } catch { return []; }
    finally { engine?.close(); }
  }

  async docs(fetcher) {
    const config = cleanConfig((await this.jsonFile('hub.json', {}, fetcher)).value, this.origin);
    const ignored = new Set(config.ignore || []), out = [];
    for (const file of await this.walk(fetcher)) {
      if (ignored.has(file.path) || ignored.has(file.name) || [...ignored].some((x) => x.endsWith('/') && file.path.startsWith(x))) continue;
      const ending = ext(file.path), ordinary = READABLE.has(ending) || MEDIA.has(ending) || file.name === 'Makefile';
      const side = (config.side || []).some((x) => file.path === x || (x.endsWith('/') && file.path.startsWith(x)));
      if (ending === '.epub') { out.push(...await this.bookDocs(file, side)); continue; }
      if (!ordinary && !LINKS.has(ending)) continue;
      const cacheKey = this.origin + '|' + file.path, cached = await titles.get(cacheKey);
      let title = cached?.size === file.size && cached?.mtime === file.mtime ? cached.title : '', links = cached?.size === file.size && cached?.mtime === file.mtime ? !!cached.links : false;
      if (!title || (LINKS.has(ending) && cached == null)) {
        const start = await this.startOf(file, fetcher);
        title = ordinary ? (titleOf(file.path, start) || basename(file.path)) : basename(file.path);
        links = (LINKS.has(ending) || /\.x?html?$/.test(file.path)) && /https?:\/\/[^\s"'<>]+/i.test(start);
        await titles.put({ key: cacheKey, path: file.path, size: file.size, mtime: file.mtime, title, links });
      }
      if (!ordinary && !links) continue;
      out.push({ path: file.path, group: folderOf(file.path), title, side, front: file.path === 'FRONTPAGE.md', changed: file.mtime, ...(links ? { links: true } : {}) });
    }
    return out;
  }

  async config(fetcher) {
    const config = cleanConfig((await this.jsonFile('hub.json', {}, fetcher)).value, this.origin);
    const front = await this.read('FRONTPAGE.md', fetcher);
    config.front = front.response.ok ? 'FRONTPAGE.md' : null;
    if (front.response.ok && h1(front.text)) config.title = h1(front.text);
    config.title ||= 'Hub';
    return config;
  }

  async search(words, fetcher) {
    const q = words.toLowerCase(), docs = await this.docs(fetcher), hits = [], work = docs.filter((d) => READABLE.has(ext(d.path)) || basename(d.path) === 'Makefile');
    let next = 0;
    const worker = async () => {
      while (next < work.length && hits.length < 60) {
        const doc = work[next++], key = 'store:' + this.origin + '|' + doc.path;
        let text = (await this.copies?.get('docs', key))?.text;
        if (text == null) {
          const response = await this.direct(rawUrl(doc.path), {}, fetcher);
          if (!response.ok) continue;
          text = await response.text();
          await this.copies?.put('docs', { key, root: 'store:' + this.origin, path: doc.path, text, ts: Date.now() });
        }
        const lines = text.split('\n');
        let inDoc = 0;
        for (let i = 0; i < lines.length && inDoc < 3 && hits.length < 60; i++) {
          const at = lines[i].toLowerCase().indexOf(q);
          if (at < 0) continue;
          hits.push({ path: doc.path, line: i + 1, text: lines[i].slice(Math.max(0, at - 60), at + q.length + 100).trim() });
          inDoc++;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return hits;
  }

  async removeTree(path, fetcher) {
    const entries = await this.list(path, fetcher, true).catch(() => []);
    for (const entry of entries) {
      const child = path + '/' + entry.name;
      if (entry.dir) await this.removeTree(child, fetcher);
      await this.direct(rawUrl(child), { method: 'DELETE' }, fetcher);
    }
    return this.direct(rawUrl(path), { method: 'DELETE' }, fetcher);
  }

  async treeSize(path, fetcher) {
    let size = 0, queue = [path];
    while (queue.length) {
      const folder = queue.shift();
      for (const entry of await this.list(folder, fetcher, true).catch(() => [])) {
        if (entry.dir) queue.push(folder + '/' + entry.name);
        else size += Number(entry.size) || 0;
      }
    }
    return size;
  }

  removedName(path) {
    const bytes = new TextEncoder().encode(path), encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return Date.now() + '-' + encoded;
  }

  removedPath(name) {
    try {
      const encoded = name.slice(name.indexOf('-') + 1).replace(/-/g, '+').replace(/_/g, '/'), bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch { return ''; }
  }

  async request(url, opts, fetcher) {
    const u = new URL(url, location.href), method = opts.method || 'GET';
    if (u.pathname === '/api/session') return this.password ? json({ device: { name: 'ESP32 store' } }) : error(401, 'password required');
    if (u.pathname === '/api/workspaces') return json([]);
    if (u.pathname === '/api/storage') return json({ used: Math.max(0, (this.device?.total || 0) - (this.device?.free || 0)), quota: this.device?.total || 0, free: this.device?.free || 0 });
    if (u.pathname === '/api/docs') return json(await this.docs(fetcher));
    if (u.pathname === '/api/doc') return this.direct(rawUrl(u.searchParams.get('path') || ''), opts, fetcher);
    if (u.pathname === '/api/search') return json(await this.search(u.searchParams.get('q') || '', fetcher));
    if (u.pathname === '/api/links') {
      const response = await this.direct(rawUrl(u.searchParams.get('path') || ''), {}, fetcher);
      if (!response.ok) return response;
      const items = linksIn(await response.text());
      return json({ items, more: items.length === 200 });
    }
    if (u.pathname === '/api/sha256') {
      const response = await this.direct(rawUrl(u.searchParams.get('path') || ''), {}, fetcher);
      if (!response.ok) return response;
      const body = await response.arrayBuffer(), hash = await crypto.subtle.digest('SHA-256', body);
      return json({ path: u.searchParams.get('path'), size: body.byteLength, sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('') });
    }
    if (u.pathname === '/api/config' && method === 'GET') return json(await this.config(fetcher));
    if (u.pathname === '/api/config' && method === 'PUT') {
      const patch = JSON.parse(opts.body || '{}');
      const saved = await this.updateJson('hub.json', {}, (config) => ({ ...config, ...patch }), fetcher);
      return saved.response.ok ? json(await this.config(fetcher)) : saved.response;
    }
    if (u.pathname === '/api/front' && method === 'PUT') {
      const body = JSON.parse(opts.body || '{}'), path = body.folder ? body.folder + '/FRONTPAGE.md' : 'FRONTPAGE.md', current = await this.read(path, fetcher);
      const response = await this.write(path, String(body.markdown || '').replace(/\n?$/, '\n'), current.response.ok ? current.etag : '', fetcher, 'text/markdown');
      return response.ok ? json(await this.config(fetcher)) : response;
    }
    if (u.pathname === '/api/notes' && method === 'GET') return json((await this.jsonFile('notes/notes.json', [], fetcher)).value);
    if ((u.pathname === '/api/notes' && method === 'POST') || (u.pathname.startsWith('/api/notes/') && ['PUT', 'DELETE'].includes(method))) {
      const id = decodeURIComponent(u.pathname.slice('/api/notes/'.length)), body = opts.body ? JSON.parse(opts.body) : {};
      let answer = null;
      const saved = await this.updateJson('notes/notes.json', [], (notes) => { answer = applyNote(notes, method, id, body); return notes; }, fetcher);
      if (!answer) return error(404, 'no such note');
      return saved.response.ok ? json(answer) : saved.response;
    }
    if (u.pathname === '/api/upload' && method === 'POST') {
      const path = u.searchParams.get('path') || '', replace = u.searchParams.get('replace') === '1';
      let etag = '';
      if (replace) {
        const current = await this.direct(rawUrl(path), { headers: { Range: 'bytes=0-0' } }, fetcher);
        if (!current.ok) return current;
        etag = current.headers.get('etag') || '';
      }
      const response = await this.direct(rawUrl(path), { method: 'PUT', headers: replace && etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }, body: opts.body }, fetcher);
      // The full server's upload endpoint calls an existing fresh file
      // "skipped". Keep that UI contract while the store expresses it as 412.
      if (!replace && response.status === 412) return json({ path, skipped: true });
      const said = await response.clone().json().catch(() => ({}));
      return response.ok ? json({ ...said, path, saved: !replace, replaced: replace }) : response;
    }
    if (u.pathname === '/api/files') {
      const base = u.searchParams.get('path') || '', files = await this.walk(fetcher, base);
      return json(files.map((f) => ({ path: f.path, size: f.size, changed: f.mtime })));
    }
    if (u.pathname === '/api/folder' && method === 'DELETE') {
      const from = u.searchParams.get('path') || '', undo = this.removedName(from), response = await this.direct('/api/move', { method: 'POST', headers: JSON_TYPE, body: JSON.stringify({ from, to: '.removed/' + undo }) }, fetcher);
      return response.ok ? json({ removed: true, undo }) : response;
    }
    if (u.pathname === '/api/folder/restore' && method === 'POST') {
      const undo = JSON.parse(opts.body || '{}').undo, to = this.removedPath(undo), response = await this.direct('/api/move', { method: 'POST', headers: JSON_TYPE, body: JSON.stringify({ from: '.removed/' + undo, to }) }, fetcher);
      return response.ok ? json({ restored: undo }) : response;
    }
    if (u.pathname === '/api/removed' && method === 'GET') {
      const list = await this.list('.removed', fetcher, true).catch(() => []);
      const removed = [];
      for (const entry of list.filter((e) => e.dir)) removed.push({ undo: entry.name, from: this.removedPath(entry.name), at: new Date(Number(entry.name.split('-')[0]) || 0).toISOString(), size: await this.treeSize('.removed/' + entry.name, fetcher), locked: false });
      return json(removed.filter((e) => e.from));
    }
    if (u.pathname === '/api/removed' && method === 'DELETE') return this.removeTree('.removed/' + (u.searchParams.get('undo') || ''), fetcher);
    // The small store endpoints, /raw files, and future additions pass through.
    return this.direct(u.pathname + u.search, opts, fetcher);
  }

  listen(onChange, onError) {
    clearInterval(this.pollTimer);
    const poll = async () => {
      if (document.hidden) return;
      try {
        const response = await this.direct('/api/changes?since=' + encodeURIComponent(this.change), { cache: 'no-store' }, fetch);
        if (!response.ok) throw new Error('changes failed');
        const said = await response.json(), before = this.change;
        this.change = Number(said.changes) || this.change;
        if (said.all && this.change !== before) onChange({ all: true, paths: [] });
        else if (said.paths?.length) onChange({ all: false, paths: said.paths });
      } catch (e) { onError(e); }
    };
    this.pollTimer = setInterval(poll, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }
}
