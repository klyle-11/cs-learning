# CS Learning — Implementation Catalog

A curated set of 25 small, build-them-yourself implementations grouped by **what they teach you**, not by what they are. Most are a weekend or less. The point is not "now I have a hash map library" — the point is *the thing you understand afterward that you did not understand before*.

## How to use this catalog

Each entry below is a deliverable: a small piece of code, written from scratch, with no library shortcuts for the core mechanism. After building it, write a short page in your own words on what surprised you. That page is the actual artifact — the code is the lab notebook.

The **top-5 highest-signal-per-hour** picks are starred (★) and have full deep-dive docs already written. The rest have brief entries here and can be expanded into their own docs later.

**Suggested language fit** is given for each — not a rule. Build the security primitives in C even if Rust is your daily driver. Build the concurrency primitives in Rust even if you live in C. The language is part of the lesson.

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

## Sources & further reading per category

- **Allocators**: Andrei Alexandrescu's "Memory Allocation" talks; jemalloc and mimalloc source. Per-Vognsen's allocator videos.
- **Data structures**: CLRS (Cormen et al.). Sedgewick's *Algorithms*. Bob Nystrom's *Crafting Interpreters* (great hash table chapter).
- **Parsers**: Russ Cox's regex articles ("Regular Expression Matching Can Be Simple And Fast"). Bob Nystrom's Pratt parsing post. Crafting Interpreters again.
- **Security**: Aleph One "Smashing the Stack for Fun and Profit." LangSec / Sergey Bratus on parser-driven security. The CWE Top 25.
- **Concurrency**: Jeff Preshing's blog (the canonical "what does Acquire/Release actually mean" resource). *The Art of Multiprocessor Programming* (Herlihy & Shavit). The `crossbeam` source in Rust.
- **Algorithms**: CLRS again. Jeff Erickson's free algorithms textbook. Cormode/Yi for streaming.
