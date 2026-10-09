# Adding Marginalia to another codebase

This guide is for a person adding the Marginalia engine to an application of
their own — and for working on that together with a coding agent. It explains
what the engine gives you, which package to use, the few rules that keep
highlights in the right place, and how to build up from "search a PDF" to a
full reading interface with notes and OCR.

Three documents work together:

- **This guide** — explanations, decisions, the order to do things in.
- **[INTEGRATION-FOR-AGENTS.md](INTEGRATION-FOR-AGENTS.md)** — the same
  integration as a compact brief for a coding agent: numbered rules, step-by-step
  procedures with tested code, an error table and a checklist. Every package
  ships it as `AGENTS.md`, so an agent working in your codebase can find it in
  `node_modules/marginalia-engine/`, inside the Python package or in the SDK.
- **[API.md](API.md)** — every method, argument, result, error code and data type.

## 1. What you get, and what stays yours

The engine is a library, written in Rust, that you call from your code. Give
it a PDF or EPUB file and it gives you, for each **unit** (a PDF page or an
EPUB chapter file):

- the text, and for PDFs the position of every character on the page;
- for EPUBs, the chapter as clean, safe XHTML (no scripts, no remote content)
  whose text matches the engine's text character for character;
- search, the table of contents (mapped to exact positions), and the EPUB's
  front matter (cover, title page, copyright…);
- **anchors**: references to a span of text that still find it after the text
  changes — re-extraction, OCR run again, a new edition of the book;
- a store of **annotations** (highlights, underlines, notes) that merges
  copies from several devices;
- a small grammar for **links inside notes**, to other notes or to web pages;
- **OCR** for scanned PDFs: the recognized text then behaves exactly like real text.

What stays yours:

- **Drawing pages.** The engine doesn't render. Use what your platform has:
  pdf.js in browsers, PDFKit on Apple platforms, `PdfRenderer` on Android, the
  DOM for EPUB chapters. The engine's coordinates are made to be laid over any
  of them.
- **Storage.** The engine keeps annotations in memory while a document is
  open. Saving them (a database, IndexedDB, files, a server) is your code.
- **Interaction.** Menus, the note editor, navigation. For the browser, the
  npm package does include the reference app's text selection (double-tap a
  word, drag handles to change the range), its highlight layer and its page
  themes (section 6). The reference app in this repository (`app/`) shows one
  complete way to build the rest.

## 2. Pick a package

| Your codebase | Package | Notes |
| --- | --- | --- |
| A web app, any framework | npm **`marginalia-engine`** | Runs the engine in a Web Worker; promises; reads files in place |
| Node (server, CLI, scripts) | npm **`marginalia-engine/node`** | Same package, synchronous API, opens files from disk |
| Rust | the **`marginalia`** crate | Depend on it by git or path; typed API |
| Swift, Kotlin, C, C++, C#, Go | the **C SDK** | Shared library, header, pkg-config file |
| Python | the **wheel** `marginalia-engine` | Library inside; `import marginalia` |
| Shell scripts, batch jobs | the **`marginalia` CLI** (in the C SDK) | JSON output |

### Getting the packages

The packages are built from this repository; they are not published to npm or
PyPI yet. On a machine with Rust, Node and Python:

```sh
sh scripts/package.sh            # everything, into target/packages/
sh scripts/package.sh npm        # or one of: npm | sdk | python
```

| File | Contents | Runs on |
| --- | --- | --- |
| `marginalia-engine-<v>.tgz` | WebAssembly engine (reader ≈2.6 MB; OCR build ≈5.8 MB, loaded only for OCR), worker client, Node entry, OCR pool, DOM and note helpers, selection UI with drag handles, highlight layer, page themes, `ui.css`, types, `AGENTS.md`, `API.md` | any OS (browsers, Node ≥ 18) |
| `marginalia-sdk-<v>-<target>.tar.gz` | `lib/libmarginalia.{so,dylib,dll}`, `include/marginalia.h`, `lib/pkgconfig/marginalia.pc`, `bin/marginalia`, `examples/demo.c`, docs | the OS and CPU it was built on |
| `marginalia_engine-<v>-py3-none-<platform>.whl` | the Python binding with the library inside | the OS and CPU it was built on (any Python 3.8+) |

