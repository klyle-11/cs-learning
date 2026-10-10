# Marginalia engine — integration brief for coding agents

You are adding the Marginalia document engine to a codebase. Read this whole
file before changing code. It is self-contained: the rules, the steps, tested
code for each host, the errors, and how to check your work. Method details
are in `API.md` (next to this file in the npm package and the Python wheel;
`docs/API.md` in the C SDK and in the source repository). The longer,
explanatory guide for people is `docs/INTEGRATION.md` in the repository.

## 0. What the engine does

It opens PDF and EPUB files and gives you, for each **unit** (a PDF page or an
EPUB chapter file, numbered from 0):

- the unit's plain **text**, and for PDFs a **box for every character** in page space;
- for EPUB, the chapter as **sanitized XHTML** whose text nodes concatenate to exactly that text;
- **search**, the **table of contents** mapped to positions, EPUB **front matter**;
- **anchors**: durable references to a span of text that re-attach after the text changes;
- an in-memory **annotation store** (highlights and notes) with last-writer-wins merge;
- a strict **note-link grammar** (`[label](ann:<id>)`, `[label](https://…)`);
- **OCR** for scanned PDF pages, producing the same text-with-boxes as native text.

The engine does **not** render pages, store anything, or provide UI. Your codebase
renders (e.g. pdf.js, PDFKit, the DOM), stores (database, IndexedDB, files)
and handles input. For the browser, the npm package also ships the reference
app's selection UI (double-tap a word, drag handles to change the range),
highlight layer and page themes (section 4). The engine reads files in place and holds only indexes and
what is being read.

## 1. Choose the package

| The codebase is… | Use | Install | Open | Offsets |
| --- | --- | --- | --- | --- |
| A web app (React, Vue, Svelte, plain JS…) | npm `marginalia-engine` | `npm install ./marginalia-engine-<v>.tgz` | `const engine = new Engine(); const summary = await engine.open(file)` | UTF-16 (JS string indices) |
| A Node service or script | npm `marginalia-engine/node` | same tarball | `const doc = openFile(path)` (sync) | UTF-16 |
| Rust | crate `marginalia` | `marginalia = { git = "https://github.com/klyle-11/grounds-cc", branch = "claude/marginalia" }` (or a `path`) | `Session::open_source(Arc::new(FileSource::open(path)?), Limits::default(), None, None)?` | chars |
| C, C++, Swift, Kotlin/JNI, C#, Go | C SDK `marginalia-sdk-<v>-<target>.tar.gz` | unpack; `pkg-config --cflags --libs marginalia` with `PKG_CONFIG_PATH=<sdk>/lib/pkgconfig` | `mg_open_path(path, NULL, utf16, &err)` | chars, or UTF-16 with `utf16 = true` |
| Python | wheel `marginalia_engine-<v>-py3-none-<platform>.whl` | `pip install <wheel>` | `Document.open(path)` | chars (Python `str` indices) |
| Shell, batch jobs | `bin/marginalia` in the C SDK | – | `marginalia search book.pdf "query"` | chars |

The packages are built from the repository with `sh scripts/package.sh` into
`target/packages/`; they are not on public registries. The C SDK and the wheel
are per operating system and CPU (build them on, or for, the target machine).
The npm package runs anywhere WebAssembly does.

## 2. Rules

Follow every rule. Each one prevents a specific, silent bug.

