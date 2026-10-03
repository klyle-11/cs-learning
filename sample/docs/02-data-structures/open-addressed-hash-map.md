# Hash Map with Open Addressing + Tombstones

> **What this teaches**: The four hard problems hiding inside the word "hash map" — hashing, probing, deletion, and resizing. Probe sequences become intuition. Load factor stops being a magic number. After this, every cache, every dictionary, every symbol table in every language makes more sense.

**Language**: C
**Effort**: one full day
**Companion reads**: 2.1 dynamic array (the storage substrate), 2.3 LRU cache (next composition), 1.4 string interner (hash map + arena)

---

## 1. Why this matters

A hash map is the most-used data structure in modern software. Every JSON object is one. Every Python `dict`, JS object, Go map, Rust `HashMap`, Java `HashMap` — same family. The version everyone is *taught* is **chained hashing**: an array of buckets, each holding a linked list of entries.

The version everyone *actually uses in modern code* is **open addressing**: a single flat array, no per-entry allocation, collisions handled by probing forward to the next slot. Open addressing wins on:

- **Cache behavior**. The flat array fits in L1; chained nodes are pointer-chases.
- **Memory**. No per-entry next-pointer, no per-entry malloc header.
- **Predictability**. No GC pressure, no fragmentation.

Modern hash tables — Google's `dense_hash_map`, Abseil's `flat_hash_map`, Rust's `hashbrown` (the basis of `std::HashMap` since 1.36), Python's `dict` since 3.6, V8's object property tables — are open-addressed. Chaining is essentially obsolete in performance-sensitive code.

You will be asked about hash maps in interviews. Almost no one has built one. After this, you have.

---

## 2. The mental model

```
slots: [_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_]
        0 1 2 3 4 5 6 7 8 9 ...        cap

insert("apple"):
  i = hash("apple") & (cap-1)     // say i = 5
  if slots[5] empty: put there
  else: try slot 6, then 7, ... until you find empty

lookup("apple"):
  i = hash("apple") & (cap-1)     // 5
  while slots[i] not empty:
    if slots[i].key == "apple": return slots[i].value
    i = (i+1) & (cap-1)
  return not_found
```

**That's it.** Two design subtleties carry almost the entire weight of "is this hash table good":

1. **What sequence do we probe?** Linear (`i+1, i+2, ...`)? Quadratic (`i+1, i+4, i+9, ...`)? Double-hashed? We'll start linear; modern designs use quadratic-ish variants for better behavior at high load.

2. **How do we handle deletion?** The killer question. If you just blank out a slot, then a lookup for `"banana"` that *used to* probe past `"apple"` to find itself will now stop at the blank slot and return "not found." This is the **tombstone** problem.

Most blog posts skip both. We're not skipping either.

---

## 3. The core layout

```c
// hashmap.h
#ifndef HASHMAP_H
#define HASHMAP_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef enum {
    SLOT_EMPTY = 0,    // never used
    SLOT_LIVE  = 1,    // contains a real entry
    SLOT_TOMB  = 2,    // entry was deleted; probe continues past
} SlotState;

typedef struct Entry {
    SlotState state;
    uint64_t  hash;   // cached so we don't recompute on every probe step
    char     *key;    // owned strings, null-terminated
    void     *value;
} Entry;

typedef struct HashMap {
    Entry  *slots;
    size_t  cap;       // power of two
    size_t  len;       // live entries
    size_t  tombs;     // tombstones (count toward load factor)
} HashMap;

bool  hm_init(HashMap *m, size_t initial_cap);
void  hm_free(HashMap *m);
bool  hm_put(HashMap *m, const char *key, void *value);
void *hm_get(HashMap *m, const char *key);
bool  hm_del(HashMap *m, const char *key);

#endif
```

Three things to notice immediately:

- **Slot states are explicit.** `EMPTY`, `LIVE`, `TOMB`. Not a NULL key, not a magic value — an enum field. This costs one byte per slot and earns clarity.
- **Hash is cached per entry.** When we probe, we compare cached hashes *first*. Comparing two `uint64_t`s is cheap; comparing two strings is `strcmp`. Hash equality is a fast pre-filter.
- **Tombstones count toward load.** Tombstones aren't free — they slow lookups exactly like live entries. So our "is it time to resize?" check uses `len + tombs`, not just `len`.

---

## 4. Hashing the key

Use a real hash function. **Do not** use `sum of bytes mod prime`. The standard modern non-cryptographic choice is **FNV-1a** (simple), **MurmurHash3** (better quality), or **xxHash** (very fast). FNV-1a is short enough to type from memory:

```c
// FNV-1a, 64-bit
static uint64_t hash_str(const char *s) {
    uint64_t h = 0xcbf29ce484222325ULL;  // FNV offset basis
    while (*s) {
        h ^= (uint8_t)*s++;
        h *= 0x100000001b3ULL;             // FNV prime
    }
    // mix once more so the low bits are good (we mask with cap-1)
    h ^= h >> 33;
    return h;
}
```

Why the extra `h ^= h >> 33`? Because `cap` is a power of two and we'll do `hash & (cap-1)` — which only looks at the low bits. FNV's low bits are mediocre; mixing pulls in entropy from the top. (This trick is sometimes called "fixing" or "finalizing" the hash; xxHash and Murmur both have explicit finalizers.)

> **Security note**: For untrusted inputs, FNV is vulnerable to *hash-collision DoS attacks* — an attacker who knows your hash function can craft keys that all land in the same bucket and turn O(1) lookups into O(n). Production servers use a **keyed** hash like SipHash, with the key randomized per process. Python switched to SipHash in 2012 after the famous collision-DoS papers. Rust's `HashMap` defaults to SipHash. You can build the table with FNV; you cannot ship the table with FNV.

---

## 5. Insertion (the heart of it)

```c
#include "hashmap.h"
#include <stdlib.h>
#include <string.h>

static bool hm_resize(HashMap *m, size_t new_cap);

// Find the slot where key belongs:
// - if found a LIVE slot with matching key: return that slot
// - else return the first TOMB or EMPTY slot we hit (for insertion)
static Entry *find_slot(HashMap *m, const char *key, uint64_t h) {
    size_t mask = m->cap - 1;
    size_t i    = (size_t)h & mask;
    Entry *first_tomb = NULL;

    for (;;) {
        Entry *e = &m->slots[i];
        if (e->state == SLOT_EMPTY) {
            return first_tomb ? first_tomb : e;
        }
        if (e->state == SLOT_TOMB) {
            if (!first_tomb) first_tomb = e;
        } else { // LIVE
            if (e->hash == h && strcmp(e->key, key) == 0) {
                return e;
            }
        }
        i = (i + 1) & mask;
    }
}

bool hm_init(HashMap *m, size_t initial_cap) {
    // round up to power of two
    size_t c = 8;
    while (c < initial_cap) c <<= 1;
    m->slots = (Entry*)calloc(c, sizeof(Entry));
    if (!m->slots) return false;
    m->cap = c;
    m->len = 0;
    m->tombs = 0;
    return true;
}

bool hm_put(HashMap *m, const char *key, void *value) {
    // Resize when load >= 75%. Tombstones count.
    if ((m->len + m->tombs) * 4 >= m->cap * 3) {
        // Choose new cap: double if live entries are most of the load,
        // keep size if tombstones dominate (resizing clears them).
        size_t new_cap = (m->len * 2 > m->cap) ? m->cap * 2 : m->cap;
        if (!hm_resize(m, new_cap)) return false;
    }
    uint64_t h = hash_str(key);
    Entry *e = find_slot(m, key, h);

    if (e->state == SLOT_LIVE) {
        // update existing
        e->value = value;
        return true;
    }

    // inserting into EMPTY or TOMB
    bool was_tomb = (e->state == SLOT_TOMB);
    e->state = SLOT_LIVE;
    e->hash  = h;
    e->key   = strdup(key);
    e->value = value;
    m->len++;
    if (was_tomb) m->tombs--;
    return true;
}
```

