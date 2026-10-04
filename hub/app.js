// The reader. Loaded as a module so that the page needs no inline script: the
// server's content policy only lets scripts from this server run.
import { store, idb, local } from './local.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const panesEl = $('panes'), treeEl = $('tree'), tocEl = $('toc'), notesEl = $('notes'), input = $('input'), titleEl = $('hubTitle');

let docs = [], config = { title: '' }, notes = [], pendingQuote = '', pendingHead = null, activeHl = null, editing = false;
let pendingAt = null;   // where the selection behind pendingQuote begins: { article, node, offset }
// Layout: one or two panes, each with its open tabs. Saved per folder.
// Pane 0 is the main reader; pane 1, when present, sits in the right column above or below the notes.
let state = { panes: [{ tabs: [], active: null, preview: null }], active: 0, notesOpen: true, sideOpen: true, notesW: 300, notesH: 40, notesTop: false, opened: [] };
const views = [];            // DOM for each pane: { root, tabsEl, body, scroller, article, frame, surface, heads, cur }
                             // surface: the element highlights are drawn in (the article, or a framed page's body)
const scrollMem = new Map(); // "pane:path" -> scrollTop

// Every request goes through call(), which is how the page knows whether the
// server is in reach. A failed request throws an error marked `offline`.
// A server that has gone quiet (a laptop asleep, a phone off its Wi-Fi) does
// not refuse the connection, it just never answers; so a request that gets no
// answer in a few seconds counts as failed. The wait is only for the answer
// to start: a long download is not cut short, and an upload is given time
// for its size.
// ---- hubs ------------------------------------------------------------------------------
// The reader is loaded from one hub ("this hub") and can be pointed at another:
// a hub on a different machine that this device has paired with as well. Every
// request then goes to that hub, with the token it gave this device. The list
// of other hubs is kept by this hub, so all its devices see the same list.
// What this device keeps from a hub is stored under that hub's address, so
// copies from all of them sit side by side (see showKept).
const HOME = { name: 'This hub', url: '' };
let hubs = [], hub = HOME;
const hubToken = (url) => (store.get('hub:tokens') || {})[url] || '';
// Settings as a hub sent them, marked with the hub they came from: `root` is
// what everything kept on this device is filed under.
const ours = (c) => { if (hub.url) c.root = hub.url + ' ' + c.root; return c; };
const configSlot = () => 'hub:config' + (hub.url ? ':' + hub.url : '');
function switchHub(url, doc) {
  store.set('hub:at', url);
  Promise.resolve(local.whenSaved()).then(() => { location.href = doc ? '/?doc=' + encodeURIComponent(doc) : '/'; });
}

const unreachable = (opts) => Object.assign(new Error('The server is not reachable.'), { offline: true, method: opts.method || 'GET' });
async function call(url, opts = {}) {
  // Known to be out of reach: nothing waits on it. Only the regular look for
  // the server (`probe`) goes out, and everything resumes when that succeeds.
  if (!net.online && !opts.probe) throw unreachable(opts);
  // Another hub answers only to the token it gave this device when they paired.
  if (hub.url && !hubToken(hub.url)) {
    if (!opts.quiet) askToPair();
    return new Response('{"error":"pairing required"}', { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  const ctl = new AbortController();
  const wait = opts.wait || (opts.body instanceof Blob ? 30000 + opts.body.size / 20 : net.online ? 8000 : 4000);
  const timer = setTimeout(() => ctl.abort(), wait);
  try {
    const r = await fetch(hub.url + url, { ...opts, headers: hub.url ? { ...opts.headers, Authorization: 'Bearer ' + hubToken(hub.url) } : opts.headers, signal: ctl.signal });
    clearTimeout(timer);
    setOnline(true);
    // 401: this device is not (or no longer) paired with the server.
    if (r.status === 401 && !opts.quiet) askToPair();
    return r;
  } catch {
    clearTimeout(timer);
    setOnline(false);
    throw unreachable(opts);
  }
}
// A request to the hub this page was loaded from, whichever hub is being
// viewed. It says nothing about whether the viewed hub is in reach.
async function homeCall(url, opts = {}) {
  if (!hub.url) return call(url, opts);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 4000);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  catch { throw unreachable(opts); }
  finally { clearTimeout(timer); }
}
// Answers that are not a success become errors that say why, in the server's words.
const api = async (url, method = 'GET', body) => {
  const r = await call(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error(data?.error || 'The server answered ' + r.status), { status: r.status, refused: true });
  return data;
};

// Markdown may contain raw HTML, so what the renderer produces is cleaned
// before it goes into the page: no scripts, no event handlers, no forms, no
// styles. (The server's content policy would stop a script anyway; this keeps
// the page from being rearranged or made to phone home.)
const CLEAN = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base'], FORBID_ATTR: ['style', 'srcset', 'ping', 'formaction', 'action'] };
function safeHtml(markdown) {
  const box = document.createElement('template');
  box.innerHTML = DOMPurify.sanitize(marked.parse(markdown), CLEAN);
  // Pictures and media on other sites are not fetched: loading them would tell
  // that site what you are reading. A link is left in their place.
  for (const m of box.content.querySelectorAll('img, video, audio, source, track')) {
    const src = m.getAttribute('src') || '';
    if (!/^(https?:)?\/\//i.test(src)) continue;
    const a = el('a', '', `[${m.tagName === 'IMG' ? 'picture' : 'media'} on ${src.replace(/^(https?:)?\/\//i, '').split('/')[0]}, not loaded${m.alt ? ': ' + m.alt : ''}]`);
    a.href = src.startsWith('//') ? 'https:' + src : src;
    (m.tagName === 'SOURCE' || m.tagName === 'TRACK' ? m.parentNode : m).replaceWith(a);
  }
  return box.content;
}
const save = () => store.set('layout:' + config.root, state);
let docMap = new Map();   // the list by path, rebuilt with it (applyLocks), so a lookup is not a search
const docOf = (path) => docMap.get(path);
// A folder path for a list row: its last two folders, with "…" standing for
// anything before them. `where` is "a / b / c" or "a/b/c"; the whole path goes in the tooltip.
function shortPath(where) {
  const sep = where.includes(' / ') ? ' / ' : '/', parts = where.split(sep);
  return parts.length > 2 ? '…' + sep + parts.slice(-2).join(sep) : where;
}
const pathLabel = (where) => { const e = el('small', '', shortPath(where)); if (shortPath(where) !== where) e.title = where; return e; };
// Run at most once per frame, however often it is asked for (scrolling asks constantly).
const perFrame = (fn) => { let waiting = false; return () => { if (waiting) return; waiting = true; requestAnimationFrame(() => { waiting = false; fn(); }); }; };
const isHtml = (path) => /\.x?html?$/.test(path);   // .xhtml: a page of a book
const isImage = (path) => /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
const isVideo = (path) => /\.(mp4|m4v|mov|webm|ogv)$/i.test(path);
const isAudio = (path) => /\.(mp3|m4a|wav|ogg)$/i.test(path);
const isMedia = (path) => isImage(path) || isVideo(path) || isAudio(path);
const isPdf = (path) => /\.pdf$/i.test(path);
const isBinary = (path) => isMedia(path) || isPdf(path);   // kept on the device as the file itself, not as text
// A front page: the workspace's own, or one inside a folder.
const isFront = (path) => !!path && (path === 'FRONTPAGE.md' || path.endsWith('/FRONTPAGE.md'));
const folderOf = (path) => path.split('/').slice(0, -1).join('/');
const rawUrl = (path) => '/raw/' + path.split('/').map(encodeURIComponent).join('/');
const activeDoc = () => state.panes[state.active]?.active || null;
const types = () => config.highlights || [];
const typeOf = (id) => types().find((t) => t.id === id) || types()[0];
const curType = () => typeOf(store.get('hlType'));   // the colour in use until changed
const hlNote = () => notes.find((n) => n.id === activeHl) || null;
const resolve = (base, rel) => decodeURIComponent(new URL(rel, 'http://x/' + base).pathname.slice(1));

// ---- font switcher, notes panel toggle ------------------------------------
function setFont(f) {
  document.documentElement.dataset.font = f;
  $('fontToggle').textContent = f === 'serif' ? 'Aa sans body' : 'Aa serif body';
  store.set('font', f);
}
$('fontToggle').onclick = () => setFont(document.documentElement.dataset.font === 'serif' ? 'sans' : 'serif');
setFont(store.get('font') || 'serif');

// A page of a book (an .epub) takes the colours of the pane it is in and the
// reader's text size: a book is text to be poured into whatever is reading it.
// The page is in a frame, where the reader's own styles do not reach, so the
// colours are worked out here and written into a style element in the page.
// Other HTML pages are left looking as their author made them.
const isBookPage = (path) => /\.epub\//i.test(path);
function dressBook(v) {
  if (!v?.dress || !v.body) return;
  const probe = el('span'), c = {};
  v.body.append(probe);
  for (const name of ['paper', 'ink', 'accent']) { probe.style.color = `var(--${name})`; c[name] = getComputedStyle(probe).color; }
  probe.remove();
  // A dark pane gets the browser's dark scrollbar too.
  const [r, g, b] = c.paper.match(/[\d.]+/g).map(Number), dark = r * 0.299 + g * 0.587 + b * 0.114 < 128;
  v.dress.textContent =
    `html { font-size: ${view.fs}px !important; background: ${c.paper} !important; color-scheme: ${dark ? 'dark' : 'light'}; }` +
    ` body { font-size: 1rem !important; background: ${c.paper} !important; color: ${c.ink} !important; }` +
    ' body *:not(mark) { color: inherit !important; background-color: transparent !important; }' +
    ` body a:any-link, body a:any-link * { color: ${c.accent} !important; }`;
}
const dressBooks = () => { views.forEach(dressBook); for (const f of document.querySelectorAll('iframe.pdf')) f.paint?.(); };   // a PDF's night follows the theme too

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').value = t;
  store.set('theme', t);
  dressBooks();
}
$('theme').onchange = () => setTheme($('theme').value);
setTheme({ focus: 'sun-sound' }[store.get('theme')] || store.get('theme') || 'plain');   // "Focus Aid" was renamed
// The left pane (files and outline) and the right pane (the side document and
// notes) can each have a theme of their own; '' means the same as the reader.
// "one theme" switches that off: while it is pressed the whole reader has the
// one theme and the two pane menus are out of use. What they were set to is
// kept, and comes back when it is released.
const paneThemes = [['themeSide', 'side', 'Left'], ['themeRight', 'right', 'Right']];
let oneTheme = store.get('themeOne') ?? !paneThemes.some(([id]) => store.get(id));   // on, unless a pane already had a theme of its own
function applyPaneThemes() {
  $('themeOne').setAttribute('aria-pressed', oneTheme);
  for (const [id, target] of paneThemes) {
    const sel = $(id), t = oneTheme ? '' : sel.value;
    sel.disabled = oneTheme;
    if (t) $(target).dataset.theme = t; else delete $(target).dataset.theme;
  }
  dressBooks();
}
for (const [id, , name] of paneThemes) {
  const sel = $(id);
  sel.append(new Option(name + ': same', ''), ...[...$('theme').options].map((o) => new Option(name + ': ' + o.text, o.value)));
  sel.value = store.get(id) || '';
  if (sel.selectedIndex < 0) sel.value = '';
  sel.onchange = () => { store.set(id, sel.value); applyPaneThemes(); };
}
$('themeOne').onclick = () => { oneTheme = !oneTheme; store.set('themeOne', oneTheme); applyPaneThemes(); };
applyPaneThemes();

// Reading aids: text size, roomier spacing, and a focus mode that fades
// everything except the block being read.
const view = { fs: 18, roomy: false, focus: false, ...(store.get('view') || {}) };
function applyView() {
  document.documentElement.style.setProperty('--fs', view.fs + 'px');
  document.body.classList.toggle('roomy', view.roomy);
  document.body.classList.toggle('focus', view.focus);
  $('roomyToggle').setAttribute('aria-pressed', view.roomy);
  $('focusToggle').setAttribute('aria-pressed', view.focus);
  store.set('view', view);
  dressBooks();
}
$('roomyToggle').onclick = () => { view.roomy = !view.roomy; applyView(); };
$('focusToggle').onclick = () => { view.focus = !view.focus; applyView(); };
$('smaller').onclick = () => { view.fs = Math.max(14, view.fs - 1); applyView(); };
$('bigger').onclick = () => { view.fs = Math.min(28, view.fs + 1); applyView(); };
applyView();

// The note box keeps its height. The handle above it resizes it: drag, or
// press to switch between small and about a quarter of the screen.
function setInputH(px) {
  const h = Math.round(Math.max(46, Math.min(px, innerHeight * 0.6)));
  input.style.height = h + 'px';
  view.inputH = h;
  store.set('view', view);
}
if (view.inputH) input.style.height = view.inputH + 'px';
const toggleInputH = () => setInputH(input.offsetHeight > 110 ? 46 : innerHeight * 0.25);
$('grip').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const grip = $('grip'), y0 = e.clientY, h0 = input.offsetHeight;
  let moved = false;
  grip.setPointerCapture(e.pointerId);
  const move = (ev) => { if (Math.abs(ev.clientY - y0) > 4) moved = true; if (moved) setInputH(h0 + y0 - ev.clientY); };
  const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); if (!moved) toggleInputH(); };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
});
$('grip').addEventListener('click', (e) => { if (e.detail === 0) toggleInputH(); }); // keyboard

// The block being read: under the pointer, or at the reading line after a scroll.
function setHere(pane, node) {
  const v = views[pane];
  while (node && node.parentElement !== v.article) node = node.parentElement;
  if (!node || node === v.here || node.classList.contains('editFront')) return;
  v.here?.classList.remove('here');
  v.here = node;
  node.classList.add('here');
}

// Sidebar: open, or tucked away and shown while the left edge is hovered.
function setSideOpen(open) {
  state.sideOpen = open;
  document.body.classList.toggle('side-closed', !open);
  document.body.classList.remove('side-peek');
  if (!open) document.activeElement?.blur();
  $('sideToggle').title = open ? 'Tuck the sidebar away; it returns when you hover the left edge' : 'Keep the sidebar open';
  $('sideToggle').setAttribute('aria-label', open ? 'Hide sidebar' : 'Keep sidebar open');
}
$('sideToggle').onclick = () => { setSideOpen(!state.sideOpen); save(); };
// Settings (text, connection, this device) stay folded away until asked for.
function setSettingsOpen(open) {
  $('settings').hidden = !open;
  $('settingsBtn').setAttribute('aria-expanded', open);
}
$('settingsBtn').onclick = () => setSettingsOpen($('settings').hidden);
$('netBrief').onclick = () => setSettingsOpen(true);
$('sideEdge').onclick = () => { setSideOpen(true); save(); };
$('sideEdge').addEventListener('mouseenter', () => document.body.classList.add('side-peek'));
$('side').addEventListener('mouseleave', () => document.body.classList.remove('side-peek'));

// Lets a touch screen show the pressed look (iOS only does with a touch listener present).
document.addEventListener('touchstart', () => {}, { passive: true });
// Rows and tabs act as buttons from the keyboard too.
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"]')) { e.preventDefault(); e.target.click(); }
});

function setNotesOpen(open) {
  state.notesOpen = open;
  $('notesToggle').title = open ? 'Hide notes' : 'Show notes';
  $('notesToggle').setAttribute('aria-label', $('notesToggle').title);
  applyLayout();
}
// Size and arrange the right column from the saved layout.
function applyLayout() {
  const split = state.panes.length > 1, r = $('right');
  document.body.classList.toggle('no-right', !split && !state.notesOpen);
  r.classList.toggle('no-doc', !split);
  r.classList.toggle('no-notes', !state.notesOpen);
  r.classList.toggle('notes-top', state.notesTop);
  // One width for the column, whether or not it holds a document.
  const w = Math.max(240, Math.min(state.notesW, innerWidth * 0.6));
  r.style.setProperty('--right-w', Math.round(w) + 'px');
  r.style.setProperty('--notes-h', state.notesH + '%');
}
window.addEventListener('resize', applyLayout);
function dragGrip(grip, onMove) {
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    const move = (ev) => { onMove(ev); applyLayout(); };
    const up = () => {
      document.body.classList.remove('dragging');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      save();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}
dragGrip($('rightGrip'), (ev) => {
  state.notesW = Math.round(Math.max(240, Math.min(innerWidth - ev.clientX, innerWidth * 0.6)));
});
dragGrip($('hGrip'), (ev) => {
  const b = $('right').getBoundingClientRect();
  const f = state.notesTop ? (ev.clientY - b.top) / b.height : (b.bottom - ev.clientY) / b.height;
  state.notesH = Math.round(Math.max(15, Math.min(85, f * 100)));
});
$('notesToggle').onclick = () => { setNotesOpen(!state.notesOpen); save(); };

// ---- title (FRONTPAGE.md heading, or hub.json) -----------------------------
function setTabTitle() {
  const d = docOf(activeDoc());
  document.title = (d && !d.front ? d.title + ' · ' : '') + config.title;
}
async function loadConfig() {
  // Without the server, fall back to the settings seen last time.
  try { config = ours(await api('/api/config')); store.set(configSlot(), config); }
  catch (e) { const last = store.get(configSlot()); if (!last) throw e; config = last; }
  if (document.activeElement !== titleEl) titleEl.textContent = config.title;
  setTabTitle();
}
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
  if (e.key === 'Escape') { titleEl.textContent = config.title; titleEl.blur(); }
});
titleEl.addEventListener('blur', async () => {
  const t = titleEl.textContent.trim();
  if (!t || t === config.title) return (titleEl.textContent = config.title);
  config = ours(await api('/api/config', 'PUT', { title: t }));
  titleEl.textContent = config.title;
  setTabTitle();
});

// ---- workspaces and folder upload ---------------------------------------------
async function loadWorkspaces() {
  let list;
  try { list = await api('/api/workspaces'); } catch { return; }
  const sel = $('workspace');
  sel.innerHTML = '';
  for (const w of list) sel.append(new Option((w.home ? '' : '↳ ') + w.name, w.root, w.current, w.current));
  sel.hidden = list.length < 2;
  sel.onchange = async () => { await api('/api/workspace', 'POST', { root: sel.value }); location.href = '/'; };
}
$('uploadBtn').onclick = () => $('folderInput').click();
$('folderInput').onchange = (e) => {
  const files = [...e.target.files].map((file) => ({ rel: file.webkitRelativePath || file.name, file }));
  e.target.value = '';
  if (files.length) offerUpload(files);
};

// After a folder is picked: say what was found, and ask where it should go.
function offerUpload(files) {
  const folder = files[0].rel.split('/')[0];
  const ok = files.filter(({ rel, file }) => !rel.split('/').some((x) => x.startsWith('.') || x === 'node_modules') && file.size <= 50 * 1024 * 1024);
  const said = el('p', '', `${ok.length} file${ok.length === 1 ? '' : 's'}` + (ok.length < files.length ? ` (${files.length - ok.length} hidden or oversized files left out)` : '') + '. Where should they go?');
  // Every folder gets a front page. Use one it already has, pick one of its
  // top-level markdown files, or have one made.
  const tops = ok.filter(({ rel }) => rel.split('/').length === 2 && /\.md$/i.test(rel));
  const own = tops.find(({ rel }) => rel.endsWith('/FRONTPAGE.md'));
  const pick = el('select');
  pick.title = 'The front page for this folder';
  if (own) pick.append(new Option('Front page: use its FRONTPAGE.md', '-'));
  else {
    pick.append(new Option('Front page: make a new one', ''));
    for (const { rel } of tops) pick.append(new Option('Front page: copy ' + rel.split('/')[1], rel));
    const readme = tops.find(({ rel }) => /\/readme\.md$/i.test(rel));
    if (readme) pick.value = readme.rel;
  }
  const front = () => (pick.value === '-' ? null : { from: ok.find((f) => f.rel === pick.value)?.file || null });
  const add = el('button', 'main', `Add to this workspace, as the folder “${folder}”`);
  add.onclick = () => runUpload(ok, null, folder, front(), lock.checked);
  const fresh = el('button', '', 'Open as its own workspace, in place of this one');
  fresh.title = 'Nothing is deleted: the current workspace stays on disk and in the workspace menu';
  fresh.onclick = () => runUpload(ok, folder, folder, front());
  // A folder added to this workspace can be locked: its password is chosen the first time it is opened.
  const lockWrap = el('label', 'check'), lock = el('input');
  lock.type = 'checkbox';
  lockWrap.append(lock, ' Lock this folder: ask for a password before showing it');
  lock.onchange = () => { fresh.disabled = lock.checked; fresh.title = lock.checked ? 'A lock is for a folder inside a workspace' : 'Nothing is deleted: the current workspace stays on disk and in the workspace menu'; };
  const cancel = el('button', 'link', 'Cancel');
  cancel.onclick = closeGate;
  showGate(`Upload “${folder}”`, (card) => card.append(said, pick, lockWrap, add, fresh, cancel), true);
  add.focus();
}

// Send the files one at a time. `workspace` set: they become a workspace of
// their own (the top folder name is dropped); otherwise they join this one.
async function runUpload(files, workspace, folder, front, lock) {
  const line = el('p');
  let box;
  showGate(`Upload “${folder}”`, (card) => { box = card; card.append(line); });
  let saved = 0, skipped = 0, failed = 0, root = '';
  const whyNot = new Map(); // reason -> how many files
  const notSaved = [];      // the first few files that were tried and refused, by name
  for (const [i, { rel, file }] of files.entries()) {
    line.textContent = `Uploading ${i + 1} of ${files.length}…`;
    const path = workspace ? rel.split('/').slice(1).join('/') : rel;
    const q = '?path=' + encodeURIComponent(path) + (workspace ? '&workspace=' + encodeURIComponent(workspace) : '');
    let why = '', stop = false;
    try {
      const res = await call('/api/upload' + q, { method: 'POST', body: file });
      const r = await res.json().catch(() => ({}));
      if (r.saved) { saved++; root = r.root; } else if (r.skipped) skipped++; else why = r.error || 'error ' + res.status;
      stop = res.status === 401 || res.status === 403 || res.status === 507; // the rest would fail the same way
    } catch {
      // The connection broke on this file. That need not mean the server has
      // gone, so it is asked: if it answers, only this file is counted as failed
      // and the rest go on.
      const there = await call('/api/config').then((r) => r.ok, () => false);
      why = there ? 'the connection was dropped while sending it' : 'the server was not reachable';
      stop = !there;
    }
    if (why) { failed++; whyNot.set(why, (whyNot.get(why) || 0) + 1); if (notSaved.length < 5) notSaved.push(rel.split('/').pop() + ` (${(file.size / 1048576).toFixed(1)} MB)`); }
    if (stop) { const rest = files.length - i - 1; if (rest) { failed += rest; whyNot.set('not tried after that', rest); } break; }
  }
  line.textContent = `${saved} added` + (skipped ? `, ${skipped} already here and left alone` : '') + '.';
  if (failed) box.append(el('p', 'say', `${failed} not saved: ` + [...whyNot].map(([w, n]) => `${n} × ${w}`).join('; ') + (notSaved.length ? '. Refused: ' + notSaved.join('; ') : '') + '. Nothing was lost on your computer; upload the folder again to retry (files already here are skipped).'));
  const done = el('button', 'main', 'OK');
  done.onclick = closeGate;
  box.append(done);
  // The folder's front page: a copy of the chosen file, or a new one with the
  // folder's name as its title. Never replaces one that is already there.
  const frontText = async () => (front.from ? await front.from.text() : `# ${folder}\n\nWhat this folder is for. Press "edit front page" to change this.\n`);
  if (workspace && root) {
    await api('/api/workspace', 'POST', { root });
    if (front && !(await api('/api/config')).front) await api('/api/front', 'PUT', { markdown: await frontText() });
    location.href = '/';
  } else {
    await loadDocs();
    if (front && !docOf(folder + '/FRONTPAGE.md')) { await api('/api/front', 'PUT', { markdown: await frontText(), folder }); await loadDocs(); }
    if (lock && saved + skipped && !locks()[folder]) { await saveLocks({ ...locks(), [folder]: {} }); applyLocks(); renderTree(); }
    if (docOf(folder + '/FRONTPAGE.md')) openDoc(folder + '/FRONTPAGE.md');
    done.focus();
  }
}

