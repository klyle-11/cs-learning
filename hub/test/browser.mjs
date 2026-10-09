// The reader in a browser: checks run against a hub of its own, on a scratch copy of the sample made under
// server-cpp/build/browser-test/ (ignored by git), never the live workspace. It needs the server built
// (cd server-cpp && make) and a Chrome, Edge or Chromium on this machine: playwright-core, a dev dependency, drives it
// and downloads nothing.
//
//   npm run test:browser                 every check (npm run test:browser:win on Windows)
//   node test/browser.mjs notes tabs     only those whose names start so
//
// HUB_TEST_BROWSER=<path> names the browser to use; otherwise Chrome, then Edge, then Playwright's own Chromium if one
// is installed. HUBD=<path> tests another copy of the server than server-cpp/hubd. HUB_TEST_PORT moves it off 4420.
// The scratch folder is left in place when a check fails, to look at.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), hubDir = resolve(here, '..'), repo = resolve(hubDir, '..');
const win = process.platform === 'win32';
const work = join(repo, 'server-cpp', 'build', 'browser-test'), ws = join(work, 'ws'), state = join(work, 'state'), spaces = join(work, 'workspaces');
const port = Number(process.env.HUB_TEST_PORT || 4420), base = `http://localhost:${port}`;
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

// ---- the scratch workspace ----------------------------------------------------------------
function prepare() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  cpSync(join(repo, 'sample'), ws, { recursive: true });
  mkdirSync(join(ws, 'notes'), { recursive: true });
  writeFileSync(join(ws, 'notes', 'notes.json'), '[]\n');
  // Folders three deep, for the file list.
  for (const f of ['shelf/notes-a/deep/inner.md', 'shelf/notes-a/deep/inner2.md', 'shelf/notes-a/one.md', 'shelf/notes-a/two.md', 'shelf/notes-b/x.md', 'shelf/notes-b/y.md', 'shelf/top.md']) {
    mkdirSync(dirname(join(ws, f)), { recursive: true });
    writeFileSync(join(ws, f), `# ${f.split('/').pop().replace('.md', '')}\n\nSome text to read in ${f}.\n`);
  }
  mkdirSync(join(ws, 'gonefolder', 'inner'), { recursive: true });
  writeFileSync(join(ws, 'gonefolder', 'FRONTPAGE.md'), '# Gone folder\n\nA folder to remove.\n');
  writeFileSync(join(ws, 'gonefolder', 'inner', 'a.md'), '# A\n\nText.\n');
  // What must not act: markup that tries to run, and a page with a script.
  writeFileSync(join(ws, 'attack.md'), '# Attack\n\n<img src="x" onerror="window.__ran = 1">\n\n<script>window.__ran = 2</script>\n\nPlain text after.\n');
  writeFileSync(join(ws, 'attack.html'), '<html><body><h1>Page</h1><script>parent.__ran = 3</script></body></html>\n');
  writeFileSync(join(ws, 'fonts.pdf'), pdfNeedingData());
}
// A one-page PDF whose text needs PDF.js's own data: a Symbol line, a Japanese line in a predefined CMap, a plain line.
function pdfNeedingData() {
  const objs = [];
  const add = (s) => objs.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'));
  const content = 'BT /F1 24 Tf 72 700 Td (abg) Tj ET BT /F2 24 Tf 72 640 Td <82a082a282a4> Tj ET BT /F3 18 Tf 72 580 Td (Plain words) Tj ET';
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 8 0 R >> >> >>');
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>');
  add('<< /Type /Font /Subtype /Type0 /BaseFont /MS-Mincho /Encoding /90ms-RKSJ-H /DescendantFonts [7 0 R] >>');
  add('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /MS-Mincho /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor << /Type /FontDescriptor /FontName /MS-Mincho /Flags 6 /FontBBox [0 -141 1000 859] /ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 700 /StemV 80 >> /DW 1000 >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]); });
  const xref = out.length;
  const table = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.concat([out, Buffer.from(table + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1')]);
}

// ---- the hub ------------------------------------------------------------------------------
let server;
async function startHub() {
  const hubd = process.env.HUBD || join(repo, 'server-cpp', win ? 'hubd.exe' : 'hubd');
  if (!existsSync(hubd)) throw new Error(`no server at ${hubd}: build it first (cd server-cpp && make)`);
  server = spawn(hubd, [ws, '--port', String(port), '--www', hubDir, '--state', state, '--workspaces', spaces], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.log = '';
  server.stdout.on('data', (d) => (server.log += d));
  server.stderr.on('data', (d) => (server.log += d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/')).ok) break; } catch { /* not yet */ }
    await new Promise((ok) => setTimeout(ok, 200));
  }
  // A second workspace, for the check that a page left on one does not write into the other.
  await fetch(base + '/api/upload?path=other.md&workspace=Other', { method: 'POST', body: '# Other place\n\nText.\n' });
}
const api = (path, method = 'GET', body) => fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }).then((r) => r.json());
const notesOnDisk = (dir = ws) => (existsSync(join(dir, 'notes', 'notes.json')) ? JSON.parse(readFileSync(join(dir, 'notes', 'notes.json'), 'utf8')) : []);
const openHome = async () => api('/api/workspace', 'POST', { root: (await api('/api/workspaces')).find((w) => w.home).root });

// ---- the browser --------------------------------------------------------------------------
async function launch() {
  const tries = [];
  if (process.env.HUB_TEST_BROWSER) tries.push({ executablePath: process.env.HUB_TEST_BROWSER });
  tries.push({ channel: 'chrome' }, { channel: 'msedge' }, {});
  for (const t of tries) {
    try { return await chromium.launch({ headless: true, ...t }); } catch { /* the next */ }
  }
  throw new Error('no browser found: install Chrome, or name one with HUB_TEST_BROWSER=<path>');
}
let browser;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const COMPUTER = { viewport: { width: 1300, height: 900 } };
// A page in a context of its own (its own storage). Its script errors are collected: any is a failure of the check.
async function page(t, opts = COMPUTER) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...opts });
  t.contexts.push(ctx);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => t.errors.push(e.message));
  return p;
}
const open = async (p, path, hash = '') => { await p.goto(base + '/?doc=' + encodeURIComponent(path) + hash); await p.waitForFunction(() => document.querySelector('#tree .file, #tree summary')); };
const until = (p, fn, arg, timeout = 8000) => p.waitForFunction(fn, arg, { timeout });
function check(t, ok, what) { t.done.push((ok ? 'ok    ' : 'FAIL  ') + what); if (!ok) t.failed = true; }
// The lines of the file list that can be seen (inside open folders, not put aside behind "Show N more").
const shownLines = (p) => p.evaluate(() => [...document.querySelectorAll('#tree summary, #tree .file')].filter((e) => {
  if (e.closest('[hidden]')) return false;
  for (let x = e.parentNode; x && x.id !== 'tree'; x = x.parentNode) if (x.tagName === 'DETAILS' && !x.open && !(e.tagName === 'SUMMARY' && e.parentNode === x)) return false;
  return true;
}).length);
const write = async (p, text) => { await p.fill('#input', text); await p.press('#input', 'Enter'); };
const savedLine = (p) => p.evaluate(() => document.getElementById('saved').textContent);

