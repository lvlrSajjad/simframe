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

There is a stronger version of that "about 1 ms", and I only found it by counting rather than reasoning. I put a logging shim in front of the accessibility client and ran a ten-step flow twice — once with the screens already in memory, once with memory cleared:

| Ten-step flow | Accessibility reads | Wall clock |
| --- | --- | --- |
| warm — screens remembered | **0** | 6.6–7.4 s |
| cold — memory cleared | 14 | 17.0 s |

Zero. Not "cheap", not "cached" — the accessibility tree is never asked. A remembered screen is answered from a file, so the perception layer sits idle and the one heavyweight dependency the tool installed for that tree was on none of the paths a warm flow takes. That is the difference between a cache, which makes a thing faster, and a memory, which makes it unnecessary.

Cold, those 14 reads were about 3.8 seconds of a 17-second run — the single largest cost of a first pass, and 255 ms each against the 123 ms that on-device OCR takes to read the same screen. Which was a useful thing to know before optimising: the first visit was bound by the accessibility tree, not by the pixels.

So that is what I optimised, and the past tense is the point. The tree is now read inside the daemon rather than by shelling out to that dependency — 45 ms against 203 ms on the same screen, measured both ways in the same session — which takes a cold eleven-step flow from 20.0 seconds to 17.3, and flips which side is binding: the first visit is now bound by the pixels. The warm numbers did not move at all, because zero reads times any latency is still zero. Knowing that in advance is what made this a two-day job worth doing for the install story rather than a week spent chasing a number that was never going to change.

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

The interesting part is what I did about it, because the first three attempts were all the wrong shape. A nav-slot rule, then a tab-label width limit, then a test for values that are not names — a date, a time, a price, a bare count. Each patch was defensible and each one held. Three defensible patches for one recurring bug is a smell, and the smell was that "chrome" was being decided by fractions of screen height: anything below 86% of the way down was a tab item, which on a long list is the last two rows of content. The fix was to stop asking where the screen ends and start asking where the elements are — a nav bar is a short row of things at the top with a gap under it, and that gap is an outlier relative to *that screen's* own row spacing, not a number from a design guideline. Chrome labels entering screen identities fell from fourteen to six, and the two screens most likely to collide — two Settings sub-pages with near-identical structure, told apart only by their titles — still separate cleanly. Patching a symptom three times is how you find out you were measuring the wrong thing.

And then the same question came back one level up, wearing different clothes. When the accessibility tree came in-process it stopped being all-or-nothing — present on every screen if you had the dependency installed, absent on every screen if you didn't — and became *intermittent*: there on most screens, missing on one still launching, cut short on a slow machine. So I measured the same screen read with the tree and without it, and the two readings agree on between a third and a half of a screen's structural tokens, and never on its hash. The same screen, a second apart, with two identities.

The obvious fix is to make the fingerprint sensor-independent — coarsen the vocabulary until both sensors describe the same screen the same way. I tried it. It moved the median agreement from 0.44 to 0.47. The divergence was never the thing I assumed it was, which I'd guessed would be containers and invisible nodes that only a tree can see; those were four tokens out of twenty-three. The rest is the two sensors *disagreeing about what things are*. The tree says `button` where OCR says `text`, because one of them can read the app's mind and the other is looking at pixels. A search field is a `slider` to one and a line of text to the other. No amount of vocabulary coarsening fixes that, because the disagreement isn't about vocabulary — it's that a label and a button look identical from the outside, and the sensor that knows the difference isn't always answering.

So the answer isn't a better hash. **Identity belongs to the graph, not to the fingerprint.** A screen node carries a *set* of fingerprints, and when a reading matches nothing but arrives through an action that has always led to screen B, and the pixels are within the same-screen band of what B looked like last time, then it *is* B wearing a face we hadn't seen. The transition is evidence the fingerprint cannot supply.

What that replaced is the part worth flinching at. The old rule attached a reading to a node when *nothing else claimed it* — and unknown is not evidence of anything. A reviewer fed it a screen sharing zero tokens with its target, got it merged, and watched the tool then report `ok` — "matches the outcome seen 3x before" — while walking on and tapping real controls on a screen its plan never contained. Absence of evidence had been the whole test.

This is the same shape as "changed since when?". The sensor supplies evidence; the memory decides what it means. Every time I have tried to make a single reading carry a judgement it cannot support — is this settled, is this the same screen, did this action work — the answer has been to move the judgement into something that has seen more than one moment.

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

The daemon is built behind a platform boundary for that reason. Frames in, accessibility tree out, gestures in; everything above that line — history, settle, transitions, memory, graph, escalation — has never heard of `simctl`. An Android backend was the next proof, and I claimed it would be easier because every primitive it needs is a public API.

## The second platform, which mostly proved the point and partly embarrassed me

The claim to test was narrow: if perception is observer-relative and memory is local, none of it should know what platform it is on. So the test is not "does Android work" but **how much had to change above the boundary**, and the answer is nothing. `simframe ui` produced a full screen map of an Android emulator — elements with points, numbered refs, a structural identity — with no edit to the frame store, the settle detector, the dHash, the fingerprint, the screen map, refs, or the transition graph. Then a tap by label landed on it: `tapped "Notifications" at 138,207 (memory d=0, via ocr)`, on a platform with **no accessibility tree at all**.