// ---- phone: drawers for the sidebar and the notes -------------------------------
const phone = matchMedia('(max-width: 760px)'), touch = matchMedia('(pointer: coarse)');
function drawer(name) {
  document.body.classList.toggle('m-side', name === 'side' && !document.body.classList.contains('m-side'));
  document.body.classList.toggle('m-right', name === 'right' && !document.body.classList.contains('m-right'));
}
$('mFiles').onclick = () => drawer('side');
$('mNotes').onclick = () => drawer('right');
$('backdrop').onclick = () => drawer(null);

// ---- working without the server ------------------------------------------------
// Documents you open are copied into this browser's own storage, so they still
// open when the server is out of reach. Notes and highlights made meanwhile, and
// files added from this device, wait in an outbox and are sent when it answers.
const net = { online: true, said: '' };
let outbox = [], pendingFiles = [], kept = new Set(), flushing = false;
const keyOf = (path) => config.root + '|' + path;
const isPending = (path) => pendingFiles.some((f) => f.path === path);
const canKeep = () => true;   // documents, and (one at a time, or by their own "keep all") music, pictures and video
function saveLocal() {
  store.set('notes:' + config.root, notes);
  store.set('outbox:' + config.root, outbox);
  store.set('pending:' + config.root, pendingFiles);
}

function setOnline(on) {
  if (net.online === on) return;
  net.online = on;
  document.body.classList.toggle('offline', !on);
  renderNet();
  renderPlayers();
  if (on) cameBack();
}
// Back in reach: send what was waiting, then take the server's view of things.
async function cameBack() {
  await flush();
  if (!net.online) return;
  // Started without the server: now it can say which device this is.
  if (!session) { try { const r = await call('/api/session', { quiet: true }); if (r.status === 401) return askToPair(); if (r.ok) session = await r.json(); } catch { return; } }
  await loadDocs();
  await loadNotes();
}
// While out of reach, look for the server every few seconds.
const probe = () => call('/api/config', { cache: 'no-store', probe: true }).catch(() => {});
let probedAt = 0, misses = 0;
setInterval(() => {
  if (net.online) { misses = 0; return; }
  if (document.hidden) return;
  const gap = misses < 15 ? 4000 : misses < 30 ? 15000 : 60000;   // every 4 s for a minute, then 15 s, then once a minute
  if (Date.now() - probedAt < gap) return;
  probedAt = Date.now();
  misses++;
  probe();
}, 4000);
window.addEventListener('online', probe);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !net.online) probe(); });
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  if (!e.reason?.offline) return showProblem(e.reason);
  if (e.reason.method !== 'GET') { net.said = 'That change was not saved: the server is not reachable.'; renderNet(); setTimeout(() => { net.said = ''; renderNet(); }, 6000); }
});
window.addEventListener('error', (e) => { if (e.error) showProblem(e.error); });

// ---- when something goes wrong ---------------------------------------------------
// One place turns an error into a sentence a person can act on, with the
// technical part folded away underneath for whoever wants it.
function explain(err) {
  const s = err?.status, name = err?.name || '';
  if (s === 401) return 'This device is not paired with the server, so it was not allowed.';
  if (s === 403) return 'The server refused that request.';
  if (s === 404) return 'That is no longer on the server.';
  if (s === 413) return 'That is too large for the server to accept.';
  if (s === 507) return 'The server\'s storage is full.';
  if (s === 503) return 'The server is busy. Try again in a moment.';
  if (s >= 500) return 'The server ran into a problem of its own.';
  if (s) return 'The server did not accept that.';
  if (name === 'QuotaExceededError') return 'This browser has no room left for copies on this device.';
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'The browser did not allow that.';
  if (name === 'OperationError' || name === 'DataError') return 'Something stored on this device could not be decrypted.';
  if (name === 'AbortError') return 'That was interrupted before it finished.';
  return 'Something went wrong inside the reader. What you were doing may not have been saved.';
}
// The message and the few lines of the stack that say where, without the address prefix.
function technical(err) {
  const head = `${err?.name || 'Error'}: ${err?.message || String(err)}`;
  const where = String(err?.stack || '').split('\n').filter((l) => /:\d+:\d+/.test(l)).slice(0, 4)
    .map((l) => l.trim().replace(location.origin, '').replace(/^at /, ''));
  return [head, ...where].join('\n');
}
function problemBox(err, title) {
  const box = el('div', 'problem');
  box.setAttribute('role', 'alert');
  const details = el('details');
  details.append(el('summary', '', 'technical details'), el('pre', '', technical(err)));
  box.append(el('b', '', title || 'A problem'), el('p', '', explain(err)), details);
  return box;
}
let lastProblem = '';
function showProblem(err) {
  if (!err || err.offline) return;
  const key = technical(err);
  const tray = $('problems');
  if (key === lastProblem && tray.childElementCount) return; // the same failure, repeating
  lastProblem = key;
  const box = problemBox(err), row = el('div', 'row');
  const ok = el('button', '', 'dismiss'), again = el('button', '', 'reload the reader');
  ok.onclick = () => box.remove();
  again.onclick = () => location.reload();
  row.append(ok, again);
  box.append(row);
  tray.prepend(box);
  while (tray.childElementCount > 3) tray.lastChild.remove();
}

// ---- the gate: a screen in front of the reader -------------------------------------
// Used for unlocking the copies on this device, for pairing, and for the
// panels that manage devices and the passphrase.
const gate = $('gate');
const gateOpen = () => !gate.hidden;
function showGate(title, build, canClose) {
  const card = el('div', 'card');
  card.append(el('h2', '', title));
  build(card);
  if (canClose) { const x = el('button', 'x', 'close'); x.onclick = closeGate; card.append(x); }
  gate.replaceChildren(card);
  gate.hidden = false;
  card.querySelector('input, button')?.focus();
}
function closeGate() { gate.hidden = true; gate.replaceChildren(); }
function field(label, type = 'text') {
  const wrap = el('label', '', label), box = el('input');
  box.type = type;
  box.autocomplete = type === 'password' ? 'current-password' : 'off';
  box.spellcheck = false;
  wrap.append(box);
  return [wrap, box];
}
const onEnter = (box, fn) => box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } });

// The copies on this device are encrypted and the key is not in memory.
function askUnlock() {
  return new Promise((resolve) => showGate('Unlock this device\'s copies', (card) => {
    const [wrap, pass] = field('Passphrase', 'password'), msg = el('p', 'say'), go = el('button', 'main', 'Unlock');
    const tryIt = async () => {
      go.disabled = true;
      msg.textContent = 'Checking…';
      if (await local.unlock(pass.value)) { closeGate(); return resolve(); }
      go.disabled = false;
      msg.textContent = 'That passphrase does not open them.';
      pass.select();
    };
    go.onclick = tryIt;
    onEnter(pass, tryIt);
    const skip = el('button', 'link', 'Continue without them');
    skip.title = 'Read from the server only. Nothing private is stored on this device until you unlock.';
    skip.onclick = () => { closeGate(); resolve(); };
    const forgot = el('button', 'link', 'I forgot it: remove the copies from this device');
    forgot.onclick = async () => {
      if (forgot.dataset.sure !== '1') { forgot.dataset.sure = '1'; forgot.textContent = 'Really remove them? Changes not yet sent to the server will be lost. Press again to confirm.'; return; }
      await local.forget();
      location.reload();
    };
    card.append(el('p', '', 'Documents, notes and changes kept on this device are encrypted. Enter your passphrase to use them.'), wrap, go, msg, skip, forgot);
  }));
}

// The server does not know this device. Ask for the code it is offering.
let pairing = false;
function askToPair() {
  if (pairing) return;
  pairing = true;
  events?.close();
  showGate('Pair this device', (card) => {
    const at = new URL(hub.url || location.href);
    const plain = at.protocol !== 'https:' && !/^(localhost|127\.|\[::1\])/.test(at.host);
    const [codeWrap, code] = field('Pairing code'), [nameWrap, name] = field('A name for this device'), msg = el('p', 'say'), go = el('button', 'main', 'Pair');
    code.autocapitalize = 'characters';
    code.placeholder = 'XXXX-XXXX';
    name.value = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android phone' : /Mac/.test(navigator.userAgent) ? 'Mac' : /Windows/.test(navigator.userAgent) ? 'Windows PC' : 'Computer';
    const tryIt = async () => {
      go.disabled = true;
      msg.textContent = '';
      try {
        const r = await fetch(hub.url + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value, name: name.value }) });
        if (r.ok) {
          // Another hub hands this device its token to keep; this hub's own page gets a cookie.
          if (hub.url) { store.set('hub:tokens', { ...(store.get('hub:tokens') || {}), [hub.url]: (await r.json()).token }); await local.whenSaved(); }
          return location.reload();
        }
        msg.textContent = r.status === 403 ? 'That code is wrong, already used, or older than ten minutes. Ask for a new one.' : 'The server did not accept that (' + r.status + ').';
      } catch { msg.textContent = hub.url ? `“${hub.name}” did not answer. It may be off, or this device may not trust its certificate yet (open ${hub.url}/trust on this device).` : 'The server is not reachable.'; }
      go.disabled = false;
    };
    go.onclick = tryIt;
    onEnter(code, tryIt);
    onEnter(name, tryIt);
    if (hub.url) card.append(el('p', '', `“${hub.name}” (${hub.url}) is another hub, and this device has not been introduced to it yet.`));
    card.append(
      el('p', '', 'This server only answers devices it has been introduced to. It is offering a code: on first start it prints one in its terminal (the board shows it on its screen); after that, any paired device can make one under “devices…”.'),
      codeWrap, nameWrap, go, msg);
    if (plain) card.append(el('p', 'say', 'This connection is not encrypted, so the code and everything after it could be read on the network.'));
    else if (at.protocol === 'https:') {
      const a = el('a', '', 'About this hub\'s certificate, and how to trust it on this device');
      a.href = hub.url + '/trust';
      a.target = '_blank';
      card.append(a);
    }
    if (hub.url) card.append(homeButton());
  });
}

const homeButton = () => { const b = el('button', 'link', 'Go back to this hub'); b.onclick = () => switchHub(''); return b; };
// The list of other hubs, from this hub; without it, the list seen last time.
async function loadHubs() {
  try {
    const r = await homeCall('/api/hubs', { quiet: true });
    if (!r.ok) return;
    hubs = await r.json();
    store.set('hub:list', hubs);
  } catch { return; }
  if (hub.url && !hubs.some((h) => h.url === hub.url)) return switchHub('');   // it was taken off the list
  renderHubs();
}
async function saveHubs(next) {
  const r = await homeCall('/api/hubs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hubs: next }) });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || 'This hub answered ' + r.status);
  hubs = await r.json();
  store.set('hub:list', hubs);
}
function renderHubs() {
  // In the sidebar: which hub to look at. Shown once there is more than one.
  const sel = $('hubSel');
  sel.replaceChildren(new Option('This hub', '', false, !hub.url), ...hubs.map((h) => new Option(h.name, h.url, false, h.url === hub.url)));
  sel.hidden = !hubs.length;
  sel.onchange = () => switchHub(sel.value);
  // In the settings: the list, with a way to add to it and take from it.
  const box = $('hubsBox'), link = (text, fn) => { const b = el('button', '', text); b.onclick = fn; return b; };
  const row = (h) => {
    const d = el('div', ''), on = h.url === hub.url;
    d.append(el('b', '', h.name + ' '), el('span', 'sub', h.url ? new URL(h.url).host + ' ' : ''));
    if (on) d.append(el('span', 'sub', '(viewing) ')); else d.append(link('view', () => switchHub(h.url)), ' ');
    if (h.url && !hubToken(h.url)) d.append(el('span', 'sub', 'not paired here yet '));
    if (h.url) d.append(link('remove', async () => {
      try { await saveHubs(hubs.filter((x) => x.url !== h.url)); } catch (e) { net.said = e.offline ? 'This hub is not reachable, and it keeps the list of hubs.' : e.message; return renderNet(); }
      const { [h.url]: gone, ...rest } = store.get('hub:tokens') || {};
      store.set('hub:tokens', rest);
      if (on) switchHub(''); else renderHubs();
    }));
    return d;
  };
  box.replaceChildren(row(HOME), ...hubs.map(row), link('add a hub…', addHub));
}
function addHub() {
  showGate('Add a hub', (card) => {
    const [nameWrap, name] = field('A name for it (for example: Desktop)'), [addrWrap, addr] = field('Its address'), say = el('p', 'say'), go = el('button', 'main', 'Add');
    addr.placeholder = 'https://192.168.1.20:4321';
    addr.inputMode = 'url';
    addr.autocapitalize = 'off';
    const run = async () => {
      say.textContent = '';
      let url = addr.value.trim();
      if (url && !/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
      try { url = new URL(url).origin; } catch { url = ''; }
      if (!/^https?:\/\//.test(url)) { say.textContent = 'That does not look like an address.'; return; }
      if (url === location.origin) { say.textContent = 'That is this hub.'; return; }
      if (location.protocol === 'https:' && url.startsWith('http:')) { say.textContent = 'This page is encrypted, so it can only talk to hubs that are too (https://).'; return; }
      if (!name.value.trim()) { say.textContent = 'Give it a name.'; return; }
      go.disabled = true;
      try { await saveHubs([...hubs.filter((h) => h.url !== url), { name: name.value.trim(), url }]); }
      catch (e) { go.disabled = false; say.textContent = e.offline ? 'This hub is not reachable, and it keeps the list of hubs.' : e.message; return; }
      switchHub(url);   // a fresh load: the page is then allowed to talk to it, and it asks for its pairing code
    };
    go.onclick = run;
    onEnter(name, run);
    onEnter(addr, run);
    card.append(
      el('p', '', 'Another hub is a reader server on a different machine. Once it is added, this device can look at either one, and what you keep from each stays on this device side by side.'),
      nameWrap, addrWrap, go, say,
      el('p', 'sub', 'Next, that hub asks this device for a pairing code. Make one on that machine: open its reader, then settings, then “devices…”.'),
      el('p', 'sub', 'If its address starts with https, this device must trust its certificate first: open its address followed by /trust on this device.'));
  }, true);
}
// Everything kept on this device, from every hub and workspace, in one list that says where each came from.
async function showKept() {
  const groups = new Map();
  for (const key of (await idb.keys('docs')) || []) {
    const bar = key.indexOf('|');
    if (bar < 0) continue;
    const root = key.slice(0, bar), path = key.slice(bar + 1), m = /^(https?:\/\/\S+) (.*)$/.exec(root);
    const url = m ? m[1] : '', folder = (m ? m[2] : root).split('/').filter(Boolean).pop() || '';
    const from = url ? hubs.find((h) => h.url === url)?.name || new URL(url).host : 'This hub';
    if (root === config.root && gateOf(path)) continue;   // in a locked folder: not named until it is opened
    const label = from + ' · ' + folder;
    if (!groups.has(label)) groups.set(label, { url, root, items: [] });
    groups.get(label).items.push(path);
  }
  showGate('On this device', (card) => {
    if (!groups.size) card.append(el('p', '', 'Nothing is kept on this device yet. Documents are kept as you open them; press ○ beside a file, or “keep all”, for the rest.'));
    for (const [label, g] of groups) {
      const here = g.root === config.root, reach = here || g.url !== hub.url;
      card.append(el('h5', '', label + (here ? ' (viewing)' : '')));
      if (!reach) card.append(el('p', 'sub', 'Another workspace of this hub: switch to it in the workspace menu to open these.'));
      for (const path of g.items.sort()) {
        const row = el('div', 'dev' + (reach ? ' go' : ''));
        row.append(el('span', '', path.split('/').pop()), el('small', '', path.split('/').slice(0, -1).join(' / ')));
        if (reach) {
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          row.onclick = () => { if (here) { closeGate(); openDoc(path); } else switchHub(g.url, path); };
        }
        card.append(row);
      }
    }
  }, true);
}

// ---- privacy: connection, this device, copies kept here ----------------------------
let session = null;
// What is stored on this device (the page itself, the copies, the notes still
// to be sent) has no expiry of its own. A browser may still clear a site's
// storage when the device runs short of space, unless it has agreed to keep
// it; so, once there is something worth keeping, it is asked to.
let durable = null;   // true, false, or null while unknown or when the browser cannot say
let askedDurable = false;
async function askDurable() {
  if (askedDurable || !navigator.storage?.persist) return;
  askedDurable = true;
  try { durable = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch { return; }
  renderPrivacy();
}
const mb = (n) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : Math.max(1, Math.round(n / (1 << 20))) + ' MB');
let storage = null, storageAt = 0;
function renderPrivacy() {
  const box = $('privacy');
  if (!box) return;
  const line = (label, text, cls) => { const d = el('div', cls || ''); d.append(el('b', '', label + ' '), text); return d; };
  const link = (text, fn, title) => { const b = el('button', '', text); b.onclick = fn; if (title) b.title = title; return b; };
  const rows = [];
  // How the page reached the server.
  const at = new URL(hub.url || location.href), here = /^(localhost|127\.|\[::1\])/.test(at.host);
  if (hub.url) rows.push(line('Viewing', `${hub.name} (${at.host})`));
  if (at.protocol === 'https:') {
    const d = line('Connection', 'encrypted (HTTPS) ');
    d.append(link('certificate…', () => window.open(hub.url + '/trust', '_blank', 'noopener'), 'How to make a device trust this hub'));
    rows.push(d);
  } else if (here) rows.push(line('Connection', 'this computer only'));
  else rows.push(line('Connection', 'not encrypted: others on this network can read it', 'say'));
  // Who the server takes this device for.
  if (session) {
    const d = line('Device', session.device.name + ' ');
    d.append(link('devices…', showDevices, 'See, add and remove paired devices'));
    rows.push(d);
  }
  // What is stored here, and whether it is readable.
  const copies = line('Copies here', local.mode === 'plain' ? 'not encrypted ' : local.mode === 'open' ? 'encrypted, unlocked ' : 'encrypted, locked ');
  if (local.mode === 'plain' && local.canProtect) copies.append(link('protect…', askNewPassphrase, 'Encrypt what is kept on this device with a passphrase'));
  else if (local.mode === 'plain') copies.title = 'Encrypting them needs an HTTPS connection.';
  else if (local.mode === 'open') copies.append(link('lock', () => local.lock()), ' ', link('turn off', turnOffProtection));
  else copies.append(link('unlock', () => location.reload()));
  rows.push(copies);
  // Whether the browser has agreed to keep what is stored here until it is removed by hand.
  if (durable != null) {
    const d = line('Kept here', durable ? 'until you remove it' : 'for now: the browser may clear it if the device runs short of space', durable ? '' : 'sub');
    if (!durable) d.title = 'Browsers keep an installed app\'s storage (Add to Home Screen, or Install) and that of sites you use often. Nothing here expires by itself.';
    rows.push(d);
  }
  if (storage) rows.push(line('Server storage', mb(storage.used) + ' used' + (storage.quota ? ' of ' + mb(storage.quota) : '')));
  box.replaceChildren(...rows);
  // How full the server is: asked for at most twice a minute.
  if (session && net.online && Date.now() - storageAt > 30000) {
    storageAt = Date.now();
    call('/api/storage', { quiet: true }).then((r) => (r.ok ? r.json() : null)).then((s) => { if (s) { storage = s; renderPrivacy(); } }).catch(() => {});
  }
}
function showDevices() {
  showGate('Paired devices', async (card) => {
    const list = el('div'), codeBox = el('p', 'code');
    card.append(el('p', '', 'Only these devices are answered by the server. Removing one locks it out at once.'), list);
    const draw = async () => {
      const devices = await api('/api/devices');
      list.replaceChildren();
      if (!devices.length) list.append(el('p', 'sub', 'None yet. This computer is trusted because the server runs on it.'));
      for (const d of devices) {
        const row = el('div', 'dev'), rm = el('button', '', d.current ? 'unpair this device' : 'remove');
        row.append(el('span', '', d.name + (d.current ? ' (this one)' : '')), el('small', '', 'last seen ' + d.seen), rm);
        rm.onclick = async () => {
          if (rm.dataset.sure !== '1') { rm.dataset.sure = '1'; rm.textContent = 'really?'; return; }
          await api('/api/devices/' + d.id, 'DELETE');
          if (d.current) location.reload(); else draw();
        };
        list.append(row);
      }
    };
    const add = el('button', 'main', 'Add a device');
    add.onclick = async () => {
      const c = await api('/api/pair/code', 'POST');
      codeBox.textContent = c.code;
      codeBox.after(el('p', 'sub', `Open this hub on the other device and type this code. It works once, for ${c.minutes} minutes.`));
      add.disabled = true;
    };
    card.append(add, codeBox);
    await draw();
  }, true);
}
function askNewPassphrase() {
  showGate('Protect the copies on this device', (card) => {
    const [w1, p1] = field('Passphrase', 'password'), [w2, p2] = field('The same again', 'password'), msg = el('p', 'say'), go = el('button', 'main', 'Encrypt');
    p1.autocomplete = p2.autocomplete = 'new-password';
    const tryIt = async () => {
      if (p1.value.length < 8) return (msg.textContent = 'Use at least 8 characters. A few unrelated words work well.');
      if (p1.value !== p2.value) return (msg.textContent = 'The two do not match.');
      go.disabled = true;
      msg.textContent = 'Encrypting what is stored…';
      await local.protect(p1.value);
      closeGate();
      renderPrivacy();
    };
    go.onclick = tryIt;
    onEnter(p2, tryIt);
    card.append(
      el('p', '', 'Documents, notes and waiting changes kept in this browser will be encrypted. You will be asked for the passphrase each time the reader is opened, and it locks itself after ten minutes in the background.'),
      el('p', '', 'The passphrase is never sent anywhere and cannot be recovered. If you forget it, the copies on this device are removed and fetched again from the server; only changes not yet sent would be lost.'),
      w1, w2, go, msg);
  }, true);
}
async function turnOffProtection() {
  showGate('Turn protection off?', (card) => {
    const go = el('button', 'main', 'Store them unencrypted');
    go.onclick = async () => { go.disabled = true; await local.unprotect(); closeGate(); renderPrivacy(); };
    card.append(el('p', '', 'The copies on this device will be stored readable again, as they were before.'), go);
  }, true);
}
// Left in the background for ten minutes, the reader locks itself.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  const long = hiddenAt && Date.now() - hiddenAt > 10 * 60 * 1000 && player.paused && (!bg || bg.el.paused);
  if (local.mode === 'open' && long) local.lock();
  else if (long && unlocked.size) { unlocked.clear(); locksChanged(); }   // locked folders close again too
});

function renderNet() {
  const box = $('net');
  if (!box) return;
  box.textContent = '';
  box.append(el('span', 'dot'), el('b', '', net.online ? 'Connected to the server' : 'Server not reachable'));
  if (!net.online) box.append(el('div', 'sub', 'Working from the copies on this device. New notes and files are held here and sent when it is back.'));
  if (outbox.length) box.append(el('div', 'sub', `${outbox.length} change${outbox.length > 1 ? 's' : ''} waiting to be sent`));
  if (stuck) box.append(el('div', 'say', stuck));
  if (refused.length) {
    const list = el('div', 'say', `${refused.length} change${refused.length > 1 ? 's were' : ' was'} refused by the server and not saved: ` + refused.map((x) => `${x.what} (${x.why})`).join('; ') + '. ');
    const ok = el('button', '', 'dismiss');
    ok.onclick = () => { refused = []; store.set('refused:' + config.root, refused); renderNet(); };
    list.append(ok);
    box.append(list);
  }
  // Copies on this device, counted and kept separately: documents (text and
  // HTML pages) are small; music can be large, so it is never fetched along with them.
  const keepable = docs.filter((d) => canKeep(d.path) && !isPending(d.path));
  const keepLine = (label, items) => {
    if (!items.length) return;
    const missing = items.filter((d) => !kept.has(d.path));
    const line = el('div', 'sub', `${items.length - missing.length} of ${items.length} ${label} copied to this device `);
    if (keeping?.label === label) line.append(`(copying ${keeping.done} of ${keeping.total}…)`);
    else if (net.online && missing.length && !keeping) {
      const all = el('button', '', 'keep all ' + label);
      all.onclick = () => keepAll(label, missing);
      line.append(all);
    }
    box.append(line);
  };
  keepLine('documents', keepable.filter((d) => !isMedia(d.path)));
  keepLine('music files', keepable.filter((d) => isAudio(d.path)));
  keepLine('pictures and videos', keepable.filter((d) => isImage(d.path) || isVideo(d.path)));
  paintKeepBtns();
  // Show everything, or only what is on this device (what opens without the server).
  const only = el('button', '', view.onlyKept ? 'show everything' : 'show only what is on this device');
  only.title = view.onlyKept ? 'The lists are showing only what is kept on this device' : 'Narrow the file list, the playlist and the front-page lists to what is kept on this device';
  only.onclick = () => setOnlyKept(!view.onlyKept);
  box.append(el('div', 'sub', '').appendChild(only).parentNode);
  const everything = el('button', '', 'everything on this device…');
  everything.title = 'What is kept here from every hub and workspace';
  everything.onclick = showKept;
  box.append(el('div', 'sub', '● on this device   ○ server only   ↑ waiting to be sent'), everything);
  if (net.said) box.append(el('div', 'say', net.said));
  if (local.full) box.append(el('div', 'say', 'This browser\'s storage for the reader is full. Notes waiting to be sent, and the layout, may not survive closing it: connect to the server so they can be sent, or remove some kept copies.'));
  // With the settings folded away, anything that needs attention still shows, in one line.
  const brief = net.said || stuck || (refused.length ? `${refused.length} change${refused.length > 1 ? 's' : ''} refused by the server` : '') || (local.full ? 'Storage on this device is full' : '') || (!net.online ? 'Server not reachable' : '');
  $('netBrief').hidden = !brief;
  $('netBrief').textContent = brief;
  renderPrivacy();
}

// The text of a document: one added here and not yet sent, else from the
// server (keeping a copy), else the copy on this device. null if none.
async function docText(path) {
  if (isPending(path)) { const f = await idb.get('files', keyOf(path)); return f ? f.blob.text() : null; }
  // Known to be out of reach: the copy here is shown at once, without waiting on the server.
  const copy = kept.has(path) ? await idb.get('docs', keyOf(path)) : null;
  if (!net.online && copy?.text != null) return copy.text;
  try {
    // With a copy to fall back on, the server gets a shorter time to answer.
    const r = await call('/api/doc?path=' + encodeURIComponent(path), copy ? { wait: 2500 } : {});
    if (!r.ok) return '# Not found\n\nThis file is no longer in the folder.\n';
    const text = await r.text();
    rememberDoc(path, text);
    return text;
  } catch {
    return copy ? copy.text : null;
  }
}
async function rememberDoc(path, text) {
  const had = kept.has(path);
  if (!(await idb.put('docs', { key: keyOf(path), root: config.root, path, text, ts: Date.now() }))) return;   // no room: it is simply not marked as kept
  kept.add(path);
  askDurable();
  if (!had) { renderTree(); renderNet(); }
}
async function keepCopy(path, quiet) {
  let stored = true;   // false only when the device had no room
  try {
    const r = await call(isHtml(path) || isBinary(path) ? rawUrl(path) : '/api/doc?path=' + encodeURIComponent(path));
    if (r.ok) {
      const body = isBinary(path) ? { blob: await r.blob() } : { text: await r.text() };
      if (await idb.put('docs', { key: keyOf(path), root: config.root, path, ...body, ts: Date.now() })) { kept.add(path); askDurable(); }
      else { stored = false; net.said = `There was no room on this device to keep “${path.split('/').pop()}”.`; setTimeout(() => { net.said = ''; renderNet(); }, 8000); }
    }
  } catch {}
  if (!quiet) { renderTree(); renderNet(); renderPlayers(); }
  return stored;
}
// "keep all": one after another, saying how far it has got.
let keeping = null;   // { label, done, total } while it runs
async function keepAll(label, items) {
  if (keeping) return;
  keeping = { label, done: 0, total: items.length };
  renderNet();
  for (const d of items) {
    if (!net.online) break;
    if (!(await keepCopy(d.path, true))) break;   // no room: the rest would fail the same way
    keeping.done++;
    if (keeping.done % 5 === 0) renderNet();   // the count moves in fives; the box is not rebuilt for every file
  }
  keeping = null;
  renderTree();
  renderNet();
  renderPlayers();
}
// What to give an element as the address of a file in the workspace. On this
// hub that is its address on the server. From another hub the browser cannot
// be given an address (it would not send this device's token), so the file
// is fetched here, whole, and handed over as a blob.
const remoteBlobs = new Map();
async function srcOf(path) {
  if (!hub.url) return rawUrl(path);
  if (!remoteBlobs.has(path)) {
    try { const r = await call(rawUrl(path)); if (!r.ok) return ''; remoteBlobs.set(path, URL.createObjectURL(await r.blob())); }
    catch { return ''; }
  }
  return remoteBlobs.get(path);
}
// Where a picture or video is read from: the copy on this device if there is one, else the server.
const blobUrls = new Map();
async function mediaSrc(path) {
  if (!kept.has(path)) return srcOf(path);
  if (!blobUrls.has(path)) {
    const copy = await idb.get('docs', keyOf(path));
    if (!copy?.blob) return srcOf(path);
    blobUrls.set(path, URL.createObjectURL(copy.blob));
  }
  return blobUrls.get(path);
}
// The keep button on a picture or video: in the viewer's bar and on a gallery tile.
function paintKeepBtn(b) {
  const here = kept.has(b.dataset.keep);
  setIcon(b, here ? 'kept' : 'keep', here ? 'On this device. Press to remove the copy.' : 'Keep a copy on this device, to open without the server');
  b.classList.toggle('kept', here);
  b.disabled = !here && !net.online;
}
const paintKeepBtns = () => document.querySelectorAll('button[data-keep]').forEach(paintKeepBtn);
function keepBtn(path) {
  const b = el('button', 'ic keepB');
  b.dataset.keep = path;
  paintKeepBtn(b);
  b.onclick = (e) => { e.stopPropagation(); b.disabled = true; if (kept.has(path)) dropCopy(path); else keepCopy(path); };
  return b;
}
async function dropCopy(path) {
  await idb.del('docs', keyOf(path));
  kept.delete(path);
  if (blobUrls.has(path)) { URL.revokeObjectURL(blobUrls.get(path)); blobUrls.delete(path); }
  renderTree();
  renderNet();
  renderPlayers();
}

// ---- the outbox: changes are applied here first, then sent ------------------------
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const makeNote = (fields) => ({ id: newId(), heading: '', headingText: '', quote: '', type: '', text: '', ...fields, ts: new Date().toISOString(), status: fields.text ? 'open' : 'highlight' });
async function noteOp(op) {
  if (op.kind === 'add') notes.push(op.note);
  if (op.kind === 'set') {
    const n = notes.find((x) => x.id === op.id);
    if (n) { Object.assign(n, op.fields); if (n.status === 'highlight' && n.text) n.status = 'open'; }
  }
  if (op.kind === 'del') notes = notes.filter((x) => x.id !== op.id);
  outbox.push(op);
  saveLocal();
  renderNotes();
  renderTree();
  renderNet();
  await flush();
}
// Send waiting changes in the order they were made. A change leaves the
// outbox only when the server took it, or said it can never be taken (the note
// is gone, the file is too large); those are listed so nothing vanishes
// unseen. Anything else (not paired, storage full, a server fault, silence)
// keeps it waiting, and everything behind it, to be tried again.
const FINAL = new Set([400, 404, 409, 410, 413, 415, 422]);
let refused = [], stuck = '';
const opLabel = (op) => (op.kind === 'file' ? `the file “${op.path.split('/').pop()}”` : op.kind === 'add' ? (op.note.text ? 'a note' : 'a highlight') : op.kind === 'del' ? 'a deletion' : 'an edit to a note');
async function flush() {
  if (flushing) return;
  flushing = true;
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  let sentFile = false;
  stuck = '';
  try {
    while (outbox.length) {
      const op = outbox[0];
      let r = null;
      if (op.kind === 'add') r = await call('/api/notes', json('POST', op.note));
      else if (op.kind === 'set') r = await call('/api/notes/' + op.id, json('PUT', op.fields));
      else if (op.kind === 'del') r = await call('/api/notes/' + op.id, json('DELETE'));
      else if (op.kind === 'file') {
        const f = await idb.get('files', keyOf(op.path));
        if (f) r = await call('/api/upload?path=' + encodeURIComponent(op.path), { method: 'POST', body: f.blob });
        else { refused.push({ what: opLabel(op), why: 'its contents were not kept on this device, so it could not be sent', ts: Date.now() }); store.set('refused:' + config.root, refused); }
      }
      if (r && !r.ok) {
        const why = (await r.json().catch(() => null))?.error || 'error ' + r.status;
        // Deleting or editing something that is already gone has nothing left to do.
        const moot = r.status === 404 && op.kind !== 'add' && op.kind !== 'file';
        if (!FINAL.has(r.status)) { stuck = `The server would not take ${opLabel(op)} (${why}). It is kept here and will be tried again.`; break; }
        if (!moot) { refused.push({ what: opLabel(op), why, ts: Date.now() }); store.set('refused:' + config.root, refused); }
      }
      if (op.kind === 'file' && (!r || r.ok)) {
        await idb.del('files', keyOf(op.path));
        pendingFiles = pendingFiles.filter((x) => x.path !== op.path);
        sentFile = true;
      }
      outbox.shift();
      saveLocal();
    }
  } catch { /* still out of reach: everything left stays in the outbox */ }
  flushing = false;
  renderNet();
  if (sentFile && net.online) loadDocs();
}
// While something is stuck, try again every half minute.
setInterval(() => { if (stuck && net.online && !gateOpen()) flush(); }, 30000);

// ---- adding files from this device -------------------------------------------------
// They go to the folder "inbox". With the server in reach they are sent at once;
// without it they wait here, already openable, and are sent later.
async function addFiles(fileList) {
  const left = [];   // what was not taken, and why: said, not dropped quietly
  for (const file of fileList) {
    const name = file.name.replace(/[\\/]/g, ' ').replace(/^\.+/, '').trim();
    if (!name) continue;
    if (file.size > 50 * 1024 * 1024) { left.push(`“${name}” is over 50 MB`); continue; }
    let path = 'inbox/' + name;
    for (let n = 2; docs.some((d) => d.path === path); n++) path = 'inbox/' + name.replace(/(\.[^.]*)?$/, ` ${n}$1`);
    if (!(await idb.put('files', { key: keyOf(path), root: config.root, path, blob: file }))) { left.push(`no room on this device for “${name}”`); continue; }
    pendingFiles.push({ path });
    outbox.push({ kind: 'file', path });
    allDocs.push({ path, group: 'inbox', title: name, side: false, front: false });
    applyLocks();
  }
  if (left.length) { net.said = 'Not added: ' + left.join('; ') + '.'; setTimeout(() => { net.said = ''; renderNet(); }, 10000); }
  saveLocal();
  renderTree();
  renderNet();
  await flush();
  renderTree();
}
async function discardPending(path) {
  await idb.del('files', keyOf(path));
  pendingFiles = pendingFiles.filter((f) => f.path !== path);
  outbox = outbox.filter((op) => !(op.kind === 'file' && op.path === path));
  allDocs = allDocs.filter((d) => d.path !== path || serverDocs.some((x) => x.path === path));
  applyLocks();
  for (const [i, p] of state.panes.entries()) if (p.tabs.includes(path)) await closeTab(i, path);
  saveLocal();
  renderTree();
  renderNet();
}
$('addBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; addFiles(files); };
const sideEl = $('side');
sideEl.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); sideEl.classList.add('drop'); } });
sideEl.addEventListener('dragleave', () => sideEl.classList.remove('drop'));
sideEl.addEventListener('drop', (e) => { if (!e.dataTransfer?.files.length) return; e.preventDefault(); sideEl.classList.remove('drop'); addFiles([...e.dataTransfer.files]); });

