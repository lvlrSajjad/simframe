# Phase 17 supplement — what the local-worker research changed

> **Kept, and superseded on the question it was answering — 2026-09-10.**
> Phase 17 is a **no-go**. This document is careful work on *how* to build the
> planner and on whether the model would be accurate enough; the go/no-go was
> settled instead by asking how much there was to win, which needed no model.
> Of 40 real element decisions taken on real apps, the local matcher already
> resolves 37. See `docs/PHASES-HUMAN-PARITY.md` and `docs/BENCHMARKS.md`.
>
> This document supplies the sharpest argument for that conclusion, from the
> other direction. Its own **"Position in the ladder is fixed"** rule — *the
> planner is consulted only when the matcher returns ambiguous or no match* —
> defines the planner's scope as precisely the slice that was measured. By the
> supplement's own scoping, the planner runs on **5% of decisions**, and only
> the ones it gets right count.
>
> Kept in the repo rather than deleted, for three reasons. The context budget
> (4,096 tokens, compact element list only, never pixels) is a real constraint
> on anything on-device and will apply again. "Availability is a capability,
> not an assumption" is this project's own rule, correctly applied, and is how
> any future local tier must be built. And a no-go that throws away the
> reasoning behind it cannot be revisited when the escalation mix changes.
>
> What is *not* needed as a result: the CLAUDE.md fixed-decision amendment.
> Nothing was loosened, because nothing is being built.

Read alongside the Phase 17 entry in docs/PHASES-HUMAN-PARITY.md. A sibling
research pass (on local coding workers) surfaced facts about Apple's on-device
model that bear on Phase 17. Apple's model stays the first candidate — the
reasons it was rejected for code do not apply here — but three constraints
and several design decisions follow.

## Why Apple's model is still the right first candidate

The research rejected it as a *coding* worker because Apple says "avoid code
generation tasks," publishes no coding benchmark, and caps context at 4,096
tokens. Phase 17's job is not code. It is: read a goal, read a compact
element list, return one element index or "escalate" as constrained JSON.
Apple's own scoping of the model — summarization, entity extraction, text
understanding, short structured output — is exactly this task. The go/no-go
test decides; do not pre-judge it in either direction.

## Hard constraints

1. **4,096-token context, total.** System prompt + goal + last verdict +
   element list + response must fit. Budget it explicitly:
   - system/instructions: ≤ 400 tokens
   - goal + flow context: ≤ 150
   - last verdict + timing line: ≤ 60
   - element list: the remainder (~3,000), which at ~10 tokens/element is
     roughly 250 elements — more than any real screen after fusion/dedupe.
   The planner must receive the **compact** element list only (ref, role,
   label, state, region), never frames as pixels, never the verbose map.
   If the list exceeds budget: drop static text with no role, then drop
   elements outside the visible viewport, then truncate by region priority
   (content → nav → tab → other) and set `truncated: true` in the log.
2. **Constrained output only.** Use `@Generable` (Foundation Models) or JSON
   schema mode (any fallback) so the response is always
   `{ element_ref: string?, confidence: number, escalate: reason? }`.
   Free-text answers are a bug, not a parse problem.
3. **Deterministic settings.** Temperature 0 (or the lowest the framework
   allows), fixed instructions, no sampling. The same inputs must yield the
   same decision so the go/no-go is reproducible.

## Design decisions

**Endpoint abstraction.** Talk to the planner through one interface:
`plan(goal, elements, verdict) -> decision`, with two backends:
- Apple Foundation Models in-process (Swift, `LanguageModelSession`), and
- any OpenAI-compatible local HTTP endpoint (for the fallback model and for
  the offline harness). Community shims already expose Apple's model this
  way (gety-ai/apple-on-device-openai on :11535, Techopolis/afm-Server on
  :11435); use one of them for the harness so every candidate — Apple, a
  Qwen tier via MLX — is tested by changing a URL, not code.

**Fallback is named, not vague.** If Apple fails the go/no-go, the fallback
is the Qwen2.5-Coder/Qwen3 tier the coding-worker project runs via MLX. One
local inference stack should serve both projects. Do not introduce a third.

**Availability is a capability, not an assumption.** Foundation Models
requires Apple Silicon, macOS 26+, and Apple Intelligence enabled; it can be
unavailable on a given machine or CI runner. `doctor` reports
`planner: apple | local:<model> | none`, and `none` degrades to the existing
ladder (matcher → Claude). CI runs must pass with `planner: none`.

**Position in the ladder is fixed.** intent matcher → local planner → Claude.
The planner is consulted only when the matcher returns ambiguous or no match.
It never runs when the graph has a confident edge and the matcher succeeded.

**Verify barrier applies unchanged.** No destructive labels (the shared
vocabulary file), no actions that leave the app, no edges with prior
`unexpected-*`, at most one planner attempt per step. A planner decision is
executed through the normal verify-after-tap path; a wrong planner action
counts against HPI_accuracy exactly like a wrong Claude action.

**Confidence threshold is measured, not guessed.** Derive it from the go/no-go
data: choose the threshold that gives ≥ 95% precision on cases where Claude's
action was later verified `ok`. Below threshold → escalate to Claude with
the planner's top candidates attached so Claude's turn is cheaper.

## The go/no-go, made concrete

1. Export ≥ 200 `ambiguous_intent` and `no_plan` escalations from the log with
   goal, compact element list, last verdict, and the action Claude eventually
   took, labelled with that action's verify-after-tap verdict. Keep only cases
   whose verdict was `ok` as ground truth; keep the rest as a "should escalate"
   set.
2. Replay them offline against each candidate through the endpoint
   abstraction. Record per candidate: top-1 agreement with Claude on the `ok`
   set; refusal/escalate rate on the "should escalate" set (higher is better
   there); any destructive suggestion (must be zero); median and p95 latency;
   memory.
3. **Go** for a candidate if: agreement ≥ 85% on the `ok` set, escalate rate
   ≥ 70% on the should-escalate set, zero destructive suggestions, median
   latency ≤ 500 ms. Apple first; if it fails, run the Qwen tier; if both
   fail, Phase 17 stays deferred and the numbers go in DEFERRED.md.
4. Write the results to docs/BENCHMARKS.md under "Phase 17 go/no-go" with
   every number flagged measured, and the chosen threshold with its
   precision/recall curve.

## Logging

New escalation-log outcome `resolved_by_local_planner`, plus fields
`planner: {backend, confidence, latency_ms, truncated}`. `simframe escalations`
gains a planner section: attempts, accepted, escalated-anyway, wrong (from
verify-after-tap), and the resulting model-turn savings. That last number is
the phase's result.

## What not to do

- Do not let the planner plan a *goal* or a multi-step flow. One step, one
  element, or escalate.
- Do not feed it images, pixels, or the verbose element map.
- Do not call any remote model from the daemon. "Local" means on this machine.
- Do not ship if `planner: none` breaks any existing flow.
