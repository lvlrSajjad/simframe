# Agents Shouldn’t Blink

*Field notes · simframe · iOS Simulator*

> **This file is generated** from [`agents-shouldnt-blink.html`](agents-shouldnt-blink.html)
> by `scripts/article-md.mjs`. Edit the page, not this — a hand-kept copy of a
> document is a copy that drifts, and this one did.
>
> The measurements, with N, median, p95 and the mistakes made getting to each,
> are in [`BENCHMARKS.md`](BENCHMARKS.md); what we expected before measuring is
> in [`EXPERIMENTS.md`](EXPERIMENTS.md).

---

*The observation*

## What I noticed watching Claude test my app

I had asked Claude Code to check a fix on the iOS Simulator. It could do it — open the app, navigate, confirm the change — but it was painfully slow, and watching it work I realised the slowness had nothing to do with intelligence. It was slow the way a person would be slow if they had to close their eyes between every action.

Here is what Claude did for each step: take a screenshot, wait for it, send the image to itself, reason about what was on it, decide where to tap, tap, and then start again from the screenshot. Every step was a blink. Every blink cost a network round trip and a few thousand tokens.

Here is what I do when I test the same flow. I already see the screen — there is no moment where I decide to look. I know how I got here, so I know what screen this is without reading it. I know where the Settings tab is because I tapped it thirty seconds ago; my hand goes there without my eyes checking. When the screen slides, I know it slid, and I know whether it slid the way I expected, before anything has finished animating. And when something surprising happens — an alert I didn’t expect, a screen I’ve never seen — *that* is when I actually think.

The difference isn’t that I’m smarter than the model. It is that I have eyes that never close, a hand that has memory, and a very cheap sense of whether the world just did what I meant it to. The model was being asked to do all of that with a single expensive tool: reason about a still image.

I am not as precise as the model. It never mis-taps a control it can see; I do. But I am much faster, and after a while I realised the speed came from architecture, not ability. So I built the architecture.

*The claim*

## Perception should be a process, not a function call

**Perception for an agent should be a continuously running process with observer-relative memory — a daemon — and the boundary between perceiving and reasoning should be a specified contract, not an ad-hoc loop.**

Almost every agent framework today, including the computer-use loops the model labs ship, treats seeing as a function the model calls: `screenshot()` → reason → act → `screenshot()`. That design makes the most expensive component in the system, the language model, responsible for the cheapest job: noticing that a spinner is still spinning, that the screen hasn’t finished sliding, that this is the same tab bar it saw a minute ago.

It also has a compounding cost. The OSWorld-Human study (Abhyankar, Qi & Zhang, MLSys 2026) measured where agent time actually goes and found that model calls for planning and reflection consume roughly 75–94% of total task time, that each step carries the whole observation history so later steps run up to 3× slower than early ones, and that leading agents take 1.4–2.7× more steps than a human needs. Every unnecessary look is not one wasted call; it is one more image dragged through every subsequent call.

The alternative is to give the agent senses that work the way mine do.

*The architecture*

## Eyes, hand, memory

I ended up with three parts, and I think the vocabulary is more reusable than the code.

**Eyes** — a process that always holds the current frame. Nothing is captured on request. The screen is watched continuously, the newest frame is always available, and “look” is a read, not a wait.

The first version did this by calling `simctl io screenshot` on a loop, which turned a ~130 ms blocking screenshot into a ~20 ms file read. The rebuilt daemon reads the simulator’s framebuffer directly, and the difference is larger than I expected.

**Capture — same work, two paths**

| Path | Median |
| --- | --- |
| `simctl io screenshot` + downscale | 210 ms |
| framebuffer grab + downscale + both hashes | **6.74 ms** |
| the framebuffer grab alone | **0.13 ms** |

Thirty-one times faster for the same work, and the capture primitive itself is about a thousand times faster than a screenshot. Almost all of the remaining 6.7 ms is the downscale, not the capture.

**Amended — the unit was wrong**

The daemon has no frame rate. It captures when the simulator says its screen changed — a damage signal, about 52 per second while something is moving, and *nothing at all* while the screen is still. “60 fps” was the wrong thing to aim at.

A still screen should produce no frames, and reasoning about it as a rate is how I ended up with a CI check that asserted a frame counter had advanced on an idle screen. It failed three times before I understood why.

**Hand** — whatever performs actions, but with the property a human hand has: it can act on an intent — “the Settings tab” — without the eyes re-reading the screen, because it remembers where that control was. In simframe this is the screen memory: every screen the agent has seen is keyed by a layout hash, and the map from label to tap coordinate is stored. First visit ~305 ms to build — accessibility tree and on-device OCR, run concurrently — and every visit after that about 1 ms.

**A four-tab flow, three times back to back, memory cleared first**

| Pass | Wall clock | Steps verified | From memory |
| --- | --- | --- | --- |
| 1 | 10.2 s | 0 / 4 — nothing known yet | 4 / 4 |
| 2 | 3.6 s | 4 / 4 | 4 / 4 |
| 3 | 3.7 s | 4 / 4 | 4 / 4 |

**Amended — the earlier table measured two bugs**

An earlier draft of this piece quoted 7370 → 5160 → 3304 ms for the same flow. Those were real measurements of the wrong thing: input was silently falling back to a slower path, and the capture daemon was being replaced by every single command because a version constant had drifted between the Swift and JavaScript halves.

Nine hundred and ninety-three daemon respawns in one session, and every timing in the project quietly wrong. It took someone else running the tool to find it.

There is a stronger version of that “about 1 ms”, and I only found it by counting rather than reasoning. I put a logging shim in front of the accessibility client and ran a ten-step flow twice — once with the screens already in memory, once with memory cleared.

**Accessibility reads per ten-step flow, counted**

| Ten-step flow | Accessibility reads | Wall clock |
| --- | --- | --- |
| warm — screens remembered | 0 | 6.6–7.4 s |
| cold — memory cleared | 14 | 17.0 s |

