# Handoff — 2026-09-18

## The queue, in priority order

Work these top down. Each line says why it is where it is and where the detail
lives. Everything below this section is history, kept for its reasoning.

**0. [OWNER, not the agent] Record the human HPI baseline.** Blocks every HPI
number in the repo. The committed `docs/research/hpi-baseline.json` is invalid:
half its time comes from `contacts-kate-bell`, which has `completed: 0`. An
agent cannot do this — if simframe drives it, HPI is simframe measured against
itself. Runbook at the end of this section.

**1. The fast failure (iOS).** 5 of 9 bench runs: `tap Accessibility` verified
`ok` while the screen stayed on Settings root. Not the device. It is the failure
a user hits, and every hard-fail that drops a caller back to single-stepping is
a latency bug. One hypothesis already falsified — it is *not* "the app has not
rendered", `launch` returns with 15-17 elements in the tree. The corrected
experiment is written up in DEFERRED 173: hold elapsed time constant and vary
only whether the tap resolves from memory or from a fresh read. Do not repeat
the delay A/B; it invalidated itself by inserting a fresh read into every arm.

**2. Item 174 — screen identity fragments on content-driven screens.** The
escalation log now nominates it independently: `unexpected-screen` is the only
verdict in 1022 records that names a faculty. It also blocks `saveFlow` on the
screens where it misfires, so it throttles the zero-model-call path as well as
costing batches. Start with the supervisor ruling, not a threshold — DEFERRED
174 says why both obvious fixes are wrong.

**3. Item 183 follow-up — why does an app launch restore a silent tree?** One
observation is not causation. The cheap test: revive, wait the same interval
without launching anything, read again. If time alone does it, `revive` needs
patience; if a launch is required, `revive` should do one.

**4. Item 173's cheap remedy.** It is a *transient* SpringBoard crash, so wait
for the shell and retry the launch instead of a ~40 s device restart. Never
tried, because the old "persistent wedge" framing made it look pointless.

**5. Web: the batching experiment (no code).** See `docs/DECISIONS.md` —
`web.js` is deferred pending one measurement. Batching lives above the platform
boundary and is the largest untested term; a peer batching aggressively and
reporting `n` decides whether the backend is worth two days.

**6. Item 179 — a data-creating flow can never replay cleanly**, so the
confirmation path is closed to most flows worth recording. Design question, not
a bug fix: a recorded assert should check the *delta* it caused, not the end
state.

**7. Item 178 — `sim_find` returns a static label as a "field".** Cheap and
well-targeted, but record a fixture first: a hard type filter breaks OCR-only
WebView screens.

**8. The rest** — 170, 181, 182, and the perception group (153, 155, 156, 162,
163).

### The number none of this has moved

`steps_per_call` is **1.5-2.0** and the vision needs 8-10. Two releases, a
diagnostic instrument, a fixed steering wheel, a corrected latency model and a
CDP client all shipped without touching it. That was defensible while the
instruments were untrustworthy. It stops being defensible now. **Items 1 and 2
are the ones that move it** — prefer them over anything that merely measures
better.

### Runbook for item 0, so it is five minutes and not a project

```bash
simframe diagnose --device=326464A4-331E-47A3-A90F-6A2E85BCEE18   # must say healthy
simframe baseline record contacts-kate-bell   --device=326464A4-331E-47A3-A90F-6A2E85BCEE18 --runs=5
simframe baseline summarize contacts-kate-bell
simframe baseline record settings-larger-text --device=326464A4-331E-47A3-A90F-6A2E85BCEE18 --runs=5
simframe baseline summarize settings-larger-text
simframe baseline list
```

The flows, as a person performs them (from `flows/hpi-suite.json`):

- **contacts-kate-bell** — tap Contacts on the home screen, tap Kate Bell, stop.
- **settings-larger-text** — tap Settings, tap Accessibility, tap Display & Text
  Size, tap Larger Text, stop.

N>=5 because it refuses under 3, and a median of two numbers is one of the two.
Re-record when the app changes. The device wedges every few dozen launches —
`simframe revive` between flows if `diagnose` stops saying `healthy`.

---


