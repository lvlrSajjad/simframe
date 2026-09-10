# simframe — human-parity phases (10–16)

Goal for this series: when an agent uses simframe to test something, it should
reach or beat a human tester's speed and accuracy. Every phase is scored by the
same two numbers — **model turns removed** and **Human Parity Index (HPI)** — and
each phase must append its measurements to `docs/BENCHMARKS.md` and its
escalation-log deltas to `docs/ESCALATIONS.md`.

Phase 9 (Tier-2 local model) stays deferred. Phase 10 is mandatory and first;
after it, the escalation log — not this file — decides the order. The default
order below follows `docs/research/03-human-parity.md`.

Copy each prompt verbatim into a fresh Claude Code session.

---

## Phase 10 — Instrumentation: escalation log, per-flow metrics, HPI

**Why first:** without it nothing later can be prioritised or proven.

```
Read CLAUDE.md, then docs/research/03-human-parity.md §1 and §8, and skim the
existing sim_do / verify-after-tap code so the new records hang off real events.

Task: make simframe measure itself against a human.
1. Escalation log. Every time the daemon or a tool hands a decision back to
   the agent, append a JSON line to ~/.simframe/<udid>/escalations.jsonl with
   exactly the schema in §8: timestamp, flow_id, step_index,
   screen_fingerprint, reason ∈ {unknown_screen, ambiguous_intent,
   verification_failed, novel_dialog, no_plan}, candidate_elements,
   reflex_or_exploration_tried, outcome, model_turns_spent, tokens_spent,
   wall_time_ms. Classifying the reason is part of the task — every existing
   escalation path must map to one reason, and "unknown" is not allowed.
2. Per-flow metrics. Every sim_do (and every CLI flow run) writes one record
   to ~/.simframe/<udid>/flows.jsonl with the §1 fields: wall_time_ms,
   steps_taken, min_steps (from the flow definition or null), model_turns,
   images_sent, escalations, mis_taps, verdict_histogram, reflex_firings,
   exploration_events, completed, wrong_action_taken.
3. Human baseline capture. `simframe baseline record <flow-name>` arms the
   daemon to record a human performing the flow on the simulator: HID event
   log + frame history → per-run wall time, tap count, inter-tap intervals.
   `simframe baseline summarize <flow-name>` writes median/IQR and min steps
   to docs/research/human-baselines/<flow>.json. Assume N≥5 runs; refuse to
   summarize fewer than 3.
4. HPI. `simframe hpi` computes, per flow and overall, exactly the §1
   definition: HPI_time = median_human / agent wall time; HPI_accuracy =
   flows completed without wrong action / total; HPI = HPI_accuracy ×
   harmonic mean of HPI_time; plus step_ratio. Output as a table and --json.
5. `simframe escalations` prints the reason breakdown and the avoidable
   escalation rate (§8), with a per-reason count and the top screens.
6. CI: add a `bench` job that runs the existing flow suite on the pinned
   simulator, writes hpi.json, and fails if HPI_time regresses >10% or
   HPI_accuracy drops at all versus the committed baseline. Commit the first
   baseline in this phase.

Verify: record yourself doing the README four-tab flow 5 times as the human
baseline; run the agent flow 5 times; print HPI and the escalation
breakdown. Create docs/ESCALATIONS.md with the first breakdown and a one-line
"next faculty" recommendation derived from it. Append all numbers to
docs/BENCHMARKS.md under "Phase 10".

Do not: change any perception or action behaviour in this phase. Do not
build any reflex, timing, or exploration logic. Measurement only.
```

---

## Phase 11 — Sense of time: adaptive waiting, no fixed sleeps

```
Read CLAUDE.md, docs/research/03-human-parity.md §7, and docs/ESCALATIONS.md.
Find every fixed sleep/timeout in actions.js and the Swift daemon and list
them before changing anything.

Task: give the daemon a sense of how long things usually take.
1. Per transition-graph edge, keep a rolling window (last 50) of observed
   settle durations. Persist with the graph.
2. Adaptive timeout = p95 + margin (margin = max(150 ms, 20% of p95)). Cold
   edges (<5 samples) use a conservative global default, recorded as such.
3. "Slower than usual" = elapsed > p95 with the screen still not settled and
   the transition classifier reporting loading/spinner. Keep waiting up to a
   hard cap (10 s, Nielsen's attention limit), then escalate with reason
   verification_failed and the timing context attached. Anything else that
   exceeds p95 is `no-visible-change`, as today.
4. Remove every fixed sleep listed in step 0. Where a sleep guarded a real
   race, replace it with a settle-or-change wait.
5. `sim_state` gains `timing: {edge_p50, edge_p95, elapsed, slower_than_usual}`.

Verify: the four-tab flow three times; report wall time before/after and the
verdict histogram. Confirm no new `unexpected-*` verdicts appeared. Run
`simframe hpi` and append to BENCHMARKS under "Phase 11". Update
docs/ESCALATIONS.md.

Do not: add reflexes or change what happens after a verdict — only how long
we wait and how we describe it.
```

---

## Phase 11.5 — Cheaper thinking: fewer, shorter model turns — **done 2026-09-10**

Inserted before Phase 12 because it is not a faculty. Phases 11–16 reduce how
*often* a decision reaches the model; this reduced how often the model believes
it has to decide, and how much each turn carries. No new perception or action
capability, and none of the verdict logic touched.

