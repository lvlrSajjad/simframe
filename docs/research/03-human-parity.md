# Toward Human-Parity iOS/Android UI Testing in simframe: Measurement Protocol and a Phased Faculty Build Plan

## TL;DR
- **Human parity is achievable and measurable, but the target is a moving ratio, not a single number.** The dominant cost in agent UI testing is model calls (planning/reflection/judging consume >90% of latency on OSWorld, and leading agents take 2.7–4.3x more steps than humans); simframe should define a "Human Parity Index" = agent_wall_time / median_human_wall_time per flow, plus an accuracy term, and track it in CI. Every faculty below is justified by how much it removes model turns, not by how clever it is.
- **Build the six faculties in escalation-log-prioritized order:** instrument first, then (1) sense of time / adaptive waiting and (2) reflexes/local recovery (cheapest, highest turn-savings, lowest risk), then (3) attention/ROI perception and (4) anticipation/prefetch, then (5) goal-directed exploration and (6) icon semantics. Ground each phase's go/no-go decision in the "avoidable escalation rate" from an instrumented escalation log.
- **The evidence base is strong for the recommended techniques:** Apple Vision `regionOfInterest`, SimulatorKit `damageRectanglesCallback` (already in idb's framebuffer code), `simctl privacy`/`status_bar` pre-emptive controls, `addUIInterruptionMonitor`/Appium auto-accept for reflexes, AutoDroid-style UTG memory injection for exploration (13.7% fewer LLM calls, prompt tokens 625.3→339.0), and a <5 MB Core ML icon classifier (RICO's ~100 icon classes, 94–96% CNN accuracy, sub-millisecond inference on the Neural Engine). These are all buildable without any large local ML model.

## Key Findings

### The measurement problem is the real deliverable
The single most important, best-sourced finding is that **agent inefficiency is overwhelmingly a model-call problem, not a perception or actuation problem.** The OSWorld-Human paper (Abhyankar, Qi & Zhang, UCSD/GenseeAI, arXiv 2506.16042, MLSys 2026) profiled Agent S2 and GTA1 and found the planning step alone accounts for "more than half, sometimes close to 75% of the total task latency," with judging/reflection the second-biggest sink (22.5% for GTA1, 33.6% for Agent S2). System-level operations (screenshot, click) "contribute minimally." Later steps take up to 3x longer than early ones. Their human-annotated trajectories for all 369 OSWorld tasks show even the best agents take **2.7–4.3x more steps than necessary**. This directly validates simframe's whole thesis: giving the agent eyes/hands/memory locally so Claude is consulted less is exactly the lever that matters. Every faculty should be scored by "model turns removed."

Human baselines in mobile agent benchmarks exist but are coarse: **AndroidWorld** (Rawles et al., Google DeepMind, arXiv 2405.14573) states verbatim, "On ANDROIDWORLD, M3A achieves a 30.6% success rate, which surpasses that of a web agent adapted for Android but remains significantly lower than the human success rate of 80.0%" — a success gap, but AndroidWorld does not publish human *time/step* baselines. **AndroidControl** (Li et al. 2024) is 7,708 human-collected tasks across 1,412 trajectories with success-rate and action-type-accuracy metrics but is a static demonstration dataset, not a timing baseline. GUI-Odyssey, AitW, and Mobile-Agent benchmarks similarly lack human wall-time baselines. **Conclusion: no existing mobile benchmark gives simframe a human time baseline; simframe must collect its own**, which is feasible because the daemon already records frame history and a HID event log.

