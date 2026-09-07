# On-Device iOS Screen Understanding for simframe: A Verified Tiered Perception Pipeline

## TL;DR
- **Yes — you can build a client-only pipeline that "understands" most iOS Simulator screens in tens of milliseconds and maps intents to elements locally, but only if you treat the accessibility tree as the primary source of truth.** In the Simulator you have direct programmatic access to the AX tree, which is ground truth (not an inference); the vision stack (Apple Vision OCR measured at 131 ms `.fast` / 207 ms `.accurate` per frame on M3 Max, plus classical CV element detection) is a fallback for custom/canvas/WebView surfaces where AX is thin.
- **Your tiered proposal is fundamentally correct and should be adopted, with three corrections:** (1) In the Simulator, AX is not a mere "Tier 0 hint" — it is authoritative and dramatically stronger than on a locked-down device, so Tiers 1–2 should be reserved for AX gaps; (2) Tier-2 local VLMs (OmniParser, UI-TARS-2B, Ferret-UI Lite 3B) cost hundreds of ms to seconds per frame on Apple Silicon, so they are milestone tools, not per-step tools; (3) the biggest latency win is the UI transition graph / screen-fingerprint cache, which drives model calls toward zero on repeated flows.
- **Escalate to Claude Code only at planning milestones** — a new/unrecognized screen fingerprint, an ambiguous intent→element match below threshold, a failed post-action verification, or a novel error/modal — not on every step. Everything else (element listing, intent matching, action verification, scroll/transition classification) runs locally.

## Key Findings

1. **The accessibility tree is your highest-value, cheapest signal and it is fully available in the Simulator.** Apple's "Screen Recognition" work exists precisely because on real locked devices apps often ship incomplete AX metadata — but in a Simulator you control, you can read the AX hierarchy directly (via the same APIs XCUITest/AXPTranslator use), giving element frames, roles, labels, values, and state with no inference error. Build everything on this first.

2. **Apple's Screen Recognition proves pixel-only UI detection is viable on-device — and gives you the target budget.** Per Apple Machine Learning Research and the CHI 2021 paper (Zhang, Wu, Fleizach, Everitt, Bigham et al., arXiv 2101.04893): "We trained a robust, fast, memory-efficient, on-device model to detect UI elements using a dataset of 77,637 screens (from 4,068 iPhone apps) that we collected and annotated," achieving "71.3% Mean Average Precision." The shipped SSD + MobileNetV1 + FPN model, per Apple: "Our final architecture uses only 20MB of memory (as a Core ML model), and takes only about 10ms per screen for inference" (on an iPhone 11 / A13). The model itself is NOT exposed via any public API, but the architecture is replicable and the budget (~10 ms on a 2019 phone) means a comparable detector on an M-series Mac is effectively free.

3. **Apple Vision OCR is fast enough for per-step use.** Measured by the ocrmac project on a MacBook Pro (Apple M3 Max): "accurate: 207 ms ± 1.49 ms per loop … fast: 131 ms ± 702 µs per loop … livetext: 174 ms ± 4.12 ms per loop (mean ± std. dev. of 7 runs)." For a UI screen with mostly crisp system text, `.accurate` with `usesLanguageCorrection = false` is usually the right call; `.fast` is for live-video-rate scanning. This is your Tier-1 text layer.

4. **Local GUI-grounding VLMs are milestone-grade, not per-step.** The best small open models (UI-TARS-2B, ShowUI-2B, OS-Atlas-4B, Ferret-UI Lite 3B, Qwen2.5-VL-3B) score 74–92% on ScreenSpot-v2 but cost hundreds of ms to seconds per frame on Apple Silicon. There is a genuine, documented gap: no published benchmark reports measured time-to-first-token or sec/image for a specific 2–3B GUI-grounding VLM on MLX/M-series. The closest Apple-Silicon proxy (vllm-mlx paper, M4 Max) shows multimodal query latency of ~21.7 s uncached collapsing to ~0.78 s with content-based prefix caching — confirming image encoding (not decode) dominates and that caching is essential.

