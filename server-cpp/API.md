# Hub HTTP API

The contract between the page (`hub/index.html`) and whichever server is behind it. Two servers implement it: `hub/server.js` (Node) and `server-cpp/hubd` (C++). `test/contract.sh` sends the same requests to both and compares the answers.

All JSON bodies are UTF-8. Errors are `{ "error": "message" }` with a 4xx or 5xx status. Paths are relative to the folder being served, use `/`, and may never contain `..`.

## Pages and files

| Request | Answer |
|---|---|
| `GET /` | `index.html` |
| `GET /vendor/marked.js`, `GET /vendor/highlight.js` | the two libraries the page loads |
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
| `POST /api/notes` | body needs `doc` and one of `text`, `quote`. Returns the new note. `status` is `open` with text, `highlight` without |
| `PUT /api/notes/<id>` | updates any of `text`, `quote`, `heading`, `headingText`, `type`; other keys are ignored. A highlight that gains text becomes `open`. 404 for an unknown id |
| `DELETE /api/notes/<id>` | `{ "ok": true }`, or 404 |

## Uploads and workspaces

`POST /api/upload?path=<path>` with the file as the raw body → `{ "saved": true, "root": "…" }`, or `{ "skipped": true }` if the file already exists (never overwritten). 400 for a path with `..`, a hidden part or `node_modules`. 413 over 50 MB.

`GET /api/workspaces` → `[{ "name", "root", "home", "current" }]`.

Node only, for now: `POST /api/upload?...&workspace=<name>` (upload into a workspace of its own) and `POST /api/workspace { "root" }` (switch). The C++ server answers 501 to the first and always reports one workspace.

## Live reload

`GET /api/events` is a server-sent event stream. Each change to a file in the folder sends:

```
data: {"file":"relative/path.md"}
```

Node uses the operating system's file-change notifications; the C++ server compares modification times at an interval set by the device profile, because the ESP32 has no notification API.

## Device profile (C++ server only)

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

## Requests from other websites

Any request that is not a `GET` and carries an `Origin` header naming a different host than the one it was sent to is refused with 403, by both servers. This stops a page on another site, open in the same browser, from adding notes or uploading files here. Reading is not blocked this way: browsers already keep other sites from reading the answers.

## Limits the C++ server enforces

- 16 KB of request headers (431 beyond that)
- 1 MB for JSON bodies, and the profile's upload limit for uploads (413), decided from `Content-Length` before the body is read
- `Content-Length` only; chunked request bodies are refused (400)
- a connection that sends nothing for 15 seconds is dropped
- listens on `127.0.0.1` unless started with `--host 0.0.0.0`
