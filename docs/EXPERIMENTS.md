# What we believed first

*Every measurement in this project that changed our minds, in the order it
changed them — including the ones that made us undo work.*

> The numbers here are copied from [`docs/BENCHMARKS.md`](BENCHMARKS.md), which
> is the record. This file exists for a different reason: BENCHMARKS says what
> was measured, and this says **what we expected before measuring it**. The
> entries worth reading are the ones where those two differ.
>
> Machine: M-series Mac, 32 GB, Xcode 26, iPhone 17 Pro simulator on iOS 26.5,
> unless an entry says otherwise.

---

## Why this file exists

A benchmarks file is a list of facts and reads like one. It cannot tell you that
a number was a surprise, and the surprises are the only part with teaching in
them. Eight of the entries below reversed a decision we had already made and
sometimes already shipped; three of those reversals came from a measurement that
took under ten minutes and could have been taken weeks earlier.

The pattern in every one of them is the same, and it is not "we were careless".
It is that **a plausible mechanism is not evidence, and the cost of finding out
was always lower than the cost of being wrong.**

---

## 1. The supervisor was 64% accurate on a population where guessing scored 86%

**What we believed:** that a local model judging failed steps was worth
measuring, and that 64% on the first population was a modest but real signal.

**What we measured:** the population was 30 `stop` against 5 `wait`. Always
answering `stop` scores 86%. The model scored 64% — *worse than a constant*.

**What changed:** nothing about the model. The number had never been about the
model. Every accuracy figure computed on a skewed population is a fact about the
fixture set wearing the model's name, and `scripts/score-rulings.mjs` now prints
the majority-class baseline above every accuracy it reports and refuses to let
one be read without the other.

**The general form:** an accuracy without its baseline is not a measurement.
This cost a week of believing a component was mediocre when we had no idea.

## 2. `prewarm()` looked like a regression until it was measured on the right axis

**What we believed:** that warming the model at startup would make the first
judgement faster, and that when first-call latency did not improve the warm-up
was not working.

**What we measured:** it *was* working. The old warm-up was a throwaway
`respond()` — it loaded the same weights the hard way and paid a full generation
to do it, so the cost had simply moved earlier rather than disappearing.
`prewarm()` is the supported call and does not generate: ~880 ms cold against
~600 ms warm.

**What changed:** the axis. We had been measuring wall-clock to first answer,
which mixes weight residency with generation. Residency is process- and
system-managed and outlives the session, which is also why a fresh session per
judgement is affordable at all.

## 3. A large-title rule that fired on one screen and not on its neighbour

**What we believed:** that the rule separating an iOS large title (chrome) from
the content beneath it was fixed, because it had been validated against a real
non-Apple app.

**What we measured:** on the React Native testbed, the *same* 62.9 pt inset
produced opposite answers on two screens. The "is this a real inset" test
compared against the screen's **median row gap**: a 24-row list gives a median
of 0 and the rule fires; four rows above a tab bar give a median of 414 and it
does not. A system-drawn title was chrome or content depending on how many rows
happened to sit below it.

**What changed:** both bounds became absolute platform constants.
`TOKEN_RULES_VERSION` went to 8.

**The general form:** a threshold derived from the data it is classifying will
pass every test written on one screen. The testbed found this on its first day
of existence, which is most of the argument for having built it.

## 4. Naming both screens did not separate them

**What we believed:** that once the fingerprint could see a screen's title, two
screens with different titles would stop colliding.

**What we measured:** 0.50 similarity against a 0.36 threshold — still a match.
The name was one token out of six, so it was outvoted by the structure.

**What changed:** a chrome label became *decisive* rather than merely present.
Two readings that both name themselves, and name themselves differently, are not
the same screen. Two where either side is silent are still compared normally,
because silence is not disagreement.

## 5. The recovery loop registered 670 callbacks and released none

**What we believed:** that the wedged-device problem was a CoreSimulator bug we
would have to work around.

**What we measured:** one log held 670 damage-callback registrations and zero
unregistrations. Registration was not idempotent, and every recovery attempt
added one.

**What changed:** `unregisterChangeCallback()` is now called from every path that
re-registers.

**What is still not proven, and must not be claimed:** the capture soak that
followed had **zero** capture failures, so it never exercised the recovery path
at all. The mechanism is established; the fix is not verified against the
symptom. Writing this down is the point of this file.

## 6. The navigation-oracle idea has a measured ceiling of 9%

**What we believed:** that a graph built by scanning an app's source — screens,
routes, destinations — could remove a large share of the model calls that
navigation costs.

**What we measured:** 9% of escalations in the log are ones such a graph could
have answered. Not zero, and not the transformation it felt like.

