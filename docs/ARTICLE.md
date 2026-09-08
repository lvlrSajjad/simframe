# Agents shouldn't blink

*Perception as a daemon, not a function — and what happened when I built one for the iOS Simulator.*

> Also published as a page: [`agents-shouldnt-blink.html`](agents-shouldnt-blink.html). This Markdown is the source of record; edit both together.
>
> Every number here is measured, on an M-series Mac with Xcode 26 and an iPhone 17 Pro simulator running iOS 26.5, against a real production React Native app. The full tables — N, median, p95, and the mistakes made getting to them — are in [`docs/BENCHMARKS.md`](BENCHMARKS.md). Where a number is an estimate rather than a measurement, it says so.

---

## The thing I noticed watching Claude test my app

I had asked Claude Code to check a fix on the iOS Simulator. It could do it — open the app, navigate, confirm the change — but it was painfully slow, and watching it work I realised the slowness had nothing to do with intelligence. It was slow the way a person would be slow if they had to close their eyes between every action.

Here is what Claude did for each step: take a screenshot, wait for it, send the image to itself, reason about what was on it, decide where to tap, tap, and then start again from the screenshot. Every step was a blink. Every blink cost a network round trip and a few thousand tokens.

Here is what I do when I test the same flow. I already see the screen — there is no moment where I decide to look. I know how I got here, so I know what screen this is without reading it. I know where the Settings tab is because I tapped it thirty seconds ago; my hand goes there without my eyes checking. When the screen slides, I know it slid, and I know whether it slid the way I expected, before anything has finished animating. And when something surprising happens — an alert I didn't expect, a screen I've never seen — *that* is when I actually think.

The difference isn't that I'm smarter than the model. It is that I have eyes that never close, a hand that has memory, and a very cheap sense of whether the world just did what I meant it to. The model was being asked to do all of that with a single expensive tool: reason about a still image.

I am not as precise as the model. It never mis-taps a control it can see; I do. But I am much faster, and after a while I realised the speed came from architecture, not ability. So I built the architecture.

## The claim

**Perception for an agent should be a continuously running process with observer-relative memory — a daemon — and the boundary between perceiving and reasoning should be a specified contract, not an ad-hoc loop.**

Almost every agent framework today, including the computer-use loops the model labs ship, treats seeing as a function the model calls: `screenshot()` → reason → act → `screenshot()`. That design makes the most expensive component in the system, the language model, responsible for the cheapest job: noticing that a spinner is still spinning, that the screen hasn't finished sliding, that this is the same tab bar it saw a minute ago.

It also has a compounding cost. The OSWorld-Human study (Abhyankar, Qi & Zhang, MLSys 2026) measured where agent time actually goes and found that model calls for planning and reflection consume roughly 75–94% of total task time, that each step carries the whole observation history so later steps run up to 3× slower than early ones, and that leading agents take 1.4–2.7× more steps than a human needs. Every unnecessary look is not one wasted call; it is one more image dragged through every subsequent call.

The alternative is to give the agent senses that work the way mine do.

## Eyes, hand, memory

I ended up with three parts, and I think the vocabulary is more reusable than the code.

**Eyes** are a process that always holds the current frame. Nothing is captured on request. The screen is watched continuously, the newest frame is always available, and "look" is a read, not a wait.

The first version did this by calling `simctl io screenshot` on a loop, which turned a ~130 ms blocking screenshot into a ~20 ms file read. The rebuilt daemon reads the simulator's framebuffer directly, and the difference is larger than I expected:

| | Median |
| --- | --- |
| `simctl io screenshot` + downscale | 210 ms |
| framebuffer grab + downscale + both hashes | **6.74 ms** |
| the framebuffer grab alone | **0.13 ms** |

Thirty-one times faster for the same work, and the capture primitive itself is about a thousand times faster than a screenshot. Almost all of the remaining 6.7 ms is the downscale, not the capture.

One correction worth making, because it changes the vocabulary: the daemon has no frame rate. It captures when the simulator says its screen changed — a damage signal, about 52 per second while something is moving, and *nothing at all* while the screen is still. "60 fps" was the wrong thing to aim at. A still screen should produce no frames, and reasoning about it as a rate is how I ended up with a CI check that asserted a frame counter had advanced on an idle screen and failed three times before I understood why.

