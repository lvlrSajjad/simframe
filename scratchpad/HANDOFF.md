# Handoff — updated 2026-09-12, mid-session

`docs/DEFERRED.md` opens with a **START HERE, 2026-09-12** block. That is the
live list. `docs/DECISIONS.md` is the register of judgements. This is the short
version.

## 0.11.0 shipped

**Done, and confirmed rather than assumed.** `npm view simframe version` returns
`0.11.0`; `dist-tags.latest` is `0.11.0`; the MCP Registry step ran. The
`release` workflow passed every gate it owns — tests, `check:package`, a Swift
build of *the tarball's own sources*, version consistency across
`package.json`/`server.json`/tag, the publish, and the "actually resolvable on
npm" poll that `v0.5.1` taught us to add.

**Nothing is held locally.** `origin/main` is current — `92b73a8` as of this
update.

**It has not had a peer round.** Every previous local-tier idea in this project
passed a bench and died on a real app. The supervisor in 0.11.0 has been driven
by its own author and nobody else.

## Push 1 — DONE, 2026-09-12

- **101a** rulings persist to `supervisions.jsonl`; `simframe supervisions`
  reads them. Verified with a real ruling on the bench device, which
  immediately contradicted a premise of 101: a naming failure is on an edge the
  graph has never timed, so it has **no p95 by construction**
  (`edge_samples: 0`). 101 can only speak to timing failures on edges that have
  worked before, and the command prints `edges the graph had timed: n/total` so
  that is now empirical.
- **98** score floor 0.8 plus a region check. The number is structural, not
  fitted: a fuzzy match caps at `similarity * 0.72`, so only a near-exact name
  clears it (a "Remindars" typo measures 0.69). The reported case is a fixture
  now — `• Reminders` in the status bar, asked for as `Reminders`, **exactly the
  reported 0.64**, refused twice over. The region rule moved to
  `regions.offerable` so `view.js` and the recovery read one predicate.
- **88** MCP descriptions and CLI help lead with the label. The skill's prose
  also contradicted its own table and its example flow tapped `"#3"`.

**110's first half is also done** — see below. Push 2 (**99** prewarm and the
token budget, **100** the abstain token) is next, then 109a.

**Push 2 — the supervisor's reliability.**

- **99** `prewarm()` instead of our throwaway `respond`; a `tokenCount` check
  against `contextSize` before each call; per-`GenerationError` triage
  (`exceededContextWindowSize` is recoverable by rebuilding, `guardrailViolation`
  is not, so a blanket retry burns battery).
- **100** the `abstain` token — the one addition that raises coverage without
  widening what the component can do.

**Then 109a, which is the good idea.** Bottle rulings as fixtures and replay them
against candidate models **offline**. The model question then needs dozens of
*rulings*, not dozens of *runs*, and escapes the noise band entirely. Only after
that, 109's four live arms.

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
