# Hub — to do

## Next phase: highlight and annotate, Hypothesis-style

**Formats**
- [ ] EPUB reader (there is already `cs-learning.epub` in the root to develop against)
- [ ] PDF reader for PDFs with a real text layer (not scans)
- [ ] Markdown and HTML keep working as now

**Highlighting**
- [x] Select text → a tiny flyout menu appears at the selection: highlight / annotate (markdown and code files)
- [x] Choose a highlight colour in the flyout; the choice sticks until changed
- [x] Highlight types: each type has its own colour and a name the user can set (e.g. "definition", "question", "don't understand yet")
- [x] Highlights are saved and persist across sessions — markdown and code files
- [ ] Same for HTML, EPUB and PDF

**Annotating**
- [x] The existing bottom text input stays where it is and is also the annotation input
- [x] When text is selected or an existing highlight is active, an indicator above the input shows which highlight is being annotated
- [x] A highlight can exist with no annotation; an annotation can be added to it later
- [ ] Remove a highlight type (types can be added, renamed and recoloured, not deleted)

**Mobile**
- [x] Input sits at the bottom of the screen and grows to about a quarter of it while typing
- [x] Sidebar and notes become slide-over drawers; one document at a time
- [x] Phone layout looked at on a real phone by the user (drawers, top bar)
- [x] "+" on each file row opens it alongside what is open; note box keeps its height, with a handle to pull or press
- [ ] Still unchecked on a real phone: touch text selection and the highlight menu were only checked in an emulated browser

**Front page**
- [ ] Recent list: latest highlights and annotations, each showing its document and section, linking to the spot

**Open questions**
- How to anchor a highlight in EPUB and PDF so it survives re-opening (today's notes anchor by quoted text plus heading, which only suits markdown)
- (Settled for markdown: a highlight is a note with a quote, a type and no text yet; same file, `notes/notes.json`)

## Accessibility (autism / ADHD study aid)

- [x] Sidebar can be tucked away; returns on hovering or clicking the left edge
- [x] Reading focus mode (fades everything but the block being read), roomy text, text size, progress bar
- [x] Thick keyboard focus outline; file rows and tabs reachable with Tab and Enter
- [ ] Keyboard shortcuts (toggle sidebar, focus mode, next/previous heading)
- [ ] Check every theme's contrast; Eva and Triple-M muted text has not been measured
- [ ] Screen-reader pass (labels on grips, live region when a note is saved)
- [ ] Dyslexia-friendly font option; line-by-line reading ruler
- [ ] Session aids: "where I stopped" bookmark per document, optional timer

## Next: a C server that also runs on an ESP32

Goal: serve the same `index.html` from an ESP32 with the documents on a microSD card, for one or two people.

- [ ] Write the HTTP API down as the contract (routes, request and response shapes) so two servers can be checked against it
- [ ] One portable C server in `server-c/`: POSIX sockets and plain file I/O, which ESP-IDF also provides (lwIP sockets, FAT on SD through its file layer). Build and test it on the Mac first, against the existing page
- [ ] Small platform layer for what differs: Wi-Fi start-up and SD mount on the ESP32; file-change events on desktop, polling on the ESP32
- [ ] Streaming file reads, one notes file per document, cached file index, write-to-temp-then-rename for saves
- [ ] ESP32 build (ESP-IDF project in `server-c/esp32/`), tried on a board with PSRAM
- [ ] HTTP Range requests and long cache headers, so the browser's PDF reader can fetch a large PDF a piece at a time and the reader's own scripts load from the card only once
- [ ] EPUB and PDF are parsed in the browser (the board only serves the bytes); keep those libraries on the card, gzipped
- [ ] When the C server passes the same checks as the Node one on desktop, delete the Node server

Do the work on a branch and merge it; do not keep two long-lived branches. One C server for both targets, not C on the board and Node on the desktop, and C not C++ (nothing here needs C++, and C keeps it closer to the systems track).

## Idea: a C/C++ document parser for highlight continuity (EPUB and PDF)

Parse EPUB and PDF into a stable structure of pages / sections / paragraphs with C or C++, so that highlights can be laid back over a document whenever it is uploaded again, and carried across different versions or files of the same document. Looks ahead to several people working on the same group of documents.

- [ ] Decide what a highlight's address is: paragraph identity (a hash of its normalised text) plus an offset and the quoted text, so it survives re-pagination and small edits
- [ ] Matching between versions: exact paragraph hash first, then nearest-text match for paragraphs that changed; report highlights that could not be placed instead of dropping them
- [ ] Document identity: recognise "the same document" across files (title/author metadata, or overlap of paragraph hashes)
- [ ] Where it runs: compiled to WebAssembly it could run in the browser, which keeps the ESP32 as a plain file server; on the board itself only small documents would be realistic
- [ ] Per-person highlight files, so two readers of one document do not overwrite each other
- Open question: how this relates to the browser-side EPUB/PDF rendering planned above. One option is the browser renders, the parser only produces the paragraph map used for anchoring

## Project structure

- [ ] Decide whether the hub becomes its own code project (own branch or repo), using this repo's markdown files and folders as example content to develop with
- [ ] Possible front-end rewrite in Preact with no build step, keeping the small Node server for file access and live reload

## Carried over from the first brainstorm

- [ ] Notes can be deleted but not edited
- [ ] Notes pinned inside HTML documents are saved but not highlighted in the page
- [ ] Concept map as a home view
- [ ] Interactive visualisations (function arrow diagrams, pigeonhole, truth tables), proof stepper
- [ ] Maths ↔ code side by side per concept