5. **Memory-based planning is the single biggest lever.** AutoDroid (MobiCom '24, arXiv 2308.15272) cut average prompt length "from 625.3 to 339.0 tokens (nearly 50% reduction)" with "13.7% fewer LLM calls per task," and a Vicuna-7B "showed a 40.5% improvement in task completion when augmented with app memory." AutoDroid-V2 (MobiSys '25, arXiv 2412.18116) compiles the flow to a script executed by a local interpreter, achieving "43.5x and 5.8x reductions in input and output token consumption" and "5.7–13.4× lower LLM inference latency," with measured avg per-task latency of "46.3s, compared to 669.2s for the baseline on Snapdragon 8 Gen 2 (93.1% reduction)" across 226 tasks / 23 apps. The lesson for simframe: cache `screen_fingerprint → element_map` and `(screen_hash, action) → screen_hash'`, and repeated flows need zero model calls.

## Details

### 1. Classical / non-ML screen understanding

**Apple Screen Recognition (Zhang et al., CHI 2021, arXiv 2101.04893)** — the canonical reference and closest thing to your goal. Architecture: a data-collection + annotation pipeline (77,637 screens / 4,068 apps) feeding an on-device object detector. They rejected Faster R-CNN (>1 s/screen, >120 MB) and a TuriCreate detector (~20 ms, ~60 MB) in favor of **SSD + MobileNetV1 + FPN: ~10 ms inference, ~20 MB Core ML, 71.3% mAP** on an iPhone 11. It detects 13 UI element types, then augments with heuristics (grouping, navigation ordering) and additional small models: an icon-clickability Gradient-Boosted-Trees model (<10 ms, 10 MB Core ML) for interactivity, selection-state recognition, and the built-in OCR (<0.5 s). This proves that "understand the screen from pixels" fits in ~30 ms + OCR on a 2019 phone. The trained model is not published or API-exposed.

**UIED (Xie et al., ESEC/FSE 2020; MulongXie/UIED)** — the reference classical+hybrid detector. Non-text graphic elements via old-fashioned CV (Suzuki-Abe contour/border following, connected components, shape filtering) + a small CNN classifier; text via EAST (original paper) or Google OCR/EasyOCR (later). Honest limitation from downstream work: with a single fixed configuration UIED correctly localized the ground-truth region for only ~77.85% of intents; per-screen tuning of the minimum-element-size parameter is needed, and complex/gradient/photo backgrounds hurt it. Practical takeaway: classical CV is a useful *recall booster* for boxes Vision/AX miss, but its precision/config-sensitivity means you must fuse it with AX + OCR rather than trust it alone.

**OpenCV building blocks (all sub-10 ms at phone-screen resolution on Apple Silicon):**
- Connected components / `findContours` (Suzuki-Abe) for rectangle and card/cell detection.
- MSER for text-like/blob regions.
- `cv2.phaseCorrelate` (FFT-based, Fourier shift theorem) for global translational shift → scroll offset and push/pop direction.
- Text-box grouping via proximity/Gestalt clustering (union rows into labels, columns into lists).

**SF Symbols / icon template matching** — feasible but brittle. NCC template matching works when the glyph is pixel-stable (system tab bars, nav bar chevrons) but fails across weights/scales/tints and custom glyphs. ORB/feature matching is more scale/rotation tolerant but slower and weak on tiny, low-texture icons. Recommendation: maintain a small NCC template bank for the ~20 most common system controls (back chevron, share, add, search, ellipsis, checkmark, tab-bar defaults), and treat misses as "unknown icon" to be resolved by AX label or, failing that, Tier 2.

**iOS HIG structural priors** — high-value and cheap. Given screen size you can classify regions by position/size: status bar (top ~44–59 pt), nav bar (title + leading/trailing buttons), tab bar (bottom ~49–83 pt, 2–5 equal segments), toolbar, sheet (rounded top corners + dimmed backdrop occupying lower portion), alert (centered rounded rect + dimmed backdrop), keyboard (bottom ~40% with key grid), search bar. These priors both label regions and gate which detectors to run.

**State detection heuristics** — toggle on/off by fill color at the knob's rest position (green vs gray for the system switch), selected tab by tint/label color vs siblings, disabled by reduced contrast/opacity, checkbox/radio by inner-mark presence. These are cheap pixel samples inside a known frame and are reliable for system controls; custom controls need AX value or Tier 2.

### 2. Apple on-device APIs (macOS/iOS 26, WWDC 2025–2026)

