# Handoff — 2026-09-17

**0.16.0 is published and verified.** npm `latest`, 85/85 files identical to the
tree (`node scripts/check-published.mjs 0.16.0`), release green via OIDC, and the
pre-tag diff was clean. `origin/main` at `f730eed`, nothing held locally. Gates:
215/215 tests, check-package, check-private (205 files), the article projection.

**Start here: item 174.** It is the largest remaining cost on a first traversal
and both obvious fixes are wrong. See below — the reasoning is worth reading
before touching it.

## Today in one line

Two field reports on the same flow, and the whole session turned out to be about
one number nobody had measured: **model round trips are ~60% of wall clock and
simframe is ~34%**. The engine has been faster than the human it is measured
against for a while.

## The arithmetic that reordered everything

```
per-step wall clock = (model round trip + 1.7s × n) / n      for n steps per call
```

| | per step |
| --- | --- |
| a human tester, measured | **1.95 s** |
| **a saved flow replayed — zero model calls** | **1.98 s** |
| simframe's own work inside a batch | ~1.7 s |
| a batch of 4, one model call | ~6.7 s |
| a batch of 2 — the recorded median | ~11.7 s |
| one model call per step | ~21.7 s |

So there is **nothing left to win inside the engine** and the only variable is
`n`. `simframe hpi` now prints `steps_per_call`, which was in the log the whole
time — every run records `steps_taken` and `model_turns` and nothing divided
them. Median 2.0, p25 1.0, and **that p25 tail is recovery**.

Which is the frame to keep: **every hard-fail that drops a caller back to
single-stepping is a latency bug**, worth more as "the batch kept going" than as
"the error message was better". Between the two reports the same flow went from
**33 tool calls to 16** — defects fixed, not code made faster.

## Shipped in 0.16.0

- **Flows can be recorded at all** (3.9, and it was the priority). `saveFlow`
  refused any non-`ok` verdict and a first traversal is all-`unverified` *by
  construction* — so nothing could ever be saved, so replay was unreachable, so
  the only zero-model-call path was sealed. Now: provisional on first traversal,
  confirmed by one clean replay. `unexpected-*` still refuses, and so does a run
  that did not reach its last step.
