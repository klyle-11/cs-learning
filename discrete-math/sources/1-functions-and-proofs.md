# Functions and Proofs, From Zero

## A slow walk through one concept, all the way up to interview problems

---

## How to read this document

This document teaches exactly one concept: the **mathematical function**. Along the way, it teaches the proof skills that surround it — how to prove something is true, how to prove something is false, and what those words even mean.

It assumes you know nothing about discrete math. It assumes you can read code, but nothing more. Every term is defined before it is used. Nothing is "left as an exercise" without an answer provided.

Why functions, out of everything in discrete math? Because functions are the load-bearing wall under three of the most common interview topics:

1. **Hash tables** — a hash function is a mathematical function, and its failure to be *injective* (a word you will own by the end of this document) is exactly why collisions exist.
2. **Mapping problems** — Isomorphic Strings, Word Pattern, Encode/Decode are all secretly asking "is this mapping a *bijection*?"
3. **Counting arguments** — the Pigeonhole Principle, which justifies answers like "a collision must exist," is a one-line consequence of function basics.

Read slowly. There are **Check Yourself** questions throughout. Try each one before reading on — the answer always appears right after, but the attempt is where the learning happens. (This is the derivation-over-memorization rhythm: you should be able to *reconstruct* every definition here from the idea behind it, not recite it.)

---

# Part 1: Sets — the only prerequisite

Functions are built out of sets, so we need about two pages on sets first. Not the whole theory. Just enough.

## 1.1 What a set is

A **set** is a collection of things where:

- order doesn't matter, and
- duplicates don't count.

That's it. The "things" in a set are called its **elements** or **members**.

We write sets with curly braces:

- `{1, 2, 3}` — a set containing the numbers 1, 2, and 3.
- `{"red", "green", "blue"}` — a set of three strings.
- `{1, 2, 3}` and `{3, 1, 2}` are **the same set**, because order doesn't matter.
- `{1, 1, 2}` is the same set as `{1, 2}`, because duplicates don't count. An element is either in the set or it isn't. There is no "in the set twice."

If you've used `Set` in JavaScript/TypeScript or `set` in Python, you've already met this idea:

```typescript
const s = new Set([1, 1, 2, 3, 3, 3]);
console.log(s.size); // 3 — duplicates collapse
```

## 1.2 Membership

The single most important relationship in set theory is "is this thing in this set?"

The symbol is **∈**, read aloud as "is an element of" or just "is in."

- `2 ∈ {1, 2, 3}` — true. Two is in the set.
- `5 ∈ {1, 2, 3}` — false. We write `5 ∉ {1, 2, 3}` (the slash means "not").

In code, this is exactly `s.has(2)`.

## 1.3 Some sets we'll name

A few sets come up so often they get permanent names:

- **ℕ**, the natural numbers: `{0, 1, 2, 3, ...}` (some books start at 1; we'll start at 0, like arrays do).
- **ℤ**, the integers: `{..., -2, -1, 0, 1, 2, ...}`.
- **ℝ**, the real numbers: all numbers on the number line, including fractions and irrationals like π.

Sets can be **finite** (like `{1, 2, 3}`, which has 3 elements) or **infinite** (like ℕ). The number of elements in a finite set A is written **|A|** and called its **cardinality**. So `|{1, 2, 3}| = 3`. Same as `.size` or `len()`.

## 1.4 Two phrases you must be able to read

Almost every definition in this document — and in all of math — is built from two phrases. Learn to read them calmly and the scary symbols evaporate.

**"For all"** (symbol: ∀). The claim is about *every* element, no exceptions.

> "For all x in ℕ, x ≥ 0."
> Plain English: pick any natural number you like; it's at least zero.

**"There exists"** (symbol: ∃). The claim is that *at least one* element works.

> "There exists an x in ℕ such that x > 100."
> Plain English: at least one natural number is bigger than 100. (Sure — 101.)

Here is the part people skip, and it costs them later: **how do you argue about these claims?**

| To show a "for all" claim is TRUE | You must give an argument that works for an *arbitrary* element — one you know nothing about except that it's in the set. You can't just check a few examples. |
|---|---|
| **To show a "for all" claim is FALSE** | You need exactly **one counterexample**. One element that breaks the rule kills the whole claim. |
| **To show a "there exists" claim is TRUE** | You need exactly **one example**. Find one element that works, show it works, done. |
| **To show a "there exists" claim is FALSE** | You must argue that *no* element works — which is a "for all" argument in disguise ("for all x, x does *not* work"). |

Notice the symmetry: *disproving* "for all" and *proving* "there exists" are the easy ones (one concrete witness). *Proving* "for all" and *disproving* "there exists" are the hard ones (an argument covering everything).

This table is the skeleton of every proof in this document. We will use it constantly.

> **Check Yourself 1.** Claim: "For all integers x, x² ≥ x." Is this true or false? Decide before reading on.
>
> **Answer.** False — and per the table, all we need is one counterexample. Try x = 0.5... no wait, 0.5 isn't an integer; counterexamples have to come from the set the claim is about. Try small integers: x = 0 gives 0 ≥ 0 ✓. x = 1 gives 1 ≥ 1 ✓. x = -1 gives 1 ≥ -1 ✓. x = 2 gives 4 ≥ 2 ✓. Hmm — for integers it actually holds (squaring an integer never shrinks it). So the claim is **true**, and to *prove* it we'd need an argument for arbitrary x: if x ≤ 0 then x² ≥ 0 ≥ x; if x ≥ 1 then x² = x·x ≥ x·1 = x. Both cases covered, so every integer is covered.
>
> The deliberate fake-out above is the lesson: a counterexample must live in the stated set. Over the *reals*, x = 0.5 gives 0.25 < 0.5 and the claim dies. The domain is part of the claim. Hold onto that — it's about to become the main theme.

---

# Part 2: What a function actually is

## 2.1 The everyday picture

A function is a machine that takes an input and produces an output. You drop something in the top, exactly one thing comes out the bottom.

A vending machine is the classic picture: press B4, get the granola bar. The machine is a function from button-codes to snacks.

But the everyday picture is missing two pieces of bookkeeping that mathematics insists on, and those two pieces are where all the interview-relevant ideas live. So let's do this properly.

## 2.2 The full definition, assembled slowly

A mathematical function is **three things bundled together**:

1. A set of allowed inputs, called the **domain**.
2. A set of allowed outputs, called the **codomain**.
3. A **rule** that assigns to *each* element of the domain *exactly one* element of the codomain.

The notation is:

> **f : A → B**

Read it aloud as: "f is a function from A to B." Here A is the domain, B is the codomain, and f is the name of the rule. When we feed input x in, we write the output as **f(x)**, read "f of x."

Example, fully spelled out:

> f : ℤ → ℤ defined by f(x) = x + 1

In words: "f is a function from the integers to the integers; its rule is 'add one.'" So f(3) = 4, f(-7) = -6.

## 2.3 The two laws

The phrase "*each* element... *exactly one*" in the definition hides two separate laws. Both must hold or the thing is not a function.

**Law 1 — Totality: every input gets an output.**
The rule must work for *every* element of the domain. No input may be left hanging.

Non-example: "g : ℝ → ℝ defined by g(x) = 1/x" is **not a function** as written, because g(0) is undefined — the input 0 is in the claimed domain ℝ but gets no output. To fix it, shrink the domain: g : ℝ∖{0} → ℝ (the reals *except* zero) is a perfectly good function. The rule didn't change; the bookkeeping did.

**Law 2 — Determinism: no input gets two outputs.**
Each input maps to exactly one output. Same input in, same output out, every time, forever.

Non-example: "h(x) = a number whose square is x" is not a function on the positive reals, because h(4) could be 2 or -2. The rule is ambiguous. To fix it, pick one: h(x) = the *non-negative* number whose square is x. Now h(4) = 2, full stop, and we have a function (this is what √ means).

> **Check Yourself 2.** Is this a function? "f : {students at a school} → {teachers at the school}, where f(s) = the teacher of student s."
>
> **Answer.** Probably not, for both reasons at once. If any student has two teachers, Law 2 breaks (one input, two outputs). If any student somehow has no teacher, Law 1 breaks. The *idea* "student has teachers" is fine — it's a perfectly good *relation* — but a relation is only a function when both laws hold. This distinction (relation vs. function) is exactly what database people mean when they argue about whether a column is a function of the primary key.

## 2.4 Codomain vs. range — slow down here

This trips up everyone, so take it slowly.

The **codomain** is the set of *allowed* outputs — declared up front, part of the function's type signature.

The **range** (also called the **image**) is the set of outputs that *actually occur* — the set {f(x) : x ∈ domain}.

The range is always contained in the codomain, but it can be smaller.

Example:

> f : ℤ → ℤ, f(x) = 2x

- Codomain: all of ℤ. We *declared* that outputs are integers.
- Range: only the **even** integers. No matter what integer you feed in, doubling it gives an even number. The odd integers sit in the codomain, allowed but never produced.

A TypeScript analogy that should feel familiar:

```typescript
function double(x: number): number {
  return x * 2;
}
```

The return type annotation `: number` is the **codomain** — a promise about what *kind* of thing comes out. The **range** is what the function actually emits when run over all inputs. The type checker only knows the codomain; it has no idea the range is "even numbers only." The codomain is the declared type; the range is the runtime truth.

Why belabor this? Because one of the three big function properties (surjectivity, coming in Part 4) is *literally the question "does the range fill the whole codomain?"* — and you can't ask that question if the two concepts are blurred together.

## 2.5 Programming functions vs. mathematical functions

Most functions you write in code are **not** mathematical functions, and knowing why sharpens both concepts.

A mathematical function is pure determinism: the output depends on the input and nothing else. Code breaks this in three standard ways:

```typescript
// 1. Randomness — same input, different outputs. Violates Law 2.
function roll(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

// 2. Hidden state — output depends on something besides the input.
let counter = 0;
function next(_: void): number {
  return counter++;
}

// 3. Side effects — the "function" changes the world, which is
// outside the input→output story entirely.
function logAndDouble(x: number): number {
  console.log(x);       // the world is now different
  return x * 2;
}
```

Code that *does* behave like a mathematical function — same input, same output, no side effects — is called **pure** or **referentially transparent**. This is not just vocabulary: purity is the precondition for **memoization** (caching results by input). You can only cache `f(x)` if `f(x)` is guaranteed to be the same next time, which is exactly Law 2. When an interviewer asks "can we memoize this?", the mathematical question underneath is "is this a function of its arguments alone?"

Hash functions, which we'll meet properly in Part 6, *must* be mathematical functions: if `hash(key)` returned different values on different calls, you could never find anything you stored.

---

# Part 3: Your first real proofs

Before introducing the three big function properties, we need to be honest about what "prove" means, because the properties are useless if you can't argue about them.

## 3.1 What a proof is

A **proof** is an argument that establishes a claim beyond doubt — not "I checked a lot of cases and it seemed fine," but "here is why it cannot fail."

For "for all" claims, the standard move (from the table in 1.4) is:

> Let x be an **arbitrary** element of the set. Using only facts true of *every* element, show the claim holds for x. Since x was arbitrary — we used nothing special about it — the claim holds for all of them.

The word "arbitrary" is doing real work. You are arguing about a representative you know nothing personal about. If your argument secretly used a special property ("well, x is even, so..."), it only proves the claim for even x.

**Worked example.** Claim: for all integers x, the number x² + x is even.

*Proof.* Let x be an arbitrary integer. Factor: x² + x = x(x + 1). These are two consecutive integers, so one of them is even (integers alternate even, odd, even, odd...). An even number times anything is even. So x(x+1) is even. Since x was arbitrary, this holds for every integer. ∎

(The little square ∎ just means "proof finished." Some books write "QED.")

Notice what we did *not* do: we did not check x = 1, 2, 3, ..., 1000 and declare victory. Examples build intuition; they never prove a "for all."

## 3.2 What a disproof is

To disprove a "for all" claim: **one counterexample**, fully checked.

Claim: "for all integers x, x² > x." Counterexample: x = 1, since 1² = 1 and 1 > 1 is false. Done — the claim is dead. You don't need to explain *why* it fails or find more failures. One witness, verified, is a complete disproof.

This asymmetry — proofs need universal arguments, disproofs need one witness — is the most practically useful fact in this whole document. In an interview, when you suspect a proposed approach is wrong, you are hunting for a counterexample, and you only need one.

## 3.3 The contrapositive — one more tool, then we're equipped

Sometimes a claim has the shape "if P, then Q." For example: "if it's raining, then the ground is wet."

Every if-then claim has a twin called its **contrapositive**: "if *not Q*, then *not P*." For the rain example: "if the ground is *not* wet, then it is *not* raining."

Stop and convince yourself these say the same thing. If rain guarantees wet ground, then dry ground guarantees no rain — because if it *were* raining, the ground would be wet, and it isn't. The contrapositive isn't a different claim; it's the same claim read in the mirror.

**A claim and its contrapositive are always equally true.** So you may prove whichever one is easier. This will matter in about two paragraphs, because the definition of "injective" is naturally stated one way but naturally *proved* the other way.

(Warning: the contrapositive is not the **converse**. The converse of "if P then Q" is "if Q then P" — "if the ground is wet, then it's raining" — which can be false even when the original is true. Sprinklers exist. Confusing converse with contrapositive is a classic logic error, including in code review: "all our crashed requests had null user IDs" does not mean "all null-user-ID requests crash.")

---

# Part 4: Injective, surjective, bijective — slowly, one at a time

Now the payoff. We have functions; we have proof tools. There are three properties a function can have, and they are the heart of this document. Each one answers a natural question about the input→output mapping:

- **Injective:** do different inputs always stay different on the way out?
- **Surjective:** does every allowed output actually get produced?
- **Bijective:** both at once — a perfect pairing.

We'll take them one at a time, each with: the idea, the formal definition derived (not announced), how to prove it, and how to disprove it.

## 4.1 Injective ("one-to-one")

### The idea

A function is **injective** if it never merges. Different inputs in, different outputs out. No two inputs ever share an output.

Picture the domain as dots on the left, the codomain as dots on the right, and the function as arrows. Injective means: **no two arrows land on the same right-hand dot.**

```
Injective:                Not injective:
  1 ──→ a                   1 ──→ a
  2 ──→ b                   2 ──→ a   ← collision! 1 and 2 merged
  3 ──→ c                   3 ──→ b
```

### Deriving the formal definition

Try to write "never merges" precisely. First attempt, directly:

> For all inputs a₁ and a₂: if a₁ ≠ a₂, then f(a₁) ≠ f(a₂).

That is correct, and it's the honest statement of the idea: different inputs give different outputs. But look at its shape: "if (not equal), then (not equal)." Proving claims about things being *unequal* is awkward — inequality gives you nothing to compute with.

So take the **contrapositive** (Part 3.3: same claim, mirror reading). Flip and negate both sides:

> For all inputs a₁ and a₂: if f(a₁) = f(a₂), then a₁ = a₂.

In words: "the only way two outputs can be equal is if they were the same input all along." Same meaning, but now the hypothesis is an *equation*, and equations are things you can do algebra on. This contrapositive form is the standard textbook definition — and now you know it isn't arbitrary; it's the provable version of the natural idea.

### How to prove a function is injective

The recipe falls straight out of the definition: assume f(a₁) = f(a₂) for arbitrary a₁, a₂, then do algebra until you've forced a₁ = a₂.

**Worked example.** Claim: f : ℤ → ℤ, f(x) = 3x + 7 is injective.

*Proof.* Let a₁, a₂ be arbitrary integers and suppose f(a₁) = f(a₂). Then:

```
3a₁ + 7 = 3a₂ + 7      (that's what f(a₁) = f(a₂) means)
3a₁ = 3a₂              (subtract 7 from both sides)
a₁ = a₂                (divide both sides by 3)
```

Equal outputs forced equal inputs. Injective. ∎

Notice the proof is just "undo the function step by step." That's no accident — a function you can undo is precisely one that didn't destroy information, which is the soul of injectivity.

### How to prove a function is NOT injective

Injectivity is a "for all" claim, so (table from 1.4) disproving it takes one counterexample: **two different inputs with the same output**, concretely exhibited.

**Worked example.** Claim: g : ℤ → ℤ, g(x) = x² is not injective.

*Disproof.* g(3) = 9 and g(-3) = 9. Two different inputs, same output. Not injective. ∎

That's the entire disproof. Two lines.

> **Check Yourself 3.** Is f : ℕ → ℕ, f(x) = x² injective? Careful — the domain changed from the last example.
>
> **Answer.** Yes. The counterexample 3 vs. -3 is gone, because -3 ∉ ℕ. Proof: suppose a₁² = a₂² with a₁, a₂ natural numbers. Then a₁² − a₂² = 0, so (a₁ − a₂)(a₁ + a₂) = 0, so a₁ = a₂ or a₁ = −a₂; for non-negative numbers a₁ = −a₂ forces both to be 0, so either way a₁ = a₂. ∎
>
> The lesson, again: **injectivity is a property of the whole package (domain, codomain, rule), not of the formula.** Same formula x², injective on ℕ, not injective on ℤ. Asking "is x² injective?" without naming the domain is not a complete question.

### Why a programmer cares

Injective = **no information lost** = **reversible**. Concretely:

- **User → user ID** must be injective, or two users share an account.
- **Serialization** must be injective, or two different objects produce the same bytes and deserialization can't tell them apart.
- **Hashing is deliberately *not* injective** (infinite keys, finite hashes — more in Part 6), and every hash-collision strategy you've ever heard of (chaining, open addressing) exists to manage that failure of injectivity.

## 4.2 Surjective ("onto")

### The idea

A function is **surjective** if its range fills its entire codomain — every allowed output is actually produced by at least one input. Nothing in the codomain is left untouched.

In the arrow picture: **every right-hand dot has at least one arrow landing on it.**

```
Surjective:               Not surjective:
  1 ──→ a                   1 ──→ a
  2 ──→ b                   2 ──→ a
  3 ──→ a                   3 ──→ b
(both a and b are hit)            c   ← lonely. nothing maps to c
```

Note from the left picture: surjective does *not* require the arrows to avoid merging. 1 and 3 both hit a, and that's fine. Merging is injectivity's business, not surjectivity's.

### The formal definition, derived

"Every codomain element is produced by at least one input." Translate phrase by phrase using Part 1.4: "every" is a for-all over the codomain; "at least one" is a there-exists over the domain:

> For all b in the codomain B, there exists an a in the domain A such that f(a) = b.

Read it slowly: pick any target output b you like; I can find an input a that produces it.

### How to prove a function is surjective

The definition tells you the shape of the proof: someone hands you an arbitrary target b, and your job is to **produce an input that hits it** — usually by solving the equation f(a) = b for a.

**Worked example.** Claim: f : ℝ → ℝ, f(x) = 3x + 7 is surjective.

*Proof.* Let b be an arbitrary real number. We need a real x with 3x + 7 = b. Solve it: x = (b − 7)/3, which is a real number. Check: f((b−7)/3) = 3·(b−7)/3 + 7 = b. ✓ Every target is hit. ∎

The proof is again "undo the function" — but pointed the other direction. Injectivity-proofs undo f to show inputs were equal; surjectivity-proofs undo f to *manufacture* an input for a given output.

### How to prove a function is NOT surjective

Surjectivity is "for all b, there exists a..." — so to disprove it, exhibit **one codomain element that nothing maps to**, and argue nothing maps to it.

**Worked example.** Claim: f : ℤ → ℤ, f(x) = 2x is not surjective.

*Disproof.* Consider 3, an element of the codomain ℤ. If f(a) = 3 for some integer a, then 2a = 3, so a = 1.5 — not an integer. So no domain element maps to 3. Not surjective. ∎

(Note the second half: we didn't just point at 3, we *argued* no input reaches it. Disproving "there exists" requires that little universal argument — last row of the table in 1.4.)

> **Check Yourself 4.** Same formula, different codomain: f : ℤ → E, f(x) = 2x, where E is the set of even integers. Surjective now?
>
> **Answer.** Yes. Let b be an arbitrary even integer; by definition of "even," b = 2k for some integer k; then f(k) = b. Every target hit. ∎ — Same formula, same domain, different *codomain*, opposite verdict. Surjectivity is exactly the question "does the range equal the codomain?" (Part 2.4), so of course changing the codomain changes the answer. This is why mathematicians are pedantic about declaring the codomain: the property literally doesn't exist without it.

### Why a programmer cares

Surjective = **full coverage**. Concretely:

- An error-code-to-message mapping should be surjective onto "messages users might see" — checked the other way: every message reachable in the UI should be producible by some actual error. Unreachable branches are dead code; surjectivity is the math name for "no dead targets."
- A test suite mapping tests → code paths: "is it surjective onto the set of paths?" *is* the definition of full path coverage.
- Load balancer mapping requests → servers: if it's not surjective, some server never receives traffic.

## 4.3 Bijective — and the inverse theorem, proved slowly

### The idea

A function is **bijective** if it is **both injective and surjective**. Combine the two arrow rules:

- injective: every right-hand dot is hit by **at most one** arrow;
- surjective: every right-hand dot is hit by **at least one** arrow;
- together: every right-hand dot is hit by **exactly one** arrow.

A bijection is a perfect pairing — a dance where everyone on the left has exactly one partner on the right, no one is left out, no one is shared. For finite sets this immediately implies |A| = |B|: you cannot perfectly pair up sets of different sizes. (That innocent observation, run in reverse, becomes the Pigeonhole Principle in Part 5.)

### The headline theorem

> **A function f : A → B has an inverse if and only if f is bijective.**

The **inverse** of f, written f⁻¹, is the function that undoes f: f⁻¹ : B → A with f⁻¹(f(a)) = a for every a, and f(f⁻¹(b)) = b for every b. Encode/decode. Serialize/deserialize. Encrypt/decrypt. Every "undo" you've ever shipped is an inverse function, so this theorem is the mathematical spec for "undoable."

Rather than memorize the theorem, let's *see* why each property is non-negotiable. The strategy: try to build f⁻¹ and watch what goes wrong when a property is missing.

To build f⁻¹, we must answer: given b in B, what is f⁻¹(b)? The only reasonable answer: "the input that f sends to b." Now check the two function laws (Part 2.3) for this proposed f⁻¹:

**Law 1 for f⁻¹ (every b gets an output) requires f surjective.** If some b is never produced by f — surjectivity fails — then "the input f sends to b" doesn't exist, and f⁻¹(b) is undefined. Concretely: f(x) = 2x on ℤ; what is f⁻¹(3)? There's no integer that doubles to 3. No total inverse.

**Law 2 for f⁻¹ (no b gets two outputs) requires f injective.** If two inputs a₁ ≠ a₂ both map to b — injectivity fails — then f⁻¹(b) is ambiguous: which one do we return? Concretely: g(x) = x² on ℤ; what is g⁻¹(9)? Could be 3, could be -3. The "inverse" isn't deterministic, so it isn't a function.

And if both properties hold, both objections vanish: every b has at least one preimage (surjective) and at most one (injective), hence exactly one, and *that* is f⁻¹(b). The inverse exists, and we built it. ∎

That's the whole theorem, derived from the two function laws. If you remember the failure modes — **not surjective → inverse undefined somewhere; not injective → inverse ambiguous somewhere** — you can reconstruct everything else at a whiteboard.

```typescript
// A bijection and its inverse, concretely.
// f : char → charCode, restricted to characters and their codes.
const encode = (c: string): number => c.charCodeAt(0);
const decode = (n: number): string => String.fromCharCode(n);

decode(encode("A")) === "A"; // f⁻¹(f(a)) = a
encode(decode(65)) === 65;   // f(f⁻¹(b)) = b
```

> **Check Yourself 5.** For each, decide: injective? surjective? bijective? (Answers follow.)
> (a) f : ℤ → ℤ, f(x) = x + 1
> (b) f : ℤ → ℤ, f(x) = 2x
> (c) f : ℕ → ℕ, f(x) = x²
> (d) f : ℝ → ℝ, f(x) = x³
>
> **Answers.**
> (a) Injective (a₁+1 = a₂+1 ⟹ a₁ = a₂) and surjective (target b is hit by b−1, an integer). **Bijective**; inverse is f⁻¹(y) = y − 1.
> (b) Injective (2a₁ = 2a₂ ⟹ a₁ = a₂) but **not surjective** (nothing hits 3). Not bijective — and indeed f⁻¹(y) = y/2 fails Law 1 on odd integers.
> (c) Injective (Check Yourself 3) but **not surjective**: nothing in ℕ squares to 2 (1² = 1, 2² = 4, and there's nothing between — √2 isn't natural). Not bijective.
> (d) Both. Injective: cubing preserves order on ℝ (bigger input, strictly bigger cube), so distinct inputs give distinct cubes. Surjective: target b is hit by its real cube root. **Bijective**; inverse is the cube root. Contrast with x² on ℝ, which fails both: not injective (±3 → 9) and not surjective (nothing real squares to −1).

---

# Part 5: The Pigeonhole Principle, and your first proof by contradiction

## 5.1 The statement

> **Pigeonhole Principle.** If you place n items into m containers and n > m, then at least one container holds at least two items.

Ten pigeons, nine holes: some hole has roommates. It sounds too obvious to deserve a name. Its power is that it proves *existence with zero information about location*: it tells you a crowded container **must exist** without telling you which one. Interview answers of the form "a collision must occur" or "two of them must be equal" are almost always pigeonhole in disguise.

In function language — and this is why it lives in this document — placing items into containers *is* a function f : Items → Containers (each item goes in exactly one container: Laws 1 and 2, check and check). "Some container holds two items" means two inputs share an output, i.e., **f is not injective**. So the principle restates as:

> **If |A| > |B|, then no function f : A → B is injective.**

A bijection needs |A| = |B|; pigeonhole is the sharper, one-directional fact: too many inputs for the outputs *forces* merging.

## 5.2 Proof by contradiction — the technique itself

We'll prove pigeonhole with a technique you haven't seen yet in this document, and it deserves its own introduction because interviews lean on it constantly.

**Proof by contradiction:** to prove a claim, assume it is *false*, then show that assumption leads to an impossibility — something that contradicts known facts. Since assuming "false" breaks mathematics, the claim must be true.

It's the logic of an alibi: "Assume I was at the scene of the crime at 9pm. But I was on camera across town at 9pm, and no one is in two places at once. Contradiction — so the assumption is wrong; I wasn't there." You temporarily live inside the world where you're wrong, and demonstrate that world is broken.

## 5.3 The proof, slowly

> **Claim.** If n items are placed in m containers and n > m, some container holds at least 2 items.
>
> *Proof.* Suppose, for contradiction, that the claim is false: every container holds **at most 1** item.
>
> Now count the items by looking at the containers. There are m containers, each holding at most 1 item, so the total number of items is at most m × 1 = m.
>
> But we were told there are n items, and n > m. So n ≤ m and n > m simultaneously. That is impossible — a number can't be both bigger than m and at most m.
>
> The assumption ("every container holds at most 1") created an impossibility, so the assumption is false. Therefore some container holds at least 2. ∎

Walk back through it once more and notice the architecture: (1) assume the opposite; (2) extract a concrete consequence (a counting bound); (3) collide it with a given fact (n > m); (4) conclude. Every contradiction proof has this shape.

## 5.4 The payoff: hash collisions are mathematically inevitable

A **hash function** maps keys into a fixed-size array:

```typescript
function hash(key: string, buckets: number): number {
  let h = 0;
  for (const ch of key) {
    h = (h * 31 + ch.charCodeAt(0)) % buckets; // % keeps h in 0..buckets-1
  }
  return h;
}
```

As a mathematical function: hash : Keys → {0, 1, ..., m−1}, where m = number of buckets. The domain (all possible strings) is infinite; the codomain has m elements. Infinity > m, so by pigeonhole, **hash is not injective — two different keys must share a bucket.** Not "might, if you're unlucky." Must.

This is a theorem, not an engineering shortfall. No cleverness in the hash function can evade it, because the proof used nothing about the rule — only the sizes of the two sets. That's why every real hash table ships a collision strategy (chaining: each bucket holds a list; open addressing: walk to the next slot), and why "what happens on collision?" is a fair question about *any* hash design: collisions are guaranteed by counting alone.

The same counting argument, one level up, is the standard proof that **lossless compression cannot shrink every file**: a compressor that maps every n-bit file to fewer bits maps a bigger set into a smaller one, so two files share a compressed form, so decompression can't be well-defined. Pigeonhole again. One tiny principle, two famous impossibilities.

> **Check Yourself 6.** A drawer has 10 black socks and 10 white socks. You pull socks in the dark. How many pulls *guarantee* a matching pair? Frame it as pigeonhole: what are the items, what are the containers?
>
> **Answer.** 3. Containers = colors (2 of them); items = socks pulled. Pull 3 socks into 2 color-containers: 3 > 2, so some color has two socks — a pair. Two pulls don't guarantee it (one of each color is possible). Notice the answer is "containers + 1," and notice what pigeonhole did *not* tell you: which color. Existence without location.

---

# Part 6: From math to interview problems

Everything above now pays rent. Three classic problems, each solved by *recognizing* a function property rather than memorizing a trick.

## 6.1 Isomorphic Strings (LeetCode 205) — "is this mapping a bijection?"

> Two strings s and t are isomorphic if the characters in s can be mapped to characters in t such that replacing every character of s by its image yields t. Each character must map to exactly one character; no two characters may map to the same character.

Read the problem statement with your new vocabulary and it dissolves:

- "each character maps to exactly one character" — the mapping must be a **function** (Law 2, determinism);
- "no two characters map to the same character" — the function must be **injective**;
- and (so that the mapping is reversible, t back to s) it must pair characters off perfectly — a **bijection** between the characters of s and the characters of t.

`"egg"` / `"add"`: e→a, g→d. A function (each char one image), injective (a and d distinct). Works.
`"foo"` / `"bar"`: f→b, then o→a, then o→r. The input o demands two outputs — **Law 2 violated**; not even a function. Fails.
`"badc"` / `"baba"`: b→b, a→a, d→b. Now b and d both map to b — function, but **not injective**. Fails.

The implementation is forced by the math. Checking "is it a function?" needs one map (does each s-char have a consistent image?). Checking "is it injective?" needs the *reverse* map (does each t-char have at most one preimage?). That's why the textbook solution carries two hash maps — not as a memorized trick, but as one map per property:

```typescript
function isIsomorphic(s: string, t: string): boolean {
  if (s.length !== t.length) return false;

  const sToT = new Map<string, string>(); // enforces: mapping is a function
  const tToS = new Map<string, string>(); // enforces: mapping is injective

  for (let i = 0; i < s.length; i++) {
    const a = s[i], b = t[i];

    // Law 2: input a may not have two different outputs.
    if (sToT.has(a) && sToT.get(a) !== b) return false;

    // Injectivity: output b may not have two different inputs.
    if (tToS.has(b) && tToS.get(b) !== a) return false;

    sToT.set(a, b);
    tToS.set(b, a);
  }
  return true;
}
```

If an interviewer asks "why two maps?", you now have a real answer: *one map checks the relation is a well-defined function; the other checks it's injective; together that's a bijection on the characters seen, which is what isomorphism means.* (Word Pattern, LeetCode 290, is the identical bijection check with words instead of characters.)

## 6.2 Encode/Decode Strings — injectivity as a design requirement

> Design `encode(list of strings) → single string` and `decode(string) → list of strings` with `decode(encode(x)) = x` for all x.

The spec sentence `decode(encode(x)) = x` says **decode is an inverse of encode** — so by Part 4.3, encode must at minimum be **injective**: if two different lists encoded to the same string, decode would face an ambiguous input and couldn't return both answers.

This instantly diagnoses the naive attempt. `encode = join with ","`? Then `["a,b"]` and `["a","b"]` both encode to `"a,b"` — two inputs, one output, not injective, no inverse possible. Any fixed delimiter dies the same way the moment the delimiter can appear inside a string.

The standard fix — length-prefixing, `"3#abc5#hello"` — works because stating each string's length *before* it removes all ambiguity about where strings begin and end, making encode injective by construction; decode then reads lengths and slices. The interview insight isn't the format; it's that **"decodable" means "injective," and you can test any proposed encoding by hunting for two inputs with the same output** — which, per Part 3.2, takes only one counterexample to kill a bad design.

## 6.3 Missing Number (LeetCode 268) — a broken bijection

> An array contains n distinct numbers taken from {0, 1, ..., n}. Find the missing one.

Function framing: the array is an injective map from n slots into a set of n+1 values. An injection from a smaller set into a bigger one hits all but |B| − |A| = 1 element — the range misses exactly one value of the codomain. "Find the missing number" = "find the one codomain element outside the range" = "find where surjectivity fails."

Two implementations, both reading straight off that framing:

```typescript
// 1. Range vs. codomain, literally: materialize both, diff them.
function findMissing(nums: number[]): number {
  const range = new Set(nums);
  for (let v = 0; v <= nums.length; v++) {
    if (!range.has(v)) return v; // the unhit codomain element
  }
  return -1; // unreachable if input is valid
}

// 2. Counting: sum(codomain) − sum(range) = the missing element,
// because every other element appears in both sums and cancels.
function findMissingSum(nums: number[]): number {
  const n = nums.length;
  return (n * (n + 1)) / 2 - nums.reduce((a, b) => a + b, 0);
}
```

The second is the elegant one, but notice it's the same idea — comparing what *should* be hit against what *is* hit — compressed into arithmetic. And its correctness leans on injectivity: if the array could contain duplicates, the sums would diverge for a second reason and the subtraction would lie. When you state that assumption out loud in an interview ("this works because the inputs are distinct — the map is injective"), you're doing exactly the kind of precondition-reasoning the whole exercise exists to test.

## 6.4 The meta-skill

Across all three problems, the move was identical:

1. **Name the function.** What's the domain, what's the codomain, what's the rule? (Often the problem hides it: an array *is* a function from indices to values; a character mapping *is* a function between alphabets.)
2. **Ask which property is at stake.** Reversible/no-merging → injective. Coverage/everything-hit → surjective. Perfect pairing/undoable → bijective. Forced collision → pigeonhole.
3. **Let the property dictate the code.** Two maps for a bijection check. A counterexample hunt for a broken encoding. A range-vs-codomain diff for a missing element.

That pipeline — *model as a function, identify the property, translate the property into code* — is what the dense chapter summaries in your other files were gesturing at when they said things like "injective and surjective properties show up in hashing and reversible transforms." Now the gesture has a floor under it.

---

# Part 7: Check Yourself — final quiz

Try all of these cold before looking at the answers below. They're ordered easy → hard.

**Q1.** State the two laws a rule must satisfy to be a function. Give a one-line violation of each.

**Q2.** f : ℤ → ℤ, f(x) = x − 5. Injective? Surjective? Prove both answers using the recipes from Part 4.

**Q3.** Your colleague says: "I tested g(x) = (x − 200)² on inputs 0 through 100 and never saw a repeated output, so it's injective on ℤ." Two things are wrong with this. What are they?

**Q4.** A URL shortener maps long URLs to 6-character codes over a 62-character alphabet (a–z, A–Z, 0–9). What does pigeonhole say about this system once it has stored more than 62⁶ ≈ 56.8 billion URLs? What property is being given up, and what's the engineering consequence?

**Q5.** State the contrapositive of: "If a function has an inverse, then it is injective." Is the converse true?

**Q6.** In Isomorphic Strings, suppose you keep only the s→t map and skip the t→s map. Construct a concrete input pair that the broken solution wrongly accepts, and say which property the missing map was enforcing.

---

## Answers

**A1.** Law 1 (totality): every domain element gets an output — violated by f(x) = 1/x claimed on all of ℝ (f(0) undefined). Law 2 (determinism): no input gets two outputs — violated by "f(x) = a number whose square is x" (f(4) ambiguous between ±2).

**A2.** Both. *Injective:* suppose a₁ − 5 = a₂ − 5; add 5 to both sides; a₁ = a₂. ∎ *Surjective:* let b be an arbitrary integer; then b + 5 is an integer and f(b + 5) = b. ∎ (So f is bijective, with inverse f⁻¹(y) = y + 5.)

**A3.** First: examples never prove a "for all" claim (Part 3.1) — testing 101 inputs proves nothing about the rest of ℤ. On 0..100, the outputs of (x − 200)² are strictly decreasing (the inputs all sit on one side of 200), so of course no repeats appeared; the test never had a chance to see a collision. Second: the claim is *false*, and one counterexample shows it: g(199) = 1 and g(201) = 1 — two inputs equidistant from 200 on opposite sides. Both collision partners live outside the tested range, which is exactly why testing can't substitute for proof: a passing test is evidence about the inputs you tried, nothing more.

**A4.** The codomain has exactly 62⁶ elements. Once the number of stored URLs (domain elements in use) exceeds 62⁶, pigeonhole forces two URLs onto the same code — the mapping cannot remain injective. Consequence: the shortener must either grow the code length (enlarge the codomain), refuse new entries, or recycle/disambiguate — and since a shortener's entire job is the inverse lookup code → URL, a non-injective map is fatal, not cosmetic (Part 4.3: not injective ⟹ inverse ambiguous).

**A5.** Contrapositive: "If a function is not injective, then it has no inverse." (Same truth value as the original — and it's exactly the ambiguity argument from Part 4.3.) The converse — "if a function is injective, then it has an inverse" — is **false as stated for f : A → B**: injectivity alone leaves the inverse undefined on codomain elements outside the range (you also need surjectivity). f(x) = 2x on ℤ is injective but f⁻¹(3) doesn't exist.

**A6.** Try s = `"badc"`, t = `"baba"`. Forward map: b→b ✓, a→a ✓, d→b (new entry, accepted) ✓, c→a (new entry, accepted) ✓ — the one-map solution returns true. But d and b both map to b: the mapping is a function yet **not injective**, so it's not a bijection and the strings are not isomorphic. The t→s map is the injectivity check; without it you've verified only Law 2, not one-to-one-ness.

---

# Part 8: Where this connects next

You now own: sets and membership; ∀/∃ and the prove/disprove table; the function laws; codomain vs. range; injective, surjective, bijective with proof recipes for each; the inverse theorem derived from first principles; contrapositive vs. converse; proof by contradiction; pigeonhole; and three interview problems solved by property-recognition instead of pattern-matching.

Natural next steps, in roughly this order — each one leans directly on what's here:

1. **Relations** (functions with the two laws relaxed) and their properties — reflexive, symmetric, transitive. This is the math under equivalence classes, `equals()`/`hashCode()` contracts, and Union-Find.
2. **Induction** — the proof technique for "for all n" claims about recursive structures. It is to recursion what this document's direct proofs are to straight-line code: base case = base case, inductive step = recursive call. This unlocks proving your recursive solutions correct in interviews.
3. **Counting** (combinatorics) — |A × B| = |A|·|B| and the multiplication principle, which together turn "how many states can this system be in?" from a guess into a calculation, and generalize the pigeonhole counting you did here.
4. **Function composition and big-O** — big-O is itself a statement comparing functions ℕ → ℝ, so the vocabulary here is literally the vocabulary of complexity analysis.

The denser chapters in this project (the "shorthand style" ones) should now read differently in the function sections: when they say "hashing is intentionally not injective" or "compression requires near-bijectivity," those are no longer assertions to accept — they're one-line summaries of arguments you can reconstruct.
