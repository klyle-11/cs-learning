# Board plan (branch `claude/esp32-32gb-memory-efficiency-n3dz1c`)

The ESP32 side of the hub, for two boards (LilyGO T3 V1.6.1 and T3-S3 V1.3): what was asked for on this branch and where it stands, what is done, what has to be tried on a board, and what comes next. The project-wide plan is `../../TODO.md`; this branch's review is [REVIEW.md](REVIEW.md), its architecture evaluation [ARCHITECTURE.md](ARCHITECTURE.md), how to use it [README.md](README.md).

## What was asked for on this branch

Every request so far, in the order it came, and where it went. ☐ marks what still needs doing, mostly trying it on a board.

First request:
- [x] A branch for the ESP32 work: `claude/esp32-32gb-memory-efficiency-n3dz1c`
- [x] Remove the 3 GB folder limit, for a 32 GB card: no quota on the boards; the card's free space, less 16 MB, is the limit
- [x] Stop working out what is stored by walking every file for each upload and storage question: measured once, then counted as the server writes
- [x] A memory overhaul for the board, up to 32 GB: bounded memory; 180 KB peak on 20,000 files, against 26 to 35 MB
- [x] The board is the T3_V1.6.1 (first written as V1.6.2; corrected)

Second request:
- [x] On the OLED: connected devices' names and IPs; the title "Learner-servr" in serif at the top; a star on the right, animated; pairing codes when they are made; the server's IP and port
- [ ] The star from the picture linked: the link could not be opened from where this was built, so the star follows the description (minimalist line star). Send the image itself to match it closer
- [x] Updates pulled from GitHub, installed by themselves: signed releases, forward only, rolled back if the new one fails (`tools/release.sh`)
- [ ] An update tried end to end on a board, including a deliberately broken one rolling back
- [x] Its own README, TODO and review for this branch: this folder
- [x] A converter for videos over 2 GB: `tools/shrink-video.sh`, on a computer (the board cannot re-encode); the board serves files up to FAT32's 4 GB anyway
- [x] Would reactive programming help: REVIEW.md, at the end, and ARCHITECTURE.md
- [x] Is this a new branch: yes, the one above; not merged, no pull request
- [x] Error boundaries for ESP32-specific failures: REVIEW.md, "Error boundaries"
- [x] Folder uploads of 1,000 files in folders and subfolders: memory holds; the unnecessary work removed (titles reused, fewer folder searches, fewer list reloads)
- [x] Home Wi-Fi, a domain name, more devices, updates from online: README, "Connecting", "More devices at once", "Updates"

