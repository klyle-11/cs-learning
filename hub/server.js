// Local markdown reader with a notes layer. Point it at any folder of .md files
// (source code files are listed too, shown as a code block):
//   node server.js [folder]      (default: ../data, the live workspace, which is
//                                 not in git; first run fills it from ../sample)
// Per-folder settings live in <folder>/hub.json, notes in <folder>/notes/notes.json.
//
// Who may use it (see ../server-cpp/API.md, "Security"): requests must name a host
// this machine really has, must not come from another website, and, unless they
// come from this machine itself, must carry the token of a paired device. Beyond
// this machine the server only speaks HTTPS. Settings, all optional:
//   HOST=0.0.0.0        listen on the network (default 127.0.0.1: this machine only)
//   HUB_STATE=<dir>     certificates and paired devices (default ~/.config/hub)
//   HUB_TLS=1           HTTPS even on this machine;  HUB_INSECURE_HTTP=1  network without HTTPS
//   HUB_PAIR_LOCAL=1    this machine's own browser must pair too
//   HUB_HOSTS=a,b       further names the server may be reached by
//   HUB_QUOTA_MB=<n>    most the folder may hold in total (0: no limit)
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
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
const MAX_JSON = 1024 * 1024;
const HOST = process.env.HOST || '127.0.0.1';
const STATE = path.resolve(process.env.HUB_STATE || path.join(os.homedir(), '.config', 'hub'));
const PAIR_LOCAL = process.env.HUB_PAIR_LOCAL === '1';
const QUOTA = (process.env.HUB_QUOTA_MB ? Number(process.env.HUB_QUOTA_MB) : 20480) * 1024 * 1024;
const loopback = (h) => h.startsWith('127.') || h === 'localhost' || h === '::1';
const USE_TLS = process.env.HUB_TLS === '1' || (!loopback(HOST) && process.env.HUB_INSECURE_HTTP !== '1');
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

// What each kind of answer is allowed to do once a browser has it.
// The reader: its own scripts only, nothing inline, and it may load from and
// talk to this server alone. So a document cannot make it run code, and
// opening a document never contacts the internet.
const CSP_PAGE = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
// A file from the folder: no scripts at all, wherever it is opened (in the
// reader's frame or in a tab of its own), no forms, no leaving the frame, and
// pictures, styles and fonts from this server only.
const CSP_RAW = "sandbox allow-same-origin; default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
  "style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const CSP_DATA = "default-src 'none'; sandbox; frame-ancestors 'none'";
