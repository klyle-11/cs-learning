# Hub HTTP API

The contract between the page (`hub/index.html`) and whichever server is behind it. Two servers implement it: `hub/server.js` (Node) and `server-cpp/hubd` (C++). `test/contract.sh` sends the same requests to both and compares the answers. The page, its scripts and the trust routes are public; everything else needs a paired device (see Security).

All JSON bodies are UTF-8. Errors are `{ "error": "message" }` with a 4xx or 5xx status. Paths are relative to the folder being served, use `/`, and may never contain `..`.

## Pages and files

| Request | Answer |
|---|---|
| `GET /` | `index.html` |
| `GET /app.js`, `/local.js`, `/vault.js` | the page's own scripts |
| `GET /sw.js`, `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png` | the service worker, manifest and icons: they let the page be installed and opened without the server |
| `GET /vendor/marked.js`, `/vendor/highlight.js`, `/vendor/purify.js` | the three libraries the page loads |
| `GET /raw/<path>` | the file as it is on disk, with a content type from its extension. 404 if missing |
| `GET /api/doc?path=<path>` | the text of a markdown, HTML or source file. 404 if missing or not a readable type |

## Listing

`GET /api/docs` → array, in display order (folders walked in natural name order):

```json
{ "path": "a/1-doc.md", "group": "a", "title": "First", "side": false, "front": false }
```

`title` is the first `# Heading` (markdown), `<title>` (HTML), or the file name. Hidden files, `node_modules`, `notes/`, the server's own folder and anything matching `ignore` are left out.

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
| `GET /api/notes` | all notes. 500 if `notes.json` exists but cannot be read (C++ server; see below) |
| `POST /api/notes` | body needs `doc` and one of `text`, `quote`. Returns the new note. `status` is `open` with text, `highlight` without |
| `PUT /api/notes/<id>` | updates any of `text`, `quote`, `heading`, `headingText`, `type`; other keys are ignored. A highlight that gains text becomes `open`. 404 for an unknown id |
| `DELETE /api/notes/<id>` | `{ "ok": true }`, or 404 |

If `notes.json` (or `hub.json`, for `PUT /api/config` and `DELETE /api/folder`) exists but cannot be read or parsed, the C++ server changes nothing and answers 500 `… could not be read, so nothing was changed; it is left as it is`, rather than treating it as empty and writing a list with only the new change. On the board a save cut short by a power cut is put right at the next start. The Node server still treats such a file as empty.

## Uploads and workspaces

`POST /api/upload?path=<path>` with the file as the raw body → `{ "saved": true, "root": "…" }`, or `{ "skipped": true }` if the file already exists (never overwritten). 400 for a path with `..`, a hidden part or `node_modules`. 413 over 50 MB.

`GET /api/workspaces` → `[{ "name", "root", "home", "current" }]`.

Node only, for now: `POST /api/upload?...&workspace=<name>` (upload into a workspace of its own) and `POST /api/workspace { "root" }` (switch). The C++ server answers 501 to the first and always reports one workspace.

## Live reload

`GET /api/events` is a server-sent event stream. Each change to a file in the folder sends:

```
data: {"file":"relative/path.md"}
```

Node uses the operating system's file-change notifications. The C++ server on a computer looks the folder over at an interval set by the device profile and compares modification times and sizes, because there is no portable notification API (and the ESP32 has none). On the board nothing but the server writes to the card, so it does not look at all: it sends each change as it makes it, the moment it is saved.

## Device profile (C++ server only)

`GET /api/device` → what the server detected and the limits it chose:

```json
{ "profile": "desktop", "cores": 8, "memoryMB": 8192, "maxUploadMB": 200,
  "watchMs": 500, "cacheAssets": true, "cacheListing": true }
```

On the board it also reports memory in bytes: `heapFree` now, `heapLeast` (the lowest since start-up) and `heapLargest` (the largest single block, which is what a large allocation can get).

