# Hub HTTP API

The contract between the page (`hub/index.html`) and whichever server is behind it. `server-cpp/hubd` implements it. `test/contract.sh` sends 123 requests and compares the answers with those recorded in `test/expected.txt`, which date from when `hubd` and the Node server it replaced answered identically. The page, its scripts and the trust routes are public; everything else needs a paired device (see Security).

All JSON bodies are UTF-8. Errors are `{ "error": "message" }` with a 4xx or 5xx status. Paths are relative to the folder being served, use `/`, and may never contain `..`.

## Pages and files

| Request | Answer |
|---|---|
| `GET /` | `index.html` |
| `GET /app.js`, `/local.js`, `/vault.js` | the page's own scripts |
| `GET /js/<name>.js` | a module of the page's (`hub/js/`): `<name>` is lowercase letters, digits and hyphens only; 404 for anything else, or a name that is not there |
| `GET /sw.js`, `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png` | the service worker, manifest and icons: they let the page be installed and opened without the server |
| `GET /vendor/marked.js`, `/vendor/highlight.js`, `/vendor/purify.js` | the three libraries the page loads |
| `GET /vendor/marginalia/<name>`, `/vendor/marginalia/wasm/<name>` | a file of the document engine (`hub/node_modules/marginalia-engine/dist/`, or `vendor/marginalia/` beside the page on the board): `<name>` is lowercase letters, digits, `-` and `_` with `.js`, `.css` or `.wasm` (sent as `application/wasm`); 404 for anything else, so no other folder of the package is served. `worker.js` is sent with `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'` and `recolor-worker.js` with `script-src 'self'`: a worker runs under the policy of its own file |
| `GET /raw/<path>` | the file as it is on disk, with a content type from its extension. 404 if missing |
| `GET /api/doc?path=<path>` | the text of a markdown, HTML or source file. 404 if missing or not a readable type |
| `GET /api/blocks?path=<path>` | `{ "blocks": [{ "hash", "nth", "len" }] }`: the document as a row of blocks (paragraph, heading, list item, table cell, block of code), in order. `hash` is FNV-1a (64 bits, 16 hex digits) of the block's text with everything but letters and digits removed and ASCII letters lowered; `nth` counts earlier blocks with the same hash; `len` is the folded text's length in bytes. Blocks with no letters or digits are left out. A source file is one block. 404 as for `/api/doc`; 413 for a file too large to hold in memory (16 MB on a computer, 1 MB on the board). See `src/anchor.hpp` |

## Pages that may run their own scripts

`hub.json` may hold `"scripts": ["folder/page.html"]`: HTML pages, by exact path, that are small programs of the user's own. `GET /raw/<such a page>` is answered with a policy that allows its inline scripts, files picked or dropped into it, and pictures, media and connections over `https:`, inside a sandbox without `allow-same-origin`. Every other file under `/raw/` keeps the policy with no scripts. `GET /api/config` passes the list through, and the reader frames such a page to match; `PUT /api/config` does not write it.

## Files of saved links

A `.txt`, `.json`, `.jsonl`, `.ndjson` or `.csv` file is listed (with `"links": true`) only if an `https://` address is found in its first 64 KB; a browser's bookmark export (`.html` beginning `NETSCAPE-Bookmark-file`) is listed with `"links": true` as well.