const COMMON = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-DNS-Prefetch-Control': 'off' };
// Other hubs the reader may also connect to: a name and an address each, set
// from the reader. The page is allowed to talk to these and to nothing else.
const HUBS = () => path.join(STATE, 'hubs.json');
function readHubs() {
  try { return JSON.parse(fs.readFileSync(HUBS(), 'utf8')).hubs.filter((h) => h && typeof h.name === 'string' && /^https?:\/\/[^\s/]+$/.test(h.url)); } catch { return []; }
}
const pageHeaders = () => ({
  'Content-Security-Policy': CSP_PAGE.replace("connect-src 'self'", ["connect-src 'self'", ...readHubs().map((h) => h.url)].join(' ')),
  'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
});
const PAGE = { 'Content-Security-Policy': CSP_PAGE, 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin' };

function send(res, status, body, type = 'application/json', extra = {}) {
  const data = Buffer.from(type === 'application/json' ? JSON.stringify(body) : body);
  res.writeHead(status, { 'Content-Type': withCharset(type), 'Content-Length': data.length, 'Content-Security-Policy': CSP_DATA, ...COMMON, ...extra });
  res.end(data);
}
// An error the handler answers with as it is.
const fail = (status, message) => Object.assign(new Error(message), { status });

// A JSON body of at most 1 MB. Anything that does not parse counts as empty.
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] || 0) > MAX_JSON) return reject(fail(413, 'body too large'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_JSON) { reject(fail(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
// Read a body and throw it away, so the answer is not lost on a client that is still sending.
const drain = (req) => new Promise((resolve) => { req.on('end', resolve).on('error', resolve).resume(); });

// ---- who is asking: host names, paired devices ---------------------------------
// State lives in STATE/devices.json, shared with the C++ server; only a hash of
// each device's token is kept, so the file alone lets nobody in.

// Every name this machine answers to. A request naming any other host is
// refused: that is what stops a website from pointing its own name at this
// address and being treated as "the same site" (DNS rebinding).
function hostNames() {
  const h = os.hostname().toLowerCase();
  const names = ['localhost', '127.0.0.1', '[::1]', 'hub.local', h];
  if (h && !h.includes('.')) names.push(h + '.local');
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4') names.push(a.address);
  if (HOST !== '0.0.0.0') names.push(HOST);
  for (const x of (process.env.HUB_HOSTS || '').split(',')) if (x.trim()) names.push(x.trim().toLowerCase());
  return new Set(names);
}
let hosts = hostNames();
function knownHost(header) {
  const h = String(header || '').toLowerCase().replace(/:\d+$/, '');
  if (!h) return false;
  if (hosts.has(h)) return true;
  hosts = hostNames(); // the address may have changed since start-up
  return hosts.has(h);
}

const DEVICES = path.join(STATE, 'devices.json');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function readDevices() {
  try { return JSON.parse(fs.readFileSync(DEVICES, 'utf8')).devices.filter((d) => d.id && d.hash); } catch { return []; }
}
function writeDevices(devices) {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  fs.writeFileSync(DEVICES + '.tmp', JSON.stringify({ devices }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(DEVICES + '.tmp', DEVICES);
}
const pair = { code: '', until: 0, fails: 0 };
// Offer a new pairing code for ten minutes.
function offerCode(announce) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
  pair.code = [...crypto.randomBytes(8)].map((b) => letters[b & 31]).join('');
  pair.until = Date.now() + 10 * 60 * 1000;
  pair.fails = 0;
  if (announce) console.log(`pairing code: ${pair.code.slice(0, 4)}-${pair.code.slice(4)}  (type it on the device you want to add; good for 10 minutes)`);
  return pair.code.slice(0, 4) + '-' + pair.code.slice(4);
}
const isLocal = (req) => /^(::ffff:)?127\.|^::1$/.test(req.socket.remoteAddress || '');
// The id of the paired device that sent this request: "local" for this machine
// itself, "" for a stranger.
// A request from this hub's own page proves itself with its cookie. A reader
// that was loaded from another hub (`cross`) proves itself with the token it
// was given when it paired, sent as "Authorization: Bearer"; for it the cookie
// and being on this machine count for nothing, since any website could cause
// such a request.
function deviceOf(req, cross) {
  const m = /^Bearer ([^.\s]+)\.(\S+)$/.exec(req.headers.authorization || '') || (!cross && /(?:^|;\s*)hub_device=([^.;]+)\.([^;]+)/.exec(req.headers.cookie || ''));
  if (m) {
    const devices = readDevices(), d = devices.find((x) => x.id === m[1] && same(x.hash, sha256(m[2])));
    const today = new Date().toISOString().slice(0, 10);
    if (d) {
      if (d.seen !== today) { d.seen = today; writeDevices(devices); } // one small write a day, not one per request
      return d.id;
    }
  }
  return !cross && isLocal(req) && !PAIR_LOCAL ? 'local' : '';
}
const deviceCookie = (value, tls, clear) =>
  `hub_device=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 31536000}${tls ? '; Secure' : ''}`;

// ---- how much is stored -------------------------------------------------------------
const usage = { bytes: 0, at: 0 };
function usedBytes() {
  if (Date.now() - usage.at < 3000) return usage.bytes;
  let total = 0;
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (abs !== __dirname) walk(abs); }
      else if (e.isFile()) { try { total += fs.statSync(abs).size; } catch {} }
    }
  })(ROOT);
  Object.assign(usage, { bytes: total, at: Date.now() });
  return total;
}
function freeBytes() {
  try { const v = fs.statfsSync(ROOT); return v.bavail * v.bsize; } catch { return Infinity; }
}
// Whether `more` bytes may be added: under the quota, and leaving the disk 16 MB to breathe.
const roomFor = (more) => freeBytes() >= more + 16 * 1024 * 1024 && (!QUOTA || usedBytes() + more <= QUOTA);

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

// The files that make up the page. Nothing else in this folder is served.
const ASSETS = {
  '/app.js': 'app.js', '/local.js': 'local.js', '/vault.js': 'vault.js',
  '/vendor/marked.js': 'node_modules/marked/lib/marked.umd.js',
  '/vendor/highlight.js': 'node_modules/@highlightjs/cdn-assets/highlight.min.js',
  '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js',
};
// What lets the page be installed and opened without the server: the service
// worker, the manifest and the icons. The worker gets a content policy of its
// own: the one for data would stop it asking the server for anything.
const CSP_WORKER = "default-src 'none'; connect-src 'self'";
const SHELL = {
  '/sw.js': ['text/javascript', { 'Content-Security-Policy': CSP_WORKER }],
  '/manifest.webmanifest': ['application/manifest+json'],
  '/icon-192.png': ['image/png'], '/icon-512.png': ['image/png'], '/apple-touch-icon.png': ['image/png'],
};
const asset = (name) => fs.readFileSync(path.join(__dirname, name));

async function handle(req, res) {
  const tls = !!req.socket.encrypted;
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'bad request' }); }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'bad request' }); }
  const m = req.method;
  try {
    if (!knownHost(req.headers.host)) return send(res, 403, { error: 'unknown host name' });

    // The authority's certificate is public: a device needs it before it can trust the connection.
    if (USE_TLS && m === 'GET') {
      if (p === '/hub-ca.crt') return send(res, 200, fs.readFileSync(path.join(STATE, 'ca.pem')), 'application/x-x509-ca-cert');
      if (p === '/trust') return send(res, 200, asset('trust.html'), 'text/html', PAGE);
      if (p === '/trust.js') return send(res, 200, asset('trust.js'), 'text/javascript');
      if (p === '/api/trust') {
        const ca = new crypto.X509Certificate(fs.readFileSync(path.join(STATE, 'ca.pem')));
        return send(res, 200, { fingerprint: ca.fingerprint256, encrypted: tls });
      }
    }
    // Someone typed http:// at a port that speaks HTTPS: send them to the trust page, or on to https://.
    if (USE_TLS && !tls) {
      return send(res, 308, 'This hub only speaks HTTPS.\n', 'text/plain', { Location: p === '/' ? '/trust' : 'https://' + req.headers.host + req.url, Connection: 'close' });
    }

    if (m === 'GET' && p === '/') return send(res, 200, asset('index.html'), 'text/html', pageHeaders());
    if (m === 'GET' && SHELL[p]) return send(res, 200, asset(p.slice(1)), ...SHELL[p]);
    if (m === 'GET' && ASSETS[p]) {
      // Scripts sit beside the page (copied there for the board), or in node_modules.
      const beside = path.join(__dirname, p.slice(1));
      return send(res, 200, fs.existsSync(beside) ? fs.readFileSync(beside) : asset(ASSETS[p]), 'text/javascript');
    }

    // A page on another website must not be able to use what is here. Browsers
    // say where a request comes from (Origin, Sec-Fetch-Site); if that is not
    // this server itself, refuse.
    // The one exception is a reader that was loaded from another hub and is
    // paired with this one: it sends its token itself (never a cookie, which
    // a browser would attach for any site), or is pairing with the code.
    const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
    const cross = (!!origin && (!/^[a-z]+:\/\//i.test(origin) || origin.replace(/^[a-z]+:\/\//i, '') !== req.headers.host)) || (!!site && site !== 'same-origin' && site !== 'none');
    if (cross) {
      const asked = m === 'OPTIONS' && req.headers['access-control-request-method'];
      const allowed = asked || /^Bearer \S/.test(req.headers.authorization || '') || (p === '/api/pair' && m === 'POST');
      const plain = !!origin && /^https?:\/\/[^\s/]+$/i.test(origin);
      if (plain) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }   // so the other reader can read the answer, a refusal included
      if (!allowed || !plain) return send(res, 403, { error: 'requests from other sites are not allowed' });
      if (asked) return send(res, 204, '', 'text/plain', { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range', 'Access-Control-Max-Age': '600' });
    }

    // Pairing: a new device shows it knows the code on offer and is given a token.
    if (p === '/api/pair' && m === 'POST') {
      const b = await readBody(req);
      const code = String(typeof b.code === 'string' ? b.code : '').replace(/[^a-z0-9]/gi, '').toUpperCase();
      if (!code) return send(res, 400, { error: 'code required' });
      const onOffer = pair.code && Date.now() < pair.until;
      if (!onOffer || !same(code, pair.code)) {
        // Five wrong tries and the code is withdrawn, so it cannot be guessed at.
        if (onOffer && ++pair.fails >= 5) { pair.code = ''; if (!readDevices().length) offerCode(true); }
        return send(res, 403, { error: 'wrong or expired pairing code' });
      }
      pair.code = '';
      const token = crypto.randomBytes(32).toString('base64url'), now = new Date().toISOString();
      const name = String(typeof b.name === 'string' ? b.name : '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'device';
      const d = { id: crypto.randomBytes(8).toString('hex'), name, hash: sha256(token), created: now, seen: now.slice(0, 10) };
      writeDevices([...readDevices(), d]);
      console.log(`paired: ${d.name} (${d.id})`);
      // A reader from another hub keeps the token itself; this hub's own page gets it as a cookie.
      if (cross) return send(res, 200, { device: { id: d.id, name: d.name }, token: d.id + '.' + token });
      return send(res, 200, { device: { id: d.id, name: d.name } }, 'application/json', { 'Set-Cookie': deviceCookie(d.id + '.' + token, tls) });
    }

    const device = deviceOf(req, cross);
    if (!device) return send(res, 401, { error: 'pairing required' });

    if (p === '/api/session' && m === 'GET') {
      const d = readDevices().find((x) => x.id === device);
      return send(res, 200, { device: { id: device, name: d ? d.name : 'this computer' }, local: device === 'local', tls: USE_TLS });
    }
    if (p === '/api/hubs' && m === 'GET') return send(res, 200, readHubs());
    if (p === '/api/hubs' && m === 'PUT') {
      const b = await readBody(req), hubs = [];
      for (const h of Array.isArray(b.hubs) ? b.hubs.slice(0, 12) : []) {
        let url = '';
        try { const u = new URL(String(h && h.url)); if (u.protocol === 'https:' || u.protocol === 'http:') url = u.origin; } catch {}
        const name = String((h && h.name) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (url && name && !hubs.some((x) => x.url === url)) hubs.push({ name, url });
      }
      fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
      fs.writeFileSync(HUBS(), JSON.stringify({ hubs }, null, 2) + '\n', { mode: 0o600 });
      return send(res, 200, readHubs());
    }
    if (p === '/api/pair/code' && m === 'POST') return send(res, 200, { code: offerCode(false), minutes: 10 });
    if (p === '/api/devices' && m === 'GET') {
      return send(res, 200, readDevices().map((d) => ({ id: d.id, name: d.name, created: d.created, seen: d.seen, current: d.id === device })));
    }
    if (p.startsWith('/api/devices/') && m === 'DELETE') {
      const id = p.slice(13), devices = readDevices();
      if (!devices.some((d) => d.id === id)) return send(res, 404, { error: 'no such device' });
      writeDevices(devices.filter((d) => d.id !== id));
      return send(res, 200, { ok: true }, 'application/json', id === device ? { 'Set-Cookie': deviceCookie('', tls, true) } : {});
    }
    if (p === '/api/storage' && m === 'GET') {
      const free = freeBytes();
      return send(res, 200, { used: usedBytes(), quota: QUOTA, free: free === Infinity ? 0 : free });
    }
    // Files as they are on disk: HTML documents shown in a frame, and the
    // images, styles and scripts that they or the markdown files refer to.
    if (p.startsWith('/raw/')) {
      const abs = path.resolve(ROOT, p.slice(5));
      if (!abs.startsWith(ROOT + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: 'no such file' });
      // Sent as a stream, and in pieces when asked (Range), which is what lets a
      // browser play and seek video and read a large PDF a part at a time.
      const size = fs.statSync(abs).size;
      const type = MIME[path.extname(abs).toLowerCase()] || 'text/plain';
      const head = { 'Content-Type': withCharset(type), 'Accept-Ranges': 'bytes', ...COMMON };
      // A browser's PDF viewer does not start inside a sandbox; a PDF cannot touch the reader anyway.
      if (type !== 'application/pdf') head['Content-Security-Policy'] = CSP_RAW;
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
      if (clients.size >= 16) return send(res, 503, { error: 'too many open pages' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', ...COMMON });
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
      const size = Number(req.headers['content-length'] || 0);
      if (size > MAX_UPLOAD) return send(res, 413, { error: 'body too large' }, 'application/json', { Connection: 'close' });
      if (fs.existsSync(abs)) { await drain(req); return send(res, 200, { skipped: true }); }
      if (!roomFor(size)) return send(res, 507, { error: 'storage is full' }, 'application/json', { Connection: 'close' });
      // The body goes to disk a piece at a time, under a temporary name until it is complete.
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(tmp);
          let got = 0;
          req.on('data', (c) => { got += c.length; if (got > MAX_UPLOAD) { req.destroy(); reject(fail(413, 'body too large')); } });
          req.on('error', reject).on('aborted', () => reject(fail(408, 'body not received')));
          out.on('error', reject).on('finish', resolve);
          req.pipe(out);
        });
        fs.renameSync(tmp, abs);
      } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
      usage.bytes += size;
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
      // Folder locks: which folders the reader asks a password for, and what
      // it checks the password against. The whole set is replaced. The lock
      // is the reader's (it hides the folder until the password is typed);
      // the files themselves are stored as they are.
      if (b.locks && typeof b.locks === 'object' && !Array.isArray(b.locks)) {
        const b64 = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n && /^[A-Za-z0-9+/=]+$/.test(v);
        cfg.locks = {};
        for (const [folder, l] of Object.entries(b.locks)) {
          const parts = cleanRel(folder);
          if (!parts || !l || typeof l !== 'object') continue;
          cfg.locks[parts.join('/')] = b64(l.salt, 64) && b64(l.hash, 128) ? { salt: l.salt, hash: l.hash } : {};
        }
      }
      if (front) cfg.title = (() => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).title; } catch {} })() || cfg.title;
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
      return send(res, 200, readConfig());
    }
    // Take a folder, and everything in it, out of the workspace. The notes
    // folder is the reader's own and stays. Any lock on the folder goes with it.
    if (p === '/api/folder' && req.method === 'DELETE') {
      const parts = cleanRel(url.searchParams.get('path'));
      const dir = parts && path.join(ROOT, ...parts);
      if (!dir || parts[0] === 'notes' || !fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return send(res, 400, { error: 'no such folder' });
      fs.rmSync(dir, { recursive: true, force: true });
      const key = parts.join('/');
      let file = {};
      try { file = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
      if (file.locks && typeof file.locks === 'object') {
        for (const k of Object.keys(file.locks)) if (k === key || k.startsWith(key + '/')) delete file.locks[k];
        fs.writeFileSync(CONFIG, JSON.stringify(file, null, 2) + '\n');
      }
      return send(res, 200, { removed: key });
    }
    if (p === '/api/doc') {
      const abs = safeDoc(url.searchParams.get('path'));
      return abs ? send(res, 200, fs.readFileSync(abs, 'utf8'), 'text/plain') : send(res, 404, { error: 'no such doc' });
    }
    // The front page is the only document the reader may write.
    if (p === '/api/front' && req.method === 'PUT') {
      const b = await readBody(req);
      if (typeof b.markdown !== 'string') return send(res, 400, { error: 'markdown required' });
      // With "folder", it is that folder's own front page; without, the workspace's.
      let dir = ROOT;
      if (typeof b.folder === 'string' && b.folder !== '') {
        const parts = cleanRel(b.folder);
        dir = parts && path.join(ROOT, ...parts);
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 400, { error: 'no such folder' });
      }
      fs.writeFileSync(path.join(dir, FRONT), b.markdown.endsWith('\n') ? b.markdown : b.markdown + '\n');
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
      if (!roomFor(JSON.stringify(b).length)) return send(res, 507, { error: 'storage is full' });
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
    const one = p.match(/^\/api\/notes\/([\w-]+)$/);
    if (one) {
      const notes = readNotes();
      const i = notes.findIndex((n) => n.id === one[1]);
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
    if (res.headersSent) return res.destroy();
    send(res, e.status || 500, { error: e.status ? e.message : 'server error' }, 'application/json', { Connection: 'close' });
  }
}

// A request that is slow to arrive or never finishes is dropped, and only so
// many connections are served at once.
function tune(server) {
  server.headersTimeout = 15000;
  server.requestTimeout = 30 * 60 * 1000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 64;
  return server;
}
let server;
if (USE_TLS) {
  // The certificates are made by the C++ server, which carries the code for it (the board needs it too).
  let cert, key;
  try { cert = fs.readFileSync(path.join(STATE, 'cert.pem')); key = fs.readFileSync(path.join(STATE, 'key.pem')); }
  catch { console.error(`No certificate in ${STATE}. Make one with:  server-cpp/hubd --make-cert\n(or set HUB_INSECURE_HTTP=1 to serve the network without encryption, which is not recommended)`); process.exit(1); }
  const names = new crypto.X509Certificate(cert).subjectAltName || '';
  const missing = [...hosts].filter((h) => h !== '[::1]' && !names.includes(h));
  if (missing.length) console.log(`The certificate does not cover ${missing.join(', ')}. Renew it with:  server-cpp/hubd --make-cert`);
  const secure = tune(https.createServer({ cert, key, minVersion: 'TLSv1.2' }, handle)), plain = tune(http.createServer(handle));
  // One port for both: TLS records start with byte 22. Anything else is
  // someone who typed http://, who is answered in plain text and redirected.
  server = net.createServer((socket) => {
    socket.setTimeout(10000, () => socket.destroy());
    socket.on('error', () => {});
    socket.once('data', (first) => {
      socket.pause();
      socket.setTimeout(0);
      socket.unshift(first);
      (first[0] === 22 ? secure : plain).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  server.maxConnections = 64;
  console.log(`To trust this hub on a device, open http://<this address>:${PORT}/ on it and follow the steps.`);
} else {
  server = tune(http.createServer(handle));
  if (!loopback(HOST)) console.log('WARNING: serving the network without encryption. Anyone on it can read and change what is sent.');
}
if (path.resolve(STATE).startsWith(HOME + path.sep)) { console.error('The state folder must not be inside the folder being served.'); process.exit(1); }

server.listen(PORT, HOST, () => {
  console.log(`${readConfig().title}: ${USE_TLS ? 'https' : 'http'}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (reading ${ROOT})`);
  const n = readDevices().length;
  console.log(`${n} paired device${n === 1 ? '' : 's'}${PAIR_LOCAL ? '' : "; this machine's own browser needs no pairing"}`);
  // With nobody paired yet, someone has to be let in: offer a code on the terminal.
  if (!n && (PAIR_LOCAL || !loopback(HOST))) offerCode(true);
});
