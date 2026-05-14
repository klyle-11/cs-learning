# Regex Engine via NFA Construction + Simulation (Thompson's Algorithm)

> **What this teaches**: The most satisfying ~200 lines you'll write in your career. The moment "an NFA is just a set of current states" lands, you understand a chunk of computing — formal languages, parsing, lexing, the theory of computation — at a level that no textbook diagram delivers. After this, you cannot un-see automata.

**Language**: Rust
**Effort**: a long day
**Companion reads**: 3.1 Pratt parser (compile-time grammar, parallel skill), 3.2 JSON parser (state machines without backtracking), Russ Cox's *"Regular Expression Matching Can Be Simple And Fast"* (the canonical popular-CS article on this exact algorithm)

---

## 1. Why this matters

Almost every regex engine you've ever used — Perl, PCRE, Python's `re`, JavaScript's `RegExp`, Java's `Matcher`, Ruby — uses **backtracking**. Backtracking is conceptually a recursive search of all possible matches. It has two profound problems:

1. **Catastrophic backtracking.** Some regexes against some inputs take *exponential* time. The infamous `(a+)+b` against `"aaaaaaaaaaaaaaaaaaaac"` is the canonical example. Real production outages have been caused by user-submitted regexes triggering this (Cloudflare's 2019 global outage). This is **ReDoS** — Regular Expression Denial of Service, CWE-1333.

2. **It's the wrong algorithm.** Ken Thompson described the right algorithm in 1968. It runs in **linear time, always**, and uses **bounded memory**. The trick is to simulate a nondeterministic finite automaton (NFA) by tracking the *set* of states the machine could currently be in, rather than backtracking to try each possibility one at a time.

This algorithm — Thompson's construction + NFA simulation — is what powers `grep`, `ripgrep`, Go's `regexp`, Rust's `regex`, RE2 (Google's open-source library). It is also one of the most elegant pieces of code in all of CS. You can write the whole thing in ~200 lines.

The reason this exercise is on the "five worth doing" list: when you finish, you will *understand the theory of computation*, not in a hand-wavy way, but at the level of *"oh, an NFA is data, and a simulation is iteration."* This generalizes — to lexer generators, to protocol state machines, to model checking, to verification. It is one of those rare implementations that rewires how you see the field.

---

## 2. The plan, end-to-end

We're building a **subset of regex** — enough to demonstrate the algorithm without drowning in features.

Supported syntax:
- Literal characters: `a`, `b`, `0`-`9`, etc.
- Concatenation: `ab` (implicit)
- Alternation: `a|b`
- Kleene star: `a*`
- One or more: `a+`
- Optional: `a?`
- Grouping: `(ab)`
- Wildcard: `.` (any single character)

Not supported (left as extensions): character classes (`[a-z]`), anchors (`^`, `$`), backreferences (`\1`), lookaround, captures.

Pipeline:
```
"a(b|c)*"  →  tokens  →  postfix  →  NFA  →  simulate against input
            (lex)     (shunting   (Thompson)   (set-based)
                       yard)
```

Each stage is small, testable, and worth understanding on its own.

---

## 3. Postfix conversion (the shunting yard)

We could parse infix directly, but converting to postfix (RPN) first makes Thompson's construction *trivial* — it becomes a simple stack walk. The trick: regex doesn't have an explicit concatenation operator, so we insert one (we'll use `.`, but wait, `.` is wildcard — fine, we'll use `~` internally) before running the shunting yard.

