# Hub — to do

## Next phase: highlight and annotate, Hypothesis-style

**Formats**
- [ ] EPUB reader (there is already `cs-learning.epub` in the root to develop against)
- [ ] PDF reader for PDFs with a real text layer (not scans)
- [ ] Markdown and HTML keep working as now

**Highlighting**
- [ ] Select text → a tiny flyout menu appears at the selection: highlight / annotate
- [ ] Choose a highlight colour in the flyout; the choice sticks until changed
- [ ] Highlight types: each type has its own colour and a name the user can set (e.g. "definition", "question", "don't understand yet")
- [ ] Highlights are saved and persist across sessions, in every format

**Annotating**
- [ ] The existing bottom text input stays where it is and is also the annotation input
- [ ] When text is selected or an existing highlight is active, an indicator in or above the input shows which highlight is being annotated
- [ ] A highlight can exist with no annotation; an annotation can be added to it later

**Mobile**
- [ ] Input sits in the lower quarter of the screen
- [ ] Sidebar, notes panel and split panes need a small-screen layout (the current layout is desktop-only)

**Front page**
- [ ] Recent list: latest highlights and annotations, each showing its document and section, linking to the spot

**Open questions**
- How to anchor a highlight in EPUB and PDF so it survives re-opening (today's notes anchor by quoted text plus heading, which only suits markdown)
- Whether today's `notes/notes.json` entries become one kind of highlight, or stay separate

## Project structure

- [ ] Decide whether the hub becomes its own code project (own branch or repo), using this repo's markdown files and folders as example content to develop with
- [ ] Possible front-end rewrite in Preact with no build step, keeping the small Node server for file access and live reload

## Carried over from the first brainstorm

- [ ] Notes can be deleted but not edited
- [ ] Notes pinned inside HTML documents are saved but not highlighted in the page
- [ ] Concept map as a home view
- [ ] Interactive visualisations (function arrow diagrams, pigeonhole, truth tables), proof stepper
- [ ] Maths ↔ code side by side per concept