**Hand** is whatever performs actions, but with the property a human hand has: it can act on an intent — "the Settings tab" — without the eyes re-reading the screen, because it remembers where that control was. In simframe this is the screen memory: every screen the agent has seen is keyed by a layout hash, and the map from label to tap coordinate is stored. First visit ~305 ms to build — accessibility tree and on-device OCR, run concurrently — and every visit after that about 1 ms.

On a four-tab flow, run three times back to back from a cleared memory:

| Pass | Wall clock | Steps verified | Controls from memory |
| --- | --- | --- | --- |
| 1 | 10.2 s | 0/4 — nothing is known yet | **4/4** |
| 2 | **3.6 s** | **4/4** | **4/4** |
| 3 | **3.7 s** | **4/4** | **4/4** |

An earlier draft of this article quoted 7370 → 5160 → 3304 ms for the same flow. Those numbers were real measurements of the wrong thing: input was silently falling back to a slower path, and the capture daemon was being replaced by every single command because a version constant had drifted between the Swift and JavaScript halves. Nine hundred and ninety-three daemon respawns in one session, and every timing in the project was quietly wrong. It took someone else running the tool to find it.

**Memory** is the part I found most people miss, and it splits in two.

*Visual memory* is the recent frames. Not one frame — the last minute of them. It is what lets the daemon answer "did anything change?" and "what moved?" as text, in about 2 ms, and it is what lets a transition be understood as motion rather than inferred from two stills.

*Procedural memory* — muscle memory, if you like — is the record of how screens connect: I was on screen A, I tapped this, I arrived at screen B. Once that graph exists, a flow the agent has completed once can be replayed with zero model calls, and an action's outcome can be *predicted* before it happens, which is what makes verification cheap.

## "Changed since when?"

The single idea I'd defend hardest is the one that looks smallest.

Every change question is really "changed *since when*?", and the natural answer — since the previous frame — is wrong for an agent. A UI transition is over in about 700 ms. An agent that acts and then polls a second later, comparing consecutive frames, sees a still screen and concludes nothing happened, even though the screen is completely different from when it last looked.

The baseline for "changed" has to be **the last frame the observer actually saw**. The daemon records what the agent looked at, and every subsequent state query is relative to that. Over MCP this is automatic; from the CLI you take a mark before acting. This is observer-relative perception, and it is the property that makes a continuously running sensor useful to an intermittently attending reasoner. Without it, a faster camera just gives you more frames to be confused by.

I learned the corollary the hard way during the rebuild. When the new daemon started capturing on every damage event instead of four times a second, screen-memory hit rates got *worse* — 1–2 of 4 instead of 4 of 4 — with byte-identical hashing. More frames meant more mid-transition frames, more distinct layouts, more rebuilds. Correctness was preserved, because a missed match rebuilds the map and never mis-taps; only the speed regressed.

The fix was not to slow the camera down. It was to key memory off a *settled* frame rather than whichever frame happened to be newest, which restored 4/4 and is the reason the table above is flat after the first pass. The lesson generalises: **memory must be keyed off settled observations, never arbitrary frames.** Frame rate and memory keying have to be decoupled, or a better sensor degrades the memory built on it.

## Understanding motion instead of comparing stills

Once you hold a stream rather than a snapshot, the frame history becomes a signal in its own right.

Settled-state detection replaces `sleep()`: the daemon waits for a change and *then* for stillness, because a bare "wait until stable" called just before an animation begins returns immediately and uselessly. A small region changing every frame while the rest is still is a spinner, not a settled screen.

Transitions can be classified rather than guessed. A horizontal shift of the content with a nav-bar title crossfade is a push; the reverse is a pop; a vertical shift with stable chrome is a scroll, and phase correlation gives the exact offset. A region rising from the bottom with dimming behind it is a sheet; a centred rectangle with dimming is an alert; a change confined to the bottom 40% is the keyboard. These are region-diff and shift-search operations on a 48×96 grayscale grid, and the whole analysis costs under about 2 ms per frame — inside the noise of the capture pipeline it runs in.

Measured against a real app, settled state to settled state: a swipe up on a list reads `scroll` with a (0, 146) pt offset, a swipe down reads `scroll` at (0, −164) pt, a tab switch reads `replace`, and a still screen reads `none`.

Getting there needed two mistakes worth keeping. Searching the whole frame for a translation found `dy=0` for a scroll that had visibly moved — a nav bar, search field and filter row that stay put are a quarter of the screen and pixel-identical, so no shift beats no shift. And the shift score subsampled columns while the baseline it was compared against did not, so the ratio deciding "is this a translation" was comparing two different quantities.

