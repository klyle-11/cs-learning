# Is this the right shape for an ESP32?

An evaluation asked for on this branch: would the hub be better built a different way for the board, or can the way it is built work? Short answer: **it can work, and it is the right shape to keep**, with three changes ahead, in this order: stop writing every feature twice (retire the Node server), split `hub.cpp` into parts, and, only if measurements on the T3 V1.6.1 call for it, an event loop instead of a thread per connection. The T3-S3 does not need the last one.

## The shape today

```
browser   hub/index.html + app.js (2,800 lines): renders markdown, code, pictures; notes and
          highlights; copies kept on the device; works offline and catches up
   |  HTTPS, JSON and files (server-cpp/API.md is the contract)
server    src/hub.cpp (2,100 lines): routes, pairing and devices, notes and settings, the
          document list, the count of what is stored, live reload, the status for a screen
          src/http.hpp: HTTP/1.1 and TLS (mbedTLS), one thread per connection
          src/fs.hpp: the file system; FatFS directly on the board's card
          src/secure.hpp: certificates, tokens, random numbers
board     esp32/main: Wi-Fi, the card, the OLED, signed updates; pins per board (board_pins.h)

also      hub/server.js: the same API in Node, still the only one with workspaces;
          test/contract.sh holds the two to identical answers (107 requests)
```

## What it gets right for a microcontroller

- **The browser does the work.** Markdown, syntax colouring, search, highlights, the layout: all in the page. The board moves bytes and small JSON, which is the one thing a 240 MHz chip with a few hundred KB does well. This is the decision that most decides whether a board can serve this at all, and it was made right from the start.
- **One server for the computer and the board,** built and tested on the computer: the contract test against the Node server, the sanitizers, 20,000-file trees, all with the board's limits (`--profile esp32`). What only the board has is fenced off (`fs.hpp`'s FatFS side, `esp32/main`). A change to a route is tested in seconds, not by flashing.
- **Bounded memory,** as of this branch: files and uploads stream, the list is written as it is made, sorting has a budget, nothing holds one thing per file.
- **Security that fits a home network:** TLS with a constrained local authority, pairing, per-device tokens. The board is not a toy on the network.

## What hurts

- **A thread per connection.** Each costs a 12 KB stack on top of TLS's buffers: about 30 KB at the peak on the T3 V1.6.1, which is why it serves 4 at once (more now wait their turn rather than fail). On the T3-S3, TLS's buffers live in PSRAM and only the stacks take internal memory: 8 at once.
- **`hub.cpp` is one 2,100-line file.** Routes, pairing, storage, the list, the count and the status sit side by side, and the board's differences arrive as profile flags read all over it. It works, and the tests guard it, but it is past the size where one person keeps it in their head.
- **Two servers.** Every feature and fix is written in C++ and in Node. The contract test keeps them equal; it does not halve the work. On this branch alone, several fixes (the unreadable notes file, upload limits, the status) went into C++ only.
- **The notes file is one JSON file,** parsed whole and rewritten whole for every note. Bounded by how many notes there are, not by the card, but on the board a parsed file takes about ten times its size.
- **Our own HTTP parser** is code that faces the network. It is small, every size has a limit, and it runs under the sanitizers in the tests; still, it is ours to keep right.

## Other ways it could be built

| Way | What it would gain | What it would cost | Verdict |
|---|---|---|---|
| **ESP-IDF's HTTPS server** (`esp_https_server`) | Espressif maintains the parser; one task with `select()` instead of threads | Every route rewritten to its API; no build on a computer, so the board's server would leave the contract test (or need an adapter layer as big as `http.hpp`); event streams need its async handlers; TLS memory per connection is the same | No: it splits the code in two to save the smaller of the two costs |
| **Arduino ESPAsyncWebServer** | Asynchronous, popular, little code | HTTPS is not properly supported (its TLS layer is unmaintained): the security model could not be kept | No |
| **An event loop in `http.hpp`** (`poll()` on lwIP, mbedTLS non-blocking) | No thread, so no stack, per connection: the 12 KB goes; idle TLS connections cost a few KB. Keeps one codebase and the tests | Streaming routes (sending a file, receiving an upload, building the list) become resumable steps; the list, which can take seconds on the card, moves to one worker thread | **Yes, later, on the T3 V1.6.1, if measurement says 4 at once is too few.** Not needed on the T3-S3 |
| **MicroPython, Lua, Espruino** | Quick to change on the board | Too slow and too hungry for TLS and FAT at this scale | No |
| **Rust** (`esp-idf-svc`) | Memory safety | A rewrite with nothing the reader would notice | No |
| **The board as a plain file server**, logic in the browser | Simplest server | Pairing, tokens, notes from several devices: none can be enforced by the browser | No |

## Recommendation

1. **Keep the shape.** The measured costs fit both boards: the T3 V1.6.1 serves 4 at once and queues the rest; the T3-S3, with PSRAM, 8 and 12 open pages.
2. **Retire the Node server** by moving workspaces into the C++ server (already in `../../TODO.md`). That is the biggest saving in work, and it ends features drifting apart.
3. **Split `hub.cpp`**, with no change in behaviour, into parts of a few hundred lines: `routes` (requests to answers), `auth` (host names, pairing, devices), `store` (notes, settings, front pages), `docs` (the list, titles, its cache), `usage` (the count, the watcher), `status`. The contract test guards the move.
4. **One notes file per document** (already planned): memory and write cost both drop.
5. **The event loop**, for the T3 V1.6.1, once `/api/device` on a real board shows connections waiting too long.
6. In the page, as `../../REVIEW.md` recommends: ES modules, and a small reactive state model so a change redraws what changed rather than whole lists.

And if another board is bought for this: the **T3-S3**. PSRAM takes away the memory ceiling that shaped most of this branch, its USB is the chip's own, and it has a button.
