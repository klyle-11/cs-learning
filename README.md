# Hub

A reader for a folder of documents (markdown, HTML, source code, pictures, video) with a layer of highlights and notes on top, a small server behind it, and a plan to run that server on an ESP32 with the documents on a microSD card.

```
hub/          the page (index.html) and the Node server
server-cpp/   the same server in C++ (API.md is the contract both follow)
sample/       starter content, tracked in git: example documents to develop against
data/         the live workspace: your notes, highlights, uploads and edits. Not in git
TODO.md       the plan
```

## Run it

```
cd hub && npm install && npm start      # http://localhost:4321, reading ../data
```

The first run creates `data/` as a copy of `sample/`. From then on everything you do in the reader lands in `data/` and stays out of git. To start again from the samples, delete `data/`.

The C++ server: `cd server-cpp && make && ./hubd ../data --port 4400`.

More: `hub/README.md` (using the reader, folder conventions), `server-cpp/API.md`, `sample/docs/08-server-migration/node-to-cpp-server.md`.