Zero. Not “cheap”, not “cached” — the accessibility tree is never asked. A remembered screen is answered from a file, so the perception layer sits idle, and the one heavyweight dependency the tool installed for that tree was on none of the paths a warm flow takes. That is the difference between a cache, which makes a thing faster, and a memory, which makes it unnecessary.

Cold, those 14 reads were about 3.8 seconds of a 17-second run — the single largest cost of a first pass, and 255 ms each against the 123 ms on-device OCR takes to read the same screen. Which was worth knowing before optimising anything: the first visit was bound by the accessibility tree, not by the pixels.

**Since — the measurement told me what to build, and what not to**

So that is what I optimised, and the past tense is the point. The tree is now read inside the daemon rather than by shelling out to that dependency — **45 ms against 203 ms** on the same screen, measured both ways in the same session — which takes a cold eleven-step flow from 20.0 seconds to 17.3, and flips which side is binding: the first visit is now bound by the pixels.

The warm numbers did not move at all, because zero reads times any latency is still zero. Knowing that in advance is what made this a job worth doing for the install story — nothing beyond Xcode is required now — rather than a week spent chasing a number that was never going to change.

**Memory** — the part I found most people miss, and it splits in two.

*Visual memory* is the recent frames. Not one frame — the last minute of them. It is what lets the daemon answer “did anything change?” and “what moved?” as text, in about 2 ms, and it is what lets a transition be understood as motion rather than inferred from two stills.

*Procedural memory* — muscle memory, if you like — is the record of how screens connect: I was on screen A, I tapped this, I arrived at screen B. Once that graph exists, a flow the agent has completed once can be replayed with zero model calls, and an action’s outcome can be *predicted* before it happens, which is what makes verification cheap.

*The smallest idea, and the one I’d defend hardest*

## “Changed since when?”

Every change question is really “changed *since when*?”, and the natural answer — since the previous frame — is wrong for an agent. A UI transition is over in about 700 ms. An agent that acts and then polls a second later, comparing consecutive frames, sees a still screen and concludes nothing happened, even though the screen is completely different from when it last looked.

The baseline for “changed” has to be **the last frame the observer actually saw**. The daemon records what the agent looked at, and every subsequent state query is relative to that. Over MCP this is automatic; from the CLI you take a mark before acting. This is observer-relative perception, and it is the property that makes a continuously running sensor useful to an intermittently attending reasoner. Without it, a faster camera just gives you more frames to be confused by.

**Amended — a better sensor made the memory worse**

When the new daemon started capturing on every damage event instead of four times a second, screen-memory hit rates got *worse* — 1–2 of 4 instead of 4 of 4 — with byte-identical hashing. More frames meant more mid-transition frames, more distinct layouts, more rebuilds. Correctness held, because a missed match rebuilds the map and never mis-taps; only the speed regressed.

The fix was not to slow the camera down. It was to key memory off a *settled* frame rather than whichever frame happened to be newest, which restored 4/4 and is why the table above is flat after the first pass. The lesson generalises: **memory must be keyed off settled observations, never arbitrary frames.** Frame rate and memory keying have to be decoupled, or a better sensor degrades the memory built on it.

*Motion*

## Understanding motion instead of comparing stills

Once you hold a stream rather than a snapshot, the frame history becomes a signal in its own right.

Settled-state detection replaces `sleep()`: the daemon waits for a change and *then* for stillness, because a bare “wait until stable” called just before an animation begins returns immediately and uselessly. A small region changing every frame while the rest is still is a spinner, not a settled screen.

Transitions can be classified rather than guessed. A horizontal shift of the content with a nav-bar title crossfade is a push; the reverse is a pop; a vertical shift with stable chrome is a scroll, and phase correlation gives the exact offset. A region rising from the bottom with dimming behind it is a sheet; a centred rectangle with dimming is an alert; a change confined to the bottom 40% is the keyboard. These are region-diff and shift-search operations on a 48×96 grayscale grid, and the whole analysis costs under about 2 ms per frame — inside the noise of the capture pipeline it runs in.

**Classifier against a real app, settled state to settled state**

| Action | Classified | Offset |
| --- | --- | --- |
| Swipe up on a list | `scroll` | (0, 146) pt |
| Swipe down on a list | `scroll` | (0, −164) pt |
| Tab switch | `replace` | — |
| Nothing | `none` | — |

Getting there needed two mistakes worth keeping. Searching the whole frame for a translation found `dy=0` for a scroll that had visibly moved — a nav bar, search field and filter row that stay put are a quarter of the screen and pixel-identical, so no shift beats no shift. And the shift score subsampled columns while the baseline it was compared against did not, so the ratio deciding “is this a translation” was comparing two different quantities.

It is still imperfect. A scroll that hits the top of a list and rubber-bands reads as `replace`, because after the bounce the frames genuinely are not a translation of each other. That matters less than it sounds, and here is why.

### Verifying an action without a model

Before acting, if the transition graph has an edge for this screen and this action, the daemon predicts the destination. After settling, it compares. The outcomes are a small closed set: `ok`, `no-visible-change`, `unexpected-screen`, `unverified`. A radio button that moves 0.1% of the screen used to burn a full timeout; now it returns marked `no-visible-change` instead of waiting out the clock.

**Amended — that verdict is wrong more often than it is right**

The sentence above used to end “and the agent knows to check rather than wait”, which credits the verdict with more than it earns. A tester driving a real form measured every radio and segment tap at **~2.5 s** of dead wait, not a second — and each one *had worked*. Being told nothing happened when something did is not a hint to check; it is a wrong answer that costs a model turn to disbelieve.

The mechanism, measured since: `changed` is a mean absolute difference over a 4×8 grid of gray means against a threshold of **0.004**, and an iOS switch flipping moves that mean by **0.001348** — a third of the threshold. So a whole class of controls, every switch, radio, checkbox and segment, changes nothing as far as the daemon is concerned. A per-region backstop exists now, calibrated to a measured gap: the flip moves one cell of thirty-two by 0.043, while the loudest thing on eighty seconds of a static screen — the status-bar clock ticking — reaches 0.0039.

