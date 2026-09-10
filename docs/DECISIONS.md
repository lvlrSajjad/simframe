# Decision register

Decisions that changed the plan, with what was measured and what it cost to
find out. **A no-go is a result.** Half the entries here are things that were
not built, or were built and taken out, and those are the entries with the most
in them — a phase that shipped tells you the plan was right, a phase that was
cancelled by its own measurement tells you something about the problem.

Ordered newest first. Every number here is measured; the numbers themselves and
their conditions live in `docs/BENCHMARKS.md`, and the working state lives in
`docs/DEFERRED.md`. This file is the index of *judgements*, so it stays short.

| date | decision | verdict | what settled it |
|---|---|---|---|
| 2026-09-10 | Phase 17 — local planner tier | **NO-GO** | The prize is 5% of decisions |
| 2026-09-10 | Phase 11.5's premise (the agent is not batching) | **OVERTURNED** | It batches 84% of the time |
| 2026-09-10 | The map cut — drop prose from the element list | **REVERTED, same day** | It deleted list rows |
| 2026-09-10 | No third-party app identifier in this repo, ever | **ADOPTED** | A real leak, mine |
| 2026-09-09 | Learned stillness — a settle window per edge | **REVERTED for cause** | Faster, and it corrupted the graph |
| 2026-09-09 | Phase 8b — Android accessibility APK | **DEFERRED** | OCR + CV first; the pain is elsewhere |
| earlier | Phase 9 — tier-2 local model | **DEFERRED, gate unmet** | Cheaper tool for the same gap, unbuilt |

---

## 2026-09-10 — Phase 17, local planner tier: NO-GO

**The question.** A small on-device model (Apple Foundation Models, ~3B) sits
between the intent matcher and Claude and answers one narrow question: given
this goal and this element list, which element is next?

**Verdict: no-go.** Of 40 element decisions taken on real apps, the local
matcher already resolves **37 (92.5%)**. Two are ambiguous, one is not found.
A planner's entire addressable share is **5%**, and only if it were perfect.

**What settled it, and it is not what the plan asked.** The plan specified a
go/no-go that measured *how accurate the model would be* — "agreement ≥85%".
It never asked *how large the prize was*. The second question is far cheaper
and it settled the phase on its own, without running a model.

**The finding worth quoting.** By the time a step reaches simframe, the decision
has already been made. A verified graph edge's goal *names* the option, because
Claude chose it and then asked for it by name. The deliberation — open a
dropdown on a screen of dynamic data, work out which option satisfies the test —
happens *upstream of the tool call*, in the only place a model inside the daemon
cannot see. A local planner would re-derive conclusions already reached.

**Two instruments, opposite biases, same answer.** A verified edge is a decision
that *succeeded*, so measuring the matcher on its own successes is partly
circular. The escalation log has the opposite bias — resolution failures per
edge traversal — and on the real third-party app across both peer rounds that is
**4 in 73 (5.5%)**, against 5% from the corpus.

**What the phase produced anyway.** Its own plan was unrunnable, and finding out
why fixed two instruments: `no_plan` has never been logged once; the session id
was minted from the pid, so a CLI agent got one "session" per command (33 ids
for 46 records, 30 holding a single record) and `--session` could not answer the
only question it exists for; and `verification_failed`, the largest reason
class, was the only one logging no intent. All three are why "collect 200
escalations" was never going to happen.

**Kept, not deleted.** `docs/PHASE-17-SUPPLEMENT.md` is a sibling research pass
on how to build the planner — context budget, constrained output, availability
as a `doctor` capability. Its constraints are right and will apply to any future
local tier. Its own ladder rule (*the planner runs only when the matcher is
ambiguous or empty*) scopes the planner to precisely the slice measured above,
which makes it the sharpest argument for the no-go.

**Consequence.** The CLAUDE.md amendment the phase wanted is not needed; nothing
was loosened. Reproduce with `node scripts/phase17-corpus.mjs`. Numbers in
`docs/BENCHMARKS.md`, "Phase 17 go/no-go".

**Reopen only if** the escalation *mix* changes — a much higher rate of abstract
goals ("pick any option") reaching the tool, rather than a better model.

## 2026-09-10 — Phase 11.5's premise: overturned by its own diagnosis

**The premise.** Thinking between steps is the cost, because the agent stops to
think after every action.

**Measured instead:** 0.56 model turns per step, **84% of calls batched**. The
agent was already chaining. The cost was **short** batches — 48 of 62 calls were
three steps or fewer — and **28 of 62 calls returning an image**.

