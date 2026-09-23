# Handoff — 2026-09-21

## The queue, in priority order

Work these top down. Each line says why it is where it is and where the detail
lives. Everything below this section is history, kept for its reasoning.

**Before you take any of this on trust: count it.** The 09-21 session re-counted
the escalation log before starting item 1 and the item's headline claim turned
out to be false. Four commands, one sentence of the plan changed, none of the
work. That is now three phase premises in a row that did not survive being
counted. `docs/ESCALATIONS.md` has the current breakdown.

**0. ~~[OWNER] Record the human HPI baseline.~~ DONE, and it was never the
owner's to do.** The human baseline has existed since 2026-09-09, `N=5` on both
flows — `settings-larger-text` p50 **7799 ms** (4 steps), `contacts-kate-bell`
p50 **4300 ms**. What put it on the owner's desk was a misread: `completed: 0`
is a field on the **agent** block of `docs/research/hpi-baseline.json`, not the
human one. One field read off the wrong half of a file held a twenty-minute task
open for nine days. **Read the file before filing the task.**

**Correction to this line's own previous version.** It used to say the agent
half was "re-recorded 2026-09-18". It was not. That re-record aborted mid-pass
and was deliberately reverted — see `b207a28` and items 188/189. **The committed
reference in `docs/research/hpi-baseline.json` is still the invalid 2026-09-09
one**, and a session that trusts the old sentence will report HPI numbers
against a reference built from runs that never finished. The human half is
sound and needs nothing.

**1. `main`'s CI is red on two real code failures, and this file used to say it
was flake.** Audited 2026-09-23. `integration (memory)` has failed every run
since `f8b0b6a` and the job itself prints *"this step failed on its merits, not
on the device"*. Details and the exact output are in **Repo state** at the
bottom — read that before anything else, because the previous version of this
queue was written on the assumption those runs were noise.

**Half of it is closed (2026-09-23), and it was neither of the two faults this
line predicted.** The `provisional=undefined` failure had nothing to do with
item 176 and the entry was not gone: the flow was confirmed before the replay
even ran. The `provisional=true` in the log came from the first save attempt;
the `--force` save is another traversal of a loop the graph has already
learned, so it saves confirmed. On the bench device the runs went
true → false → false. The check asserted a precondition it never set up. The
fix is in the harness, not the product: it reads whether the flow was
provisional before the replay, prints why a replay stopped, and reports
`NOT TESTED` when there is nothing to promote. DEFERRED 176 has the addendum.
One more finding: **CI has never actually tested promotion end to end.** The
positive check passed on flows that were never provisional. That is still open.

Note on the "one-word" fix: `?? 'gone'` would have been the wrong word. It
prints "gone" for an entry that exists without the field, which is exactly the
case in question. The harness now uses `entry ? entry.provisional : 'gone'`.