It is not fixed, and saying so is the point of the section this sits in. The frame hash is more sensitive than the mean and catches some of these on its own, which is why the class is intermittent rather than uniform; and `no-visible-change` still fires on things like a modal opening. What the closed set of verdicts buys is that a wrong one is *nameable* — it appears in an escalation log, it gets counted, and it gets a threshold with a number behind it. An unnamed wrong answer just makes the tool feel unreliable.

That list used to have a fifth entry, `unexpected-transition`, and removing it is the most useful thing I did to the verification layer. The motion classifier is noisy — the same tab switch reads `replace` on one run and `pop` on the next — and it was the *only* thing producing failures on navigation that had gone exactly where predicted. A verdict that says something is wrong when nothing is wrong teaches you to ignore verdicts. So the transition kind is now reported alongside `ok` rather than overriding it, and the verdict rests on the one signal that proved reliable: which screen you ended up on.

Knowing *which screen* turns out to be the hard part, and it is not a pixel question. Two hashes do two jobs. A perceptual hash of the pixels answers “did anything change” and “has it settled”, because that is a question about pixels. Screen *identity* is structural — roles, quantised sizes, region, roughly how many siblings, and the chrome labels — because a list with new rows in it is the same screen, and no pixel hash can say so.

**Amended — an identity with until midnight to live**

Chrome labels are the only text in a fingerprint, which makes them the only thing available to name a screen by. It also means anything misclassified as chrome lands directly in a screen’s identity. One screen’s identity contained the string `"sep 08, 2026"`.

It was perfectly stable — stable on something that expires. At midnight it would have become a different screen, and every stored map, route and remembered tap point touching it would have broken overnight, with nothing to flag it. I found it twice, in two different phases, and the second time only by dumping the tokens of all twenty learned screens and reading them.

**Since — three defensible patches for one bug is a smell**

The interesting part is what I did about it, because the first three attempts were all the wrong shape. A nav-slot rule, then a tab-label width limit, then a test for values that are not names — a date, a time, a price, a bare count. Each patch was defensible and each one held.

Three defensible patches for one recurring bug is a smell, and the smell was that “chrome” was being decided by fractions of screen height: anything below 86% of the way down was a tab item, which on a long list is the last two rows of content. The fix was to stop asking where the screen ends and start asking where the elements are — a nav bar is a short row of things at the top with a gap under it, and that gap is an outlier relative to *that screen’s* own row spacing, not a number from a design guideline. Chrome labels entering screen identities fell from **fourteen to six**, and the two screens most likely to collide — two Settings sub-pages with near-identical structure, told apart only by their titles — still separate cleanly.

That paragraph was true about the screens it looked at and wrong about the one it did not. A year’s worth of care went into deciding which labels are chrome, and none of it noticed that some screens were entering identity with *no label at all*. An iOS large title — the big bold name at the top of a root screen — is drawn tight against the content beneath it: measured on the Settings root, **79 points of inset above it and 5.3 below**, against a boundary test that wanted 66. The detector looked for the gap *under* a bar, iOS had put the gap *over* it, and so the screen’s own name was filed as content and thrown away. Settings, Contacts and Reminders were all pure geometry. On a hosted CI runner two of those shapes matched exactly and one hash stood for two different screens, which is how it was finally noticed — after an evening spent blaming the runner.

The fix took two tries and the second one is the interesting half. Finding large titles was easy once the question was right. But naming both screens did not separate them: two lists of rows under large titles still scored **0.50 against a threshold of 0.36**, because similarity weighs every token the same and the name was one token out of a union of six. A chrome label is not an ordinary token — it is the screen’s claim about what it is — so a differing name now vetoes a match outright, however alike the shapes. The module’s own comment had said as much since the day it was written: *“two list screens with identical structure differ by their title, and nothing else says so.”* Nothing had ever enforced it. Writing down the right rule and not implementing it is a way of being wrong that looks, in a diff, exactly like being right.

The same week produced a smaller lesson with a sharper edge. Capture would occasionally stop: the display stopped rendering, `simctl` could not screenshot it either, and only restarting the device helped. The daemon had a recovery ladder for this — re-resolve the display port, then rebind the device — and a log from a bad afternoon showed it climbing that ladder **670 times**. The recovery registered a fresh damage callback each attempt and released none of them, on a port it kept re-finding. Six hundred and seventy live callbacks, each firing per redraw. The thing meant to rescue capture was the thing saturating it, and because every individual attempt looked reasonable, the loop read as patience rather than as a leak.

Patching a symptom three times is how you find out you were measuring the wrong thing.

**Since — identity belongs to the graph, not the hash**

Then the same question came back one level up, wearing different clothes. When the accessibility tree came in-process it stopped being all-or-nothing — present on every screen if you had the dependency, absent on every screen if you did not — and became *intermittent*: there on most screens, missing on one still launching, cut short on a slow machine. The same screen read with the tree and without it agrees on between a third and a half of its structural tokens, and **never on its hash**. The same screen, a second apart, two identities.

The obvious fix is a sensor-independent fingerprint — coarsen the vocabulary until both sensors describe the screen the same way. I tried it. It moved the median agreement from 0.44 to 0.47. The divergence was not what I assumed: I expected containers and invisible nodes that only a tree can see, and those were four tokens out of twenty-three. The rest is the two sensors *disagreeing about what things are*. The tree says `button` where OCR says `text`, because one can read the app’s mind and the other is looking at pixels. No amount of coarsening fixes that: a label and a button look identical from outside, and the sensor that knows the difference is not always answering.

So the answer is not a better hash. A screen node carries a *set* of fingerprints, and when a reading matches nothing but arrives through an action that has always led to screen B, and the pixels are within the same-screen band of what B looked like last time, then it *is* B wearing a face we had not seen. **The transition is evidence the fingerprint cannot supply.**

What that replaced is the part worth flinching at. The old rule attached a reading to a node when *nothing else claimed it* — and unknown is not evidence of anything. A reviewer fed it a screen sharing zero tokens with its target, got it merged, and watched the tool report `ok` — “matches the outcome seen 3x before” — while walking on and tapping real controls on a screen its plan never contained. Absence of evidence had been the whole test.

