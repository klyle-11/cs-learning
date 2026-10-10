# Hub — to do

## From the review (`REVIEW.md`), in order

The second review pass (3 October 2026) found the reader private in the ways the first pass asked for, with one serious new item and a set of smaller ones. Numbers in brackets are findings in `REVIEW.md`. This order replaces the old one where they differ.

Done from the first pass:

- [x] Content cannot act: sanitise markdown, Content-Security-Policy on the reader, serve `/raw/` sandboxed, block loading from the internet
- [x] The server knows who is asking: allowed host names, device pairing and tokens, storage quota; body cap in Node, catch-all and connection limits in C++, outbox keeps changes the server refused
- [x] Encrypted connection: TLS with a trust step in the interface (`/trust`); the service worker (`hub/sw.js`)
- [x] Encrypted copies on the device (passphrase; opt-in from the privacy box). [ ] Unlock with the device's fingerprint or face instead of typing

Now, in order:

1. [x] The certificate authority can vouch for the hub only (name constraints; its own key is never stored) (17). [ ] Remove the old "Hub local authority" from each device that has it; flash encryption on the board; the trust page should say what the fingerprint check is for (23)
2. [ ] Quiet data loss: a damaged notes or settings file must not be overwritten; read the body before the list when a note is edited; check that a copy was really stored before marking it kept; do not drop a file from the outbox when its bytes are missing (19, 20, 21)
3. [ ] Loose ends from the newest features: characters allowed in a hub's address; locked folders showing through in two lists; hidden and ignored files served by path; renew the pairing cookie (25, 28, 29, 30)
4. [ ] The page's own folder must not be writable through the API; the storage limit's two gaps in Node (18, 22)
5. [ ] Retire the Node server: workspaces in C++, then delete `hub/server.js`
6. [ ] A browser test suite in the repo; split `hub/app.js` into modules
7. [ ] Efficiency for the board and for phones: one list request per burst of changes, "not modified" answers and compressed files, a guarded watcher that keeps one list, notes per document (32, 33, 24, 36); then the rest of 34 to 39
8. [ ] Design and flow: the "rough edges" table in the review, starting with the note box on a phone, the contents button overlapping "edit front page", and playing a track without leaving the page
9. [ ] Decide: devices encrypt before upload (the board only holds ciphertext), or the board encrypts the card itself
10. [ ] Smaller items: pairing from other sites, tokens for other hubs, an undo for folder removal (26, 27, 31)

Not yet checked on real devices: installing the authority on an iPhone and an Android phone, and the reader in Safari and Firefox (tested in Chrome only).

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
- [x] Shuffle and repeat (repeat the queue, repeat one, or none); a queue of sound and video files, listed under the controls
- [ ] Remember the last track and position

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
- [x] Cold start with the server off: the page itself is kept by a service worker (needs HTTPS or localhost)
- [ ] HTML pages kept offline lose their pictures and styles that live in separate files
- [x] Pictures and video kept offline, opt-in per file (and "keep all pictures and videos", separate from documents and music)
- [ ] If two devices edit the same note while both are offline, the later one to reconnect wins; no merge
- [ ] Editing the front page, settings and folder uploads are refused while offline (with a message), not queued
- [x] Remove a folder from the server from inside the reader (on its front page). [ ] Single files still cannot be removed; removal has no undo (review, 31)
- [ ] The C++ server has not been run with the page for a full session

**3. HTTPS and opening with no board at all (once the ESP32 build exists)**
- [ ] HTTPS on the board with a certificate each device trusts once
- [x] The trust step is part of the interface (`/trust`); see the review, 17 and 23, for what it should say differently
- [x] Service worker so the reader opens from the home screen with the server off
- [x] "Add to Home Screen": manifest, icon, theme colour. [ ] Offer installing from inside the reader

**4. Security**
- [x] Links inside an HTML page never navigate the frame: other documents open in the reader, other sites open in a new browser tab
- [x] A page that tries to leave by script or redirect is brought back once, then stopped
- [x] Both servers refuse changes sent from another website (Origin check)
- [ ] Optional WireGuard tunnel on the board, so only devices holding a key can reach it and traffic is encrypted. Note: this protects the connection but does not count as HTTPS to a browser, so it does not replace step 3 for offline use
- [x] A saved HTML page cannot load anything from the internet (the content policy on `/raw/`; not an option, always on)
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
- [x] The tab bar's back button remembers places (a document, its section, how far down) and keeps at most two per document, the first and the latest, so back crosses documents instead of walking through every section of one (board branch)
- [ ] A visible list of where back would go (a long press on it), now that the list is short enough to read

