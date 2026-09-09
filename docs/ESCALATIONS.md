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
changes, so it is not done here. Do it before Phase 11.

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