Install them from the files:

```sh
npm install ./marginalia-engine-0.1.0.tgz
pip install ./marginalia_engine-0.1.0-py3-none-linux_x86_64.whl
tar xzf marginalia-sdk-0.1.0-x86_64-unknown-linux-gnu.tar.gz
```

Rust needs no package:

```toml
[dependencies]
marginalia = { git = "https://github.com/klyle-11/grounds-cc", branch = "claude/marginalia" }
# or, with a checkout next to your project:
# marginalia = { path = "../grounds-cc/crates/marginalia" }
# OCR in native builds: features = ["ocrs"]
```

Building the npm package needs the `wasm32-unknown-unknown` Rust target and
`wasm-bindgen-cli` 0.2.100 (`cargo install wasm-bindgen-cli --version 0.2.100`),
and `npm install` run once in `app/` (for TypeScript). For an iOS app you
want the static library: `cargo build --release -p marginalia-ffi --target aarch64-apple-ios`
gives `libmarginalia.a` (it is left out of the SDK because it is about 80 MB).

The project declares no license yet; the npm package says `UNLICENSED`.
Choose one before publishing anything built from it.

## 3. Five rules that keep highlights in the right place

These rules come from how the engine works. Breaking any of them doesn't
crash anything — highlights just drift, or notes disappear, which is worse.

**1. A document is its fingerprint.** Opening a file gives you
`summary.info.fingerprint`, the SHA-256 of the file. Store annotations, OCR
results and reading positions under it, not under a file name. The same file
renamed is the same document; an edited file is a different one (and the
anchors will re-attach to it as well as the text allows).

**2. Your storage is the truth; the engine holds a working copy.** Save every
annotation in your storage first, then give it to the engine (`upsert`). When
a document opens, load its annotations from your storage and hand them over
(`importAnnotations`) before drawing. Then a crash, a reload or a second
device never loses a note.

**3. Pick one unit for positions and never convert by hand.** Text positions
are counted in UTF-16 code units in JavaScript (the npm package), and in
Unicode characters in Python and by default in C. An emoji is one character
but two UTF-16 units, so mixing the two shifts everything after it. Use the
positions the engine gives you, pass them back as they are, and the engine
converts at its boundary. (Anchors store characters internally so they work
in every language; treat them as opaque.)

**4. Use the engine's text for positions, never the renderer's.** pdf.js has
its own text layer; PDFKit has its own string. Their text differs from the
engine's in spaces, line breaks and ligatures, so positions taken from them
point at the wrong characters. For PDFs, hit-test with the engine's
character boxes (`offsetAtPoint`, `geometry`). For EPUBs, insert the
chapter's XHTML *unchanged* — parsed with an XML parser, not `innerHTML`, and
not re-rendered by a framework — so the page's text is the engine's text.

**5. Leave the file where it is while it's open.** The engine reads the file
as you go, which is why a 60 MB book costs a few megabytes of memory. Keep the
`File`, `Blob` or path valid until you close the document, and close
documents you are done with.

## 4. Quick start, by platform

Each of these was run against this repository's sample books
(`app/public/samples/`).

### A web app

```js
import { Engine, EngineError } from 'marginalia-engine';

const engine = new Engine();                   // one per open document
const summary = await engine.open(file);       // a File from <input type="file">, or a Blob
const hits = await engine.search('universally acknowledged');
const anchor = await engine.createAnchor(hits[0].unit, hits[0].start, hits[0].end);
// … later
engine.close();                                 // ends the worker and frees its memory
```

Bundlers:

- **Vite:** works in production builds as is. For the dev server add
  `optimizeDeps: { exclude: ['marginalia-engine'] }` to `vite.config`;
  otherwise the dev server moves the code away from its worker and
  WebAssembly files and `open` fails with `stale_build`.
