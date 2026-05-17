# Concurrent Chat Server with `epoll`

> **What this teaches**: The readiness model of high-concurrency networking — `epoll`, non-blocking I/O, edge- vs. level-triggered events, partial reads and writes, broadcasting to N clients without one thread per client. This is **the** project that explains why nginx, Redis, Node.js, and every modern game server look the way they do.

**Language**: C (Linux). The kqueue equivalent on macOS/BSD is identical in shape; the io_uring sibling is one step beyond.
**Effort**: 3 days for a working broadcast chat server; another week to make it bulletproof under bad clients.
**Companion reads**: 7.4 HTTP server (the previous design — `fork`-per-connection — that this project replaces), 7.6 redis-like server (the natural extension: same architecture, different protocol).

---

## 1. Why this matters

A blocking-I/O server uses one thread per connection. That works until you have ~10,000 connections, at which point your kernel is spending more time scheduling threads than your application is spending serving requests. This problem has a name (**the C10K problem**, coined by Dan Kegel in 1999) and a solution that the whole industry adopted within five years: **the event loop**.

An event loop is a single thread (or small pool) that does:

```
loop:
  ask the kernel: which of my N fds are ready to read or write?
  for each ready fd: do whatever non-blocking work is possible
  repeat
```

The mechanism that makes "ask the kernel about N fds" cheap is `epoll` (Linux), `kqueue` (BSD/macOS), or IOCP (Windows). It replaced `select()` and `poll()`, which were `O(N)` per call.

After this project you internalize:

- Why non-blocking I/O is non-negotiable in this model (one slow client cannot block the others).
- The difference between **edge-triggered** and **level-triggered** in your gut.
- Why "partial write" and "EAGAIN" are not edge cases but the normal happy path.
- The pattern every modern async runtime (Tokio, libuv, Netty, asyncio) is built on top of.

---

## 2. The mental model

```
                  ┌─────────────────────────────┐
                  │       event loop (one thread)│
                  │                              │
                  │  epoll_wait() ───┐           │
                  │                  │           │
                  │      ┌───────────▼──────────┐│
                  │      │   ready fd list       ││
                  │      │   ┌──┐ ┌──┐ ┌──┐     ││
                  │      │   │L │ │A │ │B │     ││  L = listening
                  │      │   └──┘ └──┘ └──┘     ││  A,B = clients
                  │      └──┬──────────────────┬┘│
                  │         │                  │ │
                  │   accept new           drain readable
                  │   (L ready)            send pending writes
                  │                              │
                  └─────────────────────────────┘
```

The event loop never blocks. Every syscall is either:

- *Made non-blocking* (`fcntl(fd, F_SETFL, O_NONBLOCK)`), so it returns `EAGAIN` instead of waiting; *or*
- `epoll_wait()` itself, which is the one blocking point of the whole architecture.

Per connection, you maintain a small state machine:

```
struct Conn {
    int fd;
    Buffer rx;            // bytes read but not yet processed
    Buffer tx;            // bytes to write but not yet sent
};
```

- On readable event: `read()` into `rx`, parse complete messages, react.
- On writable event: `write()` from `tx`; if empty, stop watching for writable.

That two-buffer-per-connection state is *the* design pattern of every event-loop server.

---

## 3. Setting up

```c
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>

static int set_nonblock(int fd) {
    int fl = fcntl(fd, F_GETFL, 0);
    return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

int main(void) {
    int listener = make_listener(7777);    // same as in project 7.4
    set_nonblock(listener);

    int ep = epoll_create1(0);
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = listener };
    epoll_ctl(ep, EPOLL_CTL_ADD, listener, &ev);
    // ...
}
```

`epoll_create1(0)` returns an epoll fd. The kernel keeps a set of `(fd, events)` you're interested in; you modify it with `epoll_ctl(ADD|MOD|DEL)`; you wait with `epoll_wait`.

---

## 4. The event loop

