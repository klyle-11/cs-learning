# hub — a markdown reader with a notes layer

Reads any folder of `.md` files, however deeply nested. `.html` files are rendered as they are, in a frame. Source files (`.c`, `.h`, `.cpp`, `.py`, … and `Makefile`) are listed too and shown as code. Nothing in here is specific to one topic.

```
cd hub && npm install && npm start        # http://localhost:4321, reads the folder containing hub/
node hub/server.js path/to/other/folder   # or point it somewhere else
PORT=4400 npm start                       # run two environments at once
```

## Using it

- **Files** (left): the folder tree. Click a file to open it as a tab; the "side" button on a row (or Cmd/Ctrl/Alt-click) opens it in a second pane beside the first.
- **Tabs**: each pane has its own. "split" puts the current document in the other pane. Drag the bar between the panes to resize. Closing a pane's last tab closes the pane; closing everything returns to the front page. The layout is remembered.
- **Outline** (left, below the files): headings of the document that has focus; click to jump.
- **Notes** (right) and the box along the bottom belong to the document that has focus. Select text first to pin a note to it.

## Starting a new learning environment

1. Make a folder for the topic and copy `hub/` into it (skip `node_modules`, then `npm install`).
2. Copy `CLAUDE.md` and change its first paragraph to describe the new topic.
3. Write a `FRONTPAGE.md` (title and description) and add markdown files.

## Folder specification

```
<topic>/
  FRONTPAGE.md      landing page: its first `# Heading` is the title, the rest is the description
  hub.json          settings
  sources/          what you are reading — any folder names work
  responses/        write-ups Claude produces in answer to your notes
  references.md     log of everything cited
  notes/notes.json  your notes (written by the reader; don't hand-edit while it is open)
  CLAUDE.md         instructions for Claude in this folder
  hub/              this app
```

Only `FRONTPAGE.md`, `hub.json` and `notes/` are fixed names. Every markdown and source file under the folder is listed, grouped by its directory. Dot-folders, `node_modules`, `notes/` and `hub/` are skipped.

### FRONTPAGE.md

Optional. Shown when the hub opens and whenever you close a document. Editable in the reader with the "edit front page" button (the only file the reader writes besides notes). Its first `# Heading` is the title in the sidebar and browser tab (renaming the title in the sidebar rewrites that line); everything after it is the description. A list of every document, with note counts, is added underneath automatically.

### hub.json

```json
{
  "title": "Discrete Maths",
  "side": ["references.md", "responses/"],
  "ignore": ["CLAUDE.md"]
}
```

- `title` — shown in the sidebar and browser tab. Only used when there is no `FRONTPAGE.md`.
- `side` — files, or folders ending in `/`, that open in the second pane when linked to.
- `ignore` — file names, paths, or folders ending in `/`, left out of the reader.

### Markdown files

- The first `# Heading` is the document's title in the picker.
- `#`, `##`, `###` headings make up the table of contents.
- Links to other files in the folder (relative paths, optional `#heading-slug`) open inside the hub as a tab; files listed under `side` open in the other pane. Relative image paths work. A heading's slug is its text lowercased with each run of non-letters/digits replaced by `-`.
- A blockquote containing a paragraph that starts with bold `**Answer…**` hides everything from that paragraph on behind "Show answer".

### Notes

`notes/notes.json` is an array of:

```json
{ "id": "…", "doc": "sources/file.md", "heading": "slug", "headingText": "Heading",
  "quote": "pinned text span or empty", "text": "the note", "ts": "ISO time", "status": "open",
  "reply": "markdown, optional", "replyDoc": "responses/file.md#slug, optional" }
```
