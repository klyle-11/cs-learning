# HTTP Server from Sockets

> **What this teaches**: The full path from `socket()` to a parsed HTTP request to a written response. Headers, keep-alive, chunked encoding, the realities of `read()` returning short, and what every web framework you've ever used quietly does on your behalf. After this, the words "request" and "response" stop being abstract and become a specific sequence of bytes you can recite. (This is the project you said you already built and got the most out of — this guide is the writeup of it.)

**Language**: C
**Effort**: A weekend gets you `GET /` returning a static file. Another 2–3 days gets you headers parsed correctly, keep-alive, and proper error handling.
**Companion reads**: 7.1 unix shell (the `fork`-per-connection model used in v1), 7.5 epoll chat server (the model that replaces `fork`-per-connection), 4.2 TLV parser (request parsing is structurally similar).

---

## 1. Why this matters

The web — all of it — runs on top of two byte-oriented contracts: TCP for transport, HTTP for application semantics. Every framework you've used (Express, Rails, Django, FastAPI, Spring) is a thin shell around the same five operations:

1. `socket()` — make a kernel object capable of network I/O.
2. `bind()` + `listen()` — claim a port and start queuing incoming connections.
3. `accept()` — return a new fd for each connection.
4. `read()` until you have a full HTTP request.
5. `write()` an HTTP response, then either close or loop for the next request (keep-alive).

That's the whole job. The reason there are millions of lines of code in a production web server isn't that the fundamentals are hard — it's that the edge cases (slow clients, dead connections, malicious requests, encoding negotiation, range requests, HTTP/2 multiplexing) accumulate. The fundamentals fit on one page, and you should write them down once.

What you internalize from this project:

- TCP returns **streams**, not messages. `read()` is allowed to return *any number of bytes* up to what you asked for. Your parser must handle a request arriving in pieces.
- HTTP is a **text protocol** with one binary trick (the body length). The headers tell you where the body ends. If you don't parse `Content-Length` or `Transfer-Encoding: chunked`, you literally do not know.
- The kernel handles a lot of nasty things for you (retransmits, congestion control, Nagle) and a few things it explicitly does *not* (request framing, keep-alive lifetimes).

---

## 2. The mental model

```
client          your server
  │                  │
  │  TCP SYN ───────▶│   ← kernel handles
  │ ◀─── SYN-ACK ────│
  │  ACK ───────────▶│   ← connection established
  │                  │
  │                  │── accept() returns fd
  │                  │
  │  GET / HTTP/1.1\r\n     │── read()
  │  Host: x\r\n             │── read() (maybe in chunks)
  │  \r\n                   │── read() (now header is complete)
  │                  │── parse_request()
  │                  │── compute response
  │  HTTP/1.1 200\r\n        ◀── write()
  │  Content-Length: 11\r\n  ◀── write()
  │  \r\n hello world      ◀── write()
  │                  │── close() or loop (keep-alive)
```

Five places where reality bites:

1. `read()` is allowed to return less than you asked for, *even if more bytes are available later*.
2. `write()` is allowed to send less than you asked. You must loop.
3. `accept()` blocks until a connection arrives — or returns `EAGAIN` if you made the listening socket non-blocking.
4. The client can disappear at any point. Every syscall can fail with `ECONNRESET` or just return 0 (orderly close).
5. The HTTP request header section ends at the first `\r\n\r\n`. Until you see that, you don't have a complete request.

---

## 3. Setting up the listening socket

```c
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <string.h>

static int make_listener(int port) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return -1;

    int yes = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port   = htons(port),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(s, (struct sockaddr*)&addr, sizeof addr) < 0) { close(s); return -1; }
    if (listen(s, 128) < 0) { close(s); return -1; }
    return s;
}
```

Three things worth pausing on:

- **`SO_REUSEADDR`.** Without this, you cannot rebind to the same port for ~60 seconds after a server crash, because the kernel keeps the previous connection in `TIME_WAIT`. Set it, always, on every server you write.
- **`listen(s, 128)`** — the second argument is the backlog: how many half-established connections the kernel queues before refusing. 128 is fine for educational projects; production tuning gets more involved.
- **`htons`/`htonl`** — port and address are in network byte order (big-endian). Forgetting this works on x86 in tests because both ends are little-endian and the bug cancels; it breaks immediately when you talk to an actual network device.

---

## 4. The forking server (v1)

The Apache-1995 design. One process per connection. Conceptually trivial.

