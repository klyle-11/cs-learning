# Lesson 01 — Dynamic Array

How `const arr = []; arr.push(x)` actually works.

---

## The thing you take for granted

In JavaScript:

```js
const arr = [];
arr.push(1);
arr.push(2);
arr.push(3);
console.log(arr.length);   // 3
console.log(arr[1]);       // 2
arr[100] = 'hi';           // also fine somehow
```

This appears to be one thing — *"an array"* — but it's hiding three pieces of machinery you've never had to think about:

1. **Memory**: where do those values physically live in RAM?
2. **Growth**: `arr` had room for 0 things and somehow has 101 now. When did the buffer change, and how?
3. **Indexing**: how does `arr[1]` find the right byte in memory in constant time?

C exposes all three. By the end of this lesson, you'll have built the thing JavaScript builds for you, and you'll never look at `.push()` the same way.

---

## Foundation 1: what memory actually is

RAM is a giant numbered array of bytes. Every byte has an address. The CPU's only memory operations are *"give me the byte at address N"* and *"store this byte at address N."* That's it.

When you write `int x = 42;` in C, what happens is:

- The compiler picks an address (say, address 100).
- It generates a store instruction that puts the 4 bytes representing 42 starting at address 100.
- The name `x` is just a label for "the value at address 100." It doesn't exist at runtime.

A **pointer** is a variable that holds an address. `int *p = &x;` means "p holds the value 100."

An **array** in C is *contiguous* memory. Ten ints means 40 bytes in a row. `arr[3]` compiles down to literal arithmetic: `(address of arr) + 3 * sizeof(int)`, then load. This is why array indexing is O(1) — it's not a search, it's one multiplication and one load.

## Foundation 2: where C gets memory from

Local variables live on the **stack**, which is fixed-size and scoped to the function call. If you want memory whose size you don't know at compile time — like an array that might grow — you ask the operating system for it. The function is `malloc`:

```c
int *buffer = malloc(10 * sizeof(int));  // give me 40 bytes, return the address
```

`malloc` returns a pointer to a chunk of memory on the **heap**. When you're done, you call `free(buffer)` to return it. **If you forget to free, the memory stays allocated forever — that's a memory leak.** If you free the same pointer twice or use it after freeing, your program is corrupted (and on a bad day, exploitable).

JavaScript has a garbage collector that does all this for you. C does not. This is the first abstraction that goes away when you leave a managed language. It is also why so many CVEs are written in C.

## Foundation 3: the problem dynamic arrays solve

A fixed-size C array is rigid:

```c
int arr[10];  // ten ints. Forever. Try to use arr[10]: undefined behavior.
```

What if you don't know how many elements you'll need? You could allocate a huge buffer "just in case" — wasteful and still bounded. Or, you could allocate a small buffer and *grow it on demand.* That's a dynamic array.

The interface looks like a JS array — make one, push, get, length, free — but under the hood we need three things:

- A pointer to a heap buffer
- A count of how many slots are in use (`len`)
- A count of how many slots exist total (`cap`)

When `len == cap`, we're full — push has to grow the buffer.

## The crucial design choice: how much do we grow?

**Naive approach**: grow by 1 each time. This is a disaster. Pushing N elements means N reallocations, each potentially copying the entire buffer to a new location. Total work: 1 + 2 + 3 + … + N = O(N²).

**The fix**: double the capacity each time we grow.

Now pushing N elements triggers only log₂(N) reallocations. The total copying work across all of them is N + N/2 + N/4 + … < 2N — *linear in N*, meaning each push is O(1) **amortized** (averaged over many pushes).

This is why `arr.push()` feels free in JavaScript. It isn't free — but the cost is spread thin enough that you never notice.

You'll see this play out concretely when you run the test: 1000 pushes, only 8 growths.

---

## Walking the code

Three files:

- **`dyn_array.h`** — the interface. Read this first.
- **`dyn_array.c`** — the implementation. Six short functions.
- **`test.c`** — exercises everything and prints the growth pattern.

### The struct (in the header)

The struct is intentionally exposed, not hidden behind an opaque pointer, because the *whole point* is to see the three fields that make this work:

```c
typedef struct {
    int    *data;   // the heap buffer
    size_t  len;    // how many ints are in use
    size_t  cap;    // how many ints the buffer can hold
} DynArray;
```

