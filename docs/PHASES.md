# simframe 2.0 — phased build plan

One phase per Claude Code session. Each prompt names what to read, what to
build, what not to do, and how the phase is verified. Run them in order; each
phase leaves the tool fully working. Copy the prompt block verbatim, then adjust
the `docs/research/…` filenames to match what you committed.

Phases 0–2 are the engine (capture, input, a11y). Phase 3 replaces idb and
simctl for good. Phases 4–6 add local perception and memory. Phase 7 reshapes
what Claude sees. Phase 8 is the second platform.

---

## Where this stands

Updated 2026-09-09. Numbers for every claim here are in `docs/BENCHMARKS.md`;
open work is in `docs/DEFERRED.md`.

This file covers Phases 0-9. **The human-parity series, Phases 10-16, is in
[`docs/PHASES-HUMAN-PARITY.md`](PHASES-HUMAN-PARITY.md)**, with its research in
[`docs/research/03-human-parity.md`](research/03-human-parity.md) and its fixed
decisions in `CLAUDE.md`. It is a separate file because it is scored
differently: every phase there reports model turns removed and a Human Parity
Index, not a latency in milliseconds.

| Phase | State |
| --- | --- |
| 0 — Swift daemon, framebuffer capture | done |
| 1 — Indigo HID input | done |
| 2 — OCR half | done |
| 2a — a11y via `AXPTranslator` | done. The tree is read host-side, in-process; idb is no longer required for anything |
| 3 — replace idb/simctl | done. Capture, input and the accessibility tree all go through the daemon; idb is a fallback, not a requirement |
| 4 — settle and transition classification | done. The classifier is noisy enough that transition *kind* is advisory, not a reason to halt a flow |
| 5 — layout priors and intent matching | done |
| 6 — transition graph, verify-after-tap | done |
| 6b — structural fingerprint | done. This is how screens are identified; the pixel hash kept change and settle |
| 6c — structural settle gate | done, **and it missed both its goals** — read the BENCHMARKS entry before trusting the gate to have fixed anything |
| 6d — variants, and the date that expired | done. A screen may hold several accepted fingerprints; a date banner had been entering one screen's identity |
| 6e — verdicts on the reliable signal | done. Transition kind is reported, not judged; `verdict` compares nodes rather than raw hashes |
| CI — packaging + integration gates | done. `integration` boots a simulator on `macos-15` and asserts every layer under `--strict`; required on `main` with an admin bypass |
| CI — the memory layer | done. `scripts/ci-memory.mjs` drives the real CLI over the screen map, refs, graph, verdicts, flows and `goto`, OCR-only. Four bugs found writing it, one of them a capture loop that could not recover a lost display port |
| 7 — compact agent state, skill | done. A ten-step flow is **1 tool call, 0 images, ~1,650 characters**. Every action returns the numbered text screen map; `sim_look` is the only image path and is capped at 1024 px |
| 8 — Android | steps 0-3 done — the seam exists, dispatch is device-keyed, and Android both reads and acts: frames at 41 ms, a screen map, the graph, taps, typing, keys and the clipboard. No accessibility tree (Phase 8b, conditional) |
| 8b — Android accessibility APK | **deferred**, with criteria and numbers in `docs/DEFERRED.md`. `uiautomator dump` costs 2,012 ms; the fast path needs an instrumentation APK on the device, which would be simframe's first installed artifact |
| 9 — tier-2 local model | **deferred, and not merely unstarted.** Its own gate — the Phase 5 eval harness — does not exist, and the measured gap it would address (83% icon-only elements) has a cheaper tool in Phase 16 |
| 10 — instrumentation | **code done, one input outstanding.** Escalation log with the five reasons, per-flow metrics, `simframe baseline / hpi / escalations`, and a `bench` CI job. First numbers in `docs/BENCHMARKS.md`, first breakdown in `docs/ESCALATIONS.md`. `HPI_time` is null until a human records five runs per flow — the denominator is a person, not a build step |
| 11-16 — human parity | not started. See [`PHASES-HUMAN-PARITY.md`](PHASES-HUMAN-PARITY.md). The escalation log, not the file, decides the order — and it already argues for the contact-row de-duplication ahead of Phase 11 |

