# Architecture and security review

Reviewed 3 October 2026, branch `c-server`: `hub/index.html` (2,118 lines), `hub/server.js` (335), `server-cpp/src/hub.cpp` (762), `server-cpp/src/http.hpp` (218). Findings marked **confirmed** were reproduced against a scratch copy of the workspace; the rest come from reading the code.

## Verdict

It works, and the two servers agree with each other, but it is **not private today**. Anyone on the same network can read and change everything, the traffic is unencrypted, the copies on the phone and on the card are unencrypted, and a single hostile document can take over the reader. None of that is surprising for something that grew feature by feature, and none of it needs a rewrite. It needs three things added in a fixed order (isolation of content, then identity and encryption in transit, then encryption at rest) and the page split up so those can be done cleanly.

"Completely secure" is not a state software reaches. What can be built is: **nobody without one of your paired devices can read or change anything, on the network, on the card, or on a lost phone, and no document or website can make the reader leak.** The design at the end of this document is aimed at that sentence.

## Checklist

Each finding below carries a box. Ticked means fixed in both servers and the page, and covered by a test.

| | Finding | State |
|---|---|---|
| Critical | 1 markdown runs code, 2 uploaded HTML/SVG runs code, 3 no login, 4 unencrypted | all four done |
| High | 5 foreign host name, 6 reading contacts the internet, 7 copies on the phone in the clear | done |
| High | 8 the card in the clear | **open: needs the decision under "Target design", layer 5** |
| Medium | 9 to 13 | done |
| Low | 14 symbolic links, 15 titles in browser history, 16 old commits on GitHub | open |

Also open, from the sections further down:

- [ ] Retire the Node server (workspaces in C++ first)
- [ ] Split `app.js` into modules (so far only moved out of `index.html`, with storage and encryption in `local.js` and `vault.js`)
- [ ] A browser test suite in the repo (the checks run so far live in a scratch folder)
- [ ] Work done too often (whole-panel redraws, per-scroll measuring, `stat` of every file, one notes file)
- [ ] Data model: highlight position as well as quote; note versions; clean-up of device copies
- [ ] Service worker, so the reader opens with the server off
- [ ] Flash and try the ESP32 project (`server-cpp/esp32/`: builds with PlatformIO, never run on a board)

What changed on the way: a page's own scripts can no longer be switched on (finding 2 offered a separate origin or dropping them; they were dropped), and reading from another website is refused as well as writing. `server-cpp/API.md`, "Security", describes what was built.

## Security findings

Ordered by how much damage each allows.

### Critical

- [x] **1. A markdown document can run code inside the reader. Confirmed.**
Markdown is turned into HTML by `marked` and inserted with `innerHTML` (`index.html:1245`; note replies at `:2000`). `marked` passes raw HTML through. A file containing `<img src=x onerror="…">` ran its code on open, read the reader's stored data, and planted a note through the API. Any document from anywhere, once opened, can read every document and note, change them, and send them elsewhere.
*Fix:* sanitise the HTML before inserting it (DOMPurify, or `marked` configured to escape raw HTML), and add a Content-Security-Policy that forbids inline handlers so a sanitiser slip is not fatal.

- [x] **2. Uploaded HTML and SVG files run with the reader's full rights when opened directly. Confirmed.**
The "scripts: off" switch only applies inside the reader's frame. The same file at its own address (`/raw/…/page.html`) is served from the reader's origin with no restrictions: it read all notes. An SVG did the same. "Open in new tab" and any link to `/raw/…` lead there.
*Fix:* serve everything under `/raw/` with `Content-Security-Policy: sandbox` (and `X-Content-Type-Options: nosniff`), so user content never has the reader's origin, however it is opened. "Scripts on" then needs a separate origin for content, or should be dropped.

- [x] **3. No login. Anyone who can reach the port can read and write everything. Confirmed.**
There is no authentication on any route. The Node server listens on every network interface by default; it answered on the LAN address. (The C++ server defaults to this machine only.)
*Fix:* device pairing: each device holds a secret token, the server keeps only a hash, every request must carry it. Until that exists, bind to `127.0.0.1` by default in Node as well.

