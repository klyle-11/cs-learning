# Moving the Hub's Server from Node.js to C++

> **What this teaches**: what a web framework's runtime was doing for you, by taking it away. How to replace a working server without breaking the page that depends on it. Why "parse untrusted bytes" is the dangerous part of any server, and what C++ gives you that C does not when you do it.

**Language**: C++17 (replacing JavaScript on Node.js)
**Code**: `server-cpp/` — `src/http.hpp`, `src/hub.cpp`, `API.md`, `test/contract.sh`
**Companion reads**: `07-projects/04-http-server-sockets.md` (you built this once in C), `04-security/tlv-parser.md` (bounds checks on untrusted input)

---

## 1. Why move at all

The reader is one HTML page plus a small server. The page does the heavy work in the browser: rendering markdown, colouring code, drawing highlights. The server only hands over files and saves small pieces of JSON.

The goal is to run that server on an ESP32 with the documents on a microSD card. Node.js does not run on an ESP32. Something compiled does.

Two decisions shaped the migration:

1. **The page does not change.** `hub/index.html` is served as it is by either server. That turns "rewrite the server" into "produce the same answers to the same requests".
2. **One server, not two.** The C++ server is built and tested on the Mac first, using only operating-system calls that the ESP32's toolkit (ESP-IDF) also provides. The Node server stays until the C++ one matches it, then goes.

## 2. What Node was doing for you

Every line below is something `server.js` got for free and `hubd` has to do itself.

| In Node | In C++ | Where |
|---|---|---|
| `http.createServer(...)` | `socket`, `bind`, `listen`, `accept`, then read bytes until the headers end | `http.hpp`, `serve` and `read_request` |
| `new URL(req.url)` | split the target at `?`, split the query at `&` and `=`, percent-decode each piece | `read_request`, `url_decode` |
| `JSON.parse`, `JSON.stringify` | the cJSON library, wrapped so the tree is always freed | `hub.cpp`, `struct Json` |
| strings that grow and are garbage-collected | `std::string`, freed when it goes out of scope | everywhere |
| the event loop (one thread, many connections) | one thread per connection, and a mutex around writes | `handle_connection`, `store_lock` |
| `fs.watch` (the OS reports file changes) | compare modification times once a second | `watch_loop` |
| `path.resolve` and a prefix check | split the path and refuse `..` | `clean_parts` |

You have written the first row before, in C. The rest is what turns an HTTP server into an application.

## 3. Write the contract down, then test against it

Before any C++, the API went into `server-cpp/API.md`: every route, what it takes, what it returns. That document is the specification both servers answer to.

Then `test/contract.sh` does something simple and strict:

1. Build a small fixture folder twice.
2. Start the Node server on one copy and `hubd` on the other.
3. Send the same 36 requests to each.
4. Replace the parts that are allowed to differ (ids, timestamps, the folder path) and `diff` the rest.

This is called a **characterization test**: you do not decide what the right answer is, you record what the existing system does and require the new one to match. It is the safest way to replace code that other code depends on.

The first run found three differences:

- A path-traversal request got a different error message. Node's URL parser had quietly normalised `/raw/../../etc/passwd` to `/etc/passwd` before the server saw it, so it fell through to "not found". The C++ server saw the raw path and rejected it by its own rule. Same status, different reason. **Lesson: the old server's behaviour included things its author never wrote.**
- Renaming the title to `"  Renamed   Title "`: Node collapsed the inner run of spaces, C++ only trimmed the ends.
- The two fixture folders had different names, and one answer includes the folder name. That was a fault in the test, not in either server.

After fixing those, all 36 answers match. On the real repository, the document list, the settings and a 45 KB document come back byte-for-byte the same from both.

> **Check Yourself 1.** The test compares answers. Name one kind of bug it cannot catch.
>
> **Answer.** Anything that does not show up in a response to those 36 requests: a memory error that happens not to change the output, a request the script never sends, behaviour under two simultaneous writers, how long an answer takes. That is why section 6 adds a second kind of check.

## 4. One request, start to finish

A browser sends bytes like these:

```
PUT /api/notes/abc123 HTTP/1.1\r\n
Content-Type: application/json\r\n
Content-Length: 21\r\n
\r\n
{"text":"my note..."}
```