**Pick up here: the contact-row de-duplication, then Phase 11** — read
`docs/ESCALATIONS.md` first, which derives that order from the escalation log
rather than from the default in
[`PHASES-HUMAN-PARITY.md`](PHASES-HUMAN-PARITY.md). Phase 8 landed; what
follows in this section is the record of how its boundary was built, kept
because the reasoning is still what governs adding a third backend. It read
"pick up here" for two phases after it stopped being true, which is the third
time a stale status in this file has been mistaken for open work.

The Swift half is ready. `SimframeCore` — history, settle, transitions, hashing,
the frame store — imports no platform framework at all, verified rather than
assumed: no `CoreSimulator`, no `SimulatorKit`, no `IOSurface`, no
`NSClassFromString`, no `dlopen`. Everything simulator-specific is behind the
21-method `SimulatorPlatform` protocol in `PrivateAPI`, with `StubPlatform`
already proving the protocol is implementable by something that is not a
simulator.

**The JavaScript half now has one too — that was Phase 8 step 0.** Five modules
(`index.js`, `daemon.js`, `actions.js`, `mcp.js`, `cli.js`) imported
`src/simctl.js` directly. That file is now `src/platform/ios.js`, every function
in it is module-private, and the only way in is `src/platform/index.js`:

| File | What it is |
| --- | --- |
| `platform/index.js` | the boundary: `PLATFORM_SURFACE`, the `PLATFORMS` registry, `activePlatform()`, and one-line dispatch for each member |
| `platform/ios.js` | the iOS backend — the old `simctl.js`, exporting a single `platform` object and nothing else |
| `platform/host.js` | `resize`, which is host-side sips and never touches a device |

`resize` was on the list of eleven and did not belong there: it downscales a PNG
file. Behind the boundary each backend would have had to declare it, identically.
The remaining ten plus `permissionServices()` and `toolchain()` make up the
surface a backend must implement, and three tests hold it: every registered
backend provides the whole surface, a hand-written non-simulator fake satisfies
it, and no file above the boundary contains the string `'xcrun'`, `'adb'` or
`'idevice'`. That last one is the rule CLAUDE.md always stated and nothing had
ever checked.

`doctor`'s `xcrun` line now comes from `platform.toolchain()`, so the backend
names its own prerequisites and doctor stays one renderer.

**Step 1 made the dispatch device-keyed**, which is the part that had to exist
before a second backend rather than because of one. `listDevices` and
`bootedDevices` union the backends and stamp every record with the platform it
came from; `resolveDevice` asks each backend in turn; and the seven udid-taking
members route on the udid itself through `platformFor(udid)`.

Three decisions in there are worth not rediscovering:

- **Routing is synchronous and free.** `isBootedSync` is called from the capture
  loop, inside a daemon process that was handed a udid and never listed
  anything. So a backend answers `ownsUdid(udid)` from the id's shape — a
  simulator udid is a UUID, an emulator serial (`emulator-5554`) is not — and
  the seam remembers what any listing taught it. Nothing about routing touches a
  device.
- **An ambiguity outranks a match.** A backend that finds nothing is passed
  over; a backend that finds the query *ambiguous* throws with `ambiguous: true`
  and that error wins even when another backend matched exactly. Answering an
  ambiguous query with the other platform's device is the wrong-device bug
  wearing a different hat, and this project has already shipped two of those.
- **Cross-platform name collisions are reported, not guessed at.** Which of a
  simulator and an emulator a bare `iPhone`-ish query should prefer is a
  question for the step that adds the second backend.

`chooseBackend(udid, backends)` and `resolveAcross(query, opts, backends)` take
their backend list as an argument for exactly one reason: the routing is tested
against *two* backends today, with a fake second one, so the seam is not shaped
around whatever `android.js` happens to need when it arrives.

Two smaller things Android will meet immediately, both already recorded in
`docs/DEFERRED.md`: the confirm vocabulary is hardcoded English, and
`PERMISSION_SERVICES` is a list of simctl's service names, which has no meaning
on Android — that one is a real protocol question, not a rename.

