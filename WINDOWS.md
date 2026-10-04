# Running the hub on Windows (and on a Raspberry Pi)

The hub's server, `hubd`, was written on a Mac. This file is what was prepared so it can be built and run on Windows, what has and has not been tried, and what to check on the first build.

**Status, 3 October 2026: built and run on Windows 11** (MSYS2 UCRT64, gcc 16.1, mbedTLS 3.6.6). The Windows code was written on a Mac; on its first Windows build it compiled without changes and all 144 server checks pass. What did need fixing was around it: line endings (`.gitattributes`) and the test script. The checklist below records what was tried. Not yet tried: a second device connecting, and the Raspberry Pi.

## What was prepared

| Piece | What it is | Tried? |
|---|---|---|
| `server-cpp/src/platform.hpp` | Everything that differs between systems, in one file: sockets, folders, links, disk space, network addresses, the state folder. Each function has a POSIX half and a Windows half. | Both halves: yes |
| `server-cpp/Makefile` | A Windows branch: links the Windows network libraries, makes one self-contained `hubd.exe`, attaches a manifest so file names are UTF-8. | yes |
| `server-cpp/windows/` | That manifest. | yes |
| Path checks | On Windows, a path part is refused if it names a device (`CON`, `NUL`…), ends in a dot or space, or contains `:`. On every system, `notes` and `node_modules` are now matched whatever their letter case. | yes |
| Long names | Windows opens no path over 259 characters, the served folder included. An upload that would be longer is refused by name (400, "the name is too long for this system") and the rest of the folder carries on; before, the refusal was lost and the page reported the server as unreachable. | yes: built, and an upload of 17 files with one over-long name tried on a scratch folder. Contract tests pass |
| Anchors and books | `src/anchor.hpp`, `src/zip.hpp`, `src/epub.hpp`: standard C++ only, nothing system-specific. | Windows: built without warnings, 166 contract requests pass. Not yet built on macOS, Linux or for the board |
| `hub/start.mjs` | The launcher, in Node, so starting the hub is the same on every system. On Windows it finds the compiler in MSYS2. | yes |
| npm scripts ending `:win` | The same scripts, for Windows. | They refuse to run on a Mac, as intended |
| `server-cpp/test/contract.sh` | No longer uses a macOS-only form of `sed`. On Windows it compares paths in their Windows form (`C:/...`) and uses `python` when `python3` is only the Microsoft Store's placeholder. | On Windows: yes. Not re-run on macOS since |
| `.gitattributes` | Text files are checked out with LF endings on every system. Windows git would otherwise give the shell scripts, the Makefile and the recorded answers CR LF endings, which breaks them. | yes |

Not needed on Windows, and unchanged: the reader itself (`hub/`), which is a web page.

## Setting up a Windows machine

