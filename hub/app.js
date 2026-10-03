// The reader. Loaded as a module so that the page needs no inline script: the
// server's content policy only lets scripts from this server run.
import { store, idb, local } from './local.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const panesEl = $('panes'), treeEl = $('tree'), tocEl = $('toc'), notesEl = $('notes'), input = $('input'), titleEl = $('hubTitle');

let docs = [], config = { title: '' }, notes = [], pendingQuote = '', pendingHead = null, activeHl = null, editing = false;
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
const unreachable = (opts) => Object.assign(new Error('The server is not reachable.'), { offline: true, method: opts.method || 'GET' });
async function call(url, opts = {}) {
  // Known to be out of reach: nothing waits on it. Only the regular look for
  // the server (`probe`) goes out, and everything resumes when that succeeds.
  if (!net.online && !opts.probe) throw unreachable(opts);
  const ctl = new AbortController();
  const wait = opts.wait || (opts.body instanceof Blob ? 30000 + opts.body.size / 20 : net.online ? 8000 : 4000);
  const timer = setTimeout(() => ctl.abort(), wait);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
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
const docOf = (path) => docs.find((d) => d.path === path);
const isHtml = (path) => /\.html?$/.test(path);
const isImage = (path) => /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
const isVideo = (path) => /\.(mp4|m4v|mov|webm|ogv)$/i.test(path);
const isAudio = (path) => /\.(mp3|m4a|wav|ogg)$/i.test(path);
const isMedia = (path) => isImage(path) || isVideo(path) || isAudio(path);
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

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').value = t;
  store.set('theme', t);
}
$('theme').onchange = () => setTheme($('theme').value);
setTheme(store.get('theme') || 'plain');

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
  try { config = await api('/api/config'); store.set('hub:config', config); }
  catch (e) { const last = store.get('hub:config'); if (!last) throw e; config = last; }
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
  config = await api('/api/config', 'PUT', { title: t });
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
    } catch { why = 'the server was not reachable'; stop = true; }
    if (why) { failed++; whyNot.set(why, (whyNot.get(why) || 0) + 1); }
    if (stop) { const rest = files.length - i - 1; if (rest) { failed += rest; whyNot.set('not tried after that', rest); } break; }
  }
  line.textContent = `${saved} added` + (skipped ? `, ${skipped} already here and left alone` : '') + '.';
  if (failed) box.append(el('p', 'say', `${failed} not saved: ` + [...whyNot].map(([w, n]) => `${n} × ${w}`).join('; ') + '. Nothing was lost on your computer; upload the folder again to retry (files already here are skipped).'));
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
setInterval(() => { if (!net.online) probe(); }, 4000);
window.addEventListener('online', probe);
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
    const plain = location.protocol !== 'https:' && !/^(localhost|127\.|\[::1\])/.test(location.host);
    const [codeWrap, code] = field('Pairing code'), [nameWrap, name] = field('A name for this device'), msg = el('p', 'say'), go = el('button', 'main', 'Pair');
    code.autocapitalize = 'characters';
    code.placeholder = 'XXXX-XXXX';
    name.value = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android phone' : /Mac/.test(navigator.userAgent) ? 'Mac' : /Windows/.test(navigator.userAgent) ? 'Windows PC' : 'Computer';
    const tryIt = async () => {
      go.disabled = true;
      msg.textContent = '';
      try {
        const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value, name: name.value }) });
        if (r.ok) return location.reload();
        msg.textContent = r.status === 403 ? 'That code is wrong, already used, or older than ten minutes. Ask for a new one.' : 'The server did not accept that (' + r.status + ').';
      } catch { msg.textContent = 'The server is not reachable.'; }
      go.disabled = false;
    };
    go.onclick = tryIt;
    onEnter(code, tryIt);
    onEnter(name, tryIt);
    card.append(
      el('p', '', 'This server only answers devices it has been introduced to. It is offering a code: on first start it prints one in its terminal (the board shows it on its screen); after that, any paired device can make one under “devices…”.'),
      codeWrap, nameWrap, go, msg);
    if (plain) card.append(el('p', 'say', 'This connection is not encrypted, so the code and everything after it could be read on the network.'));
    else if (location.protocol === 'https:') {
      const a = el('a', '', 'About this hub\'s certificate, and how to trust it on this device');
      a.href = '/trust';
      a.target = '_blank';
      card.append(a);
    }
  });
}

