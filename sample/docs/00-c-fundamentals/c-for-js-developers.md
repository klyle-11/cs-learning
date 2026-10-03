# C for the JavaScript Developer — Chapter 0

> **What this teaches**: enough C to read and write all of the other projects in this catalog. Aimed at someone fluent in JavaScript who has never opened a C file. Side-by-side comparisons, dense but flat — designed as a *cheat sheet you re-read*, not a textbook you finish once.

**Effort**: a focused day to skim; a week of building (chapters 1.1 → 2.1 → 2.2 from the catalog) to actually internalize.
**How to use it**: read once front to back. Then keep it open in a tab while you write your first 500 lines of C. Most of the bugs you'll hit have an answer in here somewhere.

---

## 0. The mental shift

If you take only one thing from this guide, take this: **C is what JavaScript is built on top of.** V8 is ~2M lines of C++; Node's `libuv` is C; every native module, every system call, every primitive you've ever used in JS bottoms out in something that looks like C eventually.

The mental shifts you'll make:

| JavaScript hides | C exposes |
|---|---|
| Memory (GC handles it) | You allocate, you free |
| Types (runtime, dynamic) | Compile-time, static, fixed-width |
| The "object" universal type | Structs, primitives, pointers — no `Object` |
| Strings as a built-in | Arrays of bytes with a `\0` at the end |
| Errors as `throw` / Promise rejection | Return values, error codes, `errno` |
| One execution model | The compile → link → execute pipeline |
| Runtime safety (mostly) | Buffer overflows, use-after-free, undefined behavior |
| Module system, npm | `#include` text-substitution + linker |

None of this is harder than JS. It is **lower**. You are operating *closer to what the machine actually does*, and the language gives you fewer guardrails because that lets you make the machine do precisely what you want.

---

## 1. The compile / link / run pipeline

In JavaScript:

```
   foo.js → node → output
```

In C:

```
   foo.c ──preprocess──▶ foo.i ──compile──▶ foo.s ──assemble──▶ foo.o ──link──▶ a.out
                                                                           ↑
                                                                       libc.so, other .o files
```

Four phases, usually wrapped into one `gcc` command:

1. **Preprocess**: `#include`, `#define`, `#ifdef` get textually substituted. Output is a single huge C file.
2. **Compile**: that big file gets turned into assembly (CPU instructions in text form).
3. **Assemble**: assembly gets turned into a binary object file (`.o`).
4. **Link**: object files + libraries get glued into one executable.

```bash
gcc hello.c -o hello       # all four phases
./hello                    # run the executable
```

There is no runtime interpreter. Once compiled, the OS loads the binary and the CPU runs it directly. **You can read the assembly** with `gcc -S hello.c` — useful when you want to know what the compiler actually did.

This pipeline is why:

- A change to a header file rebuilds everything that includes it.
- "It compiles" is a *real* milestone, unlike in JS where most errors only show up at runtime.
- You can ship a binary that runs without any interpreter installed.

---

## 2. Hello, dissected

```c
#include <stdio.h>           // bring in printf's declaration

int main(void) {             // every program's entry point
    printf("hello, world\n");
    return 0;                // 0 = success to the OS
}
```

Line by line:

- `#include <stdio.h>` — *before compilation*, the contents of `stdio.h` are pasted in. `stdio.h` declares `printf`. Without this line, the compiler doesn't know what `printf` is.
- `int main(void)` — defines a function named `main` that takes no arguments and returns `int`. The OS calls this function to start your program. Its return value is the *exit status* (0 = success, non-zero = failure).
- `printf("hello, world\n")` — `\n` is the newline escape. `printf` does its own newline; `puts` adds one for you. Both are in `stdio.h`.
- `return 0;` — passes 0 back to the OS as the exit status. Equivalent to JS `process.exit(0)`.

To run it:

```bash
gcc hello.c -o hello && ./hello
```

---

## 3. Types

C has a small, fixed set of primitive types. **Sizes can vary by platform** (this is the source of half the portability bugs in old C code) — use the `<stdint.h>` types when you care about exact sizes.

