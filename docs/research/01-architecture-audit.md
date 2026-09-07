# simframe 2.0: A Technical Audit and Redesign for Human-Speed iOS Simulator Control from Claude Code

## TL;DR
- **The single biggest win is architectural, not perceptual: replace simframe's ~130ms `simctl io screenshot` polling loop AND the fragile `idb` input path with one persistent Swift daemon that (a) registers a SimulatorKit/CoreSimulator `SimDevice.io` IOSurface framebuffer callback for near-zero-cost continuous frames, and (b) injects HID touches directly via the iOS-26 9-argument `IndigoHIDMessageForMouseNSEvent` path — exactly what the newer tools `baguette` and `testa` already do.** This collapses per-glance capture cost and removes idb's process-spawn and version-fragility overhead.
- **The dominant latency in agent-driven testing is model round-trips, not milliseconds.** The OSWorld-Human study (MLSys 2026) found that "large model calls for planning and reflection account for the majority of the overall latency," with planning alone consuming 75–94% of total task time, and that leading agents "take 1.4–2.7× more steps than necessary." simframe's `sim_do` "whole flow in one call" instinct is correct; the redesign should push much harder on composite/batched tools, local action-verification, and returning compact text state (accessibility + OCR) instead of images so Claude only "looks" when genuinely uncertain.
- **Keep simframe's three good ideas (warm last frame, OCR-as-muscle-memory, visual memory) but move perception to a semantic-first hybrid**: accessibility tree first (instant, ~10-token structured labels+frames), on-device Apple Vision OCR fallback for custom/RN/canvas UIs, and a vision model only on demand. This is the emerging consensus design (testa, Argent, conorluddy's skill, LUMOS) and directly addresses simframe's own documented pain that accessibility trees are "a promise apps do not always keep."

## Key Findings

**1. simframe today is a Node.js MCP server + CLI with a clever file-based frame cache, but it is bottlenecked by the two slowest possible primitives underneath it: `simctl` for capture and `idb` for input.** Its own README states the capture loop is `simctl screenshot (~130ms) → sips (~30ms) → decode (~6ms) → hash+diff`, tops out near 6fps, and that "idb is the one heavyweight requirement... a reimplementation of the Indigo HID transport rather than a public API." simframe cleverly hides the 130ms behind a background loop so reads are ~20ms, but it never eliminates the 130ms — it just amortizes it, and it cannot see fast animations.

**2. The private-framework path is dramatically faster and is now proven on iOS 26.** Both `baguette` (1.6k stars) and `testa` drive the simulator through Apple's own `CoreSimulator`, `SimulatorKit`, and `AccessibilityPlatformTranslation` private frameworks with zero third-party dependencies. `testa` reports ~60ms per full snapshot (IOSurface framebuffer capture + accessibility tree) from a warm daemon; `baguette` streams frames at up to 60fps via IOSurface `onFrame:` callbacks with a ~16.6ms/frame budget. HID gestures on warm services cost "a few milliseconds per gesture."

**3. iOS 26 / Xcode 26 broke the old HID injection path — this is the critical fragility fact.** Per baguette's architecture doc: iOS 26 changed SimulatorHID's wire format; `idb` and AXe use the old 5-argument `IndigoHIDMessageForMouseNSEvent`, whose messages "now route to a pointer-service target that silently drops them or crashes backboardd." Xcode 26's SimulatorKit exposes a new 9-argument signature routing to digitizer target `0x32`. Crucially, the **framebuffer/IOSurface capture symbols are not reported to have changed** — so the capture path is much more stable than the input path.

**4. Model round-trips dominate, and step-count bloat compounds super-linearly.** The OSWorld-Human paper (Abhyankar, Qi & Zhang, UC San Diego/GenseeAI; arXiv 2506.16042) is the strongest evidence for prioritizing round-trip reduction over millisecond-shaving. Its verbatim finding: "large model calls for planning and reflection account for the majority of the overall latency, and as an agent uses more steps to complete a task, each successive step can take 3x longer than steps at the beginning of a task." The project's MLSys writeup quantifies this: "LLM calls for 'Planning' and 'Reflection' are the main culprits, consuming 75–94% of total task time," and the growth is structural — "Planning and reflection occur at each step and include the full history of observations. This means tasks that take more steps are quadratically slower than tasks that take fewer steps." The paper evaluates 16 agents and finds even the best "take 1.4–2.7× more steps than necessary."

