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
- [x] Same for HTML pages (drawn inside the frame)
- [ ] Same for EPUB and PDF

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

## The C++ server (branch `c-server`, folder `server-cpp/`)

Goal: serve the same `index.html` from an ESP32 with the documents on a microSD card, for one or two people. One C++ server for both desktop and board; the Node server goes once this one fully matches it.

Done:
- [x] API written down as the contract: `server-cpp/API.md`
- [x] Desktop server `hubd` (C++17, POSIX sockets, cJSON): pages, files, document list, settings, front page, notes and highlights, folder upload into the workspace, live reload by polling
- [x] `test/contract.sh`: 36 requests sent to both servers, answers identical
- [x] `make check` build with memory-error detection; clean on the contract test and on malformed requests
- [x] Device profiles (desktop / small / esp32) picked at start-up, with caching of the page, scripts and document list
- [x] Write-up: `docs/08-server-migration/node-to-cpp-server.md`

Still to do:
- [ ] Upload as its own workspace, and switching workspaces (answers 501 for now)
- [ ] Send files in pieces instead of reading them whole (needed on the board; also lifts the memory cost of big files on desktop)
- [ ] HTTP Range requests and cache headers, so the browser's PDF reader can fetch a large PDF a piece at a time
- [ ] Keep connections open between requests (each request currently opens a new one)
- [ ] ESP-IDF project in `server-cpp/esp32/`: Wi-Fi start-up, SD mount, the same handlers registered with ESP-IDF's own HTTP server
- [ ] One notes file per document, so a save on the board rewrites a small file
- [ ] Try it on the board; measure SD read speed and how long the document list takes
- [ ] Copy the page and its two scripts to the card (`www/`), gzipped
- [ ] Run the page against `hubd` in a browser for a full session (only the API has been compared so far)
- [ ] When all of the above passes on desktop, delete `hub/server.js`

## Idea: a C/C++ document parser for highlight continuity (EPUB and PDF)

Parse EPUB and PDF into a stable structure of pages / sections / paragraphs with C or C++, so that highlights can be laid back over a document whenever it is uploaded again, and carried across different versions or files of the same document. Looks ahead to several people working on the same group of documents.

- [ ] Decide what a highlight's address is: paragraph identity (a hash of its normalised text) plus an offset and the quoted text, so it survives re-pagination and small edits
- [ ] Matching between versions: exact paragraph hash first, then nearest-text match for paragraphs that changed; report highlights that could not be placed instead of dropping them
- [ ] Document identity: recognise "the same document" across files (title/author metadata, or overlap of paragraph hashes)
- [ ] Where it runs: compiled to WebAssembly it could run in the browser, which keeps the ESP32 as a plain file server; on the board itself only small documents would be realistic
- [ ] Per-person highlight files, so two readers of one document do not overwrite each other
- Open question: how this relates to the browser-side EPUB/PDF rendering planned above. One option is the browser renders, the parser only produces the paragraph map used for anchoring

## Using it like an app on a phone

- [ ] "Add to Home Screen" polish: a web manifest, an icon and a theme colour, so it opens full-screen from an icon. No reinstall is needed after changes; it loads the current page from the server each time
- [ ] Offline is the hard part on the ESP32: the browser feature that lets an installed web app work offline (a service worker) only runs on HTTPS or localhost, and the board serves plain HTTP on a local address
- [ ] Alternative for offline reading: "export a snapshot", one self-contained HTML file holding the reader, the documents and the notes at that moment
- [ ] Keep documents and unsent notes in the browser's own storage, and send notes to the board when it is reachable again

## Project structure

- [ ] Decide whether the hub becomes its own code project (own branch or repo), using this repo's markdown files and folders as example content to develop with
- [ ] Possible front-end rewrite in Preact with no build step, keeping the small Node server for file access and live reload

## Carried over from the first brainstorm

- [ ] Notes can be deleted but not edited
- [x] Notes pinned inside HTML documents are highlighted in the page; per-file switch for the page's own scripts
- [ ] Concept map as a home view
- [ ] Interactive visualisations (function arrow diagrams, pigeonhole, truth tables), proof stepper
- [ ] Maths ↔ code side by side per concept
