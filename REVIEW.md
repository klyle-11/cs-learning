# Architecture, security and design review

Second pass, 3 October 2026, branch `c-server` at `e6d1996`. Read in full: `hub/server.js` (676 lines), `server-cpp/src/hub.cpp` (1,413), `http.hpp` (534), `secure.hpp` (316), `hub/local.js`, `vault.js`, `sw.js`, the trust page, and the board's start-up code; `hub/app.js` (about 2,700 lines) was read around everything that stores, fetches, inserts HTML or redraws. The first pass, the same day, found the reader open to anyone on the network; its checklist was ticked off as content isolation, pairing, HTTPS and device encryption were built. Added since then, and new to this pass: the service worker, the queue, keeping pictures and video, folder locks, folder removal, and other hubs.

**Since this pass was written, the same day:** finding 17 was fixed; the Node server was retired (`hub/server.js` is gone; `hubd` is the only server); findings 18 to 21, 24, 25, 29, 30, 32 and 37 were fixed and 28, 33 and 39 partly; find, reopening where you stopped, instant start and playing music without leaving the page were built; and the hub's own computer no longer needs the certificate authority, because `http://localhost` is served as it is. Each item below says what was done. The server's test now covers 144 requests. The server was also prepared for Windows and Raspberry Pi (`WINDOWS.md`): system-specific code moved into one file, with a Windows half that has not been compiled yet. One finding came out of that work and was fixed: the `notes` folder could be removed by asking for `Notes`, because macOS and Windows do not tell the two apart. Where a finding had a Node half, that half no longer exists, and the finding says so. Places given as `server.js:<line>` refer to the last commit that has the file, `d8d878f`.

Findings marked **confirmed** were reproduced against the scratch workspace (`data-test`) in this pass. The rest come from reading the code, with the place to look given. Nothing in this pass was changed in the code except one small list bug from the folder-lock work (a file added offline could drop out of the list when a lock changed).

## Verdict

The first pass said "not private today". That is no longer true: content cannot run code, strangers and other websites are refused, the network connection is encrypted, and the device copy can be encrypted. The four critical findings and most of the high and medium ones are fixed in both servers and held there by the comparison test.

What is left falls into three groups:

1. **One serious new item, fixed the same day: the hub's certificate authority.** To make HTTPS work, each device installs the hub's own authority. As first built, that authority could vouch for *any* website, not just the hub. It is now limited to the hub's own names and home-network addresses, and its key is no longer kept (finding 17). What is left is on the devices: the old authority has to be removed from each one by hand.
2. **Quiet data loss.** Several paths drop or overwrite data without saying so: a damaged notes file is replaced by an empty one, a copy that did not fit on the device is still shown as kept, storage that is full swallows unsent notes. Findings 19 to 21. None is likely on a laptop with 40 documents; all become likely on a phone that is nearly full or a board with little memory.
3. **Work done too often, and too much held in memory**, which is what will decide whether the board is usable. Findings 32 to 39.

The features added today (other hubs, folder locks, folder removal) opened a few small holes of their own, listed as 25 to 28 and 31. None lets a stranger in.

## Checklist

Ticked means fixed in both servers and the page, and covered by a test.

| | Finding | State |
|---|---|---|
| Critical | 1 markdown runs code, 2 uploaded HTML/SVG runs code, 3 no login, 4 unencrypted | done; re-checked, still hold |
| High | 5 foreign host name, 6 reading contacts the internet | done |
| High | 7 copies on the phone in the clear | built, but **off until "protect…" is pressed** |
| High | 8 the card in the clear | open: needs the decision under "Target design", layer 5 |
| High | 17 the authority could vouch for any site | fixed; **the old authority must still be removed from each device**, and the board needs flash encryption |
| Medium | 9, 10, 11, 13 | done (10 and 13 have new relatives: 24 and 21) |
| Medium | 12 no limit on total storage | done |
| Medium | **18 to 21, 23, 24** | **new, open** (22 went with the Node server) |
| Low | 14 symbolic links (now confirmed), 15 titles in browser history, 16 old commits on GitHub | open |
| Low | **25 to 31** | **new, open** |
| Efficiency | **32 to 37, 39** | **new, open** (38 went with the Node server) |

Also open, from the sections further down:

- [x] Retire the Node server. Done after this pass: workspaces were added to `hubd`, checked against Node on 123 requests, and `hub/server.js` deleted. Not yet done: a full browser session against `hubd` alone.
- [ ] Split `app.js` into modules. It has grown from about 2,000 lines to about 2,700.
- [ ] A browser test suite in the repo. This pass ran a dozen browser checks (queue, offline start, locks, two hubs side by side); all were throwaway scripts again, and they are already gone.
- [ ] Data model: highlight position as well as quote; note versions; clean-up of device copies.
- [x] Service worker, so the reader opens with the server off (`hub/sw.js`).
- [ ] Flash and try the ESP32 project.
- [ ] The design and flow items at the end of this document (ideas only; nothing changed).

## How this fits with `TODO.md` and the READMEs

`TODO.md` is the plan, and this review does not repeat it. Where a finding or an idea here is already planned there, this is where:

| Here | Already in `TODO.md` |
|---|---|
| Data model: a position as well as a quote for highlights | "Annotations that link" names it as a dependency; "Open questions" and "Idea: a C/C++ document parser" are the fuller plan (paragraph identity, an offset, and the quote) |
| 20 and data model: two devices editing one note | Working without the server: "the later one to reconnect wins; no merge" |
| 7: device encryption is opt-in | Step 6: "Unlock with the device's fingerprint or face instead of typing" |
| 16: old commits on GitHub | Step 0: "Force-push `main` to GitHub" |
| 23: the trust step | The C++ server: "Show the address, the certificate fingerprint and the pairing code on the board's screen" |
| 33: the page's files sent whole | The C++ server: "Serve them gzipped", and the "cache headers" half of "HTTP Range requests and cache headers" |
| 36: one notes file | The C++ server: "One notes file per document" |
| A dependable address for the hub | The C++ server: "Answer to `hub.local`" |
| Design: continue reading, recent | Front page: "Recent list"; Accessibility: '"where I stopped" bookmark' |
| Design: quick open, shortcuts | Accessibility: "Keyboard shortcuts" |
| Design: status colours | Accessibility: "Check every theme's contrast" |
| Design: player | Music player: "remember the last track and position" |
| Retiring the Node server | Step 1, and the whole "C++ server" list |