// ---- file browser -----------------------------------------------------------
let serverDocs = [];

// ---- folder locks ---------------------------------------------------------------------
// A folder can be locked: the reader then shows nothing of it until its
// password is typed, and asks again each time the reader is opened (and after
// ten minutes in the background). The list of locked folders, with a salted
// hash to check the password against, is part of the workspace's settings,
// so every device sees the same locks and they hold without the server too.
// A lock with no hash yet is one whose password is given on first open.
//
// There is one password for all of them. The first folder locked chooses it;
// every folder locked after that is given the same salt and hash, after the
// password has been typed to show it is known. Typing it opens every folder
// that has it. (Folders locked before this, each with a password of its own,
// keep theirs until their lock is removed and set again.)
//
// This is a lock on the reader, not on the files: they are stored as they
// are, and removing the folder and uploading it again takes the lock off.
let allDocs = [];                 // everything the server lists; `docs` is what may be shown
const unlocked = new Set();       // folders opened with their password, until the page is closed
const locks = () => config.locks || {};
// The outermost locked folder that still stands between the reader and this path.
const gateOf = (path) => Object.keys(locks()).filter((f) => path.startsWith(f + '/') && !unlocked.has(f)).sort((a, b) => a.length - b.length)[0] || null;
const frontOf = (folder) => folder + '/FRONTPAGE.md';
function applyLocks() {
  docs = allDocs.filter((d) => { const g = gateOf(d.path); return !g || d.path === frontOf(g); });
  // A locked folder is reached through its front page; one without gets a stand-in to carry the lock screen.
  for (const f of Object.keys(locks())) {
    if (gateOf(frontOf(f)) === f && !docs.some((d) => d.path === frontOf(f)) && allDocs.some((d) => d.path.startsWith(f + '/')))
      docs.push({ path: frontOf(f), group: f, title: f.split('/').pop(), side: false, front: false });
  }
  docMap = new Map(docs.map((d) => [d.path, d]));
}
// After a lock is opened, closed, set or removed: redraw everything that could show the folder.
async function locksChanged() {
  applyLocks();
  if (music.path && !docOf(music.path)) { player.pause(); player.removeAttribute('src'); music.path = null; }
  if (bg && !docOf(bg.path)) stopVideo();
  state.panes.forEach((p, i) => {
    p.tabs = p.tabs.filter(docOf);
    if (!p.tabs.includes(p.preview)) p.preview = null;
    if (!p.tabs.includes(p.active)) p.active = p.tabs[0] || null;
    if (!p.tabs.length && i === 0 && config.front) { p.tabs = [config.front]; p.active = p.preview = config.front; }
  });
  renderTree();
  renderNet();
  renderPlayers();
  for (let i = 0; i < views.length; i++) { renderTabs(i); await showDoc(i); }
  chrome();
}
async function saveLocks(next) {
  config = ours(await api('/api/config', 'PUT', { locks: next }));
  store.set(configSlot(), config);
}
async function lockHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), iterations: 100000 }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
// The password form: to open a locked folder, or to choose the password of one that has none yet.
function lockForm(box, folder, done) {
  const lock = locks()[folder], fresh = !lock?.hash;
  const shared = Object.values(locks()).find((l) => l.hash), choose = fresh && !shared;   // the one password, if a folder has it already
  if (!globalThis.crypto?.subtle) { box.append(el('p', 'say', 'Folder locks need an encrypted (HTTPS) connection, or localhost.')); return; }
  const [w1, p1] = field(choose ? 'New password' : 'Password', 'password'), say = el('p', 'say');
  box.append(el('p', '', choose ? 'Choose a password. It is the one password for every locked folder, and is asked for each time the reader is opened.' : fresh ? 'Locked folders share one password. Type it to lock this folder with it.' : 'This folder is locked. Type the password to see what is in it.'), w1);
  let p2 = null;
  if (choose) {
    const [w2, again] = field('The same again', 'password');
    p2 = again;
    p1.autocomplete = p2.autocomplete = 'new-password';
    box.append(w2);
  }
  const go = el('button', 'main', choose ? 'Set password' : fresh ? 'Lock' : 'Unlock');
  const run = async () => {
    say.textContent = '';
    if (!p1.value || go.disabled) return;
    if (choose && p1.value !== p2.value) { say.textContent = 'The two do not match.'; return; }
    go.disabled = true;
    // What the typed password is checked against: this folder's own, or the shared one it is about to be given.
    const known = fresh ? shared : lock;
    let mine = known;
    if (choose) {
      const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      mine = { salt, hash: await lockHash(p1.value, salt) };
    } else if ((await lockHash(p1.value, known.salt)) !== known.hash) {
      go.disabled = false;
      say.textContent = 'That is not the password.';
      p1.select();
      return;
    }
    if (fresh) {
      // This folder, and any other still waiting for a password, take the one password.
      const next = { ...locks(), [folder]: { salt: mine.salt, hash: mine.hash } };
      for (const f of Object.keys(next)) if (!next[f].hash) next[f] = { salt: mine.salt, hash: mine.hash };
      try { await saveLocks(next); }
      catch (e) { go.disabled = false; say.textContent = e.offline ? 'The server is not reachable. A folder can only be locked while connected.' : e.message; return; }
    }
    // The password has been typed: every folder that has it is open.
    for (const [f, l] of Object.entries(locks())) if (f === folder || l.hash === mine.hash) unlocked.add(f);
    done();
  };
  go.onclick = run;
  onEnter(p1, run);
  if (p2) onEnter(p2, run);
  box.append(go, say);
}
// In place of anything inside a locked folder.
function showLock(pane, folder) {
  const v = views[pane], box = el('div', 'lockbox');
  box.append(el('h2', '', `“${folder.split('/').pop()}” is locked`));
  lockForm(box, folder, locksChanged);
  const rm = el('button', 'link', 'Remove this folder from the workspace…');
  rm.onclick = () => removeFolder(folder);
  box.append(rm);
  v.bar.style.width = '0%';
  v.body.replaceChildren(box);
}
// Lock controls on a folder's front page (the folder is open, or not locked).
function lockButtons(folder) {
  const out = [];
  if (!locks()[folder]) {
    const b = el('button', '', 'lock…');
    b.title = 'Ask for a password before this folder is shown';
    b.onclick = () => showGate(`Lock “${folder.split('/').pop()}”`, (card) => lockForm(card, folder, () => { closeGate(); locksChanged(); }), true);
    out.push(b);
  } else {
    const now = el('button', '', 'lock now'), off = el('button', '', 'remove lock');
    now.title = 'Hide this folder again until its password is typed';
    now.onclick = () => { unlocked.delete(folder); locksChanged(); };
    off.onclick = async () => { const { [folder]: gone, ...rest } = locks(); await saveLocks(rest); locksChanged(); };
    out.push(now, off);
  }
  return out;
}
// Take a folder out of the workspace, after asking.
function removeFolder(folder) {
  const inside = allDocs.filter((d) => d.path.startsWith(folder + '/')).length;
  showGate(`Remove “${folder.split('/').pop()}”?`, (card) => {
    const say = el('p', 'say'), go = el('button', 'main', 'Remove the folder'), no = el('button', 'link', 'Cancel');
    card.append(el('p', '', `The folder and the ${inside} file${inside === 1 ? '' : 's'} in it are deleted from this workspace, on the server and for every device. This cannot be undone here.`),
      el('p', 'sub', 'Files on your own computer are not touched: a folder you uploaded can be uploaded again.'), go, no, say);
    no.onclick = closeGate;
    go.onclick = async () => {
      go.disabled = true;
      try { await api('/api/folder?path=' + encodeURIComponent(folder), 'DELETE'); }
      catch (e) { go.disabled = false; say.textContent = e.offline ? 'The server is not reachable. A folder can only be removed while connected.' : e.message; return; }
      for (const d of allDocs) if (d.path.startsWith(folder + '/') && kept.has(d.path)) await dropCopy(d.path);
      queue = queue.filter((p) => !p.startsWith(folder + '/'));
      saveQueue();
      closeGate();
      await loadConfig();
      await loadDocs();
      await locksChanged();
    };
  }, true);
}
async function loadDocs() {
  try { serverDocs = await api('/api/docs'); store.set('docs:' + config.root, serverDocs); }
  catch { serverDocs = store.get('docs:' + config.root) || serverDocs; }
  // Files added on this device and not yet sent appear in the list too.
  const waiting = pendingFiles.filter((f) => !serverDocs.some((d) => d.path === f.path))
    .map((f) => ({ path: f.path, group: f.path.split('/').slice(0, -1).join('/'), title: f.path.split('/').pop(), side: false, front: false }));
  allDocs = serverDocs.concat(waiting);
  applyLocks();
  renderTree();
  renderNet();
  renderPlayers();
}

// ---- only what is on this device ---------------------------------------------------------
// One switch (in the settings, beside the counts) narrows every list to what
// is kept here: the file list, the playlist and the front-page lists. A line
// above the file list says so while it is on, and turns it off.
const inView = (d) => !view.onlyKept || d.front || kept.has(d.path) || isPending(d.path);
function setOnlyKept(on) {
  view.onlyKept = on;
  store.set('view', view);
  showOnlyKept();
  renderTree();
  renderNet();
  renderPlayers();
  for (let i = 0; i < views.length; i++) if (isFront(state.panes[i]?.active || '')) showDoc(i, null, true);   // front-page lists
}
function showOnlyKept() {
  const b = $('keptOnly'), shown = docs.filter(inView).length;
  b.hidden = !view.onlyKept;
  b.textContent = `On this device only: ${shown} of ${docs.length}. Show everything`;
}
$('keptOnly').onclick = () => setOnlyKept(false);