The diagnosis is the part worth keeping, because it overturned the phase's own
premise. `model_turns`/step in a real session is **0.56**, not the ~1.0 the
prompt predicted, and 84% of calls were already batched. The cost is **short
batches**: 48 of 62 calls were three steps or fewer, so a twelve-step flow
arrived as five calls and every boundary was a think. And the largest single
token cost was images — 28 of 62 calls returned one, roughly a third of the
session — for a reason since fixed: the map could not report what a text field
contained.

Shipped: every tool description under 60 words with `sim_do` named as the
cheapest path and `sim_look` leading with its price; a locally-computed `next:`
line on every action result that says whether the model needs to think at all;
body prose dropped from the default map (−15% across 14 recorded screens); and
`SKILL.md` rebuilt around plan-once-execute-once with a worked recovery.

Verified: both suite flows run end-to-end as **one** model turn each, asserts
included, zero images. Numbers in `docs/BENCHMARKS.md`, baseline in
`docs/ESCALATIONS.md`.

---

> **Before Phase 12, and before Phase 13, read the route in
> `docs/DEFERRED.md`.** Five things now sit between here and Phase 12, and one
> of them changes this file: the perception eval harness is written into Phase
> 13 step 5, and four items ahead of Phase 13 need it, so it comes out of 13
> and happens first. Phase 12 also depends on label resolution and the change
> detector being fixed, because a reflex is a *safety* mechanism built on label
> matching and on verdicts, and both are currently miscalibrated in ways that
> are measured rather than suspected.

## Phase 12 — Reflexes: local recovery before escalation

> **Reordered, 2026-09-10 — most of this is waiting on evidence that has not
> arrived.** Reflexes handle interruptions, which is the `novel_dialog`
> escalation reason, and `novel_dialog` has been logged **zero times in 173
> escalations** across two days of driving a real third-party app. CLAUDE.md
> says the breakdown decides the next faculty and the default order is not a
> commitment; this is the first time that has bitten.
>
> **Build now: step 1 only** — `simframe prep`, plus the destructive-vocabulary
> data file from step 5, which several other things already want. Both are cheap
> and both address interruptions where they actually occur, at setup: pasteboard
> consent eating the first paste, a notifications prompt blocking a `waitFor`.
>
> **Wait: steps 2–4**, the reflex table and its detection. A trigger→action
> table for dialogs that have never been recorded is a guess with a
> configuration file. Re-read the breakdown after screen identity is fixed —
> some interruptions may be hiding inside `verification_failed`, because a
> dialog is exactly the sort of thing that makes a verification fail.
>
> What the log points at instead is in `docs/DECISIONS.md`: verification
> correctness first, then plan-first batching.


```
Read CLAUDE.md, docs/research/03-human-parity.md §4 (the reflex table and
its caveats), and docs/ESCALATIONS.md — especially the novel_dialog and
verification_failed counts.

Task: handle common interruptions without a model call.
1. Pre-emptive controls first. `simframe prep <bundle-id>` grants the
   requested privacy services via `simctl privacy` (or `adb pm grant`),
   pins the status bar via `simctl status_bar override`, and on Android
   sets the three animation scales to 0. `sim_launch` accepts a `prep`
   list. Record what was pre-granted in the flow record.
2. Reflex table as data. A JSON/YAML file (English vocabulary today, keyed
   by locale) mapping trigger patterns → local action → escalate-instead
   condition, covering: iOS permission alerts, ATT prompt (UI only), rating
   prompt, software-update nag, keyboard suggestion bar, Face ID sheet
   (`simctl` biometric match), wrong push → back once, transient
   no-visible-change → retry once with jittered backoff, wedged app →
   relaunch once, Android permission dialog / ANR / crash dialog.
3. Detection uses the fused element list and the transition classifier
   (alert/sheet kinds), never pixels alone. A reflex fires only when the
   trigger matches with confidence above the same threshold used for intent
   resolution; below that it is an escalation with reason novel_dialog.
4. Every firing appends to the flow record and to a `reflexes` field in the
   escalation log entry it prevented. `sim_do` output shows a reflex summary
   so a human can audit what was auto-dismissed.
5. Hard rule: a reflex never taps anything whose label matches the
   destructive vocabulary (Delete, Remove, Pay, Send, Sign out, Reset…). Add
   the list to the same data file.

Verify: build a small harness that triggers each iOS reflex on a demo app
(permission, rating, wrong push, wedge) and shows the local recovery.
Re-run the flow suite; report novel_dialog escalations before/after and the
HPI delta. Append to BENCHMARKS under "Phase 12"; update ESCALATIONS.md.

Do not: auto-accept anything not in the table. Do not let a reflex fire
twice for the same trigger on the same screen — the second time is an
escalation.
```

---

## Phase 13 — Attention: region-of-interest perception