1. **Identity.** `summary.info.fingerprint` (SHA-256 hex of the file) identifies the document. Store everything (annotations, OCR layers, reading position) under it, and set every annotation's `doc` field to it. Never key by file name or path.
2. **Persistence is yours, and it comes first.** The engine's annotation store is in memory and is lost on close or crash. To save an annotation: write it to your storage, *then* call `upsert`. When a document opens: load its annotations from your storage and call `importAnnotations(fingerprint, annotations)` (npm) or `importJson` before drawing.
3. **One offset unit per session.** The npm package uses UTF-16 code units everywhere; Python and the C default use Unicode scalar values (chars). Pass offsets in the session's unit and use the ones you get back as they are. Do not convert offsets yourself. Offsets stored *inside* an `Anchor` are always chars and must not be edited.
4. **EPUB text identity.** Render `chapter.html` with an XML parser (`new DOMParser().parseFromString(html, 'application/xhtml+xml')`) and insert it unchanged. Do not add, remove, trim or merge text nodes, and do not let a framework re-render it. Then "number of UTF-16 units of text before a DOM point" equals the engine offset; `offsetOf` and `rangeFor` from `marginalia-engine/dom` compute it.
5. **PDF text identity.** Build selection, hit-testing and highlight drawing from the engine's `text` and `geometry` (or `offsetAtPoint`, `rects`). Never use the renderer's own text layer for offsets: its text differs from the engine's.
6. **No HTML injection.** Never assign document text, chapter HTML, titles or notes to `innerHTML`. Insert chapters as parsed DOM (rule 4) inside a shadow root, so publisher CSS can't reach your page. Render notes from parsed segments (`parse` in `marginalia-engine/notes`) as text nodes and links. External links come from `data-mg-external`: open them with `target="_blank" rel="noopener noreferrer"`.
7. **Files stay in place while open.** The engine reads the file as it goes. Keep the `File`/`Blob` or path valid until you close the document. If you know the fingerprint already, pass it (`open(file, { fingerprint })`) to skip hashing the whole file.
8. **Close what you open.** One `Engine` (one worker) per open document in the browser; call `close()` when the document's view is destroyed (React: in the effect cleanup). In Node, Python and C, `close()` / `mg_close`. WebAssembly memory is returned only when the worker ends.
9. **Errors have codes.** Branch on `error.code`, not on messages (section 6). In the browser, set `engine.onRestart` to re-import annotations and OCR layers: after a crash the engine restarts with the same file but an empty store.
10. **Configure bundlers; don't edit the package.** Vite needs `optimizeDeps: { exclude: ['marginalia-engine'] }` for the dev server. webpack 5 needs nothing. Strict CSP needs `script-src 'self' 'wasm-unsafe-eval'` and `worker-src 'self'`.
11. **Annotations must validate.** `id`: `[A-Za-z0-9_-]{1,128}` (use `crypto.randomUUID()`); `color`: `#rrggbb`; `created` and `updated`: milliseconds since the epoch, `updated ≥ created`; `kind`: `highlight`, `underline`, `strikeout` or `note`; `anchor`: exactly what `createAnchor` returned. To edit, keep `id` and `created`, set `updated` to `max(now, previous.updated + 1)`. To delete, store `deleted: true` (a tombstone), don't drop the record.
12. **OCR models are not bundled.** OCR needs `text-detection.rten` and `text-recognition.rten` (≈12 MB, from the ocrs project; `scripts/fetch-models.sh` downloads them). Serve them as static files or let the person choose not to use OCR.

## 3. Procedures

### P1 · Install and smoke-test

Do this first, before writing integration code. Each snippet must print the
expected line. Use any PDF or EPUB you have, such as `opening-lines.pdf` in
the repository's `app/public/samples/`.

**Node** (`smoke.mjs`, run with `node smoke.mjs book.pdf`):

```js
import { openFile, callStatic } from 'marginalia-engine/node';
const doc = openFile(process.argv[2]);
const s = doc.summary();
console.log(s.info.kind, s.units.length, 'units', s.info.fingerprint.slice(0, 12), 'engine', callStatic('version'));
doc.close();
```

Expected: `pdf 5 units 1a2b3c4d5e6f engine 0.1.0` (your numbers will differ).

**Browser** (any bundler; in a component or module):

```js
import { Engine, EngineError } from 'marginalia-engine';
const engine = new Engine();
try {
  const s = await engine.open(file);          // a File from <input type="file">, or a Blob
  console.log(s.info.kind, s.units.length);
} catch (e) {
  console.error(e instanceof EngineError ? e.code : e);
} finally {
  engine.close();
}
```

**Python**:

```python
from marginalia import Document
with Document.open("book.pdf") as doc:
    s = doc.call("summary")
    print(s["info"]["kind"], len(s["units"]), "units")
```

**C** (`cc smoke.c $(pkg-config --cflags --libs marginalia) -Wl,-rpath,<sdk>/lib`):

```c
#include <stdio.h>
#include "marginalia.h"
int main(int argc, char **argv) {
    char *err = NULL, *out = NULL;
    MgSession *s = mg_open_path(argv[1], NULL, false, &err);
    if (!s) { fprintf(stderr, "%s\n", err); mg_free_string(err); return 1; }
    mg_call(s, "summary", "{}", &out);
    printf("%.120s\n", out);
    mg_free_string(out);
    mg_close(s);
    return 0;
}
```

**Rust** (`Cargo.toml`: `marginalia = { git = "…", branch = "claude/marginalia" }`):

```rust
use std::sync::Arc;
use marginalia::core::{source::FileSource, Limits};
use marginalia::Session;

fn main() -> marginalia::core::Result<()> {
    let path = std::env::args().nth(1).expect("a PDF or EPUB");
    let s = Session::open_source(Arc::new(FileSource::open(&path)?), Limits::default(), None, None)?;
    println!("{:?} {} units", s.summary().info.kind, s.summary().units.len());
    Ok(())
}
```

### P2 · Read text and search

1. `summary()` → `units` (one per page/chapter), `info` (title, authors, fingerprint).
2. `sections()` → table of contents; each entry has `unit` and `offset` to jump to.
3. `text(unit)` (npm) / `call("unitText", {unit})` → `text`. For EPUB, `frontMatter()` lists leading cover/title/copyright units you may group or skip.
4. `search(query)` → hits with `unit`, `start`, `end`, `before`, `matched`, `after`.

### P3 · Create and save a highlight

```js
// unit, start, end: from a search hit or a user selection (P5), in UTF-16 units
const anchor = await engine.createAnchor(unit, start, end);
const now = Date.now();
const annotation = {
  id: crypto.randomUUID(), doc: summary.info.fingerprint, kind: 'highlight', color: '#ffd23f',
  anchor, note: 'optional text, may contain [links](ann:<id>)', created: now, updated: now,
};
await myStore.save(annotation);        // rule 2: your storage first
await engine.upsert(annotation);        // then the engine
const placed = await engine.placed();   // every annotation with its current position
```