// ---- find -------------------------------------------------------------------------------
// The box above the file list. As you type it narrows the list to files whose
// name or title matches; from three letters on it also looks inside the
// documents (the server does that; without it, the copies kept here are
// searched) and in your notes, and lists the lines found.
let finding = '', findTimer = 0, findRun = 0;
const findBox = $('find'), foundEl = $('found');
const matchesFind = (d) => !finding || ((gateOf(d.path) ? '' : d.title + ' ') + d.path).toLowerCase().includes(finding);   // a locked folder's title is not matched
findBox.addEventListener('input', () => {
  finding = findBox.value.trim().toLowerCase();
  renderTree();
  clearTimeout(findTimer);
  if (finding.length < 3) { foundEl.hidden = true; foundEl.replaceChildren(); return; }
  findTimer = setTimeout(runFind, 350);
});
findBox.addEventListener('keydown', (e) => { if (e.key === 'Escape') { findBox.value = ''; findBox.dispatchEvent(new Event('input')); findBox.blur(); } });
async function findInside(q) {
  try {
    const r = await call('/api/search?q=' + encodeURIComponent(q), { quiet: true });
    if (r.ok) return await r.json();
  } catch { /* out of reach: fall through to what is kept here */ }
  const hits = [];
  for (const d of docs) {
    if (hits.length >= 60) break;
    if (isBinary(d.path) || !kept.has(d.path) || gateOf(d.path)) continue;
    const copy = await idb.get('docs', keyOf(d.path));
    if (!copy?.text) continue;
    const lines = copy.text.split('\n');
    let n = 0;
    for (let i = 0; i < lines.length && n < 3; i++) {
      const at = lines[i].toLowerCase().indexOf(q);
      if (at < 0) continue;
      hits.push({ path: d.path, line: i + 1, text: lines[i].slice(Math.max(0, at - 60), at + q.length + 100).trim() });
      n++;
    }
  }
  return hits;
}
async function runFind() {
  const q = finding, run = ++findRun;
  const hits = (await findInside(q)).filter((h) => docOf(h.path) && !gateOf(h.path));   // nothing from a locked folder, its front page included
  if (run !== findRun || q !== finding) return;                       // typed on since: this answer is out of date
  const mine = notes.filter((n) => docOf(n.doc) && !gateOf(n.doc) && ((n.text || '') + ' ' + (n.quote || '')).toLowerCase().includes(q)).slice(0, 20);
  foundEl.replaceChildren();
  const row = (title, where, text, go) => {
    const r = el('div', 'hit');
    r.tabIndex = 0;
    r.setAttribute('role', 'button');
    r.append(el('b', '', title), el('small', '', where), el('span', '', text));
    r.onclick = go;
    foundEl.append(r);
  };
  for (const h of hits) row(docOf(h.path).title, shortPath(h.path) + ', line ' + h.line, h.text.replace(/[*_`#>|]+/g, ' ').replace(/\s+/g, ' ').trim(), async () => { await openDoc(h.path, { keep: true }); showFound(state.active, q); });
  for (const n of mine) row(docOf(n.doc).title, n.text ? 'your note' : 'your highlight', n.text || n.quote, async () => { await openDoc(n.doc, { keep: true, hash: n.heading || undefined }); if (n.quote) showFound(state.active, n.quote.toLowerCase().slice(0, 40)); });
  foundEl.prepend(el('div', 'sub', hits.length + mine.length ? `${hits.length} line${hits.length === 1 ? '' : 's'} in documents${hits.length >= 60 ? ' (the first 60)' : ''}, ${mine.length} in notes${net.online ? '' : ' · searched the copies on this device only'}` : `Nothing found for “${q}”${net.online ? '' : ' in the copies on this device'}.`));
  foundEl.hidden = false;
}
// Bring the first place the words appear in an open document into view, and mark it for a moment.
function showFound(pane, q) {
  const v = views[pane], root = v?.surface || v?.article;
  if (!root) return;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    if (!node.nodeValue.toLowerCase().includes(q)) continue;
    const block = node.parentElement;
    block.scrollIntoView({ block: 'center' });
    block.classList.add('found');
    setTimeout(() => block.classList.remove('found'), 2500);
    return;
  }
}

function renderTree() {
  showOnlyKept();
  const y = treeEl.scrollTop;
  treeEl.innerHTML = '';
  const root = { dirs: {}, files: [] };
  for (const d of docs) {
    if (d.front || !matchesFind(d) || !inView(d)) continue;
    let node = root;
    // A book is one folder of pages in reading order: the folders inside its file are not shown.
    for (const part of d.path.split('/').slice(0, -1)) { node = node.dirs[part] ??= { dirs: {}, files: [] }; if (/\.epub$/i.test(part)) break; }
    node.files.push(d);
  }
  const front = docs.find((d) => d.front);
  if (front && matchesFind(front)) treeEl.append(fileRow(front, config.title || 'Front page'));
  const draw = (node, parent, prefix) => {
    // A folder's own front page comes first, under that name.
    const fp = prefix ? node.files.find((f) => isFront(f.path)) : null;
    if (fp) parent.append(fileRow(fp, gateOf(fp.path) ? 'Locked: open to unlock' : 'Front page'));
    for (const [name, sub] of Object.entries(node.dirs)) {
      const det = el('details'), sum = el('summary', '', name);
      det.open = !!finding || state.opened.includes(prefix + name);   // folders start closed; while finding, everything that matches shows
      sum.dataset.folder = prefix + name;
      paintQuick(sum);
      det.append(sum);
      det.addEventListener('toggle', () => {
        pinNext();
        // Closing a folder forgets what was open inside it, so it comes back with its subfolders closed.
        state.opened = state.opened.filter((p) => p !== prefix + name && (det.open || !p.startsWith(prefix + name + '/')));
        if (det.open) state.opened.push(prefix + name);
        else for (const inner of det.querySelectorAll('details[open]')) inner.open = false;
        save();
      });
      const kids = el('div', 'kids');
      det.append(kids);
      draw(sub, kids, prefix + name + '/');
      parent.append(det);
    }
    for (const f of node.files) if (f !== fp) parent.append(fileRow(f, /\.epub\//i.test(f.path) ? f.title : undefined));   // a page of a book goes by its name in the contents
  };
  // Sections. What hub.json lists under "starter" (the material every copy
  // begins with) is kept together, first. Each other top-level folder, added
  // since, is a section by itself; files added loose come last.
  const starter = new Set((config.starter || []).map((s) => s.replace(/\/$/, '')));
  const base = { dirs: {}, files: root.files.filter((f) => starter.has(f.path)) }, loose = root.files.filter((f) => !starter.has(f.path));
  const section = (cls, heading) => { const s = el('div', 'sect' + cls); if (heading) s.append(el('div', 'sect-h', heading)); treeEl.append(s); return s; };
  drawGroups(section);
  for (const [name, sub] of Object.entries(root.dirs)) if (starter.has(name)) base.dirs[name] = sub;
  if (Object.keys(base.dirs).length || base.files.length) draw(base, section('', 'Starter'), '');
  // inbox/ (where "add files…" puts things) leads the added folders, so what was just added is easy to find.
  // Under it, the folder most recently added to comes first (by the newest file in each; folders the server gave no time for keep their order, last).
  const newest = {};
  for (const d of docs) { const top = d.path.split('/')[0]; if (d.changed > (newest[top] || 0)) newest[top] = d.changed; }
  const added = Object.entries(root.dirs).filter(([name]) => !starter.has(name)).sort(([a], [b]) => (b === 'inbox') - (a === 'inbox') || (newest[b] || 0) - (newest[a] || 0));
  for (const [name, sub] of added) draw({ dirs: { [name]: sub }, files: [] }, section(' up'), '');
  if (loose.length) draw({ dirs: {}, files: loose }, section('', starter.size ? 'Other files' : 'Files'), '');
  treeEl.append(nextPin);
  treeEl.scrollTop = y;
  pinNext();
}
// Quick open: a closed folder's line carries the document last opened inside
// it (at any depth), so that can be returned to without opening the folder.
function paintQuick(sum) {
  sum.querySelector('.quick')?.remove();
  const d = docOf(state.last?.[sum.dataset.folder]);
  if (!d || !inView(d) || gateOf(d.path)) return;
  const b = el('button', 'quick', d.front || isFront(d.path) ? 'Front page' : d.title || d.path.split('/').pop());
  b.title = 'Open what was last opened in this folder: ' + d.path;
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openDoc(d.path); };   // not a press on the folder's line: it stays closed
  sum.append(b);
}
// A handle to get past an open folder: while a top-level folder (or group)
// that is open runs off the bottom of the list, the line of the one after it
// in the list is held at the bottom edge; pressing it brings that folder to
// the top. It goes once the folder itself has come into sight. What is inside
// the open folder (its subfolders, its books) is never what is held there.
const nextPin = el('button', 'nextPin');
let pinTo = null, pinAsked = 0;
function pinNext() {
  const edge = treeEl.getBoundingClientRect().bottom - (nextPin.hidden ? 0 : nextPin.offsetHeight);
  const tops = [...treeEl.querySelectorAll('.sect > details')];
  const cut = tops.findIndex((d) => { const r = d.getBoundingClientRect(); return d.open && r.top < edge && r.bottom > edge + 1; });
  pinTo = cut >= 0 ? tops[cut + 1]?.querySelector('summary') || null : null;
  nextPin.hidden = !pinTo;
  if (pinTo) nextPin.textContent = '↓ ' + (pinTo.dataset.folder?.split('/').pop() || pinTo.firstChild.textContent);
}
nextPin.hidden = true;
nextPin.onclick = () => { if (pinTo) { treeEl.scrollTop += pinTo.getBoundingClientRect().top - treeEl.getBoundingClientRect().top; pinNext(); } };
const askPin = () => { if (!pinAsked) pinAsked = requestAnimationFrame(() => { pinAsked = 0; pinNext(); }); };
treeEl.addEventListener('scroll', askPin, { passive: true });
addEventListener('resize', askPin);

function fileRow(d, label) {
  const row = el('div', 'file');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.path = d.path;
  row.title = d.title;
  if (state.panes.some((p) => p.tabs.includes(d.path))) row.classList.add('open');
  if (d.path === activeDoc()) row.classList.add('active');
  row.append(el('span', 'name', label || d.path.split('/').pop()));
  const n = notes.filter((x) => x.doc === d.path).length;
  if (n) row.append(el('small', '', n));
  const plus = el('button', 'plus', '+');
  plus.title = 'Open alongside what is already open';
  plus.setAttribute('aria-label', 'Open alongside what is already open');
  plus.onclick = (e) => { e.stopPropagation(); openDoc(d.path, { keep: true }); };
  row.append(plus);
  // Where this file is: waiting to be sent, copied to this device, or on the server only.
  if (isPending(d.path) || canKeep(d.path)) {
    const pend = isPending(d.path), here = kept.has(d.path);
    const st = el('button', 'st ' + (pend ? 'wait' : here ? 'kept' : ''), pend ? '↑' : here ? '●' : '○');
    st.title = pend ? 'Added on this device, waiting to be sent to the server. Press to discard it.'
      : here ? 'A copy is on this device, so it opens without the server. Press to remove the copy.'
      : 'On the server only. Press to keep a copy on this device.';
    st.setAttribute('aria-label', st.title);
    st.onclick = (e) => { e.stopPropagation(); if (pend) discardPending(d.path); else if (here) dropCopy(d.path); else keepCopy(d.path); };
    row.append(st);
  }
  if (isAudio(d.path) || isVideo(d.path)) row.append(queueBtn(d.path));
  const side = el('button', 'sideBtn', 'side');
  side.title = 'Open to the side';
  side.onclick = (e) => { e.stopPropagation(); openDoc(d.path, { side: true }); };
  row.append(side);
  // A sound file plays without taking the place of what is being read: the
  // controls appear at the foot of the sidebar, and its name there opens the
  // player. Everything else opens in the pane.
  const plays = isAudio(d.path);
  row.onclick = (e) => (plays && !(e.metaKey || e.ctrlKey || e.altKey) ? (playable(d.path) ? playTrack(d.path) : openDoc(d.path)) : openDoc(d.path, { side: e.metaKey || e.ctrlKey || e.altKey }));
  row.ondblclick = () => openDoc(d.path, { keep: true });
  if (plays && d.path === music.path) row.classList.add('playing');
  return row;
}

// ---- panes and tabs ---------------------------------------------------------
// Open a document. A plain open takes the place of the pane's preview tab (the
// one opened by the last single click); `keep` adds it as a tab that stays.
// `side` puts it in the right-hand pane, splitting if needed.
// Back: each pane remembers the documents it has shown, in order, so the back
// button in its tab bar returns to the one before (a gallery after a picture,
// the page a link was followed from). Kept for this visit only. With nothing
// left to return to, back goes up a level instead: to the front page of the
// folder the document is in, then the folder above, ending at the main front page.
const trail = [[], []];
function leave(pane) {
  const from = state.panes[pane]?.active, t = trail[pane] || (trail[pane] = []);
  if (from && t[t.length - 1] !== from) { t.push(from); if (t.length > 50) t.shift(); }
}
function upFrom(path) {
  if (!path) return null;
  let folder = folderOf(path);
  if (isFront(path)) { if (!folder) return null; folder = folderOf(folder); }
  for (;;) {
    const front = folder ? folder + '/FRONTPAGE.md' : config.front;
    if (front && front !== path && docOf(front)) return front;
    if (!folder) return null;
    folder = folderOf(folder);
  }
}
const backTo = (pane) => { const t = trail[pane] || []; while (t.length && (!docOf(t[t.length - 1]) || t[t.length - 1] === state.panes[pane].active)) t.pop(); return t[t.length - 1] || upFrom(state.panes[pane].active); };
async function goBack(pane = state.active) {
  const path = backTo(pane);
  if (!path) return;
  (trail[pane] || []).pop();
  await openDoc(path, { pane, back: true });
}
document.addEventListener('keydown', (e) => { if (e.altKey && e.key === 'ArrowLeft' && !e.target.matches?.('input, textarea, [contenteditable]')) { e.preventDefault(); goBack(); } });

async function openDoc(path, { pane = state.active, side = false, hash, keep = false, back = false } = {}) {
  if (!docOf(path)) return;
  if (phone.matches) { side = false; drawer(null); }   // one document at a time on a phone
  let rebuilt = false;
  if (side) {
    if (state.panes.length < 2) { state.panes.push({ tabs: [], active: null, preview: null }); rebuilt = true; pane = 1; }
    else pane = pane === 0 ? 1 : 0;
  }
  const p = state.panes[pane];
  remember(pane);
  if (!p.tabs.includes(path)) {
    const at = keep ? -1 : p.tabs.indexOf(p.preview);
    if (at >= 0) { p.bumped = { path: p.preview, by: path, at: Date.now() }; p.tabs[at] = path; } else p.tabs.push(path);
    if (!keep) p.preview = path;
  }
  if (keep && p.preview === path) {
    // A double click arrives as click + click: the first click has already
    // replaced the previewed document, so put that one back beside the new one.
    const b = p.bumped;
    p.preview = null;
    if (b && b.by === path && Date.now() - b.at < 800 && docOf(b.path) && !p.tabs.includes(b.path)) {
      p.tabs.splice(p.tabs.indexOf(path), 0, b.path);
      p.preview = b.path;
    }
  }
  if (!back && p.active !== path) leave(pane);
  for (let f = folderOf(path); f; f = folderOf(f)) (state.last ||= {})[f] = path;   // the last opened in each folder it is in: the folder's quick open
  p.active = path;
  state.active = pane;
  if (rebuilt) await buildPanes(); else { renderTabs(pane); await showDoc(pane, hash); }
  if (rebuilt && hash) goTo(pane, hash);
  chrome();
}

async function closeTab(pane, path) {
  const p = state.panes[pane];
  const at = p.tabs.indexOf(path);
  p.tabs.splice(at, 1);
  if (p.preview === path) p.preview = null;
  scrollMem.delete(pane + ':' + path);
  if (p.active === path) p.active = p.tabs[Math.min(at, p.tabs.length - 1)] || null;
  if (!p.tabs.length && state.panes.length > 1) {
    state.panes.splice(pane, 1);
    trail.splice(pane, 1);
    state.active = 0;
    scrollMem.clear();
    await buildPanes();
  } else {
    // Closing the last document falls back to the front page.
    if (!p.tabs.length && config.front) { p.tabs.push(config.front); p.active = p.preview = config.front; }
    renderTabs(pane);
    await showDoc(pane);
  }
  chrome();
}

function remember(pane) {
  const v = views[pane], path = state.panes[pane]?.active;
  if (v?.scroller && path) { scrollMem.set(pane + ':' + path, v.scroller.scrollTop); keepPlace(path, v.scroller.scrollTop); }
}
// Where each document was left, kept on this device per workspace, so a
// document opens where you stopped reading, also after the reader is closed.
let places = null, placeTimer = 0;
const placesOf = () => (places ||= store.get('pos:' + config.root) || {});
function savePlaces() {
  clearTimeout(placeTimer);
  placeTimer = 0;
  if (!places) return;
  const paths = Object.keys(places);
  for (const p of paths.slice(0, Math.max(0, paths.length - 300))) delete places[p];   // the 300 most recent
  store.set('pos:' + config.root, places);
}
function keepPlace(path, top) {
  const all = placesOf();
  delete all[path];                       // re-added last, so the newest are the ones kept
  if (top > 40) all[path] = Math.round(top);
  if (!placeTimer) placeTimer = setTimeout(savePlaces, 1500);
}
addEventListener('pagehide', savePlaces);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePlaces(); });

function setActive(pane) {
  if (state.active === pane) return;
  state.active = pane;
  chrome();
}

async function buildPanes() {
  for (const v of views) parkVideo(v.body);
  panesEl.innerHTML = '';
  $('rightDoc').innerHTML = '';
  views.length = 0;
  state.panes.forEach((_, i) => {
    const root = el('section', 'pane'), tabsEl = el('div', 'tabs'), body = el('div', 'body');
    const bar = el('div', 'progress');
    bar.append(el('i'));
    root.append(tabsEl, bar, body);
    root.addEventListener('pointerdown', () => setActive(i), true);
    (i ? $('rightDoc') : panesEl).append(root);
    views.push({ root, tabsEl, body, bar: bar.firstChild, heads: [] });
  });
  applyLayout();
  await Promise.all(state.panes.map((_, i) => { renderTabs(i); return showDoc(i); }));
}

function renderTabs(pane) {
  const p = state.panes[pane], bar = views[pane].tabsEl;
  bar.innerHTML = '';
  const back = el('button', 'back keep', '‹');
  back.title = 'Back: to what this tab showed before, then up towards the front page (Alt + ←)';
  back.setAttribute('aria-label', 'Back');
  back.disabled = !backTo(pane);
  back.onclick = () => goBack(pane);
  bar.append(back);
  for (const path of p.tabs) {
    const d = docOf(path);
    const tab = el('div', 'tab' + (path === p.active ? ' active' : '') + (path === p.preview ? ' preview' : ''));
    tab.tabIndex = 0;
    tab.setAttribute('role', 'button');
    tab.title = path + (path === p.preview ? '\n(double-click to keep open)' : '');
    tab.ondblclick = () => { if (p.preview === path) { p.preview = null; renderTabs(pane); save(); } };
    tab.append(el('span', '', gateOf(path) ? gateOf(path).split('/').pop() + ' (locked)' : d ? (d.front ? 'Front page' : isFront(path) ? d.title + ' (front page)' : d.title) : path));
    const x = el('button', '', '×');
    x.title = 'Close';
    x.onclick = (e) => { e.stopPropagation(); closeTab(pane, path); };
    tab.append(x);
    tab.onclick = async () => {
      if (p.active === path) return;
      remember(pane);
      leave(pane);
      p.active = path;
      renderTabs(pane);
      await showDoc(pane);
      chrome();
    };
    bar.append(tab);
  }
  if (p.active) {
    const split = el('button', '', state.panes.length > 1 ? 'to other side' : 'open on right');
    split.title = 'Open this document in the other pane';
    split.onclick = () => openDoc(p.active, { pane, side: true });
    bar.append(split);
  }
}

// ---- rendering a document into a pane ---------------------------------------
function slugify(text, used) {
  const s = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
  let out = s, n = 2;
  while (used.has(out)) out = s + '-' + n++;
  used.add(out);
  return out;
}

// Source files are shown as one fenced code block, tagged with their language.
const LANG = { c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', py: 'python', js: 'javascript', ts: 'typescript', rs: 'rust', go: 'go', java: 'java', sh: 'bash', Makefile: 'makefile' };
async function fetchDoc(path) {
  let text = await docText(path);
  if (text == null) return '# Not on this device\n\nThe server is not reachable, and no copy of this document was kept here.\n';
  if (path.endsWith('.md')) return text;
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map((t) => t.length + 1)));
  const name = path.split('/').pop();
  return `# ${name}\n\n${fence}${LANG[name.split('.').pop()] || ''}\n${text}\n${fence}\n`;
}

// A document that fails to draw says so in its own pane; the rest of the reader carries on.
async function showDoc(pane, hash, keepScroll) {
  parkVideo(views[pane]?.body);
  try { await drawDoc(pane, hash, keepScroll); }
  catch (e) { if (e?.offline) throw e; views[pane]?.body.replaceChildren(problemBox(e, 'This document could not be shown')); }
  finally { lightboxSync(); }
}
async function drawDoc(pane, hash, keepScroll) {
  const v = views[pane], path = state.panes[pane].active;
  const y = v.scroller ? v.scroller.scrollTop : 0;
  Object.assign(v, { heads: [], cur: null, article: null, surface: null, scroller: null, frame: null });
  if (!path) { v.body.replaceChildren(el('p', 'empty', 'Nothing open. Pick a file on the left.')); return; }
  if (gateOf(path)) { showLock(pane, gateOf(path)); return; }

  if (isAudio(path)) { showPlayer(pane, path); return; }
  if (docOf(path)?.links) { showLinks(pane, path); return; }
  if (isPdf(path)) { showPdf(pane, path); return; }
  if (isMedia(path)) {
    if (playable(path)) showMedia(pane, path);
    else v.body.replaceChildren(el('p', 'empty', 'The server is not reachable, and this file has not been kept on this device.'));
    return;
  }

  // HTML files are shown as they are, in a frame.
  if (isHtml(path)) {
    const frame = el('iframe');
    // A page's own scripts never run: the frame forbids them here, and the
    // server forbids them wherever the file is opened. The reader can still
    // reach in to read headings and draw highlights.
    // The exception is a page named under "scripts" in hub.json: a small
    // program of the user's own. It may run, but as a stranger: its frame is
    // given no share in the reader's origin, so it cannot read the reader's
    // data or ask the server for anything, and the reader cannot reach into it
    // either (no outline, no highlights there).
    const app = !hub.url && (config.scripts || []).includes(path);
    frame.setAttribute('sandbox', app ? 'allow-scripts allow-downloads allow-popups allow-modals allow-forms' : 'allow-same-origin');
    if (app) frame.allow = 'clipboard-write; picture-in-picture; fullscreen';
    frame.referrerPolicy = 'no-referrer';
    let bounced = false;
    if (net.online && !isPending(path) && !hub.url) {
      frame.src = rawUrl(path);
      call(rawUrl(path)).then((r) => (r.ok ? r.text() : null)).then((t) => t != null && rememberDoc(path, t)).catch(() => {});
    } else {
      // No server: show the copy kept on this device, if there is one.
      const copy = await docText(path);
      if (copy == null) { v.body.replaceChildren(el('p', 'empty', 'The server is not reachable, and no copy of this page was kept on this device.')); return; }
      frame.srcdoc = copy;
    }
    frame.onload = () => {
      if (app) { v.heads = []; v.surface = null; if (pane === state.active) { renderOutline(); renderContext(); } return; }
      try {
        const d = frame.contentDocument, used = new Set();
        v.heads = [...d.querySelectorAll('h1, h2, h3')];
        for (const h of v.heads) h.dataset.slug = slugify(h.textContent, used);
        v.surface = d.body;
        // No sideways sliding: the page scrolls up and down only. Images shrink
        // to fit; code blocks and tables that are too wide scroll inside themselves.
        const lock = d.createElement('style');
        lock.textContent = 'html, body { overflow-x: hidden !important; overscroll-behavior-x: none; max-width: 100%; }' +
          ' body { overflow-wrap: anywhere; } img, video, svg, canvas, iframe { max-width: 100%; height: auto; }' +
          ' pre { max-width: 100%; overflow-x: auto; }';
        d.head.append(lock);
        if (isBookPage(path)) { v.dress = d.createElement('style'); d.head.append(v.dress); dressBook(v); }
        if (frame.step) d.addEventListener('keydown', (e) => { if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) stepKey(e); });
        const wide = d.documentElement.clientWidth;
        for (const t of d.querySelectorAll('table')) {
          if (t.scrollWidth > wide) Object.assign(t.style, { display: 'block', maxWidth: '100%', overflowX: 'auto' });
        }
        const where = (r) => { const f = frame.getBoundingClientRect(); return { left: r.left + f.left, top: r.top + f.top, bottom: r.bottom + f.top, width: r.width, height: r.height }; };
        const offerFlyout = (below) => {
          const sel = d.getSelection();
          if (sel.isCollapsed || !sel.rangeCount || !pendingQuote) return;
          activeHl = null;
          showFlyout(where(sel.getRangeAt(0).getBoundingClientRect()), below);
        };
        d.addEventListener('pointerdown', (e) => {
          setActive(pane);
          hideFlyout();
          closeDial();
          if (e.target.closest?.('mark[data-note]') || (!activeHl && !pendingQuote)) return;
          activeHl = null;
          pendingQuote = '';
          renderContext();
          renderNotes(false);
          markActive();
        });
        d.addEventListener('selectionchange', () => {
          const sel = d.getSelection();
          if (sel.isCollapsed || !sel.rangeCount) return;
          takeSelection(sel.toString(), pane, sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
          if (touch.matches) { clearTimeout(touchTimer); touchTimer = setTimeout(() => offerFlyout(true), 400); }
        });
        d.addEventListener('pointerup', () => setTimeout(() => offerFlyout(false)));
        d.addEventListener('click', (e) => {
          const mark = e.target.closest?.('mark[data-note]');
          if (mark) { e.preventDefault(); return selectHighlight(mark.dataset.note, where(mark.getBoundingClientRect())); }
          // Links never take the frame somewhere else. Another document in the
          // folder opens in the reader; anything on another site opens in a new
          // browser tab, outside the hub.
          const a = e.target.closest?.('a[href], area[href]');
          if (!a) return;
          let url;
          try { url = new URL(a.href, d.baseURI); } catch { return e.preventDefault(); }
          const here = new URL(d.location.href);
          if (url.origin === location.origin && url.pathname === here.pathname && url.hash) return; // a jump within this page
          e.preventDefault();
          if (url.origin !== location.origin) {
            if (/^https?:$/.test(url.protocol) || url.protocol === 'mailto:') window.open(url.href, '_blank', 'noopener,noreferrer');
            return;
          }
          const rel = url.pathname.startsWith('/raw/') ? decodeURIComponent(url.pathname.slice(5)) : null;
          if (rel && docOf(rel)) openDoc(rel, { pane, hash: decodeURIComponent(url.hash.slice(1)), side: e.metaKey || e.ctrlKey || e.altKey });
          else if (rel) window.open(url.href, '_blank', 'noopener');
        }, true);
        const follow = perFrame(() => track(pane));
        frame.contentWindow.addEventListener('scroll', () => { follow(); hideFlyout(); keepPlace(path, frame.contentWindow.scrollY); }, { passive: true });
        highlightAll(v.surface, path);
        if (hash) goTo(pane, hash);
        else if (placesOf()[path]) frame.contentWindow.scrollTo(0, placesOf()[path]);
        track(pane);
      } catch {
        // The frame has left for another site (a redirect or a script, not a click).
        // Bring the saved page back; if it leaves again, stop and say so.
        v.heads = [];
        v.surface = null;
        if (!bounced && !hub.url) { bounced = true; frame.src = rawUrl(path); }
        else v.body.replaceChildren(el('p', 'empty', 'This page keeps trying to leave for another site, so it was stopped.'));
      }
      if (pane === state.active) { renderOutline(); renderContext(); }
    };
    v.frame = frame;
    // A page of a book has the page before and the page after at its sides:
    // faint arrows, and the left and right arrow keys, in the book's reading order.
    if (isBookPage(path)) {
      const book = path.slice(0, path.search(/\.epub\//i) + 5);
      const pages = docs.filter((x) => x.path.startsWith(book + '/') && inView(x)), at = pages.findIndex((x) => x.path === path);
      const wrap = el('div', 'bookwrap');
      frame.step = (dir) => pages[at + dir] && openDoc(pages[at + dir].path, { pane });
      wrap.append(frame);
      for (const [dir, sign, label] of [[-1, '‹', 'The page before in this book (←)'], [1, '›', 'The next page in this book (→)']]) {
        const b = el('button', 'step ' + (dir < 0 ? 'prev' : 'next'), sign);
        b.title = label;
        b.setAttribute('aria-label', label);
        b.disabled = at < 0 || !pages[at + dir];
        b.onclick = () => frame.step(dir);
        wrap.append(b);
      }
      v.body.replaceChildren(wrap);
      return;
    }
    v.body.replaceChildren(frame);
    return;
  }

  const md = await fetchDoc(path);
  if (views[pane] !== v || state.panes[pane].active !== path) return; // changed while loading
  const scroller = el('div', 'scroller'), article = el('article', 'md');
  article.replaceChildren(safeHtml(md));
  // The main front page gives up its right-hand corner to the latest notes and
  // highlights. The box sits outside the article, so it is not itself highlighted.
  if (docOf(path)?.front) { scroller.classList.add('has-latest'); scroller.append(el('aside', 'latest')); }
  scroller.append(article);
  v.body.replaceChildren(scroller);
  Object.assign(v, { scroller, article, surface: article });
  renderLatest();

  const used = new Set();
  for (const h of article.querySelectorAll('h1, h2, h3')) {
    h.dataset.slug = slugify(h.textContent, used);
    h.id = `p${pane}-${h.dataset.slug}`;
    v.heads.push(h);
  }
  // Relative picture, video and sound paths load from the same storage.
  for (const m of article.querySelectorAll('img, video, audio, source')) {
    const src = m.getAttribute('src') || '';
    if (src && !/^([a-z]+:|\/)/i.test(src)) { m.dataset.path = resolve(path, src); m.removeAttribute('src'); srcOf(m.dataset.path).then((u) => { if (u) m.src = u; }); }
    if (m.tagName === 'VIDEO') { m.controls = true; m.playsInline = true; m.preload = 'metadata'; }
  }
  colourCode(article);
  hideAnswers(article);
  labelTables(article);
  if (isFront(path)) appendBrowse(article, pane, folderOf(path));
  if (isFront(path)) {
    const acts = el('div', 'editFront'), b = el('button', '', 'edit front page'), folder = folderOf(path);
    b.onclick = () => editFront(pane, md, folder);
    // A folder's own front page can also lock the folder, or take it out of the workspace.
    if (folder) {
      const rm = el('button', '', 'remove folder…');
      rm.title = 'Take this folder and everything in it out of the workspace';
      rm.onclick = () => removeFolder(folder);
      acts.append(...lockButtons(folder), rm);
    }
    acts.append(b);
    article.prepend(acts);
  }
  highlightAll(article, path);
  article.addEventListener('click', (e) => onDocClick(e, pane));
  article.addEventListener('pointerup', () => setTimeout(() => {
    const sel = window.getSelection();
    if (sel.isCollapsed || !sel.rangeCount || !pendingQuote || !article.contains(sel.anchorNode)) return;
    activeHl = null;
    showFlyout(sel.getRangeAt(0).getBoundingClientRect());
  }));
  const follow = perFrame(() => track(pane));   // headings are measured once per frame, not once per scroll event
  scroller.addEventListener('scroll', () => { follow(); hideFlyout(); keepPlace(path, scroller.scrollTop); }, { passive: true });
  article.addEventListener('mousemove', (e) => { if (view.focus) setHere(pane, e.target); });

  if (keepScroll) scroller.scrollTop = y;
  else if (hash) goTo(pane, hash);
  else scroller.scrollTop = scrollMem.get(pane + ':' + path) ?? placesOf()[path] ?? 0;
  track(pane);
}

// Colour fenced code by the language named on the fence (```c, ```python, …).
// Blocks with no language, or one that isn't known, are left plain.
// Tables with more than three columns do not fit a phone. Each cell is given
// its column's heading, so that on a narrow screen the style sheet can show
// every row as a small card: one line per cell, heading above value.
function labelTables(root) {
  for (const table of root.querySelectorAll('table')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (heads.length <= 3) continue;
    table.classList.add('wide');
    for (const row of table.querySelectorAll('tbody tr')) [...row.children].forEach((cell, i) => { if (heads[i]) cell.dataset.label = heads[i]; });
  }
}
function colourCode(root) {
  if (!window.hljs) return;
  for (const code of root.querySelectorAll('pre code')) {
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1];
    if (!lang || !hljs.getLanguage(lang)) continue;
    code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
  }
}

// ---- music ---------------------------------------------------------------------------
// One player for the whole reader, so music carries on while you read. Its
// playlist is every sound file in the folder, grouped by where it lives.
const player = new Audio();
player.preload = 'metadata';
const music = { path: null, url: null };
const tracks = () => docs.filter((d) => isAudio(d.path));

// The queue: sound and video files lined up to play one after another, in the
// order they were added. While it is empty the player goes through every sound
// file, as before. When it runs out it starts again from the top, unless
// repeat is set to one song or switched off.
let queue = [], repeat = 'all';   // repeat: 'all' (the queue), 'one' (this song), 'off'
const saveQueue = () => store.set('queue:' + config.root, { list: queue, repeat });
function loadQueue() {
  const q = store.get('queue:' + config.root);
  queue = Array.isArray(q?.list) ? q.list : [];
  repeat = ['all', 'one', 'off'].includes(q?.repeat) ? q.repeat : 'all';
}
function toggleQueue(path) {
  queue = queue.includes(path) ? queue.filter((p) => p !== path) : [...queue, path];
  saveQueue();
  renderPlayers();
}
// Put the queue in a random order, keeping what is playing at the top. With
// nothing queued, every sound file is queued first.
function shuffleQueue() {
  const now = nowPath(), list = (queue.length ? queue : tracks().map((t) => t.path)).filter((p) => p !== now);
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  queue = now && (!queue.length || queue.includes(now)) ? [now, ...list] : list;
  saveQueue();
  renderPlayers();
}
const REPEATS = { all: ['repeat', 'Repeating the queue. Press to repeat this song only.'], one: ['repeat1', 'Repeating this song. Press to stop repeating.'], off: ['repeat', 'Not repeating. Press to repeat the queue.'] };
function cycleRepeat() {
  repeat = { all: 'one', one: 'off', off: 'all' }[repeat];
  saveQueue();
  renderPlayers();
}

// A video that is playing is not stopped by opening something else: its
// element is set aside, still playing, so the sound carries on, and put back
// in the viewer when you return to it. Music and a video never play at once.
let bg = null;                 // { el, path }: the one video element kept alive
let lastMedia = 'music';       // which of the two the sidebar controls act on
function parkVideo(body) {
  if (!bg || !body || !body.contains(bg.el)) return;
  if (bg.el.paused || bg.el.ended) { bg = null; return renderPlayers(); }
  $('park').append(bg.el);
  bg.el.play().catch(() => {});   // moving an element pauses it in some browsers
  renderPlayers();
}
function makeVideo() {
  const video = el('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.addEventListener('play', () => { const was = lastMedia; lastMedia = 'video'; player.pause(); if (was !== 'video') renderPlayers(); else tickPlayers(); });
  for (const ev of ['pause', 'timeupdate', 'ended']) video.addEventListener(ev, tickPlayers);
  // A video moves on to the next thing only when there is a queue to move through.
  video.addEventListener('ended', () => { if (bg?.el === video && queue.length) ended(video); });
  return video;
}
// Play a video from the queue. The one video element is reused. If a video
// is on show in a pane, the new one takes its place there; otherwise it plays
// out of sight (sound only), like a video left playing in the background.
function playVideo(path) {
  player.pause();
  if (!bg) { bg = { el: makeVideo(), path }; $('park').append(bg.el); }
  bg.path = path;
  lastMedia = 'video';
  const video = bg.el;
  mediaSrc(path).then((src) => {
    if (bg?.el !== video || bg.path !== path) return;
    video.src = src;
    video.play().catch(() => {});
    const pane = views.findIndex((v) => v.body?.contains(video));
    if (pane >= 0) openDoc(path, { pane }); else renderPlayers();
  });
}
function stopVideo() { if (bg) { bg.el.pause(); bg.el.remove(); bg = null; } }
const nowEl = () => (bg && (lastMedia === 'video' || !music.path) ? bg.el : player);
const nowPath = () => (nowEl() === player ? music.path : bg.path);
const skip = (media, seconds) => { if (isFinite(media.duration)) media.currentTime = Math.max(0, Math.min(media.duration, media.currentTime + seconds)); };
// Player controls are icons; the name is in the tooltip and for screen readers.
const round10 = '<path d="M12 5a7.5 7.5 0 1 1-7.5 7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 1.5v7L7.5 5z"/>';
const ten = '<text x="12" y="15.8" text-anchor="middle" font-size="7.5" font-weight="700" font-family="Helvetica, Arial, sans-serif">10</text>';
const line = (d) => '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
const loop = 'M5 12V9a2 2 0 0 1 2-2h11M15.5 4.5 18 7l-2.5 2.5M19 12v3a2 2 0 0 1-2 2H6M8.5 19.5 6 17l2.5-2.5';
const PLAY_ICONS = {
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
  stop: '<path d="M6 6h12v12H6z"/>',
  prev: '<path d="M5 5h2.5v14H5zM20 5v14L9 12z"/>',
  next: '<path d="M16.5 5H19v14h-2.5zM4 5v14l11-7z"/>',
  queue: '<path d="M3 6h12v2H3zM3 11h12v2H3zM3 16h8v2H3zM17 13h2v3h3v2h-3v3h-2v-3h-3v-2h3z"/>',
  queued: '<path d="M3 6h12v2H3zM3 11h12v2H3zM3 16h8v2H3z"/>' + line('M14 17.5l2.5 2.5 5-5'),
  remove: line('M6 6l12 12M18 6L6 18'),
  keep: line('M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14'),
  kept: line('M5 12.5l4.5 4.5L19 7.5M5 20.5h14'),
  shuffle: line('M3 7h3l9 10h4M3 17h3l3-3.3M12.5 10.3 15 7h4M17 4.5 19.5 7 17 9.5M17 14.5 19.5 17 17 19.5'),
  repeat: line(loop),
  repeat1: line(loop) + '<text x="12" y="14.8" text-anchor="middle" font-size="8" font-weight="700" font-family="Helvetica, Arial, sans-serif">1</text>',
  back10: round10 + ten,
  on10: '<g transform="translate(24 0) scale(-1 1)">' + round10 + '</g>' + ten,
};
function setIcon(b, name, label) {
  if (b.dataset.icon !== name) { b.dataset.icon = name; b.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + PLAY_ICONS[name] + '</svg>'; }
  if (label) { b.title = label; b.setAttribute('aria-label', label); }
}
function iconBtn(name, label, cls) { const b = el('button', 'ic' + (cls ? ' ' + cls : '')); setIcon(b, name, label); return b; }
// The button that adds a sound or video file to the queue, or takes it out.
// Every one on the page is kept in step with the queue by paintQueueBtns().
function paintQueueBtn(b) {
  const inQ = queue.includes(b.dataset.q);
  setIcon(b, inQ ? 'queued' : 'queue', inQ ? 'In the queue. Press to take it out.' : 'Add to the queue');
  b.classList.toggle('on', inQ);
}
const paintQueueBtns = () => document.querySelectorAll('button[data-q]').forEach(paintQueueBtn);
function queueBtn(path) {
  const b = el('button', 'ic q');
  b.dataset.q = path;
  paintQueueBtn(b);
  b.onclick = (e) => { e.stopPropagation(); toggleQueue(path); };
  return b;
}
function skipButtons(media) {
  const back = iconBtn('back10', 'Back ten seconds'), on = iconBtn('on10', 'Forward ten seconds');
  back.onclick = () => skip(media(), -10);
  on.onclick = () => skip(media(), 10);
  return [back, on];
}
const playable = (path) => net.online || kept.has(path);
const clock = (t) => (isFinite(t) ? Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0') : '0:00');

async function playTrack(path, start = true) {
  if (!playable(path)) { net.said = 'That track is not on this device, and the server is not reachable.'; renderNet(); return; }
  if (music.url) URL.revokeObjectURL(music.url);
  music.url = null;
  let src = '';
  if (kept.has(path)) { const copy = await idb.get('docs', keyOf(path)); if (copy?.blob) src = music.url = URL.createObjectURL(copy.blob); }
  if (!src) src = await srcOf(path);
  music.path = path;
  player.src = src;
  if (start) player.play().catch(() => {});
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: path.split('/').pop(), album: path.split('/').slice(0, -1).join(' / ') });
  renderPlayers();
}
// Next, or previous. "Previous" first goes back to the start of the track; a
// second press within three seconds goes to the track before.
// What next and previous step through: the queue, or every sound file if nothing is queued.
const playList = () => (queue.length ? queue : tracks().map((t) => t.path)).filter((p) => docOf(p) && playable(p));
const playPath = (path) => (isVideo(path) ? playVideo(path) : playTrack(path));
// `auto`: the track ended by itself, so with repeat off the end of the list is the end.
function stepTrack(dir, auto) {
  const list = playList();
  if (!list.length) return;
  if (dir < 0 && nowEl().currentTime > 3) { nowEl().currentTime = 0; return; }
  const at = list.indexOf(nowPath());
  const to = at < 0 ? (dir > 0 ? 0 : list.length - 1) : at + dir;
  if (auto && repeat === 'off' && to >= list.length) return;
  playPath(list[(to + list.length) % list.length]);
}
// A sound or video file reached its end.
function ended(media) {
  if (repeat === 'one') { media.currentTime = 0; media.play().catch(() => {}); } else stepTrack(1, true);
}
const togglePlay = () => { if (!music.path) { const first = playList()[0]; if (first) playPath(first); } else if (player.paused) player.play().catch(() => {}); else player.pause(); };
player.addEventListener('ended', () => ended(player));
player.addEventListener('play', () => { const was = lastMedia; lastMedia = 'music'; if (bg && !bg.el.paused) bg.el.pause(); if (was !== 'music') renderPlayers(); else tickPlayers(); });
for (const ev of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'emptied']) player.addEventListener(ev, tickPlayers);
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('previoustrack', () => stepTrack(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => stepTrack(1));
}
if (view.volume != null) player.volume = view.volume;

function transport(withSeek) {
  const row = el('div', 'pl-row');
  const prev = iconBtn('prev', 'Back to the start; press again for the track before'), play = iconBtn('play', 'Play', 'pl-play'), next = iconBtn('next', 'Next track');
  prev.onclick = () => stepTrack(-1);
  play.onclick = togglePlay;
  next.onclick = () => stepTrack(1);
  const [back, on] = skipButtons(() => player);
  row.append(prev, back, play, on, next);
  if (!withSeek) return row;
  const mix = iconBtn('shuffle', queue.length ? 'Shuffle the queue' : 'Queue every track, in a random order'), again = iconBtn(...REPEATS[repeat], repeat === 'off' ? 'off' : '');
  mix.onclick = shuffleQueue;
  again.onclick = cycleRepeat;
  row.append(mix, again);
  // Keep the track that is playing on this device, or remove its copy.
  if (music.path && !isPending(music.path)) {
    const path = music.path, here = kept.has(path);
    const keep = iconBtn(here ? 'kept' : 'keep', here ? 'This track is on this device. Press to remove the copy.' : 'Keep this track on this device, to play without the server', here ? 'kept' : '');
    keep.disabled = !here && !net.online;
    keep.onclick = () => { keep.disabled = true; if (here) dropCopy(path); else keepCopy(path); };
    row.append(keep);
  }
  const seek = el('input', 'pl-seek');
  seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = 0;
  seek.setAttribute('aria-label', 'Position in the track');
  seek.oninput = () => { if (isFinite(player.duration)) player.currentTime = (seek.value / 1000) * player.duration; };
  row.append(seek, el('span', 'pl-time', '0:00 / 0:00'));
  // On a phone the device's own volume buttons do this job.
  if (!touch.matches) {
    const vol = el('input', 'pl-vol');
    vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = Math.round(player.volume * 100);
    vol.title = 'Volume';
    vol.setAttribute('aria-label', 'Volume');
    vol.oninput = () => { player.volume = vol.value / 100; view.volume = player.volume; store.set('view', view); };
    row.append(vol);
  }
  return row;
}
function showPlayer(pane, path) {
  const v = views[pane];
  const box = el('div', 'player');
  v.bar.style.width = '0%';
  v.body.replaceChildren(box);
  // Opening the page does not start anything. With nothing loaded yet, this track is made ready, paused.
  if (!music.path) playTrack(path, false); else renderPlayers();
}
// The rows of the queue, in order. `where` adds the folder beside each name (the player has room for it; the sidebar does not).
function queueRows(where) {
  const rows = [];
  for (const p of queue) {
    if (gateOf(p)) continue;   // in a locked folder: not named until it is opened
    const ok = !!docOf(p) && playable(p);
    const row = el('div', 'track' + (p === nowPath() ? ' cur' : '') + (ok ? '' : ' gone'));
    row.dataset.path = p;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.append(el('span', '', p.split('/').pop()));
    if (where) row.append(isVideo(p) ? el('small', '', 'video') : pathLabel(p.split('/').slice(0, -1).join(' / ') || 'top level'));
    const out = iconBtn('remove', 'Take out of the queue', 'q');
    out.onclick = (e) => { e.stopPropagation(); toggleQueue(p); };
    row.append(out);
    row.onclick = () => ok && playPath(p);
    rows.push(row);
  }
  return rows;
}
const miniQ = { now: null, top: 0 };   // the sidebar's queue: what was playing when it was last drawn, and how far it was scrolled
function renderPlayers() {
  const name = music.path ? music.path.split('/').pop() : 'Nothing playing', dir = music.path ? music.path.split('/').slice(0, -1).join(' / ') || 'top level' : '';
  for (const box of document.querySelectorAll('.player')) {
    box.replaceChildren(el('div', 'now', name), el('div', 'where', dir), transport(true));
    // The queue, under the controls: what plays next, in order.
    box.append(el('h5', '', 'Queue' + (queue.length ? ' · ' + queue.length : '')));
    if (!queue.length) box.append(el('p', 'qnone', 'Nothing queued, so the player goes through every track. Press the queue button on a track or a video to line it up.'));
    box.append(...queueRows(true));
    if (queue.length) {
      const clear = el('button', 'qlink', 'clear the queue');
      clear.onclick = () => { queue = []; saveQueue(); renderPlayers(); };
      const keep = el('button', 'qlink', 'save as a group…');
      keep.onclick = () => startPick(queue.filter((p) => !gateOf(p)).map((p) => ({ label: p.split('/').pop(), target: encPath(p) })));
      box.append(clear, keep);
    }
    box.append(el('h5', '', 'All tracks'));
    // One list of everything, unless "group by folder" is chosen.
    const grouped = !!state.grouped;
    const mode = el('button', 'qlink', grouped ? 'show all together' : 'group by folder');
    mode.onclick = () => { state.grouped = !grouped; save(); renderPlayers(); };
    box.append(mode);
    let group = null;
    for (const t of tracks().filter(inView)) {
      const folder = t.path.split('/').slice(0, -1).join(' / ') || 'top level';
      if (grouped && folder !== group) { group = folder; box.append(el('h5', '', folder)); }
      const here = kept.has(t.path), ok = playable(t.path);
      const row = el('div', 'track' + (t.path === music.path ? ' cur' : '') + (ok ? '' : ' gone'));
      row.dataset.path = t.path;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      const st = el('button', 'st' + (here ? ' kept' : ''), here ? '●' : '○');
      st.title = here ? 'On this device. Press to remove the copy.' : 'On the server only. Press to keep a copy on this device.';
      st.setAttribute('aria-label', st.title);
      st.onclick = (e) => { e.stopPropagation(); if (here) dropCopy(t.path); else keepCopy(t.path); };
      row.append(st, el('span', '', t.path.split('/').pop()));
      if (!grouped) row.append(pathLabel(folder));
      row.append(el('small', '', here ? 'on this device' : ok ? 'server only' : 'not available offline'), queueBtn(t.path));
      row.onclick = () => ok && playTrack(t.path);
      box.append(row);
    }
    if (!tracks().filter(inView).length) box.append(el('p', 'empty', view.onlyKept && tracks().length ? 'No sound files are kept on this device. “Show everything” in the file list brings the rest back.' : 'No sound files in this folder yet.'));
  }
  // The small controls in the sidebar: for the video that is carrying on in
  // the background, or else for the music.
  const mini = $('mini'), video = bg && nowEl() === bg.el;
  mini.hidden = !music.path && !bg;
  if (video) {
    const title = el('a', '', '▶ ' + bg.path.split('/').pop()), row = el('div', 'pl-row');
    const play = iconBtn('play', 'Play', 'v-play'), stop = iconBtn('stop', 'Stop'), [back, on] = skipButtons(() => bg.el);
    title.title = 'Go back to the video';
    title.onclick = () => openDoc(bg.path);
    play.onclick = () => (bg.el.paused ? bg.el.play().catch(() => {}) : bg.el.pause());
    stop.onclick = () => { const here = views.some((v) => v.body.contains(bg.el)); if (here) bg.el.pause(); else stopVideo(); renderPlayers(); };
    row.append(back, play, on, stop);
    if (queue.length) { const next = iconBtn('next', 'Next in the queue'); next.onclick = () => stepTrack(1); row.append(next); }
    row.append(el('span', 'pl-time v-time', ''));
    mini.replaceChildren(title, row);
  } else if (music.path) {
    const title = el('a', '', '♪ ' + name);
    title.title = 'Open the player and playlist to the side; press again to open it in the main pane';
    // The player opens to the right first, leaving what is being read where it is.
    // With the player already there, the next press opens it in the main pane.
    title.onclick = () => openDoc(music.path, isAudio(state.panes[1]?.active) ? { pane: 0 } : { pane: 0, side: true });
    const row = transport(false);
    row.append(el('span', 'pl-time', ''));
    mini.replaceChildren(title, row);
  }
  // The queue, under the small controls: three rows show at a time, the rest by scrolling.
  if (!mini.hidden && queue.length) {
    const list = el('div', 'mini-q'), now = nowPath();
    list.append(...queueRows(false));
    mini.append(list);
    // Keep the place it was scrolled to, unless what is playing has changed.
    const cur = list.querySelector('.cur');
    list.scrollTop = now === miniQ.now || !cur ? miniQ.top : cur.offsetTop;
    miniQ.now = now;
    list.onscroll = () => { miniQ.top = list.scrollTop; };
    miniQ.top = list.scrollTop;
  }
  paintQueueBtns();
  markPlaying();
  tickPlayers();
}
// Mark the playing track in the file list (the list is not rebuilt for this).
function markPlaying() {
  for (const row of treeEl.querySelectorAll('.file.playing')) row.classList.remove('playing');
  if (music.path) for (const row of treeEl.querySelectorAll('.file')) if (row.dataset.path === music.path) row.classList.add('playing');
}
function tickPlayers() {
  for (const b of document.querySelectorAll('.pl-play')) setIcon(b, player.paused ? 'play' : 'pause', player.paused ? 'Play' : 'Pause');
  for (const t of document.querySelectorAll('.pl-time:not(.v-time)')) t.textContent = clock(player.currentTime) + ' / ' + clock(player.duration);
  for (const b of document.querySelectorAll('.v-play')) setIcon(b, bg && !bg.el.paused ? 'pause' : 'play', bg && !bg.el.paused ? 'Pause' : 'Play');
  for (const t of document.querySelectorAll('.v-time')) if (bg) t.textContent = clock(bg.el.currentTime) + ' / ' + clock(bg.el.duration);
  for (const sk of document.querySelectorAll('.pl-seek')) if (document.activeElement !== sk) sk.value = isFinite(player.duration) && player.duration ? (player.currentTime / player.duration) * 1000 : 0;
}

// Pictures, video and sound. A picture starts fitted to the pane; clicking it
// (or the button) switches to its real size, keeping the clicked spot in place.
//
// On a phone the viewer is a lightbox: it takes the whole screen (the top bar
// and the tabs give way, the note box stays below it), so its bar carries its
// own way to the notes and its own close. A picture at its real size there is
// "immersive": the screen is the picture, with the bar, the arrows and the reel
// laid over it, and the browser's own bars put away where the browser allows.
// That is kept while stepping from one picture to the next.
let immersive = false;
function setImmersive(on) {
  on = on && phone.matches;
  if (immersive === on) return;
  immersive = on;
  document.body.classList.toggle('immersive', on);
  if (on) document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {});   // an iPhone has none: the page alone is filled
  else if (document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
}
// Full screen left by the device's own gesture or key: the picture goes back to fitting.
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement || !immersive) return;
  const box = views[state.active]?.body.querySelector(':scope > .viewer.lb');
  if (box?.unzoom) box.unzoom(); else setImmersive(false);
});
function lightboxSync() {
  const on = !!views[state.active]?.body.querySelector(':scope > .viewer.lb');
  document.body.classList.toggle('lightbox', on);
  if (!on) setImmersive(false);
}
// Close leaves the pictures altogether: back past the ones stepped through, to the page they were opened from.
function lightboxBtns(pane) {
  const notesB = el('button', 'lbOnly', 'notes'), x = el('button', 'lbOnly x', '×');
  notesB.onclick = () => drawer('right');
  x.title = 'Close';
  x.setAttribute('aria-label', 'Close');
  x.onclick = () => {
    setImmersive(false);
    const t = trail[pane] || [];
    while (t.length && (isImage(t[t.length - 1]) || isVideo(t[t.length - 1]))) t.pop();
    if (backTo(pane)) goBack(pane); else closeTab(pane, state.panes[pane].active);
  };
  return [notesB, x];
}
function showMedia(pane, path) {
  const v = views[pane], url = rawUrl(path);
  const box = el('div', 'viewer lb'), bar = el('div', 'viewbar'), stage = el('div', 'stage fit');
  bar.append(el('span', '', path.split('/').pop()));
  const open = el('a', '', 'open in new tab');
  open.href = url;
  open.target = '_blank';
  open.rel = 'noopener';
  if (isImage(path)) {
    const img = el('img');
    img.alt = path.split('/').pop();
    img.decoding = 'async';
    const size = el('button', '', 'full size');
    const setFit = (fit, at) => {
      // Where the pointer is, as a fraction of the picture, so that spot stays put.
      // (Fitted, the picture is drawn in the middle of a box the size of the stage: the fraction is of what is drawn, not of the box.)
      const frame = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
      const k = stage.classList.contains('fit') && img.naturalWidth ? Math.min(frame.width / img.naturalWidth, frame.height / img.naturalHeight) : 0;
      const r = k ? { left: frame.left + (frame.width - img.naturalWidth * k) / 2, top: frame.top + (frame.height - img.naturalHeight * k) / 2, width: img.naturalWidth * k, height: img.naturalHeight * k } : frame;
      const clamp = (x) => Math.min(1, Math.max(0, x));
      const fx = at ? clamp((at.clientX - r.left) / r.width) : 0.5, fy = at ? clamp((at.clientY - r.top) / r.height) : 0.5;
      const px = at ? at.clientX - s.left : s.width / 2, py = at ? at.clientY - s.top : s.height / 2;
      stage.classList.toggle('fit', fit);
      size.textContent = fit ? 'full size' : 'fit to window';
      setImmersive(!fit);
      if (!fit) { stage.scrollLeft = fx * img.naturalWidth - px; stage.scrollTop = fy * img.naturalHeight - py; }
    };
    box.unzoom = () => setFit(true);
    // Stepped to from a picture at its real size on a phone: this one opens the same way, on its middle.
    if (immersive) { stage.classList.remove('fit'); size.textContent = 'fit to window'; }
    img.onload = () => {
      bar.firstChild.textContent = `${img.alt}  ·  ${img.naturalWidth} × ${img.naturalHeight}`;
      if (!stage.classList.contains('fit')) { stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2; stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2; }
    };
    img.onclick = (e) => setFit(!stage.classList.contains('fit'), e);
    size.onclick = () => setFit(!stage.classList.contains('fit'));
    mediaSrc(path).then((src) => { img.src = src; });
    stage.append(img);
    bar.append(size);
  } else if (isVideo(path)) {
    // Coming back to the video that carried on in the background: the same element, still playing.
    let video = bg && bg.path === path ? bg.el : null;
    if (!video) {
      stopVideo();
      video = makeVideo();
      mediaSrc(path).then((src) => { video.src = src; });
      bg = { el: video, path };
    }
    const playing = !video.paused;
    queueMicrotask(() => { if (playing) video.play().catch(() => {}); });
    const full = el('button', '', 'full screen');
    full.onclick = () => (video.requestFullscreen || video.webkitEnterFullscreen)?.call(video);
    // A video always fits; reached while the pictures were filling the screen, it offers the way back out.
    const unzoom = el('button', 'immOnly', 'fit to window');
    unzoom.onclick = box.unzoom = () => setImmersive(false);
    stage.append(video);
    bar.append(queueBtn(path), full, unzoom);
  } else {
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    stage.append(audio);
  }
  bar.append(keepBtn(path));
  if (!hub.url) bar.append(open);   // a tab of its own could not show this device's token to another hub
  bar.append(...lightboxBtns(pane));
  // The other pictures and videos in the same folder: arrows to the one before
  // and the one after, and a reel of the few on either side to jump to.
  const around = isImage(path) || isVideo(path) ? docs.filter((d) => (isImage(d.path) || isVideo(d.path)) && folderOf(d.path) === folderOf(path) && inView(d) && !gateOf(d.path)) : [];
  const at = around.findIndex((d) => d.path === path);
  const wrap = el('div', 'stagewrap');
  wrap.append(stage);
  box.append(bar, wrap);
  if (at >= 0 && around.length > 1) {
    const go = (i) => around[i] && openDoc(around[i].path, { pane });
    box.step = (dir) => go(at + dir);   // for the arrow keys
    bar.firstChild.after(el('small', '', `${at + 1} of ${around.length}`));
    for (const [dir, sign, label] of [[-1, '‹', 'Previous in this folder (←)'], [1, '›', 'Next in this folder (→)']]) {
      const b = el('button', 'step ' + (dir < 0 ? 'prev' : 'next'), sign);
      b.title = label;
      b.setAttribute('aria-label', label);
      b.disabled = !around[at + dir];
      b.onclick = () => go(at + dir);
      wrap.append(b);
    }
    const reel = el('div', 'reel');
    for (let i = Math.max(0, at - 4); i <= Math.min(around.length - 1, at + 4); i++) {
      const d = around[i], t = el('div', 'thumb' + (i === at ? ' cur' : ''));
      t.dataset.path = d.path;
      t.tabIndex = 0;
      t.setAttribute('role', 'button');
      t.title = d.path.split('/').pop();
      if (i === at) t.setAttribute('aria-current', 'true');
      if (isImage(d.path)) { const small = el('img'); small.loading = 'lazy'; small.alt = ''; mediaSrc(d.path).then((src) => { small.src = src; }); t.append(small); }
      else t.append(videoThumb(d.path));
      t.onclick = () => go(i);
      reel.append(t);
    }
    box.append(reel);
  }
  v.bar.style.width = '0%';
  v.body.replaceChildren(box);
  // A reel wider than the screen is scrolled to have the current one in its middle.
  const reel = box.querySelector('.reel'), cur = reel?.querySelector('.cur');
  if (cur) { const r = reel.getBoundingClientRect(), c = cur.getBoundingClientRect(); reel.scrollLeft += c.left + c.width / 2 - (r.left + r.width / 2); }
}
// A PDF is shown by the browser's own PDF viewer, in a frame. Its pages are
// fixed drawings, so they cannot take the theme's colours as a book's page
// does; what can be done is "night": the frame's colours are turned inside
// out (and the hues turned back), which gives dark pages with light text.
// Night follows the pane's theme, dark or light, until the button is pressed;
// after that it stays as chosen, for every PDF on this device.
// A phone's browser usually has no PDF viewer for a frame: there, and for a
// copy kept on the device, "open" hands the file to the device's own viewer.
function showPdf(pane, path) {
  const v = views[pane], box = el('div', 'viewer'), bar = el('div', 'viewbar');
  bar.append(el('span', '', path.split('/').pop()));
  const open = el('a', '', 'open in new tab');
  open.target = '_blank';
  open.rel = 'noopener';
  v.bar.style.width = '0%';
  box.append(bar);
  v.body.replaceChildren(box);
  if (net.online && !hub.url) {
    const frame = el('iframe', 'pdf'), night = el('button', '', 'night');
    frame.title = path.split('/').pop();
    frame.referrerPolicy = 'no-referrer';
    const paint = () => {
      const probe = el('span');
      box.append(probe);
      probe.style.color = 'var(--paper)';
      const [r, g, b] = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
      probe.remove();
      const on = state.pdfNight ?? (r * 0.299 + g * 0.587 + b * 0.114 < 128);
      frame.classList.toggle('night', on);
      night.setAttribute('aria-pressed', on);
    };
    night.title = 'Dark pages with light text. Pictures in the PDF are turned too.';
    night.onclick = () => { state.pdfNight = !frame.classList.contains('night'); save(); paint(); };
    frame.paint = paint;
    frame.src = open.href = rawUrl(path);
    bar.append(night, keepBtn(path), open);
    box.append(frame);
    paint();
    return;
  }
  // No server in reach, or another hub's file: the frame may only show this server's own address.
  bar.append(keepBtn(path));
  if (kept.has(path)) { mediaSrc(path).then((src) => { if (src) { open.href = src; bar.append(open); } }); box.append(el('p', 'empty', 'This PDF is kept on this device. "open in new tab" hands it to the PDF viewer of this device.')); }
  else box.append(el('p', 'empty', hub.url ? 'A PDF on another hub is shown once a copy is kept on this device: press the keep button, then "open in new tab".' : 'The server is not reachable, and this file has not been kept on this device.'));
}
// A video's thumbnail: the video itself, silent and still, showing its first
// frame. Nothing of it is fetched until the tile is in sight.
const thumbSeen = new IntersectionObserver((all) => {
  for (const e of all) {
    if (!e.isIntersecting) continue;
    thumbSeen.unobserve(e.target);
    mediaSrc(e.target.dataset.video).then((src) => { if (src) e.target.src = src + '#t=0.1'; });
  }
}, { rootMargin: '200px' });
function videoThumb(path) {
  const v = el('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'metadata';
  v.tabIndex = -1;
  v.dataset.video = path;
  thumbSeen.observe(v);
  return v;
}
// Left and right arrows step through the folder's pictures and videos (not while typing, and not while a video has the keys: there they seek).
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.target.matches?.('input, textarea, select, video, audio, [contenteditable]')) return;
  stepKey(e);
});
// The same keys turn the pages of a book. Pressed inside a book's page they arrive in its frame, which hands them here.
function stepKey(e) {
  const stepper = views[state.active]?.body.querySelector('.viewer, .bookwrap iframe');
  if (!stepper?.step || gateOpen()) return;
  e.preventDefault();
  stepper.step(e.key === 'ArrowLeft' ? -1 : 1);
}