```
Read CLAUDE.md, docs/research/03-human-parity.md §2, docs/PRIVATE_API.md
(capture section), and the current perception path in the daemon.

Task: perceive only what changed.
1. Wire SimulatorKit's damage-rect callback (see idb's FBFramebuffer.m for
   the selector; verify against the binary before use and log the result in
   PRIVATE_API.md). Union rects per settle, dilate by 8 px. If the callback
   is unavailable or unreliable, derive dirty rects from the existing frame
   diff instead — the rest of the phase must work either way.
2. Expected-change priors from the transition graph: tapped element's frame,
   the band below a focused text field, the top toast band, the nav-bar
   title. Union with dirty rects into the ROI set.
3. OCR runs with VNRecognizeTextRequest.regionOfInterest per ROI
   (normalized, bottom-left origin; results come back in full-image
   coordinates). Accessibility and CV re-run only for elements intersecting
   the ROI set. Everything else is carried over from the previous element
   list for that screen.
4. Safety valve: a full re-perception whenever the fingerprint fails to
   match a known screen, and unconditionally every 10th settle.
5. Build the deferred perception eval harness here: record (frame, element
   list) pairs from full perception, then replay the same frames through the
   incremental path and diff. Report recall/precision of the incremental
   element list against the full one.

Verify: per-step perception latency before/after on the flow suite (median,
p95), incremental-vs-full recall ≥ 0.98 with no new wrong taps. Append to
BENCHMARKS under "Phase 13"; update ESCALATIONS.md.

Do not: skip the safety valve. Do not remove full perception — it is the
fallback and the ground truth for the harness.
```

---

## Phase 14 — Anticipation: prefetch and speculative resolution

```
Read CLAUDE.md and docs/research/03-human-parity.md §3. This phase builds on
the transition graph (Phase 6) and ROI perception (Phase 13).

Task: overlap perception with the animation window.
1. On issuing an action whose graph edge predicts destination S′: load S′'s
   element map from screen memory immediately, start settle/transition
   classification, and pre-compute the ROI set for S′.
2. Speculatively resolve the next flow step's target against S′'s cached
   map while the transition is still animating.
3. On settle: compute the fingerprint. Match → the speculative target is
   confirmed and the next step executes with no re-perception and no model
   call; record `speculation: confirmed`. Mismatch → discard, record
   `speculation: rejected`, and proceed through the normal verify path.
4. Verify barrier: speculation never executes a step whose target label is
   in the destructive vocabulary, whose action leaves the app, or whose
   verdict history on this edge contains any `unexpected-*`. Those wait for
   confirmed perception.
5. Flow record gains speculation counts (attempted/confirmed/rejected) and
   the wall time saved (measured as time between settle and next action,
   before vs after).

Verify: flow suite three times; report confirmed/rejected speculation
counts, zero speculative wrong actions, wall-time delta, HPI delta. Append
to BENCHMARKS under "Phase 14"; update ESCALATIONS.md.

Do not: speculate on cold edges (<5 samples) or on any edge with a prior
unexpected verdict.
```

---

## Phase 15 — Goal-directed exploration when lost

> **Promoted, 2026-09-10, and it is now the leading candidate for a local model
> — ahead of Phase 18.** The owner described the behaviour twice, and the second
> version named the current failure exactly:
>
> *"I am in a new app's settings, I look for something like change username. I go
> to each menu, check the items, nothing like that? Next menu, until I find it."*
>
> *"And when I don't find what I need somewhere, I don't fall into an existential
> crisis. I look for it somewhere else."*
>
> Today a miss **is** an existential crisis. Nothing matches, `unknown_screen`
> is logged, the step throws, the batch dies, and the reasoner is asked. It is 12
> of 173 escalations, and every one of them stops a batch — so a five-menu search
> is ten or more round trips for a task a person does in seconds.
>
> **Two separable pieces, and only one of them needs a model.**
>
> *Not asking* is mechanical. The graph knows which exits from this screen have
> been taken and which have not; "try the next unexplored container, then come
> back" needs no judgement, and CLAUDE.md already fixes the guardrails — six
> actions per attempt, never explore when a graph path exists, escalate with the
> partial map attached, and the verify barrier forbids destructive labels
> throughout. That gets breadth-first search with no model at all.
>
> *Ordering* is where a local model earns its keep, and this is **the first case
> in this whole series where it does something a string matcher structurally
> cannot.** "Change username" does not lexically resemble "Account", "Privacy" or
> "Profile" — no prefix, no synonym, no typo distance. Ranking those three by
> which one plausibly *contains* a username setting is world knowledge, and a 3B
> model has it. Phase 17's job was choosing among candidates that all matched,
> which the matcher already did 37 times in 40. This is choosing among candidates
> that **none** of them match, which the matcher cannot do at all.
>
> **And unlike Phase 17's and Phase 18's, this go/no-go can be run offline
> today.** The corpus is already on disk: **129 stored screens, 3,915 labelled
> targets**, and a graph recording which container led where. Ground truth is
> free — for a control that was eventually reached, the path that reached it says
> which menu you had to open.
>
> 1. Build cases from stored screens: a goal phrase, the element list of a screen
>    that does not contain it, and the container that in fact leads to it.
> 2. Ask each candidate model to rank the containers. Measure **top-1** and
>    **top-3** accuracy, and latency.
> 3. **Go** if top-3 beats breadth-first ordering by enough to save a step on
>    average — that is the honest baseline, because breadth-first needs no model.
>    Top-1 is the prize; top-3 is the threshold, since being wrong twice still
>    beats asking.
>
> Build the mechanical half first regardless. It removes the escalation; the
> model only makes the search shorter. Measuring the model against
> breadth-first — rather than against the current behaviour of giving up — is
> what keeps this honest.