**5. Semantic-first perception is both faster and cheaper than pixels.** The accessibility tree returns structured element data (type, label, frame, enabled) that Claude can act on directly — reported at ~10 tokens per element versus 1,600–6,300 tokens for a screenshot. Apple's Vision `VNRecognizeTextRequest` runs on the Neural Engine in milliseconds with no network round-trip, filling gaps where the a11y tree is empty (custom tab bars, RN text inputs, canvas, WebViews).

## Details

### 3.1 How simframe works today (audit)

simframe is an npm package (`npm install -g simframe`) exposing both a CLI and an MCP server (`npx -y simframe mcp`, registered via `claude mcp add --scope user`). Architecture, from its README:

- **Capture:** a background loop per simulator runs `simctl io screenshot` (~130ms, blocking) → `sips` resize (~30ms) → JS PNG decode (~6ms) → difference-hash + diff → atomic rename into `~/.simframe/<udid>/`. Backs off from 4fps (moving) to 1.5fps (still).
- **IPC is the filesystem.** Readers `stat`+`read` the newest frame; a rename is atomic so no torn frames. No socket/protocol. This is elegant and is why `sim_look` is ~20ms and `sim_state` ~2ms.
- **Perception:** `sim_ui` merges the accessibility tree (~570ms) with on-device Apple Vision OCR (~290ms), keyed by a **layout hash** (dHash over a 12×24 grid, status bar cropped) so a revisited screen is a ~1ms file lookup vs ~600ms rebuild. Reports ambiguity rather than guessing.
- **Input:** delegated entirely to `idb` (`idb_companion` + `fb-idb`).
- **Tools:** `sim_look`, `sim_state`, `sim_wait` (change-then-settle), `sim_do` (batched flow), `sim_ui`, `sim_recall`, `sim_strip`, `sim_capture`/`sim_devices`.
- **Measured (iPhone 17 Pro, iOS 26.5):** warm frame 20ms; state 2ms; a11y tree 570ms; OCR 290ms; screen map first/remembered 600ms/1ms; raw simctl 130ms; cold first frame 400ms.

**Bottleneck ranking (per action):**
1. **Input via idb** — process/gRPC overhead per call plus the iOS-26 fragility; idb is a Python CLI over a gRPC companion. This is both a latency and a reliability tax.
2. **Screenshot capture (130ms floor)** — hidden but never removed; caps fps at ~6 and blinds the tool to fast animation. 130ms is the amortized ceiling for freshness.
3. **Accessibility tree read (570ms)** — expensive on first visit of each screen.
4. **OCR (290ms)** — on first visit.
5. **Model round-trips** — not simframe's own latency, but the largest end-to-end cost, and the thing simframe's memory/batching partly addresses.
6. **Image token cost** — every image returned to Claude Code is ~1,600 tokens if handled natively, but see §3.6 for a Claude Code-specific bug that can make it 10–20× worse.

### 3.2 Fastest ways to control the simulator (benchmarked)