- **webpack 5** (and Next.js on webpack): works as is; it bundles the workers
  and `.wasm` files it finds through `new URL(…, import.meta.url)`.
- **Others:** the package references its worker (`dist/worker.js`) and
  WebAssembly (`dist/wasm/marginalia_wasm_bg.wasm`) with `new URL(…, import.meta.url)`;
  any bundler that supports that pattern, or no bundler at all with the
  package served as files, works.
- **Content Security Policy:** `script-src 'self' 'wasm-unsafe-eval'` and
  `worker-src 'self'`. No `SharedArrayBuffer`, so no cross-origin isolation
  headers are needed.

In React, create the `Engine` in an effect and close it in the cleanup:

```jsx
useEffect(() => {
  const engine = new Engine();
  let live = true;
  engine.open(file).then((s) => live && setSummary(s)).catch(setError);
  engineRef.current = engine;
  return () => { live = false; engine.close(); };
}, [file]);
```

### Node

```js
import { openFile } from 'marginalia-engine/node';

const doc = openFile('book.epub');              // read in place
console.log(doc.summary().info.title);
for (const s of doc.sections()) console.log(' '.repeat(s.level * 2) + s.title);
doc.close();
```

Calls are synchronous. A panic inside the engine stops every document open in
the process, so a server that opens files from strangers should run this in a
`worker_threads` worker it can replace.

### Rust

```rust
use std::sync::Arc;
use marginalia::core::{source::FileSource, Limits};
use marginalia::Session;

let session = Session::open_source(Arc::new(FileSource::open("book.pdf")?), Limits::default(), None, None)?;
let hits = session.search("universally acknowledged", 0, 10)?;
let anchor = session.create_anchor(hits[0].unit, hits[0].start, hits[0].end)?;
```

`Session` is the typed API; `marginalia::rpc::Rpc` is the JSON layer the other
languages use, if you want identical behaviour.

### C and C++

```c
MgSession *s = mg_open_path("book.pdf", NULL, false, &err);   /* read in place */
mg_call(s, "search", "{\"query\": \"universally acknowledged\"}", &out);
/* … use out (JSON), then: */ mg_free_string(out);
mg_close(s);
```

Build: `cc app.c $(pkg-config --cflags --libs marginalia) -Wl,-rpath,<sdk>/lib`
with `PKG_CONFIG_PATH=<sdk>/lib/pkgconfig`. `examples/demo.c` in the SDK is a
complete program. Strings the library returns are yours to free with
`mg_free_string`.

### Python

```python
from marginalia import Document

with Document.open("book.pdf") as doc:               # a path: read in place
    hits = doc.call("search", {"query": "universally acknowledged"})
    anchor = doc.call("createAnchor", {"unit": hits[0]["unit"], "start": hits[0]["start"], "end": hits[0]["end"]})
```

Positions are Python string indices.

### Swift (iOS, macOS)

Build `crates/ffi` as a static library for each target (`aarch64-apple-ios`,
`aarch64-apple-ios-sim`, `aarch64-apple-darwin`), wrap them in an
XCFramework, and import `marginalia.h` through a module map.

```swift
var err: UnsafeMutablePointer<CChar>?
let s = mg_open_path(url.path, nil, true, &err)        // utf16: NSString offsets
func call(_ m: String, _ args: [String: Any]) -> Any? {
    var out: UnsafeMutablePointer<CChar>?
    let json = String(data: try! JSONSerialization.data(withJSONObject: args), encoding: .utf8)!
    let ok = mg_call(s, m, json, &out); defer { mg_free_string(out) }
    let v = try? JSONSerialization.jsonObject(with: Data(String(cString: out!).utf8), options: [.fragmentsAllowed])
    return ok ? v : nil
}
```

Render with PDFKit and convert the engine's page-space rectangles with
`PDFPage.convert(_:to:)`. Open with `utf16 = true` so positions match `NSRange`.

### Kotlin (Android)

