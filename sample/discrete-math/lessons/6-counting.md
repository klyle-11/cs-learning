# Counting, From Zero

## Turning "how many cases are there?" from a guess into a calculation

---

## How to read this document

It assumes sets, functions (injective, bijective) and induction from the earlier documents.

It teaches how to count the elements of a set without listing them. In programming this answers a question you ask constantly: *how many states, inputs or candidates are there, and can I afford to try them all?*

Try each **Check Yourself** before reading its answer.

---

# Part 1: Two rules everything else comes from

Write |A| for the number of elements of a finite set A.

## 1.1 The product rule

|A × B| = |A| · |B|.

If a choice is made in two steps, with m options for the first and n options for the second *whatever the first was*, there are m·n outcomes. Three shirts and four pairs of trousers give twelve outfits.

A nested loop is this rule running:

```cpp
#include <cassert>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

// How many times does the inner statement run? |A| * |B|.
int count_pairs(const std::vector<int>& a, const std::vector<int>& b) {
    int count = 0;
    for (int x : a)
        for (int y : b) {
            (void)x; (void)y;
            count++;
        }
    return count;
}
```

## 1.2 The sum rule

If A and B share no element, |A ∪ B| = |A| + |B|.

When they do overlap, the shared elements were counted twice, so subtract them once: |A ∪ B| = |A| + |B| − |A ∩ B|.

> **Check Yourself 1.** How many integers from 1 to 100 are divisible by 2 or by 5?
>
> **Answer.** 50 are divisible by 2 and 20 by 5. Those divisible by both are the multiples of 10: there are 10. So 50 + 20 − 10 = 60.

---

# Part 2: Counting functions

Let |A| = k and |B| = n.

## 2.1 All functions

A function A → B makes one choice from n options for each of the k inputs, independently. By the product rule there are n·n·…·n = **nᵏ** functions.

This one fact covers a lot:

- Strings of length k over an alphabet of n symbols: nᵏ. (A string *is* a function from positions to symbols.)
- 4-digit PINs: 10⁴ = 10,000.
- Values of a 32-bit integer: 2³².

## 2.2 Injective functions

Now no two inputs may share an output. The first input has n options, the second n − 1, and so on: **n·(n − 1)·…·(n − k + 1)**.

If k > n the product reaches 0: there are no injective functions from a bigger set to a smaller one. That is the Pigeonhole Principle, arrived at by counting.

## 2.3 Orderings

An ordering (permutation) of n things is an injective function from positions {1, …, n} to the things, so there are n·(n − 1)·…·1 = **n!** of them.

> **Check Yourself 2.** How many 4-digit PINs have four different digits?
>
> **Answer.** An injective function from 4 positions to 10 digits: 10·9·8·7 = 5,040. About half of all PINs.

---

# Part 3: Counting subsets

## 3.1 All subsets

**Claim.** A set with n elements has 2ⁿ subsets.

*Proof.* Number the elements 0 to n − 1. A subset is decided by answering, for each element, "in or out?". That is a function from the n elements to {out, in}, and by 2.1 there are 2ⁿ such functions. Different answers give different subsets and every subset comes from some answers, so this is a bijection between subsets and those functions. ∎

The proof is also a program. An n-bit number *is* one of those functions: bit i says whether element i is in.

```cpp
// Every subset of items, as a bitmask from 0 to 2^n - 1.
std::vector<std::vector<int>> all_subsets(const std::vector<int>& items) {
    std::vector<std::vector<int>> out;
    const std::uint32_t n = static_cast<std::uint32_t>(items.size());
    for (std::uint32_t mask = 0; mask < (1u << n); mask++) {
        std::vector<int> subset;
        for (std::uint32_t i = 0; i < n; i++)
            if (mask & (1u << i)) subset.push_back(items[i]);
        out.push_back(subset);
    }
    return out;
}
```

The loop counter running from 0 to 2ⁿ − 1 visits each subset exactly once *because* the correspondence is a bijection.

## 3.2 Subsets of a given size

Write C(n, k), "n choose k", for the number of k-element subsets of an n-element set.

**Claim.** C(n, k) = n! / (k!·(n − k)!).

*Proof.* Count the ordered selections of k different elements in two ways.

Directly, by 2.2: n·(n − 1)·…·(n − k + 1) = n!/(n − k)!.

In two steps: first choose which k elements (C(n, k) ways), then put them in order (k! ways). By the product rule that is C(n, k)·k!.

Both count the same thing, so C(n, k)·k! = n!/(n − k)!. Divide by k!. ∎

Counting one set in two ways and setting the answers equal is a standard move, worth remembering by name: **double counting**.

## 3.3 Computing it without overflowing

The formula is a bad program. 21! already exceeds a 64-bit integer, though C(21, 10) = 352,716 is small. Multiply and divide alternately instead:

```cpp
// n choose k. Exact as long as the answer (times k) fits in 64 bits.
std::uint64_t choose(std::uint64_t n, std::uint64_t k) {
    if (k > n) return 0;
    if (k > n - k) k = n - k;                    // C(n, k) = C(n, n - k)
    std::uint64_t result = 1;
    for (std::uint64_t i = 1; i <= k; i++)
        result = result * (n - k + i) / i;       // always divides exactly
    return result;
}
```

Why does the division never leave a remainder? **Invariant: after pass i, `result` equals C(n − k + i, i).** Before the loop (i = 0) it is 1 = C(n − k, 0). For the step, use the identity C(m, i) = C(m − 1, i − 1)·m/i with m = n − k + i: the old result is C(m − 1, i − 1), and multiplying by m and dividing by i gives C(m, i), a whole number. After the last pass, i = k and result = C(n, k). That is a loop invariant proved by induction, from the previous document.

---

# Part 4: What the numbers mean for a program

Counting tells you whether brute force is affordable before you write it. A common working figure is about 10⁸ simple steps per second.

| You try every… | Count | n = 10 | n = 20 | n = 30 |
|---|---|---|---|---|
| pair | C(n, 2) = n(n − 1)/2 | 45 | 190 | 435 |
| subset | 2ⁿ | 1,024 | about 10⁶ | about 10⁹ |
| ordering | n! | about 3.6·10⁶ | about 2.4·10¹⁸ | hopeless |

So "try every subset" is fine up to n around 20 to 25, and "try every ordering" stops near n = 10 or 11. When a problem statement says n ≤ 20, it is hinting that 2ⁿ is the intended size of the search.

C(n, 2) is also why comparing every pair is O(n²): the count is n(n − 1)/2, and the n² term is what grows.

## 4.1 Pigeonhole, with numbers

**Generalised pigeonhole.** If n items go into k boxes, some box holds at least ⌈n/k⌉ items.

*Proof.* By contradiction. Suppose every box holds fewer than ⌈n/k⌉, which means at most ⌈n/k⌉ − 1 items. Since ⌈n/k⌉ − 1 < n/k, the total is less than k·(n/k) = n. But the total is n. Contradiction. ∎

A hash table with 1,000 buckets holding 10,000 keys has a bucket with at least 10 keys, no matter how good the hash function is.

> **Check Yourself 3.** How many people must be in a room to be certain two share a birth month?
>
> **Answer.** 13. With 12 people each could have a different month. With 13 people in 12 months, some month holds at least ⌈13/12⌉ = 2.

---

# Part 5: Running the code

```cpp
int main() {
    assert(count_pairs({1, 2, 3}, {1, 2, 3, 4}) == 12);
    assert(all_subsets({7, 8, 9}).size() == 8);
    assert(all_subsets({}).size() == 1);              // the empty set has one subset: itself
    assert(choose(5, 2) == 10);
    assert(choose(21, 10) == 352716);
    assert(choose(4, 7) == 0);
    std::uint64_t total = 0;
    for (std::uint64_t k = 0; k <= 10; k++) total += choose(10, k);
    assert(total == 1024);                            // sizes 0..10 together are all 2^10 subsets
    std::cout << "all checks passed\n";
}
```

The last check is the sum rule: subsets of different sizes are disjoint groups, and together they are all the subsets, so C(10, 0) + … + C(10, 10) = 2¹⁰.

---

# Part 6: Check Yourself — final quiz

1. How many relations are there on a set with 3 elements?
2. A password is 8 lowercase letters. How many are there, and how many have no repeated letter?
3. Why is C(n, k) = C(n, n − k)? Give a reason that needs no algebra.
4. You must check every pair among 100,000 items. Roughly how many checks is that, and is it affordable in a second?

## Answers

1. A relation is a subset of the 3·3 = 9 possible pairs, so there are 2⁹ = 512.
2. 26⁸, about 2.1·10¹¹. With no repeats: 26·25·24·23·22·21·20·19, about 6.3·10¹⁰.
3. Choosing which k elements are in is the same decision as choosing which n − k are out. That pairing is a bijection between k-subsets and (n − k)-subsets, so the two counts are equal.
4. C(100000, 2) is about 5·10⁹. At about 10⁸ steps a second that is close to a minute, so no. This is the signal to look for a hash map or a sort.

---

# Part 7: Where this connects next

- **Probability** on finite sets is counting twice and dividing: favourable outcomes over all outcomes.
- **Big-O** is the study of how these counts grow, which is why the table in Part 4 is really a table of complexity classes.
- **Graphs**: a simple graph on n nodes is a choice of which of the C(n, 2) pairs are edges, so there are 2^C(n,2) of them.