```
Read CLAUDE.md, docs/research/03-human-parity.md §5, and docs/ESCALATIONS.md
(unknown_screen and no_plan counts — this phase exists to lower them).

Task: when the target is not on screen and the graph has no path, look for
it locally before asking the agent.
1. Exploration budget B = 6 actions per attempt, hard.
2. Order of strategies: (a) deep link if the app's URL scheme is known
   (record schemes in ~/.simframe/apps/<bundle>.json; `sim_launch` learns
   them from Info.plist); (b) scroll-to-reveal on the main scrollable until
   the target label/icon appears or the frame stops changing; (c) tab-first —
   open the tab whose label is closest to the goal by the existing intent
   matcher; (d) a search field if one exists, typing the goal noun.
3. Every discovered `(screen, action) → screen′` edge is written to the
   transition graph as you go, so the next run is a memory hit.
4. Budget exhausted → escalate with reason no_plan and attach the partial
   map (screens visited, edges learned) so the agent does not repeat the
   exploration.
5. Flow record gains exploration_events with strategy, actions used, and
   whether the target was found.

Verify: pick three targets in the demo app that are not reachable from the
graph; run each five times from a cold graph; report found/not-found,
actions used, and the unknown_screen/no_plan escalation counts before/after
across the flow suite. Append to BENCHMARKS under "Phase 15"; update
ESCALATIONS.md.

Do not: explore past the budget. Do not tap anything in the destructive
vocabulary during exploration. Do not explore when a graph path exists.
```

---

## Phase 16 — Icon semantics without a large model

```
Read CLAUDE.md, docs/research/03-human-parity.md §6, and the unbuilt Phase 5
items in docs/DEFERRED.md (SF Symbol templates, NLEmbedding). Check
docs/ESCALATIONS.md for ambiguous_intent on icon-only chrome — if it is not
a top-two reason, stop and report instead of building this phase.

Task: label unlabeled icons locally.
1. Template bank: render the ~150 most common SF Symbols (and Material
   Symbols for Android) at 3 sizes via NSImage(systemSymbolName:) to
   luminance/alpha masks. Match label-less icon candidates with multi-scale,
   tint-invariant normalized cross-correlation. Assign synonym labels
   ("Back", "Close", "Settings", "Search", "Share", "Add", "More"…).
2. Context disambiguation: tab-bar/nav-bar position, adjacent label, badge.
3. Optional tiny classifier, behind a flag: if template matching leaves a
   meaningful residue of unlabeled icons on the eval set, train or adopt a
   <5 MB Core ML classifier over the ~100 RICO icon classes; target <5 ms per
   crop on the Neural Engine. Ship only if it clears 90% on our own iOS eval
   screens.
4. NLEmbedding-based intent matching from Phase 5 lands here too, since icon
   synonyms are where fuzzy string matching stops being enough.
5. Icon-only taps are gated behind verify-after-tap and never speculative.
   Low-confidence matches are ambiguous_intent escalations, not guesses.

Verify: on the perception eval set, report icon label accuracy (template
only, then with classifier if built), intent top-1 accuracy before/after,
ambiguous_intent escalations before/after, HPI delta. Append to BENCHMARKS
under "Phase 16"; update ESCALATIONS.md.

Do not: ship any model with a license that is not MIT/Apache-2.0/BSD. Do not
let an icon label override an accessibility label when both exist.
```

---

## Phase 19 — The web as a third target (roadmap, not committed)

> **Added 2026-09-11 on the owner's framing, which is the correct one.** Their
> words: *"we can use our philosophy on web rather than the exact thing we do
> for simulators"* and *"web browser gives us lots of tools to find a field,
> debug etc — it's not a sandbox, which is good."*
>
> The full design, the CDP mapping for all sixteen `Platform` members, which
> pillars transfer and which must be re-derived, is in
> `docs/research/04-web.md`. The short version:
>
> **Porting the implementation would build a worse Playwright.** The perception
> layer exists because iOS gives bad handles; the web has
> `document.querySelector`. **Porting the philosophy is the thing**, and it gets
> *stronger* — every per-step question this project currently infers from pixels
> becomes one the browser lets you ask directly, so more can be decided locally,
> which is the whole thesis.
>
> What is new against Playwright is the **engine, not the eyes**: the transition
> graph, outcome memory, the certainty vocabulary, batching with local recovery,
> the escalation log, HPI. Playwright is hands and eyes; this is the layer above
> that decides whether to think.
>
> **One pillar must be re-derived from a log rather than copied.** The five
> escalation reasons are mostly perception failures and largely vanish on the
> web. Copying that taxonomy would repeat the `doctor` mistake of reporting
> "input driver: idb" for an Android emulator — another platform's vocabulary
> asserted about a tool that has never spoken to the device.
>
> **Sequenced after the release and the open queue**, at the owner's direction:
> *"first things first, need passing CI and a publish."* The CDP WebSocket
> client that network visibility needs is most of the plumbing, so the honest
> moment to decide is when that works and the cost is measured rather than
> estimated.

```
Read docs/research/04-web.md in full, CLAUDE.md's Platform boundary section,
and src/platform/android.js as the worked example of a second backend.

Task: measure whether the engine is worth anything on a target whose
perception is already good.
1. Build the mechanical backend ONLY, behind the existing seam: targets,
   navigate, screenshot/screencast, AX tree, input. No new perception and no
   new step types. launchApp/terminateApp are `optional` with a reason — a
   browser does not launch apps, and it must not borrow that vocabulary.
2. Run the existing flow suite against a web target. Every layer above the
   boundary is unmodified, so this measures the engine in isolation. Record
   model turns, HPI against a human median on the same flows, and the
   escalation breakdown.
3. Go if the graph and the batching remove turns on a target with a perfect
   tree and a queryable DOM — because that is the claim being tested.
4. Compare against Playwright driven by the same model with no memory, not
   against a bare model loop. Anything else flatters the result.

Verify: append to BENCHMARKS under "Phase 19"; record the decision in
DECISIONS.md either way, with its reason.

Do not: add a runtime dependency — the CDP client is hand-rolled, and
docs/BENCHMARKS.md records the two reasons why (the Origin header a stock
client cannot set, and no global WebSocket on Node 18 or 20). Do not port the
five escalation reasons; derive them. Do not weaken the verify barrier — a
real page can be a production system.
```