```c
int main(void) {
    signal(SIGCHLD, SIG_IGN);   // auto-reap zombies (Linux extension; portable: SIGCHLD handler)
    signal(SIGPIPE, SIG_IGN);   // don't die on broken-pipe writes

    int listener = make_listener(8080);
    for (;;) {
        struct sockaddr_in caddr;
        socklen_t clen = sizeof caddr;
        int c = accept(listener, (struct sockaddr*)&caddr, &clen);
        if (c < 0) continue;

        pid_t pid = fork();
        if (pid == 0) {
            close(listener);     // child doesn't need it
            handle_connection(c);
            close(c);
            _exit(0);
        }
        close(c);                // parent doesn't need it
    }
}
```

**`signal(SIGPIPE, SIG_IGN)` is mandatory.** Otherwise, the moment a client closes its end mid-response, your `write()` raises SIGPIPE and the default action is *terminate the process*. Every C network server has this line.

**`close(listener)` in the child, `close(c)` in the parent.** Mirror of the pipe-discipline lesson from the shell — both processes inherit both fds; you must close the ones you don't use in each.

This server scales to *maybe* a thousand concurrent connections before fork overhead kills you. That's the C10K problem in one paragraph, and it's why project 7.5 exists (epoll).

---

## 5. Reading a full request

The single most common bug in hand-rolled HTTP servers is to call `read()` once and assume you have the whole request. You don't.

```c
typedef struct {
    char  *buf;          // grown as data comes in
    size_t len;          // bytes filled
    size_t cap;
} RequestBuf;

static int read_until_double_crlf(int fd, RequestBuf *rb) {
    for (;;) {
        if (rb->cap - rb->len < 1024) {
            rb->cap = rb->cap ? rb->cap * 2 : 4096;
            rb->buf = realloc(rb->buf, rb->cap);
        }
        ssize_t n = read(fd, rb->buf + rb->len, rb->cap - rb->len);
        if (n == 0)  return -1;                  // peer closed before request complete
        if (n < 0)   return errno == EINTR ? 0 : -1;
        rb->len += n;
        // search for \r\n\r\n in the tail of what we've read
        if (rb->len >= 4) {
            for (size_t i = 0; i + 4 <= rb->len; i++) {
                if (memcmp(rb->buf + i, "\r\n\r\n", 4) == 0) {
                    return (int)(i + 4);          // offset of body start
                }
            }
        }
        if (rb->len > MAX_HEADER_BYTES) return -1; // headers too big — refuse
    }
}
```

Three things to note:

- **The `MAX_HEADER_BYTES` cap.** Without it, an attacker can send infinite headers and OOM your server. nginx defaults to 8 KB. This is one of the simplest and most common DoS vectors in DIY web servers.
- **The "rescan from start" is `O(n²)`** for a request that arrives one byte at a time. Real servers track the last 3 bytes across reads. For an educational version, the simple loop is fine; the issue is rare in practice because requests typically arrive in 1–2 packets.
- **`read() == 0` is orderly close.** Don't treat it as an error; treat it as "the client gave up; abort."

---

## 6. Parsing the request line and headers

After the double CRLF, the buffer up to the offset returned by `read_until_double_crlf` is the entire header section. Split it on `\r\n`:

```
GET /index.html HTTP/1.1\r\n
Host: example.com\r\n
User-Agent: curl/8.0\r\n
Content-Length: 0\r\n
\r\n
```

```c
typedef struct {
    char *method;
    char *path;
    char *version;
    struct { char *name, *value; } headers[64];
    size_t n_headers;
    size_t content_length;
    int    keep_alive;
} Request;

// in-place tokenization: replace separators with NULs and store pointers
static int parse_request(char *buf, size_t header_len, Request *r) {
    char *line_end = memmem(buf, header_len, "\r\n", 2);
    if (!line_end) return -1;
    *line_end = 0;

    char *sp1 = strchr(buf, ' ');     if (!sp1) return -1; *sp1++ = 0;
    char *sp2 = strchr(sp1, ' ');     if (!sp2) return -1; *sp2++ = 0;
    r->method = buf; r->path = sp1; r->version = sp2;

    char *p = line_end + 2;
    char *end = buf + header_len - 2;
    r->n_headers = 0;
    while (p < end) {
        char *nl = memmem(p, end - p, "\r\n", 2);
        if (!nl) return -1;
        *nl = 0;
        char *colon = strchr(p, ':');
        if (!colon) return -1;
        *colon++ = 0;
        while (*colon == ' ' || *colon == '\t') colon++;
        if (r->n_headers >= 64) return -1;
        r->headers[r->n_headers].name  = p;
        r->headers[r->n_headers].value = colon;
        r->n_headers++;
        p = nl + 2;
    }
    // post-process the two we care about
    r->content_length = 0;
    r->keep_alive = (strcmp(r->version, "HTTP/1.1") == 0); // default on 1.1
    for (size_t i = 0; i < r->n_headers; i++) {
        if (strcasecmp(r->headers[i].name, "Content-Length") == 0)
            r->content_length = strtoul(r->headers[i].value, NULL, 10);
        if (strcasecmp(r->headers[i].name, "Connection") == 0)
            r->keep_alive = strcasecmp(r->headers[i].value, "keep-alive") == 0;
    }
    return 0;
}
```

