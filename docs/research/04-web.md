# The web as a third target: which parts of "don't blink" are about simulators, and which are not

Status: **roadmap, not committed work.** Written 2026-09-11 because the question
was asked in a form worth answering precisely — *"we can use our philosophy on
web rather than the exact thing we do for simulators, right?"* — and because
recording a design before building it is how the two overturned phase premises
in this project were caught.

## TL;DR

- **The mechanics are cheap.** The `Platform` contract is sixteen members and
  every one has a direct Chrome DevTools Protocol equivalent. Android already
  proved the boundary holds, and everything above it — frame store, settle,
  fingerprint, screen map, refs, graph, verdicts, `sweep`, `seek`, the
  escalation log — would run unmodified, exactly as it does on Android today.
- **But porting the implementation would produce a worse Playwright.** simframe's
  perception layer exists because iOS gives bad handles: a tree that omits
  things, so OCR is fused in and the result is remembered. The web has
  `document.querySelector`. Arriving late with a fuzzier version of a solved
  problem is not a product.
- **Porting the *philosophy* is the thing, and the philosophy gets stronger.**
  Every per-step question this project currently *infers* becomes one the web
  lets you *ask*. The reason we needed heuristics was that we were guessing; on
  the web you do not guess. So "consult the model at planning milestones, never
  per step" becomes easier to honour, not harder.
- **What is genuinely new against Playwright is the engine, not the eyes**: the
  transition graph, outcome memory, the certainty vocabulary, batching with
  local recovery, and the escalation log. Playwright is hands and eyes. This
  would be the layer above that decides whether to think.
- **One pillar must be re-derived rather than copied**: the escalation log's five
  reasons are mostly perception failures and largely evaporate on the web.
  Copying that taxonomy would repeat a mistake this project has already made
  once — `doctor` reporting "input driver: idb" for an Android emulator, a claim
  about a tool that has never spoken to an Android device.

## The mechanical mapping

The contract lives in `src/platform/index.js` and is deliberately small.

| contract member | CDP equivalent |
| --- | --- |
| `screenshot`, capture loop | `Page.captureScreenshot`; `Page.startScreencast` is a real analogue of the IOSurface change callback — a push stream rather than a poll |
| accessibility tree | `Accessibility.getFullAXTree` — richer than iOS's, and it carries field values, which Safari's web content does not expose to the host tree at all |
| `tap` / `swipe` / `type` / key | `Input.dispatchMouseEvent`, `dispatchTouchEvent`, `dispatchKeyEvent` |
| `openUrl` | `Page.navigate` |
| `setPermission` | `Browser.grantPermissions` |
| `geometry` | `Page.getLayoutMetrics` |
| `listDevices` / `bootedDevices` / `resolveDevice` | `Target.getTargets`; a tab is a device and `targetId` is the udid |
| `setPasteboard` | `Input.insertText`, or the clipboard API under a granted permission |
| `launchApp` / `terminateApp` | **no honest equivalent.** A browser does not launch apps. These are `optional` with a reason, per the rule Android established |

**The transport is already being paid for.** Network visibility needs a
dependency-free CDP WebSocket client; a working handshake and text-frame codec
is about forty lines and reached `101 Switching Protocols` against a live Metro
on 2026-09-11. Two findings from that probe apply directly here and are the sort
of thing that costs an afternoon to discover: the upgrade is refused with **401
Unauthorized** unless the `Origin` header matches the inspector's own host, which
a stock client cannot set; and the global `WebSocket` is absent on Node 18 and
flag-only on Node 20, so the hand-rolled client is required regardless of
dependency policy. Numbers in `docs/BENCHMARKS.md`.

## Which pillars transfer

**Unchanged.** The model is consulted at planning milestones, not per step. A
transition graph, so a repeated flow costs zero model calls. Verdicts that state
their own certainty. Batching a whole flow into one call with local recovery
(`or`, `seek`, `sweep`). The escalation log as the steering wheel. HPI as the
score. None of these mention a pixel.

**Strengthened — and this is the interesting half.** The owner's framing, which
is the right one: a browser *is not a sandbox*, and that is an advantage.

| per-step question | simulator | web |
| --- | --- | --- |
| what is on screen | fuse accessibility and OCR, then hope | the DOM, exactly |
| has it settled | frame hashes, a median of shared element positions, two consecutive stalls | `MutationObserver`, network idle, `document.readyState` |
| did the action work | did enough pixels change | the DOM mutated, a request fired, a console error appeared |
| why did it fail | largely unknowable | read the response body |
| what is this control | OCR text, an icon template, a positional prior | the element, its role, its value |