If you remember nothing else from this lesson: **a dynamic array is a pointer, a length, and a capacity.** Every dynamic-array implementation in every language — JS arrays, Python lists, Rust `Vec`, Go slices, C++ `std::vector` — is some elaboration on this triple.

### The grow function (the heart)

```c
static bool da_grow(DynArray *a, size_t new_cap) {
    int *new_data = realloc(a->data, new_cap * sizeof(int));
    if (new_data == NULL) return false;
    a->data = new_data;
    a->cap = new_cap;
    return true;
}
```

`realloc` does three things in one call: tries to extend the existing buffer in place; if it can't, allocates a new larger buffer, copies the old data over, frees the old buffer. It returns NULL on failure — and crucially, on failure the *original* buffer is still valid. That's why we check before assigning.

### Push (two lines of real logic)

```c
bool da_push(DynArray *a, int value) {
    if (a->len == a->cap) {
        size_t new_cap = (a->cap == 0) ? INITIAL_CAP : a->cap * 2;
        if (!da_grow(a, new_cap)) return false;
    }
    a->data[a->len++] = value;
    return true;
}
```

Grow if needed, then write at the end and bump the length. That's the entire `push`. Everything else `.push()` does in JS — bookkeeping for `.length`, triggering listeners, garbage collection, type-tagging — is layered on top of these two lines.

---

## Run it

```sh
make run
```

You'll see:

```
push #   0: cap grew    0 ->    8
push #   8: cap grew    8 ->   16
push #  16: cap grew   16 ->   32
push #  32: cap grew   32 ->   64
push #  64: cap grew   64 ->  128
push # 128: cap grew  128 ->  256
push # 256: cap grew  256 ->  512
push # 512: cap grew  512 -> 1024
-> 1000 pushes triggered only 8 grow operations.
```

Between growths, push is a few CPU cycles: write to `data[len]`, increment `len`. The doubling means the rare expensive operation is *so* rare that pushing is effectively free.

---

## Back to JavaScript, with new eyes

`const arr = []; arr.push(1)` — what's *actually* happening:

- V8 (Chrome/Node's JS engine) allocates a small backing buffer behind the scenes. Like our `INITIAL_CAP = 8`, V8 has its own initial size.
- `.push()` writes to the next slot and increments the length — exactly like `da_push`.
- When the buffer fills, V8 doubles it and copies — exactly like `da_grow`.
- When you `arr[100] = 'hi'` on a small array, V8 either grows the buffer to 101+ slots, or switches internal representations (`PACKED_SMI_ELEMENTS` → `HOLEY_ELEMENTS`). But conceptually it's the same problem we just solved.

JavaScript adds three things on top: garbage collection (so you don't `free`), type genericism (the buffer holds any value, with boxing overhead), and the "holey vs packed" optimization (so sparse arrays don't waste gigabytes).

But the three fields are still there underneath. **Pointer. Length. Capacity.**

---

## Exercises

1. **Insert at index.** Add `bool da_insert(DynArray *a, size_t i, int value)` that inserts at position `i`, shifting later elements right. What's the time complexity? Why is insert-at-front O(n)?
2. **Shrink-to-fit.** Add `da_shrink_to_fit` that reduces `cap` to `len`. When would you call this?
3. **Generic version.** Change `int` to `void *` so the array can hold any pointer type. What do you lose? (Type safety. Value semantics for non-pointer types.)
4. **The classic bug.** What happens if you save `int *p = &a.data[5]`, then push enough times to force a realloc, then dereference `p`? Why? *This bug pattern — "iterator invalidation" — has shipped in every major C++ codebase at some point.*

---

## What you can now build on top

- **Stack** — push and pop are already there. A `DynArray` *is* a stack.
- **String builder** — same structure, `char` instead of `int`. Why concatenating strings in a loop is O(n²) in some languages and O(n) in others.
- **Hash map** — uses a fixed-size slot table, but each slot's collision chain can be a `DynArray`. (Lesson 02.)
- **Queue, deque, ring buffer** — variations on the same idea with different access patterns. (Lesson 05.)

---

**Next up:** [Lesson 02 — Hash Map](../02-hash-map/). How `const obj = {}; obj.name = 'KA'` actually works.
