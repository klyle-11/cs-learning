# LRU Cache (Hashmap + Intrusive Doubly Linked List)

> **What this teaches**: Two structures cooperating to make every operation O(1). The "one struct lives in two collections" lesson — which, once you see it, you'll spot in kernel code, in language runtimes, in databases, in animation systems. Intrusive linked lists make sense for the first time.

**Language**: C
**Effort**: half a day
**Companion reads**: 2.2 hash map (prerequisite), 1.1 arena (great for backing the nodes), 1.3 reference counting (related lifetime story)

---

## 1. Why this matters

Every interesting cache is bounded — RAM, disk, even L1 cache. When a cache fills, you must evict something. **LRU** (Least Recently Used) is the classic eviction policy: the thing you haven't touched in longest is the thing to throw away.

The interview answer is "use a hash map plus a doubly linked list." Everyone says it. Almost no one writes it. The lesson is in the *details* of writing it:

- The hash map maps key → node.
- The linked list orders nodes from most-recently-used to least-recently-used.
- **The same node lives in both data structures simultaneously.**
- Both `get` and `put` are O(1).

That last point — same node in both — is the conceptual unlock. It's the reason you can move a node to the front of the list in O(1) (you already have a pointer to it from the hash map) and the reason you can evict the LRU and clean up the hash map entry without a full search (the node knows its own key).

This pattern — **intrusive containers** — is everywhere in kernel and high-performance code. After this, you'll recognize it on sight.

---

## 2. The mental model

```
Hash map: key -> Node*

Doubly linked list (MRU at head, LRU at tail):

  head -> [A] <-> [B] <-> [C] <-> tail

get("B"):
  1. lookup "B" in map  -> node
  2. unlink node from current position
  3. relink at head     (MRU)
  4. return node->value

put("D", v) when full:
  1. evict tail node, remove its key from map, free it
  2. allocate new node, place at head, insert into map

put("B", v') when "B" exists:
  same as get(), but also overwrite value
```

Every operation: a hash-map lookup (O(1)), pointer surgery (O(1)). The whole thing is O(1).

---

## 3. Two ways to compose a hash map with a linked list

**Non-intrusive**: the linked-list nodes are *separate* from the hash-map entries. The hash map stores `key → Node*`. Each `Node` then has `key, value, prev, next`. This works, but you're duplicating keys (one in the map, one in the node) and chasing two allocations per insert.

**Intrusive**: the `prev/next` pointers live *inside the same struct* that the hash map stores. One allocation per entry, one copy of the key, both data structures point to the same memory. This is the right design.

```
Node {
    char *key;
    Value val;
    Node *prev, *next;     <-- linked-list membership lives here
    uint64_t hash;
    /* hashmap-state if needed (state enum, etc.) */
};
```

We'll write the intrusive version.

---

## 4. The skeleton

```c
// lru.h
#ifndef LRU_H
#define LRU_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef void* Value;

typedef struct Node {
    char     *key;
    Value     val;
    uint64_t  hash;
    struct Node *prev, *next;   // list links
} Node;

typedef struct LRU {
    // hash map (open addressing on Node*)
    Node    **buckets;   // each slot points to a Node, NULL, or TOMBSTONE
    size_t    cap;       // power of two
    size_t    len;       // live entries
    size_t    tombs;

    // doubly linked list (sentinel-based, so head/tail never NULL)
    Node      head_sentinel;
    Node      tail_sentinel;

    size_t    capacity;  // max live entries before eviction kicks in
} LRU;

bool   lru_init(LRU *c, size_t capacity);
void   lru_free(LRU *c);
Value  lru_get(LRU *c, const char *key);
void   lru_put(LRU *c, const char *key, Value val);

#endif
```

Two simplifications worth flagging:

- **Sentinel nodes** for the list (`head_sentinel`, `tail_sentinel`). This eliminates *every* "is this the head/tail" special case in the link/unlink code. The first real node sits between the two sentinels. Sentinels are a recurring pattern; once you use them, you'll keep using them.
- **The hash map is embedded.** No separate `HashMap` struct — the buckets/cap/len/tombs live inside `LRU`. This is appropriate when the map is private to the structure.

We'll use a single tombstone sentinel for deletion-aware probing:

```c
static Node TOMBSTONE_NODE;
#define TOMBSTONE (&TOMBSTONE_NODE)
```

`NULL` means empty. `TOMBSTONE` means "deleted, keep probing." Any other pointer is a live entry.

---

## 5. Doubly linked list operations (the boring half — get it perfect)