| Category | Type | Size | Notes |
|---|---|---|---|
| Signed int | `int` | usually 32 bits | JS `Number` is closest in spirit |
| | `long` | 32 or 64 bits | use `int32_t`/`int64_t` instead |
| | `long long` | ≥64 bits | use `int64_t` instead |
| | `char` | 8 bits | actually used as a byte, not a "character" |
| Unsigned int | `unsigned int`, `unsigned char`, … | same as signed | non-negative range, wraps on overflow |
| Float | `float` | 32 bits | half-precision of JS `Number` |
| | `double` | 64 bits | what JS uses for `Number` |
| Boolean | `_Bool` / `bool` | 1 byte | needs `<stdbool.h>` for `bool` |
| No value | `void` | n/a | "no return," "no args," "untyped pointer" |
| Pointer | `T *` | 4 or 8 bytes | the address of a `T` |
| Fixed-size int | `int8_t`, `int16_t`, `int32_t`, `int64_t` | exact | from `<stdint.h>`; *use these in real code* |
| Fixed-size unsigned | `uint8_t`, `uint16_t`, … | exact | most common in systems code |
| Size of object | `size_t` | platform pointer-sized unsigned | what `sizeof` returns and what arrays are indexed by |

**Default to `int32_t`, `int64_t`, `uint8_t`, `size_t`, `bool`.** You will almost never need `long` directly.

JS `Number` is essentially C `double`. JS `BigInt` is the only thing that resembles arbitrary-precision integers; C has none built in.

### Integer overflow

`int x = INT_MAX; x++;` is **undefined behavior** in signed integers. Unsigned wraps cleanly (`uint32_t x = UINT32_MAX; x++;` becomes 0). The compiler is allowed to assume signed overflow doesn't happen and optimize accordingly — leading to bugs that disappear under `-O0` and reappear under `-O2`.

### Floats are not exact

Same as JS: `0.1 + 0.2 != 0.3`. Use `<float.h>` constants and avoid `==` on floats.

---

## 4. Variables, scope, lifetime

```c
int x = 5;          // declaration + initialization
int y;              // declaration only; value is GARBAGE (undefined)
x = 10;             // assignment

const int z = 42;   // can't reassign
```

**Uninitialized `int y` is not zero.** It contains whatever was already in that memory. Reading it is undefined behavior. Always initialize, or use the `{0}` trick on structs (see below).

### Scope

Block-scoped, like `let`. Curly braces define a scope. No hoisting.

```c
{
    int a = 1;
    {
        int a = 2;       // shadows the outer a
        printf("%d", a); // 2
    }
    printf("%d", a);     // 1
}
```

### Storage duration (lifetime)

This is the big new concept. JavaScript variables live as long as something references them; C has three storage classes:

| Storage | Where it lives | Lifetime | How to get it |
|---|---|---|---|
| **Automatic** | The stack | Until the enclosing block exits | `int x;` inside a function |
| **Static** | Global data segment | Whole program | `static int x;` or any global variable |
| **Allocated** | The heap | Until you call `free()` | `int *x = malloc(sizeof(int));` |

```c
int g_counter = 0;       // static storage — exists for whole program

int next_id(void) {
    static int n = 0;    // static *local* — initialized once, persists across calls
    return ++n;
}

void f(void) {
    int x = 5;           // automatic — gone when f returns
    int *p = malloc(sizeof(int));  // allocated — must free(p) later
    *p = 5;
    free(p);
}
```

**Returning a pointer to an automatic variable is the most common beginner bug.** `int *bad(void) { int x = 5; return &x; }` returns a pointer to memory that no longer exists. The compiler will sometimes warn; sometimes it won't.

---

## 5. Operators

Almost all the JS operators exist in C with the same meaning:

```c
+  -  *  /  %         // arithmetic
== != <  >  <= >=     // comparison
&& || !               // logical
&  |  ^  ~  << >>     // bitwise (JS has these too)
=  += -= *= /= %=     // assignment / compound
++ --                 // increment / decrement
?:                    // ternary
,                     // comma (sequence)
sizeof                // not really an operator; returns a size_t
```

Different from JS:

- **No `===`.** `==` is value equality. There's only one.
- **No `**` for exponentiation.** Use `pow(x, y)` from `<math.h>`.
- **`/` on two ints is integer division.** `5 / 2` is `2`, not `2.5`. Cast: `(double)5 / 2`.
- **`%` works only on integers.** Use `fmod()` for floats.
- **`&&` and `||` short-circuit and return `int` (`0` or `1`), not the operand.** JS's `x || default` idiom doesn't work the same way.
- **`++` / `--` are statements with side effects, not expressions you should embed.** `a[i++] = i++;` is undefined behavior.

### Pointer-specific operators

| Operator | Meaning |
|---|---|
| `&x` | address of `x` |
| `*p` | the value `p` points at (dereference) |
| `p->field` | shorthand for `(*p).field` |
| `p + n` | pointer arithmetic — advance by `n * sizeof(*p)` bytes |
| `p[i]` | exactly equivalent to `*(p + i)` |