`TODO.md` had fallen behind the code; it was brought up to date alongside this pass (the service worker, the manifest and icon, shuffle and repeat, pictures and video kept per file, partial file requests in C++, the comparison test's size, and the review order at its top). The usage notes in `hub/README.md` still described the sidebar as it was before settings moved behind the gear; those lines were corrected too.

New in this review and not yet in the plan: findings 17 to 39 and the design table. The review order at the top of `TODO.md` now carries them.

## Security findings

Ordered by how much damage each allows. Network security is included here.

### Critical

- [x] **1. A markdown document can run code inside the reader.** Fixed: everything rendered from markdown goes through DOMPurify (`safeHtml` in `app.js`), and the page's content policy allows its own scripts only. *Re-checked:* there is one place where document content becomes HTML, and it is the sanitised one; the other `innerHTML` uses clear an element or insert the reader's own icons.

- [x] **2. Uploaded HTML and SVG files run with the reader's full rights when opened directly.** Fixed: everything under `/raw/` carries a sandbox policy with no scripts, in both servers. Pages from another hub are shown from text inside a frame that forbids scripts, and files from another hub reach the page only as pictures, sound or video, never as a document.

- [x] **3. No login.** Fixed: paired devices only, per-device tokens, only a hash kept. Still true by design: requests from the machine itself need no pairing unless started with `--pair-local`, so any program or user on that machine has full access.

- [x] **4. Everything travels unencrypted.** Fixed: HTTPS beyond the machine itself, TLS 1.2 or newer. The way trust is set up has two weaknesses of its own: 17 and 23.

### High

- [x] **5. A foreign host name is accepted.** Fixed: known host names only.

- [x] **6. Reading a document can contact the internet.** Fixed. The page may now also *connect* to the hubs listed under "Other hubs" (pictures and media still load from the server alone), so this now rests on that list holding only your own machines; see 25.

- [x] **7. Copies on the phone are stored in the clear.** Built (`vault.js`: a passphrase, 600,000 rounds, AES-256-GCM, hashed names). It is off until "protect…" is pressed, so by default the copies, the notes waiting to be sent and the tokens for other hubs (27) are readable in the browser profile.

- [ ] **8. The card is stored in the clear.** Unchanged. The folder lock added today does not change this: it is a lock on the reader, not on the files (28).

- [x] **17. The hub's certificate authority could vouch for any website, and on the board its key was not protected.** *New in this pass, and fixed the same day. Confirmed by test.*
The authority each device installs was made with no limit on which names it could sign for, and its private key was kept in the state folder. A device that trusted it would have accepted a certificate signed by it for any site at all, so whoever copied that key could have posed as any website to that device on a shared network. The trust page told the user the opposite.
*Fixed* (`secure.hpp`, `ensure_certs`): certificates are now made as a chain of three. The authority's own key is used once, to sign an *issuer*, and is never written to disk. The issuer, whose key is kept, carries name constraints marked critical: names under `.local`, `localhost`, the machine's own host names, and the private address ranges. Server certificates are signed by the issuer. A state folder from the old layout is replaced on first start, and the old key deleted. *Tested:* with the kept key, certificates were forged for `example.com`, for a public address, and through a further authority; LibreSSL and Apple's own checker on this Mac refused all three, and accepted the same forgery under an authority without limits (the control). The server still serves HTTPS with the new chain.
*Still to do:* **remove the old authority ("Hub local authority") from every device that installed it**; until then that device still trusts anything the old key signed, and the old key may survive in a backup. On the board, turn on flash encryption: the issuer's key is still readable over USB there, which now lets someone pose as the hub and nothing more. How the authority first reaches a device is still 23.

### Medium

- [x] **9. The Node server accepts request bodies of any size.** Fixed (1 MB).

- [x] **10. One bad request can stop the C++ server.** Fixed for connections. The folder watcher runs on a thread of its own with no such guard: 24.

- [x] **11. The C++ server reads whole files into memory.** Fixed: files and uploads move in pieces.

- [x] **12. No limit on total storage.** Fixed.

- [x] **13. Changes can be lost silently.** Fixed for the outbox: only a definite refusal drops a change, and it is listed. The same pattern exists in four newer places: 21.

- [x] **18. The page's own folder can be changed through the API when it sits inside the folder being served.** *New. From reading the code.*
On the board the documents are `/sdcard/hub` and the page is `/sdcard/hub/www` (`esp32/main/board.cpp:139`). `hubd` also prefers a `hub/` inside the served folder (`hub.cpp:1390`), and the README's "Starting a new learning environment" sets things up that way. Folder removal refuses only `notes` (`hub.cpp:1147`, `server.js:548`), and uploads refuse only hidden names. So a paired device can remove `www` and upload its own `app.js`. The planted script then runs in every other device's reader, with their unlocked copies and their tokens for other hubs. Paired devices are trusted with the data, but this turns "can write files" into "runs code on every device". In the usual laptop layout (`data/` beside `hub/`) the page is outside the served folder and this cannot happen.
*Fix:* refuse uploads, folder removal and front-page writes anywhere under the page's folder.
*Done after this pass:* uploads, folder removal and front-page writes are refused inside the page's folder.

- [x] **19. A damaged notes file is replaced by an empty one on the next change.** *New. From reading the code.*
Both servers treat a notes file that does not parse as an empty list (`server.js:82`, `hub.cpp:400`), and the next note written saves that list back: every earlier note is gone. Settings behave the same (`hub.json`: side list, ignore list, folder locks). `hubd` writes through a temporary file, so the likeliest cause of a broken file is a hand edit, or a tool writing replies into `notes.json`.
*Fix:* if the file exists and does not parse, refuse to write and say so; keep the previous version beside it.
*Done after this pass:* a notes or settings file that does not parse is never written over, and is not answered as "empty" either: reading and writing are both refused, with the reason. The reader then keeps showing its own copy of the notes and says so, and a damaged settings file no longer drops the folder locks. Covered by the server's test and a browser check. Not done: keeping the previous version beside the file.

- [x] **20. A slow edit to a note holds up every other save.** *New. From reading the code.*
(The Node server had the opposite fault, losing a change made during the wait; that went with it.) `hubd` takes its lock first and reads the request body while holding it (`hub.cpp:1230` to `:1244`), so one slow sender stalls all saving for up to a minute.
*Fix:* read the body first; then lock, read, change and write.
*Done after this pass:* the body is read before the lock is taken.

- [x] **21. What does not fit on the device is dropped without a word.** *New. From reading the code.* Four cases of the pattern in 13:
  - When the browser's small store is full, writes fail silently (`local.js:50`). That store holds the notes waiting to be sent and the outbox itself, so they are gone on reload. With several hubs and workspaces each caching a document list there, the 5 MB limit is closer than it was.
  - A copy that could not be stored is still marked as kept: `keepCopy` and `rememberDoc` ignore whether the write worked, so the file shows ● and is not there when the server is away.
  - A file added while offline whose bytes are missing from the device is removed from the outbox as if it had been sent (`flush`: the test is "no answer, or a good one").
  - "add files…" skips anything over 50 MB without saying so.
*Done after this pass:* a copy is marked kept only if it was stored, and "keep all" stops at the first one that does not fit; a store that refuses a write is reported in the status box, with protection on as well as off; a file whose bytes are missing is listed as not sent; files left out of "add files" are named. Not done: moving the notes and the outbox out of the small store, so a full store is now announced but can still lose them.

  *Fix:* check each result and show failures in the status box; move the notes and the outbox out of the small store into the same one as the copies.

- [x] **22. The Node server's storage limit had two gaps.** *Gone with the Node server.* `hubd` refuses uploads without a length, and measures the folder an upload goes to.
An upload that opens a workspace of its own is checked against how full the *open* workspace is (`server.js:483` to `:490`), so such uploads are never counted. And an upload sent without a stated length is checked as if it were empty: a one-byte upload sent in chunks was accepted without a length. The C++ server has no workspaces and refuses uploads without a length.
*Fix:* measure the folder the upload goes to; refuse uploads without a length, as the C++ server does.

- [ ] **23. The authority's certificate is handed out over an unencrypted connection.** *New. From reading the pages.*
By design the trust page and `hub-ca.crt` are reachable over plain HTTP, since the device cannot yet trust HTTPS. Someone on the same network at that moment can swap the file, and the fingerprint the page displays arrives over the same connection (`trust.js` fetches it from `/api/trust`), so they can swap that too. The only protection is the user comparing the page's fingerprint with the one the server printed in its terminal. The page asks for this, but does not say that the page itself may be forged or what is at stake; with 17, a swapped authority means everything that device does over HTTPS can be read.
*Fix:* say so plainly on the page; print the address and fingerprint together in the terminal (a QR code would do both); offer a way that does not use the network (the file over USB or AirDrop).

- [x] **24. On the board, a large folder can end the server.** *New. From reading the code.*
The folder watcher keeps two complete lists of every file's path (`hub.cpp:702`), and each request for the document list builds a third (`tree_stamp`, `:763`). On a microcontroller with a few hundred kilobytes free, a thousand files is enough to run out. The watcher's thread has no guard (`:1398`), so running out of memory there ends the whole process, which is exactly what 10 fixed for connections.
*Fix:* a `try`/`catch` in the loop; one shared list for the watcher and the document list; keep a running hash rather than the paths.
*Done after this pass:* the watcher's loop is guarded, and the list request walks the folder at most once per watch interval. The watcher and the list still keep separate lists.

### Low

- [ ] **14. A symbolic link inside the workspace that points outside it is followed. Confirmed.** A link to `/etc/hosts` placed in the folder was listed and served by Node through both `/raw/` and `/api/doc`. Uploads cannot create one, so this still needs file access. The C++ server follows links to folders as well when listing and measuring.

- [ ] **15.** Document titles and paths appear in the page title and address bar, so they land in browser history. Unchanged.

- [ ] **16.** Old commits may still be retrievable on GitHub by their id. Not re-checked in this pass.

- [x] **25. Hub addresses are put into the page's content policy without checking their characters. Confirmed** (the check accepts them). An address such as `https://x;sandbox` passes both servers' checks (`server.js:145`, `:412`; `hub.cpp:553`), and the page's policy is built by joining these addresses in. Spaces cannot get through, so nothing can be *allowed* this way, but a directive can be *added*: `sandbox` would stop the reader's own scripts on every device until `hubs.json` is repaired by hand. Only a paired device can do it. *Fix:* letters, digits, dots, hyphens, colons and brackets only.
*Done after this pass:* letters, digits, dots, hyphens, colons and brackets only. Covered by the server's test.

- [ ] **26. Pairing can now be attempted from other websites.** So that a reader loaded from one hub can pair with another, `POST /api/pair` is no longer refused when it comes from another site (`server.js:371`, `hub.cpp:873`). Guessing the code is not realistic (five tries at one in a million million), but a web page open in any browser on the network can use up the five tries and so cancel a code that is on offer. *Fix:* accept pairing from another site only for the address named when the code was made, or only for a few minutes after a paired device allows it.

- [ ] **27. Tokens for other hubs are kept where the page's scripts can read them.** This hub's own token is a cookie that scripts cannot see. Tokens for other hubs are stored by the page (`hub:tokens`, `app.js:33`), in the clear unless protection is on, and they never expire. Anything that ever runs in the page (a sanitiser slip, or 18) could take them and use them from anywhere that hub can be reached. *Fix:* suggest "protect…" when a hub is added; let a token be limited in time.

- [ ] **28. A locked folder shows through.** The lock is the reader's, by design, and the README says so. Beyond that: the names of kept files inside a locked folder appear in "everything on this device" and in the queue list; the full document list, titles included, is cached unencrypted on the device; the server gives the files to any paired device that asks; the salted hash is in `hub.json`, which every paired device can fetch and guess against (100,000 rounds); and a lock set on one device does not close what another already has open. *Fix:* filter those two lists. Making it a real lock means enforcing it on the server, or layer 5.
*Partly done after this pass:* the two lists no longer name files in a locked folder; find returns nothing from inside one, its front page and notes included; the notes panel stays empty beside the lock screen; and a lock set or removed on another device takes effect in open pages without a reload. Still true by design: the document list is cached unencrypted on the device, the server gives the files to any paired device, and the hash can be guessed against. Locked folders in a workspace other than the open one are still named in "everything on this device".

- [x] **29. Hidden files and "ignored" files are served to anyone who asks by path. Confirmed.** The document list leaves out names starting with a dot and anything on the ignore list, but `/raw/.name` and `/api/doc?path=.name` answer (a hidden file was read through both in Node; the C++ routes skip the same check, `hub.cpp:967`, `:1169`). If the folder is a git repository, that includes `.git/`. Only paired devices can ask. *Fix:* apply the strict path check to reading too.
*Done after this pass:* the read routes refuse hidden names. Covered by the server's test. The ignore list is still only a listing filter.

- [x] **30. A pairing lasts exactly a year.** The cookie is set once with a one-year life and never renewed (`server.js:241`, `hub.cpp:621`); Chrome caps cookies at 400 days regardless. A year after pairing the device is asked for a code again, however often it was used, and its unsent changes wait until then. *Fix:* send the cookie again on the first request of each day.
*Done after this pass:* the cookie is sent again, with a fresh year, on the first request of each day.

- [ ] **31. Removing a folder is immediate and permanent.** `DELETE /api/folder` deletes the folder (`server.js:549`, `hub.cpp:1151`). The reader asks first, but there is no way back, and the notes pinned to those documents stay behind pointing at nothing. *Fix:* move the folder to a "removed" place outside the document list and empty that by hand.

### What is already sound

- Path handling: both servers reject `..` and escapes; uploads also reject hidden names.
- The exception made for other hubs gives nothing away to ordinary websites: a request from another site is served only if it carries a token itself. The cookie and "this machine" count for nothing on such a request, and the comparison test checks exactly that.
- Content from another hub never becomes a document in this hub's page: files arrive as pictures or media, pages as text shown in a frame that cannot run scripts.
- The service worker keeps the page's own files and nothing else; documents, notes and tokens never pass through it.
- The certificate authority can vouch for the hub and nothing else, and no key that could do more is stored (17).
- Tokens come from the system's random source, are compared in constant time, and only their hashes are stored. No key, certificate or token is tracked in git.
- The C++ request parser: size limits before allocation, refused chunked bodies.
- Saves on the C++ side are atomic.
- The two servers are held to one written contract by 107 comparison requests (57 at the first pass).
- Libraries: DOMPurify 3.4.16, marked 18.0.14, highlight.js 11.12.0. Not checked against published advisories in this pass.

## Efficiency, memory and storage findings

None of these is visible on a laptop with 40 documents. They are ordered by how soon they will be felt on the board or a phone.

- [x] **32. Every file change makes every open page fetch the whole document list.** `onFileChange` in `app.js` asks for the full list on each event, with no pause to collect several. Uploading a folder of 100 files therefore makes each open page, the uploading one included, ask 100 times. To answer, the server keeps the list it built last time, but still checks every file on disk for each request (`tree_stamp` in `hub.cpp`). *Fix:* wait half a second and ask once; let the list reuse the watcher's view of the folder.
*Done after this pass:* changes are collected for a moment and answered with one list request (measured: 12 files changed at once, 1 request), and the server walks the folder at most once per interval.

- [ ] **33. The page's own files are sent whole on every load.** About 380 KB (the reader 137 KB, highlight.js 129 KB, marked 47 KB, the page 40 KB, DOMPurify 29 KB), uncompressed, marked "do not store", with no way for the browser to hear "unchanged". The service worker asks for all of them on each start. Over HTTPS from the board that is seconds. *Fix:* answer "not modified" when the file has not changed; send compressed copies; let the service worker show its copy at once and refresh behind it.
*Partly done after this pass:* the page's files carry a tag, and an unchanged file is answered "not modified" with no body. Not compressed yet.

- [ ] **34. From another hub, files are fetched whole and held in memory.** A picture, a track or a video from another hub is downloaded completely before it shows, and the copy stays in memory until the page is closed (`remoteBlobs`). A long video cannot start until all of it has arrived. Each new address also costs an extra round trip first, because the browser asks permission per address, and the list and the notes are re-fetched in full every minute whether or not anything changed. *Fix:* short-lived tickets so media can be streamed by address; a small "has anything changed" answer to poll instead.

- [ ] **35. Keeping a large file costs several times its size in memory.** `keepCopy` reads the whole file into memory; with protection on it is then copied and encrypted, three or more times its size at the peak. "keep all pictures and videos" does that for every file in turn. With protection on, the list of what is kept is also rewritten and re-encrypted in full for each file added (`local.js:105`), so keeping n files does work proportional to n squared. *Fix:* store large files in pieces; keep the index as one small record per file.

- [ ] **36. The notes file must fit in memory several times over.** Each read parses the whole file and each change writes all of it. On the board, a parsed file takes roughly ten times its size, so a notes file of a few tens of kilobytes is the practical limit. *Fix:* one notes file per document (already on the list).

- [x] **37. The reader looks for an absent server every four seconds, indefinitely.** Same rate whether the page is in front or in the background, after a minute or after a week. On a phone that is a radio wake-up every four seconds for as long as the app is open. *Fix:* back off to once a minute, and look at once when the page comes to the front or the network changes.
*Done after this pass:* every 4 seconds for the first minute, then every 15, then once a minute; not at all in the background; at once when the page comes to the front.

- [x] **38. Small repeated costs in Node.** *Gone with the Node server.* The list of paired devices is read from disk on every request that carries a token (`server.js:232`); settings and the front page are read for each list or settings request; the table of pending change notices never shrinks (`server.js:296`). An interrupted upload can leave a `.tmp` file that is never removed.

- [ ] **39. Lists are rebuilt in full for small changes.** As at the first pass (below), and more so now: the file tree, the status box and the whole track list are rebuilt on every play or pause, on each file kept, and on each step of "keep all"; documents are found by searching the list from the start, inside loops.
*Partly done after this pass:* documents are looked up by path, not searched for; headings are measured once per frame; the track list is no longer rebuilt on play and pause; "keep all" redraws every fifth file. Notes, the tree and highlights are still redrawn whole.

Storage on the device, as it stands: nothing kept there expires by itself, and the reader now asks the browser not to clear it. There is still no record of how much space the copies take, no way to remove them in bulk, and copies from a hub or workspace that is no longer used stay until removed one by one.

### Work that is done too often (first pass, still true)

- Every note change rebuilds the whole notes panel, the whole file tree, and re-applies every highlight in every open document. Each highlight walks every text node of its document.
- Every scroll measures every heading's position.
- Every text-selection change rebuilds the notes panel.
- On the server, every document-list request and every watch tick `stat`s every file in the workspace.
- `notes.json` is one file rewritten in full for each change.

## Architecture findings

### The page is still one file doing most of the jobs

Styles and markup are in `index.html`; storage and encryption moved to `local.js` and `vault.js`; the service worker is `sw.js`. Everything else is `app.js`: about 2,700 lines in one scope, 700 more than at the first pass. Today's additions each reach into several others: locks touch the document list, the tree, the player and the queue; hubs touch every request, every stored key and every place a file's address is used. Two bugs of exactly that kind were found during the work (a name used twice for two icon tables; a list that locks did not know about).

*Recommendation:* unchanged. ES modules, no build step, one owner per piece of state. The seams are clearer now than they were: `net` (requests, hubs, online state), `store` (copies, outbox), `docs` (list, locks), `panes`, `render`, `notes`, `player`, `upload`, `ui`.

### One server now

At this pass every feature and every fix was written twice, in Node and in C++, and several findings differed between the two. The Node server has since been retired: `hubd` gained workspaces, was checked against Node on 123 requests (identical, apart from listing workspaces in name order), and the comparison test became a test against those recorded answers. What that leaves open is a full session in a browser against `hubd` alone; the page has been driven against it for documents, media, notes and pairing, as a second hub, but not yet as the only server since workspaces were added.

### Pages that may run their own scripts

- Finding 2 was closed by sending every file under `/raw/` with a policy that forbids scripts. There is now one exception, off unless asked for: an HTML page listed by its exact path under `"scripts"` in `hub.json` (in this workspace, `scripts/grid.html`) is sent with a policy that lets its own inline scripts run and lets it load pictures and media from the web, which that page exists to do. It is kept apart from the reader: the policy and the frame both leave out `allow-same-origin`, so the page has an origin of its own, sees no cookie and no storage of the reader's, and a request from it to this server is refused as coming from another site. The list cannot be changed through the API (`PUT /api/config` writes the title and the highlight types only); it is changed by editing `hub.json` on disk. A bare file name in the list matches nothing: only the whole path does. What it costs: such a page can contact the internet, so opening it is no longer private in the way opening a document is. Checked: the header in the contract tests. Not checked: the page itself in a browser.

### PDFs in the reader

- **What changed (4 October 2026).** PDFs are now listed, and the reader shows one in a frame with the browser's own PDF viewer. The frame has no sandbox, because a browser's PDF viewer does not start inside one; the server already sent PDFs without the sandbox policy for that reason, so what is served is unchanged. What is new is that the reader itself frames such a file. A PDF cannot run script in the reader's origin through the browser's viewer, and the frame is given this server's address only.
- **Not checked:** a phone (where the frame is expected to stay empty and "open in new tab" is the way), Firefox, Safari.

### Files of saved links

This is a deliberate exception to "opening a document never contacts the internet", and it is worth being exact about what it does and does not give up.

- **What changed.** Text and JSON files that hold web addresses, and browser bookmark exports, are now listed, and the server makes a gallery page from one (`/cards/<file>`). That page loads pictures and media from the sites named in the file.
- **What is given up.** Privacy towards those sites, for those files: each site whose picture or video is shown sees this device's address and that the file was looked at (not who you are to the hub, and no referrer is sent). A file someone else gave you could be made to list an address of their own, to learn when and from where it was opened.
- **What is not given up.** The reader's own policy is unchanged: the reader page still loads nothing from another site, and no document, note or markdown file can make it. The gallery is a different page in a frame with no share in the reader's origin (sandbox without `allow-same-origin`): it cannot read the reader's data, its cookie, or anything on the server, and a request from it to the server is refused as coming from another site. Its policy allows pictures and media over `https:` only: no connections, no frames, no forms, no styles or fonts from outside. The one script in it is written by the server and is the only one that can run (a nonce made for each answer); every address and name from the file is written out escaped, so a file cannot put markup or script into the page.
- **Asked for, not automatic.** Opening such a file shows its contents as text and loads nothing; the media is fetched only after "Show the pictures and media" is pressed, and the choice is remembered for that file on that device. On a front page the card loads nothing until it is pressed (pointing at it lists the addresses as text).
- **Not done.** No way to turn the feature off for a whole workspace. Addresses on the local network (an `https://192.168…` in a file) are not refused, so a file could make this device knock on a machine at home; the answer cannot be read by anyone, but the knock happens.
- **Checked:** the policy header, the escaping and the colour check in the contract tests; the finding of items on fifteen real files. **Not checked:** the gallery in a browser.
- **Playing in the grid (4 October 2026).** A card with a video has a play button that plays it in the card. Nothing about what may be loaded changed: the same addresses the viewer plays, the same policy, and still only on a press. Tried in headless Chrome on Windows (play, one at a time, ×, the viewer and the reel, the bar staying at the top); not tried on a phone, in Firefox or Safari, or with an item whose sound is at a separate address.
- **Filters, direct media, and `data:` pictures (4 October 2026).** A filter by the entries a JSON item has; an `.mp4` saved as a thumbnail is taken for the video itself; an address that is not a media file by its type is never drawn or played, whatever name it was saved under, and is listed as a page (so fewer addresses are fetched than before, not more). The viewer's bar now has the exact address of what it shows, and lists every address of the item under it: written by the server, escaped, inside the gallery page; nothing is passed to the reader. The gallery's policy now reads `img-src https: data:` (it was `https:`): the browser's own video player draws its buttons from `data:` pictures and each was refused with an error. A `data:` picture is fetched from nowhere, and a file cannot put one in the page (only `https://` addresses are kept), so nothing new can be loaded. **Checked:** the contract tests (the page's markup, script and policy header). **Not checked:** any of it in a browser.