Nothing else is outstanding. Every finding from the 0.6.0 review is closed, the
identity question is decided and measured, and the memory harness passes 33/33.

**What 2a turned out to be worth.** Measured before it was attempted, so the
payoff was known rather than assumed: a warm ten-step flow makes **zero**
accessibility reads, so no warm number was ever going to move. Measured after:
the tree read went from 203 ms to 45 ms on the same screen, which puts a first
visit back under OCR and makes the screen-map build OCR-bound. The case for it
was always the install story — idb was the last heavyweight requirement — and
that is what it delivered. It is not a perception-quality win: it changed who
reads the tree, not what the app publishes.

**Region bands from clustering: done, and do not re-open it from this file.**
The bands are derived from where the elements actually sit — a nav bar is a
short row at the top with a gap under it, not a fraction of screen height — with
the HIG fractions kept only for a screen too sparse to cluster. Chrome labels
entering identity fell from 14 to 6 and the distributions held; the numbers are
in `docs/DEFERRED.md` and `docs/BENCHMARKS.md`.

This paragraph used to say the opposite, and it outlived the fix by two phases.
It was read as open work twice, which is its own lesson about where a status
lives: the entry in `docs/DEFERRED.md` was marked fixed the day it was fixed,
and this one was not.

The class is not closed, though the cause has moved: on Android a browser's
address bar is chrome by every structural test there is — and correctly so —
which put `"== example.com"` into a screen's identity through the *label* rule
rather than the band rule. `TOKEN_RULES_VERSION` 3 requires a chrome label to be
a name: two letters at minimum, and not an address.

**One habit this project earned the hard way.** Three separate times, a first
measurement agreed with the hypothesis and was wrong — capture, the layout-hash
tolerance, and the 6c settle gate. Each was caught only by re-running it. Treat
a measurement that confirms what you expected as unfinished.

---

## Phase 0 — Scaffold the Swift daemon, prove framebuffer capture

**Why first:** capture is the most stable private-API surface and the biggest
latency win; proving it early de-risks everything else.

```
Read CLAUDE.md, then docs/research/01-architecture-audit.md §3.2 and the
"Stage 1" recommendation. Also read the current capture loop in src/ so you
understand the ~/.simframe/<udid>/ frame layout, meta.json ownership and the
atomic-rename contract that readers depend on.

Task: create a SwiftPM package at native/simframed with an executable target
`simframed`. It must:
1. Load CoreSimulator and SimulatorKit from the active Xcode
   (`xcode-select -p`), find the booted device (or the UDID passed as
   --udid), and open its SimDeviceIO client.
2. Register the IOSurface framebuffer change callback for the main display
   and, on each frame, read pixels via public IOSurface accessors.
3. Downscale to the same target size the Node loop uses, compute the same
   dHash the Node code computes (port it exactly — hashes must be
   byte-compatible so existing screen-memory keys keep working), and write
   frames into ~/.simframe/<udid>/ using the identical atomic-rename layout
   and meta.json fields. Existing Node readers (`simframe state/look/wait`)
   must work unchanged against frames produced by the daemon.
4. Put every private-framework call behind a `PrivateAPI` protocol in its own
   module, with a real implementation and a stub for tests.
5. Print per-frame capture latency and achieved fps to stderr every second.

Verify: run `swift build -c release`, start the daemon against a booted
simulator, then run `simframe state`, `simframe look`, `simframe wait` from
the Node CLI and confirm they read the daemon's frames. Record warm-frame
latency and fps (median of 200 frames) in docs/BENCHMARKS.md under
"Phase 0", with chip/Xcode/iOS/device.

Do not: touch input, a11y, OCR, or the Node CLI. Do not remove the old
simctl loop yet — leave it as fallback selected by `simframe start --engine=simctl`.
If a symbol cannot be resolved, inspect the frameworks with `nm`/`class-dump`
style tools and consult tddworks/baguette's ARCHITECTURE.md and
facebook/idb's FBFramebuffer.m for the exact names before guessing.
```

---

## Phase 1 — HID input through the daemon (replace idb)