This is the same shape as “changed since when?”. The sensor supplies evidence; the memory decides what it means. Every time I have tried to make a single reading carry a judgement it cannot support — is this settled, is this the same screen, did this action work — the answer has been to move the judgement into something that has seen more than one moment.

*The seam*

## Where the model belongs

None of this removes the model. It moves it.

The daemon’s job is to answer, locally and fast, everything that has a local, fast answer: what’s on screen, which element matches this intent, has the screen settled, did that action do what was predicted, have I been here before. Its job is *also* to know exactly when it cannot answer, and the rebuild formalises that as an escalation contract. The reasoner is consulted when:

- the screen fingerprint has never been seen;
- an intent matches no element confidently, or two elements too closely — ambiguity is reported, never guessed, because silently tapping the wrong one looks exactly like nothing happening;
- a verified action did not produce its predicted outcome;
- an unfamiliar modal, alert or system dialog appears;
- the goal spans multiple steps and no compiled flow or graph path covers it.

Everything else is acted on without a round trip. What the model receives when it *is* consulted is compact text — regions, numbered elements with role, label, state and source, the last action’s verdict, any ambiguity — not an image. It can ask for the image; it rarely needs to.

That last sentence is the whole point, so it is worth being concrete about the price of an image.

**One screen, 700 px on the long edge**

| How it reaches the model | Size | Tokens |
| --- | --- | --- |
| the PNG | 107 KB | — |
| as a native image block | — | ~1,600 |
| its base64, if the client mishandles it as text | 143,000 chars | ~41,000 |
| the compact text map of the same screen | 1,159 chars | **~330** |

Token figures divide characters by 3.5 — an estimate. The character counts are the measurements.

The text is roughly five times cheaper than an image handled correctly, and over a hundred times cheaper than one handled the way an open Claude Code bug describes — where 41,000 tokens would also blow straight through the 25,000-token tool-result ceiling and be truncated. And unlike the image, it carries a tap point for every element, so nothing has to be measured by eye.

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

Region first, because “Inbox” the title and “Inbox” the tab differ only by where they are. A number, which is a selector — whatever this calls `#3`, the next call taps as `#3` without describing it. And a verdict, so the model learns what its last action did without asking.

**A ten-step flow through the MCP server — five consecutive warm runs**

|  | Steps | Model turns | Images | Text |
| --- | --- | --- | --- | --- |
| before | 10 | 10 | 10 | ~16,000 tokens at best |
| after | 10 / 10 verified | 1 | 0 | ~1,650 chars |

Across eleven runs on two different afternoons the turn count, the image count and the character count never moved. The wall clock did — 5.0 to 7.4 seconds — and it belongs to the app’s own loading as much as to the tool, which is why it is not in the table.

One turn, because a flow is one call. Zero images, because nothing returns a frame as a side effect any more — there is exactly one tool that hands back pixels, and it is the one whose name is `look`.

This is the part I think transfers furthest. Every agent framework has an implicit answer to “when does the agent need to think versus just act?” Almost none of them write it down. Writing it down is what makes the sensor and the reasoner separable.

*Two brains, and only one of them may be wrong*

## The reflex tier did not need to be intelligent

A brain does not run at one speed. Some of it argues about philosophy; some of it pulls your hand off a hot pan before the arguing part has been told. They have different latencies and, more importantly, different authority.

An agent driving a screen has the same shape, and the reason is unglamorous: its eyes and hands are on this machine and its reasoning is in a data centre. Every decision that has to cross that gap costs a round trip. A person whose motor cortex had to consult another continent before each tap would be slow too — not because they were stupid, but because of where the wire ran.

So the architecture splits by *who is allowed to be wrong about what*. The fast local part answers what is on screen, which element matches an intent, whether the screen has settled, whether the last action did what was predicted, and whether it has been here before. The slow remote part decides what to want. And the asymmetry is the load-bearing half: **the fast part may never take an action that cannot be undone.** Anything wearing a destructive label, anything that leaves the app, anything on a path that has gone wrong before — those wait for the part that can be held responsible. A model call is cheaper than a wrong tap.

Which raises the obvious question, and it was worth measuring rather than assuming: should the fast part be a small local model? A three-billion-parameter model runs on this machine in a few hundred milliseconds instead of the seconds a network round trip costs. The plan for it was written, the candidate picked, the context budget worked out.

Then the prize was measured before the solution, and it was 5%.

**Element decisions taken driving real apps — would a local model have helped?**

| Of 40 decisions where an element had to be chosen | n | Share |
| --- | --- | --- |
| already resolved locally, with no model at all | 37 | 92.5% |
| ambiguous — a planner could pick | 2 | 5.0% |
| not found — a planner cannot invent an element | 1 | 2.5% |

Reconstructed from verified transition-graph edges: every edge is a decision that demonstrably worked, carrying its goal and the element list it was taken against. Cross-checked against the escalation log, which has the opposite bias — resolution failures per traversal on a real third-party app came to 4 in 73, or 5.5%.

The reason is more useful than the number. **By the time a step reaches the tool, the decision has already been made.** A verified edge’s goal *names* the option — the reasoner chose it and then asked for it by name. The deliberation you are paying for happens upstream of the call, in the one place a model reading an element list cannot see. A local planner would spend its milliseconds re-deriving a conclusion already reached.

So the survival brain here is not a brain. It is a string matcher, a structural fingerprint and a graph of what worked last time — and that is the finding I did not expect. The reflex tier had to be *fast* and *trustworthy*. It did not have to be smart.

What actually shortened the loop was not thinking faster. It was needing to think less often. The graph already knew which controls had worked on each screen and reported only how many — `(known, 3 known exits)` — so it named them instead:

```
iPhone 17 Pro · 402x874pt · screen 0e1c7d0c (known, 1 known exit)
worked here before: tap "NEW REQUEST" (7x)
```

**Same task, same app, a fresh agent each time — one line added between the runs**

|  | Tool calls | Reads | Images | Wall |
| --- | --- | --- | --- | --- |
| before | 25 | 11 | 2 | 6m 16s |
| after | 19 | 4 | 1 | 5m 10s |

