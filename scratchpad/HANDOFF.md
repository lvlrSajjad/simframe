# Handoff — 2026-09-14 (evening)

**0.13.0 is released.** npm `latest` and the MCP registry both carry it. Nothing
is held locally. All gates green: 191/191 tests, check-private, check-package,
the article projection.

**CI is GREEN.** Run `34882362300` on `cc8b597`: integration success in 20
minutes, *every* step, plus unit tests on Node 18/20/22. The device guard never
had to revive.

**The `waitFor` fix is proven** — it was the one thing the previous handoff left
unconfirmed. The evidence is in the fingerprint eval of that run: `settings`
read `3800d34aaa` and `settings-general` read `3e158af060`, distinct and stable
across all three rounds. **Rounds 2 and 3 are the ones that count**, because
memory must be warm before it can lie, and that is exactly the collision that
used to let `waitFor "About"` pass on the Settings root. Same-screen similarity
1.00, different-screen max 0.08, gap 0.92 against a 0.36 threshold.

The token-floor demotion was also right: `settings` read 4 tokens after two
reads on all three rounds and the check fired as a **NOTE**. Under the old
version that was a hard failure every single run.

## The day in one line

0.13.0 went out; then two days of red CI turned out to be **three separate
things wearing one costume**, and only one of them was the wedge everyone
assumed.

## What CI was actually failing on

Measured, not assumed: the hosted runner is **~2.5x slower** than this laptop at
identical capture work — capture p50 **21.8 ms** vs **55.4 ms**, p95 41 vs 94.
Everything below follows from that.

| class | runs | status |
| --- | --- | --- |
| `simctl openurl` timing out | 4 | fixed — vehicle changed |
| a wait satisfied by **memory** | 2 | **fixed — the real defect, see below** |
| `simframe start` readiness lie | 1 | fixed (127) |
| settle unsatisfiable on a still screen | 1 | fixed (131) |
| the wedge | **1 in 6** | guard + `revive` (132) |

`356f190` is the proof the first one worked: every integration step passed
except the fingerprint eval, including the two that had failed all week.

## The real defect, and why it hid

`waitFor` resolved its **first** look with `refresh: attempt > 0` — false on
attempt 0 — so the opening attempt asked the *recalled map*, not the screen. A
wait memory can satisfy is not a wait: when recall returns the wrong screen's
map, the target "appears" instantly without ever having been on screen.

That is how `settings-general` read the Settings **root** with its
`waitFor "About"` already passed. **The signature is the round numbers — r2 and
r3, never r1** — because memory must be warm before it can lie.

`assert` was fixed for this exact defect after it cost a reported field session.
`waitFor` was left behind: the fix went to the *symptom that had been reported*
rather than to the class, and the twin sat one function away for weeks.

**Only CI could catch it.** It needs warm memory *and* a colliding screen pair,
and locally those two screens share no tokens at all.

## The wedge: deprioritised, with one lead kept

Of 22 real wedges in one daemon log, classified by the failure immediately
before `both recoveries are spent`:

| | |
| --- | --- |
| `no frame was available from the display` | **21** |
| `the device exposes no active display port` | 1 |
| `the display surface could not be read` | **0** |

**The condition 126 is named after preceded none of them.** The wedge is a
display that reads fine and delivers no frames — a damage callback that stopped
firing, which is the defect EXPERIMENTS entry 5 caught once and never verified a
fix for. That is the lead worth keeping: a soak on *this laptop*, with callback
registrations counted. It reproduces ~15 times a day here and once in six CI
runs, so it is a local problem and not a CI one.

Two claims about the wedge were **withdrawn** today: the "app switch trigger"
(40 controlled rounds, two arms, zero failures) and a "two equal populations"
split that was a grep artifact. Both are recorded in EXPERIMENTS §15.

## My mistakes today, because they were expensive

- **`npm test | tail -3` hid a failing suite.** The last three lines are
  cancelled/skipped/todo/duration; `# fail` sits just above them. I shipped red
  while reading a green-shaped tail. Use `grep -E '^# (tests|pass|fail)'`.
- **I measured three CI vehicles on a wedging device** and drew conclusions from
  all three. `frame --fresh` would have told me in one call. Check device health
  *before* every comparison, not after it fails.
- **A token floor built on a misreading.** I read "4 tokens" as a half-drawn
  screen; the Settings root legitimately reads 4 tokens on a runner — which my
  own comment said one screen above the check. It turned an intermittent failure
  into a deterministic one. Demoted to a note.