```
Read CLAUDE.md and docs/research/01-architecture-audit.md §3.2, §3.7 and the
"Caveats" section on the iOS 26 HID change. Read tddworks/baguette's
ARCHITECTURE.md notes on IndigoHIDMessageForMouseNSEvent (9-argument
signature, digitizer target 0x32) and SimDeviceLegacyHIDClient.

Task: add a `Platform` protocol (frames, accessibilityTree, tap, swipe, drag,
longPress, type, key, launch, openURL, permission) to the daemon, and
implement the input half for iOS:
1. Open and warm the HID client once per device at daemon start.
2. tap(x,y), longPress, swipe(from,to,duration), drag, pinch: real
   down → interpolated move → up sequences with realistic timings (tap
   ~60–90 ms down; swipes eased, 200–400 ms default). Coordinates are in
   points; convert using the device's scale.
3. type(text): keyboard HID usages for ASCII; fall back to the paste path
   for non-ASCII/emoji. key(usage) for hardware keys (home, lock, volume).
4. Expose it over a per-UDID Unix socket (0600) with a tiny line-based JSON
   protocol, and add `simframe tap/swipe/type/key` CLI commands that talk to
   the socket. `simframe doctor` must show "input driver: simframed" when the
   daemon is up and fall back to idb (if installed) when it is not.

Verify: on a booted simulator, tap a tab bar item, swipe a list, type into a
search field, press home. Confirm with `simframe state --since` that each
produced the expected change. Record per-gesture socket round-trip latency
(median of 100) in docs/BENCHMARKS.md under "Phase 1".

Do not: use the 5-argument Indigo path. Do not remove idb support yet.
Do not implement accessibility or OCR in this phase.
```

---

## Phase 2 — Accessibility tree and OCR in-process

```
Read CLAUDE.md, docs/research/02-on-device-perception.md §2 and §6 (Tier 0,
Tier 1, data structures), and the existing sim_ui / screen-memory code in
src/ so the output format stays compatible.

Task: implement the perception half of `Platform` for iOS inside the daemon:
1. accessibilityTree(): via AccessibilityPlatformTranslation (AXPTranslator),
   returning elements with frame (points), role, label, identifier, value,
   and state {enabled, selected, focused}. Target ≤60 ms warm.
2. ocr(frame, roi?): Vision VNRecognizeTextRequest, .accurate,
   usesLanguageCorrection=false, on the current IOSurface (no PNG round
   trip). Return text boxes with confidence. Support a region of interest.
3. Define the shared `Element` and `ScreenMap` structs exactly as in the
   research doc §6 (id, frame, role, label, value, state, source bitmask,
   confidence). Emit them as JSON over the socket.
4. Port the existing layout-hash screen-memory cache into the daemon,
   preserving the hash algorithm and the ~/.simframe storage so memory
   built by the Node code is still valid.
5. `simframe ui` uses the daemon when available and shows per-element
   source (ax / ocr), as today.

Verify: on three screens (one with a full a11y tree, one with a custom tab
bar, one React Native or WebView screen), compare daemon output to the old
Node output — nothing the old path found may be missing. Record a11y and OCR
latency (median of 50) in docs/BENCHMARKS.md under "Phase 2".

Do not: add classical CV, templates, or any ML model yet. Do not change
what sim_ui returns to Claude beyond the source tag.
```

---

## Phase 2a — AXPTranslator in-process a11y tree

*(Written as "Phase 2b" while it was still scheduled; the delivered work is
called 2a everywhere else, and this heading now matches.)*

**Done.** The tree is read host-side, in-process, at 45 ms against idb's 203 ms
on the same screen. What unblocked it is recorded in `docs/PRIVATE_API.md` under
"Accessibility: the sequence that works" — two mistakes, not four leads: the
delegate token belongs to the `SimDevice` and must not be invented, and the
translation object is not the element (`AXPMacPlatformElement` wraps it in
something that answers ordinary `accessibilityAttributeValue:` calls).

The prompt that ran is kept below.