### Human timing constants (measured vs estimated)
From the Touch-Level Model / KLM literature and Fitts's-law touchscreen studies:
- **Simple visual reaction time ≈ 213–231 ms** (measured): Woods et al. 2015, "Factors influencing the latency of simple reaction time" (PMC4374455), a community sample of 1,469 subjects, found "Mean SRT latencies were short (231, 213 ms when corrected for hardware delays) and increased significantly with age (0.55 ms/year)." On a touchscreen, add sampling/render latency (tens of ms), so ~300 ms is a realistic population average per tap.
- **Touchscreen movement time** fits Fitts's law: measured regression **MT = 336 + 72.72·ID (ms)** on a Galaxy Tab (Creating Fitts' Law Predictions for a Touchscreen Tablet, 2016).
- **KLM operators (measured, Card/Moran/Newell 1983):** K (keystroke) = 0.20 s; P (mouse point) = 1.1 s; H (homing) = 0.4 s; **M (mental operator) = 1.35 s**. Note: the "1.2 s" figure sometimes cited is actually the non-typist worst-case K value, not M.
- **Touch movement components (measured, El Batran & Dunlop 2014, MobileHCI):** short untargeted swipe ≈ **70 ms**; half-screen zoom ≈ **200 ms**; icon point-from-home ≈ **80 ms** — valid up to index of difficulty ≈ 4 bits.
- **TLM operators (Rice & Lartigue 2014) are conceptual only** — the paper defines Tap (T), Swipe (S), Drag (D), Pinch (P), Zoom (Z), Initial Act (I), Gesture (G), Tilt/Rotate but **published no measured second-values.** Do not attribute specific numbers to TLM operators. The Fingerstroke-Level Model (Lee et al. 2015, Human Movement Science) does provide measured fingerstroke times for gaming interaction.
- **Nielsen/Miller response-time constants (design constants):** from Jakob Nielsen, *Usability Engineering* (1993), citing Miller 1968 and Card et al. 1991: "0.1 second is about the limit for having the user feel that the system is reacting instantaneously... 1.0 second is about the limit for the user's flow of thought to stay uninterrupted... 10 seconds is about the limit for keeping the user's attention focused on the dialogue." These are the right thresholds for simframe's "slower than usual" detection and adaptive-wait UX.

A human tester on a mobile flow therefore spends roughly M (~1.35 s think) + movement (~0.1–0.3 s) + system response per step, i.e., a well-known screen step is ~1.5–2 s. An agent that makes a model call per step pays seconds-to-tens-of-seconds per step in model latency. **The parity gap is almost entirely the M-operator being replaced by a multi-second LLM call.** Faculties that let simframe skip the LLM call on routine steps convert the agent's per-step "M" from seconds back toward the human 1.35 s.

### Attention / ROI perception
Apple's Vision framework supports **`regionOfInterest`** on `VNRecognizeTextRequest` (and other image-based requests): a normalized rect (default `{% raw %}{{0,0},{1,1}}{% endraw %}`, **bottom-left origin**), and Vision only processes that sub-region, reducing memory/CPU and latency. Critically, **observation bounding boxes are still returned in the full-image (identity) coordinate space**, not the ROI's space (confirmed on Apple Developer Forums for VNCoreMLRequest), which simplifies fusing ROI OCR back into the full element map. There is also a `preferBackgroundProcessing` hint to reduce contention so Vision does not block rendering.

For "where is the dirty region?", simframe's underlying `SimulatorKit`/`FBFramebuffer` stack already exposes a **`damageRectanglesCallback`** — visible in idb's `FBSimulatorControl/Framebuffer/FBFramebuffer.m`, which registers `damageRectanglesCallback:^(NSArray<NSValue *> *frames)` and forwards each `didReceiveDamageRect:`. This is the OS telling you exactly which rectangles changed — a native damage-rect signal that most GUI agents lack. Combined with simframe's existing dHash settle detection, this gives a precise "re-OCR only these rects" pipeline.

The GUI-agent research analogue is **crop-and-zoom / ROI grounding**: Ferret-UI (Apple, arXiv 2404.05719) handles small UI widgets via referring/grounding on raw pixels; UI-TARS, OmniParser, and a wave of 2025–2026 "zoom" papers (RegionFocus/Visual Test-time Scaling, UI-Zoomer, ZoomClick, GUI-Lens, DRS-GUI) show dynamic zoom into relevant regions yields large grounding gains (UI-Zoomer +13.4% on ScreenSpot-Pro; RegionFocus lifts UI-TARS-7B several points on icon/widget cases). The lesson: **narrowing perception to a predicted region both speeds perception and improves accuracy.** simframe's advantage is it can compute the ROI *structurally* (from the transition graph + tapped element frame) rather than paying a VLM to zoom.

### Anticipation / overlapping perception and action
Human eye-hand coordination provides the model: **"just-in-time" and "look-ahead" fixations** (Land & Hayhoe 2001; Mennie, Hayhoe & Sullivan 2007, Experimental Brain Research). Humans fixate the *next* target seconds before acting on it; a look-ahead fixation to a target was measured to increase the subsequent eye-hand latency by 122 ms, evidence the brain pre-loads the next action's spatial info. Land & Hayhoe categorize fixations as locating (look-ahead), directing, guiding, and checking. The robotics analogue is **action chunking** (ACT, Zhao et al.; Diffusion Policy; π0): the policy emits a horizon of H future actions and executes K≤H before re-querying, cutting inference frequency and compounding error. Recent work (PACE; adaptive execution horizon) tunes how much of the chunk to trust before re-checking.

