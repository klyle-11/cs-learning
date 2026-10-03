# Hub — to do

## Current plan, in order

**0. Restructure (done, except the last item)**
- [x] Tracked starter content lives in `sample/`; the live workspace is `data/`, which git ignores. Notes, highlights, uploads and edits all happen in `data/`
- [x] The Node server reads `data/` by default and fills it from `sample/` on first run
- [x] Uploaded files and notes that were in git moved to `data/` and are no longer tracked
- [ ] Remove those files from git history as well (needs the restructure committed first; rewrites history, so GitHub needs a force-push afterwards)

**1. Media and partial files**
- [x] Both servers list pictures, video and sound, know their types, and send part of a file on request (HTTP Range), which video playback and large PDFs need
- [ ] Viewer in the reader for images and video: smooth, fits the pane, zoom to full size, button to open in a new tab / the default browser
- [ ] Relative `<video>` and `<audio>` paths inside markdown load from storage, as images already do

**2. Working without the board (before HTTPS)**
- [x] Both servers accept a note id and time made on the device, and ignore a repeat of the same note
- [ ] Documents kept in the browser's own storage on the device
- [ ] Outbox: notes and highlights made while disconnected are held and sent when the board answers again
- [ ] Adding files from the device while disconnected: held locally, uploaded on reconnect. Removing a local copy is one tap
- [ ] Every file shows its state clearly: on this device, on the board only, or waiting to upload
- [ ] A status line: connected / not reachable, and how many changes are waiting
- [ ] Pictures and video kept offline, opt-in per file (after documents work)

**3. HTTPS and opening with no board at all (once the ESP32 build exists)**
- [ ] HTTPS on the board with a certificate each device trusts once
- [ ] The trust step is part of the interface: it says what is happening, why, and whether it worked, in plain words
- [ ] Service worker so the reader opens from the home screen with the board off
- [ ] "Add to Home Screen" polish: manifest, icon, theme colour

**4. Security**
- [x] Links inside an HTML page never navigate the frame: other documents open in the reader, other sites open in a new browser tab
- [x] A page that tries to leave by script or redirect is brought back once, then stopped
- [x] Both servers refuse changes sent from another website (Origin check)
- [ ] Optional WireGuard tunnel on the board, so only devices holding a key can reach it and traffic is encrypted. Note: this protects the connection but does not count as HTTPS to a browser, so it does not replace step 3 for offline use
- [ ] Option to block a saved HTML page from loading anything from the internet (images, fonts, trackers)
- [ ] Confirm on a real phone that an external link opens the default browser (could not be observed in the test browser)


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

## Project structure

- [ ] Decide whether the hub becomes its own code project (own branch or repo), using this repo's markdown files and folders as example content to develop with
- [ ] Possible front-end rewrite in Preact with no build step, keeping the small Node server for file access and live reload

## Carried over from the first brainstorm

- [ ] Notes can be deleted but not edited
- [x] Notes pinned inside HTML documents are highlighted in the page; per-file switch for the page's own scripts
- [ ] Concept map as a home view
- [ ] Interactive visualisations (function arrow diagrams, pigeonhole, truth tables), proof stepper
- [ ] Maths ↔ code side by side per concept
