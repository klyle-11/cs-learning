# Board review (branch `claude/esp32-32gb-memory-efficiency-n3dz1c`)

10 October 2026. A review of the ESP32 build as this branch leaves it: memory, the ways it fails that only a board has, what the screen and the updates add to the risks, and what is still unproven. The project-wide review is `../../REVIEW.md`; findings there are referred to by number ("review 24").

Read in full: `../src/hub.cpp`, `http.hpp`, `fs.hpp`, `status.hpp`, `main/*.cpp`, `main/*.hpp`, the build files. Server behaviour was tested on a computer with the board's limits (`--profile esp32`): the comparison test against the Node server (107 requests, identical), the same under AddressSanitizer and UBSan, a 20,000-file tree, a 3 GB file read past 2 GB, a damaged notes file, the status the screen reads. The board-only code (screen, Wi-Fi, card, updates) compiles with ESP-IDF 5.4.1 with and without mDNS, and the release signing was checked end to end (OpenSSL signs, the board's mbedTLS code verifies, tampering is refused). **None of it has run on a board.**

## Verdict

Memory no longer depends on how much is on the card: what grows with the number of files is now on the card (the list, the titles) or bounded (32 KB of names to sort, 10 folders deep), and the measured peak on 20,000 files is 180 KB where it was 26 to 35 MB. The board's own failure modes (power cuts, a card pulled out, no network, low memory) now end in a message on the screen and a retry, not a silent board or lost notes. The updates add the most risk, and are built to contain it: signed, forward only, undone if the new firmware fails.

What decides whether it works is now measurement on the board: free memory with several devices, stack headroom, the time to list a full card. The board logs the numbers needed (`/api/device`, and stack headroom after five minutes).

## Error boundaries

Ticked: handled on this branch. Each says what happened before and what happens now.

### Data

- [x] **An unreadable notes file was replaced by an empty one** (review 19, on the board). If `notes/notes.json` did not parse, the server took it as empty, and the next note saved wrote a list of one: every earlier note gone. On the board this was likely, not rare: a power cut during a save, or simply too little memory to parse a large file (cJSON then fails the same way). *Now:* a file that exists but cannot be read is never written over; saving answers 500 "could not be read, so nothing was changed" and the file stays for repair. The same for `hub.json` (titles, highlight types, folder locks). The Node server still has the old behaviour.
- [x] **A power cut between two steps of a save lost the file.** FAT cannot rename onto an existing file, so a save on the board is "delete the old one, rename the new one into place" (`secure::replace`). A cut between the two left only `notes.json.tmp`, and the server started with no notes. *Now:* at start-up the board puts such a file back (a `.tmp` with no file beside it is a finished save), deletes a `.tmp` that has its file (a save that never finished), and does the same in the state partition (devices, certificates) before reading it. Elsewhere a rename replaces in one step and nothing is touched.
- [x] **Interrupted uploads left partial files.** *Now:* on the board uploads are written in `.hub-cache/` and moved into place when complete; the cache folder is emptied at every start.
- [ ] **FAT itself has no journal.** A power cut while FAT's own tables are being written can damage the file system, whatever the server does. Nothing in software fixes that; a small UPS or a battery (the board has a charger) does. A computer's `fsck`/"First Aid" repairs most damage.
- [ ] **The certificate files are written one after another on first start.** A cut in the middle may leave a set that does not match; the next start then makes a new authority, and every device installs it again. Rare (first start only), and visible.

### The card

- [x] **No card, or not FAT32, at start-up**: the board returned from start-up and sat there, saying so only on the serial port. *Now:* the screen says so and it tries again every 5 seconds.
- [x] **No reader page on the card** (`hub/www/index.html`): the server refused to start, the board restarted every 30 seconds. *Now:* the screen says to run `make card`, and waits.
- [x] **The card taken out while running**: requests failed one by one, the count of what is stored belonged to a card no longer there. *Now:* FatFS checks the card before each use (ESP-IDF 5.1 and later), a watch notices within 3 seconds, and the board says so and restarts, waiting for a card. A clean start is the only safe way to take a new card: its contents, and the count, are another card's.
- [x] **Very deep folders**: each level of the list is stack, and connection threads have 12 KB. *Now:* the list and the count stop at 10 levels (64 on a computer) and say so once.
- [x] **Files of 2 to 4 GB**: their size read as negative, and reading past 2 GB failed (`off_t` is 32 bits). *Now:* read through FatFS (`fs.hpp`).
- [ ] **Large single folders are slow on FAT**: adding a name searches the folder from its start, and the short-name scheme searches again for similar names. Bounded in memory, not in time. README advises subfolders.

