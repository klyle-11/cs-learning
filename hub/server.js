// Local markdown reader with a notes layer. Point it at any folder of .md files
// (source code files are listed too, shown as a code block):
//   node server.js [folder]      (default: the folder containing hub/)
// Per-folder settings live in <folder>/hub.json, notes in <folder>/notes/notes.json.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || process.env.HUB_ROOT || path.join(__dirname, '..'));
const NOTES = path.join(ROOT, 'notes', 'notes.json');
const CONFIG = path.join(ROOT, 'hub.json');
const FRONT = 'FRONTPAGE.md';
const PORT = process.env.PORT || 4321;
const SKIP_DIRS = new Set(['node_modules', 'notes']);
const CODE = new Set(['.c', '.h', '.cpp', '.hpp', '.cc', '.py', '.js', '.ts', '.rs', '.go', '.java', '.sh']);
const MIME = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.woff2': 'font/woff2' };
const isHtml = (name) => /\.html?$/.test(name);
const readable = (name) => name.endsWith('.md') || isHtml(name) || CODE.has(path.extname(name)) || name === 'Makefile';

// title: shown in the sidebar and tab.  side: files or folders ("refs.md",
// "responses/") that open in the side pane.  ignore: paths left out entirely.
function readConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
  const cfg = { title: path.basename(ROOT), side: [], ignore: ['CLAUDE.md'], ...c, front: null, root: ROOT };
  // FRONTPAGE.md, when present, is the landing page and its first heading is the title.
  try {
    const h1 = fs.readFileSync(path.join(ROOT, FRONT), 'utf8').match(/^#\s+(.+)$/m);
    cfg.front = FRONT;
    if (h1) cfg.title = h1[1].trim();
  } catch {}
  return cfg;
}
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
      } else if (readable(e.name)) {
        docs.push({ path: r, group: rel, title: titleOf(abs), side: matches(r, cfg.side), front: r === FRONT });
      }
    }
  })(ROOT, '');
  return docs;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  });
}

// Live reload: tell open pages which file changed.
const clients = new Set();
let timers = {};
fs.watch(ROOT, { recursive: true }, (_evt, file) => {
  if (!file || /(^|\/)(\.|node_modules\/)/.test(file) || path.join(ROOT, file).startsWith(__dirname + path.sep)) return;
  clearTimeout(timers[file]);
  timers[file] = setTimeout(() => {
    for (const res of clients) res.write(`data: ${JSON.stringify({ file })}\n\n`);
  }, 150);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html');
    if (p === '/vendor/marked.js') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'node_modules/marked/lib/marked.umd.js')), 'text/javascript');
    }
    // Files as they are on disk: HTML documents shown in a frame, and the
    // images, styles and scripts that they or the markdown files refer to.
    if (p.startsWith('/raw/')) {
      const abs = path.resolve(ROOT, decodeURIComponent(p.slice(5)));
      if (!abs.startsWith(ROOT + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: 'no such file' });
      return send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs).toLowerCase()] || 'text/plain');
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/docs') return send(res, 200, listDocs());
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, readConfig());
    if (p === '/api/config' && req.method === 'PUT') {
      const b = await readBody(req);
      const title = typeof b.title === 'string' && b.title.replace(/\s+/g, ' ').trim();
      if (!title) return send(res, 400, { error: 'title required' });
      const { front, root, ...cfg } = readConfig();
      if (front) {
        const abs = path.join(ROOT, front);
        const md = fs.readFileSync(abs, 'utf8');
        fs.writeFileSync(abs, /^#\s+.+$/m.test(md) ? md.replace(/^#\s+.+$/m, () => '# ' + title) : `# ${title}\n\n${md}`);
      } else {
        fs.writeFileSync(CONFIG, JSON.stringify({ ...cfg, title }, null, 2) + '\n');
      }
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
      if (!b.text || !b.doc) return send(res, 400, { error: 'text and doc required' });
      const note = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        doc: b.doc,
        heading: b.heading || '',
        headingText: b.headingText || '',
        quote: b.quote || '',
        text: b.text,
        ts: new Date().toISOString(),
        status: 'open',
      };
      const notes = readNotes();
      notes.push(note);
      writeNotes(notes);
      return send(res, 200, note);
    }
    const m = p.match(/^\/api\/notes\/([\w]+)$/);
    if (m) {
      const notes = readNotes();
      const i = notes.findIndex((n) => n.id === m[1]);
      if (i < 0) return send(res, 404, { error: 'no such note' });
      if (req.method === 'PUT') {
        const b = await readBody(req);
        for (const k of ['text', 'quote', 'heading', 'headingText']) if (k in b) notes[i][k] = b[k];
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