- **`sweep` accepts identifiers** — the *third* report of one assumption (152,
  `ee305d4`, and `sweep`'s own matcher in three places). Now one function.
- **A swept fill carries its read-back verdict** instead of printing `filled "X"`
  over an empty field.
- **Short values type instead of pasting** (≤40 chars), so iOS 26's paste-consent
  alert never fires. `sim_type_into` always defaulted to the keyboard; only
  `sweep` pasted unconditionally.
- **A distinctive fragment resolves** — `8471502` inside `Record #8471502` scored
  0.287 against a 0.45 floor. Promoted only when nothing reached the floor and
  exactly one element contains it, so the "back" case is untouched.
- **`waitFor` holds while a screen is still filling in**, using `stillFillingIn`,
  which was already wired only to a note the model paid a round trip to act on.
- **`stillOnPlan` settles before giving up** — it was asking its rescuing
  question at the only moment guaranteed to answer no.
- **A `supervise` brief with no supervisor enabled says so.** Both reports passed
  one on every call and never saw a verdict.

## NEXT: 174 — screen identity fragments on content-driven screens

`unexpected-screen` fires on steps that did exactly the right thing, and because
a failed step discards its batch, one instance killed a **7-step plan at step
5** — a submit already paid for in model latency never ran. Same root produced
"memory disagrees with this screen" on four screens.

**Do not do the thing that was asked for.** Making `unexpected-screen` non-fatal
trades a wrong tap for a saved round trip exactly where CLAUDE.md's verify
barrier says not to.

**And do not reach for a threshold.** `sameScreen` already passes tokens.
Lowering `SIMILARITY_THRESHOLD` is unavailable — the fingerprint eval puts
same-screen revisits at ≥0.63 and different screens at ≤0.08 on static screens.

**And chrome-anchoring does not work as stated**: every step of that wizard
shares its nav title, so chrome alone collapses steps 1–4 into one screen — and
one of the false alarms was a step correctly *advancing* between two of them.

**The tractable half:** the supervisor is the escape hatch the barrier already
names ("when in doubt, escalate") and `unexpected-screen` does not consult it.
That was unavailable in both runs for a separate reason, now fixed. Wiring the
verdict to a ruling keeps the barrier and removes the false abort without
touching screen identity.

## 175 — a change that was announced and then cancelled. Do not rebuild it.

One reporter asked that a tap be refused when its point lands inside an element
flagged as an overlap: *"the information is already computed, it just isn't wired
to the tap decision."* Good instinct, and it would have been a serious mistake.
The next report **measured the signal**: it fires on **7 of 9 screens**,
including screens with no sheet, was never once actionable, and they started
skipping it. Gating taps on a ~78% false-positive signal means constant false
refusals at ~20 s each — a latency regression dressed as safety. **The warning is
the defect, not the tap.**

Two reports, opposite conclusions, and only the second one counted anything.

## Still open, roughly in order

- **170** — a CLI dying with empty stdout is still classified as a check failure;
  `jsonRetry` still discards the stderr that would name the cause.
- **171** — an app frontmost by pid while the display renders a clock. Separable
  only because 169 landed.
- **173** — the bench suite wedges the device it measures, so **HPI has never
  been measured on a hosted runner**. The trustworthy reading is the local one in
  BENCHMARKS. Worth trying: a revive between passes, and one flow per job.
- **153, 155, 156, 162, 163** — the perception and input defects.
- **The escalation log has ~1000 entries** on the bench device
  (`verification_failed` 551, `ambiguous_intent` 207, `unknown_screen` 167,
  `no_plan` 73). CLAUDE.md makes that breakdown decide what gets built next, and
  it has been accumulating while CI was chased. That is where to look for a
  *direction* rather than a defect queue.

## Unfinished business

- **`bench` on the v0.16.0 tag was still running at compact** (run
  `35157973651`). Read it. Expect it to abstain — 173 — and if it does, that is
  *not* a passing gate and must not be reported as one.
- **The replay measurement has now been skipped by two peers in a row.** It is
  §3 of the peer prompt, numbered, with a stopwatch, and it is the one number
  that demonstrates human parity outside this machine. Insist on it.

## The lesson this session kept re-teaching

**A rule enforced where you noticed it covers a symptom.** Three times today:

- `refresh: attempt > 0` was forbidden by a test that only ever read
  `actions.js`; the identical defect sat in `baseline.js` and broke every HPI
  reset. The assertion now sweeps all of `src/`.
- Identifiers were added to `matching.rank` (152) and to the `Visible:` list, and
  `sweep` kept its own label-only matcher in **three** places.
- I replaced the flow-save contract, updated the unit test, and left
  `scripts/ci-memory.mjs` asserting the old rule. CI caught it.

And its cousin: **a check that cannot fail is worse than no check.** My
replacement for that integration assertion read `provisional` off a listing that
did not return it, so it would have passed either way.

## Standing rules

- **No client or third-party project name in this repo, ever.** Field reports
  carry them; strip before anything lands. A production record number and an
  app's own row text got into a test file today and had to be cleaned, which also
  removed a person's name an earlier report had left behind.
- Do not rewrite git history without an explicit, specific instruction.
- Never `git add -A` without looking. Verify checks separately, never chained
  with `&&`.
- Release files only when the task is explicitly a release or a fix to the
  release path — say what and why first. `npm version` is the only way to bump.
- **If CI failed, don't publish.** "Cancelled" is not "failed" — say which.
- **Always diff before tagging** (`git diff <tag> --stat` empty). Two releases in
  this series were tagged at stale commits.
- Docs, article and README current **before** a push and release, numbers
  included. The article is generated from
  `docs/agents-shouldnt-blink.html` — edit the HTML, then
  `node scripts/article-md.mjs`.
- `cancel-in-progress` is keyed on **event + ref**.
- **`gh` needs `GH_CONFIG_DIR=~/.config/gh-personal`** here. An error telling you
  to `gh auth login` means that, not auth.

## State of the machine

- Bench device `326464A4` (iPhone 17 Pro, iOS 26.5) — the HPI benchmark device.
  Wedged four times today by the bench suite; `simframe revive` cures it.
- `B55AB0AE` was booted by a peer during their run. **Not ours.** `7B8F8963`
  belongs to another of the owner's projects. Always pass `--device`.
- Five other MCP sessions hold that device. `simframe stop` will say
  *"left 1 in use by another client"* — do **not** `--force` it, and do not
  redirect that command's output, which is how three builds got tested against a
  daemon that had never restarted.
- Port 8081 is someone else's Metro. Do not kill it.