Zero perception cost and no model call — the labels were already on disk. For comparison, the same flow run by an agent that knew every label in advance was **16 steps in a single call**, which is the ceiling this is walking toward.

The best moment in that run was not a saved read. On a screen whose list had not finished loading, a remembered `tap` on a list row seen ten times before let the agent write a wait and a tap in one call *for a control it could not yet see* — collapsing read, wait, read, tap into one trip. Remembered vocabulary is worth more as material for writing a chain than as an answer to a question.

And then it pointed at a submit button. A wizard’s read-only review screen had been given the same structural identity as its first step, so it inherited that step’s entire vocabulary: three remembered controls, none of them present, offered under a hint that said *chain the next steps without looking again*. The only control on that screen submits the form for real.

The line was right; the identity was wrong. So the line now checks itself against the screen in front of it, and when memory and screen disagree it says so — that disagreement outranks any encouragement to carry on, because the usual cause is two screens sharing one fingerprint. Which is the same lesson as the destructive-label rule, arriving from a different direction: **the fast tier earns its speed by being the first to admit it might be on the wrong screen.**

None of this closes the question of a local model; it narrows it. The job it was offered — choose the element — turned out to be nearly free without one. The job it was *not* offered is triage: a step fails mid-sequence, and something must decide in milliseconds whether this is benign enough to continue or bad enough to stop. That is survival-brain shaped, and it is exactly where a round trip gets forced.

So that is what the local tier does now, and the shape of it came from the owner rather than from me. The planning model plans. A deterministic executor runs the plan and verifies every step — code is the better executor, because it is faster, exact, auditable, and cannot invent a step. The local model sits *behind the hands and in front of the reasoner*, and when a step fails it answers one of three words: **wait**, **retry**, **stop**.

Three words is the safety property, and it is not a threshold. It cannot invent a step, skip one, substitute a target or continue past an unexpected screen, because those are not answers it can give. That constraint has a specific author: an earlier component in the same position *was* given latitude over what to open, and it opened a control labelled Cancel, then pressed a button labelled “Yes, this fixed my problem”, in a live app, destroying the half-finished task it was meant to be testing. One label further along was the submit button. A design whose safety depends on the author’s private reading of their own documentation is not a design with a safety property.

That was written as an intention, and I went looking afterwards for whether it was mechanically true or merely a nice sentence. It is true, at the layer you would want it to be. Apple’s guided generation enforces the constraint by *masking tokens at sampling* — in their own words, “the model is only allowed to pick valid tokens according to the schema” — so a fourth word is not caught and rejected after the fact, it is unrepresentable. The answer space is closed by the decoder, not by a validator downstream of it, and not by the model’s good behaviour. I would rather have checked and found the opposite than kept the sentence unexamined.

One more thing had to be true before it worked at all. Asked cold, it called a list that was plainly still arriving a dead end — because it has no idea what app it is looking at, and the planner, by the time it writes the plan, does. So the plan briefs its own first responder: a sentence about how this app’s lists load, what keeps a control disabled, what a benign failure looks like here. With that sentence it answered four real cases correctly at around 700 ms. Without it, one in four.

And what it is not trusted with is its own prose. It returned a correct decision once with a reason citing a rule that did not apply. The decision is used; the sentence is recorded as a claim and never shown as the reason something happened. A confabulated rationale reads exactly like a real one, which is the whole problem.

**This part is measured on a bench and not yet in the field**, and the distinction matters more than usual here, because every previous local-tier idea in this project survived the bench and died on a real app. The number that will settle it is not accuracy. It is whether batches that used to be abandoned now finish.

Then it got its first side-by-side, and the result is more interesting than a win. Two agents, same model, same device, filling every field of two web forms in a mobile browser — one with the supervisor and a plan briefing, one with neither. **25 calls against 45**, with 28 per cent of the first arm’s calls spent recovering against 58 per cent of the second’s.

And **both arms filled every field.** That is the first thing to say, because the gap invites the conclusion that the unsupervised agent fails, and it did not. What differed was cost, not completion.

The gap also is not the supervisor’s. Its three words fired three times — one clearly right, one defensible, one wrong — and three interventions cannot account for twenty calls. What can is the sentence the plan writes for it. **Nine steps carrying a per-step note passed without an intervention that would each have looked like a failure**: a time picker that will never accept typed text, a radio button repainting twelve pixels, an option list collapsing on success. The unsupervised arm recorded the other half of that from the inside — three “nothing changed” verdicts contradicted by the element list printed underneath them, and a conclusion worth quoting exactly: *“I was instructed to spend a call disproving a claim the same response had already disproved.”*

And one more caution belongs next to those numbers, because I put them in print before I earned them. **This is a single run, and single-run agent measurements sit inside a noise band wide enough to contain it**: reported variation of 2.2 to 6.0 points depending on which run you pick, and 15 to 22 per cent of tasks flaky across identical reruns. Twenty-five against forty-five is one run of a two-armed test of a two-factor system. The direction has other people’s evidence behind it — agents given accumulated context beat agents given a runtime critic, repeatedly and by large margins — but the specific number here is not yet a result, and calling it one would be the exact failure this whole piece is about.

So the briefing and the model were measured together and cannot be separated by this experiment. The arm that would separate them — **briefing, no model** — has not been run, and if it lands near 25 then the briefing is the whole result and the local model is optional. That would be the more valuable finding, because a sentence of context costs nothing and needs no weights.

**Since then, part of that has been answered, and in the direction the paragraph above was bracing for.** One simulator pass recorded 22 real step failures; four judges then answered the identical 22, three times each, all briefed from the same source text and all constrained to the same three-word schema. Apple’s on-device ~3B scored 77, 82 and 86 per cent on three runs of the same questions. A 4-bit `qwen3:8b` scored 91. A `qwen3:14b` — seventy-nine per cent larger and sixty-two per cent slower — scored **82**. More capacity made it worse. And a one-line threshold on a number the daemon already computes, with no model at all, scored **95 per cent at zero latency**, on a population fixed before that population existed.

