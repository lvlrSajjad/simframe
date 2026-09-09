# simframe — project instructions for Claude Code

simframe gives coding agents eyes, hands and memory for the iOS Simulator and
for Android emulators.
We are rebuilding the engine underneath it. These decisions are settled; do not
relitigate them. Rationale and benchmarks live in `docs/research/` — read the
relevant section when you need a symbol name, a number, or a threshold.

## Goal

A tool that drives the simulator at human speed with machine precision, where
Claude is consulted at **planning milestones**, not per step. Every per-step
decision (what is on screen, which element matches an intent, did the action
work, has the screen settled) is made locally in tens of milliseconds.

## Fixed decisions

**Engine.** A persistent Swift daemon (`simframed`, `arm64e`) replaces both
`simctl io screenshot` and `idb`. It links the private `CoreSimulator`,
`SimulatorKit` and `AccessibilityPlatformTranslation` frameworks plus public
`Vision`/`Accelerate`. Reference implementations we follow: `tddworks/baguette`
(capture + iOS 26 HID) and `valewnrt/testa` (a11y + OCR + warm daemon).

**Capture.** `SimDevice.io` IOSurface framebuffer callback
(`registerCallbackWithUUID:ioSurfacesChangeCallback:`), read via public
`IOSurface*` accessors. Target: ≤20 ms warm frame, up to 60 fps. Frames continue
to land in `~/.simframe/<udid>/` with the same atomic-rename layout so existing
readers keep working during the transition.

**Input.** Indigo HID through `SimDeviceLegacyHIDClient`, digitizer target
`0x32`. `docs/PRIVATE_API.md` is the source of truth for the signature and it
says **six** arguments on this Xcode, not the nine this file used to assert —
the binary states its own prototype as a string, which is how that was settled.
The 5-argument path used by idb/AXe is broken on iOS 26 — never use it.
Gestures are real down→move→up sequences with realistic timing, never
teleporting taps. Warm the HID session once per device.

**Perception order (strict).**
1. Accessibility tree via `AXPTranslator` — read host-side, in-process, since
   0.6.0. Authoritative when present, and *not* authoritative about screen
   identity: the tree and OCR agree on 0.33–0.47 of a screen's structural
   tokens and never on its hash, so identity is settled by the graph rather
   than by whichever sensor answered. See `docs/DEFERRED.md`.
2. Apple Vision OCR (`VNRecognizeTextRequest`, `.accurate`, language correction
   off) + classical CV (contours/rectangles) + iOS layout priors + system-icon
   templates, **fused** into the same element list, only for gaps in (1).
3. A small local model, behind a feature flag, only when (1)+(2) are ambiguous.
4. Claude.

**Output to Claude.** Compact text by default: element list, regions, what
changed since the agent's last look, last-action verdict. Images only on
explicit `sim_look`, pre-downscaled to ≤1024 px on the long edge. Never return
an image as a side effect of an action.

**Memory.** Layout-hash → element map (exists; keep it). Add a transition graph
`(screen_hash, action) → screen_hash'` so repeated flows need zero model calls.

**Transport.** Per-UDID `0600` Unix socket + thin CLI. MCP server and a Claude
Code skill are thin front-ends over the CLI. One writer per device, as today.

**Platform boundary.** All simulator-specific code sits behind a `Platform`
protocol (frames, accessibilityTree, tap/swipe/type/key, launch/openURL/
permission). Nothing above the boundary may import a platform framework or name
a platform tool. In Swift that is `SimulatorPlatform` in `PrivateAPI`; in
JavaScript it is `src/platform/`, whose `index.js` is the only door — a backend
exports one object and no functions, and a test fails if any file above the
boundary contains `'xcrun'`, `'adb'` or `'idevice'`. That rule was stated here
for three phases before anything checked it, and the JavaScript half had quietly
never obeyed it.

Android is the second backend and it is real, not planned: `src/platform/
android.js` lists devices, launches apps, grants permissions and captures frames
through the emulator console — 20 ms for a screenshot, 41 ms for a frame with
the resize that makes it readable — and every layer above the boundary — the
frame store, settle, the fingerprint, the screen map, refs, the graph — runs on
it unmodified. It acts, too, since 0.7.0: tap, swipe, text and keys over the
console, and the clipboard over the emulator's gRPC endpoint. What it does not
have is an accessibility tree, and it says so rather than borrowing the other
platform's vocabulary. Two rules follow from that and both are load bearing. A backend declares
its own `capabilities`, because `doctor` asked about an emulator once reported
"input driver: idb", which is a claim about a tool that has never spoken to an
Android device. And a layer a platform does not have is `optional` with a
reason, never the other platform's vocabulary.