> **0.18.0 — start here. Everything below this block predates it.**
>
> Published and verified: `release` green via OIDC, npm `latest` = 0.18.0,
> `check-published.mjs 0.18.0` **87/87 identical** to the tree, pre-tag diff
> empty, all three `test` jobs and `integration (memory)` green on the release
> commit.
>
> **Three items were worked and the first one changed its own definition.**
>
> **173 is a transient crash, not a persistent wedge.** The 69 s bench failure
> was `The system shell (SpringBoard:58637) probably crashed`; a device read
> taken seconds later said `healthy`, fusion 0.857. It dies, the launch fails,
> it comes back. That is why a dozen occurrences produced no observation, and it
> means `revive` — a ~40 s restart — is a heavy cure for something that
> self-heals. **Waiting for the shell and retrying the launch has never been
> tried and is the obvious next thing.**
>
> **`simframe diagnose` is the instrument that settled it**, and the CI guard
> now runs it *before* it revives — the guard used to power-cycle the device the
> moment it recognised a wedge, destroying the only evidence. Verdicts:
> `capture-down`, `nothing-readable`, `stale-frame`, `not-presenting`,
> `healthy`. `not-presenting` deliberately refuses to say *why*.
>
> **The escalation log can finally name a faculty.** It had 20 read reasons out
> of 1022 (723 legacy, 279 assumed). `FACULTY` was keyed on the reason, so every
> `verification_failed` pointed at "sense of time (Phase 11)" — but the class
> holds 163 `no-visible-change`, 26 `unexpected-screen` (= item 174) and **51
> records that were the device, not the code**. Split by verdict now, with the
> device pulled out. `no-visible-change` is deliberately left unnamed: two
> causes wear it and the site already had the measured argument.
>
> **`HPI_accuracy` was counting SpringBoard's crashes as simframe's errors** —
> 5 of 17 runs. Device-caused runs leave the denominator. This is item 172's
> fault in the other column, and it had been fixed there and left standing here.
>
> **The latency model was missing a term**, and this one came from measurement
> rather than argument: a cold app launch is a **fixed cost amortised over the
> route**, not a per-step one. With zero model calls the agent is 2.9x a human
> on a 2-step route (6.2 s/step) and 2.0x on a 4-step one. So
> `per step = (round trip + launch + ~1.7s × n) / n`, and `~1.7 s` describes
> *warm taps inside a batch* only. Short routes are much worse than any table
> previously implied. `step_ratio` was **1** throughout — no wandering.
>
> **The open thread: the fast failure.** 5 of 9 `settings-larger-text` runs had
> `tap Accessibility` verified `ok` while the screen stayed on Settings root.
> Not the device. One hypothesis falsified (it is **not** "rendered yet?" —
> `launch` returns with 15-17 elements already in the tree), and one experiment
> invalidated by its own apparatus: every arm inserted a fresh read between
> launch and tap, which is exactly the variable under suspicion, and the failure
> vanished. Evidence now points at **memory-vs-fresh resolution**, which cuts
> against the obvious "wait longer" fix. Corrected design is written up in 173.
>
> **What did not move: `steps_per_call`, still 1.5-2.0.** This release makes the
> instruments trustworthy; it does not make the tool faster. The number the
> vision depends on is untouched.
>
> **Read this block first; the rest of the file was written before the third
> field report landed.**
>
> **A third peer tested 0.16.0 and found a silent success in the feature 0.16.0
> shipped for.** Both flows they saved were marked confirmed on disk and both
> were confirmed by replays that *failed*. `saveFlow` and `runFlow` both asked
> `ranSteps >= steps.length`, and `ranSteps` counts steps **attempted** — a
> failing step stops the batch, so a failure on the *last* step reads as a
> complete run. Fixed in `25ecfe0`, in all three places it lived, with the
> negative case added to `ci-memory`. Item **176**.
>
> **Both fixes below were found broken again by running them on a device after
> the unit suite was green** — `optional` was a no-op on every screen it was
> built for (the tag it keyed on is chosen by whether the *screen* was
> recognised, not whether the *target* was found), and the start-screen note
> fired on most correct replays because most flows open with a `launch`. Neither
> was caught by a test; both tests passed because their fixtures were invented
> to match the assumption rather than taken from what the throw sites produce.
> **Run new behaviour on `326464A4` before believing a green suite.**
>
> Also fixed there: `"optional": true` on a step (**177**) — six correct steps
> were being discarded because a first-launch sheet did *not* appear, so no flow
> crossing an interstitial could be batched at all; `startScreen`, which every
> 0.16.0 flow recorded as `null`; the malformed `(unverified, unverified, )`
> refusal; and `hpi --help`.
>
> **Open and filed: 178–182.** 178 (`sim_find` returns a static label as a
> "field") is the best return-per-line and deliberately *not* done — a hard type
> filter breaks OCR-only WebView screens, so it wants a fixture first. 179 is
> structural and pairs with 176: a flow that creates data can never replay
> cleanly, so the confirmation path is closed to most flows worth recording —
> **the two were hiding each other**, and fixing 176 alone makes the confirm
> rate collapse, which is the honest number.
>
> **CI is red on `main` and on the `v0.16.0` tag**, and it is not this work.
> `integration (fingerprint)` fails with *"a launched app never came to the
> front (the screen shows a clock and nothing else)"* — item 171 inside item
> 173. `bench` on the tag was **cancelled**, so it produced nothing: not an
> abstention, not a gate, nothing. HPI still has no hosted-runner reading.
>
> **One claim in this repo is weaker than it reads, including where I wrote it.**
> The peer who measured 1.82 s/step ran on **`326464A4`, this laptop's own bench
> device**, from this working tree, with `CLAUDE.md` and this file in context.
> Their report says *"on a machine that is not yours"*; it is false, and it went
> into BENCHMARKS and the article before anyone compared it to the UDID four
> lines above it. Corrected. What the reading is worth: a different app and an
> external stopwatch. What it is not: off-host. **The parity number has been
> measured three times, on one laptop, never by a stranger** — and same-host is
> the objection that bites, since identical code spans 0.406–0.558 across device
> conditions on this machine alone. One replay on hardware this project has
> never touched would settle it. Five minutes. Not run.
>
> **Two framings in this repo were too generous, and the owner corrected both.**
> First, and it took three passes to state correctly: **a human's 1.95 s per step
> is perceive + decide + act.** Two rows of this project's headline table do not
> include a decision and were being set against it anyway. The 1.7 s is simframe
> with the deciding removed — the deciding *is* the round trip. And a replay
> decides nothing at all; its honest counterpart is a person repeating a
> memorised flow, who would be well under 1.95 s, so "replay is at human
> latency" compares a rehearsal to a first attempt. **The one like-for-like
> comparison is 1.95 s against ~11.7 s: about 6x a human, ~11x when a hard-fail
> forces a call per step.** The tables in the README, BENCHMARKS and the article
> now carry a `decides` column for exactly this reason. What the 1.7 s figure
> *does* establish is the finding that reordered the project: beside a 20 s round
> trip there is nothing left to win inside the engine. Second: **accuracy is the neglected half.** `HPI_accuracy` reads 0.483
> over 151 runs with 78 not clean, against a baseline that is itself invalid
> (`contacts-kate-bell` has `completed: 0`) on a device the suite keeps wedging.
> Speed has had three days of attention; precision has had none.
>
> **The defect rate has not saturated, and that is a planning input.** Every
> field round so far — 0.13.0, two on 0.14.1, 0.15.0, 0.15.1, 0.16.0 — has
> opened **at least one major defect plus several smaller ones**, and the 0.16.0
> round found a silent success in the feature shipped the previous day. A tool
> whose discovery rate is still one-major-per-session is not near stable, and
> **the next field round is worth more than the next phase**. Phases 13 and 14
> optimise simframe's own 1.7 s, which is already below human and is a minority
> of the clock; on the arithmetic they buy single-digit percentages. Read
> `docs/ESCALATIONS.md` and run a round instead.
>
> **The one idea worth carrying forward.** That CI line is the same fault the
> peer hit on a laptop, where `sim_look` served them a frame from a *previous
> session* while the element map correctly described the app in front of them.
> 171, 173, 180 and possibly 175 look like **one cause wearing four faces**: the
> capture surface dies, the framebuffer keeps serving a stale frame, and the
> tree stays right. If the overlap warning is computed from a11y-vs-OCR
> disagreement, its 78% false-positive rate may be *measuring stale capture*.
> The experiment is cheap — correlate frame staleness with overlap warnings over
> the existing bench runs — and it must come before anyone touches the
> heuristic. Working these as four flaky symptoms is how they have survived.

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

- **`bench` on the v0.16.0 tag was read: it was CANCELLED** (run
  `35157973651`), so it produced nothing at all — less than the abstention this
  line predicted. The same run's `integration (fingerprint)` failed, and so did
  the one on `main` after it. See the block at the top of this file.
- **0.17.0 is published and verified** (2026-09-17). `release` green via OIDC,
  npm `latest` = 0.17.0, `check-published.mjs 0.17.0` 85/85 identical, pre-tag
  diff empty. Minor rather than patch because `"optional": true` is new
  functionality, not only a fix.

  It shipped with `integration (fingerprint)` **red**, deliberately and with the
  owner's decision: the failure is the device wedge (171 inside 173) and it
  fails identically on `main` and on the `v0.16.0` tag, i.e. it predates this
  work. **`bench` does not run on this path, so 0.17.0 carries no HPI
  measurement** — the same as every release since item 148.
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