Store the annotation object as it is (JSON). It is portable between hosts.

### P4 · Restore and draw highlights

On open: `await engine.importAnnotations(fingerprint, await myStore.list(fingerprint))`,
then `placed()`. For each `p` with `p.resolved` not null:

- **PDF:** `p.resolved.unit` is the page; `p.resolved.rects` are in PDF points.
  With pdf.js:

  ```js
  const vp = pdfPage.getViewport({ scale });
  for (const r of p.resolved.rects) {
    const [ax, ay, bx, by] = vp.convertToViewportRectangle([r.x0, r.y0, r.x1, r.y1]);
    drawBox(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));  // CSS px, page-relative
  }
  ```

- **EPUB:** build a DOM range and draw its client rects:

  ```js
  import { rangeFor } from 'marginalia-engine/dom';
  const range = rangeFor(chapterRoot, p.resolved.start, p.resolved.end);   // chapterRoot from P6
  for (const b of range?.getClientRects() ?? []) drawBox(b.left, b.top, b.width, b.height);  // viewport px
  ```

`OverlayLayer` from `marginalia-engine/selection` draws these boxes and finds
the highlight under a tap (P9). `p.resolved === null` means the text the
annotation pointed at is gone (orphaned): list it, don't draw it. `p.section` is the chapter title to group by.

### P5 · Turn a person's selection into engine offsets

In a browser, the simplest route is the packaged `SelectionEngine` (section 4,
P9 and P10): it reports ranges already in engine offsets. Otherwise:

- **PDF, with pdf.js:** convert the pointer to page space and ask the engine:
  `const [x, y] = vp.convertToPdfPoint(cssX, cssY); const offset = await engine.offsetAtPoint(unit, x, y);`
  Take two such offsets (press and release) as `start`/`end`. For drawing the
  live selection, `await engine.rects(unit, start, end)` gives page-space boxes.
  (`geometry(unit)` gives all character boxes at once as a `Float32Array`,
  4 numbers per UTF-16 unit, if you prefer to hit-test locally.)
- **EPUB:** read the DOM selection and convert both ends:

  ```js
  import { offsetOf } from 'marginalia-engine/dom';
  const sel = document.getSelection();
  const [r] = sel.getComposedRanges ? sel.getComposedRanges({ shadowRoots: [shadow] }) : [sel.getRangeAt(0)];
  const start = offsetOf(chapterRoot, r.startContainer, r.startOffset);
  const end = offsetOf(chapterRoot, r.endContainer, r.endOffset);
  ```

  `null` means the point is outside the chapter. Trim surrounding whitespace before `createAnchor`.

### P6 · Render an EPUB chapter

```js
import { invalidate } from 'marginalia-engine/dom';

const blobUrls = new Map();
async function resourceUrl(engine, path) {
  if (!blobUrls.has(path)) {
    const r = await engine.resource(path);
    blobUrls.set(path, URL.createObjectURL(new Blob([r.bytes], { type: r.mediaType })));
  }
  return blobUrls.get(path);
}

async function showChapter(engine, unit, host) {
  const ch = await engine.chapter(unit);
  const css = [...ch.styles];
  for (const p of ch.stylesheets) css.push(new TextDecoder().decode((await engine.resource(p)).bytes));
  const re = /url\("mg-res:((?:[^"\\]|\\.)*)"\)/g;
  for (let i = 0; i < css.length; i++) {
    for (const m of [...css[i].matchAll(re)]) {
      css[i] = css[i].replace(m[0], `url("${await resourceUrl(engine, m[1].replace(/\\(.)/g, '$1'))}")`);
    }
  }
  const parsed = new DOMParser().parseFromString(ch.html, 'application/xhtml+xml');
  if (parsed.getElementsByTagName('parsererror').length) throw new Error('chapter markup did not parse');
  const root = document.importNode(parsed.documentElement, true);          // <div data-mg-body>
  for (const el of root.querySelectorAll('[data-mg-src]')) {
    el.setAttribute(el instanceof SVGElement ? 'href' : 'src', await resourceUrl(engine, el.getAttribute('data-mg-src')));
  }
  for (const a of root.querySelectorAll('a[data-mg-external]')) {
    a.setAttribute('href', a.getAttribute('data-mg-external'));
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  // Internal links: a[data-mg-href="path#fragment"] → find the unit whose href is `path`
  // (summary.units[i].href) and navigate there; handle the click yourself.
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.replaceChildren(...css.map((c) => Object.assign(document.createElement('style'), { textContent: c })), root);
  invalidate(root);
  console.assert(root.textContent.length === ch.text.length, 'rule 4: DOM text must equal engine text');
  return { root, shadow, text: ch.text };
}
```

Revoke blob URLs (`URL.revokeObjectURL`) for chapters you no longer show.

### P7 · Scanned PDF pages (browser)

