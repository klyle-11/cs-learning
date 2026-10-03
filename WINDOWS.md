# Running the hub on Windows (and on a Raspberry Pi)

The hub's server, `hubd`, was written on a Mac. This file is what was prepared so it can be built and run on Windows, what has and has not been tried, and what to check on the first build.

**Status, 3 October 2026: prepared, not yet built on Windows.** The Windows code was written on a Mac with no Windows machine or compiler to try it on. The macOS build was re-tested after every change (144 server checks pass), so nothing that worked before is affected. Expect the first Windows build to need small fixes; the checklist below is ordered so each step proves one thing.

## What was prepared

| Piece | What it is | Tried? |
|---|---|---|
| `server-cpp/src/platform.hpp` | Everything that differs between systems, in one file: sockets, folders, links, disk space, network addresses, the state folder. Each function has a POSIX half and a Windows half. | POSIX half: yes. Windows half: **no** |
| `server-cpp/Makefile` | A Windows branch: links the Windows network libraries, makes one self-contained `hubd.exe`, attaches a manifest so file names are UTF-8. | **no** |
| `server-cpp/windows/` | That manifest. | **no** |
| Path checks | On Windows, a path part is refused if it names a device (`CON`, `NUL`…), ends in a dot or space, or contains `:`. On every system, `notes` and `node_modules` are now matched whatever their letter case. | The second: yes |
| `hub/start.mjs` | The launcher, in Node, so starting the hub is the same on every system. On Windows it finds the compiler in MSYS2. | On macOS: yes |
| npm scripts ending `:win` | The same scripts, for Windows. | They refuse to run on a Mac, as intended |
| `server-cpp/test/contract.sh` | No longer uses a macOS-only form of `sed`. | On macOS: yes |

Not needed on Windows, and unchanged: the reader itself (`hub/`), which is a web page.

## Setting up a Windows machine

1. **Install [MSYS2](https://www.msys2.org/)** with its default location, `C:\msys64`. It provides the compiler, `make` and `bash`. (Installed somewhere else: set the environment variable `MSYS2_ROOT` to that folder.)
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

The `:win` scripts do one extra thing: they put MSYS2's folders on the path for that run, so the build tools are found. Settings such as `PORT` are environment variables on every system; in PowerShell that is `$env:PORT = "4400"; npm run start:win`.

## First build: what to check, in order

Each line proves one piece. Stop at the first that fails; the error will point into `platform.hpp` or the Makefile.

- [ ] `npm run build:win` produces `server-cpp\hubd.exe` with no errors. (Compiler errors here will be in the Windows half of `platform.hpp`: fix and repeat.)
- [ ] `npm run start:win` prints the address and stays running. `http://localhost:4321` shows the reader. (Sockets, listening.)
- [ ] The file list shows the documents, and opening one works. (Folder reading, file sending.)
- [ ] Write a note; `data\notes\notes.json` changes on disk. (Saving: replacing a file that exists.)
- [ ] Add a file with a name outside ASCII (for example `café.md`); it lists and opens. (The UTF-8 manifest.)
- [ ] Change a file on disk; the reader notices within a second. (The watcher.)
- [ ] Upload a folder, then remove it from its front page. (Creating and deleting folders.)
- [ ] `npm run test:win`, from a terminal where `bash`, `curl` and `python3` are available (the MSYS2 shell with `pacman -S python curl`, or Git Bash). All 144 answers should match. A difference in a path with `\` in it means a path was not normalised to `/`.
- [ ] `npm run start:network:win`: certificates are made in `%APPDATA%\hub`, the fingerprint is printed, another device can connect. (Network addresses, certificate files.) Then follow `CERTIFICATES.md` for the other device.
- [ ] `http://localhost:4321` on the Windows machine itself still works with the network on, without any certificate.

## What is different on Windows

- **State folder:** `%APPDATA%\hub` (on macOS and Linux it is `~/.config/hub`). It holds the certificates and paired devices. Moving from the Mac, **do not copy it**: let Windows make its own authority, pair the devices again, and remove the Mac's authority from devices that will no longer use the Mac's hub.
- **File permissions:** the Mac build marks secret files readable by the owner only. Windows keeps a user's `AppData` private to that user already, so the Windows build does not change permissions.
- **Links:** a folder that is a link or junction to somewhere else is removed as a link and never followed when a folder is deleted.
- **Other hubs:** a Mac hub and a Windows hub can each be added to the other's reader as before.

## Raspberry Pi and other Linux

The Pi runs Linux, where the POSIX half of the code applies: the same code as macOS, already tested there. The ARM processor makes no difference to the source. Two things to know:

- **The encryption library must be version 3.** Check what the system offers with `apt-cache policy libmbedtls-dev`. If it shows 3.x, `sudo apt install build-essential libmbedtls-dev nodejs npm` is everything. If it shows 2.x (older Raspberry Pi OS releases), build mbedTLS 3.6 from its source first and point the Makefile at it with `make MBEDTLS=/path/to/it`.
- **Limits are chosen from the machine's memory:** under 1 GB gets the "small" profile, anything larger (a Pi 5) gets the same limits as a desktop.

Not yet tried on a Pi either. The first-build checklist above applies, without the Windows-only lines.

## Still to do for Windows

- A packaged desktop app (Tauri) was the plan before this; it needs `hubd.exe` working first, which is what this prepares.
- Installing as a service that starts with Windows.
- The certificate steps for Windows in `CERTIFICATES.md` are the standard procedure and also untried.
