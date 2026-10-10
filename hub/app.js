// The reader. Loaded as a module so that the page needs no inline script: the
// server's content policy only lets scripts from this server run.
import { store, idb, local } from './local.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const panesEl = $('panes'), treeEl = $('tree'), tocEl = $('toc'), notesEl = $('notes'), input = $('input'), titleEl = $('hubTitle');

let docs = [], config = { title: '' }, notes = [], pendingQuote = '', pendingHead = null, activeHl = null, editing = false;
let pendingAt = null;   // where the selection behind pendingQuote begins: { article, node, offset }
let pendingMg = null;   // the same for words selected on a PDF's page: { of, fields(), clear() } (see drawPdf)
// Layout: one or two panes, each with its open tabs. Saved per folder.
// Pane 0 is the main reader; pane 1, when present, sits in the right column above or below the notes.
let state = { panes: [{ tabs: [], active: null }], active: 0, notesOpen: true, sideOpen: true, notesW: 300, notesH: 40, notesTop: false, opened: [] };
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
    // Each request names the workspace this page shows: the hub refuses one from a page left showing a workspace that is
    // no longer open (412), so nothing here is read from, or written into, the one that is (see workspaceMoved).
    const headers = { ...opts.headers, ...(config.workspace ? { 'X-Hub-Workspace': config.workspace } : {}), ...(hub.url ? { Authorization: 'Bearer ' + hubToken(hub.url) } : {}) };
    const r = await fetch(hub.url + url, { ...opts, headers, signal: ctl.signal });
    clearTimeout(timer);
    setOnline(true);
    if (r.status === 412 && r.headers.get('X-Hub-Workspace')) workspaceMoved();
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
const musicOf = (folder) => folder + '/:music';   // the path of a folder's music page: no file is named so
const rawUrl = (path) => '/raw/' + path.split('/').map(encodeURIComponent).join('/');
const activeDoc = () => state.panes[state.active]?.active || null;
const types = () => config.highlights || [];
const typeOf = (id) => types().find((t) => t.id === id) || types()[0];
const curType = () => typeOf(store.get('hlType'));   // the colour in use until changed
const hlNote = () => notes.find((n) => n.id === activeHl) || null;
const resolve = (base, rel) => decodeURIComponent(new URL(rel, 'http://x/' + base).pathname.slice(1));

// ---- the look, kept on the server as well ----------------------------------
// The theme, the typeface and the reading settings are this device's own, kept in the browser. They are also sent
// to the server whenever one of them is changed, and a device that has made no choice of its own (a browser that
// was cleared or forgets when it is closed, the reader opened at another address, a new device) starts from what
// the server has. So the look outlasts a browser that forgets it. `fresh` notes, before anything is written,
// which of them this device has not chosen; what it has chosen is never overruled by the server.
const fresh = { theme: store.get('theme') == null, font: store.get('font') == null, view: store.get('view') == null,
  panes: store.get('themeOne') == null && store.get('themeSide') == null && store.get('themeRight') == null };
let lookReady = false, lookTimer = 0;   // nothing is sent while the reader is starting: nothing has been chosen yet
function pushLook() {
  if (!lookReady) return;
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => {
    if (!net.online || hub.url) return;
    const look = { theme: document.documentElement.dataset.theme, font: document.documentElement.dataset.font, themeOne: oneTheme,
      themeSide: $('themeSide').value, themeRight: $('themeRight').value, fs: view.fs, roomy: view.roomy, focus: view.focus, scrollTurn: view.scrollTurn, soft: view.soft };
    api('/api/config', 'PUT', { look }).catch(() => {});
  }, 1200);
}
// Once the server's settings are in (see the start): take its look for whatever this device has not chosen.
function adoptLook() {
  const look = hub.url ? null : config.look;
  if (look) {
    if (fresh.theme && [...$('theme').options].some((o) => o.value === look.theme)) setTheme(look.theme);
    if (fresh.font && FONTS.includes(look.font)) setFont(look.font);
    if (fresh.panes) {
      for (const [id] of paneThemes) if (typeof look[id] === 'string' && [...$(id).options].some((o) => o.value === look[id])) { $(id).value = look[id]; store.set(id, look[id]); }
      if (typeof look.themeOne === 'boolean') { oneTheme = look.themeOne; store.set('themeOne', oneTheme); }
      applyPaneThemes();
    }
    if (fresh.view) {
      if (look.fs >= 14 && look.fs <= 28) view.fs = Math.round(look.fs);
      for (const k of ['roomy', 'focus', 'scrollTurn', 'soft']) if (typeof look[k] === 'boolean') view[k] = look[k];
      applyView();
    }
  }
  lookReady = true;
  if (!look && !hub.url && !fresh.theme) pushLook();   // the server has none yet: it is given this device's
}

