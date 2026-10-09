# API reference

Every host talks to the same JSON request/response layer
(`crates/marginalia/src/rpc.rs`): a method name and a JSON object of
arguments in, a JSON value or an error out. This file lists the entry points,
the conventions, every method and the data types. For *how* to add the engine
to an application, read [INTEGRATION.md](INTEGRATION.md); for a compact brief
written for coding agents, [INTEGRATION-FOR-AGENTS.md](INTEGRATION-FOR-AGENTS.md)
(shipped in every package as `AGENTS.md`).

## Entry points

| Host | Package | Open a document | Call a method |
| --- | --- | --- | --- |
| Browser (any framework) | npm `marginalia-engine` | `const e = new Engine(); await e.open(fileOrBlob)` — runs in a Web Worker, reads the Blob in place | `await e.search('…')`, or `await e.call(method, args)` |
| Node | npm `marginalia-engine/node` | `openFile(path)` (in place) or `openBytes(bytes)` | `doc.search('…')`, or `doc.call(method, args)` — synchronous |
| Your own Web Worker, Deno | npm `marginalia-engine/direct` | `await init(); openBlob(blob)` / `openBytes(bytes)` | as Node |
| Rust | crate `marginalia` (git or path) | `Session::open_source(Arc::new(FileSource::open(path)?), Limits::default(), None, None)` or `Session::open(bytes, …)` | `session.search(…)` (typed), or `marginalia::rpc::Rpc::call(method, &Value)` |
| C, C++, Swift, Kotlin (JNI), C#, Go (cgo) | C SDK (`libmarginalia` + `marginalia.h`) | `mg_open_path(path, password, utf16, &err)` (in place) or `mg_open(data, len, …)` | `mg_call(session, method, args_json, &out)` |
| Python | wheel `marginalia-engine` (`import marginalia`) | `Document.open(path)` (in place) or `Document.open(bytes)` | `doc.call(method, args)` |
| Shell | `marginalia` CLI (in the C SDK) | `marginalia <command> <file>` | `info`, `sections`, `text`, `search`, `anchor`, `resolve`, `scan`, `ocr`, `ocr-tsv`, `note` |

"In place" means the file is read where it lies, as pages and chapters are
needed: only the document's indexes (a ZIP central directory, a PDF
cross-reference table) and what is being read are in memory. Keep the file in
place until the document is closed. Encrypted PDFs and PDFs with damaged
cross-reference tables are loaded whole automatically.

Underneath, the WebAssembly module exports `MgDocument` (`new MgDocument(bytes, password?)`,
`MgDocument.openSource(length, reader, password?, fingerprint?)` where
`reader.read(offset, buffer)` fills `buffer` synchronously, `.call(method, argsJson)`,
`.geometry(unit)`, `.resource(path)`), `MgOcr`, `callStatic` and `lastPanic`.
The npm package wraps these; use them directly only for unusual hosts.

The npm package also has browser helpers that don't call the engine
themselves: `marginalia-engine/dom` (`offsetOf`, `rangeFor`, `invalidate` for
EPUB DOM offsets), `/notes` (the note-link grammar), `/ocr` (`OcrPool`), and
the reading-interface pieces `/selection`, `/themes` and `/ui.css` (below,
"The npm package's frontend modules").

## Conventions

### Identity

`summary().info.fingerprint` is the SHA-256 of the file, in hex. It is the
document's identity: every annotation's `doc` field must equal it. Opening
with a known fingerprint (`fingerprint` option, `Session::open_source`'s last
argument) skips hashing the whole file.

### Offsets

A *unit* is a PDF page or an EPUB spine item (a chapter file), numbered from
0. Positions are `(unit, offset)` in the unit's text (`unitText`). The offset
unit is chosen when the session is created:

* `utf16` — UTF-16 code units. JavaScript and the DOM, Swift `NSString`,
  Java/Kotlin, C#. **The npm package always uses this.** C: `mg_open(…, utf16 = true)`.
* `chars` — Unicode scalar values. Rust, Python `str` indices, Go runes. The
  default for the C ABI and Python.

Stored anchors are always in chars, whatever the session uses, so annotation
records are portable between hosts. `unitTextChars` returns text in chars for
storing (e.g. OCR layers).