**Trace it mentally.** Insert `"a"`, `"b"`, `"c"` — assume they all hash to slot 3 (a real collision). Slot 3 takes `"a"`. Slot 4 takes `"b"`. Slot 5 takes `"c"`. Now look up `"b"`: hash → 3, probe 3 (`"a"`, miss), probe 4 (`"b"`, hit). Delete `"b"`: slot 4 becomes `TOMB`. Look up `"c"`: hash → 3, probe 3 (live miss), probe 4 (**tombstone — keep going**, do not stop), probe 5 (`"c"`, hit). This is exactly what tombstones buy you.

The `first_tomb` trick in `find_slot` is an optimization: when inserting, we prefer to reuse a tombstone slot encountered along the probe path rather than walking all the way to the empty slot. This keeps the table dense.

---

## 6. Lookup

```c
void *hm_get(HashMap *m, const char *key) {
    if (m->len == 0) return NULL;
    uint64_t h = hash_str(key);
    size_t mask = m->cap - 1;
    size_t i    = (size_t)h & mask;
    for (;;) {
        Entry *e = &m->slots[i];
        if (e->state == SLOT_EMPTY) return NULL;
        if (e->state == SLOT_LIVE && e->hash == h && strcmp(e->key, key) == 0) {
            return e->value;
        }
        i = (i + 1) & mask;
    }
}
```

A tight loop. Three things in the hot path:

1. The `EMPTY` check ends the search.
2. The cached `e->hash == h` is the cheap pre-filter that eliminates 99%+ of false candidates.
3. Only on hash match do we pay for `strcmp`.

On a well-distributed hash and load factor < 0.75, the average probe length is **< 2**. This is why open addressing is fast: in the common case, you hit your slot or the one next to it, and the array is in cache.

---

## 7. Deletion

```c
bool hm_del(HashMap *m, const char *key) {
    if (m->len == 0) return false;
    uint64_t h = hash_str(key);
    size_t mask = m->cap - 1;
    size_t i    = (size_t)h & mask;
    for (;;) {
        Entry *e = &m->slots[i];
        if (e->state == SLOT_EMPTY) return false;
        if (e->state == SLOT_LIVE && e->hash == h && strcmp(e->key, key) == 0) {
            free(e->key);
            e->key   = NULL;
            e->value = NULL;
            e->state = SLOT_TOMB;
            m->len--;
            m->tombs++;
            return true;
        }
        i = (i + 1) & mask;
    }
}
```

We do **not** clear the slot to `EMPTY`. That would break lookups that probed past it. We mark it `TOMB`, and the lookup/insert paths know to treat `TOMB` as "keep probing" but the insert path also remembers it for reuse.

Tombstones accumulate over delete-heavy workloads and slow down lookups. The cure is a periodic resize — which is conveniently the same machinery we already need for growth.

---

## 8. Resize (re-hashing everything)

```c
static bool hm_resize(HashMap *m, size_t new_cap) {
    Entry *old_slots = m->slots;
    size_t old_cap   = m->cap;

    Entry *new_slots = (Entry*)calloc(new_cap, sizeof(Entry));
    if (!new_slots) return false;

    m->slots = new_slots;
    m->cap   = new_cap;
    m->len   = 0;
    m->tombs = 0;

    // Re-insert every live entry. Tombstones are gone for free.
    for (size_t i = 0; i < old_cap; i++) {
        Entry *e = &old_slots[i];
        if (e->state != SLOT_LIVE) {
            // even tombstones may have already-freed keys, but our model
            // is keys are freed on deletion. EMPTY slots have NULL key.
            continue;
        }
        Entry *dst = find_slot(m, e->key, e->hash);
        dst->state = SLOT_LIVE;
        dst->hash  = e->hash;
        dst->key   = e->key;     // transfer ownership; do NOT strdup
        dst->value = e->value;
        m->len++;
    }
    free(old_slots);
    return true;
}

void hm_free(HashMap *m) {
    for (size_t i = 0; i < m->cap; i++) {
        if (m->slots[i].state == SLOT_LIVE) free(m->slots[i].key);
    }
    free(m->slots);
    m->slots = NULL;
    m->cap = m->len = m->tombs = 0;
}
```