**What remains of item 1 is item 174's open half**: `staleKind:
"unknown-screen"` on "Welcome to Reminders" at `ci-memory.mjs:395`. It hit the
memory shard at `f8b0b6a` and in scheduled run `35610506147`. The fingerprint
shard in that same scheduled run also failed: *"settings" never arrived*, with
the home screen still up after 8 s. Not yet read.

**2. Item 186's open half — 41% of recent device losses are still counted
against the code.** Promoted to the top, and it was measured on 09-21 rather
than argued: of 46 `could not launch` records in the last four days — every one
on the bench device, every one `The system shell (SpringBoard:NNNNN) probably
crashed` — **19 still carry `device_cause: null`**. `HPI_accuracy` is the one
number CI gates on, and it is currently being charged for the test rig's
crashes. The missing *signature* half is fixed; this half needs the throw path
out of `launch` traced, so a run lost to a recognised device death writes an
escalation carrying its cause.

It is high because it is the cheapest thing that makes every later measurement
mean what it says. Items 3 and 4 are unmeasurable until it lands.

**3. Item 189 — the device degrades *within* a pass.** The between-pass revive
is attached to the wrong boundary: a pass is 10 runs against a device that
tolerates 8-10, so the damage lands inside a pass more often than at its edge.
Pass 2 of the 09-18 re-record started `healthy` and collapsed three runs in.

**~~Item 187, the cooldown — [OWNER DECISION].~~ There was no decision. It was
made and shipped on 2026-09-18 in `8c5a189`, the same commit that measured it:
default 1500 -> 4000 ms, with `BENCHMARKS.md` recording which side of the line
each number is from.** DEFERRED 187 went on saying "not yet acted on" for three
days, and the 09-21 version of this queue promoted that sentence into a call
waiting on the owner — who then, reasonably, asked what they were being asked
to decide. **Nobody re-read the commit that the item's own table came from.**
Raising it also turned out not to be sufficient, which is why what survives of
187 is item 189 above.

**4. Re-record the agent half of the HPI reference**, once items 2 and 3 are
done, and not before — item 188 first, because `--out` currently writes the file
even on a run that has just printed "must not be adopted as a baseline". The
runbook below is still correct for the mechanics.

**5. Item 174's remaining half — screen identity itself.** The false abort is
closed (see the 09-21 block); the graph still holds two nodes for one logical
screen on content-driven screens, and that is the part with no obvious fix.
DEFERRED 174 says why both tempting ones are wrong: the similarity threshold
cannot be lowered without collapsing genuinely different screens, and chrome
anchoring merges the wizard steps it is supposed to distinguish. Do not start
here without a fixture — this is perception work, and a live page costs 60 s a
look and confounds the result.

**6. Item 185 — `diagnose` asserts "the daemon is stuck attaching" for a device
that has no display port**, a cause `simctl` names in one sentence. Cheap, and
it is the instrument items 173 and 1 depend on being honest.

**7. Web: the batching experiment (no code).** See `docs/DECISIONS.md` —
`web.js` is deferred pending one measurement. Batching lives above the platform
boundary and is the largest untested term; a peer batching aggressively and
reporting `n` decides whether the backend is worth two days.

**8. Item 179 — a data-creating flow can never replay cleanly**, so the
confirmation path is closed to most flows worth recording. Design question, not
a bug fix: a recorded assert should check the *delta* it caused, not the end
state.

**9. Item 178 — `sim_find` returns a static label as a "field".** Cheap and
well-targeted, but record a fixture first: a hard type filter breaks OCR-only
WebView screens.

**10. The rest** — 170, 181, 182, and the perception group (153, 155, 156, 162,
163).

### The number none of this has moved

`steps_per_call` is **1.5-2.0** and the vision needs 8-10. Two releases, a
diagnostic instrument, a fixed steering wheel, a corrected latency model and a
CDP client all shipped without touching it.

09-18 moved something adjacent: a four-step flow that completed 1 time in 9 now
completes 8 in 8, and every completion is a batch that did not hand control
back. 09-21 removed one class of batch abort. Neither has been re-measured
against a real session, and **`steps_per_call` is still the number to beat.**

### What the log is currently measuring, which is not what you want

Counted 2026-09-21, corpus now 1,261 records. The last four days are **46
`could not launch` records out of 124 `verification_failed`** — all on the bench
device, all SpringBoard crashes. CLAUDE.md makes the reason breakdown decide
which faculty gets built next; right now that breakdown is mostly reading a
broken test rig. This is why item 1 is item 1. Full table in
`docs/ESCALATIONS.md`.

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

> **2026-09-21 — one class of batch abort closed, and the steering wheel was
> found pointing at the test rig. Everything below this block predates it.**
>
> **A wrong turn was one read, and the read was taken of a screen still
> arriving.** `unexpected-screen` halts a batch and discards every step after
> it. The reported defect was that it is *non-deterministic* — a reporter
> re-issued the identical call with no state change and it passed — and a gate
> that fails once and passes on retry is flaky, not protective.
> `confirmWrongTurn` in `actions.js` is the sibling of `confirmNoChange`, for
> the more expensive of the two mistakes: settle, read again, re-run the
> verdict. An agreeing second read changes nothing and the halt stands on two
> reads; any other second read replaces the verdict and keeps both answers in
> `disagreed`. The graph learns from the confirmed reading via the existing
> `lateArrival` contract.
>
> **It keeps the verify barrier rather than softening it**, which is what the
> original request — make the verdict non-fatal — would have done. A halt on
> one premature read is not confirmed perception either, so both directions pay
> for a second look now.
>
> **Deliberately not gated on a supervisor**, which is what the item proposed.
> `doctor` reports `local supervisor: none — not requested` on a default
> install, so a ruling-based fix would have meant "fixed for callers who opted
> in". A second read needs no model and no opt-in.
>
> **Not demonstrated end to end, and this is the honest limit of it.** There is
> no offline harness that can drive `runScript` against a fake device — the
> `fake` platform in the tests is a surface-conformance check, not a driveable
> one — so the decision was split into a pure exported function
> (`afterSecondLook`) and tested as one, and only the read half is asserted
> against its own source text. **Nobody has watched this fire on a device.**
> First person with the bench device free: run a flow that has an edge seen 2x
> and confirm a `disagreed` field appears rather than a halt.
>
> **DEFERRED 174's headline was wrong and has been corrected.**
> `unexpected-screen` is 32 of 1261 records (2.5%), p50 2814 ms, all failed,
> all one model turn; it peaked at 12 on 09-10 and has run 0-3 a day since the
> 14th. It was never "the largest remaining cost on a first traversal". It is
> still worked first for the reason `ESCALATIONS.md` actually gives — it is the
> only verdict left that *names* a faculty — and not for its frequency.
>
> **The article generator was dropping four blocks of the page**, including the
> colophon's closing paragraph, and the test that exists to catch that could not
> fail: the module wrote `ARTICLE.md` at import time, so the test regenerated
> the file before reading it back and compared the output to itself. The write
> is behind a direct-invocation guard now. `--check` in CI was the only real
> gate the whole time.

---

> **2026-09-18 — the fast failure is fixed, and three device faults were
> measured rather than argued about. Everything below this block predates it.**
>
> **The fast failure was never the tap.** Launch-and-tap in isolation reproduces
> it 0 times in 12, in both arms, including trials that resolved `memory d=0` at
> the exact failing coordinate. It needs the step *after*: at that instant, a
> memory recall says "not on this screen" in **25 ms** and a fresh read finds the
> target in **1.8 s** — 12 for 12, same device, nothing touching it in between.
> The recall keys on the first frame of the push animation, captured 47-124 ms
> *after* the tap, so it is newer than the action and still looks like the screen
> being left; capture is damage-driven so it then goes still, `settledState`
> calls it settled, and `recallNearest` matches it back to the previous screen.
> The destination arrives ~750 ms later.
>
> **The fix is one rule: memory may confirm, never deny.** A recall's miss earns
> one fresh read. The recovery already existed and only ran in `ax-first` sensor
> mode, which is not the default — so the answer had been one branch away from
> every affected call since it was written. `settings-larger-text`: **1 of 9
> before, 8 of 8 after**, `HPI_accuracy 1`, `step_ratio 1`.
>
> **Item 173's cheap remedy works.** A crashed SpringBoard recovered **6 of 6**
> by waiting and launching again, in 5.7-7.9 s, against a ~40 s `revive`. In the
> `launch` step now, bounded, scoped to that one signature, reported. Its limit
> was also observed: the crash that preceded a full device collapse was not
> recovered.
>
> **Item 183 is answered.** A silent accessibility tree does **not** heal with
> time — six reads over 60 s, 0 elements every time — and heals instantly on one
> app launch. `revive` does that launch itself now.
>
> **Two instrument defects found by using them**: `simctl did not return within
> 90s` matched no device signature, so three bench runs counted a dead simulator
> against the code (fixed, and the next run said so out loud); and `diagnose`
> asserts "the daemon is stuck attaching" for a device that simply has no display
> port (item 185, open).
>
> **Read the method note in `docs/DECISIONS.md` before the next experiment.**
> Two experiments on this failure measured the wrong step, and one invalidated
> itself by inserting the variable under test into every arm. The rule that would
> have saved both: establish the smallest vehicle that still reproduces the
> failure before varying anything.

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

## 2026-09-18 in one line

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

## 174 — screen identity (PARTLY FIXED 2026-09-21; see the queue, item 4)

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

**The tractable half — DONE 2026-09-21, and not the way this proposed.** This
said to wire the verdict to a supervisor ruling. The supervisor is off by
default (`doctor`: `local supervisor: none — not requested`), so that fix would
have reached only callers who opted in. What landed instead is a second,
settled read — `confirmWrongTurn`, the sibling of `confirmNoChange` — which
needs no model and no opt-in. The false abort is closed; **screen identity
itself is untouched and is the open half.** Everything above this line about
thresholds and chrome anchoring still applies to it.

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
- **The escalation log is now 1,261 entries** across five devices
  (`verification_failed` 754, `ambiguous_intent` 256, `unknown_screen` 176,
  `no_plan` 75) — re-counted 2026-09-21, and the old numbers in this bullet
  were the bench device alone. CLAUDE.md makes that breakdown decide what gets
  built next, so read `docs/ESCALATIONS.md` for direction rather than counting
  it again from scratch. **It is not currently trustworthy as a faculty signal:
  the last four days are mostly the bench crashing its own device.** Queue item
  1 is what fixes that.

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
- **The replay measurement has now been skipped by two peers in a row**, and the
  sentence that used to be here over-claimed what it buys. It is **not** "the one
  number that demonstrates human parity outside this machine": peers run on this
  laptop and this bench device, so a peer replay is not off-host. What it buys is
  independence from this project's own instrumentation — a different agent, a
  different app, an external stopwatch. Worth having, not worth its own session,
  so as of 2026-09-18 it is **deliverable #1 of the field-round prompt** rather
  than §3 of it. Two peers skipping the same numbered section is a fact about the
  prompt, not about the peers.

- **Off-host parity: PARKED, 2026-09-18, by the owner.** No second machine
  available. The claim stands as measured three times on one laptop and the repo
  says so wherever it appears. Unpark when a second machine or an outside tester
  exists; it is five minutes of their time.

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
  Wedged four times on 2026-09-18 by the bench suite; `simframe revive` cures
  it. It has not been driven since — the 09-21 session was code and docs only,
  so nothing here is a fresh reading of the device.
- `B55AB0AE` was booted by a peer during their run. **Not ours.** `7B8F8963`
  belongs to another of the owner's projects. Always pass `--device`.
- Five other MCP sessions hold that device. `simframe stop` will say
  *"left 1 in use by another client"* — do **not** `--force` it, and do not
  redirect that command's output, which is how three builds got tested against a
  daemon that had never restarted.
- Port 8081 is someone else's Metro. Do not kill it.

## Repo state — 2026-09-23

- `main` is at **`1dcce18`**, local and remote in step, nothing waiting on a
  branch, working tree clean. `v0.18.0` is the last tag; **27 commits on main
  are unreleased.** A phase end is a peer test, not a release — propose a peer
  session, do not publish.
- Local: **226 pass** (`npm test`), `node scripts/article-md.mjs --check` in
  step at 579 lines.

### CI is red on `main`, and it is NOT what this file said it was

The 09-21 version of this section called it "known hosted-runner flakiness and
item 173, not a code regression". **That was wrong, and it was wrong in the
direction that costs most** — it told the next session to ignore a red build.
Read before trusting it again.

`integration (memory)` has failed on every run since `f8b0b6a`, and the job
prints its own verdict on the question:

```
     (this step failed on its merits, not on the device — not retrying)
