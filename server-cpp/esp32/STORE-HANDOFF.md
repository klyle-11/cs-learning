# The board as a store: work plan for several agents

For LLM agents (or people) picking up the ESP32 store work, in parallel or one after another. It says what is decided, what the shared contract is, how the work is split so that agents do not edit the same files, how each part is checked, and where to record progress. The reasoning behind it is in [STORE-PLAN.md](STORE-PLAN.md); the conversation that led here is in [CONVERSATION.md](CONVERSATION.md).

Branch: `claude/esp32-store-tier` (from `claude/esp32-32gb-memory-efficiency-n3dz1c` at `4f7c181`, which is open as PR #1 into `marginalia-engine`). Do not push to PR #1's branch or to `marginalia-engine` from this work.

## Read first, in this order

1. `../../CLAUDE.md`: the repository's rules. Above all "Building the hub": memory efficiency and safety on every platform; `make memory` and the boards' profiles checked on every change; never commit `data/`.
2. [STORE-PLAN.md](STORE-PLAN.md): what the store is and why.
3. This file: the contract and your work package.
4. [CONVERSATION.md](CONVERSATION.md): only if you need the history of a decision.
5. For the code you will touch: `../src/http.hpp` (HTTP and TLS, reused by the store), `../src/fs.hpp` (files and FatFS), `../src/platform.hpp`, `main/board.cpp`, `../../hub/app.js` (7,100 lines: find your way by searching, do not read it whole).

## What is decided

- **Two tiers, one client.** The full server (`server-cpp/src/hub.cpp`) stays exactly as it is, for computers and the Raspberry Pi. The board runs a small **store** server instead. The page asks `GET /api/device`; `"store": true` puts it in store mode.
- **The board is the LilyGO T3-S3 V1.3 only** (ESP32-S3, 4 MB flash, 2 MB PSRAM, SX1262, BOOT button). The T3 V1.6.1 is dropped: its pins, profile (`esp32`), PlatformIO environment (`t3`) and notes go. The `esp32-psram` profile of the full server stays (it is also what a computer uses to try the board's limits).
- **HTTPS stays** (phones need it for the service worker and `crypto.subtle`), with one self-signed certificate made on the board; no certificate authority of its own, no pairing.
- **Access is one password**, chosen in the page on the first visit (with the board's setup code), sent as `Authorization: Bearer <password>` on every request but the page's own files.
- **No connection is held open between requests** on the board: live reload is polling (`/api/changes`).
- **Memory:** the store holds nothing that grows with the number of files. Folder listings and files are streamed; at most 4 connections; TLS buffers in PSRAM.

## Decided on 11 October 2026

| Question | Decision |
|---|---|
| Where the password is set | **In the page**, on the first visit. A board with no password shows a six-digit **setup code** on its screen and serial console; the page asks for that code with the new password, so nobody else on the Wi-Fi can claim the board first. Holding **BOOT** while the board starts clears the password (and the board shows a new setup code). Kept in the board's flash (NVS), as a salted hash |
| Firmware updates | **From the card**: `firmware.bin` at the top of the card, checked (ESP-IDF image header and its SHA-256) and written into the other program slot at start-up, then deleted; the board restarts into it and rolls back if it fails. GitHub updates removed |
| Partition table | kept as now: two program slots of 1.75 MB (a running program cannot overwrite itself, so a card update goes into the other slot, and rollback stays) and the `state` partition for the certificate and the password hash |
| Boards | **T3-S3 only.** The T3 V1.6.1 is dropped from the firmware (done on 11 October, see the status table): pins, PlatformIO environment, build settings |

## The contract: the store's API

This is the boundary between the work packages. Change it only by editing this section in the same commit, and say so in the status table below.

All requests over HTTPS. `401 {"error":"password required"}` without the right `Authorization` (except: `/`, the page's files under `/` that the full server also serves without a session, `/trust`, `/api/device`, and `POST /api/password` while no password is set). `403` for a request whose `Origin` is another site (same rule as the full server's `cross_site`). Errors are `{"error": "…"}` with the status. Paths are relative to the folder served, `/`-separated, no `..`, no empty parts, no part starting with `.` except `.removed` and `.hub-cache` where stated; otherwise 400.

| Request | Answer |
|---|---|
| `GET /api/device` | `{"store": true, "profile": "store-t3s3", "version": <firmware>, "passwordSet": true|false, "maxUpload": 4294967295, "free": <bytes>, "total": <bytes>, "changes": <counter>, "heapFree", "psramFree", "wifiRssi"}` (`wifiRssi`: the Wi-Fi signal in dBm, above -60 good, below -75 poor; absent when not joined). No password needed |
| `POST /api/password` `{"code", "password"}` | while no password is set: sets it if `code` is the setup code on the board's screen (`403` otherwise; five wrong codes and a new one is shown). `{"old", "password"}` with the current password: changes it. Passwords of 8 to 128 characters; stored as a salted SHA-256 (PBKDF2, 10,000 rounds) in NVS. `204` |
| `GET /api/list?path=<folder>` | `200`, a JSON array streamed: `[{"name","dir":true|false,"size","mtime"}…]`, in the card's order, hidden names left out unless `hidden=1`. `404` if not a folder. Nothing is read from inside files |
| `GET /raw/<path>` | the file; `Range: bytes=a-b` gives `206` with `Content-Range`; `ETag: "<size>-<mtime>"`; `If-None-Match` matching gives `304`. `Content-Type` from the extension as the full server's `mime_of`; HTML sent with the full server's sandboxed policy (`CSP_RAW`) |
| `PUT /raw/<path>` | body written in pieces to a temporary file in `.hub-cache/`, renamed into place when complete; folders made as needed after the body has arrived. `If-Match: <etag>`: `412` if the file's ETag differs; `If-None-Match: *`: `412` if it exists. `201` new, `200` replaced: `{"etag": "…", "size"}`. `413` past `maxUpload`; `507` if the card would keep under 16 MB free; `408` if 30 s pass without data |
| `DELETE /raw/<path>` | a file, or an empty folder: `200 {"ok":true}`; `404`; `409` for a folder that is not empty |
| `POST /api/move` `{"from","to"}` | rename a file or folder; `409` if `to` exists; `404` if `from` does not. Folders for `to` made as needed |
| `GET /api/changes?since=<n>` | `{"changes": <now>, "paths": [...]}` with the paths written, deleted or moved since `n` if the store still has them (it keeps the last 64), else `{"changes": <now>, "all": true}` |

The counter moves on every write, delete and move the store makes (nothing else writes to the card). It starts at a random value at each start, so a page cannot mistake a restarted board's counter for an old one.

## Work packages

Each package has its own files. If you need to change a file that another package owns, say so in the status table and keep the change minimal; never reformat or reorder someone else's file.

### WP1. The store server (C++)

- **Owns:** `server-cpp/src/store.cpp` (new), `server-cpp/test/store.sh` (new), the `store` target in `server-cpp/Makefile`.
- **Builds on, without changing:** `http.hpp`, `fs.hpp`, `platform.hpp`, `secure.hpp` (if one of them must change, note it in the status table; WP3 and the full server use them too).
- **Does:** the contract above, built for a computer too (`make store` → `server-cpp/store`), so the page and tests can run against it without a board. Password from `--password` or `HUB_PASSWORD` on a computer; on the board from NVS (WP3 passes it in). Startup: recover `.tmp` files from a power cut (as `hub.cpp`'s `recover`), empty `.hub-cache/`.
- **Done when:** `test/store.sh` checks every row of the contract (status codes, headers, ranges, 412s, the change counter and its 64-path memory, path refusals, the password, `Origin`), passes on Linux and under ASan/UBSan, and compiles for Windows (MinGW) without warnings. Memory: a `make memory`-style check of the store on 20,000 files (`test/memory.sh` may gain a store section, coordinated with WP4) shows nothing growing with the number of files.

### WP2. The page in store mode

- **Owns:** `hub/js/store.js` (new): everything store-specific in the page. In `hub/app.js`, only a small, marked adapter: detect store mode from `/api/device`, and route the calls listed in STORE-PLAN.md ("What the page does in store mode") through `store.js` when in store mode. Keep the full server's path byte-for-byte as it is.
- **Does:** the document list from `/api/list` with titles cached in IndexedDB (by path, size, mtime; a ranged read of the first 4 KB per new or changed file); opening documents and media via `/raw/`; notes and `hub.json` read and written with `If-Match`, merging on `412` with the stamps already used (`stamps` per part); uploads by `PUT` with `If-None-Match: *` or `If-Match`; front pages; the password prompt in place of pairing (stored with the page's other per-hub settings); polling `/api/changes` every 15 s while visible. Then (second milestone) search over kept copies, removed folders via `/api/move` into `.removed/`, link files and cards built in the page, "update…" of an uploaded folder.
- **Done when:** the browser suite (`hub/test/browser.mjs`) passes against the full server unchanged, and a store-mode run of it (WP4 adds the switch) passes against `make store`'s server for the checks that apply; no page errors in either.

### WP3. The firmware (T3-S3)

- **Owns:** `server-cpp/esp32/` except the docs WP4 owns: `main/board.cpp`, `main/CMakeLists.txt`, `main/Kconfig.projbuild`, `main/board_pins.h`, `main/screen*.{cpp,h,hpp}`, `partitions.csv`, `sdkconfig.defaults*`, `platformio.ini`; removes `main/update.{cpp,h}`, `main/update_key.h`, `tools/release.sh` (or keeps them on a note, if the card update reuses parts).
- **Does:** builds the store (WP1's `store.cpp`) in place of `hub.cpp` for the board; the password from `wifi.txt` into NVS; firmware updates from the card (see Open decisions); the partition table for one large slot; the screen keeps title, star, address, free space, devices seen lately (from the store's own log of recent clients), messages; no pairing code. Drops the T3 V1.6.1: `board_pins.h` keeps the T3-S3 only, PlatformIO keeps `t3s3` only, `sdkconfig.defaults` folds in the S3 file. Keeps Wi-Fi from the card, mDNS, card checks and restart on removal, the memory guard on new connections, the serial reports of failed TLS handshakes and waiting connections.
- **Done when:** `idf.py set-target esp32s3 && idf.py build` succeeds with and without mDNS, the size is reported in the status table, and (on the owner's board) the checks in "To try on the board" pass.

### WP4. Tests, memory and documents

- **Owns:** `hub/test/browser.mjs` (the store-mode switch only), `server-cpp/test/memory.sh` (a store section), `server-cpp/API.md` (a new "The store" section copying the contract above once it is stable), `server-cpp/esp32/README.md`, `TODO.md`, `REVIEW.md`, `ARCHITECTURE.md`, `../../CLAUDE.md` (only to say the board runs the store).
- **Does:** keeps the documents true to the code as the other packages land; removes T3 V1.6.1 material from the board's documents; writes the memory ledger (`server-cpp/MEMORY.md`, promised in CLAUDE.md: every memory measure from the history, where it lives now, what checks it; gather from `git log`, the branches' REVIEW/TODO files and CONVERSATION.md).
- **Done when:** a reader of `server-cpp/esp32/README.md` can set up a T3-S3 from nothing (card, password, flashing, first visit) and nothing in the documents describes what is gone.

### Order and dependencies

```
WP1 (contract first) ──> WP2 (against `make store`) ──┐
   └──────────────────> WP3 (links store.cpp) ─────────┼──> on the board
WP4 throughout: tests as each lands, documents last ───┘
```

WP2 can start before WP1 is finished: the contract is fixed above, and a throwaway mock is fine for early work (do not commit it). WP3 can start on the parts that do not need `store.cpp` (dropping the T3 V1.6.1, the card update, the partition table, the screen).

## Rules for every agent

- Work on a branch of your own off `claude/esp32-store-tier` (`store/wp1-server`, `store/wp2-page`, …) and merge back into it with a pull request; or, working alone in sequence, commit to `claude/esp32-store-tier` directly. Never force-push a shared branch.
- Before every push: the full server's checks still pass (`cd server-cpp && make && make test && make memory`, and `HUBD_ARGS="--profile esp32-psram" ./test/contract.sh`), plus your package's own. A failing check is fixed, not skipped.
- Memory: nothing grows with the number of files without a budget; nothing held twice when it can be shared; files in pieces. Measure, and put the numbers in your commit message.
- The full server's behaviour does not change on this branch. If you think it should, write it in the status table as a proposal.
- Keep the repository's style: comments say why, in plain sentences, at the density of the code around them.
- Commit messages end with the attribution lines the session gives you; no model names in commits or files.
- Never commit anything from `data/`; test on scratch copies (`data-test/`, `server-cpp/build/`).

## Status

Update your row when you start, when you push, and when you finish; add notes for anything another package needs to know (a changed contract, a file you had to touch).

| Package | Owner | State | Last commit | Notes |
|---|---|---|---|---|
| WP1 store server | | not started | | |
| WP2 page in store mode | | not started | | |
| WP3 firmware (T3-S3) | | started: the T3 V1.6.1 dropped (pins, PlatformIO, build settings; plain `idf.py build` targets the S3, 1.40 MB, 24% of the slot spare) | (this commit) | the card update, the password and setup code, the store in place of `hub.cpp`, the screen still to do |
| WP4 tests, memory, documents | | not started | | the memory ledger was started on 10 October and stopped by a usage limit; nothing of it was kept |

## Where things stand (11 October 2026)

- PR #1 (`claude/esp32-32gb-memory-efficiency-n3dz1c` → `marginalia-engine`) holds the merged full app with the board as a full server. The owner will run the full app on a Raspberry Pi; PR #1 stays the base for that.
- On a T3-S3 the full server showed its pairing code but browsers only showed spinners. Fixes were pushed (`4f7c181`: the board lets go of pages that went, the page waits longer and no longer floods the board, TLS failures and waits are printed on the serial console) but not tried on the board; this store plan is the longer answer.
- Not run on Windows since the merge (compiled only). Not run on any board.