It is still imperfect. A scroll that hits the top of a list and rubber-bands reads as `replace`, because after the bounce the frames genuinely are not a translation of each other. That matters less than it sounds, and the next section is why.

And an action can be verified locally. Before acting, if the transition graph has an edge for this screen and this action, the daemon predicts the destination. After settling, it compares.

The outcomes are a small closed set: `ok`, `no-visible-change`, `unexpected-screen`, `unverified`. A radio button that moves 0.1% of the screen used to burn a full timeout; now it returns in a second marked `no-visible-change`, and the agent knows to check rather than wait.

That list used to have a fifth entry, `unexpected-transition`, and removing it is the most useful thing I did to the verification layer. The motion classifier is noisy — the same tab switch reads `replace` on one run and `pop` on the next — and it was the *only* thing producing failures on navigation that had gone exactly where predicted. A verdict that says something is wrong when nothing is wrong teaches you to ignore verdicts. So the transition kind is now reported alongside `ok` rather than overriding it, and the verdict rests on the one signal that proved reliable: which screen you ended up on.

Knowing *which screen* turns out to be the hard part, and it is not a pixel question. Two hashes do two jobs. A perceptual hash of the pixels answers "did anything change" and "has it settled", because that is a question about pixels. Screen *identity* is structural — roles, quantised sizes, region, roughly how many siblings, and the chrome labels — because a list with new rows in it is the same screen, and no pixel hash can say so.

Even that needed a correction I did not see coming. Chrome labels are the only text in a fingerprint, which makes them the only thing available to name a screen by; it also means anything misclassified as chrome lands directly in a screen's identity. One screen's identity contained the string `"sep 08, 2026"`. It was perfectly stable — stable on something that expires. At midnight it would have become a different screen, and every stored map, route and remembered tap point touching it would have broken overnight, with nothing to flag it. I found it twice, in two different phases, and the second time by dumping the tokens of all twenty learned screens and reading them.

## Where the model belongs

None of this removes the model. It moves it.

The daemon's job is to answer, locally and fast, everything that has a local, fast answer: what's on screen, which element matches this intent, has the screen settled, did that action do what was predicted, have I been here before. Its job is *also* to know exactly when it cannot answer, and the rebuild formalises that as an escalation contract. The reasoner is consulted when:

1. the screen fingerprint has never been seen;
2. an intent matches no element confidently, or two elements too closely (ambiguity is reported, never guessed — silently tapping the wrong one looks exactly like nothing happening);
3. a verified action did not produce its predicted outcome;
4. an unfamiliar modal, alert or system dialog appears;
5. the goal spans multiple steps and no compiled flow or graph path covers it.

Everything else is acted on without a round trip. What the model receives when it *is* consulted is compact text — regions, numbered elements with role, label, state and source, the last action's verdict, any ambiguity — not an image. It can ask for the image; it rarely needs to.

That last sentence is the whole point, so it is worth being concrete about the price of an image. Measured on one screen at 700 px on the long edge:

| | Size | Tokens |
| --- | --- | --- |
| the PNG | 107 KB | — |
| as a native image block | — | ~1,600 |
| its base64, if the client mishandles it as text | 143,000 chars | ~41,000 |
| the compact text map of the same screen | 1,159 chars | **~330** |

The text is roughly five times cheaper than an image handled correctly, and over a hundred times cheaper than one handled the way an open Claude Code bug describes — where 41,000 tokens would also blow straight through the 25,000-token tool-result ceiling and be truncated. And unlike the image, it carries a tap point for every element, so nothing has to be measured by eye. (Token figures divide characters by 3.5; the character counts are the measurements.)

Here is what the model actually gets:

```
iPhone 17 Pro · 402x874pt · screen a1b2c3d4 "Inbox" (known, 3 known exits)
last action: [2] tap — ok: matches the outcome seen 5x before
nav-bar:
  #1 button    24,64      Back
  #2 text      201,64     Inbox
content:
  #3 cell      201,140    Weekly digest
  #4 cell      201,196    Payment received
tab-bar:
  #5 text      62,835     Inbox
  #6 text      201,835    Settings
```

Region first, because "Inbox" the title and "Inbox" the tab differ only by where they are. A number, which is a selector — whatever this calls `#3`, the next call taps as `#3` without describing it. And a verdict, so the model learns what its last action did without asking.

