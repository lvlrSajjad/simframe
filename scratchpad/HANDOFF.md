# Handoff — 2026-09-12 night, for 2026-09-13

`origin/main` is current, nothing held. **0.12.1 is on npm as `latest`**,
verified independently (`npm view simframe version` → 0.12.1, tarball
resolvable). CI went all green on `b504631` including `integration`, so both
settle fixes worked, and 0.12.1 shipped the same night.

## State of the machine

- **Metro is running on 8083** (the owner's call) and the testbed app is built
  at `scratchpad/rn-build/…/SimframeTestbed.app`. Reinstall it after a wipe.
- **Our bench device `326464A4` is shut down.** A *different* simulator,
  `B55AB0AE`, is booted and is **also named "iPhone 17 Pro"** — the exact
  collision 119 fixes, live on this machine. It may be a colleague's; leave it
  alone, and **always pass `--device` explicitly here**.
- Two cleanup lessons worth keeping: `TaskStop` kills the shell task and **not**
  a `nohup`'d child, so three `collect-rulings` processes survived their runs
  and had to be killed by PID; and `git add -u` stages only *tracked* files, so
  a new script sat unstaged through two commits.

## First thing tomorrow

## Then, in this order — and the order changed last night

**The supervisor is off by default. The peer findings hit every user.** That
asymmetry decides this, because last night's measurement made the supervisor
work *less* urgent, not more.

1. **120** — a coordinate tap should say what it hit. Fifteen minutes lost in a
   real session to an overlay that was *in the element list* at y≈753 while the
   swipe started at y=750. We already hold the geometry; it converts a silent
   failure into one line.
2. **121** — coordinates exceeding the stated screen width (`411` on a `402pt`
   screen). The reporter stopped trusting our numbers and derived taps from
   screenshot proportions instead. Second coordinate-contract complaint in two
   rounds; **116** is the other.
3. **117** (`scrollTo` calls an element under the tab bar "in view" — half built,
   we already identify that region), **123** (print the region map `sim_state`
   already computes when settle gives up), **114** (check the step's own
   postcondition before aborting a batch on screen identity).
4. **100, the `abstain` token.** Three populations in a row have had errors in
   one direction only — `wait` where `stop` was right, never the reverse.
5. **A bigger, messier ruling population — not a bigger model.** See below.
6. Then, and possibly never, **109a / 109**.

## What last night measured, and why it reorders the list

First balanced population: 16 `wait` against 16 `stop`, baseline **50%**.

| | |
| --- | --- |
| the model | **91%** |
| `stillMs > 3000`, held-out half | **100%** (model 94% on the same half) |
| median judgement latency | 1,192 ms |
| `edges the graph had timed` | 0/32, third time |

**The model is good and may be unnecessary.** A one-line comparison on a number
the daemon already computes beat it on data it was never fitted to, with no gap
between the fit and held-out halves. The split rule and candidate thresholds
were fixed in `scripts/score-rulings.mjs` *before* the population finished, so
it is not the fitted-after-the-fact number the previous attempt produced.

**Do not over-read it.** 16 held-out samples, where 100% and 94% differ by one
ruling; five fixtures designed by the same person who then found the threshold,
each deliberately cleanly one thing or the other. The next measurement is
whether it survives situations nobody designed — which is why a messier
population beats a bigger model as the next spend.

**And 101 as written asks the wrong question.** It proposes a p95-per-edge
lookup; `edges the graph had timed` is 0 in all three populations, because a step
that failed has never succeeded on that edge. What won was a flat global
threshold. Different claim, and only the simpler one has evidence. Restated in
the item.

**One more thing neither number shows.** By *decision* the model is 91%; by
*outcome* 69%. Nearly all the difference is the `detail` fixture taking `wait`
8 times out of 8 — the right word — and recovering once. A correct ruling is not
sufficient when the wait that follows is a fixed 4 s and the screen needs
longer. Whether that is a fixture too slow or a wait budget too short is unknown
and worth measuring.

## The experiments article — the owner's idea, and a good one

They want the numbers per iteration written up: what made things better, what
made them worse. The spine should be **what we believed first**, because the
entries with teaching in them are the reversals — a "64% accurate" supervisor on
a population where guessing scored 86%; `prewarm()` looking like a regression
until measured on the right axis; a large-title rule that fired on one screen
and not its neighbour because it keyed on the median row gap; a recovery loop
that registered 670 callbacks and released none; 9% of escalations being what a
code-scanning graph could address. Generate it from `BENCHMARKS.md` where
possible so it cannot drift from the data.

## Owed to the owner

- **A peer round.** They will ask a human peer. An agent peer round on the
  testbed was started and **stopped when we paused** — it reported nothing, so
  re-run it; it takes minutes.
- **Network visibility (80).** They said "ready when you are" and will sit in
  for it. Needs ~20 minutes together: they trigger a real API call while we
  listen. The testbed's live mode was built for this, so the setup is paid for.
- **Ollama** — they are pulling `qwen3:8b` and `qwen3:14b`, several hours. Their
  Homebrew ollama 0.5.7 *server* was answering on 11434 while the new 0.34.0
  client talked to it, which is what the misleading 412 "needs a newer version"
  was: `brew services stop ollama`, then run the app's server.

## Confirmed today

- The owner's app is on RN's **New Architecture**, so the testbed matches it.
- Phase 19 (the web) waits until mobile is reliable — their words, "fry the fish
  we have".
- The code-scanning graph idea is worth a **prototype** if the results impress;
  measured ceiling as a navigation oracle is 9% of escalations, but the *names*
  and *destructive-barrier* angles are stronger and the testbed makes them
  prototypable.

## What today established

**Push 1 landed** (101a rulings persist · 98 relabel guards · 88 label-first
docs), **99** minus the token budget — measured at 1,918 tokens of 4,096 worst
case, so the check would guard a condition that cannot occur — and **110** in two
halves.

**The testbed earned its place on day one.** It validated 110's first half on a
non-Apple app, then found that half was keyed on the wrong thing: the "is this a
real inset" test compared against the screen's *median row gap*, so a
system-drawn title was chrome or content depending on how many rows sat below it
(24 rows → median 0 → fired; 4 rows above a tab bar → median 414 → did not).
Both bounds absolute now, `TOKEN_RULES_VERSION` 8.

**And naming both screens still did not separate them** — 0.50 similarity
against a 0.36 threshold, because the name was one token of six. A chrome label
is now decisive in the graph: two readings that both name themselves, and name
themselves differently, are not the same screen. Silence is not disagreement.

**CI's flakiness was mostly structural.** Every trigger shared one concurrency
lane per ref, so the nightly cancelled push verifications outright. Fixed.
`scripts/ci-integration-local.sh` runs the integration job here in two minutes
instead of thirty and has already caught two device wedges in its first ten
lines.

**Three harness bugs, all the same family — assuming instead of proving.** A
walk that does not throw is not a walk that arrived; three of four rulings in one
run were taken on step 1 of a three-step form while claiming to be about step 3.
`eval-fingerprint.mjs` already checks exactly this and the check had not been
carried over. Fixtures now assert arrival.

## The model comparison — the owner's call, 2026-09-11

Their words: *"we can of course do our own test with a chosen model… and decide
based on the numbers rather than speculations."* Correct, and it overrides our
recommendation not to look.

- **Arms:** no supervisor · Apple ~3B · one larger local model.
- **Their machine has 32 GB**, so roughly a 4-bit 8-14B (~5-9 GB resident), with
  24B at 4-bit (~14 GB) as the ceiling. Do not exceed that.
- **Experiment, not adoption.** Nothing enters the shipped dependency graph
  without its own explicit decision. A model used to measure whether capacity
  matters is not a model we ship, and conflating the two is how a non-goal
  erodes.
- **Fairness condition:** both model arms constrained to the same closed
  vocabulary, schema- or grammar-enforced. Most small-model errors are
  invalid-output faults, which Apple's guided generation eliminates at the
  sampling layer; an unconstrained challenger would lose on formatting and we
  would read it as losing on judgement.
- **Four arms, not six:** neither · briefing only · briefing+Apple ·
  briefing+larger. Model-without-briefing is dropped *with cause* — asked cold it
  scored about one in four and called an arriving list a dead end.

## 110 — the fingerprint had no name for a screen (2026-09-12)

**What last night's red `integration` actually was**, after three wrong
diagnoses of my own: not item 95, not a settle failure, not a tap that missed. A
real collision. Chrome labels are the only text identity keeps, and an iOS large
title is drawn tight against the content it heads — 63-79 pt of inset above,
**5.3 pt** below, against a boundary bar of 66.5 — so it fell into `content` and
was discarded as content. The Settings root had **0 named tokens** in both
sensor modes. Two sparse nameless readings on a runner then matched exactly.

Fixed by finding the title from the inset *above* it, deliberately not from the
`Heading` role: OCR has no roles and the colliding reading was OCR-only, so a
role test would work only where it does not fail. `TOKEN_RULES_VERSION` is 7.

**Two things worth carrying forward.** Unbounded, the rule promoted
example.com's `<h1>` to chrome, because Safari on iOS puts its chrome at the
bottom — page content entering identity, which this module has been bitten by
twice. Bounded by a platform constant (iOS draws a large title at a system
offset; the page heading sits 122 pt down). And the distributions **did not
move** — gap 0.48 either way — because the collision has never happened on this
machine. The change removes the precondition, not a measured regression.

**The other half is open and larger.** Two fixtures have real compact nav bars
the detector also misses (gap below 10.0 against 19 required; 27.7 against
66.5) and `contacts` still reads 0 named. The detector identifies a bar by the
whitespace beneath it and iOS does not always provide any.

## CI has two independent failure causes, and I conflated them once

- **The collision** (above), on `d7f0e45` step 13.
- **Item 95, which is real**, on `5c79aad` step 11: `settle: screen did not
  settle within 8056ms`, a two-step flow taking 45.6 s. Genuine runner slowness.

`5b2e8da` passed both. Do not read one as the other again.

## What 2026-09-11 established

**The red CI was hiding a worse bug than itself.** The stale-ref check failed by
matching prose. Running the scenario on a device instead: `find #1`, numbered in
Reminders and asked for in Contacts, **returned ok** — re-resolving onto the
status-bar back-to-app breadcrumb. `refs.js` separates a different screen from
layout drift; the relabel recovery was built for drift and fired on both. Fixed
(`staleKind`), and `find --json` now carries `reason`/`staleRef`/`staleKind` as
fields so no check ever has to match a sentence again.

**Two tests were asserting the shape of the source**, not behaviour — one
grepped `cli.js` for the literal `ok: false`; the stale-ref test built an
identity mismatch while its comment described drift, which is how the recovery
came to be wired to the wrong branch. Both now run the thing.

**The `@Generable` safety claim is verified** and at the layer we hoped:
constraints are enforced by **logit masking at sampling** (Apple's own words,
WWDC25 301; Tech Report §7). A fourth word is unrepresentable, not rejected
afterwards. Watch **FB24310823** — a guided-generation regression on macOS 27
betas 5-7 — before moving to 27.

**I filed research and then had to audit myself twice.** Four findings were read
and not filed (106, 107, 108, and the do-not-adopt decision), and item 101 said
its measurement "runs on logs we already have" when nothing persists a ruling at
all. Both corrected in place. The habit is the thing to watch, not the instances.

## Open with the owner

- **Network visibility** approved, cheaper path: they trigger an API call while
  we listen. Hand-rolled CDP WebSocket client needed regardless — no global
  `WebSocket` on Node 18/20, and the upgrade is **401 without an `Origin`
  matching the inspector's host**. A handshake reached `101`; `Network.enable`
  returns `{}`; whether it emits events is unresolved.
- **Phase 19 (the web)** on the roadmap, `docs/research/04-web.md`, ROADMAP in
  DECISIONS.md. Their framing and the right one: port the philosophy, not the
  implementation.
- **A peer round on 0.11.0.**

## Device

`326464A4-331E-47A3-A90F-6A2E85BCEE18` is **ours** — the owner keeps other peers
off it — and `https://formsmarts.com/html-form-example` is the benchmark page.
The software keyboard is enabled on it for testing. The other booted device may
be a colleague's; do not drive it, and note a `getFrame` on it starts a daemon.

## Things to distrust

- An MCP server holds its code **and its tool schema** at spawn. A schema change
  needs a restart; an unknown property passed to an old build sails through and
  reports itself as correct. This has cost three rounds.
- The perception harness feeds **already-fused** element lists, so it cannot
  catch a fusion-loop bug. Its own header says so. `integration` catches those.
- `doctor` runs in its own process and can report a tier healthy while the
  long-lived server's copy is dead. This is exactly how the supervisor went
  silent for twenty calls.
- The bench device wedges; restart cures it, then `simframe input reset`.
- CI is ~10 min, and `cancel-in-progress` is keyed on the ref — a push to main
  cancels the in-flight main run, so do not push while waiting on one that
  matters.

## Standing rules

- No third-party app identifier in this repo, from anyone, ever.
  `scripts/check-private.mjs` enforces it. Metro prints the owner's bundle id —
  keep it out of every file.
- Do not rewrite git history without an explicit, specific instruction.
- Never `git add -A` without looking first. Verify checks separately, never
  chained with `&&`.
- Release files (`server.json`, versions, the workflow) only when the task is
  explicitly a release or a fix to the release path — say what and why first.
  `npm version` is the only way to bump.
- Docs, article and README current **before** a push and release, numbers
  included.