Resize is O(n). Triggered occasionally (every ~75% load), the *amortized* cost per insert is O(1). This is the same amortized argument as the dynamic array's growth.

Notice the two-pronged resize trigger in `hm_put`:

- If live entries themselves push load over 0.75 → **double** the table.
- If tombstones push us over but live entries are sparse → **keep the same size** and just rebuild. This handles delete-heavy patterns without unbounded growth.

This nuance is exactly the kind of detail that distinguishes a real implementation from a textbook sketch.

---

## 9. Complexity analysis

| Op | Average | Worst case | Notes |
|----|---------|------------|-------|
| `put` | O(1) amortized | O(n) | Worst case: catastrophic clustering or rare resize |
| `get` | O(1) | O(n) | Worst case: long probe chain |
| `del` | O(1) | O(n) | Same probing concern |
| `resize` | O(n) | O(n) | Triggered rarely |

The phrase "O(1) average" leans on **load factor**. Theoretical analysis (with a perfectly random hash) gives expected probe length of $\frac{1}{1 - \alpha}$ where $\alpha$ is the load factor. At $\alpha = 0.5$, average probe = 2. At $\alpha = 0.75$, average probe = 4. At $\alpha = 0.9$, average probe = 10. **This is why we resize at 0.75.**

> The exact constant `0.75` is a sensible default; Java's `HashMap` uses it; Rust's `hashbrown` uses 0.875 with a smarter probe scheme; Python `dict` uses around 0.66. The choice is a memory-vs-speed dial.

---

## 10. Common pitfalls

1. **Forgetting tombstones.** Most beginner implementations don't handle deletion at all, or clear the slot on delete. Both are wrong in subtle ways that pass small tests and break under load.

2. **Using a weak hash.** "Sum of char codes mod prime" or "key length" — both give pathological collision behavior. Use FNV-1a or better.

3. **Not caching the hash in the entry.** Every probe step then re-hashes or `strcmp`s. Caching the hash is a 5-10× lookup speedup on long keys.

4. **Power-of-two cap with `% cap` instead of `& (cap-1)`.** Modulo on a power-of-two is the same as masking — but mask is one instruction, modulo is dozens. Compilers usually optimize it, but be explicit.

5. **Using prime caps with `% cap`.** This works (and was the traditional advice when hash functions were bad) but it's slower and the gains are imaginary if your hash is decent. Modern thinking: use a good hash, then power-of-two caps.

6. **Triggering resize only on `len`.** Forget tombstones in the load calculation and a delete-heavy workload will run at 99% load forever, with probe chains of 100+. Always count `len + tombs`.

7. **Iterator invalidation.** A user iterating the map while you resize gets dangling pointers. Document this. (`std::unordered_map` makes this a contract; `HashMap` in Rust enforces it through the borrow checker.)

8. **String ownership.** Decide once and stick to it. Above, the map *owns* its keys (`strdup` on insert, `free` on delete/destroy). The other choice is "caller owns keys" — faster, but trickier. Don't mix them.

9. **Memory safety on `put` after `resize` fail.** Above, if `hm_resize` returns false, we abort the put and return false. The map is still consistent — but make sure of it. Production code adds careful unwinding.

---

## 11. Variations you'll encounter