---

## 6. Control flow

Identical to JS for `if`, `while`, `do/while`, `for`, `break`, `continue`, `switch`. Two notes:

- **`switch` falls through by default.** Always end a case with `break;` unless you explicitly want fallthrough.
- **There is no `for...of` or `for...in`.** Loop with an index.

```c
for (int i = 0; i < n; i++) {
    sum += arr[i];
}
```

C also has `goto`, which is *sometimes* used to jump to a single cleanup block at the end of a function (a common error-handling pattern). It is not the GOTO of basic; restrict it to forward jumps within one function.

```c
int f(void) {
    char *buf = malloc(100);
    if (!buf) goto fail;
    FILE *fp = fopen("x", "r");
    if (!fp) goto fail_buf;
    // ... work ...
    fclose(fp); free(buf);
    return 0;
fail_buf:
    free(buf);
fail:
    return -1;
}
```

---

## 7. Functions

```c
// declaration (prototype) — tells the compiler "this function exists"
int add(int a, int b);

// definition — the actual code
int add(int a, int b) {
    return a + b;
}
```

A **declaration** (also called a "prototype") only states the function's signature. A **definition** has a body. You can call a function only after its declaration (or definition) appears earlier in the file. This is why programs put prototypes at the top of the file or in headers.

```c
void greet(const char *name) {     // no return value
    printf("hello, %s\n", name);
}
```

### `void` parameters

`int f(void)` means "takes no arguments." `int f()` in old C means "takes an unspecified number of arguments" — *don't use it.* Always write `void` in empty parameter lists.

### Function pointers

Yes, functions have addresses. You can store them and call through them.

```c
int add(int a, int b) { return a + b; }
int (*op)(int, int) = add;        // declare and assign
int r = op(2, 3);                  // call through the pointer
```

The syntax is famously ugly; `typedef` it:

```c
typedef int (*BinaryOp)(int, int);
BinaryOp op = add;
```

This is the C version of a callback. It's what `qsort` takes, what GLib uses for "virtual methods," what gives JS closures their underlying mechanism (sort of — closures need captured state, which C function pointers don't have).

---

## 8. Pointers (the chapter you re-read)

**A pointer is an integer that happens to be the address of a value in memory.** That's it.

```c
int x = 42;
int *p = &x;     // p holds the address of x
printf("%d\n", *p);   // prints 42  — "follow the pointer to the value"
*p = 100;             // changes x to 100
printf("%d\n", x);    // prints 100
```

Three things to internalize:

- `int *p` — the *type* is "pointer to int." Read it right to left: `p` is a `*` (pointer) to an `int`.
- `&x` — the address-of operator. Asks "where in memory is x?"
- `*p` — the dereference operator. Asks "what value is at this address?"

`&` and `*` are inverses. `*(&x)` is `x`. `&(*p)` is `p` (when `p` is valid).

### Why pointers exist

1. **To modify a caller's variable.** C is pass-by-value: `void inc(int x) { x++; }` does nothing observable. To actually modify the caller's `int`, pass its address:

   ```c
   void inc(int *x) { (*x)++; }
   int n = 5; inc(&n);   // n is now 6
   ```

2. **To avoid copying large data.** Passing a `struct Thing thing` to a function *copies the whole struct*. Passing a `struct Thing *thing` passes one pointer (8 bytes). Almost all C functions that take structs take pointers.

3. **To represent "this might be missing."** A pointer can be `NULL` (zero). That's how C says "no value," equivalent to JS `null`.

4. **To talk to the heap.** `malloc` returns a pointer because allocated memory doesn't live in any named variable.

5. **To walk through arrays.** Array indexing is pointer arithmetic in disguise.

### The `NULL` pointer

```c
int *p = NULL;       // explicitly "points at nothing"
if (p) { ... }       // false — NULL is falsy
if (p != NULL) { ... }  // equivalent, more explicit
*p;                  // CRASH — dereferencing NULL is segfault
```

Every function that returns a pointer can return `NULL` to signal failure. Check it.

### `const` and pointers

Read right to left:

```c
const int *p;        // pointer to a const int — can change p, can't change *p
int *const p;        // const pointer to int — can change *p, can't change p
const int *const p;  // both
```

You'll see `const char *` constantly — that's the C type for "string I won't modify."

### Generic pointer: `void *`

`void *` is a pointer that points at anything. You can't dereference it without casting. `malloc` returns `void *` for this reason. Use sparingly.

