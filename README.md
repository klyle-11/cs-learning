# Hub

A reader for a folder of documents (markdown, HTML, source code, pictures, video) with a layer of highlights and notes on top, a small server behind it, and a plan to run that server on an ESP32 with the documents on a microSD card.

```
hub/          the page (index.html and its scripts)
server-cpp/   the server, in C++ (API.md is the contract between it and the page)
start.sh      builds what is missing and starts the server on data/
sample/       starter content, tracked in git: example documents to develop against
data/         the live workspace: your notes, highlights, uploads and edits. Not in git
TODO.md       the plan
```

## Run it

```
./start.sh                  # or: cd hub && npm start.   http://localhost:4321, reading data/
```

The first run creates `data/` as a copy of `sample/`, fetches the page's three libraries with npm, and builds the server (it needs a C++ compiler and mbedTLS: `brew install mbedtls`). From then on everything you do in the reader lands in `data/` and stays out of git. To start again from the samples, delete `data/`.

The server is `server-cpp/hubd`, one program for a computer, a Raspberry Pi and the ESP32 board, with limits chosen to suit each. `./start.sh` runs it for you; to run it by hand: `server-cpp/hubd data --www hub`. For the board see `server-cpp/esp32/`.

It answers this computer only by default. To reach the reader from a phone: `HOST=0.0.0.0 ./start.sh`, then on the phone open `http://<this computer's address>:4321/`, follow the page to trust the hub's certificate, and type the pairing code the server printed. **Read `CERTIFICATES.md` first:** it says what installing that certificate means, and what the alternatives are. The computer the hub runs on never needs the certificate: `http://localhost:4321` keeps working there.

## What the reader does

- **Reads** markdown, HTML pages, source code, pictures, video and sound from a folder, with tabs, a second pane, an outline, and a back button.
- **Highlights and notes** on any text, kept in `data/notes/notes.json`.
- **Find**: file names as you type, then words inside documents and notes.
- **Reopens where you stopped** in each document.
- **Music beside reading**: pressing a track plays it without leaving the page; a queue with shuffle and repeat.
- **Works without the server**: the page opens at once from the copy kept on the device; documents, music, pictures and video can be kept; notes made meanwhile are sent later. One switch shows only what is on the device.
- **Folders** can be uploaded, removed, and locked behind a password.
- **Other hubs**: one reader can switch between hubs on several machines; what is kept from each sits side by side.
- **Private by default**: paired devices only, HTTPS beyond this computer, no document can run code or contact the internet, optional encryption of the device's copies.

## Working on it

```
cd server-cpp && make            # build the server (start.sh does this too)
cd server-cpp && make test       # 143 requests, answers compared with test/expected.txt
```

After changing `server-cpp/src/`, restart the server. After changing `hub/` (the page), reload the reader; it shows the copy it kept and offers "a newer version is ready" once it has fetched the change. There is no browser test suite in the repository yet; `REVIEW.md` says what was checked by hand.

More: `hub/README.md` (using the reader, folder conventions), `server-cpp/API.md` (the contract between page and server), `CERTIFICATES.md` (the certificate authority: what it is, per-device steps, checklists), `REVIEW.md` (security, efficiency and design findings, and their state), `TODO.md` (the plan), `sample/docs/08-server-migration/node-to-cpp-server.md`.
