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

### The first baseline flow that ran, and what it falsified — 2026-09-17

One flow — create a record through a four-step wizard — on an internal web app,
driven with ordinary browser tooling and no memory layer. It completed, with an
unambiguous confirmation.

| | |
| --- | --- |
| wall clock | **354 s** |
| actions executed | 23 |
| model turns | **45** |
| **actions per model turn** | **0.51** |
| screenshots | 10 |
| a human who uses the app daily, relaxed | **~60 s** |
| the same human, rushed | **~30 s** |

**The agent was ~6x slower than a relaxed person and ~12x slower than a rushed
one**, in the arm with no memory. The 6x figure is the same multiple this
project measured against a human on iOS, arrived at independently on a different
target — and the owner supplied the 30 s figure unprompted after reading the
report, which is the number a skilled operator actually works at.

**The within-session curve is the quantity a transition graph claims to hand a
fresh session for free**, and it was measured directly rather than controlled
away:

| phase | actions/turn |
| --- | --- |
| locate the entry point, diagnose dead clicks | 0.27 |
| first dropdown — crack its option markup | 0.50 |
| second dropdown — crack a *different* markup | 0.63 |
| **third dropdown — a third markup** | **0.40** |
| wizard steps, fill, submit | 0.78 |

~2.9x end to end, but the reporter's own discount is the honest figure: much of
phase 1 is harness diagnosis that a fresh session repeats regardless of app
memory, so **the recoverable span is ~1.6x**.

#### Three findings that change this document

**1. "Perception is close to free on the web" is false for this app, and that
premise was load-bearing.** Written here since 2026-09-11 and re-derived
approvingly by an earlier reporter who had not read it. The flow contained
**three different dropdown option markups inside one form**, none exposing a
standard option role, one using a hyphenated invalid ARIA role. The
accessibility-tree tools could not see a single selectable option anywhere in
the flow; every selection went through raw HTML dumps and screenshots.
Perception cost roughly what it costs on iOS.

The reporter's own reading of that is the right one and cuts against their
result: it means the comparison **can** be won on perception after all — but
winning it that way is winning against one app's accessibility debt, which is a
worse reason to build the tool than the memory claim is. A go/no-go decided on
perception should still be read as a no.

**2. Where memory would actually pay is actuation, not navigation — and this
project's index does not hold it.** About 12 of the 45 turns were spent learning
things like *"this control needs hit-test-then-click"*, *"this one needs a
DOM-level fill followed by a click on a non-semantic div"*. That is **per
widget**, not per screen. The `(screen_hash, action) -> screen_hash'` graph this
project builds is keyed on screens and would not store it.

The phase-4 dip is the evidence, and it is the sharpest single observation in
the report: the third dropdown *in the same form* broke the technique learned on
the first two and gave back a third of the gain. Their conclusion — *"what was
being learned was not how this app navigates but how this widget actuates"* — is
a claim about the shape of the memory, not its value, and it applies to iOS too.
**Before building a web backend, decide whether the store is screen-keyed,
control-pattern-keyed, or both.**

**3. This arm's headline number is contaminated, and not in simframe's favour.**
Roughly 15 of the 45 turns went to discovering and routing around **synthetic
input that never reached the page** — 4 clicks and 2 keypresses were no-ops,
including one whose coordinate was verified against the element's bounding rect
to the pixel. That is a defect in the baseline's harness, not in the flow.
Comparing 0.51 against a simframe run with working actuation would measure that
bug. **The number to beat is the post-diagnosis rate: 5 actions in 6 turns,
0.83.**

#### The baseline's slowness is the measurement, and it has a size

The owner, watching a later run, put it at *"10x slower than mobile, so slow it
pisses me off"*. That reaction is a number, and it is not the number flow 1's
report was measuring. Flow 1 measured **within-session learning** (~1.6x
recoverable). This is **batching**, a separate and multiplicative lever, and it
is the one this project's own arithmetic has always said dominates.

At 354 s over 45 model turns, the baseline's turns cost **7.9 s** each — cheaper
than the ~20 s a planning round trip costs on the iOS side, presumably smaller
payloads. But it runs at **n = 0.51 actions per model turn**, so:

| | n | per action |
| --- | --- | --- |
| the baseline arm, no engine | **0.51** | **15.4 s** |
| simframe on iOS, recorded median | 2 | 11.7 s |
| simframe, batch of 4 | 4 | 6.7 s |
| simframe, batch of 10 | 10 | 3.7 s |
| a replayed route, zero model calls | — | **1.8 s** |

15.4 s against 1.8 s is **8.5x**, which is where the owner's "10x" lands. The
baseline consults a model twice per action; a replayed route consults none.

**How much of that gap is actually addressable is smaller, and should be said in
the same breath.** About 15 of the 45 turns went to routing around broken
synthetic input — a defect in this arm's harness, not something an engine
removes. At the post-diagnosis rate of 0.83 actions/turn the baseline costs
**~9.5 s per action**, so the honest addressable gap is closer to **5x** against
replay and **~1.4x** against a batch of four.