- **Vision `VNRecognizeTextRequest`:** measured 131 ms `.fast` / 207 ms `.accurate` / 174 ms Live Text per screenshot on M3 Max (ocrmac). Returns strings, per-observation bounding boxes, and confidence (note: `.accurate` confidences cluster at 0.5/1.0; `.fast` gives more graduated confidences). Set `usesLanguageCorrection = false` for UI labels/numbers, supply `recognitionLanguages`, and use `regionOfInterest` to OCR just a changed region.
- **`VNDetectRectanglesRequest`, `VNDetectContoursRequest`:** on-device rectangle/contour detectors usable for card/button/field candidate boxes; complement or replace OpenCV if you want to stay in-framework. `RecognizeDocumentsRequest` (Vision, iOS/macOS 26) adds structured document/table grouping which can help with dense list/table screens.
- **No public Screen-Recognition / UI-element Vision API.** VisionKit's Live Text/`DataScanner` are text/data-centric, not general UI-element detectors. So the pixel-level element detector must be your own (classical CV or a Tier-2 model).
- **Apple Foundation Models framework (WWDC 2025, iOS/macOS 26):** Swift-native access to the on-device ~3B model (AFM), with **guided generation** (`@Generable`/`@Guide` for type-safe structured output via constrained decoding) and **tool calling** (`Tool` protocol). It is **text-only — no image input** — so it cannot ground on a screenshot, but it is an excellent *cheap local planner/reasoner* over your already-extracted element list (e.g., "given this JSON element list and the goal 'open Settings', return the element index to tap"). At WWDC 2026 Apple published AFM 3 (a 3B dense "Core" and a 20B sparse "Core Advanced" activating 1–4B/prompt via Instruction-Following Pruning); still text-only for the developer framework. Treat AFM as an optional on-device substitute for some Claude round-trips, not as a vision model.
- **`NLEmbedding.sentenceEmbedding` / `NLContextualEmbedding`:** ship on-device. `NLEmbedding` gives a 512-dim static sentence vector (WWDC 2020) computed locally in negligible time; `NLContextualEmbedding` (iOS 17+, BERT-like, per-token vectors, ~<100 MB models optimized for the Neural Engine, mean-pool for a sentence vector). Either is fast enough to embed an intent string and all element labels per screen and rank by cosine similarity — this is your local intent→element matcher, no network needed.
- **Xcode 26.x / simctl:** the durable UI-inspection/automation surface remains XCUITest + the Accessibility API (and `simctl`/`idb` for launching, taps, and screenshots). This is exactly what makes the Simulator case so much stronger than on-device: you can pull the real AX tree as ground truth.

### 3. Small local vision / GUI-grounding models (measured where available)

Grounding scores are ScreenSpot-v2 average unless noted; "commercial OK" flags license.

