# Handoff — 2026-10-04

The previous handoff (2026-10-03, goal mode and cartographer) is in git history.
This one covers the field reports, the model and tool comparison, the human
baseline, and **0.23.0**.

## Read this first

- **The goal is driving like a person; tokens are the proof that it works.** On
  2026-10-03 a person who knows the field app did a service request in **39.1 s**
  and an add-asset in **48.9 s** (medians of five, `simframe baseline record`).
  Every agent setup took 13–16 minutes for the pair, about 9–10× slower. The cause
  is measured: about 12 decisions for the person, 50–130 model calls for the
  agents. **Phase 20** in `docs/PHASES-HUMAN-PARITY.md` is the plan. The source is
  `docs/research/08-how-a-person-drives.md`, in the owner's own words.
- **The token saving is proven.** The same model with simframe used 2.5× fewer
  tokens and 3.5× fewer calls than without (BENCHMARKS, "Who drives"). The docs
  lead with it. **Never quote a human time without a recording** (DECISIONS,
  2026-10-03): a guessed "5–10 minutes" had flattered the agents five times over.
- **The plugin ships a Sonnet driver agent** (`agents/simframe-driver.md`, simframe
  tools only), which now carries the "move like a person" rules. It exists only
  with the plugin install, and the README, skill and GUIDE say so.
- **Released 0.23.0** at the end of this session. Confirm with
  `npm view simframe dist-tags`, and update the global (`npm i -g
  simframe@latest`) so the plugin's server and this checkout agree. This
  session's version skew (checkout on fingerprint rules v10, global on v9) made
  both of the owner's field runs see an empty graph.

## The backlog, in order

**First, three fixes from the owner's 0.23.0 run** (DEFERRED 201; they cost
trust and caused a misattribution, and #1 also feeds Phase 20's forward step):
- (a) Transient toasts captured during waits and returned as text.
- (b) "Value changed with no action" and "values still changing".
- (c) The keyboard covering the next field in a batch or a sweep.

After them, DEFERRED 201 items 4–10, in order, between Phase 20 items when they
block a measurement.

Pick from the top. Each item is scored on model calls per job, wall time
against the person's medians, and wrong taps (must stay zero). Measure on the
two field jobs before and after.

### Phase 20, drive like a person (detail in PHASES-HUMAN-PARITY)

1. **The forward step, with surprises handled locally.** These are the cheap
   wins agreed with the owner and not yet built:
   - (a) A `forward:` line in the screen map naming the primary action: the big
     button at the bottom. With one, that is forward; with several, the one with
     a forward word (next, save, submit, review, apply, approve). Never
     destructive or barrier.
   - (b) A `{"forward": true}` step: tap it; landing on another screen is `ok`
     with nothing re-read. If it stays put, collect the visible validation
     messages ("required", "invalid") and any error toast, and return them in
     one line.
   - (c) Then scroll the form for validation messages it cannot see.
2. **Know the form's shape.** Single-step forms: `sweep` returns an outline
   (field, type, required, section, position) and the fill becomes one planned
   batch. Progressive forms: a local "what appeared, is it required?" loop until
   forward enables.
3. **Satisficing, with backtracking.** "If you're given a combination then you
   choose / search for those; if not, then first options." Named values go
   through the list's search box. On a dead end (an empty list, a drop-down that
   will not open, forward still disabled), go back to the latest choice point,
   locally and bounded. The driver's instructions already say this; the local
   machinery does not exist yet.
4. **Habits.** Save a flow the driver completed, with choices as slots, and
   replay it. Target: a repeat run within 1.5× of 39 s.
5. **Glance, don't read** on known screens: what changed plus the forward
   control.
6. **Places after words:** positions as a prior on screens seen many times.

### Measurement (do alongside item 1)

- **A generic twin of the field jobs in the testbed** (a progressive wizard and
  a long form with a radio-row date choice), so CI and `simframe hpi` can track
  Phase 20 without naming the field app. The field suite itself lives only in
  the scratchpad: `field-human-suite.json`, plus the task files `field-task*.md`
  and `driver-body.md`. It names the app's bundle id, so it never goes in the
  repo.
- **The Sonnet driver twice in a row, cold then warm,** against the person's
  medians.
- **Re-record `docs/research/hpi-baseline.json`** (CLAUDE.md requires it; one of
  its flows never completed). DEFERRED 173 (the suite wedging its device) is
  still open and gates it.

### Open bugs, by cost

- **Identity splits** (DEFERRED 174). Still the root of most re-reads. Settings'
  root (search focused or not) and the field app's lists split. 0.23.0 stops a
  same-titled split from failing a step, but the split itself remains. On the
  field app, recall at distances 0–4 matched a different screen more often than
  the same one (137 vs 81 pairs).
- **`goal`:** "Settings fits 2 remembered screens" from deeper screens, and it
  opened several screens hunting a target that does not exist.
- **The radio fallback costs about 16 s;** learn per screen which edge works.
- **The "pending sync" reminder** appears and disappears (an app modal). An
  `optional` tap handles it; nothing in simframe knows it is recurring.
- **The first `ui` after a rules bump took 28 s** (the one-time carry) and said
  nothing while it ran.
- **The asset that vanished.** One field-app asset disappeared from the app's
  offline queue across a device reboot, and nothing was uploaded. Possibly the
  app's own behaviour; unexplained.
- **Customer data at rest** and **frames on disk**: owner decisions, still
  open. The store is 0700 now.

## Environment facts that will bite

- **Devices:**
  - `326464A4` is the bench device.
  - `7B8F8963` ("ecotrak-simframe") is the owner's signed-in field app on DEV:
    real data, so ask before crawls.
  - `simframe-arm-B/C/D` (`AD9186D8`, `C27BA38D`, `4A7E66EC`) are clones of it,
    made for the comparison. They are shut down, not deleted, and the owner may
    want them deleted.
  - Arm D's clone may still be booted.
  - `B55AB0AE` and `CDB00FD6` are colleagues' devices: never touch them.
- **Cloning a device** carries its app, sign-in and offline queues. An app's
  pending uploads would be duplicated by every clone, so clear them on the
  clones first.
- **The session's permission check** refused some real writes (an asset upload,
  a final submit) in agent runs. Agents are told to stop, never to route
  around it.
- **DEV records** to clean up:
  - Work orders: 6322851 (A), 6322852 (C), 6322853 (D), 6322854 (E), 6322855
    (D2), plus the owner's five baseline service requests (one is 6322860;
    their description is "Mo").
  - Assets: arm B (ID 4511086), arm C, arm E, and the owner's five, all named
    "simframe QA asset - please ignore (…)".
- **Release:** `npm version minor|patch`, push main, push the tag, watch
  `release.yml`, then `npm view`. `gh` needs `GH_CONFIG_DIR=~/.config/gh-personal`.
  The GitHub API dropped connections from this machine on 2026-10-04. Retry, or
  ask the owner to look at Actions.
- **Run locally before pushing:** `npm test`, `node scripts/eval-perception.mjs`
  (a CI step), `node scripts/check-private.mjs`, and
  `node scripts/article-md.mjs --check` after editing the article page.
- **`simframe frame` writes `simframe.png` into the working directory.** Delete
  it; it is an app screenshot.