| Profile | Chosen when | Upload limit | Changes found by | Document list kept | Quota | Page and scripts kept in memory |
|---|---|---|---|---|---|---|
| `desktop` | 1 GB of memory or more | 200 MB | looking the folder over every 0.5 s | in memory | 20 GB | yes |
| `small` | under 1 GB (Raspberry Pi Zero class) | 50 MB | looking it over every 1 s | in memory | 8 GB | yes |
| `esp32` | built with ESP-IDF | 4 MB | the server's own writes (nothing else writes to the card) | in a file on the card, `.hub-cache/` | none: the card's free space, less 16 MB | no |

All three keep the document list until something listed changes, and keep a running count of what the folder holds rather than measuring it for each request (see Storage). On the board the list is written out as it is made, never held whole in memory, and sorting a folder's names may use 32 KB: a larger folder is read again as many times as needed, each pass listing the next run of names in order. `--profile <name>` forces one, which is how the ESP32 limits are tried on a computer; `--profile esp32` then also assumes nothing else changes the folder while the server runs.

## Security

Both servers apply the same rules, in this order, to every request.

**1. Known host names only.** The `Host` header must name this machine: `localhost`, `127.0.0.1`, `hub.local`, the machine's own name and addresses, or a name added with `--allow-host` (`HUB_HOSTS` in Node). Anything else gets 403 `unknown host name`. This is what defeats DNS rebinding, where a website points its own name at the hub's address.

**2. Encrypted beyond this machine.** Listening on anything but `127.0.0.1` turns HTTPS on. The hub is its own certificate authority: `hubd --make-cert` (or the first start with `--host 0.0.0.0`) writes its certificates to the state folder (`--state`, `HUB_STATE`, default `~/.config/hub`; never inside the served folder). There are three, in a chain:

- `ca.pem`, the authority each device installs once. Its private key signs one thing, the issuer, and is never written to disk.
- `issuer.pem` (key in `issuer-key.pem`), which signs the server's certificates. Both it and the authority carry *name constraints*, marked critical: they may vouch only for names under `.local`, `localhost`, the machine's own host names as they were when the authority was made (`issuer.zones`), and addresses in the private ranges (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10). A certificate for anything else is refused by browsers even though the chain leads to an installed authority. So a copy of the state folder lets someone pose as the hub, and as nothing else.
- `cert.pem` (key in `key.pem`), the server's certificate followed by the issuer's. It is re-issued when the machine's addresses change or it nears its end, and devices keep trusting it because the authority stays the same. A name the issuer may not vouch for (a public address, say) is left out of it and reported at start-up.

`hubd --new-authority` makes a fresh authority (for a further name given with `--allow-host`, or to retire the old one); every device then installs the new one. State folders from before this layout held an authority with no constraints and kept its key (`ca-key.pem`): the first start replaces it, deletes that key, and says to remove the old authority, "Hub local authority", from every device that has it. A request sent in plain HTTP to the HTTPS port is answered in plain text with a redirect: `/` goes to `/trust`, everything else to the same address over `https://`.

| Request (no pairing needed) | Answer |
|---|---|
| `GET /hub-ca.crt` | the authority's certificate, to install on a device |
| `GET /trust` | a page with the steps for each kind of device |
| `GET /api/trust` | `{ "fingerprint": "AA:BB:…", "encrypted": true }` |

**3. No other website.** A request with an `Origin` that is not this server, or with `Sec-Fetch-Site` other than `same-origin` or `none`, gets 403 `requests from other sites are not allowed`. This covers reading as well as writing. The page and its scripts are exempt (they hold nothing private).

The one exception is a reader that was loaded from another hub and is paired with this one. Such a request is let through when it carries `Authorization: Bearer <id>.<token>`, the token this hub gave that device; a cookie counts for nothing on it, and neither does coming from this machine, because a browser would attach those for any website. `POST /api/pair` is let through as well (the code is the proof), and so is the browser's preflight: `OPTIONS` with `Access-Control-Request-Method` is answered 204 with `Access-Control-Allow-Methods: GET, POST, PUT, DELETE` and `Access-Control-Allow-Headers: Authorization, Content-Type, Range`. Answers to such requests carry `Access-Control-Allow-Origin: <that origin>` and `Vary: Origin`. The `Origin` must be a plain `http(s)://host[:port]`.

