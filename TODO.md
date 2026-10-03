# Hub — to do

## From the review (`REVIEW.md`), in order

The review found the reader is not private yet. This order replaces the old one where they differ.

1. [ ] Retire the Node server: workspaces and streamed files in C++, then delete `hub/server.js`
2. [ ] Split `hub/index.html` into modules; commit a browser test suite
3. [ ] Content cannot act: sanitise markdown, Content-Security-Policy on the reader, serve `/raw/` sandboxed, block loading from the internet
4. [ ] The server knows who is asking: allowed host names, device pairing and tokens, storage quota; body cap in Node, catch-all and connection limits in C++, outbox keeps changes the server refused
5. [ ] Encrypted connection: TLS with a trust step in the interface; then the service worker
6. [ ] Encrypted copies on the device
7. [ ] Decide: devices encrypt before upload (the board only holds ciphertext), or the board encrypts the card itself
8. [ ] Performance pass for the board: index file, notes per document, incremental rendering

## Annotations that link (after review steps 1 to 3)

- [ ] A note can refer, inline, to another document or file, to a heading in it, and to another note or highlight. Suggested form: `[[path/to/file.md]]`, `[[path/to/file.md#heading]]`, `[[note:<id>]]`; shown as a link that opens the target (a note link opens its document and selects that highlight)
- [ ] Typing `[[` in the note box offers documents and recent highlights to pick from
- [ ] Each note shows what refers to it ("mentioned in")
- [ ] Notes on pictures, video and sound: already possible as a note on the whole file; show them beside the viewer and the player
- [ ] Notes at a moment in a video or track: one extra field, the time in seconds (and optionally an end time). Pressing the note seeks to it; notes light up as playback passes them. Cheap to store and to draw
- [ ] Notes on a region of a picture (a rectangle), later
- Depends on: note ids that never change (done: ids are made on the device), sanitised note text (review step 3), and a position as well as a quote for highlights (review, data model)

## Earlier plan, in order

**0. Restructure (done, except the last item)**
- [x] Tracked starter content lives in `sample/`; the live workspace is `data/`, which git ignores. Notes, highlights, uploads and edits all happen in `data/`
- [x] The Node server reads `data/` by default and fills it from `sample/` on first run
- [x] Uploaded files and notes that were in git moved to `data/` and are no longer tracked
- [x] Those files removed from git history on this machine (backup of the old history: `../cs-learning-before-history-rewrite.bundle`)
- [ ] Force-push `main` to GitHub so the old history there is replaced, and push `c-server` (not done: it overwrites what is on GitHub)

**1. Media and partial files**
- [x] Both servers list pictures, video and sound, know their types, and send part of a file on request (HTTP Range), which video playback and large PDFs need
- [x] Picture viewer: fits the pane, click or button for full size with the clicked spot held in place, "open in new tab"
- [x] Video viewer with a full-screen button; sound files open in the music player
- [x] Clicking a picture inside a markdown document opens it in the viewer
- [x] Relative `<video>` and `<audio>` paths inside markdown load from storage, as images already do
- [ ] Try a real video file (only partial-file sending was tested, not playback)
- [ ] Pinch-zoom and drag-to-pan in the picture viewer on a phone

**1b. Music player**
- [x] One player for the whole reader: music keeps playing while you read; small controls sit in the sidebar
- [x] Playlist of every sound file in the folder, grouped by folder and sub-folder, each marked on this device / server only
- [x] Previous (first press restarts the track, second goes back), play / pause, next; moves on at the end of a track
- [x] Volume slider on a computer; on a phone the device's own volume buttons are used
- [x] A track kept on the device plays with the server out of reach; tracks not kept are marked unavailable
- [x] Lock-screen / headset next and previous (media session), untested on a phone
- [ ] Try real mp3 files (tested with generated .wav tones)
- [ ] Shuffle and repeat; remember the last track and position

**1c. Front pages**
- [x] Under a front page's description: tiles for Everything, Documents, Pictures and video, Music, each with a count; pressing one lists what is there
- [x] Lists show everything together by default, with the folder beside each item; "group by folder" splits them (the music playlist follows the same choice)
- [x] Every folder can have its own `FRONTPAGE.md`: shown first in that folder in the file list, with tiles scoped to the folder, and editable in the reader
- [x] Uploading a folder asks for its front page: use the one it has, copy one of its top-level markdown files (its README by default), or make a new one
- [ ] Front pages for folders that are already in the workspace (only made on upload, or by adding a `FRONTPAGE.md` by hand)
- [ ] Video thumbnails (videos show as a labelled tile)
- [ ] The C++ server cannot yet open an upload as its own workspace, so that path is Node-only

**2. Working without the server (before HTTPS)**
- [x] Both servers accept a note id and time made on the device, and ignore a repeat of the same note
- [x] Documents you open are copied into the browser's own storage; "keep all" copies the rest
- [x] Outbox: notes, highlights, edits and deletions made while disconnected are held and sent, in order, when the server answers again
- [x] Adding files from the device ("add files…", or drag onto the sidebar): they go to `inbox/`, open straight away, and upload on reconnect
- [x] Every file shows its state: ● on this device, ○ server only, ↑ waiting to be sent; pressing the mark keeps, removes or discards
- [x] Status box: connected / not reachable, how many changes are waiting, how many documents are on the device
- [ ] Cold start with the server off still needs step 3 (the page itself cannot load without it)
- [ ] HTML pages kept offline lose their pictures and styles that live in separate files
- [ ] Pictures and video kept offline, opt-in per file
- [ ] If two devices edit the same note while both are offline, the later one to reconnect wins; no merge
- [ ] Editing the front page, settings and folder uploads are refused while offline (with a message), not queued
- [ ] Remove a file from the server from inside the reader (only local copies can be removed today)
- [ ] The C++ server has not been run with the page for a full session

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