```
Read CLAUDE.md and docs/PRIVATE_API.md, in particular "Accessibility (partly
verified)" and "Probing pitfalls". Read the two reference implementations
directly rather than sweeping for constants — facebook/idb
(SimulatorFrameworkBridge/AXPAttributes.h, AccessibilityRuntime.m) for the
constants and semantics, valewnrt/testa (Sources/TestaEngine/TSTAccessibility.m)
for the host-side topology. They differ: idb reads in-guest, testa reads
host-side, and host-side is what suits a daemon.

Task: get an element tree out of the translator and implement
accessibilityTree() on the Platform protocol, returning the same Element shape
the OCR path already produces so sim_ui can merge them. Target 60ms warm.

Start from the failure that is already isolated, not from scratch: the bridge
works, the frontmost application resolves, and only the attribute read returns
nil.

Verify: on three screens (a full a11y tree, a custom tab bar, a React Native or
WebView screen), compare against `idb ui describe-all` at the same moment.
Nothing idb finds may be missing. Record a11y latency in docs/BENCHMARKS.md
under "Phase 2b", then remove idb from doctor's required list and from the
README.

Do not: inject anything into the guest. Do not regress the OCR path, which is
what carries a11y-poor screens today.
```

---

## Phase 3 — Cut over: daemon is the default engine

```
Read CLAUDE.md and docs/BENCHMARKS.md.

Task: make simframed the default for capture, input and perception.
1. `simframe start` builds (if needed) and launches the daemon; `--engine=simctl`
   keeps the old loop; idb becomes an optional fallback input driver only.
2. Rewrite `simframe doctor` to report each layer honestly: capture engine,
   input driver, a11y, OCR, and which is in use.
3. Update README sections "Install", "Capabilities are independent", "How it
   works", "Measured" and "Limitations" to describe the daemon. Replace the
   ASCII architecture diagram. Keep the tone and honesty of the existing
   README; cite numbers from docs/BENCHMARKS.md, not the research docs.
4. Add a `scripts/bench.sh` that reproduces every number in BENCHMARKS.md.

Verify: fresh clone on a machine with only Xcode installed: `npm install -g .`,
`simframe doctor`, `simframe start`, then the four-tab flow from the README via
`sim_do`. Record the three-run timings and compare to the README's
7370 → 5160 → 3304 ms.

Do not: delete the simctl loop or idb code paths; leave them behind flags.
Do not change the MCP tool names or schemas in this phase.
```

---

## Phase 4 — Settle detection and transition classification from frame history

```
Read CLAUDE.md and docs/research/02-on-device-perception.md §5.

Task: use the 60 fps frame stream to understand motion, all inside the daemon:
1. Settle: consecutive-frame dHash distance below threshold for N frames,
   with a separate "localized animation" detector (a small region changing
   every frame while the rest is still = spinner/loading, NOT settled).
2. Transition classifier over the frames between two settled states, using
   phase correlation (Accelerate/vDSP FFT) on a downscaled grayscale frame
   plus region-diff maps: push, pop, scroll (with pixel offset and
   direction), sheet-present/dismiss, alert-present/dismiss, keyboard
   up/down, toast, none.
3. Extend `simframe state` and `sim_state` output with
   `transition: {kind, offset?, confidence}` and `settled: bool`.
4. `sim_wait` and `sim_do` use the new settle logic; remove fixed sleeps.

Verify: script a set of known actions (push, pop, scroll by ~300pt, open
sheet, dismiss, focus a text field, blur it) and assert the classifier
labels each correctly on 20 repetitions. Record classifier latency in
docs/BENCHMARKS.md under "Phase 4".

Do not: change tap/type behavior. Do not add ML.
```

---

## Phase 5 — Element fusion, layout priors, intent matching