- [x] **4. Everything travels unencrypted.**
Plain HTTP. On shared or hostile Wi-Fi, documents, notes and (later) tokens are readable and changeable in transit. This also blocks the browser features needed for the rest: service workers and the browser's own cryptography only exist on HTTPS.
*Fix:* TLS on the server with a certificate the devices trust once (already step 3 of the plan). A WireGuard tunnel is a good extra layer but does not satisfy the browser.

### High

- [x] **5. A foreign host name is accepted, which defeats the cross-site check. Confirmed.**
The check added earlier compares `Origin` with `Host`. In a DNS-rebinding attack a website points its own name at the board's address; then both headers carry the attacker's name and match. A request with `Host: evil.example` and a matching `Origin` was accepted and wrote a note. Such a site could also read everything.
*Fix:* accept only known host names (the board's address, its local name, `localhost`); refuse the rest. Authentication (3) closes this fully.

- [x] **6. Reading a document can contact the internet. Confirmed.**
A markdown image with a remote address was fetched on open. Saved HTML pages do the same for their images, styles and fonts. Each such request tells a third party your address, the time, and often which page you are reading. This is the direct opposite of "private even on cellular".
*Fix:* a Content-Security-Policy on the reader and on `/raw/` content that allows loading only from the server itself. The reader's own code already loads nothing external.

- [x] **7. Copies on the phone are stored in the clear.**
Kept documents and music (IndexedDB), notes, the outbox and settings (`localStorage`) are unencrypted in the browser profile. A phone's own storage encryption protects them while it is locked; nothing protects them from someone using the unlocked phone, from another script in the same origin (see 1 and 2), or from a backup.
*Fix:* encrypt what is stored, with a key that exists only while the reader is unlocked. Needs HTTPS first.

- [ ] **8. The card is stored in the clear.**
Whoever takes the SD card has every document and note. The ESP32's built-in flash encryption does not cover an SD card.
*Fix:* see "Target design": have the devices encrypt before upload, so the board only ever holds ciphertext.

### Medium

- [x] **9. The Node server accepts request bodies of any size.** `readBody` (`server.js:110`) buffers without limit; a 30 MB JSON body was read in full before failing. The C++ server caps at 1 MB. *Fix:* same cap in Node.

- [x] **10. One bad request can stop the C++ server.** Each connection runs on a detached thread with no catch-all; an exception that escapes (for example running out of memory) ends the whole process. Threads are also unlimited, and a client that sends one byte every 14 seconds holds a thread forever. *Fix:* a `try`/`catch` around each connection, a cap on simultaneous connections, a total time limit per request.

- [x] **11. The C++ server reads whole files into memory.** Up to the 200 MB upload limit per request on the desktop profile; several at once exhausts memory. Already on the to-do list as "send files in pieces"; it is a security item as well as a performance one.

- [x] **12. No limit on total storage.** Uploads are capped per file but not in total; anyone who can write can fill the card.

- [x] **13. Changes can be lost silently.** The outbox treats any answer as final (`index.html:845`). If the server answers "error" or "forbidden", the change is discarded and nothing tells you. Folder upload has the same pattern. *Fix:* drop only on success or a definite "this can never work"; keep and show the rest.

### Low

- [ ] **14.** A symbolic link inside the workspace that points outside it would be followed. Uploads cannot create one, so this needs someone with file access already.
- [ ] **15.** Document titles and paths appear in the page title and address bar, so they land in browser history.
- [ ] **16.** `git` no longer tracks your uploads, and GitHub `main` now matches the rewritten history. Old commits can stay retrievable on GitHub by their id for a while, and the backup bundle beside the repo still contains them.

### What is already sound

- Path handling: both servers reject `..`, hidden parts and escapes; encoded forms were tested.
- The C++ request parser: size limits before allocation, refused chunked bodies, and a memory-checked build that came back clean on the comparison test and on malformed input.
- Saves on the C++ side are atomic (write, then rename).
- Links inside framed pages cannot navigate the reader; external links carry no referrer.
- The reader's own code loads nothing from the internet.
- The two servers are held to one written contract by 57 comparison requests.

## Architecture findings

### The page is one file doing fifteen jobs

`index.html` holds styles, markup and about 2,000 lines of script: 76 top-level functions and 51 top-level variables sharing one scope. Layout, document rendering, highlights, notes, the outbox, the device store, media, the music player, uploads, themes and reading aids all reach into each other's state. Symptoms seen during development: a property name reused for two meanings (`root`) broke pane focus; a highlight fix for code blocks made single-run highlights spill to the end of the document. Both were caught by tests that only exist in my scratch folder.

*Recommendation:* split into ES modules, no build step: `state`, `panes`, `render` (markdown/HTML/media), `highlights`, `notes`, `offline` (store + outbox), `player`, `upload`, `ui`. One module owns each piece of state; the others call it. This is also what makes the security work tractable: sanitising, the storage encryption and the request signing each belong in exactly one place.

### Work that is done too often

- Every note change rebuilds the whole notes panel, the whole file tree, and re-applies every highlight in every open document. Each highlight walks every text node of its document.
- Every scroll measures every heading's position.
- Every text-selection change rebuilds the notes panel.
- On the server, every document-list request and every watch tick `stat`s every file in the workspace; on an SD card that is the slowest thing it could do. The list should be an index file updated on write.
- `notes.json` is one file rewritten in full for each change. One file per document keeps writes small.

None of this is visible with 40 documents on a laptop. It will be on the board, and on a phone with a long document and many highlights.

### Two servers

Node and C++ implement the same contract, and they have already drifted (workspaces are Node-only; limits differ, see 9). Every security fix above has to be made twice until the Node server is retired. *Recommendation:* make the C++ server the only one before starting the security work, not after.

### Data model weaknesses

- A highlight is located by searching for its quoted text; if that text occurs twice, it lands on the first. It needs a position as well as a quote.
- Notes have no version or last-modified field, so two devices editing the same note cannot be reconciled; the later sender wins.
- Device copies are never refreshed or cleaned up, and there is no record of how much space they take.

### Tests

The server contract test is in the repo and is good. The page has no tests in the repo at all: every browser check I ran was a throwaway script. *Recommendation:* commit a small browser suite (open, highlight, note, split, offline round-trip, the three confirmed attacks above as regression tests).

## Target design for "private everywhere"

Five layers, each closing one way in. Order matters: each depends on the one before.

1. **Content cannot act.** Sanitised markdown; a strict Content-Security-Policy on the reader (own scripts only, no inline handlers, connect and load only from the server); user files served sandboxed and never in the reader's origin. Closes findings 1, 2, 6. No dependencies; can be done now.
2. **The server knows who is asking.** Known host names only; device pairing with per-device tokens; bind to local addresses by default. Closes 3, 5, 12 (with a quota per workspace).
3. **The connection is encrypted.** TLS with a certificate each device trusts once, presented in the interface as a clear step. Optional WireGuard on top. Closes 4, and unlocks service workers and browser cryptography.
4. **The device copy is encrypted.** Documents, notes and the outbox are stored encrypted in the browser; the key is derived from a passphrase (or the device's biometric unlock) and held only in memory while the reader is unlocked. Closes 7.
5. **The board never holds readable data.** Devices encrypt documents and notes before sending; the board stores and serves ciphertext and an encrypted index. Whoever takes the card, or breaks into the board, gets nothing readable. Closes 8, and reduces what a compromised server can do to "delete or withhold".

Layer 5 has real costs, which is why it is a decision and not a default:

- The board can no longer read titles, build the document list, or serve a file to a plain browser. All of that moves to the devices.
- Dropping files onto the card from a computer stops working; files must go in through a paired device (or a small command-line tool that encrypts).
- Losing every paired device and the passphrase loses the data. There must be a recovery key, written down.
- The "assess my notes" workflow needs the key on the computer where it runs.

If that is too much, the alternative for the card is encrypting it on the board with a key kept in the chip's protected storage. That is weaker (the board holds the key) but keeps today's workflow.

## Recommended order of work

1. Retire the Node server (finish workspaces and streamed files in C++), so every later fix is made once.
2. Split the page into modules; commit a browser test suite.
3. Layer 1: sanitiser, Content-Security-Policy, sandboxed `/raw/`. Regression tests for the three confirmed attacks.
4. Layer 2: host allow-list, pairing and tokens, storage quota. Server hardening (findings 9 to 13).
5. Layer 3: TLS and the trust step in the interface; then the service worker.
6. Layer 4: encrypted device storage.
7. Decide on layer 5, then build it or the on-board alternative.
8. Performance pass for the board: index file, per-document notes, incremental rendering.

Steps 1 to 3 need no new decisions. Step 7 does.
