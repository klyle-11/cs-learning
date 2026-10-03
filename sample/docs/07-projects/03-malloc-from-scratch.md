# `malloc` From Scratch

> **What this teaches**: The user-space chapter of the operating system. After you've written a free-list allocator with split and coalesce, you understand the *cost* of every line of code that calls `malloc`, the *layout* of every C process's heap, and the *vocabulary* (fragmentation, alignment, brk, mmap, boundary tags) that production allocator literature assumes you have.

**Language**: C
**Effort**: 2–4 days. A weekend gets you a working allocator; the second weekend is making it not catastrophic.
**Companion reads**: 1.1 arena allocator (the simpler design), 7.2 KV store (calls `malloc` constantly — you'll want to know what it costs).

---

## 1. Why this matters

`malloc(n)` looks like a single function call. Inside, it is one of the most-tuned pieces of software on your machine — `glibc` `ptmalloc`, `jemalloc`, `mimalloc`, `tcmalloc` are each ~30–50k lines, the product of decades of work. The reason this exists is the question every general-purpose allocator must answer:

> *"Given a heap with some free regions of various sizes, where do I find a free block of exactly `n` bytes (or larger) — fast — without leaving the heap so fragmented that the next request fails?"*

Every design choice in a production allocator (size classes, thread-local caches, segregated free lists, slab allocators, mmap thresholds) is an answer to one of three sub-questions:

1. **How do we find a free block?** (Search strategy: first-fit, best-fit, segregated, …)
2. **How do we recombine adjacent free blocks?** (Coalescing — without it, fragmentation kills you in minutes.)
3. **How do we get more memory when we run out?** (`sbrk` for small, `mmap` for large.)

Writing a basic free-list allocator forces you to confront all three with no library to hide behind. After this exercise:

- The arena (1.1) makes sense as the design that *opts out* of all three problems.
- `mmap` vs. `malloc` ceases to be a vague distinction.
- You spot fragmentation-bait code in PRs ("we malloc 16 bytes in a loop and never free them in order").

---

## 2. The mental model

The heap is a contiguous region of memory you obtain from the OS. Inside that region, you maintain:

- A linked list (or trees, or buckets) of **free blocks**, each tagged with its size.
- A way to recognize the **adjacent block in memory** — so when you free a block, you can check whether its physical neighbors are also free and **coalesce** them into a bigger free block.

That second point is the killer requirement. A naïve "free list as singly-linked list of free blocks" does not know whether two free blocks are physically adjacent — they're just two entries in a list that could be anywhere. Without coalescing, every `malloc(8); free; malloc(8); free; …` cycle leaves a graveyard of 8-byte holes that can never service a 16-byte request.

The classical solution is the **boundary tag**: every block (free *and* allocated) stores its size at both ends. Free-then-coalesce becomes a constant-time operation: look at the bytes immediately before and after the freed block, read their boundary tags, decide whether to merge.

```
heap layout (Knuth boundary tags):

[ size|F  body... size|F ][ size|A  body... size|A ][ size|F ... size|F ]
  ↑                       ↑                          ↑
  free block              allocated block            free block

Each block has a header (size + free/alloc flag) and a footer (same).
When freeing the middle block:
  - read footer of previous block (just before this block's header) → is it free?
  - read header of next block (just after this block's footer) → is it free?
  - merge accordingly, update header/footer of resulting block.
```

This is the *entire* mechanism. Every other design (segregated lists, size classes, slabs) is an optimization layered on top.

---

## 3. The header layout

```c
// malloc.h
#include <stddef.h>

void *my_malloc(size_t size);
void  my_free(void *ptr);
void *my_realloc(void *ptr, size_t size);
void *my_calloc(size_t n, size_t size);
```

```c
// malloc_internal.h
#include <stdint.h>

#define WORD     sizeof(size_t)
#define ALIGN    16                  // x86_64 ABI requires 16-byte alignment
#define MIN_BLOCK 32                 // header + min payload + footer, all aligned

// header/footer share this shape; LSB is "allocated" flag
typedef size_t Tag;
#define TAG_SIZE(t)   ((t) & ~0x7)
#define TAG_ALLOC(t)  ((t) & 0x1)
#define MAKE_TAG(sz, alloc) (((sz) & ~0x7) | ((alloc) & 0x1))
```

Tags are `size_t` with the low 3 bits stolen for flags. This works because *every block size is a multiple of 8 (or 16)*, so the low bits are guaranteed zero.

Block layout (for a free block):

```
   offset
   0:  header     (Tag: size + alloc flag)
   8:  next_free  (pointer in free list)
   16: prev_free  (pointer in free list)
   ...
   size - 8: footer (Tag: same as header)
```

For an allocated block, `next_free`/`prev_free` are simply not used — that's the payload area returned to the caller. The minimum block size has to be large enough to hold header + two pointers + footer (32 bytes on x86_64).

---

## 4. Growing the heap

Two mechanisms, two regimes:

- **`sbrk`** (or `brk`) — grows the data segment. Cheap, but contiguous, and you can only release memory from the *top* of the segment.
- **`mmap`** — gets a fresh page region from the kernel. More expensive (page faults, TLB shootdown), but releasable individually with `munmap`.

Conventional split: **small allocations** (< ~128 KB) come from a `sbrk`-grown heap; **large allocations** get a dedicated `mmap` region with a 1-bit flag in the header marking them.

```c
#include <sys/mman.h>
#include <unistd.h>

static void *grow_heap(size_t bytes) {
    void *p = sbrk(bytes);
    return p == (void*)-1 ? NULL : p;
}

static void *big_mmap(size_t bytes) {
    void *p = mmap(NULL, bytes, PROT_READ|PROT_WRITE,
                   MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
    return p == MAP_FAILED ? NULL : p;
}
```

`sbrk` is technically deprecated in favor of `mmap` everywhere, but for teaching purposes it's clearer — it gives you a literal "grow the heap" knob.

---

## 5. The free list

Maintain a doubly-linked list of free blocks. The simplest design: one global list, sorted by address. Allocation walks the list looking for a fit.

```c
static Tag    *heap_start;
static FreeNode *free_head;

typedef struct FreeNode {
    struct FreeNode *next, *prev;
} FreeNode;

static FreeNode *block_payload(Tag *header) {
    return (FreeNode*)(header + 1);
}
static Tag *block_footer(Tag *header) {
    size_t sz = TAG_SIZE(*header);
    return (Tag*)((char*)header + sz - WORD);
}
static Tag *block_next(Tag *header) {
    size_t sz = TAG_SIZE(*header);
    return (Tag*)((char*)header + sz);
}
static Tag *block_prev(Tag *header) {
    Tag *prev_footer = header - 1;
    size_t sz = TAG_SIZE(*prev_footer);
    return (Tag*)((char*)header - sz);
}
```

These three navigation helpers are the heart of boundary-tag manipulation. `block_prev` is what makes coalescing-on-free possible — given any block, you can find the one immediately before it in memory by reading the previous footer.

---

## 6. Allocation: first-fit

```c
static size_t align_up(size_t n, size_t a) {
    return (n + a - 1) & ~(a - 1);
}

void *my_malloc(size_t size) {
    if (size == 0) return NULL;
    size_t total = align_up(size + 2*WORD, ALIGN);
    if (total < MIN_BLOCK) total = MIN_BLOCK;

    if (total >= MMAP_THRESHOLD) return mmap_alloc(total);

    // first-fit search
    for (FreeNode *n = free_head; n; n = n->next) {
        Tag *h = (Tag*)n - 1;                    // header is one word before payload
        size_t blk = TAG_SIZE(*h);
        if (blk >= total) {
            split_and_place(h, total);
            return n;
        }
    }
    // grow heap
    Tag *h = grow_to_fit(total);
    if (!h) return NULL;
    split_and_place(h, total);
    return block_payload(h);
}

static void split_and_place(Tag *h, size_t need) {
    size_t blk = TAG_SIZE(*h);
    if (blk - need >= MIN_BLOCK) {
        // split: turn the tail into a new free block
        *h = MAKE_TAG(need, 1);
        *block_footer(h) = *h;
        Tag *tail = block_next(h);
        *tail = MAKE_TAG(blk - need, 0);
        *block_footer(tail) = *tail;
        free_list_remove(block_payload(h));         // was in the free list
        free_list_insert(block_payload(tail));
    } else {
        // take the whole block
        *h = MAKE_TAG(blk, 1);
        *block_footer(h) = *h;
        free_list_remove(block_payload(h));
    }
}
```

**First-fit** is the simplest search strategy. Other choices:

- **Best-fit**: search the whole list for the smallest block that fits. Lower fragmentation, higher search cost.
- **Next-fit**: like first-fit but resume from where the last search ended. Better locality.
- **Segregated lists**: one free list per size class. Constant-time search at the cost of memory.

`dlmalloc` (Doug Lea's original) uses segregated lists with smart small-bin / large-bin handling. Your version doesn't need to.

---

## 7. Free with coalescing

```c
void my_free(void *p) {
    if (!p) return;
    Tag *h = (Tag*)p - 1;
    if (is_mmaped(h)) { mmap_free(h); return; }

    size_t blk = TAG_SIZE(*h);

    // look at neighbors
    int prev_free = (h != heap_start) && !TAG_ALLOC(*(h - 1));
    int next_free = (block_next(h) < heap_end) && !TAG_ALLOC(*block_next(h));

    if (prev_free && next_free) {
        Tag *prev = block_prev(h);
        Tag *next = block_next(h);
        size_t total = TAG_SIZE(*prev) + blk + TAG_SIZE(*next);
        free_list_remove(block_payload(prev));
        free_list_remove(block_payload(next));
        *prev = MAKE_TAG(total, 0);
        *block_footer(prev) = *prev;
        free_list_insert(block_payload(prev));
    } else if (prev_free) {
        Tag *prev = block_prev(h);
        size_t total = TAG_SIZE(*prev) + blk;
        free_list_remove(block_payload(prev));
        *prev = MAKE_TAG(total, 0);
        *block_footer(prev) = *prev;
        free_list_insert(block_payload(prev));
    } else if (next_free) {
        Tag *next = block_next(h);
        size_t total = blk + TAG_SIZE(*next);
        free_list_remove(block_payload(next));
        *h = MAKE_TAG(total, 0);
        *block_footer(h) = *h;
        free_list_insert(block_payload(h));
    } else {
        *h = MAKE_TAG(blk, 0);
        *block_footer(h) = *h;
        free_list_insert(block_payload(h));
    }
}
```

That's the whole free path. **The four-case if** (both-neighbors-free / left-free / right-free / neither) is the canonical Knuth coalescing pattern. Every textbook allocator chapter has this same diamond, written the same way.

---

## 8. Realloc

`realloc(p, n)` has three good outcomes:

1. **Shrink in place**: split off the tail, return a free block.
2. **Grow in place using next-block-if-free**: coalesce with next, mark allocated.
3. **Move**: `malloc(n)` + `memcpy(min(old, new))` + `free(old)`.

The "grow in place via next block" optimization is what saves vectors from `O(n²)` total allocation cost when they're growing in a loop. Don't skip it.

---

## 9. Operation walkthroughs

### Allocation cost (first-fit, in-heap, no split)

```
align_up:         1 add, 1 and
free list search: N iterations, each: 1 load, 1 cmp, 1 branch
remove from list: 4 stores (doubly-linked)
mark allocated:   2 stores (header + footer)
```

For a few-element free list, ~20 instructions. For a list of 10k blocks with bad fit luck, much worse — this is exactly why production allocators use segregated lists.

### Free cost

Always `O(1)` with boundary tags + doubly-linked free list — neighbor check is constant-time (read two adjacent words), list removal is constant-time, insertion is constant-time. This is the asymmetry that makes free-list allocators viable: `malloc` is `O(N)` worst case but `free` is `O(1)`.

### Memory overhead

- Header (8 bytes) + footer (8 bytes) per block = 16 bytes minimum.
- For lots of small allocations, 16 bytes of overhead per 16-byte payload is 50% wasted space. **This is why production allocators have a separate "small allocation" path** (`tcmalloc`, `jemalloc`) with no per-block header — they store size implicitly via segregation into pages of uniform block size.

---

## 10. Common pitfalls

1. **Forgetting alignment.** Returning a payload pointer that isn't 16-byte-aligned crashes SSE/AVX loads. Pad your header so payload starts aligned.
2. **Header overflow on overflowed size.** `malloc(SIZE_MAX)` should return NULL, not wrap around in `align_up` and corrupt the heap. Check before adding.
3. **Coalescing across the heap boundary.** Never read `*(heap_start - 1)` — that's not your memory. Sentinel blocks at both ends are the standard fix: place permanent "allocated" zero-payload blocks at the boundaries so the neighbor check always reads valid data.
4. **Double free.** With boundary tags, a double free corrupts the heap. Production allocators detect this with a magic number in the header, or by walking the free list. Educational versions just crash, with an "I'll add this later" comment.
5. **Free-list cycles.** A single missing `prev` update on insert/remove will create a loop, and your next search hangs. `malloc_consistency_check()` is a great function to write early.
6. **Mixing `mmap`'d blocks with the free list.** They live outside the heap; `block_prev`/`block_next` are meaningless. Tag with a high-bit flag and handle separately on `free`.
7. **Returning `NULL` payload vs. `NULL` header.** The user gets a pointer to the body, but you compute everything in terms of the header. One of the most common off-by-one bugs.

---

## 11. Variations you'll encounter in the wild

- **`dlmalloc`** (Doug Lea) — the canonical reference implementation. ~5k lines, fantastically commented. Read it after yours works.
- **`ptmalloc2`** — `dlmalloc` adapted for threads, ships in `glibc`. Per-thread arenas, lots of locks.
- **`jemalloc`** (Jason Evans, FreeBSD/Facebook) — size-class-based, low fragmentation, very good multithread scaling.
- **`tcmalloc`** (Google) — thread-cached, very fast for small allocations, lock-free fast paths.
- **`mimalloc`** (Microsoft) — recent, page-based, free list sharding. Currently the highest-performing on many benchmarks.
- **`scudo`** (LLVM) — hardened allocator with security mitigations. The one Android, Fuchsia, and (parts of) Chrome use.
- **`bdwgc`** (Boehm-Demers-Weiser) — *conservative* garbage collector that *also* acts as a `malloc`. Different design space entirely.

---

## 12. Where this shows up in the real world

- Every C/C++/Rust program you have ever run uses one of these allocators.
- **Heap-spray exploits** target allocator metadata — boundary tag forgery, free-list pointer hijacking. Hardened allocators (scudo, GWP-ASan) randomize and sanity-check.
- **Memory fragmentation in long-running servers** (Redis, Postgres) is famous enough that several teams have moved to jemalloc specifically to combat it.
- **GPU allocators** face the same problems with no `mmap` analog — the entire VRAM region is one slab, and game engines ship custom allocators per system.
- **Kernel allocators** (Linux `kmalloc`, the slab allocator) are the in-kernel sibling of all of this.

---

## 13. Going deeper

1. **Add segregated free lists.** One list per size class (8, 16, 24, 32, 48, 64, …, log-binned above). Allocation becomes nearly `O(1)`.
2. **Add a `mremap`-backed grow path for large blocks.** Real `realloc` on Linux uses this for `mmap`'d blocks — kernel does the work.
3. **Replace boundary tags with a separate metadata table.** Saves 16 bytes per allocation for small objects, at the cost of indirection on free. This is the `tcmalloc` design.
4. **Add a debug mode with magic numbers and canaries.** Detect double-free, write-past-end, and use-after-free.
5. **Read Doug Lea's `dlmalloc.c`.** Annotate every section as you go; understand it section by section.
6. **Read CSAPP chapter 9.** The textbook treatment most allocator developers learned from.

---

## 14. Industry context

> Allocator design has periodic revolutions. We're in one now (last decade): per-thread caches, page-based allocation, hardening against use-after-free. The previous revolution (1990s) was Doug Lea's `dlmalloc`; before that, every Unix had its own allocator and they were all bad.

- **Active debate**: "Should the language runtime own allocation?" — Rust's `Allocator` trait, Zig's first-class allocator parameters, and Go's runtime-owned allocator are three answers. The C answer (one global allocator chosen at link time) is increasingly seen as legacy.
- **Historical context**: Knuth (TAOCP vol. 1, 1968) wrote the boundary-tag algorithm. Doug Lea's `dlmalloc` (1987–2012) is what everyone's mental model is based on. `jemalloc` (2005, Facebook 2010) made per-CPU allocators mainstream.
- **What a tech lead would ask**: "Worst-case allocation time?" (`O(N)` in your list; `O(log N)` for tree-bucketed best-fit; `O(1)` for size-segregated.) "Memory fragmentation under sustained mixed-size load?" (Run a real workload; instrumented allocator dumps are the only way to know.) "How does it scale to 64 threads?" (Yours: badly. Production: per-thread arenas, sharded free lists.)
- **Forward-looking**: Hardware-tagged memory (ARM MTE) makes use-after-free *detectable in hardware* and is showing up in Android. Allocators are being rewritten to take advantage.
- **Names worth knowing**: Doug Lea (`dlmalloc`), Jason Evans (`jemalloc`), Sanjay Ghemawat (`tcmalloc`), Daan Leijen (`mimalloc`), Kostya Serebryany (AddressSanitizer / scudo).

---

## 15. Self-check questions

1. Why do boundary tags appear at both ends of a block, not just the head?
2. Why is the minimum block size strictly larger than the requested minimum payload?
3. Why must allocations be 16-byte aligned on x86_64 even when the user asks for 5 bytes?
4. What does coalescing buy us in terms of fragmentation behavior?
5. Why are large allocations (`> ~128 KB`) often handled by `mmap` instead of from the heap?
6. Why is `free` `O(1)` while `malloc` can be `O(N)`?
7. Why are production allocators per-thread instead of one global allocator with a mutex?

If you can answer these, you have a level of allocator literacy higher than 95% of working C programmers.