// ---- privacy: connection, this device, copies kept here ----------------------------
let session = null;
const mb = (n) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : Math.max(1, Math.round(n / (1 << 20))) + ' MB');
let storage = null, storageAt = 0;
function renderPrivacy() {
  const box = $('privacy');
  if (!box) return;
  const line = (label, text, cls) => { const d = el('div', cls || ''); d.append(el('b', '', label + ' '), text); return d; };
  const link = (text, fn, title) => { const b = el('button', '', text); b.onclick = fn; if (title) b.title = title; return b; };
  const rows = [];
  // How the page reached the server.
  const here = /^(localhost|127\.|\[::1\])/.test(location.host);
  if (location.protocol === 'https:') {
    const d = line('Connection', 'encrypted (HTTPS) ');
    d.append(link('certificate…', () => window.open('/trust', '_blank', 'noopener'), 'How to make a device trust this hub'));
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
  box.append(el('div', 'sub', '● on this device   ○ server only   ↑ waiting to be sent'));
  if (net.said) box.append(el('div', 'say', net.said));
  // With the settings folded away, anything that needs attention still shows, in one line.
  const brief = net.said || stuck || (refused.length ? `${refused.length} change${refused.length > 1 ? 's' : ''} refused by the server` : '') || (!net.online ? 'Server not reachable' : '');
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
  await idb.put('docs', { key: keyOf(path), root: config.root, path, text, ts: Date.now() });
  kept.add(path);
  if (!had) { renderTree(); renderNet(); }
}
async function keepCopy(path, quiet) {
  try {
    const r = await call(isHtml(path) || isMedia(path) ? rawUrl(path) : '/api/doc?path=' + encodeURIComponent(path));
    if (r.ok) {
      const body = isMedia(path) ? { blob: await r.blob() } : { text: await r.text() };
      await idb.put('docs', { key: keyOf(path), root: config.root, path, ...body, ts: Date.now() });
      kept.add(path);
    }
  } catch {}
  if (!quiet) { renderTree(); renderNet(); renderPlayers(); }
}
// "keep all": one after another, saying how far it has got.
let keeping = null;   // { label, done, total } while it runs
async function keepAll(label, items) {
  if (keeping) return;
  keeping = { label, done: 0, total: items.length };
  renderNet();
  for (const d of items) {
    if (!net.online) break;
    await keepCopy(d.path, true);
    keeping.done++;
    renderNet();
  }
  keeping = null;
  renderTree();
  renderNet();
  renderPlayers();
}
// Where a picture or video is read from: the copy on this device if there is one, else the server.
const blobUrls = new Map();
async function mediaSrc(path) {
  if (!kept.has(path)) return rawUrl(path);
  if (!blobUrls.has(path)) {
    const copy = await idb.get('docs', keyOf(path));
    if (!copy?.blob) return rawUrl(path);
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
  for (const file of fileList) {
    const name = file.name.replace(/[\\/]/g, ' ').replace(/^\.+/, '').trim();
    if (!name || file.size > 50 * 1024 * 1024) continue;
    let path = 'inbox/' + name;
    for (let n = 2; docs.some((d) => d.path === path); n++) path = 'inbox/' + name.replace(/(\.[^.]*)?$/, ` ${n}$1`);
    await idb.put('files', { key: keyOf(path), root: config.root, path, blob: file });
    pendingFiles.push({ path });
    outbox.push({ kind: 'file', path });
    docs.push({ path, group: 'inbox', title: name, side: false, front: false });
  }
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
// A lock with no hash yet is one whose password is chosen on first open.
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
  config = await api('/api/config', 'PUT', { locks: next });
  store.set('hub:config', config);
}
async function lockHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), iterations: 100000 }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
// The password form: to open a locked folder, or to choose the password of one that has none yet.
function lockForm(box, folder, done) {
  const lock = locks()[folder], fresh = !lock?.hash;
  if (!globalThis.crypto?.subtle) { box.append(el('p', 'say', 'Folder locks need an encrypted (HTTPS) connection, or localhost.')); return; }
  const [w1, p1] = field(fresh ? 'New password' : 'Password', 'password'), say = el('p', 'say');
  box.append(el('p', '', fresh ? 'Choose a password for this folder. It is asked for each time the reader is opened.' : 'This folder is locked. Type its password to see what is in it.'), w1);
  let p2 = null;
  if (fresh) {
    const [w2, again] = field('The same again', 'password');
    p2 = again;
    p1.autocomplete = p2.autocomplete = 'new-password';
    box.append(w2);
  }
  const go = el('button', 'main', fresh ? 'Set password' : 'Unlock');
  const run = async () => {
    say.textContent = '';
    if (!p1.value || go.disabled) return;
    if (fresh && p1.value !== p2.value) { say.textContent = 'The two do not match.'; return; }
    go.disabled = true;
    if (fresh) {
      const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      try { await saveLocks({ ...locks(), [folder]: { salt, hash: await lockHash(p1.value, salt) } }); }
      catch (e) { go.disabled = false; say.textContent = e.offline ? 'The server is not reachable. A password can only be set while connected.' : e.message; return; }
    } else if ((await lockHash(p1.value, lock.salt)) !== lock.hash) {
      go.disabled = false;
      say.textContent = 'That is not the password.';
      p1.select();
      return;
    }
    unlocked.add(folder);
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

function renderTree() {
  const y = treeEl.scrollTop;
  treeEl.innerHTML = '';
  const root = { dirs: {}, files: [] };
  for (const d of docs) {
    if (d.front) continue;
    let node = root;
    for (const part of d.path.split('/').slice(0, -1)) node = node.dirs[part] ??= { dirs: {}, files: [] };
    node.files.push(d);
  }
  const front = docs.find((d) => d.front);
  if (front) treeEl.append(fileRow(front, 'Front page'));
  (function draw(node, parent, prefix) {
    // A folder's own front page comes first, under that name.
    const fp = prefix ? node.files.find((f) => isFront(f.path)) : null;
    if (fp) parent.append(fileRow(fp, gateOf(fp.path) ? 'Locked: open to unlock' : 'Front page'));
    for (const [name, sub] of Object.entries(node.dirs)) {
      const det = el('details');
      det.open = state.opened.includes(prefix + name);   // folders start closed
      det.append(el('summary', '', name));
      det.addEventListener('toggle', () => {
        state.opened = state.opened.filter((p) => p !== prefix + name);
        if (det.open) state.opened.push(prefix + name);
        save();
      });
      const kids = el('div', 'kids');
      det.append(kids);
      draw(sub, kids, prefix + name + '/');
      parent.append(det);
    }
    for (const f of node.files) if (f !== fp) parent.append(fileRow(f));
  })(root, treeEl, '');
  treeEl.scrollTop = y;
}

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
  row.onclick = (e) => openDoc(d.path, { side: e.metaKey || e.ctrlKey || e.altKey });
  row.ondblclick = () => openDoc(d.path, { keep: true });
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
  if (v?.scroller && path) scrollMem.set(pane + ':' + path, v.scroller.scrollTop);
}

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
}
async function drawDoc(pane, hash, keepScroll) {
  const v = views[pane], path = state.panes[pane].active;
  const y = v.scroller ? v.scroller.scrollTop : 0;
  Object.assign(v, { heads: [], cur: null, article: null, surface: null, scroller: null, frame: null });
  if (!path) { v.body.replaceChildren(el('p', 'empty', 'Nothing open. Pick a file on the left.')); return; }
  if (gateOf(path)) { showLock(pane, gateOf(path)); return; }

  if (isAudio(path)) { showPlayer(pane, path); return; }
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
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.referrerPolicy = 'no-referrer';
    let bounced = false;
    if (net.online && !isPending(path)) {
      frame.src = rawUrl(path);
      call(rawUrl(path)).then((r) => (r.ok ? r.text() : null)).then((t) => t != null && rememberDoc(path, t)).catch(() => {});
    } else {
      // No server: show the copy kept on this device, if there is one.
      const copy = await docText(path);
      if (copy == null) { v.body.replaceChildren(el('p', 'empty', 'The server is not reachable, and no copy of this page was kept on this device.')); return; }
      frame.srcdoc = copy;
    }
    frame.onload = () => {
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
          takeSelection(sel.toString(), pane, sel.getRangeAt(0).startContainer);
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
        frame.contentWindow.addEventListener('scroll', () => { track(pane); hideFlyout(); }, { passive: true });
        highlightAll(v.surface, path);
        if (hash) goTo(pane, hash);
        track(pane);
      } catch {
        // The frame has left for another site (a redirect or a script, not a click).
        // Bring the saved page back; if it leaves again, stop and say so.
        v.heads = [];
        v.surface = null;
        if (!bounced) { bounced = true; frame.src = rawUrl(path); }
        else v.body.replaceChildren(el('p', 'empty', 'This page keeps trying to leave for another site, so it was stopped.'));
      }
      if (pane === state.active) { renderOutline(); renderContext(); }
    };
    v.frame = frame;
    v.body.replaceChildren(frame);
    return;
  }

  const md = await fetchDoc(path);
  if (views[pane] !== v || state.panes[pane].active !== path) return; // changed while loading
  const scroller = el('div', 'scroller'), article = el('article', 'md');
  article.replaceChildren(safeHtml(md));
  scroller.append(article);
  v.body.replaceChildren(scroller);
  Object.assign(v, { scroller, article, surface: article });

  const used = new Set();
  for (const h of article.querySelectorAll('h1, h2, h3')) {
    h.dataset.slug = slugify(h.textContent, used);
    h.id = `p${pane}-${h.dataset.slug}`;
    v.heads.push(h);
  }
  // Relative picture, video and sound paths load from the same storage.
  for (const m of article.querySelectorAll('img, video, audio, source')) {
    const src = m.getAttribute('src') || '';
    if (src && !/^([a-z]+:|\/)/i.test(src)) { m.dataset.path = resolve(path, src); m.src = rawUrl(m.dataset.path); }
    if (m.tagName === 'VIDEO') { m.controls = true; m.playsInline = true; m.preload = 'metadata'; }
  }
  colourCode(article);
  hideAnswers(article);
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
  scroller.addEventListener('scroll', () => { track(pane); hideFlyout(); }, { passive: true });
  article.addEventListener('mousemove', (e) => { if (view.focus) setHere(pane, e.target); });

  if (keepScroll) scroller.scrollTop = y;
  else if (hash) goTo(pane, hash);
  else scroller.scrollTop = scrollMem.get(pane + ':' + path) || 0;
  track(pane);
}

