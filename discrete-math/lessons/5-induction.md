# Induction, From Zero

## The proof technique that recursion and loops are made of

---

## How to read this document

It assumes the earlier documents: "for all" claims, direct proofs, proof by contradiction.

It teaches one technique, **mathematical induction**, and shows that a recursive function and a loop are each an induction proof waiting to be written. By the end you should be able to justify a recursive solution or a loop out loud, which is what "can you prove that works?" means in an interview.

Try each **Check Yourself** before reading its answer.

---

# Part 1: The problem induction solves

To prove "for all n ∈ ℕ, P(n)" directly you argue about an arbitrary n. Sometimes there is nothing to grab hold of: the only thing you know about n is that it comes after n − 1.

Induction turns that into the method.

## 1.1 The principle

To prove P(n) for every natural number n, prove two things:

1. **Base case.** P(0) is true.
2. **Inductive step.** For an arbitrary k, *if* P(k) is true *then* P(k + 1) is true.

Then P(n) holds for all n.

The picture is a row of dominoes. The base case knocks over the first. The inductive step says each domino knocks over the next. Neither alone is enough.

In the inductive step, the assumption "P(k) is true" is called the **inductive hypothesis**. You are allowed to use it. That is not circular: you are not assuming the thing you want to prove (P for *all* n), only proving an implication from one case to the next.

The base need not be 0. Starting at 1, or at 5, proves the claim from there upward.

---

# Part 2: A first proof

**Claim.** For every n ≥ 0: 0 + 1 + 2 + … + n = n(n + 1)/2.

*Proof.* By induction on n.

*Base case, n = 0.* The left side is 0. The right side is 0·1/2 = 0. Equal.

*Inductive step.* Let k ≥ 0 be arbitrary and assume the claim for k: 0 + 1 + … + k = k(k + 1)/2. We must show it for k + 1.

0 + 1 + … + k + (k + 1) = k(k + 1)/2 + (k + 1)  (by the inductive hypothesis)
= (k + 1)(k/2 + 1)
= (k + 1)(k + 2)/2.

That is the formula with n = k + 1. ∎

Every induction proof has this shape. Write the three labels first ("Base case", "Assume for k", "Show for k + 1") and you never face a blank page.

> **Check Yourself 1.** Prove that 2ⁿ > n for every n ≥ 0.
>
> **Answer.** *Base case.* 2⁰ = 1 > 0. *Inductive step.* Assume 2ᵏ > k. Then 2ᵏ⁺¹ = 2ᵏ + 2ᵏ > k + 2ᵏ (using the hypothesis on the first term) ≥ k + 1 (because 2ᵏ ≥ 1). So 2ᵏ⁺¹ > k + 1. ∎

---

# Part 3: Recursion is induction

Here is the sum as a recursive function:

```cpp
#include <cassert>
#include <iostream>
#include <vector>

// Returns 0 + 1 + ... + n.
long long sum_to(int n) {
    if (n == 0) return 0;           // base case
    return sum_to(n - 1) + n;       // trusts the answer for n - 1
}
```

Why is it correct? **Claim: for every n ≥ 0, `sum_to(n)` returns 0 + 1 + … + n.**

- *Base case.* `sum_to(0)` returns 0, which is the empty sum.
- *Inductive step.* Assume `sum_to(k)` returns 0 + … + k. Then `sum_to(k + 1)` returns `sum_to(k) + (k + 1)`, which is 0 + … + k + (k + 1).

The mapping is exact:

| Induction proof | Recursive function |
|---|---|
| base case | the `if` that returns without recursing |
| inductive hypothesis | "the recursive call returns the right answer" |
| inductive step | the line that combines the recursive result |

This is the reason the usual advice for writing recursion works: *assume the call on the smaller input is correct, and only write the step*. You are not being asked to trust magic. You are using an inductive hypothesis.

It also tells you what goes wrong. No base case: no first domino, and the function never returns. A recursive call that does not move *toward* the base case: the step does not connect to anything proved, and again it never returns.

---

# Part 4: Strong induction

Sometimes P(k + 1) does not follow from P(k) alone but from some earlier case.

**Strong induction**: in the inductive step, assume P holds for *every* value from the base up to k, and prove P(k + 1).

**Claim.** Every integer n ≥ 2 is a product of one or more primes.

*Proof.* By strong induction on n.

*Base case, n = 2.* 2 is prime, so it is a product of one prime.

*Inductive step.* Let k ≥ 2 and assume every integer from 2 to k is a product of primes. Consider k + 1. If k + 1 is prime, done. Otherwise k + 1 = a·b with 2 ≤ a, b ≤ k. By the hypothesis, a and b are each products of primes, and so is their product. ∎

Ordinary induction would be stuck: knowing about k says nothing useful about k + 1's factors, which are much smaller.

In code, strong induction is recursion on *any* smaller input, not just n − 1: merge sort recursing on two halves, a tree function recursing on both children.

## 4.1 Induction on structure

The same idea works on recursively defined data. A binary tree is either empty, or a node with a left tree and a right tree.

**Claim.** A binary tree with n nodes contains exactly n + 1 empty (null) links.

*Proof.* By induction on the structure of the tree.

