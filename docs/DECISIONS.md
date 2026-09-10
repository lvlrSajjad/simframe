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
| 2026-09-10 | Phase 12 next, per the default order | **REORDERED** | `novel_dialog`: 0 of 173, ever |
| 2026-09-10 | Phase 15 — exploration, and the first real local-model job | **PROMOTED** | Semantic ranking is beyond a matcher |
| 2026-09-10 | Phase 18 — local triage, not local planning | **PROPOSED** | The recovery class cannot be enumerated |
| 2026-09-10 | Local model ranks doors; Claude drives | **INVERTED** | The plan should be watched, not chosen |
| 2026-09-10 | `seek` may open any label a retry may substitute | **WRONG, fixed** | It opened CANCEL, then answered a prompt |
| 2026-09-10 | A structural "dead end" rule | **REVERTED before shipping** | It cannot tell unfinished from unfinishable |
| 2026-09-10 | Phase 17 — local planner tier | **NO-GO** | The prize is 5% of decisions |
| 2026-09-10 | Phase 11.5's premise (the agent is not batching) | **OVERTURNED** | It batches 84% of the time |
| 2026-09-10 | The map cut — drop prose from the element list | **REVERTED, same day** | It deleted list rows |
| 2026-09-10 | No third-party app identifier in this repo, ever | **ADOPTED** | A real leak, mine |
| 2026-09-11 | Phase 19 — the web as a third target | **ROADMAP** | Port the philosophy, not the implementation |
| 2026-09-09 | Learned stillness — a settle window per edge | **REVERTED for cause** | Faster, and it corrupted the graph |
| 2026-09-09 | Phase 8b — Android accessibility APK | **DEFERRED** | OCR + CV first; the pain is elsewhere |
| earlier | Phase 9 — tier-2 local model | **DEFERRED, gate unmet** | Cheaper tool for the same gap, unbuilt |

---

## 2026-09-10 — the local model should supervise the plan, not choose the steps

**The owner's proposal, and it inverts what was built.** *"I'd use Claude as
planner and use apple as the brain to act when the tool gets confused in between
the steps... the live driver and supervisor until the plan is finished. The apple
model communicates with Claude only when it cannot act. And when the plan is
finished, apple tells the results in short to Claude."*

**Why it is right.** The shipped ranker asks the local model *which door to
open*, which is a decision Claude is good at and mostly does not need help with —
and Phase 17 already measured that the matcher resolves 37 of 40 of them. The
proposal asks it instead to hold the plan and **watch it run**, which is where
round 6 says the time goes: of 514 seconds, ~386 (75%) was thinking and round
trips, and every pause the operator flagged live was a call boundary.

**Two corrections, both of which make it stronger.**

*The executor already exists and is not a model.* `sim_do` is precisely "hand a
plan to a local driver that runs it, verifies each step and reports once", and
round 6's best result was 18 steps in a single call. Deterministic code is the
better executor — faster, exact, auditable, cannot hallucinate a step — so the
plan stays there. This also resolves a constraint the proposal would hit: Apple's
model has 4,096 tokens of context and a 27-step plan plus screen state does not
fit. A per-step supervisor does.

*The supervisor's vocabulary is three words: wait, retry, stop.* What kills
batches in the field reports is never "which step next". It is a stale assert, a
variant that satisfied the next step anyway, a list that had not loaded, ten
steps failing against an unchanged screen. Every one of those is answered by one
of three words, and none requires inventing, skipping or substituting anything.

That constraint is the safety property, and it is not a threshold — it is the
size of the answer space. Today's `seek` incident is the argument for it: given
latitude over *what* to open, with a permission list answering the wrong
question, it pressed "YES, THIS FIXED MY PROBLEM" in a live app. A component that
can only say wait/retry/stop cannot do that whatever it believes.

**The half I had underweighted.** *"Apple tells the results in short to Claude."*
A single surprise has repeatedly cost three to six calls just to *understand*. A
local summary does not remove the round trip; it makes one round trip sufficient,
and a six-call recovery becoming a one-call recovery is worth more than removing
the call.

**Sequencing, and it is not deferral.** Every batch-killer above is a
deterministic bug already filed — 49, 51, 52, 53, and G1 which landed today.
Fixing them beats having a model judge them: a supervisor papering over a stale
assert is worse than a fresh assert. Fix, re-measure, and the supervisor's job is
whatever remains. If nothing remains, that is the best available outcome and one
measurement buys the answer.

## 2026-09-10 — one permission list cannot answer two questions

**What happened.** `seek`, exploring for a service provider, opened **CANCEL**,
then AI TROUBLESHOOTING, then pressed **"YES, THIS FIXED MY PROBLEM"**, then HELP
CENTER — ending five screens deep in a live customer-support chat, with a
half-completed service request destroyed and the tester left there to rebuild it
from the home screen. One label further along was SUBMIT SERVICE REQUEST. The
operator, watching without knowing why, wrote: *"you just went back to the first
page, chose wrong stuff, and now you're interacting with support. Completely off
basically."*