| Method | Capture | Input | Deps | iOS 26 status |
|---|---|---|---|---|
| `simctl io screenshot` | ~130ms/frame (simframe's figure); ~2000ms in one third-party claim | `simctl` has no reliable tap; needs idb | Xcode only | capture OK; no input |
| **idb** (`idb_companion` + fb-idb) | video-stream MJPEG/minicap ~57fps observed, frames 30–140KB | tap/swipe/text via gRPC; **5-arg Indigo broken on iOS 26** | Homebrew + pipx, fragile | **input broken/fragile** |
| **SimulatorKit/CoreSimulator IOSurface callback** (baguette, testa) | `SimDevice.io` `registerCallbackWithUUID:ioSurfacesChangeCallback:` → IOSurface per frame; **~16.6ms budget @ 60fps**; testa ~60ms/snapshot incl. a11y | 9-arg `IndigoHIDMessageForMouseNSEvent` → digitizer `0x32`, "a few ms/gesture" | **zero third-party** (private frameworks) | **works, actively maintained** |
| **WebDriverAgent / XCUITest** (Appium, Maestro ≥1.18) | XCUITest snapshot (richer hierarchy than idb) | XCTest gestures | XCTest runner build, heavier | works but slower to start |
| **ScreenCaptureKit** on Simulator.app window | 60fps possible but real reports of throttling to ~7fps under load; captures window chrome | n/a (capture only) | macOS screen-recording permission | works |

**Verdict:** the IOSurface framebuffer-callback path is the fastest capture and the only robust iOS-26 input path, and it eliminates both idb and simctl. Named symbols (from idb's `FBSimulatorControl/Framebuffer/FBFramebuffer.m` and PrivateHeaders): `SimDeviceIOClient` (`device.io`), surface typed `id<SimDisplayIOSurfaceRenderable, SimDisplayRenderable>`, `registerCallbackWithUUID:ioSurfacesChangeCallback:` / `ioSurfaceChangeCallback:` / `damageRectanglesCallback:`, `mainScreenSurfaceForSimulator:`. Public IOSurface accessors (`IOSurfaceGetBaseAddress/Width/Height`) read pixels directly.

**Why not just keep idb?** Maestro abandoned idb for view hierarchy because idb "completely ignored" `UITabBar` elements and "can be fragile to iOS version updates" (crashes with cryptic gRPC errors), switching to XCUITest in Maestro 1.18. idb's input is now broken on iOS 26. It is the wrong long-term foundation.

### 3.3 Semantics over pixels: the hybrid perception stack

simframe already does accessibility+OCR, but as a merged map behind `sim_ui`. The redesign should make **the accessibility tree the primary observation channel**, with a defined fallback ladder:

1. **Accessibility tree first** (via `AXPTranslator` / `AccessibilityPlatformTranslation`, in point coordinates that match tap space). Returns type, label, identifier, value, enabled, frame. ~10 tokens/element. Tap by label/identifier — no coordinates guessed.
2. **On-device OCR fallback** (Apple Vision `VNRecognizeTextRequest`) for elements missing from the tree — simframe's own testing found a production app's custom tab bar "published no children at all," icon buttons carried "unreadable private-use glyphs," and RN text inputs were "absent from the tree entirely." OCR gives every visible label coordinates; testa proves this even drives canvas-rendered and HealthKit-permission screens.
3. **Vision model only on demand** — return an image to Claude only when both structured channels are ambiguous or when visual verification is explicitly requested.

**Caveats to encode:** SwiftUI without `accessibilityIdentifier` yields label-only targeting; icon-only controls with no label are invisible to both a11y and OCR (fall back to coordinates); WebViews and Canvas expose little/no tree (OCR territory); localized UIs need the confirm-word vocabulary (`OK`, `SAVE`, `DONE`…) extended beyond English (a stated simframe limitation).

### 3.4 Local, fast perception and "settling"

- **On-device OCR:** Apple Vision on the Neural Engine, "a few milliseconds" for most operations, no per-call cost, no network, no telemetry. Keep simframe's compile-Swift-on-first-use approach (or bake it into the Swift daemon). Prefer Vision over Tesseract/PaddleOCR on Apple Silicon for latency and accuracy.
- **Frame diffing / settling:** simframe's dHash "change then settle" logic is good and should be preserved. Because the IOSurface callback delivers frames continuously and cheaply, the daemon can compute perceptual-hash deltas at up to 60fps and detect "UI stopped animating" far more precisely than a 6fps sampler — replacing fixed `sleep()`s with true settle detection, and catching the "animates but doesn't navigate" false-positive that simframe's roadmap flags as "verify-after-tap."
- **Change-since-last-observation:** keep simframe's crucial insight that "changed since when" must be relative to the agent's *last look*, not the previous frame (a 700ms transition is over before a slow poller looks again).
- **Token-cost reduction for Claude:** downscale to XGA (1024×768) — Anthropic explicitly recommends screenshots at/below XGA for computer-use speed and accuracy, and says to scale in your tool rather than rely on API resizing. Send crops/diffs (only the changed region) rather than full frames. simframe's `sim_strip` contact-sheet idea is good for showing a sequence cheaply.
- **Local grounding models (optional):** OmniParser (Set-of-Mark over detected icons/text), UI-TARS, Ferret-UI/ScreenAI could ground purely-graphical controls the a11y tree and OCR both miss. On Apple Silicon these can run via MLX/CoreML, but they add latency (hundreds of ms to seconds) and complexity — reserve for a later phase; the a11y+OCR hybrid handles the overwhelming majority of cases.

### 3.5 Reducing model round-trips (the highest-leverage lever)

Because model calls consume 75–94% of task time and grow quadratically with step count (§Key Finding 4), the redesign should be aggressive here:

- **Composite/semantic tools** so one tool call does what would otherwise be several look-reason-act cycles: `tap_text("Login")`, `type_into(label, text)`, `wait_for_text(...)`, `assert_screen_contains(...)`, `scroll_to(sel)`, and `run_flow(yaml)`. testa and Maestro both expose exactly this vocabulary (`tap`, `typein`, `assert`, `scrollto`, `wait`).
- **Batched flows with local settle between steps** — simframe's `sim_do` already does "each step settling before the next"; extend it to full assert-bearing flows so a 12-step navigation is one tool call, not twelve turns. This directly attacks the finding that later steps cost up to 3× earlier ones because each carries the full observation history.
- **Return compact structured state by default** — text tree + changed-regions map, not images. Let Claude *request* an image (`sim_look`) only when uncertain.
- **Local action-verification loops** — after each tap in a flow, the daemon verifies the expected element appeared (or screen changed as expected) and only escalates to Claude on mismatch. This keeps the fast inner loop entirely off the model.
- **Generate deterministic Maestro-style flows** — once Claude discovers a working path, emit a reusable YAML flow that reruns with no model calls at all (regression testing).
- **Consider the MCP code-execution pattern** — Anthropic's November 2025 engineering post "Code execution with MCP" (Adam Jones, Conor Kelly) rebuilt a "Google Drive to Salesforce" workflow, dropping token usage "from 150,000 to 2,000, a 98.7% reduction," by exposing tools as a code API rather than piping every result through context; the tradeoff, per independent controlled tests, is that "per-call latency rose about 7%" plus operating a sandbox. For a testing loop with tight inner iteration, letting Claude write a short script that calls the daemon's API and returns only a summary is a strong fit.

Set-of-Mark prompting (numbered boxes over detected elements) is the standard technique when you must use vision (Anthropic Computer Use, Operator, OmniParser, UI-TARS) — worth adopting for the on-demand vision path so Claude picks a mark index instead of raw coordinates.

### 3.6 Claude Code-specific integration

- **MCP image token bug:** there is an open Claude Code issue (#31208) where MCP servers returning `ImageContent` have the base64 treated as text (~15,000–25,000 tokens/image) instead of a native image block (~1,600 tokens) — a 10–20× waste, and images can trip the 25,000-token tool-result limit. **This is a strong reason to default to text/structured state and return images sparingly and pre-downscaled.**
- **CLI + Skill vs MCP:** a CLI + Claude Code *skill* (a `SKILL.md` plus scripts) is often faster and more token-efficient than a chatty MCP server, because the skill can instruct Claude to call compact CLI commands and parse 3–5 line outputs. testa ships both an MCP server and a skill; conorluddy's ios-simulator-skill reports "3-5 lines — 96% reduction vs raw tool output." Recommend shipping **both**: a warm daemon with a thin CLI + skill for the fast path, and an MCP server for discoverability.
- **Persistent warm daemon** is essential: baguette notes subprocess spawn costs ~1.2s (framework resolution) and HID has a ~40ms per-session warmup that should happen once; testa keeps "connection, accessibility translator and HID client hot." Keep one writer per device (simframe already does this via `meta.json` ownership) over a `0600` Unix socket (testa's model).
- **Advanced tool use:** Anthropic's Tool Search Tool (`defer_loading`) lets large tool sets load on demand — its "advanced tool use" post reports "an 85% reduction in token usage" (~77K → ~8.7K tokens across 50+ tools, the search tool itself adding only ~500 tokens), with MCP-eval accuracy rising "from 79.5% to 88.1% with Tool Search Tool enabled" on Opus 4.5 (and 49%→74% on Opus 4). Relevant if the schema grows large.
- **Xcode 26.3 ships a native Xcode MCP** (`xcrun mcpbridge`, 20 tools) and XcodeBuildMCP (82 tools) for builds/tests — complementary: use those for build/test/diagnostics and simframe 2.0 for the interactive UI-driving loop.

### 3.7 Human-like interaction

- **Real HID gestures** through the Indigo path already behave like a finger (UIKit gesture recognizers fire normally), so momentum scrolling, long-press, pinch, rotate, and drag-and-drop are all available (baguette/testa expose all of these). Use realistic durations (down → move-with-curve → up) rather than instantaneous jumps.
- **Waiting for animations:** settle detection (§3.4) replaces fixed sleeps.
- **Keyboard/autocorrect:** route text through the HID keyboard path; baguette notes keyboard is the one still-WIP area on the pure-host path, and testa handles unicode/emoji — expect this to be the fiddliest part. Watch for the iOS keyboard-swallow/autocorrect issues that ennio's changelog specifically fixed (its Bluesky e2e suite runs 17/17 after those fixes).
- **Alerts/permissions:** pre-grant via `simctl privacy`/`permission` (testa exposes `permission grant`), and keep a recovery routine that recognizes and dismisses unexpected system sheets.
- **Deep links to skip navigation:** `xcrun simctl openurl booted "myapp://path"` jumps straight to a screen, and `launch` with arguments/environment seeds state — both massively cut step counts versus driving through the UI. (Note the known XCUITest caveat that in-process `openURL` in `setUp()` can fail to hit `onOpenURL`; the simctl route is reliable.)
- **App state seeding:** install/relaunch with reuse (ennio defaults to app-reuse "soft-reset instead of full relaunch — much faster suites"; `--disable-animations` further tightens settle).

## Recommendations

**Stage 0 — Immediate, no rewrite (days):**
- Flip perception to accessibility-first: have `sim_ui`/`sim_state` return the structured tree by default and reserve images for explicit `sim_look`. Ensure any returned image is pre-downscaled to ≤XGA. This alone cuts tokens ~10–160× per glance and reduces round-trips.
- Ship a Claude Code **skill** (`SKILL.md` + thin CLI wrappers) alongside the MCP server, with 3–5 line outputs, to dodge the MCP image-token bug and shrink context.
- Expand composite tools: add `tap_text`, `type_into`, `wait_for_text`, `assert_*`, and make `sim_do` carry asserts so whole flows are one call.

**Stage 1 — The core rewrite (the high-value bet, 2–4 weeks): a persistent Swift daemon.**
- Replace **both** `simctl` capture and `idb` input with one `arm64e` Swift/Obj-C daemon linking `CoreSimulator` + `SimulatorKit` + `AccessibilityPlatformTranslation` + `Vision`, modeled on baguette (capture+HID) and testa (a11y+OCR+daemon), both MIT/inspectable.
  - **Capture:** register `SimDevice.io` IOSurface `onFrame:` callback; keep the dHash/settle/visual-memory logic but feed it at up to 60fps. Frames never touch `simctl`.
  - **Input:** 9-arg `IndigoHIDMessageForMouseNSEvent` → digitizer `0x32` via `SimDeviceLegacyHIDClient`; warm once. Removes the idb dependency entirely (simframe's stated #1 roadmap goal).
  - **Perception:** `AXPTranslator` tree + in-process Vision OCR over the IOSurface; keep the layout-hash memory cache.
  - **Transport:** `0600` per-UDID Unix socket + thin CLI; keep filesystem frame cache for `sim_look`.
- Preserve simframe's genuinely good ideas: warm-frame, layout-hash memory, change-since-last-look baselines, liveness checks, one-writer-per-device.

**Proposed tool schema (compact, semantic, image-on-demand):**
```
# Observe (text by default)
sim_state()                    → {screen_hash, changed_since_last_look, changed_regions[]}
sim_ui(filter?)                → [{ref, role, "label", #id, =value, @x,y, src:ax|ocr, enabled}]
sim_find(query)                → matching elements (label/id/value/role)
sim_look(downscale=xga)        → image (ONLY when explicitly needed)
sim_recall(ago_ms?) / sim_strip(count?)

# Act (address by ref | #id | "label" | x y) — each settles locally
sim_tap(sel) / sim_type_into(sel, text) / sim_set_value / sim_clear
sim_scroll_to(sel) / sim_swipe / sim_drag / sim_longpress / sim_pinch / sim_rotate
sim_key(usage)

# Composite / high-level (one call, local verify, minimal round-trips)
sim_do(flow=[{tap|type|scroll|wait|assert}, …])   → per-step pass/fail + final state
sim_wait_for(sel|text, timeout)   sim_assert(sel, exists|gone|value=|label=)
sim_run_flow(yaml)                → deterministic replay, zero model calls
sim_open_url(url) / sim_launch(bundle, args?, env?) / sim_permission(grant|reset, svc, bundle)
```
Every Act/Composite call returns compact structured state (what changed + relevant elements), never an image unless `sim_look` is invoked.

**Stage 2 — Round-trip minimization (ongoing):**
- Local action-verification inside flows (verify-after-tap, already on simframe's roadmap); escalate to Claude only on mismatch.
- Emit replayable Maestro-style YAML from discovered flows for zero-model regression runs.
- Add deep-link/launch-argument/permission-seeding tools to skip navigation.
- Evaluate the MCP code-execution pattern for the inner loop.

**Stage 3 — Optional perception upgrades:** Set-of-Mark for the on-demand vision path; a local grounding model (OmniParser/UI-TARS via MLX) only if icon-only controls prove a real blocker.

**Benchmarks that should change the plan:**
- If per-glance capture stays ≥100ms after Stage 1, the IOSurface callback isn't wired correctly — target ≤20ms warm, ≤60ms cold incl. a11y (testa's number).
- If a test flow still costs >1 model turn per UI step, push more logic into composite tools/local verification.
- If images still cost >2,000 tokens each in Claude Code, the native-image path is broken — force text-only + skill CLI.
- If iOS 27/Xcode 27 breaks input, the 9-arg Indigo signature is the first suspect; isolate all private-symbol calls behind a mockable port (baguette's pattern) so a signature bump is a one-file change.

## Caveats and Trade-offs

- **Private API fragility is real and asymmetric.** The *input* path is the fragile one — iOS 26 already broke the 5-arg Indigo signature and required the 9-arg fix; `siri` button "crashes backboardd via every known Indigo path." The *capture* (IOSurface) and *accessibility* symbols are reported stable across the iOS 26 transition. Mitigate by (a) isolating every private call behind a mockable protocol, (b) pinning tested Xcode versions, (c) keeping a `simctl`+`idb` fallback capability (simframe's "degrade rather than fail" philosophy) so observation survives even if injection breaks.
- **No notarization / Gatekeeper:** a Swift binary calling private frameworks won't be notarized unless signed with your own Developer ID; distribute build-from-source (Homebrew tap / clone), as baguette and testa do.
- **SwiftUI/RN/WebView/Canvas accessibility gaps** remain the perception ceiling; OCR covers text but not label-less icons — those still need coordinates. This is inherent, not fixable by tooling.
- **Simulator-only** — `simctl` and the IOSurface path cannot touch a physical device (WebDriverAgent/XCUITest can, if that ever matters).
- **Localized confirm vocabulary** must be extended beyond English.
- **Screen-reflow** breaks the layout-hash memory (rebuilds ~600ms) — acceptable and self-healing.
- **Maintenance burden:** owning a private-framework daemon means tracking every Xcode release. This is the price of leaving the `simctl`/`idb` public surface — but baguette, testa, and ennio demonstrate it is a tractable, actively-maintained price in 2026, and it is the only path to true human-speed control.

### Key tools, repos, and sources
- simframe — github.com/lvlrSajjad/simframe
- baguette (capture + iOS-26 HID, MIT) — github.com/tddworks/baguette (see docs/ARCHITECTURE.md)
- testa (a11y + OCR + warm daemon, MIT) — github.com/valewnrt/testa
- ennio (Maestro-compatible RN runner, enniohid) — github.com/enzomanuelmangano/ennio
- facebook/idb — fbidb.io, github.com/facebook/idb (FBSimulatorControl/Framebuffer/FBFramebuffer.m)
- Maestro iOS driver rebuild — maestro.dev/blog/maestro-re-building-the-ios-driver
- ios-simulator-mcp — github.com/joshuayoes/ios-simulator-mcp, github.com/whitesmith/ios-simulator-mcp
- conorluddy/ios-simulator-skill — github.com/conorluddy/ios-simulator-skill
- OSWorld-Human (latency study) — arxiv.org/abs/2506.16042; writeup mlsys.wuklab.io/posts/oshuman
- OmniParser — learnopencv.com/omniparser-vision-based-gui-agent; UI-TARS — arxiv.org/pdf/2501.12326
- Anthropic computer-use tool — platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Anthropic code execution with MCP — anthropic.com/engineering/code-execution-with-mcp; advanced tool use — anthropic.com/engineering/advanced-tool-use
- Claude Code MCP image-token bug — github.com/anthropics/claude-code/issues/31208
- Apple Vision framework (VNRecognizeTextRequest) & ScreenCaptureKit — developer.apple.com