For simframe this maps to: **while a transition animates, prefetch the predicted destination screen's element map from the transition graph and speculatively resolve the next target; confirm on arrival via the screen fingerprint.** Safe to speculate on: which screen you'll land on, where the next tap target probably is, pre-warming OCR ROI. Must always be confirmed before an irreversible/destructive action: the actual fingerprint match, and anything that submits, pays, deletes, or leaves the app. This is "speculative execution with a verify barrier."

### Reflexes / local recovery without a model
Existing frameworks already handle interruptions locally, which simframe should copy:
- **iOS system alerts:** XCUITest's `addUIInterruptionMonitor(withDescription:)` registers a handler that taps a button on a system alert. Appium exposes `autoAcceptAlerts`/`autoDismissAlerts` capabilities and an `acceptAlertButtonSelector` (e.g., a class-chain to tap "Allow Once"). Note the documented iOS 13+ gotcha: for 3-button popups, the accept/dismiss behavior flips. Maestro handles iOS permissions at `launchApp`.
- **Pre-emptive controls (better than reacting):** `simctl privacy booted grant/revoke/reset <service> <bundle>` (photos, camera, location, contacts, calendar, microphone, etc.); `simctl status_bar override` to pin a clean status bar (9:41, full battery/signal) for stable fingerprints; on Android `adb shell pm grant/revoke` and `adb shell settings put global window_animation_scale/transition_animation_scale/animator_duration_scale 0` to disable animations (which also makes settle detection near-instantaneous). Note the ATT/tracking prompt is **not** grantable via `simctl` and needs a UI reflex.
- **Idleness/synchronization models:** Espresso `IdlingResource`/`onIdle()` (main-thread + registered async idle), Detox/DetoxSync (tracks animations, network requests, timers, dispatch queues, and delayed selectors — its logs enumerate "View animations pending," "enqueued native timers," etc.), Playwright network-idle. simframe can't instrument the app, so it approximates idleness from the *outside* via frame-diff settle + damage rects, plus optional process CPU (`simctl spawn`/`top`) and network (`nettop`).

The recommendation is a **reflex table** (trigger pattern → local action → escalate-instead condition) that fires without a model call and logs every firing.

### Goal-directed local exploration when lost
The strongest quantified evidence comes from **AutoDroid** (Wen et al., arXiv 2308.15272): pre-exploring an app to build a UI Transition Graph injected as memory yields **13.7% fewer LLM calls per task** and a 38.02% reduction in steps requiring LLM inference; its GUI merging "reduc[es] the token count by nearly half (339.0 on average)" from a 625.3-token baseline, which "reduces cloud cost... from $0.938 and $18.76 to $0.509 and $10.17 every 1000 queries" for GPT-3.5/GPT-4 respectively and "reduces inference latency by 21.3% on average" on device; UI pruning/merging shrank the action space from 36.4 to 13.2 choices per state; it reached 90.9% action accuracy / 71.3% task completion on 158 tasks. **AutoDroid-V2** reframes as code generation and reports large token reductions at ~2.1 s latency. Classic model-based explorers — DroidBot, Stoat (Gibbs-sampling stochastic model, +17–31% code coverage, 3x crashes vs Monkey), Humanoid (43.3% line coverage), **Fastbot2** (probabilistic memory of event→activity transitions + UCB/RL, beats Monkey/APE/Stoat on coverage and fault detection on billion-install apps) — establish that **remembered transition knowledge + novelty-guided exploration efficiently reaches targets.** Agent-S/S2 (arXiv 2410.08164) add narrative + episodic memory in a closed loop. simframe already has a transition graph and screen memory, so it is one step from "when lost, run a bounded exploration and write what you learn back into the graph."