// ---- the checks ---------------------------------------------------------------------------
const checks = [
  ['starts', async (t) => {
    const p = await page(t);
    await p.goto(base + '/');
    await until(p, () => document.getElementById('hubTitle').textContent.length > 0);
    check(t, (await p.title()).length > 0, 'the reader starts, with a title');
  }],

  ['file list', async (t) => {
    const p = await page(t);
    await open(p, 'docs/02-data-structures/lru-cache.md');
    await until(p, () => document.querySelectorAll('#tree .moreRow').length >= 2);
    const lines = await shownLines(p);
    check(t, lines < 20, `the list opens short at the folder being read (${lines} lines)`);
    check(t, await p.evaluate(() => document.querySelectorAll('#tree .moreRow').length >= 2), 'the rest of each folder on the way is behind "Show N more"');
    await p.evaluate(() => [...document.querySelectorAll('#tree .moreRow')].find((m) => m.title.endsWith(' docs')).click());
    check(t, (await shownLines(p)) > lines, '"Show N more" brings the rest back');
  }],

  ['notes', async (t) => {
    const p = await page(t);
    await open(p, 'c-lessons-project/README.md');
    const text = 'A note from the browser test ' + Date.now();
    await write(p, text);
    await until(p, (s) => [...document.querySelectorAll('#notes .note')].some((n) => n.textContent.includes(s)), text);
    const parent = notesOnDisk().find((n) => n.text === text);
    check(t, !!parent?.stamps?.text, 'a note reaches the server, stamped');
    await p.evaluate((id) => [...document.querySelectorAll(`#notes .note[data-id="${id}"] .meta button`)].find((b) => b.textContent === 'reply').click(), parent.id);
    await write(p, 'A reply to it');
    await until(p, () => document.querySelector('#notes .note.replyNote'));
    check(t, notesOnDisk().some((n) => n.replyTo === parent.id), 'a reply is saved with the note it answers');
    check(t, (await savedLine(p)) === 'saved', 'the saved line says "saved"');
  }],

  ['outbox', async (t) => {
    const p = await page(t);
    await open(p, 'c-lessons-project/README.md');
    await p.route('**/api/notes', (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));
    const text = 'Written while the server would not take it ' + Date.now();
    await write(p, text);
    await until(p, () => /to send/.test(document.getElementById('saved').textContent));
    check(t, true, 'a note the server does not take waits ("to send")');
    await p.unroute('**/api/notes');
    await p.reload();
    await until(p, (s) => document.getElementById('saved').textContent === 'saved', null, 15000);
    check(t, notesOnDisk().some((n) => n.text === text), 'and is sent when the server is back');
  }],

  ['full storage', async (t) => {
    const p = await page(t);
    await open(p, 'c-lessons-project/README.md');
    await p.evaluate(() => { const chunk = 'x'.repeat(256 * 1024); try { for (let i = 0; ; i++) localStorage.setItem('junk' + i, chunk); } catch {} for (const size of [16384, 1024, 64, 1]) { try { for (let i = 0; ; i++) localStorage.setItem(`jnk${size}_${i}`, 'x'.repeat(size)); } catch {} } });
    await p.route('**/api/notes', (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));
    const text = 'Written with the small store full ' + Date.now();
    await write(p, text);
    await until(p, () => /to send/.test(document.getElementById('saved').textContent));
    await p.unroute('**/api/notes');
    await p.reload();
    await until(p, () => document.getElementById('saved').textContent === 'saved', null, 15000);
    check(t, notesOnDisk().some((n) => n.text === text), 'a note made with the small store full survives a reload and is sent');
  }],

  ['workspaces', async (t) => {
    const a = await page(t), ctx = a.context(), b = await ctx.newPage();
    b.on('pageerror', (e) => t.errors.push(e.message));
    await open(a, 'c-lessons-project/README.md');
    await b.goto(base + '/');
    await until(b, () => document.getElementById('workspace').options.length > 1);
    try {
      await b.selectOption('#workspace', { label: '↳ Other' });
      await until(a, () => !document.getElementById('moved').hidden);
      check(t, true, 'a page left on a workspace is told another was opened');
      var text = 'Meant for the first workspace ' + Date.now();
      await write(a, text);
      await until(a, () => /to send/.test(document.getElementById('saved').textContent));
      check(t, !notesOnDisk(join(spaces, 'Other')).some((n) => n.text === text) && !notesOnDisk().some((n) => n.text === text), 'its note goes into neither workspace, and waits');
    } finally { await openHome(); }   // the checks after this one read the first workspace
    await a.goto(base + '/');
    await until(a, () => document.getElementById('saved').textContent === 'saved', null, 15000);
    check(t, notesOnDisk().some((n) => n.text === text), 'and is sent into its own when that one is open again');
  }],

  ['removal', async (t) => {
    const p = await page(t);
    await open(p, 'gonefolder/FRONTPAGE.md');
    await until(p, () => [...document.querySelectorAll('button')].some((x) => /remove folder/.test(x.textContent)));
    await p.evaluate(() => [...document.querySelectorAll('button')].find((x) => /remove folder/.test(x.textContent)).click());
    await until(p, () => [...document.querySelectorAll('#gate button')].some((x) => x.textContent === 'Remove the folder'));
    await p.evaluate(() => [...document.querySelectorAll('#gate button')].find((x) => x.textContent === 'Remove the folder').click());
    await until(p, () => /was removed/.test(document.querySelector('#gate h2')?.textContent || ''));
    check(t, !existsSync(join(ws, 'gonefolder')), 'a removed folder leaves the workspace');
    await p.evaluate(() => [...document.querySelectorAll('#gate button')].find((x) => x.textContent === 'Put it back').click());
    await until(p, () => document.getElementById('gate').hidden);
    check(t, existsSync(join(ws, 'gonefolder', 'inner', 'a.md')), '"Put it back" returns it');
  }],

  ['tabs', async (t) => {
    const p = await page(t);
    const tabs = () => p.evaluate(() => [...document.querySelectorAll('.pane')].map((pane) => [...pane.querySelectorAll('.tab')].map((x) => (x.classList.contains('active') ? '*' : '') + x.textContent.replace('×', '').trim().slice(0, 6)).join('|')).join(' / '));
    const reveal = () => p.evaluate(() => { for (const d of document.querySelectorAll('#tree details')) d.open = true; for (const h of document.querySelectorAll('#tree [hidden]')) h.hidden = false; });
    await open(p, 'shelf/notes-a/one.md');
    await until(p, () => document.querySelector('#tree .file[data-path="shelf/notes-a/two.md"]'));
    await reveal();
    await p.evaluate(() => document.querySelector('#tree .file[data-path="shelf/notes-a/two.md"] .plus').click());
    await until(p, () => document.querySelectorAll('.pane .tab').length === 2);
    await reveal();
    await p.evaluate(() => document.querySelector('#tree .file[data-path="shelf/notes-a/one.md"]').click());
    await until(p, () => document.querySelector('.pane .tab.active')?.textContent.includes('one'));
    check(t, (await tabs()) === '*one|two', 'pressing what is open goes to its tab, and keeps the other');
    await reveal();
    await p.evaluate(() => document.querySelector('#tree .file[data-path="shelf/notes-b/x.md"] .sideBtn').click());
    await until(p, () => document.querySelectorAll('.pane').length === 2);
    await p.evaluate(() => document.querySelector('.pane').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await reveal();
    await p.evaluate(() => document.querySelector('#tree .file[data-path="shelf/notes-b/x.md"]').click());
    await p.waitForTimeout(800);
    check(t, (await tabs()) === '*one|two / *x', `and in the other pane (${await tabs()})`);
  }],

  ['book', async (t) => {
    const p = await page(t);
    let covers = 0;
    p.on('request', (r) => { if (/\/raw\/cs-learning\.epub\/.*\.(png|jpe?g|gif|svg)$/i.test(r.url()) && r.resourceType() === 'image') covers++; });
    await open(p, 'cs-learning.epub/EPUB/text/ch002.xhtml');
    const frameText = () => p.evaluate(() => { const f = [...document.querySelectorAll('iframe')].find((x) => x.srcdoc); return f?.contentDocument?.body?.innerText.length || 0; });
    await until(p, () => [...document.querySelectorAll('iframe')].some((x) => x.srcdoc && x.contentDocument?.body?.innerText.length > 100), null, 15000);
    check(t, (await frameText()) > 100, 'a page of a book is drawn from the engine');
    const was = covers;
    await p.keyboard.press('ArrowRight');
    await until(p, () => location.search.includes('ch003'));
    await p.waitForTimeout(1200);
    check(t, covers === was, 'turning the page does not fetch the cover again');
  }],

  ['pdf', async (t) => {
    const p = await page(t), asked = [];
    p.on('request', (r) => { if (r.url().includes('/vendor/pdfjs/')) asked.push(r.url()); });
    await open(p, 'fonts.pdf');
    await until(p, () => document.querySelector('.pdfpage canvas'), null, 15000);
    check(t, true, 'a PDF is drawn');
    await until(p, () => /Plain words/.test(document.querySelector('.pdftext')?.textContent || ''), null, 15000);
    check(t, true, 'its page carries its text for screen readers');
    check(t, asked.some((u) => u.includes('90ms-RKSJ-H')) && asked.some((u) => u.includes('FoxitSymbol')), 'PDF.js is given its character maps and typefaces');
  }],

  ['where was I', async (t) => {
    const p = await page(t);
    await open(p, 'c-lessons-project/README.md');
    await p.waitForTimeout(1500);
    await p.close();
    const q = await t.contexts[0].newPage();
    q.on('pageerror', (e) => t.errors.push(e.message));
    await q.addInitScript(() => { if (sessionStorage.getItem('aged')) return; sessionStorage.setItem('aged', '1'); for (const k of Object.keys(localStorage)) if (k.startsWith('seenAt:')) localStorage.setItem(k, JSON.stringify(Date.now() - 3 * 3600e3)); });
    await open(q, 'shelf/top.md');
    await until(q, () => document.querySelector('.whereCard'));
    check(t, /Lesson 01/.test(await q.evaluate(() => document.querySelector('.whereCard').innerText)), 'coming back after hours, a card says where you were');
  }],

  ['margin', async (t) => {
    const d = 'docs/02-data-structures/lru-cache.md';
    const n = await api('/api/notes', 'POST', { doc: d, heading: '1-why-this-matters', headingText: '1. Why this matters', quote: 'the classic eviction policy', text: 'Why LRU?' });
    await api('/api/notes', 'POST', { doc: d, text: 'A reply', replyTo: n.id });
    await api('/api/notes', 'POST', { doc: d, heading: '1-why-this-matters', headingText: '1. Why this matters', quote: 'Almost no one writes it' });
    const p = await page(t);
    await open(p, d, '#1-why-this-matters');
    await until(p, () => document.querySelector('.md [data-notes]'));
    const counts = await p.evaluate(() => [...document.querySelectorAll('.md [data-notes]')].map((b) => b.dataset.notes));
    check(t, counts.includes('2') && counts.length === 1, `a paragraph with a note and its reply shows 2, a bare highlight none (${counts})`);
  }],

  ['typefaces', async (t) => {
    const p = await page(t);
    const fonts = [];
    p.on('request', (r) => { if (r.url().includes('/vendor/fonts/')) fonts.push(r.url()); });
    await open(p, 'c-lessons-project/README.md');
    const before = fonts.length;
    await p.evaluate(() => document.getElementById('settingsBtn').click());
    await p.selectOption('#fontToggle', 'dyslexic');
    await until(p, () => [...document.fonts].some((f) => f.family.includes('OpenDyslexic') && f.status === 'loaded'));
    check(t, before === 0 && fonts.length > 0, 'a reading typeface is fetched only once chosen, and is used');
    await p.selectOption('#fontToggle', 'serif');   // as it was, for the checks after
  }],

  ['content cannot act', async (t) => {
    const p = await page(t);
    await open(p, 'attack.md');
    await until(p, () => /Plain text after/.test(document.querySelector('.md')?.textContent || ''));
    await p.waitForTimeout(500);
    check(t, (await p.evaluate(() => window.__ran)) === undefined, 'markup in a document does not run');
    const policy = (await fetch(base + '/raw/attack.html')).headers.get('content-security-policy') || '';
    check(t, /sandbox/.test(policy) && !/script-src/.test(policy.replace("script-src 'none'", '')), 'an HTML file is sent sandboxed, without scripts');
    await open(p, 'attack.html');
    await p.waitForTimeout(1500);
    check(t, (await p.evaluate(() => window.__ran)) === undefined, 'nor does an HTML page shown in the reader');
  }],
];

// ---- running them -------------------------------------------------------------------------
const run = checks.filter(([name]) => !only.length || only.some((o) => name.startsWith(o)));
let failed = 0;
try {
  prepare();
  await startHub();
  browser = await launch();
  console.log(`browser: ${browser.version()} | hub: ${base} on ${ws}`);
  for (const [name, fn] of run) {
    const t = { contexts: [], errors: [], done: [], failed: false };
    const started = Date.now();
    try { await fn(t); } catch (e) { t.failed = true; t.done.push('FAIL  ' + (e.message || e).split('\n')[0]); }
    if (t.errors.length) { t.failed = true; t.done.push('FAIL  page errors: ' + t.errors.join(' | ')); }
    for (const c of t.contexts) await c.close().catch(() => {});
    console.log(`${t.failed ? 'FAIL' : 'pass'}  ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    for (const line of t.done) console.log('        ' + line);
    if (t.failed) failed++;
  }
} catch (e) {
  console.error('could not run: ' + (e.message || e));
  failed = failed || 1;
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
console.log(failed ? `FAIL: ${failed} of ${run.length} checks (the scratch copy is in ${work})` : `PASS: ${run.length} checks`);
if (!failed) rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