- **Quadratic probing**: probe step $i^2$ instead of $i$. Reduces *primary clustering*. Slightly more complex.
- **Double hashing**: probe step = second hash of the key. Best clustering behavior; one extra hash per probe.
- **Robin Hood hashing**: when probing past a slot, if the existing entry has a shorter probe distance than the one you're inserting, **swap them** ("steal from the rich, give to the poor"). Distance-weighted balance; allows much higher load factors.
- **Hopscotch hashing**: each entry stays within a small neighborhood. Cache-friendly with hard probe-length bounds.
- **Cuckoo hashing**: two hash functions; on collision, kick the existing entry to its alternate position. O(1) worst-case lookup; rebuilds on insertion conflict.
- **SwissTable** (Abseil) / **hashbrown** (Rust): groups of 16 slots with SIMD parallel probe. The state-of-the-art design.
- **Chained hashing**: the old default. Still appropriate when entries are huge or have complex destructors, but no longer the right starting point.

---

## 12. Where this shows up in the real world

- **Compilers**: every symbol table.
- **Languages**: Python `dict`, JS objects, Ruby hashes, Java `HashMap`, Go map, Rust `HashMap`, Swift `Dictionary`.
- **Databases**: hash joins, hash aggregations, hash indexes.
- **Caches**: Redis, memcached are giant hash tables at heart.
- **Operating systems**: dentry caches, route caches, pid → process maps.
- **JITs**: V8 hides a hash table behind every JavaScript object's property accesses.

Every single one of these is an *open-addressed* hash table or evolving toward one. The mental model you build here generalizes immediately.

---

## 13. Going deeper

1. **Benchmark vs. `std::unordered_map` and `khash.h`.** You'll often beat `unordered_map` (which is required by the C++ standard to use chaining). You'll lose to `khash.h` and `hashbrown` — that's instructive too.
2. **Add iterators.** Forces you to think about what changes during resize.
3. **Make it generic.** In C, this means macros or a comparator/hasher function pointer pair. In Rust, generics + `Hash`/`Eq` traits.
4. **Implement Robin Hood probing.** It's about 30 extra lines and *much* better at high load.
5. **Read `hashbrown`'s source.** The state of the art. Note how it uses SIMD to check 16 slots in parallel.
6. **Read Malte Skarupke's blog posts on hash tables.** ("I Wrote The Fastest Hashtable.") This is the rabbit hole.

---

## 14. Industry context

- **Active debate**: Open addressing wins for almost every workload now, but there are still corners where chaining is correct (huge entries, custom destructors, types that *cannot* be moved). The Rust `HashMap` default was famously *changed* from a chained design to `hashbrown` in 1.36; the perf wins were dramatic enough that the standard library swapped its implementation.
- **Historical context**: Knuth analyzed open addressing in the 1960s. Chaining dominated the 80s-2000s because hash functions were bad and cache effects weren't yet the bottleneck (CPUs were close in speed to RAM). When the memory wall opened in the 2000s, cache-friendly open-addressed designs took over.
- **What a tech lead would ask**: "How does this behave on adversarial keys?" (your answer: collision-DoS, need SipHash for untrusted input) "What's your load factor and why?" (0.75, classic) "What's your deletion strategy and why does it actually work?" (tombstones, with the trace-it-through explanation above) "How do you handle iteration during mutation?" (you don't — iterators are invalidated on resize)
- **Forward-looking**: SIMD-augmented probing (SwissTable, hashbrown) and "rendezvous hashing" / "consistent hashing" variants for distributed contexts. The future of single-machine hash maps is *more* parallelism per probe (AVX-512 → 64 slots in one instruction).
- **Names worth knowing**: Donald Knuth (the original analysis), Pedro Celis (Robin Hood, 1986), Matt Kulukundis (SwissTable, the CppCon talk), Andrew Gallant (`burntsushi`, ripgrep's author, hashbrown contributor), Sebastiano Vigna (`fastutil`, hash-table research).

---

## 15. Self-check questions

1. Why do open addressing tables need tombstones, but chained tables don't?
2. Why is the load-factor trigger `(len + tombs)`, not just `len`?
3. Why cache `hash` in the entry rather than recomputing each probe step?
4. What attack does SipHash defend against that FNV-1a doesn't?
5. At load factor 0.75 with a good hash, what's the expected probe length?
6. When should resize keep the same cap rather than doubling?
7. Why is `& (cap-1)` correct only when `cap` is a power of two?

You're done when these flow.
