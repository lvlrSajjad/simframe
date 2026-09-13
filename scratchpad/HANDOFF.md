# Handoff — 2026-09-13 (evening)

**0.13.0 is published.** npm `latest` is 0.13.0, the MCP registry has
`io.github.lvlrSajjad/simframe` at 0.13.0, and CI was green on `aa405f5`
before the tag went up. This project publishes tags + npm + MCP registry and
has never created GitHub Release objects, so there is nothing missing there.

## What went into 0.13.0

**122 — controls with no name.** Three field reports called icon-only menus and
back chevrons "absent from the tree". They were not; `screenmap.build` dropped
them one line before printing. Measured first: of 39 ax nodes on the testbed's
list screen exactly one is nameless, and it was the one control no caller could
reach. Settings and Safari gain nothing. `testID` reaches the map too. The
second half — a view the app never declared accessible — is still open and the
new line says so instead of reporting zero.

**The numbers are written up.** Three-pass table and the graph's ~27% in
BENCHMARKS, EXPERIMENTS §14, the article, the site and the README, which now
opens with a study-case block.

**123's cheap half.** A settle that times out names where the movement is and
draws the region map.

**126 has a trigger.** The wedge lands on an **app switch** — launching a second
app with Safari in front — and hit roughly every other run of the local mirror,
five times in one session. `frame --fresh` named it every time, `revive` cured
it every time. First reproducible trigger anyone has had for it.

## Six defects, and five of them were one disease

Every CI failure today was a component reporting a condition it could not
distinguish from a different one. The article's own closing rule.

- **127** `simframe start` said "no daemon process came up" about a daemon that
  was up and capturing. Circular: aliveness was read from `meta.json`, which the
  daemon writes *after* its slowest startup step, so the 60s live cap could
  never be reached in the case it exists for. The previous fix in this family
  **created** this one.
- **128** `simctl openurl` timing out is a statement about simctl's patience,
  not about whether the URL opened. The step asks the screen now.
- **129** A bad ax read reported "idb is not installed" — a tool we deliberately
  do not use on CI. The daemon had sent `axError` all along and nothing read it,
  while the OCR branch eight lines below reads `ocrError`.
- **130** `stableForMs` reported **79,207 ms** of stillness on a screen
  animating at 85 ms a frame, in the same file carrying `motion.animating` and
  `settled: false`. The premature settle, isolated. **Reported, not fixed** —
  see below.
- **131** A settle could not be satisfied on a screen still for 3,548 ms of a
  required 1,400, because it demanded a frame newer than the call and a still
  screen produces none by design. Currency is time, not a counter.
- **132** `ci-memory` exited 1 both for a real failure and for the device dying.
  75 now, and the job revives once on that code alone.

## The open decision, with its number attached

**130 is deliberately unfixed.** Requiring the daemon's `settled` flag would be
right for a spinner and wrong for a text caret — also small, also persistent,
and it must never stop a screen settling. **The next step is a measurement, not
a fix**: a blinking caret's per-cell delta and duty cycle against a spinner's,
on this device. If they separate, stillness can use the per-cell signal and the
premature settle goes away. If they do not, the answer is 123's expensive half —
let the caller name a region to ignore.

## Next, in order

1. **The caret measurement above.** It unblocks 130 and probably 123.
2. `--session` binding to the MCP server's id, then 117, 114, 118.
3. **graphify prototype** on the in-tree testbed, aimed at *control inventory*
   rather than route memory — per peer 2's reframing and the owner's two cases:
   static-ish repeated screens, versus one screen whose state change entirely
   changes its shape.

## Mistakes worth keeping from today

- **I made the same mistake twice in one day in one file.** The motion window
  was in frames when it had to be in time, and two hours later the settle's
  freshness check was in frames when it had to be in time. Frames are not a
  clock: capture is damage-driven with a 2 s idle floor.
- **I shipped a motion report that did not fire on the real failure path.** CI
  showed the bare message before I did. The fix was to make the message carry
  its own evidence, which then answered the question in one run.
- **I read a null field and nearly concluded the tracking was broken.** It was
  the reporting: `cli.js wait` builds a hand-written payload and dropped it.
- **`pgrep -fl "react-native start"` found nothing while Metro was running**,
  because `npx` execs a node process whose command line does not carry that
  string. The owner's task chip was the reliable signal; my process check was
  not. Second time this shape has cost something.

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

- **Our bench device `326464A4` is booted** with a daemon running; shut it down
  if you are done. It wedged five times today — see 126's trigger above.
- **`B55AB0AE` is booted and is NOT ours** — it is the device the field rounds
  ran on. Leave it alone; always pass `--device` explicitly, because both
  simulators are named "iPhone 17 Pro".
- Metro is not running. The testbed app is installed on the bench device, and
  the testbed now carries two deliberate shapes: an unlabelled overflow menu
  (122) and a spinner that never settles (123/130). The spinner is 120pt on
  purpose — at 28pt it settles in 247ms and reproduces the premature settle
  instead.
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