Third request:
- [x] The back button: at most two places per document in its history (the first and the latest), not every section visited (`hub/app.js`, "Back")
- [x] Look over every request and put what is open on this list: this section
- [x] A second build for the LilyGO T3-S3 V1.3 (SX1262, 915 MHz, 4 MB flash, 2 MB PSRAM, BOOT and RESET buttons, the same 32 GB card): `idf.py set-target esp32s3`, `pio run -e t3s3`
- [ ] The T3-S3 build tried on the board
- [x] Re-evaluate the architecture: ARCHITECTURE.md (keep it; retire Node, split `hub.cpp`, an event loop only if the T3 V1.6.1 needs it)
- [x] On the OLED, addresses that all start the same (192.168…) shown by what follows ("1.23")
- [x] A narrower, taller star
- [x] A larger upload limit from the reader with the T3-S3: 4 GB (FAT32's limit) on both boards; the reader now asks the server for its limit instead of assuming 50 MB, and says which files were left out and why

## Done on this branch

A full 32 GB card in a few hundred KB:
- [x] No 3 GB quota on the board: the card's free space, less 16 MB, from FatFS's own count
- [x] What the folder holds is measured once at start-up, then counted as the server writes; no walk per upload or storage question
- [x] No watcher thread on the board: only the server writes to the card, so it announces its own changes as it makes them
- [x] The document list streamed to a file on the card, never a JSON tree in memory; folder names sorted in 32 KB, bigger folders in extra passes, same order as on a computer
- [x] Folders listed through FatFS directly (sizes and times come with the directory; `stat` per file searched it again)
- [x] Files of 2 to 4 GB served correctly (the board's `off_t` stops at 2 GB)
- [x] Fewer FatFS file slots and no per-file sector buffers: about 65 KB of heap back
- [x] Measured on 20,000 files with the board's limits: 180 KB heap at the peak, 26 to 35 MB before

The screen:
- [x] SSD1306 driver on I2C (SH1106 and upside-down as options), only changed bytes sent
- [x] Title in serif, animated line-art star, address and name, devices with their IPs, pairing code with countdown and fingerprint, update progress, start-up and error messages, notices; dims after ten idle minutes
- [x] A computer-side preview (`tools/screen-preview.cpp`)

Large uploads:
- [x] Titles reused from the previous list for files that did not change: after an upload a new list opened 2 documents instead of 15,002
- [x] Folders created only when missing; one look per upload instead of two; on the board the temporary file is written in the cache folder (one search of a big folder per file, not two)
- [x] The page asks for the list at most every three seconds while changes keep coming, and not at all during its own upload

Errors (see REVIEW.md):
- [x] An unreadable notes or settings file is never overwritten (it was replaced by the one new change)
- [x] Saves cut short by a power cut put right at start-up (FAT replaces a file in two steps); partial uploads removed
- [x] Folder depth limited (stack); memory checked before taking in a connection; closed pages free their place at once
- [x] No card, no page on the card, no Wi-Fi, a card taken out, a server that cannot start, out of memory at start: said on the screen, retried or restarted
- [x] `Content-Length` larger than the board's 32-bit sizes refused instead of wrapping
- [x] The ESP-IDF build compiles again (two mbedTLS threading options at once, `lstat`, a format warning)

Network:
- [x] Wi-Fi from `wifi.txt` on the card, kept in flash and deleted from the card
- [x] `NAME.local` by mDNS, the name sent to the router as the DHCP host name, and in the certificate
- [x] Connections over the limit wait instead of being refused; 6 open pages instead of 2; 16 sockets

Updates:
- [x] Two program slots (the state partition where it was), signed releases from GitHub, forward only, rollback if the new one fails, `tools/release.sh`

Third round:
- [x] Back history by place (document, section, scroll), two places per document at most
- [x] T3-S3 V1.3 build: pins by chip (`main/board_pins.h`), PSRAM on, TLS buffers in PSRAM, console on the USB-C port, an `esp32-psram` profile (8 connections, 12 open pages, page and scripts kept in memory, 512 KB to sort folder names), the BOOT button showing the board's details on the screen
- [x] Upload limit 4 GB on both boards; a stalled upload gives up after 30 s without data; the reader uses the server's limit, sends big files only by "Upload a folder" (straight from disk), and lists what it left out
- [x] The OLED: a taller, narrower star; device addresses without the start they all share

## To try on the board

- [ ] Flash by USB (the partition table changed); check the screen comes up, at 0x3C or 0x3D, the right way up
- [ ] `GET /api/device` with 1, 2, 4 devices and pages open: `heapFree`, `heapLeast`, `heapLargest`. Raise or lower `max_conns` and `max_streams` in the `esp32` profile to match
- [ ] How long the list takes on a card with a few thousand documents, first time and after an upload
- [ ] Upload a folder of a thousand files from the reader; time it, and watch memory
- [ ] A release end to end: keys, release v2, the board finds it, installs, restarts, keeps it after a minute
- [ ] A release that crashes on purpose (v3): the board must go back to v2 by itself
- [ ] Take the card out while it runs; put it back
- [ ] `hub.local` from an iPhone, a Mac, Windows, and an Android phone
- [ ] A clone board: SH1106 or not, pins the same or not
- [ ] T3-S3: flash over its USB-C (hold BOOT while plugging in if it will not take it), the screen at 0x3C on 18/17, the card on 11/2/14/13, `/api/device` reporting `esp32-psram` and `psramFree`, the BOOT button
- [ ] A 1 GB upload through the reader on each board: how long, and whether anything else stays usable meanwhile

## Next

- [ ] An event loop instead of a thread per connection: the 12 KB stack each is the largest cost per device after TLS. With `select()` on lwIP and mbedTLS's non-blocking mode, many more devices fit
- [ ] One notes file per document: the notes file is read and parsed whole for every note saved, and on the board a parsed file takes about ten times its size
- [ ] The same "never overwrite an unreadable notes file" in the Node server (`hub/server.js`)
- [ ] Wi-Fi set up without the card: a setup network of the board's own (SoftAP) with a page to choose the network
- [ ] More screen pages on the BOOT button (T3-S3): storage, the full fingerprint; it shows the board, version, uptime and memory for now
- [ ] Split `../src/hub.cpp` into parts (ARCHITECTURE.md, recommendation 3)
- [ ] Battery level on the screen (ADC 35), for running without USB
- [ ] Check for an update now, from the reader (a paired device asks; the board looks at once)
- [ ] A larger upload limit on the board, or resumable uploads, so videos can go up through the reader
- [ ] exFAT, for cards larger than 32 GB. FatFS supports it, but ESP-IDF 5.4 builds FatFS with exFAT off (`FF_FS_EXFAT 0` in its `ffconf.h`, no menuconfig option): it needs a patched FatFS component, and 64-bit sizes through `fs.hpp`
- [ ] Free room in the update slot: about 122 KB left with mDNS (130 KB on the T3-S3). If it runs short, the slots can grow by shrinking the state partition, at the cost of pairing again once