### Geometry

PDF rectangles (`boxes`, `rects`, `images`, `bbox`) are in **PDF user space**
of the page: points, origin at the bottom-left, y up, *before* `/Rotate`.
`UnitInfo.pageBox` is the page's crop box in the same space. Convert with your
renderer's viewport: pdf.js `viewport.convertToViewportRectangle([x0, y0, x1, y1])`,
PDFKit `PDFPage.convert(_:to:)`, Android `PdfRenderer` via the matrix
`[s, 0, 0, -s, -x0*s, y1*s]` where `s` is pixels per point and `(x0, y1)` the
crop box's top-left. EPUB units have no geometry: the host lays them out.

### Errors

Errors are `{"error": {"code": "...", "message": "..."}}` (C, Python, the RPC
layer); the npm package throws `EngineError` with `.code` and `.message`;
Python raises `MarginaliaError` with `.code`; Rust returns `marginalia::core::Error`
(`.code()`).

| Code | Meaning | What to do |
| --- | --- | --- |
| `malformed` | Not a well-formed PDF/EPUB (or a damaged part of one) | Tell the person the file can't be read |
| `unsupported` | Not a PDF or EPUB, or a feature not supported (e.g. `chapter` on a PDF) | Check the file type / the method |
| `encrypted` | Password-protected or DRM-locked | Ask for a password (PDF) or refuse (DRM) |
| `limit_exceeded` | A safety limit was hit (size, pages, decompression, nesting) | Treat as unreadable; limits are generous |
| `out_of_range` | Unit or offset out of range | Bug in the caller: check `units.length` and text length |
| `invalid` | Bad arguments or data (e.g. an annotation that fails validation) | Bug in the caller: check the shape |
| `not_found` | Unknown method or resource | Check the name |
| `unreadable` | The file can no longer be read (moved, deleted, permission revoked) | Reopen it, or ask the person to add it again |
| `panic` | C ABI only: an internal error was caught | Close the session; open the document again |
| `crashed` | npm package: the engine instance trapped (a panic or out of memory) | `Engine` restarts itself and reopens the file — restore your annotations in `onRestart`; with `Document`, reload the engine |
| `stale_build` | npm package: the worker or `.wasm` file could not be loaded | Check bundler setup (see INTEGRATION.md) or network |
| `closed` | npm package: the document or engine was closed | Don't use it after `close()` |

After a panic or crash, a session is unusable. In WebAssembly a panic traps
the instance; `lastPanic()` returns the message and location. The npm
`Engine` handles this for you (one worker per document, restarted with the
same file; more than two crashes in a minute and it stops with `onBroken`).

## Methods

### Document

| Method | Args | Result |
| --- | --- | --- |
| `summary` | – | `{ info: DocInfo, units: UnitInfo[], cover }` |
| `sections` | – | `Section[]` — table of contents in document order (`level`, `parent`, `unit`, `offset`, `source: "toc"\|"inferred"`) |
| `sectionAt` | `{unit, offset}` | innermost `Section` or `null` |
| `frontMatter` | – | EPUB: the leading run of front-matter units, `[{unit, role}]` with `role` ∈ `cover`, `titlePage`, `copyright`, `dedication`, `epigraph`, `alsoBy`, `toc`, `other`; `[]` for PDFs and books that start with their text. Detected from landmarks/`<guide>`, the nav document, TOC titles, file names and text, with length guards so a foreword is never folded away. |
| `unitText` | `{unit}` | `UnitText` — `text`; PDF only: `boxes` (one per offset unit), `lines`, `ocr`, `needsOcr`, `images` |
| `unitTextLite` | `{unit}` | `UnitText` without `boxes`, plus `hasBoxes`; fetch geometry separately as a `Float32Array` (`geometry(unit)`: 4 floats per offset unit) — 16 bytes per character instead of ≈60 in JSON |
| `unitTextChars` | `{unit}` | `UnitText` in char offsets regardless of session encoding (for persistence) |
| `chapter` | `{unit}` | EPUB only: `{html, stylesheets, styles, text}` — sanitized XHTML whose text nodes concatenate to `text` |
| `search` | `{query, fromUnit?, maxHits?}` | `SearchHit[]` (default `maxHits` 200) — case-, whitespace- and typography-insensitive |
| `rectsForRange` | `{unit, start, end}` | PDF: `Rect[]` merged per line |
| `offsetAtPoint` | `{unit, x, y}` | PDF: offset nearest to a user-space point (hit testing without a DOM), or `null` |