What did have to change, twice, was a layer above the boundary quietly speaking the first platform's language. Engine selection asked for the Swift daemon on every device, so starting capture on an emulator failed with a message about CoreSimulator. And `doctor`, asked about an emulator, reported *"input driver: idb"* — a claim about a tool that has never spoken to an Android device in its life. Both were invisible while there was one backend. That is what a second backend is actually for: not the platform, the audit.

The prediction about public APIs was right and my guess about *which* ones was wrong in a way worth admitting. The plan said capture would be the emulator's gRPC streaming endpoint with a scrcpy-style fallback. It isn't: the emulator *console* — a plain TCP line protocol you can speak with a socket and no library — has a `screenrecord screenshot <dir>` command that makes the emulator write the PNG onto the host filesystem itself, with no device-to-host transfer at all. 41 ms, no dependency. Input is the same socket: `event mouse` puts a real down, move and up on the touch screen, which is how you get gestures with honest timing instead of teleporting taps. And the clipboard, which I had written up as *impossible* because adb has no path to it, turned out to be one gRPC call — reachable with Node's built-in `http2` in about forty lines, because a unary gRPC call is just an HTTP/2 POST with a five-byte header.

That 41 ms was published as 21 ms, and the story of how is the most useful thing in this section. I measured that number four times. The first said 2,400 ms and was a real bug: my "is this PNG complete" check looked for the `IEND` marker four bytes from the end of the file, which is the checksum and never spells anything, so every frame fell through to the slow path. The second said 67 ms, almost all of it a poll interval waiting for a file that had already arrived. The third said 21 ms and was not a measurement of a screenshot at all — the console emits an extra `OK` after authentication, so my script sent `quit` one response early, closed the socket while the emulator was still writing, and read the *previous* run's file out of a shared directory. Five consecutive runs reporting byte-identical file sizes was the tell, and I explained it away as a static screen. The fourth timed the phases separately and said 41 ms.

The lesson is not "be careful". It is that a measurement must never be allowed to be the sum of one thing finishing and another thing not having started, and the only structural defence is to time the phases apart.

## What the ladder is actually worth

Android has no accessibility tree — `uiautomator dump` costs two seconds a read, and making it fast means shipping an instrumentation app onto someone's device, which is a different promise from shipping a package. So the perception ladder's central bet got tested for real: does a missing tier degrade, or fail?

Measured on iOS, reading every screen twice from the same frame, once with the tree and once without:

- **Every interactive element came from the tree.** All 72 of 72. OCR and classical CV produce text, and nothing in that pipeline infers a button from a rectangle confidently enough to say so.
- **83% of those controls have no text at all.** They are icons. There is nothing for OCR to read even in principle.
- **And screen memory did not need the tree.** Every revisit was recognised either way, 6 of 6, with the weakest similarity barely moving.

That last line is the one I did not expect, and it splits the ladder cleanly: the accessibility tier earns its place in *acting*, not in *recognising*. Knowing where you are is a question about layout, which pixels answer. Knowing what a thing is and what it is called is a question about semantics, which pixels do not answer and a tree does.

Intent resolution went from 26 of 28 to 22 of 28 without it, and the shape of the four failures matters more than the count. Two were refusals: `refresh` and the address field resolve to *nothing*, because they are icons and there is no text to match. The third was worse — asked for `Back`, the OCR-only reading returned `"B"`, the section-index letter sitting next to it. A refusal tells the caller to look again. A confident wrong answer taps the wrong thing, and there is no verdict, no diff and no graph that can rescue an action already taken. One in fourteen, on Apple's own unusually well-labelled apps.

Android also found the sharpest version of a bug this project has now hit four times. Chrome's address bar is chrome by every structural test there is — a short row at the top with a gap under it — so the URL went into the screen's *identity*. A URL in a fingerprint does not degrade recognition, it inverts it: every visit to a new page mints a new screen, the memory fills with screens that will never recur, and every learned route through the browser breaks the moment the page changes. The rule now is that a label has to be a name before it can be an identity — two letters at minimum, and not an address.

## What I'd want someone else to take from this

If you are building an agent that acts on a screen, ask three questions of your architecture:

- Do the eyes ever close? If perception is a function the model calls, they do, and you are paying the model to notice things a diff could notice.
- Is "changed" relative to the observer's last look, or to the previous frame? If the latter, your agent is blind to every transition that finishes before it polls.
- Can you write down, in a numbered list, the exact conditions under which the model must be consulted? If not, the model is being consulted by default, and OSWorld-Human's numbers are your bill.

I built simframe to test a fix faster. What I ended up with was a small argument about what an agent's senses should be. The code is at `github.com/lvlrSajjad/simframe`; the phases, benchmarks and the private-API corrections are in `docs/`.

---

*Every measurement in this piece, with N, median, p95, the machine, and the mistakes made getting to each one, is in [`docs/BENCHMARKS.md`](BENCHMARKS.md). Three separate times in this project a first measurement agreed with my hypothesis and was wrong — the capture rate, the fingerprint tolerance, and a settle gate I was sure had fixed something. Each was caught only by running it again. If you take one habit from this rather than one idea: treat a measurement that confirms what you expected as unfinished.*