### Memory

- [x] **Out of memory while serving**: was already caught per connection (503, the connection closed). *Now also:* a connection is taken in only with 48 KB free, 20 KB of it in one block (one connection is always let in, so wrong thresholds cannot lock everyone out); event streams are refused (503) under the same condition; over the limit, connections wait in the listening queue instead of being dropped.
- [x] **The watcher kept every path twice** (review 24): no watcher on the board.
- [x] **The list as a JSON tree**: written out as it is made; on the card.
- [x] **`Content-Length` past 4 GB wrapped round** on a 32-bit board to a small number, so the rest of the body was read as the next request. *Now:* refused (413).
- [ ] **Fragmentation over weeks.** Free memory can stay large while the largest block shrinks; a TLS record needs 16 KB in one piece. The admission check refuses new connections rather than failing inside one, which keeps it safe, but it can make the board unhelpful after a long run. Measure `heapLargest` over days; a restart at a quiet hour once a week is the usual answer if it drifts.
- [ ] **The notes file is parsed whole** on every save (review 36): about ten times its size in memory. Bounded by how many notes there are, not by the card; one notes file per document is the fix (TODO).

### Network and start-up

- [x] **No Wi-Fi settings** (none built in): it tried an empty network forever. *Now:* "No Wi-Fi settings: put wifi.txt on the card".
- [x] **A network that cannot be joined**: the screen says so after 20 seconds and keeps trying.
- [x] **Wi-Fi lost while running**: it reconnected, silently. *Now:* "Wi-Fi lost: rejoining" until it has an address again. The reconnect waits a second inside the event handler, which also holds up other network events for that second; harmless here.
- [x] **The server could not start** (certificates, the folder): "the server stopped" on the serial port and nothing else. *Now:* on the screen, a restart after 30 seconds, and if this is a new firmware on trial, back to the previous one.
- [x] **No memory for the server's thread at start**: an uncaught exception, a crash, a restart loop. *Now:* caught, said, restarted.
- [x] **Pages that close** kept their place among the event streams until the next change; with 2 places, two closed tabs locked out the next device. *Now:* a closed stream is noticed when a new one asks (it has data to read: the close), 6 places.

### Stacks

Chosen by estimate, to be measured (the board logs the unused part of each after five minutes): connection threads 12 KB (TLS handshake, then the request, the list 10 levels deep at most), the server's start-up thread 16 KB (certificates: EC P-256, fast), the screen 6 KB, the update task 8 KB (a TLS handshake with certificate checks), the watch 6 KB.

## The T3-S3 V1.3 (third round)

The second board shares every line of the server and nearly all of the board code: the build target picks the pins (`main/board_pins.h`), `sdkconfig.defaults.esp32s3` adds PSRAM, and at start-up the server finds 2 MB of PSRAM and takes the `esp32-psram` profile. It builds (ESP-IDF 5.4.1, 1.27 MB, 12% of the update slot spare); it has not run.

- **What PSRAM changes.** mbedTLS allocates in PSRAM (`CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC`), so a connection's 20 KB of TLS buffers leave internal memory, and only its 12 KB stack stays. Hence 8 connections and 12 open pages, the page and its scripts kept in memory (about 380 KB) instead of read from the card on every load, and 512 KB to sort folder names in one pass.
- **What stays internal, on purpose.** Thread stacks: tasks with stacks in PSRAM cannot run while the flash cache is off (during flash writes, so during updates), and the SD card's SPI transfers would go through bounce buffers. Buffers of 16 KB and under (the 8 KB pieces files are sent in): DMA needs internal memory, and the SD driver would otherwise read a sector at a time.
- **The memory check** counts both: 40 KB of internal memory with a 16 KB block (a stack), and 96 KB of PSRAM.
- [ ] Measure on the board: `/api/device` gives `heapFree` (all memory), `psramFree`, `heapLargest`; the BOOT button shows internal and PSRAM free on the screen.
- [ ] Under the PlatformIO build, whether TLS buffers go to PSRAM depends on the Arduino core's settings; the memory check keeps it safe either way, but fewer may fit.

## Uploads of gigabytes (third round)