`resource(path)` (npm: `engine.resource(path)` / `doc.resource(path)`; C:
`mg_resource`; Python: `doc.resource(path)`) returns EPUB images, fonts, media
and **sanitized** CSS as bytes plus a media type. Markup is never served. In
chapter markup and CSS, container references appear as `url("mg-res:PATH")`,
`data-mg-src`, `data-mg-poster`, `data-mg-href` (internal link: `PATH#fragment`)
and `data-mg-external` (external `http`/`https`/`mailto` link) for the host
to resolve; the chapter root is `<div data-mg-body>`.

### Anchors

| Method | Args | Result |
| --- | --- | --- |
| `createAnchor` | `{unit, start, end}` | `Anchor` |
| `resolve` | `{anchor}` | `ResolvedAnchor` (`unit`, `start`, `end`, `score`, `method`, `rects`) or `null` if orphaned |

An `Anchor` carries redundant selectors:

```json
{
  "unit": "ch1", "unitIndex": 0,
  "quote": { "exact": "boiled cabbage", "prefix": "…smelt of ", "suffix": " and old rag…" },
  "position": { "start": 332, "end": 346 },
  "cfi": "epubcfi(/6/2[ch1]!/4/2/6[p1-0],/1:332,/1:346)",
  "rects": [{ "x0": 72.0, "y0": 560.1, "x1": 160.4, "y1": 571.3 }]
}
```

Resolution order: stored position (verified against the quote) → CFI →
quote with context in the same unit (exact, then fuzzy bitap with ≤20% edits)
→ neighbouring units (`method: "moved"`) → stored rects when a scanned page
has no text yet (`method: "rects"`).

### Annotations

The engine keeps an in-memory store per open document. **Persistence is the
host's job**: save records (or `exportJson`) and give them back on open
(`importJson`).

| Method | Args | Result |
| --- | --- | --- |
| `upsert` | `{annotation}` | `bool` changed (last-writer-wins on `updated`) |
| `remove` | `{id, now}` | `bool` (keeps a tombstone for sync) |
| `get` | `{id}` | `Annotation \| null` |
| `placed` | – | `{annotation, resolved, section}[]` in reading order |
| `placedOnUnit` | `{unit}` | same, for one unit (cheap; used while rendering) |
| `exportJson` / `importJson` | – / `{json}` | the store as JSON text, tombstones included / number of records merged |
| `exportW3c` / `importW3c` | – / `{data}` | W3C Web Annotation `AnnotationPage` / number imported |

```json
{
  "id": "6c1f…", "doc": "<sha256 of file>", "kind": "highlight",
  "color": "#ffd400", "anchor": { … }, "note": "optional", "tags": [],
  "created": 1760000000000, "updated": 1760000000000
}
```

`kind` ∈ `highlight`, `underline`, `strikeout`, `note`. All fields are
validated: ids `[A-Za-z0-9_-]{1,128}`, `doc` must be this document's
fingerprint, colors `#rrggbb`, `updated ≥ created` (milliseconds since the
epoch), notes ≤ 100,000 chars, ≤ 64 tags. The `importJson` envelope is
`{"version": 1, "doc": "<fingerprint>", "annotations": [ … ]}`.

#### Links inside notes

A note is plain text with a small, strict link grammar, specified in
`crates/core/src/links.rs` (`marginalia_core::links`):

