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
2. [x] Quiet data loss: a damaged notes or settings file must not be overwritten; read the body before the list when a note is edited; check that a copy was really stored before marking it kept; do not drop a file from the outbox when its bytes are missing (19, 20, 21)
3. [x] Loose ends from the newest features: characters allowed in a hub's address; locked folders showing through in two lists; hidden and ignored files served by path; renew the pairing cookie (25, 28, 29, 30)
4. [x] The page's own folder must not be writable through the API (18)
5. [x] Retire the Node server: workspaces in C++, `hub/server.js` deleted, `./start.sh` (and `npm start`) run `hubd`. [ ] A full session in a browser against `hubd` as the only server
6. [ ] A browser test suite in the repo; split `hub/app.js` into modules
7. Efficiency for the board and for phones. [x] One list request per burst of changes; "not modified" answers for the page's files; a guarded watcher; the folder walked at most once per interval; looking for an absent server less and less often; headings measured once per frame; the track list no longer rebuilt on play and pause (32, 33, 24, 37, 39). [ ] Compressed files; one shared list for the watcher and the document list; notes per document; files from another hub streamed; large files kept in pieces (33, 24, 36, 34, 35)
8. Design and flow: [x] find (file names, text in documents, notes); [x] a document reopens where it was left; [x] wide tables as cards on a phone; [x] pressed and hover look; [x] instant start from the kept page, with "a newer version is ready"; [x] a track plays without leaving the page; [x] a switch to show only what is on the device; [x] the hub's own computer uses `http://localhost` with no certificate. [ ] The rest: the "rough edges" table in the review, starting with the note box on a phone, the contents button overlapping "edit front page", and playing a track without leaving the page
9. [ ] Decide: devices encrypt before upload (the board only holds ciphertext), or the board encrypts the card itself
10. [ ] Smaller items: pairing from other sites, tokens for other hubs, an undo for folder removal (26, 27, 31)

Not yet checked on real devices: installing the authority on an iPhone and an Android phone, and the reader in Safari and Firefox (tested in Chrome only).

## Windows and Raspberry Pi (prepared 3 October 2026)

- [x] System-specific code gathered in `server-cpp/src/platform.hpp`, with a Windows half; Makefile branch, UTF-8 manifest, path checks for Windows; a Node launcher and `:win` scripts; `WINDOWS.md`
- [x] First build on Windows, working through the checklist in `WINDOWS.md`: built unchanged, 144 checks pass; `.gitattributes` and the test script needed fixing
- [ ] On Windows: a second device over HTTPS, and a full browser session
- [x] Repair the blank reader caused by a duplicate declaration in book scrolling (6 October 2026); scratch Chromium checks passed for desktop startup, cached reload and phone-sized startup. A full browser session remains unchecked.
- [ ] First build on a Raspberry Pi (needs mbedTLS 3)
- [ ] Then: a packaged desktop app with its own window (Tauri), starting with Windows
- [ ] Start with the system (a Windows service; a systemd unit on the Pi)

## Other hubs (built 3 October 2026)

- [x] A reader can be pointed at a hub on another machine: add it in settings by address, pair once, switch with a menu. Notes, uploads and find go to the hub being viewed
- [x] What is kept from each hub is stored side by side; "everything on this device" lists it by hub
- [ ] One merged list across hubs, in place of switching
- [ ] Media from another hub streamed, not fetched whole (review, 34)
- [ ] Hubs finding each other on the network, so no address has to be typed
- [ ] A publicly trusted certificate (Tailscale, or a domain of your own), so no authority has to be installed on any device (`CERTIFICATES.md`, option 4)
- [ ] Controls in the reader for network access and for retiring the authority (`CERTIFICATES.md`, "About a switch")

## The document engine (started 8 October 2026, branch `marginalia-engine`)

`marginalia-engine-integration/` holds the engine's three packages and its guides. Only the npm package (WebAssembly) is used: the C library and the Python wheel are for Linux on x86-64, and the hub also has to run on Windows, macOS and a Raspberry Pi.

