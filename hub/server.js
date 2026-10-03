// Local markdown reader with a notes layer. Point it at any folder of .md files
// (source code files are listed too, shown as a code block):
//   node server.js [folder]      (default: ../data, the live workspace, which is
//                                 not in git; first run fills it from ../sample)
// Per-folder settings live in <folder>/hub.json, notes in <folder>/notes/notes.json.
const http = require('http');
const fs = require('fs');
const path = require('path');

// HOME is the folder the hub was started on. Uploaded folders can be opened as
// workspaces of their own; those are kept in hub/workspaces/ and ROOT points at
// whichever one is open.
const DATA = path.join(__dirname, '..', 'data'), SAMPLE = path.join(__dirname, '..', 'sample');
const HOME = path.resolve(process.argv[2] || process.env.HUB_ROOT || DATA);
// The live workspace starts as a copy of the sample content that ships with the code.
if (HOME === DATA && !fs.existsSync(DATA)) {
  if (fs.existsSync(SAMPLE)) fs.cpSync(SAMPLE, DATA, { recursive: true }); else fs.mkdirSync(DATA, { recursive: true });
}
const WORKSPACES = path.join(__dirname, 'workspaces');
const CURRENT = path.join(WORKSPACES, '.current');
const MAX_UPLOAD = 50 * 1024 * 1024;
let ROOT, NOTES, CONFIG, watcher;
const FRONT = 'FRONTPAGE.md';
const PORT = process.env.PORT || 4321;
const SKIP_DIRS = new Set(['node_modules', 'notes']);
const CODE = new Set(['.c', '.h', '.cpp', '.hpp', '.cc', '.py', '.js', '.ts', '.rs', '.go', '.java', '.sh']);
const MIME = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
// Pictures, video and sound are listed too; the reader shows them in a viewer.
const MEDIA = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.m4v', '.mov', '.webm', '.ogv', '.mp3', '.m4a', '.wav', '.ogg']);
const isMedia = (name) => MEDIA.has(path.extname(name).toLowerCase());
const MAX_RANGE = 4 * 1024 * 1024; // most bytes sent in answer to one partial request
const withCharset = (type) => (/^text\/|javascript|json/.test(type) ? type + '; charset=utf-8' : type);
const isHtml = (name) => /\.html?$/.test(name);
const readable = (name) => name.endsWith('.md') || isHtml(name) || CODE.has(path.extname(name)) || name === 'Makefile';

// title: shown in the sidebar and tab.  side: files or folders ("refs.md",
// "responses/") that open in the side pane.  ignore: paths left out entirely.
function readConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
  const cfg = { title: path.basename(ROOT), side: [], ignore: ['CLAUDE.md'], highlights: HIGHLIGHTS, ...c, front: null, root: ROOT };
  if (!Array.isArray(cfg.highlights) || !cfg.highlights.length) cfg.highlights = HIGHLIGHTS;
  // FRONTPAGE.md, when present, is the landing page and its first heading is the title.
  try {
    const h1 = fs.readFileSync(path.join(ROOT, FRONT), 'utf8').match(/^#\s+(.+)$/m);
    cfg.front = FRONT;
    if (h1) cfg.title = h1[1].trim();
  } catch {}
  return cfg;
}
// Highlight types: a colour and a name the user can change.
const HIGHLIGHTS = [
  { id: 'important', name: 'Important', color: '#fbeeb0' },
  { id: 'definition', name: 'Definition', color: '#cfe8c6' },
  { id: 'question', name: 'Question', color: '#cfe0f5' },
  { id: 'unclear', name: 'Unclear', color: '#f6d0d6' },
];
const matches = (rel, list) => list.some((x) => rel === x || path.basename(rel) === x || (x.endsWith('/') && (rel + '/').startsWith(x)));

function readNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES, 'utf8')); } catch { return []; }
}
function writeNotes(notes) {
  fs.mkdirSync(path.dirname(NOTES), { recursive: true });
  fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2) + '\n');
}

// Only markdown and source files inside ROOT may be read.
function safeDoc(rel) {
  const abs = path.resolve(ROOT, rel || '');
  if (!abs.startsWith(ROOT + path.sep) || !readable(path.basename(abs))) return null;
  return fs.existsSync(abs) ? abs : null;
}

function titleOf(abs) {
  if (isHtml(abs)) {
    const t = fs.readFileSync(abs, 'utf8').match(/<title[^>]*>([^<]+)<\/title>/i);
    return t ? t[1].trim() : path.basename(abs);
  }
  if (!abs.endsWith('.md')) return path.basename(abs);
  const m = fs.readFileSync(abs, 'utf8').match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : path.basename(abs, '.md');
}