The "in-place tokenization with NULs and pointers" pattern is a common C idiom — zero allocation, zero copy, parser owns the buffer for the request lifetime. Just remember the buffer must outlive the `Request`.

**Header name comparison is case-insensitive** per the spec (`Host`, `host`, `HOST` are the same header). `strcasecmp` is your friend. Real-world servers I have seen ship with `==`-based comparisons and fail to interoperate with niche clients; do not be that server.

---

## 7. Writing a response

```c
static int write_all(int fd, const void *buf, size_t n) {
    const char *p = buf;
    while (n) {
        ssize_t w = write(fd, p, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        p += w; n -= w;
    }
    return 0;
}

static void respond_200(int fd, const char *body, size_t n, int keep_alive) {
    char header[256];
    int hn = snprintf(header, sizeof header,
        "HTTP/1.1 200 OK\r\n"
        "Content-Length: %zu\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        "Connection: %s\r\n"
        "\r\n",
        n, keep_alive ? "keep-alive" : "close");
    write_all(fd, header, hn);
    write_all(fd, body, n);
}
```

**Why a `write_all` wrapper?** Same reason as `read` — `write()` can return short. On a fast local socket you'll almost never see it; on a slow client over a congested network you'll see it constantly. Educational servers that skip this wrapper appear to work and then mysteriously drop bytes during stress tests.

`Content-Length` is **mandatory** for HTTP/1.1 responses with a body, unless you use `Transfer-Encoding: chunked`. Without it the client has no way to know where the body ends, and the response either hangs forever (keep-alive) or the client guesses based on connection close (HTTP/1.0 semantics, removed from 1.1).

---

## 8. Keep-alive

HTTP/1.1 connections are keep-alive by default. After writing the response, loop back to read the next request on the same fd. Close after the first request only if the client sent `Connection: close` or you decided to.

```c
static void handle_connection(int fd) {
    for (;;) {
        RequestBuf rb = {0};
        int body_off = read_until_double_crlf(fd, &rb);
        if (body_off < 0) { free(rb.buf); return; }

        Request req;
        if (parse_request(rb.buf, body_off, &req) < 0) {
            send_400(fd); free(rb.buf); return;
        }
        // (if needed) read body of length req.content_length from rb.buf[body_off:] plus more from fd
        serve(fd, &req);
        free(rb.buf);

        if (!req.keep_alive) return;
    }
}
```

Set a **read timeout** on the keep-alive fd so an idle client can't hold a connection open forever:

```c
struct timeval tv = { .tv_sec = 15, .tv_usec = 0 };
setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
```

Without this, a "Slowloris" attacker opens a thousand connections, never sends data, and your forking server is now hosting a thousand idle children with no way out.

---

## 9. Chunked transfer encoding (the only "tricky" part)

For responses whose length you don't know in advance (streaming a file generated on the fly, an SSE stream, a long-running response), send:

```
HTTP/1.1 200 OK\r\n
Transfer-Encoding: chunked\r\n
\r\n
1a\r\n
the first chunk of data here\r\n
0\r\n
\r\n
```

Each chunk is `<hex length>\r\n<bytes>\r\n`; a zero-length chunk ends the body. The chunked encoder itself is ~20 lines. The decoder (for parsing chunked request bodies, much rarer) is more code and worth skipping in v1.

---

## 10. Common pitfalls

1. **`read()` returns short.** Treat the request buffer as a stream; loop until you have the framing marker.
2. **`SIGPIPE`.** Set `signal(SIGPIPE, SIG_IGN)`. You will be bitten if you don't.
3. **Forgetting `Content-Length`.** Either the response or the request hangs. Browsers will give weird symptoms; `curl -v` will tell you the truth.
4. **Naïve URL handling.** `GET /../../../etc/passwd HTTP/1.1` should not serve `/etc/passwd`. Normalize the path; reject `..`; root it under your document root with `openat(rootfd, ...)` ideally.
5. **`fork`-per-connection at scale.** Fine for educational purposes; falls apart at a few thousand connections. The next project (7.5 epoll) solves this.
6. **Trusting header values.** `Content-Length: 0xffffffffffffffff` is an attacker probing for integer overflow. Use a safe parser; cap at a sane maximum.
7. **HTTP/1.0 quirks.** No keep-alive by default; no `Host` header required. If you serve `curl --http1.0`, you'll need to handle this.
8. **Returning a stale `Connection` header.** If the request was 1.0 and didn't ask for keep-alive, your response must include `Connection: close` and you must close. Otherwise the client hangs waiting for the next byte.

