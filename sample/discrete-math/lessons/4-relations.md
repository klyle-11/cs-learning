# Relations, From Zero

## Functions with the two laws relaxed, and why `==` and `<` are promises

---

## How to read this document

This picks up where *Functions and Proofs, From Zero* stops. It assumes sets, ∀ and ∃, and the idea of proving a "for all" claim with an arbitrary element.

It teaches one concept, the **relation**, and the four properties a relation can have. Those properties are what C++ silently assumes every time you write `operator==`, hand a comparator to `std::sort`, or use a type as a map key.

Try each **Check Yourself** before reading its answer.

---

# Part 1: What a relation is

## 1.1 Pairs

For sets A and B, the **product** A × B is the set of all ordered pairs (a, b) with a ∈ A and b ∈ B.

A **relation from A to B** is any subset of A × B. That is the whole definition: a relation is a set of pairs. When (a, b) is in the relation R we write a R b and say "a is related to b".

A relation **on A** is a subset of A × A.

> Example. A = {1, 2, 3, 4, 6}. Let a R b mean "a divides b". Then (2, 6) ∈ R because 6 = 2·3, and (4, 6) ∉ R.

## 1.2 Where functions fit

A function f: A → B is a relation with two extra laws: every a is related to *at least one* b, and to *at most one* b. Drop those laws and you have a general relation. One element may be related to several, or to none.

In code a relation on a small finite set can be stored exactly as the definition says, as a set of pairs:

```cpp
#include <algorithm>
#include <cctype>
#include <functional>
#include <iostream>
#include <set>
#include <string>
#include <utility>
#include <vector>

using Relation = std::set<std::pair<int, int>>;

// "a divides b" on the given elements.
Relation divides_on(const std::vector<int>& elems) {
    Relation r;
    for (int a : elems)
        for (int b : elems)
            if (b % a == 0) r.insert({a, b});
    return r;
}
```

---

# Part 2: The four properties

Let R be a relation on a set A.

| Property | Definition | Plain English |
|---|---|---|
| **Reflexive** | ∀a ∈ A: a R a | everything is related to itself |
| **Symmetric** | ∀a, b: a R b ⇒ b R a | relatedness goes both ways |
| **Antisymmetric** | ∀a, b: (a R b and b R a) ⇒ a = b | it goes both ways only for an element and itself |
| **Transitive** | ∀a, b, c: (a R b and b R c) ⇒ a R c | chains can be shortened |

Each is a "for all" claim. From the earlier document: to prove one you argue about arbitrary elements; to disprove one you need a single counterexample.

For a finite relation a program can simply check every case, which is a direct translation of the definitions:

```cpp
bool reflexive(const Relation& r, const std::vector<int>& elems) {
    return std::all_of(elems.begin(), elems.end(), [&](int a) { return r.count({a, a}) > 0; });
}

bool symmetric(const Relation& r) {
    return std::all_of(r.begin(), r.end(), [&](auto p) { return r.count({p.second, p.first}) > 0; });
}

bool antisymmetric(const Relation& r) {
    return std::all_of(r.begin(), r.end(), [&](auto p) {
        return p.first == p.second || r.count({p.second, p.first}) == 0;
    });
}

bool transitive(const Relation& r) {
    for (auto [a, b] : r)
        for (auto [b2, c] : r)
            if (b == b2 && r.count({a, c}) == 0) return false;
    return true;
}
```

Notice `std::all_of` is ∀ written in C++, and returning `false` at the first failing triple is "one counterexample kills a for-all claim".

> **Check Yourself 1.** On the positive integers, is "divides" reflexive? Symmetric? Antisymmetric? Transitive?
>
> **Answer.** Reflexive: yes, a = a·1. Symmetric: no; 2 divides 4 but 4 does not divide 2 (one counterexample is enough). Antisymmetric: yes. If a | b and b | a then b = a·k and a = b·m for positive integers k, m, so a = a·k·m, so k·m = 1, which forces k = m = 1 and a = b. Transitive: yes. If b = a·k and c = b·m then c = a·(k·m).

---

# Part 3: Equivalence relations

A relation that is **reflexive, symmetric and transitive** is an **equivalence relation**. It is the mathematical form of "the same in the way I care about".

## 3.1 The standard example, proved

Fix an integer n ≥ 1. Say a ≡ b when n divides a − b ("a and b leave the same remainder").

**Claim.** ≡ is an equivalence relation on the integers.

*Proof.* Let a, b, c be arbitrary integers.

- *Reflexive.* a − a = 0 = n·0, so n divides a − a.
- *Symmetric.* Suppose a ≡ b, so a − b = n·k for some integer k. Then b − a = n·(−k), so b ≡ a.
- *Transitive.* Suppose a ≡ b and b ≡ c, so a − b = n·k and b − c = n·m. Adding, a − c = n·(k + m), so a ≡ c. ∎

## 3.2 Classes

For an equivalence relation ~ on A, the **equivalence class** of a is [a] = { x ∈ A : a ~ x }, everything a is equivalent to. With n = 3 the integers fall into three classes: remainders 0, 1 and 2.

**Theorem.** Two equivalence classes are either identical or share no element.

*Proof.* Suppose [a] and [b] share an element c. So a ~ c and b ~ c. We show [a] ⊆ [b]. Take any x ∈ [a], so a ~ x. From a ~ c, symmetry gives c ~ a. Then b ~ c and c ~ a give b ~ a by transitivity, and b ~ a and a ~ x give b ~ x. So x ∈ [b]. The same argument with a and b swapped shows [b] ⊆ [a]. So [a] = [b]. ∎

