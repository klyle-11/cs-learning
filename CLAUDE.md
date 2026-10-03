# cs-learning — working instructions

A self-directed CS learning environment. The user works in small steps, irregularly. Depth over speed; explain the why.

## Layout

- `FRONTPAGE.md` — landing page of the reader; its `# Heading` is the title, the rest the description. The user's to edit.
- `docs/`, `c-lessons-project/`, `discrete-math/sources/`, root `.md` files — the material being read. Do not edit `discrete-math/sources/`.
- `notes/notes.json` — the user's notes, written from the reader UI. A separate layer from the documents.
- `responses/` — docs Claude writes in answer to the notes.
- `references.md` — log of everything cited (books, sites, videos, courses) with links.
- `hub/` — the reader (see `hub/README.md`). Run with `cd hub && npm start`, then http://localhost:4321.

## Notes

Each entry in `notes/notes.json`:

```json
{ "id": "...", "doc": "discrete-math/sources/1-functions-and-proofs.md", "heading": "slug", "headingText": "4.1 Injective",
  "quote": "text span the note is pinned to, may be empty", "type": "highlight type id from hub.json, may be empty",
  "text": "what the user wrote, empty for a bare highlight", "ts": "ISO time", "status": "open" }
```

`status` is `highlight` for a highlight with no note (nothing to answer — but its type name, e.g. "Unclear" or "Question", says how the user read that passage and is useful context), `open` for a note awaiting a reply, `answered` once replied to. Type names and colours are in `hub.json` under `highlights`.

## When the user asks to assess / answer the notes

1. Read `notes/notes.json`; take the entries with `"status": "open"`. Read the surrounding section for each (use `doc` + `heading` + `quote`).
2. Group related notes. For each group write or extend a doc in `responses/` (`NN-short-topic.md`, starting with a `# Title`). It should:
   - supply the background that would let the user answer their own question,
   - say plainly where an observation is right and reinforce it, and where it is off and why,
   - show the code parallel where one genuinely exists (C for systems topics, C++ for discrete maths),
   - link back to the section: `[4.1 Injective](../discrete-math/sources/1-functions-and-proofs.md#4-1-injective-one-to-one)` (heading slugs are lowercase, non-alphanumerics → `-`).
3. On each note set `"status": "answered"`, `"reply"` (2–4 sentence direct answer, markdown), `"replyDoc"` (`responses/NN-topic.md#heading-slug`), `"replyTs"`. Never change the user's `text` or `quote`.
4. Add anything cited to `references.md`. Check a link resolves before logging it; do not write URLs from memory.

The reader live-reloads, so replies appear under the notes as the files are saved.

## Questions asked in the terminal

When the user asks a concept question in a session here, also append it to `notes/notes.json` as an answered note (their question as `text`, the answer as `reply`, `doc` set to the document it relates to) so the reader keeps the full log.
