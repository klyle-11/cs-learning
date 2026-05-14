# Bump / Arena Allocator

> **What this teaches**: Lifetime as a *region*, not a *graph*. Why game engines, compilers, and request-scoped servers reach for arenas before they reach for `malloc`. Why "free" is sometimes the wrong primitive.

**Language**: C
**Effort**: half a day to write; a week to internalize where else it applies
**Companion reads**: 1.2 free-list allocator (the opposite design), 1.4 string interner (an arena composed with a hash table)

---

## 1. Why this matters

A general-purpose allocator like `malloc` has to answer a hard question every call: *"Where can I find a free block of exactly this size?"* That bookkeeping — free lists, size classes, coalescing — is what makes general allocators slow and what makes their internal state complex enough to be a security surface (heap-spray exploits, double-free bugs, use-after-free).

An **arena** asks a simpler question: *"What's the next byte?"* It bumps a pointer forward. Allocation is two or three instructions. There is no per-object free — you free **the whole arena** at once, all at the end.

This works whenever objects share a **lifetime**:

- All objects produced during one HTTP request, freed when the response is written.
- All AST nodes produced during one compile, freed when codegen finishes.
- All temporary geometry produced during one frame, freed when the frame is presented.

When the lifetime is uniform, an arena is **faster**, **simpler**, and **safer** than `malloc`/`free`. You cannot leak (the arena frees everything). You cannot double-free (there is no per-object free). You cannot use-after-free *across* arenas (the lifetime is the arena).