### Icon semantics without a large model
**Feasible with a tiny model.** The RICO dataset (Deka et al. 2017, 72k screenshots) plus Liu et al. 2018 "Learning Design Semantics for Mobile Apps" define **~100 common icon classes** (99 icon classes / 135 icon concepts) and train a CNN to **94% icon-classification accuracy**; the follow-up "Towards Complete Icon Labeling" (CHI 2022) reports **96.3% test accuracy, 92.4% macro-precision, 89.5% macro-recall** and detects nearby text (95.3%) and modifier badges (87.4%) — exactly the contextual disambiguation simframe needs (a gear in the tab bar = Settings). On Apple platforms, a template bank can be rendered directly from **SF Symbols 7** — per Apple, "a library of over 6,900 symbols... available in apps running iOS 26, iPadOS 26, macOS 26, watchOS 26, tvOS 26, and visionOS 26" — via `NSImage(systemSymbolName:)`, matched with tint-invariant normalized cross-correlation (luminance/alpha masks, multi-scale); Android has Material Symbols. **Latency is a non-issue:** Apple's MobileOne runs a 1000-class 224×224 ImageNet model in **<1 ms on an iPhone 12** (arXiv 2206.04040, measured, full round-trip over 1000 runs), and MobileNetV2 runs <1 ms on the iPhone 15 Pro Neural Engine (Apple, vendor-published). A ~100-class classifier on a 48–64 px icon crop will run **well under 5 ms** — the <5 MB / <5 ms target is realistic and conservative.

### A sense of time / adaptive waiting
Replace fixed sleeps (still in `actions.js`) with **learned per-edge timing**: record each transition-graph edge's observed durations, set the adaptive timeout at **p95 of observed durations + margin**, and flag "slower than usual" (e.g., current > p95) as a signal to keep waiting vs escalate. Anchor the human-perception constants (0.1 / 1 / 10 s) as design bounds. Detect spinners/skeleton screens via the existing transition classifier. This is pure bookkeeping over data simframe already collects and removes the single most common source of both wasted wall time (over-waiting) and flakiness (under-waiting).

### Instrumentation: the escalation log is the steering wheel
Every faculty must log why the slow layer (Claude) was consulted. Prior art: Agent-S reflection logs, OSWorld trajectory format, AutoDroid's memory hit/miss accounting, Anthropic computer-use logging guidance. This log, aggregated into an **"avoidable escalation rate,"** is what prioritizes the next faculty and gates each phase.

## Details

### 1. Measurement protocol and the Human Parity Index (HPI)

**Per-flow metrics simframe should emit (JSON, one record per flow run):**
- `wall_time_ms` (end-to-end)
- `steps_taken`, `min_steps` (from a human/authored reference trajectory), `step_ratio = steps_taken/min_steps`
- `model_turns` (Claude calls), `images_sent`, `input_tokens`, `output_tokens`
- `escalations[]` with reasons (see §8) and `escalation_count`
- `mis_taps` (taps producing `no-visible-change` or `unexpected-transition`)
- `verdict_histogram` over {ok, no-visible-change, unexpected-screen, unexpected-transition, unverified}
- `reflex_firings[]`, `exploration_events[]`
- `completed` (bool) and `wrong_action_taken` (bool)

**Human baseline collection method:** have N (recommend N≥5, ideally 7–10) human testers perform each canonical flow on the *same* booted simulator while the daemon records frame history + the HID event log. Derive per-flow human `wall_time` (median + IQR), human `step count` (the minimum-steps reference), and inter-tap intervals. Because HID events are already logged, this is essentially free instrumentation. Store as `docs/research/human-baselines/<flow>.json`.

**Human Parity Index (proposed definition):**
- `HPI_time(flow) = median_human_wall_time / agent_wall_time` (so 1.0 = parity, >1.0 = agent faster than human).
- `HPI_accuracy = flows_completed_without_wrong_action / total_flows`.
- Report a combined **`HPI = HPI_accuracy × harmonic_mean_over_flows(HPI_time)`** so that a fast agent that takes wrong actions is penalized. Also report the OSWorld-style `step_ratio` (target ≤1.5, since even top OSWorld agents sit at 2.7x).

**CI integration:** add a `bench` job that runs the flow suite on a pinned simulator image, computes HPI and step_ratio, writes `docs/BENCHMARKS.md` deltas, and **fails the build if HPI_time regresses >10% or HPI_accuracy drops at all** vs the committed baseline. Track the trend as a committed JSON so each PR shows the movement. Flag every number as measured (from runs) vs the human baseline (measured once per flow, re-collected quarterly).