```rust
// regex.rs — first half

// Internal token for concatenation we insert.
const CONCAT: char = '\u{0001}';   // unprintable; can't conflict with input

fn insert_concat(re: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = re.chars().collect();
    for i in 0..chars.len() {
        let c = chars[i];
        out.push(c);
        if i + 1 >= chars.len() { continue; }
        let next = chars[i + 1];

        // Insert ~ between two atoms.
        // c is an "atom-end"  if it is: literal, ')', '*', '+', '?', '.'
        // next is "atom-start" if it is: literal, '(', '.'
        let c_ends    = !matches!(c,    '(' | '|');
        let next_starts = !matches!(next, ')' | '|' | '*' | '+' | '?');
        if c_ends && next_starts {
            out.push(CONCAT);
        }
    }
    out
}

fn to_postfix(re: &str) -> Result<String, String> {
    // Shunting yard. Precedence: * + ?  >  ~ (concat)  >  |
    fn prec(c: char) -> i32 {
        match c {
            '|'      => 1,
            CONCAT   => 2,
            '*'|'+'|'?' => 3,
            _ => 0,
        }
    }
    let mut output = String::new();
    let mut ops: Vec<char> = Vec::new();
    for c in re.chars() {
        match c {
            '(' => ops.push(c),
            ')' => {
                while let Some(&top) = ops.last() {
                    if top == '(' { ops.pop(); break; }
                    output.push(ops.pop().unwrap());
                }
            }
            '|' | CONCAT | '*' | '+' | '?' => {
                while let Some(&top) = ops.last() {
                    if top == '(' { break; }
                    if prec(top) >= prec(c) {
                        output.push(ops.pop().unwrap());
                    } else { break; }
                }
                ops.push(c);
            }
            _ => output.push(c),    // literal
        }
    }
    while let Some(op) = ops.pop() { output.push(op); }
    Ok(output)
}
```

Quick worked example. `a(b|c)*` after `insert_concat` is `a~(b|c)*`. After `to_postfix`:

```
input    stack       output
a                    a
~        ~           a
(        ~ (         a
b        ~ (         ab
|        ~ ( |       ab
c        ~ ( |       abc
)        ~           abc|
*        ~ *         abc|
                     abc|*
                     abc|*~
```

Final postfix: `abc|*~`. Read as: push `a`, push `b`, push `c`, apply alternation (pops `b` and `c`), apply star (pops `bc|`), apply concat (pops `a` and `bc|*`).

The whole point of postfix is that **each operator's operands are sitting on the stack right above it.** Thompson's construction becomes a one-pass walk where each operator pops fragments off a stack and pushes a new one.

---

## 4. NFA representation

