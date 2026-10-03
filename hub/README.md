# hub — a markdown reader with a notes layer

Reads any folder of `.md` files, however deeply nested. `.html` files are rendered as they are, in a frame. Source files (`.c`, `.h`, `.cpp`, `.py`, … and `Makefile`) are listed too and shown as code. Nothing in here is specific to one topic.

```
cd hub && npm install && npm start        # http://localhost:4321, reads the folder containing hub/
node hub/server.js path/to/other/folder   # or point it somewhere else
PORT=4400 npm start                       # run two environments at once
```

## Using it

- **Files** (left): the folder tree. A single click opens a file in place of the one you were previewing (its tab title is in italics). A double click opens it as a tab that stays, so both are open. Double-clicking a tab also keeps it.
- **Second document**: the "side" button on a file row (or Cmd/Ctrl/Alt-click), or "open on right" in the tab bar, opens a document in the right-hand column, which it shares with the notes. Drag the column's left edge for width and the bar between document and notes for height; "move notes above/below" swaps them. Closing its last tab gives the column back to the notes. Closing everything returns to the front page. The layout is remembered.
- **Reading aids**: "hide sidebar" tucks the sidebar away (hover or click the strip on the left edge to bring it back); "reading focus" fades everything except the paragraph under the pointer or at the reading line; "roomy text" widens line, word and paragraph spacing; A−/A+ change the text size. A thin bar under the tabs shows how far through the document you are. Keyboard focus always has a thick outline, and file rows and tabs work with Tab and Enter.
- **Upload a folder**: "upload a folder…" in the sidebar picks a folder from your computer and asks where it goes. *Add to this workspace* copies it in as a new folder beside the others; files that already exist are left alone, never overwritten. *Open as its own workspace* copies it to `hub/workspaces/<name>/` and switches the hub to it, with its own notes, title and tabs. Nothing is deleted: the workspace menu that appears above the file list switches back. Dot-files, `node_modules` and files over 50 MB are left out.
- **On a phone** (screens under 760px): one document at a time. "☰ Files" and "Notes" in the top bar slide the sidebar and the notes in over the page; tap outside to close. The "+" on a file row opens it as an extra tab beside what is already open. The note box stays at the bottom at the height you leave it; drag the small handle above it to resize, or press the handle to switch between small and about a quarter of the screen. Selecting text shows the highlight menu just below the selection.
- **Contents dial**: whenever the sidebar is hidden (always on a phone), a small icon sits at the top right of the page. It opens a short scrolling list of the document's headings in tiny text; the one at the centre is selected and drawn large. Scroll to turn the dial, tap the selected heading to jump to it, or tap another heading to bring it to the centre. Tap the icon, outside the list, or press Escape to close.
- **HTML pages** open in a frame, looking as their author made them. Headings feed the outline and the contents dial, and selecting text gives the same highlight menu and notes as markdown, with highlights drawn in the page. A page's own scripts are off until you press "scripts: off" in the tab bar for that file (remembered per file); turn them on only for pages you trust, since a script can use the hub's API.
- **Theme and font**: the menu and button under the title. Themes are Plain, Selenized Light, Pale Lime, Pale Sky, Eva Dark and Triple-M; each is a block of colour tokens at the top of `index.html`.
- **Outline** (left, below the files): headings of the document that has focus; click to jump.
- **Highlighting**: select text and a small menu appears. Click a colour to highlight (that colour stays in use until you pick another), or "note" to highlight and write about it. Click an existing highlight to change its type, annotate it or remove it.
- **Notes** (right) and the box along the bottom belong to the document that has focus. While a highlight is selected, the line above the box shows which one you are annotating. The legend at the top of the notes panel renames and recolours the highlight types.

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
- `highlights` — the highlight types, each `{ "id", "name", "color" }`. Managed from the legend above the notes; four defaults are used until changed.
- `side` — files, or folders ending in `/`, that open in the second pane when linked to.
- `ignore` — file names, paths, or folders ending in `/`, left out of the reader.

### Markdown files

- The first `# Heading` is the document's title in the picker.
- `#`, `##`, `###` headings make up the table of contents.
- Links to other files in the folder (relative paths, optional `#heading-slug`) open inside the hub as a tab; files listed under `side` open in the other pane. Relative image paths work. A heading's slug is its text lowercased with each run of non-letters/digits replaced by `-`.
- Fenced code is coloured by the language on the fence (` ```c `, ` ```cpp `, ` ```python `, …); a fence with no language stays plain. Source files are coloured by their extension.
- A blockquote containing a paragraph that starts with bold `**Answer…**` hides everything from that paragraph on behind "Show answer".

### Notes

`notes/notes.json` is an array of:

```json
{ "id": "…", "doc": "sources/file.md", "heading": "slug", "headingText": "Heading",
  "quote": "pinned text span or empty", "type": "highlight type id or empty", "text": "the note, empty for a bare highlight",
  "ts": "ISO time", "status": "highlight | open | answered",
  "reply": "markdown, optional", "replyDoc": "responses/file.md#slug, optional" }
```