## The C++ server (branch `c-server`, folder `server-cpp/`)

Goal: serve the same `index.html` from an ESP32 with the documents on a microSD card, for one or two people. One C++ server for both desktop and board; the Node server goes once this one fully matches it.

Done:
- [x] API written down as the contract: `server-cpp/API.md`
- [x] Desktop server `hubd` (C++17, POSIX sockets, cJSON): pages, files, document list, settings, front page, notes and highlights, folder upload into the workspace, live reload by polling
- [x] `test/contract.sh`: 107 requests sent to both servers, answers identical
- [x] `make check` build with memory-error detection; clean on the contract test and on malformed requests
- [x] Device profiles (desktop / small / esp32) picked at start-up, with caching of the page, scripts and document list
- [x] Write-up: `docs/08-server-migration/node-to-cpp-server.md`

Still to do:
- [ ] Upload as its own workspace, and switching workspaces (answers 501 for now)
- [x] Send and receive files in pieces instead of reading them whole
- [x] HTTP Range requests, so video can be played and a large PDF fetched a piece at a time. [ ] Cache headers: everything is still sent whole each time (review, 33)
- [x] Keep connections open between requests
- [x] ESP-IDF project in `server-cpp/esp32/` for the LilyGO T3 V1.6.1: Wi-Fi, SD card, a state partition in the board's own flash, then the same server as on a computer (its own HTTP and TLS code, not ESP-IDF's HTTP server). It builds with ESP-IDF 5.4 (`idf.py build`: 1.31 MB with the screen and updates, in a 1.38 MB update slot) and with PlatformIO (needs Arduino-ESP32 3.x); never run on a board. The board's own plan, review and guide: `server-cpp/esp32/TODO.md`, `REVIEW.md`, `README.md`
- [x] A full 32 GB card on the board (branch `claude/esp32-32gb-memory-efficiency-n3dz1c`): no 3 GB quota, the card's free space is the limit (FatFS's own count); what the folder holds is measured once at start-up and then counted as the server writes, instead of walking every file for each upload and storage question; no watcher (only the server writes to the card, so it announces its own changes); the document list streamed to a file on the card, never held as a JSON tree, with folder names sorted in 32 KB (a bigger folder is read in passes); folders listed through FatFS directly (sizes come with the directory, no `stat` per file); files of 2 to 4 GB served correctly; fewer FatFS file slots and no per-file sector buffers (about 65 KB of heap back). On 20,000 files the list peaked at 180 KB of heap, against 26 to 35 MB before (review, 24 and 32)
- [ ] Flash it: card prepared with `make card CARD=/Volumes/…`, Wi-Fi name and password in `HUB_WIFI_SSID` / `HUB_WIFI_PASSWORD`, then `pio run -d server-cpp/esp32 -t upload` and `pio device monitor`
- [ ] Measure free memory with 1 to 4 HTTPS connections open; lower the connection limit if needed. `GET /api/device` on the board reports free memory, the least since start-up and the largest block
- [ ] Titles survive a rebuild of the list: after any change the board reads the start of every markdown and HTML file again (fine for hundreds, slow for thousands on SPI)
- [ ] Upload limit on the board: 4 MB, though uploads go to the card in pieces and memory is not what limits them; time and the 4 connection places are
- [ ] Show the address, the certificate fingerprint and the pairing code on the board's screen (they go to the serial monitor for now)
- [ ] Answer to `hub.local` (mDNS component)
- [ ] A way to set the Wi-Fi name and password without rebuilding (they are build settings for now)
- [ ] One notes file per document, so a save on the board rewrites a small file
- [ ] Try it on the board; measure SD read speed and how long the document list takes
- [x] Copy the page and its scripts to the card (`hub/www/`): `make card CARD=/Volumes/…`. [ ] Serve them gzipped
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
- [ ] Split `server-cpp/src/hub.cpp` (2,100 lines) into routes, auth, store, docs, usage and status: `server-cpp/esp32/ARCHITECTURE.md`, which also weighs other ways to build the board's server and recommends keeping this one

## Carried over from the first brainstorm

- [ ] Notes can be deleted but not edited
- [x] Notes pinned inside HTML documents are highlighted in the page; per-file switch for the page's own scripts
- [ ] Concept map as a home view
- [ ] Interactive visualisations (function arrow diagrams, pigeonhole, truth tables), proof stepper
- [ ] Maths ↔ code side by side per concept