Which reorders the three claims for the web target:

| claim | status |
| --- | --- |
| perception is cheaper on the web | **dead** — this app's dropdowns expose no option roles at all |
| within-flow memory | ~1.6x, and keyed on the wrong index today (per widget, not per screen) |
| **batching** | **~4x, unmeasured on the web so far, and the largest term** |

The second peer's run should therefore be read for **n** first and transfer
second. `n` is what the engine changes; transfer is what the memory changes; and
on this evidence the first is worth more than the second.

#### What this does to the product argument

Even the optimistic version of this arm — harness fixed, actuation known from
turn one, the best phase rate sustained — lands near 2 minutes. Against a
relaxed human minute that is ~2x; **against the 30 s a rushed operator actually
takes, it is ~4x.** A memory layer that removes model turns closes some of that
and **does not cross the line under any reading.**

So the case cannot rest on beating a human operator's speed, on this evidence.
It rests on what a human minute cannot do: running unattended, at 3am, fifty
times, reporting what it saw rather than relying on a person to remember to
look. And both arms should be reported **against the human time**, because a
1.6x improvement on a 6x deficit reads very differently from 1.6x presented
alone.

One caveat the reporter raised unprompted and it is fair: the human minute is a
*learned* minute. A cold human on an unfamiliar app would not manage 60 s
either. That is an argument that the memory layer aims at a real cost, not that
it closes this particular gap.

### Three corrections to that design, from a baseline attempt — 2026-09-17

The first attempt to collect the baseline arm was **blocked before flow 1, step
1**: the browser holding the authenticated session was unreachable, and the
isolated pane had no session cookie and landed on a login screen, where the
reporter correctly stopped rather than typing credentials. Zero flows ran. The
methodology notes it produced are better than the numbers would have been.

**Tool calls are not a comparable unit across the arms.** Both sides batch — the
browser tooling has a batch primitive, `sim_do` is one — so "number of tool
calls" measures *batching style*, not memory, and either arm can be made to look
arbitrarily good by one authoring choice. Count **actions executed** and **model
turns** separately, and hold both arms to the same batching policy. This project
already has the right metric and should simply use it on both sides:
`steps_per_call = steps_taken / model_turns`.

**"Screenshots needed" structurally favours the browser, and that is the finding
rather than a flaw to correct.** Their words: *"On iOS, perception is the
expensive part; on the web it is close to free. So if the web pitch rests on
perception parity it has no case, and the memory layer has to carry the whole
argument alone."* That is this document's own thesis, re-derived from outside by
someone who had not read it — which is the strongest form the argument has been
stated in so far. It also sets the bar: a web go/no-go that shows perception
wins has shown nothing.

**"Run each flow cold" is not enforceable inside one session.** The prompt asked
a model to un-see flow 1 while running flow 2, and mitigated it with self-report
of something nobody has reliable introspective access to. The clean design is
**one flow per session, no shared context**, plus one deliberate session in
learned order to measure the within-session improvement directly — because that
improvement is exactly the quantity a transition graph claims to supply for
free, and controlling it away removes the measurement instead of taking it.

**And the attach cost belongs in the numbers — on its own line.** Reaching a
drivable, authenticated page cost 6 tool calls and one re-plan in the first
attempt, and 4 calls over 9.4 s to a conclusive failure in the second. Every arm
pays it. If simframe's web runs start from a pre-attached, pre-authenticated
harness while the baseline arm does not, the gap between them is a measurement
artifact rather than a result.

The second reporter sharpened it correctly: the web arm's attach depends on a
browser extension being installed and signed in on the same account, which is an
**out-of-band, human-only setup step the agent cannot recover from**. It is a
real recurring cost and it should be reported as a separate line rather than
folded into flow timings, because it is orthogonal to the question actually on
trial — actions per model turn.

**Both baseline attempts were blocked at that step and neither ran a flow**, and
the second was also blocked by a defect in the prompt: it said one flow runs per
session and "you will be told which", and nothing told them. A coordination step
that exists only in the author's head is a step that does not exist. The prompt
is now three files, each naming its own flow, and each carrying a path that needs
no extension: the agent opens the page, stops at the login screen, and the owner
signs in to that pane by hand. Credentials stay with the human either way; what
changes is that a login screen is no longer terminal.

One more round trip was lost to *who* the request was addressed to. The peer
reported the login screen as "your move: type the credentials yourself", which
reached another Claude rather than a person — and was correctly refused twice
over: no agent enters credentials, and a browser pane belongs to the session that
opened it, so no other session could have acted on it anyway. The prompt now says
to name the human operator explicitly and to never hand the request to a relaying
agent. Worth the line, because "ask a human" and "ask whoever is reading this"
are the same sentence to a model and different instructions in practice.

## Where this belongs in the article

The piece currently argues that an agent's senses should not be a function the
model calls. Web support is the test of whether that argument was about
simulators or about agents. If the graph, the verdicts and the batching earn
their keep on a target with a perfect accessibility tree and a queryable DOM,
then the thesis was never about pixels — and that is a much stronger claim than
the one the article makes today.