```c
#define MAX_EVENTS 1024

static Conn *conns_by_fd[65536];   // simple slot table by fd value

int main(void) {
    // ... setup as above ...
    struct epoll_event events[MAX_EVENTS];
    for (;;) {
        int n = epoll_wait(ep, events, MAX_EVENTS, -1);
        if (n < 0) { if (errno == EINTR) continue; perror("epoll_wait"); break; }
        for (int i = 0; i < n; i++) {
            int fd = events[i].data.fd;
            uint32_t e = events[i].events;
            if (fd == listener) {
                accept_new(ep, listener);
            } else {
                if (e & (EPOLLERR | EPOLLHUP | EPOLLRDHUP)) {
                    close_conn(ep, conns_by_fd[fd]);
                    continue;
                }
                if (e & EPOLLIN)  on_readable(ep, conns_by_fd[fd]);
                if (e & EPOLLOUT) on_writable(ep, conns_by_fd[fd]);
            }
        }
    }
}
```

Three rules:

- **`EPOLLRDHUP`** fires when the peer closes its end. Treat as "connection over."
- **`EPOLLERR`/`EPOLLHUP`** can also fire alongside `EPOLLIN`. Check those *first*; ignore further events for that fd.
- **`epoll_wait` returning `EINTR`** is normal — signal arrived. Loop.

---

## 5. Accept loop

In edge-triggered mode (covered next), one `EPOLLIN` on the listener might correspond to *many* pending connections. Accept in a loop until `EAGAIN`:

```c
static void accept_new(int ep, int listener) {
    for (;;) {
        struct sockaddr_in caddr;
        socklen_t clen = sizeof caddr;
        int c = accept4(listener, (struct sockaddr*)&caddr, &clen,
                        SOCK_NONBLOCK | SOCK_CLOEXEC);
        if (c < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) return;
            perror("accept"); return;
        }
        Conn *conn = calloc(1, sizeof *conn);
        conn->fd = c;
        conns_by_fd[c] = conn;
        struct epoll_event ev = {
            .events = EPOLLIN | EPOLLRDHUP | EPOLLET,
            .data.fd = c,
        };
        epoll_ctl(ep, EPOLL_CTL_ADD, c, &ev);
        broadcast_join(conn);
    }
}
```

`accept4` is the Linux-specific variant that lets you pass `SOCK_NONBLOCK | SOCK_CLOEXEC` at accept time, saving two extra `fcntl` calls per connection. Cheap and idiomatic.

---

## 6. Edge-triggered vs. level-triggered (the part everyone gets wrong once)

**Level-triggered (default)**: `epoll_wait` returns a fd as ready every call *as long as the condition holds*. If 1 KB is sitting in the receive buffer and you `read()` only 256 B, the next `epoll_wait` will return it again because there's still data.

**Edge-triggered (`EPOLLET`)**: the fd is returned ready *exactly once per transition* from not-ready to ready. If you don't drain everything available, the kernel does not re-notify you until *more* data arrives.

The implication: **in edge-triggered mode, every read/write must loop until `EAGAIN`**. Otherwise you can deadlock — data sits in the buffer, kernel doesn't notify you again, you wait forever.

```c
static void on_readable(int ep, Conn *c) {
    for (;;) {
        char buf[4096];
        ssize_t n = read(c->fd, buf, sizeof buf);
        if (n == 0) { close_conn(ep, c); return; }    // peer closed
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) return;
            if (errno == EINTR) continue;
            close_conn(ep, c); return;
        }
        buffer_append(&c->rx, buf, n);
    }
    process_messages(ep, c);  // unreachable here, but conceptually after the loop
}
```

(In practice, push `process_messages(ep, c)` into the `EAGAIN` branch.)

**Why edge-triggered at all?** Because in level mode, a writable socket is *almost always* writable, so `EPOLLOUT` fires constantly on every loop iteration whether you have anything to send or not. ET avoids that — `EPOLLOUT` only fires when transitioning from full to not-full. Most production event loops use ET for this reason.

For an educational version, **start with level-triggered**. It's much more forgiving. Move to ET as a v2 once everything works.

---

## 7. Buffered writes

The classic mistake: you call `write(c->fd, msg, n)`. It returns `m < n`. You discard the remaining `n - m` bytes. You wonder why messages are silently truncated.

Correct pattern:

```c
static void try_flush(int ep, Conn *c) {
    while (c->tx.len) {
        ssize_t w = write(c->fd, c->tx.buf, c->tx.len);
        if (w < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                // ask epoll to tell us when writable
                struct epoll_event ev = {
                    .events = EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLET,
                    .data.fd = c->fd,
                };
                epoll_ctl(ep, EPOLL_CTL_MOD, c->fd, &ev);
                return;
            }
            if (errno == EINTR) continue;
            close_conn(ep, c); return;
        }
        buffer_consume(&c->tx, w);
    }
    // tx empty: stop watching for writable
    struct epoll_event ev = {
        .events = EPOLLIN | EPOLLRDHUP | EPOLLET,
        .data.fd = c->fd,
    };
    epoll_ctl(ep, EPOLL_CTL_MOD, c->fd, &ev);
}
```

The pattern: **enable `EPOLLOUT` only when you have data to write and `write()` returned `EAGAIN`. Disable it when your tx buffer is empty.** Leaving `EPOLLOUT` on permanently in level-triggered mode burns 100% CPU spinning on writable events you don't care about.

`on_writable` is just `try_flush(ep, c)`.

---

## 8. The chat protocol (the easy part)

Messages are newline-terminated text. On read, scan rx for `\n`; for each complete line, broadcast it (with `[user]: ` prefix) to every connection except the sender.

```c
static void process_messages(int ep, Conn *src) {
    for (;;) {
        char *nl = memchr(src->rx.buf, '\n', src->rx.len);
        if (!nl) return;
        size_t line_len = nl - src->rx.buf;
        broadcast(ep, src, src->rx.buf, line_len);
        buffer_consume(&src->rx, line_len + 1);
    }
}

static void broadcast(int ep, Conn *src, const char *line, size_t n) {
    char out[1024];
    int on = snprintf(out, sizeof out, "[%d] %.*s\n", src->fd, (int)n, line);
    for (int fd = 0; fd < 65536; fd++) {
        Conn *c = conns_by_fd[fd];
        if (!c || c == src) continue;
        buffer_append(&c->tx, out, on);
        try_flush(ep, c);
    }
}
```

The "iterate every fd slot to find connections" is `O(maxfd)` but with `maxfd` ~ thousands and broadcasts being rare, it's fine. Production servers maintain an explicit connection list.

---

## 9. Backpressure (the hard part)

A slow client's tx buffer grows without bound. If you blindly `buffer_append` every broadcast to every client, one paused client OOMs your server.

Two policies, both reasonable:

1. **High watermark**: if a client's tx buffer exceeds N bytes, drop it. (Kicks slow clients.)
2. **Drop intermediate messages**: only the most recent line for paused clients. (Lossy but stable.)

Real systems (HAProxy, nginx) do option 1 with configurable limits. IRCds historically did option 2.

In any case: **enforce a maximum per-connection memory footprint**. Otherwise the first thing a hostile actor will do is connect, never read, and send your server to swap.

---

## 10. Common pitfalls

1. **Forgetting to drain in ET mode.** Read once, return; kernel never notifies again; connection wedges. Always loop to `EAGAIN`.
2. **Forgetting to handle short writes.** Silent data loss. Always buffer.
3. **Leaving `EPOLLOUT` permanently armed.** 100% CPU spin in level mode. Toggle it.
4. **Closing an fd that's still in epoll.** On Linux, `close()` automatically removes it from any epoll set, but only if no other process has a copy of the fd. Defensive: `epoll_ctl(EPOLL_CTL_DEL)` before `close()`.
5. **fd reuse race.** You close fd 17; kernel hands fd 17 to a new connection; your stale event for the old conn fires on the new one. Solve with `epoll_event.data.ptr` pointing at the `Conn` struct, with a generation counter, OR by being disciplined about removing before close.
6. **Blocking syscall in the loop.** `getaddrinfo`, file I/O without `O_NONBLOCK`, `gettimeofday` is fine, `printf` to a non-piped stdout is fine, `printf` to a piped stdout *can* block. Run nothing that might block in the loop.
7. **One slow handler stalls everyone.** Event loops are cooperative. If your message parser takes 100 ms, every other client waits 100 ms. Keep handlers `O(1)`.
8. **Not handling `EINTR`.** Every syscall can return `EINTR` if a signal arrives. Wrap.

---

## 11. Variations you'll encounter in the wild