- **A tap vehicle that tapped dead space** — `via ocr` on an icon's *label*,
  which is not a hit target.
- Two of those verified green locally first. **The local mirror cannot catch
  what depends on the runner being slower or having warmer memory.**

## The CI vehicle, so nobody tries a sixth

The step asserts only: *a step runs, and capture notices the change.* Rejected:
a frame counter (cannot advance on an idle screen), launching an app already in
front, a top-edge swipe (does not move a bare springboard), a tap on an icon
label (OCR text, not a hit target), a swipe to Spotlight (works once, then you
are in Spotlight).

**What holds is structural: from inside an app, pressing home always changes the
screen.** Setup launches Settings; the asserted action is `button: home` through
simframe's own HID path, no simctl in the measured part. 3 of 3, same two hashes
every run.

## Next, in the owner's agreed order

1. ~~**Item 138**~~ — **DONE** (`f8a68d0`), and it was not where the report
   pointed. The `or` list was reachable all along: a resolution that clears
   nothing throws `unknown_screen`/`ambiguous_intent` and the fallback path
   accepts both. The real defect was upstream — `synonymGroup` fires when the
   query merely *contains* a group word, and the override then set a flat 0.9
   in a branch that runs only `if (base < 0.5)`, i.e. whose whole job is to
   overrule coverage scaling. Third branch to need that lesson; the other two
   carry comments saying they were taught it. Regression-checked on 181 verified
   graph decisions: unchanged. The reporter's fallback half is **left open on
   purpose** — acting on `or` after a no-visible-change takes a *second* action,
   and no-visible-change is a known false negative there (item 4, and toggles).
2. **Item 140 — `sim_storage`.** The field reporter rates it the highest-leverage
   thing in their whole session, and it was not a simframe call: reading the
   app's persisted state proved a bug before the device was even booted.
   *"`sim_ui` says what is drawn, `sim_storage` says what the app believes."*
3. **The operator-knowledge layer** — the three-pass experiment says it is worth
   roughly twice the graph, and it has no phase number.

## Open decisions that are the owner's

- **Should a device-state failure fail the build** after one revive and retry?
  It does now. It matters less than it did, since device state is no longer the
  main cause of red.
- **130** — gating stillness on the daemon's `settled` flag. The caret objection
  is gone (134 measured it: a caret is 2 cells of 4,608, and no longer
  registers). What remains is that a *real* spinner would make settle
  unsatisfiable, which is 123's expensive half.

## State of the machine

- **Our bench device `326464A4` is shut down**; no daemons running.
- **`7B8F8963-98F7-49AC-AA6E-EC1ABF82F351` is booted and is NOT ours** — it
  belongs to one of the owner's other projects. Leave it alone, and always pass
  `--device` explicitly.
- **Port 8081 is held by another Metro** that is not ours. Do not kill it; start
  ours on another port or not at all.
- The testbed carries two deliberate shapes: an unlabelled overflow menu (122)
  and a 120pt spinner that never settles (123/130). At 28pt that spinner settles
  in 247 ms and reproduces the premature settle instead.
- Ollama has `qwen3:8b`, `qwen3:14b`, and a `mistral-small3.1` nobody in this
  project asked for.

## Standing rules

- **No client or third-party project name in this repo, ever** — not the app,
  not the company, not any of the owner's other projects. Verified clean today:
  `git grep -il` returns nothing.
- Do not rewrite git history without an explicit, specific instruction.
- Never `git add -A` without looking first. Verify checks separately, never
  chained with `&&`.
- Release files (`server.json`, versions, the workflow) only when the task is
  explicitly a release or a fix to the release path — say what and why first.
  `npm version` is the only way to bump.
- Docs, article and README current **before** a push and release, numbers
  included.
- `cancel-in-progress` is keyed on the ref: **a push to main cancels the
  in-flight main run**, so never push while waiting on a run you need to read.

## Things to distrust

- `npm test | tail -3`. See above.
- A local green. Two defects this week were invisible to the local mirror by
  construction.
- An error raised *by* CoreSimulator is not evidence the cause *is*
  CoreSimulator. That inference has been wrong here twice.
- A message that quotes another message. Classifying log lines by what they
  *mention* rather than what they *are* turned 22 wedges into 43.
- `pgrep -fl "<name>"` finds nothing when a process runs under `npx`/node with a
  different argv. The task chip is the reliable signal.
- A process that is idle is not a process that is stuck.
