# Naming Icon-Only Buttons in iOS Simulator Apps for simframe: Research Report and Ranked Recommendation

**Bottom line:** Build an "exact-source" namer first. It reads names from the app's own bundled icon fonts and asset catalogs, plus a host-rendered SF Symbols bank, and accepts a template match only when the binarized-glyph score clears both an absolute floor and a top-1/top-2 margin. Wrap it in context *vetoes*, not context *guesses*. A general-purpose learned classifier is not the right tool: no Apple API gives one without shipped weights, and the literature that reports 96% icon accuracy does so with models trained on hundreds of thousands of labeled icons, which you cannot ship.

## TL;DR

- **Most promising path (unmeasured for your setting):** In React Native, Expo and Flutter apps, the exact icon font ships inside the .app. For native apps, SF Symbols can be rendered on the user's Mac. So the matching problem shrinks from "recognize any icon" to "find which of N known glyphs this crop is." Treat precision ≥0.98 on dangerous classes as a target to verify on your own benchmark, not as a published result. No paper measures this exact pipeline.
- **Apple on-device models:** Since WWDC 2026 (iOS 27 / macOS 27), Foundation Models accepts image attachments (UIImage, NSImage, CGImage, CIImage, CVPixelBuffer, file URLs). Which Macs support it, its accuracy on 60–132 px glyphs, and its latency are all unpublished. Use it only as a second-opinion verifier that can veto a match, never as the sole namer. Vision's VNClassifyImageRequest (1,303 photo-taxonomy classes) and feature prints are photo-trained, with no published icon accuracy.
- **Order of work:** (1) harvest free metadata (identifiers, testIDs, system-provided labels); (2) bundled-font and Assets.car extraction with exact-raster matching; (3) a curated SF Symbols dangerous-class bank; (4) context vetoes; (5) a Foundation Models verifier spike. Each step has a kill experiment, listed in Section 7. Budget roughly 15–22 person-days for 1–4 plus the spike.

## Key Findings