Build with `cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 build -p marginalia-ffi --release`,
then call `mg_open_path`/`mg_call`/`mg_free_string` through a small JNI shim
or JNA (the same signatures as the Python binding). Render with
`android.graphics.pdf.PdfRenderer`; map page-space rectangles with
`Matrix(s, 0, -x0*s; 0, -s, y1*s)` where `s` is pixels per point and
`(x0, y1)` the crop box's top-left. Kotlin strings are UTF-16: open with `utf16 = true`.

## 5. Building a reading interface, one level at a time

You don't have to build everything. Each level is useful on its own, and each
builds on the one before. The agent brief has tested code for every step
(its procedures P2–P12); here is what each level involves and why.

### Level 1 — Text and search, no interface

Open a document, read `summary()`, `sections()`, the text of each unit, and
search. This is enough to index a library, extract quotes, or answer
questions about a book. Store the fingerprint with whatever you index.

### Level 2 — Show highlights on pages you already render

Load annotations from your storage, hand them to the engine, and ask where
each one is now (`placed()`). Each placed annotation has a `resolved` position
(or `null` if its text no longer exists — keep it in a list, but don't draw it):

- **PDF:** `resolved.rects` are boxes in PDF points with the origin at the
  bottom-left of the page. Your renderer converts them; with pdf.js,
  `viewport.convertToViewportRectangle([x0, y0, x1, y1])`.
- **EPUB:** `resolved.start`/`end` are positions in the chapter's text. With
  the chapter rendered as the engine gave it (rule 4), `rangeFor(root, start, end)`
  from `marginalia-engine/dom` makes a DOM `Range`, and `range.getClientRects()`
  gives boxes to draw.

Draw highlights in a layer above the text (an SVG or absolutely positioned
boxes), not by wrapping text in `<mark>` elements — wrapping changes the DOM
and breaks rule 4. In the browser, the package's `OverlayLayer` is such a
layer (section 6).

### Level 3 — Let people highlight and write notes

Turn a selection into positions, ask the engine for an anchor, save, and draw:

- **PDF:** convert the pointer position to page space (pdf.js:
  `viewport.convertToPdfPoint(x, y)`) and call `offsetAtPoint(unit, x, y)`
  for each end of the selection. `rects(unit, start, end)` gives the boxes
  to draw while the person drags.
- **EPUB:** read the browser's selection and convert each end with
  `offsetOf(root, node, offset)` from `marginalia-engine/dom`. Chapters live
  in a shadow root; `getComposedRanges` reads a selection inside one.
- Then `createAnchor(unit, start, end)`, build the annotation record
  (`id`, `doc` = fingerprint, `kind`, `color`, `anchor`, `note`, `created`,
  `updated`), save it, `upsert` it, and redraw from `placed()`.

On phones, the operating system's selection over a custom-drawn page is
clumsy. The reference app replaces it with its own: double-tap a word, then
drag handles to change the range. The npm package includes it
(`marginalia-engine/selection`, section 6), and it reports ranges already in
the engine's offsets.

### Level 4 — Links between notes

Notes are plain text with a tiny markup: `[label](ann:<id>)` links to another
annotation in any document, `[label](https://…)` and bare `https://…` links
to the web. Parse notes with `parse` from `marginalia-engine/notes` (or the
`noteParse` method in other languages) and render the segments as text nodes,
links and buttons — never as HTML. When you save a note, index its targets
(`annotationTargets(note)`) so you can show *backlinks*: the notes that link to
this one. Following an `ann:` link means finding that annotation in your
storage, opening its document, and scrolling to its `placed` position.

### Level 5 — Scanned PDFs

`text(unit)` tells you a page `needsOcr` when it is a picture of text. Render
the page unrotated at a known scale (pixels per PDF point), give the pixels
to `OcrPool.recognize` (browser, `marginalia-engine/ocr`) or `mg_ocr_rgba` /
`ocrPage` (native), and pass the result to `applyOcrLines(unit, scale, lines)`.
From then on the page has text and character boxes like any other. Save the
layer (`unitTextChars`) under the fingerprint and page, and restore it with
`setOcrLayer` the next time — OCR takes seconds per page; do it once.

OCR needs two model files (≈12 MB, from the ocrs project) that are not in
any package: `scripts/fetch-models.sh` downloads them. Serve them with your
app, or offer OCR as something the person turns on.

## 6. In the browser: selection, highlights and page themes

The engine draws nothing, but a reading interface in a browser needs the
same three things whatever the app looks like: a way to select text that
works with a finger, a layer that draws highlights, and page colors for
reading at night. The npm package includes the reference app's versions of
all three, with no framework attached:

- `marginalia-engine/selection`: the selection engine with drag handles, the
  connectors for PDF pages and EPUB chapters, and the highlight layer;
- `marginalia-engine/themes`: page themes for PDFs that keep pictures in
  color, and the CSS to theme EPUB chapters;
- `marginalia-engine/ui.css`: their styles.

The agent brief puts them together in two tested classes, `PdfReader` and
`EpubReader` (its P9 and P10). This section explains what they do and why, so
you can judge them and adapt them.

### Selecting text with drag handles

The operating system's text selection doesn't suit a document reader. A PDF
page is a picture on a canvas, so there is nothing for the browser to select.
pdf.js can lay invisible text over the page, but that text isn't the engine's
text (rule 4). In an EPUB the browser's selection works, but on a phone it
competes with scrolling, opens the system menu over the page and can't be
adjusted precisely. So the reference app turns the system selection off over
the document (the `mg-selectable` class) and draws its own.

How a person uses it:

- **Double-tap a word** (or double-click it, or press and hold it on a touch
  screen) to select it. Word boundaries come from the browser's
  `Intl.Segmenter`, so they are right for languages without spaces too.
- **Drag either handle** to move that end of the selection. If the end handle
  is dragged past the start, the two swap places, as on iOS and Android. Near
  the top or bottom of the screen the document scrolls under the finger.
  While dragging, the selection follows the middle of the text line rather
  than the point under the fingertip, so the finger never hides the words
  being chosen. Each handle is a 44-pixel touch target.
- **With a keyboard**, the handles are in the tab order: the arrow keys move
  the focused end by a character, and with Shift by a word.
- **With a mouse**, pressing and dragging over text selects it, as usual.
- **A single tap** either opens the highlight under it (your code decides) or
  clears the selection. Dragging a finger over text scrolls, as people expect.

How it knows where the text is: it asks a *surface*, a small object that
answers "which character is under this point?" and "where on screen are
these characters?". The PDF surface answers from the engine's character
boxes, converted to the screen with pdf.js's viewport. The EPUB surface asks
the browser which text node is under the point and converts that to the
engine's offset. Either way, the selection is reported in the engine's own
offsets, ready for `createAnchor`, with no conversion in between.

The selection tint and the handles are drawn in a layer *inside* the page or
chapter element. They scroll with the page for free, and nothing has to be
redrawn while scrolling. A selection stays within one page or chapter,
because an anchor belongs to one unit. Your code supplies three things:
- the list of pages currently drawn;
- what to do when the selection changes (show a toolbar);
- what a single tap means (open a highlight).

### Drawing highlights

The highlight layer is one SVG per page or chapter, laid over the text with
`mix-blend-mode: multiply` so the ink stays crisp under the color. It draws
highlights as tinted boxes, underlines and strikeouts as lines, and marks
annotations that have notes with a small dot. It also answers the reverse
question, which highlights are under a point, for opening one on tap, and it
can flash boxes briefly to show a search result or a link's target. For PDF
pages the boxes come from `placed()` converted with the page's viewport; for
EPUB chapters, from the DOM range of the highlighted text. Either way, redraw
after anything that moves text: zoom, rotation, a new font size.

### Page themes that keep pictures

Sepia, night and black page themes are easy for an EPUB and hard for a PDF.

An EPUB chapter is text, so a theme is CSS. `EPUB_THEME_CSS` goes into each
chapter's shadow root after the publisher's styles, and
`setEpubTheme(host, theme)` turns it on or off. The ink and paper colors
change; images don't, and neither does the text, so offsets and highlights
are untouched and nothing needs re-rendering.

A PDF page is a picture: pdf.js paints it into a canvas. The quick fix, a CSS
`filter: invert()`, turns photographs into negatives. Instead, the
`Recolorer` repaints the canvas pixel by pixel after pdf.js has drawn it:

- **Paper and ink trade places by brightness.** Every pixel's brightness
  says how much ink it holds. White paper becomes the theme's background,
  black ink its text color, and the grey edges of letters land in between,
  so text stays smooth.
- **Colored ink keeps its hue.** Blue links, red headings and chart lines get
  the theme's brightness but stay blue, red and so on.
- **Pictures are left alone.** For a normal PDF page, the engine reports
  where images were painted (`text(unit).images`), and those areas are skipped.
  A scanned page is a single image of the whole page, so skipping it would
  leave the page unthemed. On scans, the recolorer looks at the page in small
  tiles: tiles that are only paper and ink are recolored, and tiles full of
  mid-tones or color (photographs, figures) are kept. Where OCR found lines
  of text, those always count as text.

Practical points:
- The recoloring runs in a worker where the browser allows, and is applied
  before the page is shown, so it never flashes white.
- Changing theme renders the page again rather than recoloring a recolored
  canvas. Recoloring loses information, so night to sepia must start again
  from the original.
- On dark themes, put the `mg-dark` class on the scroller. Highlights then
  blend normally, because `multiply` would make them invisible on a dark
  page, and the selection tint becomes lighter.

### Styling

Everything visible is driven by CSS variables, so the pieces take on your
app's look without forking:
- `--accent` for the handles;
- `--sel` for the selection tint;
- `--hl-opacity` and `--blend` for highlights;
- `--surface` for the ring around note dots;
- `--mg-link` for EPUB link color under a theme.

The class names (`sel-layer`, `handle`, `mg-overlay`, `mg-ann`) are stable, if
you'd rather restyle them outright. Keep the handles at least 44 pixels wide.

### What the reference app adds

The rest of the reference app's reader depends on its layout, so it isn't
packaged. These parts are worth reading before you build your own (the agent
brief, section 4.4, has the details and file paths):
- **Bounded rendering.** Only pages near the screen keep a canvas, and their
  total memory is capped.
- **One EPUB chapter at a time.** The next chapter is prepared in the
  background.
- **A note composer above the on-screen keyboard.** iOS doesn't resize the
  page for the keyboard, so the app measures it.
- **Focus mode.** Everything but the paragraph being read is dimmed.
- **A table of contents** that tracks the reading position.

## 7. Storage

The annotation record is the unit of storage. Store it as JSON, keyed by its
`id`, with an index on `doc` (the fingerprint):

```json
{ "id": "c0a8…", "doc": "<fingerprint>", "kind": "highlight", "color": "#ffd23f",
  "anchor": { … as returned by createAnchor … }, "note": "optional",
  "created": 1760000000000, "updated": 1760000000000 }
```

- **Edit:** keep `id` and `created`; set `updated` to `max(now, previous.updated + 1)`.
- **Delete:** keep the record with `deleted: true` (a *tombstone*), so other
  copies learn about the deletion.
- **Sync between devices:** for each `id`, the record with the larger
  `updated` wins. The engine applies the same rule when you `upsert` or
  `importJson`.
- **Also worth storing:** OCR layers (`unitTextChars`), keyed by fingerprint
  and unit; reading position as `(unit, offset)`; and `exportJson()` if you
  prefer one blob per document.
- **Exports:** `exportW3c()` produces standard W3C Web Annotations other tools
  understand.

The reference app's `app/src/store/library.ts` is a complete IndexedDB
implementation: one transaction per edit (annotation, history and link index
together), tombstones, and an outbox for syncing.

## 8. When things go wrong

Every failure has a code (`API.md` lists them all). The ones you will meet:

- **`unsupported`, `malformed`, `encrypted`** when opening: the file isn't a
  readable PDF or EPUB. Tell the person; nothing else is affected.
- **`unreadable`**: the file moved or was deleted while open. Ask them to add
  it again.
- **`crashed`** (browser): the engine hit an internal error. `Engine` restarts
  its worker and reopens the file by itself; set `engine.onRestart` to re-import
  annotations and OCR layers, because the new engine starts empty. After
  repeated crashes it gives up and calls `onBroken`.
- **`stale_build`** (browser): the worker or WebAssembly file didn't load —
  usually the Vite dev-server setting from section 4, or a deploy that
  replaced the files under an open page.
- **`out_of_range`, `invalid`, `not_found`**: a bug in the calling code.

Every input is treated as hostile: files are parsed with limits on size,
depth and decompression, chapter markup is rebuilt from an allow-list, and the
mutation test suite has run hundreds of thousands of corrupted files through
every method without a panic. Your code still decides what reaches the screen
— so follow rule 4 and never put document or note text into `innerHTML`.

## 9. Memory and speed

- Opening reads only the document's index: tens of kilobytes, tens of
  milliseconds, even for very large files (pass the fingerprint if you know it,
  so the file isn't hashed).
- A page's text costs a few kilobytes of reading; pictures and fonts stay on
  disk unless OCR needs one.
- In the browser, WebAssembly memory only grows. That is why `Engine` uses one
  worker per document: `close()` ends the worker and returns all of it.
- Geometry travels as a `Float32Array` (16 bytes per character) instead of
  JSON. Ask for `text(unit)` and `geometry(unit)` only for pages near the
  screen.

Measured: a 61 MB PDF uses 6.2 MB of engine memory and opens in 29 ms; a
27 MB EPUB uses 6.8 MB (REVIEW.md §2).

## 10. Working with a coding agent

The integration is a good job to share with an agent: the rules are precise,
the steps are mechanical, and every step can be checked. What works:

1. **Install the package first**, yourself or by asking the agent, so
   `AGENTS.md` is inside the codebase (`node_modules/marginalia-engine/AGENTS.md`,
   `site-packages/marginalia/AGENTS.md`, or the SDK's top folder).
2. **Give a brief that names the level** you want (section 5), where your
   storage lives, and how pages are rendered today. For example:

   ```text
   Add Marginalia highlights to our PDF viewer (React + pdf.js, src/viewer/).
   Read node_modules/marginalia-engine/AGENTS.md first and follow its rules.
   Goal: level 3 — people can select text on a page, highlight it in a color
   and add a note; highlights reappear after reload.
   Storage: our Postgres API, add a table keyed by annotation id with an index
   on doc (the fingerprint); endpoints under /api/annotations.
   Do: P1 smoke test in our real build, then P3, P4, P9 (the packaged
   SelectionEngine, OverlayLayer and page themes; adapt PdfReader to our viewer).
   Don't: use pdf.js's text layer for offsets; innerHTML; edit node_modules.
   Done when: the checklist in AGENTS.md section 7 passes, with how you checked each item.
   ```

3. **Review the result against the rules**, not just by trying it. The quick
   checks: annotations are saved before `upsert` (rule 2); no hand-written
   offset conversion (rule 3); no use of the renderer's text for positions,
   no `innerHTML` (rules 4 and 6 in the brief); every `Engine` is closed; no
   CSS `filter` for dark pages (rule 18).
4. **Ask for the checklist results.** The brief's section 7 is written so an
   agent can run each check and say how — for example, highlighting a word
   after an emoji to prove positions are consistent.

If the agent works in this repository rather than yours, point it at
`GAUNTLET.md`'s reading guide (after module M89), which walks through how the
engine and the reference app are put together.

## 11. Versions and limits

- **Version:** the packages carry the workspace version (`Cargo.toml`). The
  JSON contract (method names, record shapes) is the compatibility surface;
  stored annotations have a format version and are validated on import.
- **Limits:** right-to-left and vertical scripts anchor correctly but PDF text
  lines are laid out left to right; fixed-layout EPUBs render as reflowable
  chapters; selections stop at page and chapter boundaries; the bundled OCR
  models read Latin script (plug another engine into `applyOcrLines` for others);
  encrypted PDFs are loaded whole.
