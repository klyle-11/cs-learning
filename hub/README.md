# hub — a markdown reader with a notes layer

Reads any folder of `.md` files, however deeply nested. `.html` files are rendered as they are, in a frame. Source files (`.c`, `.h`, `.cpp`, `.py`, … and `Makefile`) are listed too and shown as code. Nothing in here is specific to one topic.

```
cd hub && npm install && npm start        # http://localhost:4321, reads ../data
node hub/server.js path/to/other/folder   # or point it somewhere else
PORT=4400 npm start                       # run two environments at once
HOST=0.0.0.0 npm start                    # reachable from a phone: HTTPS and pairing, see below
```

The server answers this computer only unless started with `HOST=0.0.0.0`. Then it speaks HTTPS (make the certificate once with `server-cpp/hubd --make-cert`), prints a pairing code, and each device goes through two steps once: trust the hub's certificate (open `http://<address>:4321/` on the device and follow the page), then type the pairing code. `server-cpp/API.md`, "Security", has the details.

`../data` is the live workspace and is not in git. The first run creates it as a copy of `../sample`, the starter content that is. Delete `data/` to start again from the samples.

## Using it

- **Files** (left): the folder tree. Folders start closed; the ones you open stay open. A single click opens a file in place of the one you were previewing (its tab title is in italics). A double click opens it as a tab that stays, so both are open. Double-clicking a tab also keeps it.
- **Back**: the ‹ at the start of a pane's tab bar (or Alt + ←) returns that pane to what it showed before: the gallery after a picture, the page a link was followed from, the tab you switched away from. It is remembered for the current visit only. With nothing left to return to, it goes up a level at a time: the front page of the folder the document is in, then the folder above, ending at the main front page.
- **Second document**: the "side" button on a file row (or Cmd/Ctrl/Alt-click), or "open on right" in the tab bar, opens a document in the right-hand column, which it shares with the notes. Drag the column's left edge for width and the bar between document and notes for height; "move notes above/below" swaps them. Closing its last tab gives the column back to the notes. Closing everything returns to the front page. The layout is remembered.
- **Reading aids**: "hide sidebar" tucks the sidebar away (hover or click the strip on the left edge to bring it back); "reading focus" fades everything except the paragraph under the pointer or at the reading line; "roomy text" widens line, word and paragraph spacing; A−/A+ change the text size. A thin bar under the tabs shows how far through the document you are. Keyboard focus always has a thick outline, and file rows and tabs work with Tab and Enter.
- **Upload a folder**: "upload a folder…" in the sidebar picks a folder from your computer and asks where it goes. *Add to this workspace* copies it in as a new folder beside the others; files that already exist are left alone, never overwritten. *Open as its own workspace* copies it to `hub/workspaces/<name>/` and switches the hub to it, with its own notes, title and tabs. Nothing is deleted: the workspace menu that appears above the file list switches back. Dot-files, `node_modules` and files over 50 MB are left out.
- **On a phone** (screens under 760px): one document at a time. "☰ Files" and "Notes" in the top bar slide the sidebar and the notes in over the page; tap outside to close. The "+" on a file row opens it as an extra tab beside what is already open. The note box stays at the bottom at the height you leave it; drag the small handle above it to resize, or press the handle to switch between small and about a quarter of the screen. Selecting text shows the highlight menu just below the selection.
- **Contents dial**: whenever the sidebar is hidden (always on a phone), a small icon sits at the top right of the page. It opens a short scrolling list of the document's headings in tiny text; the one at the centre is selected and drawn large. Scroll to turn the dial, tap the selected heading to jump to it, or tap another heading to bring it to the centre. Tap the icon, outside the list, or press Escape to close.
- **HTML pages** open in a frame, looking as their author made them. Headings feed the outline and the contents dial, and selecting text gives the same highlight menu and notes as markdown, with highlights drawn in the page. A page's own scripts never run, in the reader or when the file is opened in a tab of its own, and it cannot load anything from the internet.
- **Pictures and video** appear in the file list and open in a viewer. A picture fits the pane; click it, or press "full size", to see it at its real size, and "open in new tab" hands it to the browser. A picture inside a document opens in the viewer when clicked.
- **Music**: any sound file opens the player, whose playlist is every sound file in the folder grouped by where it lives. "previous" restarts the track, and goes to the one before if pressed again; music keeps playing while you read. **Queue**: the queue button on a sound or video row (in the player, the file list, a front page listing, or the video viewer's bar) lines it up; the queue is listed under the player's controls, where a row can be played or taken out. Next and previous step through the queue, or through every sound file while it is empty. Shuffle puts the queue in a random order (queueing every track first if it is empty). The repeat button cycles: repeat the queue (the default), repeat this song, no repeat. A queued video plays in the pane if a video is on show there, and otherwise in the background, sound only. A video that is playing also carries on (sound only) when you open something else, and is still playing when you come back to it. Either way the small controls sit in the sidebar: back and forward ten seconds, play/pause, and a link back to what is playing. On a phone, volume is the device's own.
- **Without the server**: the box at the top of the sidebar says whether the server is in reach. Documents you open are copied to this device (● in the file list; ○ means server only; press the mark to keep or remove a copy; in the settings, "keep all documents" copies the text and HTML pages "keep all music files" the music and "keep all pictures and videos" those, each separately; a picture or video also has a keep button in its viewer's bar and on its gallery tile). If the server goes away you can keep reading those, and notes and highlights you make wait in a queue and are sent when it returns. "add files…" (or dragging files onto the sidebar) puts files in `inbox/`; added while disconnected, they show ↑ until sent. The page must already be open: starting it with the server off needs HTTPS and is not built yet.
- **Privacy box** (sidebar): how this device is connected (this computer only, encrypted, or not), which paired device the server takes it for ("devices…" lists them, removes them, and makes a code to add another), and whether the copies kept in this browser are encrypted. "protect…" encrypts them with a passphrase: it is asked for each time the reader opens, the reader locks itself after ten minutes in the background, and a forgotten passphrase means the copies here are removed and fetched again (only unsent changes would be lost). Needs HTTPS or localhost.
- **Changes the server refuses** are not dropped quietly: one it may accept later (storage full, not paired) stays in the queue and is retried; one it never will is listed in the status box until dismissed.
- **Problems** appear bottom right as a plain sentence, with the technical details folded underneath.
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

Optional. The one at the top of the workspace is shown when the hub opens and whenever you close the last document. Its first `# Heading` is the title in the sidebar and browser tab (renaming the title in the sidebar rewrites that line); everything after it is the description.

Any folder can have its own `FRONTPAGE.md` as well. It appears first in that folder in the file list, as "Front page". Uploading a folder offers to use the one it has, copy one of its markdown files, or make a new one.

Under the description, every front page shows a row of tiles (Everything, Documents, Pictures and video, Music) counting what is in that folder; pressing one lists it. Lists show everything together with each item's folder beside it; "group by folder" splits them up.

All front pages are editable in the reader with "edit front page". They are the only documents the reader writes.

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