```
Read CLAUDE.md and docs/research/02-on-device-perception.md §1, §4 and §6
(fusion rules, HIG priors, intent matching, escalation thresholds).

Task: turn a11y + OCR + pixels into one trustworthy element list and resolve
intents locally:
1. Classical CV candidates (Vision VNDetectRectanglesRequest / contours) run
   only on regions the a11y tree leaves empty. Fuse by IoU: a11y wins on
   role/label; OCR fills labels; CV-only boxes get lower confidence.
   Dedupe at IoU > 0.6. Containers do not absorb their contents (keep the
   existing comparable-size rule).
2. HIG region priors: status bar, nav bar (leading/title/trailing), tab bar
   (2–5 segments, selected by tint), sheet, alert, keyboard. Attach `region`
   to each element.
3. System-icon template bank: render ~20 SF Symbols (chevron.left, xmark,
   gear, magnifyingglass, plus, ellipsis, checkmark, square.and.arrow.up,
   trash, line.3.horizontal…) at 3 sizes; NCC-match only inside label-less
   candidates; assign a synonym label ("Back", "Close", "Settings", …).
4. State heuristics for system controls: switch on/off by knob-side fill,
   selected tab by tint, disabled by contrast ratio.
5. Intent matching `resolve(intent) -> {element, score, alternatives}`:
   exact/case-insensitive → fuzzy (edit distance) → synonym table →
   NLEmbedding sentence cosine, with a role prior (e.g. "type email" prefers
   textfield). Return ambiguous when top-2 are within the threshold from the
   research doc; never guess.
6. `simframe find "<intent>"` CLI and `sim_find` MCP tool.

Verify: build a small eval set — 15 screens from 3 apps, capture (frame,
a11y tree) pairs, hide the a11y tree, and measure Tier 1 element recall and
label accuracy against it, plus intent top-1 accuracy on 30 hand-written
intents. Put the harness in test/perception/ and the results in
docs/BENCHMARKS.md under "Phase 5".

Do not: add any ML model. Do not send images to Claude to disambiguate —
report the ambiguity in text.
```

---

## Phase 6 — Transition graph and local action verification

```
Read CLAUDE.md, docs/research/02-on-device-perception.md §4 (AutoDroid /
transition graph) and §6 (escalation rules), and the README roadmap item
"Verify-after-tap".

Task:
1. Persist a per-app TransitionGraph in ~/.simframe/<udid>/graph/:
   edges (screen_hash, action) -> screen_hash' with counts and last-seen
   transition kind. Record an edge after every action the daemon performs.
2. Verify-after-tap: before acting, predict the outcome from the graph if an
   edge exists; after acting and settling, compare. Return one of
   {ok, no_visible_change, unexpected_transition, unexpected_screen} with
   the observed vs predicted hashes. `sim_do` stops at the first
   non-ok step and reports it instead of continuing blind.
3. Graph-assisted navigation: `simframe goto "<screen label or hash>"`
   plans a path through known edges and executes it with per-step
   verification, zero model calls.
4. Flow compilation: `sim_do` flows that complete with all-ok steps can be
   saved (`simframe flow save <name>`) and replayed (`simframe flow run
   <name>`) deterministically.

Verify: run the README four-tab flow three times; the third run must resolve
every step from graph+memory. Then deliberately break one step (e.g. a
label rename) and confirm the failure is reported at the right step with the
right verdict. Record numbers under "Phase 6".

Do not: use the graph to guess when a screen is unknown — an unknown screen
is an escalation, not a heuristic.
```

---

## Phase 7 — What Claude sees: compact state, milestone escalation, skill

```
Read CLAUDE.md, docs/research/01-architecture-audit.md §3.5–§3.6 (round-trip
reduction, MCP image token issue, CLI+skill) and
docs/research/02-on-device-perception.md §6 (compact text format, escalation
rules).

Task: reshape the agent-facing surface so Claude is consulted at milestones.
1. Every action/flow tool returns the compact text screen map from the
   research doc §6 (regions, numbered elements with role/label/state/frame
   and source, last-action verdict, ambiguities). No image is ever returned
   as a side effect. `sim_look` remains the only image path and downscales
   to ≤1024 px long edge.
2. Extend tools: sim_find, sim_tap(sel), sim_type_into(sel, text),
   sim_scroll_to(sel), sim_wait_for(sel|text), sim_assert(sel, cond),
   sim_goto, sim_flow_run, sim_open_url, sim_launch(args, env),
   sim_permission. Selectors: #ref | "label" | @x,y. Keep existing tools.
3. Write tool descriptions that steer the model: prefer sim_do with asserts
   over single steps; prefer sim_ui/sim_find over sim_look; call sim_look
   only when the text state is ambiguous or visual verification is
   explicitly requested. Keep descriptions short.
4. Add a Claude Code skill at skills/simframe/SKILL.md that teaches the
   CLI path (3–5 line outputs) as the preferred low-token route, with the
   escalation rules stated plainly.
5. Add a `--json` flag to every CLI command.

Verify: drive a 10-step flow through the MCP server with Claude Code and
count model turns and image returns; target ≤3 turns and 0 images for a
flow whose screens are in memory. Record under "Phase 7".

Do not: break existing tool names. Do not add server-side calls to any
model API.
```

