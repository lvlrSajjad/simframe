# simframe

[![ci](https://github.com/lvlrSajjad/simframe/actions/workflows/ci.yml/badge.svg)](https://github.com/lvlrSajjad/simframe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/simframe.svg)](https://www.npmjs.com/package/simframe)
[![license](https://img.shields.io/npm/l/simframe.svg)](./LICENSE)

**Eyes, hands and memory for an agent driving the iOS Simulator or an Android emulator.**

[Website](https://lvlrsajjad.github.io/simframe/) · [npm](https://www.npmjs.com/package/simframe)

An agent driving a simulator is slow for three reasons, and only the first
one is obvious:

1. **Every look is a wait.** `simctl io screenshot` costs ~130 ms of blocking
   latency, paid again on every glance — and paid twice whenever the agent
   captures mid-animation and has to look again.
2. **Every step is a round trip.** Tap, screenshot, reason, tap, screenshot. A
   twelve-step flow costs twelve model turns, and the model turns cost far more
   than the milliseconds.
3. **Nothing is remembered.** The same screen gets re-read and re-reasoned about
   every single time it appears.

And there is a fourth that is pure waste: **an image is the most expensive way
to ask what is on screen.** A screenshot costs ~1,600 tokens when it is handled
as a native image block and 15,000–25,000 when it is not, and it does not tell
you what is tappable or where — you have to measure that by eye.

simframe attacks all four: a background loop keeps the newest frame warm, whole
flows run in one call, screens the agent has seen before are answered from
memory, and every answer is text with tap points in it. Nothing returns an
image unless you ask for one.

### It is also a study case, and the numbers are the point

Almost everything here was decided by a measurement rather than by an argument,
and several of those measurements **reversed a decision that had already
shipped**. They are written down in full, with what we expected beforehand, what
it cost to find out, and the mistakes made getting there — because a benchmark
that only records the winner teaches nothing.

| | |
| --- | --- |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) | the record: N, median, p95, machine, every round |
| [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) | what we believed *before* measuring, and the fourteen times it was wrong |
| [`docs/DEFERRED.md`](docs/DEFERRED.md) | every known defect, open or closed, with the evidence |
| [`docs/ARTICLE.md`](docs/ARTICLE.md) | the argument the whole thing adds up to |

The headline results, all free to reuse:

- **A warm transition graph removes ~27% of an agent's model round trips** —
  isolated with a three-pass field experiment, and corroborated to three points
  by an independent estimate. Operator knowledge is worth twice that, and no
  tool here carries it yet. ([§14](docs/EXPERIMENTS.md))
- **A bigger local judge is not a better one.** `qwen3:14b` scored *lower* than
  `qwen3:8b` — 82% against 91% — while being 79% larger and 62% slower. A
  one-line threshold on a number already computed beat all of them at **95% and
  zero latency**.
- **Every interactive element came from the accessibility tree — 72 of 72 — and
  83% of them have no text at all.** Screen *recognition*, though, did not need
  the tree once. The ladder splits there: semantics need a tree, identity needs
  pixels.
- **Capture is ~31× faster than a screenshot** for the same work, and the
  capture primitive itself about a thousand times faster.
- **Three independent reporters converged on one thing**: a refusal is cheap and
  a confident wrong answer is expensive. Every serious bug they found was a
  component reporting more certainty than it had.

## What changed, measured

Same four-tab navigation flow, on a real production app:

| | Before | With simframe |
| --- | --- | --- |
| Look at the screen | ~130–400 ms, blocking | **~20 ms**, already captured |

| "Did anything change?" | a full image | **~2 ms**, text only |
| Finding a control | read tree (~570 ms) + reason | **~1 ms** from memory |
| A 4-step flow, verified | 4+ model round trips | **1 call**, 3.6 s |
| Same flow, 3rd run | no improvement — every run is the first | **3.7 s, 4/4 from memory, 4/4 verified** |
| A 10-step flow | 10 turns, 10 images (~16,000 tokens at best) | **1 turn, 0 images, ~1,650 characters** |
| Reading a screen | an image: ~1,600 tokens, no tap points | **~330 tokens** of text, with tap points |

Every figure above is the cost inside a live process — the MCP server, or the
daemon answering a socket — which is how an agent actually uses simframe. A
one-shot `simframe` command from a shell pays about 200 ms of Node startup on
top, and a frame sitting on an idle screen can be older than 20 ms because the
capture loop throttles when nothing moves. `~20 ms` is the read, not the
process.

The four-tab tour, three times back to back from a cleared memory:

| Pass | Wall clock | Steps verified | Controls from memory |
| --- | --- | --- | --- |
| 1 | 10.2 s | 0/4 — nothing is known yet | **4/4** |
| 2 | **3.6 s** | **4/4** | **4/4** |
| 3 | **3.7 s** | **4/4** | **4/4** |

Every step is checked against what the same action did last time, and the run
records its own preconditions — which input path, which daemon, whether the
daemon was replaced mid-run — so a regression shows up in the measurement rather
than hiding inside it. Earlier versions of this table quoted 7.4 s → 3.3 s with
verification switched off; those numbers were measured while input was silently
falling back to a slower path and the capture daemon was being replaced by every
command, so they measured two bugs rather than the tool.

## Install

```bash
npm install -g simframe
simframe doctor
```

**Whichever of those two commands you run first** builds a small Swift daemon
from source — including `doctor`, which is why a cold `doctor` takes around 15
seconds and every later one takes two. It needs the Xcode command line tools,
which you already have if you have a simulator. Without them simframe falls
back to the original `simctl` loop and says so.

If more than one simulator is booted, name the one you mean — `--device=<udid>`,
or `export SIMFRAME_DEVICE=<udid>` once per shell. simframe refuses to choose
for you, because the first booted device is nobody's idea of "yours" and the
command that would act on it is a tap.

`doctor` checks each capability separately and tells you what you have:

```
ok   xcrun              xcrun version 72.
ok   sips               available
ok   input driver      simframed: Indigo HID
ok   accessibility tree simframed: AXPTranslator, host-side
ok   on-device OCR      available
ok   booted simulator   iPhone 17 Pro (iOS 26.5)
ok   capture            frame #888 322x700 in 2ms (age 538ms)
ok   sensor mode        full — accessibility and OCR fused on every read (~164ms)
ok   local supervisor   none — not requested (SIMFRAME_SUPERVISOR is unset)
ok   local planner      none — not requested (SIMFRAME_PLANNER is unset)
```

The last three are experiments and `none` is their normal answer. See
[Local tiers, off by default](#local-tiers-off-by-default).

### Claude Code

```bash
claude mcp add --scope user simframe -- npx -y simframe mcp
```

`--scope user` makes it available in every session; without it the server is
registered only for the directory you ran the command in.

### Any other MCP client

```json
{
  "mcpServers": {
    "simframe": { "command": "npx", "args": ["-y", "simframe", "mcp"] }
  }
}
```

## Recovering without a round trip

The measured cost of driving an app is not perception — warm, an
accessibility-only read is 85 ms and a fused read 142 ms. It is **round trips**:
in one instrumented run, 75% of the wall time was the agent thinking and the
call boundary, not simframe working. So the tools that matter most are the ones
that let a batch survive a problem instead of handing it back.

**Fallback selectors.** `{"tap": "Save", "or": ["Done", "Confirm"]}` — tried
locally in order, only an exhausted list reaching the model. Eligible after a
selector that did not *resolve* and nothing else, because retrying from a screen
you did not expect to be on is a second guess. A destructive-looking label is
refused as a substitute even if you list it.

**Steps that may legitimately have nothing to act on.** `{"tap": "Not Now",
"optional": true}` is skipped when nothing matches and runs normally when
something does. It exists because the opposite cost real time: a batch that
included a dismissal for a first-launch sheet lost **six correct steps** on the
next run because the sheet *did not appear*. A nag screen, a permission prompt,
a "What's New" or a cold-start splash otherwise makes a flow unbatchable, which
is the expensive outcome — a call per step instead of a call per flow. Only a
selector that resolved to **nothing** is absorbed: a target that is on screen
twice is ambiguous, not absent, and must still verify. Skipped steps are
reported, because "the sheet was gone" and "the sheet was dismissed" are
different facts.

**`{"seek": "change username", "budget": 6}`** opens containers, checks, and
comes back, depth first, inside a hard budget. It **acts** — opening a door
changes state — and it refuses to open anything that commits, abandons or
answers. It does not tap the target; it leaves you on the screen where the target
resolves.

**`{"sweep": "all", "fill": {…}}`** reads a long screen a viewport at a time and
fills each field while it is on screen. A form taller than the screen is only
knowable in pieces — the tree publishes what is rendered — and one scroll gesture
travels a non-deterministic distance, so finding a field and scrolling back to it
does not work. Sweeping does: on a real web form it filled every field in one
call. It detects both ends by measuring how far the *content* moved, ignoring
fixed chrome, which is the only reliable signal available since nothing reports a
scroll offset.

**`worked here before:`** puts the graph's own vocabulary in the map, most-used
first, rather than reporting a count. When the remembered controls are *not* on
the screen it says so instead, because that means two screens share one
fingerprint — and confident advice on a misidentified screen is how a remembered
label ends up pointing at a submit button.

## Local tiers, off by default

Two on-device model experiments, both `none` unless asked for, both degrading to
the existing matcher-then-model ladder, and CI runs with both off. They ship no
weights: Apple's Foundation Models framework has nothing to download, which is
the whole reason it clears this project's non-goal on shipping model weights.

| flag | what it does |
|---|---|
| `--sensor=ax-first` | read the accessibility tree alone (~50 ms) and pay for OCR only when a resolve fails |
| `--planner=apple` | order the containers `seek` opens; it cannot choose an action |
| `--supervisor=apple` | when a step fails, answer `wait`, `retry` or `stop` — nothing else — before the failure reaches the model |

All three are also per-call arguments on every MCP tool, because an MCP server's
environment is fixed when it spawns and comparing two modes inside one session
was otherwise impossible.

**What is measured and what is not.** The ranker: 5 of 6 top-1 on hand-written
cases, median 564 ms warm, and on a real exploration it went to the right region
in two steps where reading order wandered into version strings. `ax-first` made
no measurable difference to how an agent drove a real app, with one small
regression and one small win.

**The supervisor, on 22 labelled failures from a seeded React Native app** —
and the number to judge it by is round trips, not accuracy:

| | |
|---|---|
| handled locally, no round trip | **9 of 22** |
| escalated to Claude | 13 of 22 |
| a model round trip, measured in the field | 10–16 s |

So roughly 90–145 s saved on that population. Accuracy was 77 / 82 / 86% across
three runs of the *same* questions — it is **not deterministic**, and every
earlier single-run figure in this project carried that spread without reporting
it. All of its errors were `wait` where `stop` was right, which is the cheap
direction: a wrong `wait` costs a settle and a re-run, and `stop` already means
"hand back to Claude with the unattempted steps" rather than "give up".

**Still a bench, not the field.** These are fixtures we designed, on a testbed we
built, labelled by the person who then scored them. Numbers and conditions are in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md); the judgements, including a phase
cancelled by its own measurement, are in [`docs/DECISIONS.md`](docs/DECISIONS.md).

**And the measurements that changed our minds** are in
[`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md), with what we expected beforehand
written down beside each — including the capacity comparison the supervisor
design was assumed to make unnecessary. Asked the same 22 situations, three
times each:

| arm | accuracy | median | deterministic |
|---|---|---|---|
| always the commonest answer | 55% | — | — |
| **`stillMs > 3000ms`, no model at all** | **95%** | **0 ms** | yes |
| Apple Foundation Models (~3B, on-device) | 77 / 82 / 86% | ~640 ms | **no** |
| `qwen3:8b` via Ollama (4-bit, 5.2 GB) | **91%** | 919 ms | yes |
| `qwen3:14b` via Ollama (4-bit, 9.3 GB) | 82% | 1,489 ms | yes |

Three results, and the third is the one that matters. The larger model scored
*lower* than the smaller one. A free threshold on a number the daemon already
computes beat all three, on a population it was never fitted to. And **the
accuracy ranking inverts the safety ranking**: every arm errs in one direction
only, Apple's errors are all `wait` where `stop` was right and both Qwen arms'
are all `stop` where `wait` was right — and a wrong `stop` abandons a plan that
would have worked, while a wrong `wait` costs a settle. A comparison reporting
only the percentages would have recommended the wrong model.

The Ollama arm is an **experiment, not a recommendation**: off unless named,
no weights shipped, no dependency added, and every arm reads the same briefing
out of `native/supervise.swift` so no arm is answering a different question.

**Two further results, both negative, both worth more than the table.** A
*cascade* — free rule first, model where it is unsure, Claude after that — was
worse at every abstention band we tried (95% for the rule alone; 91%, 86%, 82%
as more was handed to the model). And giving the model a fourth word, `abstain`,
cost the Apple arm about a third of its accuracy (77/82/86% → 45/50/55%) **while
it never used the word once**. One added paragraph, nothing else changed. So the
fourth word ships off, and "add an abstain token" became "find a judge that will
use one".

The supervisor's whole vocabulary is three words on purpose. It cannot invent a
step, skip one, substitute a target or continue past an unexpected screen — not
because a threshold forbids it but because those are not answers it can give.
That constraint replaced an earlier version of the same idea that was given
latitude over *what* to open and pressed a button labelled "YES, THIS FIXED MY
PROBLEM" in a live app.

## Capabilities are independent

Each layer works without the ones above it, and `doctor` tells you which you
have. **Observation needs nothing but Xcode.**

| Capability | Needs | Without it |
| --- | --- | --- |
| Watch the screen, wait, recall | nothing extra | — |
| Read labels + coordinates from pixels | `swiftc` (Xcode CLT) | falls back to the accessibility tree alone |
| Tap, type, swipe | nothing extra | simframe observes but cannot touch |
| Accessibility tree | nothing extra | OCR alone still yields labels and coordinates |

`simframe doctor` names which engine is carrying each capability, per device.
**Nothing beyond Xcode is required.** Capture, input, text recognition and the
accessibility tree all run in-process, in one daemon.

[`idb`](https://fbidb.io) is still accepted as a fallback for input and for the
tree, for a machine where the daemon cannot run — and `SIMFRAME_AX_DRIVER=idb`
forces the tree back onto it, which is the escape hatch if an Xcode upgrade
breaks the host-side path.

```bash
# optional fallback, not a requirement
brew tap facebook/fb && brew install idb-companion && pipx install fb-idb
```

## Android

simframe's second backend drives an Android emulator with the same commands, the
same screen map and the same memory as a simulator. Everything above the
platform boundary — the frame store, settle, the structural fingerprint, the
screen map, refs and the transition graph — runs on it unmodified, because the
boundary hands it frames and nothing above it knows what a simulator is.

| Capability | Android | How |
| --- | --- | --- |
| Watch the screen, wait, recall | yes | frames at **41 ms** through the emulator console, host-side — no adb in the capture path |
| Read labels + coordinates from pixels | yes | the same Vision OCR + CV, off the same PNG |
| Screen map, refs, screen memory, the graph | yes | unchanged above the boundary |
| Tap, type, swipe, keys | yes | the console's `event mouse` as a real down/move/up, `event text` for characters, `input keyevent` for keys |
| Clipboard, and `paste` into a field | yes | the emulator's gRPC `setClipboard`, over `node:http2`, no dependency, then `KEYCODE_PASTE` to deliver it |
| List/resolve devices, launch, terminate, open a URL, permissions | yes | `adb`, with the permission state read back off the device |
| Accessibility tree | **not available (OCR + CV only)** | `uiautomator dump` costs **2,012 ms** a read, against 45 ms for the iOS tree. See [`docs/DEFERRED.md`](docs/DEFERRED.md) |
| A launch confirmed to have reached the front | **not available (the launch is not checked)** | iOS compares the pid `simctl launch` printed against the pid the device reports as frontmost, in **2–5 ms**. Nothing here reports either; `am start` fronts synchronously, which is why it has not bitten — but that is not a check. See [`docs/DEFERRED.md`](docs/DEFERRED.md) |

```bash
# an emulator is found the same way a simulator is
simframe devices          # ● Small_Phone_API_36  Android 16 (API 36)  emulator-5554
simframe ui --device=emulator-5554
simframe do --device=emulator-5554 flow.json
```

A host with a booted simulator **and** a booted emulator has no default, and
simframe will not pick one for you: preferring iOS because it came first would
tap a simulator while you were driving an emulator, and acting on the wrong
device is worse than refusing. So a command with no device names both and stops.
`--device` answers it per command; `SIMFRAME_DEVICE` answers it per shell:

```bash
export SIMFRAME_DEVICE=emulator-5554
simframe ui               # the emulator, without saying so every time
```

The tree is a deliberate omission, not an oversight. Making it fast needs a
resident instrumentation APK on the device — the shape uiautomator2, Maestro and
Appium all converged on — and that would be simframe's first runtime artifact
installed onto your device. The perception ladder was built so a missing tier
degrades rather than fails, and this is exactly that case: OCR and CV yield
labels and coordinates on Android today, and a tap by label works without a tree
at all. `simframe doctor` reports the tier as `optional` with that number, so
the gap is visible rather than silent, and the criteria for revisiting it are in
`docs/DEFERRED.md` under **Phase 8b**.

**What the missing tree costs, measured rather than hand-waved.** Screen
*identity* is weaker on Android than on iOS, and specifically so. Tokens per
screen, and where they come from:

| Screen | Tokens | Regions | Roles | Chrome labels |
| --- | --- | --- | --- | --- |
| launcher | **1** | nav-bar 1 | text 1 | 0 |
| Settings root | 9 | content 9 | text 9 | 0 |
| example.com in Chrome | 6 | content 3, nav-bar 3 | text 6 | 0 |

Every token has role `text`, because without a tree nothing infers a button from
a rectangle reliably enough to say so, and no screen here carries a chrome label
at all. So on Android a screen is recognised by the geometry of its text, which
is thinner and noisier than the iOS mix of roles, chrome labels and geometry.
Flows still work; screen *memory* is doing more guessing, and that is the honest
cost of the tier being absent.

It is also why the obvious fix for the iOS drift — dropping content-region text
out of identity, which would be a strict improvement there — is not available:
it would leave Settings' root with zero tokens, and zero tokens is no identity
at all. See [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

That last column read **3** before this measurement changed it. Chrome's address
bar is chrome by every structural test there is, so the screen's identity
contained `"== example.com"` — a URL, meaning the same browser on a different
page was a different screen and every learned route through it broke on
navigation — plus `":"` and `"+"`, which are OCR reading punctuation off icons.
A chrome label now has to be a name: two letters at minimum, and not an
address.

The emulator's own gRPC surface was checked for anything tree-shaped and has
nothing: 43 RPCs for sensors, input, screenshots and VM state, and no notion of
a view. That question is settled, not open. The same surface is what carries the
clipboard.

## The tools

Read first, act in batches, and look at pixels only when the question is about
pixels. Every tool description says so, because a tool surface that does not
steer the model is a tool surface the model uses wrong.

| Tool | What it does |
| --- | --- |
| `sim_ui` | **Start here.** The screen as a numbered text map: region, type, label, state, tap point, source. A tenth the cost of a screenshot and strictly more useful. |
| `sim_do` | **The main tool.** A whole flow in one call — tap, type, scroll, wait, assert — each step settling before the next and verified against what it did last time. |
| `sim_state` | The cheapest question there is: has anything changed **since your last look**, and which regions moved. |
| `sim_goto` | Walk to a screen simframe has been to before, planning the route through remembered transitions. |
| `sim_flow_run` | Replay a saved flow — **zero model calls**, which is the only path to human wall clock. A first traversal saves as *provisional*; one replay in which every step passed confirms it. A run with a contradicted step, a failed step, or one that never reached its last step is refused and says which. |
| `sim_find` | Resolve an intent to one control, without acting on it. |
| `sim_tap` · `sim_type_into` · `sim_scroll_to` · `sim_wait_for` · `sim_assert` | Single actions, for when you genuinely only have one step. Each is one `sim_do` step underneath. |
| `sim_launch` · `sim_open_url` · `sim_permission` | Launch with arguments and environment; open a deep link; grant a privacy permission instead of tapping a system alert. A launch is **confirmed to have reached the front**, by comparing the pid `simctl` started against the pid the device reports as frontmost — so *"the process started"* is no longer reported as *"the app is on screen"*. |
| `sim_wait` | Waits for the screen to change *and then* settle. |
| `sim_look` | **The only tool that returns an image**, capped at 1024 px. For layout, colour, spacing — questions text cannot answer. |
| `sim_recall` · `sim_strip` | Look backwards: a text timeline of what happened, or recent frames tiled into one image. |
| `sim_storage` | **What the app believes**, as opposed to what it drew: its `UserDefaults` and, for React Native, its `AsyncStorage`. Reads the data container off disk, so it answers on a device that is **not running**. |
| `sim_capture` · `sim_devices` | Manage capture loops; list simulators. |

### What the screen looks like as text

```
iPhone 17 Pro · 402x874pt · screen a1b2c3d4 "Inbox" (known, 3 known exits)
last action: [2] tap — ok: matches the outcome seen 5x before
nav-bar:
  #1 button    24,64      Back
  #2 text      201,64     Inbox
content:
  #3 cell      201,140    Weekly digest
  #4 field     201,196    Search = weekly ~ weekly|
  #5 switch    201,252    Notifications = 1
tab-bar:
  #6 text      62,835     Inbox
  #7 text      201,835    Settings
```

Region first, because "Inbox" the title and "Inbox" the tab differ only by where
they are. A tap point, because that is what an action needs. And a number, which
is a selector: whatever this calls `#3`, the next call can tap as `#3` without
describing it. A ref is valid only while that screen is showing — used on a
different screen it refuses rather than tapping whatever now sits there.

`= something` is what the control *contains*, from the accessibility tree, and
`~ something` is what OCR read off the pixels. Both are printed, and where they
disagree that is the point: one is authoritative and the other is what is
actually on screen, and a field mid-edit can legitimately differ. A row with no
`=` is a control that reports no value, not an empty one.

When the elements were recalled from screen memory rather than looked at just
now, the header says so and how long ago — `elements recalled from 41s ago —
pass refresh for what is there now`. Identity is cached on purpose, because a
list with new rows is the same screen; contents are exactly what changes without
the screen changing, so the age is worth seeing.

Three ways to name a control, anywhere one is named:

| | |
| --- | --- |
| `"Save"` · `the Assets tab` · `back` | **start here** — resolved by intent: verbs, typos, synonyms, icon-only controls by their common name |
| `#3` | the number the map gave it. Cheap and exact, but only within the round trip that numbered it |
| `@120,400` | raw point coordinates. Last resort: it cannot tell you it missed. |

The order is deliberate and it used to be the other way round. Four peer rounds
reported that intent resolution worked every time while refs renumbered
underneath them, so a table that led with `#3` and called it "unambiguous" was
recommending the more brittle of the two.

## Baselines: the thing to understand

Every change question is really "changed **since when**?" — and the answer is
almost never "since the previous frame". A UI transition is over in about 700 ms,
so comparing consecutive frames tells a caller that polls every few seconds
"nothing changed", even though the screen is completely different from when it
last looked.

So simframe compares against **the last frame you observed**. Over MCP that is
automatic. From the CLI, capture a baseline before you act:

```bash
H=$(simframe mark)
# ...tap, launch, navigate...
simframe wait --since=$H     # change, then settle
simframe state --since=$H    # what moved, as text
```

The same applies to waiting. `--mode=settle` (the default) waits for a change and
*then* for stillness, because a bare "wait until stable" called in the moment
before an animation starts will correctly, and uselessly, return immediately.

## Screen memory

An accessibility tree is a promise apps do not always keep. In testing against a
real production app, its custom tab bar published **no children at all**, its
icon buttons carried unreadable private-use glyphs, and its React Native text
inputs were **absent from the tree entirely** — the controls used most were
exactly the ones that could not be tapped by name.

So simframe reads the screen two ways and remembers the result:

- **Accessibility** gives real hit targets, types and enabled state.
- **On-device OCR** (Apple's Vision, ~290 ms, no model round trip) gives every
  label a person can actually see, with coordinates.
- The merge is keyed by a **structural fingerprint**, so the next visit is a
  file read. What that fingerprint is, and why it is not a pixel hash, is below.

```
first visit to a screen   ~1000 ms   read tree + OCR, store the map
every visit after that       ~1 ms   look it up
```

OCR is also more accurate than measuring by eye. On one tab bar the first tab
centre sat at x=62, not the x=40 an even five-way split predicts — a silent
mis-tap on every attempt.

Two details that matter:

- **Containers do not absorb their contents.** A tab bar encloses all five tab
  labels but is not any of them, so the merge only combines an element with text
  of comparable size.
- **Ambiguity is reported, not guessed.** A word that is both a screen title and
  a tab returns an error listing both with coordinates, because silently tapping
  the title looks exactly like nothing happening.

### Two hashes, because there are two questions

"Did this move?" and "is this the same screen?" look like one question and are
not. simframe answers them separately, and getting that wrong was the single
most expensive mistake in its development.

**Change and settle** are questions about pixels, so a pixel hash answers them.
The frame hash changes whenever any pixel group changes — a clock digit, one new
row — which is exactly right for "did anything happen?" and useless as a key for
"have I been here before?". For change detection there is a layout hash: status
bar cropped, difference hash over a 12×24 grid.

A mean-threshold hash was tried first and was actively dangerous: low-contrast
screens collapsed onto identical values, so unrelated screens matched at distance
0 and taps landed on the wrong control. The difference hash fixed that.

**Identity is not a question about pixels**, and this is the part that took three
attempts. Content *is* pixels: a list whose rows changed drifts as far as a
different screen does. Measured on a real app, same-screen revisits reached 62
bits against a different-screen floor of 74 — overlapping, with no threshold
available to choose. An earlier calibration had suggested a comfortable margin
(0–4 against 77–113), but it was measured on screens whose content happened to be
stable and did not survive contact with a real list.

So identity is **structural**. The fingerprint is built from element roles,
frames quantised to a 24 px grid, the region each element sits in, and repeated
siblings bucketed as "one" or "many" rather than counted. Deliberately included:
the labels of chrome elements only — nav title, tab labels, toolbar buttons —
because two list screens with identical structure are told apart by their title
and nothing else. Deliberately excluded: all content text and values, the status
bar, and the keyboard region when a keyboard is up.

It does not depend on the accessibility tree. Fingerprinting from OCR boxes
alone, with the tree discarded entirely, still separates screens — different
screens ceiling 0.35 against the same threshold.

| | Jaccard similarity |
| --- | --- |
| Same screen, revisited | 0.41–1.00 |
| **Different screens** | **0.00–0.31** |

The threshold sits in that gap, but the gap is narrower than anyone would want,
and one screen causes it: a screen whose sections load from different sources has
more than one genuine settled structure, and two structures of one screen are as
far apart as two different screens.

No threshold can express that, so a screen may hold **several** accepted
fingerprints instead. A new one is admitted only when a known edge lands
somewhere its target does not recognise — the edge is the evidence that it is the
same place — and only if no other stored screen claims that reading. Identity
stays exact rather than being loosened, and the count is capped, so a
non-deterministic action shows up as a node collecting variants rather than as
screens silently merging.

It earns its place on real apps: an app reconnecting to its bundler put an alert
over one screen, and that screen gained a variant instead of a duplicate
appearing.

Failing to recognise a screen you have seen is harmless — it rebuilds the map and
taps correctly. Matching the *wrong* screen taps the wrong control. The threshold
is set to err toward the first.

## Navigating by memory

Once simframe knows which screens exist and which action leads from one to the
next, getting somewhere is a search over known edges rather than a question for a
model:

```bash
simframe screens              # what this device has learned
simframe goto invoices        # walk there, verifying every step
```

And when the screen and the behaviour disagree, the question is usually not
about the screen at all:

```bash
simframe storage                          # apps with a data container
simframe storage com.example.myapp        # what that app saved
```

`sim_ui` says what is drawn; `sim_storage` says what the app believes. It reads
the data container straight off the host filesystem, which means it works on a
device that is **shut down** — `simctl` cannot do this at all, on any of its own
paths, once a device stops running.


Measured on a four-tab tour, `goto` plans and walks three-step routes with every
step verified and no model call. It fails rather than guesses: an unknown
destination, a query matching two screens equally, or no path of known edges all
report themselves instead of tapping hopefully.

Flows work the same way and refuse to save if any step went unverified —
replaying a recording of something that may not have worked just reproduces the
doubt.

```bash
simframe flow save checkout ./checkout.json
simframe flow run checkout
```

### What the memory is worth, isolated

Three agent sessions drove the same task family on the same production app. The
third existed only to hold a variable still: pass 2 beat pass 1 by twenty-one
model round trips, but it had a warm graph *and* an operator who had already
driven the app once, so the gap could belong to either.

| pass | operator | graph | round trips |
| --- | --- | --- | --- |
| 1 | fresh | cold | **33** |
| 3 | fresh | **warm** | **24** |
| 2 | experienced | warm | **12** |

**The graph is worth ~27%** of the round trips. Operator knowledge is worth the
rest — half of everything left after the graph had taken its share. A second
reporter, unable to isolate the graph, derived **~23%** from escalation rate per
step without knowing that number.

One app, one operator per pass, and round trips are not seconds. What it settles
is the direction: the memory is real, it is the smaller half, and the larger half
is what an operator learns and no tool here carries between sessions yet. Full
working in [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md) §14.

## Does this work on *your* app?

Nothing in simframe is written for a particular app. What varies between apps is
how much of the accessibility tree exists, and simframe is built to degrade
rather than fail:

- **Good tree** → tap by label, batch aggressively, everything just works.
- **Partial tree** (custom tab bars, icon buttons) → OCR fills the gaps; you tap
  by the visible text instead.
- **No tree at all** → OCR alone still yields labels and coordinates.

Run `simframe ui` on any screen to see exactly what simframe can see, with each
target marked `ax` or `ocr`. If something you can read is not listed, that is a
bug worth reporting.

A control the app **declares but never names** — an icon-only overflow menu, a
back chevron — is listed with its coordinates and tappable by `#ref` rather than
by name, and the map counts how many such controls are on the screen. A view the
app never declared accessible at all is invisible to any accessibility tree, ours
included, and the same line says so: a count of zero on a screen that has one
would be the more expensive answer.

**What a settle can and cannot see.** Stillness is decided from a mean over a
grid of the frame, and a small animation does not move a mean. Measured on a
screen built to never settle — a spinner, frames every 77–95 ms — the mean
difference was **0.00196** against a 0.004 threshold while one cell moved by
**0.0275**, and `stableForMs` reported **79 seconds** of stillness. So a settle
can return satisfied while part of the screen is still moving, and it now says
so: `settled after 63ms (a 13x13 region is still animating)`. A settle that
times out names where the movement is instead. Refusing to settle on any
animation would be right for a spinner and wrong for a blinking cursor, so the
disagreement is reported rather than resolved by a guessed threshold.

Two honest caveats. OCR reads **text**, so a purely graphical icon with no label
is invisible to both paths — the tree still gives you its coordinates, and
`#ref` still taps it. And the confirm-button vocabulary (`APPLY`, `OK`, `SAVE`,
`DONE`…) is English; a localised UI needs those words extended.

## Measured

iPhone 17 Pro, iOS 26.5, Apple Silicon, default settings.

| | |
| --- | --- |
| Frame capture, whole pipeline | **6.6 ms** |
| Frame grab alone | **0.13 ms** |
| The `simctl` + `sips` path it replaces | ~210 ms |
| Warm frame read (`sim_look`) | ~20 ms |
| State check (`sim_state`) | ~2 ms |
| Input round trip (`ping`) | **0 ms** |
| Tap (70 ms hold / 10 ms hold) | 76 ms / 13 ms |
| Text recognition, in-process | **~174 ms** |
| Text recognition, via PNG + helper (fallback) | ~555 ms |
| Accessibility tree read, in-process | **~45 ms** |
| Accessibility tree read, via idb (fallback) | ~203 ms |
| Screen map: first visit / remembered | ~305 ms / **~1 ms** |
| CPU | 1.1 % idle · 3.1 % active |
| Frame memory | ~60 s of screen, ~2.7 MB |

Reproduce all of it with `npm run bench`, which prints the same table against
your machine. Full detail, including the measurement traps, is in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

### Wall clock per step — where the time really goes

Every number above is microscopic next to the one that decides how fast this
feels, and it took two field reports to see it. Per-step wall clock is

```
(model round trip + simframe work × n) / n        for n steps in one call
```

**Compare like with like, which this table used not to.** A human tester's
1.95 s per step is the *whole* loop — look at the screen, decide what to do,
do it. Any row that does not include a decision is not comparable to it.

| | perceives | decides | acts | per step |
| --- | --- | --- | --- | --- |
| **a human tester, measured** | yes | yes | yes | **1.95 s** |
| **simframe, batch of 2 — the recorded median** | yes | yes | yes | **~11.7 s** |
| simframe, batch of 4 | yes | yes | yes | ~6.7 s |
| simframe, one model call per step | yes | yes | yes | ~21.7 s |
| — simframe's mechanical half alone | yes | **no** | yes | ~1.7 s |
| — a saved flow replayed | yes | **no** | yes | 1.98 s |

**The only like-for-like comparison is 1.95 s against ~11.7 s: about six times
a human**, and about eleven times when a failure forces one model call per step.

The two indented rows are the ones this README used to lead with, and both are
category errors when set against 1.95 s. The 1.7 s is simframe with the thinking
taken out — the thinking is the model round trip, which is most of the clock.
And a replay *decides nothing*: it is a recording being played back, so its fair
counterpart is a human repeating a flow they have memorised, who would be well
under 1.95 s. Replay against a human working something out for the first time is
a rehearsal measured against a first attempt.

What the two rows do establish, and it is the finding that reordered this
project: **there is nothing left to win inside the engine.** 1.7 s is small
beside a 20 s round trip, so making perception or input faster buys single-digit
percentages. The only variable that matters is `n` — how many steps one decision
covers. Every improvement here has come from raising it, not from faster code.

### One more term: the launch is a fixed cost

Measured on the benchmark suite with **no model in the loop at all**:

| route | steps | agent | per step | human | per step |
| --- | --- | --- | --- | --- | --- |
| contacts-kate-bell | 2 | 12419 ms | **6.2 s** | 4300 ms | 2.15 s |
| settings-larger-text | 4 | 15281 ms | 3.8 s | 7799 ms | 1.95 s |

2.9× a human on the short route with nothing thinking, which does not fit
`1.7s × n`. A cold app launch is a **one-off cost amortised over the route**:

```
per step = (model round trip + launch cost + ~1.7s × n) / n
```

That reconciles a 7-step replay at 1.82 s/step with a 2-step route at 6.2 s/step
— one launch spread over 7 steps or over 2. **The `~1.7 s` figure is warm taps
inside a batch**, and short routes are materially worse than the table above
implies on its own.

`step_ratio` was **1** throughout: when a run completed it took exactly the
minimum number of steps.
A field report put the split at **34% simframe, 60% agent round trips** over
462 s of wall clock — the tester's *"30+ seconds between each step"* was
accurate and was not simframe. So there is nothing left to win inside the
engine, and the only variable is `n`: `simframe hpi` reports `steps_per_call`
for exactly that reason.

Which is why **every hard-fail that drops a caller back to single-stepping is a
latency bug**. Between two field reports on the same flow, one run took 33 tool
calls and the next took **16**, for 28 executed steps and no screenshots at
all — the difference being defects fixed, not code made faster.

## How it works

```
┌─── simframed — one Swift daemon per simulator ──────────────────────────────┐
│                                                                             │
│   display damage callback ──► read IOSurface ──► scale ──► hash             │
│        the screen tells us          0.13 ms      6.6 ms total               │
│                                          │                                  │
│   Vision OCR reads the same surface ─────┤   no PNG, no file, no spawn      │
│                                          │                                  │
│   Indigo HID ◄── control socket ◄────────┤   0600, one JSON object per line │
│   taps, swipes, text                     │                                  │
│                                          ▼                                  │
│                        ~/.simframe/<udid>/  frames · state.json · meta.json │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │  a rename is atomic
┌────────────────────────────────────▼────────────────────────────────────────┐
│   MCP server / CLI: stat + read, or one socket round trip for input.        │
│   Screen memory: layout hash ──► label → point, built once per screen.      │
└─────────────────────────────────────────────────────────────────────────────┘
```

The daemon links CoreSimulator and SimulatorKit, which are private frameworks
with no documentation and no stability promise. Everything it calls is recorded
in [`docs/PRIVATE_API.md`](docs/PRIVATE_API.md) with the evidence behind it, so
an Xcode upgrade that moves something is a bounded fix rather than an
archaeology project. If a layer breaks, simframe degrades to the layer below
and `doctor` says which.

Run `simframe start --engine=screenshot` to use the one-frame-at-a-time loop
instead — it is also the only capture engine on Android, where it reaches the
emulator console rather than any simulator tool. `--engine=simctl` is still
accepted as the name that loop used to have.

- **Files are the IPC for reads.** The daemon renames completed frames into
  place; readers just read them. A rename is atomic, so a reader can never see a
  half-written frame. Input is the one thing that needs a reply, and it goes
  over a `0600` Unix socket — the file system is the whole permission model.
- **Almost no dependencies.** The only runtime npm dependency is the MCP SDK.
  The daemon is Swift built from source against frameworks already on the
  machine.
- **The screen says when it changed.** The capture loop is driven by the
  display's damage callback rather than a timer, so an idle screen costs
  nothing and a moving one is picked up at once.
- **It backs off when nothing happens.** 4 fps while the screen moves, 1.5 fps
  once still, snapping back instantly on change.
- **One writer per device.** Ownership lives in `meta.json`; `stop` refuses to
  kill a loop another client is using unless forced.
- **A wedged capture loop never looks like a calm screen.** Every answer carries
  a liveness check, and `wait` fails loudly rather than quietly timing out.
- **An action with no visible effect is reported, not waited out.** Selecting a
  radio button moves ~0.1 % of the screen — below the change threshold — which
  used to burn the full timeout. Now the step returns in ~3 s marked
  `[no visible change]`, so you know to check rather than wait.
- **And a gesture aimed at a coordinate says what it landed on.** A tap or swipe
  that changed nothing prints the element covering its start point, because a
  gesture goes to whatever is on top there:

  ```
  swiped 83,141 -> 83,800 [no visible change]
    [the swipe start point 83,141 is inside "Settings" (nav-bar)]
  ```

  Reported from the field as fifteen minutes lost to six identical swipes that
  a support banner was swallowing — a banner that was *in the element list the
  same call printed*. Nothing said "there is something at y≈753 and you started
  at y=750".
- **A control half off the edge is offered, clamped, and says so.** A filter
  chip with 29 pt of itself visible used to be dropped — the off-screen test
  reads the *centre* — and OCR's reading of that same sliver, a box labelled
  `Flc`, was printed in its place. So the map did not merely omit a control; it
  offered a meaningless name for it at an ordinary-looking coordinate. Now:

  ```
  #6 button 387,191  Flowering  (partly off-screen — the coordinate is the middle of the visible part)
  ```

  `scrollTo` is deliberately unchanged: a clipped element is still "not in
  view", so it still scrolls rather than calling a sliver good enough.

## CLI

The CLI is the low-token path, and it is a first-class one: `--json` is on every
command, so nothing has to be parsed out of prose.

```bash
simframe ui                    # the numbered screen map — start here
simframe ui --json | jq '.elements[] | select(.type=="button") | .label'
simframe do flow.json          # a whole flow, verified, then the end-state map
simframe do flow.json --save=checkout   # save it if every step verified
simframe flow run checkout     # replay it
simframe tap "#3"              # or "Save", or "@120,400"
simframe find "the save button"   # resolve an intent without acting
simframe screens               # screens this device has learned
simframe goto invoices         # walk to a known screen over known steps
simframe state --since=$H      # what changed, as text
simframe mark                  # hash of the current frame, for --since
simframe wait --since=$H       # change, then settle
simframe recall                # what happened in the last minute, as text
simframe recall --ago=15000    # the frame from 15s ago
simframe frame --out=now.png   # newest frame, native resolution, to a file
simframe strip --count=6       # contact sheet, for an animation
simframe doctor --strict       # any degraded layer is a non-zero exit
simframe escalations           # why simframe still needs a model, by reason
simframe escalations --session # ...this agent only, not every agent on the device
simframe supervisions          # local supervisor rulings, and what came of each
simframe hpi                   # speed and accuracy against a human baseline
simframe baseline record settings-larger-text --runs=5   # record the human
simframe input reset           # rebuild the HID session, without restarting anything
simframe diagnose              # what this device is doing right now, and which failure it is
simframe revive                # power-cycle a wedged device: stop, shutdown, boot, start, reset input, launch
simframe start / status / stop [--force] / devices
simframe ui --device=emulator-5554      # or export SIMFRAME_DEVICE once
```

`--device` takes `--device=X` and `--device X` alike. It used to take only the
first: the space form set the flag to `true` and then resolved a device named
"true", which is a poor answer to a flag `doctor`'s own advice tells you to
type.

### When the simulator stops rendering

A simulator driven hard for several minutes can stop rendering: capture fails,
`simctl screenshot` fails too, and the daemon's own recoveries — re-resolving the
display port, then rebinding the device — do not help. It reports the state
rather than acting on it, because a capture loop that rebooted the device it was
watching would be a tool reaching for the mains:

```
capture is wedged and both recoveries are spent (2 port re-resolves, 2 device
rebinds, no frame since). This needs the device restarted —
`simframe revive --device=<udid>`. Backing off until a frame arrives.
```

**`simframe diagnose` says which failure it is**, which `doctor` cannot: `doctor`
answers "can this machine capture", and this answers "what is this device doing
right now". It reads only what discriminates — frame sequence, age and
stillness, element counts split by sensor, how many of them fuse, and who holds
the front by pid — and returns one of:

| verdict | what it means |
| --- | --- |
| `capture-down` | no frames at all, carrying the daemon's own sentence |
| `nothing-readable` | frames arriving, neither sensor finds a single element |
| `stale-frame` | both sensors full, almost nothing fuses — the framebuffer is behind the tree, so **an image from this device is not safe to trust** |
| `not-presenting` | an app holds the front by pid and the display shows almost nothing |
| `tree-silent` / `ocr-silent` | one sensor is reading and the other returns nothing. A silent tree is the serious one: it is authoritative when present, so every intent silently falls back to OCR |
| `healthy` | — |

`not-presenting` deliberately does **not** say whether that is a lock screen, a
dead surface or a crashed system shell. It is not knowable from here, and
guessing is how a regex ended up standing where a measurement belongs.

**It is not the same question `doctor` answers, and they can disagree.** Observed
on the bench device: `doctor` reported *"sensor mode: full — accessibility and
OCR fused on every read"* while `diagnose` reported `tree-silent`, 0 elements
from the tree against 20 from OCR. `doctor` is right about what is configured
and `diagnose` is right about what is happening. Ask the second one when
something is behaving oddly.

The `stale-frame` threshold is measured rather than chosen: element fusion has
run 0.667–0.929 on Apple's own screens, 0.567 on a third-party app and 0.471 on
a content-heavy Settings screen, so the threshold sits at 0.1 — **4.7× below the
lowest healthy reading yet seen**, rather than inside the metric's own noise.
Healthy fusion has no fixed band, because it tracks how much of a screen is
OCR-only and that is a property of the app; `diagnose` prints the reading and
the threshold and does not print a range the verdict does not use. Numbers in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

`simframe revive` is that restart, in the order that matters — stop the daemon,
shut the device down, boot it and *wait for the boot to finish*, start capture,
rebuild the HID session — and it ends by checking frames are flowing again
rather than by reporting that the steps ran. It is a command and not a
behaviour: the decision stays yours.

Frames are not the whole device, so the check is the one `diagnose` makes. If
the device comes back with its accessibility tree silent, the revive launches an
app, because that is what brings the tree back: measured on 2026-09-18, six
reads over sixty seconds left the tree at zero elements every time and a single
launch took it to fourteen. Waiting was the wrong remedy and the file used to
say so as advice to the caller.

### Reading what the local supervisor decided

With `SIMFRAME_SUPERVISOR=apple`, every consultation is written to
`~/.simframe/<udid>/supervisions.jsonl` with what the executor observed
afterwards, which is what makes a ruling scoreable rather than merely recorded.
`simframe supervisions` reads it:

```
14 supervisor rulings on iPhone 17 Pro

  stop -> stopped                    7
  wait -> recovered                  5
  wait -> still_failed               2

sourced: model 14
median latency: 1440ms
edges the graph had timed: 0/14 — 14 ruling(s) are on edges with no p95
```

That last line is the honest one: a step that failed is usually a step that has
never succeeded on that edge, so the graph has no timing to compare against.

### Keeping a session cheap

The expensive part of driving a simulator with an agent is not the tapping, it
is the thinking between taps — observe, think, tap, observe, think. Measured
over one real session against a third-party app: **62 tool calls for 179 steps**,
and 48 of those calls were three steps or fewer. A twelve-step flow arrived as
five calls, and every boundary between them was a think.

Three things move that number, and simframe does the first two for you:

- **Batch.** `sim_do` runs a whole flow in one call, with an assert after each
  step that matters. The asserts are what make it safe not to look in between:
  a step that lands somewhere unplanned halts the flow instead of letting the
  next four run against the wrong screen.
- **A `next:` line on every action result** — from the CLI and the MCP server
  alike — computed locally from what the daemon already knows — whether the screen settled, whether the graph
  recognises it, how many elements it has, whether any labels repeat. When it
  says *nothing ambiguous — chain the next steps in one sim_do without looking
  again*, that is the tool telling the agent it does not need to think.
- **A trailing map that was re-read, not recalled.** An action pays one
  perception pass — a few hundred milliseconds, locally — so the map it returns
  is the screen as it is now. The alternative was an agent spending a whole turn
  on `ui --refresh` because it could not trust the one it was given.
- **One goal per session.** Sessions get slower with every turn. A flow that
  runs as one call adds one exchange to the context instead of twelve.

And one thing to know about waiting: `settle` asks whether the screen stopped
moving, and a screen waiting on a network call has stopped moving. For anything
that arrives over the network, assert on the content you expect —
`{"waitFor": {"value": "Kate Bell"}}` — rather than on stillness. The map says
`STILL LOADING` when the classifier can see a load in flight, but only you know
what "arrived" means.

And the expensive habit worth naming: in that session, **28 of 62 calls returned
a screenshot** — about a third of its entire token cost — because the text map
could not report what a text field contained. It can now, so check the map
before reaching for pixels: a row carries the element's contents (`= Fryer 3`)
and its state (`disabled`), and the flow's own verdict already said whether the
action worked.

### The Claude Code skill

[`skills/simframe/SKILL.md`](skills/simframe/SKILL.md) teaches the CLI path
directly: the cheap-to-expensive order, the selector grammar, what each verdict
means and what to do about it. It ships with the package, so an installed copy
has it.

```bash
mkdir -p ~/.claude/skills
ln -s "$(npm root -g)/simframe/skills/simframe" ~/.claude/skills/simframe
```

A skill and an MCP server are not redundant. The MCP server is discoverable —
it appears in the tool list without anybody setting it up. The skill is cheaper:
Claude reads 3–5 lines of CLI output instead of a tool result, and none of the
MCP schema is in context until a tool is actually used. Ship both, use whichever
the client makes easy.

## Degrading is allowed. Degrading quietly is not

simframe is built to degrade rather than fail: no Swift toolchain still gives
you frames through `simctl`, no accessibility tree still gives you OCR. That
policy is right, and it nearly sank the tool twice — because a downgrade looked
exactly like everything working.

Once, one file was missing from the published package, so `Package.swift`
declared a test target with no directory, SwiftPM reported overlapping sources,
and **every install silently fell back to the slow engine**. Another time OCR
shipped disabled the same way. Both passed the tests. Both printed nothing. The
bug was never the missing file; it was the silence.

So every downgrade now announces itself:

- `simframe start` prints the engine it chose, and if it is the slow one, why —
  build error, missing sources, or "reason unrecorded" if the daemon was started
  by an earlier process.
- `simframe doctor` marks a degraded layer `WARN`, not `ok`, and summarises what
  is degraded and what that costs.
- A dependency that is simply not installed is `--`, not `WARN`. The distinction
  is deliberate: `WARN` means this machine could be doing better and silently is
  not, which is the failure worth shouting about. An optional fallback missing on
  a fresh machine has not degraded from anything, and `--strict` ignores it.
- A device whose capture has **wedged** says so: `capture: stalled — the display
  surface has been unreadable for 62s; 3 re-attaches did not help; only
  restarting the device is known to cure it`. This is a different thing from a
  still screen, and it used to look identical, because a damage-driven engine
  produces no frames for either. An agent told "nothing changed" keeps tapping;
  one told the simulator is wedged stops. simframe reports it and does not
  restart your device.
- `--strict`, or `SIMFRAME_STRICT=1`, turns any downgrade into a non-zero exit.
  CI runs strict, so a release cannot ship in the state that shipped twice.

```
$ simframe doctor
ok   capture engine        simframed
WARN input driver          idb — the daemon's control socket is not up
WARN accessibility tree    idb — the host-side translator did not load
```

Two checks enforce it. A packaging check derives the required file list from the
build's own inputs — a hand-written list is what rotted last time — and runs in
seconds without a simulator. An integration job installs the packed tarball on a
real simulator and asserts `capture.engine`, `input.driver` and `ocr.available`
are all the good values, under `--strict`.

That last check found a real bug the day it was written: a daemon shutting down
unlinked the control socket unconditionally, so restarting deleted the *new*
daemon's socket. Capture kept working, input quietly dropped to idb, and nothing
said a word — the exact failure shape, found by the thing built to catch it.

## Limitations

- Simulators and Android emulators only. Neither the framebuffer nor `simctl`
  nor the emulator console can reach a physical device.
- Android has no accessibility tree, so its screen identity rests on the
  geometry of OCR'd text: thinner and noisier than iOS's. See
  [Android](#android) above.
- The daemon depends on private frameworks. They are stable enough to build on —
  capture and accessibility survived the iOS 26 transition — but an Xcode
  upgrade can move a symbol. `doctor` reports each layer separately so a break
  is visible rather than mysterious, and `--engine=screenshot` still works.
- Hardware buttons: only `home` is implemented. The other Indigo codes are
  unverified, and a wrong one can crash `backboardd` or lock the device, so they
  return an error rather than a guess.
- Typing sends key positions, which iOS maps through the device's active
  keyboard layout. Text that must be exact goes through the pasteboard, which
  `sim_do` does by default.
- Region maps need a baseline inside the ~90 s history window. Older baselines
  still get a reliable changed / did-not-change, without a map of what moved.
- Screen memory assumes a screen's layout is stable. A screen that reflows
  dramatically between visits will simply be rebuilt.
- It speeds up *confirming* a fix, not *locating* one. A bug living in a memo
  comparator or a stale closure is not visible in any frame.
- A switch is tapped at its **activation point** when the app publishes one —
  UIKit's `accessibilityActivationPoint`, which is what a switch answers with,
  and tapping it flipped a real switch 3 of 3 times where the frame centre
  managed 0 of 3. Only **4 of 75** elements on a measured screen publish one,
  though, so where the app says nothing the tap still goes to the centre of the
  frame — and a switch's frame is the whole row, so it lands on the label and
  the control at the trailing end does not move. `@x,y` remains the escape
  hatch there. Never a guessed offset: nil means the app did not answer.
- A launch is confirmed to have fronted **on iOS only**. It compares the pid
  `simctl launch` printed against the pid the device reports as frontmost, in
  2–5 ms. Android reports neither, so a launch there is not checked — `am start`
  fronts synchronously, which is why it has not bitten, but that is not a check
  and `doctor` says so. Note that a launch which starts a process without
  bringing it forward now **fails** rather than returning success: a flow that
  used to pass through such a launch and then assert on the previous app's
  screen will start failing, correctly.
- The simulator's display pipeline stops rendering under rapid app relaunch —
  about six cycles, reproducibly — and every frame comes back black while
  `simctl` itself reports success. simframe now says so instead of reading a
  black screen as a calm one, but it cannot fix it: restarting the device is
  the cure that always works, and it usually recovers on its own.

## What was decided, and what was not built

[`docs/DECISIONS.md`](docs/DECISIONS.md) is the register of judgements that
changed the plan: a phase cancelled by its own measurement, two features built
and reverted for cause, and the premises that turned out to be false. It is
short on purpose — the numbers live in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) and the open work in
[`docs/DEFERRED.md`](docs/DEFERRED.md).

The most useful entry is a **no-go**: Phase 17 proposed a small on-device model
to choose the next element, and measuring the prize before the model showed the
matcher already resolves 37 of 40 real decisions. By the time a step reaches
simframe the decision has already been made — the goal names the option,
because the agent chose it and then asked for it by name.

## Roadmap

- **Extend the confirm vocabulary beyond English.**
- **Region bands from clustering**, replacing the positional bands. They have
  produced three bugs in three phases, and on Android they put a URL bar in the
  nav bar and its URL into the screen's identity.
- **Phase 8b, conditionally:** an instrumentation APK for the Android
  accessibility tree, with the criteria for doing it stated in
  `docs/DEFERRED.md` rather than left to enthusiasm.

## Releasing

`npm version` runs a `version` hook that rewrites `server.json` to match and
stages it, so one command covers both files:

```bash
npm version minor          # bumps package.json + server.json, commits, tags
git push --follow-tags
```

Before that hook existed, `server.json` had to be hand-edited between two
commands, and the release that forgot failed at the workflow's own agreement
check — which is the one thing that check is for.

The `release` workflow verifies tag/`package.json`/`server.json` agree, validates
`server.json` against the live registry, and publishes to npm and the MCP
Registry. It holds **no secrets** — both halves authenticate with the workflow's
GitHub OIDC identity.

That needs one setup step on npmjs.com, not in this repo: the package must have a
Trusted Publisher pointing at this repository and `release.yml` (Package →
Settings → Trusted Publisher → GitHub Actions). Without it npm has nothing to
trust and fails with `ENEEDAUTH`. npm is ending token publishing in January 2027,
and the tokens that work in CI need 2FA bypass, which npm's own UI warns against —
so OIDC is the durable path, not merely the tidier one.

## License

MIT