## Non-goals (for now)

Physical devices. Shipping any ML model weights. Removing the Node CLI/MCP
before the Swift daemon is at parity. Localised confirm vocabulary (tracked,
not this rebuild).

## Working rules

- Every private-framework call goes through a single `PrivateAPI` module with a
  protocol so a signature change is a one-file fix and tests can mock it.
- Measure before and after. Every phase ends with numbers appended to
  `docs/BENCHMARKS.md` (chip, Xcode, iOS, device type, N runs, median).
- Degrade rather than fail: if a layer is unavailable, report which and keep
  the layers below working. `simframe doctor` must reflect every layer.
- Do not add npm dependencies. The only runtime dependency stays the MCP SDK.
- The release workflow, `server.json` and package versions are **not** ordinary
  files: change them only when the task is explicitly a release or a fix to the
  release path, and say what you are changing and why before you do it. The rule
  used to be "do not touch", and it was right about the risk and wrong about the
  remedy — a release path nobody may repair fails silently, which is what
  happened. `v0.5.1` was tagged, released on GitHub, and never reached npm for a
  week because `npm install -g npm@latest` had started requiring a newer Node
  than the runner had. Five distinct faults in that pipeline were found and
  fixed in one afternoon, every one of them invisible from a green local build.
  `npm version` is the only way to bump a version, because its hook keeps
  `server.json` in step.
- Prefer small commits per phase step; run existing tests before and after.

## Layout

- `src/` Node CLI + MCP server (kept; becomes a thin client)
- `native/` Swift sources — the daemon lives here as a SwiftPM package
- `docs/research/` the two research reports (architecture audit; on-device perception)
- `docs/PHASES.md` the phased build plan and the prompt for each phase
- `docs/BENCHMARKS.md` measured numbers, appended per phase

## Human parity (Phases 10–16)

The goal of this series is that an agent using simframe reaches or beats a
human tester's speed and accuracy. Rationale and sources are in
`docs/research/03-human-parity.md`; prompts are in `docs/PHASES-HUMAN-PARITY.md`.

**Fixed decisions.**

- Every phase is scored on two numbers: **model turns removed** and **Human
  Parity Index** (`simframe hpi`). A phase that does not move one of them is
  not done.
- The **escalation log** (`~/.simframe/<udid>/escalations.jsonl`, schema in
  research §8) is the steering wheel. After Phase 10, the reason breakdown in
  `docs/ESCALATIONS.md` decides which faculty is built next; the default order
  in PHASES-HUMAN-PARITY.md is a default, not a commitment. Every escalation
  must carry one of the five reasons; "unknown" is not a reason.
- **Verify barrier.** Nothing local — reflex, speculation, exploration, icon
  inference — may perform an action whose label matches the destructive
  vocabulary (Delete, Remove, Pay, Send, Sign out, Reset…), leaves the app, or
  runs on an edge with a prior `unexpected-*` verdict. Those wait for confirmed
  perception; when in doubt, escalate. A model call is cheaper than a wrong tap.
- **Reflexes are data, not code.** Trigger → action → escalate-instead lives in
  a locale-keyed file. A reflex fires at most once per trigger per screen; the
  second occurrence is an escalation. Every firing is logged and shown to the
  human in the flow summary.
- **Waiting is learned, not fixed.** No fixed sleeps anywhere after Phase 11.
  Timeouts are p95 + margin per graph edge; the hard cap is 10 s.
- **Perception is incremental with a safety valve.** ROI/damage-rect perception
  always falls back to full perception on an unrecognised fingerprint and
  unconditionally every 10th settle. Full perception stays as ground truth for
  the perception eval harness.
- **Exploration is bounded.** Six actions per attempt, then escalate with the
  partial map attached. Never explore when a graph path exists.
- **Human baselines are measured, not assumed.** `simframe baseline` records
  real humans on the same simulator; medians and IQR, N≥5, re-collected when
  the app changes. HPI is a trend metric, not a claim.
- **CI gates on HPI.** The `bench` job fails on a >10% HPI_time regression or
  any HPI_accuracy drop against the committed baseline.

**Still deferred:** Phase 9 (Tier-2 local model), Android accessibility APK
(8b), non-English reflex/confirm vocabulary.
