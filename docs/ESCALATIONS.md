# Escalations — where simframe still needs a model

Every time simframe hands a decision back to the agent, it writes a line to
`~/.simframe/<udid>/escalations.jsonl` (schema: `docs/research/03-human-parity.md`
§8). This file is the steering wheel for Phases 11–16: **the reason breakdown
decides which faculty is built next**, and the default order in
`docs/PHASES-HUMAN-PARITY.md` is a default, not a commitment.

Read it with:

```
simframe escalations --device=<udid>
simframe escalations --device=<udid> --json
```

## The five reasons, and what would remove each

| reason | means | faculty that would remove it |
|---|---|---|
| `unknown_screen` | screen memory has never seen this screen, and the target is not on it | exploration (Phase 14) |
| `ambiguous_intent` | the screen is known; the intent fits more than one element, or none | icon semantics (Phase 15) |
| `verification_failed` | the step's effect could not be confirmed — a wrong turn, nothing moving, an assert that did not hold | sense of time (Phase 11) |
| `novel_dialog` | something on screen that the confirm/choose vocabulary does not cover | reflexes (Phase 12) |
| `no_plan` | no route of known edges reaches the destination | exploration (Phase 14) |

There is no sixth category and no `unknown`. Classification happens where the
decision is made — `metrics.tag` marks the error at the throw site, adding a
property and changing nothing else — rather than by matching error strings at
the boundary, because a regexed message becomes "unknown" the day somebody
rewords it. A unit test asserts that every refusal `goto` can return maps to
one of the five, so a new refusal fails a test instead of logging a category
nobody counts.

Two fields are worth explaining rather than leaving to be discovered:

- **`tokens_spent` is always `null`.** §8 asks for it; simframe sits on the
  far side of the model from whatever counts tokens. A number derived from
  output length would be a guess wearing a measurement's clothes. `model_turns_spent`
  *is* measured — one per escalation the agent has to answer.
- **`avoidable_escalation_rate` is 1.0 by construction today.** §8 defines
  avoidable as "maps to a not-yet-built or under-performing faculty", and every
  faculty in the table above is unbuilt, so every escalation qualifies. The
  rate becomes informative as phases land and `metrics.BUILT_FACULTIES` fills;
  the only term that moves it today is `outcome: resolved_locally`, which
  nothing produces until Phase 12. **The per-reason counts are the part that
  decides the next phase.** Read those.

## First breakdown — Phase 10, 2026-09-09

Twenty-two agent flow runs on an iPhone 17 Pro (iOS 26.5), Apple M2 Pro, Xcode
26.6, all layers `simframed`. Flows: `flows/hpi-suite.json`, stock apps only.

```
19 escalations
  ambiguous_intent      16   would be removed by: icon semantics (Phase 15)
  verification_failed    3   would be removed by: sense of time (Phase 11)

avoidable 19/19 (1.0)      outcomes: failed 19
model turns spent on escalations: 19
top screens:
  5d3ee404fb88d3b2      16      (the Contacts list)
```

**Three of these are artifacts and must not steer anything.** All three
`verification_failed` records carry the detail `note is not a function` — a
JavaScript TypeError from a name collision in this phase's own escalation
recorder, since fixed (`docs/BENCHMARKS.md`, "Two faults found by measuring").
The fallback classified them as `verification_failed` because a step that threw
is a step whose effect could not be confirmed, which is the right rule applied
to a bogus input. They are left in the log rather than deleted — the log is
evidence, and evidence does not get edited when it is embarrassing — but the
real reason distribution here is **16 escalations, all `ambiguous_intent`, all
one screen**.

`settings-larger-text` produces **zero** escalations across every clean run:
four steps, all verified, one model turn. Every real escalation in this data
comes from `contacts-kate-bell`, and they are all the same one.

### What the records say, which is not what the count says

The reason table maps `ambiguous_intent` to icon semantics (Phase 15). The
`candidate_elements` in the log say otherwise, and this is exactly why §8 asks
for that field:

```
"Kate Bell"  (194,286)  source ax    frame x=2   w=384   score 1.00
"Kate Bell"  (103,286)  source ocr   frame x=67  w=71    score 1.00
"K"          (393,411)  source ocr                       score 0.86
```

The first two are the same contact row. The accessibility tree reports the row;
OCR reports the words inside it; the OCR box is wholly contained in the AX box;
both score 1.00, so the matcher calls it ambiguous and refuses. Nothing about
icons is involved. Two further facts make it sharper: `simframe ui` displays
**one** "Kate Bell" — the renderer collapses the duplicate and the matcher that
acts on it does not — and the OCR-only condition has one element there and
resolves it, so the tree being *present* is what causes this.

This is not a new discovery. It is filed in `docs/DEFERRED.md` ("A contact row
is ambiguous with its own name"), found while measuring the accessibility tier,
with the same diagnosis: the fix is probably in `collapseSamePlace`, where a
text element wholly inside a row *is* that row. What Phase 10 adds is that it
now carries a count, a screen fingerprint and the candidate list, so it can be
tracked rather than remembered — and a price: it is the entire difference
between `HPI_accuracy` 0.5 and 1.0.

### Next faculty, derived from the above

**First, and it is not a faculty:** de-duplicate same-element entries in the
fused list. One bounded change in perception, worth half of `HPI_accuracy` on
this suite, cheaper than anything in Phases 11–16. Phase 10 forbids perception
changes, so it was not done in that phase.

**Done, immediately after Phase 10.** An OCR reading ≥90% inside a labelled ax
element whose text matches its label is that element. `contacts-kate-bell` went
from 0 of 5 runs completing to 5 of 5, `HPI_accuracy` from 0.5 to 1.0, and a
fresh 5-run measurement of that flow added **zero** escalations where the
previous one added five. Numbers and the two rules that could not see it are in
`docs/BENCHMARKS.md`. The refusal itself was never the bug: ambiguity should
escalate rather than guess, and it still does — what was wrong sat upstream of
the decision, in the element list the decision was made from.

**Then Phase 11 (adaptive waiting)**, on evidence the escalation log cannot
see: `HPI_time` is 0.475 — the agent takes about twice a human's time — at
`step_ratio` 1.0, so the cost is per step rather than in extra steps, and the
Settings flow's IQR is a third of its own median. Variable per-step cost with
nothing wasted on wandering is the shape of a timeout being waited out. No
escalation blames waiting, which is precisely why this phase is scored on two
numbers and not one.

One caveat on this breakdown, stated because it bounds every conclusion above:
two flows on Apple's own apps, one device, one afternoon. The reason
distribution from a third-party app with poorer labelling will not look like
this.

## The log cannot say who wrote a line — 2026-09-09, after Phase 11 step 4

The breakdown above bounds itself with "one device, one afternoon". It needs a
second bound, found the hard way on the same device the same evening.

`escalations.jsonl` is per-UDID, and a record carries `flow_id`, `step_index`,
`screen_fingerprint` and `reason` — nothing that says which *session* produced
it. Two Claude sessions with the simframe MCP server attached to one booted
simulator therefore write into one log, interleaved, indistinguishably. That
happened here: the bench device's log went from 57 to 81 entries across an
evening in which a second session was driving the same device, and a third of
the new entries name screens from an app the suite has never launched.

The consequence is not a corrupted file, it is a corrupted instrument. CLAUDE.md
says this log is the steering wheel and that its reason breakdown decides which
faculty is built next. A breakdown that silently pools two sessions' work
answers a question nobody asked — and it errs toward whichever session made
more mistakes, which is not the same as whichever faculty is most missing.

So: **the reason breakdown is only trustworthy on a device one session owns**,
and the numbers above were collected under that condition while the ones from
this evening were not. The fix is small and worth doing before the next
breakdown is used to choose a phase — a session id and the flow's own name on
each record, so a breakdown can be taken per session, per flow, or pooled *on
purpose*. `flowRecordFrom` already carries `flowName`; the escalation record
does not.

Reading the same fact the other way: a shared device is the normal case, not
the pathological one. Three MCP servers were attached to this machine's
simulator while this was written, which is what a person with several agents
open looks like. An instrument that only works when nothing else is running is
an instrument with a precondition nobody will remember to check.

## Fixed: a record now says which agent wrote it — 2026-09-10

The instrument described above is repaired. Every escalation record now carries
`session_id` — the process start, its pid and a random tail, computed once per
process — and `client`, which is one of `mcp`, `cli`, `script` or `library`.
Flow refusals carry `flow_name` too, and a `goto` refusal names its
destination, because "this agent could not route to Settings" and "this flow
failed" are different rows in the same column.

`simframe escalations` gained three things:

- `--session` narrows to this process, `--session=<id>` to one, `--flow=<name>`
  to one flow. `total` and every rate derived from it describe the narrowed set,
  model turns included.
- A **warning before the counts**, not after, whenever the breakdown might be
  pooling more than one agent's work — either several sessions or any records
  written before sessions were logged.
- A faculty marked `[built]` reads differently. Phase 11 shipped, so
  `verification_failed` no longer maps to something unwritten: those 34 records
  are not a queue waiting on a phase, they are evidence the phase that shipped
  is not sufficient. The line says `not removed by: sense of time (Phase 11)
  [built]` rather than `would be removed by`.

What is deliberately not recorded: no device id, no username, nothing about the
machine. The question this has to answer is "was this all one agent", and that
needs no identity to answer.

The 92 records already in the bench device's log stay unattributable, and the
breakdown says so every time it prints them rather than quietly averaging them.
The Phase 10 breakdown above was collected on a device one session owned and is
still good; anything measured on that device between then and now is a pool.

## Phase 11.5 — thinking cost baseline, 2026-09-10

From `flows.jsonl`, separating the real session driving a third-party app from
the bench device, because only the first has a model in the loop. 62 real calls,
179 steps.

| | real session | bench (scripted) |
|---|---|---|
| flow records (= MCP calls) | **62** | 254 |
| steps | 179 | 657 |
| `model_turns` / step | 0.56 | 0.58 |
| single-step calls | 10 (16%) | 46 (18%) |
| batched calls | 52 (84%) | 208 (81%) |
| median batch | **3 steps** | 3 steps |
| images returned | **29, in 28 of 62 calls** | 0 |

### The stated hypothesis is not what the data says

Phase 11.5's prompt says "if turns/step is near 1.0 on flows the graph already
knows, that is the bug this phase fixes". It is **0.56**, and 84% of calls are
already batched. The model is not calling one step at a time.

What it is doing is planning *three steps ahead*: 48 of 62 calls are three steps
or fewer, and only 11 are five or more. So the cost is not un-batched calls, it
is **short batches** — a flow of a dozen steps arrives as four or five calls
instead of one, and each boundary is a think.

### The larger cost is images, and the reason is known

**28 of 62 calls (45%) returned an image.** At roughly 1.6k tokens each that is
~46k tokens against ~87k for all the text results put together — a third of the
session's tool output, spent on the one call the text map exists to avoid.

The reporter said exactly why, and it was not a preference: *"because the map
cannot be trusted, every verification becomes a `{"look": true}` image."* The map
could not report a text field's contents at all — the accessibility `value` was
read by the daemon and dropped at two boundaries. That shipped this morning, so
the largest single driver of image cost has already been removed; this phase has
to make the model *notice*.

### And what the model was reading

| verdict | count |
|---|---|
| `unverified` | 43 |
| `no-visible-change` | 25 |
| `ok` | **6** |

Six `ok` verdicts in 179 steps. On an app the graph had never seen, almost
nothing was predicted, so almost every step returned something the model had to
interpret. 35 of the 39 escalations were `verification_failed`, and 14 of 62
calls (23%) did not complete — each of those forces a re-plan, which is the most
expensive thing that can happen to a batch.

### What this phase can and cannot move

It can shorten what a turn carries and make longer batches the obvious path. It
cannot manufacture `ok` verdicts on an app nobody has driven before — that is
the graph warming up, and it is Phase 12–16 work. So the number to watch is
**calls per completed task**, not turns per step.