```c
void *p = malloc(100);    // OK
int *ip = p;              // implicit conversion to int*
```

---

## 9. Arrays

```c
int arr[5] = {1, 2, 3, 4, 5};
printf("%d", arr[2]);     // 3 — same indexing as JS
size_t n = sizeof(arr) / sizeof(arr[0]);   // 5
```

**Arrays are not objects.** They have no `.length`, no `.push`, no methods. The size is part of the type. `int[5]` is a different type from `int[6]`.

### Arrays decay to pointers

This is the most confusing C rule for new C programmers. **The name of an array, in almost any expression, is implicitly converted to a pointer to its first element.**

```c
int arr[5];
int *p = arr;           // OK, p points at arr[0]
printf("%d", arr[2]);   // same as *(arr + 2)
printf("%d", p[2]);     // also same as *(p + 2)
```

Inside a function, an array parameter *is actually a pointer*:

```c
// these three are identical:
void f(int arr[5]) { ... }
void f(int arr[]) { ... }
void f(int *arr) { ... }
```

The `[5]` is documentation; the compiler ignores it. Inside `f`, `sizeof(arr)` is the size of a pointer, not the size of the array. **You must pass the length separately:**

```c
int sum(const int *arr, size_t n) {
    int s = 0;
    for (size_t i = 0; i < n; i++) s += arr[i];
    return s;
}
```

This is also why functions return `void` or a status and put output through a pointer parameter — they can't return a fixed-size array meaningfully.

### Multi-dimensional arrays

```c
int grid[3][4];
grid[1][2] = 99;
```

Stored row-major (rows contiguous in memory). For dynamic 2D, allocate an array of pointers or a single flat block with `i * cols + j` indexing.

---

## 10. Strings

**There is no string type.** A C string is `char *` pointing at a sequence of bytes ending in `'\0'` (a zero byte).

```c
char *s = "hello";          // string literal: 6 bytes ('h','e','l','l','o','\0')
printf("%s", s);            // prints hello
printf("%zu", strlen(s));   // 5 — strlen scans until \0
```

String literals are *read-only* — modifying one (`s[0] = 'H'`) is undefined behavior. To get a modifiable copy:

```c
char buf[16];
strcpy(buf, "hello");
buf[0] = 'H';               // OK
```

### The string library (`<string.h>`)

| Function | What it does | JS analog |
|---|---|---|
| `strlen(s)` | length (bytes until `\0`) | `s.length` |
| `strcpy(dst, src)` | copy src into dst | assignment |
| `strncpy(dst, src, n)` | copy at most n bytes | `slice` + copy |
| `strcmp(a, b)` | < 0, 0, > 0 | `a === b`-ish |
| `strcat(dst, src)` | append src onto dst | `+` |
| `strchr(s, c)` | find first c | `indexOf` |
| `strstr(s, sub)` | find substring | `indexOf` |
| `memcpy(dst, src, n)` | copy n bytes (no `\0` semantics) | `Buffer.copy` |
| `memset(dst, c, n)` | set n bytes to c | `fill` |
| `memcmp(a, b, n)` | compare n bytes | `Buffer.equals` |

**`strcpy`, `strcat`, `sprintf` are unsafe** — they don't bound their writes. Use `strncpy`, `strncat`, `snprintf`. Or, for new code, just use `memcpy` + manual `\0` termination.

```c
snprintf(buf, sizeof buf, "user: %s, age: %d", name, age);
```

`snprintf` is the format-into-buffer equivalent of JS template literals, and it's the function you'll reach for most often.

### `printf` format specifiers (cheat sheet)

```
%d   int
%ld  long
%lld long long
%u   unsigned
%zu  size_t                  ← use for sizeof results
%x   hex
%o   octal
%f   double (use %.3f for 3 decimal places)
%c   char
%s   char* (null-terminated string)
%p   void* (prints address)
%%   a literal %
```

Mismatching the format and the argument is undefined behavior. The compiler with `-Wformat -Wall` will catch most of these.

---

## 11. Structs

```c
struct Point {
    int x;
    int y;
};

struct Point p;        // declare a Point
p.x = 3;
p.y = 4;

struct Point q = { .x = 5, .y = 7 };   // designated initializer
struct Point r = { 0 };                // zero out the struct

struct Point *pp = &p;
pp->x = 10;            // shorthand for (*pp).x
```

The `struct ` keyword is required every time unless you `typedef`:

```c
typedef struct Point {
    int x, y;
} Point;

Point p = { 1, 2 };    // now you can just write Point
```

You'll see this idiom in 90% of real C code.

### Structs are values

Assigning a struct copies it field-by-field:

```c
Point a = { 1, 2 };
Point b = a;           // copy
b.x = 99;              // a.x is still 1
```

Function arguments work the same — pass by value copies the struct. **Pass `Point *` if you want to mutate or avoid copying.**

### Anonymous structs and unions

```c
struct Foo {
    int kind;
    union {                // takes the space of the largest member
        int   i;
        float f;
        char *s;
    };
};
```

A **union** stores any one of its members at the same memory location — used for tagged unions, type punning, and bit-twiddling.

---

## 12. The heap: `malloc` and `free`

JS gives you allocation for free; C makes you do it.

```c
#include <stdlib.h>

int *arr = malloc(100 * sizeof(int));   // allocate space for 100 ints
if (!arr) { /* allocation failed */ }
arr[0] = 1;
arr[99] = 99;
free(arr);                              // give it back
arr = NULL;                             // defensive: avoid use-after-free
```

Rules:

1. Every `malloc` (or `calloc`, or `realloc`) needs a matching `free`. **Memory leaks** are the bug from forgetting.
2. `free` only memory you got from `malloc`/`calloc`/`realloc`. Freeing the stack (`free(&x)`) is a crash.
3. After `free(p)`, `p` still holds the same address — but using it is *undefined behavior*. Set to `NULL`.
4. **Double-free** (calling `free` twice on the same pointer) corrupts the allocator. Set to `NULL` after free.

```c
void *malloc(size_t n);            // n bytes, uninitialized
void *calloc(size_t n, size_t sz); // n*sz bytes, ZEROED
void *realloc(void *p, size_t n);  // resize; may return a new pointer
void  free(void *p);               // give it back; free(NULL) is a no-op
```

`realloc` is the only `realloc` you have; the C version of growing an array.

### Ownership conventions

C has no language-level ownership. The convention is *documentation*: a function that returns a `malloc`'d pointer documents "caller must free." A function that takes a pointer documents "I don't keep it" vs. "I take ownership."

A common pattern:

```c
// Caller passes in a buffer; function fills it. Caller owns it.
int format_user(char *buf, size_t bufsz, const User *u);

// Function allocates and returns; caller must free.
char *user_to_string(const User *u);
```

Naming `_new` / `_destroy`, `_open` / `_close`, `_create` / `_free` is the convention to make ownership visible.

---

## 13. Header files

A `.h` file declares; a `.c` file defines.

```c
// math_utils.h — the interface
#ifndef MATH_UTILS_H            // include guard (prevents double-inclusion)
#define MATH_UTILS_H

int add(int a, int b);
int max(int a, int b);

#endif
```

```c
// math_utils.c — the implementation
#include "math_utils.h"

int add(int a, int b) { return a + b; }
int max(int a, int b) { return a > b ? a : b; }
```

```c
// main.c — the consumer
#include "math_utils.h"
#include <stdio.h>

int main(void) {
    printf("%d\n", add(2, 3));
    return 0;
}
```

Build with:

```bash
gcc main.c math_utils.c -o app
```

`#include "x.h"` searches your project first; `#include <x.h>` searches the system headers. Use `""` for your headers, `<>` for system / library.

### Include guards

The `#ifndef / #define / #endif` trio prevents the header from being processed twice (a common cause of "duplicate definition" errors). Modern compilers also accept `#pragma once`, but the `ifndef` pattern is universal.

### `extern` and `static`

- **`static` at file scope**: the function/variable is local to this `.c` file. Like JS module-scoped.
- **`extern`**: "declared elsewhere, link to it." Used in headers for global variables.

```c
// counter.h
extern int counter;       // declaration

// counter.c
int counter = 0;          // definition
```

The header gets `#include`d in many files; the definition lives in one. Without `extern`, every `#include` would try to define it again and the linker would fail.

---

## 14. The preprocessor

Runs *before* compilation. Pure text substitution. It is **not part of C** in any meaningful sense — but you'll see it everywhere.

```c
#define PI 3.14159              // text substitution
#define MAX(a, b) ((a) > (b) ? (a) : (b))   // macro with args

#include <stdio.h>              // paste in stdio.h here

#ifdef DEBUG                    // conditional compilation
    fprintf(stderr, "debug: %d\n", x);
#endif

#if __STDC_VERSION__ >= 201112L  // C11 or later
    _Static_assert(sizeof(int) >= 4, "int must be at least 32 bits");
#endif
```