### 2. Attention / ROI perception — recommended algorithm
1. On settle, consume `damageRectanglesCallback` rects (union, dilated by a few px) OR compute changed regions from the frame diff already used for dHash.
2. Map the transition graph's expected-change regions (tapped element frame; band below a focused text field; top toast band; nav-bar title area) into a **prior ROI set**.
3. Run `VNRecognizeTextRequest` with `regionOfInterest` set to each ROI (normalized, bottom-left origin); merge results into the existing fused element list using the full-image coordinates Vision returns.
4. Only re-run accessibility/CV on elements intersecting dirty rects; keep the rest from screen memory.

**Expected effect:** perception latency drops roughly in proportion to (dirty area / full area) — often 5–20% of the screen changes between steps, so this is a multiple-x perception speedup and, more importantly, it makes "changed since the agent's last look" cheap enough to run every step without a model call. **Risk:** damage rects can under-report (GPU-composited animations) — always fall back to a full re-perception when the fingerprint doesn't match any known screen, and periodically (every k steps) do a full sweep to catch drift.

### 3. Anticipation / overlapping perception and action — recommended algorithm
1. On issuing a tap that the transition graph says leads to screen S', immediately (a) load S's element map from screen memory and (b) start the settle/transition classifier.
2. Speculatively resolve the next flow step's target against S's cached map; pre-compute its ROI.
3. On arrival, compute the fingerprint. If it matches S', the speculative target is confirmed and executed with **no model call**. If it doesn't match (unexpected-screen), discard speculation and escalate/reflex.
4. Never speculatively execute a destructive/irreversible action; those wait for confirmed fingerprint.

**Expected effect:** overlapping perception with the animation window (typically 200–500 ms) hides perception latency entirely on the happy path, and confirmed speculation removes a model turn on every predictable transition. **Risk:** mis-speculation wastes one perception cycle (cheap) but must never cause a wrong tap — hence the verify barrier before any state-changing action.

### 4. Reflexes / local recovery — the reflex table

| Trigger pattern (detected locally) | Local reflex action | Escalate instead when |
|---|---|---|
| iOS permission alert (camera/location/notifications/photos/contacts/Bluetooth) | Prefer pre-emptive `simctl privacy grant`; else tap the flow-appropriate button via a11y | Unknown/3-button variant not in vocab |
| ATT / "Allow Tracking" prompt | UI tap (not grantable via simctl) | Button labels unrecognized |
| App Store rating / "rate this app" | Dismiss ("Not Now") | Appears mid-critical-flow |
| "Software Update" / system nag | Dismiss / Later | — |
| Keyboard suggestion bar / autofill | Ignore or dismiss | Blocks target element |
| Face ID / passcode sheet | `simctl` biometric match if enrolled | Passcode required |
| Wrong push (unexpected-screen) | Back out once (nav back / swipe) | Second wrong screen in a row |
| Spinner persists < p95 edge time | Keep waiting (adaptive) | Exceeds p95 + margin |
| App wedged / no change after retry | Relaunch app once | Wedged after relaunch |
| Transient failure (no-visible-change) | Retry once with jittered backoff | Second identical failure |
| Android permission dialog / ANR / crash | `pm grant` pre-emptive; dismiss ANR; capture crash | Repeated crash |

Every firing logs `{trigger, action, outcome, screen_fingerprint}`. Confirm vocabulary is English-only today (a known deferred limitation) — the table should be data-driven so locales can be added.

**Expected effect:** interruptions are the highest-frequency avoidable escalation in real testing; handling them locally can eliminate a large fraction of "novel_dialog" escalations. **Risk:** auto-accepting a permission can mask a real bug — so record every reflex firing and surface a per-run reflex summary so a human can audit what was auto-dismissed.

### 5. Goal-directed local exploration — recommended algorithm
When the target element is not on the current screen and no plan exists, run a **bounded exploration budget** (e.g., ≤ B=6 actions) before escalating:
1. **Deep-link bypass first** if a known URL scheme exists (`simctl openurl` / `adb am start -d`) — cheapest.
2. **Scroll-to-reveal:** scroll the main scrollable until the target label/icon appears or the frame stops changing (list exhausted).
3. **Tab-first:** open the tab whose label is semantically closest to the goal (string/embedding similarity; NLEmbedding intent matching is deferred but a simple token/edit-distance match works now).
4. **Search field:** if a search affordance exists, type the goal noun.
5. Write every discovered `(screen, action) → screen'` edge back into the transition graph so the next run is a memory hit.

