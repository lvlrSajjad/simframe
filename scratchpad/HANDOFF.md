# Handoff — 2026-09-11 (refreshed before a compact)

`docs/DEFERRED.md`'s **2026-09-11 status block** is the live list and opens with
"read this first after a compact". `docs/DECISIONS.md` is the register of
judgements. This file is the short version.

## Release state — READ THIS FIRST

**0.11.0 is authorised and gated on a green `integration`.** The owner's words:
*"if CI is green yes"*, and *"before a push and release all the articles and
docs are up-to-date"* — which they now are.

- `origin/main` is at **`4d17b68`**; **two commits are held locally**:
  `8c2e72a` (the focus race) and `e97022d` (the queue). Held only so the release
  can be tagged from a commit CI has actually gone green on — push them either
  way once it resolves.
- **When integration is green:** `npm version minor`, then push the tag. The
  tag also runs `bench`, which is the one place HPI is worth 28 minutes.
- **CI is now ~10 minutes, down from 28.** `bench` is off the push path (it
  cost 28 of a 28-minute run and can only ever emit a `::warning` on a hosted
  runner), the daemon build is cached, and `cancel-in-progress` is on.

## What happened today

Three peer rounds and an external research brief, and one shape runs through
all of it: **every serious bug was a component reporting more certainty than it
had, and not one would have failed a test.**

**Shipped, all verified on a device rather than a bench.** The field readback
now works on web content *at all* — it was an ax-only read, and Safari's page
content is not in the host tree, so it had never once run where it mattered. A
value simframe wrote and can no longer see is announced. `detail:"high"` serves
a real full-resolution frame instead of upscaling a sub-1x one. `sweep` no
longer pull-to-refreshes at the top. A look cannot claim an image is fresher
than its bytes. The stale-ref message no longer prints 8 characters of a
72-character hash. An alias cannot pair two z-layers. The keyboard boundary
reaches its own top row (`TOKEN_RULES_VERSION` **6**). **A keyboard key can be
pressed on iOS at all**, for the first time. **A field can be cleared.** Text
insertion waits for focus.

**Two of mine, both caught by CI and worth remembering.** I pushed a change that
read `covering.label` before checking `covering` existed — the TypeError landed
inside the OCR try/catch, so the sensor turned itself off and politely reported
`degraded: text recognition`. And I wrapped a CI step in `timeout`, which macOS
does not ship; it is on my machine via Homebrew.

## Research — `docs/research/05-private-api-and-uncertainty.md`

Answers to seven questions we could not answer ourselves. Filed as items 89-97
and **placed in the ordering**, not left in a section.

The four that change what we do:

- **`custom_actions` is already in the tree and we have never requested it.** We
  ask for eight attributes and none is this. It is a way to act on an element
  that is not a keystroke, so no keyboard layout can corrupt it (89).
- **`AXTraits` exist and we read none** — `AXTraitAlert` is the modality hint we
  lacked for the z-layer bug; `AXTraitScrollable` names the scroller (92).
- **There is no scroll offset anywhere**, and no public tool reads one. Only
  *change* is observable, so our content-delta approach is the state of the art
  (93).
- **The unpredictable swipe is UIScrollView inertia.** Dwell before lift, and
  compute the next step from measured travel. Nobody gets deterministic travel
  (94).

And the one to say out loud: **the supervisor A/B is inside the noise band.**
Single-run agent measurements vary 2.2-6.0 points by run selection; 15-22% of
tasks are flaky across identical reruns. "25 calls vs 45" is one run of a
two-armed test of a two-factor system. Item 96 has the design that would settle
it: full 2x2, within-subject, Williams order, graph reset between conditions,
repeated cells, mean ± SD.

## Next, in order

The full list is in `docs/DEFERRED.md`'s status block. In brief: the release →
**89 + 92** (both already in the tree) → **93 + 94 together** as one closed-loop
piece → **86** (fingerprint noise from live numbers and dates) → **78, 87** →
**88** (tool descriptions still lead with `#3`) → **96** before any further
supervisor claim → **97**.

**Build 93+94 offline against the perception harness, not by swiping at a live
page.** That mistake cost two wrong fixes today and one made things measurably
worse — the owner watched it happen and said so.

## Open with the owner

- **Network visibility is approved**, with the cheaper path chosen: they will
  trigger an API call while we listen, rather than us injecting an interceptor.
  A hand-rolled CDP WebSocket client is needed regardless — no global
  `WebSocket` on Node 18/20, and the upgrade is **401 without an `Origin`
  matching the inspector's host**, which a stock client cannot set. A handshake
  reached `101` on 2026-09-11; `Network.enable` returns `{}`; whether it emits
  events is unresolved.
- **Phase 19 (the web) is on the roadmap**, `docs/research/04-web.md`, registered
  as ROADMAP in DECISIONS.md. Their framing, which is the right one: port the
  philosophy, not the implementation.

## Device

`326464A4-331E-47A3-A90F-6A2E85BCEE18` is **ours to use** — the owner said so
and is keeping other peers off it — and `https://formsmarts.com/html-form-example`
is the agreed benchmark page. They also enabled the software keyboard for
testing, which is what made the keyboard-boundary bug measurable.

The other booted device may be a colleague's. Do not drive it; a `getFrame` on
it starts a daemon.

## Things to distrust

- An MCP server holds its code **and its tool schema** at spawn. A schema change
  needs a restart, and an unknown property passed to an old build sails through
  and reports itself as correct. This has now cost three rounds.
- The perception harness feeds **already-fused** element lists, so it cannot
  catch a bug in the fusion loop. Its own header says so. The integration job is
  what catches those.
- `doctor` runs in its own process and can report a tier healthy while the
  long-lived server's copy is dead.
- The bench device wedges; restart cures it, then `simframe input reset`.

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