- [x] **The limit was the page's, as much as the board's.** The page dropped files over 50 MB without a word (review 21), whatever the server could take; the board took 4 MB. *Now:* both boards take up to 4 GB (FAT32's largest file); the page asks the server (`/api/device`, `maxUpload`; the Node server keeps 50 MB) and lists what it leaves out, with the reason. "Add files", which keeps each file on the device until it is sent, stops at 200 MB, and says to use the folder button, which sends from the disk.
- [x] **A stalled upload held a connection for hours.** The time allowed was the whole body's (30 s plus its size at 32 KB/s: 36 hours for 4 GB). *Now:* each piece must also arrive within 30 seconds of the last.
- [ ] A long upload occupies one of the 4 (T3 V1.6.1) or 8 (T3-S3) places, and shares the SPI bus and the processor's TLS work with everyone else: the others slow down while it runs. Measured: not yet.

## Updates for two boards (third round)

- [x] Both boards fetching one release's image would have offered the T3-S3 the T3 V1.6.1's firmware (the image check would refuse it, and the S3 could then never update). *Now:* a release holds an image and a manifest per chip, and the chip is in the signed sentence, so one board's signed image cannot be passed to the other. Checked: each manifest is accepted by its own chip's code and refused by the other's.

## The screen

- It shows the pairing code to whoever is in the room. That is the point (physical presence is what pairing proves: review 23 asked for the address, the fingerprint and the code on the board), but it also means anyone near the board can pair while a code is on offer. Codes last ten minutes and are offered only when no device is paired or a paired device asks.
- It shows the names and addresses of connected devices to whoever is in the room. Fine at home; worth knowing elsewhere.
- It never makes the server walk the card: it reads the count already kept, and only once the server is up.
- It runs below the server in priority: under load the star stutters, the server does not.
- Device addresses are shortened only when all of them, and the board's, share their first two parts; then the board's own, whole on the line above, carries the part left out. One address from elsewhere (a VPN) and all are shown whole, so a shortened one is never ambiguous.
- [x] **It never dimmed** (found in the fourth round). "Nothing new for ten minutes" was judged by comparing each frame with the last below the title, but the address and the name take turns there every three seconds, more than four devices turn over in pages, and the tall star's diamond reached two rows below the title: something always changed. *Now:* `screen_sum` (`main/screen_draw.hpp`) gives a number for what the screen says (drawn as at frame 0, and every device, those on later pages too), and only a change in it counts; the star is cut at the title's band. Checked on a computer: ten idle minutes, no change counted (299 before); a device opening or closing a page, leaving from the second page, a notice, an alert, each counted.

## Updates

What an attacker needs, and what stops them:

| To get code onto the board | What stops it |
|---|---|
| Control of the GitHub repository or account | The signature: the board installs only images signed with your key, which is not on GitHub |
| A position on the network (rogue Wi-Fi, DNS) | HTTPS to GitHub, checked against the certificate bundle; and the signature regardless |
| An old, faulty release replayed | The version is inside the signature and must be higher than the running one |
| The signing key | Nothing: keep it off GitHub, off CI, backed up somewhere safe. If it leaks, reflash every board by USB with a new key |
| A broken release of your own | The new image is kept only after a minute of serving; before that, a crash or a failed start goes back to the previous one (ESP-IDF build; PlatformIO depends on the Arduino core's bootloader) |

- [ ] A release that boots and serves for a minute but is wrong in some other way stays. The fix is not to publish it; the board cannot know.
- [ ] Releases must be public (the board does not sign in to GitHub). Putting a GitHub token on the board would be a key to the repository on a removable-card device: a separate public repository for firmware is better.
- [ ] Room: the program is 1.32 MB with mDNS in a 1.38 MB slot (about 122 KB left on the T3 V1.6.1, 130 KB on the T3-S3; IPv6 is left out of the network stack to make that). Growing the slots means shrinking the state partition, which means pairing again once.

## Other things checked

- Sorting with bounded memory gives the same order as sorting everything: compared on 20,000 files, and on a 3,000-entry folder holding 2,000-entry folders (where a folder holding most of the budget lets its names go while an inner one is walked, so the inner one is not starved).
- The title cache reuses a title only if the file's size and time are unchanged; an edited heading showed up in the next list.
- The status the screen reads was exercised under the sanitizers: pairing, the countdown, the notice, a page opening and closing.
- `hub.local` and the board's name are in the host names the server accepts and in the certificate.

## Would reactive programming help?

Asked alongside this review. For the server on the board, the reactive *libraries* (observables, RxCpp) would add code and memory to a program short of both. The idea underneath, reacting to events as they arrive instead of polling or blocking, is what helps, and this branch already moves that way: changes are announced as they happen instead of the folder being polled, and the screen redraws from a status that the server keeps up to date. The next step in that direction is an event loop (one thread reacting to whichever connection is ready) instead of a thread per connection: that is what would let many more devices in (TODO). For the page (`hub/app.js`), a small reactive state model (signals) would address review 39, lists rebuilt in full for small changes.