Everything in the left column is a *proxy*. `docs/DEFERRED.md` is substantially a
list of proxies failing on ordinary properties of real screens: a footer that
looked like a keyboard, a keyboard whose top row fell outside its own detection
window, a fixed toolbar dragging a median to zero, a caret that never lets a
screen settle. **On the web most of those questions have direct answers**, which
means more can be decided locally, which is the entire thesis of the project.

**Holds, and must not be loosened.** The verify barrier. A wrong action is still
irreversible on the web — submitting a form, deleting a record, sending a
message — so the destructive-label rule and "when in doubt, escalate" transfer
without amendment. If anything the web makes it sharper, because a real page can
be a production system.

**Must be re-derived.** The five escalation reasons. `unknown_screen` and
`ambiguous_intent` are artefacts of weak perception and will nearly vanish. What
replaces them has to come from a log rather than from this document — the
candidates are *the page did something the plan did not predict*, *an API
returned something the plan cannot interpret*, and *the flow's assumption about
the data is stale*. CLAUDE.md's rule applies: every escalation carries one of a
fixed set of reasons, "unknown" is not a reason, and the breakdown decides what
gets built next.

## What is actually new against Playwright

Playwright, Puppeteer and Selenium are mature and their selectors are better
than anything this project's perception layer will produce on a web page. They
also do not:

- **remember across sessions.** `worked here before: tap "Home"` and
  `ok: matches the outcome seen 3x before` come from a graph of
  `(screen, action) → screen'` persisted per device. Three separate peer
  reporters independently named outcome memory as the real differentiator over
  screenshot-driving.
- **decide whether the model is needed.** The `next:` line — *"settled; screen
  known; nothing ambiguous — chain the next steps in one sim_do without looking
  again"* — is the product. A peer called it the standout feature, specifically
  for talking them out of a wasteful re-plan.
- **state their own certainty.** `unconfirmed`, `a value simframe wrote here is
  gone`, `this is a pixel measurement, not a different screen`. Three peers in
  one day converged on refusals being cheap and confident errors being expensive.
- **keep a log that chooses the next faculty**, or a parity metric against a
  human median.

So the honest positioning is not "a better browser driver". It is **memory,
batching and calibrated certainty pointed at a target that already has good
eyes** — with the browser's own tooling doing the seeing.

## The flagship behaviour, and why it argues for building this

The sentence this project has been circling, from `docs/BENCHMARKS.md`:

> the screen settled, and these three requests fired with these statuses

On iOS that needs a debugger bridge into the app. **On the web it is native.**
And it answers the exact frustration a peer reported after hand-rolling their
own CDP bridge to get it:

> the screen looked identical whether the API returned `403`, returned
> `200 []`, or was never called

Which turns an unanswerable QA question into a report: *the tap landed, the
request fired, it came back 403, so the empty list is not a UI bug.* That is the
same "don't blink" move as everything else here — answer it locally, with
evidence, instead of paying a model to squint at a screenshot.

## Two arguments against, stated properly

**We are already driving the web, badly, and that cuts both ways.** Nearly every
hard bug of 2026-09-11 came from squinting at web content through a simulator:
an alias pairing a sheet's label with a dimmed page's value across z-layers, OCR
returning `O Records` for `0 Records`, and a field readback that needed an OCR
fallback *because Safari's web content is not in the host accessibility tree at
all*. A DOM-backed target has none of those. That is an argument for building it
— and also a warning that the current web support is a mirage nobody should
mistake for the real thing.

**It is a third platform while eighty-eight items are filed and a release is
held.** The `capabilities` rule — a layer a platform does not have is `optional`
with a reason, never the other platform's vocabulary — would need care from the
first commit, not retrofitting.

## The go/no-go this phase would run

Following the pattern that produced the Phase 17 NO-GO and the Phase 15
promotion: measure the prize before building the solution.

1. **Build the mechanical backend only** — targets, navigate, screenshot, AX
   tree, input — behind the existing `Platform` seam. No new perception, no new
   step types. Two days of work if the CDP client already exists.
2. **Run the existing flow suite against a web target** and record: model turns,
   HPI against a human median on the same flows, and the escalation breakdown.
   Every layer above the boundary is unmodified, so this measures the *engine*
   in isolation.
3. **Go** if the graph and the batching remove turns on a target whose
   perception is already good — because that is the claim. If the numbers say
   the wins were coming from the perception layer all along, then the engine is
   worth less than this document assumes and the honest answer is a NO-GO with a
   reason, which is data either way.
4. **The comparison that matters** is not against a bare model loop. It is
   against Playwright driven by the same model with no memory. Anything else
   flatters the result.

## Where this belongs in the article

The piece currently argues that an agent's senses should not be a function the
model calls. Web support is the test of whether that argument was about
simulators or about agents. If the graph, the verdicts and the batching earn
their keep on a target with a perfect accessibility tree and a queryable DOM,
then the thesis was never about pixels — and that is a much stronger claim than
the one the article makes today.