- **Apple FastVLM (CVPR 2025; apple/ml-fastvlm):** 0.5B/1.5B/7B; FastViTHD encoder emits 3–8× fewer visual tokens; **85× faster time-to-first-token than LLaVA-OneVision-0.5B**; MLX + Core ML export, official iOS/macOS demo; community-reported <120 ms to first token for 0.5B on iPhone 16 Pro. Strong for captioning/VQA/OCR-ish description; **not a trained GUI grounder** out of the box (no ScreenSpot SOTA claim). Best role: fast on-device "describe this region/screen" and state VQA, not coordinate grounding.
- **Apple Ferret-UI Lite (arXiv 2509.26539, Feb 2026):** 3B, purpose-built for on-device GUI agents (mobile/web/desktop). Per the paper: "In GUI grounding, Ferret-UI Lite attains scores of 91.6%, 53.3%, and 61.2% on the ScreenSpot-V2, ScreenSpot-Pro, and OSWorld-G benchmarks, respectively," with the 53.3% ScreenSpot-Pro "only slightly below GUI-Owl-7B (54.9)" and >15 pts above UI-TARS-1.5-7B on Pro. Uses inference-time crop-and-zoom (predict → crop → re-predict) to compensate for small capacity. Weakest on long multi-step navigation. Weights/runtime not yet released as a drop-in; represents the accuracy ceiling for a 3B on-device grounder and is trained on iOS pixels.
- **UI-TARS-2B / 1.5-7B (ByteDance, bytedance/UI-TARS):** UI-TARS-2B ScreenSpot-v2 **84.7%**; 7B **91.6%**. UI-TARS-1.5-7B is a strong open grounder. Coordinate-based; runnable via transformers/vLLM, and 2B is MLX-portable. Latency on Apple Silicon not officially published.
- **ShowUI-2B (showlab):** ScreenSpot-v2 **77.3%** (mobile 83.7); Qwen2-VL-2B base; lightweight; permissive. Good small default.
- **OS-Atlas-Base-4B / 7B (ICLR 2025; OS-Copilot):** 4B (InternVL2-4B) ScreenSpot-v2 ~ mid-80s; 7B (Qwen2-VL-7B) **85.1%**. Also "Pro" action variants. Apache-family license.
- **OmniParser v2 (microsoft/OmniParser-v2.0):** YOLOv8 icon detector + Florence-2 caption; not an end-to-end grounder but a *parser* that outputs a set-of-mark element list for any model to index into. Published latency **0.6 s/frame on A100, 0.8 s on a single RTX 4090** (detector+caption); a community MLX port claims ~110 ms/image detector-only on M4 (single-dev, unverified). **License caveat: `icon_detect` v1/v2 weights are AGPL-3.0** (inherited from Ultralytics YOLOv8; the model card states "icon_detect model is under AGPL license, and icon_caption is under MIT license"); the newer `icon_detect_v3` moved to an MIT YOLOv9 implementation. Detector file ~100 MB (.pt), ~80 MB as MLX float32. AGPL is a real commercial constraint for v1/v2 — prefer v3 or your own YOLO for shipping.
- **Holo1 / Holo1.5 / Holo2 (H Company):** Holo1-7B 76.2% avg localization; Holo1.5-7B ScreenSpot-Pro **57.94**; **Holo1/1.5 and Holo2-4B/8B are Apache-2.0**, Holo2-30B/235B research-only. Holo2-4B is a strong commercially-usable option if you can afford ~4B latency.
- **Moondream 2/3:** Moondream2 (1.8B) ScreenSpot F1@0.5 up to 80.4 after RL; Moondream 3 preview (2B active MoE, ~9B total) strong grounding, permissive license, but preview fp16 ~19 GB VRAM. Fast, permissive, good for detection/pointing; verify UI-specific accuracy.
- **SmolVLM2-2.2B / Smol2Operator:** base has 0% GUI grounding but fine-tunes to ~58% ScreenSpot-v2 at 460M; shows small models can be cheaply specialized. Apache-2.0.
- **Florence-2 base/large (MIT):** the captioner inside OmniParser; good detection/caption backbone, MIT-licensed, Core ML-convertible.
- **Qwen2.5-VL-3B / 7B:** 3B ScreenSpot-v2 80.9%; 7B 88.8%; base for many GUI fine-tunes; mlx-vlm supports 3B-4bit directly. Qwen3-VL-2B reports ScreenSpot-v2 86.7 (third-party tables). Strong MLX ecosystem support.
- **Others noted:** GUI-Actor (coordinate-free action head; 2B surpasses many 7B), UGround/Aguvis/SeeClick/CogAgent (mostly larger or older), ScreenAI (Google, not open-weights), PaliGemma 2, Gemma 3n (edge multimodal). Newest high scorers (UI-Venus-1.5, GUI-Owl/Mobile-Agent-v3.5, MAI-UI, MolmoPoint) are mostly ≥7B and beyond your latency budget.

**iOS-specific training data:** Ferret-UI / Ferret-UI 2 (iPhone + iPad + AppleTV) and Apple Screen Recognition are the only ones trained substantially on iOS pixels; most others are web/Android/desktop-heavy (Rico, AMEX, AndroidControl, GUI-Odyssey), a real domain-shift risk for iOS.

### 4. Purely-local "decide what to click" and memory-based planning

