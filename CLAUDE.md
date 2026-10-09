# cs-learning — working instructions

A self-directed CS learning environment. The user works in small steps, irregularly. Depth over speed; explain the why.

## Layout

- `hub/` — the reader page; `server-cpp/` — the server (C++, `hubd`); `start.sh` starts it. Code, tracked in git.
- `sample/` — starter content tracked in git (the C lessons, project guides, discrete-math sources and lessons). Example material to develop the reader against.
- `data/` — the **live workspace**, ignored by git. It starts as a copy of `sample/`. The user's notes, highlights, uploads and front-page edits are here, and this is what the reader shows. Paths below are relative to `data/`.
  - `FRONTPAGE.md` — landing page; its `# Heading` is the title. The user's to edit.
  - `notes/notes.json` — the user's notes and highlights, written from the reader.
  - `responses/` — docs Claude writes in answer to the notes.
  - `references.md` — log of everything cited, with links.
  - `discrete-math/sources/` — do not edit.
- Run with `cd hub && npm start` (or `./start.sh`), then http://localhost:4321. Both run `server-cpp/hubd`; there is no Node server any more.
- `marginalia-engine-integration/` — the document engine's packages and guides. The reader uses the npm one (`hub/node_modules/marginalia-engine`, served under `/vendor/marginalia/`) for selecting and highlighting on PDF pages; `INTEGRATION-FOR-AGENTS.md` there has the rules for working with it.
- `REVIEW.md` — findings and their state; `TODO.md` — the plan; `CERTIFICATES.md` — the hub's certificate authority; `server-cpp/API.md` — the contract between page and server. Keep these in step with the code when it changes.

## Working on the hub's code

- The server must keep building on macOS, Linux (Raspberry Pi) and Windows. Anything system-specific goes in `server-cpp/src/platform.hpp`, with both halves written; `WINDOWS.md` says what has been tried where. The Windows half builds and passes the tests (MSYS2 UCRT64): after touching it, build and test on Windows or say that it was not.
- Start scripts are in `hub/package.json`; each has a `:win` twin for Windows. Add both when adding one.
- Build: `cd server-cpp && make`. Test: `make test` (compares answers with `test/expected.txt`; after an intended change, read the differences, then `UPDATE=1 ./test/contract.sh`).
- The user's hub is usually running, and on Windows a running `hubd.exe` cannot be replaced: `make` then fails at the link, and `make test` would test the old program. Claude builds and tests its own copy instead, `server-cpp/build/hubd-own`: `npm run test:own:win` (`make test-own`; to record, `UPDATE=1` in front). Never stop the user's hub to build; tell them the server needs a restart to pick the change up.
- A server change needs the server restarted. A page change (`hub/`) shows one reload late: the reader opens from the copy it kept and then offers "a newer version is ready".
- Try things on a scratch copy, never on `data/`: `PORT=4396 HUB_STATE=<dir> ./start.sh data-test --workspaces <dir>`. Put scratch state under `server-cpp/build/` (ignored by git).
- The real state folder is `~/.config/hub` (certificates, paired devices). Do not make, replace or delete certificates there without being asked: every device that trusts the hub has to follow by hand.
- Any change to who may connect, what is served, or how certificates are made gets a line in `REVIEW.md` and, if it affects devices, in `CERTIFICATES.md`.

New learning material the user should keep goes in `data/` (so they see it) and, if it is meant as part of the starter set, in `sample/` too. Never commit anything from `data/`. For testing, work on a scratch copy (`data-test/`, also ignored), not on `data/`.

## Notes

Each entry in `notes/notes.json`:

```json
{ "id": "...", "doc": "discrete-math/sources/1-functions-and-proofs.md", "heading": "slug", "headingText": "4.1 Injective",
  "quote": "text span the note is pinned to, may be empty", "type": "highlight type id from hub.json, may be empty",
  "text": "what the user wrote, empty for a bare highlight", "ts": "ISO time", "status": "open" }
```

A highlight made in the reader may also carry `"anchor": { "block", "nth", "start", "before", "after" }`: where in the document its `quote` is (see `server-cpp/src/anchor.hpp`). Leave it as it is; a note written here (a terminal question) has none.

A highlight on a PDF's page carries `"mg": { "doc", "anchor" }` instead: the file's SHA-256 and the document engine's anchor (`marginalia-engine-integration/API.md`, "Anchor"). Its `headingText` is the page ("page 12") and its `heading` is empty. Leave `mg` exactly as it is: the engine finds the words by it.

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
