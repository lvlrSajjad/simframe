# Handoff — 2026-09-12

**0.12.2 is live on npm as `latest`**, tagged at `b4c9fb0`. Verified twice and
independently of the release workflow's exit code: `npm view simframe version`
-> `0.12.2`, and the published tarball pulled down and checked to contain
`src/ollama.js`, the new `screenmap`/`navigate`, and `scripts/replay-rulings.mjs`.
CI was green on that commit including `integration` before the tag was pushed.

`origin/main` is current; nothing is held. The bench device is shut down and
Metro is still on 8083 with the testbed installed.

## What went in

**Five CI failures, all fixed, and only two of them were the same bug family.**

- The fingerprint eval was red on *the tour*, not the threshold. Six fixed
  sleeps, one of them waiting 3 s for a network page load; on a loaded runner
  one reading of `example.com` had no content tokens at all. Every sleep is now
  an arrival assertion. Worst same-screen pair 0.31 -> 0.63 locally.
- `goto` had one outcome with no name — a route that ran and landed elsewhere
  returned `{ok: false}` and no `reason`, which failed `ci-memory`'s check with
  an empty detail. Now `route-halted` and `arrived-elsewhere`.
- The 9271 ms settle was already fixed the night before in `b504631`; that log
  predated it.
- The reset step then failed at **25 s** with `screen unidentified · STILL
  MOVING · no elements read`. Not widened a third time: it retries and dumps
  `simframe state --json` and `simframe ui` on each failed attempt.
- And the next run failed *earlier still* — `simframe start` gave up while the
  daemon was **working**. Its own log, captured eight seconds later, read
  `frame=#1 age=1514ms, 1.0 fps, median 75.08ms`. The display had taken ~27 s to
  produce a first frame against a 20 s budget. Fixed at the root: a daemon we
  can see running earns a bounded 60 s, and "no daemon came up" is now a
  different sentence from "the daemon is running and the display produced
  nothing". That also explains the previous failure, so 126 is probably one
  phenomenon and not two.

**The pattern worth carrying.** Three separate times on that one step a budget
was widened on a plausible mechanism rather than a diagnosis, and two of those
were mine. What broke the run of guesses was the on-failure daemon log — a
diagnostic somebody had added earlier for exactly this. Add the diagnostic
before the third guess, not after.

**Item 120** — a coordinate gesture that changes nothing now says what it landed
on. Verified live. It nearly shipped keyed on `settled.noVisibleChange` alone,
which is the pixel detector; the `no-visible-change` *verdict* is the
fingerprint, and a live swipe produced the second without the first. Keying on
one would have shipped a fix that did not fire on its own bug report.

**The capacity comparison.** See `docs/EXPERIMENTS.md` — the new article, "What
we believed first" — and `docs/BENCHMARKS.md` for conditions.

## Two of my own diagnoses that were wrong

- **The "orphaned" collect-rulings processes were not orphans.** They had each
  finished their work and could not exit: the warm supervisor child holds the
  event loop open until something calls `close()`, and nothing did. Last night's
  handoff blamed the task runner for not killing `nohup`'d children. Fixed, and
  filed as 125. *A process that is idle is not a process that is stuck.*
- **Item 121 is not what it looks like.** `offViewport` has checked both axes
  since 0.11.0 and `rowsFor` calls it on every row with the same `screen` object
  the header prints from. Probed directly: the reported combination — dimensions
  in the header, an out-of-bounds row below — is not reachable through
  `screenMap`. Everything ruled out is written into the item. **Do not ship a
  fix on the current reasoning.** The next step is a reproduction: the testbed
  needs a horizontally scrolling row.

## The numbers, and what they actually say

22 rulings from one device pass; every arm then answered the identical 22, three
times each, same brief, same three-word schema.

| arm | accuracy | median | deterministic |
| --- | --- | --- | --- |
| always the commonest answer | 55% | — | — |
| **`stillMs > 3000ms`, no model** | **95%** | **0 ms** | yes |
| Apple Foundation Models (~3B) | 77 / 82 / 86% | ~640 ms | **no** |
| `qwen3:8b` (4-bit, 5.2 GB) | **91%** | 919 ms | yes |
| `qwen3:14b` (4-bit, 9.3 GB) | 82% | 1,489 ms | yes |

1. **Capacity did not help.** The 14B is larger, slower and *worse* than the 8B.
   That question is now answered with numbers and should not be re-opened by
   reaching for a bigger model.
2. **The accuracy ranking inverts the safety ranking.** Each arm errs in one
   direction only and the directions are opposite: Apple always `wait` where
   `stop` was right, both Qwen arms always `stop` where `wait` was right. A wrong
   `wait` costs a settle; a wrong `stop` abandons a working plan. Reporting only
   the percentages would have recommended the wrong model. This is the strongest
   case yet for item 100's `abstain` token, and it does not depend on the
   balance or the threshold.
3. **The shipped arm is non-deterministic** — ±2 rulings on identical inputs.
   Every previous single-run Apple number in this project carries that noise and
   was not reporting it.
4. **The free threshold won again**, out of sample. But its plateau is only
   ~2,100–3,200 ms and the `blocked` fixtures sit at 3,225–3,699 ms, so it may
   be separating *the fixture design*. **The next measurement is a population
   nobody designed — not a bigger model.**

## Next, in order

1. **121**, by reproduction rather than reasoning (above).
2. **117** (`scrollTo` calls an element under the tab bar "in view" — half built),
   **123** (print the region map on settle failure), **114** (check the step's own
   postcondition before aborting a batch).
3. **100, the `abstain` token.** Finding 2 above is now its main evidence.
4. **A messier ruling population.** Five fixture shapes designed by one person is
   the binding limit on everything in that table.
5. **124** — `lineServer.open()` has no timeout, and the file's own safety
   property ("null means behave as if there is no supervisor") requires one.
   Reasoned, not observed. Stop discarding the child's stderr while there.

## State of the machine

- **Bench device `326464A4`**: shut down. Metro is on **8083** with the testbed
  installed and its app built.
- **Ollama** has `qwen3:8b` and `qwen3:14b`. `SIMFRAME_SUPERVISOR=ollama:qwen3:8b`
  works and `doctor` reports it honestly, including "still loading" as distinct
  from "did not answer".
- `scripts/replay-rulings.mjs` is the cheap way to ask a new judge the same
  questions — one device pass, then seconds per arm.

## Standing rules

- No third-party app identifier in this repo, from anyone, ever.
  `scripts/check-private.mjs` enforces it.
- Do not rewrite git history without an explicit, specific instruction.
- Never `git add -A` without looking first. Verify checks separately, never
  chained with `&&`.
- Release files (`server.json`, versions, the workflow) only when the task is
  explicitly a release or a fix to the release path — say what and why first.
  `npm version` is the only way to bump.
- Docs, article and README current **before** a push and release, numbers
  included.
- `cancel-in-progress` is keyed on the ref: a push to main cancels the in-flight
  main run. Do not push while waiting on one that matters.

## Things to distrust

- An MCP server holds its code **and its tool schema** at spawn. A schema change
  needs a restart; an unknown property passed to an old build sails through and
  reports itself as correct.
- The perception harness feeds already-fused element lists, so it cannot catch a
  fusion-loop bug. `integration` catches those.
- `doctor` runs in its own process and can report a tier healthy while the
  long-lived server's copy is dead.
- The bench device wedges; restart cures it, then `simframe input reset`.
- A background command piped through `tail` buffers everything until it exits —
  an empty output file is not an idle job.