| Markup | Meaning |
| --- | --- |
| `[label](ann:<id>)` | link to another annotation, in any document |
| `[label](https://…)` | labelled link (`http`, `https`, `mailto` only) |
| `https://…` | bare URL, auto-linked (not after a letter or digit) |
| `\[` `\]` `\\` | literal brackets and backslash (a `\` before anything else is literal) |

Anything else stays plain text: invalid targets (`javascript:`, `data:`, ids
outside `[A-Za-z0-9_-]{1,128}`), labels over 300 characters or spanning lines,
targets with whitespace, control characters, brackets or unbalanced
parentheses, and URLs over 2048 characters. Lengths count Unicode scalar
values, and "whitespace"/"control" are the Unicode `White_Space`/`Cc`
properties, so every implementation agrees on every input. Parsing is linear
in the note length, including on hostile input.

Every host uses the same grammar without opening a document:

| Method | Args | Result |
| --- | --- | --- |
| `noteParse` | `{note}` | `Segment[]`: `{kind:"text", text}` or `{kind:"link", label, target}` |
| `noteSerialize` | `{segments}` | markup; `noteParse(noteSerialize(noteParse(s)))` equals `noteParse(s)` for every `s` |
| `noteTargets` | `{note}` | distinct targets: `{type:"annotation", id}` or `{type:"url", href}` |
| `notePlainText` | `{note}` | labels-only text, for search and previews |
| `version` | – | library version |

* npm: `marginalia-engine/notes` (`parse`, `serialize`, `targets`,
  `plainText`, synchronous TypeScript), or `callStatic(method, args)` from
  `marginalia-engine/node` / `/direct`.
* Rust: `marginalia::rpc::call_static(method, args)`, or the functions in
  `marginalia_core::links`.
* C: `mg_call_static(method, args_json, &out)`, same contract as `mg_call`.
* Python: `marginalia.parse_note`, `serialize_note`, `note_targets`, `call_static`.
* CLI: `marginalia note "<text>"`, or `marginalia note -` to read stdin.
* Any session: `call` falls through to these methods.

The TypeScript mirror (`app/src/notes/markup.ts`, shipped as
`marginalia-engine/notes`) is held to the Rust implementation by two vector
files that both test suites run: `markup-vectors.json` (hand-written edge
cases) and `markup-fuzz-vectors.json` (600 random notes with Rust's parse and
serialise output; regenerate with `MARGINALIA_REGEN_VECTORS=1 cargo test -p
marginalia-core links`).

In the W3C export, a note with links gets one
`{"type":"SpecificResource","purpose":"linking","source":…}` body per target
next to its `TextualBody`.

### OCR

| Method | Args | Result |
| --- | --- | --- |
| `needsOcr` | `{unit}` | `bool` — page is mostly image with no text layer |
| `ocrPage` | `{unit}` | decode the embedded scan natively and OCR it (engine required) → `UnitText`, or `null` if the image codec is unsupported |
| `applyOcrLines` | `{unit, scale, lines}` | build the text layer from recognised lines of a rendering at `scale` px/pt |
| `setOcrLayer` | `{unit, layer}` | attach a previously saved layer (`unitTextChars` form) |
| `renderToPage` | `{unit, scale}` | pixel→user-space matrix for a rendering at `scale` |
| `hasOcr` | – | engine loaded? |

* Browser: `OcrPool` from `marginalia-engine/ocr` (`new OcrPool({det, rec})`,
  `recognize(width, height, rgba)` → lines) runs the OCR build in several
  workers; pass its lines to `engine.applyOcrLines(unit, scale, lines)`.
* Native: `mg_load_ocr` / `doc.loadOcr(det, rec)` load the models;
  `mg_ocr_rgba` / `doc.ocrRgba(unit, w, h, rgba, scale)` OCR a host rendering;
  `ocrPage` decodes typical scans (JPEG, CCITT, raw) without rendering.
* Tesseract users can convert TSV output with
  `marginalia::ocr::parse_tesseract_tsv` (CLI: `marginalia ocr-tsv`).
* Models: `text-detection.rten` and `text-recognition.rten` (≈12 MB) from the
  ocrs project, fetched by `scripts/fetch-models.sh`; not included in any
  package. Latin script.

## The npm package's typed methods

`Engine` (browser, promises) and `Document` (Node/direct, synchronous) expose
the methods above with these names:

| Method | RPC |
| --- | --- |
| `open(blob, {password?, fingerprint?})` (Engine only) | opens; returns `Summary` |
| `summary()` (Document), `sections()`, `sectionAt(unit, offset)`, `frontMatter()` | same names |
| `text(unit)` | `unitTextLite` |
| `unitText(unit)` (Document), `textChars(unit)` / `unitTextChars(unit)` | `unitText` / `unitTextChars` |
| `geometry(unit)` | `Float32Array`, 4 floats per UTF-16 unit |
| `chapter(unit)`, `resource(path)` | EPUB |
| `search(query, …)`, `createAnchor(unit, start, end)`, `resolve(anchor)`, `rects(…)` / `rectsForRange(…)`, `offsetAtPoint(unit, x, y)` | same |
| `upsert(a)`, `remove(id, now?)`, `get(id)`, `placed()`, `placedOnUnit(unit)` | same |
| `importAnnotations(doc, annotations)` | `importJson` with the envelope built for you |
| `exportJson()`, `exportW3c()`, `importW3c(data)` (Document) | same |
| `setOcrLayer(unit, layer)`, `applyOcrLines(unit, scale, lines)` | same |
| `call(method, args)` | anything else |
| `memory()` (Engine only) | bytes of WebAssembly memory in the worker (its high-water mark) |
| `close()` | frees the engine (Engine: terminates the worker) |

`Engine` also has `onRestart` (called after a crash once the file is
reopened: re-import your annotations and OCR layers there) and `onBroken`
(the engine gave up), and `broken`.

## The npm package's frontend modules

Browser-only helpers from the reference app, independent of any framework.
How to put them together: `AGENTS.md` section 4 (P9–P12).

**`marginalia-engine/selection`**

| Export | Signature and behaviour |
| --- | --- |
| `SelectionEngine` | `new SelectionEngine(scroller, surface, { change(range \| null), tap(x, y): boolean })`. Members: `sel` (current `Range` or null), `select(range \| null)`, `selectWordAt(x, y)`, `clear()`, `render()` (repaint after layout changes; once per frame), `destroy()`. Gestures: double-tap/double-click a word, long-press (touch, 450 ms), mouse drag; drag handles (swap when crossing, autoscroll within 56 px of the edges); arrow keys on a focused handle (Shift: by word). `change` fires on every step and again on release; `tap` runs 300 ms after a single tap: return `true` if handled, else the selection clears |
| `Surface` | `{ hit(x, y): Pos \| null; text(unit): string \| null; rects(unit, start, end): Box[]; host(unit): HTMLElement \| null }` — viewport coordinates in, viewport boxes out; `host` is the positioned element the layers go in |
| `pdfSurface(pages)` | `pages: () => Iterable<PdfPage>`, with `PdfPage { unit, element, viewport, text, geometry }` (`viewport`: the pdf.js `PageViewport` the page is drawn with; `text`/`geometry` from the engine, or null until loaded). Boxes are cached per geometry and viewport object |
| `epubSurface(chapters)` | `chapters: () => Iterable<EpubChapter>`, with `EpubChapter { unit, element, shadow, root, text }` (`root`: the `[data-mg-body]` element inserted unchanged in `shadow`) |
| `OverlayLayer` | `new OverlayLayer(parent)` appends `<svg class="mg-overlay">` to `parent`. `set(shapes, selectedId?)` with `Shape { annotation, boxes: Box[] }` in parent-relative CSS px; `hit(x, y)` → annotation ids under a parent-relative point, topmost first; `flash(boxes, ms = 1600)`; `boxesOf(id)`; `el` |
| `Range`, `Pos`, `Box` | `{ unit, start, end }`; `{ unit, offset, char }` (`offset`: nearest caret boundary; `char`: character under the point); `{ left, top, width, height }` |
| `trimRange(text, start, end)` | drops surrounding whitespace → `{ start, end }` |
| `toLocal(boxes, host)` | viewport boxes → boxes relative to `host` |
| `wordAt(text, offset)` | word around `offset` (`Intl.Segmenter`, with a fallback) → `{ start, end }` or null |
| `mergeLines(boxes)` | per-character boxes → one box per line |
| `nearestChar(boxes, x, y)` | nearest character in packed `[x0, y0, x1, y1, …]` boxes → `{ char, offset }` or null |

All offsets are UTF-16, like the rest of the npm package.

**`marginalia-engine/themes`**

| Export | Signature and behaviour |
| --- | --- |
| `PAGE_THEMES` | `{ sepia, night, black }`, each a `PageTheme { bg: [r, g, b], fg: [r, g, b] }` ("paper" is no theme: `null`) |
| `Recolorer` | `new Recolorer()`; `apply(canvas, job)` recolors a canvas in place (in a worker with `OffscreenCanvas`, else on the calling thread); `close()` |
| `pageJob(theme, page, toPx)` | `page: { images?, lines?, ocr, needsOcr, pageBox }` from `text(unit)` (`lines` as `bbox` rects) and `summary.units[unit].pageBox`; `toPx`: page space → canvas pixels. A page whose largest image covers more than 80% of it, or with OCR, is treated as a scan |
| `pdfjsToPx(viewport, dpr = 1)` | `toPx` for a canvas rendered with that pdf.js viewport and `transform: [dpr, 0, 0, dpr, 0, 0]` |
| `recolor(input)`, `paperAndInk(data)`, `classifyTiles(…)` | the pure functions underneath (RGBA buffers in, recolored in place) |
| `EPUB_THEME_CSS` | stylesheet to append last in each chapter's shadow root; inactive until a theme is set |
| `setEpubTheme(host, theme \| null)` | themes a chapter's shadow host (sets `mg-themed`, `--mg-paper`, `--mg-ink`); `--mg-link` is yours to set |
| `isDark(theme)` | true for dark pages (put `mg-dark` on the scroller) |

**`marginalia-engine/ui.css`**: styles for `.sel-layer`, `.sel-rect`,
`.handle` (with `i` stem and `b` knob), `.mg-overlay` and `.mg-ann`; classes
`.mg-selectable` (put on the scroller: no OS selection, callout or double-tap
zoom) and `.mg-dark` (dark pages); variables `--accent`, `--sel`,
`--hl-opacity`, `--blend`, `--surface`.

## Data types

The TypeScript declarations ship in the npm package (`dist/types.d.ts`) and
mirror the Rust types in `crates/core`; JSON field names are camelCase
everywhere.

```ts
interface Rect { x0: number; y0: number; x1: number; y1: number }               // PDF points, y up
interface DocInfo { kind: 'pdf' | 'epub'; fingerprint: string; title: string | null; authors: string[];
  language: string | null; identifier: string | null; unitCount: number; fixedLayout: boolean }
interface UnitInfo { id: string; label: string; pageBox: Rect | null; rotation: number; href: string | null; linear: boolean }
interface Summary { info: DocInfo; units: UnitInfo[]; cover: string | null }      // cover: EPUB resource path
interface LineInfo { start: number; end: number; fontSize: number; bbox: Rect }
interface UnitText { text: string; boxes?: Rect[]; lines?: LineInfo[]; ocr: boolean; needsOcr: boolean; images?: Rect[] }
interface UnitTextLite { text: string; lines?: LineInfo[]; ocr: boolean; needsOcr: boolean; hasBoxes: boolean; images?: Rect[] }
interface Section { id: number; title: string; level: number; parent: number | null; unit: number; offset: number; source: 'toc' | 'inferred' }
interface ChapterView { html: string; stylesheets: string[]; styles: string[]; text: string }
interface TextQuote { exact: string; prefix: string; suffix: string }
interface Anchor { unit: string; unitIndex: number; quote: TextQuote; position?: { start: number; end: number }; cfi?: string; rects?: Rect[] }
type AnnotationKind = 'highlight' | 'underline' | 'strikeout' | 'note';
interface Annotation { id: string; doc: string; kind: AnnotationKind; color: string; anchor: Anchor; note?: string;
  tags?: string[]; created: number; updated: number; deleted?: boolean }
interface Resolved { unit: number; start: number; end: number; score: number; method: 'position' | 'cfi' | 'quote' | 'moved' | 'rects'; rects: Rect[] }
interface Placed { annotation: Annotation; resolved: Resolved | null; section: string | null }
interface SearchHit { unit: number; start: number; end: number; before: string; matched: string; after: string }
interface FrontUnit { unit: number; role: 'cover' | 'titlePage' | 'copyright' | 'dedication' | 'epigraph' | 'alsoBy' | 'toc' | 'other' }
```

Offsets in `Resolved`, `SearchHit`, `LineInfo` and positions you pass in are
in the session's encoding; offsets *inside* `Anchor` are always chars.