- **Intent→element grounding without a VLM:** embed the intent and each element's label/role/synonyms with `NLEmbedding`/`NLContextualEmbedding` (or bge-small/MiniLM via Core ML) and rank by cosine; combine with fuzzy string match + a small synonym table ("Login"≈"Sign in"≈"Log in"). This resolves the majority of "tap X" intents in <5 ms once embeddings are cached.
- **Set-of-mark:** if you must call a VLM (Tier 2/3), overlay numeric IDs on detected elements and have the model return an *index*, not coordinates — this is exactly OmniParser's design and is what lifts raw-vision agents off the floor on hard grounding benchmarks. It also makes your local element list the single source of truth.
- **UI transition graph & app memory (AutoDroid, MobiCom 2024):** offline/looped exploration builds a `screen → (element, action) → screen'` graph plus a "UI function table"; injecting relevant memory cut prompt length "from 625.3 to 339.0 tokens (nearly 50% reduction)," reduced LLM calls per task 13.7%, and improved a Vicuna-7B's task completion by 40.5%; the full system reached 90.9% action accuracy / 71.3% task success on 158 tasks with GPT-4.
- **AutoDroid-V2 (MobiSys 2025):** reframes automation as code generation — a local SLM emits a multi-step script executed by a DSL interpreter, giving "43.5x and 5.8x reductions in input and output token consumption" and "5.7–13.4× lower LLM inference latency," with measured average per-task latency of "46.3s, compared to 669.2s for the baseline on Snapdragon 8 Gen 2 (93.1% reduction)" across 226 tasks / 23 apps. Directly applicable: once simframe has walked a flow (e.g., login), compile it into a reusable local script keyed by app + screen fingerprint.
- **Other agents (context):** Mobile-Agent-v2/v3, AppAgent, DroidBot-GPT, Agent-S/S2 — all confirm the same architecture: perceive (prefer structured tree) → ground → act → verify, with a memory that amortizes model calls. AFM (Foundation Models) can serve as the local planner over your element JSON when a step needs reasoning but not vision.

### 5. Change understanding across frame history (all local, sub-10 ms)

- **dHash/pHash Hamming distance** (you already have dHash) → change/settle detection and screen fingerprinting; pHash (DCT-based) is robust to minor rendering noise.
- **Region diff + SSIM** on tiles → localize *what* changed (bottom ~40% only → keyboard; centered rect + global dimming → alert/sheet; small top banner → toast).
- **`phaseCorrelate` / optical flow** → scroll offset (vertical shift with stable chrome), push (horizontal shift of full content + nav-bar title crossfade), pop (reverse).
- **Transition classification** by combining the above: navigation push/pop, modal sheet, alert, keyboard up/down, toast, spinner/loading (localized animated region with no settle), scroll.
- **Settled-state detection:** consecutive frames with dHash distance below threshold for N frames = settled; gate perception and verification on "settled."
- **Local action verification:** after a tap, assert the expected transition (fingerprint changed to the predicted `screen_hash'`, or the expected element/state appeared). Mismatch → re-perceive, then escalate. This loop lets simframe run many steps before consulting Claude.

### 6. Corrected tiered pipeline for simframe

**Data structures (local, per screen):**
```
Element {
  id: int                     // stable within screen; used for set-of-mark
  frame: Rect                 // in screen pixels
  role: enum                  // button, textfield, toggle, tab, cell, icon, static_text, image, nav_bar, tab_bar, alert, sheet, keyboard...
  label: string               // AX label | OCR text | icon-template name | VLM caption
  value: string?              // AX value (toggle state, field text)
  state: {enabled, selected, checked, focused}
  source: bitmask             // {AX, OCR, CV, TEMPLATE, VLM}
  confidence: float           // fused
  embedding: [Float]?         // cached label embedding
}
ScreenMap {
  screen_fingerprint: hash    // layout-hash (dHash of structure + role histogram)
  size: (w,h); safe_area
  regions: [Region]           // HIG priors: nav/tab/sheet/alert/keyboard
  elements: [Element]
}
TransitionGraph {
  edges: map<(screen_fingerprint, action) -> screen_fingerprint'>
  scripts: map<(app, goal) -> compiled_step_list>   // AutoDroid-V2 style
}
```

**Tier 0 — Accessibility tree (authoritative in Simulator), ~10–60 ms.** Pull the AX hierarchy for the frontmost simulator app. Populate `Element`s directly (frame/role/label/value/state). For most standard UIKit/SwiftUI screens this alone is a complete, correct element list — no vision needed. Compute `screen_fingerprint`.