- **`libevent`, `libev`, `libuv`** — abstraction libraries over epoll/kqueue/IOCP. `libuv` is what Node.js uses; `libev` is what nginx used historically.
- **`io_uring`** (Linux 5.1+) — the successor to `epoll`, a true async-I/O API rather than readiness notification. Submit operations, get completions; no `EAGAIN` to spin on. The right primitive for the next decade.
- **`kqueue`** (BSD, macOS) — older than `epoll`, similar shape but more general (file events, signals, timers, all in one API).
- **`Tokio`** (Rust), **`asyncio`** (Python), **`netty`** (Java) — language-level runtimes built on top of these primitives. All have the same buffer-per-connection + event-loop shape inside.

---

## 12. Where this shows up in the real world

- **nginx**: single-threaded event loop per worker, ~10k connections per worker on modest hardware.
- **Redis**: single event loop, ~100k ops/sec on commodity hardware (project 7.6).
- **HAProxy**: event loop + per-CPU worker model; the most-deployed L7 load balancer.
- **Node.js**: V8 + libuv event loop. JavaScript's "async/await" is a syntactic dress over exactly this.
- **Discord, WhatsApp, Slack**: chat servers at scale. Different languages (Erlang, Elixir, Go), same architecture underneath.

---

## 13. Going deeper

1. **Make the broadcast `O(active)` instead of `O(maxfd)`.** Track an explicit connection list.
2. **Add IRC-style rooms.** Connection → room mapping; broadcast only within room.
3. **Add a per-connection user nick.** Now you have an in-protocol handshake; first message after connect is `NICK alice`.
4. **Add SSL/TLS** with OpenSSL's BIO API integrated with epoll. Surprisingly fiddly; teaches you a *lot*.
5. **Port to `io_uring`.** Different paradigm: submission/completion queues instead of readiness. Genuinely faster for high-throughput servers.
6. **Read the Redis event loop** (`src/ae.c`, ~500 lines). Tiny, complete, very clean. Educational gold.

---

## 14. Industry context

> The C10K problem was the defining infrastructure problem of the early 2000s. Its solution (event-loop architectures + non-blocking I/O) is the foundation of essentially every server-side framework written since. C10M (10 million connections) is the current frontier — io_uring, eBPF, kernel-bypass with DPDK, all aim at it.

- **Active debate**: Goroutine-per-connection (Go) vs. shared event loop (Rust/Tokio, Node) vs. async-await-on-top-of-event-loop (Python, Rust, modern Java). Each has tradeoffs in latency variance, memory per connection, and developer ergonomics. Most teams pick by language.
- **Historical context**: `select(2)` (early 1980s), `poll(2)` (mid-1980s), `kqueue` (FreeBSD 4.1, 2000), `epoll` (Linux 2.5.45, 2002), `io_uring` (Linux 5.1, 2019). Each was a response to the previous becoming a bottleneck at scale.
- **What a tech lead would ask**: "How do you avoid head-of-line blocking?" (One slow message handler blocks the loop; bound everything.) "How do you handle backpressure?" (High watermark, drop slow clients.) "Why edge-triggered?" (Avoids spurious wakeups in level mode under contention.) "How do you scale past one core?" (Worker-per-core with `SO_REUSEPORT`, each with its own epoll set.)
- **Forward-looking**: io_uring is replacing epoll in performance-critical infra. eBPF + XDP is moving even more work into the kernel. DPDK and Snabb bypass the kernel entirely for the highest-end use cases.
- **Names worth knowing**: Dan Kegel (C10K essay), Davide Libenzi (epoll author), Jens Axboe (io_uring author), Igor Sysoev (nginx), Salvatore Sanfilippo (Redis, antirez).

---

## 15. Self-check questions

1. Why must every fd be non-blocking in an event-loop server?
2. What's the practical difference between level- and edge-triggered for `EPOLLIN`?
3. Why does `EPOLLOUT` need to be toggled rather than left on?
4. What does `EAGAIN` mean and why is it the *normal* termination of a read or write loop?
5. Why do `read()` returning 0 and `read()` returning `-1` need different handling?
6. What's the failure mode if you don't bound a slow client's tx buffer?
7. Why is `accept4` preferred over `accept` + `fcntl`?

If you can answer these, you have the foundation under nginx, Redis, Node.js, HAProxy, and every async runtime since 2003.
