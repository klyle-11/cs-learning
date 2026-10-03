# Discrete maths

Discrete mathematics and proofs, and how each idea shows up in code, with C++ for the parallels. Read in order; each document assumes the ones before it.

## Start here: `sources/`

1. [Functions and Proofs, From Zero](sources/1-functions-and-proofs.md) — sets, ∀ and ∃, what a proof is, injective / surjective / bijective, pigeonhole
2. [Where to Begin: A Thinking Toolbox for LeetCode](sources/2-leetcode-thinking-toolbox.md) — a process for the first five minutes of a problem
3. [The Machine Under Everything](sources/3-the-machine-under-everything.md) — memory, pointers, and what containers are made of

## Then: `lessons/`

These follow the "where this connects next" list at the end of the first document.

4. [Relations](lessons/4-relations.md) — reflexive, symmetric, transitive; equivalence classes; what `operator==`, hash functions and `std::sort` comparators must promise
5. [Induction](lessons/5-induction.md) — the proof behind every recursive function and loop; loop invariants; binary search proved correct
6. [Counting](lessons/6-counting.md) — product and sum rules, subsets as bitmasks, n choose k, and reading a problem's size limits

Every C++ block in the lessons compiles; put a lesson's blocks in one file, in order, and it runs.

## Not written yet

- Logic: implication, truth tables, De Morgan, and `bool` expressions
- Graphs and trees
- Recurrences and big-O
- Probability on finite sets