function listDocs() {
  const cfg = readConfig();
  const docs = [];
  (function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.name.startsWith('.') || matches(r, cfg.ignore)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || abs === __dirname) continue;
        walk(abs, r);
      } else if (readable(e.name) || isMedia(e.name)) {
        docs.push({ path: r, group: rel, title: titleOf(abs), side: matches(r, cfg.side), front: r === FRONT });
      }
    }
  })(ROOT, '');
  return docs;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': withCharset(type), 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('file too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// A relative path from an upload, made safe: no "..", no dot-files, no absolute paths.
function cleanRel(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((x) => x === '..' || x.startsWith('.') || x === 'node_modules')) return null;
  return parts;
}
const cleanName = (name) => String(name || '').replace(/[^\w .-]+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80);

function listWorkspaces() {
  const list = [{ name: path.basename(HOME), root: HOME, home: true }];
  if (fs.existsSync(WORKSPACES)) {
    for (const e of fs.readdirSync(WORKSPACES, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) list.push({ name: e.name, root: path.join(WORKSPACES, e.name), home: false });
    }
  }
  return list.map((w) => ({ ...w, current: w.root === ROOT }));
}

// Live reload: tell open pages which file changed.
const clients = new Set();
let timers = {};
function setRoot(root) {
  ROOT = root;
  NOTES = path.join(ROOT, 'notes', 'notes.json');
  CONFIG = path.join(ROOT, 'hub.json');
  if (watcher) watcher.close();
  const inHub = (file) => ROOT === HOME && path.join(ROOT, file).startsWith(__dirname + path.sep);
  watcher = fs.watch(ROOT, { recursive: true }, (_evt, file) => {
    if (!file || /(^|\/)(\.|node_modules\/)/.test(file) || inHub(file)) return;
    clearTimeout(timers[file]);
    timers[file] = setTimeout(() => {
      for (const res of clients) res.write(`data: ${JSON.stringify({ file })}\n\n`);
    }, 150);
  });
}
// Start on the workspace that was open last time, if it still exists.
(() => {
  let last = '';
  try { last = fs.readFileSync(CURRENT, 'utf8').trim(); } catch {}
  const ws = last && path.join(WORKSPACES, last);
  setRoot(ws && fs.existsSync(ws) ? ws : HOME);
})();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // A page on another website must not be able to change anything here. Browsers
    // put the calling site in the Origin header; if it is not this server, refuse.
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && origin !== 'null' && new URL(origin).host !== req.headers.host) {
      return send(res, 403, { error: 'requests from other sites are not allowed' });
    }
    if (req.method !== 'GET' && origin === 'null') return send(res, 403, { error: 'requests from other sites are not allowed' });
    if (p === '/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html');
    if (p === '/vendor/marked.js') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'node_modules/marked/lib/marked.umd.js')), 'text/javascript');
    }
    if (p === '/vendor/highlight.js') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'node_modules/@highlightjs/cdn-assets/highlight.min.js')), 'text/javascript');
    }
    // Files as they are on disk: HTML documents shown in a frame, and the
    // images, styles and scripts that they or the markdown files refer to.
    if (p.startsWith('/raw/')) {
      const abs = path.resolve(ROOT, decodeURIComponent(p.slice(5)));
      if (!abs.startsWith(ROOT + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: 'no such file' });
      // Sent as a stream, and in pieces when asked (Range), which is what lets a
      // browser play and seek video and read a large PDF a part at a time.
      const size = fs.statSync(abs).size;
      const head = { 'Content-Type': withCharset(MIME[path.extname(abs).toLowerCase()] || 'text/plain'), 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) { res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }); return res.end(); }
        end = Math.min(end, start + MAX_RANGE - 1);
        res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        return fs.createReadStream(abs, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...head, 'Content-Length': size });
      return fs.createReadStream(abs).pipe(res);
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/workspaces') return send(res, 200, listWorkspaces());
    // Switch to another workspace: the home folder, or one made from an upload.
    if (p === '/api/workspace' && req.method === 'POST') {
      const b = await readBody(req);
      const target = listWorkspaces().find((w) => w.root === b.root);
      if (!target) return send(res, 404, { error: 'no such workspace' });
      setRoot(target.root);
      fs.mkdirSync(WORKSPACES, { recursive: true });
      fs.writeFileSync(CURRENT, target.home ? '' : target.name);
      return send(res, 200, listWorkspaces());
    }
    // One file of an uploaded folder. to=here adds it to the open workspace
    // (existing files are never overwritten); to=<name> puts it in a workspace
    // of its own, created on first use.
    if (p === '/api/upload' && req.method === 'POST') {
      const parts = cleanRel(url.searchParams.get('path'));
      const ws = url.searchParams.get('workspace');
      const base = ws ? path.join(WORKSPACES, cleanName(ws)) : ROOT;
      if (!parts || (ws && !cleanName(ws))) return send(res, 400, { error: 'bad path' });
      const abs = path.join(base, ...parts);
      if (!abs.startsWith(base + path.sep)) return send(res, 400, { error: 'bad path' });
      const data = await readRaw(req, MAX_UPLOAD);
      if (fs.existsSync(abs)) return send(res, 200, { skipped: true });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      return send(res, 200, { saved: true, root: base });
    }
    if (p === '/api/docs') return send(res, 200, listDocs());
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, readConfig());
    if (p === '/api/config' && req.method === 'PUT') {
      const b = await readBody(req);
      const { front, root, ...cfg } = readConfig();
      const title = typeof b.title === 'string' && b.title.replace(/\s+/g, ' ').trim();
      if (title && front) {
        const abs = path.join(ROOT, front);
        const md = fs.readFileSync(abs, 'utf8');
        fs.writeFileSync(abs, /^#\s+.+$/m.test(md) ? md.replace(/^#\s+.+$/m, () => '# ' + title) : `# ${title}\n\n${md}`);
      } else if (title) {
        cfg.title = title;
      }
      if (Array.isArray(b.highlights)) {
        cfg.highlights = b.highlights
          .filter((t) => t && t.id && /^#[0-9a-f]{6}$/i.test(t.color))
          .map((t) => ({ id: String(t.id), name: String(t.name || '').trim() || 'Untitled', color: t.color }));
      }
      if (front) cfg.title = (() => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).title; } catch {} })() || cfg.title;
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
      return send(res, 200, readConfig());
    }
    if (p === '/api/doc') {
      const abs = safeDoc(url.searchParams.get('path'));
      return abs ? send(res, 200, fs.readFileSync(abs, 'utf8'), 'text/plain') : send(res, 404, { error: 'no such doc' });
    }
    // The front page is the only document the reader may write.
    if (p === '/api/front' && req.method === 'PUT') {
      const b = await readBody(req);
      if (typeof b.markdown !== 'string') return send(res, 400, { error: 'markdown required' });
      fs.writeFileSync(path.join(ROOT, FRONT), b.markdown.endsWith('\n') ? b.markdown : b.markdown + '\n');
      return send(res, 200, readConfig());
    }
    if (p === '/api/notes' && req.method === 'GET') return send(res, 200, readNotes());
    if (p === '/api/notes' && req.method === 'POST') {
      const b = await readBody(req);
      // A highlight is a note with a quote and no text yet.
      if (!b.doc || (!b.text && !b.quote)) return send(res, 400, { error: 'doc and text or quote required' });
      // A note written while the board was out of reach arrives later with the id
      // and time it was given on the device. Sending the same one twice is harmless.
      const existing = readNotes().find((n) => n.id === b.id);
      if (existing) return send(res, 200, existing);
      const ownId = typeof b.id === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(b.id);
      const ownTs = typeof b.ts === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(b.ts);
      const note = {
        id: ownId ? b.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        doc: b.doc,
        heading: b.heading || '',
        headingText: b.headingText || '',
        quote: b.quote || '',
        type: b.type || '',
        text: b.text || '',
        ts: ownTs ? b.ts : new Date().toISOString(),
        status: b.text ? 'open' : 'highlight',
      };
      const notes = readNotes();
      notes.push(note);
      writeNotes(notes);
      return send(res, 200, note);
    }
    const m = p.match(/^\/api\/notes\/([\w-]+)$/);
    if (m) {
      const notes = readNotes();
      const i = notes.findIndex((n) => n.id === m[1]);
      if (i < 0) return send(res, 404, { error: 'no such note' });
      if (req.method === 'PUT') {
        const b = await readBody(req);
        for (const k of ['text', 'quote', 'heading', 'headingText', 'type']) if (k in b) notes[i][k] = b[k];
        if (notes[i].status === 'highlight' && notes[i].text) notes[i].status = 'open';
        writeNotes(notes);
        return send(res, 200, notes[i]);
      }
      if (req.method === 'DELETE') {
        notes.splice(i, 1);
        writeNotes(notes);
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`${readConfig().title}: http://localhost:${PORT}  (reading ${ROOT})`));