**Expected effect:** AutoDroid's measured 13.7% fewer LLM calls, 625.3→339.0 prompt tokens, and 21.3% lower inference latency are the reference; simframe should target a similar reduction in "no_plan"/"unknown_screen" escalations as the graph fills. **Risk:** unbounded exploration burns wall time — hence a hard budget B and a rule to escalate with the partial map attached rather than wander.

### 6. Icon semantics — recommended algorithm
1. **Template-first (zero training):** render SF Symbols 7 (over 6,900 symbols) and Material Symbols to a template bank; match unlabeled icon crops with multi-scale, tint-invariant normalized cross-correlation on luminance/alpha masks. This alone labels most standard system icons (gear, share, back, trash, plus).
2. **Tiny CNN fallback:** ship a <5 MB Core ML classifier over the ~100 RICO icon classes (94–96% accuracy in the literature) for custom/app icons; runs <5 ms on the Neural Engine (MobileOne <1 ms on iPhone 12 is the measured proof point).
3. **Context disambiguation:** use tab-bar/nav-bar position, adjacent label, and badge to resolve ambiguity (literature: nearby text 95.3%, modifiers 87.4%).

**Expected effect:** removes icon-labeling round-trips to Claude (a common "ambiguous_intent" escalation) and improves target resolution on icon-only chrome. **Risk:** a wrong icon label could cause a wrong tap — gate icon-only taps behind the verify-after-tap verdict, and treat low-confidence matches as an escalation, not a guess.

### 7. Sense of time — recommended algorithm
Per transition-graph edge, maintain a rolling distribution of observed durations; set `timeout = p95 + margin`, treat `> p95` as "slower than usual" (keep waiting up to a hard cap, then escalate with timing context), and retire fixed sleeps in `actions.js`. Use spinner/skeleton detection from the transition classifier to distinguish "loading" from "stuck." Anchor UX to Nielsen's 0.1/1/10 s constants. **Expected effect:** eliminates both over-waiting (wall-time savings) and under-waiting flakiness (accuracy). **Risk:** cold edges have no history — use a conservative global default until ≥5 samples accumulate.

### 8. Escalation log schema and avoidable-escalation rate
Proposed per-escalation record:
```
{
  timestamp, flow_id, step_index, screen_fingerprint,
  reason ∈ {unknown_screen, ambiguous_intent, verification_failed,
            novel_dialog, no_plan},
  candidate_elements: [...],
  reflex_or_exploration_tried: [...],
  outcome ∈ {resolved_locally, escalated_to_model, failed},
  model_turns_spent, tokens_spent, wall_time_ms
}
```
Aggregate **avoidable_escalation_rate = (escalations whose reason maps to a not-yet-built or under-performing faculty) / total_escalations.** Break down by reason to see which faculty would remove the most turns next. This is the single dashboard that drives phase ordering.

## Recommendations

**Phase ordering (go/no-go gated on the escalation log):**

1. **Phase A — Instrumentation + Measurement (build first, always).** Implement the escalation log (§8), per-flow metrics (§1), human-baseline collection, HPI, and the CI `bench` job. *Go/no-go to proceed:* you can compute HPI and a reason-broken-down avoidable-escalation rate for the flow suite. Without this you're flying blind; nothing else is prioritizable.

2. **Phase B — Sense of time / adaptive waiting (§7).** Cheapest, pure bookkeeping, immediate wall-time + flakiness win, zero model risk. *Go criteria to move on:* fixed sleeps removed; p95 timeouts live; measured wall-time reduction on the suite.

3. **Phase C — Reflexes / local recovery (§4).** Highest-frequency avoidable escalation ("novel_dialog"), low risk with pre-emptive `simctl privacy`/`status_bar` + animation-disable. *Go criteria:* novel_dialog escalation rate drops to near-zero on the suite; every firing logged and auditable.

4. **Phase D — Attention / ROI perception (§2).** Leverages the already-present `damageRectanglesCallback` + Vision `regionOfInterest`. *Go criteria:* per-step perception latency down materially with no accuracy regression vs full-frame perception (validated by a perception eval on recorded frames — worth building the deferred perception eval harness here).