All three properties were used, and reflexivity is what guarantees every element is in *some* class (its own). So the classes cut A into non-overlapping pieces covering everything: a **partition**.

## 3.3 What this is in a program

**`operator==` is a promise to be an equivalence relation.** Containers and algorithms assume it. If your `==` is not transitive, `std::find`, `std::unique` and every hash container can give answers that depend on the order things happened in.

**A hash function must respect the classes.** `std::unordered_map` requires: if a == b then hash(a) == hash(b). In the language of the last document, the hash must be a well-defined *function on equivalence classes*. Equal keys in different buckets would make a key you inserted impossible to find.

```cpp
struct CaseInsensitive {            // "Hello" and "HELLO" are the same key
    std::string text;
};

std::string lowered(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

bool operator==(const CaseInsensitive& a, const CaseInsensitive& b) {
    return lowered(a.text) == lowered(b.text);
}

struct CaseInsensitiveHash {
    std::size_t operator()(const CaseInsensitive& k) const {
        return std::hash<std::string>{}(lowered(k.text));  // hash the class, not the spelling
    }
};
```

Hashing `k.text` directly would be the bug: "Hello" and "HELLO" are equal but would hash differently.

**Union-Find is a partition you can edit.** Each `union(a, b)` merges two classes; `find(a)` names the class a is in. Its correctness argument is exactly the theorem above.

> **Check Yourself 2.** Define a ~ b on doubles as |a − b| < 0.001 ("close enough"). Is ~ an equivalence relation?
>
> **Answer.** No. It is reflexive and symmetric but not transitive: 0 ~ 0.0009 and 0.0009 ~ 0.0018, yet |0 − 0.0018| is not below 0.001. This is why "approximately equal" must never be used as `operator==` for a map key or in `std::unique`: there are no classes for the container to rely on.

---

# Part 4: Orders

## 4.1 Partial orders

A relation that is **reflexive, antisymmetric and transitive** is a **partial order**. ≤ on numbers, ⊆ on sets and "divides" on positive integers are all partial orders.

"Partial" because some pairs may be unrelated in both directions: 4 does not divide 6 and 6 does not divide 4. When every pair is related one way or the other, the order is **total**.

## 4.2 What `std::sort` actually requires

`std::sort` takes a comparator `comp(a, b)` meaning "a goes before b". The standard requires it to be a **strict weak ordering**. The parts that matter most:

- **Irreflexive**: comp(a, a) is false, for every a.
- **Transitive**: comp(a, b) and comp(b, c) imply comp(a, c).
- Elements where neither goes before the other count as equivalent, and that "equivalent" must itself be transitive.

**Claim.** `<=` is not a valid comparator.

*Proof.* A valid comparator is irreflexive: comp(a, a) must be false for all a. But a <= a is true for every a. One counterexample suffices; take a = 0. ∎

```cpp
bool by_length(const std::string& a, const std::string& b) {
    return a.size() < b.size();     // correct: strict
}

bool by_length_broken(const std::string& a, const std::string& b) {
    return a.size() <= b.size();    // wrong: says an element goes before itself
}
```

Passing the broken one to `std::sort` is undefined behaviour. In practice it can read past the end of the array, because the algorithm's loops rely on irreflexivity to stop.

> **Check Yourself 3.** With `by_length`, "cat" and "dog" are unrelated in both directions. Is that allowed?
>
> **Answer.** Yes. Neither goes before the other, so the ordering treats them as equivalent, and "same length" is transitive, so the requirement holds. `std::sort` may leave them in either order; `std::stable_sort` keeps their original order.

---

# Part 5: Running the checks

```cpp
int main() {
    std::vector<int> elems = {1, 2, 3, 4, 6};
    Relation r = divides_on(elems);
    std::cout << std::boolalpha
              << "reflexive " << reflexive(r, elems) << "\n"
              << "symmetric " << symmetric(r) << "\n"
              << "antisymmetric " << antisymmetric(r) << "\n"
              << "transitive " << transitive(r) << "\n";

    CaseInsensitive a{"Hello"}, b{"HELLO"};
    std::cout << "equal " << (a == b) << ", same hash "
              << (CaseInsensitiveHash{}(a) == CaseInsensitiveHash{}(b)) << "\n";
    std::cout << "by_length(cat, cat) " << by_length("cat", "cat")
              << ", broken " << by_length_broken("cat", "cat") << "\n";
}
```

It prints `true false true true` for the four properties, matching Check Yourself 1.

---

# Part 6: Check Yourself — final quiz

1. Give a relation on {1, 2, 3} that is symmetric and transitive but not reflexive.
2. True or false: a relation cannot be both symmetric and antisymmetric.
3. Your `operator<` for a `Point` compares only `x`. Is it a valid comparator for `std::set<Point>`? What happens to two points with equal `x` and different `y`?

## Answers

1. The empty relation works: with no pairs at all, the symmetric and transitive "if" conditions are never triggered, but 1 R 1 fails. So does {(1, 1)}, since 2 R 2 fails.
2. False. Equality itself, {(1,1), (2,2), (3,3)}, is both: it goes both ways, and only between an element and itself.
3. It is a valid strict weak ordering, so the set works, but the set treats points with equal `x` as equivalent and keeps only the first one inserted. The comparator defines the equivalence classes, whether or not you meant it to.

---

# Part 7: Where this connects next

- **Induction** proves "for all n" claims and is the argument behind every recursive function and loop.
- **Counting** needs products of sets, which is where this document started: a relation on an n-element set is a subset of n² pairs, so there are 2^(n²) relations.
