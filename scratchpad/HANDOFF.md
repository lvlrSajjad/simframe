# Handoff — paused mid-session, 2026-09-12 evening

`docs/DEFERRED.md` opens with a **START HERE** block; that plus items 111 and 112
are the live list. Nothing is held locally — `origin/main` is current, 20 commits
today. The bench device is shut down. Metro is left running on **8083** (the
owner's call), and the testbed app is installed.

## Pick up here

The agreed order, and we got one item into it:

1. **95 — device stability. IN PROGRESS, and the interesting half is done.**
   A real leak was found in our own code: `observeChanges` registered a
   damage-rectangles callback with a fresh UUID on every call and never released
   the previous one, while `resolveDisplay` re-walks the same `ioPorts` array and
   frequently finds the *same* port. So every recovery attempt added a live
   callback to one port — and this morning's log has **670 port re-resolves**,
   each invoked per redraw. Our recovery was a cause as well as a response.
   Fixed; registration is now unregister-then-register.

   **What is NOT done is proving it was the cause.** `scripts/soak-capture.mjs`
   exists for exactly that: drive until the display dies and report how long it
   took. Before the fix, roughly 10-20 minutes; the device wedged three times in
   one afternoon. **Run it first thing** — that is the before/after, and it is
   the difference between "found a leak" and "fixed the wedge".

2. **112 — balance the ruling population.** Today's 14 labelled rulings are 12
   `stop` to 2 `wait`, so a majority-class guess scores 86% and beats the model's
   64%. No accuracy number from that set means anything. Add genuine `wait`
   fixtures: `listArrivesInWaves` already exists in the testbed and no fixture
   uses it; a slow detail screen and a modal mid-present are cheap.
3. **100, the `abstain` token**, with **97** behind it. Today's measurement is
   direct evidence: every supervisor error was `wait` where `stop` was right,
   five times, never the reverse.
4. Then **109a → 109**, a reshaped **101**, then 89+92 and 93+94.

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