This is why every serious compiler (LLVM's `BumpPtrAllocator`, Zig's `ArenaAllocator`, Rust's `bumpalo`, the V8 zone allocator) ships with one.

---

## 2. The mental model

Imagine a long flat slab of memory. You have one pointer, `cursor`, pointing somewhere into it. To allocate `n` bytes, you return `cursor` and add `n` to it. To free *everything*, you reset `cursor` to the start.

```
[xxxxxxxxxxxxxxxxxxx....................................]
 ^                  ^                                    ^
 base               cursor                               end

allocate(n):
  if cursor + n > end: fail (or grow)
  p = cursor
  cursor += n
  return p

reset():
  cursor = base
```

Three subtleties hide in that picture:

1. **Alignment**. Modern CPUs penalize or fault on misaligned loads. You must round `cursor` up to the required alignment *before* you bump it.
2. **Growth**. A fixed slab eventually fills. Real arenas keep a linked list of *chunks*; when one fills, they allocate another.
3. **No individual free**. You cannot give back one allocation. Either accept this discipline or you don't have an arena.

The "no individual free" is the *feature*, not a limitation. It is exactly what makes the allocator fast and safe.

---

## 3. Minimal arena (single chunk, no growth)

We'll build this in three layers: minimal → chunked → with savepoints. Each layer earns its complexity.

```c
// arena.h
#ifndef ARENA_H
#define ARENA_H

#include <stddef.h>
#include <stdint.h>

typedef struct Arena {
    uint8_t *base;     // start of the slab
    uint8_t *cursor;   // next free byte
    uint8_t *end;      // one past the last usable byte
} Arena;

void arena_init(Arena *a, void *buf, size_t cap);
void *arena_alloc(Arena *a, size_t size, size_t align);
void arena_reset(Arena *a);

// convenience macro: allocate one T from arena `a`
#define ARENA_NEW(a, T) ((T*)arena_alloc((a), sizeof(T), _Alignof(T)))

#endif
```

```c
// arena.c
#include "arena.h"
#include <stdint.h>
#include <stddef.h>

static uintptr_t align_up(uintptr_t x, size_t align) {
    // align must be a power of two
    return (x + (align - 1)) & ~(uintptr_t)(align - 1);
}

void arena_init(Arena *a, void *buf, size_t cap) {
    a->base   = (uint8_t*)buf;
    a->cursor = (uint8_t*)buf;
    a->end    = (uint8_t*)buf + cap;
}

void *arena_alloc(Arena *a, size_t size, size_t align) {
    uintptr_t raw     = (uintptr_t)a->cursor;
    uintptr_t aligned = align_up(raw, align);
    uintptr_t next    = aligned + size;
    if (next > (uintptr_t)a->end) return NULL; // out of memory
    a->cursor = (uint8_t*)next;
    return (void*)aligned;
}

void arena_reset(Arena *a) {
    a->cursor = a->base;
}
```

**Read it carefully.** Every line earns its keep:

- `align_up` uses the classic bitmask trick. `align` must be a power of two — every alignment a hardware ever requires is. The mask `~(align - 1)` clears the low bits.
- `arena_alloc` *first* aligns, *then* adds size. Aligning the cursor *after* allocating is a subtle bug — the returned pointer would point at unaligned memory.
- The overflow check is `next > end`. **Don't** write `cursor + size > end` — if `size` is attacker-controlled it can overflow `cursor + size` and bypass the check. (We're using `uintptr_t` arithmetic, but the principle generalizes; for `size_t` you'd write `size > (size_t)(end - cursor)`.)
- `arena_reset` is the entire deallocation story: one pointer assignment. **This is the whole point.**

### Using it

```c
#include "arena.h"
#include <stdio.h>

typedef struct Point { float x, y, z; } Point;

int main(void) {
    static uint8_t backing[64 * 1024];   // 64 KB stack-static slab
    Arena a;
    arena_init(&a, backing, sizeof backing);

    Point *p = ARENA_NEW(&a, Point);
    p->x = 1.0f; p->y = 2.0f; p->z = 3.0f;

    char *msg = (char*)arena_alloc(&a, 32, 1);
    snprintf(msg, 32, "point=(%g,%g,%g)", p->x, p->y, p->z);
    puts(msg);

    arena_reset(&a);   // frees `p` and `msg` simultaneously
}
```

That's a complete arena. You can ship this and it will work for many use cases — request scopes, frame allocations, parser scratch space.

---

## 4. The chunked arena (handles growth)

The minimal arena dies when it fills. A real arena keeps a linked list of chunks; when one runs out, it grabs another from the system.

```c
// arena.h additions
typedef struct ArenaChunk ArenaChunk;
struct ArenaChunk {
    ArenaChunk *next;
    uint8_t    *cursor;
    uint8_t    *end;
    // followed in memory by the chunk's storage
};

typedef struct ChunkedArena {
    ArenaChunk *head;        // most recently allocated chunk (the "active" one)
    size_t      chunk_size;  // default new-chunk size
} ChunkedArena;

void  chunked_arena_init(ChunkedArena *a, size_t chunk_size);
void *chunked_arena_alloc(ChunkedArena *a, size_t size, size_t align);
void  chunked_arena_destroy(ChunkedArena *a);
```

```c
// arena.c additions
#include <stdlib.h>
#include <string.h>

static ArenaChunk *new_chunk(size_t payload) {
    ArenaChunk *c = (ArenaChunk*)malloc(sizeof(ArenaChunk) + payload);
    if (!c) return NULL;
    uint8_t *data = (uint8_t*)(c + 1);
    c->cursor = data;
    c->end    = data + payload;
    c->next   = NULL;
    return c;
}

void chunked_arena_init(ChunkedArena *a, size_t chunk_size) {
    a->head = NULL;
    a->chunk_size = chunk_size;
}

void *chunked_arena_alloc(ChunkedArena *a, size_t size, size_t align) {
    // try the active chunk first
    if (a->head) {
        uintptr_t aligned = align_up((uintptr_t)a->head->cursor, align);
        uintptr_t next    = aligned + size;
        if (next <= (uintptr_t)a->head->end) {
            a->head->cursor = (uint8_t*)next;
            return (void*)aligned;
        }
    }
    // need a new chunk. Big allocations get their own chunk to avoid waste.
    size_t want = (size + align > a->chunk_size) ? size + align : a->chunk_size;
    ArenaChunk *c = new_chunk(want);
    if (!c) return NULL;
    c->next = a->head;
    a->head = c;

    uintptr_t aligned = align_up((uintptr_t)c->cursor, align);
    c->cursor = (uint8_t*)(aligned + size);
    return (void*)aligned;
}

void chunked_arena_destroy(ChunkedArena *a) {
    ArenaChunk *c = a->head;
    while (c) {
        ArenaChunk *next = c->next;
        free(c);
        c = next;
    }
    a->head = NULL;
}
```

Two design decisions worth flagging:

- **Big allocations get their own chunk.** If you request 10 MB out of a 64 KB-default arena, we don't try to grow the active chunk — we allocate a one-off chunk just for that. This keeps the average chunk full and avoids wasting space.
- **New chunks are pushed at the head.** Future allocations go into the *newest* chunk. Older chunks may still have unused bytes — accepted waste in exchange for never having to search.

The "search the chunk list for space" alternative is what gets you back into `malloc` territory. Don't do it.

---

## 5. The savepoint pattern (the killer feature)

Once you have an arena, you get something `malloc` cannot easily give you: **scoped sub-lifetimes**.

```c
typedef struct ArenaSavepoint {
    ArenaChunk *chunk;
    uint8_t    *cursor;
} ArenaSavepoint;

ArenaSavepoint arena_save(ChunkedArena *a) {
    ArenaSavepoint s = { a->head, a->head ? a->head->cursor : NULL };
    return s;
}

void arena_restore(ChunkedArena *a, ArenaSavepoint s) {
    // free chunks newer than the savepoint
    while (a->head && a->head != s.chunk) {
        ArenaChunk *next = a->head->next;
        free(a->head);
        a->head = next;
    }
    if (a->head) a->head->cursor = s.cursor;
}
```

This is the move:

```c
ArenaSavepoint s = arena_save(&arena);
// ... do a bunch of temporary work, allocating freely
arena_restore(&arena, s);     // all of it gone, one pointer rewind
```

This pattern is **how modern compilers handle speculative parsing**. Parse an expression speculatively; if it doesn't match the grammar, rewind the arena. No bookkeeping, no leak, no cleanup code.

---

## 6. Operation walkthroughs

### Allocation cost

For an allocation that fits in the active chunk:

```
align_up:     1 add, 1 and       — branch-free
overflow check: 1 compare        — predictable branch
cursor update: 1 add, 1 store    — ~2 cycles
return:       1 mov              — pointer in a register
```

Five or six instructions, all dependent only on the cursor (which is hot in L1). Compare to `malloc`, which has to search free lists, possibly take a lock, possibly call `sbrk`/`mmap`. The win is not 2× — it's often 50–100×.

### Reset cost

`O(1)` for the single-chunk arena. `O(#chunks)` for the chunked arena if you free them, `O(1)` if you keep them around and just reset cursors (a common optimization: **reuse chunks across resets**).

### Memory overhead

- **Wasted space at end of chunks**: at most `chunk_size` bytes per arena, on average half that. Tunable: bigger chunks = less metadata, more potential waste.
- **Per-chunk header**: ~24–32 bytes. Negligible if `chunk_size` is in the KB range.
- **No per-allocation metadata.** None. `malloc` typically prepends 16–32 bytes of bookkeeping to every allocation; arenas don't.

For a parser allocating millions of 16-byte AST nodes, the savings are *significant* — `malloc` would double the memory footprint just on headers.

---

## 7. Common pitfalls (you will hit at least two of these)

1. **Forgetting alignment.** You allocate three `char`s, then a `double`. The `double` is on a one-byte-aligned address. On x86 it works but is slower; on some ARM configurations it crashes. Always pass `_Alignof(T)` (C11) or the equivalent.

2. **Aligning after instead of before allocating.** `cursor += size; cursor = align(cursor)` returns a pointer to *aligned padding*, not aligned data. Align first.

3. **Returning a pointer that survives `arena_reset`.** This is a use-after-free, full stop. The compiler can't help you. Discipline must.

4. **Storing pointers into the arena from objects that outlive it.** Cache invalidation in disguise. If a long-lived map holds keys allocated in a short-lived arena, you have a dangling-key bug as soon as the arena resets.

5. **Overflow in the bounds check.** Already covered above. Pay attention.

6. **`malloc`-shaped thinking.** Trying to add a `free(ptr)` to an arena defeats it. If you find yourself wanting per-object free, you wanted a free-list allocator (1.2), not an arena.

7. **Threading.** The arena above is not thread-safe. The standard fix is **one arena per thread**, not "wrap allocate in a mutex." If two threads need to share results, they copy across arenas.

---

## 8. Variations you'll encounter in the wild

- **Linear allocator** — same as arena but with no per-chunk `next` pointer; just a single grown buffer. Slightly faster, less robust.
- **Stack allocator** — arena where `free` *does* work, but only in LIFO order. Useful for temporary scratch.
- **Pool allocator** — fixed-size slots in a free list. Fast like an arena, but supports per-object free, and only for one size class.
- **Slab allocator** — Linux kernel object cache. Per-size-class pools with constructors. The same idea, hardened.
- **Region allocator** — arenas with explicit lifetime tracking checked by a compiler (Cyclone, MLton, parts of Rust's `'arena` patterns).
- **Bumpalo** (Rust) — production-grade arena crate. Read the source after you build yours.
- **LLVM `BumpPtrAllocator`** — production arena inside a major compiler. About 150 lines.

---

## 9. Where this shows up in the real world

- **Compilers**: Clang, GCC, Roslyn, the Rust compiler — all use arenas for AST/IR nodes. Lifetime = "one translation unit" or "one query."
- **Game engines**: per-frame allocators (Unity's `Allocator.TempJob`, Unreal's `FMemStack`). Lifetime = "one frame." Reset every frame, zero free calls.
- **Web servers**: nginx's `ngx_pool_t`. Lifetime = "one request." Apache's `apr_pool_t` likewise.
- **Databases**: query execution scratch in Postgres (`MemoryContext` — actually a tree of arenas).
- **Protocol parsers**: Wireshark dissectors allocate from a per-packet arena.

Once you see the pattern, you see it everywhere. *Lifetimes are usually coarse-grained*, and matching the allocator to the lifetime structure of the program is one of the highest-leverage performance moves available.

---

## 10. Going deeper

After you have this working, try these in order:

1. **Make it thread-safe with `_Thread_local` arenas.** Each thread gets its own; no locking. This is how serious systems do it.
2. **Add a "reset to savepoint" benchmark** — measure how fast you can checkpoint/rewind. You'll see why speculative parsing is cheap with arenas.
3. **Build the string interner (1.4) on top.** A hash table whose keys are allocated in the arena. Strings have arena lifetime; lookup is pointer compare.
4. **Read LLVM's `BumpPtrAllocator.h`.** ~150 lines. Compare to yours.
5. **Read [Per Vognsen's "bitwise" stream](https://www.youtube.com/c/pervognsen) on arena allocators** — closest thing to watching a senior systems engineer think out loud about allocator design.
6. **Read about *generational* arenas** — multiple arenas with different reset frequencies. The pattern Postgres uses, the pattern V8 uses for its young/old generation in a different shape.

---

## 11. Industry context

> Allocator design is one of the deepest topics in systems engineering, and arenas are the gateway drug. Below is the kind of discussion that would happen in a senior PR review.

- **Active debate**: "Use the system allocator everywhere" (mimalloc/jemalloc are *very* good now) vs. "use specialized allocators per subsystem." The compiler/game-engine/DB world sided with specialized arenas long ago; many web-backend teams still default to system allocators and lose 10–30% on workloads that should be using arenas.
- **Historical context**: Apache's pool allocators (early 1995s) were one of the first widely visible arenas in a long-running server. Hans Boehm's conservative GC paper named "region inference" as the academic version of the same idea. The Cyclone language (Dan Grossman, Greg Morrisett) made regions a *type-system* concept, which is the direct ancestor of Rust's lifetimes.
- **What a tech lead would ask**: "How do you handle giant outlier allocations?" (your answer: dedicated chunks) "What happens under heap pressure on a hot path that doesn't reset?" (your answer: nothing good — arenas are bad fits for indefinite-lifetime workloads) "Is it thread-safe?" (your answer: no, by design — one per thread)
- **Forward-looking**: Rust's `bumpalo`, Zig's `std.heap.ArenaAllocator`, and Go's experimental `arena` package (currently disabled but actively researched) all show that mainstream languages are absorbing this pattern. Knowing it gives you advance literacy.
- **Names worth knowing**: Per Vognsen (bitwise), Andrei Alexandrescu (allocator-design talks), Casey Muratori (Handmade Hero — arena-based game engine in public), Daniel Lemire (numeric performance, includes arena content).

---

## 12. Self-check questions

Before declaring yourself done, can you answer these without looking?

1. Why must you align *before* bumping, not after?
2. Why is the bounds check `next > end` and not `cursor + size > end`?
3. Why don't arenas typically support per-object free?
4. Why is a per-thread arena the standard approach to thread safety?
5. What's the worst-case wasted-space-per-chunk in the chunked design?
6. Name three real systems that use arenas in production.
7. What's the savepoint pattern good for?

If you can answer these crisply, you've gotten what this exercise gives.