### Macros vs. functions

```c
#define SQUARE(x) ((x) * (x))     // text substitution; (x) parens are critical

SQUARE(2 + 3)   // expands to ((2 + 3) * (2 + 3)) = 25
                // without the parens around x, it'd be (2 + 3 * 2 + 3) = 11
```

Macros are textual, not semantic. Side effects double-evaluate: `SQUARE(i++)` is `((i++) * (i++))` — undefined behavior. **Prefer `static inline` functions for small helpers**; reserve macros for things you genuinely can't do as a function (header-only constants, conditional compilation, X-macros).

### Common preprocessor symbols

```c
__FILE__       // current filename (string)
__LINE__       // current line number (int)
__func__       // current function name (string, C99)
__DATE__       // compilation date (string)
NULL           // ((void*)0)
```

---

## 15. The standard library (cheat sheet)

The C standard library is small and largely about I/O, strings, math, and memory.

| Header | What's in it |
|---|---|
| `<stdio.h>` | `printf`, `scanf`, `fopen`, `fread`, `fwrite`, `fclose`, `fgets`, `puts` |
| `<stdlib.h>` | `malloc`, `free`, `realloc`, `calloc`, `exit`, `atoi`, `strtol`, `rand`, `qsort`, `bsearch` |
| `<string.h>` | `strlen`, `strcpy`, `strcmp`, `memcpy`, `memset`, `strchr`, `strstr` |
| `<stdint.h>` | `int32_t`, `uint64_t`, etc. |
| `<stdbool.h>` | `bool`, `true`, `false` |
| `<stddef.h>` | `size_t`, `NULL`, `offsetof` |
| `<stdarg.h>` | varargs: `va_list`, `va_start`, `va_arg`, `va_end` |
| `<assert.h>` | `assert(condition)` — abort on false |
| `<errno.h>` | `errno`, the global error indicator |
| `<math.h>` | `sin`, `cos`, `sqrt`, `pow`, `floor`. **Link with `-lm`.** |
| `<time.h>` | `time`, `clock`, `localtime`, `strftime` |
| `<ctype.h>` | `isdigit`, `isalpha`, `tolower`, `toupper` |
| `<limits.h>` | `INT_MAX`, `CHAR_BIT`, etc. |

That is essentially everything. Compared to the npm ecosystem, the C "standard library" is tiny. **POSIX** adds another layer on Unix systems: `<unistd.h>` (`read`, `write`, `close`, `fork`), `<fcntl.h>` (`open`, `O_RDONLY`), `<sys/socket.h>`, `<pthread.h>`, etc.

### I/O quick reference

```c
// formatted print to stdout
printf("x = %d\n", x);

// to a file
FILE *fp = fopen("out.txt", "w");
fprintf(fp, "x = %d\n", x);
fclose(fp);

// read a line
char buf[256];
if (fgets(buf, sizeof buf, stdin)) {
    // buf has the line including '\n' (if it fit)
}

// read raw bytes
ssize_t n = read(fd, buf, sizeof buf);  // POSIX, returns bytes read or -1
```

`scanf` exists but is treacherous (no bounds checking, easy to break). Use `fgets` + `sscanf` or `strtol`.

---

## 16. Build tooling

For one file:

```bash
gcc -Wall -Wextra -std=c11 -g hello.c -o hello
```

| Flag | What it does |
|---|---|
| `-Wall -Wextra` | enable most warnings; you should fix them all |
| `-Werror` | treat warnings as errors |
| `-std=c11` (or `c99`, `c17`) | choose C version |
| `-g` | include debug info (for gdb) |
| `-O0`, `-O2`, `-O3` | optimization level |
| `-o name` | output filename |
| `-I path` | add header search path |
| `-L path` | add library search path |
| `-l name` | link with `libname.so` (e.g., `-lm` for math) |
| `-pthread` | enable POSIX threads |
| `-fsanitize=address` | enable AddressSanitizer (catches memory bugs) |
| `-fsanitize=undefined` | enable UndefinedBehaviorSanitizer |

### Makefiles

For more than one file:

```makefile
CC = gcc
CFLAGS = -Wall -Wextra -std=c11 -g
OBJS = main.o math_utils.o

app: $(OBJS)
	$(CC) $(CFLAGS) -o $@ $^

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f app $(OBJS)
```

`make` reads `Makefile`, sees `app` depends on `main.o math_utils.o`, sees how to make those from `.c`, and runs the commands. Indentation must be *tabs*, not spaces — the only place in 2026 where this matters.

