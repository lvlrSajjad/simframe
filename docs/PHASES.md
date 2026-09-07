# simframe 2.0 — phased build plan

One phase per Claude Code session. Each prompt names what to read, what to
build, what not to do, and how the phase is verified. Run them in order; each
phase leaves the tool fully working. Copy the prompt block verbatim, then adjust
the `docs/research/…` filenames to match what you committed.

Phases 0–2 are the engine (capture, input, a11y). Phase 3 replaces idb and
simctl for good. Phases 4–6 add local perception and memory. Phase 7 reshapes
what Claude sees. Phase 8 is the second platform.

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
