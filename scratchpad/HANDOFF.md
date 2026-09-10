# Handoff — 2026-09-11 night, for 2026-09-12

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

**Nothing is held locally.** `origin/main` is current. This is the first handoff
in a while with no unpushed commits, and it should stay that way.

**It has not had a peer round.** Every previous local-tier idea in this project
passed a bench and died on a real app. The supervisor in 0.11.0 has been driven
by its own author and nobody else.

## Tomorrow, in the owner's own order

They said: cheap wins first (my choice of which), then the model comparison,
then the rest. Not tonight.

**Push 1 — cheap wins, all offline-testable, no device sweep.**

- **101a** persist supervisor rulings. One line per consultation: screen hash and
  graph edge, decision, `stillMs`, the step's `expect`, and **the outcome the
  executor observed afterwards**. That last field is what makes a ruling
  scoreable rather than merely recorded. Smallest item on the list; gates 101,
  106, 96 and 109a.
- **98** the relabel recovery still accepts a weak match. Today it took **0.64**
  and a target in the **status bar**, a region `sim_ui` refuses to publish. Two
  guards: a score floor (a recovery is a guess and deserves a higher bar than a
  lookup the caller asked for) and a published-region check.
- **88** MCP tool descriptions still open with `#3` rather than intent.

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

## What today established

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
