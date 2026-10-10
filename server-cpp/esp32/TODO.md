# Board plan (branch `claude/esp32-32gb-memory-efficiency-n3dz1c`)

The ESP32 side of the hub: what is done on this branch, what has to be tried on the board, and what comes next. The project-wide plan is `../../TODO.md`; this branch's review is [REVIEW.md](REVIEW.md); how to use it is [README.md](README.md).

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

## Next

- [ ] An event loop instead of a thread per connection: the 12 KB stack each is the largest cost per device after TLS. With `select()` on lwIP and mbedTLS's non-blocking mode, many more devices fit
- [ ] One notes file per document: the notes file is read and parsed whole for every note saved, and on the board a parsed file takes about ten times its size
- [ ] The same "never overwrite an unreadable notes file" in the Node server (`hub/server.js`)
- [ ] Wi-Fi set up without the card: a setup network of the board's own (SoftAP) with a page to choose the network
- [ ] The BOOT button (GPIO 0) to turn screen pages: storage, uptime, the full fingerprint, the version
- [ ] Battery level on the screen (ADC 35), for running without USB
- [ ] Check for an update now, from the reader (a paired device asks; the board looks at once)
- [ ] A larger upload limit on the board, or resumable uploads, so videos can go up through the reader
- [ ] exFAT, for cards larger than 32 GB. FatFS supports it, but ESP-IDF 5.4 builds FatFS with exFAT off (`FF_FS_EXFAT 0` in its `ffconf.h`, no menuconfig option): it needs a patched FatFS component, and 64-bit sizes through `fs.hpp`
- [ ] Free room in the update slot: about 124 KB left with mDNS. If it runs short, the slots can grow by shrinking the state partition, at the cost of pairing again once