// A text or JSON file of web addresses, as media cards. The cards are a page
// the server makes, shown in a frame apart from the reader: that page loads
// pictures and media from the web; the reader itself still loads nothing from
// anywhere but its server.
function cardsFrame(path, within = document.body) {
  const frame = el('iframe', 'cards');
  // Its one script is the server's own; without allow-same-origin the page stays a stranger to the reader.
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  frame.referrerPolicy = 'no-referrer';
  frame.allow = 'fullscreen; picture-in-picture';
  frame.title = 'Media from ' + path.split('/').pop();
  // The gallery is told the colours of the pane it will sit in, so it looks like the reader's own.
  const probe = el('span'), look = [];
  within.append(probe);
  for (const name of ['paper', 'shade', 'ink', 'muted', 'rule', 'accent']) {
    probe.style.color = `var(--${name})`;
    const rgb = getComputedStyle(probe).color.match(/[\d.]+/g);
    if (rgb) look.push(name + '=' + rgb.slice(0, 3).map((x) => Math.round(Number(x)).toString(16).padStart(2, '0')).join(''));
  }
  probe.remove();
  frame.src = '/cards/' + path.split('/').map(encodeURIComponent).join('/') + '?' + look.join('&') + '&size=' + cardSize() + (state.cardsReversed ? '&rev=1' : '');
  return frame;
}
// How wide a card is in a gallery: set by the slider there, kept for this device.
const cardSize = () => Math.min(420, Math.max(70, Number(state.cardSize) || 150));
let cardSaved = 0;
function setCardSize(n) {
  if (!(n >= 70 && n <= 420)) return;
  state.cardSize = Math.round(n);
  for (const g of document.querySelectorAll('.thumbs')) g.style.setProperty('--card', state.cardSize + 'px');
  clearTimeout(cardSaved);
  cardSaved = setTimeout(save, 400);
}
// The gallery of a file of links is a page apart; its slider says what it was set to.
window.addEventListener('message', (e) => {
  const from = [...document.querySelectorAll('iframe.cards')].find((f) => f.contentWindow === e.source);
  if (!from) return;
  // "reverse" in the gallery: remembered here, and the gallery is loaded again in that order.
  if (typeof e.data?.cardsReversed === 'boolean') {
    state.cardsReversed = e.data.cardsReversed;
    save();
    const u = new URL(from.src);
    u.searchParams.set('rev', state.cardsReversed ? '1' : '0');
    from.src = u.href;
  }
  if (typeof e.data?.cardSize === 'number') setCardSize(e.data.cardSize);
});
// A card takes the shape of its picture once that is known (kept within reason).
const shapeCard = (m) => { const w = m.naturalWidth || m.videoWidth, h = m.naturalHeight || m.videoHeight; if (w && h) m.parentNode.style.aspectRatio = String(Math.min(2.5, Math.max(0.4, w / h))); };
// Opening the file loads nothing from the web: it lists what is in it, as
// text. The pictures and media are fetched only when asked for, since that
// tells the sites they are on that this device is looking; the choice is
// remembered for the file.
function showLinks(pane, path) {
  const v = views[pane], box = el('div', 'viewer lb'), bar = el('div', 'viewbar');
  bar.append(el('span', '', path.split('/').pop()), ...lightboxBtns(pane));
  box.append(bar);
  v.bar.style.width = '0%';
  v.body.replaceChildren(box);
  if (hub.url || !net.online) { box.append(el('p', 'empty', 'The media in this file is shown by the server it is on, when that is in reach.')); return; }
  const show = () => { box.replaceChildren(bar, cardsFrame(path, v.root)); };
  if ((state.linksShown || []).includes(path)) return show();
  const ask = el('div', 'linksAsk'), go = el('button', 'main', 'Show the pictures and media'), list = el('div', 'fly');
  ask.append(el('p', '', 'This file holds web addresses. Showing its pictures and media loads them from the sites they are on, which tells those sites this device\'s address. Nothing has been loaded yet.'), go, list);
  go.onclick = () => { state.linksShown = [...(state.linksShown || []), path]; save(); show(); };
  box.append(ask);
  api('/api/links?path=' + encodeURIComponent(path)).then((r) => {
    if (!ask.isConnected) return;
    const sites = new Set(r.items.flatMap((it) => [it.thumb, ...it.media.map((m) => m.url)]).filter(Boolean).map((u) => u.split('/')[2]));
    go.textContent = `Show the pictures and media (${r.items.length}${r.more ? '+' : ''} saved, from ${sites.size} site${sites.size === 1 ? '' : 's'})`;
    list.replaceChildren(...r.items.map((it) => {
      const row = el('div', '', it.title || (it.page || it.media[0]?.url || it.thumb).replace(/^https:\/\//, ''));
      row.prepend(el('small', '', it.media[0]?.kind || (it.thumb ? 'image' : 'page')));
      return row;
    }));
  }).catch(() => {});
}

// "Check Yourself" blocks: hide the answer until asked for.
function hideAnswers(root) {
  for (const bq of root.querySelectorAll('blockquote')) {
    const start = [...bq.children].find((c) => /^Answer/.test(c.querySelector('strong')?.textContent || ''));
    if (!start) continue;
    const details = el('details');
    start.before(details);
    details.append(el('summary', '', 'Show answer'));
    while (details.nextSibling) details.append(details.nextSibling);
  }
}

// Under a front page's description: a row of tiles, one per kind of file in
// that folder (the whole workspace for the main front page). Pressing a tile
// lists what is there; pressing it again closes the list.
const ICONS = {
  all: '<path d="M3 4h7v7H3zM14 4h7v7h-7zM3 15h7v7H3zM14 15h7v7h-7z"/>',
  docs: '<path d="M6 2h9l5 5v15H6zM15 2v5h5M9 12h8M9 16h8M9 8h3"/>',
  media: '<path d="M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.6"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
};
const KINDS = [
  ['all', 'Everything', () => true],
  ['docs', 'Documents', (p) => !isMedia(p)],
  ['media', 'Pictures and video', (p) => isImage(p) || isVideo(p)],
  ['music', 'Music', (p) => isAudio(p)],
];
function appendBrowse(article, pane, folder) {
  const inside = docs.filter((d) => !isFront(d.path) && inView(d) && (!folder || d.path.startsWith(folder + '/')));
  const box = el('div', 'browse'), tiles = el('div', 'tiles'), listing = el('div', 'listing');
  const key = 'browse:' + folder;
  const draw = () => {
    const open = state.browse?.[key];
    for (const t of tiles.children) t.setAttribute('aria-pressed', t.dataset.kind === open);
    listing.replaceChildren();
    const kind = KINDS.find((k) => k[0] === open);
    if (!kind) return;
    const files = inside.filter((d) => kind[2](d.path));
    // Everything is listed together unless "group by folder" is chosen.
    const grouped = !!state.grouped;
    const mode = el('button', '', grouped ? 'show all together' : 'group by folder');
    mode.style.cssText = 'border: 0; padding: 0; color: var(--accent); text-decoration: underline;';
    mode.onclick = () => { state.grouped = !grouped; save(); draw(); renderPlayers(); };
    listing.append(mode);
    if (open === 'all' || open === 'media') {
      const wide = el('label', 'cardSize', 'size '), slide = el('input');
      slide.type = 'range'; slide.min = 70; slide.max = 420; slide.value = cardSize();
      slide.setAttribute('aria-label', 'Size of the cards');
      slide.oninput = () => setCardSize(Number(slide.value));
      wide.append(slide);
      listing.append(wide);
    }
    const whereOf = (d) => (folderOf(d.path).slice(folder ? folder.length + 1 : 0) || 'here').replace(/\//g, ' / ');
    const section = (title, items, build) => { if (items.length) { listing.append(el('h5', '', title)); build(items); } };
    const rows = (items) => {
      let group = null;
      for (const d of items) {
        const where = whereOf(d);
        if (grouped && where !== group) { group = where; listing.append(el('h5', '', where)); }
        const row = el('div', 'item');
        row.dataset.path = d.path;
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.append(el('span', '', isBinary(d.path) ? d.path.split('/').pop() : d.title));
        if (!grouped && where !== 'here') row.append(pathLabel(where));
        if (kept.has(d.path)) row.append(el('small', '', 'on this device'));
        if (isAudio(d.path) || isVideo(d.path)) row.append(queueBtn(d.path));
        row.onclick = (e) => (isAudio(d.path) && playable(d.path) && !(e.metaKey || e.ctrlKey || e.altKey) ? playTrack(d.path) : openDoc(d.path, { pane, side: e.metaKey || e.ctrlKey || e.altKey }));
        listing.append(row);
      }
    };
    // A file of saved links is one card. Pointing at it lists the addresses;
    // pressing it opens the card out into the media itself, scrolling inside the card.
    const linkCards = (items) => {
      for (const d of items) {
        const card = el('div', 'linkcard'), head = el('div', 'head'), fly = el('div', 'fly'), count = el('small', '', 'saved links');
        card.dataset.path = d.path;
        head.tabIndex = 0;
        head.setAttribute('role', 'button');
        head.title = 'Show the media in this file';
        head.append(el('b', '', d.title), count);
        fly.hidden = true;
        let asked = false;   // the addresses are fetched the first time they are wanted
        const load = async () => {
          if (asked) return;
          asked = true;
          try {
            const r = await api('/api/links?path=' + encodeURIComponent(d.path));
            count.textContent = r.items.length + (r.more ? '+' : '') + ' saved';
            fly.replaceChildren(...r.items.map((it) => {
              const row = el('div', '', it.title || (it.page || it.media[0]?.url || it.thumb).replace(/^https:\/\//, ''));
              row.prepend(el('small', '', it.media[0]?.kind || (it.thumb ? 'image' : 'page')));
              return row;
            }));
          } catch { asked = false; }
        };
        card.onmouseenter = () => { if (card.classList.contains('super')) return; load(); fly.hidden = false; };
        card.onmouseleave = () => { fly.hidden = true; };
        head.onclick = () => {
          const on = card.classList.toggle('super');
          fly.hidden = true;
          card.querySelector('iframe')?.remove();
          if (on) { load(); card.append(cardsFrame(d.path, card)); }
        };
        card.append(head, fly);
        listing.append(card);
      }
    };
    const thumbs = (items) => {
      if (grouped) {
        const by = new Map();
        for (const d of items) by.set(whereOf(d), [...(by.get(whereOf(d)) || []), d]);
        for (const [where, group] of by) { listing.append(el('h5', '', where)); thumbGrid(group); }
      } else thumbGrid(items);
    };
    const thumbGrid = (items) => {
      const grid = el('div', 'thumbs');
      grid.style.setProperty('--card', cardSize() + 'px');
      for (const d of items) {
        const t = el('div', 'thumb');
        t.dataset.path = d.path;
        t.tabIndex = 0;
        t.setAttribute('role', 'button');
        t.title = d.path;
        if (isImage(d.path)) { const img = el('img'); img.loading = 'lazy'; img.alt = ''; img.onload = () => shapeCard(img); mediaSrc(d.path).then((src) => { img.src = src; }); t.append(img); }
        else { const still = videoThumb(d.path); still.addEventListener('loadedmetadata', () => shapeCard(still)); t.append(still); }
        t.append(el('b', '', d.path.split('/').pop()), keepBtn(d.path));
        t.onclick = (e) => openDoc(d.path, { pane, side: e.metaKey || e.ctrlKey || e.altKey });
        grid.append(t);
      }
      listing.append(grid);
    };
    if (open === 'all') {
      section('Pictures and video', files.filter((d) => isImage(d.path) || isVideo(d.path)), thumbs);
      section('Music', files.filter((d) => isAudio(d.path)), rows);
      section('Saved links', files.filter((d) => d.links), linkCards);
      section('Documents', files.filter((d) => !isMedia(d.path) && !d.links), rows);
    } else if (open === 'media') thumbs(files);
    else rows(files);
    if (!files.length) listing.append(el('p', 'empty', 'Nothing of this kind here yet.'));
  };
  for (const [id, label, test] of KINDS) {
    const n = inside.filter((d) => test(d.path)).length;
    const t = el('button', 'tile');
    t.dataset.kind = id;
    t.disabled = !n;
    t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`;
    t.append(el('span', '', label), el('small', '', String(n)));
    t.onclick = () => { state.browse = { ...(state.browse || {}), [key]: state.browse?.[key] === id ? null : id }; save(); draw(); };
    tiles.append(t);
  }
  box.append(tiles, listing);
  article.append(box);
  draw();
}

// The front page can be edited in place; it is saved back to FRONTPAGE.md.
function editFront(pane, md, folder = '') {
  editing = true;
  const box = el('div', 'frontEditor'), ta = el('textarea');
  ta.value = md;
  const done = async () => { editing = false; await showDoc(pane); chrome(); };
  const saveBtn = el('button', '', 'Save');
  saveBtn.onclick = async () => { await api('/api/front', 'PUT', { markdown: ta.value, folder }); await loadConfig(); await loadDocs(); done(); };
  const cancel = el('button', '', 'Cancel');
  cancel.onclick = done;
  box.append(el('p', '', 'Markdown. The first "# Heading" is the title; everything after it is the description.'), ta, saveBtn, cancel);
  const scroller = el('div', 'scroller');
  scroller.append(box);
  views[pane].body.replaceChildren(scroller);
  ta.focus();
}

function goTo(pane, slug) {
  const h = views[pane].heads.find((x) => x.dataset?.slug === slug);
  if (h) h.scrollIntoView();
}

// Links between files stay in the hub. Documents listed under "side" in
// hub.json, and modifier-clicks, open in the other pane.
function onDocClick(e, pane) {
  const mark = e.target.closest('mark');
  if (mark) return selectHighlight(mark.dataset.note, mark.getBoundingClientRect());
  // A picture in a document opens in the viewer, where it can be seen full size.
  const pic = e.target.closest('img[data-path]');
  if (pic && !e.target.closest('a') && docOf(pic.dataset.path)) return openDoc(pic.dataset.path, { pane, side: e.metaKey || e.ctrlKey || e.altKey });
  const a = e.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (href.startsWith('#')) { e.preventDefault(); return goTo(pane, decodeURIComponent(href.slice(1))); }
  if (/^[a-z]+:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; return; }
  const [file, hash] = href.split('#');
  if (!file) return;
  const resolved = resolve(state.panes[pane].active, file);
  const target = docOf(resolved);
  e.preventDefault();
  if (!target) { if (!hub.url) window.open(rawUrl(resolved), '_blank', 'noopener'); return; }
  openDoc(resolved, { pane, hash, side: target.side || e.metaKey || e.ctrlKey || e.altKey });
}

// ---- outline, and which heading the reader is under ---------------------------
function track(pane) {
  const v = views[pane];
  let top, scrolled, room;
  if (v.scroller) {
    const box = v.scroller.getBoundingClientRect();
    top = box.top;
    scrolled = v.scroller.scrollTop;
    room = v.scroller.scrollHeight - v.scroller.clientHeight;
    if (view.focus && v.article) setHere(pane, document.elementFromPoint(box.left + box.width / 2, top + box.height * 0.35));
  } else if (v.frame && v.surface) {
    // A framed page: positions are measured inside the frame's own window.
    const w = v.frame.contentWindow;
    top = 0;
    scrolled = w.scrollY;
    room = v.surface.ownerDocument.documentElement.scrollHeight - w.innerHeight;
  } else return;
  v.bar.style.width = (room > 0 ? Math.round((scrolled / room) * 100) : 100) + '%';
  let cur = v.heads[0] || null;
  for (const h of v.heads) { if (h.getBoundingClientRect().top - top < 48) cur = h; else break; }
  if (cur === v.cur) return;
  v.cur = cur;
  if (pane === state.active) { markOutline(); renderContext(); }
}

function renderOutline() {
  const v = views[state.active];
  tocEl.innerHTML = '';
  // The label says which document the outline is of; cut short with … when it does not fit.
  const of = docOf(activeDoc()), name = of ? (of.front ? config.title : of.title) : '';
  $('tocLabel').textContent = 'Outline' + (name ? ' · ' + name : '');
  $('tocLabel').title = name;
  if (!v) return;
  v.heads.forEach((h, k) => {
    const a = el('a', 'l' + h.tagName[1], h.textContent);
    a.href = '#' + (h.dataset?.slug || '');
    a.onclick = (e) => {
      e.preventDefault();
      h.scrollIntoView();
      drawer(null);
      if (h.dataset?.slug) history.replaceState(null, '', '?doc=' + encodeURIComponent(activeDoc()) + '#' + h.dataset.slug);
    };
    tocEl.append(a);
  });
  markOutline();
}
function markOutline() {
  const v = views[state.active];
  [...tocEl.children].forEach((a, k) => a.classList.toggle('active', v.heads[k] === v.cur));
  tocEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

// ---- contents dial ----------------------------------------------------------------
// Scroll the list: the heading nearest its centre is selected (and drawn big).
// Tap the selected heading to go there; tap another to bring it to the centre.
const dial = $('dial'), tocBtn = $('tocBtn');
function closeDial() { dial.hidden = true; tocBtn.setAttribute('aria-expanded', 'false'); }
function markDial() {
  const box = dial.getBoundingClientRect(), mid = box.top + box.height / 2;
  let best = null, gap = Infinity;
  for (const d of dial.querySelectorAll('.d')) {
    const r = d.getBoundingClientRect(), g = Math.abs(r.top + r.height / 2 - mid);
    if (g < gap) { gap = g; best = d; }
  }
  for (const d of dial.querySelectorAll('.d')) d.classList.toggle('sel', d === best);
}
function openDial() {
  const v = views[state.active];
  dial.innerHTML = '';
  if (!v || !v.heads.length) dial.append(el('div', 'none', 'No headings in this document.'));
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  (v ? v.heads : []).forEach((h) => {
    const d = el('div', 'd l' + h.tagName[1], h.textContent);
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.onclick = () => {
      if (d.classList.contains('sel')) { h.scrollIntoView(); closeDial(); }
      else d.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    };
    dial.append(d);
  });
  dial.hidden = false;
  tocBtn.setAttribute('aria-expanded', 'true');
  const at = v ? v.heads.indexOf(v.cur) : -1;
  if (at >= 0) dial.querySelectorAll('.d')[at].scrollIntoView({ block: 'center', behavior: 'auto' });
  markDial();
}
tocBtn.onclick = () => (dial.hidden ? openDial() : closeDial());
dial.addEventListener('scroll', markDial, { passive: true });
document.addEventListener('pointerdown', (e) => { if (!dial.hidden && !e.target.closest('#dial, #tocBtn')) closeDial(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dial.hidden) { closeDial(); tocBtn.focus(); } });

// Everything outside the panes that depends on which document has focus.
function chrome() {
  views.forEach((v, i) => v.root.classList.toggle('active', i === state.active));
  lightboxSync();
  for (const sum of treeEl.querySelectorAll('summary[data-folder]')) paintQuick(sum);
  for (const row of treeEl.querySelectorAll('.file')) {
    row.classList.toggle('active', row.dataset.path === activeDoc());
    row.classList.toggle('open', state.panes.some((p) => p.tabs.includes(row.dataset.path)));
  }
  treeEl.querySelector('.file.active')?.scrollIntoView({ block: 'nearest' });
  pendingQuote = '';
  activeHl = null;
  hideFlyout();
  closeDial();
  renderOutline();
  renderContext();
  renderNotes(false);
  setTabTitle();
  const here = docOf(activeDoc());
  $('mTitle').textContent = here ? (here.front ? config.title : here.title) : config.title;
  if (activeDoc()) history.replaceState(null, '', '?doc=' + encodeURIComponent(activeDoc()));
  save();
}

// ---- selection → what the note is about ---------------------------------------
function takeSelection(raw, pane, node, offset = 0) {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length < 3) return;
  if (pane !== state.active) { state.active = pane; chrome(); }
  pendingQuote = text;
  pendingAt = node && views[pane].surface ? { article: views[pane].surface, node, offset } : null;
  activeHl = null;
  // The heading the selection sits under (not merely the one scrolled to).
  pendingHead = node ? views[pane].heads.filter((h) => h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).pop() || null : null;
  renderContext();
  renderNotes(false);
}
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (sel.isCollapsed || !sel.rangeCount) return;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const pane = views.findIndex((v) => v.article?.contains(node));
  if (pane < 0) return;
  takeSelection(sel.toString(), pane, sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  if (!touch.matches) return;
  clearTimeout(touchTimer);
  touchTimer = setTimeout(() => {
    const s = window.getSelection();
    if (s.isCollapsed || !s.rangeCount || !pendingQuote) return;
    activeHl = null;
    showFlyout(s.getRangeAt(0).getBoundingClientRect(), true);
  }, 400);
});

function renderContext() {
  const c = $('context'), d = docOf(activeDoc());
  c.textContent = '';
  if (!d) return c.append('Open a document to take notes on it.');
  const hl = hlNote();
  if (hl) {
    const x = el('button', '', '×');
    x.type = 'button';
    x.title = 'Stop annotating this highlight';
    x.onclick = () => { activeHl = null; renderContext(); markActive(); };
    const sw = el('span', 'sw');
    sw.style.background = typeOf(hl.type).color;
    c.append('Annotating ', sw, ' ', x, el('b', '', '“' + hl.quote + '”'));
  } else if (pendingQuote) {
    const x = el('button', '', '×');
    x.type = 'button';
    x.title = 'Drop the quote';
    x.onclick = () => { pendingQuote = ''; renderContext(); renderNotes(false); };
    c.append('On: ', x, el('b', '', '“' + pendingQuote + '”'));
  } else {
    const cur = views[state.active].cur;
    c.append('In: ', el('b', '', (d.front ? 'Front page' : d.title) + (cur && cur.textContent !== d.title ? ' › ' + cur.textContent : '')), '  · select text to pin the note to it');
  }
}

// ---- notes ---------------------------------------------------------------------
async function loadNotes() {
  // While changes are still waiting to be sent, this device's copy is the newer one.
  if (!outbox.some((op) => op.kind !== 'file')) {
    try { notes = await api('/api/notes'); saveLocal(); }
    catch (e) { notes = store.get('notes:' + config.root) || notes; if (e.refused) { net.said = 'Notes shown are this device\'s copy: ' + e.message + '.'; renderNet(); } }
  }
  renderNotes();
  renderTree();
}

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim(), doc = activeDoc();
  if (!text || !doc) return;
  endRefs();
  input.value = '';
  const hl = hlNote();
  if (hl && !hl.text) await noteOp({ kind: 'set', id: hl.id, fields: { text } });
  else if (hl) await noteOp({ kind: 'add', note: makeNote({ doc: hl.doc, text, quote: hl.quote, type: hl.type, heading: hl.heading, headingText: hl.headingText, ...(hl.anchor ? { anchor: hl.anchor } : {}) }) });
  else await createNote(text);
  pendingQuote = '';
  activeHl = null;
  renderContext();
  await loadNotes();
  if (!state.notesOpen) setNotesOpen(true);
  notesEl.lastElementChild?.scrollIntoView({ block: 'nearest' });
};
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
  if (e.key === 'Escape') endRefs();
});

// ---- references inside a note ----------------------------------------------------
// Typing "//" in the note box (not followed by a space, and not the "//" of a
// web address) puts a link button on every file, heading, note, highlight and
// media item on the page. Pressing one writes a reference where the "//" was;
// any number can be added. Typing anything else, sending the note or Escape
// takes the buttons away again.
// A reference is written [label](path), [label](path#heading-slug) or
// [label](path#note:id), with the path counted from the top of the workspace.
const ref = { on: false, at: 0, len: 0, n: 0 };
const REF_TARGETS = '#tree .file[data-path], .listing .item[data-path], .thumb[data-path], .track[data-path], #toc a, #notes .note[data-id], .latest .tick[data-id]';
const REF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
const refWatch = new MutationObserver(() => paintRefs());   // lists are redrawn while the buttons are showing
// What an item on the page is, as a label and a target to open: a file, a heading, a note or highlight.
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/').replace(/\(/g, '%28').replace(/\)/g, '%29');
function refParts(node) {
  const label = (s) => { const t = s.replace(/[\[\]\s]+/g, ' ').trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t; };
  if (node.dataset.id) {
    const n = notes.find((x) => x.id === node.dataset.id);
    return n ? { label: label(n.text || n.quote) || 'note', target: `${encPath(n.doc)}#note:${n.id}` } : null;
  }
  if (node.matches('#toc a')) {
    const d = activeDoc(), slug = (node.getAttribute('href') || '').slice(1);
    return d ? { label: label(node.textContent) || 'heading', target: encPath(d) + (slug ? '#' + slug : '') } : null;
  }
  const path = node.dataset.path, d = docOf(path);
  return { label: label(d && !isMedia(path) ? (d.front ? config.title : d.title) : path.split('/').pop()), target: encPath(path) };
}
function refTo(node) {
  const p = refParts(node);
  return p ? `[${p.label}](${p.target})` : '';
}
// The buttons on the items: a link button while references are being added
// to a note, a "+" while items are being picked for a group.
function paintRefs() {
  if (!ref.on && !pick.on) return;
  for (const node of document.querySelectorAll(REF_TARGETS)) {
    const host = node.querySelector('.meta') || node;
    if (ref.on && !node.querySelector('.refBtn')) {
      const b = el('button', 'refBtn');
      b.type = 'button';
      b.innerHTML = REF_ICON;
      b.title = 'Add a reference to this in the note';
      b.setAttribute('aria-label', b.title);
      b.onmousedown = (e) => e.preventDefault();   // the note box keeps the cursor
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const t = refTo(node); if (t) addRef(t); };
      host.append(b);
    }
    if (pick.on && !node.querySelector('.pickBtn')) {
      const item = refParts(node);
      if (!item) continue;
      const b = el('button', 'pickBtn');
      b.type = 'button';
      b.dataset.target = item.target;
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); togglePick(item); };
      host.append(b);
      paintPick(b);
    }
  }
}
const watchItems = () => { if (ref.on || pick.on) refWatch.observe(document.body, { childList: true, subtree: true }); else refWatch.disconnect(); };
function startRefs(at) {
  Object.assign(ref, { on: true, at, len: 2, n: 0 });
  document.body.classList.add('reffing');
  paintRefs();
  watchItems();
}
function endRefs() {
  if (!ref.on) return;
  ref.on = false;
  watchItems();
  document.body.classList.remove('reffing');
  for (const b of document.querySelectorAll('.refBtn')) b.remove();
}

// ---- focus groups -------------------------------------------------------------
// A group is a list of items under a name of the reader's choosing, "#name":
// files, headings, notes, highlights, media, in any mix. Making one: press "#"
// beside Files, press "+" on each item wanted (anywhere on the page), give the
// name, save. A queue of music can be saved as one too. Groups are listed at
// the top of the file list, closed until opened, and are kept on this device.
let groups = [];
const pick = { on: false, items: [] };
const saveGroups = () => store.set('groups:' + config.root, groups);
function loadGroups() {
  const g = store.get('groups:' + config.root);
  groups = Array.isArray(g) ? g.filter((x) => x && typeof x.tag === 'string' && Array.isArray(x.items)) : [];
}
const pickBar = el('div'), pickCount = el('span'), pickName = el('input'), pickSave = el('button', 'main', 'save'), pickStop = el('button', '', 'cancel');
pickBar.id = 'pickBar';
pickBar.hidden = true;
pickName.placeholder = 'name';
pickName.setAttribute('aria-label', 'Name of the group');
pickName.maxLength = 40;
pickBar.append(pickCount, el('b', '', '#'), pickName, pickSave, pickStop);
treeEl.before(pickBar);
const groupBtn = el('button', 'ic', '#');
groupBtn.id = 'groupBtn';
groupBtn.title = 'Make a focus group: pick items, then name it';
groupBtn.setAttribute('aria-label', groupBtn.title);
$('addBtn').before(groupBtn);
function paintPick(b) {
  const inIt = pick.items.some((x) => x.target === b.dataset.target);
  b.textContent = inIt ? '✓' : '+';
  b.setAttribute('aria-pressed', inIt);
  b.title = inIt ? 'In the group being made. Press to take it out.' : 'Add to the group being made';
  b.setAttribute('aria-label', b.title);
}
function paintPicks() {
  pickCount.textContent = pick.items.length ? `${pick.items.length} picked · save as` : 'Press + on what belongs together · save as';
  for (const b of document.querySelectorAll('.pickBtn')) paintPick(b);
}
function togglePick(item) {
  const at = pick.items.findIndex((x) => x.target === item.target);
  if (at >= 0) pick.items.splice(at, 1); else pick.items.push(item);
  paintPicks();
}
function startPick(items = []) {
  pick.on = true;
  pick.items = [...items];
  pickBar.hidden = false;
  pickName.value = '';
  document.body.classList.add('picking');
  groupBtn.setAttribute('aria-pressed', 'true');
  paintRefs();
  paintPicks();
  watchItems();
  if (items.length) pickName.focus();
}
function endPick() {
  pick.on = false;
  pick.items = [];
  pickBar.hidden = true;
  watchItems();
  document.body.classList.remove('picking');
  groupBtn.setAttribute('aria-pressed', 'false');
  for (const b of document.querySelectorAll('.pickBtn')) b.remove();
}
function savePick() {
  const tag = pickName.value.replace(/^#+/, '').trim().replace(/\s+/g, '-');
  if (!tag) { pickName.focus(); return; }
  if (!pick.items.length) return;
  // A name already in use: the items join that group.
  const had = groups.find((g) => g.tag === tag);
  if (had) { for (const it of pick.items) if (!had.items.some((x) => x.target === it.target)) had.items.push(it); }
  else groups.push({ tag, items: pick.items });
  saveGroups();
  state.groupsOpen = [...new Set([...(state.groupsOpen || []), tag])];   // shown open this once, to see what was made
  save();
  endPick();
  renderTree();
}
groupBtn.onclick = () => (pick.on ? endPick() : startPick());
pickSave.onclick = savePick;
pickStop.onclick = endPick;
pickName.addEventListener('keydown', (e) => { if (e.key === 'Enter') savePick(); if (e.key === 'Escape') endPick(); });
// The groups, at the top of the file list.
function drawGroups(section) {
  for (const g of groups) {
    const det = el('details'), kids = el('div', 'kids'), sum = el('summary', '', '#' + g.tag);
    sum.append(el('small', '', ' · ' + g.items.length));
    det.open = (state.groupsOpen || []).includes(g.tag);
    det.addEventListener('toggle', () => {
      pinNext();
      state.groupsOpen = (state.groupsOpen || []).filter((t) => t !== g.tag);
      if (det.open) state.groupsOpen.push(g.tag);
      save();
    });
    for (const item of g.items) {
      const row = el('div', 'file'), out = el('button', '', '×');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = item.label;
      out.title = 'Take out of this group';
      out.setAttribute('aria-label', out.title);
      out.onclick = (e) => { e.stopPropagation(); g.items = g.items.filter((x) => x !== item); if (!g.items.length) groups = groups.filter((x) => x !== g); saveGroups(); renderTree(); };
      row.append(el('span', 'name', item.label), out);
      row.onclick = (e) => openRef(item.target, e.metaKey || e.ctrlKey || e.altKey);
      kids.append(row);
    }
    // What can be played goes to the queue in one press.
    const plays = g.items.map((x) => { try { return x.target.includes('#') ? '' : decodeURIComponent(x.target); } catch { return ''; } }).filter((p) => p && (isAudio(p) || isVideo(p)) && docOf(p));
    const foot = el('div', 'group-foot');
    if (plays.length) {
      const play = el('button', 'qlink', 'add to the queue');
      play.onclick = () => { queue = [...queue, ...plays.filter((p) => !queue.includes(p))]; saveQueue(); renderPlayers(); };
      foot.append(play);
    }
    const drop = el('button', 'qlink', 'delete group');
    drop.onclick = () => { if (drop.textContent === 'delete group') return (drop.textContent = 'really delete?'); groups = groups.filter((x) => x !== g); saveGroups(); renderTree(); };
    foot.append(drop);
    kids.append(foot);
    det.append(sum, kids);
    section(' group').append(det);
  }
}

// The first reference takes the place of the "//"; later ones follow it.
function addRef(token) {
  const v = input.value, put = (ref.n ? ' ' : '') + token;
  input.value = v.slice(0, ref.at) + put + v.slice(ref.at + ref.len);
  Object.assign(ref, { at: ref.at + put.length, len: 0, n: ref.n + 1 });
  input.focus();
  input.setSelectionRange(ref.at, ref.at);
}
input.addEventListener('input', () => {
  const before = input.value.slice(0, input.selectionStart);
  if (/(^|[^:\/])\/\/$/.test(before)) startRefs(before.length - 2); else endRefs();
});
// A note's text is shown as typed, except that a reference in it is a link.
function noteText(text) {
  const box = el('div', 'text'), re = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (let m; (m = re.exec(text));) {
    const a = el('a', 'ref', m[1]);
    a.href = '#';
    a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openRef(m[2], e.metaKey || e.ctrlKey || e.altKey); };
    box.append(text.slice(at, m.index), a);
    at = re.lastIndex;
  }
  box.append(text.slice(at));
  return box;
}
async function openRef(target, side) {
  if (/^https?:/i.test(target)) return void window.open(target, '_blank', 'noopener');
  const cut = target.indexOf('#'), hash = cut < 0 ? '' : target.slice(cut + 1), id = hash.startsWith('note:') ? hash.slice(5) : '';
  let path;
  try { path = decodeURIComponent(cut < 0 ? target : target.slice(0, cut)); } catch { return; }
  if (!docOf(path)) return;
  await openDoc(path, { side, hash: id ? undefined : hash || undefined });
  if (id) showNote(id);
}
// Bring a note or highlight into view: its passage in the open document, and its entry in the notes.
function showNote(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  const mark = views[state.active].surface?.querySelector(`mark[data-note="${CSS.escape(id)}"]`);
  if (mark) flash(mark); else if (n.heading) goTo(state.active, n.heading);
  if (n.quote) selectHighlight(id); else flash(notesEl.querySelector(`.note[data-id="${CSS.escape(id)}"]`));
}

// A note or highlight on the current selection (or, with no selection, on the
// section being read).
async function createNote(text) {
  const head = (pendingQuote && pendingHead) || views[state.active].cur;
  const note = makeNote({
    doc: activeDoc(), text, quote: pendingQuote, type: pendingQuote ? curType().id : '',
    heading: head?.dataset?.slug || '', headingText: head?.textContent || '',
    ...pendingAnchor(),
  });
  await noteOp({ kind: 'add', note });
  return note;
}

// ---- highlights -------------------------------------------------------------------
// The flyout: one swatch per highlight type. On a fresh selection a swatch
// highlights it; on an existing highlight it changes the type.
let touchTimer;
// `below`: on touch screens the system's own selection menu sits above the text.
function showFlyout(rect, below) {
  const f = $('flyout'), hl = hlNote();
  const cur = hl ? typeOf(hl.type).id : curType().id;
  f.innerHTML = '';
  for (const t of types()) {
    const b = el('button', 'sw' + (t.id === cur ? ' cur' : ''));
    b.style.background = t.color;
    b.title = t.name;
    b.onclick = () => pickType(t.id);
    f.append(b);
  }
  const note = el('button', '', 'note');
  note.title = 'Write a note on this';
  note.onclick = async () => { if (!hl) await highlightSelection(curType().id); hideFlyout(); input.focus(); };
  f.append(note);
  if (hl) {
    const rm = el('button', '', hl.text ? 'delete' : 'remove');
    rm.onclick = async () => { await noteOp({ kind: 'del', id: hl.id }); activeHl = null; hideFlyout(); renderContext(); loadNotes(); };
    f.append(rm);
  }
  f.hidden = false;
  const w = f.offsetWidth;
  f.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
  const h = f.offsetHeight, under = rect.bottom + 14;
  if (below && under + h < innerHeight - 8) f.style.top = under + 'px';
  else f.style.top = (rect.top > h + 14 ? rect.top - h - 8 : rect.bottom + 8) + 'px';
}
function hideFlyout() { $('flyout').hidden = true; }
$('flyout').addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection

async function highlightSelection(typeId) {
  if (!pendingQuote) return;
  store.set('hlType', typeId);
  const n = await createNote('');
  pendingQuote = '';
  window.getSelection().removeAllRanges();
  views[state.active].surface?.ownerDocument.getSelection()?.removeAllRanges();
  activeHl = n.id;
  await loadNotes();
  renderContext();
}
async function pickType(typeId) {
  const hl = hlNote();
  store.set('hlType', typeId);
  hideFlyout();
  if (!hl) return highlightSelection(typeId);
  await noteOp({ kind: 'set', id: hl.id, fields: { type: typeId } });
  await loadNotes();
  renderContext();
}
function selectHighlight(id, rect) {
  activeHl = id;
  pendingQuote = '';
  renderContext();
  renderNotes(false);
  markActive();
  if (rect) showFlyout(rect);
  flash(notesEl.querySelector(`.note[data-id="${id}"]`));
}
function markActive() {
  for (const v of views) {
    if (!v.surface) continue;
    const framed = v.surface.ownerDocument !== document; // a framed page has none of the reader's styles
    for (const m of v.surface.querySelectorAll('mark[data-note]')) {
      const on = m.dataset.note === activeHl;
      m.classList.toggle('on', on);
      if (framed) m.style.boxShadow = on ? '0 0 0 2px #8c2f1b' : '';
    }
  }
}
// Clicking elsewhere in a document drops the flyout and the active highlight.
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#flyout')) return;
  hideFlyout();
  if (!e.target.closest('.md') || e.target.closest('mark')) return;
  if (!activeHl && !pendingQuote) return;
  activeHl = null;
  pendingQuote = '';
  renderContext();
  renderNotes(false);
  markActive();
});