---

## Phase 8 — Android backend behind the Platform boundary

**Step 0 is done: the boundary exists on both sides now.** The Swift half was
ready from Phase 0 — `SimframeCore` imports no platform framework, and the
21-method `SimulatorPlatform` protocol already has a non-simulator implementation
in `StubPlatform`. The JavaScript half caught up in `src/platform/`: `index.js`
is the boundary and the registry, `ios.js` is the old `simctl.js` with every
function module-private behind one exported `platform` object, `host.js` holds
`resize` because sips is host-side and not a device operation. `PLATFORM_SURFACE`
is the list a backend must satisfy; three tests enforce it, including one that
fails if any file above the boundary names `'xcrun'`, `'adb'` or `'idevice'`.

Verified as no behaviour change: 78 unit tests (up from 74 — the three boundary
tests plus a wrapper-name check), `scripts/ci-memory.mjs` green on every check,
`scripts/eval-fingerprint.mjs --tour=test/tours/device-native.json` separating at
gap 0.64, `simframe doctor --strict` all-ok, `check:package` shipping the new
directory, and the `sim_permission` tool description byte-identical.

**Step 1 is done too: dispatch is device-keyed.** `platformFor(udid)` routes
every udid-taking call, records carry their own `platform`, listings union the
backends, and `chooseBackend`/`resolveAcross` take their backend list as an
argument so both are tested against two backends before a second one exists.
Verified as no behaviour change: 81 unit tests, `ci-memory.mjs` 33/33 on a
restarted device, the eval separating at gap 0.65, `doctor --strict` all-ok, and
`devices --json` gaining exactly one additive field (`platform`).

**Step 2 landed `android.js`, and the boundary held.** `simframe ui` produced a
full screen map of an Android emulator — elements, points, refs, a structural
identity — with no change to any layer above `src/platform/`. The frame store,
the ring, the dHash, settle, the fingerprint, the screen map, refs and the graph
all ran unmodified on a platform they were never written for.

What Android can do today: list and resolve devices, launch and terminate an
app, open a URL, grant and revoke permissions, capture frames, and therefore
everything the perception and memory layers do on top of frames. What it cannot
do: act. There is no input path and no accessibility tree yet.

Three things step 2 found that were not in the plan:

- **Capture is 41 ms, and not over gRPC.** The plan said emulator gRPC
  streaming with a scrcpy fallback, and `adb screencap` as the slow stopgap.
  The emulator *console* — a plain TCP line protocol, no protobuf, no
  dependency — has `screenrecord screenshot <dir>`, which makes the emulator
  write the PNG onto the host filesystem with no device-to-host transfer at
  all: five times faster than adb screencap and in the same range as the iOS
  framebuffer callback. gRPC (port 8554, open and unused) is still the path to
  *streaming*; it is no longer the path to a frame.
- **`uiautomator dump` costs 2 s a read**, which is the real problem of the
  phase and the opposite shape from iOS's: nothing to batch, because the cost is
  a fresh instrumentation process per dump. The fast answer is a resident APK,
  which would be this project's first runtime dependency. Undecided, in
  `docs/DEFERRED.md`.
- **`pm grant` exits 0 while doing nothing** when the app never declared the
  permission — so `setPermission` reads the state back off the device and
  reports what is true rather than that adb ran. Same class as `am start`
  reporting its failures on stdout with a zero exit.

Two things above the boundary had to stop assuming iOS, and finding them is
what the step was for. Engine selection asked for the Swift daemon on every
device, so `simframe start` on an emulator failed with a message about
CoreSimulator; a platform now declares which capture engines it has. And
`doctor`, asked about an emulator, reported "input driver: idb" and
"accessibility tree: idb" — a claim about a tool that has never spoken to an
Android device — so a platform now declares its `capabilities`, and a layer it
does not have yet is reported `optional` with the reason instead of in the other
platform's vocabulary.