// Colour fenced code by the language named on the fence (```c, ```python, …).
// Blocks with no language, or one that isn't known, are left plain.
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
  video.addEventListener('play', () => { lastMedia = 'video'; player.pause(); renderPlayers(); });
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
  let src = rawUrl(path);
  if (kept.has(path)) { const copy = await idb.get('docs', keyOf(path)); if (copy?.blob) src = music.url = URL.createObjectURL(copy.blob); }
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
player.addEventListener('play', () => { lastMedia = 'music'; if (bg && !bg.el.paused) bg.el.pause(); renderPlayers(); });
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
  if (path !== music.path) playTrack(path); else renderPlayers();
}
function renderPlayers() {
  const name = music.path ? music.path.split('/').pop() : 'Nothing playing', dir = music.path ? music.path.split('/').slice(0, -1).join(' / ') || 'top level' : '';
  for (const box of document.querySelectorAll('.player')) {
    box.replaceChildren(el('div', 'now', name), el('div', 'where', dir), transport(true));
    // The queue, under the controls: what plays next, in order.
    box.append(el('h5', '', 'Queue' + (queue.length ? ' · ' + queue.length : '')));
    if (!queue.length) box.append(el('p', 'qnone', 'Nothing queued, so the player goes through every track. Press the queue button on a track or a video to line it up.'));
    for (const p of queue) {
      const ok = !!docOf(p) && playable(p);
      const row = el('div', 'track' + (p === nowPath() ? ' cur' : '') + (ok ? '' : ' gone'));
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.append(el('span', '', p.split('/').pop()), el('small', '', isVideo(p) ? 'video' : p.split('/').slice(0, -1).join(' / ') || 'top level'));
      const out = iconBtn('remove', 'Take out of the queue', 'q');
      out.onclick = (e) => { e.stopPropagation(); toggleQueue(p); };
      row.append(out);
      row.onclick = () => ok && playPath(p);
      box.append(row);
    }
    if (queue.length) {
      const clear = el('button', 'qlink', 'clear the queue');
      clear.onclick = () => { queue = []; saveQueue(); renderPlayers(); };
      box.append(clear);
    }
    box.append(el('h5', '', 'All tracks'));
    // One list of everything, unless "group by folder" is chosen.
    const grouped = !!state.grouped;
    const mode = el('button', 'qlink', grouped ? 'show all together' : 'group by folder');
    mode.onclick = () => { state.grouped = !grouped; save(); renderPlayers(); };
    box.append(mode);
    let group = null;
    for (const t of tracks()) {
      const folder = t.path.split('/').slice(0, -1).join(' / ') || 'top level';
      if (grouped && folder !== group) { group = folder; box.append(el('h5', '', folder)); }
      const here = kept.has(t.path), ok = playable(t.path);
      const row = el('div', 'track' + (t.path === music.path ? ' cur' : '') + (ok ? '' : ' gone'));
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      const st = el('button', 'st' + (here ? ' kept' : ''), here ? '●' : '○');
      st.title = here ? 'On this device. Press to remove the copy.' : 'On the server only. Press to keep a copy on this device.';
      st.setAttribute('aria-label', st.title);
      st.onclick = (e) => { e.stopPropagation(); if (here) dropCopy(t.path); else keepCopy(t.path); };
      row.append(st, el('span', '', t.path.split('/').pop()));
      if (!grouped) row.append(el('small', '', folder));
      row.append(el('small', '', here ? 'on this device' : ok ? 'server only' : 'not available offline'), queueBtn(t.path));
      row.onclick = () => ok && playTrack(t.path);
      box.append(row);
    }
    if (!tracks().length) box.append(el('p', 'empty', 'No sound files in this folder yet.'));
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
    title.title = 'Open the player and playlist';
    title.onclick = () => openDoc(music.path);
    const row = transport(false);
    row.append(el('span', 'pl-time', ''));
    mini.replaceChildren(title, row);
  }
  paintQueueBtns();
  tickPlayers();
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
function showMedia(pane, path) {
  const v = views[pane], url = rawUrl(path);
  const box = el('div', 'viewer'), bar = el('div', 'viewbar'), stage = el('div', 'stage fit');
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
      const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
      const fx = at ? (at.clientX - r.left) / r.width : 0.5, fy = at ? (at.clientY - r.top) / r.height : 0.5;
      const px = at ? at.clientX - s.left : s.width / 2, py = at ? at.clientY - s.top : s.height / 2;
      stage.classList.toggle('fit', fit);
      size.textContent = fit ? 'full size' : 'fit to window';
      if (!fit) { stage.scrollLeft = fx * img.naturalWidth - px; stage.scrollTop = fy * img.naturalHeight - py; }
    };
    img.onload = () => { bar.firstChild.textContent = `${img.alt}  ·  ${img.naturalWidth} × ${img.naturalHeight}`; };
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
    stage.append(video);
    bar.append(queueBtn(path), full);
  } else {
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    stage.append(audio);
  }
  bar.append(keepBtn(path), open);
  box.append(bar, stage);
  v.bar.style.width = '0%';
  v.body.replaceChildren(box);
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
  const inside = docs.filter((d) => !isFront(d.path) && (!folder || d.path.startsWith(folder + '/')));
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
    const whereOf = (d) => (folderOf(d.path).slice(folder ? folder.length + 1 : 0) || 'here').replace(/\//g, ' / ');
    const section = (title, items, build) => { if (items.length) { listing.append(el('h5', '', title)); build(items); } };
    const rows = (items) => {
      let group = null;
      for (const d of items) {
        const where = whereOf(d);
        if (grouped && where !== group) { group = where; listing.append(el('h5', '', where)); }
        const row = el('div', 'item');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.append(el('span', '', isMedia(d.path) ? d.path.split('/').pop() : d.title));
        if (!grouped && where !== 'here') row.append(el('small', '', where));
        if (kept.has(d.path)) row.append(el('small', '', 'on this device'));
        if (isAudio(d.path) || isVideo(d.path)) row.append(queueBtn(d.path));
        row.onclick = (e) => openDoc(d.path, { pane, side: e.metaKey || e.ctrlKey || e.altKey });
        listing.append(row);
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
      for (const d of items) {
        const t = el('div', 'thumb');
        t.tabIndex = 0;
        t.setAttribute('role', 'button');
        t.title = d.path;
        if (isImage(d.path)) { const img = el('img'); img.loading = 'lazy'; img.alt = ''; mediaSrc(d.path).then((src) => { img.src = src; }); t.append(img); }
        else t.append(el('i', '', 'video'));
        t.append(el('b', '', d.path.split('/').pop()), keepBtn(d.path));
        t.onclick = (e) => openDoc(d.path, { pane, side: e.metaKey || e.ctrlKey || e.altKey });
        grid.append(t);
      }
      listing.append(grid);
    };
    if (open === 'all') {
      section('Pictures and video', files.filter((d) => isImage(d.path) || isVideo(d.path)), thumbs);
      section('Music', files.filter((d) => isAudio(d.path)), rows);
      section('Documents', files.filter((d) => !isMedia(d.path)), rows);
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
  if (!target) return window.open(rawUrl(resolved), '_blank', 'noopener');
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
function takeSelection(raw, pane, node) {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length < 3) return;
  if (pane !== state.active) { state.active = pane; chrome(); }
  pendingQuote = text;
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
  takeSelection(sel.toString(), pane, sel.getRangeAt(0).startContainer);
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
    try { notes = await api('/api/notes'); saveLocal(); } catch { notes = store.get('notes:' + config.root) || notes; }
  }
  renderNotes();
  renderTree();
}

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim(), doc = activeDoc();
  if (!text || !doc) return;
  input.value = '';
  const hl = hlNote();
  if (hl && !hl.text) await noteOp({ kind: 'set', id: hl.id, fields: { text } });
  else if (hl) await noteOp({ kind: 'add', note: makeNote({ doc: hl.doc, text, quote: hl.quote, type: hl.type, heading: hl.heading, headingText: hl.headingText }) });
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
});