`read_request` in `http.hpp` handles them in four steps.

**Read until the blank line.** TCP delivers a stream, not messages. One `recv` may return half the headers, or the headers plus some of the body. So the loop keeps appending to a buffer until it contains `\r\n\r\n`:

```cpp
while (head_end == std::string::npos) {
  ssize_t n = ::recv(fd, chunk, sizeof chunk, 0);
  if (n <= 0) return false;
  buf.append(chunk, static_cast<size_t>(n));
  head_end = buf.find("\r\n\r\n");
  if (head_end == std::string::npos && buf.size() > MAX_HEAD) { write_response(fd, error(431, "headers too large")); return false; }
}
```

**Parse the request line.** Method, target, version, separated by spaces. The target splits at `?` into a path and a query, and each piece is percent-decoded (`%20` becomes a space).

**Parse the headers.** One per line, `Name: value`. Names are lower-cased because HTTP header names are case-insensitive.

**Read the body.** `Content-Length` says how many bytes follow. Some of them may already be in the buffer from step one; the rest are read until the count is reached.

Then `route` in `hub.cpp` looks at the method and path, does the work, and returns a `Response`; `write_response` adds the status line and headers and sends it.

## 5. Every byte from the network is hostile until checked

In Node, a malformed request is the runtime's problem. Here it is yours. The rule the code follows: **decide how big something may be before making room for it.**

- **Headers** stop at 16 KB. Without that limit, a client that never sends the blank line makes the buffer grow until memory runs out.
- **Bodies** are limited per route (1 MB for JSON, 50 MB for uploads) and the limit is checked against `Content-Length` *before* reading the body. `strtoull` parses the number; anything that is not entirely digits is refused, which is why `-5` and `99999999999` both get an error and no allocation.
- **Chunked bodies** are refused outright. Supporting a second way to frame a body is a second parser to get wrong, and the page never sends one.
- **Silence** ends a connection after 15 seconds (`SO_RCVTIMEO`), so idle sockets cannot pile up.

Paths get the same treatment. A client chooses the path, and the server must never join it to a folder and hope:

```cpp
while (std::getline(ss, part, '/')) {
  if (part.empty() || part == ".") continue;
  if (part == ".." || part.find('\\') != string::npos || part.find('\0') != string::npos) return false;
  if (strict && (part[0] == '.' || part == "node_modules")) return false;
  parts.push_back(part);
}
```

The path is split into parts and rebuilt from the parts that passed. There is no "remove the dangerous bits" step, because sanitising by deletion is how `....//` becomes `../`. A path with a `..` in it is rejected whole. Percent-decoding happens *before* this check, so `%2e%2e` is seen as `..`.

> **Check Yourself 2.** Why must decoding come before the check, not after?
>
> **Answer.** If the check ran on the raw text, `%2e%2e` would pass (it contains no `..`), and decoding afterwards would turn it into `..` with nothing left to stop it. Always validate the form you are about to use.

## 6. Memory: what C++ gives you here that C does not

The security question behind "C or C++?" is really "who remembers to free things, and who checks lengths?"

In C, the request buffer is a `char` array you size, grow with `realloc`, and index by hand. Every one of those is a place to be off by one. In this server the buffer is a `std::string`: `append` grows it, `substr` copies a checked range, and it frees itself when the function returns, on every path, including the early `return false` ones.

cJSON is a C library, so its trees must be freed with `cJSON_Delete`. Forgetting that on one error path is a leak; doing it twice is a crash. The fix is a six-line wrapper:

```cpp
struct Json { // owns a cJSON tree
  cJSON *p;
  explicit Json(cJSON *node) : p(node) {}
  ~Json() { cJSON_Delete(p); }
  Json(const Json &) = delete;
  Json &operator=(const Json &) = delete;
};
```

The destructor runs when the variable goes out of scope, however the function exits. This idea is called **RAII**: tie a resource's release to an object's lifetime. Deleting the copy operations means two `Json` objects can never own the same tree. Locks work the same way: `std::lock_guard<std::mutex> g(store_lock);` unlocks when `g` goes out of scope.

C++ does not make the code safe by itself. `buf[i]` on a `std::string` is still unchecked. So the build has a second mode:

```
make check     # rebuild with AddressSanitizer and UndefinedBehaviorSanitizer
```