// The legend above the notes: rename a type, change its colour, add one.
function renderTypes() {
  const box = el('div');
  box.id = 'types';
  box.append(el('h4', '', 'Highlight types'));
  const saveTypes = async () => { config = ours(await api('/api/config', 'PUT', { highlights: types() })); renderNotes(); };
  for (const t of types()) {
    const row = el('div', 'type' + (t.id === curType().id ? ' cur' : ''));
    const color = el('input');
    color.type = 'color';
    color.value = t.color;
    color.title = 'Change colour';
    color.onchange = () => { t.color = color.value; saveTypes(); };
    const name = el('span', '', t.name);
    name.contentEditable = 'plaintext-only';
    name.spellcheck = false;
    name.title = 'Click to rename';
    name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } };
    name.onblur = () => { const v = name.textContent.trim(); if (v && v !== t.name) { t.name = v; saveTypes(); } else name.textContent = t.name; };
    row.append(color, name);
    box.append(row);
  }
  const add = el('button', '', '+ add a type');
  add.onclick = () => { config.highlights = [...types(), { id: 't' + Date.now().toString(36), name: 'New type', color: '#e0d4f5' }]; saveTypes(); };
  box.append(add);
  return box;
}

function flash(node) {
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  if (node.ownerDocument !== document) { // inside a framed page: no stylesheet to lean on
    node.style.outline = '2px solid #8c2f1b';
    setTimeout(() => { node.style.outline = ''; }, 1200);
    return;
  }
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1200);
}