End to end, a ten-step flow through the MCP server, five consecutive runs once the route was in memory:

| | Steps | Model turns | Images | Text |
| --- | --- | --- | --- | --- |
| before | 10 | 10 | 10 | ~16,000 tokens at best |
| after | 10/10 verified | **1** | **0** | ~1,650 characters |

Across eleven runs on two different afternoons the turn count, the image count and the character count never moved. The wall clock did — 5.0 to 7.4 seconds — and it belongs to the app's own loading as much as to the tool, which is why it is not in the table.

One turn, because a flow is one call. Zero images, because nothing returns a frame as a side effect any more — there is exactly one tool that hands back pixels, and it is the one whose name is `look`.

This is the part I think transfers furthest. Every agent framework has an implicit answer to "when does the agent need to think versus just act?" Almost none of them write it down. Writing it down is what makes the sensor and the reasoner separable.

## What's borrowed

A lot, and it's worth being precise. Reading the simulator's framebuffer through Apple's private `SimulatorKit` surface and injecting touches through its HID path is work that `baguette` and `testa` did first and documented; I followed them and hit different walls.

Six of them, and they are logged in [`docs/PRIVATE_API.md`](PRIVATE_API.md) as a table of "research said X, reality was Y". The frame callback everyone cites fires when the surface is *reallocated*, which is rare — registering it and waiting produced zero callbacks in five seconds of heavy screen activity, and the real per-redraw signal is a different selector. The unregister selector has an extra `s` in it. Several IO ports conform to the renderable protocol and only the one with a non-zero display size vends a surface, so picking the first match gives you a permanently nil framebuffer that looks exactly like the API being broken. And the HID message constructor documented as taking nine arguments takes six on this Xcode — which needs no guessing at all, because the binary states its own prototype as a string.

That last point is the reusable one. When you are working against private frameworks, the binary is the documentation. Every hour I spent reasoning about what a signature *should* be was worse spent than the minute it took to ask the binary. On-device OCR is Apple's Vision framework. The accessibility tree is Apple's. The UI transition graph and the idea of compiling explored flows into scripts that run without a model come from AutoDroid (MobiCom '24) and AutoDroid-V2 (MobiSys '25), which reported prompt-length reductions near 50% and end-to-end latency reductions above 90% from exactly that pattern. Set-of-mark prompting comes from OmniParser and the papers before it.

What I'd claim as mine is the framing and the seams: perception as an always-on daemon rather than a callable; baselines relative to the observer's last look; memory gated on settled frames; motion understood from the stream; and a written contract for when the daemon must stop and ask. None of those sentences mention iOS.

## Why the simulator was the right place to prove it

It is the hardest sandbox. There is no public input API, the capture path runs through private frameworks that change between Xcode versions, and the accessibility tree is a promise apps don't always keep — in a real production app the custom tab bar published no children, icon buttons carried private-use glyphs, and React Native text inputs were absent from the tree entirely. If observer-relative perception with local memory works here, it works on a browser, a desktop, an Android emulator, or a game.

The daemon is built behind a platform boundary for that reason. Frames in, accessibility tree out, gestures in; everything above that line — history, settle, transitions, memory, graph, escalation — has never heard of `simctl`. An Android backend is the next proof, and it will be easier: every primitive it needs is a public API.

## What I'd want someone else to take from this

If you are building an agent that acts on a screen, ask three questions of your architecture:

- Do the eyes ever close? If perception is a function the model calls, they do, and you are paying the model to notice things a diff could notice.
- Is "changed" relative to the observer's last look, or to the previous frame? If the latter, your agent is blind to every transition that finishes before it polls.
- Can you write down, in a numbered list, the exact conditions under which the model must be consulted? If not, the model is being consulted by default, and OSWorld-Human's numbers are your bill.

I built simframe to test a fix faster. What I ended up with was a small argument about what an agent's senses should be. The code is at `github.com/lvlrSajjad/simframe`; the phases, benchmarks and the private-API corrections are in `docs/`.

---

*Every measurement in this piece, with N, median, p95, the machine, and the mistakes made getting to each one, is in [`docs/BENCHMARKS.md`](BENCHMARKS.md). Three separate times in this project a first measurement agreed with my hypothesis and was wrong — the capture rate, the fingerprint tolerance, and a settle gate I was sure had fixed something. Each was caught only by running it again. If you take one habit from this rather than one idea: treat a measurement that confirms what you expected as unfinished.*
