# Where to Begin: A Thinking Toolbox for LeetCode

## What to do in the first five minutes so you never face a blank page again

---

## How to read this document

The last document taught one math concept slowly. This one teaches something different: **the process and the small set of tools that experienced developers walk in with**, so that a timed problem is never a blank page.

Here is the honest diagnosis of "I get lost and have to look up the solution." It is almost never a willpower problem, and it is almost never an intelligence problem. It is two missing things:

1. **A process.** Strong solvers run the same checklist every single time, on every problem, no matter how easy or hard. The checklist generates progress even when no idea has arrived yet. You don't have the checklist, so when the idea doesn't arrive in the first minute, there's nothing to do but stare — and staring feels like failing, so you google.

2. **A small pattern vocabulary.** Roughly 8–10 reusable tools cover the large majority of easy and medium problems. Experienced people aren't inventing solutions live; they're *recognizing* which tool the problem is wearing as a costume. You can't recognize tools you've never been formally introduced to.

This document gives you both. Part 1 defines the ground-floor vocabulary from zero — what an algorithm even is, what "Big-O" means, what the basic data structures are and what each one is *fast at*. Part 2 is the process: the exact sequence of moves to make in the first five minutes. Part 3 is the toolbox: each pattern explained like you've never seen it, with the *recognition signal* — the phrase in a problem statement that should make that tool light up. Part 4 is the protocol for being stuck without collapsing. Part 5 is how to practice so this becomes reflex. The cheat sheet is at the end.

One reframe before we start, and it matters: **producing the slow, obvious solution and saying so is a passing performance.** In real interviews, "here's the brute-force approach, it works, it's O(n²), and here's where the waste is" is a *good* answer — often the expected first answer. The skill you're building is not "summon the clever solution from nothing." It is "always have *a* solution, then improve it." That skill is learnable, and it's mostly process.

---

# Part 1: The vocabulary, from the ground floor

You said assume no terms are known. So: the ground floor.

## 1.1 What an algorithm is

An **algorithm** is a precise, step-by-step procedure for solving a problem — so precise that something with no judgment (a computer) can follow it.