function renderNotes(rehighlight = true) {
  const doc = activeDoc(), mine = doc && gateOf(doc) ? [] : notes.filter((n) => n.doc === doc);
  $('mNotes').textContent = 'Notes' + (mine.length ? ` (${mine.length})` : '');
  notesEl.innerHTML = '';
  if (state.panes.length > 1) {
    const flip = el('button', 'flip', state.notesTop ? 'move notes below' : 'move notes above');
    flip.onclick = () => { state.notesTop = !state.notesTop; applyLayout(); renderNotes(false); save(); };
    notesEl.append(flip);
  }
  notesEl.append(renderTypes(), el('h4', '', 'Highlights and notes on this document'));
  if (!mine.length) notesEl.append(el('p', 'empty', 'None yet. Select text to highlight it, or type below.'));
  for (const n of mine) {
    const div = el('div', 'note');
    div.dataset.id = n.id;
    if (n.quote) {
      const q = el('div', 'quote', n.quote.length > 160 ? n.quote.slice(0, 160) + '…' : n.quote);
      if (n.type) q.style.borderLeftColor = typeOf(n.type).color;
      q.onclick = () => {
        const mark = views[state.active].surface?.querySelector(`mark[data-note="${n.id}"]`);
        drawer(null);
        if (mark) flash(mark); else goTo(state.active, n.heading);
        selectHighlight(n.id);
      };
      div.append(q);
    }
    if (n.id === activeHl) div.classList.add('on');
    if (lost.has(n.id)) div.classList.add('lost');
    if (n.text) div.append(noteText(n.text));

    const meta = el('div', 'meta');
    meta.append(new Date(n.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
    if (n.type) meta.append(' · ', typeOf(n.type).name);
    if (n.headingText) {
      const where = el('a', '', n.headingText);
      where.href = '#' + n.heading;
      where.onclick = (e) => { e.preventDefault(); goTo(state.active, n.heading); };
      meta.append(' · ', where);
    }
    if (pendingQuote) {
      const attach = el('button', '', n.quote ? 'move to selection' : 'attach selection');
      attach.onclick = async () => { await noteOp({ kind: 'set', id: n.id, fields: { quote: pendingQuote, ...pendingAnchor() } }); pendingQuote = ''; renderContext(); loadNotes(); };
      meta.append(attach);
    }
    const del = el('button', '', 'delete');
    del.onclick = async () => { if (del.textContent === 'delete') return (del.textContent = 'really delete?'); await noteOp({ kind: 'del', id: n.id }); loadNotes(); };
    meta.append(del);
    div.append(meta);

    if (n.reply) {
      const r = el('div', 'reply');
      r.replaceChildren(safeHtml(n.reply));
      if (n.replyDoc) {
        const a = el('a', '', 'Read the full write-up →');
        a.href = '#';
        a.onclick = (e) => { e.preventDefault(); const [f, h] = n.replyDoc.split('#'); openDoc(f, { hash: h, side: true }); };
        r.append(a);
      }
      div.append(r);
    }
    notesEl.append(div);
  }
  if (rehighlight) views.forEach((v, i) => v.surface && highlightAll(v.surface, state.panes[i].active));
  renderLatest();
}
// The latest notes and highlights from every document, newest first, beside
// the main front page. Pressing one opens its document at that passage.
function renderLatest() {
  const cut = (s, n) => { const t = s.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
  for (const box of document.querySelectorAll('.latest')) {
    const recent = notes.filter((n) => docOf(n.doc) && !gateOf(n.doc)).sort((x, y) => (y.ts > x.ts ? 1 : y.ts < x.ts ? -1 : 0)).slice(0, 15);
    box.replaceChildren(el('h5', '', 'Latest notes and highlights'));
    if (!recent.length) box.append(el('p', 'empty', 'None yet.'));
    for (const n of recent) {
      const row = el('div', 'tick');
      row.dataset.id = n.id;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      if (n.type) row.style.borderLeftColor = typeOf(n.type).color;
      if (n.quote) row.append(el('div', 'quote', '“' + cut(n.quote, n.text ? 70 : 120) + '”'));
      if (n.text) row.append(el('div', 'said', cut(n.text, 120)));
      row.append(el('div', 'meta', new Date(n.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' · ' + docOf(n.doc).title));
      row.onclick = async () => { await openDoc(n.doc); showNote(n.id); };
      box.append(row);
    }
  }
}

// Wrap each note's quote in <mark>. Matching ignores whitespace so a selection
// that crossed paragraphs or inline formatting still finds its place.
// ---- anchors: where in a document a highlight belongs ---------------------------
// A highlight used to be found by its words alone, so words that occur twice
// were always marked at the first place. It now carries an anchor as well:
//
//   block, nth   the block it is in (a paragraph, heading, list item, cell):
//                a hash of the block's letters and digits, and which one of
//                the blocks with that hash (0 for the first)
//   start        how far into the block it begins, counted in characters
//                that are not spaces
//   before, after   the few characters on either side
//
// Placing one: the block and offset if the words are still there; otherwise
// every place the words occur, choosing the one whose surroundings fit best;
// otherwise (a note from before anchors) the first place under its heading.
// A highlight that cannot be placed is said to be lost, not dropped.
// The server folds and hashes the same way (server-cpp/src/anchor.hpp).
const BLOCK_TAGS = new Set('P LI H1 H2 H3 H4 H5 H6 PRE TD TH DT DD BLOCKQUOTE FIGCAPTION DIV SECTION ARTICLE MAIN ASIDE HEADER FOOTER NAV BODY DETAILS SUMMARY CAPTION ADDRESS FORM UL OL DL TABLE THEAD TBODY TR FIGURE'.split(' '));
// Text inside <script> and <style> is not part of what the reader sees.
const VISIBLE = { acceptNode: (n) => (/^(SCRIPT|STYLE|NOSCRIPT)$/i.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) };
const lost = new Set();   // highlights whose words were not found in the document as it is now
// Letters and digits only, ASCII letters lowered.
function fold(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) out += ch; else if (c >= 65 && c <= 90) out += ch.toLowerCase(); }
    else if (!(c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x206F) || c === 0x3000 || c === 0xFEFF)) out += ch;
  }
  return out;
}
// FNV-1a, 64 bits, as 16 hex digits. The number is kept as two halves, since a
// JavaScript number holds 53 bits exactly: multiplying by the prime
// 2^40 + 0x1b3 is a shift of the low half into the high one, plus two small products.
function hash64(text) {
  let hi = 0xcbf29ce4, lo = 0x84222325;
  for (const byte of new TextEncoder().encode(text)) {
    lo = (lo ^ byte) >>> 0;
    const low = lo * 0x1b3;
    hi = (hi * 0x1b3 + Math.floor(low / 4294967296) + lo * 256) % 4294967296;
    lo = low % 4294967296;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}
// The document's text with the spaces taken out, where each character of it
// is in the page, and where each block begins.
function textMap(article) {
  const walker = article.ownerDocument.createTreeWalker(article, NodeFilter.SHOW_TEXT, VISIBLE);
  const at = [], starts = [];
  let flat = '', node, last = null;
  while ((node = walker.nextNode())) {
    let block = node.parentNode;
    while (block && block !== article && !BLOCK_TAGS.has(block.nodeName.toUpperCase())) block = block.parentNode;
    const s = node.data;
    for (let i = 0; i < s.length; i++) {
      if (/\s/.test(s[i])) continue;
      if (block !== last) { starts.push(flat.length); last = block; }
      flat += s[i];
      at.push([node, i]);
    }
  }
  return { flat, at, starts, blocks: null };
}
// Each block's hash, worked out the first time one is asked for.
function blocksOf(map) {
  if (map.blocks) return map.blocks;
  const seen = new Map();
  map.blocks = map.starts.map((start, k) => {
    const folded = fold(map.flat.slice(start, map.starts[k + 1] ?? map.flat.length)), hash = folded ? hash64(folded) : '';
    const nth = seen.get(hash) || 0;
    if (hash) seen.set(hash, nth + 1);
    return { start, hash, nth };
  });
  return map.blocks;
}
// The anchor of the words that begin at `start` in the map.
function anchorAt(map, start, length) {
  const block = blocksOf(map).filter((b) => b.start <= start).pop();
  if (!block?.hash) return null;
  return { block: block.hash, nth: block.nth, start: start - block.start, before: map.flat.slice(Math.max(0, start - 24), start), after: map.flat.slice(start + length, start + length + 24) };
}
// The anchor for the text now selected, as { anchor } to add to a note; {} if it cannot be worked out.
function pendingAnchor() {
  const p = pendingAt, needle = pendingQuote.replace(/\s+/g, '');
  if (!p || !needle || !p.article.isConnected) return {};
  try {
    const map = textMap(p.article), point = p.article.ownerDocument.createRange();
    point.setStart(p.node, p.offset);
    point.collapse(true);
    // The first character at or after the start of the selection (the map is in page order).
    let lo = 0, hi = map.at.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (point.comparePoint(map.at[mid][0], map.at[mid][1]) < 0) lo = mid + 1; else hi = mid; }
    // What the browser gives as the selected text can differ a little from the page's text at that point.
    let start = map.flat.startsWith(needle, lo) ? lo : map.flat.indexOf(needle, Math.max(0, lo - needle.length));
    if (start < 0 || Math.abs(start - lo) > needle.length + 40) return {};
    const anchor = anchorAt(map, start, needle.length);
    return anchor ? { anchor } : {};
  } catch { return {}; }
}
// Where a note's words are in the map; -1 if they are not there.
function placeOf(map, n, article) {
  const needle = n.quote.replace(/\s+/g, ''), a = n.anchor;
  if (!needle) return -1;
  if (a?.block) {
    const block = blocksOf(map).find((b) => b.hash === a.block && b.nth === (a.nth || 0));
    if (block && map.flat.startsWith(needle, block.start + (a.start || 0))) return block.start + (a.start || 0);
  }
  const hits = [];
  for (let i = map.flat.indexOf(needle); i >= 0 && hits.length < 200; i = map.flat.indexOf(needle, i + 1)) hits.push(i);
  if (hits.length < 2) return hits.length ? hits[0] : -1;
  if (a) {
    // The place whose surroundings are most like those the highlight was made in.
    const before = a.before || '', after = a.after || '';
    const fit = (i) => {
      let s = 0, t = 0;
      while (s < before.length && map.flat[i - 1 - s] === before[before.length - 1 - s]) s++;
      while (t < after.length && map.flat[i + needle.length + t] === after[t]) t++;
      const block = blocksOf(map).filter((b) => b.start <= i).pop();
      return s + t + (block?.hash === a.block ? 8 : 0);
    };
    let best = hits[0], most = fit(best);
    for (const i of hits.slice(1)) { const f = fit(i); if (f > most) { most = f; best = i; } }
    if (most > 0) return best;
  }
  // No anchor to go by: the first place at or after the note's heading.
  let from = 0;
  try {
    const head = n.heading && article.querySelector(`[data-slug="${CSS.escape(n.heading)}"]`);
    if (head) from = Math.max(0, map.at.findIndex(([node]) => head.contains(node)));
  } catch { /* a heading that cannot be looked for: start from the top */ }
  return hits.find((i) => i >= from) ?? hits[0];
}
function highlightAll(article, path) {
  for (const m of article.querySelectorAll('mark[data-note]')) m.replaceWith(...m.childNodes);
  article.normalize();
  const mine = notes.filter((n) => n.doc === path && n.quote);
  let map = mine.length ? textMap(article) : null;
  const placed = [];
  for (const n of mine) {
    const start = placeOf(map, n, article);
    if (start < 0) { lost.add(n.id); continue; }
    lost.delete(n.id);
    placed.push({ n, start, length: n.quote.replace(/\s+/g, '').length });
  }
  // From the end of the document backwards: marking splits the text it marks,
  // and leaves everything before it where the map says it is.
  placed.sort((x, y) => y.start - x.start);
  let marked = Infinity;   // where the marks made so far begin
  for (const { n, start, length } of placed) {
    if (start + length > marked) map = textMap(article);   // it overlaps one already marked: measure again
    mark(article, map, start, length, n.id, n.type ? typeOf(n.type).color : '');
    marked = Math.min(marked, start);
  }
  for (const d of notesEl.querySelectorAll('.note')) d.classList.toggle('lost', lost.has(d.dataset.id));
  markActive();
}
function mark(article, map, start, length, id, color) {
  const doc = article.ownerDocument, framed = doc !== document, at = map.at;
  const spans = new Map();
  for (let i = start; i < start + length; i++) {
    const [nd, off] = at[i];
    const s = spans.get(nd);
    if (s) s[1] = off; else spans.set(nd, [off, off]);
  }
  // Whitespace-only text between the first and last piece is part of the span too.
  const first = at[start][0], last = at[start + length - 1][0];
  const between = doc.createTreeWalker(article, NodeFilter.SHOW_TEXT, VISIBLE);
  between.currentNode = first;
  for (let nd = first === last ? null : between.nextNode(); nd && nd !== last; nd = between.nextNode()) {
    if (!spans.has(nd) && nd.data.length && !nd.data.includes('\n\n')) spans.set(nd, [0, nd.data.length - 1]);
  }
  // Last piece first, for the same reason as above.
  for (const [nd, [a0, b0]] of [...spans].reverse()) {
    // Pieces in the middle are covered whole, so spaces at their edges are not left as gaps.
    const a = nd === first ? a0 : 0, b = nd === last ? b0 : nd.data.length - 1;
    const range = doc.createRange();
    range.setStart(nd, a);
    range.setEnd(nd, b + 1);
    const el = doc.createElement('mark');
    el.dataset.note = id;
    if (color) el.style.background = color;
    if (framed) { el.style.background = color || '#fbeeb0'; el.style.color = '#1d1b16'; el.style.cursor = 'pointer'; }
    range.surroundContents(el);
  }
}