Two more results came out of the same 22 questions, both negative, and I think they are worth more than the ranking. The obvious next move was a **cascade** — answer free where you can, fall through to the small model where you cannot, pay a round trip only after that. It was worse at every band we tried: 95 per cent for the free rule alone, then 91, then 86, then 82 as more was handed to the model. The reason is the useful part. A cascade needs a tier that can say *I don’t know*, and no tier has one — a threshold always answers, and the supervisor’s vocabulary is three words none of which is an abstention. And the obvious abstain signal, closeness to the decision boundary, is the wrong one here: the rule’s single error sits 3,534 ms from its own threshold against a median row distance of 1,610, so a band wide enough to catch it escalates twenty of the twenty-two rows first.

So I added the fourth word and measured it. **The model never used it once, and lost about a third of its accuracy for having been told it could** — 77, 82, 86 per cent across three runs became 45, 50, 55. One paragraph added to the brief; nothing else changed; the answers to the *original* three-word question got worse. That is prompt sensitivity rather than judgement, and it would have been invisible without a before/after on identical inputs. It does not say abstention is a bad idea — nothing there tested a model that abstains, because neither of them did. It says the option cannot be described to this model for free.

And one number I had been quoting the wrong thing instead of. Accuracy is not what a supervisor is for. On the same population it **handled 9 of 22 failures locally with no round trip** and escalated 13, which at 10–16 seconds a round trip is something like 90–145 seconds saved. The check that makes that safe is already there and it is asymmetric: acting on *wait* or *retry* re-runs the step, and whether it worked is the verdict on the ruling. Acting on *stop* produces no evidence at all — you stopped, so you never learn whether continuing would have worked. Which is why the direction a judge errs in matters more than how often it errs.