A recipe is an algorithm for food. "Look up a word in a dictionary by opening to the middle, seeing if your word comes before or after, and repeating in the correct half" is an algorithm — and it happens to be one of the famous ones (we'll meet it again as *binary search*).

A LeetCode problem hands you inputs and a desired output, and asks you to write the procedure connecting them. That's all "solve" means.

## 1.2 Arrays, indices, and strings

An **array** is a numbered row of boxes, each holding one value. The numbers are called **indices** (singular: **index**), and — this trips up everyone once — **the numbering starts at 0**, not 1.

```
array:   [ 7 ][ 3 ][ 9 ][ 3 ]
index:     0    1    2    3
```

`nums[2]` means "the value in box number 2," which here is 9. The array above has **length** 4, and its last index is 3 — always length minus one. (Off-by-one mistakes, where you accidentally read one box too far, are the most common bug in all of programming. You will make them. Everyone does.)

The crucial physical fact about arrays: **jumping to any box by its number is instant.** Box 0 and box 9,999,999 take the same time to read. But *finding* a value when you don't know its box number means walking the boxes one by one.

A **string** is text — `"hello"` — and for our purposes it behaves like an array of characters: `"hello"[1]` is `"e"`. Most string problems are array problems in costume.

## 1.3 Counting steps: what Big-O actually is

Imagine your solution runs on an array of n items. (**n** is just the conventional name for "the size of the input.") The question Big-O answers is: **as n grows, how fast does your work grow?**

Don't think in seconds — computers differ. Think in **steps**: how many times does your code look at something, compare something, do a little operation?

Walk through the common growth rates slowly, with the dictionary as the running picture:

- **O(1)** — "constant time." The work doesn't depend on n at all. *Reading box 5 of an array.* One step whether the array has ten items or ten million. (Read "O(1)" aloud as "oh of one"; the O is just notation meaning "on the order of.")

- **O(log n)** — "logarithmic." Each step **cuts the remaining work in half**. The dictionary lookup: 1,000-page dictionary → 500 → 250 → 125 → ... you reach one page in about 10 halvings. A *million* pages takes only about 20. That's the magic of halving: doubling the input adds just **one** step. Whenever you see log n, the algorithm is discarding half of something repeatedly.

- **O(n)** — "linear." You touch each item a constant number of times. *Reading every page of the dictionary once.* Double the input, double the work. Any solution that must at least look at all the input can't beat this — O(n) is often the floor, and reaching it is a win.

- **O(n log n)** — the cost of good **sorting**. About n items times a log-n's worth of organizing work each. For n = 100,000 that's roughly 1.7 million steps — completely fine.

- **O(n²)** — "quadratic." For each item, you do something with **every other item**: a loop inside a loop. *Comparing every page of the dictionary to every other page.* Double the input, **quadruple** the work. For n = 100,000 that's 10,000,000,000 steps — billions. This is the one that times out.

Feel the cliff in numbers, because the cliff is the whole point:

| n | O(log n) | O(n) | O(n log n) | O(n²) |
|---|---|---|---|---|
| 1,000 | ~10 | 1,000 | ~10,000 | 1,000,000 |
| 100,000 | ~17 | 100,000 | ~1,700,000 | 10,000,000,000 |
| 1,000,000 | ~20 | 1,000,000 | ~20,000,000 | 1,000,000,000,000 |

A computer comfortably does on the order of 100 million simple steps per second. So at n = 100,000, an O(n²) solution takes minutes; O(n log n) takes a blink. **This is why "find a better solution" is ever necessary at all** — and, as you'll see in Part 4, the problem secretly *tells you* which row of this table you need, in its constraints.

There's also **space complexity** — the same idea applied to extra memory your solution uses instead of steps. A solution that builds a hash map of all n items uses O(n) space. One that uses three variables uses O(1) space. Interviewers ask about both; the vocabulary is identical.

## 1.4 The data structures: what each one is, and what it's fast at

A **data structure** is just a way of organizing data so that certain operations are fast. That's the entire concept — and "what is this one fast at?" is the only question that matters for problem-solving. Here is your starter set. ELI5 picture first, then the speed facts.

**Array** — the numbered row of boxes from 1.2.
*Fast at:* jumping to a position, O(1). *Slow at:* finding a value (must scan, O(n)); inserting in the middle (must shift everything after, O(n)).

**Hash map** (also called dictionary, map, object) — **the single most important tool in this document.** Picture a coat check. You hand over a coat (a **value**) and receive a ticket (a **key**). Later, you present the ticket and get your exact coat back *immediately* — the attendant doesn't search the racks; the ticket number tells them exactly where to go.

A hash map stores key → value pairs and can answer three questions in O(1), regardless of how much it holds:
- "Store this value under this key."
- "What value is under this key?"
- "**Does this key exist at all?**"

That third one is the superpower. An array answers "have I seen the value 7?" by scanning everything: O(n). A hash map answers it instantly: O(1). A vast number of LeetCode optimizations are exactly this swap — replacing an inner search loop with a hash map lookup, turning O(n²) into O(n). (How it pulls this off internally is the hash-function story from the previous document; for problem-solving you only need the speed facts.)

```typescript
const seen = new Map<number, number>(); // key type, value type
seen.set(7, 0);        // store: "value 7 was at index 0"
seen.has(7);           // true — O(1)
seen.get(7);           // 0 — O(1)
```

**Set** — a hash map where you only care about the keys. A guest list: it answers "is this name on the list?" in O(1), nothing more. Use it when you need membership ("have I seen this?") without any attached value.

**Stack** — a stack of plates. You can only add to the top (**push**) and remove from the top (**pop**). The last plate placed is the first one removed — **LIFO**, last-in-first-out. That sounds like a useless restriction; it's actually a precise model of *nesting* and *most-recent-thing-first*: matching brackets, undo history, "go back" buttons. In most languages you just use an array and only touch its end:

```typescript
const stack: string[] = [];
stack.push("(");          // add to top
const top = stack.pop();  // remove from top — both O(1)
```

**Queue** — a line at a store. Add at the back, remove from the front — **FIFO**, first-in-first-out. It models *fairness* and *order of arrival*, and it is the engine inside breadth-first search (coming in Part 4).

**Linked list** — boxes that are *not* in a row. Each box holds a value and an arrow ("pointer") to the next box, wherever it lives. *Fast at:* inserting/removing a box once you're standing at it, O(1) — just rewire arrows. *Slow at:* jumping to position k — there's no numbering; you must walk the arrows, O(n). LeetCode has a whole genre of "rewire the arrows carefully" problems; for now just know the shape.

**Tree** — boxes arranged like a family tree: one box at the top (the **root**), each box pointing down to **children**, boxes with no children called **leaves**. No loops — you can't walk downward and arrive back where you started. File systems, HTML pages, and organization charts are trees. The special variant worth naming: a **binary search tree** keeps everything smaller to the left and larger to the right, so searching it is the dictionary-halving trick in tree form — O(log n) when balanced.

**Graph** — the fully general version: boxes (**nodes**) and connections (**edges**), any shape, loops allowed. Social networks, maps, dependencies. Every tree is a graph; not every graph is a tree. Most graph problems at the easy/medium level reduce to "explore the graph systematically" — Part 4 gives the two ways.

**Heap** (priority queue) — a gadget with one job: always hand you the smallest (or largest) item in O(log n), even as items stream in. Recognition signal: the words "k-th largest," "top k," "k closest." File it; you won't need it for a while.

> **Check Yourself 1.** You're told "given an array of a million numbers, you'll be asked many times whether some number x is present." Which structure, and why?
>
> **Answer.** Pour the array into a **Set** once (O(n) setup), then every "is x present?" is O(1). Answering from the raw array would be O(n) *per question*. This little move — pay once to build a fast structure, then query it cheaply — is the shape of half of all optimizations you'll ever write.

---

# Part 2: The process — what to actually do in the first five minutes

This is the heart of the document. The process below is what fills the silence where googling currently lives. Run it on **every** problem, in order, even when the answer seems obvious — especially in a timed setting, because the process *is* the performance the interviewer wants to see.

## Step 1: Restate the problem in your own words

Read the problem twice. Then say (out loud in an interview, in writing when practicing): "So I'm given ___, and I need to return ___." 

This sounds like a kindergarten move. It catches an enormous fraction of failures, because a huge number of wrong solutions are correct solutions *to a different problem* — return the indices when it wanted the values, count the items when it wanted the longest run, handle one pair when it wanted all pairs. Thirty seconds here saves twenty minutes later.

## Step 2: Interrogate the inputs and outputs

Ask these, every time:

- Can the array be **empty**? Can it have **one** element?
- Can numbers be **negative**? **Zero**? Can there be **duplicates**?
- Is the input **sorted**? (If yes, alarms should ring — see binary search and two pointers in Part 4.)
- What exactly is returned — a value, an index, a count, a boolean, a new array?
- **What are the constraints?** This means the stated bounds like "1 ≤ n ≤ 10⁵." Hold that thought — Step 6 turns constraints into a cheat code.

In an interview, asking these questions *is* scored, positively. The problem is often deliberately underspecified to see whether you probe it.

## Step 3: Work a small example by hand — no code

Take the sample input (or invent a tiny one, 4–6 elements) and produce the answer *yourself, manually, on paper*. Then — this is the actual move — **watch what your own brain did to get it.**

Your hands are smarter than you give them credit for. If, while finding two numbers that sum to 9 in `[2, 7, 11, 15]`, you caught yourself thinking "2... so I need a 7... is there a 7?" — congratulations, you just invented the hash-map solution to Two Sum (Part 4 finishes that story). The algorithm is very often a formalization of what you naturally did by hand. People skip this step because it feels childish. Experts never skip it.

## Step 4: Say the brute force out loud — always

The **brute force** solution is the obvious, try-everything approach with no cleverness: check every pair, try every starting point, test every candidate. State it explicitly: "Brute force: two nested loops over all pairs, check each sum — that's O(n²) time, O(1) space."

Three reasons this is mandatory, not optional:

1. **It's a real answer.** If time runs out, working-but-slow beats clever-but-broken, and infinitely beats blank.
2. **It proves you understand the problem.** You can't brute-force a problem you've misread.
3. **It is the raw material for the good solution.** Which is the next step.

The single most damaging habit of new solvers is skipping this step to hunt for the clever answer directly — and finding nothing, because cleverness has nothing to grip without a baseline to improve. Never start at clever. Start at honest.

## Step 5: Find the waste

Look at your brute force and ask one question: **"What work am I doing over and over that I could remember instead?"**

Almost every optimization at this level is one of three swaps:

- **Recomputation → memory.** The inner loop *searches* for something each time? Remember the candidates in a hash map/set and look them up in O(1). (Kills the inner loop: O(n²) → O(n).)
- **Disorder → order.** Comparisons would be trivial if the data were sorted? Sort first for O(n log n), then often a single pass finishes the job.
- **Re-scanning → reusing.** Recomputing a sum/count over a range that mostly overlaps the previous range? Keep a running total and adjust it (the sliding-window idea, Part 4).

Name the waste in words before reaching for a tool: "the waste is that for every element I re-scan the whole array looking for its partner." Once the waste has a name, the right tool is usually obvious from the toolbox.

## Step 6: Read the constraints as a hint about the intended speed

Here is the cheat code that experienced people use silently. The constraint on n, combined with the ~100-million-steps-per-second fact from 1.3, tells you **which complexity the setters intend**:

| Constraint says | Intended complexity | Which usually means |
|---|---|---|
| n ≤ ~20 | O(2ⁿ) is fine | try all subsets / brute force everything |
| n ≤ ~500 | O(n³) is fine | triple loop acceptable |
| n ≤ ~5,000 | O(n²) is fine | **your brute force will pass — just write it** |
| n ≤ ~100,000 | need O(n log n) or O(n) | sort-first, hash map, two pointers, sliding window, heap |
| n ≤ ~10,000,000 | need O(n) or O(log n) | single pass, running totals, binary search |

Two liberating consequences. If n ≤ 5,000: **stop hunting for cleverness; the brute force is the intended solution.** If n ≤ 100,000 and your idea is O(n²): don't bother polishing it; you already know it's not the destination — go back to Step 5 and find the waste. The constraints have quietly told you the shape of the answer before you've had a single idea.

## Step 7: Match against the toolbox, code it, trace it

With the waste named and the target complexity known, scan Part 4's recognition signals for a match. Code the smallest correct version. Then **trace it**: run your small example from Step 3 through your code line by line, by hand, tracking each variable. Tracing catches off-by-ones and empty-input crashes before the judge does. Finally, deliberately feed it the nasty cases from Step 2: empty, single element, all duplicates, negatives.

That's the whole process. Seven steps, the first six of which require **no idea whatsoever** — they manufacture the idea. That's the point: you are never again waiting for inspiration with nothing to do.

---

# Part 3: One problem, full process, start to finish

Watch the process run once at full length on the most famous problem on the site, so the steps stop being abstract.

> **Two Sum.** Given an array of integers `nums` and an integer `target`, return the **indices** of the two numbers that add up to `target`. Exactly one solution exists; you may not use the same element twice.

**Step 1 — restate.** "Given an array and a target, return the *positions* (not the values) of the two entries summing to the target."

**Step 2 — interrogate.** Indices, not values — noted. Negatives? Allowed. Duplicates? Allowed (e.g., `[3, 3]`, target 6 — two *different* positions, same value, legal). Sorted? **Not promised** — so tools requiring sorted input don't directly apply, and since we must return original indices, sorting would scramble exactly the thing we're asked for. Constraints: n up to 10⁴, so O(n²) would *pass* (Step 6 table) — but the famous follow-up asks for better, so let's earn it.

**Step 3 — by hand.** `nums = [2, 7, 11, 15]`, target 9. My brain: "2 — its partner would be 9 − 2 = 7 — is there a 7? Yes, at index 1. Done." Notice the structure of that thought: *compute the needed partner, then ask whether it exists.* "Does it exist?" — that's the hash-map superpower from 1.4. The solution is already in the room.

**Step 4 — brute force, out loud.** "Try every pair: outer loop i, inner loop j > i, check nums[i] + nums[j] === target. O(n²) time, O(1) space. Correct, would pass at these constraints."

```typescript
function twoSumBrute(nums: number[], target: number): number[] {
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      if (nums[i] + nums[j] === target) return [i, j];
    }
  }
  return []; // unreachable per problem statement
}
```

**Step 5 — name the waste.** "For each element, the inner loop *re-scans the array* hunting for one specific value — the partner. Hunting for a specific value is exactly what a hash map does in O(1)." The fix: walk the array once; for each element, ask the map "has my partner already walked past?"; if not, register myself (value → index) so *future* elements can find *me*.

**Step 6 — constraints.** Target was O(n); this is one pass with O(1) work per element. On target.

**Step 7 — code and trace.**

```typescript
function twoSum(nums: number[], target: number): number[] {
  const seen = new Map<number, number>(); // value → index where it lives

  for (let i = 0; i < nums.length; i++) {
    const partner = target - nums[i];
    if (seen.has(partner)) {
      return [seen.get(partner)!, i]; // partner's index, then mine
    }
    seen.set(nums[i], i); // register myself for future elements
  }
  return [];
}
```

Trace on `[2, 7, 11, 15]`, target 9: i=0 → partner 7 → map empty, no → register 2→0. i=1 → partner 2 → **map has 2** → return [0, 1]. ✓ Nasty case `[3, 3]`, target 6: i=0 registers 3→0; i=1 wants partner 3, finds it, returns [0, 1] — duplicates handled, and registering *after* checking is what prevented an element from partnering with itself. That ordering wasn't luck; trace-by-hand is where you notice it matters.

One pass, O(n) time, O(n) space — we *bought* speed with memory, the recomputation→memory swap from Step 5. That trade is the most common deal in algorithms, and now you've executed it once yourself rather than read someone else's.

---

# Part 4: The toolbox

Each tool: the picture, the recognition signal, a small worked example, the complexity. These eight cover the bulk of easy/medium array, string, and basic structure problems. Patterns, not memorized solutions — the same tool reappears in fifty costumes.

## Tool 1: Hash map / set — "have I seen this before?"

Already earned above. The general form: **any time a loop's job is to *find* or *check for* something, a hash map or set can usually do that job in O(1).**

**Recognition signals:** "find a pair/partner/complement," "contains duplicate," "first unique/repeated element," "have these letters appeared," anything where you'd naturally say *seen*.

**Variant — frequency counting:** map each item to *how many times* it has appeared. This single move solves Valid Anagram (do both strings have identical letter counts?), Majority Element, Top K Frequent, and dozens more:

```typescript
const counts = new Map<string, number>();
for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
```

**Complexity:** typically turns O(n²) into O(n) time, paying O(n) space.

## Tool 2: Two pointers — squeeze from both ends

The picture: two fingers on the array — commonly one at the start (**left**), one at the end (**right**) — moved inward according to a rule until they meet. The power source: when data is **sorted**, comparing the two finger values tells you which finger is *safe to move*, eliminating many pairs at once without checking them.

Worked example — Two Sum, but on a **sorted** array, returning values: `[1, 3, 4, 6, 8, 11]`, target 10. Fingers at 1 and 11: sum 12, too big — only shrinking the big side can help, so move right inward. Now 1 + 8 = 9, too small — move left. 3 + 8 = 11 — move right. 3 + 6 = 9 — move left. 4 + 6 = 10 ✓. Each step discarded an entire element's worth of pairs from consideration; total work O(n), and unlike the hash map, O(1) extra space.

```typescript
function twoSumSorted(nums: number[], target: number): number[] {
  let left = 0, right = nums.length - 1;
  while (left < right) {
    const sum = nums[left] + nums[right];
    if (sum === target) return [nums[left], nums[right]];
    if (sum < target) left++;   // too small: need a bigger left
    else right--;                // too big: need a smaller right
  }
  return [];
}
```

**Recognition signals:** the input is **sorted** (or sorting it wouldn't destroy the answer); "pair in sorted array," "is it a palindrome" (fingers at both ends walking inward comparing characters), "remove duplicates in place," "container with most water," merging two sorted lists (one finger per list).

**Complexity:** O(n) time, O(1) space — the fingers only ever move inward, so total movement is bounded by n.

## Tool 3: Sliding window — a stretchy two-pointer for ranges

The picture: both fingers start at the left, and the stretch of array *between* them is the **window**. The right finger advances, growing the window; whenever the window violates the problem's rule ("no repeated characters," "sum ≤ k"), the left finger advances, shrinking it until the rule holds again. The window slithers rightward, growing and shrinking, and you record the best window seen.

The waste it eliminates (Step 5's third swap): the brute force re-examines every possible range from scratch — O(n²) ranges. The window never rebuilds; it *adjusts*, adding one element on the right, removing some on the left, **maintaining a running summary** (a sum, or a set of what's currently inside) instead of recomputing it.

Worked example — Longest Substring Without Repeating Characters, on `"abcabcbb"`: grow `a`, `ab`, `abc` (length 3, best so far); right finger hits a second `a` — violation — shrink from left until the first `a` leaves; window `bca`; continue: `bcab` violates, shrink to `cab`... best stays 3. One left-to-right sweep of each finger: O(n).

```typescript
function lengthOfLongestSubstring(s: string): number {
  const inWindow = new Set<string>();
  let left = 0, best = 0;
  for (let right = 0; right < s.length; right++) {
    while (inWindow.has(s[right])) {   // rule violated:
      inWindow.delete(s[left]);        // shrink from the left
      left++;
    }
    inWindow.add(s[right]);
    best = Math.max(best, right - left + 1);
  }
  return best;
}
```

(Notice it's Tool 1 *inside* Tool 3 — the set answers "is this character already in the window?" in O(1). Tools compose; that's why a small kit covers so much.)

**Recognition signals:** "longest/shortest **substring** or **subarray** such that ___," "maximum sum of a window of size k," "minimum window containing ___." The words *contiguous*, *substring*, *subarray* are the giveaway — windows are for **runs**, never for scattered picks.

**Complexity:** O(n) — each finger moves only forward, at most n steps each.

## Tool 4: Stack — matching, nesting, and "most recent first"

The plate-stack from 1.4. The deep reason it solves so many problems: **whenever the thing you must respond to is the *most recent unresolved* thing, a stack is the physically correct container** — the most recent unresolved thing is, by construction, sitting on top.

Worked example — Valid Parentheses: is `"([{}])"` properly nested? Rule: a closing bracket must match the most recently opened, not-yet-closed bracket. *Most recent unresolved* — stack. Walk the string: opener → push it; closer → pop and check it matches; mismatch or empty stack → invalid; leftover openers at the end → invalid.

```typescript
function isValid(s: string): boolean {
  const stack: string[] = [];
  const match: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push(ch);
    } else {
      if (stack.pop() !== match[ch]) return false;
    }
  }
  return stack.length === 0;
}
```

Trace `"([)]"`: push `(`, push `[`, see `)` → pop gives `[` ≠ `(` → false. The stack caught improper nesting that mere *counting* of brackets would miss — counts are balanced here; *order* isn't.

**Recognition signals:** brackets/tags/quotes that open and close; "undo"; evaluating expressions; "next greater element" (a famous family where the stack holds elements still waiting for their answer); anything where you process items and sometimes must *back up to the latest pending one*.

**Complexity:** O(n) time — each element is pushed once and popped at most once.

## Tool 5: Sort first — buy order, then cash it in

Sorting costs O(n log n) — and at LeetCode constraints, that's almost always affordable (Step 6 table). What it buys: equal items become **adjacent**; "closest" becomes "neighboring"; two pointers (Tool 2) becomes legal; and many questions collapse from hard to trivial.

- "Are there duplicates?" — sort, then check neighbors. (Or use a set; both work — having two tools for one job is normal.)
- "Merge overlapping intervals" — sort by start time; overlaps are now adjacent; one pass merges them.
- "3Sum / pair with smallest difference" — sort, then two pointers.

**The one caution**, met already in Two Sum: sorting destroys original positions. If the answer is *indices*, either sort a copy of (value, original-index) pairs, or pick a different tool.

**Recognition signal:** you catch yourself wishing equal or near-equal items were next to each other — that wish *is* the signal. Ask Step 5's question as: "would this be easy if the input were sorted?" If yes, and order-destruction is acceptable, sort.

## Tool 6: Binary search — discard half, repeatedly

The dictionary trick from 1.3, named. Requirements: the data is **sorted** (or, more generally, the answers form a yes/no pattern that flips exactly once — all "no"s then all "yes"s). Then: probe the middle; the result tells you which half the target lives in; discard the other half; repeat. O(log n) — twenty probes searches a million items.

```typescript
function binarySearch(nums: number[], target: number): number {
  let lo = 0, hi = nums.length - 1;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (nums[mid] === target) return mid;
    if (nums[mid] < target) lo = mid + 1;  // target is in right half
    else hi = mid - 1;                     // target is in left half
  }
  return -1; // not present
}
```

Honesty note: binary search is famously easy to get *almost* right — the `<=` vs `<`, the `mid + 1` vs `mid` — so when practicing, always trace it on a 2-element and a 1-element array by hand. (Knuth called it one of the most bug-prone simple algorithms ever; you're in good company when you fumble it.)

**Recognition signals:** "sorted" plus "find/search," O(log n) demanded by huge constraints, "find the first/last position where ___," "minimum value such that ___ works" (the yes/no-flip form — file that phrase; it unlocks a whole medium-tier genre later).

## Tool 7: BFS and DFS — the two ways to explore anything

Trees and graphs (1.4) all yield to the same meta-move: **visit everything systematically, never visiting the same node twice.** There are exactly two orders to do it in, and they correspond to two containers you already own:

**DFS — depth-first search.** Go *deep*: follow a path as far as it goes, then back up to the most recent junction and try the next branch. "Most recent junction" — that's the stack's phrase (Tool 4), and indeed DFS runs on a stack, usually the implicit one provided by **recursion** (a function calling itself; each pending call *is* a plate on the plates-stack). Maze strategy: keep your left hand on the wall.

**BFS — breadth-first search.** Go *wide*: visit everything 1 step away, then everything 2 steps away, ring by ring, like a ripple. Order-of-arrival fairness — that's the **queue** (Tool 4's sibling). BFS's special property, worth memorizing as a fact: **in an unweighted graph, BFS reaches every node by a shortest path.** So "minimum number of moves/steps" → BFS, nearly always.

Worked micro-example — Number of Islands: a grid of land/water cells; count the connected blobs of land. Scan the grid; on finding unvisited land, that's one new island — then flood outward from it (DFS or BFS, either works) marking every connected land cell as visited so it's never counted again. The flood is the explore-everything move; the scan counts how many times you had to start a flood.

The one non-negotiable mechanic in both: a **visited set** (Tool 1 again). Without it, graphs with loops will walk you in circles forever.

**Recognition signals:** grids, mazes, trees, "connected," "islands/regions/provinces," "shortest path / fewest moves" (→ BFS specifically), "all paths / does a path exist" (→ DFS is fine).

**Complexity:** O(nodes + edges) — everything visited once. For a grid of r×c cells: O(r·c).

## Tool 8: One-pass tracking — carry a running answer

The humblest pattern, and the most secretly common: walk the array **once**, carrying one or two variables that summarize everything behind you — a running max, a running sum, the best-so-far, the smallest-so-far. At each element, update the carried values; at the end, the answer is in your hand.

Worked example — Best Time to Buy and Sell Stock: given daily prices, maximize (sell price − earlier buy price). Brute force checks all pairs, O(n²); the waste (Step 5) is that for each sell day, you re-scan the past for the cheapest buy day — but the cheapest-so-far is a single number you could just *carry*:

```typescript
function maxProfit(prices: number[]): number {
  let cheapestSoFar = Infinity;
  let bestProfit = 0;
  for (const price of prices) {
    cheapestSoFar = Math.min(cheapestSoFar, price);          // best buy behind me
    bestProfit = Math.max(bestProfit, price - cheapestSoFar); // sell today?
  }
  return bestProfit;
}
```

O(n) time, O(1) space, four lines. **Recognition signals:** "maximum/minimum ___ so far," "best single transaction," "max subarray sum" (the famous Kadane's algorithm is exactly this pattern), any time the past can be compressed into one or two numbers.

## What's deliberately NOT in the toolbox yet

**Dynamic programming, backtracking, advanced graph algorithms, tries, union-find.** They're real, they're learnable, and they are *not* prerequisites for holding your own on easies and most mediums. If a problem seems to demand them, the honest play right now is: state the brute force (Step 4 — it's usually a recursion that tries everything), say "this looks like it wants dynamic programming, which I'd approach by caching these repeated subproblems," and move on without shame. A correctly-identified hard problem with a stated brute force is a respectable interview outcome. These tools are Volume 2; the eight above are Volume 1, and Volume 1 is where the win rate lives.

---

# Part 5: The stuck protocol — what to do instead of googling

Even with everything above, you will get stuck. Stuck is normal; what distinguishes solvers is having moves *while* stuck. Run these in order, each for a minute or two:

**1. Re-run Step 3 on a different example.** Invent a second tiny input — especially a weird one (duplicates, negatives, already-sorted) — and solve it by hand. Watch your hands again. A second example often exposes the mechanism the first one hid.

**2. Re-ask the waste question against each tool.** Go down the cheat sheet literally, line by line: "Is my brute force *searching* for something each iteration? (hash map) ... Is the input sorted or sortable? (two pointers / binary search) ... Is the answer about a contiguous run? (window) ... Am I responding to the most recent unresolved thing? (stack) ... Could one carried variable summarize the past? (one-pass)." This is not cheating; this *is* the method. Pattern matching by checklist is what the fluent version of you will eventually do invisibly.

**3. Solve a smaller version of the problem.** Array of size 2. Then size 3. What changed between them? The change is often the algorithm: "to handle one more element, I need to know ___ about everything before it" — and *that ___* is your carried state (Tool 8) or your map (Tool 1).

**4. Say the constraint-table verdict out loud.** "n is 10⁵, so I need roughly O(n log n); my idea is O(n²), so I shouldn't polish it — the gap means there's a tool I haven't applied." Knowing your idea is *structurally* wrong, not detail-wrong, redirects energy correctly.

**5. After 20–25 minutes of genuine effort: look at the solution — but with rules.** This is the part that turns looking-it-up from failure into training. Read only until the *idea* clicks ("oh — sliding window"), then **close it and implement from the idea alone**, no peeking at code. Afterwards, write one sentence in your own words: "the signal I missed was ___; the tool was ___." Then — non-negotiable — **re-solve the same problem from scratch 2–3 days later.** Looking up answers isn't the sin; looking them up *without the re-solve* is, because then the pattern was rented, not bought.

And the willpower question, answered honestly: yes, sitting with confusion for twenty minutes is uncomfortable, and yes, tolerance for that discomfort grows with practice. But notice the structure of this protocol — it converts dead staring into a sequence of *actions*. Discomfort with nothing to do is what breaks people. Discomfort with a checklist is just work.

---

# Part 6: How to practice so this becomes reflex

The toolbox only fires under time pressure if it's been installed by the right kind of repetition. Three rules:

**Practice by pattern, not at random.** Random problems force you to guess the tool *and* learn the tool simultaneously — maximal frustration, minimal learning. Instead: one tool per week. Solve 5–8 problems all known to be that pattern (LeetCode tags and any "Grind 75"-style list organize by pattern). By problem four, you'll feel the recognition reflex forming — "oh, this is the window again, in a new costume." *That feeling is the entire skill.* Only after a tool feels boring do you mix patterns to train recognition itself.

**The 20-minute rule with the re-solve, every time.** As specified in the stuck protocol. The re-solve days later is what moves a pattern from "seen once" to "owned" — without it, you can read solutions for a year and gain nothing, which is precisely the trap you described.

**Narrate, even alone.** Run Steps 1–6 out loud (or in writing) on every practice problem, including easy ones. Two reasons: the narration *is* what interviews grade, so practicing silent solving trains the wrong event; and verbalizing the waste ("I keep re-scanning for the partner") is reliably the moment the tool announces itself. The process from Part 2 should eventually take under three minutes and feel like brushing your teeth.

A realistic calibration so you don't misread normal difficulty as personal deficiency: a new developer practicing by-pattern can expect easies to feel routine after a few focused weeks, and the listed mediums for a *known* pattern to fall reliably soon after. Mediums for *unrecognized* patterns stay hard for everyone much longer — that's the game being the game, not you failing at it.

---

# Part 7: The cheat sheet

## The process (run every time, in order)

1. **Restate** the problem in your own words — input, output, exactly what's returned.
2. **Interrogate**: empty? one element? negatives? duplicates? sorted? constraints?
3. **Hand-solve** a tiny example — and watch what your brain did.
4. **State the brute force** out loud, with its complexity. Always.
5. **Name the waste**: what am I recomputing that I could remember / reorder / reuse?
6. **Read the constraints** → target complexity (table below).
7. **Match a tool**, code it small, **trace it by hand**, then feed it the nasty cases.

## Constraints → intended complexity

| n up to... | You can afford | So probably... |
|---|---|---|
| ~20 | O(2ⁿ) | try everything / all subsets |
| ~500 | O(n³) | triple loop fine |
| ~5,000 | O(n²) | **brute force is the intended answer** |
| ~100,000 | O(n log n) / O(n) | sort, hash map, two pointers, window, heap |
| ~10⁷+ | O(n) / O(log n) | one pass or binary search |

(Yardstick: ~10⁸ simple steps ≈ 1 second.)

## Signal → tool

| When the problem says / you notice... | Reach for | Typical result |
|---|---|---|
| "find a pair / complement / duplicate / seen before" | **Hash map / set** | O(n²) → O(n), pay O(n) space |
| counts of letters/items matter ("anagram," "frequency") | **Frequency map** | one pass + compare |
| input is **sorted** + pairs/palindrome/merge | **Two pointers** | O(n) time, O(1) space |
| "longest/shortest **substring/subarray** such that ___" | **Sliding window** | O(n), contiguous runs only |
| brackets, nesting, undo, "most recent unresolved" | **Stack** | O(n), push/pop each item once |
| "wish equal/close items were adjacent"; intervals | **Sort first** | O(n log n), then easy pass — careful if indices needed |
| sorted + search; "first/last position"; huge n | **Binary search** | O(log n); trace tiny cases, it bites |
| grid / maze / connected / islands | **DFS or BFS** + visited set | O(nodes + edges) |
| "**shortest path / fewest moves**" (unweighted) | **BFS specifically** | shortest by construction |
| "best so far," "max profit," "max subarray sum" | **One-pass tracking** | O(n), O(1) space |
| "k-th largest / top k / k closest" | **Heap** | O(n log k) — learn later, recognize now |

## Data structure speed facts

| Structure | Killer move | Cost |
|---|---|---|
| Array | jump to index i | O(1) |
| Array | find a value / insert middle | O(n) |
| Hash map / set | has? / get / set | O(1) |
| Stack | push / pop (top only) | O(1) |
| Queue | enqueue back / dequeue front | O(1) |
| Sorting | reorder everything | O(n log n) |
| Binary search (sorted) | find | O(log n) |
| Heap | smallest/largest of stream | O(log n) per op |

## The stuck protocol

1. Hand-solve a *second*, weirder example.
2. Walk the signal→tool table line by line against your named waste.
3. Solve size-2, then size-3; the difference is the algorithm.
4. Compare your idea's complexity to the constraints' verdict — structurally wrong ≠ detail wrong.
5. After ~20 min: read the solution **idea only**, close it, implement yourself, write the one-sentence lesson, **re-solve in 2–3 days**.

## The three mindset facts

- Brute force stated clearly is a **passing answer**, and the raw material for every better one.
- The process needs **no inspiration** — six of its seven steps work on any problem before you have a single idea.
- Looking up solutions is training **only with the re-solve**. Rented patterns vanish; bought ones stay.