// A note or highlight on the current selection (or, with no selection, on the
// section being read).
async function createNote(text) {
  const head = (pendingQuote && pendingHead) || views[state.active].cur;
  const note = makeNote({
    doc: activeDoc(), text, quote: pendingQuote, type: pendingQuote ? curType().id : '',
    heading: head?.dataset?.slug || '', headingText: head?.textContent || '',
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
  const saveTypes = async () => { config = await api('/api/config', 'PUT', { highlights: types() }); renderNotes(); };
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
  const doc = activeDoc(), mine = notes.filter((n) => n.doc === doc);
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
    if (n.text) div.append(el('div', 'text', n.text));

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
      attach.onclick = async () => { await noteOp({ kind: 'set', id: n.id, fields: { quote: pendingQuote } }); pendingQuote = ''; renderContext(); loadNotes(); };
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
}

// Wrap each note's quote in <mark>. Matching ignores whitespace so a selection
// that crossed paragraphs or inline formatting still finds its place.
function highlightAll(article, path) {
  for (const m of article.querySelectorAll('mark[data-note]')) m.replaceWith(...m.childNodes);
  article.normalize();
  for (const n of notes) if (n.doc === path && n.quote) highlight(article, n.quote, n.id, n.type ? typeOf(n.type).color : '');
  markActive();
}
function highlight(article, quote, id, color) {
  const doc = article.ownerDocument, framed = doc !== document;
  // Text inside <script> and <style> is not part of what the reader sees.
  const visible = { acceptNode: (n) => (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) };
  const walker = doc.createTreeWalker(article, NodeFilter.SHOW_TEXT, visible);
  const at = [];
  let flat = '', node;
  while ((node = walker.nextNode())) {
    const s = node.data;
    for (let i = 0; i < s.length; i++) if (!/\s/.test(s[i])) { flat += s[i]; at.push([node, i]); }
  }
  const needle = quote.replace(/\s+/g, '');
  const start = flat.indexOf(needle);
  if (start < 0 || !needle) return;
  const spans = new Map();
  for (let i = start; i < start + needle.length; i++) {
    const [nd, off] = at[i];
    const s = spans.get(nd);
    if (s) s[1] = off; else spans.set(nd, [off, off]);
  }
  // Whitespace-only text between the first and last piece is part of the span too.
  const first = at[start][0], last = at[start + needle.length - 1][0];
  const between = doc.createTreeWalker(article, NodeFilter.SHOW_TEXT, visible);
  between.currentNode = first;
  for (let nd = first === last ? null : between.nextNode(); nd && nd !== last; nd = between.nextNode()) {
    if (!spans.has(nd) && nd.data.length && !nd.data.includes('\n\n')) spans.set(nd, [0, nd.data.length - 1]);
  }
  for (const [nd, [a0, b0]] of spans) {
    // Pieces in the middle are covered whole, so spaces at their edges are not left as gaps.
    const a = nd === first ? a0 : 0, b = nd === last ? b0 : nd.data.length - 1;
    const range = doc.createRange();
    range.setStart(nd, a);
    range.setEnd(nd, b + 1);
    const mark = doc.createElement('mark');
    mark.dataset.note = id;
    if (color) mark.style.background = color;
    if (framed) { mark.style.background = color || '#fbeeb0'; mark.style.color = '#1d1b16'; mark.style.cursor = 'pointer'; }
    range.surroundContents(mark);
  }
}

// ---- live reload when files change on disk --------------------------------------
let events = null;
function listen() {
  events?.close();
  events = new EventSource('/api/events');
  events.onerror = probe;
  events.onopen = () => setOnline(true);
  events.onmessage = onFileChange;
}
async function onFileChange(e) {
  const { file } = JSON.parse(e.data);
  if (file.endsWith('notes.json')) return loadNotes();
  if (file === 'hub.json' || file === config.front || file === 'FRONTPAGE.md') await loadConfig();
  await loadDocs();
  if (editing) return;
  for (let i = 0; i < state.panes.length; i++) {
    if (state.panes[i].active !== file) continue;
    renderTabs(i);
    await showDoc(i, null, true);
    if (i === state.active) renderOutline();
  }
}

// Keep a copy of the page itself, so the reader opens without the server (see sw.js).
// Browsers allow this on HTTPS and on localhost only.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

(async function init() {
  // Private copies first: if they are encrypted, ask for the passphrase.
  if (local.start() === 'locked') await askUnlock();
  // Then find out whether the server knows this device.
  try {
    const r = await call('/api/session', { quiet: true, wait: 3000 });
    if (r.status === 401) return askToPair();
    if (r.ok) session = await r.json();
  } catch { /* not reachable: carry on with what is on this device */ }
  try { await loadConfig(); }
  catch (e) {
    if (pairing) return;
    $('panes').replaceChildren(problemBox(e, e.offline ? 'The server is not reachable, and nothing from it is kept on this device yet' : 'The reader could not start'));
    return;
  }
  listen();
  loadWorkspaces();
  refused = store.get('refused:' + config.root) || [];
  outbox = store.get('outbox:' + config.root) || [];
  loadQueue();
  pendingFiles = store.get('pending:' + config.root) || [];
  kept = new Set(((await idb.keys('docs')) || []).filter((k) => k.startsWith(config.root + '|')).map((k) => k.slice(config.root.length + 1)));
  try { notes = outbox.some((op) => op.kind !== 'file') ? store.get('notes:' + config.root) || [] : await api('/api/notes'); }
  catch { notes = store.get('notes:' + config.root) || []; }
  await loadDocs();

  const saved = store.get('layout:' + config.root);
  if (saved?.panes?.length) state = { ...state, ...saved, opened: saved.opened || [] };
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