The part worth carrying, though, is not the ranking. **Every arm errs in exactly one direction, and the directions are opposite.** All of Apple’s mistakes are *wait* where *stop* was right; all of both Qwen arms’ are *stop* where *wait* was right. A wrong *wait* costs a settle and a re-run. A wrong *stop* abandons a plan that would have worked. So the arm with the best score fails in the expensive direction and the arm with the worst score fails in the cheap one — and a comparison that had reported only the percentages would have recommended the wrong model. Which is, once again, the thing this whole piece is about: **the number was real and the conclusion it invited was wrong.** Conditions, caveats and the reasons to distrust that threshold are in [What We Believed First](https://github.com/lvlrSajjad/simframe/blob/main/docs/EXPERIMENTS.md).

Which is why the local tiers ship **off by default**, and that is not timidity, it is the same rule as everything else here. A tier is trusted where it has been measured, and this one has been measured on a bench and in one arm driven by its own author — not by a stranger, not on somebody’s real app. Every claim in this project that skipped that step has been overturned by a log: two phase premises, a map optimisation, a learned-stillness estimator. **Shipping a promising thing switched off is what makes the eventual number mean something**, and a flag is a cheap price for that.

*Where am I, and why nothing could answer it*

## Four signals for one question, three of them wrong

A form taller than the screen is only knowable a screenful at a time. The accessibility tree publishes what is rendered, so the fields below the fold do not exist yet — there is nothing to search for and nothing to scroll to.

Which makes the obvious tool useless. “Scroll until you find X” hunts one label, and X is not there to be found; it gets discovered by being scrolled to. So the unit has to be the viewport: read this screenful, act on what is in it, move by a screenful, repeat. That framing came from the owner, watching it fail: *“detect min and max scroll and look at it section by section — section one, anything to fill? Do it. Not? Scroll to section two.”*

Which turns the whole problem into one question: **where am I in the scroll range?** And neither iOS nor Android will tell you. There is no scroll offset in the accessibility tree, no content height, no scrollbar to read. It has to be inferred, and I inferred it wrongly three times.

**Four answers to “did that gesture move anything?”**

| Signal | How it failed, on a real page |
| --- | --- |
| the screen fingerprint stopped changing | a footer with live content changes it forever — it thrashed at the bottom for **40 seconds** |
| a screenful added no new labels | a gesture revealing a little looks like an end — it stopped **two sections above** the form |
| element positions, all elements | a browser toolbar is five rows whose *y* never moves, dragging the median to zero — it declared the bottom after **one section** |
| element positions, content only, two consecutive stalls | works |

The working answer is embarrassingly concrete: take the labels present both before and after a gesture, throw away anything in a fixed region, and compare their vertical positions. An unchanged median means nothing moved. That is a scroll-position sensor built entirely out of things already being read for other reasons.

Two of those details are load bearing and neither was obvious. **Content only**, because fixed chrome is a majority of the shared set on a short page and it never moves — averaging it in says “stationary” about a page that plainly scrolled. And **two consecutive stalls**, not one, because any sticky element inside a page makes a single median read as zero. Acting on one stall produced exactly the symptom the owner described from across the room: *“I feel like you miss the form — you either scroll to the end or to the beginning.”*

There was a fourth mistake underneath all three, and it is the one I would most want a reader to take. The default scroll gesture moved **28, 42 and 58 points** on an 874-point screen — about five per cent of a viewport. Every version of this was making dozens of tiny gestures and calling it a search, which is what *“you scrolled too much”* was actually describing: not too far, too many. A section is a viewport, and once a gesture moves a viewport the loop is four steps long instead of thirty.

The result fills a form taller than the screen in one call. What I find worth recording is not the feature but the shape of getting there: every wrong signal was a reasonable abstraction — a hash, a label set, a median — and each one failed on a specific, ordinary property of a real web page. None of them failed in a test.

*What the contract said when it was first measured*

## Sixteen of nineteen were one bug

The escalation contract above was written as an architecture. Then it was instrumented — every escalation appended to a log with one of five reasons, a screen fingerprint, and what it cost — and the first breakdown did something a design document cannot do. It disagreed with the plan.

Nineteen escalations. **Sixteen of them were the same de-duplication bug**: the accessibility tree and OCR both reporting one contact row, the ambiguity check correctly refusing to guess between them, and a human reading the log and finding a whole faculty’s worth of “the model must decide this” that was really one arithmetic error about overlapping rectangles. An IoU (axis-aligned bounding box overlap over union) test scored those two boxes at 0.053 and let them both through; containment scored them at 1.000, because the OCR box sits entirely inside the row. One threshold, in one function.

The refusal was right. The tool was asked to choose between two things it could not tell apart, and it stopped and said so rather than tapping one — which is the contract working exactly as written. What was wrong was upstream of the decision, not in it. That distinction only exists because the log records *why*, and the fix took the flow it was blocking from **0 of 5 runs completing to 5 of 5**, with no new escalations of any kind.

The lesson generalises past this tool. A planned order of work is a hypothesis about where the cost is, and instrumenting the boundary is how you find out. The phase order here said to build a local reasoner next; the log said to fix a rectangle comparison. Two other measurements did the same thing later: a pause statistic that turned out to be noise in *both* directions rather than the one the design assumed, and a map optimisation that saved characters on settings screens and spent a 1,600-token screenshot on list screens. Each was written down as a number before it was believed, and each overturned something in this piece.

Which is the actual argument for a closed set of five reasons and a log nobody has to remember to write. Not that it makes the tool faster. That it makes being wrong *legible* — and every claim above this line is one measurement away from an amendment box.

*Credit where it is due*

## What’s borrowed

A lot, and it’s worth being precise. Reading the simulator’s framebuffer through Apple’s private `SimulatorKit` surface and injecting touches through its HID path is work that `baguette` and `testa` did first and documented; I followed them and hit different walls.

**Amended — six times, by the binary itself**

The frame callback everyone cites fires when the surface is *reallocated*, which is rare: registering it and waiting produced zero callbacks in five seconds of heavy screen activity. The real per-redraw signal is a different selector. The unregister selector has an extra `s` in it. Several IO ports conform to the renderable protocol and only the one with a non-zero display size vends a surface, so picking the first match gives you a permanently nil framebuffer that looks exactly like the API being broken. And the HID message constructor documented as taking nine arguments takes six on this Xcode.

That last one needed no guessing at all, because the binary states its own prototype as a string. Which is the reusable point: when you are working against private frameworks, **the binary is the documentation**. Every hour I spent reasoning about what a signature *should* be was worse spent than the minute it took to ask.

On-device OCR is Apple’s Vision framework. The accessibility tree is Apple’s. The UI transition graph, and the idea of compiling explored flows into scripts that run without a model, come from AutoDroid (MobiCom ’24) and AutoDroid-V2 (MobiSys ’25), which reported prompt-length reductions near 50% and end-to-end latency reductions above 90% from exactly that pattern. Set-of-mark prompting comes from OmniParser and the papers before it.

What I’d claim as mine is the framing and the seams: perception as an always-on daemon rather than a callable; baselines relative to the observer’s last look; memory gated on settled frames; motion understood from the stream; and a written contract for when the daemon must stop and ask. None of those sentences mention iOS.

*The proving ground*

## Why the simulator was the right place to prove it

It is the hardest sandbox. There is no public input API, the capture path runs through private frameworks that change between Xcode versions, and the accessibility tree is a promise apps don’t always keep — in a real production app the custom tab bar published no children, icon buttons carried private-use glyphs, and React Native text inputs were absent from the tree entirely. If observer-relative perception with local memory works here, it works on a browser, a desktop, an Android emulator, or a game.

The daemon is built behind a platform boundary for that reason. Frames in, accessibility tree out, gestures in; everything above that line — history, settle, transitions, memory, graph, escalation — has never heard of `simctl`. An Android backend was the next proof, and I claimed it would be easier because every primitive it needs is a public API.

*The second platform*

## Mostly it proved the point, partly it embarrassed me

The claim to test was narrow: if perception is observer-relative and memory is local, none of it should know what platform it is on. So the test is not “does Android work” but **how much had to change above the boundary** — and the answer is nothing. `simframe ui` produced a full screen map of an Android emulator, elements with points and numbered refs and a structural identity, with no edit to the frame store, the settle detector, the hash, the fingerprint, the screen map, refs or the transition graph. Then a tap by label landed on it: `tapped "Notifications" at 138,207 (memory d=0, via ocr)` — on a platform with *no accessibility tree at all*.

What did have to change, twice, was a layer above the boundary quietly speaking the first platform’s language. Engine selection asked for the Swift daemon on every device, so starting capture on an emulator failed with a message about CoreSimulator. And `doctor`, asked about an emulator, reported *“input driver: idb”* — a claim about a tool that has never spoken to an Android device in its life. Both were invisible while there was one backend. That is what a second backend is really for: not the platform, the audit.

The prediction about public APIs was right and my guess about *which* ones was wrong. The plan said capture would be the emulator’s gRPC streaming endpoint with a scrcpy-style fallback. It isn’t: the emulator *console* — a plain TCP line protocol you can speak with a socket and no library — has a `screenrecord screenshot` command that makes the emulator write the PNG onto the host filesystem itself, with no device-to-host transfer at all. 41 ms, no dependency. Input is the same socket, and it puts a real down, move and up on the touch screen, which is how you get gestures with honest timing instead of teleporting taps. The clipboard, which I had written up as *impossible* because adb has no path to it, turned out to be one gRPC call — reachable with Node’s built-in `http2` in about forty lines, because a unary gRPC call is just an HTTP/2 POST with a five-byte header.

**Amended — I measured 41 ms four times before it was right**

It was published as 21 ms. The first measurement said 2,400 ms and was a real bug: my “is this PNG complete” check looked for the `IEND` marker four bytes from the end of the file, which is the checksum and never spells anything, so every frame silently fell through to the slow path. The second said 67 ms, almost all of it a poll interval waiting for a file that had already arrived.

The third said 21 ms and was not a measurement of a screenshot at all. The console emits an extra `OK` after authentication, so my script sent `quit` one response early, closed the socket while the emulator was still writing, and read the *previous* run’s file out of a shared directory. Five consecutive runs reporting byte-identical file sizes was the tell, and I explained it away as a static screen.

The lesson is not “be careful”. It is that a measurement must never be allowed to be the sum of one thing finishing and another thing not having started, and the only structural defence is to time the phases apart.

*The ladder, tested*

## What the accessibility tier is actually worth

Android has no accessibility tree — `uiautomator dump` costs two seconds a read, and making it fast means shipping an instrumentation app onto someone’s device, which is a different promise from shipping a package. So the perception ladder’s central bet got tested for real: does a missing tier degrade, or fail?

Measured on iOS, reading every screen twice from the same frame, once with the tree and once without:

- **Every interactive element came from the tree.** All 72 of 72. OCR and classical CV produce text, and nothing in that pipeline infers a button from a rectangle confidently enough to say so.
- **83% of those controls have no text at all.** They are icons. There is nothing for OCR to read even in principle.
- **And screen memory did not need the tree.** Every revisit was recognised either way, 6 of 6, with the weakest similarity barely moving.

That last line is the one I did not expect, and it splits the ladder cleanly: the accessibility tier earns its place in *acting*, not in *recognising*. Knowing where you are is a question about layout, which pixels answer. Knowing what a thing is and what it is called is a question about semantics, which pixels do not answer and a tree does.

Intent resolution went from 26 of 28 to 22 of 28 without it, and the shape of the failures matters more than the count. Two were refusals: the refresh button and the address field resolve to *nothing*, because they are icons and there is no text to match. The third was worse — asked for `Back`, the OCR-only reading returned `"B"`, the section-index letter sitting next to it. A refusal tells the caller to look again. A confident wrong answer taps the wrong thing, and there is no verdict, no diff and no graph that can rescue an action already taken. One in fourteen, on Apple’s own unusually well-labelled apps.

Android also found the sharpest version of a bug this project has now hit four times. Chrome’s address bar is chrome by every structural test there is — a short row at the top with a gap under it — so the URL went into the screen’s *identity*. A URL in a fingerprint does not degrade recognition, it inverts it: every visit to a new page mints a new screen, the memory fills with screens that will never recur, and every learned route through the browser breaks the moment the page changes. The rule now is that a label has to be a name before it can be an identity — two letters at minimum, and not an address.

*What three strangers agreed on*

## The bill for a confident wrong answer

Three agents drove this tool on real apps in one day, independently, and reported separately. They ranked their findings differently and disagreed about the tool’s strengths. On one thing they converged so exactly that it is worth treating as a result rather than as feedback.

Every one of them rated a *refusal* as cheap and a *confident wrong answer* as expensive — and each praised specific refusals by name. One kept a false refusal in the “good” column with a sentence that settles the trade for me: *“on a screen where Submit order sits 16 points from the field I wanted, I take a false refusal every time.”* Another put it as a taxonomy: the bugs that mattered were *“all in the ‘confidently wrong’ family rather than the ‘obviously broken’ family, which is the dangerous kind for an agent-facing tool.”* A third reduced it to a cost: *“the cost was not the wrong answer — it was that the wrong answer was confident.”*

What makes that more than a nice principle is what it found when applied as a search. Every serious bug in those three rounds was a component reporting more certainty than it had, and none of them looked broken:

- A `type` that landed nowhere returned **ok**. The verification existed — and read the accessibility tree, which on a web page carries no field contents at all, so it had never once run where it was needed.
- A screenshot request for readable small text **silently served a frame below the device’s own resolution**, because the full-resolution frame it wanted had been pruned and the fallback said nothing.
- A header read `84ms old` above an image whose clock was **five hours wrong**, because the state and the image are two separate writes and only one of them was fresh.
- A refusal said the screen had changed while printing two identical hashes — **eight characters of a seventy-two-character** perceptual hash, whose leading characters coincide by design.
- A crop that never happened was captioned as one that did, because the region arrived in a shape the parser did not read and the failure had no words.

Not one of those would fail a test, because each was a component answering the question it was asked and misreporting how well. The pattern is sharp enough to use as a design rule: **wherever a component can fail to know something, the interesting bug is not the failure — it is whether the failure is distinguishable from success in what it says.**

The same rule cuts the other way, and this is the part I did not expect. A warning that is usually wrong is worse than no warning. A half-loaded-list check fired on nearly every step of a list whose correct final state was 43 rows, because it compared them against a header promising 1,232 — and a total says nothing about how many rows belong on screen. The reporter’s verdict: *“by the fourth occurrence I was ignoring it, which is the failure mode you least want from a warning.”* Another watched a memory-disagreement warning fire ten times in a row on screens that were fine. Both were capped rather than tuned, because a threshold that cries wolf does not need a better threshold — it needs to know when it has nothing to say.

Which turns the thesis of this piece around by ninety degrees. The argument so far has been about *not* asking the model — keeping the eyes open, remembering what worked, deciding locally in milliseconds. All of that is only safe if the local tier is honest about its own certainty, because every deterministic answer it gives is an answer nobody is checking. One reporter said it better than my own architecture diagram does: **this tool’s value is in what it says about its own certainty, not in what it can do.**

*The takeaway*

## Three questions to ask your own architecture

If you are building an agent that acts on a screen:

- **Do the eyes ever close?** If perception is a function the model calls, they do — and you are paying the model to notice things a diff could notice.
- **Is “changed” relative to the observer’s last look, or to the previous frame?** If the latter, your agent is blind to every transition that finishes before it polls.
- **Can you write down, in a numbered list, the exact conditions under which the model must be consulted?** If not, the model is being consulted by default, and OSWorld-Human’s numbers are your bill.
- **For every component that can fail to know something — does its output distinguish “no” from “I could not tell”?** If a single sentence covers both, you will diagnose the wrong condition, and so will everyone reading your logs. It cost this project two consecutive misdiagnoses of the same red build.

I built simframe to test a fix faster. What I ended up with was a small argument about what an agent’s senses should be. The code is at [github.com/lvlrSajjad/simframe](https://github.com/lvlrSajjad/simframe); the phases, benchmarks and the private-API corrections are in `docs/`.

**On the numbers**