---

## 11. Variations you'll encounter in the wild

- **nginx** — production-grade event loop (epoll/kqueue), C, ~150k LOC. The reference for "fast static server."
- **Apache `httpd`** — historically forking, now also has event MPM. Heavier, more configurable.
- **Caddy** — Go, opinionated, automatic HTTPS. Good source for modern design choices.
- **Envoy** — C++, HTTP/1, HTTP/2, gRPC. The data plane behind a lot of modern infra.
- **`httpd.c`** in the `kilo` editor author's repo, `tinyhttpd`, `picohttpd` — pedagogical implementations under 500 lines.
- **`h2o`** — small, fast, HTTP/2 native.

---

## 12. Where this shows up in the real world

- Every web framework wraps these exact syscalls. Express/Node uses `libuv` which uses `epoll`; Django/uWSGI calls `accept`/`read`/`write` in worker processes; Go's `net/http` is the goroutine scheduler wrapped around `epoll`.
- **Reverse proxies** (nginx, Envoy, HAProxy) are this loop with an upstream `connect()` added.
- **TLS termination** is exactly this server with `read`/`write` replaced by `SSL_read`/`SSL_write` and a handshake step on accept.
- **HTTP/2** changes the wire format but the socket lifecycle is identical; you `accept`, you read frames instead of lines, you write frames instead of lines.
- **CGI** is `fork`/`exec` after `accept` — directly the shell + this server.

---

## 13. Going deeper

1. **Add a `sendfile()`-based static-file path.** Zero-copy `disk → socket`; ~5× faster than `read` + `write` for big files.
2. **Switch from `fork` to a thread pool.** Lower per-connection overhead. Still falls over at C10K.
3. **Then switch the thread pool to a single-threaded event loop with `epoll`.** This is the entire next project (7.5).
4. **Add HTTPS with OpenSSL.** `SSL_accept`, `SSL_read`, `SSL_write`. Conceptually a wrapper around the fd; in practice handshake state machines are non-trivial.
5. **Add HTTP/2 support** with `nghttp2`. Frames, streams, flow control — a different model entirely.
6. **Read `picohttpparser`.** Single-header HTTP parser used by h2o and (historically) Cloudflare; demonstrates the fastest possible parsing.

---

## 14. Industry context

> The most interesting evolution in HTTP servers in the last decade is the move away from "one connection per request" — first to keep-alive (HTTP/1.1), then to multiplexing (HTTP/2), then to UDP-based transport (HTTP/3 over QUIC). Each step solved a real performance problem visible in the previous design.

- **Active debate**: Synchronous-per-thread (Apache prefork, PHP-FPM, Rails Puma) vs. async-event-loop (nginx, Node, asyncio). For mostly-CPU-bound work, threads win. For mostly-I/O-bound work, event loops win. Most production stacks now blend both.
- **Historical context**: NCSA `httpd` (1993, ~2k lines) was the first popular web server and used `fork`-per-connection. Apache (1995) added the MPM (multi-processing module) abstraction. nginx (2004) introduced the event-loop design at scale to defeat the C10K problem.
- **What a tech lead would ask**: "What's the maximum concurrent connections?" (Fork: ~1k. Threadpool: ~10k. Event loop: ~100k–1M.) "How do you handle slow clients?" (Read timeouts, write timeouts, both.) "Are you protected against header smuggling?" (Two requests in one TCP segment, conflicting `Content-Length` and `Transfer-Encoding`, etc. — the Apache/nginx CVE database is mostly this.)
- **Forward-looking**: HTTP/3 (QUIC) moves transport into user space. Cloudflare's `quiche`, Google's `quic`, Facebook's `mvfst` are the reference implementations. Writing one of those is the 2030s version of this project.
- **Names worth knowing**: Roy Fielding (REST, HTTP/1.1 spec author), Igor Sysoev (nginx), Patrick McManus (Mozilla, HTTP/2), Jonathan Hui (h2o, picohttpparser).

---

## 15. Self-check questions

1. Why must you handle `read()` returning short?
2. Why do you set `SIGPIPE` to `SIG_IGN`?
3. What does `Content-Length` actually do for the protocol?
4. What is the framing rule that ends the header section?
5. What does keep-alive change about the lifecycle of `handle_connection`?
6. What is the difference between `SO_REUSEADDR` and `SO_REUSEPORT`?
7. Why is `fork`-per-connection a dead end at scale?

If you can answer these, you have understood, byte by byte, the foundation under every web framework you've ever used. (You said you already learned a lot here — this section is your receipt.)