```js
import { OcrPool } from 'marginalia-engine/ocr';
const t = await engine.text(unit);
if (t.needsOcr && !t.ocr) {
  const base = page.getViewport({ scale: 1, rotation: 0 });
  const scale = Math.min(3, 2000 / Math.max(base.width, base.height));  // pixels per PDF point
  const vp = page.getViewport({ scale, rotation: 0 });
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.floor(vp.width), height: Math.floor(vp.height) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pool = new OcrPool({ det: '/models/text-detection.rten', rec: '/models/text-recognition.rten' });
  const lines = await pool.recognize(img.width, img.height, img.data);
  pool.terminate();
  await engine.applyOcrLines(unit, scale, lines);
  await myStore.saveOcr(fingerprint, unit, await engine.textChars(unit));  // restore later with setOcrLayer
}
```

Render unrotated (`rotation: 0`) and pass the same `scale`. Restore saved
layers on open with `engine.setOcrLayer(unit, layer)` before `placed()`.

### P8 · Notes with links

```js
import { parse, serialize, annotationTargets } from 'marginalia-engine/notes';
for (const seg of parse(annotation.note ?? '')) {
  if (seg.kind === 'text') container.append(seg.text);
  else if (seg.target.type === 'url') container.append(link(seg.label, seg.target.href));  // rel="noopener noreferrer"
  else container.append(chip(seg.label, () => openAnnotation(seg.target.id)));          // ann:<id>, any document
}
// Backlinks: index annotationTargets(note) when you save, query "which notes link to <id>".
```

To insert a link while editing, build segments and `serialize(segments)`;
never concatenate markup by hand.

## 4. Frontend (browser)

The engine has no UI, but the npm package ships the reference app's
reusable frontend pieces. Use them unless the codebase already has its own:

| Import | Gives you |
| --- | --- |
| `marginalia-engine/selection` | `SelectionEngine` (the app's own text selection, with drag handles), `pdfSurface` and `epubSurface` (connect it to your pages), `OverlayLayer` (draws highlights and finds the one under a tap), `trimRange`, `toLocal`, `wordAt` |
| `marginalia-engine/themes` | `Recolorer`, `pageJob`, `pdfjsToPx`, `PAGE_THEMES` (sepia, night and black PDF pages that keep their pictures); `EPUB_THEME_CSS`, `setEpubTheme`; `isDark` |
| `marginalia-engine/ui.css` | styles for the selection tint, the handles and the highlights; the `.mg-selectable` and `.mg-dark` classes |

They are plain DOM classes, with no framework. In React, Vue or Svelte,
create them in a mount effect from element refs and call `destroy()` /
`close()` in the cleanup. Never let the framework render inside the page and
chapter elements they manage.

### 4.1 Frontend rules

13. **Layout.** One scrolling element (the *scroller*) holds the document and has the class `mg-selectable`. Each PDF page and each EPUB chapter is its own element inside it, with `position: relative`, sized to what is drawn: the canvas, or the chapter's shadow host, fills it from the top-left. The selection layer and the highlight overlay are inserted inside that element, so they scroll with it and nothing repaints on scroll. Toolbars and the note composer live *outside* the scroller, so they never scroll away.
14. **Selections are in engine offsets.** `SelectionEngine` reports `{ unit, start, end }` in UTF-16 offsets into `engine.text(unit).text` (PDF) or `chapter.text` (EPUB). These are the npm package's units, so pass `trimRange(text, start, end)` straight to `createAnchor`.
15. **Pages are selectable once loaded.** A `pdfSurface` page needs its `text` and `geometry` from the engine, and an `epubSurface` chapter needs its `root` in the DOM (P6); until then, taps on it do nothing.
16. **The page list must be cheap to read.** `pdfSurface(() => pages)` and `epubSurface(() => chapters)` call the function on every pointer event. Return a collection you already hold (the pages currently drawn); never call the engine there.
17. **Redraw after layout changes.** After a zoom, rotation, resize or font change, give the page its new `viewport` object (or let the chapter reflow), redraw the highlights, and call `selection.render()`. Character boxes are cached per geometry and viewport object, so replace the viewport rather than mutating it.
18. **Recolor pixels, never filter them.** Don't use CSS `filter: invert()` or `hue-rotate()` for dark pages: they invert photographs too. PDF pages: `Recolorer` (P11). EPUB chapters: `EPUB_THEME_CSS` (P12).
19. **A selection stays in one unit.** It covers one PDF page or one EPUB chapter; dragging a handle onto another page stops at the edge of the first. To quote across pages, save two highlights and link them with a note (P8).

### 4.2 What the person can do

| Gesture | Result |
| --- | --- |
| Double-tap or double-click a word | Selects the word (word boundaries from `Intl.Segmenter`) |
| Long-press a word (touch, 450 ms) | Selects the word |
| Press and drag with a mouse | Selects from the press point to the pointer |
| Drag a handle | Moves that end; the handles swap when they cross; the view scrolls when the finger is within 56 px of the scroller's top or bottom edge |
| Arrow keys on a focused handle (`role="slider"`, in the tab order) | Moves that end by a character; with Shift, by a word |
| Single tap | After 300 ms (to tell it from a double tap) your `tap(x, y)` runs; return `true` if you handled it (opened a highlight), otherwise the selection clears |
| Touch drag on text | Scrolls, as usual |

`change(range)` runs on every step of a handle drag and once more when the
finger lifts, with `null` when the selection clears. Do only cheap work in it
(show or move a toolbar, set the quoted text). Create the anchor when the
person presses Save, from `selection.sel`. The handles are 44 px wide touch
targets, and while dragging they aim at the middle of the text line, not at
the point under the finger, so the finger doesn't hide the text. Buttons,
links, inputs and `[contenteditable]` in your own markup inside the scroller
are left to their own behaviour. Links inside EPUB chapters still receive their
clicks (handle internal ones as P6 says). The OS selection, the long-press callout and double-tap zoom are
off over `.mg-selectable`.

Restyle with CSS variables: `--accent` (handles), `--sel` (selection tint),
`--hl-opacity` and `--blend` (highlights), and `--surface` (the ring around a
note dot). Keep the handles at least 44 px wide.

### P9 · PDF reader: pages, selection, highlights, themes

A complete, tested pattern with pdf.js 4. `PdfReader` draws pages into
elements you create, makes them selectable, saves the selection as a
highlight, draws saved highlights, opens one on tap and applies page themes.

```js
import * as pdfjs from 'pdfjs-dist';
import { OverlayLayer, SelectionEngine, pdfSurface, trimRange } from 'marginalia-engine/selection';
import { Recolorer, isDark, pageJob, pdfjsToPx } from 'marginalia-engine/themes';
import 'marginalia-engine/ui.css'; // or link node_modules/marginalia-engine/dist/ui.css in your HTML
// Set pdfjs.GlobalWorkerOptions.workerSrc to your bundler's URL for 'pdfjs-dist/build/pdf.worker.min.mjs'.

/** pdf.js reads the file in ranges too (rule 7): the file is never loaded whole. */
class BlobRange extends pdfjs.PDFDataRangeTransport {
  constructor(blob, initial) {
    super(blob.size, initial);
    this.blob = blob;
  }
  requestDataRange(begin, end) {
    this.blob.slice(begin, end).arrayBuffer().then((b) => this.onDataRange(begin, new Uint8Array(b)), () => this.onDataRange(begin, null));
  }
}

export async function openPdfJs(file) {
  const initial = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  return pdfjs.getDocument({ range: new BlobRange(file, initial), rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true, isEvalSupported: false }).promise;
}

/** What PdfReader and EpubReader share: selection, saving, tapping highlights. */
class Reader {
  units = new Map(); // unit → the page or chapter as drawn (with its `overlay`)
  theme = null;      // null (as published), or PAGE_THEMES.sepia / .night / .black

  constructor(engine, summary, scroller, surface, { onSelect, onOpen }) {
    Object.assign(this, { engine, summary, scroller, surface });
    this.selection = new SelectionEngine(scroller, surface, {
      change: (range) => onSelect(range && this.surface.text(range.unit).slice(range.start, range.end)),
      tap: (x, y) => {
        const id = this.highlightAt(x, y);
        if (!id) return false; // not on a highlight: the selection clears
        onOpen(id);
        return true;
      },
    });
  }

  /** The id of the highlight under a viewport point, if any. */
  highlightAt(x, y) {
    for (const u of this.units.values()) {
      const r = u.element.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return u.overlay.hit(x - r.left, y - r.top)[0] ?? null;
    }
    return null;
  }

  /** Save the selection as a highlight. `save` writes it to your storage (rule 2). */
  async highlight(color, save) {
    const s = this.selection.sel;
    if (!s) return null;
    const { start, end } = trimRange(this.surface.text(s.unit), s.start, s.end);
    const now = Date.now();
    const annotation = {
      id: crypto.randomUUID(), doc: this.summary.info.fingerprint, kind: 'highlight', color,
      anchor: await this.engine.createAnchor(s.unit, start, end), created: now, updated: now,
    };
    await save(annotation);
    await this.engine.upsert(annotation);
    this.selection.clear();
    this.draw(await this.engine.placed());
    return annotation;
  }

  /** Draw `placed` (from engine.placed()) on the units that are shown. */
  draw(placed, selectedId = null) {
    for (const u of this.units.values()) {
      const mine = placed.filter((p) => p.resolved?.unit === u.unit);
      u.overlay.set(mine.map((p) => ({ annotation: p.annotation, boxes: this.boxes(u, p.resolved) })), selectedId);
    }
  }

  destroy() {
    this.selection.destroy();
  }
}

export class PdfReader extends Reader {
  recolorer = new Recolorer();

  constructor(engine, pdf, summary, scroller, events) {
    const pages = new Map();
    super(engine, summary, scroller, pdfSurface(() => pages.values()), events);
    this.units = pages;
    this.pdf = pdf;
  }

  /** Draw page `unit` into `el` (position: relative, in the scroller), `width` CSS px wide. */
  async show(unit, el, width) {
    const page = await this.pdf.getPage(unit + 1);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    Object.assign(el.style, { width: `${viewport.width}px`, height: `${viewport.height}px` });
    el.style.background = this.theme ? `rgb(${this.theme.bg.join(' ')})` : '#fff';
    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, transform }).promise;
    const t = await this.engine.text(unit);
    if (this.theme) {
      // Recolor before the canvas is shown (no white flash). If it fails, the page stays as published.
      const job = pageJob(this.theme, {
        images: t.images, lines: t.lines?.map((l) => l.bbox), ocr: t.ocr, needsOcr: t.needsOcr,
        pageBox: this.summary.units[unit].pageBox,
      }, pdfjsToPx(viewport, dpr));
      await this.recolorer.apply(canvas, job).catch((e) => console.warn('page theme failed', e));
    }
    const old = this.units.get(unit);
    old?.canvas.remove();
    if (old) old.canvas.width = old.canvas.height = 0; // give the pixels back now
    el.prepend(canvas);
    this.units.set(unit, {
      unit, element: el, viewport, canvas, text: t.text, geometry: await this.engine.geometry(unit),
      overlay: old?.overlay ?? new OverlayLayer(el),
    });
    this.selection.render(); // the selection may be on this page: redraw it at the new size
  }

  /** Stop drawing a page that scrolled far away (keep only nearby pages: 4.4). */
  hide(unit) {
    const p = this.units.get(unit);
    if (!p) return;
    p.canvas.remove();
    p.canvas.width = p.canvas.height = 0;
    p.overlay.el.remove();
    this.units.delete(unit);
    if (this.selection.sel?.unit === unit) this.selection.clear();
  }

  boxes(p, resolved) {
    return resolved.rects.map((r) => {
      const [ax, ay, bx, by] = p.viewport.convertToViewportRectangle([r.x0, r.y0, r.x1, r.y1]);
      return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
    });
  }

  /** Re-render the shown pages in a theme. Never recolor a recolored canvas: render again. */
  async setTheme(theme) {
    this.theme = theme;
    this.scroller.classList.toggle('mg-dark', isDark(theme));
    for (const p of [...this.units.values()]) await this.show(p.unit, p.element, p.viewport.width);
  }

  destroy() {
    super.destroy();
    this.recolorer.close();
  }
}
```

Using it:

```js
const engine = new Engine();
const summary = await engine.open(file);
const reader = new PdfReader(engine, await openPdfJs(file), summary, scroller, {
  onSelect: (quote) => showToolbar(quote),   // null: hide it
  onOpen: (id) => openNote(id),
});
for (let unit = 0; unit < summary.units.length; unit++) {   // a real reader shows only nearby pages (4.4)
  const el = scroller.appendChild(document.createElement('div'));
  el.style.cssText = 'position:relative;margin:8px auto';
  await reader.show(unit, el, Math.min(scroller.clientWidth - 16, 800));
}
await engine.importAnnotations(summary.info.fingerprint, await myStore.list(summary.info.fingerprint));
reader.draw(await engine.placed());
saveButton.onclick = () => reader.highlight('#ffd23f', (a) => myStore.save(a));
```

### P10 · EPUB reader: chapters, selection, highlights, themes

The same, with `showChapter` from P6 (put this class in the same module as
`Reader` above). Highlight boxes come from the DOM, so redraw them when the
chapter's layout changes (a `ResizeObserver` on the chapter element, or after
a font-size change).

