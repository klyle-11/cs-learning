# Redis-Like In-Memory Server

> **What this teaches**: How "a hash table behind an event loop" becomes a database serving 100k ops/sec. RESP protocol parsing, single-threaded command dispatch, key expiration, and the design rationale ("why is Redis single-threaded?") that confuses everyone until they build one.

**Language**: C
**Effort**: 3 days for `GET`/`SET`/`DEL` over RESP. 5 days for expiration, `INCR`, lists, persistence.
**Companion reads**: 7.5 epoll chat server (this is exactly that architecture, with a different protocol), 7.2 KV store (the persistence layer Redis bolts on), 2.2 hash map (the core data structure).

---

## 1. Why this matters

Redis is one of the most-deployed pieces of infrastructure in the world. It is also small (~50k lines for the core) and reads almost like a textbook. The reason a tiny single-threaded C program can serve more requests per second than a sharded multi-node Java cluster comes down to four design decisions, all of which become *obvious* after you replicate them:

1. **Single-threaded event loop.** No locks. Cache-friendly. CPU-bound work is amortized over millions of small ops.
2. **In-memory data, no disk on the hot path.** Disk is for snapshots only.
3. **A binary protocol designed in 30 minutes** (RESP) that is trivial to parse correctly.
4. **A small, sharply chosen command set**, each command an `O(1)` or `O(log N)` data-structure operation.

After this project, "in-memory database" stops sounding like marketing and starts feeling like exactly what it is: a hash table reachable over a socket.

---

## 2. The mental model

```
   client ──TCP──▶ event loop ──▶ parse RESP ──▶ dispatch command ──▶ hash table
                       ▲                                                  │
                       │ ◀──────── serialize response ◀───────────────────┘

   On the side: a periodic timer evicts expired keys (background) and
   forks once a minute to snapshot the dataset (RDB) or appends every
   write to a log (AOF, structurally identical to project 7.2).
```

Three notable design choices:

- **Single-threaded means "command execution is single-threaded."** Networking I/O can be multithreaded (Redis 6+ does this), and persistence is in a `fork()`'d child. Only the command-dispatch loop is one thread, by design.
- **All values live in one hash table indexed by string key.** A value is a tagged union: string, list, hash, set, sorted set, stream. Each type has its own operations.
- **Expiration is lazy + sampled.** A key's TTL is checked on access (lazy) and a background cycle samples random keys looking for expired ones (active).

---

## 3. The RESP protocol

RESP (REdis Serialization Protocol) is the simplest binary-ish protocol that has ever achieved widespread adoption. Five types, all newline-framed.

```
+OK\r\n                 simple string
-ERR something\r\n      error
:1000\r\n               integer
$5\r\nhello\r\n         bulk string (length-prefixed)
*3\r\n                  array of 3 elements
$3\r\nSET\r\n
$3\r\nkey\r\n
$3\r\nval\r\n
```

A client sends commands as arrays of bulk strings:

```
*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$3\r\nval\r\n
```

The server replies in any of the five types depending on the command.

That is the entire protocol. Three pages of spec, no version negotiation, no headers, no encoding negotiation. It is the anti-HTTP: cheap to parse, cheap to generate, easy to learn.

---

## 4. The parser

The parser is a state machine over a byte buffer. It returns either "need more bytes" or "got a full command, here it is, consumed N bytes":

```c
typedef enum { PARSE_OK, PARSE_NEED_MORE, PARSE_ERROR } ParseStatus;

typedef struct {
    char  **argv;
    size_t *argv_len;
    int     argc;
} Command;

ParseStatus parse_resp(const char *buf, size_t n, Command *out, size_t *consumed);
```

The algorithm:

```c
static const char *find_crlf(const char *p, const char *end) {
    for (; p + 1 < end; p++) if (p[0] == '\r' && p[1] == '\n') return p;
    return NULL;
}

ParseStatus parse_resp(const char *buf, size_t n, Command *out, size_t *consumed) {
    const char *p = buf, *end = buf + n;
    if (p == end) return PARSE_NEED_MORE;
    if (*p != '*') return PARSE_ERROR;
    p++;
    const char *crlf = find_crlf(p, end);
    if (!crlf) return PARSE_NEED_MORE;
    long argc = strtol(p, NULL, 10);
    if (argc < 1 || argc > 1024) return PARSE_ERROR;
    p = crlf + 2;

    out->argc = (int)argc;
    out->argv     = malloc(sizeof(char*)  * argc);
    out->argv_len = malloc(sizeof(size_t) * argc);

    for (long i = 0; i < argc; i++) {
        if (p >= end || *p != '$') return PARSE_NEED_MORE;
        p++;
        crlf = find_crlf(p, end);
        if (!crlf) return PARSE_NEED_MORE;
        long slen = strtol(p, NULL, 10);
        if (slen < 0 || slen > 512*1024*1024) return PARSE_ERROR;
        p = crlf + 2;
        if (p + slen + 2 > end) return PARSE_NEED_MORE;
        out->argv[i]     = (char*)p;
        out->argv_len[i] = (size_t)slen;
        p += slen + 2;
    }
    *consumed = p - buf;
    return PARSE_OK;
}
```

**`PARSE_NEED_MORE` is the magic word.** It tells the event-loop layer "your buffer is incomplete; come back when you have more bytes." This is the same shape as every streaming-protocol parser ever written: state machine + "need more" sentinel.

The `argv` pointers are *into the caller's buffer*. Cheap, but the buffer must not be freed or shifted while the command runs. Standard tradeoff.

---

## 5. The command table

Each command is a function plus metadata:

```c
typedef struct Conn Conn;
typedef void (*CommandFn)(Conn *c, int argc, char **argv, size_t *argv_len);

typedef struct {
    const char *name;
    CommandFn   fn;
    int         arity;          // exact count; negative means "at least"
} CommandSpec;

static const CommandSpec commands[] = {
    { "PING", cmd_ping, 1 },
    { "ECHO", cmd_echo, 2 },
    { "GET",  cmd_get,  2 },
    { "SET",  cmd_set, -3 },    // SET k v [EX seconds]
    { "DEL",  cmd_del, -2 },
    { "EXPIRE", cmd_expire, 3 },
    { "INCR", cmd_incr, 2 },
    { "EXISTS", cmd_exists, -2 },
    { NULL, NULL, 0 }
};

static CommandFn lookup(const char *name) {
    for (const CommandSpec *s = commands; s->name; s++)
        if (strcasecmp(s->name, name) == 0) return s->fn;
    return NULL;
}
```

For ~10 commands a linear scan is fine. For 240 (real Redis), they use a hash table.

A command implementation is tiny:

```c
static void cmd_set(Conn *c, int argc, char **argv, size_t *len) {
    Entry *e = entry_new(argv[1], len[1], argv[2], len[2]);
    db_insert(db, e);
    reply_simple(c, "+OK\r\n");
}
static void cmd_get(Conn *c, int argc, char **argv, size_t *len) {
    Entry *e = db_lookup(db, argv[1], len[1]);
    if (!e) { reply_simple(c, "$-1\r\n"); return; }   // RESP null
    reply_bulk(c, e->val, e->val_len);
}
```

`$-1\r\n` is RESP's null bulk string — the way Redis returns "key not found." Note: that's distinct from `*-1\r\n` (null array) and from `$0\r\n\r\n` (empty string). Three distinct nulls. Welcome to protocol design.

---

## 6. The hash table

For a Redis-shaped server, use **open-addressed hashing with linear probing** for cache locality, or **chained hashing with incremental rehashing** for predictable latency under growth. Redis itself uses the latter:

- Two tables (`ht[0]`, `ht[1]`).
- During rehash, every operation also migrates a few buckets from `ht[0]` to `ht[1]`.
- After all migrated, free `ht[0]`, swap.

The reason: a 100M-key table doubling to 200M in one shot would block the event loop for seconds. Incremental rehashing amortizes the cost across thousands of operations, keeping `p99` latency bounded.

That is one of the most important infrastructure design lessons in the project: **single-threaded systems must avoid any operation that takes more than ~1 ms**. Resize-in-one-shot is a sin; amortize.

---

## 7. Expiration (TTL)

Each entry carries an optional `expire_at` timestamp.

```c
typedef struct Entry {
    char  *key, *val;
    size_t key_len, val_len;
    uint64_t expire_at_ms;     // 0 = no expiration
} Entry;
```

Two policies, used together:

- **Lazy**: on every access (`GET`, `EXISTS`, etc.), check; if expired, delete and behave as "not found."
- **Active**: a background callback fires every ~100 ms. It samples 20 random keys with TTLs; deletes the expired ones; if >25% were expired, immediately resamples. This is exactly the Redis algorithm.