The capture loop was also renamed from `simctl` to `screenshot`, with `simctl`
kept as an alias. It no longer shells out to simctl on either platform: on
Android the same loop reaches the emulator console. A "downgrade" warning is
now only printed where a faster engine actually exists, because the screenshot
loop is the whole of Android's capture rather than a fallback from anything.

**Step 3 is done: Android acts.** The whole gesture vocabulary in one step, as
this said it should be — tap, swipe, type, keys — over the emulator console's
`event mouse` and `event text`, so `sim_tap` never existed on a platform where
`swipe` did not. `tapped "Notifications" at 138,207 (memory d=0, via ocr)` is
the shape of the result: driven by label, off OCR and screen memory, with no
accessibility tree in the loop.

Four things that step found, all of them recorded where they belong rather than
here: the coordinate space is device pixels and was settled by watching the
kernel report `0x3fff` for a point at half the screen; geometry had been falling
through to a guess derived from the capture image, so every Android tap point
would have been wrong; `waitFor` could report "no visible change" without having
observed a single frame, because the screenshot engine idles slower than the
reaction window; and `relaunch` did not mean a fresh start, because Android
restores a task's activity stack unless told not to.

The clipboard came with it, and it corrected a "not possible" note: adb has no
path to the Android clipboard, and the emulator's gRPC endpoint does —
`setClipboard`, reachable through Node's built-in `http2` in about forty lines,
because a unary gRPC call is an HTTP/2 POST with a five-byte header. No
dependency and no helper app.

**What is left on Android is the accessibility tree, and it is deliberately
conditional.** `docs/DEFERRED.md` has the criteria under Phase 8b, and the
measurement that informs them: every interactive element on six iOS screens came
from the tree, 83% of those controls carry no text at all, and yet screen
memory did not need the tree — 6/6 revisits recognised without it. The tier
earns its place in acting, not in recognising.

Two smaller things Android meets immediately, both in `docs/DEFERRED.md`: the
confirm vocabulary is hardcoded English, and `PERMISSION_SERVICES` is a list of
simctl's own service names with no Android meaning — that one is a genuine
protocol question, not a rename, because the two platforms do not have the same
permissions.

One thing to carry across rather than rediscover: **identity is settled by the
graph, not by whichever sensor answered.** Android's `AccessibilityNodeInfo`
tree will disagree with OCR about roles exactly as iOS's does — measured at
0.33–0.47 token agreement on the same screen — so the aliasing path is load
bearing on the second platform too, and `FINGERPRINT_VERSION` must be bumped if
the token rules change to accommodate it.

```
Read CLAUDE.md (Platform boundary) and skim both research docs for the
platform-agnostic parts (frame history, settle/transition, fusion, intent
matching, graph). Everything in those layers must work unchanged.

Task: implement `Platform` for the Android emulator using only public APIs:
1. Frames: emulator gRPC control API (streaming screenshot) with a scrcpy-
   style fallback; feed into the same frame pipeline and ~/.simframe/<serial>/
   layout.
2. Input: emulator gRPC sendTouch/sendKey; fall back to a persistent
   on-device UiAutomation agent when gRPC is unavailable (physical devices).
3. Accessibility: AccessibilityNodeInfo tree via the on-device agent, mapped
   into the same Element struct (bounds → frame, class → role,
   contentDescription/text → label, resource-id → identifier, clickable/
   checked/enabled/focused → state).
4. launch/openURL/permission via adb (`am start`, `pm grant`).
5. `simframe devices` lists both platforms; `doctor` reports per platform.

Verify: run the Phase 5 eval harness and the Phase 6 verification suite
against a sample Android app; nothing above the Platform boundary may need
a change. Record under "Phase 8".

Do not: import any Android-specific code above the Platform boundary.
```

---

## Optional Phase 9 — Tier-2 local model behind a flag

Only if the Phase 5 eval shows vision-only recall on a11y-poor screens is
below what you can live with. Read docs/research/02-on-device-perception.md §3
for the shortlist and license notes (avoid AGPL detector weights). Prompt to be
written after Phase 5 numbers exist — do not start it before.