```js
import { epubSurface, toLocal } from 'marginalia-engine/selection';
import { EPUB_THEME_CSS, setEpubTheme } from 'marginalia-engine/themes';

export class EpubReader extends Reader {
  constructor(engine, summary, scroller, events) {
    const chapters = new Map();
    super(engine, summary, scroller, epubSurface(() => chapters.values()), events);
    this.units = chapters;
  }

  /** Render chapter `unit` into `el` (position: relative, in the scroller). */
  async show(unit, el) {
    const host = el.querySelector(':scope > .chapter') ?? el.appendChild(Object.assign(document.createElement('div'), { className: 'chapter' }));
    const { root, shadow, text } = await showChapter(this.engine, unit, host); // P6
    shadow.append(Object.assign(document.createElement('style'), { textContent: EPUB_THEME_CSS }));
    setEpubTheme(host, this.theme);
    const old = this.units.get(unit);
    this.units.set(unit, { unit, element: el, shadow, root, text, overlay: old?.overlay ?? new OverlayLayer(el) });
    this.selection.render();
  }

  boxes(c, resolved) {
    return toLocal(this.surface.rects(c.unit, resolved.start, resolved.end), c.element);
  }

  /** Colors only: the text, its offsets and the highlights stay where they are. */
  setTheme(theme) {
    this.theme = theme;
    this.scroller.classList.toggle('mg-dark', isDark(theme));
    for (const c of this.units.values()) setEpubTheme(c.shadow.host, theme);
  }
}
```

### P11 · PDF page themes: what the recolorer does

`PdfReader.show` above already themes pages. To do it in your own renderer:

1. Render the page with pdf.js into a canvas that is **not yet in the document**, as usual.
2. `const t = await engine.text(unit)`, then build the job:
   `pageJob(theme, { images: t.images, lines: t.lines?.map((l) => l.bbox), ocr: t.ocr, needsOcr: t.needsOcr, pageBox: summary.units[unit].pageBox }, pdfjsToPx(viewport, dpr))`.
   `viewport` and `dpr` must be exactly the ones you rendered with (`dpr` is the scale in the `transform` you passed to `render`).
3. `await recolorer.apply(canvas, job)`, then show the canvas. One `Recolorer` per view; it runs in a worker (`OffscreenCanvas`), or on the calling thread where there is none. `recolorer.close()` when the view goes.

What happens to the pixels: paper becomes the theme's background and ink its
foreground, by luminance, so anti-aliased edges stay smooth. Colored ink
(links, colored headings, chart lines) gets the new lightness but keeps its
hue. **Pictures are left alone.** On a native page, `t.images` lists where
the engine saw images painted, in page space. A page whose largest image
covers more than 80% of it, or that needs or has OCR, is a **scan**: its one
big image is cut into 16 px tiles, and tiles that look like paper and ink are
recolored while tiles with mid-tones or color (photos, figures) are kept;
OCR line boxes always count as text. A custom theme is
`{ bg: [r, g, b], fg: [r, g, b] }`; "paper" means no theme (`null`).

When the theme changes, **render the page again** and recolor the fresh
canvas: recoloring loses information, so night → sepia from a night canvas is
wrong. Keep the old canvas on screen until the new one is ready. Give the
page element the theme's background (`rgb(${theme.bg.join(' ')})`), so
nothing flashes white while a page renders, and put `mg-dark` on the scroller
for dark themes (`isDark(theme)`): highlights then blend normally, because
`multiply` would make them invisible on a dark page.

### P12 · EPUB themes

EPUB chapters are themed with CSS, inside each chapter's shadow root, because
outside styles can't reach in (rule 6):

1. Append `EPUB_THEME_CSS` as the **last** `<style>` in the shadow root, after the publisher's styles.
2. `setEpubTheme(shadowHost, PAGE_THEMES.night)` turns it on, and `setEpubTheme(shadowHost, null)` turns it off. No re-render is needed.
3. Optional: set `--mg-link` on the host or an ancestor for link color (default: the ink color).

Text takes the theme's ink, publisher backgrounds are cleared, and borders are
tinted to match. Images, SVG and video are untouched. Only colors change, so
offsets, the selection and highlights are unaffected.

### 4.3 Check the frontend

Add these to the checklist in section 7:

- [ ] On a phone, or in Chrome's device emulation with touch: double-tap a word on a PDF page and in an EPUB chapter; both select the word, and two handles appear.
- [ ] Dragging the end handle onto a later word on the same line extends the selection to it; dragging it before the start handle swaps them.
- [ ] Save, then reload: the highlight is drawn over the same words. Zoom or resize: it still is.
- [ ] Tapping a highlight opens it, and tapping plain text clears the selection.
- [ ] Night theme on a PDF page with a photograph: the paper is dark, the text light, and the photograph keeps its colors. On a scanned page: the same.
- [ ] Highlights are visible on a night page (the scroller has `mg-dark`).
- [ ] Opening and closing a document twenty times leaves no extra workers (pdf.js, engine, recolorer) running.

### 4.4 Patterns from the reference app