*Base case.* The empty tree has 0 nodes and is itself one empty link: 0 + 1 = 1.

*Inductive step.* Take a node whose left subtree has a nodes and right subtree has b nodes, and assume the claim for both subtrees: they contain a + 1 and b + 1 empty links. The whole tree has n = a + b + 1 nodes and (a + 1) + (b + 1) = (a + b + 1) + 1 = n + 1 empty links. ∎

```cpp
struct Node {
    Node* left = nullptr;
    Node* right = nullptr;
};

int count_nodes(const Node* t) { return t ? 1 + count_nodes(t->left) + count_nodes(t->right) : 0; }
int count_nulls(const Node* t) { return t ? count_nulls(t->left) + count_nulls(t->right) : 1; }
```

The two functions have the same shape as the proof: one case for empty, one for a node.

---

# Part 5: Loops are induction too

A loop is correct for the same reason, with the induction running over the number of iterations. The statement you prove is called a **loop invariant**: something true before the loop starts and kept true by each pass.

```cpp
// Index of target in sorted v, or -1 if it is not there.
int binary_search(const std::vector<int>& v, int target) {
    int lo = 0, hi = static_cast<int>(v.size());   // search the half-open range [lo, hi)
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (v[mid] == target) return mid;
        if (v[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return -1;
}
```

**Invariant.** If target is anywhere in v, it is at an index in [lo, hi).

- *Base case (before the first pass).* [lo, hi) is the whole array, so the invariant holds.
- *Inductive step (one pass keeps it true).* Assume the invariant at the top of a pass. If v[mid] < target, then because v is sorted every index ≤ mid holds a value below target, so target is not there; setting lo = mid + 1 discards only those. The other branch discards only indices ≥ mid, whose values are above target. Either way the invariant still holds.
- *Termination.* hi − lo is a non-negative integer that gets strictly smaller every pass, so the loop ends.
- *Conclusion.* If the loop exits without returning, lo ≥ hi, so [lo, hi) is empty. By the invariant, target is not in v, and −1 is the right answer.

"Termination" is the part ordinary induction did not need. A loop needs both: the invariant says the answer is right *if* it stops; the shrinking quantity says it stops.

> **Check Yourself 2.** Change `lo = mid + 1` to `lo = mid`. The invariant argument still goes through. What breaks?
>
> **Answer.** Termination. When hi = lo + 1, mid equals lo, and `lo = mid` changes nothing: hi − lo no longer strictly decreases, and the loop can run forever. The invariant alone never proves a loop finishes.

---

# Part 6: Two ways to get it wrong

**Skipping the base case.** "Claim: n = n + 1 for all n." Inductive step: assume k = k + 1; add 1 to both sides; k + 1 = k + 2. The step is valid! The claim is false because no base case holds. Every domino would knock over the next, but none ever falls.

**A step that does not work for every k.** The classic false proof that all horses are the same colour argues: any group of k + 1 horses is two overlapping groups of k, each one-coloured by hypothesis, so all k + 1 match. For k + 1 = 2 the two "overlapping" groups are single horses that do not overlap at all. The step fails at exactly one k, and one gap is enough to stop the dominoes.

---

# Part 7: Running the code

```cpp
int main() {
    for (int n = 0; n <= 100; n++) assert(sum_to(n) == 1LL * n * (n + 1) / 2);

    Node leaf1, leaf2, root;
    root.left = &leaf1;
    root.right = &leaf2;
    assert(count_nulls(&root) == count_nodes(&root) + 1);
    assert(count_nulls(nullptr) == 1);

    std::vector<int> v = {1, 3, 5, 7, 9, 11};
    assert(binary_search(v, 7) == 3);
    assert(binary_search(v, 4) == -1);
    assert(binary_search({}, 4) == -1);
    std::cout << "all checks passed\n";
}
```

Checking 101 values of n is evidence. The induction proof is what covers all of them.

---

# Part 8: Check Yourself — final quiz

1. Prove that 1 + 3 + 5 + … + (2n − 1) = n² for every n ≥ 1.
2. A recursive `fib(n)` calls `fib(n - 1)` and `fib(n - 2)`. How many base cases does its correctness proof need, and why?
3. State a loop invariant for a loop that finds the largest element of a non-empty array.

## Answers

1. *Base case, n = 1.* The sum is 1 = 1². *Inductive step.* Assume 1 + 3 + … + (2k − 1) = k². The next term is 2(k + 1) − 1 = 2k + 1, so the sum up to it is k² + 2k + 1 = (k + 1)². ∎
2. Two (n = 0 and n = 1). The step for n uses the two cases before it, so the first step, for n = 2, needs both 0 and 1 already proved. With only one base case, `fib(1)` would call `fib(-1)`.
3. "After looking at the first i elements, `best` equals the largest of them." True after the first element, each pass keeps it true by comparing with the next element, and when i reaches the length it says `best` is the largest of all.

---

# Part 9: Where this connects next

- **Counting**: many counting formulas (2ⁿ subsets, n! orderings) are proved by induction, and they tell you how long a brute-force search runs.
- **Recurrences**: the running time of a recursive function is itself defined recursively (T(n) = 2T(n/2) + n), and solved with the same tool.