5. **Phase E — Anticipation / prefetch (§3).** Builds on the graph + ROI from D. *Go criteria:* confirmed-speculation removes a measurable share of model turns on predictable transitions with zero speculative wrong-actions.

6. **Phase F — Goal-directed exploration (§5).** Now that timing/reflexes/perception are cheap, exploration is safe and its learnings persist in the graph. *Go criteria:* "no_plan"/"unknown_screen" escalations fall as the graph fills (AutoDroid's ~14% fewer LLM calls as the target).

7. **Phase G — Icon semantics (§6).** Last because it addresses the narrowest escalation slice ("ambiguous_intent" on icon-only chrome) and needs a shipped model. *Go criteria:* template bank + <5 MB Core ML classifier label the top-100 icons at the literature's ~94% with <5 ms latency; icon-only taps gated behind verify-after-tap.

**Thresholds that change the plan:** if at any phase the escalation log shows a *different* reason dominating the avoidable rate, reorder to attack that reason next — the log, not this list, is authoritative. Re-collect human baselines quarterly (apps change). Treat any HPI_accuracy regression as a hard stop.

## Caveats
- **Measured vs estimated flags:** OSWorld-Human ratios (2.7–4.3x steps; >90% latency in model calls; 3x step-time growth), AndroidWorld human 80.0% / M3A 30.6%, AutoDroid (13.7% fewer calls; 625.3→339.0 tokens; 21.3% lower latency; 90.9%/71.3%), RICO icon accuracies (94%/96.3%), KLM operators (K=0.2, M=1.35, P=1.1, H=0.4 s), El Batran & Dunlop touch times (swipe 70 ms, zoom 200 ms, point 80 ms), Fitts touchscreen MT=336+72.7·ID ms, Woods et al. reaction time (213–231 ms, n=1,469), MobileOne <1 ms on iPhone 12, and Nielsen 0.1/1/10 s are all **measured/published**. **TLM operator second-values are NOT published (conceptual only)** — do not cite numbers for them. The **MobileNetV2 <1 ms on iPhone 15 Pro** figure is **vendor-published** (relayed via a secondary blog), not independently verified.
- **`damageRectanglesCallback` reliability is not officially documented** — it appears in idb's open-source framebuffer code and simframe's own SimulatorKit stack, but Apple provides no contract; it can under-report GPU-composited changes, so always keep a full-perception fallback and periodic full sweeps.
- **iOS 3-button permission popups flip auto-accept/dismiss semantics** (documented Appium gotcha) — the reflex table must special-case these, not assume 2-button.
- **ATT/tracking prompt cannot be pre-granted via `simctl`** — it requires a UI reflex, unlike most privacy services.
- **`simctl status_bar` has had version-specific breakage** (e.g., iOS 16.1 / Xcode `xcrun` bugs fixed around Xcode 15.3) — pin the simulator runtime used for CI baselines.
- **Speculation and icon inference are the two riskiest faculties** for causing *wrong* actions; both must sit behind the existing verify-after-tap barrier and never fire on destructive actions. When confidence is low, escalate — a model call is cheaper than a wrong tap in a test.
- **Human baseline validity:** a handful of testers on a simulator is not a population; report IQR, use median not mean, and treat HPI as a relative trend metric, not an absolute claim of "human-level."

## Sources
- OSWorld-Human: Benchmarking the Efficiency of Computer-Use Agents — arXiv 2506.16042 (MLSys 2026); https://arxiv.org/abs/2506.16042 ; https://arxiv.org/html/2506.16042v2 ; https://github.com/WukLab/osworld-human
- AndroidWorld: A Dynamic Benchmarking Environment for Autonomous Agents — arXiv 2405.14573; https://arxiv.org/abs/2405.14573
- AndroidControl (Li et al. 2024) via OS-Genesis appendix; https://arxiv.org/pdf/2412.19723
- Woods et al. 2015, Factors influencing the latency of simple reaction time; https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4374455/
- Touch-Level Model (Rice & Lartigue 2014); https://dl.acm.org/doi/10.1145/2638404.2638532 ; https://www2.cs.science.cmu.ac.th/courses/204365/cognitiveModel/tlm.pdf
- El Batran & Dunlop 2014, Enhancing KLM to fit touch screen mobile devices; https://dl.acm.org/doi/10.1145/2628363.2628385 ; https://strathprints.strath.ac.uk/49816/
- Keystroke-Level Model operators (Card, Moran & Newell); https://en.wikipedia.org/wiki/Keystroke-level_model
- Creating Fitts' Law Predictions for a Touchscreen Tablet (2016); https://www.researchgate.net/publication/311788586
- FFitts Law: Modeling Finger Touch with Fitts' Law; https://www3.cs.stonybrook.edu/~xiaojun/pdf/FFitts.pdf
- Nielsen, Response Times: The 3 Important Limits; https://www.nngroup.com/articles/response-times-3-important-limits/
- Apple Vision regionOfInterest / coordinate system; https://developer.apple.com/forums/thread/126145 ; https://machinethink.net/blog/bounding-boxes/
- idb FBFramebuffer damageRectanglesCallback; https://github.com/facebook/idb/blob/main/FBSimulatorControl/Framebuffer/FBFramebuffer.m
- Ferret-UI: Grounded Mobile UI Understanding with MLLMs — arXiv 2404.05719; https://arxiv.org/pdf/2404.05719
- RegionFocus / Visual Test-time Scaling for GUI Agent Grounding; https://www.researchgate.net/publication/391369481
- UI-Zoomer; https://arxiv.org/pdf/2604.14113 — DRS-GUI; https://arxiv.org/html/2605.15542 — GUI-Lens; https://arxiv.org/html/2608.03270
- Land & Hayhoe / Mennie, Hayhoe & Sullivan, Look-ahead fixations (Exp. Brain Res. 2007); https://link.springer.com/article/10.1007/s00221-006-0804-0 ; https://www.nature.com/articles/eye2014275
- Action Chunking (ACT) & execution horizon; https://huggingface.co/docs/lerobot/act ; PACE https://arxiv.org/pdf/2606.00537
- Appium autoAcceptAlerts/autoDismissAlerts & acceptAlertButtonSelector; https://testingbot.com/support/app-automate/appium/permission-popups ; https://www.browserstack.com/docs/app-automate/appium/advanced-features/handle-permission-pop-ups
- XCUITest addUIInterruptionMonitor; https://developer.apple.com/forums/thread/31370
- Maestro iOS permissions; https://www.browserstack.com/docs/app-automate/maestro/set-up-test-env/configure-tests/handle-permission-popups
- Espresso IdlingResource; https://developer.android.com/training/testing/espresso/idling-resource — Detox synchronization / DetoxSync; https://wix.github.io/Detox/docs/troubleshooting/synchronization/ ; https://github.com/wix/DetoxSync
- Android animation-disable adb settings; https://alexzh.com/handle-android-animations-properly/
- SimulatorStatusMagic / simctl status_bar; https://github.com/shinydevelopment/SimulatorStatusMagic ; https://developer.apple.com/forums/thread/720610
- AutoDroid — arXiv 2308.15272; https://arxiv.org/pdf/2308.15272 ; https://www.alphaxiv.org/abs/2308.15272 — AutoDroid-V2 — arXiv 2412.18116; https://arxiv.org/pdf/2412.18116
- Fastbot / Fastbot2; https://dl.acm.org/doi/pdf/10.1145/3387903.3389308 ; https://dl.acm.org/doi/10.1145/3551349.3559505 — Stoat / Humanoid; https://arxiv.org/pdf/1901.02633
- Agent S — arXiv 2410.08164; https://arxiv.org/pdf/2410.08164
- RICO / Liu et al. Learning Design Semantics for Mobile Apps; https://experts.illinois.edu/en/publications/learning-design-semantics-for-mobile-apps — Towards Complete Icon Labeling (CHI 2022); https://dl.acm.org/doi/fullHtml/10.1145/3491102.3502073
- SF Symbols 7; https://developer.apple.com/sf-symbols/ ; https://9to5mac.com/2025/06/11/apple-releases-sf-symbols-7-beta/
- MobileOne: An Improved One millisecond Mobile Backbone — arXiv 2206.04040; https://arxiv.org/pdf/2206.04040
- On-Device Neural Net Inference with Mobile GPUs (Core ML MobileNet timings) — arXiv 1907.01989; https://arxiv.org/pdf/1907.01989
- simframe-adjacent iOS simulator daemons (context): valewnrt/testa; https://github.com/valewnrt/testa ; tddworks/baguette; https://github.com/tddworks/baguette/blob/main/docs/ARCHITECTURE.md