```c
// lru.c
#include "lru.h"
#include <stdlib.h>
#include <string.h>

static void list_insert_after(Node *prev, Node *n) {
    n->prev = prev;
    n->next = prev->next;
    prev->next->prev = n;
    prev->next = n;
}

static void list_unlink(Node *n) {
    n->prev->next = n->next;
    n->next->prev = n->prev;
    n->prev = n->next = NULL;
}

static void list_move_to_front(LRU *c, Node *n) {
    list_unlink(n);
    list_insert_after(&c->head_sentinel, n);
}
```

Three functions, fifteen lines, the entire linked-list logic. Sentinels mean we never test `if (prev == NULL)`. The cost is two unused Node-shaped objects sitting in the LRU struct — entirely worth it.

> **Walk through `list_insert_after` mentally.** Before: `prev <-> X`. We want: `prev <-> n <-> X`. Set `n->prev = prev`, `n->next = X`, set `X->prev = n`, set `prev->next = n`. Done. Notice the order matters: if you wrote `prev->next = n` *before* `n->next = X`, you'd lose your handle on `X`.

---

## 6. Hash map operations (the interesting half)

We could reuse the hash map from doc 2.2, but for the LRU we'll write a slimmer version specialized to `Node*` values. Same probing logic.

```c
// FNV-1a 64-bit, same as 2.2
static uint64_t hash_str(const char *s) {
    uint64_t h = 0xcbf29ce484222325ULL;
    while (*s) { h ^= (uint8_t)*s++; h *= 0x100000001b3ULL; }
    h ^= h >> 33;
    return h;
}

// Returns address of slot: either a live Node* matching key, or the
// slot where it should be inserted (first TOMBSTONE or NULL on probe).
static Node **find_slot(LRU *c, const char *key, uint64_t h) {
    size_t mask = c->cap - 1;
    size_t i    = (size_t)h & mask;
    Node **first_tomb = NULL;
    for (;;) {
        Node **slot = &c->buckets[i];
        Node *e = *slot;
        if (e == NULL) {
            return first_tomb ? first_tomb : slot;
        }
        if (e == TOMBSTONE) {
            if (!first_tomb) first_tomb = slot;
        } else if (e->hash == h && strcmp(e->key, key) == 0) {
            return slot;
        }
        i = (i + 1) & mask;
    }
}

static bool map_resize(LRU *c, size_t new_cap);

static bool map_insert(LRU *c, Node *n) {
    if ((c->len + c->tombs) * 4 >= c->cap * 3) {
        size_t new_cap = (c->len * 2 > c->cap) ? c->cap * 2 : c->cap;
        if (!map_resize(c, new_cap)) return false;
    }
    Node **slot = find_slot(c, n->key, n->hash);
    bool was_tomb = (*slot == TOMBSTONE);
    *slot = n;
    c->len++;
    if (was_tomb) c->tombs--;
    return true;
}

static void map_remove(LRU *c, Node *n) {
    Node **slot = find_slot(c, n->key, n->hash);
    if (*slot == n) {
        *slot = TOMBSTONE;
        c->len--;
        c->tombs++;
    }
}

static bool map_resize(LRU *c, size_t new_cap) {
    Node **old = c->buckets;
    size_t old_cap = c->cap;
    c->buckets = (Node**)calloc(new_cap, sizeof(Node*));
    if (!c->buckets) { c->buckets = old; return false; }
    c->cap = new_cap; c->len = 0; c->tombs = 0;
    for (size_t i = 0; i < old_cap; i++) {
        Node *n = old[i];
        if (n && n != TOMBSTONE) map_insert(c, n);
    }
    free(old);
    return true;
}
```

This is the same hash-table machinery as 2.2, with one important specialization: the **slots store `Node*` directly**. The hash and the key live in the `Node`, so we don't duplicate them. This is the intrusive payoff: one allocation, no copying, both structures share data.

---

## 7. `lru_init`, `lru_free`

```c
bool lru_init(LRU *c, size_t capacity) {
    size_t cap = 8;
    while (cap < capacity * 2) cap <<= 1;  // start with some headroom
    c->buckets = (Node**)calloc(cap, sizeof(Node*));
    if (!c->buckets) return false;
    c->cap = cap; c->len = 0; c->tombs = 0;
    c->capacity = capacity;

    c->head_sentinel.next = &c->tail_sentinel;
    c->head_sentinel.prev = NULL;
    c->tail_sentinel.prev = &c->head_sentinel;
    c->tail_sentinel.next = NULL;
    c->head_sentinel.key  = c->tail_sentinel.key  = NULL;
    return true;
}

void lru_free(LRU *c) {
    Node *n = c->head_sentinel.next;
    while (n != &c->tail_sentinel) {
        Node *next = n->next;
        free(n->key);
        free(n);
        n = next;
    }
    free(c->buckets);
    c->buckets = NULL;
}
```

