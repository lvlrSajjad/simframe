# Handoff — 2026-09-13

**Nothing is released.** npm is still on **0.12.2**. `package.json` says 0.12.3
and the next release should be **0.13.0** (`npm version minor`) — the tree
carries a new supervisor arm, a new experiment harness, a changed escalation
record shape and a changed `waitFor` contract, and calling that a patch would be
dishonest. The stale local `v0.12.3` tag has been deleted; it was never pushed.

Three commits are held locally and unpushed. CI last went red on `3189ee4`, and
**the reason is now solved — see 126 below.**

## What today was

Three field reports on a real production app, from three separate agent
sessions. They are the best input this project has had, and most of the day's
work came from them. They live outside the repo by design.

### The three-pass experiment, finished

| pass | operator | graph | `sim_do` calls |
| --- | --- | --- | --- |
| 1 | fresh | cold | **33** |
| 3 | fresh | **warm** | **24** |
| 2 | experienced | warm | **12** |

Pass 3 is the isolation and it settles the attribution:

- **the graph is worth ~27%** (33 -> 24, nothing else changed)
- **operator knowledge is worth the rest** (24 -> 12)

Peer 2 estimated the graph share at ~23% from escalation rate per step without
being able to isolate it. The direct measurement says ~27%. Two methods, three
points apart, n=1 app.

**This has not been written into the docs yet, and the owner has asked for it.**
Their framing, and it is right: these numbers cost three peer sessions and make
the project a study case, not just a tool. They belong in EXPERIMENTS, the
article, README and the site.

### 126 — solved, and it was one cause wearing five faces

`simctl io screenshot` on a wedged display does not fail, it **hangs**. `run`
kills it at 10 s. `simctl` opens every invocation with `Note: No display
specified …`, so at kill time that Note is the only thing on stderr — and the
handler took the last stderr line. We reported an informational message as the
reason a capture failed.

Run to completion the device is unambiguous:

```
NSPOSIXErrorDomain code 60 — Timeout waiting for screen surfaces
```

That went unread through **five** CI failures with five different symptoms: a
27 s first frame, a screen moving while reading as empty, a tree returning
nothing for eighteen readings, a three-hour-stale frame sold as 130 ms, and an
empty map on a live device. All one thing.

`screenshotFailure` is extracted and tested. `simframe frame --fresh` is the
arbiter every field round had to leave simframe to get — compared by region
signature, on a threshold that was **measured**: same screen two paths 0.00123,
two different screens 0.686, so `PATHS_AGREE = 0.02`.

## Next, in order

1. **122 — emit unlabeled-but-tappable nodes** as `#7 button 361,234 <unlabeled>`.
   The cheap half of Phase 16, needs no model, testable on the in-tree testbed.
   All three peers named this their biggest practical drag; three of peer 3's
   four flows needed a control that was not in the map. **The owner has approved
   Phase 16.**
2. **Write the numbers up** — the three-pass table above and the supervisor
   results, into EXPERIMENTS / the article / README / the site.
3. **Cut 0.13.0.** Run `./scripts/ci-integration-local.sh <udid>` first: it has
   caught every real problem and costs two minutes against CI's thirty.
4. Then: the premature `settle` (peer 3 — `settled after 62ms` on a
   still-loading screen, 4-element map, tab labels bound to the wrong
   coordinates), `--session` binding to the MCP server's id, 117, 123, 114, 118.

## What is fixed and unreleased

120, 121, SEV-1 (rewritten — see below), the `waitFor` ambiguity stop, the
`index` out-of-range message, the escalation read-vs-assumed split,
`supervisions --session`, `doctor` proving the ax tree answers, "untested is not
passed" in `ci-memory`, and 126.

## Mistakes worth keeping

- **I shipped SEV-1 detection gated on 20 s of stillness**, a number taken from
  one earlier report. The next report's case was 8,183 ms, so it could not fire
  during exactly the failure it was written for. Rewritten to count *ignored
  gestures* instead: three gestures with no pixel moving, at any duration. A
  threshold chosen from one example is not a mechanism.
- **I announced two wrong causes for the CI failures** — a runner image change
  that had not happened (I read the `Image Release` line from the wrong job),
  and a retry-shaped fix for what turned out to be a discarded error string.
- **My first `--fresh` comparison was a byte comparison**, which calls a
  full-resolution capture and a downscaled frame different every time. A
  confident wrong answer about the one question the command exists to settle.
- **I asked the owner to run a pass-3 experiment that was already done** and
  sitting in the report they had sent me.

## The measurement results, for anyone picking this up

- **Capacity does not help.** qwen3:14b scored *lower* than qwen3:8b (82% vs
  91%) on identical inputs, both deterministic, while being 79% larger and 62%
  slower. Do not reach for a bigger model.
- **The accuracy ranking inverts the safety ranking.** Every arm errs in one
  direction only and the directions differ: Apple always `wait` where `stop` was
  right, both Qwen arms always `stop` where `wait` was right. A wrong `stop`
  abandons a working plan.
- **Apple is not deterministic** — 77 / 82 / 86% on identical inputs.
- **The cascade does not work** at any abstention band tried (95% for the free
  rule alone; 91 / 86 / 82 as more is handed to the model).
- **The fourth word made Apple ~32 points worse** and it never used it once.
- **The supervisor went 0-for-18 in the field**, two independent sessions, at
  ~1.3 s a ruling. Third population saying the same thing.

## Where we are against the phases

Done: 10, 11, 11.5, 18. Cancelled by their own measurement: 17 (NO-GO), 11.5's
original premise. Never started: 12, 13, 14, 15, **16**, 19.

The escalation breakdown is supposed to pick the next faculty and has been
pointing at **16** for a while — partly unread because `verification_failed` was
mislabelling most of the log as Phase 11 until today.

## State of the machine

- **Our bench device `326464A4` is shut down**, daemon stopped.
- **`B55AB0AE` is booted and is NOT ours** — it is the device the field rounds
  ran on. Leave it alone; always pass `--device` explicitly, because both
  simulators are named "iPhone 17 Pro".
- Metro is not running. The testbed app is installed on the bench device.
- Ollama has `qwen3:8b` and `qwen3:14b`.

## Standing rules

- **No client or third-party project name in this repo, ever** — not the app,
  not the company, not any of the owner's other projects. `scripts/check-private.mjs`
  enforces the bundle-id half; the rest is discipline. Verified clean today:
  zero tracked files mention it.
- Do not rewrite git history without an explicit, specific instruction.
- Never `git add -A` without looking first. Verify checks separately, never
  chained with `&&`.
- Release files (`server.json`, versions, the workflow) only when the task is
  explicitly a release or a fix to the release path — say what and why first.
  `npm version` is the only way to bump.
- Docs, article and README current **before** a push and release, numbers
  included.
- `cancel-in-progress` is keyed on the ref: a push to main cancels the in-flight
  main run.

## Things to distrust

- An MCP server holds its code **and its tool schema** at spawn. A schema change
  needs a restart.
- `doctor` runs in its own process and can report a tier healthy while the
  long-lived server's copy is dead. It now proves the ax tree *answers*; the
  same correction has not been made everywhere.
- A background command piped through `tail` buffers everything until it exits —
  an empty output file is not an idle job.
- `ps -p $(pgrep …)` prints nothing when pgrep finds nothing, which reads
  identically to "nothing is running". It hid a stuck background task for hours.
- A process that is idle is not a process that is stuck. Three "orphaned"
  scripts had finished their work and could not exit.
