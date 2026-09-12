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
them. Most of the entries below reversed a decision we had already made and in
several cases already shipped.

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

22 rulings from one device pass (6 seeds x 5 fixtures, 30 judged steps, 0
skipped), balance 10 `wait` / 12 `stop`, so the majority-class baseline is 55%.
Every arm answered the identical 22 situations, three times.

| arm | accuracy | median | deterministic |
| --- | --- | --- | --- |
| always the commonest answer | 55% | — | — |
| **`stillMs > 3000ms -> stop`** | **95%** | **0 ms** | yes |
| Apple Foundation Models (~3B) | 77 / 82 / 86% | 634–641 ms | **no** |
| `qwen3:8b` (4-bit, 5.2 GB) | **91%** | 919 ms | yes |
| `qwen3:14b` (4-bit, 9.3 GB) | 82% | 1,489 ms | yes |

### What we believed, and what the table says

**We believed capacity would help a little, and that the interesting question
was how much.** The 14B is 79% larger than the 8B, 62% slower, and scored
*lower* — 82% against 91%, on identical inputs, both deterministic at
temperature 0. Whatever this task is hard at, it is not hard in a way more
parameters fix.

**We believed a headline accuracy would rank the arms.** It ranks them
backwards. Every arm errs in exactly one direction, and the directions differ:

| arm | errors | direction |
| --- | --- | --- |
| Apple | 4 | all `wait`/`retry` where `stop` was right |
| `qwen3:8b` | 2 | all `stop` where `wait` was right |
| `qwen3:14b` | 4 | all `stop` where `wait` was right |

A wrong `wait` costs a settle and one re-run. A wrong `stop` abandons a plan
that would have worked. So the best-scoring arm fails in the expensive
direction and the worst-scoring arm fails in the cheap one. No single accuracy
figure shows that, and a comparison that had reported only the percentages
would have recommended the wrong model.

**We did not expect the shipped arm to be non-deterministic.** Asked the same 22
questions three times, Apple gave 77%, 82% and 86% — a spread of two rulings.
Both Ollama arms returned byte-identical answers every time. That is a fact
about reproducibility, not about quality, and it means any single Apple number
in this project carries ±2 rulings of noise that was never being reported.

### And the free comparison beat all three again

`stillMs > 3000ms` was fixed on the *previous* population, before this one
existed, so 95% here is genuinely out of sample. Second independent
confirmation that a one-line comparison on a number the daemon already computes
outperforms every model arm at no latency.

**The reason to still distrust it**, which matters more than the number:
sweeping the threshold gives 91% at 2,000 ms, 95% at 2,500 and 3,000, 82% at
3,500 and 77% at 4,000. The plateau is about 2,100–3,200 ms, and the `blocked`
fixtures sit at 3,225 / 3,250 / 3,401 / 3,699 ms — just above it, which is why
3,500 collapses. A rule whose correctness depends on a 1.1-second window that
the fixture design happens to straddle may be separating **the fixtures**
rather than the world.

So the honest reading is not "the supervisor is unnecessary". It is:

- for these five fixture shapes, a free threshold is at least as good as any of
  three models, and the burden of proof has moved onto the models;
- the next measurement that would change anything is a population **nobody
  designed** — not a bigger model, which this table has now tested and which did
  not help;
- and the error-direction result stands independently of all of it, because it
  does not depend on the balance, the threshold, or the fixture design.

### The question this experiment was actually commissioned to answer

The reason for a local model was never accuracy. It was **latency**: a model
consulted between steps should not cost a network round trip. That framing
deserves its own table, because the one above ranks the arms against each other
and not against the thing they exist to replace.

| | median | accuracy |
| --- | --- | --- |
| a model round trip in the field | **10,000–16,000 ms** | — |
| `qwen3:14b`, local | 1,489 ms | 82% |
| `qwen3:8b`, local | 919 ms | 91% |
| Apple ~3B, on-device | 634 ms | 77–86% |
| a threshold, no model | **0 ms** | **95%** |

**The thesis holds: local is 7–25x faster than going out.** Three things follow
that the thesis did not anticipate.

**More parameters are a straight loss on the latency axis.** The 14B costs 2.3x
the latency of the 3B and is no more accurate. A design motivated by latency
should reach for the *smallest* model that clears the bar, which is the opposite
of the instinct a disappointing accuracy number produces.

**A local model contends with the app under test.** The medians above are from a
quiet machine. Run while the simulator was being driven, the same calls measured
**5,191 ms** for `qwen3:8b` and **7,250 ms** for `qwen3:14b` — against 842 ms for
Apple, which runs on the Neural Engine rather than fighting the app for the GPU.
That is one observation and not a controlled measurement, and it is flagged
rather than tabulated for that reason. But if it holds, a local Qwen *under
load* lands in the same order of magnitude as the network round trip it was
chosen to avoid, and the latency argument for it disappears exactly when the
machine is busy — which is always, because the machine is busy running the app
you are testing. **This is the next thing to measure**, and it matters more than
another point of accuracy.

**And for this particular decision the latency argument is moot**, because a
zero-cost threshold already answers it better than any model. That is not an
argument against local models; it is an argument about *which decisions* deserve
one. Where the thesis pays undiminished is a decision with no cheap rule
available — the `seek` container ranker is 564 ms warm against the same
10–16 s round trip, ~20x cheaper, and nothing free replaces it.

### The cascade — threshold, then the small model, then Claude

The owner's design, and the right shape: answer free where you can, pay for the
on-device model only where you cannot, and pay a round trip only after that.
Measured on the same 22 situations, letting the rule abstain in a band around
its own threshold and handing those to the model:

| abstain band | escalated | cascade accuracy |
| --- | --- | --- |
| none — the rule alone | 0/22 | **95%** |
| ±250 ms → Apple | 2/22 | 91% |
| ±500 ms → Apple | 3/22 | 91% |
| ±1,000 ms → Apple | 5/22 | 86% |
| ±1,500 ms → Apple | 8/22 | 82% |
| ±1,500 ms → `qwen3:8b` | 8/22 | 91% |

**Every escalation made it worse or left it unchanged. Never better.** And the
reason is more useful than the table.

**The cascade needs a tier that can say "I don't know", and no tier has one.**
The threshold is a comparison: it always answers. The supervisor's vocabulary is
three words and none of them is an abstention. So the question a cascade really
asks is not "does falling through help" but "what is the abstain signal" — which
is item 100, arrived at from a completely different direction.

**And the obvious abstain signal is the wrong one here.** Proximity to the
decision boundary is what you would reach for first. The rule's single error
sits **3,534 ms from its own threshold** — further out than the median row's
1,610 ms — so a band wide enough to catch it would escalate 20 of the 22 rows
first. The error is not a close call. It is a `detail` screen still fetching
after 6.5 s of stillness, which is wrong for a *semantic* reason that no
confidence band around a duration can see.

That is the finding to carry: **the shape of the cascade is right and the hard
part is not the shape.** A tier that knows when it does not know is worth more
than a tier that is slightly more accurate, and nothing here measures confidence
yet. n=22 on five designed fixture shapes, so this rules the simple version out
rather than settling the idea.

### What replay cannot say

Whether acting on a ruling actually *recovered* the flow is a fact about the
device at that moment and belongs to whichever arm was live. Only the Apple arm
was. On the live pass it recovered or correctly stopped **13 of 22** — 59%,
against the same 55% baseline — and the gap between its decisions and its outcomes is the same
one the previous population showed: the `detail` fixture takes the right word
almost every time and recovers about a third of the time, because `wait` settles
for a fixed budget and that screen wants longer. A correct ruling is not
sufficient.

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