For real projects: CMake (most popular), Meson, plain Make, or just a `build.sh`. For a learning project, plain Make is enough.

---

## 17. Memory bugs (the ones you'll hit first)

| Bug | Symptom | How to find |
|---|---|---|
| **Use of uninitialized variable** | Random garbage values; works on debug, breaks on release | `-Wall`, valgrind, MemorySanitizer |
| **Buffer overflow** | Silent corruption; eventual crash; sometimes a security vuln | AddressSanitizer (`-fsanitize=address`), valgrind |
| **Use-after-free** | Sometimes works, sometimes crashes — based on what overwrote the memory | AddressSanitizer |
| **Double free** | Heap corruption; later crash | AddressSanitizer; set pointer to NULL after free |
| **Memory leak** | Slow process growth | valgrind `--leak-check=full`, AddressSanitizer with `LSAN` |
| **NULL dereference** | Segfault, immediate | Check returns from `malloc`/`fopen`/etc. |
| **Off-by-one** | Skipped element, extra element, overflow | Stare; tests; `assert` |
| **Format string mismatch** | `printf("%d", "string")` — undefined behavior | `-Wformat` (compiler warning) |
| **Type confusion via void\*** | Crash or wrong value | Don't cast away types unless you have to |

### The tools

```bash
# AddressSanitizer — instrument every memory access; catches most bugs in real time
gcc -fsanitize=address -g foo.c && ./a.out

# valgrind — runs your binary under simulation; slower but very accurate
valgrind --leak-check=full ./a.out

# gdb — interactive debugger
gdb ./a.out
(gdb) break main
(gdb) run
(gdb) print x
(gdb) next
(gdb) bt          # backtrace on crash
```

**Make `-Wall -Wextra -fsanitize=address` your default for learning code.** You will catch ~80% of bugs at the moment they happen instead of three hours later.

---

## 18. Error handling

C has no exceptions. Three idioms cover ~95% of real code:

### 1. Return an int status

```c
int parse_int(const char *s, int *out) {
    char *end;
    long v = strtol(s, &end, 10);
    if (*end != 0) return -1;
    *out = (int)v;
    return 0;
}

int x;
if (parse_int("42", &x) < 0) { /* handle error */ }
```

`0` = success, non-zero = failure. The "output" goes through a pointer parameter.

### 2. Return NULL on failure

```c
FILE *fp = fopen("x", "r");
if (!fp) {
    perror("fopen");
    return -1;
}
```

For functions that return pointers, `NULL` is the universal error. Many of these also set `errno`.

### 3. `errno` + standard C library

```c
#include <errno.h>
#include <string.h>

if (open("x", O_RDONLY) < 0) {
    printf("open failed: %s\n", strerror(errno));
    // or use perror("open"); which prints "open: " + strerror(errno) + "\n"
}
```

`errno` is a thread-local global set by the standard library on failure. You read it *immediately* after the failing call (any subsequent library call may overwrite it).

### A common project pattern: the `goto cleanup` chain

```c
int do_thing(void) {
    int ret = -1;
    char *buf = malloc(1024);
    if (!buf) goto end;
    FILE *fp = fopen("x", "r");
    if (!fp) goto free_buf;

    // ... real work ...

    ret = 0;
    fclose(fp);
free_buf:
    free(buf);
end:
    return ret;
}
```

Reads ugly the first time. After your tenth resource leak, you'll love it.

---

## 19. Idioms and conventions

### Constructor / destructor pattern

```c
typedef struct {
    int *data;
    size_t len, cap;
} Vec;

Vec  *vec_new(void);
void  vec_free(Vec *v);
void  vec_push(Vec *v, int x);
```

Every "object-like" thing in C is: a struct, a `_new` function (returns a pointer or fills a caller-provided struct), a `_free` function, and operations that take the struct pointer as the first argument. This is OOP in pure C, and it is *everywhere*.

### `const` correctness

`const T *` means "I won't modify what this points at." Use it on every input parameter that's a pointer to data you don't modify. Communicates intent and catches mistakes.

```c
size_t my_strlen(const char *s);   // promise: doesn't touch *s
```

### `assert` everywhere

```c
#include <assert.h>
assert(ptr != NULL);
assert(idx < arr_len);
```