**Why, and it is not that the list was too short.** `"cancel"` is on the
*safe* list, deliberately, so that a local tier can **decline** a dialog instead
of stranding on every confirmation it meets. That was the right call for that
question. `seek` asked the same list a different question — *may I open this as a
door?* — and got the first question's answer.

**May-I-tap-this-to-decline and may-I-open-this-as-a-door are different
permissions.** One list answering both is the whole defect, and no amount of
adding words to it would have found that.

**Three faults, not one, and the second is the instructive one.**

1. The permission. Exploration has its own list now, which refuses anything that
   commits, abandons, answers or leaves, and patterns for labels that read as
   answers or instructions. Substitution is unchanged.
2. **The documentation.** It said `seek` *"finds and does not act"*. I meant it
   does not tap the *target*. A reader took it to mean what it says, and handed
   it a flow it could destroy — correctly, on the documented contract. Opening a
   door is an action. A safety property that is true only under the author's
   private reading is not a safety property.
3. No return. The contract said depth-first *with return* and on failure it
   returned nowhere. It now walks back and says plainly when it could not.

**The fix that came with it, from the same report.** Candidacy required
`actsInteractive` and found **zero doors** on a screen holding two real
pickers — a React Native picker is a generic element with no value, and the tree
has been wrong about roles in every single round. So container detection was
wrong in *both* directions on one app: nothing on a screen full of doors, then
CANCEL as a door on the next screen along. It is permissive about shape and
strict about vocabulary now: the tree is unreliable about what is tappable, the
label is reliable about what must not be opened.

**Consequence for Phase 15.** The local ranker could not be evaluated at all,
because ranking cannot rescue a candidate set that does not contain the answer —
the correct door was never a candidate in either arm. The A/B stands as
*inconclusive on the model* rather than negative, and the go/no-go has to wait
for candidacy to work.

## 2026-09-10 — Phase 18 proposed, and the rule that would have made it unnecessary

**Phase 17 asked a local model to choose the next element. Phase 18 asks it to
handle the moment the plan breaks.** Filed as its own phase rather than as an
appeal against the no-go, because it is a different job and the no-go's evidence
still stands.

**What made the case.** Five field rounds, and the owner's framing: *"testing a
dynamic app with dynamic data and several rules has several things we might not
expect at all."* A reflex table covers interruptions you can list; it cannot
cover "this location has no assets because of a branch rule".

**The concrete example, and why the cheap answer failed.** Select a location
with no assets; the instinct is to pick another, immediately. Every fact that
instinct runs on appears to be in hand — an empty asset region, a `disabled`
primary action, a remembered `tap "Change"` — so a structural rule was written
and tested. It was **reverted before shipping**: "nothing choosable" is false
because the Location select is choosable, and loosening it to "the primary action
is disabled" fires on every half-filled form. It cannot distinguish *you have
not finished* from *you cannot finish*, because the missing fact — an asset is
required and this location has none — is an app rule and not in the tree.

That failure is the strongest evidence for the phase. Recorded with the rule
attached, because a threshold that cries wolf on every unfinished form is the
exact class of thing this project has shipped and had to revert before.

**The underrated half is compression, not triage.** When a surprise is genuine
the right answer is usually still to ask Claude — but the field reports show a
single surprise costing **three to six calls** to *understand*: a `find`, an
`--interactive`, a screenshot, a coordinate guess. A local summary does not
remove the round trip; it makes one round trip sufficient. Turning a six-call
recovery into a one-call recovery is worth more than removing the call.

**Safety, by construction rather than by threshold.** One-directional authority:
the local tier may downgrade an escalation to a retry, or annotate one to make
the model's turn cheaper. It may not authorise continuing past an anomaly, act
on a destructive label, or leave the app. Wrong in the cautious direction costs a
round trip, which is the status quo; wrong in the bold direction is impossible
rather than unlikely.

**Not before the residue is measured.** Most off-plan events so far were tool
defects — false `unexpected-screen`, a phantom keyboard, a focus warning that
could not succeed — and they were fixed by fixing them. A model on top of that
would have been a brain servicing a bug.

## 2026-09-10 — the phase order, reordered by the log it said would decide it

**The rule being followed.** CLAUDE.md: *"After Phase 10, the reason breakdown
in `docs/ESCALATIONS.md` decides which faculty is built next; the default order
in PHASES-HUMAN-PARITY.md is a default, not a commitment."* This is the first
time that clause has been used, and it changes the order.

**The breakdown, 173 escalations on the benchmark device:**

| reason | all | last 40 |
|---|---|---|
| `verification_failed` | 102 | **38** |
| `ambiguous_intent` | 59 | 2 |
| `unknown_screen` | 12 | 0 |
| `novel_dialog` | **0** | 0 |

**Phase 12 is reflexes, and reflexes exist to handle interruptions — which is
`novel_dialog`. It has never been logged once.** Not rare: zero, across two
days and 173 records, on a device driving a real third-party app through
permission grants, pasteboard consent and a four-step wizard. Real use *did*
specify some of it (pasteboard consent eating the first paste, a notifications
prompt blocking a `waitFor`), but those happen at **setup**, where the cheap half
of Phase 12 — `simframe prep` and the destructive-vocabulary data file — covers
them without a reflex engine.