**4. Paired devices only.** Everything except the page, its scripts, the three trust routes and `POST /api/pair` needs the token of a paired device, sent as the cookie `hub_device=<id>.<token>` (`HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS). A reader loaded from another hub sends the same token as `Authorization: Bearer <id>.<token>` instead (see 3); when it pairs, the answer to `POST /api/pair` carries `"token": "<id>.<token>"` in its body and no cookie. Without a token: 401 `pairing required`. The server stores only a SHA-256 hash of each token, in `devices.json` in the state folder. Requests from this machine itself (127.0.0.1) count as the device `local` and need no token, unless the server was started with `--pair-local` (`HUB_PAIR_LOCAL=1`).

| Request | Answer |
|---|---|
| `POST /api/pair` `{ "code", "name" }` | `{ "device": { "id", "name" } }` and the cookie. 400 without a code; 403 `wrong or expired pairing code`. A code works once, for ten minutes; five wrong tries withdraw it |
| `GET /api/session` | `{ "device": { "id", "name" }, "local": false, "tls": true }` |
| `POST /api/pair/code` | `{ "code": "ABCD-EFGH", "minutes": 10 }`: a code for the next device |
| `GET /api/devices` | `[{ "id", "name", "created", "seen", "current" }]` |
| `DELETE /api/devices/<id>` | `{ "ok": true }`; that device is locked out at once. 404 for an unknown id |
| `GET /api/storage` | `{ "used", "quota", "free" }` in bytes (`quota` 0: no limit; `free` is what the disk has free, 0 if unknown) |

With no device paired yet and the server reachable from the network (or `--pair-local`), a first code is printed on the terminal at start-up.

**5. What a browser may do with each answer.** Every answer carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`, and a `Content-Security-Policy`:

- the page: scripts from this server only and none inline; pictures, media, styles and fonts from this server only; connections to this server and to the hubs listed in `/api/hubs`, nothing else; cannot be framed. So a document cannot make the reader run code, and reading never contacts the internet.
- `/raw/…`: `sandbox allow-same-origin` and no script source at all, so a saved HTML page or an SVG never runs code, whether shown in the reader's frame or opened in a tab of its own; pictures, styles and fonts from this server only. (PDFs are sent without it: a browser's PDF viewer does not start in a sandbox.)
- everything else: `default-src 'none'; sandbox`.

**6. Storage.** Uploads and new notes are refused with 507 `storage is full` when the folder would pass its quota (`--quota-mb`, `HUB_QUOTA_MB`; default by profile: 20 GB on a computer, none on the board) or the disk would be left with under 16 MB. On the board the disk is the card, and its free space comes from FatFS's own count.

The C++ server measures the folder once and then keeps count as it writes (uploads, notes, settings, removed folders). On the board that count stays exact, because nothing else writes to the card. On a computer, where other programs do, the count is refreshed by every look over the folder (the change watcher, the document list) and redone when older than 3 seconds.

## Limits the C++ server enforces

- 16 KB of request headers (431 beyond that), which must arrive within 15 seconds in all
- 1 MB for JSON bodies (both servers), and the profile's upload limit for uploads (413), decided from `Content-Length` before the body is read
- `Content-Length` only; chunked request bodies are refused (400), and so is a length larger than the machine can count (413; on the board sizes are 32 bits)
- a body gets 30 seconds plus its size at 32 KB a second; an answer gets 30 seconds plus its size at 8 KB a second
- a fixed number of connections at once (64 on a computer, 4 on the ESP32); the rest wait unaccepted until a place frees up, and on the ESP32 also until there is memory for one more (48 KB free, a 20 KB block; one connection is always let in). An idle connection is kept for its next request for 5 seconds (2 on the ESP32)
- open pages listening for changes: 16 on a computer, 6 on the ESP32 (503 beyond, or when memory is short); one that has closed frees its place at once
- files are sent and received a piece at a time, never held whole in memory; on the board files of 2 to 4 GB (the most FAT32 holds) are read through FatFS, past the 2 GB limit of the board's `off_t`
- an error in one connection ends that connection only
- listens on `127.0.0.1` unless started with `--host 0.0.0.0`