- **Find in saved links, and PDF.js (5 October 2026).** `/api/search` now reads files of saved links and answers with their items' names and addresses, to a paired device only, like every other answer. `/cards/<file>` takes `?item=<n>`; the only thing it puts in the page for that is an id the server makes (`g12`, `p3`), never the request's own text. Two more page files are served, `/vendor/pdf.mjs` and `/vendor/pdf.worker.mjs` (PDF.js 4.10.38, from `node_modules`, fetched from nowhere else): the reader loads them only when it draws a PDF itself. The worker's file is sent with `default-src 'none'; script-src 'self'`; the reader's own policy is unchanged, and PDF.js is run with `isEvalSupported: false`. A PDF is then parsed by script in the reader's origin, where before the browser's viewer did it: a flaw in PDF.js would run with the reader's rights, held only by the reader's policy (no inline or foreign script, no connection but to this server). **Checked:** the contract tests (181), and in headless Chrome made to look like an iPhone, a 580-page scanned book. **Not checked:** a real phone.
- **The document engine (8 October 2026).** Seventeen more page files are served, under `/vendor/marginalia/` (the `marginalia-engine` package, from `node_modules`, fetched from nowhere else; listed in `server-cpp/API.md`), and nothing else of the package: a name not on the list is not looked for on disk. The reader's own policy is unchanged. The engine is WebAssembly in a worker of its own, and that worker's file is the one answer sent with `'wasm-unsafe-eval'`: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'`. So the worker may compile WebAssembly and fetch from this server, and nothing else; the page itself still may not. The recolouring worker gets `default-src 'none'; script-src 'self'`. A PDF or a book is then parsed by this engine in the reader's origin, as PDF.js already parses a PDF: a flaw in it would run with the worker's rights. A note may now carry `mg` (the file's SHA-256 and the engine's anchor): the anchor is kept as sent, as JSON, bounded at 64 KB, and is only ever handed back to the engine, never put into a page. The page list gives a book's title with each of its pages (`bookTitle`), shown as text. **Checked:** the contract tests (198), and in headless Chromium on a scratch copy, macOS: a PDF's words selected, highlighted and drawn again after a reload, with no policy violation; the same on a page of a book. **Not checked:** Windows and Linux builds of this change, a phone, Firefox, Safari.