The pure-lazy approach leaks memory for keys that are set with a TTL and never accessed again. The active sampler bounds the leak without doing the full `O(N)` scan a more naïve approach would require.

---

## 8. Putting it together (the connection state)

```c
typedef struct Conn {
    int    fd;
    Buffer rx, tx;
} Conn;

static void on_data(Conn *c) {
    for (;;) {
        Command cmd;
        size_t consumed;
        ParseStatus s = parse_resp(c->rx.buf, c->rx.len, &cmd, &consumed);
        if (s == PARSE_NEED_MORE) return;
        if (s == PARSE_ERROR) {
            reply_simple(c, "-ERR protocol error\r\n");
            close_conn(c);
            return;
        }
        if (cmd.argc < 1) { /* protocol error */ return; }
        CommandFn fn = lookup(cmd.argv[0]);
        if (!fn) reply_simple(c, "-ERR unknown command\r\n");
        else     fn(c, cmd.argc, cmd.argv, cmd.argv_len);

        free(cmd.argv); free(cmd.argv_len);
        buffer_consume(&c->rx, consumed);
    }
}
```

The loop is the **pipelining** support — if the client sent three commands at once, we parse and execute all three before returning. This is what gives Redis 10× throughput improvement under pipelining: same network roundtrip, many ops.

The whole networking layer is structurally identical to project 7.5. The work in *this* project is the protocol parser, command table, and data structure layer.

---

## 9. Persistence (briefly)

Two modes, both shipping in real Redis:

- **RDB (snapshot)**: every N writes or every M minutes, `fork()`; the child writes the entire dataset to disk; the parent continues serving. Copy-on-write keeps the snapshot consistent with no read-side cost. The whole point of single-threaded + fork + COW is that this works cleanly — no locks needed, kernel handles isolation.
- **AOF (append-only file)**: every write command is appended to a log. On restart, replay the log to rebuild state. This is exactly project 7.2 — a log-structured KV. Periodically rewrite the log to deduplicate.

