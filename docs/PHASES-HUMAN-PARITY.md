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

> **Before Phase 12, and before Phase 13, read the route in
> `docs/DEFERRED.md`.** Five things now sit between here and Phase 12, and one
> of them changes this file: the perception eval harness is written into Phase
> 13 step 5, and four items ahead of Phase 13 need it, so it comes out of 13
> and happens first. Phase 12 also depends on label resolution and the change
> detector being fixed, because a reflex is a *safety* mechanism built on label
> matching and on verdicts, and both are currently miscalibrated in ways that
> are measured rather than suspected.

## Phase 12 — Reflexes: local recovery before escalation

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

## After Phase 16

Re-run `simframe hpi` and `simframe escalations` across the whole suite.
Write `docs/HUMAN-PARITY.md`: the HPI trend from Phase 10 to now, the
avoidable escalation rate trend, which faculties moved which numbers, and
what remains. That document plus BENCHMARKS.md is the evidence for the article.