1. **Install [MSYS2](https://www.msys2.org/)** with its default location, `C:\msys64` (`winget install MSYS2.MSYS2` does that). It provides the compiler, `make` and `bash`. (Installed somewhere else: set the environment variable `MSYS2_ROOT` to that folder.)
2. **Open the "MSYS2 UCRT64" shell** from the Start menu and install the tools:
   ```
   pacman -S --needed make mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-mbedtls
   ```
   The encryption library there is version 3.6, which is what the server needs.
3. **Install [Node.js](https://nodejs.org/)** (the ordinary Windows installer) and git.
4. **Get the project** and, in PowerShell or the Windows terminal:
   ```
   cd cs-learning\hub
   npm install
   npm run start:win
   ```
   The first run builds `server-cpp\hubd.exe` and makes `data\` from `sample\`. Then open `http://localhost:4321`.

Windows will ask whether to allow `hubd.exe` through the firewall the first time it listens on the network (`npm run start:network:win`). Allow it for **private** networks only.

## The same commands on every system

From `hub/`. On Windows add `:win`; on macOS, Linux and Raspberry Pi OS use them as they are.

| macOS, Linux, Raspberry Pi | Windows | What it does |
|---|---|---|
| `npm start` | `npm run start:win` | This computer only |
| `npm run start:network` | `npm run start:network:win` | The network, over HTTPS, with pairing |
| `npm run start:network:insecure` | `npm run start:network:insecure:win` | The network without encryption |
| `npm run start:https-local` | `npm run start:https-local:win` | HTTPS even on this computer |
| `npm run start:pair-local` | `npm run start:pair-local:win` | This computer's own browser must pair too |
| `npm run start:scratch` | `npm run start:scratch:win` | The scratch workspace on port 4396 |
| `npm run cert` | `npm run cert:win` | Make or renew certificates, print the fingerprint |
| `npm run cert:new-authority` | `npm run cert:new-authority:win` | Replace the authority |
| `npm run build` | `npm run build:win` | Build the server |
| `npm test` | `npm run test:win` | The server's 144 checks |
| `npm run test:own` | `npm run test:own:win` | The same checks on a copy of the server built apart (`server-cpp/build/hubd-own`), for when the hub is running: Windows will not replace a running `hubd.exe`, so the ordinary build fails then |

The `:win` scripts do one extra thing: they put MSYS2's folders on the path for that run, so the build tools are found. Settings such as `PORT` are environment variables on every system; in PowerShell that is `$env:PORT = "4400"; npm run start:win`.

## First build: what to check, in order

Each line proves one piece. Stop at the first that fails; the error will point into `platform.hpp` or the Makefile.

- [x] `npm run build:win` produces `server-cpp\hubd.exe` with no errors. (Compiler errors here will be in the Windows half of `platform.hpp`: fix and repeat.)
- [x] `npm run start:win` prints the address and stays running. `http://localhost:4321` shows the reader. (Sockets, listening.) Tried as `start:scratch:win`, with requests rather than a browser.
- [x] The file list shows the documents, and opening one works. (Folder reading, file sending.)
- [x] Write a note; `data\notes\notes.json` changes on disk. (Saving: replacing a file that exists.)
- [x] Add a file with a name outside ASCII (for example `café.md`); it lists and opens. (The UTF-8 manifest.)
- [x] Change a file on disk; the reader notices within a second. (The watcher.)
- [x] Upload a folder, then remove it from its front page. (Creating and deleting folders.)
- [x] `npm run test:win`. It needs Python: the ordinary Windows one is enough (`bash` and `curl` come with MSYS2). All 144 answers match. A difference in a path with `\` in it means a path was not normalised to `/`.
- [x] `npm run start:network:win`: certificates are made, the fingerprint is printed, HTTPS by this machine's network address verifies against the authority, pairing works. (Network addresses, certificate files.) Tried with scratch state, from this machine.
- [ ] The same from another device, with the real state in `%APPDATA%\hub`, following `CERTIFICATES.md`. Windows will ask about the firewall here.
- [x] `http://localhost:4321` on the Windows machine itself still works with the network on, without any certificate.

## What is different on Windows

- **State folder:** `%APPDATA%\hub` (on macOS and Linux it is `~/.config/hub`). It holds the certificates and paired devices. Moving from the Mac, **do not copy it**: let Windows make its own authority, pair the devices again, and remove the Mac's authority from devices that will no longer use the Mac's hub.
- **File permissions:** the Mac build marks secret files readable by the owner only. Windows keeps a user's `AppData` private to that user already, so the Windows build does not change permissions.
- **Links:** a folder that is a link or junction to somewhere else is removed as a link and never followed when a folder is deleted.
- **Other hubs:** a Mac hub and a Windows hub can each be added to the other's reader as before.

## Raspberry Pi and other Linux

The Pi runs Linux, where the POSIX half of the code applies: the same code as macOS, already tested there. The ARM processor makes no difference to the source. Two things to know:

- **The encryption library must be version 3.** Check what the system offers with `apt-cache policy libmbedtls-dev`. If it shows 3.x, `sudo apt install build-essential libmbedtls-dev nodejs npm` is everything. If it shows 2.x (older Raspberry Pi OS releases), build mbedTLS 3.6 from its source first and point the Makefile at it with `make MBEDTLS=/path/to/it`.
- **Limits are chosen from the machine's memory:** under 1 GB gets the "small" profile, anything larger (a Pi 5) gets the same limits as a desktop.

Not yet tried on a Pi. The first-build checklist above applies, without the Windows-only lines.

## Still to do for Windows

- A full session in a browser, and a second device (the last open line of the checklist).
- A packaged desktop app (Tauri) was the plan before this; it needed `hubd.exe` working first, which it now is.
- Installing as a service that starts with Windows.
- The certificate steps for Windows in `CERTIFICATES.md` are the standard procedure and also untried.