A first version can skip persistence entirely. A second version implements RDB (~200 lines, very satisfying — `fork()` and you're done).

---

## 10. Why single-threaded?

The most-asked Redis question, with one answer that becomes obvious after building this:

- **No locking** → no contention, no priority inversion, no LiveLock.
- **Cache-friendly** → the hash table and recent values stay in L1/L2; multiple threads sharing the same table would cause cache-line ping-pong.
- **Trivial semantics** → "every command is atomic" is free; transactions (MULTI/EXEC) are queues, not 2PC.
- **The bottleneck isn't CPU** → it's memory bandwidth and network. One thread at saturating I/O is competitive with eight threads each at 12.5% I/O.

The cost: a single slow command (`KEYS *` on 100M keys) blocks everything. Real Redis explicitly warns against such commands and provides `SCAN` as the cursor-based incremental alternative.

Modern Redis (6+) added multi-threaded I/O *only* — the parsing and writing of bytes can be parallel, but command execution is still on one thread. This squeezes out the last 30% of throughput on 10+ Gbps NICs without breaking the single-threaded execution model.

---

## 11. Common pitfalls

1. **Allocating per command argument.** Easy to wind up with 4 mallocs per `GET`. Slow. Use the buffer-borrow pattern shown above.
2. **`strncmp` on case-sensitive commands.** Redis is case-insensitive (`SET`, `set`, `SeT`). Use `strcasecmp`.
3. **Not handling pipelining.** Parsing one command per `epoll` wakeup leaves throughput on the floor. Loop until `PARSE_NEED_MORE`.
4. **Blocking on disk in the event loop.** Persistence must `fork()` (RDB) or be a background thread with a write queue (AOF fsync). The main loop never touches disk.
5. **Synchronous resize.** Doubling a 10M-entry table in one operation is a multi-second pause. Incremental rehash.
6. **Returning the wrong null.** RESP has three. `$-1\r\n` for missing key, `*-1\r\n` for null array, `$0\r\n\r\n` for empty string. Conflate them and clients explode.
7. **No max client / max memory cap.** A memory-resident database without `maxmemory` is a memory-exhaustion vulnerability.
8. **Forgetting to free expired entries.** Pure-lazy expiration leaks slowly. Add the active sampler.

---

## 12. Variations you'll encounter in the wild

- **Redis itself** — ~150k lines of C, very readable. `src/server.c`, `src/networking.c`, `src/db.c` are the headliners.
- **KeyDB** — multi-threaded fork of Redis. Interesting case study in *why* the single-threaded design persists.
- **Dragonfly** — Redis-compatible server in modern C++, multi-threaded, shared-nothing. The "what if we re-designed Redis from scratch for 64-core machines" answer.
- **Memcached** — older sibling, simpler (no data types, no persistence), threaded.
- **Aerospike, Hazelcast** — clustered in-memory stores; different design center (consistency, sharding, replication built in).
- **Garnet** (Microsoft, 2024) — Redis-compatible in C#; performance work has interesting overlap.

---

## 13. Where this shows up in the real world

- **Caching tier** of essentially every web app at scale. Redis caches user sessions, page fragments, expensive query results.
- **Job queues** (Celery, Sidekiq, BullMQ all use Redis as the backend).
- **Pub/sub** for ephemeral fan-out (chat, notifications).
- **Rate limiting** (`INCR` + `EXPIRE` is the canonical implementation).
- **Real-time leaderboards** (sorted sets — `ZADD`/`ZRANGE`/`ZRANGEBYSCORE`).
- **Distributed locks** (the `Redlock` algorithm — controversial but widely used).

---

## 14. Going deeper

1. **Add lists (`LPUSH`/`RPUSH`/`LRANGE`).** A linked list of strings. ~100 lines.
2. **Add hashes (`HSET`/`HGET`).** A nested hash table per key. ~150 lines.
3. **Add sorted sets (`ZADD`/`ZRANGE`).** A skiplist + a hash table cooperating. The most interesting data-structure exercise on this whole list; Redis's `t_zset.c` is the reference.
4. **Add MULTI/EXEC transactions.** Queue commands; execute atomically. Very simple under single-threaded semantics.
5. **Add pub/sub.** Channels → subscriber list → broadcast. ~200 lines.
6. **Read `src/ae.c`** (Redis event loop, ~500 lines) and `src/networking.c` (~3500 lines). Both are very approachable.
7. **Implement RDB persistence.** `fork()`; child walks the hash table writing a typed binary format; rename the temp file atomically.

---

## 15. Industry context

> Redis's design is one of the most influential in modern infrastructure. Its core ideas (single-threaded event loop, in-memory, simple binary protocol) have been borrowed by dozens of systems. The fact that it ships in pure C and reads like a textbook means more engineers have learned from its source than from any other infrastructure codebase.

- **Active debate**: "Is single-threaded still the right call in 2026?" — KeyDB and Dragonfly say no; Redis upstream (now Valkey, post-license-change) says mostly yes with multi-threaded I/O. The honest answer is workload-dependent and hardware-dependent.
- **Historical context**: Salvatore Sanfilippo (antirez) started Redis in 2009 as a fix for the LLOOGG real-time analytics system. The project's stylistic clarity (and stubbornness — antirez routinely rejected PRs that added complexity for negligible benefit) is the reason the codebase remains readable 15 years later.
- **What a tech lead would ask**: "What's your worst-case command latency?" (`KEYS *` over 10M keys: hundreds of ms.) "How do you avoid head-of-line blocking?" (Don't run slow commands; use `SCAN` instead of `KEYS`.) "How do you handle persistence vs. throughput tradeoff?" (Choose RDB-only, AOF-only, both, or none, per workload.)
- **Forward-looking**: Memory-disaggregated architectures (CXL) and persistent memory (Optane, before discontinuation) prompt re-examinations of "in-memory" as a category. Valkey (the Linux Foundation fork after Redis's license change) is the active development front for the OSS lineage.
- **Names worth knowing**: Salvatore Sanfilippo (antirez), Pieter Noordhuis (early Redis core), Yossi Gottlieb (current Valkey lead), Brad Fitzpatrick (memcached author).

---

## 16. Self-check questions

1. Why is RESP newline-framed instead of using a length prefix everywhere?
2. What does `$-1\r\n` mean and how does it differ from `$0\r\n\r\n`?
3. Why is incremental rehashing necessary in a single-threaded server?
4. What does `fork()` give you for snapshotting that locking would not?
5. What's the difference between lazy and active expiration, and why are both needed?
6. Why does pipelining give Redis a 10× throughput boost?
7. What is the failure mode if a user runs `KEYS *` on a 100M-key database?

If you can answer these, Redis stops being a black box and starts being a thing whose behavior you can predict from first principles.