// ---- font switcher, notes panel toggle ------------------------------------
// The typefaces: the reader's serif and sans (the device's own), and two made for reading, served by the hub
// (/vendor/fonts/, from @fontsource): Atkinson Hyperlegible and OpenDyslexic. Their faces are declared here, once, for
// the page and for the frame a book's page is in; a browser fetches a file only when its typeface is used.
const FONTS = ['serif', 'sans', 'legible', 'dyslexic'];
const FACES = [['Atkinson Hyperlegible', 'atkinson-hyperlegible', true], ['OpenDyslexic', 'opendyslexic', false]].flatMap(([family, file, ext]) =>
  ['400-normal', '400-italic', '700-normal', '700-italic'].flatMap((cut) => [['latin', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
    ...(ext ? [['latin-ext', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF']] : [])]
    .map(([set, range]) => `@font-face { font-family: "${family}"; font-weight: ${cut.slice(0, 3)}; font-style: ${cut.slice(4)}; font-display: swap; src: url(/vendor/fonts/${file}-${set}-${cut}.woff2) format("woff2"); unicode-range: ${range}; }`))).join('\n');
document.head.append(Object.assign(document.createElement('style'), { textContent: FACES }));
// `keep` false: a default being shown, not a choice to remember.
function setFont(f, keep = true) {
  if (!FONTS.includes(f)) f = 'serif';
  document.documentElement.dataset.font = f;
  $('fontToggle').value = f;
  if (keep) { store.set('font', f); pushLook(); }
  for (const v of views) dressBook(v);   // a book's page has the typeface written into it (see dressBook)
}
$('fontToggle').onchange = () => setFont($('fontToggle').value);
setFont(store.get('font') || 'serif', !fresh.font);

// A page of a book (an .epub) reads as the reader's own documents do: the
// colours of the pane it is in, the reader's typeface and text size, its
// column, "roomy" and "focus". A book is text to be poured into whatever is
// reading it, and the same controls work on it as on everything else.
// The page is in a frame, where the reader's own styles do not reach, so all
// of it is worked out here and written into a style element in the page.
// Other HTML pages are left looking as their author made them.
const isBookPage = (path) => /\.epub\//i.test(path);
// A page of a book, named anywhere but among the book's own pages, says whose it is after its name: "Contents" alone
// could be any book's. The book goes by its title, else by its file's name.
const bookOf = (path) => path.slice(0, path.search(/\.epub\//i) + 5);
const bookName = (path) => docOf(path)?.bookTitle || givenName(bookOf(path)).replace(/\.epub$/i, '');
const withBook = (path, name) => (isBookPage(path) && !name.endsWith(' - ' + bookName(path)) ? name + ' - ' + bookName(path) : name);
const titleOf = (d) => withBook(d.path, pageTitle(d));
// The same for what a group (#fav and the rest) holds: it was saved under the page's name alone, or a note's words.
const shownLabel = (item) => {
  try {
    const path = decodeURIComponent(item.target.split('#')[0]), d = docOf(path);
    return withBook(path, d && !item.target.includes('#') && item.label === d.title ? pageTitle(d) : item.label);   // saved under its file's name, before the page was known for a title page or the contents
  } catch { return item.label; }
};
function dressBook(v) {
  if (!v?.dress || !v.body) return;
  const probe = el('span'), c = {};
  v.body.append(probe);
  for (const name of ['paper', 'ink', 'accent']) { probe.style.color = `var(--${name})`; c[name] = getComputedStyle(probe).color; }
  const face = {};
  for (const name of ['body', 'head']) { probe.style.fontFamily = `var(--${name})`; face[name] = getComputedStyle(probe).fontFamily; }
  probe.remove();
  // A dark pane gets the browser's dark scrollbar too.
  const [r, g, b] = c.paper.match(/[\d.]+/g).map(Number), dark = r * 0.299 + g * 0.587 + b * 0.114 < 128;
  v.dress.textContent = FACES +
    `html { font-size: ${view.fs}px !important; background: ${c.paper} !important; color-scheme: ${dark ? 'dark' : 'light'}; }` +
    ` body { font-size: 1rem !important; background: ${c.paper} !important; color: ${c.ink} !important; font-family: ${face.body} !important;` +
    ` line-height: ${view.roomy ? 1.95 : 1.65} !important; letter-spacing: ${view.roomy ? '.015em' : 'normal'} !important; word-spacing: ${view.roomy ? '.08em' : 'normal'} !important;` +
    ' max-width: 40em !important; margin: 0 auto !important; padding: 16px 16px 120px !important; }' +
    ' body *:not(mark) { color: inherit !important; background-color: transparent !important; }' +
    ` body a:any-link, body a:any-link *, body [data-mg-href], body [data-mg-href] *, body [data-mg-external], body [data-mg-external] * { color: ${c.accent} !important; }` +
    // The reader's typeface for the text and for the headings; what is set as code keeps its own.
    ' body :not(pre, code, kbd, samp, tt, pre *, code *) { font-family: inherit !important; }' +
    ` body :is(h1, h2, h3, h4, h5, h6), body :is(h1, h2, h3, h4, h5, h6) * { font-family: ${face.head} !important; }` +
    // The reader's text size all the way down: a book that sets its paragraphs (or what they sit in) in points or
    // pixels would otherwise stay as it was while A− and A+ only moved its margins. Headings take the reader's steps.
    ' body :not(h1, h2, h3, h4, h5, h6, small, sub, sup, pre, code, kbd, samp, tt) { font-size: inherit !important; }' +
    ' body h1 { font-size: 1.7em !important; } body h2 { font-size: 1.25em !important; } body h3 { font-size: 1.1em !important; } body :is(h4, h5, h6) { font-size: 1em !important; }' +
    ' body :is(small, sub, sup) { font-size: .8em !important; } body :is(pre, code, kbd, samp, tt) { font-size: .9em !important; } body pre code { font-size: 1em !important; }' +
    ' body :is(p, li) { line-height: inherit !important; }' +
    (view.roomy ? ' body :is(p, li) { margin-bottom: 1.3em !important; }' : '') +
    // How many notes are on a paragraph, in the margin (see marginCounts).
    ` body [data-notes] { position: relative !important; } body [data-notes]::after { content: attr(data-notes); position: absolute; top: .15em; right: -2.4em; min-width: 1.5em; padding: 0 .35em; border-radius: .75em; background: color-mix(in srgb, ${c.accent} 14%, ${c.paper}); color: ${c.accent}; font: 600 12px/1.6 ${face.head}; text-align: center; cursor: pointer; }` +
    // Focus: every block faint but the one being read (frameHere marks it). A block inside another is not made fainter still.
    (view.focus ? ` body :is(${FOCUS_BLOCKS}) { opacity: .3; } body :is(${FOCUS_BLOCKS}) :is(${FOCUS_BLOCKS}) { opacity: 1; } body .hub-here { opacity: 1 !important; box-shadow: -12px 0 0 0 ${c.paper}, -16px 0 0 0 ${c.accent}; }` : '');
}
// The block being read in a book's page: the outermost block around `node`.
const FOCUS_BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, pre, table, figure, dt, dd';
function frameHere(v, node) {
  if (!view.focus || !v.dress) return;
  let top = null;
  for (let n = node; n && n.nodeType === 1 && n !== v.surface; n = n.parentElement) if (n.matches(FOCUS_BLOCKS)) top = n;
  if (!top || top === v.bookHere) return;
  v.bookHere?.classList.remove('hub-here');
  v.bookHere = top;
  top.classList.add('hub-here');
}
const dressBooks = () => { views.forEach(dressBook); for (const f of document.querySelectorAll('.viewer .pdf')) f.paint?.(); };   // a PDF's pages follow the theme too

function setTheme(t, keep = true) {
  document.documentElement.dataset.theme = t;
  $('theme').value = t;
  if (keep) { store.set('theme', t); pushLook(); }
  dressBooks();
}
$('theme').onchange = () => setTheme($('theme').value);
setTheme({ focus: 'sun-sound' }[store.get('theme')] || store.get('theme') || 'plain', !fresh.theme);   // "Focus Aid" was renamed
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
  pushLook();
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
// everything except the block being read. And the reader's edges: square, or soft (rounded, and shaded where parts
// meet instead of lined), with any theme.
const view = { fs: 18, roomy: false, focus: false, scrollTurn: true, soft: false, ...(store.get('view') || {}) };
function applyView() {
  document.documentElement.style.setProperty('--fs', view.fs + 'px');
  document.documentElement.dataset.edges = view.soft ? 'soft' : 'square';
  $('softToggle').setAttribute('aria-pressed', view.soft);
  document.body.classList.toggle('roomy', view.roomy);
  document.body.classList.toggle('focus', view.focus);
  $('roomyToggle').setAttribute('aria-pressed', view.roomy);
  $('focusToggle').setAttribute('aria-pressed', view.focus);
  $('turnToggle').setAttribute('aria-pressed', view.scrollTurn);
  store.set('view', view);
  dressBooks();
  if (!view.scrollTurn) for (const v of views) if (v.frame?.hint) v.frame.hint.hidden = true;   // nothing to scroll on to
  for (const v of views) v.body?.querySelector('.bookwrap')?.fitCover?.();   // the text column is as wide as the text is large
  views.forEach((_, i) => track(i));   // apply focus at the reading line as soon as it is switched on
  pushLook();
}
$('roomyToggle').onclick = () => { view.roomy = !view.roomy; applyView(); };
$('softToggle').onclick = () => { view.soft = !view.soft; applyView(); };
$('focusToggle').onclick = () => { view.focus = !view.focus; applyView(); };
$('turnToggle').onclick = () => { view.scrollTurn = !view.scrollTurn; applyView(); };
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
// The note box floats over the foot of the page. How tall it is, with the gap under it, is kept where the styles can
// use it (--note-room), so what scrolls behind it can be scrolled clear of it.
new ResizeObserver(() => { const c = $('composer'), h = c.offsetHeight; $('work').style.setProperty('--note-room', (h ? h + parseFloat(getComputedStyle(c).bottom || 0) + 8 : 0) + 'px'); }).observe($('composer'));
// A phone's keyboard covers the foot of the page without making the page shorter (iOS): the note box is lifted by as much.
if (window.visualViewport) {
  const lift = () => $('composer').style.setProperty('--kb', Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop) + 'px');
  visualViewport.addEventListener('resize', lift);
  visualViewport.addEventListener('scroll', lift);
}
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
$('sideToggle').onclick = () => { setSideOpen(!state.sideOpen); save(); if (state.sideOpen) focusTree(); };
// Settings (text, connection, this device) stay folded away until asked for.
function setSettingsOpen(open) {
  $('settings').hidden = !open;
  $('settingsBtn').setAttribute('aria-expanded', open);
}
$('settingsBtn').onclick = () => setSettingsOpen($('settings').hidden);
$('netBrief').onclick = () => setSettingsOpen(true);
$('sideEdge').onclick = () => { setSideOpen(true); save(); focusTree(); };
$('sideEdge').addEventListener('mouseenter', () => { if (!document.body.classList.contains('side-peek')) focusTree(); document.body.classList.add('side-peek'); });
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
// The bars over the page (the tabs, and a phone's top bar) put away while reading, so the text has the room. The
// button is at the start of the line over the note box, which stays, so it is always there to bring them back.
function paintBare() {
  const on = !!state.bare, b = $('bare');
  document.body.classList.toggle('bare', on);
  b.setAttribute('aria-pressed', on);
  b.title = on ? 'Show the tabs and the top bar again' : 'Put the tabs and the top bar away, for more room to read';
  b.setAttribute('aria-label', b.title);
  if (on) paintBareWhere();
}
$('bare').onclick = () => { state.bare = !state.bare; save(); paintBare(); };
// While they are away, two small muted things lie over the page's top left corner: a gear, which brings the bars back
// and opens the sidebar at its settings; and, for a PDF, the page being read ("page 7 of 120"), which the tab said.
const bareBar = el('div'), bareGear = el('button', 'ic'), bareTools = el('button', 'ic'), bareWhere = el('small'), bareLess = el('button', '', '−'), bareMore = el('button', '', '+');
bareBar.id = 'bareBar';
bareGear.id = 'bareGear';
bareWhere.id = 'bareWhere';
bareGear.type = 'button';
bareGear.title = 'Settings and the sidebar: brings the tabs and the top bar back';
bareGear.setAttribute('aria-label', bareGear.title);
bareGear.append($('settingsBtn').querySelector('svg').cloneNode(true));
// On a phone, a PDF's own bar (its name, smaller and larger, night, reader, keep) comes out with the sliders button in
// the top bar; with that bar away, the same button is here (see togglePdfTools).
bareTools.id = 'bareTools';
bareTools.type = 'button';
bareTools.title = $('mTools').title;
bareTools.setAttribute('aria-label', bareTools.title);
bareTools.append($('mTools').querySelector('svg').cloneNode(true));
bareTools.onclick = () => togglePdfTools();
// A PDF's smaller and larger, too: on a phone its own bar, which has them, is put away.
for (const [b, id, title, times] of [[bareLess, 'bareLess', 'Smaller pages', 1 / 1.25], [bareMore, 'bareMore', 'Larger pages', 1.25]]) {
  b.id = id;
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.onclick = () => { const z = views[state.active]?.zoom; if (z?.path === state.panes[state.active]?.active) z.by(times); };
}
bareBar.append(bareGear, bareTools, bareLess, bareMore, bareWhere);
$('work').append(bareBar);
bareGear.onclick = () => {
  state.bare = false;
  paintBare();
  setSideOpen(true);
  save();
  if (phone.matches && !document.body.classList.contains('m-side')) drawer('side');   // on a phone the sidebar is a drawer
  setSettingsOpen(true);
};
// A viewer's own bar (a PDF's, a picture's) stays where it is while the tabs are away: the two go under it, not over it,
// and the page is not said twice where that bar is saying it.
function paintBareWhere() {
  const v = views[state.active], w = v?.where, bar = v?.body?.querySelector('.viewbar'), shown = !!bar?.offsetHeight;
  bareBar.style.top = (shown ? bar.getBoundingClientRect().bottom - $('work').getBoundingClientRect().top : 0) + 6 + 'px';
  const open = state.panes[state.active]?.active, said = shown && !!bar.querySelector('.pdfwhere')?.offsetHeight;   // `said`: the PDF's own bar is showing, page, − and + and all
  bareWhere.textContent = w && w.path === open && !said ? w.text : '';
  bareLess.hidden = bareMore.hidden = !(v?.zoom?.path === open && isPdf(open || '')) || said;
  bareTools.hidden = !isPdf(open || '');
  bareTools.setAttribute('aria-pressed', !!state.pdfTools);
}
addEventListener('resize', paintBareWhere);
function applyLayout() {
  paintBare();
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
  titleEl.textContent = config.title;
  setTabTitle();
}
// The name is not changed here (that is done on the front page, whose heading it is): with the house beside it, it is the way home.
$('hubHome').onclick = (e) => { if (config.front) openDoc(config.front, { side: e.metaKey || e.ctrlKey || e.altKey }); };

// ---- workspaces and folder upload ---------------------------------------------
// Open another workspace on the hub. From then on this page names that one (see call), until it loads again.
async function openWorkspace(root) {
  const list = await api('/api/workspace', 'POST', { root });
  config.workspace = list.find((w) => w.current)?.workspace || config.workspace;
}
// Another workspace was opened on the hub (from another device, another tab, or this one): this page still shows the
// one before, and the hub refuses what it asks. What waits to be sent is kept for when that one is open again.
function workspaceMoved() {
  const b = $('moved');
  if (!b.hidden) return;
  b.textContent = `Another workspace was opened on the hub. This page still shows “${config.title}”; nothing done here goes into the other one, and what waits to be sent is kept for when “${config.title}” is open again. Show the open one`;
  b.hidden = false;
}
async function loadWorkspaces() {
  let list;
  try { list = await api('/api/workspaces'); } catch { return; }
  const sel = $('workspace');
  sel.innerHTML = '';
  for (const w of list) sel.append(new Option((w.home ? '' : '↳ ') + w.name, w.root, w.current, w.current));
  sel.hidden = list.length < 2;
  sel.onchange = async () => { await openWorkspace(sel.value); location.href = '/'; };
}
// ---- a folder on this device, and its copy in the workspace ----
// An uploaded folder is a copy: the server watches the copy, not the folder it came from. "update…" on the
// folder's page brings the copy up to date: it reads the folder on this device again, asks the server what the
// copy holds (each file's size and date), and sends only what is new or was changed since. Nothing is taken out
// of the copy. A browser that can (Chrome and its kin, on a computer) remembers which folder it was, so after the
// first time it asks only for leave to read it; any other is shown the folder chooser each time.
// Nothing is read into memory to do this: a folder is walked for names, sizes and dates, and a file that has to
// be sent is streamed from the disk by the browser, one at a time.
const canPick = 'showDirectoryPicker' in window;
const folderHandles = {   // the folders chosen, by workspace and name; kept apart from the copies, as plain handles the browser can store
  db: () => new Promise((ok, no) => { const r = indexedDB.open('hub-folders', 1); r.onupgradeneeded = () => r.result.createObjectStore('handles'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }),
  async get(folder) {
    try { const db = await this.db(); return await new Promise((ok) => { const q = db.transaction('handles').objectStore('handles').get(keyOf(folder)); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); }); }
    catch { return null; }
  },
  async set(folder, handle) {
    try { const db = await this.db(); await new Promise((ok) => { const t = db.transaction('handles', 'readwrite'); t.objectStore('handles').put(handle, keyOf(folder)); t.oncomplete = t.onerror = t.onabort = () => ok(); }); }
    catch { /* not remembered: the chooser is shown next time */ }
  },
};
const picked = new Map();   // folders chosen in this visit, by name: remembered once they are in the workspace
const leftOut = (rel, file) => rel.split('/').some((x) => x.startsWith('.') || x === 'node_modules') || file.size > uploadLimit;
// Every file in a chosen folder, each with its path from (and including) the folder's own name.
async function filesIn(handle, rel = handle.name, out = []) {
  for await (const [name, h] of handle.entries()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    if (h.kind === 'directory') await filesIn(h, rel + '/' + name, out);
    else { const file = await h.getFile().catch(() => null); if (file) out.push({ rel: rel + '/' + name, file }); }
  }
  return out;
}
// The folder on this device that `folder` of the workspace is a copy of, as its files: the one remembered, or one chosen now.
async function sourceOf(folder) {
  if (!canPick) {
    // No lasting hold on a folder in this browser: the chooser, each time.
    return new Promise((ok) => {
      const inp = el('input');
      inp.type = 'file'; inp.webkitdirectory = true; inp.multiple = true;
      inp.onchange = () => ok({ name: (inp.files[0]?.webkitRelativePath || '').split('/')[0], files: [...inp.files].map((file) => ({ rel: file.webkitRelativePath || file.name, file })) });
      inp.oncancel = () => ok(null);
      inp.click();
    });
  }
  let handle = await folderHandles.get(folder);
  if (handle && (await handle.queryPermission({ mode: 'read' })) !== 'granted' && (await handle.requestPermission({ mode: 'read' }).catch(() => 'denied')) !== 'granted') handle = null;
  const known = !!handle;   // the folder this one was uploaded from: whatever it is called on its disk, it is the one
  if (!handle) { try { handle = await showDirectoryPicker({ mode: 'read' }); } catch { return null; } }
  return { name: handle.name, handle, known, files: await filesIn(handle).catch(() => null) };
}
async function updateFolder(folder) {
  const src = await sourceOf(folder);   // first, while the press still counts as one: a browser gives leave to read only then
  if (!src) return;
  const name = folder.split('/').pop();
  let box, line = el('p', '', 'Looking at what is in the folder\u2026');
  const done = (text) => { line.textContent = text; const ok = el('button', 'main', 'OK'); ok.onclick = closeGate; box.append(ok); ok.focus(); };
  showGate(`Update \u201c${name}\u201d`, (card) => { box = card; card.append(line); });
  if (!src.files) return done('That folder could not be read. It may have been moved or renamed: press "update\u2026" again and choose it.');
  if (src.name !== name && !src.known && !(await new Promise((ok) => {
    const go = el('button', 'main', `Update from \u201c${src.name}\u201d`), no = el('button', 'link', 'Cancel');
    line.textContent = `The folder chosen is \u201c${src.name}\u201d, and this one is \u201c${name}\u201d. What is in it would be added here.`;
    go.onclick = () => { go.remove(); no.remove(); ok(true); };
    no.onclick = () => ok(false);
    box.append(go, no);
  }))) return closeGate();
  let have;
  try { have = new Map((await api('/api/files?path=' + encodeURIComponent(folder))).map((f) => [f.asked || f.path, f])); }   // a file saved under a shorter name, by the one it was given
  catch (e) { return done(e.offline ? 'The server is not reachable.' : 'The server that is running is older than this: stop it and start it again (npm start), then press "update\u2026" once more.'); }
  // New: not in the copy. Changed: another size, or touched on this device after its copy was made (two seconds' grace: some disks keep time in steps).
  const send = [];
  let skipped = 0;
  for (const { rel, file } of src.files) {
    if (leftOut(rel, file)) { skipped++; continue; }
    const path = folder + rel.slice(src.name.length), was = have.get(path);
    if (!was) send.push({ path, file, fresh: true });
    else if (was.size !== file.size || file.lastModified / 1000 > was.changed + 2) send.push({ path, file, fresh: false });
  }
  let added = 0, updated = 0, failed = 0;
  for (const [i, { path, file, fresh }] of send.entries()) {
    line.textContent = `Sending ${i + 1} of ${send.length}\u2026`;
    try {
      const r = await call('/api/upload?path=' + encodeURIComponent(path) + (fresh ? '' : '&replace=1'), { method: 'POST', body: file }).then((res) => res.json()).catch(() => ({}));
      if (r.replaced) updated++; else if (r.saved) added++; else failed++;
    } catch { failed += send.length - i; break; }   // out of reach: the rest would go the same way
  }
  if (src.handle) await folderHandles.set(folder, src.handle);
  if (added || updated) await loadDocs();
  const some = (n, what) => `${n} ${what}`;
  done((send.length ? [added && some(added, 'added'), updated && some(updated, 'updated'), failed && some(failed, 'not sent (press "update\u2026" again to retry)')].filter(Boolean).join(', ') + '.' : 'Nothing is new or changed.')
    + ` ${src.files.length - skipped - send.length} as they were.` + (skipped ? ` ${skipped} hidden or over 50 MB left out.` : ''));
}
$('uploadBtn').onclick = async () => {
  if (!canPick) return $('folderInput').click();
  let handle;
  try { handle = await showDirectoryPicker({ mode: 'read' }); } catch { return; }   // closed without choosing
  picked.set(handle.name, handle);
  const files = await filesIn(handle);
  const all = [...gathered.filter((g) => !files.some((f) => f.rel === g.rel)), ...files];
  gathered = [];
  if (all.length) offerUpload(all);
};
// A browser's folder chooser gives one folder at a time. Several are gathered by choosing again ("add another
// folder…" in the dialog: what was chosen so far is held in `gathered`), or by dropping them all on the sidebar at once.
let gathered = [];
$('folderInput').onchange = (e) => {
  const files = [...e.target.files].map((file) => ({ rel: file.webkitRelativePath || file.name, file }));
  e.target.value = '';
  const all = [...gathered.filter((g) => !files.some((f) => f.rel === g.rel)), ...files];
  gathered = [];
  if (all.length) offerUpload(all);
};
// Everything in the folders dropped, each file with its path from the folder dropped. Null if no folder was among them.
async function droppedFolders(data) {
  const entries = [...(data.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((en) => en.isDirectory)) return null;
  const files = [];
  const walk = async (en) => {
    if (en.isFile) { const file = await new Promise((ok, no) => en.file(ok, no)).catch(() => null); if (file) files.push({ rel: en.fullPath.replace(/^\//, ''), file }); return; }
    const reader = en.createReader();
    for (;;) {   // a folder is read out a batch at a time, until a batch comes back empty
      const batch = await new Promise((ok, no) => reader.readEntries(ok, no)).catch(() => []);
      if (!batch.length) break;
      for (const inner of batch) await walk(inner);
    }
  };
  for (const en of entries) if (en.isDirectory) await walk(en);
  return files;
}

// The largest file the server takes in one upload. The C++ server says (its
// /api/device: on a board, as much as the card's FAT32 holds, 4 GB); the Node
// server has no such answer and takes 50 MB. Asked once, at start.
let uploadLimit = 50 * 1024 * 1024;
async function loadUploadLimit() {
  try {
    const r = await call('/api/device', { quiet: true });
    const d = r.ok ? await r.json() : null;
    if (d?.maxUpload > 0) uploadLimit = d.maxUpload;
  } catch { /* the old limit stands */ }
}

// A folder goes by a name of its own in the hub, asked for when it is uploaded: the name it has on the disk it
// came from is only what is offered first. So two folders called "Music", from two drives, can be told apart here,
// and a folder renamed on its disk since is not held to its old name. Characters no disk takes are left out.
const hubName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim();
const underName = (files, from, to) => (to === from ? files : files.map((f) => (f.rel.split('/')[0] === from ? { ...f, rel: to + f.rel.slice(from.length) } : f)));
const takenName = (name) => allDocs.some((d) => d.path.toLowerCase().startsWith(name.toLowerCase() + '/'));
function nameBox(folder, onChange) {
  const wrap = el('label', 'nameRow', 'Name in the hub '), box = el('input'), says = el('p', 'sub');
  box.value = folder;
  box.maxLength = 80;
  box.autocomplete = 'off';
  box.spellcheck = false;
  box.title = 'What this folder is called here. It need not be its name on the disk it came from.';
  wrap.append(box);
  const name = () => hubName(box.value) || folder;
  const paint = () => {
    says.textContent = takenName(name()) ? `There is a folder \u201c${name()}\u201d here already: these files would be added to it. Give this one another name to keep them apart.` : name() !== folder ? `On its disk it is \u201c${folder}\u201d; here it will be \u201c${name()}\u201d.` : '';
    says.hidden = !says.textContent;
    onChange?.(name());
  };
  box.addEventListener('input', paint);
  return { wrap, says, name, paint };
}
// The folder chosen is remembered for "update\u2026" under the name it goes by here.
function pickedAs(from, to) { if (to !== from && picked.has(from)) { picked.set(to, picked.get(from)); picked.delete(from); } }
// After a folder is picked: say what was found, and ask where it should go.
function offerUpload(files) {
  const folders = [...new Set(files.map((f) => f.rel.split('/')[0]))];
  if (folders.length > 1) return offerUploads(files, folders);
  const folder = files[0].rel.split('/')[0];
  const hidden = ({ rel }) => rel.split('/').some((x) => x.startsWith('.') || x === 'node_modules');
  const big = files.filter((f) => !hidden(f) && f.file.size > uploadLimit);
  const ok = files.filter((f) => !hidden(f) && f.file.size <= uploadLimit);
  const skipped = files.length - ok.length - big.length;
  const notes = [];
  if (skipped) notes.push(`${skipped} hidden file${skipped === 1 ? '' : 's'} left out`);
  if (big.length) notes.push(`${big.length} over ${mb(uploadLimit)}, more than the server takes, left out: ` + big.slice(0, 3).map((f) => f.rel.split('/').pop()).join(', ') + (big.length > 3 ? '…' : ''));
  const said = el('p', '', `${ok.length} file${ok.length === 1 ? '' : 's'}` + (notes.length ? ` (${notes.join('; ')})` : '') + '. Where should they go?');
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
  const add = el('button', 'main', '');
  const as = nameBox(folder, (n) => { add.textContent = `Add to this workspace, as the folder “${n}”`; });
  add.onclick = () => { const to = as.name(); pickedAs(folder, to); runUpload(underName(ok, folder, to), null, to, front(), lock.checked); };
  const fresh = el('button', '', 'Open as its own workspace, in place of this one');
  fresh.title = 'Nothing is deleted: the current workspace stays on disk and in the workspace menu';
  fresh.onclick = () => runUpload(ok, as.name(), as.name(), front());
  // A folder added to this workspace can be locked: its password is chosen the first time it is opened.
  const lockWrap = el('label', 'check'), lock = el('input');
  lock.type = 'checkbox';
  lockWrap.append(lock, ' Lock this folder: ask for a password before showing it');
  lock.onchange = () => { fresh.disabled = lock.checked; fresh.title = lock.checked ? 'A lock is for a folder inside a workspace' : 'Nothing is deleted: the current workspace stays on disk and in the workspace menu'; };
  const cancel = el('button', 'link', 'Cancel');
  cancel.onclick = closeGate;
  showGate(`Upload “${folder}”`, (card) => card.append(said, as.wrap, as.says, pick, lockWrap, add, fresh, anotherFolder(files), cancel), true);
  as.paint();
  add.focus();
}
// "add another folder…": the chooser again, and what it gives joins what is here already.
function anotherFolder(files) {
  const b = el('button', '', 'Add another folder…');
  b.title = 'Choose one more folder to upload together with this';
  b.onclick = () => { gathered = files; $('uploadBtn').onclick(); };
  return b;
}
// Several folders at once: each joins this workspace under its own name. A folder's front page is its own
// FRONTPAGE.md, or else a copy of its README.md, or else a new one.
function offerUploads(files, folders) {
  const ok = files.filter(({ rel, file }) => !rel.split('/').some((x) => x.startsWith('.') || x === 'node_modules') && file.size <= uploadLimit);
  const said = el('p', '', `${folders.length} folders, ${ok.length} files` + (ok.length < files.length ? ` (${files.length - ok.length} hidden, or over ${mb(uploadLimit)}, left out)` : '') + ':');
  const list = el('div', 'fly');
  const names = new Map();   // each folder's name in the hub, as typed in its line
  for (const f of folders) {
    const row = el('div'), out = el('button', 'link', 'leave out'), as = nameBox(f);
    names.set(f, as);
    row.append(as.wrap, el('small', '', ` ${ok.filter(({ rel }) => rel.startsWith(f + '/')).length} files `), out, as.says);
    out.onclick = () => offerUpload(files.filter(({ rel }) => rel.split('/')[0] !== f));
    list.append(row);
    as.paint();
  }
  const frontOfUpload = (f) => {
    const tops = ok.filter(({ rel }) => rel.startsWith(f + '/') && rel.split('/').length === 2 && /\.md$/i.test(rel));
    if (tops.some(({ rel }) => rel.endsWith('/FRONTPAGE.md'))) return null;
    return { from: tops.find(({ rel }) => /\/readme\.md$/i.test(rel))?.file || null };
  };
  const lockWrap = el('label', 'check'), lock = el('input');
  lock.type = 'checkbox';
  lockWrap.append(lock, ' Lock these folders: ask for a password before showing them');
  const add = el('button', 'main', `Add all ${folders.length} to this workspace`);
  add.onclick = () => {
    const fronts = new Map(folders.map((f) => [f, frontOfUpload(f)])), to = (f) => names.get(f).name();
    let all = ok;
    for (const f of folders) { all = underName(all, f, to(f)); pickedAs(f, to(f)); }
    runUpload(all, null, to(folders[0]), fronts.get(folders[0]), lock.checked, folders.slice(1).map((f) => ({ folder: to(f), front: fronts.get(f) })));
  };
  const cancel = el('button', 'link', 'Cancel');
  cancel.onclick = closeGate;
  showGate(`Upload ${folders.length} folders`, (card) => card.append(said, list, lockWrap, add, anotherFolder(files), cancel), true);
  add.focus();
}

// Send the files one at a time. `workspace` set: they become a workspace of
// their own (the top folder name is dropped); otherwise they join this one.
// `more`: further folders among the files ({ folder, front } each), when several are uploaded at once.
async function runUpload(files, workspace, folder, front, lock, more = []) {
  uploading = true;
  try { await sendUpload(files, workspace, folder, front, lock, more); } finally {
    uploading = false;
    // What this upload changed is in the list it fetched at the end; anything else (notes) is still due.
    for (const f of changedFiles) if (!f.endsWith('notes.json')) changedFiles.delete(f);
    if (changedFiles.size && !changeTimer) changeTimer = setTimeout(applyChanges, 250);
  }
}
async function sendUpload(files, workspace, folder, front, lock, more) {
  const line = el('p');
  let box;
  showGate(more.length ? `Upload ${more.length + 1} folders` : `Upload “${folder}”`, (card) => { box = card; card.append(line); });
  let saved = 0, skipped = 0, failed = 0, root = '', shortened = 0;
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
      if (r.shortened && (r.saved || r.skipped)) shortened++;
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
  line.textContent = `${saved} added` + (skipped ? `, ${skipped} already here and left alone` : '') + '.'
    + (shortened ? ` ${shortened} had a name too long for the hub's system: ${shortened === 1 ? 'it is' : 'they are'} kept under a shorter one, and listed by the name you gave.` : '');
  if (failed) box.append(el('p', 'say', `${failed} not saved: ` + [...whyNot].map(([w, n]) => `${n} × ${w}`).join('; ') + (notSaved.length ? '. Refused: ' + notSaved.join('; ') : '') + '. Nothing was lost on your computer; upload the folder again to retry (files already here are skipped).'));
  const done = el('button', 'main', 'OK');
  done.onclick = closeGate;
  box.append(done);
  // The folder's front page: a copy of the chosen file, or a new one with the
  // folder's name as its title. Never replaces one that is already there.
  const frontText = async (front, folder) => (front.from ? await front.from.text() : `# ${folder}\n\nWhat this folder is for. Press the pencil to change this.\n`);
  if (workspace && root) {
    await openWorkspace(root);
    if (front && !(await api('/api/config')).front) await api('/api/front', 'PUT', { markdown: await frontText(front, folder) });
    location.href = '/';
  } else {
    await loadDocs();
    for (const one of [{ folder, front }, ...more]) {
      if (!allDocs.some((d) => d.path.startsWith(one.folder + '/'))) continue;   // nothing of it arrived
      if (picked.has(one.folder)) { await folderHandles.set(one.folder, picked.get(one.folder)); picked.delete(one.folder); }   // which folder it is a copy of, for "update…"
      if (one.front && !docOf(one.folder + '/FRONTPAGE.md')) { await api('/api/front', 'PUT', { markdown: await frontText(one.front, one.folder), folder: one.folder }); await loadDocs(); }
      if (lock && saved + skipped && !locks()[one.folder]) { await saveLocks({ ...locks(), [one.folder]: {} }); applyLocks(); renderTree(); }
    }
    if (docOf(folder + '/FRONTPAGE.md')) openDoc(folder + '/FRONTPAGE.md');
    done.focus();
  }
}

// ---- phone: drawers for the sidebar and the notes -------------------------------
const phone = matchMedia('(max-width: 760px)'), touch = matchMedia('(pointer: coarse)');
// A pinch on a picture or a video makes that larger or smaller, where the reader as a whole stays as it is: the
// picture is given a width, and its stage scrolls. The spot between the fingers stays under them. Pinched back to
// the size it had, it is as it was.
const pinch = { m: null, stage: null, d: 0, k: 1 };
const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
// As it was before any pinch: fitted to the stage, or at its own size.
function unpinch(stage) {
  const m = stage.querySelector('img, video');
  stage.classList.remove('pinched');
  if (m) { m.style.width = m.style.height = ''; delete m.dataset.w; delete m.dataset.h; delete m.dataset.k; }
}
document.addEventListener('touchstart', (e) => {
  const stage = e.touches.length === 2 && e.target.closest?.('.stage'), m = stage && stage.querySelector('img, video');
  if (!m) { pinch.m = null; return; }
  // The size it has now is what the pinch multiplies: fitted, that is the stage; at full size, the picture's own.
  if (!m.dataset.w) { const r = m.getBoundingClientRect(); m.dataset.w = r.width; m.dataset.h = r.height; m.dataset.k = 1; }
  Object.assign(pinch, { m, stage, d: spread(e.touches), k: Number(m.dataset.k) });
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  const { m, stage } = pinch;
  if (!m || e.touches.length !== 2) return;
  e.preventDefault();
  const k = Math.min(8, Math.max(1, pinch.k * spread(e.touches) / pinch.d));
  const x = (e.touches[0].clientX + e.touches[1].clientX) / 2, y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
  const was = m.getBoundingClientRect(), fx = (x - was.left) / was.width, fy = (y - was.top) / was.height;
  if (k <= 1.02) { unpinch(stage); pinch.m = null; return; }
  stage.classList.add('pinched');
  m.dataset.k = k;
  m.style.width = Number(m.dataset.w) * k + 'px';
  m.style.height = Number(m.dataset.h) * k + 'px';
  const now = m.getBoundingClientRect();
  stage.scrollLeft += now.left + fx * now.width - x;
  stage.scrollTop += now.top + fy * now.height - y;
}, { passive: false });
document.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch.m = null; }, { passive: true });
// An iPhone or iPad says a pinch is starting: it is refused, so the whole reader is not zoomed by accident (see the style sheet, too).
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
// A press in the list takes the place of the tab being looked at. The + at the end of the tab bar opens the list to
// add to the tabs instead: while it is open that way (`adding`, said at its top), what is pressed opens in a tab of its own.
let adding = false;
function drawer(name) {
  const side = name === 'side' && !document.body.classList.contains('m-side');
  if (!side) adding = false;
  document.body.classList.toggle('m-side', side);
  if (side) focusTree();   // the list opens short, at where you are (see focusTree)
  document.body.classList.toggle('m-right', name === 'right' && !document.body.classList.contains('m-right'));
  document.body.classList.toggle('m-add', adding);
}
function addTab() { drawer(null); adding = true; drawer('side'); }
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
  net.lostAt = on ? 0 : Date.now();
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
  // A password on a page with no name beside it: a browser that keeps passwords takes the nearest box of text for
  // the name, which here is the find box, and fills that in (with whatever was last looked for) whenever the
  // password is asked for. So the password gets a name of its own to be kept under, out of sight.
  if (type === 'password') {
    const who = el('input');
    who.type = 'text'; who.name = 'username'; who.autocomplete = 'username'; who.value = 'hub';
    who.tabIndex = -1; who.readOnly = true; who.setAttribute('aria-hidden', 'true'); who.style.display = 'none';
    wrap.append(who);
  }
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

// Paired with another hub: this device now keeps a key to it, which anything that can read this browser's storage
// could take and use from anywhere that hub is reached. Protection encrypts it, with everything else kept here.
function keyKept() {
  showGate(`Paired with “${hub.name}”`, (card) => {
    const yes = el('button', 'main', 'Protect…'), no = el('button', 'link', 'Not now');
    card.append(el('p', '', `This device now keeps a key to “${hub.name}”. Like everything the reader keeps here, it is stored readable, so anything that can read this browser's storage could take it and use it wherever “${hub.name}” can be reached.`),
      el('p', 'sub', '“Protect…” encrypts it, and the copies and notes kept here, with a passphrase. It can be done later from the settings, under This device.'), yes, no);
    yes.onclick = () => askNewPassphrase(() => location.reload());
    no.onclick = () => location.reload();
  }, false);
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
          if (hub.url) {
            store.set('hub:tokens', { ...(store.get('hub:tokens') || {}), [hub.url]: (await r.json()).token });
            await local.whenSaved();
            // That key is kept in this browser's storage, readable unless protection is on (review, 27): say so now.
            if (local.mode === 'plain' && local.canProtect) return keyKept();
          }
          return location.reload();
        }
        const why = (await r.json().catch(() => null))?.error || '';
        msg.textContent = r.status === 403 && /site/.test(why) ? `“${hub.name}” takes pairing only from a reader on the home network, and this one was loaded from ${location.host}. Open the reader from a hub at a .local name or a home address, or pair on “${hub.name}” itself.`
          : r.status === 403 && /other sites/.test(why) ? 'Too many wrong codes were tried for this one from other hubs. Make a new code on that hub, under “devices…”.'
          : r.status === 403 ? 'That code is wrong, already used, or older than ten minutes. Ask for a new one.' : 'The server did not accept that (' + r.status + ').';
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
  // The page kept on this device allows connections to the hubs it was sent with: let it go, so the next load is the
  // page as the server sends it now, allowed to reach the new list (a kept page would be one load late, and the
  // pairing with a hub just added would be refused).
  if ('caches' in self) for (const k of await caches.keys().catch(() => [])) await (await caches.open(k)).delete('/').catch(() => {});
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

// How much each copy kept on this device takes, largest first, with a way to remove it from the device. A copy
// removed here is only the device's: the file stays on the server, and can be kept again. A book counts as one, all
// its pages and pictures together; so does each other file, the pictures and styles kept beside a page included
// as files of their own. Copies from other hubs and workspaces are listed too, under their own heading. Files added
// here and not yet sent are not copies, and are not listed: removing one would lose it.
async function showSpace() {
  const items = new Map();   // root + '|' + book or path -> { id, root, from, label, where, folder, keys, size }
  let measuring = true, total = 0, used = null;
  const size = (n) => (n < 1 << 20 ? Math.max(1, Math.round(n / 1024)) + ' KB' : mb(n));
  const fill = (card) => {
    if (used) card.append(el('p', 'sub', `The reader uses about ${mb(used.usage)} of this device${used.quota ? ` (it may use up to ${mb(used.quota)})` : ''}: the copies below, and the reader itself.`));
    if (measuring) { card.append(el('p', 'sub', 'Measuring…')); return; }
    if (!items.size) { card.append(el('p', '', 'Nothing is kept on this device.')); return; }
    card.append(el('p', '', `Copies kept here: ${size(total)} in all. Removing one frees its space here; it stays on the server.`));
    const groups = new Map();
    for (const it of [...items.values()].sort((a, b) => b.size - a.size)) {
      if (!groups.has(it.from)) groups.set(it.from, []);
      groups.get(it.from).push(it);
    }
    for (const [from, list] of groups) {
      card.append(el('h5', '', from));
      for (const it of list) {
        const row = el('div', 'dev space'), name = el('span', '', it.label), amount = el('small', 'size', it.size ? size(it.size) : '—');
        name.title = it.where;
        const drop = el('button', '', 'remove');
        drop.title = 'Remove this copy from the device. It stays on the server.';
        drop.onclick = async () => {
          if (drop.dataset.sure !== '1') { drop.dataset.sure = '1'; drop.textContent = 'remove from device?'; drop.classList.add('sure'); return; }
          drop.disabled = true;
          // As dropCopy does, for every page of a book at once, and the lists drawn again once.
          for (const key of it.keys) {
            await idb.del('docs', key);
            if (it.root !== config.root) continue;
            const path = key.slice(key.indexOf('|') + 1);
            kept.delete(path);
            if (blobUrls.has(path)) { URL.revokeObjectURL(blobUrls.get(path)); blobUrls.delete(path); }
          }
          if (it.root === config.root) { renderTree(); renderNet(); renderPlayers(); }
          items.delete(it.id);
          total -= it.size;
          if (navigator.storage?.estimate) used = await navigator.storage.estimate().catch(() => used);
          redraw();
        };
        row.append(name, el('small', '', it.folder), amount, drop);
        card.append(row);
      }
    }
  };
  const redraw = () => showGate('Space on this device', fill, true);
  redraw();
  if (navigator.storage?.estimate) used = await navigator.storage.estimate().catch(() => null);
  for (const key of (await idb.keys('docs')) || []) {
    const bar = key.indexOf('|');
    if (bar < 0) continue;
    const root = key.slice(0, bar), path = key.slice(bar + 1), m = /^(https?:\/\/\S+) (.*)$/.exec(root);
    if (root === config.root && gateOf(path)) continue;   // in a locked folder: not named until it is opened
    const url = m ? m[1] : '', folder = (m ? m[2] : root).split('/').filter(Boolean).pop() || '';
    const from = (url ? hubs.find((h) => h.url === url)?.name || new URL(url).host : 'This hub') + ' · ' + folder + (root === config.root ? ' (viewing)' : '');
    const book = isBookPage(path) ? bookOf(path) : null, id = root + '|' + (book || path);
    const where = book || path, parts = where.split('/');
    if (!items.has(id)) {
      const label = book ? (root === config.root && docOf(path)?.bookTitle) || parts.pop().replace(/\.epub$/i, '') : parts.pop();
      items.set(id, { id, root, from, label, where, folder: (book ? book.split('/') : path.split('/')).slice(0, -1).join(' / '), keys: [], size: 0 });
    }
    const it = items.get(id), bytes = await idb.size('docs', key);
    it.keys.push(key);
    it.size += bytes;
    total += bytes;
  }
  measuring = false;
  if (!gate.hidden && gate.querySelector('h2')?.textContent === 'Space on this device') redraw();
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
  if (local.mode === 'plain' && local.canProtect) copies.append(link('protect…', () => askNewPassphrase(), 'Encrypt what is kept on this device with a passphrase'));
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
  if (storage) rows.push(line('Server storage', mb(storage.used) + ' used' + (storage.quota ? ' of ' + mb(storage.quota) : '') + (storage.free ? ', ' + mb(storage.free) + ' free on its disk' : '')));
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
function askNewPassphrase(then) {
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
      then?.();
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

// What is only partly on this device: a book with some of its pages kept, or a folder with some of its own
// documents, its music, or its pictures and videos kept, and the rest on the server only. The three kinds are
// counted apart in a folder, so a document read in a folder of videos does not make the videos "partly kept".
// Nothing is written down for this: it is counted from what is kept, so a "keep all" that was cut short (the
// server gone, the reader closed, no room) shows here as far as it got, and is carried on from there.
function partlyKept() {
  const units = new Map();
  for (const d of docs) {
    if (d.gallery || d.front || isPending(d.path) || !canKeep(d.path) || gateOf(d.path)) continue;
    const at = d.path.search(/\.epub\//i), book = at >= 0 ? d.path.slice(0, at + 5) : '';
    const kind = book ? 'book' : isAudio(d.path) ? 'music' : isImage(d.path) || isVideo(d.path) ? 'pictures and videos' : 'documents';
    const where = book || folderOf(d.path);
    if (!where) continue;   // a file at the top is by itself: on this device or not
    const key = where + '|' + kind, u = units.get(key) || units.set(key, { key, where, kind, items: [], missing: [] }).get(key);
    u.items.push(d);
    if (!kept.has(d.path)) u.missing.push(d);
  }
  return [...units.values()].filter((u) => u.missing.length && u.missing.length < u.items.length);
}
let partlyOpen = false;   // the list under "partly on this device", open or not: the box is redrawn often
// One line over the note box that always says, in the same words, whether everything is saved: on the server; waiting
// on this device to be sent (and since when the server has been out of reach); being sent; or refused.
function paintSaved() {
  const s = $('saved');
  if (!s) return;
  const waiting = outbox.length, since = net.lostAt ? new Date(net.lostAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  s.textContent = refused.length ? `${refused.length} not saved` : flushing && waiting && net.online ? 'saving…' : waiting ? `${waiting} to send` : net.online ? 'saved' : 'all sent';
  if (!net.online) s.textContent += ' · offline' + (since ? ' since ' + since : '');
  s.className = refused.length ? 'say' : waiting || !net.online ? 'wait' : '';
  s.title = refused.length ? 'The server refused some changes: the settings, under Connection, say which'
    : waiting ? `${waiting} change${waiting > 1 ? 's are' : ' is'} kept on this device and will be sent when the server answers`
    : net.online ? 'Every note and highlight is saved on the server' : 'Nothing is waiting: every change was sent before the server went out of reach';
}
function renderNet() {
  paintSaved();
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
    const missing = items.filter((d) => !kept.has(d.path)), units = asItems(items);   // a book counts once, and is here when all of it is
    const line = el('div', 'sub', `${units.filter(hereOf).length} of ${units.length} ${label} copied to this device `);
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
  // What is partly here, each with how far it has got; with the server in reach, one press fetches the rest of all of them.
  const partly = partlyKept(), ALL = 'what is partly here';
  if (partly.length || keeping?.label === ALL) {
    const det = el('details', 'partly'), sum = el('summary', 'sub', `${partly.length} book${partly.length === 1 ? ' or folder' : 's and folders'} only partly on this device `);
    det.open = partlyOpen;
    det.addEventListener('toggle', () => { partlyOpen = det.open; });
    const finish = (label, text, missing, title) => {
      if (keeping?.label === label) return el('span', '', `(copying ${keeping.done} of ${keeping.total}…)`);
      if (!net.online || keeping) return '';
      const b = el('button', '', text);
      b.title = title;
      b.onclick = (e) => { e.preventDefault(); keepAll(label, missing); };
      return b;
    };
    const rest = partly.flatMap((u) => u.missing);
    sum.append(finish(ALL, 'finish them all', rest, `Copy the ${rest.length} file${rest.length === 1 ? '' : 's'} still missing from them to this device`));
    det.append(sum);
    for (const u of partly) {
      const name = givenName(u.where).replace(/\.epub$/i, ''), row = el('div', 'sub');
      // A book is said by how much of it is here: what it is kept as (cover, contents, chapters, index) is not a count a reader has.
      const part = el('span', '', u.kind === 'book' ? `${name}: ${Math.max(1, Math.round(100 * (u.items.length - u.missing.length) / u.items.length))}% of the book ` : `${name}: ${u.items.length - u.missing.length} of ${u.items.length} ${u.kind} `);
      part.title = u.where;
      row.append(part, finish(u.key, 'finish', u.missing, `Copy the other ${u.missing.length} to this device`));
      det.append(row);
    }
    if (!net.online && partly.length) det.append(el('div', 'sub', 'The rest can be fetched when the server is in reach.'));
    box.append(det);
  }
  paintKeepBtns();
  // Show everything, or only what is on this device (what opens without the server).
  const only = el('button', '', view.onlyKept ? 'show everything' : 'show only what is on this device');
  only.title = view.onlyKept ? 'The lists are showing only what is kept on this device' : 'Narrow the file list, the playlist and the front-page lists to what is kept on this device';
  only.onclick = () => setOnlyKept(!view.onlyKept);
  box.append(el('div', 'sub', '').appendChild(only).parentNode);
  const everything = el('button', '', 'everything on this device…');
  everything.title = 'What is kept here from every hub and workspace';
  everything.onclick = showKept;
  const space = el('button', '', 'space on this device…');
  space.title = 'How much each kept copy takes on this device, and remove copies to free the space (they stay on the server)';
  space.onclick = showSpace;
  const removed = el('button', '', 'removed folders…');
  removed.title = 'Folders removed from this workspace in the last seven days: put one back, or let it go for good';
  removed.onclick = showRemoved;
  box.append(el('div', 'sub', '● on this device   ○ server only   ↑ waiting to be sent'), everything, ' ', space, ' ', removed);
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
    if (keepsItself(path)) rememberDoc(path, text);
    return text;
  } catch {
    return copy ? copy.text : null;
  }
}
// Opening a document does not copy it to this device: that is asked for, with its keep mark. Two things are still
// written here when read from the server: a copy that is already kept (so it is the latest), and a front page (the
// way around the reader when the server is out of reach).
const keepsItself = (path) => kept.has(path) || isFront(path);
async function rememberDoc(path, text) {
  const had = kept.has(path);
  if (!(await idb.put('docs', { key: keyOf(path), root: config.root, path, text, ts: Date.now() }))) return;   // no room: it is simply not marked as kept
  kept.add(path);
  keepParts(path, text);   // its pictures and styles, behind it
  askDurable();
  if (!had) { renderTree(); renderNet(); }
}
// While a copy is being made, a thin bar under the item's line or card says how much of it has arrived (a book:
// how many of its pages). `getting`: path, or a book's, -> the share that is here, 0 to 1.
const getting = new Map();
function paintGot(key) {
  const at = CSS.escape(key), share = getting.get(key);
  for (const n of document.querySelectorAll(`.file[data-path="${at}"], .file[data-book="${at}"], .thumb[data-path="${at}"], .item[data-path="${at}"]`)) {
    n.classList.toggle('getting', share != null);
    if (share != null) n.style.setProperty('--got', Math.round(share * 100) + '%'); else n.style.removeProperty('--got');
  }
}
function setGot(key, share) {
  if (share == null) getting.delete(key);
  else { const was = getting.get(key); share = Math.min(1, share); if (was != null && share < 1 && share - was < 0.02) return; getting.set(key, share); }
  paintGot(key);
}
// What the server sent, read a piece at a time so the bar can move. Without a length to measure against, read whole.
async function bodyOf(r, path, binary) {
  const total = Number(r.headers.get('Content-Length')) || 0;
  if (!r.body || !total) return binary ? r.blob() : r.text();
  const parts = [], reader = r.body.getReader();
  for (let got = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    setGot(path, (got += value.length) / total);
  }
  const blob = new Blob(parts, { type: r.headers.get('Content-Type') || '' });
  return binary ? blob : blob.text();
}
async function keepCopy(path, quiet) {
  let stored = true;   // false only when the device had no room
  setGot(path, 0.03);   // a sliver at once: it has been asked for
  try {
    const r = await call(isHtml(path) || isBinary(path) ? rawUrl(path) : '/api/doc?path=' + encodeURIComponent(path));
    if (r.ok) {
      const body = isBinary(path) ? { blob: await bodyOf(r, path, true) } : { text: await bodyOf(r, path, false) };
      if (await idb.put('docs', { key: keyOf(path), root: config.root, path, ...body, ts: Date.now() })) { kept.add(path); askDurable(); await keepParts(path, body.text); }
      else { stored = false; net.said = `There was no room on this device to keep “${path.split('/').pop()}”.`; setTimeout(() => { net.said = ''; renderNet(); }, 8000); }
    }
  } catch {}
  setGot(path, null);
  if (!quiet) { renderTree(); renderNet(); renderPlayers(); }
  return stored;
}
// ---- what a page needs beside itself ----
// A page of a book, or an HTML page, is its text and the stylesheets and pictures it names; a markdown document is
// its text and its pictures. Keeping the page keeps those too (a book's are files inside the book, which the list
// of files does not name), each under its own path like any kept file, and the copy is shown with them (pageFromCopy).
// Fonts are left out: the reader's content policy takes a font from the server only.
const relOnly = (src) => !!src && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(src);   // a path beside the page: no site, no "/", not a place in the page itself
const isCss = (path) => /\.css$/i.test(path);
const cssUrls = (css) => [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]);
// A page's text as a document that loads nothing. A book's page is XHTML: read as that, then moved into an HTML
// document, so it is written out as HTML (a frame given text takes it for HTML, where <title/> would swallow the page).
function parsePage(path, text) {
  if (/\.xhtml$/i.test(path) || /^\s*<\?xml/.test(text)) {
    const x = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    if (!x.querySelector('parsererror') && x.documentElement.localName === 'html') {
      const h = document.implementation.createHTMLDocument('');
      h.replaceChild(h.importNode(x.documentElement, true), h.documentElement);
      return h;
    }
  }
  return new DOMParser().parseFromString(text, 'text/html');
}
const hrefOf = (m) => ['src', 'href', 'xlink:href'].find((a) => m.hasAttribute(a));   // where a picture names its file (an <image> in a drawing: href)
function partsOf(path, text) {
  const out = new Set();
  const add = (src) => { if (relOnly(src)) { try { out.add(resolve(path, src)); } catch { /* not a path */ } } };
  if (isHtml(path)) {
    const d = parsePage(path, text);
    for (const l of d.querySelectorAll('link[href]')) if (/stylesheet/i.test(l.getAttribute('rel') || '')) add(l.getAttribute('href'));
    for (const m of d.querySelectorAll('img[src], image')) add(m.getAttribute(hrefOf(m) || 'src'));
  } else if (/\.md$/i.test(path)) {
    for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) add(m[1]);
    for (const m of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)/gi)) add(m[1]);
  }
  return [...out].filter((p) => isImage(p) || isCss(p));
}
const partsBusy = new Set();
async function keepParts(path, text) {
  if (!net.online || text == null || !(isHtml(path) || /\.md$/i.test(path))) return;
  const one = async (p) => {
    if (kept.has(p) || partsBusy.has(p)) return;
    partsBusy.add(p);
    try {
      const r = await call(rawUrl(p), { quiet: true });
      if (!r.ok) return;
      const body = isCss(p) ? { text: await r.text() } : { blob: await r.blob() };
      if (!(await idb.put('docs', { key: keyOf(p), root: config.root, path: p, ...body, ts: Date.now() }))) return;
      kept.add(p);
      // a stylesheet's own pictures
      if (isCss(p)) for (const u of cssUrls(body.text)) { if (!relOnly(u)) continue; const q = resolve(p, u); if (isImage(q)) await one(q); }
    } catch { /* out of reach, or not a path: the page is kept without it */ } finally { partsBusy.delete(p); }
  };
  for (const p of partsOf(path, text)) await one(p);
}
// The address of a kept file's copy, for a page shown from its own: '' if this device has none.
async function keptUrl(path) {
  if (!kept.has(path)) return '';
  const u = await mediaSrc(path);
  return u.startsWith('blob:') ? u : '';
}
// A kept page as text for a frame, with what it names put in from this device: each stylesheet written into the
// page, each picture pointed at its copy, and each link given its whole address (text in a frame has no address
// of its own for "../ch2.xhtml" to be counted from).
async function pageFromCopy(path, text) {
  const d = parsePage(path, text);
  for (const l of [...d.querySelectorAll('link[href]')]) {
    const href = l.getAttribute('href');
    if (!/stylesheet/i.test(l.getAttribute('rel') || '') || !relOnly(href)) continue;
    const p = resolve(path, href), copy = kept.has(p) ? await idb.get('docs', keyOf(p)) : null;
    if (copy?.text == null) { l.remove(); continue; }
    let css = copy.text;
    for (const u of new Set(cssUrls(css))) { const src = relOnly(u) ? await keptUrl(resolve(p, u)) : ''; if (src) css = css.split(u).join(src); }
    const style = d.createElement('style');
    style.textContent = css;
    l.replaceWith(style);
  }
  for (const m of d.querySelectorAll('img[src], image')) {
    const at = hrefOf(m), src = at && m.getAttribute(at);
    if (!relOnly(src)) continue;
    const u = await keptUrl(resolve(path, src));
    if (u) m.setAttribute(at, u);
  }
  for (const a of d.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href');
    if (relOnly(h)) a.setAttribute('href', rawUrl(resolve(path, h)) + (h.includes('#') ? '#' + h.split('#').slice(1).join('#') : ''));
  }
  return '<!doctype html>' + d.documentElement.outerHTML;
}
// Pages kept before their pictures and styles were: those are fetched once, quietly, the next time the server is in reach.
async function catchUpParts() {
  if (!net.online || store.get('parts:' + config.root)) return;
  for (const d of docs) {
    if (!net.online) return;
    if (!kept.has(d.path) || !(isHtml(d.path) || /\.md$/i.test(d.path))) continue;
    await keepParts(d.path, (await idb.get('docs', keyOf(d.path)))?.text);
  }
  store.set('parts:' + config.root, 1);
}
// "keep all": one after another, saying how far it has got.
let keeping = null;   // { label, done, total } while it runs
async function keepAll(label, items, key) {   // `key`: the book these are the pages of, for the bar on its line
  if (keeping) return;
  keeping = { label, done: 0, total: items.length };
  renderNet();
  if (key) setGot(key, 0.03);
  for (const d of items) {
    if (!net.online) break;
    if (!(await keepCopy(d.path, true))) break;   // no room: the rest would fail the same way
    keeping.done++;
    if (key) setGot(key, keeping.done / keeping.total);
    if (keeping.done % 5 === 0) renderNet();   // the count moves in fives; the box is not rebuilt for every file
  }
  keeping = null;
  if (key) setGot(key, null);
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

// ---- when a change to a note was made -----------------------------------------------
// Each change to a note is stamped with a hybrid logical clock (see stamp_ok in server-cpp/src/hub.cpp): this device's
// clock, or the latest stamp it has seen if that is later, a counter, and a name for this device. The server applies a
// change to a part of a note (its text, its type, its place) only if it is newer than the last one that part had, so
// two devices editing one note while apart no longer leave whichever reconnects last as the winner.
const deviceTag = store.get('deviceTag') || (() => { const t = Math.random().toString(36).slice(2, 10) || 'device'; store.set('deviceTag', t); return t; })();
let hlc = store.get('clock') || { wall: 0, n: 0 };
function stamp() {
  const now = Date.now();
  hlc = now > hlc.wall ? { wall: now, n: 0 } : hlc.n < 9999 ? { wall: hlc.wall, n: hlc.n + 1 } : { wall: hlc.wall + 1, n: 0 };
  store.set('clock', hlc);
  return String(hlc.wall).padStart(16, '0') + '-' + String(hlc.n).padStart(4, '0') + '-' + deviceTag;
}
// The latest stamp on the notes the server sent: this device's next one comes after it, whatever its own clock says.
function seeStamps(list) {
  for (const n of list) for (const st of Object.values(n?.stamps || {})) {
    if (typeof st !== 'string' || st.length < 21) continue;
    const wall = Number(st.slice(0, 16)), k = Number(st.slice(17, 21));
    if (wall > hlc.wall || (wall === hlc.wall && k > hlc.n)) hlc = { wall, n: k };
  }
}

// ---- the outbox: changes are applied here first, then sent ------------------------
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const makeNote = (fields) => ({ id: newId(), heading: '', headingText: '', quote: '', type: '', text: '', ...fields, ts: new Date().toISOString(), status: fields.text ? 'open' : 'highlight' });
async function noteOp(op) {
  if (op.kind !== 'del' && !op.at) op.at = stamp();   // when it was made, which is what counts, however late it is sent
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
  paintSaved();
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  let sentFile = false;
  stuck = '';
  try {
    while (outbox.length) {
      const op = outbox[0];
      let r = null;
      if (op.kind === 'add') r = await call('/api/notes', json('POST', op.at ? { ...op.note, at: op.at } : op.note));
      else if (op.kind === 'set') r = await call('/api/notes/' + op.id, json('PUT', op.at ? { ...op.fields, at: op.at } : op.fields));
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
        if (r.status === 412) { stuck = `Another workspace is open on the hub: ${opLabel(op)} is kept here, and sent when this one is open again.`; break; }
        if (!FINAL.has(r.status)) { stuck = `The server would not take ${opLabel(op)} (${why}). It is kept here and will be tried again.`; break; }
        if (!moot) { refused.push({ what: opLabel(op), why, ts: Date.now() }); store.set('refused:' + config.root, refused); }
      }
      if (op.kind === 'file' && (!r || r.ok)) {
        await idb.del('files', keyOf(op.path));
        pendingFiles = pendingFiles.filter((x) => x.path !== op.path);
        sentFile = true;
        // Kept by the hub under a shorter name (its own was too long for the hub's system): a tab showing it follows.
        const said = r ? await r.clone().json().catch(() => null) : null;
        if (said?.path && said.path !== op.path) for (const pane of state.panes) { pane.tabs = pane.tabs.map((t) => (t === op.path ? said.path : t)); if (pane.active === op.path) pane.active = said.path; }
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
// Each is kept on this device until sent, so files larger than this device
// should be asked to hold (200 MB) go by "Upload a folder" (the folder button), which sends straight
// from the disk. Whatever is left out is listed with the reason, not dropped.
async function addFiles(fileList) {
  const left = [];   // what was not taken, and why: said, not dropped quietly
  const limit = Math.min(uploadLimit, 200 * 1024 * 1024);   // what the server takes, and at most what this device is asked to hold
  for (const file of fileList) {
    const name = file.name.replace(/[\\/]/g, ' ').replace(/^\.+/, '').trim();
    if (!name) continue;
    if (file.size > limit) { left.push(`“${name}” is over ${mb(limit)}: put it in a folder and use "Upload a folder", which sends large files straight from the disk`); continue; }
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
sideEl.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  sideEl.classList.remove('drop');
  const loose = [...e.dataTransfer.files], inFolders = await droppedFolders(e.dataTransfer);   // read at once: what was dropped cannot be asked about later
  if (inFolders?.length) offerUpload(inFolders); else if (!inFolders) addFiles(loose);
});

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
// password has been typed to show it is known. Typing it opens the folder it
// was typed for and no other: each locked folder is opened by itself. (Folders
// locked before this, each with a password of its own, keep theirs until their
// lock is removed and set again.)
//
// This is a lock on the reader, not on the files: they are stored as they
// are, and removing the folder and uploading it again takes the lock off.
let allDocs = [];                 // everything the server lists; `docs` is what may be shown
const unlocked = new Set();       // folders opened with their password, until the page is closed
const locks = () => config.locks || {};
// The outermost locked folder that still stands between the reader and this path.
const gateOf = (path) => Object.keys(locks()).filter((f) => path.startsWith(f + '/') && !unlocked.has(f)).sort((a, b) => a.length - b.length)[0] || null;
const frontOf = (folder) => folder + '/FRONTPAGE.md';
const INBOX = 'inbox';   // the folder added files go to
// What each folder holds of its own: { shots, songs, other } (see applyLocks).
let holds = new Map();
// A folder's front page is its gallery and music page too: the tile it opens on.
const frontTile = (folder) => { const h = holds.get(folder) || {}, shelf = shelfUnder(folder); return shelf ? shelf.kind : h.shots && h.songs ? 'all' : h.shots ? 'media' : h.songs ? 'music' : null; };   // a shelf's page opens on its books
// The line in the file list that stands for a folder's sound files.
const musicLine = (folder) => (docOf(frontOf(folder)) ? frontOf(folder) : docOf(musicOf(folder)) ? musicOf(folder) : folder + '/');
// A folder's cover: a picture named "cover" in it. It is not a file of the folder anywhere (not in the list, a
// gallery or a count, and it does not make the folder one of pictures): it is shown on the folder's page, beside
// the title (see addCover).
const isCover = (path) => /\/cover\.(jpe?g|png|webp|gif)$/i.test(path) && !isBookPage(path);
let covers = new Map();   // folder -> the path of its cover
// ---- what a folder is, to whoever is looking for something in it ----
// A folder of things to look at, listen to or read is not opened out in the file list: it is one line, and its
// page shows what is in it. unitOf says which of three such a folder is, or null for one that opens out as before
// (notes, source, a mix with documents):
//   one    one thing and nothing else: a file (its front page apart), or a book
//   shelf  two or more things and no folder among them, each a book, a PDF, a picture, a video or a sound file
//          (an album; the same book as an .epub and as a PDF)
//   set    folders, each of them one of these three (an artist's albums, an author's books, a year of pictures),
//          with or without such files of its own beside them; never a folder of notes
// A folder holding nothing but one folder (front pages apart) is whatever that folder is, and so on down. `folder`
// is where the things are; `page` is what the line opens: the first front page on the way down, else a page made
// for it (the folder's path ending in "/", or an album's music page). `kind` is the tile that page opens on.
let ones = new Map();     // folder -> { path } or { book }: the one thing right inside it
let tally = new Map();    // folder -> what is right inside it: { files, books, kids (the folders) }
let units = new Map();    // folder -> what unitOf found; forgotten when the list of files changes
function unitOf(f) {
  if (units.has(f)) return units.get(f);
  let u = null, page = null, at = f;
  for (;;) {
    if (docOf(frontOf(at))) page ||= frontOf(at);
    const t = tally.get(at);
    if (!t) break;
    if (ones.has(at)) { u = { type: 'one', folder: at, ...ones.get(at) }; break; }
    const own = t.files.length + t.books.size;
    if (!own && t.kids.size === 1) { [at] = t.kids; continue; }
    if (!t.files.every((p) => isMedia(p) || isPdf(p))) break;
    const books = t.books.size || t.files.some(isPdf), songs = t.files.some(isAudio), shots = t.files.some((p) => isImage(p) || isVideo(p));
    const kind = books ? (songs || shots ? 'all' : 'docs') : songs ? (shots ? 'all' : 'music') : shots ? 'media' : null;
    if (!t.kids.size) { if (own >= 2) u = { type: 'shelf', folder: at, count: own, kind }; break; }
    if (kindOf(at) === 'notes') break;
    const kids = [...t.kids].map((path) => ({ path, unit: unitOf(path) }));
    if (kids.every((k) => k.unit)) u = { type: 'set', folder: at, kids, own, kind };
    break;
  }
  if (u) u.page = page || (u.type === 'shelf' && u.kind === 'music' ? musicOf(u.folder) : u.folder + '/');
  units.set(f, u);
  return u;
}
const oneUnder = (f) => { const u = unitOf(f); return u?.type === 'one' ? u : null; };
const shelfUnder = (f) => { const u = unitOf(f); return u?.type === 'shelf' ? u : null; };
// The name such a folder goes by, in the list and on its page: its own, with before it those of the folders that
// hold nothing but it ("outer / inner"; once, if the two are the same).
function lineName(f) {
  let top = f;
  for (let p = folderOf(top); p; p = folderOf(top)) { const t = tally.get(p); if (!t || t.files.length || t.books.size || t.kids.size !== 1) break; top = p; }
  const from = f.split('/').length - f.slice(top.length - top.split('/').pop().length).split('/').length;
  return f.split('/').map((_, i, all) => givenName(all.slice(0, i + 1).join('/'))).slice(from).filter((n, i, all) => n !== all[i - 1]).join(' / ');
}
// The page that stands for a folder: its front page, else the one made for it. null for a folder that has neither.
const pageOf = (folder) => { const page = docOf(frontOf(folder)) ? frontOf(folder) : unitOf(folder)?.page || folder + '/'; return docOf(page) ? page : null; };
function applyLocks() {
  covers = new Map();
  docs = allDocs.filter((d) => {
    const g = gateOf(d.path);
    if (g) return d.path === frontOf(g);
    if (isCover(d.path)) { covers.set(folderOf(d.path), d.path); return false; }
    return true;
  });
  // A locked folder is reached through its front page; one without gets a stand-in to carry the lock screen.
  for (const f of Object.keys(locks())) {
    if (gateOf(frontOf(f)) === f && !docs.some((d) => d.path === frontOf(f)) && allDocs.some((d) => d.path.startsWith(f + '/')))
      docs.push({ path: frontOf(f), group: f, title: f.split('/').pop(), side: false, front: false });
  }
  docMap = new Map(docs.map((d) => [d.path, d]));
  countKinds();
  // A folder with pictures or videos of its own has a gallery: a page that is
  // no file (its path is the folder's, ending in "/"), opened from the folder's
  // line in the list. It can be looked up and opened; it is not in the list of files.
  // A folder with sound files of its own has a music page the same way (see musicOf).
  holds = new Map();
  for (const d of docs) {
    const f = folderOf(d.path);
    if (!f || isBookPage(d.path)) continue;
    const h = holds.get(f) || holds.set(f, {}).get(f);
    if (isAudio(d.path)) h.songs = true; else if (isMedia(d.path)) h.shots = true; else if (!isFront(d.path)) h.other = true;
    for (let up = folderOf(f); up; up = folderOf(up)) (holds.get(up) || holds.set(up, {}).get(up)).other = true;   // a folder inside counts as something else
  }
  ones = new Map();
  tally = new Map();
  units = new Map();
  folderCovers = new Map();
  const inside = (f) => tally.get(f) || tally.set(f, { files: [], books: new Set(), kids: new Set() }).get(f);
  for (const d of docs) {
    const at = d.path.search(/\.epub\//i), item = at >= 0 ? d.path.slice(0, at + 5) : d.path, f = folderOf(item);
    if (!f) continue;
    if (at >= 0) inside(f).books.add(item); else if (!isFront(d.path)) inside(f).files.push(d.path);
    for (let kid = f, up = folderOf(f); up; kid = up, up = folderOf(up)) inside(up).kids.add(kid);
  }
  for (const [f, t] of tally) {
    if (t.kids.size || gateOf(frontOf(f))) continue;
    if (t.files.length === 1 && !t.books.size) ones.set(f, { path: t.files[0] });
    else if (!t.files.length && t.books.size === 1) ones.set(f, { book: [...t.books][0] });
  }
  for (const f of ones.keys()) docMap.set(f + '/', { path: f + '/', title: f.split('/').pop(), gallery: 'one', side: false, front: false });
  for (const [f, h] of holds) {
    // A folder of pictures and music and nothing else has the one page, opened on everything.
    if (h.shots && !docMap.has(f + '/')) docMap.set(f + '/', { path: f + '/', title: f.split('/').pop(), gallery: h.songs && !h.other ? 'all' : 'media', side: false, front: false });
    if (h.songs && !docMap.has(musicOf(f))) docMap.set(musicOf(f), { path: musicOf(f), title: f.split('/').pop() + ' (music)', gallery: 'music', side: false, front: false });
  }
  // A folder with books of its own has such a page too, opened on them (a shelf's line opens it: see shelfUnder).
  for (const [f, t] of tally) {
    if (docMap.has(f + '/') || gateOf(frontOf(f)) || !(t.books.size || t.files.some(isPdf))) continue;
    docMap.set(f + '/', { path: f + '/', title: f.split('/').pop(), gallery: t.files.some(isMedia) ? 'all' : 'docs', side: false, front: false });
  }
  // A set has a page as well (see unitOf); and each of these pages goes by the name its line has in the list.
  for (const f of tally.keys()) { const u = unitOf(f); if (u?.type === 'set' && !docMap.has(u.folder + '/')) docMap.set(u.folder + '/', { path: u.folder + '/', title: '', gallery: 'set', side: false, front: false }); }
  // And so has every other folder: a page that shows the folders in it as cards and lists its own files (see
  // folderBody). The file list opens such a folder out; this page is the way into it from a card, from the pages
  // above it, and on a phone, where the list is out of sight.
  for (const f of tally.keys()) if (!docMap.has(f + '/') && !gateOf(frontOf(f))) docMap.set(f + '/', { path: f + '/', title: '', gallery: 'folder', side: false, front: false });
  for (const d of docMap.values()) if (d.gallery && d.path.endsWith('/')) d.title = lineName(d.path.slice(0, -1));
  // The inbox (where "add files" puts things) always has its page, with or without anything in it yet: everything in it, the latest first (see inboxBody).
  if (!gateOf(frontOf(INBOX))) docMap.set(INBOX + '/', { path: INBOX + '/', title: 'Inbox', gallery: 'inbox', side: false, front: false });
}
// After a lock is opened, closed, set or removed: redraw everything that could show the folder.
async function locksChanged() {
  applyLocks();
  if (music.path && !docOf(music.path)) { player.pause(); player.removeAttribute('src'); music.path = null; }
  if (bg && !docOf(bg.path)) stopVideo();
  state.panes.forEach((p, i) => {
    p.tabs = p.tabs.filter(docOf);
    if (!p.tabs.includes(p.active)) p.active = p.tabs[0] || null;
    if (!p.tabs.length && i === 0 && config.front) { p.tabs = [config.front]; p.active = config.front; }
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
    // The password has been typed for this folder: this one is open. The others stay locked, the same password or not, until each is opened itself.
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
// What can be done with a folder as a whole, under its page (its front page, or the one made for it: a gallery,
// a music page, a page of cards): bring it up to date, lock it, take it out of the workspace.
function folderActs(folder) {
  const rm = el('button', '', 'remove folder…');
  rm.title = 'Take this folder and everything in it out of the workspace';
  rm.onclick = () => removeFolder(folder);
  const up = el('button', '', 'update…');
  up.title = 'Bring in what is new or changed in this folder on this device since it was uploaded. Only those files are sent.';
  up.onclick = () => updateFolder(folder);
  return [up, ...lockButtons(folder), rm];
}
// "lock now" once more, under the title of a page of a locked folder that is open: the one among the buttons at the
// foot of the page is a long way down a full folder. The folder that is locked may be one further out than the page's own.
function addLockTop(article, folder) {
  const f = Object.keys(locks()).filter((x) => (folder + '/').startsWith(x + '/') && unlocked.has(x)).sort((a, b) => a.length - b.length)[0];
  const h1 = article.querySelector('h1');
  if (!f || !h1) return;
  const box = el('div', 'lockTop'), b = el('button', '', f === folder ? 'lock now' : `lock \u201c${f.split('/').pop()}\u201d now`);
  b.title = 'Hide this folder again until its password is typed';
  b.onclick = () => { unlocked.delete(f); locksChanged(); };
  box.append(b);
  h1.after(box);
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
    card.append(el('p', '', `The folder and the ${inside} file${inside === 1 ? '' : 's'} in it are taken out of this workspace, on the server and for every device. The hub keeps it aside for seven days (less if the room is needed for something new), and it can be put back from the settings, under “removed folders…”.`),
      el('p', 'sub', 'Files on your own computer are not touched: a folder you uploaded can be uploaded again.'), go, no, say);
    no.onclick = closeGate;
    go.onclick = async () => {
      go.disabled = true;
      let done;
      try { done = await api('/api/folder?path=' + encodeURIComponent(folder), 'DELETE'); }
      catch (e) { go.disabled = false; say.textContent = e.offline ? 'The server is not reachable. A folder can only be removed while connected.' : e.message; return; }
      for (const d of allDocs) if (d.path.startsWith(folder + '/') && kept.has(d.path)) await dropCopy(d.path);
      queue = queue.filter((p) => !p.startsWith(folder + '/'));
      saveQueue();
      closeGate();
      await loadConfig();
      await loadDocs();
      await locksChanged();
      if (done?.undo) showGate(`“${folder.split('/').pop()}” was removed`, (card) => {
        const back = el('button', '', 'Put it back'), ok = el('button', 'main', 'OK'), why = el('p', 'say');
        card.append(el('p', 'sub', 'Kept aside on the hub for seven days; “removed folders…” in the settings puts it back later too.'), ok, back, why);
        ok.onclick = closeGate;
        back.onclick = async () => {
          back.disabled = true;
          try { await putBack(done.undo); closeGate(); if (docOf(frontOf(folder))) openDoc(frontOf(folder)); }
          catch (e) { back.disabled = false; why.textContent = e.message; }
        };
        ok.focus();
      }, true);
    };
  }, true);
}
// A removed folder, put back where it was, with its lock (see /api/folder/restore).
async function putBack(undo) {
  const done = await api('/api/folder/restore', 'POST', { undo });
  await loadConfig();
  await loadDocs();
  await locksChanged();
  return done.restored;
}
// Folders removed from this workspace that the hub still keeps aside, newest first: each can be put back, or let go
// for good now (to free the room at once). A folder that was locked is not named.
async function showRemoved() {
  let list = null, why = '';
  const size = (n) => (n < 1 << 20 ? Math.max(1, Math.round(n / 1024)) + ' KB' : mb(n));
  const fill = (card) => {
    card.append(el('p', 'sub', 'A folder removed from this workspace is kept aside on the hub for seven days, or less when the room is needed for something new. Put back, it is where it was, with its lock; notes on it were never removed.'));
    if (why) return card.append(el('p', 'say', why));
    if (!list) return card.append(el('p', 'sub', 'Asking the hub…'));
    if (!list.length) return card.append(el('p', '', 'Nothing removed is kept now.'));
    for (const r of [...list].reverse()) {
      const row = el('div', 'dev space'), name = el('span', '', r.locked ? 'A locked folder' : r.from.split('/').pop());
      if (!r.locked) name.title = r.from;
      const back = el('button', '', 'put back'), drop = el('button', '', 'let go');
      back.title = 'Put it back where it was';
      drop.title = 'Delete it for good now, to free its room on the hub';
      back.onclick = async () => {
        back.disabled = drop.disabled = true;
        try { await putBack(r.undo); list = list.filter((x) => x !== r); }
        catch (e) { why = e.message; }
        redraw();
      };
      drop.onclick = async () => {
        if (drop.dataset.sure !== '1') { drop.dataset.sure = '1'; drop.textContent = 'delete for good?'; drop.classList.add('sure'); return; }
        back.disabled = drop.disabled = true;
        try { await api('/api/removed?undo=' + encodeURIComponent(r.undo), 'DELETE'); list = list.filter((x) => x !== r); }
        catch (e) { why = e.message; }
        redraw();
      };
      const parent = r.locked ? '' : r.from.split('/').slice(0, -1).join(' / ');
      row.append(name, el('small', '', (parent ? parent + ' · ' : '') + ago(Date.parse(r.at))), el('small', 'size', size(r.size)), back, drop);
      card.append(row);
    }
  };
  const redraw = () => showGate('Removed folders', fill, true);
  redraw();
  try { list = await api('/api/removed'); } catch (e) { why = e.offline ? 'The hub is not reachable: removed folders can be seen and put back only while it is.' : e.message; }
  if (!gate.hidden && gate.querySelector('h2')?.textContent === 'Removed folders') redraw();
}
async function loadDocs() {
  try { serverDocs = await api('/api/docs'); store.set('docs:' + config.root, serverDocs); }
  catch { serverDocs = store.get('docs:' + config.root) || serverDocs; }
  // Files added on this device and not yet sent appear in the list too.
  const waiting = pendingFiles.filter((f) => !serverDocs.some((d) => d.path === f.path))
    .map((f) => ({ path: f.path, group: f.path.split('/').slice(0, -1).join('/'), title: f.path.split('/').pop(), side: false, front: false }));
  allDocs = serverDocs.concat(waiting);
  learnGivenNames();
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
  const b = $('keptOnly'), shown = asItems(docs.filter(inView)).length;
  b.hidden = !view.onlyKept;
  b.textContent = `On this device only: ${shown} of ${asItems(docs).length}. Show everything`;
}
$('keptOnly').onclick = () => setOnlyKept(false);

// ---- find -------------------------------------------------------------------------------
// The box above the file list. As you type it narrows the list to files whose
// name or title matches; from three letters on it also looks inside the
// documents (the server does that; without it, the copies kept here are
// searched) and in your notes, and lists the lines found. The files that match
// are listed under the box as well, because finding opens no folder: the
// folders in the list stay as they were left, open or closed.
let finding = '', findTimer = 0, findRun = 0;
let inside = null;   // what was last found inside the documents and notes, and for which words: { q, hits, mine }
const findBox = $('find'), findClear = $('findClear'), foundEl = $('found');
const matchesFind = (d) => !finding || ((gateOf(d.path) ? '' : d.title + ' ') + d.path).toLowerCase().includes(finding);   // a locked folder's title is not matched
findBox.addEventListener('input', () => {
  finding = findBox.value.trim().toLowerCase();
  findClear.hidden = !findBox.value;
  renderTree();
  clearTimeout(findTimer);
  if (finding.length < 3) inside = null; else findTimer = setTimeout(runFind, 350);
  drawFound();
});
const clearFind = () => { findBox.value = ''; findBox.dispatchEvent(new Event('input')); };
findBox.addEventListener('keydown', (e) => { if (e.key === 'Escape') { clearFind(); findBox.blur(); } });
findClear.onclick = () => { clearFind(); findBox.focus(); };   // the × over the end of the box
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
  inside = { q, hits, mine };
  drawFound();
}
// What was found, under the box: the files by name, then the lines inside documents, then the notes.
function drawFound() {
  foundEl.replaceChildren();
  foundEl.hidden = !finding;
  if (!finding) return;
  // `open` is how to come back to this result: it is kept, with the words, as the latest search (see keepSearch).
  const row = (title, where, text, go, open) => {
    const r = el('div', 'hit');
    r.tabIndex = 0;
    r.setAttribute('role', 'button');
    r.append(el('b', '', title));
    if (where) r.append(el('small', '', where));
    if (text) r.append(el('span', '', text));
    // What it is, for a group being made or a reference in a note (see refParts): a note, or a file (at one of its saved links).
    if (open.id) r.dataset.id = open.id; else { r.dataset.path = open.path; if (/^item=\d+$/.test(open.hash || '')) r.dataset.hash = open.hash; }
    r.onclick = (e) => { keepSearch(finding, title, open); go(e); };
    foundEl.append(r);
  };
  const names = asItems(docs.filter((d) => matchesFind(d) && inView(d)));
  for (const d of names.slice(0, 20)) {
    // A book is one line: found by its own name, it opens where it was last read; found by a page's name, at that page.
    if (d.book) {
      const page = d.book.toLowerCase().includes(finding) ? null : d.pages[0], to = page ? page.path : bookTarget({ book: d.book, pages: docs.filter((x) => inBook(d.book, x.path) && inView(x)) });
      row(d.title, shortPath(folderOf(d.path)), page ? page.title : 'Book', (e) => openDoc(to, { side: e.metaKey || e.ctrlKey || e.altKey }), { path: to });
      continue;
    }
    const name = d.path.split('/').pop(), locked = gateOf(d.path);
    row(isFront(d.path) ? 'Front page' : name, shortPath(folderOf(d.path)), locked ? 'Locked: open to unlock' : d.title && d.title !== name ? d.title : '', (e) => pressFile(d.path, e), { path: d.path });
  }
  const q = inside?.q, hits = (inside?.hits || []).filter((h) => docOf(h.path) && !gateOf(h.path)), mine = (inside?.mine || []).filter((n) => docOf(n.doc));
  for (const h of hits) {
    // A line of a document opens it there. What was found in a file of saved links is one of its items: the file opens at that item's card, or its row.
    if (h.item != null) row(titleOf(docOf(h.path)), shortPath(h.path) + ', saved link', h.text, () => openDoc(h.path, { hash: 'item=' + h.item }), { path: h.path, hash: 'item=' + h.item });
    else row(titleOf(docOf(h.path)), shortPath(h.path) + ', line ' + h.line, h.text.replace(/[*_`#>|]+/g, ' ').replace(/\s+/g, ' ').trim(), async () => { await openDoc(h.path); showFound(state.active, q); }, { path: h.path, words: q });
  }
  for (const n of mine) row(titleOf(docOf(n.doc)), n.text ? 'your note' : 'your highlight', n.text || n.quote, async () => { await openDoc(n.doc, { hash: n.heading || undefined }); if (n.quote) showFound(state.active, n.quote.toLowerCase().slice(0, 40)); }, { path: n.doc, id: n.id, hash: n.heading || undefined, words: n.quote ? n.quote.toLowerCase().slice(0, 40) : undefined });
  const some = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
  let said = some(names.length, 'file') + ' by name' + (names.length > 20 ? ' (the first 20)' : '');
  if (finding.length < 3) said += '. From three letters on, documents and notes are looked inside too.';
  else if (!inside) said += '. Looking inside documents and notes…';
  else said += `, ${some(hits.length, 'line')} in documents${hits.length >= 60 ? ' (the first 60)' : ''}, ${mine.length} in notes${net.online ? '' : ' · searched the copies on this device only'}`;
  if (inside && !names.length && !hits.length && !mine.length) said = `Nothing found for “${q}”${net.online ? '' : ' in the copies on this device'}.`;
  foundEl.prepend(el('div', 'sub', said));
}
// The latest searches: for each set of words, the one result that was opened from it (the last, if several
// were). Kept on this device, per workspace, the newest first; listed on the main front page (appendSearches).
const searchesOf = () => { const s = store.get('searches:' + config.root); return Array.isArray(s) ? s : []; };
function keepSearch(q, label, open) {
  if (!q || !open?.path) return;
  store.set('searches:' + config.root, [{ q, label, open, ts: Date.now() }, ...searchesOf().filter((s) => s.q !== q)].slice(0, 30));
}
async function openSearch(s) {
  if (!docOf(s.open.path)) return;
  await openDoc(s.open.path, { hash: s.open.hash });
  if (s.open.words) showFound(state.active, s.open.words);
}
// On the main front page, over its title: closed until pressed. Pressing a line opens what was opened from that search; × forgets it.
function appendSearches(article) {
  const list = searchesOf().filter((s) => !gateOf(s.open?.path || ''));   // not what was found in a folder that is locked now: its words and the file's name would say what is in there
  if (!list.length) return;
  const det = el('details', 'searches'), sum = el('summary', '', 'Latest searches'), count = el('small', '', ' \u00b7 ' + list.length), rows = el('div', 'listing');
  sum.append(count);
  for (const s of list) {
    const row = el('div', 'item'), out = el('button', '', '\u00d7');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    out.title = 'Forget this search';
    out.setAttribute('aria-label', out.title);
    out.onclick = (e) => {
      e.stopPropagation();
      store.set('searches:' + config.root, searchesOf().filter((x) => x.q !== s.q));
      row.remove();
      count.textContent = ' \u00b7 ' + rows.children.length;
      if (!rows.children.length) det.remove();
    };
    row.append(el('span', '', s.q), el('small', '', s.label + (docOf(s.open.path) ? '' : ' (no longer here)')), out);
    row.onclick = () => openSearch(s);
    rows.append(row);
  }
  det.append(sum, rows);
  article.prepend(det);
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

// What a folder holds, everything inside it counted: sound, video, a gallery, or books and documents alone, or a
// mix of them. A gallery is a file of saved links (its page is a grid of the pictures and video it points to), or
// a folder of nothing but pictures. Beside anything else, pictures are company (a cover with an album, the figures
// of a text) and do not make a mix. Each folder's line carries the sign of its kind, and the folders added to the
// workspace are listed under the five kinds (CATS), each kind one line that opens out.
const KIND_ICONS = {
  mixed: '<path d="M3 4h7v7H3zM14 4h7v7h-7zM3 15h7v7H3zM14 15h7v7h-7z"/>',
  audio: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  video: '<path d="M3 5h18v14H3z"/><path d="M10 9l5 3-5 3z"/>',
  pics: '<path d="M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.6"/>',
  docs: '<path d="M12 6c-2-1.5-5-2-9-2v15c4 0 7 .5 9 2 2-1.5 5-2 9-2V4c-4 0-7 .5-9 2zM12 6v15"/>',
  notes: '<path d="M6 2h9l5 5v15H6zM15 2v5h5M9 12h8M9 16h8M9 8h3"/>',
  pin: '<path d="M9 3h6l-1 7 3 3H7l3-3zM12 13v8"/>',
  inbox: '<path d="M3 13l3-9h12l3 9v7H3zM3 13h5l1 3h6l1-3h5"/>',
};
// Notes: a folder where more than this share of what is in it, its folders' contents counted too, is markdown.
const NOTES_SHARE = 0.5;
const CATS = [['notes', 'Notes'], ['mixed', 'Mixed'], ['audio', 'Audio'], ['video', 'Video'], ['pics', 'Image/video galleries'], ['docs', 'Books and documents']];
const KIND_SAYS = { notes: 'Notes: mostly markdown', mixed: 'A mix of kinds', audio: 'Sound', video: 'Video', pics: 'Pictures, and galleries of saved links', docs: 'Books and documents', inbox: 'What was added, the latest first' };
let folderBits = new Map();   // folder -> what is inside it: 1 sound, 2 video, 4 documents, 8 pictures, 16 files of saved links
let folderCount = new Map();   // folder -> [how many things are inside it (a book is one), how many of them markdown]
function countKinds() {
  folderBits = new Map();
  folderCount = new Map();
  const books = new Set();
  // What is in a locked folder is counted too (it is not in `docs`): locked, the folder is still of its kind, and stays under it in the list.
  for (const d of [...docs, ...allDocs.filter((x) => gateOf(x.path) && !isCover(x.path))]) {
    if (d.gallery || d.front || isFront(d.path)) continue;
    const cut = d.path.search(/\.epub\//i), item = cut >= 0 ? d.path.slice(0, cut + 5) : d.path;
    if (cut < 0 || !books.has(item)) {
      books.add(item);
      const md = cut < 0 && /\.md$/i.test(item) ? 1 : 0;
      for (let at = item.lastIndexOf('/'); at > 0; at = item.lastIndexOf('/', at - 1)) { const f = item.slice(0, at), c = folderCount.get(f) || folderCount.set(f, [0, 0]).get(f); c[0]++; c[1] += md; }
    }
    const p = d.path, bit = /\.epub\//i.test(p) ? 4 : isAudio(p) ? 1 : isVideo(p) ? 2 : isImage(p) ? 8 : d.links ? 16 : 4;   // whatever is in a book is the book
    for (let at = p.lastIndexOf('/'); at > 0; at = p.lastIndexOf('/', at - 1)) { const f = p.slice(0, at); folderBits.set(f, folderBits.get(f) | bit); }
  }
}
const kindOfBits = (b) => ({ 1: 'audio', 2: 'video', 4: 'docs', 16: 'pics', 0: b & 8 ? 'pics' : 'docs' })[b & 23] || 'mixed';
const kindOf = (folder) => { const c = folderCount.get(folder); return c && c[1] / c[0] > NOTES_SHARE ? 'notes' : kindOfBits(folderBits.get(folder) || 0); };
const catOf = kindOf;   // a kind is listed under its own name
function kindIcon(kind) {
  const s = el('span', 'kind');
  s.title = KIND_SAYS[kind];
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">${KIND_ICONS[kind]}</svg>`;
  return s;
}
// Pinning: a folder's line has a pin at its end (shown when the line is pointed at; always, once pinned). A pinned
// folder is listed under "Pinned", over the kinds, wherever it is in the workspace: a folder at the top moves
// there, one inside another is listed there as well as in its place. Kept with the layout, on this device.
function addPin(sum, folder) {
  const on = (state.pinned || []).includes(folder), b = el('button', 'pin');
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">${KIND_ICONS.pin}</svg>`;
  b.title = on ? 'Pinned to the top of the list. Press to unpin.' : 'Pin to the top of the list';
  b.setAttribute('aria-label', b.title);
  b.setAttribute('aria-pressed', on);
  b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.pinned = on ? state.pinned.filter((f) => f !== folder) : [...(state.pinned || []), folder];
    save();
    renderTree();
  };
  sum.append(b);
}
// A line that opens out and is no folder (the starter material, a kind of folder): whether it is open is kept under `key`.
function holdOpen(det, key) {
  det.open = state.opened.includes(key);
  det.addEventListener('toggle', () => {
    pinNext();
    state.opened = state.opened.filter((p) => p !== key);
    if (det.open) state.opened.push(key);
    else for (const inner of det.querySelectorAll('details[open]')) inner.open = false;
    stickFolders();
    save();
  });
}
function renderTree() {
  showOnlyKept();
  const y = treeEl.scrollTop, tools = (renderTree.tools ||= $('treeTools'));   // taken from the list before it is emptied
  if (tools) tools.onclick = tools.ondblclick = (e) => e.stopPropagation();   // a press on a button there is not one on the line
  treeEl.innerHTML = '';
  const root = { dirs: {}, files: [] };
  for (const d of docs) {
    if (d.front || !matchesFind(d) || !inView(d)) continue;
    let node = root;
    // A book is one folder of pages in reading order: the folders inside its file are not shown.
    for (const part of d.path.split('/').slice(0, -1)) { node = node.dirs[part] ??= { dirs: {}, files: [] }; if (/\.epub$/i.test(part)) break; }
    node.files.push(d);
  }
  // The first line is the workspace's front page, under the workspace's name. At its end: make a group, add files, upload a folder.
  const front = docs.find((d) => d.front), frontRow = front ? fileRow(front, config.title || 'Front page') : null, head = front && matchesFind(front) ? frontRow : el('div', 'file bare');
  head.classList.add('head');
  // Its keep mark is not on the line, where the room goes to the name: it is on the home button over the list, between the title and the house.
  const st = frontRow?.querySelector('.st');
  $('hubHome').querySelector('.st')?.remove();
  if (st) $('hubHome').querySelector('svg').before(st);
  if (tools) head.append(tools);
  treeEl.append(head);
  const draw = (node, parent, prefix) => {
    // A folder's own front page comes first, under that name.
    const fp = prefix ? node.files.find((f) => isFront(f.path)) : null;
    if (fp) parent.append(fileRow(fp, gateOf(fp.path) ? 'Locked: open to unlock' : 'Front page'));
    // A folder's pictures and videos are one line, its gallery, not a line each
    // (while finding, each file that matches is still listed).
    const shots = finding || !prefix ? [] : node.files.filter((f) => isImage(f.path) || isVideo(f.path));
    // Its sound files likewise: one line, its music page.
    const songs = finding || !prefix ? [] : node.files.filter((f) => isAudio(f.path));
    // With a front page, that page is the gallery and the music page: no lines apart from it.
    if (shots.length && !fp) parent.append(galleryRow(prefix, 'Gallery', shots.length));
    if (songs.length && !fp) parent.append(galleryRow(musicOf(prefix.slice(0, -1)), 'Music', songs.length, 'sound files'));
    for (let [name, sub] of Object.entries(node.dirs)) {
      const whole = prefix + name;   // the folder this line stands for, however far down what it shows is: what a pin remembers
      // A folder of things to look at, listen to or read (see unitOf) is one line, with nothing to open out:
      // pressing it opens the page that shows what is in it, and that is where it is gone into.
      const u = finding || gateOf(whole + '/') === whole ? null : unitOf(whole);
      if (u) {
        // A lone document that is text is read as it is: no page stands before it. Inside another folder it is the file's own line.
        const text = u.type === 'one' && !!u.path && !isBinary(u.path) && u.page.endsWith('/');
        if (text && prefix) { const row = fileRow(docOf(u.path)); row.title = u.path; parent.append(row); continue; }
        const says = u.type === 'one' ? (u.book || u.path).split('/').pop() + ', in ' + u.folder : `${u.type === 'set' ? u.kids.length + u.own : u.count} in ${u.folder}`;
        addPin(parent.appendChild(leafRow(u.folder, text ? u.path : u.page, [], lineName(u.folder), says)).firstChild, whole);
        continue;
      }
      // A folder holding nothing but one folder is that folder's line: the two names on it (once, if they are the
      // same), and what it opens, or opens out to, is what the inner folder holds. So on, as far down as that goes.
      let label = givenName(prefix + name);
      if (!finding && !/\.epub$/i.test(name)) for (let inner; !sub.files.length && ([inner] = Object.keys(sub.dirs)).length === 1 && !/\.epub$/i.test(inner);) {
        const shown = givenName(prefix + name + '/' + inner);
        if (shown !== label.split(' / ').pop()) label += ' / ' + shown;
        name += '/' + inner;
        sub = sub.dirs[inner];
      }
      // A locked folder stays where it was in the list, as one line that says it is locked: pressing it asks for the password.
      if (!finding && gateOf(prefix + name + '/') === prefix + name) {
        const line = leafRow(prefix + name, frontOf(prefix + name), [], label, 'Locked: press to unlock');
        line.firstChild.classList.add('lockedLine');
        line.firstChild.append(el('small', '', ' \u00b7 locked'));
        addPin(parent.appendChild(line).firstChild, whole);
        continue;
      }
      if (!finding) {
        // A book is one line that opens it: its chapters are in the outline.
        if (/\.epub$/i.test(name)) { if (sub.files.length) parent.append(bookRow(prefix + name, sub.files)); continue; }
        // A folder of nothing but pictures, videos and sound files is one line
        // too: its front page if it has one (the page lists them), or else its
        // gallery or music page. Only a folder that also holds documents, or
        // folders, opens out.
        // A folder inside another that holds one file and nothing else is that file's line, under the file's own name: no folder to open for it.
        if (prefix && sub.files.length === 1 && !Object.keys(sub.dirs).length && !gateOf(sub.files[0].path)) {
          const only = sub.files[0], row = fileRow(only, isFront(only.path) ? label : undefined);
          row.title = only.path;
          parent.append(row);
          continue;
        }
        const front = sub.files.find((f) => isFront(f.path)), media = sub.files.filter((f) => f !== front);
        if (media.length && media.every((f) => isMedia(f.path)) && !Object.keys(sub.dirs).length) {
          addPin(parent.appendChild(leafRow(prefix + name, front ? front.path : media.every((f) => isAudio(f.path)) ? musicOf(prefix + name) : prefix + name + '/', media, label)).firstChild, whole);
          continue;
        }
      }
      const det = el('details'), sum = el('summary', '', label);
      sum.prepend(kindIcon(kindOf(prefix + name)));
      det.open = state.opened.includes(prefix + name);   // folders start closed, and finding opens none: what matches is listed under the find box
      sum.dataset.folder = prefix + name;
      paintQuick(sum);
      if (pageOf(prefix + name)) sum.append(plusBtn(() => pageOf(prefix + name)));
      addPin(sum, whole);
      det.append(sum);
      det.addEventListener('toggle', () => {
        pinNext();
        // Closing a folder forgets what was open inside it, so it comes back with its subfolders closed.
        state.opened = state.opened.filter((p) => p !== prefix + name && (det.open || !p.startsWith(prefix + name + '/')));
        if (det.open) state.opened.push(prefix + name);
        else for (const inner of det.querySelectorAll('details[open]')) inner.open = false;
        stickFolders();
        save();
      });
      const kids = el('div', 'kids');
      det.append(kids);
      draw(sub, kids, prefix + name + '/');
      parent.append(det);
    }
    for (const f of node.files) if (f !== fp && !shots.includes(f) && !songs.includes(f)) parent.append(fileRow(f, /\.epub\//i.test(f.path) ? pageTitle(f) : undefined));   // a page of a book goes by its name in the contents
  };
  // Sections. What hub.json lists under "starter" (the material every copy
  // begins with) is kept together, first. Each other top-level folder, added
  // since, is a section by itself; files added loose come last.
  const starter = new Set((config.starter || []).map((s) => s.replace(/\/$/, '')));
  const base = { dirs: {}, files: root.files.filter((f) => starter.has(f.path)) }, loose = root.files.filter((f) => !starter.has(f.path));
  const section = (cls, heading) => { const s = el('div', 'sect' + cls); if (heading) s.append(el('div', 'sect-h', heading)); treeEl.append(s); return s; };
  drawGroups(section);
  // The inbox is a line of its own, with nothing to open out: its page shows all of it, the latest first.
  const inboxed = !finding && !!docOf(INBOX + '/') && !starter.has(INBOX);
  if (inboxed) {
    const det = el('details', 'leaf'), sum = el('summary', '', 'Inbox'), n = asItems(docs.filter((d) => d.path.startsWith(INBOX + '/') && !isFront(d.path) && inView(d))).length;
    sum.prepend(kindIcon('inbox'));
    if (n) sum.append(el('small', '', ' \u00b7 ' + n));
    sum.dataset.folder = INBOX;
    sum.dataset.path = INBOX + '/';
    sum.setAttribute('role', 'button');
    if (state.panes.some((p) => p.tabs.some((t) => inLine(sum, t)))) sum.classList.add('open');
    if (inLine(sum, activeDoc())) sum.classList.add('active');
    sum.onclick = (e) => { e.preventDefault(); openDoc(INBOX + '/', { side: e.metaKey || e.ctrlKey || e.altKey }); };
    sum.ondblclick = () => openDoc(INBOX + '/', { keep: true });
    sum.append(plusBtn(() => INBOX + '/'));
    det.append(sum);
    section(' cat').append(det);
  }
  for (const [name, sub] of Object.entries(root.dirs)) if (starter.has(name)) base.dirs[name] = sub;
  // The starter material is one folder's line, "cs-learning", closed until it is pressed like any other folder.
  if (Object.keys(base.dirs).length || base.files.length) {
    const det = el('details'), sum = el('summary', '', 'cs-learning'), kids = el('div', 'kids');
    sum.dataset.name = 'cs-learning';
    // Its kind, from everything in it together (a starter file that is loose is a document, or a note).
    const [all, md] = [...starter].reduce((a, s) => { const c = folderCount.get(s) || [1, /\.md$/i.test(s) ? 1 : 0]; return [a[0] + c[0], a[1] + c[1]]; }, [0, 0]);
    sum.prepend(kindIcon(all && md / all > NOTES_SHARE ? 'notes' : kindOfBits([...starter].reduce((b, s) => b | (folderBits.get(s) || 4), 0))));
    holdOpen(det, ':starter');   // no folder can be named so
    det.append(sum, kids);
    draw(base, kids, '');
    section(' up').append(det);
  }
  // The added folders, under their kinds: each kind is one line, closed until it is pressed, with its folders inside.
  // In a kind, inbox/ (where "add files…" puts things) leads, so what was just added is easy to find; under it, the
  // folder most recently added to comes first (by the newest file in each; folders the server gave no time for keep their order, last).
  const newest = {};
  for (const d of docs) { const top = d.path.split('/')[0]; if (d.changed > (newest[top] || 0)) newest[top] = d.changed; }
  // The pinned folders, in the order they were pinned.
  const nodeAt = (f) => f.split('/').reduce((n, part) => n?.dirs[part], root);
  const pins = finding ? [] : (state.pinned || []).filter(nodeAt);
  if (pins.length) {
    const box = section(' pins', 'Pinned');
    for (const f of pins) { const s = el('div', 'sect up'), cut = f.lastIndexOf('/'); box.append(s); draw({ dirs: { [f.slice(cut + 1)]: nodeAt(f) }, files: [] }, s, f.slice(0, cut + 1)); }
  }
  const added = Object.entries(root.dirs).filter(([name]) => !starter.has(name) && !pins.includes(name) && !(inboxed && name === INBOX)).sort(([a], [b]) => (b === 'inbox') - (a === 'inbox') || (newest[b] || 0) - (newest[a] || 0));
  for (const [cat, label] of CATS) {
    const mine = added.filter(([name]) => catOf(name) === cat);
    if (!mine.length) continue;
    const det = el('details'), sum = el('summary', '', label), kids = el('div', 'kids');
    sum.dataset.name = label;
    sum.prepend(kindIcon(cat));
    sum.append(el('small', '', ' \u00b7 ' + mine.length));
    holdOpen(det, ':cat:' + cat);
    det.append(sum, kids);
    for (const [name, sub] of mine) { const s = el('div', 'sect up'); kids.append(s); draw({ dirs: { [name]: sub }, files: [] }, s, ''); }
    section(' cat').append(det);
  }
  if (loose.length) draw({ dirs: {}, files: loose }, section('', starter.size ? 'Other files' : ''), '');
  treeEl.append(nextPin);
  for (const key of getting.keys()) paintGot(key);
  trimTree();
  stickFolders();
  treeEl.scrollTop = y;
  pinNext();
}
// Each open folder's line is held at the top of the list while its contents
// scroll (the style sheet does that). A folder inside another is held just
// under its parent's line, so the whole way down to where one is stays in sight.
function stickFolders() {
  for (const sum of treeEl.querySelectorAll('details[open] > summary')) {   // in the order of the page: a parent before what is in it
    const up = sum.parentNode.parentNode.closest('details')?.querySelector(':scope > summary');
    const top = up ? (parseFloat(up.style.top) || 0) + up.offsetHeight : 0;
    sum.style.top = top + 'px';
    sum.style.zIndex = String(Math.max(1, 20 - Math.round(top / 10)));   // a line further in slides away beneath the ones above it
  }
}
addEventListener('resize', stickFolders);
// ---- the list, short: only the way to where you are ----
// Each time the list is opened (the reader starting, the drawer on a phone, the sidebar brought back or peeked at),
// everything in it is closed but the way down to the folder being read in, and that folder is open with all it holds.
// In each folder on the way (and the section it is in) only the next step down is shown; the rest of what is in it
// waits behind "Show N more" at its top, so a long list does not all come at once. Finding is left as it is.
let treeFocus = null;   // { folder, shown }: the folder being read in when the list was opened, and the folders whose other contents were asked for since
function focusTree() {
  const path = activeDoc() || '', book = path.search(/\.epub\//i), at = book < 0 ? path : path.slice(0, book + 5);
  const folder = at.endsWith('/') ? at.slice(0, -1) : folderOf(at);   // a book's place is the folder it is in; the main front page's, none
  // The section it is in: the starter material's, or the kind of the folder at the top (a book at the top is listed under
  // a kind as a folder is). A loose file at the top is in none.
  const parts = folder ? folder.split('/') : [], top = parts[0] || (book >= 0 ? at : '');
  const starter = (config.starter || []).map((x) => x.replace(/\/$/, '')).includes(top || at);
  const sect = starter ? ':starter' : top ? ':cat:' + catOf(top) : null;
  treeFocus = { folder, shown: new Set() };
  state.opened = [...(sect ? [sect] : []), ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
  state.groupsOpen = [];
  save();
  renderTree();
  // A section opened above that does not lead there after all (the inbox and a pinned folder have lines of their own): closed again.
  const marks = focusMarks(treeFocus);
  for (const det of treeEl.querySelectorAll('details[open]')) if (!marks.some((m) => m === det || det.contains(m))) det.open = false;
  (marks[0]?.matches('details') ? marks[0].querySelector(':scope > summary') : marks[0])?.scrollIntoView({ block: 'nearest' });
}
// What stands for the place in the list: the folder's own line, or else the line of what is open in it (a file, a
// book, a folder that is one line). It may be there twice, when a folder it is in is pinned.
function focusMarks(f) {
  const marks = f.folder ? [...treeEl.querySelectorAll('summary[data-folder]')].filter((x) => x.dataset.folder === f.folder).map((x) => x.parentNode) : [];
  return marks.length ? marks : [...treeEl.querySelectorAll('.file.active, .leaf > summary.active')].map((x) => (x.matches('summary') ? x.parentNode : x));
}
function trimTree() {
  const f = treeFocus;
  if (!f || finding) return;
  const marks = focusMarks(f), keep = new Set();
  for (const m of marks) for (let n = m; n && n !== treeEl; n = n.parentNode) keep.add(n);
  for (const m of marks) for (let det = m.parentNode.closest('details'); det && treeEl.contains(det); det = det.parentNode.closest('details')) {
    const kids = det.querySelector(':scope > .kids'), sum = det.querySelector(':scope > summary');
    const key = sum.dataset.folder || ':' + sum.dataset.name;
    if (!det.open || !kids || f.shown.has(key) || kids.querySelector(':scope > .moreRow')) continue;
    const rest = [...kids.children].filter((c) => !keep.has(c));
    if (!rest.length) continue;
    for (const c of rest) c.hidden = true;
    const name = sum.dataset.name || sum.dataset.folder.split('/').pop(), more = el('div', 'file moreRow');
    more.append(el('span', 'name', `Show ${rest.length} more`));
    more.tabIndex = 0;
    more.setAttribute('role', 'button');
    more.title = `Everything else in ${name}`;
    more.onclick = (e) => {
      e.stopPropagation();
      f.shown.add(key);
      for (const c of rest) c.hidden = false;
      more.remove();
      stickFolders();
      pinNext();
    };
    kids.prepend(more);
  }
}
// A folder that is one line: it looks like any folder's line, quick open and
// all, but has nothing to open out to (no arrow). Pressing it opens the
// folder's page: its front page, or else its gallery or music page.
// Whether `p` is what a one-line folder opens, or anything inside the folder: such a line is the only sign in the list of all that is in it.
const inLine = (sum, p) => !!p && (p === sum.dataset.path || p.startsWith(sum.dataset.folder + '/'));
function leafRow(folder, path, media, label, says) {
  const det = el('details', 'leaf'), sum = el('summary', '', label || folder.split('/').pop()), sign = kindIcon(kindOf(folder));
  sum.prepend(sign);
  if (['docs', 'audio', 'mixed', 'pics'].includes(kindOf(folder))) coverInto(sign, () => folderCoverUrl(folder));   // books, albums, and whatever else has a picture to show
  sum.dataset.folder = folder;
  sum.dataset.path = path;
  sum.setAttribute('role', 'button');
  const songs = media.filter((f) => isAudio(f.path)).length, shots = media.length - songs;
  sum.title = says || [shots && `${shots} picture${shots === 1 ? '' : 's'} and videos`, songs && `${songs} sound file${songs === 1 ? '' : 's'}`].filter(Boolean).join(', ') + ' in ' + folder;
  if (state.panes.some((p) => p.tabs.some((t) => inLine(sum, t)))) sum.classList.add('open');
  if (inLine(sum, activeDoc())) sum.classList.add('active');
  if (inLine(sum, music.path)) sum.classList.add('playing');
  paintQuick(sum);
  sum.onclick = (e) => { e.preventDefault(); openDoc(path, { side: e.metaKey || e.ctrlKey || e.altKey }); };   // never opens out
  sum.ondblclick = () => openDoc(path, { keep: true });
  sum.append(plusBtn(() => path));
  det.append(sum);
  return det;
}
// A folder's gallery, or its music page, as a line in the list of an open folder.
function galleryRow(path, label, count, what = 'pictures and videos') {
  const row = el('div', 'file');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.path = path;
  row.title = `${count} ${what} in ${folderOf(path)}`;
  if (state.panes.some((p) => p.tabs.includes(path))) row.classList.add('open');
  if (path === activeDoc()) row.classList.add('active');
  if (music.path && path === musicLine(folderOf(music.path))) row.classList.add('playing');
  row.append(el('span', 'name', label), el('small', '', count), plusBtn(() => path));
  row.onclick = (e) => openDoc(path, { side: e.metaKey || e.ctrlKey || e.altKey });
  row.ondblclick = () => openDoc(path, { keep: true });
  return row;
}
// A book is one thing to whoever reads it, whatever number of pages the server lists it as: wherever files are
// counted or chosen from, its pages are folded into one entry, { book, path (the book's own), title, pages }.
function asItems(list) {
  const out = [], seen = new Map();
  for (const d of list) {
    const at = d.path.search(/\.epub\//i);
    if (at < 0) { out.push(d); continue; }
    const book = d.path.slice(0, at + 5);
    let b = seen.get(book);
    if (!b) { b = { book, path: book, title: givenName(book).replace(/\.epub$/i, ''), pages: [] }; seen.set(book, b); out.push(b); }
    b.pages.push(d);
  }
  return out;
}
// Where a book opens: the page last read in it, or its first.
// Where a book begins for a reader: its contents, where it has a page of them, and not its cover or the pages
// before. Told by the page's name in the book ("Contents", "Table of Contents"), else by its file's ("toc",
// "contents"). Many books name neither; for those the page is looked for once, in the background (see
// learnBookStarts), and remembered. Failing that, a file named "nav" (every newer book has one, though some keep
// it out of the reading order), and failing that the first page.
// What comes before a book's text (its cover, title page, copyright page, dedication, contents and the like) is told
// apart by the document engine (its frontMatter: from the book's own landmarks and contents, its file names and its
// text). Each book is read for this once, quietly (learnBookFronts), and what is found is kept on this device:
// book -> { pages (how many it had then), roles: { page: role } }, roles null for a book the engine could not read.
// From it come where a book begins (bookStart), and a name for a leading page that has none but its file's.
const FRONT_NAMES = { cover: 'Cover', titlePage: 'Title page', copyright: 'Copyright', dedication: 'Dedication', epigraph: 'Epigraph', alsoBy: 'Also by', toc: 'Contents' };
let fronts = null;
const bookFronts = () => (fronts?.root === config.root ? fronts.books : (fronts = { root: config.root, books: store.get('bookFronts:' + config.root) || {} }).books);
const frontRole = (path) => (isBookPage(path) ? bookFronts()[bookOf(path)]?.roles?.[path] : undefined);
const pageTitle = (d) => { const named = FRONT_NAMES[frontRole(d.path)]; return named && (!d.title || d.title === d.path.split('/').pop().replace(/\.x?html?$/i, '')) ? named : d.title; };
async function learnBookFronts() {
  const known = bookFronts();
  let lib = null, learned = false;
  for (const b of asItems(docs).filter((d) => d.book)) {
    if (known[b.book]?.pages === b.pages.length || gateOf(b.book)) continue;
    if (!net.online) break;   // another time
    let engine = null;
    try {
      // A book open in the engine already (one of its pages is being read) is asked as it is.
      const open = bookOpen.get(b.book);
      if (open) {
        const roles = {}, pageOf = new Map([...open.units].map(([page, unit]) => [unit, page]));
        for (const f of await open.engine.frontMatter()) { const page = pageOf.get(f.unit); if (page) roles[page] = f.role; }
        known[b.book] = { pages: b.pages.length, roles };
        learned = true;
        store.set('bookFronts:' + config.root, known);
        continue;
      }
      lib ||= await marginalia();
      // From this hub, read in place (see bookEngine); from another, fetched whole.
      const source = hub.url ? await call(rawUrl(b.book), { quiet: true }).then((r) => (r.ok ? r.blob() : null)) : { url: rawUrl(b.book) };
      if (!source) continue;
      engine = hub.url ? new lib.Engine() : new lib.Engine(engineWorker);
      const summary = await engine.open(source, hub.url ? {} : { fingerprint: ZERO_PRINT }), roles = {};
      for (const f of await engine.frontMatter()) { const href = summary.units[f.unit]?.href; if (href) roles[b.book + '/' + href] = f.role; }
      known[b.book] = { pages: b.pages.length, roles };
    } catch (e) {
      if (!lib) return;   // no engine to be had (a server from before it had one): the older ways of finding a book's start stand
      if (!['malformed', 'unsupported', 'encrypted', 'limit_exceeded'].includes(e?.code)) continue;   // not the book's doing: tried again another time
      known[b.book] = { pages: b.pages.length, roles: null };
    } finally { engine?.close(); }
    learned = true;
    store.set('bookFronts:' + config.root, known);
  }
  if (learned) { renderTree(); views.forEach((v, i) => renderTabs(i)); chrome(); }
}
const bookStarts = () => store.get('bookStarts:' + config.root) || {};   // book -> the page found to be its contents ('' for none)
function bookStart(pages) {
  const named = (test) => pages.find((d) => test.test(d.path.split('/').pop().replace(/\.x?html?$/i, '')));
  const found = pages.length ? bookStarts()[pages[0].path.slice(0, pages[0].path.search(/\.epub\//i) + 5)] : '';
  // The engine has read this book: at the start of its front matter (its cover, title page, contents and the like,
  // which the engine tells apart), else at its first page, where its text begins.
  const roles = pages.length ? bookFronts()[bookOf(pages[0].path)]?.roles : null;
  if (roles) return pages.find((d) => roles[d.path]) || pages[0];
  return pages.find((d) => /^\s*(table\s+of\s+)?contents\s*$/i.test(d.title || '')) || named(/^(toc|contents|table[-_ ]?of[-_ ]?contents)$/i)
    || (found && pages.find((d) => d.path === found)) || named(/^nav$/i) || pages[0];
}
// A contents page that is not named as one is known by what it does: it is the page, among a book's first few,
// that leads to the most other pages of the book (four or more). Each book without a named one is looked at once,
// quietly, a page at a time, and what is found is kept on this device; nothing read for this is kept as a copy.
async function learnBookStarts() {
  const known = bookStarts();
  for (const b of asItems(docs).filter((d) => d.book)) {
    if (b.book in known || bookFronts()[b.book]?.roles || bookStart(b.pages) !== b.pages[0]) continue;
    let best = '', most = 3;
    for (const d of b.pages.slice(0, 8)) {
      if (!net.online) return;   // another time
      const text = kept.has(d.path) ? (await idb.get('docs', keyOf(d.path)))?.text
        : await call('/api/doc?path=' + encodeURIComponent(d.path), { quiet: true }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
      if (text == null) continue;
      const leads = new Set();
      for (const a of parsePage(d.path, text).querySelectorAll('a[href]')) {
        const h = a.getAttribute('href');
        if (!relOnly(h)) continue;
        try { const to = resolve(d.path, h); if (to !== d.path && inBook(b.book, to)) leads.add(to); } catch { /* not a path */ }
      }
      if (leads.size > most) { most = leads.size; best = d.path; }
    }
    known[b.book] = best;
    store.set('bookStarts:' + config.root, known);
  }
}
// Where a book opens, from wherever it is opened: the page last read in it, or where it begins (see bookStart).
const bookTarget = (b) => { const last = state.last?.[b.book]; return b.pages.some((d) => d.path === last) ? last : bookStart(b.pages)?.path; };
const hereOf = (d) => (d.book ? d.pages.every((p) => kept.has(p.path)) : kept.has(d.path));   // on this device: a book, when every page is
// A book as one line: pressing it opens the page last read in it, or its first.
// The mark at its end keeps a copy of every page on this device, or removes them.
const inBook = (book, path) => !!path && path.startsWith(book + '/');
function bookRow(book, pages) {
  const row = el('div', 'file');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.book = book;
  row.title = book.split('/').pop();
  if (state.panes.some((p) => p.tabs.some((t) => inBook(book, t)))) row.classList.add('open');
  if (inBook(book, activeDoc())) row.classList.add('active');
  const sign = kindIcon('docs');
  coverInto(sign, () => coverUrl(book));
  row.append(sign, el('span', 'name', givenName(book).replace(/\.epub$/i, '')));
  const n = notes.filter((x) => inBook(book, x.doc)).length;
  if (n) row.append(el('small', '', n));
  row.append(plusBtn(() => bookTarget({ book, pages })));
  const missing = pages.filter((d) => !kept.has(d.path) && !isPending(d.path)), here = !missing.length;
  const st = el('button', 'st ' + (here ? 'kept' : ''), here ? '●' : '○');
  st.title = here ? 'The whole book is copied to this device, so it opens without the server. Press to remove the copy.'
    : (missing.length < pages.length ? `About ${Math.max(1, Math.round(100 * (pages.length - missing.length) / pages.length))}% of this book is copied to this device. ` : 'On the server only. ') + 'Press to keep all of it.';
  st.setAttribute('aria-label', st.title);
  st.onclick = async (e) => { e.stopPropagation(); if (here) { for (const d of pages) await dropCopy(d.path); for (const p of [...kept]) if (inBook(book, p)) await dropCopy(p); } else await keepAll(row.title, missing, book); renderTree(); };   // with the pages go the pictures and styles kept for them
  row.append(st);
  const target = () => bookTarget({ book, pages });
  row.onclick = (e) => openDoc(target(), { side: e.metaKey || e.ctrlKey || e.altKey });
  row.ondblclick = () => openDoc(target(), { keep: true });
  return row;
}
// Quick open: a closed folder's line carries the document last opened inside
// it (at any depth), so that can be returned to without opening the folder.
function paintQuick(sum) {
  sum.querySelector('.quick')?.remove();
  const d = docOf(state.last?.[sum.dataset.folder]);
  if (!d || !inView(d) || gateOf(d.path) || d.path === sum.dataset.path) return;   // a one-line folder's own page is what its line opens already
  const b = el('button', 'quick', d.front || isFront(d.path) ? 'Front page' : d.title ? titleOf(d) : d.path.split('/').pop());
  b.title = 'Open what was last opened in this folder: ' + d.path;
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (isAudio(d.path) && playable(d.path)) askPlay(d.path); else openDoc(d.path); };   // not a press on the folder's line: it stays closed. A track plays, as it does from its own line
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
  // A kind's line holds folders that are found here too: the one meant is the innermost that runs off the bottom, and what follows is the first line not inside it.
  const cut = tops.findLast((d) => { const r = d.getBoundingClientRect(); return d.open && r.top < edge && r.bottom > edge + 1; });
  pinTo = cut ? tops.slice(tops.indexOf(cut) + 1).find((d) => !cut.contains(d))?.querySelector('summary') || null : null;
  nextPin.hidden = !pinTo;
  if (pinTo) nextPin.textContent = '↓ ' + (pinTo.dataset.folder?.split('/').pop() || pinTo.dataset.name || pinTo.firstChild.textContent);
}
nextPin.hidden = true;
nextPin.onclick = () => { if (pinTo) { treeEl.scrollTop += pinTo.getBoundingClientRect().top - treeEl.getBoundingClientRect().top; pinNext(); } };
const askPin = () => { if (!pinAsked) pinAsked = requestAnimationFrame(() => { pinAsked = 0; pinNext(); }); };
treeEl.addEventListener('scroll', askPin, { passive: true });
addEventListener('resize', askPin);

// Pressing a file's line, in the list or among what was found (see fileRow for why a sound file differs).
function pressFile(path, e) {
  const mod = e.metaKey || e.ctrlKey || e.altKey;
  return isAudio(path) && !mod ? (playable(path) ? askPlay(path) : openDoc(path)) : openDoc(path, { side: mod });
}
// The + on a line of the list: opens it in a tab of its own, alongside what is already open. On a folder's line
// that is the folder's page (its front page, or else the one made for it), and the line neither opens out nor closes for it.
function plusBtn(target) {
  const plus = el('button', 'plus', '+');
  plus.title = 'Open alongside what is already open';
  plus.setAttribute('aria-label', 'Open alongside what is already open');
  plus.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openDoc(target(), { keep: true }); };
  return plus;
}
function fileRow(d, label) {
  const row = el('div', 'file');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.path = d.path;
  row.title = d.title;
  if (state.panes.some((p) => p.tabs.includes(d.path))) row.classList.add('open');
  if (d.path === activeDoc()) row.classList.add('active');
  row.append(el('span', 'name', label || showName(d.path)));
  const n = notes.filter((x) => x.doc === d.path).length;
  if (n) row.append(el('small', '', n));
  row.append(plusBtn(() => d.path));
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
  row.onclick = (e) => pressFile(d.path, e);
  row.ondblclick = () => openDoc(d.path, { keep: true });
  if ((plays && d.path === music.path) || (music.path && isFront(d.path) && folderOf(music.path) && d.path === musicLine(folderOf(music.path)))) row.classList.add('playing');
  return row;
}

// ---- panes and tabs ---------------------------------------------------------
// Open a document. A plain open takes the place of the tab being looked at, so
// the tabs do not pile up: what was there is one press of back away. Only `keep`
// (a double click, or the "+" on a file's line) adds a tab beside the others.
// A document that already has a tab is gone to there, never opened twice.
// `side` puts it in the right-hand pane, splitting if needed.
// Back: each pane remembers the places it has been, so the back button in its
// tab bar returns to them: the document before (a gallery after a picture, the
// page a link was followed from), or the section of this one that a link or the
// outline jumped away from. A place is a document, the section the reader was
// in, and how far down. Each document keeps at most two places in this history,
// the first one and the latest: moving about inside a document, or coming back
// to it later, replaces its latest place rather than adding another, so back
// crosses documents instead of walking through every section of one, and the
// 50 places reach further back. Kept for this visit only. With nothing left to
// return to, back goes up a level instead: to the front page of the folder the
// document is in, then the folder above, ending at the main front page.
const trail = [[], []];
function paneSpot(pane) {
  const v = views[pane], path = state.panes[pane]?.active;
  if (!path) return null;
  return { path, slug: v?.cur?.dataset?.slug || '', head: v?.cur?.textContent || '', y: v?.scroller ? v.scroller.scrollTop : null };
}
function leave(pane) {
  const at = paneSpot(pane), t = trail[pane] || (trail[pane] = []);
  if (!at) return;
  const last = t[t.length - 1];
  if (last && last.path === at.path && last.slug === at.slug) { last.y = at.y; return; }
  t.push(at);
  const mine = t.filter((x) => x.path === at.path);
  if (mine.length > 2) t.splice(t.indexOf(mine[1]), 1); // keep the first and this, the latest
  if (t.length > 50) t.shift();
}
// A jump inside the open document (a link to a heading, the outline, a note's
// place) is remembered, so back returns to where the reader was.
function jumpTo(pane, slug) {
  leave(pane);
  goTo(pane, slug);
  renderTabs(pane);
}
function upFrom(path) {
  if (!path) return null;
  let folder = folderOf(path);
  // A folder's own page (its front page, or the one made for it: an album's, a set's) goes up from the folder above.
  if (isFront(path) || docOf(path)?.gallery) { if (!folder) return null; folder = folderOf(folder); }
  for (;;) {
    const front = folder ? pageOf(folder) : config.front;
    if (front && front !== path && docOf(front)) return front;
    if (!folder) return null;
    folder = folderOf(folder);
  }
}
// Where back goes: the last place that still exists and is not where the
// reader is now. Only looks: right after a jump the section being read is not
// updated yet (that follows the scroll), so nothing may be removed on that basis.
function backTo(pane) {
  const t = trail[pane] || [], now = paneSpot(pane);
  for (let i = t.length - 1; i >= 0; i--) {
    const x = t[i];
    if (docOf(x.path) && !(now && x.path === now.path && x.slug === now.slug && x.y === now.y)) return x;
  }
  const up = upFrom(state.panes[pane].active);
  return up ? { path: up, slug: '', head: '', y: null } : null;
}
async function goBack(pane = state.active) {
  const to = backTo(pane), t = trail[pane] || [];
  if (!to) return;
  const at = t.lastIndexOf(to);
  if (at >= 0) t.splice(at); // it, and anything after it that was skipped
  if (to.path === state.panes[pane].active) { // a section of this document
    const v = views[pane];
    if (to.y != null && v.scroller) v.scroller.scrollTop = to.y; else if (to.slug) goTo(pane, to.slug);
    renderTabs(pane);
    return;
  }
  if (to.y != null) scrollMem.set(pane + ':' + to.path, to.y);
  await openDoc(to.path, { pane, back: true, hash: to.y == null && to.slug ? to.slug : undefined });
}
document.addEventListener('keydown', (e) => { if (e.altKey && e.key === 'ArrowLeft' && !e.target.matches?.('input, textarea, [contenteditable]')) { e.preventDefault(); goBack(); } });

async function openDoc(path, { pane = state.active, side = false, hash, keep = false, back = false } = {}) {
  if (!docOf(path)) return;
  if (phone.matches) { side = false; keep ||= adding; drawer(null); }   // one document at a time on a phone; after the tab bar's +, in a tab of its own
  // A document is open in one tab at most. What is open already is gone to, however it is asked for (a press, the +
  // for a tab of its own, "side"), and never opened again in place of another tab: in whichever pane has it (on a
  // computer; a phone shows one pane). A book is one document: a page of a book that has a tab is turned to in that tab.
  // Going back is taken as asked, within its own pane.
  let into = -1;   // the tab of the same book, in `pane`, that the page goes into
  const twice = keep;   // a tab of its own was asked for: the second press of a double click (see below)
  if (!back) {
    const panes = phone.matches ? [pane] : [pane, ...state.panes.keys()].filter((i, n, all) => all.indexOf(i) === n);
    const has = panes.find((i) => state.panes[i]?.tabs.includes(path));
    if (has != null) { pane = has; side = keep = false; }
    else if (isBookPage(path)) {
      const book = bookOf(path);
      for (const i of panes) {
        const at = state.panes[i]?.tabs.findIndex((t) => inBook(book, t)) ?? -1;
        if (at >= 0) { pane = i; into = at; side = keep = false; break; }
      }
    }
  }
  let rebuilt = false;
  if (side) {
    if (state.panes.length < 2) { state.panes.push({ tabs: [], active: null }); rebuilt = true; pane = 1; }
    else pane = pane === 0 ? 1 : 0;
  }
  const p = state.panes[pane];
  remember(pane);
  if (!p.tabs.includes(path)) {
    const at = keep ? -1 : into >= 0 ? into : p.tabs.indexOf(p.active);
    if (at >= 0) { p.bumped = { path: p.tabs[at], by: path, at: Date.now() }; scrollMem.delete(pane + ':' + p.tabs[at]); p.tabs[at] = path; } else p.tabs.push(path);
  } else if (twice) {
    // A double click arrives as click + click: the first click has already
    // taken the place of the tab that was open, so put that one back beside the new one.
    const b = p.bumped;
    if (b && b.by === path && Date.now() - b.at < 800 && docOf(b.path) && !p.tabs.includes(b.path)) p.tabs.splice(p.tabs.indexOf(path), 0, b.path);
    p.bumped = null;
  }
  if (!back && (p.active !== path || hash)) leave(pane);
  state.recent = [...new Set([path, p.active, ...(state.recent || [])])].filter(Boolean).slice(0, 12);   // the latest opened (and what was left for it), for the list beside back
  for (let f = folderOf(path); f; f = folderOf(f)) (state.last ||= {})[f] = path;   // the last opened in each folder it is in: the folder's quick open
  p.active = path;
  state.active = pane;
  if (rebuilt) await buildPanes(); else { renderTabs(pane); await showDoc(pane, hash); }
  if (rebuilt && hash) goTo(pane, hash);
  if (keep && phone.matches) views[pane].tabsEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });   // the tab just added, where it can be seen
  chrome();
}

async function closeTab(pane, path) {
  const p = state.panes[pane];
  const at = p.tabs.indexOf(path);
  p.tabs.splice(at, 1);
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
    if (!p.tabs.length && config.front) { p.tabs.push(config.front); p.active = config.front; }
    renderTabs(pane);
    await showDoc(pane);
  }
  chrome();
}

function remember(pane) {
  const v = views[pane], path = state.panes[pane]?.active;
  if (v?.scroller && path) { scrollMem.set(pane + ':' + path, v.scroller.scrollTop); keepPlace(path, v.place ? v.place() : v.scroller.scrollTop); }
}
// Where each document was left, kept on this device per workspace, so a
// document opens where you stopped reading, also after the reader is closed.
// A page of text, a page of a book and a folder's page are kept as how far down they were scrolled. A PDF is kept
// as its page and how far down that page ("p12.370"): its pages are as wide as the screen, so a distance scrolled
// on one screen is another place on the next.
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
  if (typeof top === 'string') all[path] = top;
  else if (top > 40) all[path] = Math.round(top);
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

// The keep mark on the tab of what is being read: a copy on this device, made or removed from there. A page of a
// book stands for the book: the mark keeps all of it, and is filled only when all of it is here.
function tabKeepBtn(path) {
  if (!isBookPage(path)) return keepBtn(path);
  const book = path.slice(0, path.search(/\.epub\//i) + 5), pages = docs.filter((d) => inBook(book, d.path));
  const missing = pages.filter((d) => !kept.has(d.path) && !isPending(d.path)), here = !missing.length, b = el('button', 'ic keepB' + (here ? ' kept' : ''));
  setIcon(b, here ? 'kept' : 'keep', here ? 'The whole book is on this device. Press to remove the copy.' : 'Keep the whole book on this device, to read without the server');
  b.disabled = !here && (!net.online || !!keeping);
  b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    if (here) { for (const d of pages) await dropCopy(d.path); for (const p of [...kept]) if (inBook(book, p)) await dropCopy(p); }
    else await keepAll(givenName(book).replace(/\.epub$/i, ''), missing, book);
    views.forEach((_, i) => renderTabs(i));
  };
  return b;
}
const tabName = (path) => { const d = docOf(path); return gateOf(path) ? gateOf(path).split('/').pop() + ' (locked)' : d ? (d.front ? 'Front page' : isFront(path) ? d.title + ' (front page)' : titleOf(d)) : path; };
// The latest opened, newest first, as a list dropped from the tab bar: a tab is taken over by whatever is opened
// next, so this is the way back to something from a while ago. Pressing one opens it in the place of the tab being looked at.
const recentEl = el('div', 'recent');
recentEl.hidden = true;
document.body.append(recentEl);
const hideRecent = () => { recentEl.hidden = true; };
function showRecent(pane, from) {
  const list = (state.recent || []).filter((x) => docOf(x) && x !== state.panes[pane]?.active).slice(0, 11);
  recentEl.replaceChildren(el('small', '', list.length ? 'Latest opened' : 'Nothing opened before this yet'));
  for (const path of list) {
    const b = el('button', '', tabName(path)), where = folderOf(path.replace(/\/$/, ''));
    b.title = path;
    if (where) b.append(el('small', '', where.split('/').slice(-2).join(' / ')));
    b.onclick = () => { hideRecent(); openDoc(path, { pane }); };
    recentEl.append(b);
  }
  recentEl.hidden = false;
  const r = from.getBoundingClientRect();
  recentEl.style.left = Math.max(8, Math.min(r.left, innerWidth - recentEl.offsetWidth - 8)) + 'px';
  recentEl.style.top = r.bottom + 2 + 'px';
  recentEl.style.maxHeight = Math.max(120, innerHeight - r.bottom - 16) + 'px';
}
addEventListener('pointerdown', (e) => { if (!recentEl.hidden && !recentEl.contains(e.target) && !e.target.closest?.('.tabs > .back, .tabs > .recentB')) hideRecent(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') hideRecent(); });
function renderTabs(pane) {
  const p = state.panes[pane], bar = views[pane].tabsEl;
  bar.innerHTML = '';
  const back = el('button', 'back keep', '‹');
  const to = backTo(pane);
  back.title = to ? `Back to ${docOf(to.path)?.title || to.path}${to.head && to.path !== p.active ? ' › ' + to.head : to.head ? ': ' + to.head : ''} (Alt + ←)` : 'Back';
  back.setAttribute('aria-label', 'Back');
  back.disabled = !to;
  // Held down (or pressed with the other button), back lists the latest opened; so does the mark beside it.
  let held = 0, listed = false;
  back.onpointerdown = () => { listed = false; held = setTimeout(() => { listed = true; showRecent(pane, back); }, 500); };
  back.onpointerup = back.onpointerleave = back.onpointercancel = () => clearTimeout(held);
  back.oncontextmenu = (e) => { e.preventDefault(); clearTimeout(held); listed = true; showRecent(pane, back); };
  back.onclick = () => { if (listed) listed = false; else goBack(pane); };
  const more = el('button', 'recentB keep', '▾');
  more.title = 'The latest opened (also: hold back down)';
  more.setAttribute('aria-label', 'The latest opened');
  more.onclick = () => (recentEl.hidden ? showRecent(pane, more) : hideRecent());
  bar.append(back, more);
  for (const path of p.tabs) {
    const d = docOf(path);
    const tab = el('div', 'tab' + (path === p.active ? ' active' : ''));
    tab.tabIndex = 0;
    tab.setAttribute('role', 'button');
    tab.title = path;
    // A book's or a PDF's tab carries its cover before its name.
    const cover = d && !gateOf(path) ? coverKeyOf(path) : null;
    if (cover) {
      const pic = el('img', 'tabCover');
      pic.alt = '';
      pic.hidden = true;
      pic.onload = () => { pic.hidden = false; };
      coverUrl(cover).then((u) => { if (u) pic.src = u; });
      tab.append(pic);
    }
    tab.append(el('span', '', tabName(path)));
    // A PDF being read says its page on its tab (on a phone, where its own bar is put away): the name gives way for it.
    if (path === p.active && isPdf(path)) { tab.classList.add('paged'); tab.append(el('small', 'tabWhere', views[pane].where?.path === path ? views[pane].where.text : '')); }
    // What is being read can be kept on this device from its tab (a file, not a folder's page or one that is locked or still waiting to be sent).
    if (path === p.active && d && !d.gallery && !gateOf(path) && !isPending(path) && canKeep(path)) tab.append(tabKeepBtn(path));
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
  // On a phone, at the end of the bar: the list of files, to open one more from (see addTab).
  const add = el('button', 'newTab keep', '+');
  add.title = 'Open another page, beside these';
  add.setAttribute('aria-label', 'Open another page in a new tab');
  add.onclick = addTab;
  bar.append(add);
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

// A book is read through by scrolling: at the end of a page, scrolling on turns to the next, and at the top,
// scrolling back turns to the one before (which opens at its end). Each page is still a page of its own, with
// its own progress bar. "scroll through books" in the settings turns this off; the arrows stay either way.
// A turn takes a deliberate push: a scroll that only arrives at the end, and what is left of its momentum, turns
// nothing. The wheel has to stop there and then go on (a touch: a drag of its own that starts at the end).
let landAt = null;   // { path, end }: where the page just turned to should open
function scrollTurns(frame, d) {
  const w = frame.contentWindow, PUSH = 220, DRAG = 80;
  const atEnd = () => w.scrollY + w.innerHeight >= d.documentElement.scrollHeight - 2, atTop = () => w.scrollY <= 0;
  const hint = () => { if (frame.hint) frame.hint.hidden = !(view.scrollTurn && frame.next && atEnd()); };
  let armed = false, pushed = 0, lastWheel = 0;
  d.addEventListener('wheel', (e) => {
    const now = performance.now(), gap = now - lastWheel, dir = e.deltaY > 0 && atEnd() ? 1 : e.deltaY < 0 && atTop() ? -1 : 0;
    lastWheel = now;
    if (!view.scrollTurn || e.ctrlKey || !dir) { armed = false; pushed = 0; return; }
    if (!armed) { if (gap < 180) return; armed = true; pushed = 0; }   // still the scroll that got here
    if (Math.sign(pushed) !== dir) pushed = 0;
    pushed += e.deltaY * (e.deltaMode === 1 ? 32 : 1);
    if (Math.abs(pushed) >= PUSH) { armed = false; pushed = 0; frame.turn(dir); }
  }, { passive: true });
  // By touch, a push past the end shows in three ways, and any one of them turns the page (phones differ in which
  // they give): the finger moving on while the page is at its end; the finger lifted further up than it came down,
  // for a browser that tells of the move late or not at all; and the page itself pulled past its end, which an
  // iPhone does and reports as a scroll beyond the last line.
  let from = null;   // a touch that began at the end, or at the top: { y, end, top }
  const touchPush = (y) => {
    if (!from || !view.scrollTurn) return;
    const up = from.y - y, dir = from.end && up > DRAG ? 1 : from.top && up < -DRAG ? -1 : 0;
    if (dir) { from = null; frame.turn(dir); }
  };
  d.addEventListener('touchstart', (e) => { from = e.touches.length === 1 ? { y: e.touches[0].clientY, end: atEnd(), top: atTop() } : null; }, { passive: true });
  d.addEventListener('touchmove', (e) => { if (e.touches.length === 1) touchPush(e.touches[0].clientY); }, { passive: true });
  d.addEventListener('touchend', (e) => { if (e.changedTouches.length) touchPush(e.changedTouches[0].clientY); from = null; }, { passive: true });
  d.addEventListener('touchcancel', () => { from = null; }, { passive: true });
  let pulled = 0;   // when the page was last turned by being pulled past its end: once a pull
  w.addEventListener('scroll', () => {
    if (!view.scrollTurn || !touch.matches || performance.now() - pulled < 1500) return;
    const over = w.scrollY - (d.documentElement.scrollHeight - w.innerHeight);
    if (over > 50) { pulled = performance.now(); frame.turn(1); } else if (w.scrollY < -50) { pulled = performance.now(); frame.turn(-1); }
  }, { passive: true });
  d.addEventListener('keydown', (e) => {
    if (!view.scrollTurn || e.altKey || e.ctrlKey || e.metaKey) return;
    if ((e.key === ' ' && !e.shiftKey || e.key === 'PageDown' || e.key === 'ArrowDown') && atEnd()) { e.preventDefault(); frame.turn(1); }
    else if ((e.key === ' ' && e.shiftKey || e.key === 'PageUp' || e.key === 'ArrowUp') && atTop()) { e.preventDefault(); frame.turn(-1); }
  });
  w.addEventListener('scroll', hint, { passive: true });
  hint();
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
  for (const u of v.urls || []) URL.revokeObjectURL(u);   // the pictures of a book's page drawn from the engine
  Object.assign(v, { heads: [], cur: null, article: null, surface: null, scroller: null, frame: null, dress: null, bookHere: null, place: null, pdfMarks: null, zoom: null, urls: null });
  sweepBooks();
  if (!path) { v.body.replaceChildren(el('p', 'empty', 'Nothing open. Pick a file on the left.')); return; }
  if (gateOf(path)) { showLock(pane, gateOf(path)); return; }

  if (docOf(path)?.gallery) { showGallery(pane, path); return; }
  if (isAudio(path)) { showPlayer(pane, path); return; }
  if (docOf(path)?.links) { showLinks(pane, path, hash); return; }
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
    // A page of a book: drawn from the engine where it can be (see bookChapter), else as the server sends it.
    const chapter = isBookPage(path) && net.online && !isPending(path) && !hub.url ? await bookChapter(path) : null;
    if (views[pane] !== v || state.panes[pane].active !== path) { for (const u of chapter?.urls || []) URL.revokeObjectURL(u); return; }   // changed while loading
    if (chapter) {
      v.urls = chapter.urls;
      frame.chapter = chapter;
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
      if (keepsItself(path)) call(rawUrl(path)).then((r) => (r.ok ? r.text() : null)).then((t) => t != null && rememberDoc(path, t)).catch(() => {});   // the copy kept for reading offline is the server's
    } else if (net.online && !isPending(path) && !hub.url) {
      frame.src = rawUrl(path);
      if (keepsItself(path)) call(rawUrl(path)).then((r) => (r.ok ? r.text() : null)).then((t) => t != null && rememberDoc(path, t)).catch(() => {});   // a kept copy is brought up to date
    } else {
      // No server: show the copy kept on this device, if there is one.
      const copy = await docText(path);
      if (copy == null) { v.body.replaceChildren(el('p', 'empty', 'The server is not reachable, and no copy of this page was kept on this device.')); return; }
      frame.srcdoc = app ? copy : await pageFromCopy(path, copy);   // with its styles and pictures, from this device
    }
    frame.onload = () => {
      if (app) { v.heads = []; v.surface = null; if (pane === state.active) { renderOutline(); renderContext(); } return; }
      try {
        const d = frame.contentDocument, used = new Set();
        if (frame.chapter) fillChapter(d, frame.chapter);
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
        if (isBookPage(path)) {
          v.dress = d.createElement('style');
          d.head.append(v.dress);
          dressBook(v);
          d.addEventListener('pointermove', (e) => frameHere(v, e.target), { passive: true });   // focus: the block under the pointer
        }
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
          // A link in a page drawn from the engine: to a place in the book, or elsewhere (http, https or mailto only: the engine checked).
          const link = frame.chapter && e.target.closest?.('[data-mg-href], [data-mg-external]');
          if (link) {
            e.preventDefault();
            const out = link.getAttribute('data-mg-external');
            if (out) { window.open(out, '_blank', 'noopener,noreferrer'); return; }
            const [file, frag = ''] = link.getAttribute('data-mg-href').split('#');
            let id = frag;
            try { id = decodeURIComponent(frag); } catch { /* as written */ }
            const to = bookOf(path) + '/' + file;
            if (to === path) { if (id) d.getElementById(id)?.scrollIntoView(); }
            else if (docOf(to)) openDoc(to, { pane, hash: id, side: e.metaKey || e.ctrlKey || e.altKey });
            return;
          }
          // Links never take the frame somewhere else. Another document in the
          // folder opens in the reader; anything on another site opens in a new
          // browser tab, outside the hub.
          const a = e.target.closest?.('a[href], area[href]');
          if (!a) return;
          // Shown from a copy, the page has no address of its own: a place in it is gone to by hand.
          const own = a.getAttribute('href') || '';
          if (frame.srcdoc && own.startsWith('#')) {
            e.preventDefault();
            let id = own.slice(1);
            try { id = decodeURIComponent(id); } catch { /* as written */ }
            (d.getElementById(id) || d.getElementsByName(id)[0])?.scrollIntoView();
            return;
          }
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
        // Some EPUBs scroll a container inside the page. Those scroll events do not bubble to the window.
        d.addEventListener('scroll', follow, { capture: true, passive: true });
        frame.contentWindow.addEventListener('scroll', () => { follow(); hideFlyout(); keepPlace(path, frame.contentWindow.scrollY); }, { passive: true });
        highlightAll(v.surface, path);
        if (isBookPage(path)) placeBookMarks(v.surface, path);   // the engine is fetched now, so that it is there by the time words are selected
        // Turned to by scrolling: the next page begins at its top, the one before at its end, wherever it was left.
        if (landAt?.path === path) { frame.contentWindow.scrollTo(0, landAt.end ? d.documentElement.scrollHeight : 0); landAt = null; }
        else if (hash) goTo(pane, hash);
        else if (placesOf()[path]) frame.contentWindow.scrollTo(0, placesOf()[path]);
        if (frame.turn) scrollTurns(frame, d);
        track(pane);
      } catch {
        // The frame has left for another site (a redirect or a script, not a click).
        // Bring the saved page back; if it leaves again, stop and say so.
        v.heads = [];
        v.surface = null;
        frame.chapter = null;
        if (!bounced && !hub.url) { bounced = true; frame.removeAttribute('srcdoc'); frame.src = rawUrl(path); }
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
      // By scrolling (see scrollTurns): the same turn, and where the page turned to opens.
      frame.turn = (dir) => { if (at < 0 || !pages[at + dir]) return; landAt = { path: pages[at + dir].path, end: dir < 0 }; frame.step(dir); };
      frame.next = pages[at + 1] || null;
      wrap.append(frame);
      // The text is a column 40 letters' heights wide in the middle of the pane (see dressBook): the cover goes against its right side.
      addPageCover(wrap, book, () => 40 * view.fs + 190, true);
      if (frame.next) {
        // At the end of the page: what scrolling on leads to.
        frame.hint = el('button', 'turnHint', '\u2193 ' + pageTitle(frame.next));
        frame.hint.title = 'Scroll on, or press, for the next part of the book';
        frame.hint.hidden = true;
        frame.hint.onclick = () => frame.turn(1);
        wrap.append(frame.hint);
      }
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
  if (docOf(path)?.front) { scroller.classList.add('has-latest'); scroller.append(el('aside', 'latest where'), el('aside', 'latest'), el('aside', 'latest favs')); }
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
    if (src && !/^([a-z]+:|\/)/i.test(src)) { m.dataset.path = resolve(path, src); m.removeAttribute('src'); mediaSrc(m.dataset.path).then((u) => { if (u) m.src = u; }); }   // the copy on this device, if there is one
    if (m.tagName === 'VIDEO') { m.controls = true; m.playsInline = true; m.preload = 'metadata'; }
  }
  colourCode(article);
  hideAnswers(article);
  labelTables(article);
  if (docOf(path)?.front) { appendSearches(article); appendTags(article); }
  // Under a front page: for the workspace's own, everything in it by kind; for a folder's, what the folder is (see folderBody).
  if (isFront(path)) {
    if (folderOf(path)) { folderBody(article, pane, folderOf(path), frontTile(folderOf(path))); addCrumbs(article, pane, folderOf(path), path); }
    else { addLibrary(article, pane); appendBrowse(article, pane, '', frontTile('')); }
    ensureSlider(article);
  }
  if (isFront(path)) {
    // Editing is a pencil at the end of the description (beside the title, if there is none), not a button of its own.
    const acts = el('div', 'editFront'), b = el('button', 'ic editPen'), folder = folderOf(path);
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
    b.title = 'Edit this front page: its title and description';
    b.setAttribute('aria-label', b.title);
    b.onclick = () => editFront(pane, md, folder);
    // A folder's own front page can also lock the folder, or take it out of the workspace.
    if (folder) acts.append(...folderActs(folder));
    const h1 = article.querySelector('h1'), after = h1?.nextElementSibling?.classList.contains('tiles') ? h1.nextElementSibling.nextElementSibling : h1?.nextElementSibling, says = after?.tagName === 'P' ? after : null;   // a folder's small tiles sit between the title and the description
    if (says || h1) (says || h1).append(b); else acts.append(b);
    if (acts.children.length) article.append(acts);   // under everything: these are for now and then
    if (folder) addLockTop(article, folder);
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
// Move a line of the queue: one place up or down (-1, 1), or to its top or its bottom. What is playing goes on playing.
function moveQueue(path, to) {
  const at = queue.indexOf(path), end = queue.length - 1;
  const put = to === 'top' ? 0 : to === 'bottom' ? end : Math.min(end, Math.max(0, at + to));
  if (at < 0 || put === at) return;
  const list = queue.filter((p) => p !== path);
  list.splice(put, 0, path);
  queue = list;
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
  up: '<path d="M12 7l7 9H5z"/>',
  down: '<path d="M12 17l-7-9h14z"/>',
  top: '<path d="M5 4h14v2.5H5zM12 9l7 9H5z"/>',
  bottom: '<path d="M5 17.5h14V20H5zM12 15L5 6h14z"/>',
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
  if (start) {
    player.play().catch(() => {});
    // The last thing opened in each folder it is in: the folder's quick open.
    for (let f = folderOf(path); f; f = folderOf(f)) (state.last ||= {})[f] = path;
    save();
    for (const sum of treeEl.querySelectorAll('summary[data-folder]')) paintQuick(sum);
  }
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: path.split('/').pop(), album: path.split('/').slice(0, -1).join(' / ') });
  renderPlayers();
}
// Next, or previous. "Previous" first goes back to the start of the track; a
// second press within three seconds goes to the track before.
// What next and previous step through: the queue, or every sound file if nothing is queued.
const playList = () => (queue.length ? queue : tracks().map((t) => t.path)).filter((p) => docOf(p) && playable(p));
const playPath = (path) => (isVideo(path) ? playVideo(path) : playTrack(path));
// A press on a track's line (in the list, the queue, a folder's page) while something is playing asks first: a line
// is easily pressed by accident, on a phone above all, and what was playing is then lost with its place. Nothing
// playing, or paused: it plays at once. The player's own buttons (next, previous) and the end of a track never ask.
const askEl = el('div', 'ask');
askEl.hidden = true;
document.body.append(askEl);
const closeAsk = () => { askEl.hidden = true; askEl.replaceChildren(); };
askEl.onclick = (e) => { if (e.target === askEl) closeAsk(); };
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !askEl.hidden) closeAsk(); });
function askPlay(path) {
  const now = nowPath(), media = nowEl();
  if (!now || !docOf(now) || media.paused || media.ended) return playPath(path);
  const box = el('div'), row = el('div', 'row'), same = now === path;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', same ? 'Start this again?' : 'Play this instead?');
  const said = el('p', '', 'Playing: ');
  said.append(el('b', '', showName(now)));
  const ask = el('p', '', same ? 'Start it again from the beginning?' : 'Play this instead? ');
  if (!same) ask.append(el('b', '', showName(path)));
  const stay = el('button', '', 'Keep playing'), go = el('button', 'main', same ? 'Start again' : 'Play instead');
  stay.onclick = closeAsk;
  go.onclick = () => { closeAsk(); playPath(path); };
  row.append(stay);
  if (!same && !queue.includes(path)) {
    const later = el('button', '', 'Add to queue');
    later.onclick = () => { closeAsk(); toggleQueue(path); };
    row.append(later);
  }
  row.append(go);
  box.append(said, ask, row);
  askEl.replaceChildren(box);
  askEl.hidden = false;
  stay.focus();   // Enter, or a second press in the same spot, changes nothing
}
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
    row.append(el('span', '', showName(p)));
    if (where) row.append(isVideo(p) ? el('small', '', 'video') : pathLabel(p.split('/').slice(0, -1).join(' / ') || 'top level'));
    // Its place in the queue: to the top, one up, one down, to the bottom.
    const moves = el('div', 'mvs'), first = p === queue[0], last = p === queue[queue.length - 1];
    for (const [icon, label, to, off] of [['top', 'To the top of the queue', 'top', first], ['up', 'One place up', -1, first], ['down', 'One place down', 1, last], ['bottom', 'To the bottom of the queue', 'bottom', last]]) {
      const b = iconBtn(icon, label, 'q mv');
      b.disabled = off;
      b.onclick = (e) => { e.stopPropagation(); moveQueue(p, to); };
      moves.append(b);
    }
    row.append(moves);
    const out = iconBtn('remove', 'Take out of the queue', 'q');
    out.onclick = (e) => { e.stopPropagation(); toggleQueue(p); };
    if (docOf(p) && canKeep(p)) row.append(keepBtn(p));   // keep a copy of it on this device, or remove the copy
    row.append(out);
    row.onclick = () => ok && askPlay(p);
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
      row.onclick = () => ok && askPlay(t.path);
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
    if (canKeep(music.path)) row.append(keepBtn(music.path));   // what is playing, kept on this device
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
  for (const row of treeEl.querySelectorAll('.playing')) row.classList.remove('playing');
  if (music.path) for (const sum of treeEl.querySelectorAll('.leaf > summary')) if (inLine(sum, music.path)) sum.classList.add('playing');
  // A track that has no line of its own is marked on its folder's music line.
  if (music.path) for (const row of treeEl.querySelectorAll('.file')) if (row.dataset.path === music.path || (folderOf(music.path) && row.dataset.path === musicLine(folderOf(music.path)))) row.classList.add('playing');
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
  const open = el('a', '', 'open');
  open.append(el('i', '', ' in new tab'));   // dropped in a phone's lightbox, where the bar has no room for it
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
      unpinch(stage);   // a pinch is let go: the two sizes are the picture's own and the window's
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
// A PDF's pages are drawn by the reader itself, with PDF.js (see drawPdf):
// drawn here, words on a page can be selected, highlighted and written about,
// as in any other document. "reader" in the bar hands the PDF to the browser's
// own PDF viewer, in a frame, and back; it stays as chosen. In a frame nothing
// can be highlighted, and a phone's browser has no viewer for one (an iPhone
// or iPad draws the first page only, as a picture; Android's draws nothing).
// A PDF's pages are fixed drawings. Drawn here, "theme" in the bar gives them
// the pane's theme all the same: the paper is recoloured to the theme's paper
// and the ink to its ink, and the pictures are left as they are (the document
// engine says where they are). Off, the PDF is as it was made. It is on under
// a dark theme and off under a light one until the button is pressed; after
// that it stays as chosen, for every PDF on this device. Until the engine has
// the file, a dark theme's pages are turned inside out instead, pictures and all.
// In a frame the pages cannot be recoloured: the button there is "night", which
// turns the colours inside out, and is kept apart from "theme".
// Without the server (or for another hub's file, which a frame may not be
// given), the copy kept on this device is drawn the same way, read from the
// device a piece at a time: PDF.js itself is among what the service worker
// keeps (sw.js), so that needs no server either.
// The document engine (marginalia-engine: Rust as WebAssembly, in a worker of its own) reads a PDF's text with a box
// for every character, and makes the anchor a highlight is found again by. With it come the selection that is drawn
// here (double-press a word, drag its two handles), the layer highlights are drawn in, and the recolouring of pages.
// Fetched the first time a PDF is drawn here; without it a PDF is still drawn, and nothing on it can be selected.
let mgLib = null;
const marginalia = () => (mgLib ||= Promise.all(['index', 'selection', 'themes'].map((m) => import(`/vendor/marginalia/${m}.js`))).then((parts) => {
  const css = el('link');
  css.rel = 'stylesheet';
  css.href = '/vendor/marginalia/ui.css';
  document.head.append(css);
  return Object.assign({}, ...parts);
}).catch((e) => { mgLib = null; throw e; }));
// A PDF's file, for the engine, which reads it in place: the copy kept on this device, or the whole file from the server.
const pdfBlob = async (path) => (kept.has(path) ? (await idb.get('docs', keyOf(path)))?.blob : null) || call(rawUrl(path)).then((r) => (r.ok ? r.blob() : null));
// The file's SHA-256 is what the engine knows it by. Working it out reads the whole file, so it is remembered.
const mgPrints = () => store.get('mgPrints:' + config.root) || {};
// A book (an .epub) is opened in the engine while one of its pages is open. From this hub the engine reads it from the
// server a piece at a time (js/engine-worker.js): the end of the zip and its directory, then each chapter as it is
// drawn, never the whole file. A page of the book is then drawn from the engine (bookChapter): rebuilt from what is
// allowed, its text the engine's own letter for letter, so each highlight is placed by the engine's anchor (kept on
// the note as `mg`, beside the reader's own `anchor`): by the words and those around them, and their place in the
// chapter and in the book's own structure. So a highlight is still found when the book's text has changed a little,
// and means the same to anything else that reads the engine's anchors. With no engine (no server in reach, or a server
// from before it had one), a page is drawn as the server sends it and the reader's own anchor is all there is; where
// such a page's text is still the engine's (see bookSpot), new highlights get the engine's anchor all the same. From
// another hub, the book is fetched whole for the engine (the engine's own worker reads only what is in the browser).
const bookEngines = new Map();   // book -> a promise of { engine, print (a promise of the file's SHA-256, or null), units: page -> its number, texts: number -> its text }, or of null
const bookOpen = new Map();      // book -> the same, once it is there
const bookFailed = new Map();    // book -> when the engine last could not be had for it: not asked for again within the minute
// The engine's worker that also reads files on this server in pieces; the engine is opened in it with a stand-in for
// the file's SHA-256 (which it would otherwise work out by reading the whole file) and told the real one by the server.
const engineWorker = () => new Worker('/js/engine-worker.js', { type: 'module' });
const ZERO_PRINT = '0'.repeat(64);
// A file's SHA-256 as the server works it out, where the file is; remembered here with the file's size. null if it cannot be had.
async function serverPrint(path) {
  try {
    const { size, sha256 } = await api('/api/sha256?path=' + encodeURIComponent(path));
    const prints = mgPrints();
    if (prints[path]?.print !== sha256 || prints[path]?.size !== size) store.set('mgPrints:' + config.root, { ...prints, [path]: { size, print: sha256 } });
    return sha256;
  } catch { return null; }
}
function bookEngine(book) {
  if (bookEngines.has(book)) return bookEngines.get(book);
  if (Date.now() - (bookFailed.get(book) || 0) < 60000) return Promise.resolve(null);
  const opening = (async () => {
    let engine = null;
    try {
      if (!net.online) return null;
      const lib = await marginalia();
      let summary, print;
      if (!hub.url) {
        engine = new lib.Engine(engineWorker);
        summary = await engine.open({ url: rawUrl(book) }, { fingerprint: ZERO_PRINT });
        print = serverPrint(book);
      } else {
        const blob = await call(rawUrl(book), { quiet: true }).then((r) => (r.ok ? r.blob() : null));
        if (!blob || bookEngines.get(book) !== opening) return null;
        engine = new lib.Engine();
        const prints = mgPrints(), known = prints[book];
        summary = await engine.open(blob, known?.size === blob.size ? { fingerprint: known.print } : {});
        if (known?.print !== summary.info.fingerprint || known.size !== blob.size) store.set('mgPrints:' + config.root, { ...prints, [book]: { size: blob.size, print: summary.info.fingerprint } });
        print = Promise.resolve(summary.info.fingerprint);
      }
      if (bookEngines.get(book) !== opening) { engine.close(); return null; }   // the book was left meanwhile
      const rec = { engine, print, units: new Map(summary.units.map((u, i) => [book + '/' + u.href, i])), texts: new Map() };
      engine.onBroken = () => { if (bookOpen.get(book) === rec) { bookOpen.delete(book); bookEngines.delete(book); } };
      bookOpen.set(book, rec);
      return rec;
    } catch (e) {
      engine?.close();
      console.warn('The document engine did not open ' + book + ': its highlights are placed by the reader alone.', e?.code || e);
      return null;
    }
  })();
  bookEngines.set(book, opening);
  opening.then((rec) => { if (!rec && bookEngines.get(book) === opening) { bookEngines.delete(book); bookFailed.set(book, Date.now()); } });   // not had this time: asked for again later
  return opening;
}
// A book none of whose pages is being read any more is closed: the engine holds its file, and a worker, until then.
function sweepBooks() {
  for (const [book, opening] of bookEngines) {
    if (state.panes.some((p) => inBook(book, p.active))) continue;
    bookEngines.delete(book);
    bookOpen.delete(book);
    opening.then((rec) => { if (!rec) return; rec.closed = true; rec.ahead = null; rec.engine.close(); });
  }
}
// Where each piece of a page's text begins in the page's whole text, which is what the engine counts in.
// Text in <script>, <style> and <noscript> is not part of it, for the engine as for the reader's own map (VISIBLE).
function rawIndex(article) {
  const walker = article.ownerDocument.createTreeWalker(article, NodeFilter.SHOW_TEXT, VISIBLE), starts = new Map();
  let text = '', node;
  while ((node = walker.nextNode())) { starts.set(node, text.length); text += node.data; }
  return { text, starts };
}
// The engine for the page of a book that `article` is, if it is there and has the same text for it: { rec, unit, raw }.
function bookSpot(article, path) {
  const rec = isBookPage(path) ? bookOpen.get(bookOf(path)) : null, unit = rec?.units.get(path);
  if (unit == null || !rec.texts.has(unit)) return null;
  const raw = rawIndex(article);
  return raw.text === rec.texts.get(unit) ? { rec, unit, raw } : null;
}
// A page of a book as the engine makes it, for its frame: { root, sheets, urls, text }. The markup is rebuilt from
// what is allowed (no scripts, forms or frames; links and pictures named by the engine, not followed by the browser),
// with every HTML entity resolved, and its text is the engine's own. The book's style sheets come with it, and the
// pictures and fonts they name are given addresses on this device (`urls`), let go with the page (drawDoc). null where
// the engine cannot be had within a few seconds or cannot make this page: the page is then drawn as the server sends it.
async function bookChapter(path) {
  const rec = await Promise.race([bookEngine(bookOf(path)), new Promise((ok) => setTimeout(ok, 6000, null))]);
  const unit = rec?.units.get(path);
  if (unit == null) return null;
  const urls = [], made = new Map();
  try {
    // The page after the one being read is asked of the engine ahead of time (below), so turning to it does not wait on
    // the hub: on the board, reading a chapter out of the book takes a round of requests. One page is held, no more.
    const ahead = rec.ahead?.unit === unit ? await rec.ahead.cv : null;
    rec.ahead = null;
    const cv = ahead || (await rec.engine.chapter(unit));
    const parsed = new DOMParser().parseFromString(cv.html, 'application/xhtml+xml');
    if (parsed.getElementsByTagName('parsererror').length) return null;
    // A file in the book (a picture, a font), as an address here.
    const address = (file) => {
      if (!made.has(file)) made.set(file, rec.engine.resource(file).then(({ bytes, mediaType }) => { const u = URL.createObjectURL(new Blob([bytes], { type: mediaType })); urls.push(u); return u; }, () => ''));
      return made.get(file);
    };
    // The engine writes a file a style sheet names as url("mg-res:<file>"), and the page's <body> as :host, since its
    // own reader puts a page in a shadow root. Here the page is a document of its own.
    const sheet = async (css) => {
      const files = [...new Set([...css.matchAll(/mg-res:([^"')\s]+)/g)].map((m) => m[1]))];
      const at = new Map(await Promise.all(files.map(async (f) => [f, await address(f)])));
      return css.replace(/mg-res:([^"')\s]+)/g, (_, f) => at.get(f) || '').replace(/:host\(([^)]*)\)/g, 'body$1').replace(/:host\b/g, 'body');
    };
    const sheets = [];
    for (const file of cv.stylesheets) {
      try { sheets.push(await sheet(new TextDecoder().decode((await rec.engine.resource(file)).bytes))); } catch { /* a style sheet the book names and does not hold */ }
    }
    for (const css of cv.styles) sheets.push(await sheet(css));
    const root = parsed.documentElement;
    await Promise.all([...root.querySelectorAll('[data-mg-src], [data-mg-poster]')].map(async (m) => {
      const src = m.getAttribute('data-mg-src'), poster = m.getAttribute('data-mg-poster');
      if (src) { const u = await address(src); if (u) m.setAttribute(m.namespaceURI === 'http://www.w3.org/2000/svg' ? 'href' : 'src', u); }
      if (poster) { const u = await address(poster); if (u) m.setAttribute('poster', u); }
    }));
    rec.texts.set(unit, cv.text);
    if (unit + 1 < rec.units.size) setTimeout(() => { if (!rec.ahead && !rec.closed) rec.ahead = { unit: unit + 1, cv: rec.engine.chapter(unit + 1).catch(() => null) }; }, 400);
    return { root, sheets, urls, text: cv.text };
  } catch {
    for (const u of urls) URL.revokeObjectURL(u);
    return null;
  }
}
// Put a page made by bookChapter into its frame's (empty) document: the book's style sheets, then the markup.
function fillChapter(d, ch) {
  for (const css of [...ch.sheets, '[data-mg-href], [data-mg-external] { cursor: pointer; text-decoration: underline; }']) {
    const s = d.createElement('style');
    s.textContent = css;
    d.head.append(s);
  }
  d.body.replaceChildren(d.importNode(ch.root, true));
  ch.root = null;   // the frame has its own copy now
  if (rawIndex(d.body).text !== ch.text) console.warn('A page of a book does not have the engine\'s text: its highlights are placed by the reader alone.');
}
// Where the engine found each highlight of a book: note id -> { exact (the words it was asked about), at: { unit, start, end } or null }.
const mgPlaces = new Map();
const placing = new WeakSet();
const backfilled = new Set();   // highlights already given the engine's anchor, or tried, in this session
// Ask the engine where the highlights on this page of a book are; if it has anything new to say, they are drawn again.
async function placeBookMarks(article, path) {
  if (placing.has(article)) return;
  placing.add(article);
  try {
    const rec = await bookEngine(bookOf(path)), unit = rec?.units.get(path);
    if (unit == null || !article.isConnected) return;
    let news = false;
    if (!rec.texts.has(unit)) { rec.texts.set(unit, (await rec.engine.text(unit)).text); news = true; }
    for (const n of notes.filter((x) => x.doc === path && x.mg?.anchor)) {
      const exact = n.mg.anchor.quote?.exact;
      if (mgPlaces.get(n.id)?.exact === exact) continue;
      let at = null;
      try { at = await rec.engine.resolve(n.mg.anchor); } catch { /* an anchor the engine cannot read: the reader's own places it */ }
      mgPlaces.set(n.id, { exact, at });
      news = true;
    }
    // A highlight made before the engine placed highlights on books has no anchor of the engine's. While this page's
    // text is the engine's, it is given one, once, from where the reader places it, and saved like any edit.
    const old = notes.filter((x) => x.doc === path && x.quote && !x.mg?.anchor && !backfilled.has(x.id));
    const spot = old.length ? bookSpot(article, path) : null, doc = spot ? await rec.print : null;
    if (doc && article.isConnected) {
      const map = textMap(article), raw = ([node, offset]) => spot.raw.starts.get(node) + offset;
      for (const n of old) {
        backfilled.add(n.id);
        const start = placeOf(map, n, article), length = n.quote.replace(/\s+/g, '').length;
        if (start < 0 || !length) continue;
        try {
          const anchor = await rec.engine.createAnchor(unit, raw(map.at[start]), raw(map.at[start + length - 1]) + 1);
          await noteOp({ kind: 'set', id: n.id, fields: { mg: { doc, anchor } } });
        } catch { /* left with the reader's own anchor */ }
      }
    }
    if (news && article.isConnected && notes.some((x) => x.doc === path && x.mg?.anchor)) highlightAll(article, path);
  } catch { /* the engine went away meanwhile */ } finally { placing.delete(article); }
}
let pdfLib = null;   // PDF.js, fetched from the server the first time a PDF is drawn here
const pdfjs = () => (pdfLib ||= import('/vendor/pdf.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs'; return m; }).catch((e) => { pdfLib = null; throw e; }));
// The pages of a PDF, drawn by the reader: one under the other, each as wide
// as the pane (times the zoom). A page is drawn when it comes near the
// window and let go when it is far from it, so a long book costs no more
// memory than a short one; the file is fetched a piece at a time, as needed.
// Where PDF.js reads a PDF from: this server, by range requests, or (`copy`) the copy on this device, or another hub's
// file fetched whole. Either way PDF.js asks for the pieces it needs through a transport of the reader's own, so a long
// book is not read into memory whole, and what it has been handed is counted (`got.bytes`): PDF.js keeps every piece
// until the document is let go, and drawPdf opens it afresh when that count grows large. { range, size }, or { url }
// for a server that does not answer ranges (PDF.js then reads it by itself, as before).
async function pdfFrom(lib, path, copy, got = { bytes: 0 }) {
  let size, piece;
  if (!copy) {
    const r = await call(rawUrl(path), { headers: { Range: 'bytes=0-0' }, quiet: true });
    const total = /\/(\d+)\s*$/.exec(r.headers.get('Content-Range') || '');
    if (r.status !== 206 || !total) return { url: rawUrl(path) };
    size = Number(total[1]);
    // The server sends at most a few megabytes to one request: the rest of a larger piece is asked for again.
    piece = async (begin, end) => {
      const out = new Uint8Array(end - begin);
      for (let at = begin; at < end;) {
        const x = await call(rawUrl(path), { headers: { Range: `bytes=${at}-${end - 1}` }, quiet: true, wait: 60000 });
        const b = x.status === 206 ? new Uint8Array(await x.arrayBuffer()) : null;
        if (!b?.length) throw new Error('the server answered ' + x.status);
        out.set(b.subarray(0, end - at), at - begin);
        at += b.length;
      }
      return out;
    };
  } else {
    const blob = kept.has(path) ? (await idb.get('docs', keyOf(path)))?.blob : await call(rawUrl(path)).then((r) => (r.ok ? r.blob() : null));
    if (!blob) throw new Error('no copy of it was found');
    size = blob.size;
    piece = (begin, end) => blob.slice(begin, end).arrayBuffer().then((b) => new Uint8Array(b));
  }
  const pieces = new lib.PDFDataRangeTransport(size, null);
  pieces.requestDataRange = (begin, end) => piece(begin, end).then((b) => { got.bytes += b.length; pieces.onDataRange(begin, b); }, () => {});
  return { range: pieces, size };
}
// What PDF.js is given besides the file. Some PDFs need its character maps (Chinese, Japanese and Korean, and some
// older encodings) or one of the fourteen standard typefaces a PDF may name without including it: without them their
// text is drawn wrong or not at all. The server has both (/vendor/pdfjs/); the page fetches them, not PDF.js's worker,
// whose policy lets it fetch nothing.
const PDF_OPTIONS = { isEvalSupported: false, disableAutoFetch: true, disableStream: true, rangeChunkSize: 1 << 20,
  cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', useWorkerFetch: false };
const pdfOpen = async (lib, path, copy, got) => { const { size, ...source } = await pdfFrom(lib, path, copy, got); return { doc: await lib.getDocument({ ...source, ...PDF_OPTIONS }).promise, size: size || 0 }; };
async function drawPdf(pane, path, box, bar, copy) {
  const v = views[pane], scroller = el('div', 'pdfpages'), status = el('p', 'empty', 'Opening the PDF\u2026');
  const where = el('small', 'pdfwhere'), less = el('button', '', '\u2212'), more = el('button', '', '+');
  less.title = 'Smaller pages'; more.title = 'Larger pages';
  less.setAttribute('aria-label', less.title); more.setAttribute('aria-label', more.title);
  scroller.append(status);
  box.append(scroller);
  v.scroller = scroller;
  let doc, lib, fileSize = 0, ready;
  const got = { bytes: 0 };   // what PDF.js has been handed of the file since it was opened (see pdfFrom)
  const opened = new Promise((ok) => (ready = ok)), forget = () => { ready(null); if (openPdfs.get(path) === opened) openPdfs.delete(path); };
  openPdfs.set(path, opened);
  try {
    lib = await pdfjs();
    ({ doc, size: fileSize } = await pdfOpen(lib, path, copy, got));
  } catch (e) {
    forget();
    // No PDF.js to be had: without the server, it was never kept on this device; with it, the server is one from before it had PDF.js, still running since then.
    status.textContent = pdfLib ? 'This PDF could not be drawn here' + (e?.message ? ' (' + e.message + ')' : '') + '.' + (copy ? '' : ' "open in new tab" hands it to the PDF viewer of this device.')
      : !net.online ? 'What the reader draws a PDF with is not on this device yet: open the reader once with the server in reach, and from then on a kept PDF is drawn here without it.'
      : 'The server that is running is older than the reader\'s PDF pages: stop it and start it again (npm start), and the PDF is drawn here, every page.';
    return;
  }
  if (!scroller.isConnected) { forget(); doc.destroy(); return; }
  ready(() => doc);
  const first = await doc.getPage(1), shape = first.getViewport({ scale: 1 });
  status.remove();
  const holders = [], jobs = new Map();
  let zoom = 1, line = Promise.resolve();
  const seen = new IntersectionObserver((all) => {
    if (!scroller.isConnected) { seen.disconnect(); shut(); forget(); doc.destroy(); return; }   // the pane shows something else now
    for (const e of all) { e.target.dataset.far = e.isIntersecting ? '0' : '1'; if (e.isIntersecting) draw(e.target); else drop(e.target); }   // "far" is kept on the page itself, so a drawing that finishes late knows it is no longer wanted
  }, { root: scroller, rootMargin: '150% 0px' });
  const canvasOf = (h) => h.querySelector(':scope > canvas');
  const drop = (h) => { jobs.get(h)?.cancel(); jobs.delete(h); const c = canvasOf(h); if (c) { c.width = c.height = 0; c.remove(); } leave(h); };
  // One page at a time: a phone has little memory for drawing surfaces.
  const draw = (h) => { line = line.then(async () => {
    if (!h.isConnected || canvasOf(h) || h.dataset.far === '1') return;
    try {
      const page = await doc.getPage(Number(h.dataset.n)), flat = page.getViewport({ scale: 1 });
      h.style.aspectRatio = String(flat.width / flat.height);
      // As sharp as the screen, within what a phone will hold for one surface.
      let scale = h.clientWidth * Math.min(devicePixelRatio || 1, 3) / flat.width;
      scale = Math.min(scale, Math.sqrt(5e6 / (flat.width * flat.height)));
      const view = page.getViewport({ scale }), canvas = el('canvas');
      canvas.width = Math.floor(view.width); canvas.height = Math.floor(view.height);
      const job = page.render({ canvasContext: canvas.getContext('2d'), viewport: view });
      jobs.set(h, job);
      await job.promise;
      jobs.delete(h);
      const theme = mg ? box.theme : null;
      const done = !!theme && await recolour(canvas, view, Number(h.dataset.n) - 1, theme).then(() => true, () => false);   // not recoloured: the page is turned inside out instead, as before
      if (h.dataset.far === '1' || canvasOf(h)) { canvas.width = canvas.height = 0; return; }
      h.classList.toggle('recoloured', done);
      h.style.background = done ? `rgb(${theme.bg.join(' ')})` : '';
      h.prepend(canvas);
      page.cleanup();
      proxies.set(h, page);
      enter(h);
      if (got.bytes > REOPEN && fileSize > REOPEN) await reopen();
    } catch { jobs.delete(h); /* let go while it was being drawn, or a page that cannot be read: its place stays blank */ }
  }); };
  // PDF.js keeps every piece of the file it has been handed until the document is let go, so reading slowly through a
  // large PDF would end with most of the file in memory. Past 64 MB, between two pages being drawn (one is drawn at a
  // time), the PDF is opened afresh: the pages already drawn stay as they are, the next come from the new document, and
  // the old one is let go with all it held.
  const REOPEN = 64 << 20;
  const reopen = async () => {
    const was = doc;
    got.bytes = 0;
    try {
      const fresh = (await pdfOpen(lib, path, copy, got)).doc;
      if (!scroller.isConnected) { fresh.destroy(); return; }
      doc = fresh;
      was.destroy();
    } catch { /* kept as it was: tried again after the next page */ }
  };
  for (let n = 1; n <= doc.numPages; n++) {
    const h = el('div', 'pdfpage');
    h.dataset.n = n;
    h.style.aspectRatio = String(shape.width / shape.height);
    holders.push(h);
  }
  scroller.append(...holders);
  for (const h of holders) { h.dataset.far = '1'; seen.observe(h); }
  const redraw = () => { for (const h of holders) if (canvasOf(h)) { drop(h); draw(h); } };

  // ---- words on the pages: selecting, highlighting, notes ----
  // The engine is given the file when the first pages are already showing; from then on each drawn page has its text and
  // the box of every character, and so can be selected on. A highlight is a note like any other, with the engine's anchor
  // in `mg`: where its words are is asked of the engine, which finds them by position, and by the words themselves if the
  // file has changed. Everything is drawn inside the page's own element, so it scrolls with the page.
  let mg = null;   // { lib, engine, summary, selection, recolourer }, once the engine has the file
  const pages = new Map();     // page (from 0) -> as drawn: what the selection and the highlights need of it
  const proxies = new Map();   // holder -> its PDF.js page
  const read = new Map();      // page -> its text and boxes, for the last few dozen pages drawn
  const marks = new Map();     // note id -> { exact, at }: where the engine found its words (`at` null: not found)
  const viewOf = (h) => { const page = proxies.get(h); return page.getViewport({ scale: h.clientWidth / page.getViewport({ scale: 1 }).width }); };
  const boxesIn = (view, at) => at.rects.map((r) => {
    const [ax, ay, bx, by] = view.convertToViewportRectangle([r.x0, r.y0, r.x1, r.y1]);
    return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
  });
  // The one box around several, as the flyout wants it: in the window, `from` being the corner they are measured from.
  const around = (boxes, from = { left: 0, top: 0 }) => {
    const left = Math.min(...boxes.map((b) => b.left)), top = Math.min(...boxes.map((b) => b.top));
    return new DOMRect(from.left + left, from.top + top, Math.max(...boxes.map((b) => b.left + b.width)) - left, Math.max(...boxes.map((b) => b.top + b.height)) - top);
  };
  const textOf = (unit) => {
    if (!read.has(unit)) {
      read.set(unit, Promise.all([mg.engine.text(unit), mg.engine.geometry(unit)]).then(([t, geometry]) => ({ ...t, geometry })).catch((e) => { read.delete(unit); throw e; }));
      if (read.size > 48) read.delete(read.keys().next().value);
    }
    return read.get(unit);
  };
  const recolour = async (canvas, view, unit, theme) => {
    const t = await textOf(unit);
    await mg.recolourer.apply(canvas, mg.lib.pageJob(theme, { images: t.images, lines: t.lines?.map((l) => l.bbox), ocr: t.ocr, needsOcr: t.needsOcr, pageBox: mg.summary.units[unit].pageBox }, mg.lib.pdfjsToPx(view, 1)));
  };
  // A page has been drawn: make it one that can be selected on, and draw its highlights.
  const enter = async (h) => {
    if (!mg) return;
    const unit = Number(h.dataset.n) - 1, canvas = canvasOf(h);
    let t;
    try { t = await textOf(unit); } catch { return; }
    if (!mg || !canvas?.isConnected) return;   // let go while its text was read
    pages.set(unit, { unit, element: h, viewport: viewOf(h), text: t.text, geometry: t.geometry, overlay: pages.get(unit)?.overlay ?? new mg.lib.OverlayLayer(h) });
    mirror(h, unit, t);
    paintMarks(unit);
    mg.selection.render();
  };
  // What a screen reader is given of a page: its text, a line at a time, out of sight. The page itself is a picture,
  // and its words are only the engine's, so without this a page says nothing at all.
  const mirror = (h, unit, t) => {
    let m = h.querySelector(':scope > .pdftext');
    if (!m) { m = el('div', 'pdftext'); m.setAttribute('aria-label', 'Text of page ' + (unit + 1)); h.append(m); }
    m.textContent = (t.lines?.length ? t.lines.map((l) => t.text.slice(l.start, l.end)) : [t.text]).join('\n');
  };
  function leave(h) {
    const unit = Number(h.dataset.n) - 1, p = pages.get(unit);
    h.querySelector(':scope > .pdftext')?.remove();
    h.classList.remove('recoloured');
    h.style.background = '';
    if (!p) return;
    p.overlay.el.remove();
    pages.delete(unit);
    if (mg?.selection.sel?.unit === unit) mg.selection.clear();
  }
  const mine = () => notes.filter((n) => n.doc === path && n.mg?.anchor);
  const paintMarks = (unit) => {
    const p = pages.get(unit);
    if (!p) return;
    const shapes = [];
    for (const n of mine()) {
      const at = marks.get(n.id)?.at;
      if (at?.unit === unit) shapes.push({ annotation: { id: n.id, kind: 'highlight', color: n.type ? typeOf(n.type).color : '#fbeeb0', note: n.text }, boxes: boxesIn(p.viewport, at) });
    }
    p.overlay.set(shapes, activeHl);
  };
  const paintAll = () => { for (const unit of pages.keys()) paintMarks(unit); };
  // Ask the engine where each highlight's words are (once each), then draw them.
  let placing = Promise.resolve();
  const placeMarks = () => (placing = placing.then(async () => {
    if (!mg || !scroller.isConnected) return;
    const all = mine();
    for (const id of [...marks.keys()]) if (!all.some((n) => n.id === id)) marks.delete(id);
    for (const n of all) {
      const exact = n.mg.anchor.quote?.exact;
      if (marks.get(n.id)?.exact === exact) continue;
      let at = null;
      try { at = await mg.engine.resolve(n.mg.anchor); } catch { /* an anchor the engine cannot read: its words are not found */ }
      marks.set(n.id, { exact, at });
      if (at) lost.delete(n.id); else lost.add(n.id);
    }
    for (const d of notesEl.querySelectorAll('.note')) d.classList.toggle('lost', lost.has(d.dataset.id));
    paintAll();
  }).catch(() => {}));
  // Bring a highlight into view: a third of the way down the window, and outlined for a moment once its page is drawn.
  const showMark = async (id) => {
    await placeMarks();
    const at = marks.get(id)?.at, h = at && holders[at.unit];
    if (!h) return;
    const page = await doc.getPage(at.unit + 1), boxes = boxesIn(page.getViewport({ scale: h.clientWidth / page.getViewport({ scale: 1 }).width }), at);
    scroller.scrollTop += h.getBoundingClientRect().top + around(boxes).top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
    let tries = 0;
    const wait = setInterval(() => {
      const p = pages.get(at.unit);
      if (p) p.overlay.flash(boxesIn(p.viewport, at));
      if (p || ++tries > 50 || !scroller.isConnected) clearInterval(wait);
    }, 100);
  };
  v.pdfMarks = { place: placeMarks, paint: paintAll, show: showMark };
  // The pages' theme was changed (`again`), or the engine has just come: dark pages want their highlights laid over, not multiplied.
  box.repaint = (again) => {
    scroller.classList.toggle('mg-dark', !!mg && !!box.theme && mg.lib.isDark(box.theme));
    if (again && mg) redraw();
  };
  // The pages are as wide as the pane: when that changes, what is drawn over them is measured again.
  const sized = new ResizeObserver(perFrame(() => {
    if (!mg) return;
    for (const p of pages.values()) p.viewport = viewOf(p.element);
    paintAll();
    mg.selection.render();
  }));
  sized.observe(scroller);
  const shut = () => {
    sized.disconnect();
    mg?.selection.destroy();
    mg?.recolourer.close();
    mg?.engine.close();
    if (pendingMg?.of === scroller) pendingMg = null;
    if (v.pdfMarks?.show === showMark) v.pdfMarks = null;
    mg = null;
  };
  (async () => {
    let engine;
    try {
      // From this server, a PDF that is not kept here is read in pieces as pages are drawn (js/engine-worker.js), and its
      // SHA-256 comes from the server; otherwise the engine reads the copy on this device (or another hub's file, whole).
      const lib = await marginalia(), fromHere = !kept.has(path) && net.online && !hub.url;
      const print = fromHere ? await serverPrint(path) : null;
      let summary;
      if (print) {
        engine = new lib.Engine(engineWorker);
        summary = await engine.open({ url: rawUrl(path) }, { fingerprint: print });
      } else {
        const blob = await pdfBlob(path);
        if (!blob || !scroller.isConnected) return;
        engine = new lib.Engine();
        const prints = mgPrints(), known = prints[path];
        summary = await engine.open(blob, known?.size === blob.size ? { fingerprint: known.print } : {});
        if (known?.print !== summary.info.fingerprint || known.size !== blob.size) store.set('mgPrints:' + config.root, { ...prints, [path]: { size: blob.size, print: summary.info.fingerprint } });
      }
      if (!scroller.isConnected) { engine.close(); return; }
      const surface = lib.pdfSurface(() => pages.values());
      let flyTimer;
      const selection = new lib.SelectionEngine(scroller, surface, {
        // Runs at every step of a handle being dragged: the anchor is made only when the highlight or the note is.
        change: (range) => {
          clearTimeout(flyTimer);
          const text = range && pages.get(range.unit)?.text, cut = text ? lib.trimRange(text, range.start, range.end) : null;
          const quote = cut ? text.slice(cut.start, cut.end).replace(/\s+/g, ' ').trim() : '';
          if (!quote) {
            if (pendingMg?.of !== scroller) return;
            pendingMg = null;
            pendingQuote = '';
            hideFlyout();
          } else {
            if (pane !== state.active) { state.active = pane; chrome(); }
            pendingQuote = quote;
            pendingAt = pendingHead = activeHl = null;
            pendingMg = {
              of: scroller, clear: () => selection.clear(),
              fields: async () => ({ mg: { doc: summary.info.fingerprint, anchor: await engine.createAnchor(range.unit, cut.start, cut.end) }, heading: '', headingText: 'page ' + (range.unit + 1) }),
            };
            // The swatches come when the selection has stopped changing, beside it.
            flyTimer = setTimeout(() => {
              const b = pendingMg?.of === scroller ? surface.rects(range.unit, cut.start, cut.end) : [];
              if (b.length) showFlyout(around(b), touch.matches);
            }, 350);
          }
          renderContext();
          paintAll();
          laterNotes();
        },
        // A press that selected nothing: on a highlight, it is the one being worked on; anywhere else, none is.
        tap: (x, y) => {
          for (const p of pages.values()) {
            const r = p.element.getBoundingClientRect();
            if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
            const id = p.overlay.hit(x - r.left, y - r.top)[0];
            if (!id) break;
            dropPendingMg();
            selectHighlight(id, around(p.overlay.boxesOf(id), r));
            return true;
          }
          if (activeHl) { activeHl = null; hideFlyout(); renderContext(); renderNotes(false); markActive(); }
          return false;
        },
      });
      mg = { lib, engine, summary, selection, recolourer: new lib.Recolorer() };
      scroller.classList.add('mg-selectable');
      // The engine stopped and started again by itself: it has the file again, and nothing here was kept in it.
      engine.onRestart = async () => { read.clear(); marks.clear(); await placeMarks(); };
      engine.onBroken = shut;
      box.repaint();
      for (const h of holders) if (canvasOf(h)) { if (box.theme) { drop(h); draw(h); } else enter(h); }
      placeMarks();
    } catch (e) {
      // No engine (a server from before it had one), or a file it cannot read (locked with a password, or damaged): the pages are drawn all the same.
      engine?.close();
      console.warn('The document engine did not open ' + path + ': nothing can be selected on its pages.', e?.code || e);
    }
  })();
  const tell = perFrame(() => {
    const top = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
    const at = holders.find((h) => h.getBoundingClientRect().bottom > top) || holders[holders.length - 1];
    where.textContent = `page ${at.dataset.n} of ${doc.numPages}`;
    // On a phone the PDF's own bar is put away, and its tab says the page (see renderTabs).
    v.where = { path, text: where.textContent };
    paintBareWhere();
    const onTab = state.panes[pane]?.active === path && v.tabsEl.querySelector('.tab.active .tabWhere');
    if (onTab) onTab.textContent = v.where.text;
    v.bar.style.width = (100 * Number(at.dataset.n) / doc.numPages) + '%';
    if (views[pane] === v && state.panes[pane]?.active === path) keepPlace(path, place());
  });
  // The page at the top of what is in sight, and how far down it: "p12.370" (0 at the very start: nothing to keep).
  const place = () => {
    const top = scroller.getBoundingClientRect().top, h = holders.find((x) => x.getBoundingClientRect().bottom > top + 1) || holders[holders.length - 1], r = h.getBoundingClientRect();
    const part = Math.min(0.999, Math.max(0, (top - r.top) / Math.max(1, r.height)));
    return h === holders[0] && part < 0.05 ? 0 : 'p' + (Number(h.dataset.n) + part).toFixed(3);
  };
  v.place = place;
  scroller.addEventListener('scroll', tell, { passive: true });
  const setZoom = (z) => {
    const mid = (scroller.scrollTop + scroller.clientHeight / 2) / Math.max(1, scroller.scrollHeight);
    zoom = Math.min(4, Math.max(0.5, z));
    scroller.style.setProperty('--zoom', zoom);
    scroller.scrollTop = mid * scroller.scrollHeight - scroller.clientHeight / 2;
    redraw();   // drawn again at the new size
  };
  less.onclick = () => setZoom(zoom / 1.25);
  more.onclick = () => setZoom(zoom * 1.25);
  v.zoom = { path, by: (times) => setZoom(zoom * times) };   // for the small − and + over the page while the bars are away
  bar.firstChild.after(where, less, more);
  const left = placesOf()[path], here = scrollMem.get(pane + ':' + path);
  if (here != null) scroller.scrollTop = here;   // a tab gone back to, the screen as it was
  else if (typeof left === 'string') {
    const at = parseFloat(left.slice(1)), h = holders[Math.min(holders.length, Math.max(1, Math.floor(at))) - 1], r = h.getBoundingClientRect();
    scroller.scrollTop += r.top - scroller.getBoundingClientRect().top + (at % 1) * r.height;
  } else scroller.scrollTop = left ?? 0;   // as it was kept before: a distance
  tell();
}
// On a phone a PDF's bar (its name, smaller and larger, night, reader, keep) is put away, so the page has the room:
// the button in the top bar brings it out and puts it back, and the page being read is said on the PDF's tab.
// Kept with the layout.
// With the top bar away (the bars put away for reading), the same button sits with the muted ones at the top left.
function togglePdfTools() {
  state.pdfTools = !state.pdfTools;
  save();
  for (const box of document.querySelectorAll('.viewer.pdfv')) box.classList.toggle('tools', state.pdfTools);
  paintBareWhere();
  $('mTools').setAttribute('aria-pressed', state.pdfTools);
}
$('mTools').onclick = togglePdfTools;
function showPdf(pane, path) {
  const v = views[pane], box = el('div', 'viewer pdfv' + (state.pdfTools ? ' tools' : '')), bar = el('div', 'viewbar');
  bar.append(el('span', '', path.split('/').pop()));
  const open = el('a', '', 'open in new tab');
  open.target = '_blank';
  open.rel = 'noopener';
  v.bar.style.width = '0%';
  box.append(bar);
  v.body.replaceChildren(box);
  // This server's own address can be given to a frame or to PDF.js. Otherwise (no server in reach, or another hub's
  // file) the reader draws the pages itself, from the copy kept on this device, or from the other hub while it answers.
  const here = net.online && !hub.url, copy = !here && (kept.has(path) || (!!hub.url && net.online));
  if (here || copy) {
    const own = copy || (state.pdfOwn ?? true), mine = el('button', '', 'reader');
    mine.title = 'Draw the pages in the reader itself, where their words can be highlighted and written about. Off: the browser\'s own PDF viewer, in which nothing can be highlighted.';
    mine.setAttribute('aria-pressed', own);
    mine.onclick = () => { state.pdfOwn = !own; save(); showDoc(pane); };
    const frame = el(own ? 'div' : 'iframe', 'pdf'), night = el('button', '', own ? 'theme' : 'night');   // drawn here, `frame` is only what carries the pages' theme
    if (!own) { frame.title = path.split('/').pop(); frame.referrerPolicy = 'no-referrer'; }
    const paint = () => {
      const probe = el('span');
      box.append(probe);
      // The pane's paper and ink, as the three numbers of each.
      const rgb = (name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map((n) => Math.round(Number(n))); };
      const bg = rgb('--paper'), fg = rgb('--ink'), dark = bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114 < 128;
      probe.remove();
      const on = (own ? state.pdfTheme : state.pdfNight) ?? dark;
      const was = JSON.stringify(frame.theme || null);
      frame.theme = own && on ? { bg, fg } : null;
      frame.classList.toggle('night', on && (dark || !own));   // turned inside out: in a frame, and here a dark theme's page that could not be recoloured
      night.setAttribute('aria-pressed', on);
      if (was !== JSON.stringify(frame.theme)) frame.repaint?.(true);
    };
    night.title = own ? 'The pages in this theme\'s colours: its paper and its ink, with pictures left as they are. Off: the PDF as it was made.' : 'Dark pages with light text. Pictures in the PDF are turned too.';
    night.onclick = () => { state[own ? 'pdfTheme' : 'pdfNight'] = night.getAttribute('aria-pressed') !== 'true'; save(); paint(); };
    frame.paint = paint;
    open.href = rawUrl(path);
    bar.append(night, keepBtn(path));
    if (here) { night.after(mine); bar.append(open); }   // a copy has the one way to be shown, and no address a tab of its own could open
    if (own) {
      frame.className = 'pdf pdfwrap';
      box.append(frame);
      drawPdf(pane, path, frame, bar, copy);
      addPageCover(frame, path, () => 1300);   // its pages are up to 1100 wide
    }
    else { frame.src = open.href; box.append(frame); }
    paint();
    return;
  }
  bar.append(keepBtn(path));
  box.append(el('p', 'empty', (hub.url ? `“${hub.name}” is not reachable` : 'The server is not reachable') + ', and this file has not been kept on this device.'));
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
// `at` ("item=12", from find): the item of the file the page is to open at.
function cardsFrame(path, within = document.body, at = '') {
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
  frame.src = '/cards/' + path.split('/').map(encodeURIComponent).join('/') + '?' + look.join('&') + '&size=' + cardSize() + (state.cardsReversed ? '&rev=1' : '') + (/^item=\d+$/.test(at || '') ? '&' + at : '');
  return frame;
}
// How wide a card is in a gallery: set by the slider there, kept for this device.
const cardSize = () => Math.min(420, Math.max(70, Number(state.cardSize) || 150));
let cardSaved = 0;
function setCardSize(n) {
  if (!(n >= 70 && n <= 420)) return;
  state.cardSize = Math.round(n);
  for (const g of document.querySelectorAll('.thumbs')) g.style.setProperty('--card', state.cardSize + 'px');
  for (const s of document.querySelectorAll('.cardSize input')) if (s !== document.activeElement) s.value = state.cardSize;   // every slider says the one size
  clearTimeout(cardSaved);
  cardSaved = setTimeout(save, 400);
}
// The slider that sets it. One size holds for every page of cards, so every page of cards has the slider: a page
// that would have none of its own (the front page's folders, a folder's cards) is given one over its first cards
// (`auto`: it gives way, in the style sheet, while the page shows a slider of its own).
function sizeSlider(cls = '') {
  const wide = el('label', 'cardSize' + cls, 'size '), slide = el('input');
  slide.type = 'range'; slide.min = 70; slide.max = 420; slide.value = cardSize();
  slide.setAttribute('aria-label', 'Size of the cards');
  slide.oninput = () => setCardSize(Number(slide.value));
  wide.append(slide);
  return wide;
}
function ensureSlider(article) {
  const first = article.querySelector('.thumbs');
  if (!first || article.querySelector('.cardSize.auto')) return;
  const box = first.closest('.library');
  if (box) box.prepend(sizeSlider(' auto')); else first.before(sizeSlider(' auto'));
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
    u.searchParams.delete('item');   // turned round, it opens at its top
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
function showLinks(pane, path, at) {
  const v = views[pane], box = el('div', 'viewer lb'), bar = el('div', 'viewbar');
  bar.append(el('span', '', path.split('/').pop()), ...lightboxBtns(pane));
  box.append(bar);
  v.bar.style.width = '0%';
  v.body.replaceChildren(box);
  if (hub.url || !net.online) { box.append(el('p', 'empty', 'The media in this file is shown by the server it is on, when that is in reach.')); return; }
  const show = () => { box.replaceChildren(bar, cardsFrame(path, v.root, at)); };
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
// A folder's gallery (see applyLocks): its name, and what a front page has under
// its description, opened on the pictures and video. A folder's music page is
// the same, opened on the music; each remembers the tile chosen on it apart.
// The folder's cover, on its page: at the side of the title. A folder with something kept on this device has its cover kept too.
function addCover(article, folder) {
  const path = covers.get(folder) || covers.get(unitOf(folder)?.folder);   // its own, or that of the folder it comes down to
  if (!path || (!net.online && !kept.has(path))) return;
  const img = el('img', 'cover');
  img.alt = '';
  mediaSrc(path).then((u) => { if (u) img.src = u; });
  const h1 = article.querySelector('h1');
  if (h1) h1.before(img); else article.prepend(img);
  if (net.online && !kept.has(path) && docs.some((d) => kept.has(d.path) && d.path.startsWith(folder + '/'))) keepCopy(path, true);
}
// A card that fills itself in (a book's cover, a PDF's first page) does so when it comes into sight, and one at a time.
let coverLine = Promise.resolve();
const coverSeen = new IntersectionObserver((all) => {
  for (const e of all) {
    if (!e.isIntersecting) continue;
    coverSeen.unobserve(e.target);
    coverLine = coverLine.then(() => (e.target.isConnected ? e.target.fill() : null)).catch(() => {});
  }
}, { rootMargin: '200px' });
// The first picture a book shows (its cover, in most): looked for in its first pages. '' if it has none there.
const bookCovers = new Map();
async function bookCover(book) {
  if (bookCovers.has(book)) return bookCovers.get(book);
  let found = '';
  for (const d of docs.filter((x) => inBook(book, x.path)).slice(0, 3)) {
    let text = null;
    // Asked for by itself, not through docText: looking for a cover should not leave the page kept on this device.
    if (kept.has(d.path)) text = (await idb.get('docs', keyOf(d.path)))?.text;
    else if (net.online) text = await call('/api/doc?path=' + encodeURIComponent(d.path), { quiet: true }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    found = text == null ? '' : partsOf(d.path, text).find(isImage) || '';
    if (found) break;
  }
  if (found || net.online) bookCovers.set(book, found);
  return found;
}
// The cover of a book or a PDF as the address of a picture, for wherever it is shown small: on its tab, and at the
// corner of its page. A book's is its first picture; a PDF's is its first page, drawn once and kept as a picture
// for this visit. `key`: the book's own path, or the PDF's. '' if it has none, or it cannot be had now.
const coverKeyOf = (path) => (isBookPage(path) ? path.slice(0, path.search(/\.epub\//i) + 5) : isPdf(path) ? path : null);
const coverUrls = new Map();
// A picture shown small (a cover on a tab, at a page's corner, on a folder's line or card): read once, drawn at most
// 480 pixels wide, and kept as a small JPEG for this visit. Shown from the server's address instead, it was read whole
// each time it appeared, since the browser keeps nothing the server sends of a workspace: for a book of large pictures,
// the whole cover again on every page turned, and a folder's cover on every redraw of the file list. Left as it was if
// it cannot be drawn (an SVG some browsers will not): then the bytes read are kept as they are, so they are still read once.
async function smallPicture(src) {
  if (!src) return '';
  let blob = null, pic;
  try {
    // A copy on this device (a blob: address) is read through a picture: the page may not fetch such an address.
    if (src.startsWith('blob:')) { pic = new Image(); pic.src = src; await pic.decode(); }
    else {
      const r = await fetch(src);
      if (!r.ok) return src;
      blob = await r.blob();
      pic = await createImageBitmap(blob);
    }
    const pw = pic.naturalWidth || pic.width, ph = pic.naturalHeight || pic.height, w = Math.min(480, pw), c = el('canvas');
    c.width = w;
    c.height = Math.max(1, Math.round((ph * w) / pw));
    c.getContext('2d').drawImage(pic, 0, 0, c.width, c.height);
    pic.close?.();
    const small = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.82));
    c.width = c.height = 0;
    return small ? URL.createObjectURL(small) : blob ? URL.createObjectURL(blob) : src;
  } catch { return blob ? URL.createObjectURL(blob) : src; }
}
function coverUrl(key) {
  if (!coverUrls.has(key)) coverUrls.set(key, (async () => {
    if (!isPdf(key)) { const p = await bookCover(key); return !p ? '' : smallPicture(net.online ? await mediaSrc(p) : await keptUrl(p)); }
    const drawn = await pdfThumb(key);
    if (!drawn) return '';
    const blob = await new Promise((ok) => drawn.toBlob(ok, 'image/jpeg', 0.82));
    drawn.width = drawn.height = 0;
    return blob ? URL.createObjectURL(blob) : '';
  })().catch(() => '').then((u) => { if (!u) coverUrls.delete(key); return u; }));   // none this time: asked again the next
  return coverUrls.get(key);
}
// On a phone the cover is not in the page but beside the contents button, which floats at the top right there: one
// thumbnail for whatever is being read, identifying it without changing the reading position.
const coverBtn = el('div'), coverBtnImg = el('img');
coverBtn.id = 'coverBtn';
coverBtn.hidden = true;
coverBtnImg.alt = 'Cover of the current book or PDF';
coverBtn.append(coverBtnImg);
$('work').append(coverBtn);
function paintCoverBtn() {
  const path = activeDoc(), key = path && !gateOf(path) ? coverKeyOf(path) : null;
  coverBtn.dataset.key = key || '';
  if (!key) { coverBtn.hidden = true; return; }
  coverUrl(key).then((u) => { if (coverBtn.dataset.key !== key) return; coverBtn.hidden = !u; if (u) coverBtnImg.src = u; });
}
// At the top right of the page of a book or a PDF: its cover, small, so it is plain which book this is however far
// in. In the margin on a wide pane; smaller, beside the contents button, on a narrow one or a phone.
// `room`: how wide the pane has to be for the cover to sit beside the page; in less it is small, in the corner.
// `byText`: beside the text column of a book (which is in the middle of the pane), not at the pane's edge.
function addPageCover(wrap, key, room, byText) {
  const b = el('div', 'pageCover' + (byText ? ' byText' : '')), img = el('img');
  wrap.fitCover = () => b.classList.toggle('tight', wrap.clientWidth < room());   // asked again when the pane changes width, or the text its size
  new ResizeObserver(wrap.fitCover).observe(wrap);
  b.hidden = true;
  img.alt = 'Cover of the current book or PDF';
  img.onload = () => { b.hidden = false; };
  coverUrl(key).then((u) => { if (u) img.src = u; });
  b.append(img);
  wrap.append(b);
}
// PDFs open in a pane, by path: a promise of what gives the document, null if it could not be opened (see drawPdf).
const openPdfs = new Map();
// The first page of a PDF, as a small drawing. null if it cannot be had (not kept, and no server). A PDF being read
// is not opened a second time for it: its first page is drawn from the document the pane has open, so the start of
// the file is not fetched and held twice.
async function pdfThumb(path) {
  await new Promise((ok) => setTimeout(ok));   // the pane that draws it may be about to open it
  const open = (await openPdfs.get(path))?.();
  const here = net.online && !hub.url;
  if (!open && !here && !kept.has(path)) return null;
  const doc = open || (await pdfOpen(await pdfjs(), path, !here)).doc;
  try {
    const page = await doc.getPage(1), flat = page.getViewport({ scale: 1 }), view = page.getViewport({ scale: 480 / flat.width }), canvas = el('canvas');
    canvas.width = Math.floor(view.width); canvas.height = Math.floor(view.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
    if (open) page.cleanup();   // what drawing it held, let go: the document is the pane's
    return canvas;
  } finally { if (!open) doc.destroy(); }
}
// On the page of a folder that comes down to one thing: that thing, as a card at the side of the title and the
// description. Its picture is the folder's cover if it has one, else the thing's own (the picture, the video's
// first frame, a PDF's first page, a book's first picture), else the sign of its kind. Pressing the card opens the
// thing in a tab of its own; a book opens where it was last read. False if the folder is not such a one.
function oneCard(article, folder) {
  const one = oneUnder(folder);
  if (!one) return false;
  const pages = one.book ? docs.filter((d) => inBook(one.book, d.path) && inView(d)) : [];
  const target = () => (one.book ? bookTarget({ book: one.book, pages }) : one.path);
  const kind = one.book ? 'docs' : kindOfBits(isAudio(one.path) ? 1 : isVideo(one.path) ? 2 : isImage(one.path) ? 8 : 4);
  const name = one.book ? givenName(one.book).replace(/\.epub$/i, '') : docOf(one.path)?.title || one.path.split('/').pop();
  const card = el('div', 'onecard'), pic = el('div', 'pic'), what = el('div', 'what'), go = el('button', 'main', one.book ? 'Read' : isAudio(one.path) ? 'Play' : 'Open');
  const open = () => { const p = target(); if (!p) return; if (isAudio(p) && playable(p)) askPlay(p); else openDoc(p); };
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.onclick = open;
  card.onkeydown = (e) => { if (e.key === 'Enter' && e.target === card) open(); };
  what.append(el('b', '', name), el('small', '', one.book ? 'Book' : one.path.split('/').pop()), go);
  card.append(pic, what);
  const sign = () => { pic.classList.add('sign'); pic.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">${KIND_ICONS[kind]}</svg>`; };
  const put = (node) => { pic.classList.remove('sign'); pic.replaceChildren(node); };
  const show = async (p) => {
    const u = !p ? '' : net.online ? await mediaSrc(p) : await keptUrl(p);
    if (!u) return false;
    const img = el('img');
    img.alt = '';
    img.onerror = sign;
    img.src = u;
    put(img);
    return true;
  };
  sign();
  (async () => {
    const cover = [folder, one.folder].map((f) => covers.get(f)).find(Boolean);
    if (await show(cover)) return;
    const p = one.path;
    if (one.book) await show(await bookCover(one.book));
    else if (isImage(p)) await show(p);
    else if (isVideo(p)) { if (playable(p)) put(videoThumb(p)); }
    else if (isPdf(p)) { const c = await pdfThumb(p); if (c) put(c); }
  })().catch(() => {});
  const h1 = article.querySelector('h1');
  if (h1) h1.before(card); else article.prepend(card);
  return true;
}
// The picture that stands for a folder. As an address (folderCoverUrl; for its line in the file list): its cover
// (its own, else the nearest one inside it), else the first picture in it, else the cover of the first book or PDF
// in it; '' if it has none. As something to put on a card (folderThumb): the same, with a video's first frame
// coming before a book's cover. What is found is kept until the list of files changes.
let folderCovers = new Map();
function folderCoverUrl(root, books = true) {
  const key = (books ? 'b|' : 'p|') + root;
  if (!folderCovers.has(key)) folderCovers.set(key, (async () => {
    const url = async (p) => (!p ? '' : smallPicture(net.online ? await mediaSrc(p) : await keptUrl(p)));
    const cover = [...covers.keys()].filter((f) => f === root || f.startsWith(root + '/')).sort((a, b) => a.length - b.length)[0];
    const inside = docs.filter((d) => d.path.startsWith(root + '/') && !gateOf(d.path));
    const pic = (await url(covers.get(cover))) || (await url(inside.find((d) => isImage(d.path) && !isBookPage(d.path))?.path));
    if (pic || !books) return pic;
    const book = inside.find((d) => isBookPage(d.path) || isPdf(d.path));
    return book ? coverUrl(coverKeyOf(book.path)) : '';
  })().catch(() => ''));
  return folderCovers.get(key);
}
async function folderThumb(root) {
  const img = (u) => { if (!u) return null; const i = el('img'); i.alt = ''; i.src = u; return i; };
  const pic = img(await folderCoverUrl(root, false));
  if (pic) return pic;
  const video = docs.find((d) => d.path.startsWith(root + '/') && isVideo(d.path) && playable(d.path) && !gateOf(d.path));
  return video ? videoThumb(video.path) : img(await folderCoverUrl(root));
}
// In the file list, the sign before a folder's or a book's name gives way to its picture, where it has one (a book
// its cover, an album its artwork): fetched when the line comes into sight, one at a time (see coverSeen).
function coverInto(sign, find) {
  sign.fill = async () => {
    const u = await find();
    if (!u || !sign.isConnected) return;
    const img = el('img');
    img.alt = '';
    img.onload = () => { sign.classList.add('pic'); sign.replaceChildren(img); };
    img.src = u;
  };
  coverSeen.observe(sign);
}
// How much is in a folder, in a number and a word: "12 tracks", "3 books", "40 pictures".
function saysCount(folder) {
  // Pictures beside anything else are company (an album's artwork), and are not counted with it.
  const every = asItems(docs.filter((d) => d.path.startsWith(folder + '/') && !isFront(d.path) && inView(d))), main = every.filter((d) => !isImage(d.path));
  const items = main.length ? main : every, n = items.length;
  const all = (test) => n > 0 && items.every((d) => test(d.path));
  const word = all(isAudio) ? 'track' : all(isImage) ? 'picture' : all(isVideo) ? 'video' : n && items.every((d) => d.book || isPdf(d.path)) ? 'book' : 'item';
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
// A file's name as it is shown: a picture, a video or a sound file goes by its name without the ending (the reader
// knows what it is, and says so by how it shows it). Anything else keeps its whole name: "notes.md" and "notes.c" are two things.
// What a part of a path was called when it came, where the hub saved it under a shorter name because the whole was too
// long for its system (`asked` in the list; see fit_path in hub.cpp): the list shows the name given, the path stays short.
const givenNames = new Map();
function learnGivenNames() {
  givenNames.clear();
  for (const d of allDocs) {
    if (!d.asked) continue;
    const a = d.asked.split('/'), s = d.path.split('/');
    for (let i = 0; i < s.length && i < a.length; i++) if (s[i] !== a[i]) givenNames.set(s.slice(0, i + 1).join('/'), a[i]);
  }
}
const givenName = (path) => givenNames.get(path) || path.split('/').pop();
const showName = (path) => { const name = givenName(path); return isMedia(path) ? name.replace(/\.[^.]+$/, '') : name; };
// Folders as cards (a set's page; the library on the front page): for each, a picture from inside it (see
// folderThumb), its name, and how much it holds. Pressing a card goes into the folder: to its page; or, where the
// folder is nothing more than one thing and has no front page to say more, straight to the thing; or, for a
// folder that opens out in the file list and has no page, to its place in the list. A folder with sound in it
// has a play button on its card: everything in it is lined up and the first track starts, without going in.
// `kids`: [{ path, unit }], `unit` as unitOf gives it (null for a folder that opens out).
function folderCards(pane, kids) {
  const grid = el('div', 'thumbs sets');
  grid.style.setProperty('--card', cardSize() + 'px');
  for (const kid of kids) {
    const k = kid.unit, t = el('div', 'thumb unit'), sign = el('i'), name = lineName(k ? k.folder : kid.path), locked = !!gateOf(frontOf(kid.path)), count = locked ? 'locked' : saysCount(kid.path);
    const pages = k?.book ? docs.filter((d) => inBook(k.book, d.path) && inView(d)) : [];
    const thing = k?.type === 'one' && k.page.endsWith('/') ? (k.book ? (pages.length ? bookTarget({ book: k.book, pages }) : null) : k.path) : null, to = thing || (k ? k.page : pageOf(kid.path));
    if (to) t.dataset.path = to; else t.dataset.folder = kid.path;
    t.tabIndex = 0;
    t.setAttribute('role', 'button');
    t.title = thing ? name : `${name} · ${count}`;
    sign.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">${KIND_ICONS[kindOf(kid.path)]}</svg>`;
    const label = el('b', '', name);
    if (!thing) label.prepend(el('small', '', count));
    t.append(sign, label);
    t.fill = async () => { const pic = await folderThumb(kid.path); if (pic && t.isConnected) sign.replaceWith(pic); };
    coverSeen.observe(t);
    const songs = locked ? [] : docs.filter((d) => isAudio(d.path) && d.path.startsWith(kid.path + '/') && playable(d.path)).map((d) => d.path);
    if (songs.length) {
      const play = el('button', 'ic playB');
      play.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${PLAY_ICONS.play}</svg>`;
      play.title = songs.length === 1 ? 'Play it' : `Play these ${songs.length} tracks, one after another`;
      play.setAttribute('aria-label', play.title);
      play.onclick = (e) => { e.stopPropagation(); queue = songs; saveQueue(); playTrack(songs[0]); renderPlayers(); };
      t.append(play);
    }
    const go = (e) => {
      const side = e.metaKey || e.ctrlKey || e.altKey;
      if (!to) openFolder(kid.path, side); else if (isAudio(to) && playable(to) && !side) askPlay(to); else openDoc(to, { pane, side });
    };
    t.onclick = go;
    t.onkeydown = (e) => { if (e.key === 'Enter' && e.target === t) go(e); };
    grid.append(t);
  }
  return grid;
}
// The library, on the workspace's front page: every folder at the top of the workspace as a card, under the same
// headings as the file list (the pinned ones, the starter material, then each kind), so any of them is one press
// from the front page with nothing to open out first.
function addLibrary(article, pane) {
  const tops = new Map();   // folder at the top -> when something in it last changed
  for (const d of docs) {
    const cut = d.path.indexOf('/'), top = cut < 0 ? '' : d.path.slice(0, cut);
    if (!top || /\.epub$/i.test(top) || !inView(d)) continue;
    tops.set(top, Math.max(tops.get(top) || 0, d.changed || 0));
  }
  const starter = new Set((config.starter || []).map((x) => x.replace(/\/$/, '')));
  const pins = (state.pinned || []).filter((f) => tops.has(f) || tally.has(f));
  const rest = [...tops].filter(([n]) => !starter.has(n) && !pins.includes(n)).sort(([a, x], [b, y]) => (b === 'inbox') - (a === 'inbox') || y - x).map(([n]) => n);
  const groups = [['Pinned', pins], ['cs-learning', [...tops.keys()].filter((n) => starter.has(n) && !pins.includes(n))], ...CATS.map(([cat, label]) => [label, rest.filter((n) => catOf(n) === cat)])].filter(([, list]) => list.length);
  if (!groups.length) return;
  const box = el('div', 'library');
  for (const [label, list] of groups) box.append(el('h5', '', label), folderCards(pane, list.map((path) => ({ path, unit: unitOf(path) }))));
  article.append(box);
}
// Over the title of a folder's page: the pages above it, from the front page down, each one press away.
function addCrumbs(article, pane, folder, path) {
  const steps = [];
  for (let f = folderOf(folder); f; f = folderOf(f)) { const page = pageOf(f); if (page && page !== path && !steps.some((x) => x.page === page)) steps.unshift({ page, name: f.split('/').pop() }); }
  if (config.front && config.front !== path && docOf(config.front)) steps.unshift({ page: config.front, name: config.title || 'Front page' });
  if (!steps.length) return;
  const nav = el('nav', 'crumbs');
  nav.setAttribute('aria-label', 'Where this is');
  for (const step of steps) {
    const b = el('button', '', step.name);
    b.onclick = (e) => { e.stopPropagation(); openDoc(step.page, { pane, side: e.metaKey || e.ctrlKey || e.altKey }); };
    nav.append(b, el('span', '', '›'));
  }
  article.prepend(nav);
}
// Under the title and description of a folder's page (its front page, or the one made for it): what is in the
// folder. One thing: its card. Folders: a card for each (an album, an author, a chapter's folder of notes), and
// the folder's own files listed, whichever there is more of first. No folders: its files by kind, opened on
// `first`. A folder holding nothing but one folder shows what that one holds, and so on down.
function folderBody(article, pane, folder, first) {
  const u = unitOf(folder);
  if (u?.type === 'one') { oneCard(article, folder); return; }
  let at = folder;
  for (let t; (t = tally.get(at)) && !t.files.length && !t.books.size && t.kids.size === 1;) [at] = t.kids;
  const t = tally.get(at), kids = t ? [...t.kids].map((path) => ({ path, unit: unitOf(path) })) : [], own = t ? t.files.length + t.books.size : 0;
  if (kids.length) {
    const list = () => { if (own) appendBrowse(article, pane, at, u?.kind ?? (at === folder ? first : null), 'browse:' + at, (d) => folderOf(d.path) === at); };
    if (own > kids.length) { list(); article.append(folderCards(pane, kids)); } else { article.append(folderCards(pane, kids)); list(); }
  } else appendBrowse(article, pane, folder, u ? u.kind : first);
  addCover(article, folder);
}
function showGallery(pane, path) {
  const v = views[pane], folder = folderOf(path), kind = docOf(path).gallery;
  const scroller = el('div', 'scroller'), article = el('article', 'md');
  article.append(el('h1', '', kind === 'inbox' ? 'Inbox' : lineName(folder)));
  scroller.append(article);
  v.body.replaceChildren(scroller);
  v.scroller = scroller;
  // The folder's own page is whatever the folder is (see folderBody); its music page lists every sound file in it.
  if (kind === 'inbox') inboxBody(article, pane, folder);
  else if (path.endsWith('/')) folderBody(article, pane, folder, ['one', 'set', 'folder'].includes(kind) ? null : kind);
  else { appendBrowse(article, pane, folder, kind, 'browse:' + path); addCover(article, folder); }
  addCrumbs(article, pane, folder, path);
  // A folder with no front page has these under the page made for it, as a front page has them (not the inbox, which is the reader's own).
  if (folder && kind !== 'inbox') { const acts = el('div', 'editFront'); acts.append(...folderActs(folder)); article.append(acts); }
  ensureSlider(article);
  if (folder && kind !== 'inbox') addLockTop(article, folder);
  scroller.addEventListener('scroll', () => keepPlace(path, scroller.scrollTop), { passive: true });
  scroller.scrollTop = scrollMem.get(pane + ':' + path) ?? placesOf()[path] ?? 0;
}
// The inbox's page: everything in it, at any depth and of any kind, as one run of cards, the latest changed first
// (what is still waiting to be sent before all). A picture or a video shows itself, a book or a PDF its cover, and
// anything else the sign of its kind. Pressing a card opens it; a sound file plays.
function inboxBody(article, pane, folder) {
  const when = (d) => (d.book ? Math.max(...d.pages.map((p) => p.changed || 0)) : isPending(d.path) ? Number.MAX_VALUE : d.changed || 0);
  const items = asItems(docs.filter((d) => d.path.startsWith(folder + '/') && !isFront(d.path) && inView(d))).sort((a, b) => when(b) - when(a));
  if (!items.length) { article.append(el('p', 'empty', 'Nothing here yet. What is added with “add files” arrives here.')); return; }
  const wide = sizeSlider(), grid = el('div', 'thumbs');
  grid.style.setProperty('--card', cardSize() + 'px');
  for (const d of items) {
    const p = d.path, booky = !!d.book || isPdf(p), to = d.book ? bookTarget(d) : p, t = el('div', 'thumb ' + (booky ? 'book' : 'unit'));
    t.dataset.path = to;
    t.tabIndex = 0;
    t.setAttribute('role', 'button');
    t.title = p + (isPending(p) ? '\nwaiting to be sent' : '');
    if (isImage(p)) { const img = el('img'); img.loading = 'lazy'; img.alt = ''; img.onload = () => shapeCard(img); mediaSrc(p).then((src) => { img.src = src; }); t.append(img); }
    else if (isVideo(p) && playable(p)) { const still = videoThumb(p); still.addEventListener('loadedmetadata', () => shapeCard(still)); t.append(still); }
    else {
      const sign = el('i');
      sign.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">${KIND_ICONS[booky ? 'docs' : isAudio(p) ? 'audio' : isVideo(p) ? 'video' : d.links ? 'pics' : 'notes']}</svg>`;
      t.append(sign);
      if (booky) {
        t.fill = async () => {
          let pic = null;
          if (d.book) { const c = await bookCover(d.book), u = !c ? '' : net.online ? await mediaSrc(c) : await keptUrl(c); if (u) { pic = el('img'); pic.alt = ''; pic.onerror = () => pic.remove(); pic.src = u; } }
          else pic = await pdfThumb(p);
          if (pic && t.isConnected) sign.replaceWith(pic);
        };
        coverSeen.observe(t);
      }
    }
    t.append(el('b', '', d.book ? d.title : isBinary(p) ? showName(p) : d.title || p.split('/').pop()));
    if (booky) t.append(el('em', '', d.book ? 'EPUB' : 'PDF'));
    if (!d.book && !isPending(p)) t.append(keepBtn(p));
    const go = (e) => { const side = e.metaKey || e.ctrlKey || e.altKey; if (isAudio(to) && playable(to) && !side) askPlay(to); else openDoc(to, { pane, side }); };
    t.onclick = go;
    t.onkeydown = (e) => { if (e.key === 'Enter' && e.target === t) go(e); };
    grid.append(t);
  }
  article.append(wide, grid);
}
// `first`: the tile that is pressed until one has been chosen for this folder.
// `only`: a test that narrows what is counted and listed (a set's page lists its own files, not those of the folders in it).
function appendBrowse(article, pane, folder, first = null, key = 'browse:' + folder, only = null) {
  const inside = asItems(docs.filter((d) => !isFront(d.path) && inView(d) && (!folder || d.path.startsWith(folder + '/')))).filter((d) => !only || only(d));   // a book is one of them
  const box = el('div', 'browse'), tiles = el('div', 'tiles'), listing = el('div', 'listing');
  // On a folder's page only the kinds it has are offered; with one kind alone, that one and no "Everything".
  const has = KINDS.filter(([id, , test]) => id !== 'all' && inside.some((d) => test(d.path))).map(([id]) => id);
  const offered = (id) => !folder || (id === 'all' ? has.length > 1 : has.includes(id));
  // A folder with one kind of thing in it lists that, with no tile to press for it. One with several opens on what
  // it was left on, else on `first`, else (unless it is large) on everything: what is in a folder is seen on arriving.
  const lone = !!folder && has.length === 1;
  const chosen = () => {
    if (lone) return has[0];
    const c = state.browse && key in state.browse ? state.browse[key] : first ?? (folder && inside.length <= 400 ? 'all' : null);
    return c && !offered(c) ? (has.length === 1 ? has[0] : null) : c;
  };
  const draw = () => {
    const open = chosen();
    for (const t of tiles.children) t.setAttribute('aria-pressed', t.dataset.kind === open);
    listing.replaceChildren();
    const kind = KINDS.find((k) => k[0] === open);
    if (!kind) return;
    const files = inside.filter((d) => kind[2](d.path));
    // Everything is listed together unless "group by folder" is chosen: offered only where what is listed is in more folders than one.
    const spread = new Set(files.map((d) => folderOf(d.path))).size > 1, grouped = spread && !!state.grouped;
    if (spread) {
      const mode = el('button', '', grouped ? 'show all together' : 'group by folder');
      mode.style.cssText = 'border: 0; padding: 0; color: var(--accent); text-decoration: underline;';
      mode.onclick = () => { state.grouped = !grouped; save(); draw(); renderPlayers(); };
      listing.append(mode);
    }
    if (open === 'all' || open === 'media') {
      listing.append(sizeSlider());
    }
    const whereOf = (d) => (folderOf(d.path).slice(folder ? folder.length + 1 : 0) || 'here').replace(/\//g, ' / ');
    const section = (title, items, build) => { if (items.length) { if (title) listing.append(el('h5', '', title)); build(items); } };
    const rows = (items) => {
      let group = null;
      for (const d of items) {
        const where = whereOf(d);
        if (grouped && where !== group) { group = where; listing.append(el('h5', '', where)); }
        const row = el('div', 'item');
        row.dataset.path = d.path;
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.append(el('span', '', isBinary(d.path) ? showName(d.path) : titleOf(d)));
        if (!grouped && where !== 'here') row.append(pathLabel(where));
        if (kept.has(d.path)) row.append(el('small', '', 'on this device'));
        if (isAudio(d.path) || isVideo(d.path)) row.append(keepBtn(d.path), queueBtn(d.path));   // keep a copy on this device; line it up
        row.onclick = (e) => (isAudio(d.path) && playable(d.path) && !(e.metaKey || e.ctrlKey || e.altKey) ? askPlay(d.path) : openDoc(d.path, { pane, side: e.metaKey || e.ctrlKey || e.altKey }));
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
        t.append(el('b', '', showName(d.path)), keepBtn(d.path));
        t.onclick = (e) => openDoc(d.path, { pane, side: e.metaKey || e.ctrlKey || e.altKey });
        grid.append(t);
      }
      listing.append(grid);
    };
    // Books (and PDFs, which are books too) are shown as a shelf: each a card with its cover, pressed to open it.
    const isBook = (d) => !!d.book || isPdf(d.path);
    const shelf = (items) => {
      const grid = el('div', 'thumbs');
      grid.style.setProperty('--card', cardSize() + 'px');
      for (const d of items) {
        const t = el('div', 'thumb book'), to = d.book ? bookTarget(d) : d.path, sign = el('i');
        t.dataset.path = to;
        t.tabIndex = 0;
        t.setAttribute('role', 'button');
        t.title = d.book ? d.title : d.path;
        sign.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">${KIND_ICONS.docs}</svg>`;
        t.append(sign, el('b', '', d.book ? d.title : d.path.split('/').pop().replace(/\.pdf$/i, '')), el('em', '', d.book ? 'EPUB' : 'PDF'));   // which form of the book: it may be here as both
        if (!d.book) t.append(keepBtn(d.path));
        // Its cover: fetched and drawn when the card comes into sight, one card at a time.
        t.fill = async () => {
          let pic = null;
          if (d.book) {
            const p = await bookCover(d.book), u = !p ? '' : net.online ? await mediaSrc(p) : await keptUrl(p);
            if (u) { pic = el('img'); pic.alt = ''; pic.onerror = () => pic.remove(); pic.src = u; }
          } else pic = await pdfThumb(d.path);
          if (pic && t.isConnected) sign.replaceWith(pic);
        };
        coverSeen.observe(t);
        t.onclick = (e) => openDoc(to, { pane, side: e.metaKey || e.ctrlKey || e.altKey });
        grid.append(t);
      }
      listing.append(grid);
    };
    const papers = (d) => !isMedia(d.path) && !d.links && !isBook(d);
    if (open === 'all') {
      section('Pictures and video', files.filter((d) => isImage(d.path) || isVideo(d.path)), thumbs);
      section('Music', files.filter((d) => isAudio(d.path)), rows);
      section('Saved links', files.filter((d) => d.links), linkCards);
      section('Books', files.filter(isBook), shelf);
      section('Documents', files.filter(papers), rows);
    } else if (open === 'media') thumbs(files);
    else if (open === 'docs' && files.some(isBook)) {
      const rest = files.filter((d) => !isBook(d));
      section(rest.length ? 'Books' : '', files.filter(isBook), shelf);
      section('Documents', rest, rows);
    } else rows(files);
    if (!files.length) listing.append(el('p', 'empty', 'Nothing of this kind here yet.'));
  };
  for (const [id, label, test] of KINDS) {
    if (!offered(id) || lone) continue;
    const n = inside.filter((d) => test(d.path)).length;
    const t = el('button', 'tile');
    t.dataset.kind = id;
    t.disabled = !n;
    t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`;
    t.append(el('span', '', label), el('small', '', String(n)));
    t.onclick = () => { state.browse = { ...(state.browse || {}), [key]: chosen() === id ? null : id }; save(); draw(); };
    tiles.append(t);
  }
  // The main front page has the tiles large, across the page. A folder's page has them small, at the right beside
  // its description, so what is in the folder comes sooner.
  if (folder && article.querySelector('h1')) { tiles.classList.add('small'); if (tiles.children.length) article.querySelector('h1').after(tiles); box.append(listing); }
  else box.append(tiles, listing);
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
  if (href.startsWith('#')) { e.preventDefault(); return jumpTo(pane, decodeURIComponent(href.slice(1))); }
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
    if (view.focus && v.dress) frameHere(v, v.surface.ownerDocument.elementFromPoint(w.innerWidth / 2, w.innerHeight * 0.35));   // a book's page: the block at the reading line
    top = 0;
    scrolled = w.scrollY;
    room = v.surface.ownerDocument.documentElement.scrollHeight - w.innerHeight;
  } else return;
  v.bar.style.width = (room > 0 ? Math.round((scrolled / room) * 100) : 100) + '%';
  let cur = v.heads[0] || null;
  for (const h of v.heads) { if (h.getBoundingClientRect().top - top < 48) cur = h; else break; }
  if (cur === v.cur) return;
  v.cur = cur;
  if (pane === state.active) { markOutline(); renderContext(); noteWhere(); }
}

// ---- where was I ---------------------------------------------------------------------
// Where the reader was (the document and the section being read) and the last note made, said on the main front page
// and, on coming back after a while (the reader opened again, or brought to the front after two hours or more), in a
// small card over the page that closes by itself. What is in a locked folder is not named.
function noteWhere() {
  const path = activeDoc(), d = docOf(path);
  if (!d || d.front || gateOf(path)) return;
  const cur = views[state.active]?.cur;
  store.set('where:' + config.root, { path, slug: cur?.dataset?.slug || '', text: (cur?.textContent || '').trim().slice(0, 120), ts: Date.now() });
}
function ago(ms) {
  const s = (Date.now() - ms) / 1000, h = Math.round(s / 3600), d = Math.round(s / 86400);
  return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' minutes ago' : s < 86400 ? (h === 1 ? 'an hour ago' : h + ' hours ago') : d === 1 ? 'yesterday' : d < 14 ? d + ' days ago' : new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function whereParts(at = store.get('where:' + config.root)) {
  const parts = [], d = at && docOf(at.path);
  if (d && !d.front && !gateOf(at.path)) {
    const where = titleOf(d) + (at.text && at.text !== d.title ? ' › ' + at.text : '');
    parts.push({ label: 'You were reading', what: where, when: at.ts, button: 'Go there', go: () => openDoc(at.path, { hash: at.slug || undefined }) });
  }
  const last = notes.filter((n) => docOf(n.doc) && !gateOf(n.doc) && (n.text || n.quote)).reduce((a, n) => (!a || n.ts > a.ts ? n : a), null);
  if (last) parts.push({ label: last.text ? 'Your last note' : 'Your last highlight', what: '“' + clip(last.text || last.quote, 110) + '” · ' + titleOf(docOf(last.doc)), when: Date.parse(last.ts), button: 'Show it', go: async () => { await openDoc(last.doc); showNote(last.id); } });
  return parts;
}
function whereRow(part, close) {
  const row = el('div', 'whereRow'), go = el('button', '', part.button);
  go.type = 'button';
  go.onclick = () => { close?.(); part.go(); };
  const words = el('div', 'words');
  words.append(el('small', '', part.label + (part.when ? ' · ' + ago(part.when) : '')), el('div', 'what', part.what));
  row.append(words, go);
  return row;
}
let whereCard = null;
function showWhereWas(at) {
  const parts = whereParts(at);
  if (!parts.length || docOf(activeDoc())?.front) return;   // the main front page says it already
  whereCard?.remove();
  const card = el('div', 'whereCard'), x = el('button', 'x', '×'), close = () => { card.remove(); if (whereCard === card) whereCard = null; };
  card.setAttribute('role', 'status');
  x.type = 'button';
  x.title = 'Close';
  x.setAttribute('aria-label', 'Close');
  x.onclick = close;
  card.append(el('h5', '', 'Where was I'), x, ...parts.map((p) => whereRow(p, close)));
  $('work').append(card);
  whereCard = card;
  let timer = setTimeout(close, 30000);
  card.addEventListener('pointerenter', () => clearTimeout(timer));
  card.addEventListener('pointerleave', () => { clearTimeout(timer); timer = setTimeout(close, 10000); });
}
// When the reader was last in front of someone: kept, so coming back after a while can be told from a reload.
const AWAY = 2 * 3600e3;
let awaySince = 0;
const markSeen = () => store.set('seenAt:' + (config.root || ''), Date.now());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { awaySince = Date.now(); markSeen(); return; }
  if (awaySince && Date.now() - awaySince > AWAY && config.root) showWhereWas();
  awaySince = 0;
});
addEventListener('pagehide', markSeen);
setInterval(() => { if (!document.hidden && config.root) markSeen(); }, 60000);

function renderOutline() {
  const v = views[state.active];
  tocEl.innerHTML = '';
  // The label says which document the outline is of; cut short with … when it does not fit.
  const of = docOf(activeDoc()), name = of ? (of.front ? config.title : of.title) : '';
  $('tocLabel').textContent = 'Outline' + (name ? ' · ' + name : '');
  $('tocLabel').title = name;
  if (!v) return;
  const heading = (h, cls) => {
    const a = el('a', cls, h.textContent);
    a.head = h;
    a.href = '#' + (h.dataset?.slug || '');
    a.onclick = (e) => {
      e.preventDefault();
      leave(state.active);
      h.scrollIntoView();
      renderTabs(state.active);
      drawer(null);
      if (h.dataset?.slug) history.replaceState(null, '', '?doc=' + encodeURIComponent(activeDoc()) + '#' + h.dataset.slug);
    };
    tocEl.append(a);
  };
  // A page of a book: the outline is the book's, every chapter by name, with
  // this page's own headings under its chapter (one step in; a heading that
  // only repeats the chapter's name is left out).
  if (of && isBookPage(of.path)) {
    const book = of.path.slice(0, of.path.search(/\.epub\//i) + 5);
    $('tocLabel').textContent = 'Outline · ' + givenName(book).replace(/\.epub$/i, '');
    for (const d of docs) {
      if (!inBook(book, d.path) || !inView(d)) continue;
      const a = el('a', 'l1' + (d === of ? ' here' : ''), pageTitle(d));
      a.href = '?doc=' + encodeURIComponent(d.path);
      a.onclick = (e) => { e.preventDefault(); drawer(null); openDoc(d.path); };
      tocEl.append(a);
      if (d === of) for (const h of v.heads) if (h.textContent.trim() !== d.title.trim()) heading(h, 'l' + Math.min(3, Number(h.tagName[1]) + 1));
    }
    markOutline();
    if (!tocEl.querySelector('.active')) tocEl.querySelector('.here')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  for (const h of v.heads) heading(h, 'l' + h.tagName[1]);
  markOutline();
}
function markOutline() {
  const v = views[state.active];
  for (const a of tocEl.children) a.classList.toggle('active', !!a.head && a.head === v.cur);
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
  const v = views[state.active], of = docOf(activeDoc());
  dial.innerHTML = '';
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // A line of the dial: pressed while it is the one selected, it goes there; otherwise it comes to the centre.
  const line = (cls, text, go) => {
    const d = el('div', 'd ' + cls, text);
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.onclick = () => {
      if (d.classList.contains('sel')) { go(); closeDial(); }
      else d.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    };
    dial.append(d);
    return d;
  };
  let at = null;
  // A page of a book: as in the outline, the dial is the book's, every page by name, with this page's own headings
  // under it (one step in; a heading that only repeats the page's name is left out).
  if (v && of && isBookPage(of.path)) {
    const book = of.path.slice(0, of.path.search(/\.epub\//i) + 5);
    for (const d of docs) {
      if (!inBook(book, d.path) || !inView(d)) continue;
      const page = line('l1', pageTitle(d), () => { if (d !== of) openDoc(d.path); else (v.article || v.surface)?.scrollIntoView(); });   // the page being read: back to its top
      if (d !== of) continue;
      at = page;
      for (const h of v.heads) {
        if (h.textContent.trim() === d.title.trim()) continue;
        const mine = line('l' + Math.min(3, Number(h.tagName[1]) + 1), h.textContent, () => h.scrollIntoView());
        if (h === v.cur) at = mine;
      }
    }
  } else if (v) for (const h of v.heads) { const mine = line('l' + h.tagName[1], h.textContent, () => h.scrollIntoView()); if (h === v.cur) at = mine; }
  if (!dial.children.length) dial.append(el('div', 'none', 'No headings in this document.'));
  dial.hidden = false;
  tocBtn.setAttribute('aria-expanded', 'true');
  at?.scrollIntoView({ block: 'center', behavior: 'auto' });
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
  paintCoverBtn();
  for (const sum of treeEl.querySelectorAll('summary[data-folder]')) paintQuick(sum);
  for (const row of treeEl.querySelectorAll('.file')) {
    const book = row.dataset.book;   // a book's line stands for every page in it
    row.classList.toggle('active', book ? inBook(book, activeDoc()) : row.dataset.path === activeDoc());
    row.classList.toggle('open', state.panes.some((p) => (book ? p.tabs.some((t) => inBook(book, t)) : p.tabs.includes(row.dataset.path))));
  }
  for (const sum of treeEl.querySelectorAll('.leaf > summary')) {
    sum.classList.toggle('active', inLine(sum, activeDoc()));
    sum.classList.toggle('open', state.panes.some((p) => p.tabs.some((t) => inLine(sum, t))));
  }
  treeEl.querySelector('.file.active, summary.active')?.scrollIntoView({ block: 'nearest' });
  pendingQuote = '';
  activeHl = null;
  replyTo = null;
  hideFlyout();
  closeDial();
  renderOutline();
  renderContext();
  renderNotes(false);
  setTabTitle();
  const here = docOf(activeDoc());
  $('mTitle').textContent = here ? (here.front ? config.title : here.title) : config.title;
  $('mTools').hidden = !isPdf(activeDoc());
  $('mTools').setAttribute('aria-pressed', !!state.pdfTools);
  if (activeDoc()) history.replaceState(null, '', '?doc=' + encodeURIComponent(activeDoc()));
  noteWhere();
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
  paintFav();
  paintBareWhere();
  c.textContent = '';
  if (!d) return c.append('Open a document to take notes on it.');
  const to = replyTo && notes.find((n) => n.id === replyTo);
  if (replyTo && !to) replyTo = null;
  const hl = hlNote();
  if (to) {
    const x = el('button', '', '×');
    x.type = 'button';
    x.title = 'Stop replying';
    x.onclick = () => { replyTo = null; renderContext(); };
    const said = (to.text || to.reply || to.quote || '').replace(/\s+/g, ' ').trim();
    c.append('Replying to ', x, el('b', '', '“' + (said.length > 80 ? said.slice(0, 80) + '…' : said) + '”'));
  } else if (hl) {
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
    x.onclick = () => { pendingQuote = ''; dropPendingMg(); renderContext(); renderNotes(false); };
    c.append('On: ', x, el('b', '', '“' + pendingQuote + '”'));
  } else {
    const cur = views[state.active].cur;
    c.append('In: ', el('b', '', (d.front ? 'Front page' : titleOf(d)) + (cur && cur.textContent !== d.title ? ' › ' + cur.textContent : '')), '  · select text to pin the note to it');
  }
}

// ---- notes ---------------------------------------------------------------------
// A note being replied to (its id): the note box then writes a reply, shown under it in the notes, in its thread.
let replyTo = null;
function replyToNote(id) {
  replyTo = id;
  activeHl = null;
  pendingQuote = '';
  dropPendingMg();
  hideFlyout();
  renderContext();
  markActive();
  input.focus();
}
async function loadNotes() {
  // While changes are still waiting to be sent, this device's copy is the newer one.
  if (!outbox.some((op) => op.kind !== 'file')) {
    try { notes = await api('/api/notes'); seeStamps(notes); saveLocal(); }
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
  const hl = hlNote(), to = replyTo && notes.find((n) => n.id === replyTo);
  replyTo = null;
  if (to) await noteOp({ kind: 'add', note: makeNote({ doc: to.doc, text, replyTo: to.id, heading: to.heading, headingText: to.headingText }) });
  else if (hl && !hl.text) await noteOp({ kind: 'set', id: hl.id, fields: { text } });
  else if (hl) await noteOp({ kind: 'add', note: makeNote({ doc: hl.doc, text, quote: hl.quote, type: hl.type, heading: hl.heading, headingText: hl.headingText, ...(hl.anchor ? { anchor: hl.anchor } : {}) }) });
  else await createNote(text);
  pendingQuote = '';
  dropPendingMg();
  activeHl = null;
  renderContext();
  await loadNotes();
  if (!state.notesOpen) setNotesOpen(true);
  notesEl.lastElementChild?.scrollIntoView({ block: 'nearest' });
};
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
  if (e.key === 'Escape') { endRefs(); if (replyTo) { replyTo = null; renderContext(); } }
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
const REF_TARGETS = '#found .hit[data-path], #found .hit[data-id], #tree summary[data-folder], #tree .file[data-path], .listing .item[data-path], .thumb[data-path], .track[data-path], #toc a, #notes .note[data-id], .latest .tick[data-id]';
const REF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
const refWatch = new MutationObserver(() => paintRefs());   // lists are redrawn while the buttons are showing
// What an item on the page is, as a label and a target to open: a file, a heading, a note or highlight.
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/').replace(/\(/g, '%28').replace(/\)/g, '%29');
const refLabel = (s) => { const t = s.replace(/[\[\]\s]+/g, ' ').trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t; };
function refParts(node) {
  const label = refLabel;
  if (node.dataset.id) {
    const n = notes.find((x) => x.id === node.dataset.id);
    return n ? { label: label(n.text || n.quote) || 'note', target: `${encPath(n.doc)}#note:${n.id}` } : null;
  }
  if (node.matches('#toc a')) {
    const d = activeDoc(), slug = (node.getAttribute('href') || '').slice(1);
    return d ? { label: label(node.textContent) || 'heading', target: encPath(d) + (slug ? '#' + slug : '') } : null;
  }
  if (node.dataset.folder) return { label: label(node.dataset.folder.split('/').pop()) + '/', target: encPath(node.dataset.folder) + '/' };   // a folder: its path, ending in "/"
  const path = node.dataset.path, d = docOf(path);
  return { label: label(d && !isMedia(path) ? (d.front ? config.title : d.title) : path.split('/').pop()), target: encPath(path) + (node.dataset.hash ? '#' + node.dataset.hash : '') };
}
function refTo(node) {
  const p = refParts(node);
  return p ? `[${shownLabel(p)}](${p.target})` : '';
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
// One group is there for the asking, "#fav": the button over the note box puts what is open in it (or the highlight
// being worked on), in one press, and takes it out again. It is a group like any other, and nothing is in one group
// only: what is in #fav can be picked into others later, and stays in both. What is in it is listed on the main
// front page, under the latest notes.
let groups = [];
const pick = { on: false, items: [] };
const FAV = 'fav';
const favGroup = () => groups.find((g) => g.tag === FAV);
const saveGroups = () => { store.set('groups:' + config.root, groups); paintFav(); renderLatest(); };
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
// The groups there are already are offered under the name, as marks to press: five, the most recently made or added
// to first; once something is typed, the five whose names have it in them (those that begin with it first). Pressing
// one writes its name, so what is picked joins that group. (The reader's own list, a browser's being hard to count on, on a phone least of all.)
pickName.autocomplete = 'off';
const pickHints = el('div', 'tags');
function paintHints() {
  const typed = pickName.value.replace(/^#+/, '').trim().replace(/\s+/g, '-').toLowerCase();
  const has = [...recentGroups(), ...(favGroup() ? [] : [{ tag: FAV, items: [] }])].filter((g) => g.tag.toLowerCase().includes(typed));   // #fav is always offered
  const list = [...has.filter((g) => g.tag.toLowerCase().startsWith(typed)), ...has.filter((g) => !g.tag.toLowerCase().startsWith(typed))].slice(0, 5);
  pickHints.replaceChildren(...list.map((g) => {
    const same = g.tag.toLowerCase() === typed, b = el('button', 'tag', '#' + g.tag);
    b.type = 'button';
    b.append(el('small', '', ' ' + g.items.length));
    b.setAttribute('aria-pressed', same);
    b.title = same ? 'What is picked joins this group' : 'Add to this group: writes its name';
    b.onclick = () => { pickName.value = g.tag; paintHints(); pickName.focus(); };
    return b;
  }));
  pickHints.hidden = !list.length;
  const joins = groups.find((g) => g.tag.toLowerCase() === typed);
  pickSave.textContent = joins ? 'add to it' : 'save';
}
pickName.addEventListener('input', paintHints);
// Most recently made or added to, first. (A group from before this was kept has no time: those follow, the last made first.)
const recentGroups = () => groups.map((g, i) => [g, i]).sort(([a, i], [b, j]) => (b.ts || 0) - (a.ts || 0) || j - i).map(([g]) => g);
pickBar.append(pickCount, el('b', '', '#'), pickName, pickSave, pickStop, pickHints);
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
  paintFav();
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
  paintHints();
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
  paintFav();
  for (const b of document.querySelectorAll('.pickBtn')) b.remove();
}
function savePick() {
  const tag = pickName.value.replace(/^#+/, '').trim().replace(/\s+/g, '-');
  if (!tag) { pickName.focus(); return; }
  if (!pick.items.length) return;
  // A name already in use: the items join that group.
  const had = groups.find((g) => g.tag === tag);
  if (had) { for (const it of pick.items) if (!had.items.some((x) => x.target === it.target)) had.items.push(it); had.ts = Date.now(); }
  else groups.push({ tag, items: pick.items, ts: Date.now() });
  saveGroups();
  state.groupsOpen = [tag];   // listed this once, to see what was made
  save();
  endPick();
  renderTree();
  for (let i = 0; i < views.length; i++) if (docOf(state.panes[i]?.active)?.front) showDoc(i, null, true);   // the front page lists the groups
}
groupBtn.onclick = () => (pick.on ? endPick() : startPick());
const favBtn = el('button', '', '#' + FAV);
favBtn.id = 'favBtn';
favBtn.type = 'button';
$('send').before(favBtn);
// What "#fav" is pressed for: the highlight or note being worked on, or else the document that is open.
function favItem() {
  const n = hlNote(), path = activeDoc(), d = docOf(path);
  if (n) return { label: refLabel(n.text || n.quote) || 'note', target: `${encPath(n.doc)}#note:${n.id}` };
  return d ? { label: refLabel(isMedia(path) ? path.split('/').pop() : d.front ? config.title : d.title), target: encPath(path) } : null;
}
function paintFav() {
  const item = favItem(), inIt = !!item && !!favGroup()?.items.some((x) => x.target === item.target);
  favBtn.disabled = pick.on ? !pick.items.length : !item;
  favBtn.setAttribute('aria-pressed', !pick.on && inIt);
  favBtn.title = pick.on ? 'Put what is picked in #fav' : !item ? 'Open something to put it in #fav' : inIt ? 'In #fav. Press to take it out.' : hlNote() ? 'Put this highlight in #fav' : 'Put what is open in #fav';
  favBtn.setAttribute('aria-label', favBtn.title);
}
favBtn.onclick = () => {
  if (pick.on) { pickName.value = FAV; savePick(); return; }   // while picking: what is picked goes in
  const item = favItem(), g = favGroup();
  if (!item) return;
  if (g?.items.some((x) => x.target === item.target)) { g.items = g.items.filter((x) => x.target !== item.target); if (!g.items.length) groups = groups.filter((x) => x !== g); }
  else if (g) { g.items.push(item); g.ts = Date.now(); }
  else groups.push({ tag: FAV, items: [item], ts: Date.now() });
  saveGroups();
  renderTree();
  for (let i = 0; i < views.length; i++) if (i !== state.active && docOf(state.panes[i]?.active)?.front) showDoc(i, null, true);   // a front page beside this one lists the groups
};
pickSave.onclick = savePick;
pickStop.onclick = endPick;
pickName.addEventListener('keydown', (e) => { if (e.key === 'Enter') savePick(); if (e.key === 'Escape') endPick(); });
// Every group on the main front page, the most recent first, under the latest searches and over the title: closed
// until pressed, like them. Pressing a group lists what is in it, there.
function appendTags(article) {
  if (!groups.length) return;
  const box = el('details', 'tags searches'), sum = el('summary', '', 'Groups'), chips = el('div', 'chips'), listing = el('div', 'listing');
  sum.append(el('small', '', ' · ' + groups.length));
  let open = null;
  const draw = () => {
    for (const c of chips.children) c.setAttribute('aria-pressed', c.dataset.tag === open);
    const g = groups.find((x) => x.tag === open);
    listing.replaceChildren(...(g ? g.items : []).map((item) => {
      const row = el('div', 'item');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.append(el('span', '', shownLabel(item)));
      row.onclick = (e) => openRef(item.target, e.metaKey || e.ctrlKey || e.altKey);
      return row;
    }));
  };
  for (const g of recentGroups()) {
    const c = el('button', '', '#' + g.tag);
    c.dataset.tag = g.tag;
    c.append(el('small', '', ' \u00b7 ' + g.items.length));
    c.onclick = () => { open = open === g.tag ? null : g.tag; draw(); };
    chips.append(c);
  }
  box.append(sum, chips, listing);
  const over = article.querySelector('details.searches');
  if (over) over.after(box); else article.prepend(box);
  draw();
}
// The groups, at the top of the file list.
function drawGroups(section) {
  if (!groups.length) return;
  // Every group is a small mark, #name and how many are in it, one after another on as many lines as they need.
  // What is in a group is listed only once its mark is pressed, under the marks; pressing it again, or another, puts the list away.
  const box = section(' group'), bar = el('div', 'tags'), open = state.groupsOpen || [];
  box.append(bar);
  for (const g of groups) {
    const on = open.includes(g.tag), mark = el('button', 'tag', '#' + g.tag);
    mark.append(el('small', '', ' ' + g.items.length));
    mark.setAttribute('aria-expanded', on);
    mark.title = on ? 'Put the list of what is in this group away' : `List the ${g.items.length} in this group`;
    mark.onclick = () => { state.groupsOpen = on ? [] : [g.tag]; save(); renderTree(); };
    bar.append(mark);
    if (!on) continue;
    const kids = el('div', 'kids');
    for (const item of g.items) {
      // What is in a locked folder is not named while the folder is locked; it is still in the group.
      let inFolder = '';
      try { inFolder = decodeURIComponent(item.target.split('#')[0]); } catch { /* as it is */ }
      if (inFolder && gateOf(inFolder)) continue;
      const row = el('div', 'file'), out = el('button', '', '\u00d7');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = shownLabel(item);
      out.title = 'Take out of this group';
      out.setAttribute('aria-label', out.title);
      out.onclick = (e) => { e.stopPropagation(); g.items = g.items.filter((x) => x !== item); if (!g.items.length) groups = groups.filter((x) => x !== g); saveGroups(); renderTree(); };
      row.append(el('span', 'name', shownLabel(item)), out);
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
    box.append(kids);
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
  if (path.endsWith('/') && cut < 0) return openFolder(path.slice(0, -1), side);
  if (!docOf(path)) return;
  await openDoc(path, { side, hash: id ? undefined : hash || undefined });
  if (id) showNote(id);
}
// A folder (in a group, or referred to in a note): its front page if it has one; otherwise it is opened in the file list and brought into view.
async function openFolder(folder, side) {
  if (docOf(frontOf(folder))) return openDoc(frontOf(folder), { side });
  const parts = folder.split('/'), starter = (config.starter || []).map((s) => s.replace(/\/$/, '')).includes(parts[0]);
  state.opened = [...new Set([...state.opened, starter ? ':starter' : ':cat:' + catOf(parts[0]), ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))])];
  save();
  renderTree();
  const sum = [...treeEl.querySelectorAll('summary[data-folder]')].find((s) => s.dataset.folder === folder);
  if (sum) { sum.scrollIntoView({ block: 'center' }); flash(sum); }
}
// Bring a note or highlight into view: its passage in the open document, and its entry in the notes.
function showNote(id) {
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  seekNote(n);
  if (n.quote) selectHighlight(id); else flash(notesEl.querySelector(`.note[data-id="${CSS.escape(id)}"]`));
}

// The passage a note is on, brought into view in the open document: its mark, its place on a PDF's page, or its heading.
function seekNote(n) {
  const v = views[state.active], mark = v.surface?.querySelector(`mark[data-note="${CSS.escape(n.id)}"]`);
  leave(state.active);   // back returns to where the reader was (see "Back")
  if (n.mg && v.pdfMarks) v.pdfMarks.show(n.id);
  else if (mark) flash(mark);
  else if (n.heading) goTo(state.active, n.heading);
  renderTabs(state.active);
}
// Where the words now selected are, as fields to add to a note: an anchor in a document's text, or the engine's on a
// PDF's page (with the page as its heading); {} if it cannot be worked out.
async function pendingPlace() {
  if (pendingMg) return pendingMg.fields().catch(() => ({}));
  const spot = pendingSpot();
  if (!spot) return {};
  const fields = { anchor: spot.anchor }, path = activeDoc(), article = pendingAt.article;
  // On a page of a book the engine's anchor goes with it, where the engine has this very text (see bookSpot).
  const at = views[state.active].surface === article ? bookSpot(article, path) : null;
  if (at) {
    const raw = ([node, offset]) => at.raw.starts.get(node) + offset;
    try {
      const doc = await at.rec.print, anchor = doc && (await at.rec.engine.createAnchor(at.unit, raw(spot.map.at[spot.start]), raw(spot.map.at[spot.start + spot.length - 1]) + 1));
      if (anchor) fields.mg = { doc, anchor };
    } catch { /* the reader's own anchor stands alone */ }
  }
  return fields;
}
// The selection on a PDF's page is done with (made into a highlight, or let go).
function dropPendingMg() { const m = pendingMg; pendingMg = null; m?.clear(); }
const laterNotes = perFrame(() => renderNotes(false));
// A note or highlight on the current selection (or, with no selection, on the
// section being read).
async function createNote(text) {
  const head = (pendingQuote && pendingHead) || views[state.active].cur;
  const note = makeNote({
    doc: activeDoc(), text, quote: pendingQuote, type: pendingQuote ? curType().id : '',
    heading: head?.dataset?.slug || '', headingText: head?.textContent || '',
    ...(await pendingPlace()),
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
  dropPendingMg();
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
  for (const v of views) v.pdfMarks?.paint();
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
  // Replies are shown under the note they answer, in its thread, oldest first; a reply to a reply goes in the same
  // thread. A reply whose note was removed stands on its own, and says so.
  const byId = new Map(mine.map((n) => [n.id, n]));
  const rootOf = (n) => { let r = n; for (let i = 0; r.replyTo && byId.has(r.replyTo) && i < 50; i++) r = byId.get(r.replyTo); return r; };
  const threads = new Map();
  for (const n of mine) { const r = rootOf(n); if (r !== n) { if (!threads.has(r.id)) threads.set(r.id, []); threads.get(r.id).push(n); } }
  for (const list of threads.values()) list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const top of mine) {
    if (rootOf(top) !== top) continue;
    for (const n of [top, ...(threads.get(top.id) || [])]) {
      const div = el('div', 'note' + (n === top ? '' : ' replyNote'));
      div.dataset.id = n.id;
      if (n.quote) {
        const q = el('div', 'quote', n.quote.length > 160 ? n.quote.slice(0, 160) + '…' : n.quote);
        if (n.type) q.style.borderLeftColor = typeOf(n.type).color;
        q.onclick = () => {
          drawer(null);
          seekNote(n);
          selectHighlight(n.id);
        };
        div.append(q);
      }
      if (n.id === activeHl) div.classList.add('on');
      if (lost.has(n.id)) div.classList.add('lost');
      if (n.text) div.append(noteText(n.text));

      const meta = el('div', 'meta');
      meta.append(new Date(n.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
      if (n.replyTo) meta.append(' · ', byId.has(n.replyTo) ? 'reply' : 'reply to a note that was removed');
      if (n.type) meta.append(' · ', typeOf(n.type).name);
      if (n.headingText) {
        const where = el('a', '', n.headingText);
        where.href = '#' + n.heading;
        where.onclick = (e) => { e.preventDefault(); seekNote(n); };
        meta.append(' · ', where);
      }
      if (pendingQuote) {
        const attach = el('button', '', n.quote ? 'move to selection' : 'attach selection');
        attach.onclick = async () => { await noteOp({ kind: 'set', id: n.id, fields: { quote: pendingQuote, ...(await pendingPlace()) } }); pendingQuote = ''; dropPendingMg(); renderContext(); loadNotes(); };
        meta.append(attach);
      }
      const answer = el('button', '', 'reply');
      answer.title = 'Write a reply to this, shown under it';
      answer.onclick = () => replyToNote(n.id);
      if (n.id === replyTo) div.classList.add('replying');
      const del = el('button', '', 'delete');
      del.onclick = async () => { if (del.textContent === 'delete') return (del.textContent = 'really delete?'); await noteOp({ kind: 'del', id: n.id }); loadNotes(); };
      meta.append(answer, del);
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
  }
  if (rehighlight) views.forEach((v, i) => (v.surface ? highlightAll(v.surface, state.panes[i].active) : v.pdfMarks?.place()));
  renderLatest();
}
// The latest notes and highlights from every document, newest first, beside
// the main front page. Pressing one opens its document at that passage.
const clip = (s, n) => { const t = s.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
function renderLatest() {
  const cut = clip;
  // At the top of the main front page: where the reader was, and the last note (see whereParts).
  for (const box of document.querySelectorAll('.latest.where')) {
    const parts = whereParts();
    box.hidden = !parts.length;
    box.replaceChildren(el('h5', '', 'Where you were'), ...parts.map((p) => whereRow(p)));
  }
  for (const box of document.querySelectorAll('.latest:not(.favs, .where)')) {
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
      row.append(el('div', 'meta', new Date(n.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + (n.replyTo ? ' · reply' : '') + ' · ' + titleOf(docOf(n.doc))));
      row.onclick = async () => { await openDoc(n.doc); showNote(n.id); };
      box.append(row);
    }
  }
  // Under it, what is in #fav, the last added first. Pressing one opens it.
  for (const box of document.querySelectorAll('.latest.favs')) {
    box.replaceChildren(el('h5', '', '#fav'));
    // What is in a locked folder is not named while the folder is locked; it is still in the group.
    const items = (favGroup()?.items || []).filter((item) => { try { return !gateOf(decodeURIComponent(item.target.split('#')[0])); } catch { return true; } }).reverse();
    if (!items.length) box.append(el('p', 'empty', 'Nothing yet. “#fav” over the note box adds what is open.'));
    for (const item of items) {
      const row = el('div', 'tick');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.append(el('div', 'said', shownLabel(item)));
      row.onclick = (e) => openRef(item.target, e.metaKey || e.ctrlKey || e.altKey);
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
// Where the text now selected is: { anchor, map, start, length } (the anchor to add to a note, and the place in the
// page's map it was worked out from); null if it cannot be worked out.
function pendingSpot() {
  const p = pendingAt, needle = pendingQuote.replace(/\s+/g, '');
  if (!p || !needle || !p.article.isConnected) return null;
  try {
    const map = textMap(p.article), point = p.article.ownerDocument.createRange();
    point.setStart(p.node, p.offset);
    point.collapse(true);
    // The first character at or after the start of the selection (the map is in page order).
    let lo = 0, hi = map.at.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (point.comparePoint(map.at[mid][0], map.at[mid][1]) < 0) lo = mid + 1; else hi = mid; }
    // What the browser gives as the selected text can differ a little from the page's text at that point.
    let start = map.flat.startsWith(needle, lo) ? lo : map.flat.indexOf(needle, Math.max(0, lo - needle.length));
    if (start < 0 || Math.abs(start - lo) > needle.length + 40) return null;
    const anchor = anchorAt(map, start, needle.length);
    return anchor ? { anchor, map, start, length: needle.length } : null;
  } catch { return null; }
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
  // On a page of a book the engine's word on where a highlight is comes first, where it has one (see placeBookMarks).
  const book = mine.some((n) => n.mg?.anchor) ? bookSpot(article, path) : null;
  const rawOf = (k) => book.raw.starts.get(map.at[k][0]) + map.at[k][1];
  const firstAt = (offset) => { let lo = 0, hi = map.at.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (rawOf(mid) < offset) lo = mid + 1; else hi = mid; } return lo; };
  for (const n of mine) {
    const at = book && n.mg?.anchor ? mgPlaces.get(n.id)?.at : null;
    if (at && at.unit === book.unit) {
      const start = firstAt(at.start), length = firstAt(at.end) - start;
      if (length > 0) { lost.delete(n.id); placed.push({ n, start, length }); continue; }
    }
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
  marginCounts(article, path);
  markActive();
  if (isBookPage(path) && mine.some((n) => n.mg?.anchor && mgPlaces.get(n.id)?.exact !== n.mg.anchor.quote?.exact)) placeBookMarks(article, path);   // a highlight the engine has not been asked about yet
}
// In the margin beside each paragraph that has notes written on it: how many (with the replies to them). A highlight
// with nothing written shows as its colour already and is not counted. The number is drawn by the style sheet from an
// attribute of the paragraph, not put into its text, so no highlight's place in the text moves. Pressing it opens the
// notes at them. Counted again whenever the highlights are drawn.
const COUNTED = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption';
function marginCounts(article, path) {
  for (const b of article.querySelectorAll('[data-notes]')) { delete b.dataset.notes; delete b.dataset.noteIds; }
  const said = new Set(notes.filter((n) => n.doc === path && n.text).map((n) => n.id));
  for (const n of notes) if (n.doc === path && n.replyTo && said.has(n.replyTo)) said.add(n.id);
  const at = new Map();   // paragraph -> the ids of the notes on it
  for (const m of article.querySelectorAll('mark[data-note]')) {
    const id = m.dataset.note;
    if (!said.has(id)) continue;
    const b = m.closest(COUNTED);
    if (!b || !article.contains(b) || b.closest('pre, table')) continue;   // a code block or a table scrolls, and would hide it
    if (!at.has(b)) at.set(b, new Set());
    at.get(b).add(id);
    for (const r of notes) if (r.replyTo === id && r.doc === path) at.get(b).add(r.id);
  }
  for (const [b, ids] of at) { b.dataset.notes = ids.size; b.dataset.noteIds = [...ids].join(' '); }
  if (article.countsWired) return;
  article.countsWired = true;
  article.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-notes]');
    if (!b || e.clientX < b.getBoundingClientRect().right - 2) return;   // the number sits past the paragraph's right edge
    e.preventDefault();
    e.stopPropagation();
    if (phone.matches) drawer('right'); else if (!state.notesOpen) setNotesOpen(true);
    const entries = b.dataset.noteIds.split(' ').map((id) => notesEl.querySelector(`.note[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
    entries[0]?.scrollIntoView({ block: 'nearest' });
    for (const d of entries) flash(d);
  }, true);
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
// Changes come in bursts (a folder of files uploaded, a notes file rewritten
// twice), and every list fetched means the server looks over the whole folder;
// on the board that takes a while. So changes are gathered for a quarter of a
// second and dealt with together, and while they keep coming (another device
// uploading a thousand files, one at a time) the list is fetched at most once
// every three seconds. During this page's own upload nothing is fetched: it
// fetches the list once at the end. Another workspace opened on the hub is
// said at once.
const changedFiles = new Set();
let changeTimer = 0, changesApplied = 0, uploading = false;
function onFileChange(e) {
  const said = JSON.parse(e.data);
  if (said.workspace) { if (said.workspace !== config.workspace) workspaceMoved(); return; }
  changedFiles.add(said.file);
  if (!changeTimer && !uploading) changeTimer = setTimeout(applyChanges, Math.max(250, changesApplied + 3000 - Date.now()));
}
async function applyChanges() {
  changeTimer = 0;
  changesApplied = Date.now();
  const files = [...changedFiles];
  changedFiles.clear();
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
$('moved').onclick = () => { location.href = '/'; };

(async function init() {
  // Private copies first: if they are encrypted, ask for the passphrase.
  if (local.start() === 'locked') await askUnlock();
  else await local.load();
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
  adoptLook();
  listen();
  loadWorkspaces();
  loadUploadLimit();
  const wasAt = store.get('where:' + config.root), awayFor = Date.now() - (store.get('seenAt:' + config.root) || Date.now());
  markSeen();
  refused = store.get('refused:' + config.root) || [];
  outbox = store.get('outbox:' + config.root) || [];
  loadQueue();
  loadGroups();
  pendingFiles = store.get('pending:' + config.root) || [];
  kept = new Set(((await idb.keys('docs')) || []).filter((k) => k.startsWith(config.root + '|')).map((k) => k.slice(config.root.length + 1)));
  if (kept.size || matchMedia('(display-mode: standalone)').matches) askDurable();
  setTimeout(catchUpParts, 8000);
  setTimeout(() => learnBookFronts().catch(() => {}).then(learnBookStarts), 5000);
  try { notes = outbox.some((op) => op.kind !== 'file') ? store.get('notes:' + config.root) || [] : await api('/api/notes'); seeStamps(notes); saveLocal(); }
  catch { notes = store.get('notes:' + config.root) || []; }
  await loadDocs();

  const saved = store.get('layout:' + config.root);
  if (saved?.panes?.length) state = { ...state, ...saved, opened: (saved.opened || []).filter((k) => k.startsWith(':cat:')), groupsOpen: [] };   // every folder, subfolder and group starts closed, whatever was open last time
  for (const p of state.panes) {
    p.tabs = p.tabs.filter(docOf);
    if (!p.tabs.includes(p.active)) p.active = p.tabs[0] || null;
  }
  state.panes = state.panes.filter((p, i) => i === 0 || p.tabs.length).slice(0, 2);
  state.active = Math.min(state.active, state.panes.length - 1);
  if (!state.panes[0].tabs.length) {
    const first = docs.find((d) => d.front) || docs.find((d) => !d.side) || docs[0];
    if (first) state.panes[0] = { tabs: [first.path], active: first.path };
  }
  setNotesOpen(state.notesOpen);
  setSideOpen(state.sideOpen);
  renderTree();
  await buildPanes();

  const want = new URLSearchParams(location.search).get('doc');
  const hash = decodeURIComponent(location.hash.slice(1));
  if (want && docOf(want) && want !== activeDoc()) await openDoc(want, { hash });
  else { if (want && hash) goTo(state.active, hash); chrome(); }
  focusTree();   // the list starts short, at where you are
  renderNet();
  flush(); // anything left waiting from last time
  if (awayFor > AWAY) setTimeout(() => showWhereWas(wasAt), 1200);
})().catch(showProblem);
