# C Lessons: Things JavaScript Does For You

A series of self-contained, runnable C lessons. Each one reverse-engineers something you use every day in JavaScript without thinking about it: arrays, objects, JSON parsing, closures, the event loop, garbage collection.

The premise: you can't make informed engineering decisions about something you've never built. Every JavaScript feature in this series is implemented from scratch in C in under 200 lines, so you can see the whole thing.

## Format

Each lesson is one directory containing:

| File | What it is |
|---|---|
| `README.md` | The explanation. Foundations → implementation → back to JS, with an "aha" moment. |
| `<name>.h` | The interface. Read this first to see what you're building. |
| `<name>.c` | The implementation, with teaching comments inline. |
| `test.c` | Tests *and* visible demonstrations. The tests are part of the lesson, not an afterthought. |
| `Makefile` | One command: `make run`. |

## How to study one lesson

1. Read **"The thing you take for granted"** first — see the JS code you're going to reverse-engineer.
2. **Predict** how you'd build it before reading further. Even a wrong prediction primes you.
3. Read the **Foundation** sections. These are short, but go slow if anything is new.
4. Read the **header file** before the implementation. The interface tells you what's possible; the implementation tells you how.
5. Read `dyn_array.c` (or equivalent), then `test.c`.
6. Run `make run`. Watch the output.
7. Do at least one **exercise** before moving on. The exercises are the actual learning.

The goal is not to memorize the code. The goal is that next time you write `arr.push(x)`, you can *see* what's happening underneath.

## Lessons

| # | Topic | What JS feature it explains | Status |
|---|---|---|---|
| 01 | **Dynamic array** | `[]`, `.push()`, `.length`, `arr[i]` | ✅ built |
| 02 | **Hash map** | `{}`, `obj.key`, `Map` | planned |
| 03 | **Linked list** | what `[]` *isn't* good at, why DOM nodes are linked | planned |
| 04 | **Binary search tree** | the structure under sorted-`Map` in some engines | planned |
| 05 | **Min-heap** | what `PriorityQueue` looks like in the languages that have it | planned |
| 06 | **LRU cache** | how `Map` + browser caches + JIT inline-caches work | planned |
| 07 | **String builder** | why concatenating strings in a loop can be O(n²) | planned |
| 08 | **JSON parser** | what `JSON.parse` actually does, byte by byte | planned |
| 09 | **TLV parser** | how protobuf, msgpack, and most binary protocols work — plus a tour of the bugs that ship in this code | planned |
| 10 | **Reference counter** | one of two main strategies behind garbage collection | planned |
| 11 | **Mark-and-sweep GC** | the other strategy (what V8 actually uses) | planned |
| 12 | **Closures from scratch** | what `function makeCounter()` is hiding | planned |
| 13 | **Event loop** | what `setTimeout`, promises, and `async/await` actually sit on top of | planned |

## Prerequisites

- A C compiler (`gcc` or `clang`) and `make`.
- Knowing JavaScript well enough that you find yourself agreeing or disagreeing with the "Back to JavaScript" sections.
- No formal C background needed. The first lesson explains everything you need to know about memory and pointers.

## Pacing

Each lesson is meant to be ~60–90 minutes of focused work: 15 min reading, 15 min running and breaking the tests, 30+ min on exercises. If a lesson is taking three hours, you're trying to do too many exercises in one sitting — split it.

The series in total is roughly 12–15 hours of focused work. That is a tiny fraction of CS50 and gets at the same lessons more directly, because every example is something you already understand at the high level.

## What this is not

- Not a C tutorial. We don't cover `printf` format specifiers or the preprocessor in depth.
- Not a substitute for K&R if you want full C fluency.
- Not idiomatic production C. The code is optimized for *reading*, not *shipping*: no generics, no allocator parameters, no thread safety. Real implementations are 5x longer.

What it *is*: a focused tour of the data structures and algorithms hiding inside JavaScript, with the abstractions stripped off so you can see the machine.