```

Two *different* real failures, not one flake:

- **`f8b0b6a`** — `#1 cannot be trusted here — refs were numbered 1s ago;
  simframe does not recognise this screen`, `staleKind: "unknown-screen"`,
  `staleLabel: "Welcome to Reminders"`. That is **item 174's open half**, screen
  identity, failing in CI rather than in a field report.
- **`1dcce18`** — `FAIL and a replay that failed does NOT confirm the flow it
  just disproved — ok=false, provisional=undefined`. The flow saved
  `provisional=true` and was listed; after a replay that ran **1 of 2 steps**
  and failed, the second `flow list` reads `undefined`. So the entry lost the
  field, or the entry is gone — **and the check cannot tell you which**, because
  this branch prints `${entry?.provisional}` raw while its sibling five lines up
  prints `?? 'gone'`. `scripts/ci-memory.mjs:704`. Fix that diagnostic first; it
  is one word and it decides which of two bugs this is. Item 176 territory.
  **Resolved 2026-09-23: it was neither.** The flow was confirmed before the
  replay (the forced save is a warm traversal), so the check had no
  precondition. The harness is fixed; see queue item 1 and DEFERRED 176.

The scheduled run `35610506147` also failed **both** shards, so the "shards
alternate" reading in the previous version of this section does not hold either.
What holds is narrower: at least one `integration` shard has failed on every run
since 09-20, so **"wait for CI" is not a usable gate**, and every push since has
gone in with the required check bypassed at the owner's direction.

**Is `54479d9` (item 174's `confirmWrongTurn`) the cause of the newer one?**
Not on the evidence, and do not assume either way. It is inert unless a verdict
is `unexpected-screen`; its effect would push a replay toward *succeeding*, not
failing; and the observed fault is a listing losing a field. But the memory
shard was already red at `f8b0b6a` for a different reason, so that run never
reached this check — **nobody has seen this check pass or fail with item 174's
change isolated.** Cheapest way to settle it: `git stash` nothing, just run
`scripts/ci-memory.mjs` locally against `54479d9^` and `54479d9`.