**Tier 1 — Vision fusion, ~150–250 ms, run only for AX gaps or non-native surfaces.** For regions the AX tree marks opaque/custom (canvas, WebView, game views, custom-drawn controls) or when the AX label is empty: run Vision OCR (`.accurate`, correction off) for text; OpenCV/`VNDetectRectangles`/`VNDetectContours` for boxes; NCC template bank for system icons; apply HIG region priors and state heuristics. **Fuse** into the element list: match vision boxes to AX frames by IoU; where AX exists it wins on role/label, vision fills missing label/state; vision-only boxes are added with `source=CV/OCR` and lower confidence. Deduplicate by IoU > 0.6.

**Intent matching (local), <5 ms.** Embed intent (NLEmbedding) → cosine vs cached element-label embeddings + fuzzy/synonym boost + role prior (e.g., "type email" prefers textfield). Return best element if score ≥ τ_high; if τ_low ≤ score < τ_high, mark ambiguous.

**Tier 2 — Small local model, only when Tier 0+1 ambiguous.** Overlay set-of-mark IDs on the current element list and ask a 2–3B grounder (Ferret-UI Lite-class if/when weights ship, else UI-TARS-2B / ShowUI-2B / Qwen2.5-VL-3B via mlx-vlm) to return the element index for the intent, OR run OmniParser (v3 detector to avoid AGPL) to recover icon-only/custom boxes then re-match. Budget: expect several hundred ms to ~1–2 s incl. image encoding; **mandatory content-based prefix caching** (hash the frame; reuse vision encoding) per the vllm-mlx result. FastVLM is the fast choice for "describe this region / what state is this control" VQA.

**Tier 3 — Claude Code, only at milestones.** Return to Claude a **compact text screen-map**, not pixels:
```
SCREEN fp=8f3a size=390x844 kind=nav+list
regions: navbar("Settings"), tabbar[General|Privacy*|About]
elements:
  1 button "Back" [enabled] @(16,52,44,44)
  2 textfield "Search" value="" [focused] @(...)
  3 cell "Wi-Fi" value="MyNet" [enabled] @(...)
  ...
last_action: tap(#12 "Login") -> transition=push OK (fp 8f3a->b1c2)
ambiguous: intent "open privacy" ~ {#7 0.61, #9 0.58}
```

**Escalation rules (trigger Claude):**
1. `screen_fingerprint` unseen in `TransitionGraph` (novel screen/flow).
2. Intent→element best score < τ_high AND Tier-2 disagreement/low confidence.
3. Post-action verification failed (transition ≠ predicted, or expected element/state absent).
4. Novel modal/alert/error not in memory, or a permission/system dialog.
5. Multi-step goal with no compiled script and no matching memory.

Otherwise, act locally and record the edge; on success, extend/compile the script so the same flow later costs zero model calls.

### 7. Benchmarks/datasets and building an iOS eval set

- **Existing:** Rico/RICO-SCA and AMEX (104K screens, 110 apps, element grounding + functionality + action chains), AndroidControl, GUI-Odyssey — **all Android**. ScreenSpot / ScreenSpot-v2 / ScreenSpot-Pro (grounding), OSWorld-G, WebClick — cross-platform but web/desktop/Android-weighted. **iOS-specific:** Ferret-UI / Ferret-UI 2 iPhone+iPad data and Apple's Screen Recognition dataset (not public). This Android/web skew is the main external-validity risk.
- **Build your own iOS eval set — you already have the ideal oracle.** In the Simulator, capture (screenshot, AX tree) pairs across a corpus of apps/screens. Use the **AX tree as ground truth** for element frames/roles/labels/states. Then evaluate your vision-only stack (Tiers 1–2, AX withheld) against it: report element-detection mAP/IoU, role accuracy, OCR CER on labels, state-classification accuracy, and intent→element top-1 accuracy. Include deliberately AX-poor screens (WebViews, SpriteKit/Metal canvases, custom-drawn controls) to measure the exact regime where you must fall back to vision. Track end-to-end per-tier latency on your target M-series chip.

## Recommendations

**Stage 1 (build now, days):** Ship Tier 0 + intent matching. Read the AX tree via the Simulator, build the `ScreenMap`/`Element` structures, and do local intent→element matching with `NLEmbedding` + fuzzy/synonym. Add dHash settle detection (you have it) and a `screen_fingerprint`. Add local post-action verification (predicted vs observed fingerprint). This alone should let Claude drive most standard UIKit/SwiftUI apps with per-step latency in the tens of ms and Claude consulted only on new screens.