| Request | Answer |
|---|---|
| `GET /api/links?path=<file>` | `{ "items": [{ "title", "thumb", "preview", "page", "media": [{ "url", "kind" }] }], "more" }`: what is saved in the file, all of it (on the `esp32` profile at most 2000, and `more` says there were more). In JSON, an item is any object with `thumbnailUrl` or `directMedia` (and `title`, `mediaPage`, `sourcePage` if there); the older names `mediaUrl`, `directUrls`, `ytDlpUrls`, `linkUrl`, `postUrl` are read the same way, and upper and lower case are not told apart. `media` is what `directMedia` lists (a list, or one address); a `thumbnailUrl` that is a picture is `thumb`; one that is a clip is `preview` (a moving thumbnail) when there is direct media, and is itself the media when there is none; `page` is `mediaPage`, or `sourcePage` if there is none; in a bookmark export, each `<a href>`; otherwise, and in JSON with no such objects, each `https://` address once. `kind` is `video` or `audio`, told from the address's ending (the kinds of file a browser shows or plays: `.jpg .jpeg .jfif .png .apng .gif .webp .avif .bmp .svg .ico`; `.mp4 .m4v .webm .mov .ogv .mkv`; `.mp3 .m4a .aac .ogg .oga .opus .wav .flac .weba`) or from `format=`, `fm=` or `mime=` in it. The type need not be at the very end: a slash after it is ignored (`…/394826.mp4/`), and failing all that, a media type anywhere after the site's name counts (`…/clip.mp4/play`, `…?file=clip.mp4&x=1`), video looked for first. An address that is none of these is a page, under whichever name it was saved (a `thumbnailUrl` or a `directMedia` entry that is a web page is not drawn or played: it becomes the item's `page` if it has none, and an item with nothing but pages goes in the table of pages, not the grid). Only `https:` addresses are kept |
| `GET /cards/<file>` | a gallery made from the same items, as one page: a grid of cards for what is a picture, a video or sound, shown 60 at a time, each opening a viewer with an arrow to the one before and after and a reel of those nearby; under the grid, a table (name, site, address) of the items that are only pages, sorted by site; at the side, a list of everything in the file, each line a way to that item. The page has filters of its own (a kind; one of the entries an item of a JSON file has, "thumbnail", "video", "webm" (a `.webm` clip is named apart from other video, in the kinds too), "picture", "sound", "page", "linked page" or "source page", the list offering those the file has; and words in the name or in any of the item's addresses), worked by its script. A `thumbnailUrl` that is a video file other than a `.webm` (an `.mp4`, say) is taken for the video itself, not a thumbnail. The viewer's bar has the exact address of what it shows (the video, else the picture, else the sound) as a link, and under the bar every address the item groups, the one on show marked. `?item=<n>` (the item's place in the file, as `/api/search` gives it) makes the page open at that item's card, or its row in the table of pages: the server writes that card's or row's id on `<body data-at>` and the page's script goes there; nothing else of the request is put in the page. `?rev=1` turns the order round (last in the file first; the table of pages too); the page's "reverse" button tells the reader by `postMessage({ cardsReversed })`, and the reader loads the page again with it (the page itself may not ask the server for anything). `?size=` (70 to 420) is how wide a card starts; the page tells the reader, by `postMessage({ cardSize })`, when its slider is moved. `?paper=&shade=&ink=&muted=&rule=&accent=` (six hex digits each) give it the reader's colours; anything else is ignored. Sent with a policy that allows pictures over `https:` and `data:` (the browser's own player draws its buttons from `data:` pictures) and media over `https:`, and one script: the server's own, named by a nonce made for each answer (it stops what is playing when the viewer moves on, starts a `.webm` clip when it is come to, plays the clips in the grid silently while they are in sight, has a video with no picture of its own show its first frame once it is in sight, puts a play button on each card with a video (not on one whose thumbnail is a clip already playing), which plays it in the card, one at a time, and gives the arrow keys their use). The size slider and page buttons stay at the top while the grid scrolls. The sandbox has no `allow-same-origin`; the reader shows the page in a frame |

404 for a file of another kind, a hidden name, or none; 413 for a file larger than is held in memory at once. See `src/links.hpp`.

## Books (EPUB)

An `.epub` file is listed as a folder of its pages, in reading order: each page is a document whose path goes into the book, `shelf/book.epub/OEBPS/text/ch1.xhtml`, with `group` the book's path and `title` the page's name in the book's table of contents (the file's own name for a page the contents leave out). Such a path works wherever a document's path does:

| Request | Answer |
|---|---|
| `GET /raw/<book.epub>/<path inside>` | that file of the book, whole (no `Range`), with its type (`application/xhtml+xml` for a page) and the same content policy as any `/raw/` file. Pictures, styles and fonts beside a page are found this way |
| `GET /api/doc?path=<book.epub>/<page>` | the page's text; 404 for anything that is not a page |
| `GET /api/blocks?path=<book.epub>/<page>` | the page's blocks |

404 if the book or the file in it is missing; 413 if the file is larger than is held in memory at once (16 MB on a computer, 1 MB on the board); 500 if the zip is damaged or uses what is not handled (zip64, encryption, a method other than stored or deflate). Each entry is checked against the size and CRC the zip records. A book whose pages cannot be found is not listed. Books are not searched by `/api/search`. See `src/zip.hpp` (the zip reader and inflate) and `src/epub.hpp`.

## Search

`GET /api/search?q=<words>` → `[{ "path", "line", "text" }]`: lines containing the words, in the documents that can be read as text. A file of saved links (what `/api/docs` marks `links`) is searched by its items instead, as `/api/links` gives them: a hit there is `{ "path", "item", "text" }`, where `item` is the item's place in the file (from 0) and `text` its name and the address the words are in; the words are looked for in the item's name and in each of its addresses. `/cards/<file>?item=<n>` opens at that item. Such a file is read whole (up to what is held in memory at once), and read through for its items only if the words are in it. Letter case is ignored. At most 3 lines per document and 60 in all; `text` is the part of the line around the match. Hidden files, `notes/` and anything on the ignore list are not searched. 400 unless `q` is 2 to 100 characters. Every document is read for each search, so the reader waits for a pause in typing before asking.

## Listing

`GET /api/docs` → array, in display order (folders walked in natural name order):

```json
{ "path": "a/1-doc.md", "group": "a", "title": "First", "side": false, "front": false, "changed": 1759570000 }
```

`changed` is when the file was last changed, in seconds since 1970 (the pages of a book have none): the reader lists the added folders with the one most recently added to first.

A page of a book also has `bookTitle`, the book's own title, when the book gives one: the reader puts it after the page's name wherever the page is named away from its book.

`title` is the first `# Heading` (markdown), `<title>` (HTML), or the file name. Pictures, video, sound and PDFs are listed by their file names. Hidden files, `node_modules`, `notes/`, the server's own folder and anything matching `ignore` are left out.

## Settings

`GET /api/config` →

```json
{ "title": "…", "side": ["references.md"], "ignore": ["CLAUDE.md"],
  "highlights": [{ "id": "important", "name": "Important", "color": "#fbeeb0" }],
  "front": "FRONTPAGE.md", "root": "/absolute/folder" }
```

`front` is `null` when there is no `FRONTPAGE.md`. When there is one, `title` is its first heading.

`PUT /api/config` with any of `{ "title": "…", "highlights": [...] }` → the new config. A title is trimmed and its whitespace collapsed; with a front page it rewrites that file's heading, otherwise it is stored in `hub.json`. Highlight types without an `id` or a `#rrggbb` colour are dropped; an empty name becomes `Untitled`.

`GET /api/hubs` → `[{ "name": "Desktop", "url": "https://192.168.1.20:4321" }]`: other hubs the reader may connect to. `PUT /api/hubs` with `{ "hubs": [ … ] }` replaces the list (at most 12) and answers with it. Each `url` is cut down to its origin (scheme and host in lower case, the port unless it is the usual one, nothing after it); entries with no name, with an address that is not `http(s)`, or repeating an address are dropped. Kept in `hubs.json` in the state folder, not in the workspace: it is about this server, not about a folder. The server never contacts these hubs itself; the list only says what the page may talk to and what the reader offers.

`PUT /api/config` also takes `"look"`: how the reader looks, as the device that last changed it left it (`{ "theme": "lime-dark", "font": "sans", "fs": 20, "roomy": true }` and the like). The whole object is replaced. Up to 12 values are kept: names of 1 to 20 letters, digits and hyphens; text of up to 40 such characters (or empty), numbers, and true or false. Anything else is dropped. `GET /api/config` gives it back as it was stored; the reader uses it only on a device that has no choice of its own yet.

`PUT /api/config` also takes `"locks"`: `{ "some/folder": { "salt": "…", "hash": "…" }, "other": {} }`, the folders the reader asks a password for. The whole set is replaced. `salt` and `hash` are base64 (up to 64 and 128 characters); an entry without both is kept as `{}`, a lock whose password is still to be chosen. Folder names that try to leave the workspace are dropped. The server only stores these: the reader does the asking, and the files are stored as they are.

`DELETE /api/folder?path=some/folder` → `{ "removed": "some/folder" }`. Deletes the folder and everything in it, and any lock on it or inside it. 400 if it is not a folder in the workspace, tries to leave it, or is `notes`.

`PUT /api/front` with `{ "markdown": "…" }` → the new config. Writes `FRONTPAGE.md`. 400 without `markdown`. With `"folder": "some/folder"` it writes that folder's own `FRONTPAGE.md` instead; 400 if the folder does not exist or the path tries to leave the workspace.

## Notes and highlights

Stored in `notes/notes.json`.

```json
{ "id": "…", "doc": "a/1-doc.md", "heading": "slug", "headingText": "Heading",
  "quote": "pinned text or empty", "type": "highlight type id or empty", "text": "the note or empty",
  "ts": "2026-10-03T04:30:15.022Z", "status": "highlight | open | answered" }
```

| Request | Answer |
|---|---|
| `GET /api/notes` | all notes |
| `POST /api/notes` | body needs `doc` and one of `text`, `quote`. Returns the new note. `status` is `open` with text, `highlight` without. An `anchor` object is kept if its `block` is hex (at most 32 digits): `{ block, nth, start, before, after }`, numbers floored and not negative, `before` and `after` at most 200 bytes; other keys in it are dropped, and an anchor that is not usable is left off. A highlight on a PDF's page carries `mg` instead: `{ doc, anchor }`, `doc` the file's SHA-256 (64 hex digits) and `anchor` what the document engine made: `{ unit, unitIndex, quote: { exact, prefix, suffix }, position: { start, end }, cfi, rects: [{ x0, x1, y0, y1 }] }`. It is kept if `doc` is such a hash, `unit` is at most 200 bytes and `quote.exact` at most 20000; `prefix`, `suffix` and `cfi` at most 2000 each, at most 2000 boxes, other keys dropped. The server reads nothing in it |
| `PUT /api/notes/<id>` | updates any of `text`, `quote`, `heading`, `headingText`, `type`, `anchor`, `mg`; other keys are ignored. A new `quote` sent without an `anchor` removes the old anchor, which was for the old quote; the same holds for `mg`. A highlight that gains text becomes `open`. 404 for an unknown id |
| `DELETE /api/notes/<id>` | `{ "ok": true }`, or 404 |

## Uploads and workspaces

`POST /api/upload?path=<path>` with the file as the raw body → `{ "saved": true, "root": "…" }`, or `{ "skipped": true }` if the file already exists (not overwritten). With `&replace=1` a file that is there is replaced by the body (written beside it first, then put in its place) and the answer has `"replaced": true` as well; a folder of that name is still skipped, and a path with nothing at it is saved as usual.

`GET /api/files?path=<folder>` → `[{ "path", "size", "changed" }]`: every file under that folder of the workspace (paths from the top of the workspace, sizes in bytes, `changed` in seconds), hidden names and `node_modules` left out. It is what the reader's "update" compares a folder on the device with, so that only what is new or changed is sent. 400 for a path that leaves the workspace; 404 if it is not a folder. 400 for a path with `..`, a hidden part or `node_modules`, or one longer than the system will open (on Windows, 259 characters for the whole path, the served folder included). 413 over the profile's upload limit (200 MB on a computer).

`GET /api/workspaces` → `[{ "name", "root", "home", "current" }]`.

The first entry is "home", the folder the server was started on; the rest are folders in the workspaces folder, in name order ignoring case.

`POST /api/upload?path=<path>&workspace=<name>` puts the file in a workspace of its own instead, made on first use; `root` in the answer is that workspace's folder. The name is reduced to letters, digits, `_`, spaces, dots and hyphens, without leading or trailing dots or spaces; 400 if nothing is left. Storage is measured for that workspace's folder.

`POST /api/workspace` with `{ "root": "…" }` opens that workspace in place of the one that is open, for every device, and answers with the list. 404 `no such workspace` unless `root` is one of the listed ones. The choice is remembered for the next start.

The workspaces folder is `workspaces/` beside the page, or what `--workspaces` names. When the page lives inside the folder being served, as on the board, there is none: uploads with `workspace` get 501.

## Live reload

`GET /api/events` is a server-sent event stream. Each change to a file in the folder sends:

```
data: {"file":"relative/path.md"}
```

The server compares modification times at an interval set by the device profile, because the ESP32 has no file-change notification to rely on.

## Device profile

`GET /api/device` → what the server detected and the limits it chose:

```json
{ "profile": "desktop", "cores": 8, "memoryMB": 8192, "maxUploadMB": 200,
  "watchMs": 500, "cacheAssets": true, "cacheListing": true }
```

| Profile | Chosen when | Upload limit | Folder checked every | Page and scripts kept in memory |
|---|---|---|---|---|
| `desktop` | 1 GB of memory or more | 200 MB | 0.5 s | yes |
| `small` | under 1 GB (Raspberry Pi Zero class) | 50 MB | 1 s | yes |
| `esp32` | built with ESP-IDF | 4 MB | 5 s | no |

All three keep the document list until a file in the folder changes. `--profile <name>` forces one, which is how the ESP32 limits are tried on a computer.

## Security

Both servers apply the same rules, in this order, to every request.

**1. Known host names only.** The `Host` header must name this machine: `localhost`, `127.0.0.1`, `hub.local`, the machine's own name and addresses, or a name added with `--allow-host` (`HUB_HOSTS` with `start.sh`). Anything else gets 403 `unknown host name`. This is what defeats DNS rebinding, where a website points its own name at the hub's address.

**2. Encrypted beyond this machine.** Listening on anything but `127.0.0.1` turns HTTPS on. The hub is its own certificate authority: `hubd --make-cert` (or the first start with `--host 0.0.0.0`) writes its certificates to the state folder (`--state`, `HUB_STATE`, default `~/.config/hub`; never inside the served folder). There are three, in a chain:

- `ca.pem`, the authority each device installs once. Its private key signs one thing, the issuer, and is never written to disk.
- `issuer.pem` (key in `issuer-key.pem`), which signs the server's certificates. Both it and the authority carry *name constraints*, marked critical: they may vouch only for names under `.local`, `localhost`, the machine's own host names as they were when the authority was made (`issuer.zones`), and addresses in the private ranges (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10). A certificate for anything else is refused by browsers even though the chain leads to an installed authority. So a copy of the state folder lets someone pose as the hub, and as nothing else.
- `cert.pem` (key in `key.pem`), the server's certificate followed by the issuer's. It is re-issued when the machine's addresses change or it nears its end, and devices keep trusting it because the authority stays the same. A name the issuer may not vouch for (a public address, say) is left out of it and reported at start-up.

`hubd --new-authority` makes a fresh authority (for a further name given with `--allow-host`, or to retire the old one); every device then installs the new one. State folders from before this layout held an authority with no constraints and kept its key (`ca-key.pem`): the first start replaces it, deletes that key, and says to remove the old authority, "Hub local authority", from every device that has it. A request sent in plain HTTP to the HTTPS port from another machine is answered in plain text with a redirect: `/` goes to `/trust`, everything else to the same address over `https://`. From the machine itself (127.0.0.1) plain HTTP is served as it is: that connection never leaves the machine, and browsers treat `http://localhost` as secure, so the hub's own computer needs no authority installed.

| Request (no pairing needed) | Answer |
|---|---|
| `GET /hub-ca.crt` | the authority's certificate, to install on a device |
| `GET /trust` | a page with the steps for each kind of device |
| `GET /api/trust` | `{ "fingerprint": "AA:BB:…", "encrypted": true }` |

**3. No other website.** A request with an `Origin` that is not this server, or with `Sec-Fetch-Site` other than `same-origin` or `none`, gets 403 `requests from other sites are not allowed`. This covers reading as well as writing. The page and its scripts are exempt (they hold nothing private).

The one exception is a reader that was loaded from another hub and is paired with this one. Such a request is let through when it carries `Authorization: Bearer <id>.<token>`, the token this hub gave that device; a cookie counts for nothing on it, and neither does coming from this machine, because a browser would attach those for any website. `POST /api/pair` is let through as well (the code is the proof), and so is the browser's preflight: `OPTIONS` with `Access-Control-Request-Method` is answered 204 with `Access-Control-Allow-Methods: GET, POST, PUT, DELETE` and `Access-Control-Allow-Headers: Authorization, Content-Type, Range`. Answers to such requests carry `Access-Control-Allow-Origin: <that origin>` and `Vary: Origin`. The `Origin` must be a plain `http(s)://host[:port]`.

**4. Paired devices only.** Everything except the page, its scripts, the three trust routes and `POST /api/pair` needs the token of a paired device, sent as the cookie `hub_device_<port>=<id>.<token>` (`HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS). The port is in the name because a browser keeps cookies by host name whatever the port: two hubs on one machine would take each other's cookie, and a plain-HTTP one cannot replace a `Secure` cookie of the same name. The name from before, `hub_device`, is still read when the new one is absent, so a device paired then stays paired; it gets the new name when its cookie is next renewed. A reader loaded from another hub sends the same token as `Authorization: Bearer <id>.<token>` instead (see 3); when it pairs, the answer to `POST /api/pair` carries `"token": "<id>.<token>"` in its body and no cookie. Without a token: 401 `pairing required`. The server stores only a SHA-256 hash of each token, in `devices.json` in the state folder. Requests from this machine itself (127.0.0.1) count as the device `local` and need no token, unless the server was started with `--pair-local` (`HUB_PAIR_LOCAL=1`).

| Request | Answer |
|---|---|
| `POST /api/pair` `{ "code", "name" }` | `{ "device": { "id", "name" } }` and the cookie. 400 without a code; 403 `wrong or expired pairing code`. A code works once, for ten minutes; five wrong tries withdraw it |
| `GET /api/session` | `{ "device": { "id", "name" }, "local": false, "tls": true }` |
| `POST /api/pair/code` | `{ "code": "ABCD-EFGH", "minutes": 10 }`: a code for the next device |
| `GET /api/devices` | `[{ "id", "name", "created", "seen", "current" }]` |
| `DELETE /api/devices/<id>` | `{ "ok": true }`; that device is locked out at once. 404 for an unknown id |
| `GET /api/storage` | `{ "used", "quota", "free" }` in bytes (`quota` 0: no limit) |

With no device paired yet and the server reachable from the network (or `--pair-local`), a first code is printed on the terminal at start-up.

**5. What a browser may do with each answer.** Every answer carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`, and a `Content-Security-Policy`:

The page's own files (the page, its scripts, the manifest and icons) carry an `ETag` and `Cache-Control: no-cache`: a browser may keep them, and a request with `If-None-Match` for a file that has not changed is answered `304` with no body and the same headers. Everything else is `Cache-Control: no-store`.

- the page: scripts from this server only and none inline; pictures, media, styles and fonts from this server only; connections to this server and to the hubs listed in `/api/hubs`, nothing else; cannot be framed. So a document cannot make the reader run code, and reading never contacts the internet.
- `/raw/…`: `sandbox allow-same-origin` and no script source at all, so a saved HTML page or an SVG never runs code, whether shown in the reader's frame or opened in a tab of its own; pictures, styles and fonts from this server only. (PDFs are sent without it: a browser's PDF viewer does not start in a sandbox.)
- everything else: `default-src 'none'; sandbox`.

**6. Storage.** Uploads and new notes are refused with 507 `storage is full` when the folder would pass its quota (`--quota-mb`, `HUB_QUOTA_MB`; default by profile, 20 GB on a computer) or the disk would be left with under 16 MB.

**7. Small protections.** `/raw/` and `/api/doc` refuse hidden names (404), as the list leaves them out. Uploads, folder removal and front-page writes are refused inside the page's own folder when that lies within the folder being served. A notes or settings file that exists but does not parse is never overwritten: requests that would write it get 500 `… is damaged and was left as it is`. The pairing cookie is sent again, with a fresh year, on the first request of each day. A hub address may contain only letters, digits, dots, hyphens, colons and brackets.

## Limits the C++ server enforces

- 16 KB of request headers (431 beyond that), which must arrive within 15 seconds in all
- 1 MB for JSON bodies (both servers), and the profile's upload limit for uploads (413), decided from `Content-Length` before the body is read
- `Content-Length` only; chunked request bodies are refused (400)
- a body gets 30 seconds plus its size at 32 KB a second; an answer gets 30 seconds plus its size at 8 KB a second
- a fixed number of connections at once (64 on a computer, 4 on the ESP32); the rest are turned away. An idle connection is kept for its next request for 5 seconds (2 on the ESP32)
- files are sent and received a piece at a time, never held whole in memory
- an error in one connection ends that connection only
- listens on `127.0.0.1` unless started with `--host 0.0.0.0`
