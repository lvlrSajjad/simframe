# simframe research brief — answers to Q1–Q7

*Prepared 2026-09-11. Confidence tiers per question: (a) verified with source, (b) inferred/likely, (c) unknown/nobody-has-solved. "Verify-against-binary" flags mark signatures you should dump before treating as confirmed — consistent with your `docs/PRIVATE_API.md` discipline.*

## Highest-confidence actionable findings
1. **Q1 (scroll offset):** No AXP/CoreSimulator attribute exposes `contentOffset`/`contentSize`. The AXP tree publishes only rendered elements. XCUITest cannot read `contentOffset` either. Nobody has solved host-side scroll-position sensing through accessibility; the honest answer is "you are asking the wrong question — track content-anchor frame deltas, not viewport position." Verified new signals: `AXTraitScrollable` (bit 33) and `AXTraitCausesPageTurn` (bit 14) exist in AXRuntime, but they are booleans, not offsets.
2. **Q2 (set value without keyboard):** No verified AXP set-value selector exists on the simulator path. XCUITest's `typeText` also goes through the keyboard — there is literally a log line "There is currently no way to bypass typing using XCUITest." The `AXPTranslatorRequest` has an `action` field and elements carry a `custom_actions` array — this is your one under-used lever. Clearing a field: use ⌘A + Delete via HID key usages, not re-typing.
3. **Q3 (unpredictable swipe):** This is UIScrollView inertia/deceleration; pan velocity is computed from the last touch samples before lift. A dwell/hold at the end zeroing velocity is the cure, but Apple's own `thenHoldForDuration` has a known bug where the hold does nothing on a perfectly still finger. Apple DTS admits coordinate drags are not pixel-accurate. Close the loop by measuring a content anchor's frame delta.
4. **Q5 (CI):** Hosted-runner simulator flakiness is universal and documented across many actions/runner-images issues. Mitigations exist (`simctl bootstatus -b`, bigger runners, disable animations, pre-launch GUI) but "teams running XCUITest at scale largely self-host or use a device/simulator cloud" is the honest state of the art. Keep the HPI job non-blocking on hosted runners.
5. **Q6/Q7:** Run the full 2×2 within-subject factorial with a balanced Latin square, reset the transition graph between conditions (or treat cold/warm graph as an explicit blocking factor), repeat each cell and report mean ± SD; primary response = model calls with completion as a gate. Adopt conformal-abstention + Dempster–Shafer + cascade/early-abstention literature — the weight-free subset (conformal thresholds = a stored quantile; DS conflict rules; abstention framing) respects your no-weights non-goal.

---

## Q1 — Is a scroll offset really unavailable?