**Stage 2 (weeks):** Add the `TransitionGraph` + app memory and AutoDroid-V2-style script compilation for recurring flows (login, onboarding, settings toggles). Benchmark: once a flow is in memory, model/Claude calls per repeat should approach zero (AutoDroid-V2's own numbers show ~93% per-task latency reduction from this pattern). Add Tier 1 vision fusion (Vision OCR `.accurate` + OpenCV/`VNDetectRectangles` + NCC icon bank + HIG priors + state heuristics) gated to AX-gap regions.

**Stage 3 (as needed):** Add exactly one Tier-2 model behind a feature flag, chosen by license and latency: **ShowUI-2B or Qwen2.5-VL-3B via mlx-vlm** for permissive commercial use, or **Holo2-4B (Apache-2.0)** if you can afford the latency; adopt **Ferret-UI Lite** if/when Apple ships weights. If you use OmniParser, use the **v3 (MIT YOLOv9) detector**, not the AGPL v1/v2 one. Always drive it with set-of-mark over your local element list and enable content-based prefix caching. Use **FastVLM 0.5B (Core ML/MLX)** for cheap region-VQA/state questions.

**Thresholds that change the plan:**
- If AX coverage on your target apps is >~90% of interactive elements, you may never need Tier 2 in production — keep it as a fallback only.
- If Tier-2 image-encode latency stays >~1 s on your chip, restrict it strictly to milestones and cache aggressively; do not put it in the per-step loop.
- If your self-collected iOS eval shows vision-only element mAP <~0.6 on AX-poor screens, invest in a small iOS-fine-tuned YOLO detector (Screen-Recognition-style) rather than a general web-trained model.
- Consider Apple Foundation Models as a local planner once you measure its latency on your machine; if it reliably picks the right element index from your JSON in <~300 ms, it can absorb a large share of Claude planning round-trips (but it cannot see the screen — feed it your element list).

## Caveats
- **Icon-only custom glyphs, canvas/Metal/SpriteKit UIs, and WebViews** are where AX is thin and classical CV/templates are weak; these are the true Tier-2/Tier-3 cases. Expect false positives from OpenCV on gradient/photo backgrounds (UIED's documented failure mode) — always cross-check vision boxes against AX and require IoU/consistency before trusting them.
- **The 10 ms / 20 MB Screen Recognition figures are on an iPhone 11 (A13), not a Mac**, and the model is not public; treat them as a feasibility target, not a drop-in. **Vision OCR timings (131/207 ms) are M3 Max**; your chip will differ.
- **There is a real measurement gap:** no published TTFT/sec-per-image benchmark exists for a specific 2–3B GUI-grounding VLM on MLX/M-series. The Apple-Silicon numbers cited for VLMs are proxies (vllm-mlx M4 Max; FastVLM iPhone demo) — measure your chosen model on your hardware before committing it to any latency-sensitive path.
- **License landscape is a trap:** OmniParser v1/v2 icon detector is AGPL-3.0 (Ultralytics YOLOv8); Holo2-30B/235B and H-company large models are research-only; UI-Venus/MAI-UI/GUI-Owl top scorers are ≥7B. Verify each model's license against your commercial plans; prefer Apache-2.0/MIT (ShowUI, OS-Atlas base, Holo2-4B/8B, Florence-2, Qwen2.5-VL) for shipping.
- **Domain shift:** almost all open GUI grounders are trained web/Android/desktop-heavy; iOS-specific accuracy will be lower than headline ScreenSpot numbers until you validate on your own iOS eval set.
- **Measured vs estimated:** *Measured* = Screen Recognition 10 ms / 20 MB / 71.3% mAP (iPhone 11); Vision OCR 131/207/174 ms (M3 Max); OmniParser 0.6 s A100 / 0.8 s RTX 4090; AutoDroid token/call/latency reductions and AutoDroid-V2 46.3 s vs 669.2 s (Snapdragon 8 Gen 2); Ferret-UI Lite ScreenSpot 91.6/53.3/61.2; ScreenSpot-v2 accuracies. *Estimated / proxy* = all Apple-Silicon VLM latencies, per-tier budget sums, and the ~110 ms OmniParser-on-M4 community claim.