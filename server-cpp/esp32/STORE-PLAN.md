# The board as a store: plan (branch `claude/esp32-store-tier`)

Two tiers, one client. On a computer or a Raspberry Pi, `hubd` stays as it is (the full server). On the ESP32 boards a small **store** server takes its place: it keeps files and says when they change, and the reader in the browser does the rest. The page learns which it is talking to from `GET /api/device` (`"store": true`) and works either way.

Nothing here is built yet. Cross out or change anything before it is.

## Why

The board is the **LilyGO T3-S3 V1.3 only** (ESP32-S3, 4 MB flash, 2 MB PSRAM); the T3 V1.6.1 is dropped. It has a few hundred KB of internal RAM, 2 MB of PSRAM, and two 240 MHz cores doing TLS. The full server makes it build the document list (reading every file's title, unpacking books), search, merge notes, unpack books' pages, hash files, keep a trash, hold a connection open per page, and pair devices: about 3,300 lines, each part competing with TLS for memory. A browser has gigabytes. So the board serves and stores; the browser thinks.

## The store's API (the whole of it)

All over HTTPS, all but the first needing the access password.

| Request | Answer |
|---|---|
| `GET /` and the page's own files | the reader, from `hub/www` on the card (as now: served in pieces, with an ETag; nothing kept in memory) |
| `GET /api/device` | `{ "store": true, "profile", "maxUpload", "free", "total", "changes", "heapFree", … }`: what it is, its space, and the change counter |
| `GET /api/list?path=<folder>` | that folder's entries, `[{ "name", "dir", "size", "mtime" }]`, streamed, in the card's order; nothing read from inside the files |
| `GET /raw/<path>` | a file, with `Range` (a PDF, a book, a video read in pieces), an ETag (size and time) |
| `PUT /raw/<path>` | write a file from the body, in pieces, to a temporary name, renamed when complete. With `If-Match: <etag>`: refused (412) if the file changed since it was read; `If-None-Match: *`: only if it is not there. Folders made as needed |
| `DELETE /raw/<path>` | a file, or an empty folder |
| `POST /api/move` `{ from, to }` | rename a file or folder (removing a folder becomes "move to `.removed/`", done by the page) |
| `GET /api/changes?since=<n>` | the change counter now, and the paths written since `n` if it still remembers them (the last 64), else "everything may have changed" |

Every write the store makes moves the change counter on. Nothing else writes to the card, so that is exact.

**Access:** one password, chosen in the page on the first visit: a board with none shows a six-digit setup code on its screen, which the page asks for with the new password, so no one else on the Wi-Fi can claim it first. Holding BOOT for five seconds while the board runs clears it. The page keeps it; each request carries it (`Authorization: Bearer`). Requests from other sites are refused as now (Origin check). No pairing codes, no per-device tokens, no device list.

**TLS:** kept (phones need it for offline copies and the page's encryption), one certificate made on the board at first start, its fingerprint on the screen. At most 4 connections, session reuse on, TLS buffers in PSRAM. No connection held open between requests.

## What the page does in store mode

| Now asked of the server | In store mode |
|---|---|
| `/api/docs` (the document list, titles) | built from `/api/list`, folder by folder; titles read once from each file's start (a ranged `/raw/` of 4 KB) and kept in IndexedDB by path, size and time, so only new or changed files are read again. Books: listed from the engine, which reads them by range already |
| `/api/doc`, book pages, `/api/blocks`, `/api/sha256` | `/raw/` by range; unpacking, block maps and hashes done in the page (the engine does books; SHA-256 by `crypto.subtle` over the copy kept) |
| `/api/search` | over the copies kept on the device (the page keeps them already); documents not yet kept are fetched first, a few at a time |
| `/api/notes` and its edits | `notes/notes.json` read with `/raw/`, changed in the page (the same stamps per part as now), written back with `If-Match`; on 412, read again, merge, write again |
| `/api/config`, `/api/front` | `hub.json` and the front pages, the same way |
| `/api/upload` | `PUT /raw/` with `If-None-Match: *` (or `If-Match` for "replace") |
| `/api/folder` (remove), `/api/removed`, restore | `POST /api/move` into and out of `.removed/`; the list of removed folders from `/api/list` of `.removed/` |
| `/api/files` (update a folder) | `/api/list`, walked by the page |
| `/api/links`, `/cards/` | built in the page from the file (`/raw/`) |
| `/api/events` (live reload) | `/api/changes` every 15 s while the page is visible; at once when it comes back into view |
| `/api/workspaces` | not on the board: one folder. (A second one can be a top folder on the card) |
| `/api/session`, `/api/pair*`, `/api/devices` | the password, asked once |
| `/api/storage` | from `/api/device` |
| `/api/hubs` (other hubs) | unchanged in the page; not the board's business |

The page's code for this goes in modules of its own (`hub/js/store.js`: the list, notes, search over copies), used only when `/api/device` says `store`, so the full server's path is untouched.

## What leaves the firmware

- The full server (`src/hub.cpp`) is not built for the board; the store is a file of its own (`esp32/main/store.cpp`, about 600 lines), using `fs.hpp` and `http.hpp` as they are.
- Signed updates from GitHub (`update.cpp`, the HTTPS client, the signature check): replaced by "put `firmware.bin` on the card and restart" (the board checks it, writes it, deletes it). The partition table keeps its two slots: the card's `firmware.bin` is written into the other one, so a bad update still rolls back.
- Pairing, the certificate authority with its own root (one self-signed certificate instead; the trust page shows its fingerprint), devices, sessions.
- The screen keeps: the title, the star, the address, the free space, the number of devices seen lately, and messages. Not the pairing code (there is none).
- Kept: Wi-Fi from `wifi.txt`, mDNS (`hub.local`), the card checks, power-cut recovery of `.tmp` files, the stall timeouts, the memory guard on new connections.

## The computer and the Pi

Unchanged: the full server, all its features, `make test`, `make memory`. The contract test stays the full server's; the store gets a test of its own (`test/store.sh`: the table above, run against the store built for a computer), and the browser suite runs once against each.

## Steps, each tested before the next

1. The store server, built for a computer too (`make store`), with `test/store.sh`.
2. The page in store mode: the list, opening documents, notes, uploads; the browser suite against the store.
3. Search, removed folders, links and cards, folder updates in store mode.
4. The firmware: the store in place of the full server, card updates in place of GitHub ones, the screen trimmed, one program slot.
5. On the T3-S3: flash, `make card`, and the checks in TODO.md.

## Decided (11 October 2026)

- The password is chosen in the page, with the board's setup code.
- Firmware updates come from the card.
- The T3-S3 only; the T3 V1.6.1 is dropped.