### (a) Verified facts with sources
- **The AXP request/response shape is known.** idb crash logs show `<AXPTranslatorRequest>: Type: 2, action: (null), attribute: AXPAttributeChildren, params: (null): translation: <AXPTranslationObject>`. So an AXP request carries: requestType ("Type"), action, attribute, params, and a translation object (facebook/idb issue #802).
- **The host-side entry point is** `-[SimDevice sendAccessibilityRequestAsync:completionQueue:completionHandler:]` — verified verbatim in idb `PrivateHeaders/CoreSimulator/SimDevice.h` (dumped from Xcode 26.2; in-file comment: "In Xcode 12, this replaces SimulatorBridge related accessibility requests"). Companion selectors in the same file: `-(NSString *)accessibilityPlatformTranslationToken;` and `-(id)accessibilityConnection;`.
- **What idb actually serializes per element:** `AXFrame`, `AXUniqueId`, `frame`, `role_description`, `AXLabel`, `content_required`, `type`, `title`, `help`, `custom_actions`, `AXValue`, `enabled`, `role`, `subrole` (fbidb.io/docs/accessibility). **No scroll offset, content size, or scroll-percentage field appears.**
- **AXRuntime traits include scroll signals** (idb `PrivateHeaders/AXRuntime/AXTraits.h`, values "extracted from `_kAXButtonTrait` like statics in … `AXRuntime.framework`" inside the iOS simruntime): `AXTraitScrollable = FBBIT64(33)`, `AXTraitCausesPageTurn = FBBIT64(14)`, `AXTraitSupportsZoom = FBBIT64(46)`, `AXTraitAdjustable = FBBIT64(12)`, `AXTraitTableIndex = FBBIT64(35)`, `AXTraitContainedByTable/List = FBBIT64(43/44)`. These are booleans — "this is scrollable / causes a page turn" — not offsets.
- **XCUITest cannot give you a pixel-accurate scroll position.** Apple DTS (Developer Forums thread 817583, Mar 2026) confirms coordinate-based drags have "a consistent error of several pixels," and `scroll(byDeltaX:deltaY:)` is macOS-only (present on the AppKit-era `XCUIApplication`, not usable on iPhone).
- **`kAXVisibleCharacterRangeAttribute` exists on macOS AX** but is reported buggy/imprecise even there — it "gives a range that starts from an index that is not visible" including the top bar (Apple Forums 734935) — and it is a macOS AXUIElement text attribute, not confirmed on the iOS AXP path.

### (b) Inferred / likely
- The AXP framework *may* internally define more attribute constants than idb requests (idb only asks for the keys it serializes). But searches of idb source, idb runtime logs, idb's JSON schema, and header-dump indices (limneos iOS 14.4 lists `AXPIOSPlatformElement.h`, `AXPTranslationElementProtocol.h`, `AXPTranslationObject.h`, `AXPTranslator.h`, `AXPTranslatorRequest.h`) found **no** `AXContentSize`/`AXScrollPosition`/`contentOffset`/`AXVerticalScrollBar` analogue on the AXP path. Absence in idb's output does not prove the constant does not exist in `AXPTranslator.h` — but there is no positive evidence it does. **Verify-against-binary:** dump the AXP attribute-constant table and the AXPTranslatorRequest Type enum before concluding definitively.
- `AXValue` sometimes carries progress ("Page 1 of 2" on a page control; a slider's normalized value). This is the closest thing to a position signal and is already in the eight attributes you request — but only for controls that model themselves as adjustable/paged, not arbitrary scroll views.

### (c) Unknown / nobody-has-solved
- No public tool (XCUITest, Appium/WDA, idb, AXe) answers "am I at the top/bottom" from a *read* of the accessibility tree. They all answer it **behaviorally**: WDA/Appium `scrollIntoView` and XCUITest scroll until the target element appears or the tree stops changing — exactly the heuristic family you already tried. WebdriverIO's native `scrollIntoView` uses repeated `mobile: swipe` with a `maxScrolls` cap; it never reads an offset.
- **Reframing (the "right question"):** Since the platform only publishes rendered content, absolute position is not observable — only *change* is. The robust signal is not viewport position but **content-anchor displacement**: pick a stable labeled element present before and after the move and measure its `AXFrame.y` delta to compute exactly how far the content actually travelled (this doubles as the Q3 measurement). Termination = "the set of content-only element identities stops gaining new members AND the last content anchor's frame delta ≈ 0 for two consecutive moves." That upgrades your current best (content-only + two stalls) by making the stall test a *measured frame delta* rather than label-set novelty, which is what fails on live-content footers.

---

## Q2 — Setting a text field's value without the keyboard

### (b1) Does AXP support SETTING attributes?
- **Verified:** `AXPTranslatorRequest` has an `action` field (logged as `action: (null)` in idb #802), and the host entry point `sendAccessibilityRequestAsync:` exists — so the request struct *can* carry an action.
- **Not found / unknown:** No verified `setAttribute:value:forElement:`-shaped selector on `AXPTranslator`, `AXPTranslationObject`, `AXPMacPlatformElement`, or `AXPTranslator_iOS` surfaced in idb source, idb logs, or header-dump indices. The header files exist (limneos iOS 14.4 index) but their bodies were behind an automated-access wall. **Verify-against-binary.** Note the macOS analogue `-[NSObject accessibilitySetValue:forAttribute:]` / `_accessibilitySetValue:forAttribute:` exists in AppKit AX and in WebKit's test runner (`void setAttributeValue(id element, NSString* attribute, id value, bool synchronous)` — WebKit `AccessibilityUIElementMac.mm`), but that is the **host macOS AX API, not the iOS AXP translation path**, and WebKit/Electron/Terminator all report it fails silently on browser-rendered views (t8r.tech field notes: "AXPress and AXClick return success on browser-rendered views and do nothing").

### (b2) Action list — already in the tree, never requested
- **Verified:** idb's `describe-all` emits a `custom_actions` array per element (e.g. `"custom_actions":["Edit mode","Today"]` on the Calendar icon; fbidb.io/docs/accessibility), populated from the element's AX custom actions. **This is the single most under-used lever in your eight-attribute request** — you fetch `AXRole, AXSubrole, AXDescription, AXValue, AXIdentifier, AXEnabled, AXSelected, AXFocused` and never ask for actions. Add the custom-actions attribute and exercise the request's `action` field.
- **Inferred / verify-against-binary:** the specific AXP attribute constant backing `custom_actions` (Apple's underlying key is `AXCustomActions`-shaped) and whether a request Type *performs* an action versus *reads* one. Dump `FBSimulatorAccessibilityCommands.m` and `AXPTranslatorRequest.h` to confirm.

### (b3) How the tools actually deliver characters
- **XCUITest `typeText` → keyboard.** Verified by the recurring Appium/WDA log line: **"There is currently no way to bypass typing using XCUITest. Setting value through keyboard"** (appium/appium #6873, #8899, #8264, #8059). WDA's `+[FBKeyboard typeText:error:]` calls XCTest's `typeText` at the end (WebDriverAgentLib/Utilities/FBKeyboard.m). So Appium `setValue`/`sendKeys` on iOS text fields **also goes through the active keyboard layout** — confirming your Farsi/Armenian corruption is a general iOS problem, not a simframe bug.
- **Appium `mobile: setValue`:** the "bypasses the keyboard" reputation is only true for pickers/sliders (`adjust(toPickerWheelValue:)`, `adjust(toNormalizedSliderPosition:)`); generic text fields still funnel to `typeText`. There is no verified keyboard-bypass text insertion for a generic text field in WDA.
- **idb `text` command → HID keyboard events** ("equivalent to sending events via a hardware keyboard"; fbidb.io/docs/accessibility). It maps a string to HID key events, so it is **subject to the same active-layout problem** and will corrupt under Farsi/Armenian exactly like your `type`. Not a layout-independent path.
- **AXe / `IndigoHID.key(usage:op:)`:** you already have the primitive; Return is a HID usage (Keyboard Return/Enter = usage `0x28` on the HID Keyboard/Keypad usage page). This is the correct fix for the `"\n"`-as-text bug (`Coke Display` → `Coke In Display`): send the Return **key usage**, never a newline character into the type stream.
- **`simctl`:** there is no `simctl io sendkey`. `simctl pbcopy`/`pbpaste` exist (pasteboard sync), but pasting still requires triggering the field's paste action and hits the consent race in (b4b).

### (b4) Clearing a field
- **Verified problem:** re-typing appends; there is no clear/replace primitive in XCUITest/Appium/idb. Standard workaround: **⌘A then Delete** via HID — hold Left-GUI usage `0xE3` + `a` usage `0x04`, release, then Delete/Backspace usage `0x2A`. This is HID-only and layout-independent for the modifier+delete combo (the letter `a` in ⌘A is position-based, not glyph-based). Alternatively long-press → Select All → Delete, or place the caret and send N× Delete.

### (b4b) Why a web `<textarea>` intermittently ignores paste/keystroke
- **Verified — paste consent race:** iOS 16 introduced a **system paste-consent prompt** ("[App] would like to paste from [Source]") whenever code reads `UIPasteboard.general` without a qualifying user gesture. Apple VP Ron Huang confirmed via MacRumors the early-iOS-16 over-firing was "absolutely not expected behavior"; it was partially corrected by iOS 16.1 and given a per-app "Paste from Other Apps" setting (Ask/Allow/Deny). If your paste path reads the pasteboard, the first paste can be swallowed by the modal and the second "works" — matching your intermittent textarea symptom exactly.
- **UIPasteControl** (iOS 16+) is the sanctioned no-prompt paste button; a raw programmatic paste is not.
- **WebKit `<textarea>` focus race:** a keystroke/paste delivered before the web view commits focus to the input is dropped. WDA copes by checking `hasKeyboardFocus` (exposed on `XCUIElement`, used in appium/appium #16419) before typing. **Recommendation:** gate every insertion on a confirmed-focus read (tap field → poll `AXFocused`/`hasKeyboardFocus` → then insert). This also explains the "one primitive reports success into an empty field, the other then works" symptom as a focus-timing race, not a primitive defect — so it will not reproduce deterministically, and chasing a paste-vs-type bug is the wrong investigation.

---

## Q3 — Why one swipe travels an unpredictable distance

### (a) Verified facts with sources
- **Mechanism = UIScrollView deceleration + velocity-from-last-samples.** UIKit computes pan velocity from the final touch samples before lift; a fast lift imparts a fling that decelerates over a variable distance. Your 612 pt/260 ms drag measuring 28/40/482/529/0 pt is the signature of this: the 482/529 runs were flung, the 28/40 runs were near-static lifts, and 0 was a gesture that didn't register as a scroll.
- **Apple confirms coordinate drags are not pixel-accurate.** DTS, Forums 817583 (Mar 2026): user reports "a consistent error of several pixels… making the scroll amount unpredictable"; DTS did not deny it, only suggested anchoring coordinates to the root/top-level element.
- **The documented "zero the velocity" gesture is `press(forDuration:thenDragTo:withVelocity:thenHoldForDuration:)`** (hold at end before lift). **Known bug:** `thenHoldForDuration` "has no effect" on a perfectly still finger because a stationary touch fires no pan-gesture callbacks (Apple Forums 705304; repro repo asafkorem/XCUITestHoldBugReproduction). Apple's reviewer concluded "there is no bug in XCUITest here" — the hold *is* delivered, but movement-driven recognizers don't update on a still touch. **Implication for you:** a dwell still zeros the fling (last velocity samples are stationary → ~0), even though that callback quirk exists; you get inertia suppression regardless.
- **XCUITest composes gestures via `XCPointerEventPath` / `XCSynthesizedEventRecord`** (timestamped event paths). `swipeUp()` is widely reported "far too violent" versus a controlled `press(forDuration:thenDragTo:)` (gist UglyBlueCat/9c9657…).
- **idb `swipe`** default recipe: "touch down at the start point, followed by moving 10 points at a time until the end point is reached" (fbidb.io/docs/commands), with `--delta` controlling step size and `--duration` the total. This fixed-small-step approach is the closest public thing to a deterministic drag. idb's HID stack (`FBSimulatorIndigoHID`, `SimDeviceLegacyHIDClient`, digitizer target `0x32`) is the same layer you drive.

### (b) Inferred / likely — the known-good recipe
Compose a **DRAG, not a FLICK**:
1. Touch-down, then a **short dwell at start** (~50–80 ms of stationary samples) to zero initial velocity.
2. **Many small, equal move steps** (idb uses 10 pt/step; finer is smoother) with **monotonic, realistically spaced timestamps** — do not batch them at one instant, and do not space them so far apart the scroll view decelerates mid-drag.
3. **Dwell/hold at the end** (~80–120 ms of stationary samples) *before* lift so the last velocity samples are ~0. This is the single highest-value step for killing inertia.
4. Keep total duration long enough that per-step velocity stays below the fling threshold (≈600 pt over ~600–800 ms in ~10–20 pt steps behaves as a controlled drag).
Then **measure actual travel via a content anchor's `AXFrame.y` delta** (Q1) and close the loop — never trust the requested distance. This directly fixes your sweep defect (30% overlap / overshoot) because the next step size is computed from measured travel, not assumed.

### (c) Unknown / nobody-has-solved
- No tool reports deterministic pixel travel; Appium/WDA/idb/XCUITest all inherit UIKit inertia. Indigo `IndigoHIDMessage` timestamp fields must be monotonic and realistically spaced, but there is **no public measurement of "steps × delay → exact travel."** The deterministic path is closed-loop measurement, not open-loop tuning.

---

## Q4 — Modality and z-order in the tree

### (a) Verified facts
- **`accessibilityViewIsModal` is a real UIKit property** that makes VoiceOver ignore sibling views of the modal's root (Apple docs; React Native docs quote the exact semantics; Orange a11y guidelines; Deque). VoiceOver *automatically* filters modal-occluded siblings when it is set.
- **`accessibilityElementsHidden`** and **`isAccessibilityElement`** are the other relevant booleans; `accessibilityElementsHidden` hides an element and its children from AX.
- **The catch:** `accessibilityViewIsModal` only suppresses **siblings of the modal root**, not arbitrary background views deeper in the hierarchy (Orange guidelines, Example 2: developers must additionally set `accessibilityElementsHidden=YES` on non-sibling parents). So even when honored, dimmed-page text that is not a sibling of the sheet root can remain — exactly your sheet-paired-with-background-OCR bug.

### (b) Inferred / likely
- **Whether the AXP-translated tree carries `accessibilityViewIsModal` to the host is not verified.** idb's serialized schema does **not** include a modal/hidden flag (keys are role/label/frame/value/actions only), so on the idb-style AXP path you do **not** get a modality bit today. VoiceOver's automatic modal filtering lives inside the AX runtime; whether it is applied before translation or only in the VoiceOver client is unconfirmed. **Verify-against-binary:** dump `AXPTranslator`/AXRuntime for an `AXModal`/`isModal`/`elementsHidden` attribute.
- WDA/XCUITest expose visibility via `isHittable` and WDA's `fb_isVisible`/`isWDAVisible` — computed from frame intersection + hit-testing, **not** from a modal flag — and `fb_isVisible` is famously flaky (it hit-tests and can disagree with actual paint).

### (c) Unknown / nobody-has-solved
- There is no reliable public z-order/occlusion attribute on the iOS AX tree. Your current "these overlap and disagree → refuse" is consistent with how WDA copes (geometry + hit-test, no true z-order). **Principled improvement using a verified signal:** `AXTraitAlert = FBBIT64(56)` exists in `AXTraits.h`. When element A's accessibility frame is fully contained in a larger element B carrying `AXTraitAlert` (or `AXTraitTouchContainer = FBBIT64(45)`), prefer B's subtree and suppress the rest — using `AXTraitAlert` as the modality hint you currently lack, instead of only detecting the overlap symptom.

---

## Q5 — iOS-simulator benchmarks in CI without a self-hosted box

### (a) Verified facts / other people's measurements
- **Hosted-runner simulator boot/openurl flakiness is a documented, recurring class of bug**, not your environment: actions/runner-images **#7971** ("XCode simulators failing when booting or using openurl"), **#11874** (macOS runner fails to launch unit tests behind `simctl boot` + `bootstatus`), **#9511** (Vision Pro sim never boots, 30-min hang), **#8434** (new macOS-13 image ~2× slower: pipeline 25–33 min → 45–60 min/timeout), **#11845** (macOS-14 arm64 image 20250304 "much slower" than 20250120), **#12948** (Xcode 16.4 "sometimes missing simulators"). This corroborates your 47–55 s launches and 3-in-a-row failures.
- **openradar 27524047:** `xcodebuild` exit code 65 caused by slow simulator boot; documented workaround is to pre-launch the Simulator GUI (`xcrun instruments -w <UUID>`) because "Using xcrun simctl does not work" reliably under load.

### (b) Inferred / likely — mitigations that measurably help
- **Pre-boot and wait explicitly:** `xcrun simctl boot <udid>` then **`xcrun simctl bootstatus <udid> -b`** (`-b` boots if needed and blocks until fully booted) before any `launch`/`openurl`. Highest-value single change; it is what the #11874 workflow adopted.
- **Warm the runtime once, keep the sim hot** across the whole bench job — booting dominates cost.
- **Kill first-launch overhead:** disable/slow-disable animations, pre-dismiss SpringBoard first-run, and control keyboard state. Appium's documented knobs: `forceSimulatorSoftwareKeyboardPresence` (default true to avoid "Keyboard is not present") and `connectHardwareKeyboard:false` (default, "helps to workaround some XCTest bugs"). Use `SIMCTL_CHILD_*` env to quiet the app under test.
- **Use larger hosted runners** (GitHub's larger macOS runners); the slowdown reports correlate with the smallest images.
- **Budget realistically:** even with pre-boot + bootstatus, first boot is tens of seconds; your 28-min job emitting one `::warning` is dominated by boot + first-launch, not your perception layer.

### (c) The honest state of the art
- **Teams running XCUITest at scale largely do not rely on hosted runners for the device-touching parts** — they self-host Mac hardware or use device/simulator clouds (BrowserStack, Sauce Labs, AWS Device Farm). The public GitHub-issue record shows hosted-runner simulator reliability is chronically marginal. So **"self-hosted (or a device cloud), or accept flakiness" is close to the honest answer for a *gating* HPI job.** Recommendation: keep the bench job **non-blocking/informational on hosted runners**, and only promote it to a hard gate on a self-hosted or cloud target where boot is warm and reliable.

---

## Q6 — Separating two confounded treatments (briefing vs on-device supervisor)

### (a) The core problem, named
You ran a 2-arm test (both vs neither) of a **2-factor** system (briefing × supervisor-model), so the factors are perfectly confounded. The supervisor fired 3× but 9 briefed steps self-recovered — i.e. the *briefing prose* is doing most of the work, and you cannot attribute the 20-call saving. Run the **full 2×2 factorial**: {neither, briefing-only, model-only, both}. The missing arm is **briefing-only (no model)**.

### (b) Established methodology to apply
- **2×2 within-subject (repeated-measures) factorial** so each flow experiences all four conditions; this recovers the main effect of briefing, the main effect of the model, **and their interaction** — the interaction is precisely "does the model add anything on top of the briefing," which is the question you actually care about.
- **Counterbalance order with a Latin square** — for 4 conditions use a 4×4 balanced Latin square, ideally a **Williams design** (also balances first-order carryover). This is standard crossover-trial methodology and defeats both the learning effect and fatigue.
- **Graph persistence is a carryover/blocking factor — handle it explicitly.** Do both: (1) **reset the transition graph between conditions** so each run starts from the same memory state; (2) if you want to *study* memory, treat **graph state (cold/warm) as an explicit blocking factor** in the design. Do **not** run within-subject on the same app with a persistent graph and no reset — that is contaminated by exactly the learning effect you flagged.
- **Small-N analysis:** with expensive runs, use **paired/repeated-measures analysis** (each flow is its own control — far more powerful than between-groups) and prefer **Bayesian estimation** (posterior on call-savings with a credible interval) or a **pre-registered sequential design** (add flows until the credible interval excludes zero). This is the "run the right five experiments, not twenty sloppy ones" path.
- **Power / how many flows:** you cannot get frequentist power from N=2. Pilot the four arms on ~5 flows × several repetitions to estimate per-flow variance, then size the study from that variance for the effect you care about. Given the run-to-run variance below, plan for **repeated runs per (flow × condition) cell**, not single runs.

### (c) Response variable
- **Primary: model calls** (your own cost model: agent cost = model calls), analyzed as a paired within-flow difference.
- **Completion is a gate, not the primary metric** (both arms completed every field, so completion has no variance here). Report it as a constraint ("all cells completed") and analyze calls conditional on completion.
- **Secondary/diagnostic: recovery-call fraction** (share of calls that were escalations) and **wall-clock.** Recovery-call fraction is the mechanistic variable that separates "briefing prevented a failure" from "model recovered a failure" — the exact confound you have.
- **Variance control is mandatory.** Per Label Studio's synthesis of agentic-benchmark research ("How to handle non-determinism in agent evaluation"), *"Single-run pass@1 estimates vary by 2.2 to 6.0 percentage points depending on which run you select… Standard deviations exceed 1.5 percentage points even at temperature 0,"* and a referenced study of *"five models across eight tasks"* found *"accuracy variations of up to 15 percent across runs configured at temperature 0."* Multiple arXiv agent papers likewise report per-config std devs of ~1–3 pp with 15–22% of tasks flaky across identical reruns. **Therefore repeat each cell and report mean ± SD** — your single-run "25 vs 45 calls" is inside the noise band until replicated.

---

## Q7 — Is there a method you don't know about?

### Calibrated uncertainty / refuse-vs-answer (the direct hit)
- **Selective prediction / classification with a reject option** (El-Yaniv & Wiener; Sadinle et al.) is the formal name for "a sensor should refuse rather than answer." This is the literature for telling "no" from "I couldn't tell."
- **Conformal prediction for abstention** gives *distribution-free* guarantees: emit a prediction *set*; if it collapses to one answer, commit; if it holds several, abstain/escalate ("Conformal Cascade," arXiv 2607.25018; "Prune 'n Predict," 2501.00555; C3PO, 2511.07396). The error budget **α reads directly as your allowed false-warning rate** — which operationalizes your rule "a warning that is usually wrong is worse than no warning": set α to bound false warnings, and the threshold follows with a coverage guarantee. Weight-free: the calibration is a stored quantile of a nonconformity score, not a learned model.
- **Combining disagreeing sensors without averaging into confident-wrong:** **Dempster–Shafer evidence theory** and conflict-aware sensor fusion explicitly represent *conflict* and *ignorance* as distinct from *low probability* — precisely your sheet-vs-OCR disagreement. Your current "they overlap and disagree → refuse" is a hand-rolled high-conflict → abstain rule; DS formalizes it and lets you carry "I couldn't tell" as a first-class mass rather than collapsing to a confident wrong answer.

### Local escalate-to-bigger-model decisions (cascades)
- **FrugalGPT** (Chen, Zaharia & Zou, Stanford, arXiv:2305.05176, 2023): cascade small→large with a learned confidence threshold — *"can match the performance of the best individual LLM (e.g. GPT-4) with up to 98% cost reduction or improve the accuracy over GPT-4 by 4% with the same cost."*
- **RouteLLM** (Ong et al., LMSYS/UC Berkeley, arXiv:2406.18665, July 2024): trained routers *"reduce costs by up to 85% while maintaining 95% GPT-4 performance"* on MT Bench (45% on MMLU, 35% on GSM8K); the matrix-factorization router reached 95% of GPT-4 quality using only 26% of GPT-4 calls. **Hybrid LLM** (Ding et al. 2024) and **RouterBench** (Hu et al. 2024) round out the routing literature.
- **Early-abstention cascades** — *"Cost-Saving LLM Cascades with Early Abstention"* (Zellinger, Liu & Thomson, arXiv:2502.09054, 2025): small models predict whether the *big* model will abstain; early abstention trades *"+4.1% on average"* abstention rate for *"significant cost reductions (-13.0% on average) and error reductions (-5.0% on average)."* Directly relevant to your on-device supervisor deciding when to escalate.
- **Bayesian self-escalation** (arXiv:2608.24087): the deferral decision is made *sequentially within a single generation*, and the posterior is over the junior model's *own eventual success* — the closest published framing to your step-failure supervisor (wait/retry/stop). **UCCI** (arXiv:2605.18796) fixes the known miscalibration of raw-confidence thresholds via calibrated cascade routing.
- **Caveat for your constraints:** most cascade/routing papers assume a small learned router/meta-model. A BERT-style router or logistic-regression confidence model **would be shipped ML weights → violates your no-weights non-goal.** Weight-free adoptions: conformal thresholds (a stored quantile), Dempster–Shafer conflict rules, and the abstention framing itself.

### GUI transition-graph / UTG memory beyond AutoDroid
- **DroidBot** (origin of the term UTG = UI Transition Graph), **Stoat** (stochastic model-based GUI testing), **Humanoid** (learns human-like interaction to guide exploration), plus **APE / ComboDroid** for Android exploration. **AppAgent** (Zhang et al.) and **Mobile-Agent / Mobile-Agent-v2** for LLM-driven mobile GUI agents with exploration memory. **GUI-Odyssey** (cross-app navigation dataset). **"Screen state abstraction"** and **memory-augmented GUI agents** are the search terms for turning raw screens into a compact graph state. Your `(screen_hash, action) → screen_hash'` *is* a UTG; the recurring hard problem in that literature is **state-abstraction quality** — when are two screens "the same state." The key transferable idea: **abstract screen state by structural signature (element-identity set), not by pixel/hash**, which is exactly what would stop your "footer with live content thrashes the fingerprint" failure.

### Bottom line for Q7
The body of work you want exists and is mature: **selective prediction + conformal abstention** for refuse-vs-answer, **Dempster–Shafer** for conflict-aware fusion, **cascade/early-abstention** for local escalation, and **UTG/screen-state-abstraction** for memory. Adopt first, because it is weight-free and directly encodes your "false warning is worse than no warning" rule: **conformal abstention with α set to your false-warning budget**, and **structural (element-identity) screen-state abstraction** to replace hash fingerprints.

---

## Cross-cutting flags (non-goals)
- **No new runtime dependency required** for any recommendation. Adding the AXP **custom-actions / action** request (Q2), enumerating the full AXP attribute set (Q1/Q4), and reading `AXTraitScrollable`/`AXTraitAlert` (Q1/Q4) are one-file changes to your single private-framework module.
- **No shipped ML weights:** the weight-free Q7 subset is conformal thresholds (a stored quantile), Dempster–Shafer rules, structural state abstraction, and the abstention framing. Learned routers (FrugalGPT / Hybrid-LLM / RouteLLM) and BERT-style confidence models would violate the rule — flagged, not recommended.
- **Verify-against-binary before treating as confirmed** (the subagent verified the request *shape* — `AXPTranslatorRequest` fields requestType/action/attribute/params/translation — and the host entry-point signature verbatim, but header bodies were behind an automated-access wall): (1) any AXP set-value selector; (2) the exact attribute constant behind `custom_actions`; (3) whether `accessibilityViewIsModal`/an `AXModal` bit survives AXP translation; (4) the full AXP attribute-constant list and the AXPTranslatorRequest Type enum, including any scroll/content-size key. Dump `FBSimulatorAccessibilityCommands.m`, `AXPTranslator.h`, and `AXPTranslatorRequest.h`, and open the limneos AXP pages in a real browser (they block automated fetch).