---

## After Phase 16

Re-run `simframe hpi` and `simframe escalations` across the whole suite.
Write `docs/HUMAN-PARITY.md`: the HPI trend from Phase 10 to now, the
avoidable escalation rate trend, which faculties moved which numbers, and
what remains. That document plus BENCHMARKS.md is the evidence for the article.

---

## Phase 18 — The local supervisor: Claude plans, the local model drives and watches

> **Redesigned 2026-09-10 on the owner's proposal, which is better than what this
> phase said.** Their words:
>
> *"For step C you used apple as planner, but I'd use Claude as planner and use
> apple as the brain to act when the tool gets confused in between the steps. I'd
> give the plan to apple's model and use that as the live driver and supervisor
> until the plan is finished. The apple model communicates with Claude only when
> it cannot act. And when the plan is finished, apple tells the results in short
> to Claude."*
>
> This inverts what was built. The shipped ranker asks the local model *which
> door to open* — a decision Claude is better at and mostly does not need help
> with. This asks it to **hold the plan and watch it run**, which is where the
> round-6 measurement says the time actually goes: of run A's 514 seconds, ~386
> (75%) was thinking and round trips, and every pause the operator flagged live
> was a call boundary.
>
> **Two corrections it needs, and both make it stronger.**
>
> **One: the executor already exists and it is not a model.** `sim_do` is exactly
> "hand a plan to a local driver that runs it, verifies each step and reports back
> once" — and round 6's best result was **18 steps in a single call**.
> Deterministic code is a better executor than a model: faster, exact, auditable,
> and it cannot hallucinate a step. So the local model must not *drive*. The plan
> stays in the executor.
>
> This also settles a hard constraint the proposal would otherwise hit. Apple's
> model has a 4,096-token context; a 27-step plan plus screen state plus history
> does not fit. A **per-step supervisor** does, comfortably: the step that failed,
> what was expected, what is on screen.
>
> **Two: the supervisor's whole vocabulary is three words.** What actually kills
> batches in the field reports is never "which step next" — it is a moment where
> the executor needed judgement and had none:
>
> | what killed the batch | what a supervisor would have said |
> |---|---|
> | `assert` read a stale snapshot (item 49) | re-read, then retry |
> | `unexpected-screen` on a variant (G1) | the next step resolves here — continue |
> | a list had not loaded (items 51, 53) | wait, do not fail |
> | ten steps failed on an unchanged screen (item 52) | stop, nothing downstream can work |
>
> So the supervisor chooses only between **wait**, **retry**, and **stop**. It may
> not invent a step, skip a step, substitute a target, or continue past an
> unexpected *screen*. That is one-directional authority in the shape this design
> needs, and it is not a threshold — it is the size of the answer space.
>
> After today it is worth saying why that matters so much. `seek` was given
> latitude to choose *what* to open, its permission list answered the wrong
> question, and it pressed "YES, THIS FIXED MY PROBLEM" in a live app. A component
> that can only say wait/retry/stop cannot do that, whatever it believes.
>
> **The half of the proposal I had underweighted, and it is the valuable half.**
> *"When the plan is finished, apple tells the results in short to Claude."* The
> field reports show a single surprise costing **three to six calls just to
> understand** — a `find`, an `--interactive`, a screenshot, a coordinate guess.
> A local summary does not remove the round trip; it makes one round trip
> sufficient. Turning a six-call recovery into a one-call recovery is worth more
> than removing the call.
>
> **Sequencing, and this is not deferral.** Every row in the table above is a
> *deterministic* fix that is already filed: 49, 51, 52, 53, and G1 which landed
> today. Fixing them is strictly better than having a model judge them — a
> supervisor papering over a stale assert is worse than a fresh assert. So: fix
> those, re-measure, and the supervisor's job is whatever is *left*. If nothing
> is left, that is the best possible outcome and it costs one measurement to find
> out.
>
> **Go/no-go, revised.** After items 49–53 land, run two field rounds and classify
> every batch that still died: deterministic bug, genuine app surprise, or a
> judgement call that wait/retry/stop would have answered. **Go** if the third
> category is more than a quarter of them. Measure two things separately because
> they succeed independently: **batches saved** (a wrong "continue" costs a wrong
> tap, so precision must be very high — start at 95% and derive the threshold from
> the data), and **calls-per-recovery before and after the summary**, which is the
> number that justifies the phase on its own.

## Phase 18 (superseded framing) — Local triage: recovering from the unexpected

Proposed 2026-09-10, out of the round-4 and round-5 field data and the owner's
own framing. **Filed as a separate phase rather than as an appeal against Phase
17's no-go, because it is a different job.** Phase 17 asked a local model to
choose the next element and the answer was that the matcher already does — 37 of
40. This asks it to handle the moment the plan breaks, which was never measured.

**The case, in the owner's words:** *"testing a dynamic app with dynamic data and
several rules has several things we might not expect at all."* That is precisely
the shape a reflex table cannot cover. Phase 12's table handles interruptions you
can enumerate — a permission alert, a rating prompt. It cannot enumerate "this
location has no assets because of a branch rule", "a validation message appeared
and cleared", "the list came back empty", "the trade is still loading". Those are
unbounded, and a table meeting an unlisted trigger has nothing to say.