- [x] The npm package installed in `hub/`, served by `hubd` under `/vendor/marginalia/`, kept by the service worker, copied by `make card`
- [x] PDFs: words on a page can be selected (double-press a word, drag the handles), highlighted with a type, written about, found again after a reload, pressed to open; "night" recolours paper and ink and leaves pictures alone
- [x] A highlight on a PDF is a note with the engine's anchor in `mg`; the server stores it (contract test) and the outbox carries it like any note
- [ ] Decide whether `marginalia-engine-integration/` (13 MB of archives) is committed. `hub/package.json` points at the `.tgz` in it, so a fresh clone needs that one file for `npm install`
- [x] Books drawn from the engine (9 October 2026, review third pass): with the server in reach, a page of a book is drawn from `engine.chapter` into its frame (no scripts, forms or frames; HTML entities resolved; the book's style sheets and pictures from the engine), and the book is read by the reader's own engine worker (`hub/js/engine-worker.js`) a piece at a time by range requests: a chapter in the middle of a 6.3 MB book took 4 requests and 197 KB. The file's SHA-256 comes from the server (`/api/sha256`). Highlights are placed by the engine's anchor first; older book highlights are given one the first time their page is opened. The server's page list stays, so pages, covers, "keep", places and find are unchanged. [ ] Offline, and on another hub, a page is still the server's (named entities still cut such a page short: review, 42); keeping a book as one file would let the engine draw it offline too. [ ] Search and contents from the engine
- [x] A book with no page to resume at opens at the start of its front matter (from the engine's `frontMatter`), not at its contents (9 October 2026)
- [x] "space on this device…" in the settings: every kept copy with its size, largest first, removed from the device (not the server) on a second press. A book is one item. Sizes are read without decrypting protected copies. Checked in headless Chromium. [ ] Not tried on an iPhone
- [x] With the bars put away, a PDF's sliders button sits with the muted ones at the top left on a phone (9 October 2026)
- [x] "soft edges" in the settings: rounded corners, fills instead of outlines, soft shades at the seams, with any theme; kept with the look (9 October 2026). [ ] Not looked at on a real phone or in every theme
- [ ] Find in a PDF's text (`engine.search`), and its table of contents (`engine.sections`) in the outline
- [ ] Scanned PDFs: the engine's OCR, which needs two model files (about 12 MB) that are not in the package
- [ ] A PDF that is not kept on the device is fetched whole for the engine; the engine worker that reads books in pieces (`hub/js/engine-worker.js`) would spare that, with the file's SHA-256 from `/api/sha256`
- [ ] Notes that follow a renamed file by its hash (`mg.doc`)
- [ ] A real phone (iPhone, Android), Firefox and Safari: checked in headless Chromium only
- [ ] The native library on the board or in a desktop app, if text is ever wanted on the server's side (find across PDFs)

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
- [x] The server reads `data/` by default and `start.sh` fills it from `sample/` on first run
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
- [x] Pressing a track plays it where you are; the player page opens from the sidebar's footer and does not start anything by itself
- [ ] Remember the last track and position

**1c. Front pages**
- [x] Under a front page's description: tiles for Everything, Documents, Pictures and video, Music, each with a count; pressing one lists what is there
- [x] Lists show everything together by default, with the folder beside each item; "group by folder" splits them (the music playlist follows the same choice)
- [x] Every folder can have its own `FRONTPAGE.md`: shown first in that folder in the file list, with tiles scoped to the folder, and editable in the reader
- [x] Uploading a folder asks for its front page: use the one it has, copy one of its top-level markdown files (its README by default), or make a new one
- [ ] Front pages for folders that are already in the workspace (only made on upload, or by adding a `FRONTPAGE.md` by hand)
- [ ] Video thumbnails (videos show as a labelled tile)
- [x] The C++ server can open an upload as its own workspace

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
- [x] EPUB reader: a book is listed as a folder of its pages in reading order and each page opens like an HTML page, served from inside the zip by the server (`server-cpp/src/zip.hpp`, own inflate; `epub.hpp`). Checked: every entry of two real books comes out byte for byte as a reference unzip gives it. [ ] Look at a book in a browser (pages are sent as XHTML, which the reader's frame code has not been run against). [ ] Next/previous page at the foot of a page. [ ] Search inside books. [ ] A page kept on the device shows without its pictures when the server is away
- [x] PDF reader for PDFs with a real text layer: drawn with PDF.js; the document engine (`marginalia-engine`, WebAssembly, served from `/vendor/marginalia/`) reads their text and where each character is. [ ] Scans (the engine's OCR and its models are not served)
- [x] A book's front matter, from the engine (`frontMatter`): each book is read once, quietly, and what is found is kept on the device. A book opens at its contents if it has them in front, else where its text begins; a leading page with no name but its file's is called by what it is (Cover, Title page, Copyright, Contents…). The older ways of finding a book's start stand where there is no engine. Checked on the sample book in headless Chromium (8 October 2026). [ ] Not kept across devices. [ ] The whole book file is fetched for this, once per book and device
- [x] A page of a book, named away from its book (a tab, #fav and the other groups, find, the latest notes, the note box, a reference written into a note), has the book's title after its name: "Contents - <title>". What was saved in a group before this is shown so too (8 October 2026)
- [ ] Markdown and HTML keep working as now

**Highlighting**
- [x] Select text → a tiny flyout menu appears at the selection: highlight / annotate (markdown and code files)
- [x] Choose a highlight colour in the flyout; the choice sticks until changed
- [x] Highlight types: each type has its own colour and a name the user can set (e.g. "definition", "question", "don't understand yet")
- [x] Highlights are saved and persist across sessions — markdown and code files
- [x] Same for HTML pages (drawn inside the frame)
- [x] Same for EPUB (a page of a book is an HTML page to the reader, anchors included). Tried in headless Chromium on a scratch copy, desktop and phone width (7 October 2026): select, highlight, a note on it, drawn again after a reload (`server-cpp/build/check-epubhl.cjs`). [ ] Not tried by touch on a phone itself. [x] PDF: words on a page are selected with the engine's own selection (double-press a word, drag the handles), and a highlight is kept with the engine's anchor (`mg` on the note). Tried in headless Chromium on a scratch copy, a word after an emoji included (8 October 2026). [ ] Not tried by touch
- [x] A highlight on a page of a book carries the engine's anchor as well as the reader's own (`mg`: the words and those around them, the place in the chapter, an EPUB CFI), and is placed by the engine first; the reader's own anchor is the fallback, and all there is with no server in reach or where the engine's text for the chapter is not the page's text letter for letter. The pages are still drawn in the frame, selected with the browser's own selection. Tried in headless Chromium: saved, drawn again after a reload, and found by the engine alone with the reader's anchor and quote spoilt (`server-cpp/build/mgcheck/check_epub.py`). [ ] Books drawn by the engine itself (its chapters, its selection with handles), as PDFs are

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
- [x] The picture and video viewer (and a gallery of saved links) is a lightbox on a phone: the whole screen, the top bar and tabs out of the way, the note box below it, "notes" and × in its bar (4 October 2026)
- [x] A picture at its real size fills the screen on a phone: the bar, the arrows and the reel lie over it, the browser's bars are put away where it can, and it stays so while stepping
- [ ] None of the lightbox has been looked at in a browser or on a phone (only the script's syntax was checked). To look at: the bar's width with all its buttons, the reel over the picture, full screen on Android, an iPhone (which has no full screen for a page), turning the phone on its side (wider than 760px, the lightbox rules stop applying)

**File list (4 October 2026)**
- [x] Every folder, subfolder and group starts closed each time the reader is opened
- [x] Quick open: a closed folder's line names what was last opened inside it, and opens it
- [x] An open folder no longer scrolls inside itself; its own line stays at the top, and the next top-level folder's line is held at the bottom edge as a handle to jump past it
- [x] Added folders are listed with the one most recently added to first, under `inbox/` (the server sends each file's `changed` time). [ ] The pages of a book carry no time, so a book at the top level sorts last
- [ ] The held line is for top-level folders only: a long open subfolder has no such handle
- [ ] None of this has been looked at in a browser

**Tabs, inbox, first line (6 October 2026)**
- [x] Opening takes the place of the tab being looked at; a tab is added only by a double click or the + on a file's line. The "preview" tab (italic, kept by a double click on it) is gone
- [x] Beside back, the latest opened as a list (the ▾, holding back down, or the other mouse button). The list is kept with the layout, and shows 11 at most
- [x] Inbox: a line of its own in the file list, and a page of cards of everything in it, the latest changed first. [ ] A book in it sorts last (its pages carry no time, as above). [ ] `.txt` and other files the server does not list are not on it
- [x] The "Files" line is gone; #, + and upload are at the end of the list's first line
- [x] A thin bar on a line or card while its copy is being made. [ ] It needs a `Content-Length` from the server; without one the bar stays a sliver until the copy is done
- [x] On a phone, a + at the end of the tab bar opens the file list to add a tab from: the list says so at its top, and whatever is pressed there next (a file, a book, a folder's line, something found) opens in a tab of its own. A book's line and a gallery's have the + of a file's line too (7 October 2026)
- [x] A folder's line, a one-line folder's and the inbox's have the + too: the folder's page (its front page, else the one made for it) in a tab of its own, the line neither opening nor closing (7 October 2026)
- [x] On a phone a PDF's own bar (size, night, reader, keep) is put away, for the room: a button in the top bar brings it out and puts it back (kept with the layout), and the PDF's tab says "page x of y", its name cut shorter for it. A computer keeps the bar as it was (7 October 2026)
- [x] Where a PDF was left is kept while it is read (until now only on leaving its tab, so closing the reader lost it), as its page and how far down that page, so it is found again on a screen of another width. A folder's page is gone back to as well. Text, HTML and a page of a book were kept already. Checked in headless Chromium, both widths (`server-cpp/build/check-pdfbar.cjs`). [ ] Kept on this device only: another device does not know of it. [ ] Not kept: a PDF in the browser's own viewer ("reader" off), how far into a video or a sound file, a book page that scrolls a box of its own
- [x] A button before "In:" over the note box puts the bars over the page away (the tabs, and a phone's top bar) and brings them back; kept with the layout. On a phone a PDF's page count goes with its tab (7 October 2026)
- [x] Each line of the queue has four buttons: to the top, one up, one down, to the bottom; in the player and in the sidebar's small queue. The order is kept
- [x] A press on a track's line while something is playing asks first ("Keep playing", "Add to queue", "Play instead"; for the song that is playing, "Start again"). Nothing playing, or paused: it plays at once. Next, previous and the end of a track never ask; nor does "play" on an album's card. Checked in headless Chromium with real sound files (`server-cpp/build/check-askplay.cjs`, `check-bare-queue.cjs`). [ ] Not tried on a phone itself; a video started from its own viewer does not ask
- [x] Groups in the file list are marks that run on and wrap (`#name 4`), not a line each; one that is pressed lists what is in it under the marks, one at a time. Naming a group offers the groups there are as marks under the name (five, the latest first, narrowed by what is typed; the browser's own list of suggestions is gone, as a phone could not be counted on to show it); a name in use turns "save" into "add to it". Checked in headless Chromium, both widths (`server-cpp/build/check-groups.cjs`) (7 October 2026)
- [x] A locked folder and finding: the find box already left out its files, lines and notes while it is locked (checked: names, titles, lines, notes, a book, a folder with no front page; `server-cpp/build/check-locksearch.cjs`). Two places still named what is inside and no longer do: "Latest searches" on the front page (the words and the file opened from them) and the list of a group's items. [ ] The server's own answer to `/api/search` still holds lines from a locked folder (the reader drops them): the lock is the reader's, not the server's (7 October 2026)
- [x] A folder is uploaded under a name of its own: the upload dialog has "Name in the hub", with the folder's name on its disk offered first (one box per folder when several are uploaded). A name already in use is said to be, since the files would join that folder. The front page made for it takes the new name, and "update…" no longer asks about the differing name for the folder it was uploaded from. Checked in headless Chromium through the folder chooser's input (`server-cpp/build/check-uploadname.cjs`); the several-folders dialog and "update…" after a rename were not run. [ ] Renaming a folder that is already in the hub needs the server (7 October 2026)
- [x] A locked folder stays in the file list where it was: one line under its name, marked "locked", under the same kind as before (its kind is still told from what is in it, which was what moved it to "Books and documents" before); pressing it asks for the password. One inside an open folder is a line there. Nothing in it is named. The cards on the front page keep their kind the same way (`server-cpp/build/check-locknav.cjs`) (8 October 2026)
- [x] A folder with no front page has "update…", "lock…" and "remove folder…" under the page made for it (a gallery, a music page, a page of cards), as a front page has; not the inbox (`server-cpp/build/check-galleryacts.cjs`)
- [x] Typing the password opens the one folder it was typed for; the others, though they have the same password, stay locked until each is opened (`server-cpp/build/check-unlockone.cjs`) (8 October 2026)
- [x] Every page of cards has the size slider (the front page's folders and a folder's cards had none, and were resized all the same from a gallery); a page shows one at a time, and all say the one size (`server-cpp/build/check-slider.cjs`)
- [x] A password asked for no longer fills the find box: a browser that keeps passwords took the find box for the name that goes with the password. Each password box now has a name box of its own, out of sight. [ ] Not checked: it needs a browser with a kept password, which the test browser has not; a browser that already kept one under the old name may fill the find box once more
- [x] "lock now" is also under the title of an open locked folder's page (its front page, or the page made for it), not only among the buttons at the foot; on the page of a folder inside a locked one it names the folder that is locked (`server-cpp/build/check-locktop.cjs`). [ ] Locking from a gallery goes to the workspace's front page, not to the folder's "is locked" page (8 October 2026)
- [x] "Save note" over the right end of the note box, on a phone and on any touch screen: until now Enter was the only way to save, and a phone's keyboard cannot be counted on to send it. On a phone the box's lower corners are rounder (40px), after the phone's own. Saved in headless Chromium at phone width on a page of each kind (markdown, source, PDF, picture, video, sound file). [ ] Not tried on a phone itself (7 October 2026)
- Checked in headless Chromium, desktop and phone width, on a scratch workspace (`server-cpp/build/check-tabs.cjs`). [ ] Not tried on a phone itself; a double tap may or may not arrive there as a double click

**Saved links (4 October 2026)**
- [x] A filter by the entries a JSON file's items have (thumbnail, video, webm, picture, sound, page, linked page, source page); `.webm` is a kind apart from video; the words filter looks in every address of a card, not only its name; an address with a media type anywhere in it (`….mp4/?rnd=1`) is direct media
- [x] The gallery viewer's bar has the exact address of what it shows, and every address of that item listed under the bar
- [x] No play button over a thumbnail clip that is already playing; an `.mp4` saved as a thumbnail is the video itself
- [x] Only an address that is a media file by its type becomes a card; a web page saved as a thumbnail or as direct media is listed as a page
- [ ] Media addresses with no file type in them (some sites' thumbnails) now count as pages: decide per site if any should be let through
- [ ] `.m3u8` streams are pages (only Safari plays them by itself)
- [ ] None of it looked at in a browser

**Front page**
- [x] Recent list: latest highlights and annotations, each showing its document, linking to the spot (a box in the main front page's corner; not yet looked at in a browser)

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

Goal: serve the same `index.html` from an ESP32 with the documents on a microSD card, for one or two people. One C++ server for both desktop and board. The Node server it was modelled on is gone (3 October 2026).

Done:
- [x] API written down as the contract: `server-cpp/API.md`
- [x] Desktop server `hubd` (C++17, POSIX sockets, cJSON): pages, files, document list, settings, front page, notes and highlights, folder upload into the workspace, live reload by polling
- [x] `test/contract.sh`: 144 requests, answers compared with `test/expected.txt`, recorded when both servers answered identically
- [x] `make check` build with memory-error detection; clean on the contract test and on malformed requests
- [x] `make test-own` (`npm run test:own`, `test:own:win`): the tests on a copy of the server built apart, `build/hubd-own`, so the hub can stay running (Windows will not replace a running `hubd.exe`). [ ] `npm test` still tests the old program without saying so when the build fails at the link. [ ] Three answers (a note with `ü` and `ï` in it) differ when the tests are started from Git Bash and not from PowerShell
- [x] Device profiles (desktop / small / esp32) picked at start-up, with caching of the page, scripts and document list
- [x] Write-up: `docs/08-server-migration/node-to-cpp-server.md`

Still to do:
- [x] Upload as its own workspace, and switching workspaces (not on the board, where the page lives inside the served folder)
- [x] Send and receive files in pieces instead of reading them whole
- [x] HTTP Range requests, so video can be played and a large PDF fetched a piece at a time. [ ] Cache headers: everything is still sent whole each time (review, 33)
- [x] Keep connections open between requests
- [x] ESP-IDF project in `server-cpp/esp32/` for the LilyGO T3 V1.6.1: Wi-Fi, SD card, a state partition in the board's own flash, then the same server as on a computer (its own HTTP and TLS code, not ESP-IDF's HTTP server). It builds with PlatformIO (`pio run -d server-cpp/esp32`: 1.3 MB of the 4 MB flash); never run on a board
- [ ] Flash it: card prepared with `make card CARD=/Volumes/…`, Wi-Fi name and password in `HUB_WIFI_SSID` / `HUB_WIFI_PASSWORD`, then `pio run -d server-cpp/esp32 -t upload` and `pio device monitor`
- [ ] Measure free memory with 1 to 4 HTTPS connections open; lower the connection limit if needed
- [ ] Show the address, the certificate fingerprint and the pairing code on the board's screen (they go to the serial monitor for now)
- [ ] Answer to `hub.local` (mDNS component)
- [ ] One hub on two computers (Windows and the Mac, one running at a time), so a phone keeps the one installed reader and what it saved to the device. Three parts:
  - [ ] Announce `hub.local` from the desktop server too, both halves in `platform.hpp` (the name is already accepted and already in the certificate: `hub.cpp`, the list of host names). The phone then has one address whichever computer answers
  - [ ] The same state folder on both (`%APPDATA%` on Windows, `~/.config/hub` on the Mac): one authority, one list of paired devices. `issuer-key.pem` is then on two machines: a line in `CERTIFICATES.md` and `REVIEW.md` when it is done
  - [ ] The same `data/` on both (it is not in git): synced by something outside the hub, or served from one place
  - The reader installed from the Windows address stays tied to that address: it is installed once more from `hub.local`, and what was saved to the device is fetched once more. Not tried
- [ ] A way to set the Wi-Fi name and password without rebuilding (they are build settings for now)
- [ ] One notes file per document, so a save on the board rewrites a small file
- [ ] Try it on the board; measure SD read speed and how long the document list takes
- [x] Copy the page and its scripts to the card (`hub/www/`): `make card CARD=/Volumes/…`. [ ] Serve them gzipped
- [ ] Run the page against `hubd` in a browser for a full session (only the API has been compared so far)
- [x] `hub/server.js` deleted. The last commit that has it is `d8d878f`, if it is ever needed for comparison

## Idea: a C/C++ document parser for highlight continuity (EPUB and PDF)

Parse EPUB and PDF into a stable structure of pages / sections / paragraphs with C or C++, so that highlights can be laid back over a document whenever it is uploaded again, and carried across different versions or files of the same document. Looks ahead to several people working on the same group of documents.

- [x] Decide what a highlight's address is: the block (a hash of its letters and digits, and which of the blocks with that hash), the offset in it, the quoted text and the characters on either side. Done for markdown, source files and HTML: `server-cpp/src/anchor.hpp`, `GET /api/blocks`, and "anchors" in `hub/app.js`. The server's block map from markdown source and the page's from the rendered document agree on every block of the 35 sample documents. [ ] Try it in a browser: make two highlights on the same words in one document and reload
- [ ] Give the highlights made before anchors an anchor (they are placed at the first occurrence under their heading until then)
- [ ] Matching between versions: exact paragraph hash first, then nearest-text match for paragraphs that changed; report highlights that could not be placed instead of dropping them
- [ ] Document identity: recognise "the same document" across files (title/author metadata, or overlap of paragraph hashes)
- [ ] Where it runs: compiled to WebAssembly it could run in the browser, which keeps the ESP32 as a plain file server; on the board itself only small documents would be realistic
- [ ] Per-person highlight files, so two readers of one document do not overwrite each other
- Open question: how this relates to the browser-side EPUB/PDF rendering planned above. One option is the browser renders, the parser only produces the paragraph map used for anchoring

## Project structure

- [ ] Decide whether the hub becomes its own code project (own branch or repo), using this repo's markdown files and folders as example content to develop with
- [ ] Possible front-end rewrite in Preact with no build step, keeping the server as it is

## Carried over from the first brainstorm

- [ ] Notes can be deleted but not edited
- [x] Notes pinned inside HTML documents are highlighted in the page; per-file switch for the page's own scripts
- [ ] Concept map as a home view
- [ ] Interactive visualisations (function arrow diagrams, pigeonhole, truth tables), proof stepper
- [ ] Maths ↔ code side by side per concept