| Question | Answer in one line | Evidence quality |
|---|---|---|
| 1a Icon fonts in app | Fonts plus glyph maps are recoverable. Flutter release builds tree-shake MaterialIcons down to only the used glyphs, which shrinks the bank to exactly what the app uses\[1\] | Strong (official repos, issue logs) |
| 1b Assets.car | `assetutil --info` (public, ships with Xcode) dumps names as JSON. Pixel extraction needs CoreUI-based tools (private framework)\[2\] | Strong for listing; no empirical naming-convention data found |
| 1c SF Symbols | SF Symbols 8 has "more than 7,000 symbols" (9to5Mac).\[3\] Name lists in CoreGlyphs' name_availability.plist hold 8,000–9,000+ entries including variants. Licence ties symbols to Apple-platform software; matching on the user's Mac is a gray but defensible reading\[4\] | Counts: medium (conflicting tool counts). Licence: interpretation only, not legal advice |
| 2 Matching | Binarized NCC or chamfer against an exact-source bank is the right core. ORB/SIFT fail on low-texture icons. Feature prints are photo-semantic, and their distance scale changed between OS releases\[5\] | Medium; few icon-specific measurements |
| 3 Apple models | Foundation Models image input exists (WWDC26).\[6\] Visual Intelligence's IntentValueQuery is an inbound system→app hook, not a classifier you can call | Strong for API existence; no accuracy data |
| 4 Context | Nearby text detection 95.3% accurate (Chen et al. CHI '22),\[7\] yet 46.7% of icons are standalone. One shape can mean several things ("X" = close/delete/multiply)\[8\] | Strong |
| 5 Evaluation | Zero wrong names in ≥150 accepted predictions is the minimum to claim precision ≥0.98 at 95% confidence (rule of three) | Arithmetic |

## 1. Icons shipped inside the app under test

### 1a. React Native, Expo, Flutter and native icon fonts

**Where the files are.** In a Simulator install the .app sits unencrypted under `.../data/Containers/Bundle/Application/<UUID>/<App>.app`. Simulator builds are not FairPlay-encrypted. That is standard Simulator behaviour, but no Apple document stating it was located for this report.
- **react-native-vector-icons:** iOS setup copies `.ttf` files (AntDesign, Entypo, Feather, FontAwesome 5/6 variants, Ionicons, MaterialIcons, MaterialCommunityIcons, Octicons, Fontisto, …) into the bundle and lists them under `UIAppFonts` in Info.plist.\[9\]\[10\] That makes `Info.plist → UIAppFonts` the authoritative list of fonts to scan. The npm README lists MaterialCommunityIcons v6.5.95 with 6,596 icons and Ionicons v7.1.0 with 1,338 icons.\[11\] The package ships name→codepoint glyph maps as JSON (`glyphmaps/MaterialCommunityIcons.json`, `Ionicons.json`, `FontAwesome5Free.json`, etc.).\[12\] These JSON maps live in node_modules, **not** in the .app, because the JS bundle inlines them. Two practical routes follow: (i) parse the font's own `post`/`cmap` tables, which usually carry glyph names in community icon fonts; or (ii) fetch the published glyphmap for the font version identified by the font's `name` table at *runtime on the user's Mac* from npm. That is a download of a public JSON file, not shipped weights.
- **@expo/vector-icons** wraps the same fonts, so the same approach applies.
- **Flutter:** assets sit under `Runner.app/Frameworks/App.framework/flutter_assets/` with `FontManifest.json` listing font families. Release builds tree-shake icon fonts aggressively. Flutter's own build log reports `"MaterialIcons-Regular.otf" was tree-shaken, reducing it from 1645184 to 1640 bytes (99.9% reduction)` (flutter/flutter issue #172449).\[1\] Apps that build `IconData` non-constantly must pass `--no-tree-shake-icons`, and then the full font ships.\[13\]\[14\] **Tree-shaking helps you:** the shipped font contains *only* the glyphs the app uses, so the bank is tiny and exact. The catch is that subsetted fonts may lose glyph names. You then need Flutter's `icons.dart` codepoint→name table **for that Flutter version**. FlutterIconPicker notes that "flutter framework is constantly changing codePoint's", so codepoint→name maps are version-specific.\[15\] Getting the Flutter engine version from the bundle is feasible but not verified here.
- **Rendering templates on the host:** CoreText (`CTFontCreateWithGraphicsFont` + `CTFontGetGlyphsForCharacters` + `CTFontDrawGlyphs`) renders any glyph at any pixel size with system antialiasing, close to what the Simulator produces. fontTools (Python) is the easiest way to read `cmap`/`post` tables, but it adds a Python dependency. A small Swift helper using CoreText covers both jobs without it.

**How reliable are glyph names as semantics?** No study measuring how often app authors use an icon-font glyph for a meaning other than its name was found. Treat that as **unknown / no measured data found**. Indirect evidence:
- Sunkara et al. (Google Research, "Towards Better Semantic Understanding of Mobile Interfaces") had to build a separate *icon semantics* layer because shape ≠ function. An "X" can mean "close", "remove an option/entry", "delete/clear text" or "multiply". They report that 11% of screens with ICON_PLAY, 4.9% with ICON_X and 4.8% with ICON_CHAT show the same shape with different meanings *on the same screen*. They also note earlier RICO labels (Liu et al. 2018) conflated "close" and "delete", "undo" and "back", and "add" and "expand".\[8\]
- **Implication for simframe:** report the *glyph name* verbatim ("glyph: trash-can-outline") rather than a translated action ("Delete"). Map to dangerous *classes* with a hand-curated table, for example MDI `delete`, `delete-outline`, `trash-can*`; Ionicons `trash*`; FontAwesome `trash*`, `trash-alt`. Let the agent's safety rule key off the class. Names such as `close`, `x`, `minus-circle` must stay **ambiguous** (possible delete) and should trigger confirmation rather than a benign label.

### 1b. Asset catalogs (Assets.car)

- **Listing (public tooling):** `assetutil --info Assets.car` (ships with Xcode, `xcrun --sdk iphoneos assetutil`) emits JSON for every rendition: `Name`, `RenditionName`, scale, idiom, pixel size, and more (assetutil man page; halmueller/assetutil-convert shows the fields).\[16\]\[17\] Developers on Apple's forums use it to inspect `RenditionName` values.\[18\] That is enough to get image-set **names** without private API.
- **Pixel extraction:** this needs CoreUI, a private framework, through acextract (bartoszj/acextract: "Can extract PNG and PDF files", list mode `-l`) or Asset Catalog Tinkerer (insidegui; v2.9).\[2\]\[19\] Marxon13's iOS-Asset-Extractor documents a CoreUI quirk: a process that has already loaded an Assets.car can crash with EXC_BAD_ACCESS, so they spawn one subprocess per .car.\[20\] Amy Worrall's write-up notes that *consuming* a .car through a bundle is public API: load the bundle and ask `UIImage(named:in:)`/`NSImage` for the image by name.\[21\] **Recommended route:** list names with `assetutil --info`, then render each named image on the host by loading the .app's bundle (or a copy) and asking for the image by name through public AppKit/UIKit-for-Mac APIs. Whether an iOS-Simulator-idiom catalog renders correctly through macOS `NSImage` lookup is **not verified**, so test it.
- **Simulator note:** Simulator builds run the asset catalog through `actool` like device builds, so an Assets.car is present. Debug builds may contain extra renditions. Not separately verified.
- **How meaningful are names ("ic_delete" vs "img_1234")?** **No empirical study of iOS asset-catalog naming conventions was found.** Expect a mix: designer exports (`icon-trash-24`), auto-names (`Group 12`, `Vector`), and localized or hashed names. The kill experiment in Section 7 measures this directly on 20 apps.

### 1c. SF Symbols

- **Count:** 9to5Mac (June 12, 2026) reports the SF Symbols 8 beta "features more than 7,000 symbols" across iOS 27/macOS 27.\[3\] Tool-derived *name* counts run higher because they include variants and aliases: sfsym reports "8,300 or more" names read from CoreGlyphs' Assets.car, sfsymbols-mcp reports "9,000+",\[22\]\[23\] and a third-party browser lists 8,111 for "SF Symbols 8.1.3".\[24\] These counts conflict because they measure different things (symbols vs names/aliases). Use the installed plist as ground truth at runtime. Apple's SF Symbols download page was also reported as labelling the current release by OS year ("SF Symbols 27") in one fetch.\[25\] The naming may have changed with the 2026 OS-year versioning, so check the docs.
- **Name lists without shipping anything:** `/System/Library/CoreServices/CoreGlyphs.bundle/Contents/Resources/name_availability.plist` maps symbol→introduction year. `symbol_search.plist` and `name_aliases.strings` provide keywords and aliases (SFSafeSymbols CONTRIBUTING; sfsymbols-mcp).\[22\]\[26\] The Simulator runtime carries its own copy inside the `.simruntime` RuntimeRoot.\[26\]\[27\] This matters because the app under test runs against the *Simulator's* symbol set, not the host's. Prefer the runtime's copy when it exists.
- **Rendering:** `NSImage(systemSymbolName:accessibilityDescription:)` with `NSImage.SymbolConfiguration(pointSize:weight:scale:)` and a monochrome/hierarchical rendering mode, rasterized at 3× (or 2× for @2x devices). Rendering all ~7,000 symbols × 9 weights × 3 scales is about 190k templates. That is unnecessary. Restrict to weights regular/medium/semibold, the scales the size implies, and a curated subset of a few hundred symbols, with the full set as an optional second tier.
- **Licence:** Apple's text, quoted by Apple forum staff and users from the SF Symbols page: "All SF Symbols shall be considered to be system-provided images as defined in the Xcode and Apple SDKs license agreements… You may not use SF Symbols — or glyphs that are substantially or confusingly similar — in your app icons, logos, or any other trademark-related use."\[4\]\[28\] The Xcode and Apple SDKs Agreement grants a "limited, non-exclusive, personal, revocable… internal use license" and says the software is "AUTHORIZED ONLY FOR EXECUTION ON AN APPLE-BRANDED PRODUCT RUNNING MACOS".\[29\] An older SF Symbols licence variant limited use to "creating mock-ups of user interfaces for software products running on Apple's iOS, iPadOS, macOS and tvOS".\[30\] **Interpretation (not legal advice):** rendering symbols on the user's own Mac, keeping them in memory or a local cache, and using them only to test iOS software is close to the licence's purpose (developing and testing Apple-platform apps) and involves no redistribution. The risky acts are shipping rendered PNGs or vector outlines in the npm package, or uploading them anywhere. Keep the cache local and never commit it. Get a lawyer's read before a commercial launch.

## 2. Matching a crop to a template bank

**What is measured vs unknown.** No published benchmark matches 60–132 px tinted iOS glyphs against SF Symbols or icon-font banks. Every precision/recall figure below that is not attributed is **unknown / no measured data found**.

| Method | Fit for 60–132 px monochrome glyphs | Known evidence | Role |
|---|---|---|---|
| NCC (`TM_CCOEFF_NORMED`) on binarized/alpha masks | Good when the template comes from the *same* source raster; sensitive to 1 px stroke-weight changes and sub-pixel offset | Sikuli uses NCC template matching for "small patterns" such as icons. SikuliX users report false positives above 0.98 similarity when large black/white backgrounds dominate\[31\]\[32\] | **Primary scorer** (mask-only, background excluded) |
| Chamfer / distance-transform | Tolerant of 1 px antialiasing and weight drift; cheap | Classic shape matching; no icon-specific iOS measurement found | **Secondary scorer** for SF Symbol weight mismatch |
| Hu / Zernike moments | Rotation/scale invariant but weak at telling similar silhouettes apart (trash vs archive box) | No icon measurement found | Pre-filter only |
| pHash / dHash / aHash / blockhash | 64-bit hashes of 8×8–32×32 downsamples lose thin-stroke detail | No measurement on line icons found | Fast dedupe and cache key, not naming |
| ORB / SIFT / AKAZE | Poor: low texture, few keypoints | NiCro (arXiv 2305.14611): SIFT accuracy is low on widgets because "icons, do not have complicated textures so SIFT fails to extract sufficient features points"\[33\] | Do not use |
| Vision feature print | Semantic, photo-trained embedding; scale changed between releases | MWM.io measured iOS 16: 2048-dim non-normalized, distances 0–~40; iOS 17: 768-dim normalized, distances 0–2.\[5\] No icon accuracy published | Optional tie-break feature; recalibrate thresholds per OS |
| Learned embeddings without shipped weights | Only Apple's (feature print, Foundation Models) qualify | — | See §3 |

**Preprocessing recipe (design, not measured):**
1. Crop from the accessibility frame. Pad 2 px and square it, as Chen et al. CHI '22 do: they "extend the bounding box to be a square using the larger-side length".\[34\]\[35\]
2. Extract the glyph mask. Estimate the background as the border-pixel mode, take per-pixel distance from it, then Otsu-threshold. That removes tint and dark-mode differences.
3. Tight-crop the mask, then resize it to a canonical 64×64 keeping aspect ratio.
4. Render each template the same way, on transparent background, as alpha → mask.
5. Score with NCC on masks at 3 scales (±8%) and ±1 px shifts, plus a chamfer score.

**Refusal threshold (design):** accept the top-1 only if (a) its score is above an absolute floor calibrated on held-out *negatives* (avatars, logos, custom glyphs absent from the bank) so that ≤1% of negatives pass, **and** (b) its margin over the best template of a *different class* exceeds a calibrated margin. Variants of the same class (`trash` vs `trash.fill`) must not cancel each other. Recalibrate whenever the OS or Simulator runtime changes; the feature-print scale change between iOS 16 and 17 shows why.\[5\]

**Latency:** **no measured numbers for this workload were found.** Back-of-envelope only: a 64×64 mask NCC against 7,000 templates is about 29 M multiply-adds per crop. That should run in low milliseconds with Accelerate/vDSP on Apple silicon, and much faster with a hash or moment pre-filter that keeps the top 50. Feature-print generation latency per crop on M-series Macs is **unknown**; measure it in kill experiment K3.

## 3. Apple on-device models that need no shipped weights

- **Foundation Models image input (new in 2026):** In WWDC26 session 241, Apple says "the on-device model is also gaining Vision capabilities… Simply insert an image attachment into your prompt… Image attachments can be created from… UIImage, NSImage, CGImage Core Image types, CoreVideo Pixel Buffers, and file URLs", and "larger images will consume more tokens and incur more latency."\[6\] The API is `Attachment(image)` inside a `Prompt { }` builder, with `ImageAttachmentContent` / `ImageReference` in the docs index.\[36\]\[37\] Session 237 adds image-typed tool arguments and built-in `OCRTool` / `BarcodeReaderTool`.\[36\] The session's sample prints a context size of 8,192 tokens.\[6\] Apple's third-generation models post describes AFM 3 Core (3B dense) and AFM 3 Core Advanced (20B sparse, "unlocked by and optimized for our most capable Apple silicon systems"). Users preferred AFM 3 Core over the previous generation "more than 61 percent of the time" for image understanding.\[38\] That is a preference rate, not accuracy. **Unknown:** which Macs support image input (secondary sources conflict: byteiota claims it requires Core Advanced on high-end devices only,\[39\] while Apple reports image evaluations for Core), per-image token cost, latency, and accuracy on UI glyphs. Apple's benchmark tech report was promised "later this summer"\[38\] but none was found. The 2025 report gave image-token figures (9 tokens per image in rapid mode vs 144 otherwise) for the old model only.\[40\] **Use:** a constrained verifier ("Is this icon a trash can? Answer yes/no/unsure") run on accepted dangerous-class matches. A "no" vetoes; it never creates names. The framework now also lets other models plug in through a `LanguageModel` protocol, including Private Cloud Compute, Claude and Gemini.\[6\]\[41\] Those are cloud and violate your constraint, so pin to `SystemLanguageModel`.
- **VNClassifyImageRequest:** 1,303 identifiers in revision 1 (Kamil Tustanowski; alexdong's gist of `knownClassifications`).\[42\] The taxonomy is photographic (animals, food, scenes, objects, with a generic "illustrations"). There is no "trash can icon" or "paper plane icon" class, and **no published measurement on icons, clip art or sketches was found.** Expect it to be useless for naming.
- **VNRecognizeTextRequest / RecognizeDocumentsRequest:** useful only for text *inside or next to* icons (badges, "30" in skip-30, tab labels). Not glyph classifiers.
- **Visual Intelligence (IntentValueQuery + SemanticContentDescriptor):** this is an *inbound* integration. The system passes a captured pixel buffer *to your app* so your app returns AppEntity results. Apple's WWDC26 session 297 suggests implementing it with `GenerateImageFeaturePrintRequest` and precomputed feature prints.\[43\] It cannot be called as a classifier and is irrelevant here, except as confirmation that Apple's own recommended on-device matcher is feature-print kNN.
- **Screen Recognition's "Icon Recognition engine in VoiceOver":** Apple's CHI '21 paper says it classifies "38 common icon type[s]".\[44\] It is a system feature, **not developer-accessible**. Whether VoiceOver Recognition labels show up in the accessibility tree that simframe reads is **unknown**; it is cheap to test (see K1).
- **Create ML at runtime on the user's Mac:** `MLImageClassifier` uses Apple's Vision Feature Print backbone; Kodeco states "Create ML's image classifier always uses the VisionFeaturePrint_Screen base model". Kodeco's tutorial (Machine Learning by Tutorials, Ch. 3) reports that training on 4,838 images across 20 snack classes "took 2 minutes, 47 seconds — most of that time was spent on extracting features". At a few hundred rendered templates, training in seconds to tens of seconds is plausible but **not measured**. It inherits the feature print's photo bias and adds little over direct kNN on feature prints. Deprioritize.
- **Apple Intelligence screen awareness / onscreen content:** the developer surface is *outbound*: apps annotate their own content with `appEntityIdentifier` / `userActivity`. No API reads another app's screen semantics. Not usable.

## 4. Context priors

**What the literature reports:**
- **Chen et al., CHI '22, "Towards Complete Icon Labeling in Mobile Applications".** This is an **Apple** paper (Jieshan Chen was at ANU, interning at Apple), not Google as the brief stated. The dataset has 327,879 iPhone icons. 98 common types cover 92.8% of icons and 331 long-tail types cover the rest.\[34\] Common-icon classifier accuracy is 96.3% and long-tail few-shot 78.6%. Nearby-text detection is 95.3% accurate and modifier detection 87.4%.\[7\]\[34\] End-to-end accuracy on matched detections is 90.7%.\[35\] In a validation study, 80.3% of 2,064 predictions were judged useful by ≥1 worker. Of 2,535 sampled icons, 46.7% were **standalone** (no nearby text), 39.3% partial and 14% duplicate.\[35\] The most frequent types are Back (11%), Right Arrow (10%) and Close (7%).\[34\] The paper does not report a with/without-context ablation for classification accuracy, nor dangerous-class-specific numbers. Treat those as **not found**.
- **Zhang et al., CHI '21, "Screen Recognition" (Apple):** 77,637 screens from 4,068 apps.\[34\] The SSD-MobileNetV1-FPN detector reaches 71.3% mAP, uses 20 MB, and takes "about 10ms per screen for inference (on an iPhone 11 running iOS 14)", versus more than one second and 120 MB for Faster R-CNN. The per-class table lists 79.7% and 88.0% for Icon over 21,875 instances;\[45\] the column headers were not recoverable from the extracted text. 59% of screens have elements missing from the accessibility tree, and 94% of apps have at least one such screen.\[34\]\[45\] Icon semantics come from VoiceOver's 38-class engine.\[44\]
- **Chen et al., ICSE '20, LabelDroid:** 77.38% of 10,408 Android apps have unlabeled image buttons.\[34\] Exact-match label accuracy is 60.7% (ROUGE-L 0.654).\[46\]
- **Sunkara et al. (Google, RICO semantics):** 77 icon-shape classes and 38 semantic classes; 15% of semantic annotations fall into OTHER. Associating an icon with its text label is hard: view-hierarchy heuristics reach 40% accuracy and nearest-OCR-box 29.5%, with many false positives.\[8\] **Implication:** "nearest text" is a weak naming signal outside tab bars.
- **Ferret-UI and similar MLLMs** score well (Ferret-UI 2, arXiv 2410.18967, reportedly scored 89.73 on UI element recognition vs GPT-4o's 77.73, per The Decoder), but they are cloud-scale or unreleased weights, so they are excluded by your constraints. Swearngin & Li (CHI '19) on tappability, RICO, Enrico, VINS, Screen2Vec, Spotlight and ScreenAI were not re-verified in this pass. None reports dangerous-class icon recall usable here.

**Priors to implement (design):**
- **Hard signals that unlabeled elements still carry:** `accessibilityIdentifier` (RN `testID` maps to it on iOS; Flutter `Semantics(identifier:)` in recent versions), element type, and traits (.button, .image, .selected, .notEnabled). An identifier like `delete_button` or `btnTrash` is often more reliable than pixels. Parse it with the same dangerous-class lexicon.
- **System auto-labels:** UIKit system bar items (`UIBarButtonItem.SystemItem` .trash/.compose/.action/.add, …) may get default labels, and for SwiftUI Apple's WWDC21 session "SF Symbols in SwiftUI" states "When possible, SwiftUI will provide a label based on a system symbol's content", although SwiftLint issue #5165 notes that while "plus" gets "Add", many symbols "simply fall back to the name of the icon, like clock.arrow.circlepath". Such controls should then not appear unlabeled at all. **Which items get which strings was not verified here.** Enumerate them empirically in K1 with a 30-minute test app that places every SystemItem and the top 100 SF Symbols in buttons and dumps the accessibility tree.
- **Position priors** (compose-bar trailing = send, nav-bar trailing, swipe actions, tab bar with OCR label below, FAB): use them **only as vetoes or confidence modifiers**. Example: a "paperplane" match in a compose bar's trailing slot is boosted; a "trash" match inside a tab bar triggers a demand for confirmation. Never let position alone produce a name.

## 5. Evaluation design

- **Corpus:** Simulator system apps (Mail, Messages, Notes, Reminders, Photos, Files, Safari, Maps, Settings, Contacts, Calendar), plus one React Native/Expo app (e.g. a sample using MaterialCommunityIcons and Ionicons) and one Flutter app. Capture iPhone (@3x) and one @2x device, light and dark mode, and default plus one large Dynamic Type size.
- **Ground truth:** System apps are labeled, so take their accessibility labels as truth and *hide the labels from the namer* to simulate unlabeled controls. Spot-check 10% by hand, because labels describe actions and the namer outputs glyphs. For RN and Flutter, build a labeled and an unlabeled variant from the same source; the source's icon `name=` prop gives exact glyph truth.
- **Taxonomy:** *dangerous* = delete/trash, send, logout/sign-out, pay/purchase/checkout, plus a "destructive-ambiguous" bucket for X/close/minus-circle. *Benign* = the common types. *Unknown/negative* = avatars, logos, photos, decorative images, custom glyphs not in the bank.
- **Metrics:** per-class precision and recall at the operating threshold; **wrong-name rate per 100 screens**; abstention rate; coverage (fraction of unlabeled controls named); and PR curves over the acceptance threshold. Report dangerous classes separately and never average them with benign ones.
- **Sample sizes (Wilson 95%):** observed precision 0.98 at n = 200 gives roughly [0.950, 0.992]. At n = 500 it gives roughly [0.964, 0.989]. Zero errors at n = 200 gives a lower bound of about 0.981. Rule of three: **≥150 accepted predictions with zero wrong names** are needed to claim precision ≥0.98 at 95% confidence. For per-class recall, 50 positives at an observed 0.8 gives about [0.67, 0.89]. Aim for ≥50 positives per dangerous class, which will need synthetic screens or the RN app for logout and pay.

## 6. Ranked recommendation

All numbers in the "Expected" column are **targets to verify, not measurements.**

| Rank | Build | Expected (to verify) | Latency | Effort |
|---|---|---|---|---|
| 1 | Metadata harvest: identifiers/testIDs lexicon, traits, empirical table of system auto-labels | Precision near 1.0 where present; coverage unknown | <1 ms | 1–2 d |
| 2 | Bundled icon fonts (RN/Expo/Flutter/native `UIAppFonts`): glyph enumeration, CoreText render, mask-NCC, curated dangerous-name map | Highest precision of any pixel method, because templates are the exact source raster | ms-level (estimate) | 4–5 d |
| 3 | SF Symbols curated bank (~300 symbols × 3 weights × 2–3 scales) from the Simulator runtime, NCC + chamfer, margin refusal | Good on native apps; weight/scale mismatch is the main risk | ms-level (estimate) | 4–6 d |
| 4 | Assets.car: `assetutil` names + public-API render + match | Depends on naming quality (unknown) | ms-level | 3–4 d |
| 5 | Context vetoes/boosts (compose-bar, tab-bar OCR, swipe actions) | Cuts wrong names; adds no new names | <1 ms | 2–3 d |
| 6 | Foundation Models yes/no verifier on dangerous accepts | Unknown; hardware support unknown | Unknown (likely 100s of ms) | 1–2 d spike |
| 7 | Feature print kNN / Create ML / VNClassifyImageRequest | Likely weak on line art; no data | Unknown | Skip unless K3 surprises |

## 7. Kill experiments (pass/fail)

- **K1 – Free labels (0.5 d):** Build a test app with every `UIBarButtonItem.SystemItem` and the top 100 SF Symbols as image-only buttons in UIKit and SwiftUI, then dump the tree. *Pass:* ≥50% get non-empty system labels, so ship that table first and rescope the pixel work. *Fail:* <10%, so pixels matter more. Also toggle VoiceOver Recognition and check whether its labels reach the tree.
- **K2 – Font route (1 d):** On one RN and one Flutter release build, extract fonts, render the used glyphs and match 100 unlabeled crops. *Pass:* ≥95% top-1 correct with zero wrong dangerous names at the chosen threshold. *Fail:* <85% or any wrong dangerous name that thresholding cannot remove. Also record whether tree-shaken Flutter fonts keep glyph names.
- **K3 – SF Symbols matching (1.5 d):** Take 200 SF-Symbol buttons from system apps (labels hidden), light/dark at @3x and @2x, against a 300-symbol bank. *Pass:* dangerous-class precision 1.0 (0 errors) with recall ≥0.8, and p95 latency ≤10 ms per crop on M1. *Fail:* any wrong dangerous name at recall ≥0.5. Measure feature-print latency and accuracy in the same run as a side arm.
- **K4 – Asset naming (0.5 d):** Run `assetutil --info` on 20 installed apps and hand-rate image-set names. *Pass:* ≥40% of icon-sized image sets have semantically usable names. *Fail:* <15%, so drop name parsing and keep only template matching.
- **K5 – Foundation Models verifier (1 d):** On a macOS 27 Mac with Apple Intelligence, ask yes/no about 100 dangerous accepts and 100 hard negatives. *Pass:* vetoes ≥80% of wrong accepts while rejecting ≤2% of correct ones, at ≤500 ms. *Fail:* API unavailable on M1-class hardware, or worse than chance.
- **K6 – Negatives (0.5 d):** Run 300 avatars, logos and custom glyphs through the full pipeline. *Pass:* ≤1% get any name and 0 get a dangerous name. *Fail:* otherwise, so tighten the absolute floor.

## Caveats

- Several 2026 claims (Foundation Models hardware requirements, SF Symbols 8 vs "SF Symbols 27" naming, exact symbol counts) come from secondary sources or conflict with each other. Re-check Apple's current docs at implementation time.
- Licence analysis is interpretive. The SF Symbols terms are written for building Apple-platform UIs; a QA agent's use is adjacent, not identical.
- No published work measures icon-name precision for exact-source template matching on iOS. Every operating-point number above is a target until K2–K3 run.

## Sources

1. [much larger release apk after removing the last Symbol / Tree-shaking issue · Issue #172449 · flutter/flutter](https://github.com/flutter/flutter/issues/172449)
2. [github.com](https://github.com/bartoszj/acextract)
3. [Icon Composer 2 and SF Symbols 8 now available as betas - 9to5Mac](https://9to5mac.com/2026/06/12/icon-composer-2-and-sf-symbols-8-now-available-as-betas/)
4. [can i use sfsymbols in my app?](https://developer.apple.com/forums/thread/706089)
5. [Apple’s Vision Framework: Exploring Advanced Image Similarity Techniques](https://medium.com/@MWM.io/apples-vision-framework-exploring-advanced-image-similarity-techniques-f7bb7d008763)
6. [What’s new in the Foundation Models framework - WWDC26 - Videos - Apple Developer](https://developer.apple.com/videos/play/wwdc2026/241/)
7. [Towards Complete Icon Labeling in Mobile Applications](https://dl.acm.org/doi/abs/10.1145/3491102.3502073)
8. [\[2210.02663\] Towards Better Semantic Understanding of Mobile Interfaces](https://ar5iv.labs.arxiv.org/html/2210.02663)
9. [Image classification using the Vision framework](https://medium.com/@kamil.tustanowski/image-classification-using-the-vision-framework-3cac0ab6f399)
10. [How to Add React Native Vector Icons Into Your Next Project](https://builtin.com/articles/react-native-vector-icons)
11. [react-native-vector-icons - npm](https://www.npmjs.com/package/react-native-vector-icons)
12. [react-native-vector-icons usage. Installation:](https://medium.com/@sisongqolosi/react-native-vector-icons-usage-d6c3c1537f53)
13. [\[web\] Icon tree shaking doesn't work well on web · Issue #154986 · flutter/flutter](https://github.com/flutter/flutter/issues/154986)
14. [Flutter iOS Build Error: How to Resolve IconData Tree Shaking Issues｜Q\_Q箱](https://note.com/real_pansy2412/n/nfb2487cad44f?hl=en)
15. [github.com](https://github.com/MathGaps/FlutterIconPicker)
16. [GitHub - halmueller/assetutil-convert: Utility to convert the JSON output of "assetutil --info" to CSV. · GitHub](https://github.com/halmueller/assetutil-convert)
17. [assetutil(1)](https://keith.github.io/xcode-man-pages/assetutil.1.html)
18. [Asset Catalog](https://developer.apple.com/forums/tags/asset-catalog)
19. [Download AssetCatalogTinkerer\_v2.9-290.zip (Asset Catalog Tinkerer)](https://sourceforge.net/projects/asset-catalog-tinkerer.mirror/files/2.9/AssetCatalogTinkerer_v2.9-290.zip/download)
20. [iOS Asset Extractor](https://github.com/Marxon13/iOS-Asset-Extractor)
21. [Previewing SF Symbols with Apple's own renderer — Amy Worrall](https://www.amyworrall.com/blog/previewing-sf-symbols-with-apples-own-renderer)
22. [SF Symbols MCP Server](https://mcpservers.org/servers/svedm/sfsymbols-mcp)
23. [GitHub - yapstudios/sfsym: Export Apple SF Symbols as SVG · GitHub](https://github.com/yapstudios/sfsym)
24. [SF Symbols](https://sfsymbols.bhodges.me/)
25. [SF Symbols - Apple Developer](https://developer.apple.com/sf-symbols/)
26. [SFSafeSymbols/CONTRIBUTING.md at stable · SFSafeSymbols/SFSafeSymbols](https://github.com/SFSafeSymbols/SFSafeSymbols/blob/stable/CONTRIBUTING.md)
27. [fix(navigation): LS-160 SF Symbol 可用性測試改驗引入版本＋iPad 空狀態圖示對齊 by CLYEH · Pull Request #266 · CLYEH/little-sprout](https://github.com/CLYEH/little-sprout/pull/266)
28. [The use of SF Symbols](https://developer.apple.com/forums/thread/724523)
29. [Page 1 of 16 Xcode and Apple SDKs Agreement](https://www.apple.com/legal/sla/docs/xcode.pdf)
30. [Apple offers 2,400 icons for free](https://news.ycombinator.com/item?id=26484456)
31. [Sikuli: Using GUI Screenshots for Search and Automation](https://dspace.mit.edu/bitstream/handle/1721.1/72686/Miller_Sikuli.pdf?sequence=1&isAllowed=y)
32. [Question #256236 “Differing images matched with very high simila...” : Questions : SikuliX](https://answers.launchpad.net/sikuli/+question/256236)
33. [NiCro: Purely Vision-based, Non-intrusive Cross-Device and Cross-Platform GUI Testing](https://arxiv.org/pdf/2305.14611)
34. [Towards Complete Icon Labeling in Mobile Applications Jieshan Chen∗](https://docs-assets.developer.apple.com/ml-research/papers/icon-labelling-mobile-apps-chi-22.pdf)
35. [Towards Complete Icon Labeling in Mobile Applications](https://dl.acm.org/doi/fullHtml/10.1145/3491102.3502073)
36. [What’s new in image understanding - WWDC26 - Videos - Apple Developer](https://developer.apple.com/videos/play/wwdc2026/237/)
37. <https://developer.apple.com/documentation/foundationmodels.md>
38. [Introducing the Third Generation of Apple’s Foundation Models](https://machinelearning.apple.com/research/introducing-third-generation-of-apple-foundation-models)
39. [Apple Foundation Models WWDC 2026: Multimodal + Python SDK](https://byteiota.com/apple-foundation-models-wwdc-2026-multimodal-python-sdk/)
40. [Apple Intelligence Foundation Language Models](https://arxiv.org/html/2507.13575v3)
41. [WWDC26 Machine Learning guide - Apple Developer](https://developer.apple.com/wwdc26/guides/machine-learning/)
42. [VNClassifyImageRequest.knownClassifications(forRevision: VNClassifyImageRequestRevision1) · GitHub](https://gist.github.com/alexdong/5da51b09d4fc07139f6ce98ceb8705ab)
43. [Best practices for integrating visual intelligence in your app - WWDC26 - Videos - Apple Developer](https://developer.apple.com/videos/play/wwdc2026/297/)
44. [Making Mobile Applications Accessible with Machine Learning - Apple Machine Learning Research](https://machinelearning.apple.com/research/mobile-applications-accessible)
45. [Screen Recognition: Creating Accessibility Metadata for Mobile](https://docs-assets.developer.apple.com/ml-research/papers/screen-recognition-chi-2021.pdf)
46. [\[2003.00380\] Unblind Your Apps: Predicting Natural-Language Labels for Mobile GUI Components by Deep Learning](https://ar5iv.labs.arxiv.org/html/2003.00380)

---

## Measured against simframe's own data — 2026-10-03

Offline, from stored screen readings (fingerprint v9) and the installed bundle.
Nothing was driven.

| store | screens | interactive controls (tree) | unlabeled | unlabeled **with an identifier** |
| --- | --- | --- | --- | --- |
| Ecotrak (`7B8F8963`) | 142 | 2306 | 188 | **185 (98%)** |
| bench device (`326464A4`), mixed apps | 510 | 4266 | 43 | 34 (79%) |

The identifiers are React Native `testID`s and read as names: `screen-toolbar-back-button`,
`home-header-notifications-button`, `home-dashboard-qr-scanner-button`,
`work-order-search-filter-button`, `quick-filter-buttons-scroll-right`, and one dangerous
one, `time-track-note-input-send-button`. Ecotrak's 26 distinct identifiers cover every
unlabeled control the crawls skipped.

The bundle: `UIAppFonts` lists MaterialDesignIcons, MaterialIcons and
MaterialCommunityIcons. `MaterialDesignIcons.ttf` has a version-2 `post` table with
**7,431 named glyphs** (`bell-outline`, `dots-horizontal`, `delete`, `filter`…), so the
report's rank-2 route is open for this app. `Assets.car` holds only the app icon and splash
images, so rank 4 does nothing here.

**What this changes in the ranking, for us.** Rank 1, metadata harvest, is not a 1–2 day
bet with unknown coverage: on the app that matters it is 98% coverage today, and it costs
a tokeniser over the identifier plus the existing vocabulary barrier. The pixel routes
remain for apps without identifiers (21% of the bench device's unlabeled controls, and
anything a developer did not tag).

**Icon fonts are text, which makes rank 2 a lookup, not a match.** An icon
drawn by react-native-vector-icons is one private-use character set in the icon
font, and the accessibility tree hands that character over in the label
(simframe stripped it in `input.cleanLabel`). So for those apps no pixels are
needed: the code point is looked up in the app's own font, which names the
glyph exactly. Parsed from Ecotrak's bundle: `MaterialDesignIcons.ttf` resolves
7,447 code points to names (U+F009C `bell-outline`, U+F01B4 `delete`, U+F048A
`send`, U+F0433 `qrcode-scan`). Implemented in `src/glyphs.js`. **Not yet
verified live:** the app was signed out when this was written, and the sign-in
screen has no icon glyphs.