**Two jobs, and the second one is the underrated half.**

1. **Triage.** Given the goal, the step that just failed, what was expected and
   what arrived, decide: *retry this step*, or *hand back to Claude*. Round 5's
   three `unexpected-screen` failures were all benign variation, and each cost
   the remainder of its batch — so a correct "this is benign, retry" is worth a
   round trip every time it fires.
2. **Compression.** When it genuinely is a surprise, describe it well enough that
   Claude's *one* turn is sufficient. This is where the field data is loudest: a
   single surprise repeatedly cost **three to six calls** to understand — a
   `find`, an `--interactive`, a screenshot, a coordinate guess — because the
   agent had to reconstruct what happened from a map. A local summary — "a
   validation message appeared; the submit control is now disabled; two required
   fields are empty" — does not remove the round trip. It makes the round trip
   enough. Turning a six-call recovery into a one-call recovery is a larger win
   than removing the call would have been.

**The example that decided this, and the rule that failed to cover it.** The
owner's own words: *"maybe we select a location in CSR but that location doesn't
have any asset, so my next instinct is select another location — and all this
happens in seconds. It's not like I think for minutes."*

Every fact that instinct runs on looks like it is already in hand: the asset
region has nothing in it, the primary action reports `disabled`, and the graph
remembers `tap "Change"` worked on this screen. So the first attempt at this was
a structural rule — *nothing choosable plus a disabled primary action equals a
dead end, name the way back* — written, tested, and **reverted before it
shipped**, because it cannot be made to work:

- "Nothing choosable" is false. The Location select on that screen is perfectly
  choosable; it is the *asset* list that is empty. The screen is not a dead end,
  one required input on it is.
- Loosening it to "the primary action is disabled" fires on **every half-filled
  form**, which is most form screens most of the time. It cannot tell *you have
  not finished* from *you cannot finish*.

The missing fact is that an asset is **required** and that this location has
**none** — and neither is in the accessibility tree. The map models controls,
not the app's rules. A reflex table keyed on dialog vocabulary is even further
away, because there is no dialog.

So the owner's example is not an argument that the table needs more entries. It
is the clearest available demonstration that **a class of recovery cannot be
enumerated at all**, which is the case for Phase 18 and the reason it is filed
rather than folded into Phase 12. Recorded with the failed rule attached,
because a rule that cries wolf on every unfinished form is exactly the kind of
threshold this project has shipped before and had to revert.

**And the owner generalised it, which split the problem in two.** *"It was an
example — I can act like that in any new environment. I go to Instagram, misclick
a like button; humans aren't as accurate as bots. I notice immediately, I go back
or I remove the like. No need to think for minutes and scan the whole of
Instagram's philosophy. I use what I see."*

That is a different class from the location example, and the difference is the
whole design:

- **Convention-recoverable.** A misclick, a wrong push, an accidental toggle.
  Recovery needs no knowledge of the app — back, undo, tap it again. Every app
  has these because every UI toolkit has these.
- **Rule-blocked.** The empty asset list. Recovery needs to know the app's
  rules, and no amount of looking at the screen supplies them.

The first class was **already answerable and simply unsaid**, which is the more
embarrassing finding. `unexpected-screen` notices a wrong turn in about 200ms,
and `graph.route` can compute a path from where we landed back to where we were
out of edges already recorded. The step threw anyway, the batch died, and a model
round trip was spent deciding what the graph could have answered. So a wrong turn
now reports the way back with it:

```
FAIL [0] tap: unexpected-screen: expected the screen this action reached 6x
     before, and landed somewhere else — back to where you were: tap "Back" (seen 6x)
```

No model, no new state, and it does not take the action — going back changes what
happens next, so the reasoner still chooses. It makes **one** round trip
sufficient instead of the three to six the field reports spent working out where
they were.

Which sharpens what is actually left for a local model: not noticing, and not
the conventional recovery. What is left is the tail where convention does not
apply and the app's rules do — and the **compression** job below, which is
class-independent.

**The safety property that makes it buildable: one-directional authority.**

The local tier may only ever move a decision *toward* caution:

- it may downgrade an escalation to **retry the same step**;
- it may **annotate** an escalation so the model's turn is cheaper;
- it may **not** authorise continuing past an anomaly;
- it may **not** act on a destructive label, leave the app, or touch an edge with
  a prior `unexpected-*`.

Getting it wrong in the cautious direction costs one round trip, which is the
status quo. Getting it wrong in the bold direction is forbidden by construction
rather than by confidence threshold. This is the verify barrier, unchanged, and
it is what the reflex analogy actually implies: the reflex may pull your hand off
the pan; it may not decide to leave it there.

**Ordering, and it matters.** Do not build this before the residue is measured.
Most off-plan events observed so far were **tool defects**, not app surprises —
false `unexpected-screen`, a phantom keyboard, a focus warning that could not
succeed — and those were fixed by fixing them, not by adding judgement. A model
placed on top of that would have been a brain servicing a bug.

**Go/no-go, and note what it does not measure.** Unlike Phase 17's, this one
cannot be answered from stored data, because the corpus does not exist yet: the
false alarms polluted it and have only just been fixed.

1. Run two or three field rounds on the current build. Count off-plan events and
   classify each: tool defect, enumerable interruption (Phase 12 table), or
   genuine app surprise.
