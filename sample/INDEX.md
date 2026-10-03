# CS Learning — Implementation Catalog

A curated set of 25 small, build-them-yourself implementations grouped by **what they teach you**, not by what they are. Most are a weekend or less. The point is not "now I have a hash map library" — the point is *the thing you understand afterward that you did not understand before*.

## How to use this catalog

Each entry below is a deliverable: a small piece of code, written from scratch, with no library shortcuts for the core mechanism. After building it, write a short page in your own words on what surprised you. That page is the actual artifact — the code is the lab notebook.

The **top-5 highest-signal-per-hour** picks are starred (★) and have full deep-dive docs already written. The rest have brief entries here and can be expanded into their own docs later.

**Suggested language fit** is given for each — not a rule. Build the security primitives in C even if Rust is your daily driver. Build the concurrency primitives in Rust even if you live in C. The language is part of the lesson.

---

## 0. Prerequisites — if you're new to C

If you've never written C before (or only touched it briefly), start here. It's the only entry on this list that is a *reference document* rather than a build-it-yourself project.

| # | Topic | What it teaches | Effort | Lang |
|---|-------|-----------------|--------|------|
| 0.1 | **[C for the JavaScript developer (cheat sheet)](docs/00-c-fundamentals/c-for-js-developers.md)** | The whole language in one document: compile/link pipeline, types, pointers, arrays, strings, structs, heap memory, headers, the preprocessor, build tooling, memory bugs, idioms. Aimed at someone fluent in a managed language who has never opened a `.c` file. | 1 focused day to skim; a week of building to internalize | C |

After this, jump straight to 1.1 (arena allocator) — it's the gentlest first project.

---

## 1. Allocators & memory primitives

This is where C separates from managed languages. A garbage-collected runtime hides the entire lifetime story; here, you write it.

| # | Topic | What it teaches | Effort | Lang |
|---|-------|-----------------|--------|------|
| 1.1 ★ | **[Bump / arena allocator](docs/01-allocators/arena-allocator.md)** | Lifetime as a region. Why game engines, compilers, and request-scoped servers love arenas. | Half day | C |
| 1.2 | Free-list allocator with split/coalesce | Implement `malloc`/`free` yourself. Fragmentation stops being abstract — you watch it happen in a printf-debugged heap diagram. | 1–2 days | C |
| 1.3 | Reference-counted pointer (`rc_retain`/`rc_release`) | You hand-build what `Rc<T>` and `shared_ptr` give you for free. The cycle problem becomes painfully obvious the first time you leak a doubly linked list. | Half day | C |
| 1.4 | String interning table | Hash + arena working together. Teaches identity vs. equality at the byte level — why `==` on interned strings is a pointer compare and a 100× speedup in a compiler symbol table. | Half day | C |

**Reading order tip**: Build 1.1 first. Then 1.2 — `malloc` won't seem magical anymore. Then 1.4, which composes 1.1 with hashing.

---

## 2. Data structures from the metal up

The structures every CS curriculum names, but almost no one has *actually written*. Doing them once dissolves a class of interview anxiety permanently.

| # | Topic | What it teaches | Effort | Lang |
|---|-------|-----------------|--------|------|
| 2.1 | Dynamic array with growth strategy | `push`/`pop`/`reserve`. Amortized analysis becomes intuitive when you write the `realloc` and feel the 1.5× vs 2× growth trade-off. | 2–3 hours | C |
| 2.2 ★ | **[Hash map: open addressing + tombstones](docs/02-data-structures/open-addressed-hash-map.md)** | Probe sequences, load factor, rehashing, deletion-without-shift. The interview classic almost no one has actually built. | 1 day | C |
| 2.3 ★ | **[LRU cache: hashmap + intrusive doubly linked list](docs/02-data-structures/lru-cache.md)** | Two structures cooperating. The "one struct lives in two collections" lesson. Intrusive lists make sense. | Half day | C |
| 2.4 | Min-heap / binary heap → Dijkstra | The algorithm only feels real once your heap is yours. Sift-up/sift-down is shorter than you think. | Half day | C |
| 2.5 | Trie with prefix iteration | Autocomplete, IP routing tables, T9 — same shape. Teaches "the key *is* the path through the structure." | Half day | C |

**Reading order tip**: 2.1 → 2.2 → 2.3 → 2.4 → 2.5. The dynamic array is the foundation; the hash map and LRU pull from it; the heap and trie stand alone.

---

## 3. Parsers & state machines

Rust shines here because lifetimes on string slices map naturally to "the token borrows from the source." You can build these in C, but you'll fight more.