The cleanest representation (Cox's design, also what RE2 uses internally) is:

```rust
type StateId = usize;

#[derive(Debug, Clone)]
enum State {
    // Match a specific char, then go to `next`.
    Char(char, StateId),
    // Match any single char (the '.' regex).
    Any(StateId),
    // Epsilon-transition: split into two parallel branches.
    Split(StateId, StateId),
    // Accept state.
    Match,
}

struct Nfa {
    states: Vec<State>,
    start:  StateId,
}
```

Every state has **at most two outgoing transitions**. That's the entire constraint that makes Thompson's NFAs simulatable cheaply. Concatenation and Kleene star both fit because of `Split`.

A **dangling pointer** problem hides here: when you build the NFA piece by piece, sub-fragments have *unfilled* outgoing edges that will be filled when the fragment is composed with the next one. The clean way is to track the list of "outgoing pointers needing fill" with each fragment.

```rust
struct Fragment {
    start: StateId,
    // Indices into `nfa.states` whose `next` slot still needs to be patched.
    // Each entry is (state_id, which_field) where which_field is 0 or 1
    // for Split's two branches, or 0 for Char/Any.
    outs: Vec<(StateId, u8)>,
}
```

A `Fragment` has a known start state and a *list of holes* — places where the next state ID hasn't been decided yet. To concatenate fragment A then B, you patch all of A's outs to point at B's start.

---

## 5. Thompson's construction

The whole machine.

```rust
fn compile(postfix: &str) -> Result<Nfa, String> {
    let mut nfa = Nfa { states: Vec::new(), start: 0 };
    let mut stack: Vec<Fragment> = Vec::new();

    // Allocate a placeholder state; returns its id.
    fn alloc(nfa: &mut Nfa, s: State) -> StateId {
        nfa.states.push(s);
        nfa.states.len() - 1
    }

    // Patch each (state_id, field) in outs to point at target.
    fn patch(nfa: &mut Nfa, outs: &[(StateId, u8)], target: StateId) {
        for &(sid, field) in outs {
            match &mut nfa.states[sid] {
                State::Char(_, next) | State::Any(next) => *next = target,
                State::Split(a, b)   => if field == 0 { *a = target } else { *b = target },
                State::Match         => {}
            }
        }
    }

    for c in postfix.chars() {
        match c {
            CONCAT => {
                let b = stack.pop().ok_or("concat: missing rhs")?;
                let a = stack.pop().ok_or("concat: missing lhs")?;
                patch(&mut nfa, &a.outs, b.start);
                stack.push(Fragment { start: a.start, outs: b.outs });
            }
            '|' => {
                let b = stack.pop().ok_or("alt: missing rhs")?;
                let a = stack.pop().ok_or("alt: missing lhs")?;
                let split = alloc(&mut nfa, State::Split(a.start, b.start));
                let mut outs = a.outs; outs.extend(b.outs);
                stack.push(Fragment { start: split, outs });
            }
            '*' => {
                let a = stack.pop().ok_or("star: missing operand")?;
                // sentinel target patched below
                let split = alloc(&mut nfa, State::Split(a.start, 0));
                patch(&mut nfa, &a.outs, split);
                stack.push(Fragment {
                    start: split,
                    outs: vec![(split, 1)],     // second branch of split is the exit
                });
            }
            '+' => {
                let a = stack.pop().ok_or("plus: missing operand")?;
                let split = alloc(&mut nfa, State::Split(a.start, 0));
                patch(&mut nfa, &a.outs, split);
                stack.push(Fragment {
                    start: a.start,             // must match at least once, so start at a
                    outs: vec![(split, 1)],
                });
            }
            '?' => {
                let a = stack.pop().ok_or("opt: missing operand")?;
                let split = alloc(&mut nfa, State::Split(a.start, 0));
                let mut outs = a.outs; outs.push((split, 1));
                stack.push(Fragment { start: split, outs });
            }
            '.' => {
                let s = alloc(&mut nfa, State::Any(0));
                stack.push(Fragment { start: s, outs: vec![(s, 0)] });
            }
            ch => {
                let s = alloc(&mut nfa, State::Char(ch, 0));
                stack.push(Fragment { start: s, outs: vec![(s, 0)] });
            }
        }
    }
    let frag = stack.pop().ok_or("empty regex")?;
    if !stack.is_empty() { return Err("malformed regex (extra fragments)".into()); }
    let m = alloc(&mut nfa, State::Match);
    patch(&mut nfa, &frag.outs, m);
    nfa.start = frag.start;
    Ok(nfa)
}
```

Stop and look. **This is the entire compiler.** Every case is ~5 lines, and they all do the same shape of thing: pop fragments from the stack, allocate maybe one `Split`, patch dangling edges, push the resulting fragment.

The Thompson trick is that **every fragment has exactly one entry and a list of exits.** Composition is gluing exits to entries. No tree, no recursion, no node types beyond the three NFA state variants.

**Trace `abc|*~`** (which is `a(b|c)*`):

1. `a` → push fragment(start=Char('a',?), outs=[Char('a').next])
2. `b` → push fragment(Char('b',?), outs=[Char('b').next])
3. `c` → push fragment(Char('c',?), outs=[Char('c').next])
4. `|` → pop b, c; alloc Split(b.start, c.start); push fragment(Split, outs = b.outs ++ c.outs)
5. `*` → pop the alt; alloc Split(alt.start, exit); patch alt.outs back to the Split; push fragment(Split, outs=[Split.branch1])
6. `~` → pop a, the star-frag; patch a.outs to star.start; push fragment(a.start, outs=star.outs)
7. End: alloc Match, patch outs to it. start = a.start.

Pencil-and-paper this once. The penny drops.

---

## 6. NFA simulation — the heart of it

Now the moment everything earns its keep. To match a string against the NFA:

- Track the *set* of states the machine could be in right now.
- For each input character: from the current set, compute the next set (every state reachable by consuming this char).
- After each character, follow all epsilon-transitions (Splits) to expand the set.
- If the Match state is in the set at end-of-input, the string matches.

The set of states is bounded by the number of NFA states (which is linear in regex length). The work per input character is bounded by the set size. Therefore: **O(n*m)** where n = input length and m = regex length. **No exponential blowup.**

```rust
fn matches(nfa: &Nfa, input: &str) -> bool {
    let n = nfa.states.len();

    // Two reusable bitmaps to avoid allocation per char.
    let mut current = vec![false; n];
    let mut next    = vec![false; n];
    // We also track the order of additions for trace clarity; not required.

    // Follow epsilon transitions from `from`, adding all reachable states
    // into `set`. Uses a stack to avoid recursion. Marks visited via `set`.
    fn add_state(nfa: &Nfa, set: &mut [bool], from: StateId) {
        let mut stack = vec![from];
        while let Some(s) = stack.pop() {
            if set[s] { continue; }
            set[s] = true;
            if let State::Split(a, b) = nfa.states[s] {
                stack.push(a);
                stack.push(b);
            }
        }
    }

    add_state(nfa, &mut current, nfa.start);

    for ch in input.chars() {
        for s in next.iter_mut() { *s = false; }
        for sid in 0..n {
            if !current[sid] { continue; }
            match nfa.states[sid] {
                State::Char(c, next_sid) if c == ch => add_state(nfa, &mut next, next_sid),
                State::Any(next_sid)               => add_state(nfa, &mut next, next_sid),
                _ => {}    // Split handled by add_state; Match doesn't consume input
            }
        }
        std::mem::swap(&mut current, &mut next);
    }

    current.iter().enumerate().any(|(i, &on)| on && matches!(nfa.states[i], State::Match))
}
```

This is the algorithm. Twenty-five lines. **No backtracking. No recursion. No catastrophic blow-up — ever.**

Step through it mentally with the NFA for `a(b|c)*` and input `"abcbc"`:

- Initial: `current = {start}` then `add_state` expands through the Split for the star → includes Char('a') state, includes the post-star Match-bound state.
- Consume `a`: only the Char('a') state matches, advances. `next = {after-a}`. Then `add_state` from after-a expands through the star's Split, which can go to Char('b'), Char('c'), or exit to Match.
- Consume `b`: only Char('b') matches; `next = {after-b}`. Expand through Split again.
- And so on. At end of input, Match is in `current`. → true.

Now try `"abx"`. After consuming `a`, expand. Consume `b`. Now consume `x`: no Char(_, _) matches `x`. `next` is empty. After swap, `current` is empty. We're done — no match.

That last detail is crucial: **once the set goes empty, no recovery is possible.** No backtracking, no second chance — that's the property that makes the algorithm linear-time.

---

## 7. Tying it together

```rust
pub fn compile_and_run(re: &str, input: &str) -> Result<bool, String> {
    let with_concat = insert_concat(re);
    let postfix     = to_postfix(&with_concat)?;
    let nfa         = compile(&postfix)?;
    Ok(matches(&nfa, input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn literal() {
        assert!(compile_and_run("abc", "abc").unwrap());
        assert!(!compile_and_run("abc", "abd").unwrap());
    }

    #[test] fn star() {
        assert!(compile_and_run("a*", "").unwrap());
        assert!(compile_and_run("a*", "aaaa").unwrap());
        assert!(!compile_and_run("a*", "aab").unwrap());  // we match the whole string
    }

    #[test] fn alternation() {
        assert!(compile_and_run("a|b", "a").unwrap());
        assert!(compile_and_run("a|b", "b").unwrap());
        assert!(!compile_and_run("a|b", "c").unwrap());
    }

    #[test] fn group_and_star() {
        assert!(compile_and_run("a(bc)*", "a").unwrap());
        assert!(compile_and_run("a(bc)*", "abcbc").unwrap());
        assert!(!compile_and_run("a(bc)*", "abcb").unwrap());
    }

    #[test] fn the_pathological_case() {
        // a(a+)+ against "aaaaaaaaaaaa..." — would blow up a backtracker.
        // Ours runs in linear time.
        let big_a: String = "a".repeat(100);
        assert!(compile_and_run("(a+)+", &big_a).unwrap());
        let big_a_then_b: String = format!("{}b", "a".repeat(100));
        // Our matcher requires the whole string match; "aaa...b" doesn't.
        assert!(!compile_and_run("(a+)+", &big_a_then_b).unwrap());
    }

    #[test] fn wildcard() {
        assert!(compile_and_run("a.c", "abc").unwrap());
        assert!(compile_and_run("a.c", "azc").unwrap());
        assert!(!compile_and_run("a.c", "ac").unwrap());
    }
}
```

When `the_pathological_case` passes in microseconds where any backtracking engine would hang for minutes or seconds, *that* is the moment the algorithm earns its mythological status.

---

## 8. Complexity analysis

| Op | Complexity | Notes |
|----|------------|-------|
| Compile | O(m) | m = regex length. One pass through postfix, constant work per char. |
| NFA size | O(m) states | Each operator adds O(1) states. |
| Match | O(n · m) | n = input length, m = NFA size. Each input char does O(m) work for set expansion. |
| Worst-case memory | O(m) | Two bitsets of size m. **Bounded.** |

Compare to backtracking: O(n · m) best case, **O(2ⁿ)** worst case, and memory grows with recursion depth. Thompson's algorithm trades a small constant overhead for an exponential guarantee.

There's an even faster variant — **DFA construction** — where you precompute (or lazily compute) the powerset of NFA states. RE2 and Go's `regexp` do this lazily on demand. Match becomes O(n) flat. But the NFA-simulation approach is the foundation and is fast enough for most uses.

---

## 9. Common pitfalls

1. **Trying to support backreferences in this framework.** You can't — they're not regular. The moment you need `\1`, you're back in backtracking territory (and reasoning about polynomial-vs-exponential blowup again). RE2 famously does *not* support backrefs for exactly this reason.

2. **Forgetting epsilon-closure on the initial state.** If you don't `add_state` from `start` before the first character, you'll miss alternations that begin the regex.

3. **Allocating the visited-set per character.** It's hot. Reuse two bitsets and swap.

4. **Recursive `add_state`.** A deeply nested star can blow the stack. Use the explicit stack as shown.

5. **Confusing "match" with "search".** The implementation above checks if the *entire input* matches the regex. To support "find a match anywhere" (`grep`-style), either wrap the regex in `.*re.*` or extend the matcher to try every starting position.

6. **Greedy vs. lazy.** Real engines distinguish `*` (greedy) and `*?` (lazy). Pure NFA simulation doesn't naturally distinguish — both find a match if one exists. To track *which* match you found (longest? leftmost?), you need extra state. RE2's "submatch tracking" handles this — a separate, harder problem.

7. **Anchors (`^`, `$`).** Easy to add: `^` is a zero-width assertion that the current input position is 0; `$` is one that it's at the end. Both can be modeled as states with zero-width transitions guarded by position.

8. **Character classes (`[a-z]`).** Easy in principle — replace `State::Char(c, next)` with a `State::Class(class_id, next)` and check membership. The lexer gets more interesting.

9. **Unicode.** The above uses `char` (Rust's 4-byte scalar). Real engines handle byte-level vs. Unicode-codepoint-level matching, normalization, locale-aware case folding — endless rabbit holes.

10. **Memory ordering on `current` and `next`.** Already addressed by swap; just don't iterate `current` while writing `next` by accident.

---

## 10. Variations & where to go after

- **DFA construction (subset construction)**: precompute or lazily build a transition table where each "state" is a *set* of NFA states. Match becomes O(n) (no inner loop over states). Powers `lex`/`flex`, RE2, Go's `regexp`, Rust's `regex` crate.
- **PCRE-style backtracking**: what most languages use. Supports backrefs, lookaround, captures. Slow worst case. The default in Python `re`, Perl, JS, Ruby, Java.
- **Hybrid engines**: Rust's `regex` crate (and RE2) use multiple engines internally — bounded backtracking, NFA, DFA, Boyer-Moore-style literal acceleration — and pick per regex per input. Real production-grade.
- **Submatch / capture tracking**: hardest extension. The Tagged-NFA approach (Laurikari) is the cleanest way. RE2 implements it.
- **Streaming matching**: match against an input you can't fully hold in memory. NFA simulation handles this trivially; backtrackers cannot.
- **Approximate matching (fuzzy)**: edit-distance regex. Builds an NFA with one extra dimension per allowed edit. Still polynomial.

---

## 11. Where this shows up in the real world

- **`grep`, `ripgrep`, `ag`** — all use NFA-or-DFA simulation, not backtracking.
- **`lex`, `flex`** — lexer generators. The DFA cousin.
- **Go's `regexp` package, RE2 (C++), Rust's `regex` crate** — all NFA/DFA hybrids, all linear-time guaranteed.
- **Web service WAFs (Cloudflare, AWS WAF)**: pattern-matching rules. Cloudflare's 2019 outage was *exactly* a backtracking-regex disaster; the post-mortem is required reading.
- **Network intrusion detection (Snort, Suricata)** — fast regex over packet payloads.
- **Compilers / lexers** — the tokenizer for any modern language is a DFA generated from regular grammar rules.
- **Protocol parsers** — anywhere you have "find pattern X in this stream."

If you ever ship user-supplied regexes against untrusted input, **use a Thompson-NFA-or-DFA engine** (RE2, `re2-rs`, Rust's `regex`). Do not use `python.re`, `JS RegExp`, `PCRE`, or anything backtracking. This is the take-home from ReDoS.

---

## 12. Going deeper

1. **Add character classes** (`[a-z]`, `[^abc]`). Small lex extension, small state-type extension.
2. **Add anchors** (`^`, `$`). Zero-width transitions guarded by input position.
3. **Add `find` (search anywhere) and submatch capture.** This is where serious engines diverge in design.
4. **Build the DFA via subset construction.** A weekend project. Compare match speeds against the NFA simulator.
5. **Read Russ Cox's series:** *"Regular Expression Matching Can Be Simple And Fast"*, *"Regular Expression Matching: the Virtual Machine Approach"*, *"Regular Expression Matching in the Wild"*. The trilogy. The clearest expositions of this material in print.
6. **Read RE2's source.** Cox's production version.
7. **Read the Rust `regex` crate's source.** Andrew Gallant's annotated implementation of the hybrid approach.
8. **Watch the famous "Regular Expressions are NP-Complete" gotcha** unfold: it's *backtracking* regex with backrefs that's NP-complete; pure regular expressions are linear-time. The conflation is endemic.

---

## 13. Industry context

- **Active debate**: Should mainstream languages switch their stdlib regex engines from backtracking to NFA/DFA? Go and Rust said yes (and shipped with no backref support — controversial but correct). Python, Perl, JavaScript, Java said "compatibility matters more." The Cloudflare outage and the ReDoS literature have pushed many at-risk teams to RE2-based alternatives even when the stdlib is backtracking-based.
- **Historical context**: Thompson's paper is from 1968. Russ Cox's articles, starting 2007, are largely responsible for the algorithm's mainstream renaissance — they pointed out that production languages were *all* using the worse algorithm for no good reason. RE2 (2008) was the demonstration that a linear-time engine was practical, fast, and feature-rich. Go (2009) shipped with the linear-time engine from day one. Rust's `regex` (2014) followed.
- **What a tech lead would ask**: "Where does this regex come from?" (if it's user-supplied, you need linear-time guarantees) "What's the input size bound?" "Are backrefs needed, or just regular expressions?" "Have you fuzzed it?" "What happens on adversarial inputs?"
- **Forward-looking**: SIMD acceleration of NFA simulation (Hyperscan from Intel/Sensory Networks does this), DFA caching strategies at scale, parser combinator libraries that fold regex into a broader parsing framework (`nom`, `winnow`). The next decade's regex story is about SIMD and JIT compilation of NFAs to native code (PCRE2 already does some of this; RE2 is more conservative).
- **Names worth knowing**: Ken Thompson (1968 algorithm, also wrote the original `grep`); Russ Cox (RE2, the modernizer); Andrew Gallant aka `burntsushi` (ripgrep, Rust `regex`); Geoff Langdale (Hyperscan, SIMD regex); Ville Laurikari (TNFA/submatch tracking).

---

## 14. Self-check questions

1. Why does the NFA simulation never blow up exponentially the way backtracking does?
2. What does it mean to say "the current state is a set of states"?
3. Why is converting to postfix (RPN) a useful preprocessing step?
4. Why must every NFA state have at most two outgoing transitions?
5. What's a "dangling fragment" and how does patching resolve it?
6. Why can't this engine support backreferences? What complexity class are backrefs in?
7. What is ReDoS, and which regex engines are vulnerable?
8. When would you choose to also build the DFA (subset construction)?
9. After consuming a character, what's the order of operations? (Consume → expand epsilons → swap.)
10. Why is `current.iter()…any(matches!(_, Match))` the right end-of-input check, and not "is `start` in `current`"?

When you can answer these without hesitation, you have the algorithm — and you have it in a way no textbook diagram could give you.