**Consequence.** The phase shipped, but against different targets: tool
descriptions under 60 words, a locally computed `next:` line saying when the
model need not think, and a trailing map that is re-read rather than recalled.
Had the premise not been checked, the work would have gone into removing turns
that were not being spent.

**Pattern, now two for two.** This and Phase 17 are the same error: a phase
assuming the shape of its own problem. Both were disproved in under an hour from
data already on disk. Measure the prize before the solution.

## 2026-09-10 — the map cut: built, reverted the same day

**The change.** Drop non-interactive prose (long labels, no role, `content`
region) from the element list, to make maps cheaper to read.

**Reverted within hours,** on a peer report. A React Native list card exposes all
its children as one concatenated accessibility label — 105 characters,
`GenericElement`, region `content` — **identical in every property the rule
tested** to a Settings caption. Nothing became untappable, because targets
survive. What was lost was **discovery**: the agent could no longer see the rows
existed. A confidently-wrong map is worse than a verbose one.

**Consequence.** Truncation (`…`) instead of dropping — position and tappability
are the valuable half of a row. The perception harness gained
`expect.discoverable` and a fixture assembled from the report, so the same
mistake now fails offline in a second.

## 2026-09-10 — no third-party app identifier in this repo, ever

**Adopted after a real leak, and it was mine.** A `git add -A` committed and
pushed a 282-line field-notes file: a company name in the filename, a bundle id,
a backend login address, an internal API path, third-party defect reports. It was
the exact failure the guard written an hour earlier existed to prevent — and the
guard was inert, because it needed a denylist nobody had supplied. I had also
published a file I never read.

**Consequence.** `scripts/check-private.mjs` enforces it as a **pattern** with
no secret and no configuration, so it works for every user of an open-source
tool who has no bundle id to declare. It never prints a match, only `file:line`
and a count. History was rewritten over the 22 post-v0.9.0 commits, on explicit
instruction, and verified four ways. Two further rules came out of it: never
`git add -A` without looking, and never chain verification with `&&` — a
short-circuit let a failing guard through twice the same night.

## 2026-09-09 — learned stillness: built, then reverted for cause

**The change.** Learn a settle window per graph edge instead of paying a fixed
500 ms.

**It worked and it was wrong.** The Settings flow went 11.5 s → 8.0 s. Then
eight runs in a row failed at step 2 with the screen still on Settings root:
step 1's settle returned mid-push, `screenIdentity` read the screen we had never
left, and the graph learned `root → root` as a verified edge and started
predicting it.

**The flaw is the estimator, not the idea.** The gap statistic was gathered from
what a wait itself observed, so a wait that ends early never sees the later
pauses, the gaps read as zero, the window ratchets down, and the next wait ends
earlier still. A self-reinforcing bias with a corrupt graph at the end of it.

**Consequence.** Gaps are still recorded and act on nothing. The unbiased
estimator computes a transition's motion profile *after* it is over, from the
frame history, rather than from inside the wait that cut it short. Phase 11's
adaptive waiting was rebuilt on that footing.

## 2026-09-09 — Phase 8b, the Android accessibility APK: deferred

**Decided: Android ships OCR + CV only.** Not because the tree is worthless, but
because of where the pain is. Android is the second proof of the platform
boundary, and the perception ladder was built precisely so a missing tier
degrades rather than fails. A backend declares its own `capabilities` and says
`optional` with a reason instead of borrowing the other platform's vocabulary.

**It is also a promise change.** Putting a runtime artifact on the user's
machine is the same class of decision as shipping model weights, which CLAUDE.md
lists as a non-goal. Decided together, not one at a time.

## earlier — Phase 9, tier-2 local model: deferred, gate unmet

**The gate:** vision-only recall on accessibility-poor screens must be below
what you can live with, measured on a real harness, before starting.

**Where the evidence pointed:** narrow. 83% of interactive elements carry no
text, and every OCR-only failure was the same shape — **icon-only controls**
(two refusals, and `Back` resolving to `"B"`).

**Three reasons not to start it anyway.** The cheaper tool for that exact gap —
an SF Symbol template bank — needs no weights, no licence review and no
download, and is still unbuilt. The gate was not met, because the harness that
would meet it did not exist. And it contradicts a stated non-goal.

**Status change, 2026-09-10:** the harness now exists — 15 screens, 5 apps, 67
expectations, offline, one second in CI (`scripts/eval-perception.mjs`). One of
the three reasons has therefore expired. The other two have not, and the order
that respects them is unchanged: template bank and contours, then a real recall
number on a11y-poor screens, then Phase 9 is a decision with evidence behind it.