**What changed:** the idea is worth a prototype and is not worth a phase, and
the *other* two angles it opens — element **names** and the **destructive
barrier** — look stronger than navigation. Measuring the prize before building
the solution is now the default; two phase premises in a row had been false.

## 7. The harness was measuring itself

**What we believed:** that 18 collected rulings were 18 data points.

**What we measured:** 14 of them came from the collection script's own
plumbing — setup steps failing, not fixtures.

**What changed:** the scaffold runs with `supervisor: 'none'` so it cannot
generate rulings about itself.

## 8. A walk that does not throw is not a walk that arrived

**What we believed:** that a fixture which ran without error had reached the
screen it claimed to be testing.

**What we measured:** three of four rulings in one run were taken on **step 1 of
a three-step form** while the fixture's label said step 3.

**What changed:** fixtures assert arrival. Worth noting precisely because
`scripts/eval-fingerprint.mjs` already had exactly this check and it had not been
carried over — the lesson existed in the repository and still had to be learned
twice.

**And a third time, the same day this file was written.** The fingerprint tour
waited for a network page load with `{"pause": 3000}`. On a hosted runner that
is sometimes not enough: one reading of `example.com` had a stop button where the
others had refresh and **no content tokens at all**, scored 0.31 against a 0.46
bar, and turned CI red under the message *"the threshold no longer has the
clearance this bar states"*. The threshold was fine. Every fixed sleep in that
tour is now an arrival assertion — which the project's own rules had required
since Phase 11.

## 9. The viewport had one edge

**What we believed:** that off-screen elements were filtered out of the element
map.

**What we measured:** every filter in the project checked `y` and ignored `x`. A
filter chip at **x = 422 on a 402 pt screen** counted as visible, and `scrollTo`
reported *"'Assigned to Me' is in view at 422,277 already"* — confidently wrong
about the one question it exists to answer.

**What changed:** both axes. And the cost was not the wrong answer: it was that
the wrong answer was *confident*, so the recovery was hand-tuned swipes and two
overshoots. Reported as the most expensive finding of that session.

## 10. The fix that removed a precondition rather than a regression

**What we believed:** that fixing the large-title rule would visibly improve the
fingerprint distributions.

**What we measured:** the gap did not move. 0.48 either way.

**What changed:** how we describe the fix. The collision it prevents has never
happened on this machine — it happened on a CI runner, where a sparse OCR-only
reading of two nameless screens matched exactly. The change removes the
precondition for a failure, not a measured regression, and saying otherwise
would have been a number-shaped claim with no number behind it.

---

## 11. The supervisor comparison — the one the owner asked for

> *"we can of course do our own test with a chosen model… and decide based on
> the numbers rather than speculations."* — 2026-09-11

**What we believed, and recommended:** that we should not spend time comparing a
larger local model, because the three-word vocabulary makes capacity nearly
irrelevant.

That recommendation was overruled, correctly, and the numbers are below.

### The fairness condition, which is most of the work

Most small-model errors are **invalid-output** faults, not judgement faults.
Apple's guided generation eliminates those at the sampling layer — constraints
are enforced by logit masking, so a fourth word is unrepresentable rather than
rejected afterwards (WWDC25 301; Tech Report §7). An unconstrained challenger
would lose on *formatting* and we would read it as losing on *judgement*.

So every model arm is:

- given the **same briefing**, which is not a second copy of the prompt but is
  read out of `native/supervise.swift` at run time by `src/ollama.js`, because
  two hand-maintained copies of a prompt is two arms answering different
  questions and the difference would be invisible in the numbers;
- constrained to the **same three words** by a JSON schema whose `decision` is an
  enum, which Ollama enforces at sampling exactly as Apple does;
- asked **not to deliberate** (`think: false` for Qwen3), because the Apple arm
  does not either and a supervisor that answers in twenty seconds has already
  lost the argument it is here to have.

Model-without-briefing is dropped **with cause**, not for convenience: asked
cold it scored about one in four and called a list that was plainly still
arriving a dead end.

### The population

Five fixtures on the in-tree React Native testbed, each with a known correct
answer, seeded so the same failure happens on demand. `wait`/`retry` differ only
in how long they settle, so both satisfy a situation whose answer is "wait".

<!-- NUMBERS -->

---

## What the whole file adds up to

Three habits, each bought with a reversal above.

**Measure the prize before building the solution.** Entries 6 and 1. Two phase
premises in a row were false, and both were countable in minutes.

**An accuracy without its baseline is not a measurement**, and a threshold
chosen after seeing the answers is not a threshold. Entry 1, and the reason
`scripts/score-rulings.mjs` was written before the population it first scored.

**A confident wrong answer costs more than a refusal.** Entry 9 is the clearest
case, and it is why the supervisor may only say three words: the answer space is
the safety property, not a confidence threshold.