The sentinels point to each other initially — an empty list. Freeing walks the list (which mirrors the map's live set) and frees each node. **We free via the list, not via the map**, because the list iteration is sequential and cache-friendly, and we don't have to touch tombstones.

---

## 8. `lru_get` — the move-to-front move

```c
Value lru_get(LRU *c, const char *key) {
    if (c->len == 0) return NULL;
    uint64_t h = hash_str(key);
    Node **slot = find_slot(c, key, h);
    Node *n = *slot;
    if (!n || n == TOMBSTONE) return NULL;

    // Cache hit: bump to MRU position.
    list_move_to_front(c, n);
    return n->val;
}
```

Five lines. Map lookup → list move. Both O(1). **This is the whole show.**

Notice we mutate the structure on a *read*. Many LRU bugs come from forgetting this: a `get` that doesn't update recency turns your LRU into a random-eviction cache.

---

## 9. `lru_put` — insert, update, or evict

```c
void lru_put(LRU *c, const char *key, Value val) {
    uint64_t h = hash_str(key);
    Node **slot = find_slot(c, key, h);
    Node *n = *slot;

    if (n && n != TOMBSTONE) {
        // Update: replace value, bump to MRU.
        n->val = val;
        list_move_to_front(c, n);
        return;
    }

    // Need to insert. First, evict if full.
    if (c->len >= c->capacity) {
        Node *victim = c->tail_sentinel.prev;   // the LRU node
        if (victim != &c->head_sentinel) {
            list_unlink(victim);
            map_remove(c, victim);
            free(victim->key);
            free(victim);
        }
    }

    // Allocate and insert.
    Node *fresh = (Node*)calloc(1, sizeof(Node));
    fresh->key  = strdup(key);
    fresh->val  = val;
    fresh->hash = h;
    list_insert_after(&c->head_sentinel, fresh);
    map_insert(c, fresh);
}
```

Three cases:

1. **Update** — the key exists. Overwrite the value, bump to MRU. No allocation.
2. **Eviction needed** — at capacity, no matching key. The tail sentinel's `prev` is the LRU node. Unlink it from the list, remove it from the map, free it. Then proceed to insert.
3. **Plain insert** — under capacity, no matching key. Allocate, link at head, insert into map.

The eviction step is the entire reason the linked list is *doubly* linked. To remove the tail in O(1), you need a back-pointer from tail to its predecessor, plus the tail-sentinel trick to know where to stop without `NULL` checks.

---

## 10. Operation walkthrough

Imagine `capacity = 3`, starting empty.

```
put("A", 1) -> list: A   ; map: {A}
put("B", 2) -> list: B-A ; map: {A,B}
put("C", 3) -> list: C-B-A ; map: {A,B,C}
get("A")    -> list: A-C-B ; map: {A,B,C}  (A bumped to front)
put("D", 4) -> evict B (LRU); list: D-A-C ; map: {A,C,D}
```

Notice: after `get("A")`, B became the LRU even though A is older. This is the *recency* in LRU — touched = fresh, untouched = stale.

---

## 11. Complexity

| Op | Time | Space per entry |
|----|------|------------------|
| `get` | O(1) | 1 Node (key + value + 4 pointers + hash ≈ 48 bytes) |
| `put` (new) | O(1) amortized | + 1 hash bucket slot (8 bytes) |
| `put` (update) | O(1) | — |
| Eviction | O(1) | — |

Compare to alternatives: a list-only LRU is O(n) get. A map-only "cache" can't evict by recency. Together they hit O(1) on every operation. **This is why the textbook answer is "hash map + doubly linked list."**

---

## 12. Common pitfalls

1. **Singly linked list.** You can't evict in O(1) without back-pointers. The list must be doubly linked.

2. **Forgetting to move-to-front on `get`.** Now reads don't update recency and your LRU is broken. Test this by accessing one key repeatedly while inserting others — your "frequent" key should not be evicted.

3. **Two separate allocations per entry** (separate map-entry struct + list-node struct). Works, but doubles memory traffic and complexity. Intrusive is the right design.

4. **Storing the node-pointer in the map but not the hash.** Then on every map probe step you compare strings. Cache the hash in the node and compare hashes first.

5. **Forgetting that on `put`-update you must still move-to-front.** If you write the new value but leave the node in place, recency lies.

6. **NULL sentinels instead of sentinel nodes.** Now you need `if (head == NULL)` and `if (prev == NULL)` everywhere. Sentinels make link/unlink branchless.

7. **Evicting after insert instead of before.** If you insert first, then evict the tail, you might evict the entry you just inserted (if it's now the tail) when the cache was empty before insert. Evict first, then insert.

8. **Thread safety.** This LRU is not thread-safe. The standard fix is a coarse mutex (Java's `LinkedHashMap`-backed `Collections.synchronizedMap` does this). High-performance versions use shard-by-key or per-bucket locks (Caffeine, Guava). Lock-free LRUs exist but are research-grade.

---

## 13. Variations & the LRU family

- **Segmented LRU (SLRU)**: two LRU lists — "probationary" and "protected." Items move from probationary to protected on second hit. Resists scan pollution (a big sequential read evicting everything useful).
- **LRU-K**: track the time of the K-th most-recent access, not just the most recent. Better when access patterns have memory beyond one hit.
- **CLOCK / Second-Chance**: approximates LRU with a single bit per entry. Used in OS page replacement because doubly linked list updates are too expensive on every memory access.
- **ARC (Adaptive Replacement Cache)**: balances recency and frequency dynamically. ZFS uses it.
- **TinyLFU / W-TinyLFU**: frequency sketch + small admission window. Caffeine and modern in-memory caches use this. Outperforms LRU on most realistic workloads — a sign that LRU is *the simplest reasonable choice*, not the best one.
- **Random replacement**: surprisingly competitive on workloads with no recency signal. Worth knowing as a baseline.

---

## 14. Where this shows up in the real world

- **CPU caches**: L1/L2/L3 use *approximations* of LRU (pseudo-LRU trees). True LRU is too expensive in hardware.
- **OS page cache**: Linux uses two-list LRU (active + inactive lists), evicting from the inactive list. Same shape, more sophistication.
- **Databases**: Postgres's buffer pool uses CLOCK. MySQL/InnoDB uses a modified LRU. Most databases evolved away from strict LRU to handle scan patterns.
- **Web caches**: HTTP caches, CDNs. Cloudflare and Varnish use LRU variants.
- **Application caches**: Memcached, Redis (Redis has multiple eviction policies, allkeys-lru being one). Caffeine (Java) is the modern in-memory cache benchmark.
- **CPU branch predictors and TLBs**: pseudo-LRU again.
- **Compiler register allocation**: linear scan with last-use info is essentially LRU on registers.

---

## 15. Going deeper

1. **Add expiration (TTL).** Per-entry expiration time, evict on access if expired. Suddenly your hands are dirty with all the questions real caches face.
2. **Make it thread-safe.** Try a coarse mutex first. Profile. Then try sharding.
3. **Implement SLRU.** ~50 extra lines, dramatically better cache behavior on scans.
4. **Implement W-TinyLFU** (the Caffeine design). This is the rabbit hole; the paper and blog posts are excellent.
5. **Read the Caffeine source** (Java, but readable). State of the art.
6. **Read Linux's `mm/swap.c` and the page LRU code.** Same idea, productionized to the hilt.
7. **Read `linux/list.h`.** *The* canonical intrusive linked list. Once you understand it, you have a tool you'll use for the rest of your career.

---

## 16. Industry context

- **Active debate**: LRU vs. frequency-aware policies (LFU, TinyLFU, ARC). On scan-heavy workloads, strict LRU is *bad* — one big sequential read wipes the cache. Modern in-memory caches (Caffeine, the upcoming Rust `moka`) use admission + frequency sketches. LRU remains the right *teaching* answer and the right starting answer, not the right ending answer.
- **Historical context**: The hash-map + DLL design appears in Belady's 1966 paper on virtual memory replacement (OPT and LRU are introduced together). It's been in every OS textbook since. The interview prompt "implement LRU" has been canonical at FAANG and FAANG-like since at least the early 2010s.
- **What a tech lead would ask**: "What happens to the hit rate when there's a big sequential scan?" (drops to ~0 — see SLRU) "How do you handle concurrent access?" (lock, or shard) "What if the entries have variable size?" (now you're talking about *byte*-based eviction, not entry count — see Memcached) "How do you measure if LRU is actually the right policy for your workload?" (compare hit rate vs. random, vs. LFU; if random is close, you have no recency signal)
- **Forward-looking**: Frequency-aware caches (W-TinyLFU) are now mainstream in JVM-land and spreading. The next decade's cache designs will use ML-derived admission/eviction (Google's CacheLib papers).
- **Names worth knowing**: Lazslo Belady (the foundational paper, and OPT), Theodore Johnson and Dennis Shasha (LRU-K), Ben Manes (Caffeine, W-TinyLFU implementer), Nimrod Megiddo and Dharmendra Modha (ARC).

---

## 17. Self-check questions

1. Why does `get` mutate the structure?
2. Why doubly linked list, not singly?
3. Why intrusive, not non-intrusive?
4. What goes wrong if you evict *after* the new insert when at capacity?
5. Why sentinel nodes rather than NULL head/tail?
6. What workload pattern breaks strict LRU, and what variants address it?
7. Why is the hash cached in the Node?
8. In a production LRU, how would you make it thread-safe at scale?

If those flow, you've got it.