Not packaged (they depend on the app's layout), but worth copying. Paths
are in the source repository.

- **Draw only what is near the screen.** Keep canvases for the pages within about a screen of the viewport and cap their total bytes (the app: 48 MB). Release a canvas by setting its `width` and `height` to 0, and cap device pixels per page (8 million), so zooming in renders at a lower resolution and scales up. Cache text and geometry for at most about 48 pages. `app/src/reader/pdf.ts` (`pump`, `paint`, `unitData`).
- **One EPUB chapter at a time**, with the next one prepared in the background, and blob URLs revoked for chapters that are gone. `app/src/reader/epub.ts`.
- **Composer above the on-screen keyboard.** iOS doesn't resize the layout for the keyboard, so measure `window.innerHeight - visualViewport.height - visualViewport.offsetTop` on the `visualViewport` resize and scroll events. Put it in a CSS variable that lifts the composer, and remove the listeners when the screen closes. `app/src/reader/reader.ts` (`keepComposerAboveKeyboard`).
- **Contents and table of contents.** `sections()` gives `unit` and `offset`. Navigate by showing the unit and scrolling the box of the character at `offset` to about a third of the way down the screen. Mark as current the last entry at or before the reading position (the unit and offset at the top of the screen). `app/src/reader/toc.ts`, `reader.ts` (`updateLocation`).
- **Focus mode.** Dim everything but the paragraph at a fixed reading line (CSS on a class, no DOM changes, so offsets are kept). `app/src/reader/epub.ts` (`.mg-focusing`).
- **Restart after a crash.** In `engine.onRestart`, re-import annotations and OCR layers, then redraw (`reader.draw(await engine.placed())`). `app/src/reader/reader.ts`.

## 5. Data shapes

`Summary { info: DocInfo, units: UnitInfo[], cover }`;
`UnitInfo { id, label, pageBox (PDF crop box, points), rotation, href (EPUB path), linear }`;
`UnitText { text, boxes?, lines?, ocr, needsOcr, images? }`;
`Section { id, title, level, parent, unit, offset, source }`;
`SearchHit { unit, start, end, before, matched, after }`;
`Anchor { unit (stable unit id), unitIndex, quote { exact, prefix, suffix }, position?, cfi?, rects? }`;
`Annotation { id, doc, kind, color, anchor, note?, tags?, created, updated, deleted? }`;
`Placed { annotation, resolved: { unit, start, end, score, method, rects } | null, section }`.
Full TypeScript declarations: `dist/types.d.ts` in the npm package; the
"Data types" section of `API.md`.

## 6. Errors

| `code` | Cause | Do |
| --- | --- | --- |
| `unsupported` | Not a PDF or EPUB, or EPUB-only method on a PDF | Show "only PDF and EPUB files" |
| `malformed` | Damaged file | Show "this file could not be read" |
| `encrypted` | Password or DRM | PDF: ask for a password and pass it to `open`; DRM: refuse |
| `limit_exceeded` | Hostile or enormous file | Treat as unreadable |
| `unreadable` | The file moved, was deleted, or access was revoked | Ask the person to add it again |
| `out_of_range`, `invalid`, `not_found` | Bug in the calling code | Fix the arguments (check unit counts, text lengths, record shape) |
| `crashed` | Engine trapped (npm) | `Engine` restarts itself; re-import in `onRestart`; `Document` (Node): restart the process or worker |
| `stale_build` | Worker or `.wasm` didn't load (npm) | Bundler config (rule 10), network, or stale deploy: reload |
| `closed` | Used after `close()` | Fix the lifecycle |
| `panic` | C/Python: internal error caught | Close and reopen the document |

## 7. Check your work

Before calling the integration done, verify each item and say how you did:

- [ ] P1's smoke test passes in the target codebase's real build (not only in a scratch project).
- [ ] A highlight saved, then the page/app reloaded: it reappears on the same words.
- [ ] Offsets survive non-ASCII text: select a word that comes *after* an emoji or other astral character; the anchor's `quote.exact` equals the selected words.
- [ ] EPUB: after rendering, the chapter root's `textContent.length === chapter.text.length`.
- [ ] Opening a `.txt` renamed to `.pdf` shows a message (code `unsupported` or `malformed`), and the app keeps working.
- [ ] Closing a document closes its `Engine` (no worker left running: DevTools → Sources → threads, or `performance.memory` stable over repeated open/close).
- [ ] No `innerHTML` with document or note content anywhere in the change.
- [ ] Production build works with the codebase's CSP.

## 8. Common mistakes

- Using pdf.js's text layer (or `getTextContent`) for offsets → highlights drift. Use the engine (rule 5).
- Rendering `chapter.html` with `innerHTML` or a framework's HTML binding → whitespace and entities change the text; offsets drift and it is unsafe (rules 4, 6).
- Storing annotations only in the engine → lost on reload (rule 2).
- Keying data by file name → duplicates and lost notes after a rename (rule 1).
- Converting UTF-16 ↔ code points by hand → off-by-one after emoji (rule 3).
- Creating a new `Engine` per call, or never closing it → memory grows (rule 8).
- Vite dev server shows `stale_build` → add `optimizeDeps.exclude` (rule 10).
- Editing `Anchor` fields → resolution fails or lands on the wrong text. Treat anchors as opaque.
- Dark pages with CSS `filter: invert()` → photographs turn negative. Use the recolorer (rule 18).
- Recoloring an already recolored canvas on a theme change → wrong colors. Render again (P11).
- Highlights drawn with `mix-blend-mode: multiply` on a night page → invisible. Put `mg-dark` on the scroller (P11).
- Page elements without `position: relative`, or layers added outside the page element → the selection and highlights drift when the page scrolls (rule 13).
- Building the selection from `document.getSelection()` on a touch device → the OS callout fights the app, and handles can't be dragged precisely. Use `SelectionEngine` with `.mg-selectable` (section 4).
- Saving on every `change` event → one anchor per drag step. Create the anchor when the person presses Save.

## 9. Where to look

- `API.md`: every method, argument and result; error codes; data types.
- The npm package's `dist/*.d.ts`: exact TypeScript signatures (`Engine` in `client.d.ts`, `Document` in `document.d.ts`).
- The npm package's frontend sources, compiled with their declarations: `dist/selection-engine.js` (gestures and handles), `dist/surfaces.js` (`pdfSurface`, `epubSurface`), `dist/overlay.js` (highlights), `dist/recolor.js` (page themes), `dist/ui.css`.
- In the source repository: `docs/INTEGRATION.md` (the guide for people), and the reference app that uses all of this — `app/src/reader/reader.ts` (wiring), `pdf.ts` (PDF view), `epub.ts` (EPUB view), `selection.ts` (touch selection), `recolor.ts` (page themes), `app/src/store/library.ts` (storage).