`assert` aborts the program if the condition is false. Use it for invariants — things that should be true if your code is correct. Disabled at compile time with `-DNDEBUG` (so don't use it for input validation, only for invariants).

### Initialize with `{ 0 }`

```c
struct BigConfig cfg = { 0 };       // zero-initializes everything
```

The cleanest way to zero a struct. Works for any type. The single-`0` initializer in C is special — it zeros every field.

---

## 20. Reading C code

Things to look for when you open a `.c` file you've never seen:

1. **What does this file include?** That tells you what APIs it uses.
2. **What does it `typedef`?** Those types define the data model.
3. **What functions are `static`?** Those are internal — the public API is the non-static ones.
4. **What's `malloc`'d?** Find the matching `free`s — that maps the ownership graph.
5. **What does `main` do, or what's the function called from `main`?** Top-down.
6. **What signal handlers, atexit handlers, or global state?** Often hidden control flow.

A 1000-line C file is much smaller than a 1000-line TypeScript file because there is no syntactic noise (no decorators, no generics, no JSX). You read it faster once you're fluent.

### Some non-obvious patterns

```c
// "do nothing" loop body
while (*p++);    // advance p until *p is 0

// flexible array member (C99) — for structs with variable-length tails
struct Packet {
    int length;
    char data[];   // sized at allocation time
};
struct Packet *p = malloc(sizeof(struct Packet) + 100);
p->length = 100;

// X-macro — generates code from a list
#define COLORS X(RED) X(GREEN) X(BLUE)
typedef enum { COLORS } Color;
#undef X
#define X(name) #name,
const char *color_names[] = { COLORS };
```

These idioms read like noise the first time and like home after the tenth.

---

## 21. The five-minute "lint your knowledge" quiz

After reading this guide, you should be able to answer these without looking:

1. What's the difference between `int *p` (declaration) and `*p` (in an expression)?
2. What does `malloc` return when it can't allocate?
3. Why is `int arr[5]; sizeof(arr)` different inside `main` than inside a function that takes `arr` as a parameter?
4. What's the difference between `char *s = "hello"` and `char s[] = "hello"`?
5. What does `static` do at file scope, vs inside a function?
6. Why is `strcpy` considered unsafe?
7. What's the difference between `==` on two `int`s, on two `char *`s, and what's the correct way to compare two strings?
8. Why does `for (int i = 0; i < 10; i++)` *not* work in C89, and what flag enables it?
9. What's an "include guard" and what bug does it prevent?
10. Why do most C "objects" pass a `T *self` as the first argument?

If any of these is fuzzy, re-read the relevant section. They will all come up in the first few hundred lines of C you write.

---

## 22. Suggested first paths through the catalog

Now go build something. Order, from easiest to hardest in terms of "what's the new C concept":

1. **1.1 Arena allocator** — practice `malloc`, pointers, alignment. No bigger algorithms.
2. **2.1 Dynamic array** (the existing `c-lessons-project/`) — practice `realloc`, `void *`, generic-ish design.
3. **4.1 Length-prefixed string** — practice bounds checking. Short.
4. **2.2 Open-addressed hash map** — practice everything above + a real algorithm.
5. **3.2 JSON parser** — a real-world parser; teaches state machines.
6. **7.1 Unix shell** — `fork`/`exec`/`pipe`; this is where systems C *really* clicks.
7. **7.4 HTTP server from sockets** — networking; the project you said taught you the most.

Each builds on the previous and uses every concept from this guide.

---

## 23. Going further

Once these basics are second nature:

- **K&R (Kernighan & Ritchie), *The C Programming Language*, 2nd ed.** The canonical book. Short, dense, beautiful. Still the best 250 pages on C.
- **Modern C** by Jens Gustedt. Free PDF online. Covers C11/C17 idioms, which K&R predates.
- **Beej's Guide to C Programming**. Free, modern, friendly. The "Beej's Guide to Network Programming" by the same author is also famous for project 7.4.
- **CSAPP** (Bryant & O'Hallaron, *Computer Systems: A Programmer's Perspective*). C from the machine's side; pairs well with project 7.9.
- **Crafting Interpreters** by Bob Nystrom. The C half (Part III) is the cleanest demonstration of C as a real engineering language anywhere on the internet.
- **The Practice of Programming** by Kernighan and Pike. Older but timeless on style, debugging, performance.

---

## 24. The takeaway

C is small. The whole language fits in this document. What's hard isn't the language — it's the *responsibility*: every byte you read, every allocation you make, every pointer you dereference is on you. JavaScript gives you a safety net; C gives you the wire underneath the net. You'll fall a few times. After that, you'll never look at a stack trace or a process exit code or a buffer the same way again.

That's the trade. Go build the shell.