**What the log points at instead is not a new faculty at all.**
`verification_failed` is 102 of 173 and 38 of the last 40, and five field rounds
established that a large share of those are **false**: `unexpected-screen` on
correct transitions (3 for 3 wrong in one round), `no-visible-change` on taps
and types that worked, a focus warning that fires because the simulator has a
hardware keyboard. The faculty that removes the most escalations is *correct
verification*, and its root cause is one thing: **screen identity weighting
chrome over content**, which also made `assert` resolve against another screen's
stored elements.

**Revised order.**

1. **Verification correctness** — screen identity (items 41, 42), then the
   negative verdict on data variation (43). Not a phase in the plan; it is what
   the plan's own steering wheel points at.
2. **Plan-first** — item 44, opening a batch against a remembered screen with no
   read. This is Phase 14's territory (anticipation) arriving early because a
   primitive version of it already paid: naming the remembered vocabulary cut a
   cold run from 25 calls to 19.
3. **Phase 12, shrunk** — `simframe prep` and the destructive vocabulary file
   only. The reflex table waits for a `novel_dialog` count above zero.
4. **Phases 13, 15, 16 on evidence.** Phase 13 is ROI perception, and perception
   was never the bottleneck — *emission* was: the map omitted a control the
   resolver could hit instantly. Phase 15 is exploration when lost, and the cold
   run was never lost, it was misinformed. Neither has field evidence behind it
   yet.

**What would reverse this.** A `novel_dialog` count that climbs once verification
stops swallowing everything — some interruptions may currently be logged as
`verification_failed` because a dialog is what made the verification fail. Worth
re-reading the breakdown after item 41.

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

## 2026-09-11 — the supervisor's answer space: verified, and one word to be added

**The safety property is real at the sampling layer.** `@Generable` enum
constraints are enforced by logit masking during decoding — Apple's own words,
WWDC25 session 301 and Tech Report arXiv:2507.13575 §7 — so a word outside
`wait`/`retry`/`stop` is not rejected after generation, it is unrepresentable.
"The answer space *is* the safety property" was a design intention when it was
written and is now a mechanical fact. Registered because we have been wrong
before about claims we found appealing, and this one turned out to be true.

**Decided: add an `abstain`, and never a fourth action.** Both of the
supervisor's non-clean rulings were missing-vocabulary cases — a control needing
the page zoomed out, content a scroll had gone past. The tempting fix is a
fourth action word, which would widen what the component can do and spend
exactly the property above. An abstain does not: it raises coverage while
mapping onto the safe default we already have, where no answer means the
executor proceeds as if unsupervised. Selective prediction is the name for it
(Chow 1970; El-Yaniv & Wiener 2010).

**Decided: 97 is promoted ahead of 96.** The abstain token is cheap and lands a
reliability win; the 2x2 is four cells of device time that settles attribution
rather than improving anything. Filing the cheap fix behind the expensive
experiment is the "research instead of act" habit the owner has already caught
us in once, and Fable named it independently.

**Not decided, and flagged.** A guided-generation regression — empty token
masks, severe slowdowns — is reported on macOS 27 betas 5-7 (FB24310823). Our
safety claim rests on that mechanism, so it is re-verified before we move to 27,
not assumed.

**Pre-registered thresholds**, written down now so they cannot move later. If
briefing-only recovers ≥80% of the calls that briefing-plus-model does, the
model becomes a `stop`-only, abstain-capable cascade stage. If a p95-per-edge
graph lookup would have got ≥70% of past `wait`/`retry` rulings right, the graph
answers first and the model sees only the remainder.

## 2026-09-11 — the local model stays the system's, and what we are turning down

**Decided: no Ollama, no llama.cpp, no MLX, no community Node bridge.** All of
them break a hard non-goal — a runtime dependency, shipped or downloaded
weights, or both — and the research says what we would be buying: a larger
context window, and a bigger model whose advantage is *marginal at k=3*, since
the large-model edge concentrates on uncertain inputs and most small-model
errors are invalid-output faults that constrained decoding already eliminates
for us. Revisit only if a **measured** k=3 accuracy gap appears, or a context
need the system model cannot meet. Not before.

`SystemLanguageModel` is the only system-provided general LLM on macOS, which is
precisely why it satisfies both non-goals at once. The Swift helper we
hand-rolled is what keeps "the only runtime dependency is the MCP SDK" true; a
community npm bridge would end that quietly.

**Noted and not taken: Private Cloud Compute.** `PrivateCloudComputeLanguageModel`
is system-provided with a 32K context, which would dissolve our 4,096-token
budget — but it is off-device, needs the network and an entitlement, and a
supervisor that phones home is a different product from the one described in
CLAUDE.md. Recorded so the option is a decision rather than an oversight.

**macOS 27 surfaces are forthcoming, not shipped.** The `fm` CLI, the Python
SDK, and the `LanguageModelExecutor` provider protocol are described in WWDC26
sessions against a release still in beta. The provider protocol is the
interesting one — it would let a different model sit behind the same Swift API —
but it is still a dependency-and-weights decision, taken deliberately or not at
all. Nothing we ship today may depend on any of it.