### Books

- The server now opens zip files (`.epub`) and sends what is inside them. What is served is still only what is under the workspace folder: a path into a book is cleaned like any other (no `..`, no hidden names) and then looked up by exact name in the zip's own list, so a zip cannot name a file outside itself. Each entry is limited to what the device profile holds in memory (16 MB, 1 MB on the board), the limit is enforced while unpacking and not only read from the zip's header, and the result is checked against the recorded size and CRC. Pages of a book are sent with the same sandboxing content policy as any other page, so a book's scripts do not run. Not yet done: a limit on how many entries a zip may list (the directory itself is limited to 16 MB).

### Updating an uploaded folder (6 October 2026)

Four additions to what the server answers, for the reader's "update…", for splitting `app.js`, and for a look that outlasts the browser. Built and tested on Windows (MSYS2 UCRT64, `make test-own`: 191 requests); not yet built on macOS or Linux.

- `GET /api/files?path=<folder>` lists every file under a folder of the workspace with its size and date. It names files the document list leaves out (a `.txt` with no addresses in it, any type the reader does not show). Only a paired device can ask, and a paired device can already fetch any of those by `/raw/`; hidden names and `node_modules` are left out, and the page's own folder is refused.
- `POST /api/upload?...&replace=1` replaces a file that is there. Until now an upload never overwrote. A paired device could already remove a folder and upload it again, so this adds no reach, but it does make an overwrite one request, with nothing kept of what was there. The page's own folder is still refused, so `app.js` cannot be replaced this way (item 18 stands as it was).
- `PUT /api/config` takes `"look"` (the reader's theme, typeface and reading settings) and stores it in `hub.json`; `GET /api/config` gives it back. Any paired device can set it, as it can the title. What is stored is cleaned: at most 12 values, names and text of letters, digits and hyphens only, numbers, and true or false, so nothing stored there can be markup or a path. The reader uses it only where a device has no choice of its own, and checks a theme against its own list before applying it.
- `GET /js/<name>.js` serves the page's modules from `hub/js/`, by names of lowercase letters, digits and hyphens only, so nothing outside that folder can be named.

### Data model weaknesses

- A highlight is located by searching for its quoted text; if that text occurs twice, it lands on the first. **Addressed for markdown, source files and HTML pages:** a new highlight carries an anchor (its block's hash, which of the blocks with that hash, the offset in it, and the characters on either side), and is placed by that; one that cannot be placed is marked as not found. Highlights made before this have no anchor and are placed at the first occurrence under their heading. The server's side (`/api/blocks`, the anchor kept on a note) is in the contract tests; the placing in the page was tried on hand-made documents outside a browser, not yet in one. Notes at a moment in a video, on a region of a picture, and EPUB and PDF still wait.
- Notes have no version or last-modified field, so two devices editing the same note cannot be reconciled (and see 20).
- Notes stay behind when their folder is removed (31).

### Tests

The server comparison test is in the repo and is good. The page has no tests in the repo. *Recommendation:* commit a small browser suite: open, highlight, note, split, offline round-trip, lock and unlock, two hubs, and the three confirmed attacks from the first pass.

## Design, experience and flow

No changes were made for this section; these are observations and ideas. It is based on the screens rendered during today's testing, at desktop width and at phone widths of 375 and 320, and on the code.

### What works well

- The default sidebar is now just files and outline; settings are one press away.
- The reader says what state it is in: one line when something needs attention, details in settings.
- Drawers on a phone, the contents dial, and touch targets sized up at phone width.
- The player's footer stays out of the way and stays put.
- Dialogs share one style (pairing, upload, lock, remove).
- Keyboard focus is always visible, and rows and tabs work from the keyboard.

### Rough edges

Startup repair (6 October 2026): the book-scroll code declared `pushed` for both wheel distance and a touch handler in the same scope. Chromium rejected `app.js` before any of the reader could start. The touch handler now has its own name. Verified on Windows in headless Chromium against an isolated scratch workspace: desktop startup, a cached reload, and phone-sized startup, with no page errors. This does not cover a full reading session or real-phone book gestures; the startup-message suggestion below remains open.

| Where | What happens now | Idea |
|---|---|---|
| Starting up | A blank page when the script fails to load (this morning: an old server on the same port). | Put a plain sentence in the page that the script removes when it starts; make the server refuse to start if the port already answers. |
| Connecting a phone | Two terminal commands, an address typed by hand, a trust page, a pairing code. | One start option that makes the certificate itself and prints a QR code carrying address and fingerprint. |
| Note box on a phone | Return saves the note; there is no way to type a new line, and it is easy to send by accident. | On touch screens, return makes a new line and a button sends. |
| Note box | Shown under pictures, video and the player, where a note cannot be pinned to anything. On a phone it takes about a quarter of the screen. | Fold it to one line until tapped; hide it for media. |
| Contents button on a phone | Sits on top of the front page's "edit front page" button. | Move one of them. |
| Opening a track | Done after this pass: a track plays without leaving the page, and the player opens from the footer. | On a phone the footer lives in the drawer, so nothing shows what is playing once the drawer is closed: a small mark in the top bar would. |
| Phone's own back gesture | Leaves the reader. | Record each document opened in the browser's history, so back means back. |
| Reading position | Done after this pass: a document reopens where it was left. | Next: "continue reading" on the front page. |
| Finding things | Done after this pass: a find box filters the file list and searches inside documents and notes. | Next: jump between several matches in one document. |
| ○ and ● | The meaning is explained only in settings; three different marks mean "keep" (○/●, an arrow, a tick). | One mark everywhere, and a word beside it at phone width. |
| File rows | Up to four small controls on hover (+, ○, queue, "side"), one of them a word. | One "more" menu, or icons throughout. |
| Hub and workspace menus | Two unlabelled menus stacked above the files. On a phone, nothing says which hub is on screen. | One "where" menu (hub, then workspace); the hub's name in the phone's top bar. |
| "This hub" | Means the machine the reader was installed from, which on a phone is not obvious. | Show its real name. |
| Adding a hub | Three hops: type the address, visit its trust page, fetch a code from the other machine. | An "invite" made on the other hub (address, code and fingerprint in one string or QR code), pasted once. |
| Settings on a phone | Opens inside the drawer above the file list and takes most of its height. | A screen of its own. |
| Settings, "Connection" | Mixes server status, what is kept, three "keep all" links and a legend. | Two groups: "Connection" and "On this device". |
| Folder front page | Four small buttons in a row; "remove folder…" looks like the others. | A folder menu; the destructive one set apart. |
| Folders without a front page | Cannot be locked or removed from the reader. | Put the folder actions on the folder's row. |
| Lock box in the upload dialog | Ticking it disables "own workspace"; the reason is only in a tooltip, which touch screens do not show. | Say it in the dialog. |
| Dialogs | Escape does not close them; focus does not return to where it was. | Both. |
| Waiting | Nothing shows while a document, a kept file, or a file from another hub is on its way. | A quiet progress mark after a third of a second. |
| Copies | A document shown from the device looks the same as one from the server. | A small "copy from 3 Oct" tag. |
| Updates | Done after this pass: the reader says "a newer version is ready" and reloads on a press. | |
| Installing | Nothing offers it, though installing is what makes the browser keep the copies. | An "install" button where the browser allows it; a one-line hint on an iPhone. |
| Player footer | No shuffle, repeat, position bar or way to the queue. | A press on the footer opens a small panel with them. |
| Queue | Order cannot be changed; no "play next". | Drag to reorder; "play next" beside "add". |
| Tooltips | Many controls are explained only by a tooltip. | Labels at phone width; a short "what the marks mean" on the front page for a new workspace. |

### Added after this section was first written

Two changes were made on request afterwards, and neither has been seen rendered yet, so both belong on the list of things to look at:

| Where | What changed | What to look for |
|---|---|---|
| Wide tables on a phone | A table with more than three columns now shows each row as a card, one line per cell under its column name. | Tables whose first column is not a good card heading; very long tables, which become a long run of cards; whether three columns is the right cut-off. |
| Buttons and links | A dark background with light text while pressed, and with a mouse while pointed at. | Links inside running text flashing dark as the pointer crosses a paragraph, which may be too strong while reading; icon buttons, where the dark square may be larger than the icon suggests; the reversed colours on the Triple-M theme. |

And three more rough edges, from the certificate work:

| Where | What happens now | Idea |
|---|---|---|
| Network access | Whether the hub listens on the network is decided in the terminal (`HOST=0.0.0.0`). Nothing in the reader shows or changes it. | A "Network access: off / on" control in settings on the hub's own machine. |
| The authority | The reader does not say which authority this device was given, when, or how to remove it. | A line under "This device" with its name and fingerprint, and the removal steps for the device in hand. |
| The trust page | Asks for the fingerprint to be compared but not why, and gives the Windows value in a form Windows does not show. | Say what the check protects against; show the SHA-1 as well, labelled "Thumbprint". |

Also built on request since: a switch in settings that narrows every list to what is kept on the device; playlists that give the file's name the room it needs and shorten the folder to its last two parts; and a hub menu re-tested with the C++ server on both ends.

### Consistency

- **Buttons.** Four looks are in use without a rule (filled, boxed, link-like, icon). Decide what each is for: filled for the one main action, boxed for others, link-like for quiet ones, icons where space is tight.
- **Icons.** Drawn in three places with three line weights (1.6, 2 and 2.2), some filled and some outlined. One table, one weight.
- **Type sizes.** Fourteen sizes between 10.5 and 22 pixels, nine uses of 11. A scale of five or six, with nothing under 12 on a phone.
- **Status colours.** Green, red and amber are written as fixed values in eleven places, so they do not follow the theme. On the two dark themes the red works out at about 2.6 and 3.1 to 1 against the background, under the 4.5 to 1 usually asked of text (calculated, not judged by eye). Make them theme tokens.

### Bigger ideas, in the order I would try them

1. **Instant start.** *Done.* The kept page is shown at once and checked against the server behind it; a changed page is fetched for next time and the reader offers "a newer version is ready". Measured: 0.08 s with the server up, 0.02 s for the page itself with the server not answering (the document then waits about 3 s for the reader to give up on the server).
2. **Music beside reading.** *Done.* Pressing a track in the file list or a front-page list plays it where you are; the playing track is marked in the list; the name in the sidebar's footer opens the player. Opening the player page no longer starts or changes what is playing.
3. **Find.** *Done* (file names, text in documents, notes).
4. **Continue reading.** Positions are remembered (*done*); the "recent" list on the front page is not built.
5. **One "everything is saved" line.** Saved, waiting, or not reachable since when; in one place, always in the same words.
6. **Quick open.** One key for a box that jumps to a document, a heading or an action. Most useful when the sidebar is tucked away.
7. **Answered notes.** A mark for replies not yet read, and "next unanswered".

## Target design for "private everywhere"

Five layers, each closing one way in.

1. **Content cannot act.** Done.
2. **The server knows who is asking.** Done. Open edges: 18, 26, 30.
3. **The connection is encrypted.** Done. The authority can now vouch for the hub only (17); how it first reaches a device is still 23.
4. **The device copy is encrypted.** Built; off by default (7).
5. **The board never holds readable data.** Still a decision. Its costs are unchanged: the board can no longer read titles or build the list, files must go in through a paired device, a lost passphrase loses the data, and the "assess my notes" workflow needs the key. The alternative remains encrypting on the board with a key in the chip's protected storage, which needs the same flash encryption that 17 asks for.

## Recommended order of work

1. **What is left of the authority (17, 23).** Remove the old one from every device; flash encryption on the board; have the trust page say what the fingerprint check is for.
2. **Quiet data loss (19, 20, 21).** Small, contained changes; each gets a regression in the comparison test or the browser suite.
3. **Today's loose ends (25, 28, 29, 30).** An hour each.
4. **The page's folder (18).**
5. **A browser test suite in the repo**, starting with the checks from this pass.
6. **Efficiency for the board (32, 33, 24, 36), in that order.** 32 and 33 are also what make a phone feel quick.
7. **Design: the rough-edges table**, starting with the note box on a phone, the contents button overlap, and "play without leaving the page".
8. Then the standing items: split the page into modules, decide on layer 5.

Steps 1 to 6 need no new decisions. Layer 5 does.