The sanitizers add checks to every memory access and arithmetic operation, and stop the program with a report at the first bad one. The contract test and eleven deliberately malformed requests (a 20 KB header, a negative length, binary garbage, a NUL in the path, a 60 MB upload) were run against that build. Each got a 4xx answer, the server stayed up, and the sanitizers reported nothing.

That is evidence, not proof. It says those inputs do not break it.

## 7. Saving a file so a power cut cannot corrupt it

`fs.writeFileSync` overwrites in place. If power fails halfway, the file is half old and half new. On an SD card in a small board, that will happen.

```cpp
string tmp = p + ".tmp";
{ std::ofstream f(tmp, std::ios::binary | std::ios::trunc); /* write, check */ }
return ::rename(tmp.c_str(), p.c_str()) == 0;
```

Write the whole new content to a temporary file, then rename it over the old one. A rename is a single step for the filesystem: afterwards the name points at either the complete old file or the complete new one.

Two requests saving notes at once would also be a problem (both read, both write, one loses). Node avoided it by accident: one thread, and its file calls were synchronous. With a thread per connection it has to be explicit, hence `store_lock` around every read-modify-write.

## 8. Live reload without being told about changes

Node's `fs.watch` asks the operating system to report changes. The ESP32 has no such service, so `watch_loop` does it the plain way: at a fixed interval (half a second on a computer), walk the folder, record each file's modification time and size, and compare with the previous walk. Anything different is announced to the connected pages.

It only walks while a page is connected. On an SD card, a full walk is real work, so the board's profile does it every five seconds.

## 9. One program, different machines

The same source has to behave sensibly on a laptop with 8 GB of memory and on a board with a few hundred kilobytes free. `detect_profile` decides once, at start-up:

- On the ESP32 the answer is known when the program is *compiled*: ESP-IDF defines `ESP_PLATFORM`, and an `#ifdef` selects the small limits.
- Anywhere else it asks the operating system at *run time* how much memory there is (`sysconf`) and picks `desktop` or `small` (under 1 GB, a Raspberry Pi Zero class board).

The profile sets the upload limit, how often the folder is checked for changes, and whether the page and its scripts are kept in memory. `--profile esp32` forces the board's limits on a computer, so they can be tested without the board.

Caching is where the speed comes from. Building the document list reads every file to find its title; the cached version only asks the filesystem for each file's modification time and size (`stat`, no reading) and rebuilds when any of them changed. On this repository that took the list from about 8 ms per request under Node to under 1 ms.

## 10. What changes on the ESP32, and what is not done

Carries over as written: every handler in `hub.cpp` (they use `opendir`, `stat`, file streams and cJSON, all present in ESP-IDF), the path checks, the temp-and-rename saves.

Changes:

- **The HTTP front end.** ESP-IDF ships its own HTTP server, maintained by the people who make the chip. The plan is to register the same handlers with it instead of using `http.hpp`. Less of your own parsing code on a device that sits on a network is the safer choice.
- **Memory.** The desktop build reads a whole file into a string before sending it. The board has a few hundred kilobytes free, so files must be sent in pieces as they are read.
- **Threads.** One thread per connection is fine on a Mac. On the board, connections are few and handled by the built-in server's own task.
- **Start-up.** Joining Wi-Fi and mounting the SD card happen before anything else.

Not in the C++ server yet: uploading a folder as its own workspace and switching workspaces (it answers 501), partial downloads for large PDFs, and sending files in pieces.

## 11. Exercises

1. Start `hubd` and send it a request by hand: `printf 'GET /api/config HTTP/1.1\r\n\r\n' | nc 127.0.0.1 4321`. Read the reply and name each line.
2. In `read_request`, find where a client that sends `Content-Length: 10` but only 3 bytes ends up. What stops the thread waiting forever?
3. `clean_parts` refuses a backslash in a path part. On which operating system would that matter, and why refuse it everywhere?
4. Add a route the page does not use yet, `GET /api/health` returning `{"ok":true}`, to both servers, and add it to `contract.sh`. Run `make test`.
5. Remove `store_lock` from the note routes, rebuild with `make check`, and write a loop that posts notes from two terminals at once. What goes wrong, and does the sanitizer notice?