// ---- live reload when files change on disk --------------------------------------
let events = null;
let asking = 0;
function listen() {
  events?.close();
  if (hub.url) {
    clearInterval(asking);
    asking = setInterval(() => { if (net.online && !document.hidden && !gateOpen()) { loadDocs(); loadNotes(); } }, 60000);
    return;
  }
  events = new EventSource('/api/events');
  events.onerror = probe;
  events.onopen = () => setOnline(true);
  events.onmessage = onFileChange;
}
// Changes arrive one file at a time, often in bursts (a folder upload, a
// save that touches several files). They are collected for a moment and
// answered with one refresh, not one each.
let changed = new Set(), changedSince = 0, changeTimer = 0;
function onFileChange(e) {
  changed.add(JSON.parse(e.data).file);
  if (!changedSince) changedSince = Date.now();
  clearTimeout(changeTimer);
  changeTimer = setTimeout(applyChanges, Date.now() - changedSince > 2000 ? 0 : 400);   // a long burst still refreshes every two seconds
}
async function applyChanges() {
  const files = [...changed];
  changed = new Set();
  changedSince = 0;
  if (files.some((f) => f.endsWith('notes.json'))) loadNotes();
  const others = files.filter((f) => !f.endsWith('notes.json'));
  if (!others.length) return;
  if (others.some((f) => f === 'hub.json' || f === config.front || f === 'FRONTPAGE.md')) await loadConfig();
  await loadDocs();
  if (editing) return;
  if (others.includes('hub.json')) return locksChanged();   // settings changed elsewhere, locks among them: redraw whatever they now hide or show
  for (let i = 0; i < state.panes.length; i++) {
    if (!others.includes(state.panes[i].active)) continue;
    renderTabs(i);
    await showDoc(i, null, true);
    if (i === state.active) renderOutline();
  }
}

// Keep a copy of the page itself, so the reader opens without the server (see sw.js).
// Browsers allow this on HTTPS and on localhost only.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // The page shown came from the copy kept here; the worker has since fetched a changed one.
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'page-updated') $('fresh').hidden = false; });
}
$('fresh').onclick = () => location.reload();

(async function init() {
  // Private copies first: if they are encrypted, ask for the passphrase.
  if (local.start() === 'locked') await askUnlock();
  // Which hub to look at: this one, or the other one this device was pointed at last.
  hubs = store.get('hub:list') || [];
  hub = hubs.find((h) => h.url === store.get('hub:at')) || HOME;
  renderHubs();
  loadHubs();
  // Then find out whether the server knows this device.
  try {
    const r = await call('/api/session', { quiet: true, wait: 3000 });
    if (r.status === 401) return askToPair();
    if (r.ok) session = await r.json();
  } catch { /* not reachable: carry on with what is on this device */ }
  try { await loadConfig(); }
  catch (e) {
    if (pairing) return;
    $('panes').replaceChildren(problemBox(e, e.offline ? (hub.url ? `“${hub.name}” is not reachable, and nothing from it is kept on this device yet` : 'The server is not reachable, and nothing from it is kept on this device yet') : 'The reader could not start'));
    if (hub.url) $('panes').append(homeButton());
    return;
  }
  listen();
  loadWorkspaces();
  refused = store.get('refused:' + config.root) || [];
  outbox = store.get('outbox:' + config.root) || [];
  loadQueue();
  loadGroups();
  pendingFiles = store.get('pending:' + config.root) || [];
  kept = new Set(((await idb.keys('docs')) || []).filter((k) => k.startsWith(config.root + '|')).map((k) => k.slice(config.root.length + 1)));
  if (kept.size || matchMedia('(display-mode: standalone)').matches) askDurable();
  try { notes = outbox.some((op) => op.kind !== 'file') ? store.get('notes:' + config.root) || [] : await api('/api/notes'); }
  catch { notes = store.get('notes:' + config.root) || []; }
  await loadDocs();

  const saved = store.get('layout:' + config.root);
  if (saved?.panes?.length) state = { ...state, ...saved, opened: [], groupsOpen: [] };   // every folder, subfolder and group starts closed, whatever was open last time
  for (const p of state.panes) {
    p.tabs = p.tabs.filter(docOf);
    if (!p.tabs.includes(p.active)) p.active = p.tabs[0] || null;
    if (!p.tabs.includes(p.preview)) p.preview = null;
  }
  state.panes = state.panes.filter((p, i) => i === 0 || p.tabs.length).slice(0, 2);
  state.active = Math.min(state.active, state.panes.length - 1);
  if (!state.panes[0].tabs.length) {
    const first = docs.find((d) => d.front) || docs.find((d) => !d.side) || docs[0];
    if (first) state.panes[0] = { tabs: [first.path], active: first.path, preview: first.path };
  }
  setNotesOpen(state.notesOpen);
  setSideOpen(state.sideOpen);
  renderTree();
  await buildPanes();

  const want = new URLSearchParams(location.search).get('doc');
  const hash = decodeURIComponent(location.hash.slice(1));
  if (want && docOf(want) && want !== activeDoc()) await openDoc(want, { hash });
  else { if (want && hash) goTo(state.active, hash); chrome(); }
  renderNet();
  flush(); // anything left waiting from last time
})().catch(showProblem);
