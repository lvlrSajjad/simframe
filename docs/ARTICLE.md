# Agents shouldn't blink

*Perception as a daemon, not a function — and what happened when I built one for the iOS Simulator.*

> **Draft.** Numbers marked `[TBD]` are filled in from `docs/BENCHMARKS.md` as phases land. Everything else is measured on the released `simframe` or cited.

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

**Eyes** are a process that always holds the current frame. Nothing is captured on request. The screen is watched continuously, the newest frame is always available, and "look" is a read, not a wait. On the released simframe this turned a ~130 ms blocking screenshot into a ~20 ms file read; the rebuilt daemon reads the simulator's framebuffer directly and holds frames at `[TBD]` fps with `[TBD]` ms warm-frame latency.

**Hand** is whatever performs actions, but with the property a human hand has: it can act on an intent — "the Settings tab" — without the eyes re-reading the screen, because it remembers where that control was. In simframe this is the screen memory: every screen the agent has seen is keyed by a layout hash, and the map from label to tap coordinate is stored. First visit ~600 ms to build (accessibility tree plus on-device OCR); every visit after that ~1 ms. On a four-tab flow run three times back to back, wall time went 7370 → 5160 → 3304 ms as more controls resolved from memory instead of perception.

**Memory** is the part I found most people miss, and it splits in two.

*Visual memory* is the recent frames. Not one frame — the last minute of them. It is what lets the daemon answer "did anything change?" and "what moved?" as text, in about 2 ms, and it is what lets a transition be understood as motion rather than inferred from two stills.

*Procedural memory* — muscle memory, if you like — is the record of how screens connect: I was on screen A, I tapped this, I arrived at screen B. Once that graph exists, a flow the agent has completed once can be replayed with zero model calls, and an action's outcome can be *predicted* before it happens, which is what makes verification cheap.

## "Changed since when?"

The single idea I'd defend hardest is the one that looks smallest.

Every change question is really "changed *since when*?", and the natural answer — since the previous frame — is wrong for an agent. A UI transition is over in about 700 ms. An agent that acts and then polls a second later, comparing consecutive frames, sees a still screen and concludes nothing happened, even though the screen is completely different from when it last looked.

The baseline for "changed" has to be **the last frame the observer actually saw**. The daemon records what the agent looked at, and every subsequent state query is relative to that. Over MCP this is automatic; from the CLI you take a mark before acting. This is observer-relative perception, and it is the property that makes a continuously running sensor useful to an intermittently attending reasoner. Without it, a faster camera just gives you more frames to be confused by.

I learned the corollary the hard way during the rebuild. When the new daemon captured at 12 fps instead of the old 4, screen-memory hit rates got *worse* — 1–2 of 4 instead of 4 of 4 — with byte-identical hashing. More frames meant more mid-transition frames, more distinct layouts, more rebuilds. Correctness was preserved (a missed match rebuilds; it never mis-taps), but the lesson generalises: **memory must be keyed off settled observations, never arbitrary frames.** Frame rate and memory keying have to be decoupled, or a better sensor degrades the memory built on it. `[TBD: confirm with the 4 fps test and the settled-gate result]`

## Understanding motion instead of comparing stills

Once you hold a stream rather than a snapshot, the frame history becomes a signal in its own right.

Settled-state detection replaces `sleep()`: the daemon waits for a change and *then* for stillness, because a bare "wait until stable" called just before an animation begins returns immediately and uselessly. A small region changing every frame while the rest is still is a spinner, not a settled screen.

Transitions can be classified rather than guessed. A horizontal shift of the content with a nav-bar title crossfade is a push; the reverse is a pop; a vertical shift with stable chrome is a scroll, and phase correlation gives the exact offset. A region rising from the bottom with dimming behind it is a sheet; a centred rectangle with dimming is an alert; a change confined to the bottom 40% is the keyboard. These are FFT and region-diff operations on downscaled frames, a few milliseconds each. `[TBD: classifier accuracy and latency from Phase 4]`

And an action can be verified locally. Before acting, if the transition graph has an edge for this screen and this action, the daemon predicts the destination. After settling, it compares. The outcomes are a small closed set — `ok`, `no visible change`, `unexpected transition`, `unexpected screen` — and only the last two need a mind. A radio button that moves 0.1% of the screen used to burn a full timeout; now it returns in seconds marked as no visible change, and the agent knows to check rather than wait.

## Where the model belongs

None of this removes the model. It moves it.

The daemon's job is to answer, locally and fast, everything that has a local, fast answer: what's on screen, which element matches this intent, has the screen settled, did that action do what was predicted, have I been here before. Its job is *also* to know exactly when it cannot answer, and the rebuild formalises that as an escalation contract. The reasoner is consulted when:

1. the screen fingerprint has never been seen;
2. an intent matches no element confidently, or two elements too closely (ambiguity is reported, never guessed — silently tapping the wrong one looks exactly like nothing happening);
3. a verified action did not produce its predicted outcome;
4. an unfamiliar modal, alert or system dialog appears;
5. the goal spans multiple steps and no compiled flow or graph path covers it.

Everything else is acted on without a round trip. What the model receives when it *is* consulted is compact text — regions, numbered elements with role, label, state and source, the last action's verdict, any ambiguity — not an image. It can ask for the image; it rarely needs to. `[TBD: Phase 7 — model turns and image returns for a 10-step flow before/after]`

This is the part I think transfers furthest. Every agent framework has an implicit answer to "when does the agent need to think versus just act?" Almost none of them write it down. Writing it down is what makes the sensor and the reasoner separable.

## What's borrowed

A lot, and it's worth being precise. Reading the simulator's framebuffer through Apple's private `SimulatorKit` surface and injecting touches through its HID path is work that `baguette` and `testa` did first and documented; I followed them and hit different walls. `[TBD: note the corrections logged in PRIVATE_API.md]` On-device OCR is Apple's Vision framework. The accessibility tree is Apple's. The UI transition graph and the idea of compiling explored flows into scripts that run without a model come from AutoDroid (MobiCom '24) and AutoDroid-V2 (MobiSys '25), which reported prompt-length reductions near 50% and end-to-end latency reductions above 90% from exactly that pattern. Set-of-mark prompting comes from OmniParser and the papers before it.

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

*Appendix: measurements* `[TBD: paste the BENCHMARKS.md table — chip, Xcode, iOS, device, N, median — for capture latency, fps, a11y/OCR latency, memory hit rates per pass, transition-classifier accuracy, and model turns per flow.]`