2. **Go** if genuine surprises are more than a third of the remainder *and* the
   recovery cost more than two calls each on average. Below that, Phase 12's
   table plus better failure messages is the cheaper answer and this stays
   filed.
3. If go, measure two things separately, because they succeed independently:
   triage precision on the "retry" decision (a wrong retry costs a round trip, so
   the bar is ~90%), and **calls-per-recovery before and after** the compression
   summary. The second is the number that justifies the phase.

**Candidate and constraints** are unchanged from `docs/PHASE-17-SUPPLEMENT.md`,
including its amendment: Apple's on-device model first because it ships no
weights, degrade to `none`, and never a multi-gigabyte download as a default.
The 4,096-token budget is more comfortable here than it was for planning — a
failed step, its expectation, and the current element list is a smaller prompt
than a full screen plus a goal.

---

## Phase 17 — Local planner tier (a plan, a go/no-go, and a NO-GO)

> **Result, 2026-09-10: NO-GO.** The go/no-go was run — see "Go/no-go, as run"
> below — and it says the prize is 5% of decisions. Not because the candidate
> model is weak; that was never measured, because it did not need to be. Of the
> element decisions an agent actually makes on real apps, the local matcher
> already resolves **37 of 40**. A planner that got every remaining case right
> would remove two escalations in forty steps.
>
> The reason is worth more than the number. **By the time a step reaches
> simframe, the decision has already been made.** A verified edge's goal *names*
> the option — `tap "<the option Claude picked>"` — because Claude chose the option and then asked
> for it by name. The deliberation the user is paying for happens upstream of
> the tool call, and a model inside the daemon reading an element list would
> only re-derive a conclusion Claude had already reached. The one shape a local
> planner could own is the abstract goal, "open this dropdown and pick any
> option", which is `intent.chooseAny` — already local, already cheap, and 2 of
> 40 decisions.
>
> This is the same class of mistake Phase 11.5's premise made. That phase
> assumed the agent was not batching and found it batches 84% of the time; this
> one assumed the expensive decision was visible to the tool and it is not.
> Both were cheap to check and would have been expensive to build.
>
> **What replaces it** is in `docs/DEFERRED.md`: the `next:` hint currently uses
> familiarity as a proxy for risk and shrinks the batch on exactly the screens
> where short batches cost most, and a form-shaped read replaces about eight
> calls with one on a form screen. Those attack the same cost with none of the
> machinery. The plan below is kept intact — including the amendment it wanted —
> because a no-go that deletes its own reasoning cannot be revisited.

Not a build prompt, and now not a prompt at all. Kept as the record of a
question that was asked properly and answered no.

**The idea.** The daemon already turns a screen into text. A small on-device
model can read that text and answer one narrow question — *given this goal and
this element list, which element is the next action?* — in a few hundred
milliseconds, with no network. It sits between the local intent matcher and
Claude in the escalation ladder. Claude keeps every decision that needs real
intelligence: new goals, unknown screens, failed verifications, anything wearing
a destructive label.

**Candidate.** Apple Foundation Models framework (macOS 26): an on-device ~3B
text model, nothing to download, tool calling, constrained JSON via
`@Generable`. Text-only, which is exactly right — it never sees pixels, only the
element list. Fallback if AFM is unavailable or too weak: a ≤4B instruct model
via MLX, Apache/MIT licence only, behind the same interface.

**A rule has to change first, and it is not mine to change.** CLAUDE.md's fixed
decisions forbid model calls inside the daemon. Phase 17 needs that amended to:
*no **remote** model calls inside the daemon; an on-device model behind a flag
is permitted for step selection only, never for planning a goal and never for
overriding a verdict.* Recorded here rather than edited in, because a fixed
decision should not be quietly loosened by the phase that wants it loosened.

**Blockers, checked 2026-09-10, before the go/no-go was run.** Two are real,
one is the user's, one turned out not to be a blocker at all. Kept because the
last of them is what the go/no-go went around rather than waited for.

- **Not a blocker: the candidate exists here.** macOS 26.6.2 and
  `FoundationModels.framework` is in the macOS SDK (26.5). No download, no MLX
  fallback needed to *try* it.
- **Blocker, and it was the user's to clear: the CLAUDE.md amendment.** Fixed
  decisions forbid model calls inside the daemon. See above.
- **Blocker, now cleared: the ground truth was not being logged.** The go/no-go
  needs (goal, element list, the action Claude eventually took). The element
  list was there as `candidate_elements`, and the eventual action is recoverable
  from the graph — the tap that finally worked on that screen becomes a verified
  edge carrying its own step. The **goal** was missing, sitting inside
  `detail`'s prose. It is a field now: `intent`. Without it there was no test to
  run, only a sentence to regex.
- **Blocker, and only time clears it: the existing data is contaminated.** The
  bench device's log holds ~121 records of which 55 are `ambiguous_intent` — and
  `ambiguous_intent` is the reason a *ranking* bug produced all day on
  2026-09-10, fixed the same day. Those 121 also predate session ids, so they
  cannot be attributed to one agent. **The 200 must be collected after the
  ranking fix, from real peer sessions, filtered to one session id.**

**Ordering.** "After Phase 16" is a default, not a dependency. The go/no-go is
cheap and reads a log, so it can and should be run as soon as the 200 exist — a
*no-go* changes the plan for Phases 12–16, and finding that out early is worth
more than tidiness.

**Go/no-go, as planned:**