| # | Topic | What it teaches | Effort | Lang |
|---|-------|-----------------|--------|------|
| 3.1 | Tokenizer for arithmetic + Pratt parser | Operator precedence stops being magic. Pratt's trick — binding powers — is the most underrated parsing technique in mainstream curricula. | Half day | Rust |
| 3.2 | JSON parser, hand-rolled, no regex | Small enough to finish in a sitting, real enough to ship. You learn that "parser" is a humble word for what most of the systems you depend on are doing constantly. | Half day | Rust |
| 3.3 ★ | **[Regex engine via NFA construction + simulation](docs/03-parsers/nfa-regex-engine.md)** (Thompson's algorithm) | One of the most satisfying ~200 lines you'll ever write. The moment you grok "an NFA is just a set of current states" you understand a chunk of computing you didn't before. | 1 day | Rust |

**Reading order tip**: 3.1 → 3.2 → 3.3. Pratt teaches recursive descent intuition; JSON teaches state machines without recursion; Thompson teaches the formal-language layer beneath both.

---

## 4. Security-flavored primitives

Direct Security+ / CVE-literature payoff. Each of these is a real-world vulnerability class compressed into a weekend project.

| # | Topic | What it teaches | Effort | Lang |
|---|-------|-----------------|--------|------|
| 4.1 | Length-prefixed string with bounds-checked append/copy | Feel *exactly* why `strcpy` is a footgun. The Pascal string vs. C string design debate, in your hands. | 2–3 hours | C |
| 4.2 ★ | **[TLV (type-length-value) parser with strict bounds checks](docs/04-security/tlv-parser.md)** | The shape of *most* binary protocols (ASN.1, BER/DER, TLS records, BGP messages) and *most* parser CVEs. Heartbleed lived in this exact pattern. | Half day | C |
| 4.3 | Constant-time memory compare | Timing side channels in 10 lines. The reason `memcmp` is wrong for password/HMAC comparison. | 1 hour | C |
| 4.4 | Integer parse with overflow detection | The bug behind a huge fraction of real exploits — image decoders, font parsers, ELF loaders. Underflow is sneakier than overflow. | 2 hours | C |
| 4.5 | Stack canary check (toy version) | Write the vulnerable function and the mitigation side by side. You understand `-fstack-protector` for the rest of your career. | Half day | C |

**Reading order tip**: 4.1 → 4.4 → 4.2 → 4.3 → 4.5. Build mental models of length, then arithmetic, then composite TLV parsing, then side channels, then mitigations.

---

## 5. Concurrency primitives

Rust is ideal here — atomics with explicit memory ordering force you to *think* about the ordering instead of getting it accidentally right.

| # | Topic | What it teaches | Effort | Lang |
|---|-------|-----------------|--------|------|
| 5.1 | Spinlock with atomics + memory ordering | `Acquire`/`Release` becomes concrete. You'll never again read those keywords as decoration. | 2–3 hours | Rust |
| 5.2 | MPSC channel on a bounded ring buffer | The producer/consumer problem with real backpressure, no busy-waiting. The sequence-number trick is beautiful. | 1 day | Rust |
| 5.3 | Lock-free stack with CAS | Small surface, deep lesson — including the ABA problem, which you will hit, and which is the thing senior engineers mean when they say "lock-free is hard." | 1 day | Rust |

**Reading order tip**: 5.1 → 5.2 → 5.3. Strict difficulty ramp.

---

## 7. Standalone projects (multi-day builds)

These are larger than the primitives above — each is a finished system you can run and demo. Where the earlier sections give you one mechanism in isolation, these put many mechanisms together. The format of each guide matches the deep-dives above: foundations, mental model, layered implementation, pitfalls, real-world context.

| # | Topic | What it teaches | Effort | Lang |
|---|-------|-----------------|--------|------|
| 7.1 | **[Unix shell](docs/07-projects/01-unix-shell.md)** | `fork`/`exec`/`wait`, file-descriptor plumbing for pipes and redirection, signals, job control. The shell is the "hello world" of operating systems — once you write one, every line of every Dockerfile and CI pipeline reads differently. | 2–3 days | C |
| 7.2 | **[Persistent key-value store](docs/07-projects/02-key-value-store.md)** | Log-structured storage, in-memory index, compaction, crash recovery. The simplest design behind Bitcask, RocksDB, LevelDB. You learn what "durable" actually costs. | 2–3 days | C |
| 7.3 | **[`malloc` from scratch](docs/07-projects/03-malloc-from-scratch.md)** | `sbrk`/`mmap`, boundary tags, free-list management, coalescing, alignment, header overhead. The chapter of the operating system that runs in user space. | 2–4 days | C |
| 7.4 | **[HTTP server from sockets](docs/07-projects/04-http-server-sockets.md)** | The full path from `socket()` to a parsed request to a written response. Headers, keep-alive, chunked encoding, the disasters of `read()` returning short. Covers the bonus web-server build. | 2–3 days | C |
| 7.5 | **[Concurrent chat server with `epoll`](docs/07-projects/05-concurrent-chat-epoll.md)** | Non-blocking I/O, edge- vs. level-triggered, the readiness model, partial reads/writes, broadcasting to N clients without a thread per client. The C10K problem in your hands. | 3 days | C |
| 7.6 | **[Redis-like in-memory server](docs/07-projects/06-redis-like-server.md)** | RESP protocol parsing, single-threaded event-loop architecture, expiration, basic persistence. After this, Redis stops being magic and starts being "a hash table behind an event loop." | 3–5 days | C |
| 7.7 | **[SQLite-style database with B-tree](docs/07-projects/07-sqlite-clone-btree.md)** | Pager, page cache, B-tree splits and merges, a tiny SQL subset, REPL. The hardest project on this list in pure code complexity; the most satisfying when it works. | 1–2 weeks | C |
| 7.8 | **[Git internals from scratch](docs/07-projects/08-git-internals.md)** | Content-addressed object store (blobs, trees, commits), zlib compression, refs, the index. After this, every `git` command makes sense. | 4–6 days | C |
| 7.9 | **[Tiny OS kernel](docs/07-projects/09-tiny-os-kernel.md)** | Freestanding C, the boot path, the GDT/IDT, paging, VGA text output, basic interrupts. Running your own kernel under QEMU is one of the most permanently mind-changing things a programmer can do. | 1–3 weeks | C + asm |

**Reading order tip**: 7.1 → 7.4 → 7.5 → 7.6 → 7.3 → 7.2 → 7.8 → 7.7 → 7.9. Shell teaches process model; the network sequence (7.4/7.5/7.6) teaches I/O architecture; `malloc` and the KV store teach storage; git and SQLite teach data structures at scale; the kernel teaches everything underneath all of it.

---

## 6. Algorithms that "click" once you implement them

Famous algorithms whose names you already know but whose internal logic only resolves into intuition after you've written them once.

| # | Topic | What it teaches | Effort | Lang |
|---|-------|-----------------|--------|------|
| 6.1 | Union-find with path compression + union by rank | Kruskal's MST falls out for free. Inverse Ackermann complexity in real code. | 2 hours | C or Rust |
| 6.2 | Reservoir sampling | A beautiful 5-line algorithm with a beautiful proof. Streaming algorithms in miniature. | 1 hour | Any |
| 6.3 | Consistent hashing ring | Directly applicable to distributed systems interviews (sharding, load balancing, Cassandra-style rings). | Half day | Any |
| 6.4 | Bit tricks: popcount, find-first-set, bitset ops | Building blocks of bloom filters, compression, crypto, vectorization. | 2 hours | C |
| 6.5 | Merkle tree | Security-relevant (git, certificate transparency, blockchains, BitTorrent). Inclusion proofs are surprisingly elegant. | Half day | Any |

---

## The top-5: what to build first

If you only build five of these, build:

1. **★ Arena allocator** — interview-friendly, mind-changing, and the foundation for the string interner later.
2. **★ Open-addressed hash map** — interview gold. Almost no one has built one. After you do, every cache, dictionary, and symbol table you ever see makes more sense.
3. **★ LRU cache** — interview gold *and* foundational systems literacy. The "two collections, one struct" idea unlocks a dozen related designs.
4. **★ TLV parser with bounds checks** — Sec+ payoff in code form. After this, you'll spot a class of CVEs by smell.
5. **★ NFA regex engine** — the one that makes you *feel* like you understand computing differently. Thompson's algorithm is short, complete, and beautiful.

These five are written up in full. Start with the arena allocator and work down the list.

---

## 9. Network security: certificates, HTTPS and who can reach a server

Written after this project's own certificate authority turned out to be able to vouch for any website. Four short documents, in order; the examples are the hub's own server.

| # | Document | What you'll learn |
|---|---|---|
| 9.1 | **[HTTPS and certificates, from zero](docs/09-network-security/01-https-and-certificates.md)** | What TLS gives, what a certificate is, the chain of trust, and what installing an authority really means. Name constraints. |
| 9.2 | **[Case study: an authority with no limits](docs/09-network-security/02-case-study-an-authority-with-no-limits.md)** | Two real incidents with the same shape, why they were hard to see, how bad they were, and what was done. |
| 9.3 | **[Who can reach a server](docs/09-network-security/03-who-can-reach-a-server.md)** | Bind addresses, pairing and tokens, cookie flags, cross-site requests, DNS rebinding, content policies. |
| 9.4 | **[Keeping watch](docs/09-network-security/04-keeping-watch.md)** | The two questions, commands that deserve a pause, a routine for every few months, and what to do when something looks wrong. |

---

## Sources & further reading per category

- **Allocators**: Andrei Alexandrescu's "Memory Allocation" talks; jemalloc and mimalloc source. Per-Vognsen's allocator videos.
- **Data structures**: CLRS (Cormen et al.). Sedgewick's *Algorithms*. Bob Nystrom's *Crafting Interpreters* (great hash table chapter).
- **Parsers**: Russ Cox's regex articles ("Regular Expression Matching Can Be Simple And Fast"). Bob Nystrom's Pratt parsing post. Crafting Interpreters again.
- **Security**: Aleph One "Smashing the Stack for Fun and Profit." LangSec / Sergey Bratus on parser-driven security. The CWE Top 25.
- **Concurrency**: Jeff Preshing's blog (the canonical "what does Acquire/Release actually mean" resource). *The Art of Multiprocessor Programming* (Herlihy & Shavit). The `crossbeam` source in Rust.
- **Algorithms**: CLRS again. Jeff Erickson's free algorithms textbook. Cormode/Yi for streaming.