1. Export 200 real `ambiguous_intent` and `no_plan` escalations, each with the
   goal, the element list, the candidates, and the action Claude eventually took
   as ground truth. Filter to one session id — the log pools agents, and the
   breakdown warns when it might be doing so.
2. Prompt the candidate offline with the same inputs. Measure top-1 agreement
   with Claude's action, refusal rate, and latency.
3. **Go** if agreement ≥85% on cases where Claude's action was verified `ok`,
   zero destructive suggestions, and median latency ≤500 ms. Otherwise stay
   deferred and revisit when the escalation mix has changed.

**Go/no-go, as run — 2026-09-10.** `scripts/phase17-corpus.mjs`, aggregate
output only because it reads a real device's memory of real third-party apps.

Step 1 as written could not be done, and finding out why is half the result.
`no_plan` has never been logged once. `ambiguous_intent` is the reason the
ranking bug produced all day, so the pre-fix records encode a bug. And the
session id was minted from the pid — right for the MCP server, which is one
long-lived process, and wrong for a CLI-driven agent, which starts a process per
command: 33 session ids for 46 records on the benchmark device, 30 of them
holding one record. "Filter to one session id" had nothing to filter. Both
logging defects are fixed (`SIMFRAME_SESSION`; `intent` now carried on
`verification_failed`, which was the largest reason class and the only one
dropping it), but the corpus they would have built is still months away, because
it is a corpus of *failures* and the failures were being fixed.

The better corpus was already on disk. **Every verified graph edge is a decision
that worked**: the goal is in `step`, the screen is the node, and the element
list for that screen is in the screen map. That is (goal, element list, action)
for every *successful* step rather than only the rare failures, and the ground
truth is stronger because the tap was verified.

118 verified edges across five devices — two real third-party apps, Settings,
and an Android emulator. Of those, 40 were decisions where an element had to be
chosen; the rest chose no element at all (30: `launch`, hardware `button`,
`openUrl`, `scroll`) or named a `#ref` or a coordinate (27), and 18 could not be
joined to a stored screen. Running today's `matching.resolve` on the stored
element list:

| | n | share |
|---|---|---|
| already resolved locally | 37 | 92.5% |
| ambiguous — a planner could pick | 2 | 5.0% |
| not found — a planner cannot invent an element | 1 | 2.5% |

The planned threshold asked how accurate the model would be. It never asked how
large the prize was, which is the question that settles it.

**The objection, and the answer.** A verified edge is a decision that
*succeeded*, so the graph cannot see the ones the matcher fumbled — those became
escalations, Claude fixed them, and the edge was written with the corrected
goal. Measuring the matcher on its own successes is partly circular. The
escalation log is the second instrument, with the opposite bias: resolution
failures (`ambiguous_intent` + `unknown_screen`) against total edge traversals.
On the real third-party app across both peer rounds that is **4 in 73 — 5.5%**,
against 5% from the corpus. Two instruments, one built from successes and one
from failures, same answer. The benchmark device reports 69 failures against 50
traversals, which is not a rate: its graph is discarded on every `MAP_VERSION`
bump while the log appends, and 51 of the 69 are the ranking bug. That device is
why the plan said "collect after the ranking fix", and it is why the real app's
number is the one to read.

**A sibling research pass reached the same place from the build side.**
`docs/PHASE-17-SUPPLEMENT.md` works out how the planner should be built —
Apple's 4,096-token budget, constrained `@Generable` output, temperature 0, an
endpoint abstraction, availability as a `doctor` capability. Its constraints are
right and worth keeping. But its own ladder rule — *the planner is consulted
only when the matcher returns ambiguous or no match* — scopes the planner to
exactly the slice measured above. By that document's own definition, the planner
runs on 5% of decisions.

**Caveats, because N is 40.** The goals were phrased by an agent already using
this matcher, so the interface trains the caller into the resolvable regime —
92.5% is not a claim about arbitrary phrasing, and it cuts toward no-go rather
than away from it. `resolve` runs against the stored snapshot, which is not
always the screen at decision time; 18 edges could not be joined at all. Only
verified edges are recorded, so decisions that failed and were retried are
under-represented — the escalation log is the other half of that picture, and
post-ranking-fix it holds two intent-bearing records in total. A larger corpus
could move 5% to 10%. It cannot move it to a phase.

One caution the log already justifies: at the time of writing, this device's
escalations are 55 `ambiguous_intent` and 54 `verification_failed`, and
`ambiguous_intent` is the reason a *ranking* bug produced all day. Export the
200 after the ranking work has settled, or the ground truth will encode a bug.

**If it had been a go, the build phase would have been:**

- Ladder: intent matcher → local planner → Claude. The planner receives the
  goal, a compact element list and the last verdict, and returns
  `{element_ref, confidence}` or `{escalate: reason}`.
- Hard limits: a confidence threshold taken from the go/no-go data; never on a
  destructive label; never on an edge with a prior `unexpected-*`; at most one
  planner attempt per step, then Claude.
- Every planner decision is logged with a new outcome
  `resolved_by_local_planner` and verified by verify-after-tap like any other
  action. A wrong planner action counts against HPI_accuracy exactly as a wrong
  Claude action would — the ladder does not get its own scoring.
- Success metric: model turns per flow, `ambiguous_intent` and `no_plan` counts
  before and after, HPI delta, planner precision.

**Why not a full local agent.** A 7–8B model on an M-series machine is 1–3 s per
decision — barely faster than Claude over the network, and far weaker at exactly
the milestone decisions that matter. Narrow, fast, verifiable step selection is
the only local job here with a clear payoff.
