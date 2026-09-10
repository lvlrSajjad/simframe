# simframe benchmarks

Numbers are medians unless stated. Each entry records the machine, toolchain and
device, because private-framework performance is not portable across them.

Reproduce with `native/simframed/.build/release/simframed bench --n=300`.

## Environment

| | |
| --- | --- |
| Chip | Apple M2 Pro |
| macOS | 26.6.2 |
| Xcode | Xcode 26.6 |
| Device | iPhone 17 Pro, iOS 26.5 (1206×2622 @3x) |

## Phase 0 — framebuffer capture

The capture primitive, measured in isolation (`framebufferSurface` read plus a
lock/unlock, no scaling or hashing):

| Metric | N | Median | p95 |
| --- | --- | --- | --- |
| IOSurface grab | 202 | **0.13 ms** | 0.25 ms |

The full per-frame pipeline a capture loop actually needs — grab, downscale to
the ring size, then frame hash + layout hash:

| Pipeline | N | Median | p95 |
| --- | --- | --- | --- |
| grab + scale to 700px | 300 | 6.02 ms | 8.70 ms |
| grab + scale + both hashes | 300 | **6.74 ms** | 10.26 ms |
| grab + scale to 420px + hashes | 300 | 5.52 ms | 6.28 ms |

Against the path it replaces, doing the same work:

| Path | Mean |
| --- | --- |
| `simctl io screenshot` + `sips -Z 700` | 210 ms |
| simframed (grab + scale + hashes) | **6.74 ms** |

**31× faster end to end; the capture primitive alone is ~1000× faster than a
`simctl` screenshot.** Most of the remaining 6.7 ms is the downscale, not the
capture, so the headroom is in scaling — dropping to a 420 px ring costs 5.5 ms.

## Hash compatibility

The Swift daemon must produce the hashes the JavaScript already produced, or
every screen-memory key on disk is invalidated. Measured on a verified-static
screen (two Node reads one second apart agreeing, stable for 11.5 s):

| Scaler | frameHash | layoutHash |
| --- | --- | --- |
| **CoreGraphics** (default) | **Δ0 / 128 bits** | **Δ0 / 288 bits** |
| Box average (`--box`) | Δ0 / 128 bits | Δ4 / 288 bits |

CoreGraphics is byte-identical to the `sips` path, which is unsurprising once
you know `sips` is a thin ImageIO wrapper. The box-average fallback stays within
the layout-hash tolerance of 12 but is not exact, so it is opt-in only.

Measuring this needs a genuinely still screen. An earlier run against a moving
one reported Δ26/128 and Δ53/288 — an artefact of the screen changing between
the two readings, not of the scaler.

## Phase 0 — sanity checks

Correct hashes prove nothing about channel order, row padding or orientation, so
the capture was checked against `simctl io screenshot` pixel by pixel on a
verified-static screen:

| Check | Result |
| --- | --- |
| Pixels identical to `simctl` | **100.00 %** |
| Mean absolute channel difference | 0.000 / 255 |
| Max absolute channel difference | 1 |

Behaviour under the conditions a daemon actually meets:

| Check | Result |
| --- | --- |
| 3000 consecutive captures | median 6.56 ms, p95 7.04 ms, no drift |
| Peak resident memory over that run | 70 MB |
| Four concurrent captures | all succeeded, identical results |
| Running alongside the Node capture loop | neither disturbed |
| Simulator window hidden | works, 98.8 % non-black, same as `simctl` |
| Bad UDID / bad command / missing frameworks | exit 1 with a readable message |

Two notes for whoever reads this next:

- **Window independence holds.** An earlier check appeared to show a black frame
  while the window was hidden. That was a truncated hash being misread — the
  screen simply had a large dark region. Always compare full hashes.
- **The surface is re-read every capture rather than cached**, so a reallocated
  surface (rotation, resize) is picked up automatically with no re-attach.

## Phase 0 — second device class

Port selection and geometry were the parts most likely to be written around one
phone, so they were checked against a 2x iPad as soon as one was available.

| | iPhone 17 Pro | iPad Pro 13-inch (M5) |
| --- | --- | --- |
| Native | 1206x2622 (3x) | 2064x2752 (2x) |
| Scaled ring frame | 322x700 | 525x700 |
| Pixels identical to `simctl` | 100.00 % | **100.00 %** |
| Max channel difference | 1 | **0** |
| grab + scale + hashes | 6.56 ms | 11.32 ms |

The iPad is slower in proportion to its pixel count (5.7 M vs 3.2 M), which is
what you would expect if the cost is the downscale rather than the capture.

Both devices were also captured concurrently from separate processes, each
returning its own correct frame.

## Phase 0 — the change signal

`registerCallbackWithUUID:damageRectanglesCallback:` on the live display port:

| Metric | Result |
| --- | --- |
| Damage events during app switching | **51.9 / s** |

This is the per-redraw signal the capture loop should be driven by. It means the
daemon can be event-driven — wait for damage, then grab in 0.13 ms — instead of
polling and discarding unchanged frames. Note it must be registered on the *live*
port; the inactive display port reports nothing.

## Phase 0 — the capture loop

The daemon is driven by the damage callback rather than a timer, so an idle
screen costs nothing and a moving one is picked up at once. Per-capture cost
includes the PNG encode and the `state.json` write, which the raw pipeline
figures above do not.

| | Median per capture | Frame rate |
| --- | --- | --- |
| First working loop | 121 ms | 1 fps |
| Full-res encode moved off the capture path | 30 ms | 8 fps |
| PNG encoded once, housekeeping throttled | **12–21 ms** | **12 fps** |
| Node loop it replaces, for comparison | ~210 ms | 4 fps |

The remaining frame rate is capped by the 80 ms coalescing window, not by cost.

Three things dominated the early cost and are worth remembering:

- A native-resolution PNG encode is ~115 ms. It belongs on a background queue
  and behind a throttle, never on the capture path.
- The ring frame and `latest.png` are the same picture. Encoding it twice
  doubled the per-frame cost for nothing.
- Retention housekeeping stats every retained file. Running it every frame cost
  more than the capture; every twentieth frame is plenty.

## Phase 0 — acceptance

With the Node capture loop stopped and `simframed run` in its place, against
frames the Swift daemon produced:

| Check | Result |
| --- | --- |
| `simframe status` sees the daemon | yes, by pid from meta.json |
| `simframe state` / `frame` / `wait` / `recall` | all work unchanged |
| `simframe ui` (needs a native-resolution frame for OCR) | works |
| Node respawning its own loop | no — ownership is respected |
| Four-tab flow via `sim_do` | 4/4 steps, screen memory hitting |
| Clean shutdown on SIGINT | releases ownership (`pid: null`, `stoppedAt` set) |
| Capture errors during the run | 0 |

## Phase 0 — screen memory and capture rate

The Swift daemon captures faster than the Node loop it replaces, which raised a
question: does capture rate change how often screen memory hits? The four-tab
flow, three passes, memory cleared first, counting how many of the four controls
resolved from memory.

Before the settle gate:

| Capture cap | pass 1 | pass 2 | pass 3 |
| --- | --- | --- | --- |
| 12.5 fps | 1/4 | 3/4 | 4/4 |
| 4 fps | 0/4 | 4/4 | 4/4 |

Both converge, so capture rate was **not** the main driver — the earlier
observation of a persistent 1-2/4 was more likely the app still loading. But the
two rates followed visibly different trajectories, which should not happen: what
gets remembered must not depend on how fast frames arrive.

The cause was structural. A screen map was keyed off whichever frame happened to
be newest, including frames from the middle of a transition, whose layout
belongs to neither the screen being left nor the one arriving. A faster loop
samples more such frames.

The fix is a settle gate: memory is looked up and built only from a frame that
has been still for `MEMORY_SETTLE_MS`, and a map built while the screen was
moving is used once and never persisted. After it:

| Capture cap | pass 1 | pass 2 | pass 3 |
| --- | --- | --- | --- |
| 12.5 fps | 2/4 | 2/4 | 4/4 |
| 4 fps | 1/4 | 2/4 | 4/4 |

The trajectories now match, which was the point: capture rate no longer changes
what is remembered. The gate does not make memory hit *sooner* — convergence
still takes three passes, because a screen genuinely looks different while its
data is loading — and it is deliberately crude. Phase 4 replaces it with a real
settle detector that can tell a spinner from a still screen.

Checked afterwards: five stored maps for a five-screen app, no pair within 30
bits of another, and the gate reported settled on 6 of 6 lookups against a still
screen. No transitional junk is being persisted.

## Phase 1 — input through the daemon

Gestures go over a per-device Unix socket at `~/.simframe/<udid>/control.sock`,
mode 0600, one JSON object per line. Measured from Node against a live daemon.

| Request | N | Median | p95 |
| --- | --- | --- | --- |
| `ping` — pure round trip | 100 | **0 ms** | 1 ms |
| `status` | 50 | **0 ms** | — |
| `tap` (70 ms hold) | 100 | 76 ms | 79 ms |
| `tap` (10 ms hold) | 100 | **13 ms** | 14 ms |
| `swipe` (300 ms gesture) | 20 | 358 ms | 373 ms |

The transport costs nothing measurable. A tap's latency is almost entirely the
hold it was asked for: dropping the hold from 70 ms to 10 ms takes the whole
call from 76 ms to 13 ms, which puts fixed overhead at roughly 3 ms. Holds are
deliberate — a zero-length press is not what a finger does — but they are the
budget, not the plumbing.

`status` was 315 ms until the keyboard-layout check was cached at attach time.
It shells out to `simctl` to read `AppleKeyboards`, and it was doing so on every
call, on a path the CLI hits for every command.

### End to end

The four-tab flow with every tap carried by simframed rather than idb, memory
cleared first:

| Pass | Time | Steps | From memory |
| --- | --- | --- | --- |
| 1 | 2881 ms | 3/4 | 1/4 |
| 2 | 3441 ms | 4/4 | 2/4 |
| 3 | 2841 ms | 4/4 | 3/4 |

The one failed step was the ambiguity guard doing its job: "Invoices" is both
the screen title and a tab, and it reported both with coordinates rather than
picking one.

### Remaining gestures

`drag`, `longPress`, `launch`, `terminate`, `openURL` and `permission` round out
the Platform surface. `drag` holds before moving — that hold is what separates a
drag from a swipe, and without it a reorderable list never enters drag mode.

| Action | Measured |
| --- | --- |
| `longPress` (600 ms) | 606 ms |
| `drag` (500 ms hold + 400 ms move) | 1062 ms |
| `launch` | 218 ms |
| `terminate` | 179 ms |
| `openUrl` | 847 ms |
| `permission grant` | 167 ms |

Still not implemented, with reasons rather than omissions: `pinch` needs
multi-touch, a different Indigo message shape that is unverified; and every
hardware button except `home`, because identifying the codes means sweeping them
on a simulator you are willing to have crash or lock.

`simframe doctor` now reports capture and input per device, so a machine part
way through the transition reads honestly:

```
ok  capture engine (iPhone 17 Pro)  simframed
ok  input driver  (iPhone 17 Pro)   simframed: Indigo HID (SimDeviceLegacyHIDClient)
ok  capture engine (iPad Pro 13-inch (M5))  simctl
ok  input driver  (iPad Pro 13-inch (M5))   idb: companion built Sep 1 2026
```

## Phase 2 — text recognition in-process

Vision now runs against the IOSurface the daemon already has mapped, rather than
against a PNG the daemon wrote and a helper process decoded.

| Route | N | Median |
| --- | --- | --- |
| In-process, off the framebuffer | 12 | **174 ms** |
| PNG encode + write + spawn + decode | 8 | 555 ms |

**3.2x faster**, and the first call is 301 ms because Vision warms up — measure
the second onwards or the improvement disappears into the warm-up.

The effect on the path that matters, building a screen map:

| | Before | After |
| --- | --- | --- |
| First visit to a screen | ~600 ms | **~305 ms** |
| Remembered | ~1 ms | ~1 ms |

Same 47 targets, same resolved coordinates. A regression worth recording: the
first attempt ran the daemon OCR *after* the accessibility read rather than
alongside it, which cost 1126 ms — slower than the path it replaced. Both routes
now start before the tree read.

### What idb is still for

| Capability | Engine |
| --- | --- |
| Capture | simframed |
| Input | simframed (idb as fallback) |
| Text recognition | simframed, in-process |
| **Accessibility tree** | **idb — the only remaining dependency** |

Phase 2b removes the last one.

## Phase 3 — cutover

`simframe start` builds the daemon if needed and runs it. `--engine=simctl`
keeps the original loop, and it is chosen automatically when the daemon cannot
be built, with the reason printed rather than swallowed.

Reproduce everything above with `npm run bench`.

### The four-tab flow, both engines

Same flow, same app, memory cleared first:

| Pass | simctl engine | simframed engine |
| --- | --- | --- |
| 1 | 7370 ms | **3925 ms** |
| 2 | 5160 ms | **2741 ms** |
| 3 | 3304 ms | **3159 ms** |

Faster throughout, though less than the 30x on the capture primitive would
suggest — by pass three most of the remaining time is the app's own animation
and data load, which no engine change touches.

### A packaging bug this phase's own verification caught

Installing the tarball and starting it produced:

```
started — engine=simctl (simframed unavailable: building simframed failed:
error: 'simframed': target 'SimframeCoreTests' has overlapping sources)
```

`Package.swift` declares a test target, but `files` shipped `Sources` without
`Tests`, so SwiftPM assigned the whole source tree to the missing target and the
build failed. **Every npm install would have silently used the simctl engine** —
the fallback behaved correctly and said why, but nobody would have got the thing
the rebuild is for.

Shipping `Tests` fixes it, and CI now builds the daemon from an unpacked tarball
so the packaged artefact is checked rather than the working tree. A clean install
now builds and starts its own daemon in about 13 seconds, first time only.

## Phase 4 — settle and transitions from frame history

Motion analysis runs on every captured frame, on a 48x96 grayscale grid built
with integer arithmetic. Per-frame cost is unchanged within noise — 13-21 ms
with it, the same without — so the whole analysis is under about 2 ms.

An earlier version cost 15 ms a frame because it reused `Hashing.grayGrid`,
which averages every pixel in double precision. That precision exists so the
hash matches the JavaScript byte for byte; motion has no such constraint, and a
subsampled integer grid is free.

### Settle

Settled means N consecutive frames below the change threshold **and** a minimum
duration. Frame count alone is not a measure of time: the capture loop drops to
one frame every two seconds when nothing is happening, so requiring three
consecutive still frames took six seconds to call a motionless screen settled.

A localised-animation detector runs alongside, and **must run even when the
frames look still globally**. A spinner covering half a percent of the screen
moves the mean difference by about 0.001, well under the still threshold, so
checking for one only when the global test already says "moving" never fires. A
screen with a spinner is reported as neither settled nor changing, with the
moving region localised.

### Transition classification

Measured against a real app, settled state to settled state:

| Action | Classified | Offset |
| --- | --- | --- |
| Swipe up on a list | `scroll` | (0, 146) pt |
| Swipe down on a list | `scroll` | (0, -164) pt |
| Tab switch | `replace` | — |
| Nothing | `none` | — |

Two mistakes were needed to get there, and both are worth keeping in mind.

**The fixed chrome pins the shift search.** Searching the whole frame for a
translation found `dy=0` for a scroll that had visibly moved: a navigation bar,
search field and filter row that stay put are a quarter of the screen and
pixel-identical, so no shift beats no-shift. The search is now restricted to the
rows that actually changed, which is what makes a real scroll measurable.

**The score and its baseline must be measured over the same sample.** The shift
score subsampled columns while the baseline it was compared against did not, so
the ratio deciding "is this a translation" compared two different quantities.

Classification on real screens is still imperfect — a scroll that hits the top
of a list and rubber-bands reads as `replace`, because after the bounce the
frames genuinely are not a translation of each other. The failure mode is a less
specific answer rather than a wrong one, and every result carries the evidence it
was decided from, so a misclassification can be argued with rather than guessed
at.

## Phase 5 — layout priors and intent matching

`sim_find` / `simframe find` resolve an intent to one control, or say why they
cannot. Region priors come from geometry, so they cost nothing and disambiguate
a great deal: "Assets" the navigation title and "Assets" the tab differ only by
where they are.

Measured against a real app screen:

| Intent | Resolved | Score |
| --- | --- | --- |
| `Work Orders tab` | tab bar (200, 836) | 1.00 |
| `tap Invoices` | tab bar (275, 836) | 1.00 |
| `Wrok Orders tab` (typo) | tab bar (200, 836) | 0.74 |
| `Map` | nav bar (363, 90) | 1.00 |
| `Assets` (title and tab both present) | **ambiguous, both listed** | — |
| `back` (no back button on this screen) | **not on this screen** | — |

Three bugs found while building it, each of which produced a confident wrong
answer rather than an error:

**A bail-out sentinel used as a measurement.** `editDistance` returns `cap + 1`
when it gives up early. Scoring treated that as a real distance, so
`1 - 9/200` gave every long string a similarity of 0.955 and a score of 0.687 —
*against any query at all*. Two different queries scoring a row identically is
what gave it away.

**Substring matches unweighted by coverage.** "back" scored 0.78 against a
two-hundred-character list row containing "Back of House" and beat the actual
back button. A substring match is now worth the share of the name it covers.

**Off-screen elements offered as answers.** A scrolled-away row still sits in
the screen map with a negative `y`; tapping it lands somewhere else entirely.
Candidates are now filtered to what is actually on screen.

And one design mistake worth naming: when intent resolution found nothing, the
code fell through to plain substring matching, which has none of the guards
above. A fallback that is less safe than the thing it backs up is not a
fallback. "Not found" is the answer.

## Phase 6 — transition graph and action verification

Every action now records what it did — `(screen, action) -> screen'` with a
count and the transition kind — and every action is checked against what it did
last time.

Verdicts: `ok`, `no-visible-change`, `unexpected-screen`,
`unexpected-transition`, `unverified`. **A step with no prediction is
`unverified`, not `ok`.** Not knowing what should have happened is not evidence
that the right thing did, and reporting it as success is how a flow carries on
past a wrong turn. `sim_do` stops at the first `unexpected-*`.

Learning the four-tab tour, memory and graph cleared first:

| Pass | Verdicts |
| --- | --- |
| 1 | unverified × 4 |
| 2 | unverified, unverified, **ok**, unverified |
| 4 | unverified, unverified, **ok**, **ok** |

### Why it does not reach four of four

The graph is keyed by the same layout hash as screen memory, and that hash
fingerprints pixels. The phase's target — every step resolved from graph and
memory by the third pass — is not met, and the reason is measured rather than
guessed:

| | Layout-hash distance |
| --- | --- |
| Same screen, revisited (n=30) | min 0, **median 0**, max **62** |
| Different screens (n=10) | **min 74**, median 85 |

A revisit is usually identical, but a list whose content has changed drifts as
far as 62 bits — against a different-screen floor of 74. No threshold separates
those cleanly. The tolerance was raised from 12 to 20, which collapsed the tour
from six stored screens to three; the rest must rebuild.

This also explains the "screen memory hit rate varies" note carried since
Phase 3. The first calibration measured 0-3 against 77-96 and chose 12, but that
was on screens whose content happened to be stable, and it was not
representative.

The fix is not a better threshold. It is to fingerprint **structure** — element
roles and positions — rather than pixels, which is content-independent by
construction and which the element map already has the ingredients for. It is
now the highest-value item in `docs/DEFERRED.md`.

## Phase 6b — structural fingerprint

M4 Pro, Xcode 26, iOS 26.0, iPhone 17 Pro (402×874 pt), a real third-party app.

Phase 6 keyed screen identity on the pixel dHash and could not reach its target.
6b keeps that hash for *change* and *settle* — questions about pixels, which it
answers well — and adds a second, structural hash for *identity*. Memory and the
graph are keyed by the structural hash; the pixel hash remains the trigger that
says a frame is settled enough to compute one.

What goes in: element roles, frames quantised to 24 px, the region each element
sits in, and repeated siblings bucketed rather than counted. Labels go in for
chrome only — nav title, tab labels, toolbar buttons — because two list screens
with identical structure are told apart by their title and nothing else. Out:
all content text and values, the status bar, and the keyboard region when a
keyboard is up (`keyboard: true` is recorded separately instead).

### The two distributions

Jaccard similarity over token sets, four tabs, three visits each.

| | Same screen, revisited | Different screens | Gap |
| --- | --- | --- | --- |
| Full element list, screen map warm | 0.54–1.00 | 0.00–0.31 | 0.23 |
| Full element list, **map forced cold** | **0.41**–1.00 | 0.00–**0.31** | **0.11** |
| OCR-only (accessibility discarded) | — | 0.00–0.35 | — |

The cold row is the honest one; the warm row is partly measuring screen-map
cache hits. The threshold is **0.36**, the middle of the cold gap.

That gap is narrow, and one screen causes it. Home fingerprinted at 17 tokens on
one visit and 7 on the next two — a screen caught after its pixels settled but
before its rows arrived. Every other screen scored 1.00 against itself. So the
distributions do separate, but the margin is thin and it is thin for a reason
that is fixable: `settled` is a pixel criterion, and structural identity needs a
structural one. That is recorded in `docs/DEFERRED.md` rather than papered over
with a looser tolerance.

Even so, compare what it replaces. The pixel hash put same-screen revisits at 62
bits against a different-screen floor of 74 — overlapping, with no threshold
available to choose at all.

### Accessibility-poor screens

Every screen in this app fuses both sources — 8–33 accessibility targets and
10–32 OCR targets each. Discarding the accessibility half entirely and
fingerprinting from OCR boxes alone still separates the four tabs, with a
different-screen ceiling of 0.35 against the same 0.45 threshold. Structural
identity does not depend on the accessibility tree being present.

### The tour, three passes

| Pass | Steps verified `ok` | Controls from memory | Wall clock |
| --- | --- | --- | --- |
| 1 | 0/4 | 3/4 | 30.0 s |
| 2 | 3/4 | **4/4** | 7.3 s |
| 3 | **4/4** | **4/4** | 19.4 s |

Phase 6 never exceeded 2/4 verified on the same tour. The phase target — every
step resolved from graph and memory by the third pass — is met.

Two honest caveats in those numbers. The wall clock is worse than Phase 6, not
better: verification now builds a screen map both before *and* after every step,
roughly doubling the per-step cost, and passes 1 and 3 also paid for cold
perception on screens the map had not yet seen. The variance between 7.3 s and
19.4 s is that cost appearing or not, not a change in the tool. Second, the tour
stores five graph nodes for four tabs; all five are pairwise distinct at ≤0.31,
so nothing was wrongly merged, but one tab was captured twice in states far
enough apart to count as different screens. That is the same Home-tab
mid-load capture the 0.41 figure comes from — the anomaly and the measurement
are one finding, not two. Both are recorded in `docs/DEFERRED.md`.

### Measurement traps hit in this phase

A first run showed different screens scoring 1.00 against each other, which
would have condemned the whole approach. The taps were not switching tabs; both
reads were of the same screen. Navigation was verified (74–94 bit pixel moves
between tabs) before any similarity number was believed.

A later run showed same-screen pairs at exactly 1.00 with identical token *and*
target counts across all three visits. That is a screen-map cache hit being
measured, not three independent perceptions of the same screen — the number is
tautological. Same-screen figures here come from runs with the map forced cold.

### Graph-assisted navigation

With the four tabs learned (two teaching passes, the second verifying 4/4),
`simframe goto` plans over known edges and walks them with no model call:

| | Route | Steps | Result |
| --- | --- | --- | --- |
| `goto invoices` | more → home → work orders → invoices | 3 | every step `ok`, arrived |
| `goto "work orders"` | invoices → more → home → work orders | 3 | every step `ok`, arrived |

Adding the nav slot to chrome tokens is what made this addressable. Before it,
three different screens were all named "help center e" — a button that happened
to sit in the nav bar, mistaken for a title — and the tour stored five nodes for
four tabs. After it, four tabs store four nodes named `invoices`, `work orders`,
`more`, and the tab bar itself for the one screen with no title.

## Phase 6c — structural settle gate, and what it did not fix

Same machine and app. This phase set out to do two things: widen the narrow
same-screen gap left by 6b, and claw back the verification cost 6b introduced.
**It achieved neither of its stated goals.** It is recorded because of what it
found on the way.

### Goal 1: widen the gap — not achieved

The theory was that the 0.41 same-screen floor came from screens caught after
their pixels settled but before their rows arrived, and that making a novel
fingerprint prove itself twice would remove the transients. A gate was built:
two readings, 300 ms apart, agreeing by similarity rather than exact hash.

The first measurement after it looked like a triumph — Home read 7/7/7 tokens,
same-screen floor 1.00, gap 0.69. That measurement was luck. Re-run:

| | Home tokens, three cold visits | Same-screen floor | Gap |
| --- | --- | --- | --- |
| Before the gate | 17 / 7 / 7 | 0.41 | 0.11 |
| After the gate, first run | 7 / 7 / 7 | 1.00 | 0.69 |
| After the gate, re-run | **8 / 17 / 6** | **0.35** | **0.05** |

Home is not catching a transient. Its structure genuinely differs between
visits, and a settle gate cannot wait out something that was never unsettled.
Every other screen scores 1.00 against itself in every run; the entire margin
problem is this one screen, and it needs a different fix — see
`docs/DEFERRED.md`.

### Goal 2: reduce the verification cost — not achieved

Carrying the previous step's after-screen forward as the next step's before-
screen is sound and is kept, but it is swamped. The warm pass is still far above
where Phase 6 left it.

### What it did achieve: correctness, and two real bugs

A/B on the same tour, gate off versus on, everything else equal:

| | Pass 1 | Pass 2 | Pass 3 | Screens |
| --- | --- | --- | --- | --- |
| Gate **off** | 33.2 s, 0/4 ok, 3/4 memory | 27.1 s, 3/4 ok, 3/4 memory | 16.6 s, 4/4 ok, 4/4 memory | 3 |
| Gate **on** | 30.4 s, 0/4 ok, **4/4** memory | 28.6 s, **4/4** ok, **4/4** memory | 27.4 s, 4/4 ok, 4/4 memory | 4 |

The gate reaches full memory from the first pass and full verification from the
second, one pass earlier than without it, and costs about 10 s on the warm pass.
It is on by default and `confirmNovel: false` turns it off.

Two genuine bugs surfaced while diagnosing, both invisible until a per-step
diagnostic printed `settled` and `confirmed`:

- **Identity settled with its own patience, not the caller's.** `settledState`
  times out at 1.5 s. Inside a flow allowing twelve seconds this reported
  `settled=false` on three of four screens while the flow was still waiting
  happily — and an unsettled screen recorded no edge, so **pass 1 recorded zero
  edges** and every later step read `unverified`.
- **The fix for that overshot.** Passing the caller's timeout straight through
  made screens that never settle — live content, a looping animation — burn the
  flow's whole 12 s budget, twice per step: the tour went from 7 s to 53 s on
  the warm pass. Identity now waits `IDENTITY_SETTLE_TIMEOUT_MS` (2.5 s), long
  enough to outlast a transition, short enough to give up cheaply.

The lesson worth keeping is the first measurement. It showed exactly what the
change was supposed to show, and it was wrong; only re-running it caught that.

## Phase 6d — variants, and a fingerprint that expired daily

### The bug worth the whole phase

The Home screen's fingerprint contained `text:tab-bar:w6:h1:"sep 08, 2026"`.

Chrome labels go into the structural hash on purpose — two list screens with
identical structure are told apart by their title. But `regionFor` is a
positional band, so a date banner sitting ~70 px above the real tabs was
classified `tab-bar` and its text became part of the screen's identity. That
screen would have become a **different screen at midnight**, invalidating every
stored map, graph node and route touching it, overnight and silently.

Nothing in the existing measurements could have caught it. The fingerprint was
perfectly stable across visits — it was stable on something that expires. Same
similarity, same gap, same hit rate, right up until the date rolled over.

The discriminator is structural, not textual: a tab bar divides its width among
its tabs, so a tab's label is a small fraction of the screen. Measured on this
app, real tab labels ran 24–72 px against the banner's 144 px on a 402 px
screen; `tab-bar` labels are now kept only below 30% of screen width. The
element still contributes its shape — presence is structure — it just stops
contributing text. Regression test asserts that today's and tomorrow's dates
produce the same hash.

| | Home screen's name |
| --- | --- |
| Before | `assets / home / more / •.. / $ / invoices / work orders / sep 08, 2026` |
| After | `assets / home / more / •.. / $ / invoices / work orders` |

### Variants: built, not yet exercised

A node can now hold up to four accepted fingerprints. One is admitted only when
a **known edge lands somewhere its target does not recognise** — the edge being
the evidence that it is the same place — and only if no other stored screen
claims that reading, which stays a genuine change of destination. Unit tests
cover admission, the refusal, and the cap.

On device it did not fire: **variants=0 on every node** across three passes. The
tour recognised every screen, so nothing needed a second face. The mechanism is
in place and tested, but its value on a real app is **unmeasured** — the screen
that motivated it was not reproduced in these runs. It should not be described
as having fixed the narrow margin until a run actually admits a variant.

### The tour

| Pass | Steps verified `ok` | Controls from memory |
| --- | --- | --- |
| 1 | 0/4 | **4/4** |
| 2 | **4/4** | **4/4** |
| 3 | **4/4** | **4/4** |

Four screens, four edges, names free of content.

**A note on wall clock.** Across the runs in this phase and 6c the same four-tab
tour measured anywhere from 7 s to 58 s. That spread is dominated by the app's
own data loading and by whether screens report settled, not by the changes being
tested. Single-run timings at this granularity are not evidence of anything and
are no longer quoted as such; the per-operation numbers earlier in this file are
the ones that mean something.

## CI, strict mode, and the socket bug it found

### What the two checks cost

| Check | Runner | Needs a simulator | Time |
| --- | --- | --- | --- |
| Packaging — every build input ships | any | no | ~2 s |
| Integration — tarball on a booted simulator, `--strict` | `macos-15` | yes | ~5-10 min |

The packaging check derives its required list from the build's own inputs: the
SwiftPM manifest, every `.swift` under `Sources` and `Tests`, the standalone OCR
helper, and every runtime module. Verified against both historical regressions
by removing each from `files` in turn — each exits 1.

### Two bugs found while writing the checks

**The existing packaging check could not fail.** It ran
`swift build … 2>&1 | tail -3`, and a pipeline's exit status is the last
command's, so `tail` succeeding masked any build failure. The one check meant to
catch a broken package was itself broken for its entire life. Now `set -o
pipefail` and no `tail`.

**A daemon shutting down deleted its successor's control socket.**
`ControlSocket.stop()` called `unlink(path)` unconditionally. Restarting the
daemon meant: old process killed → new process binds and creates the socket →
old process's cleanup unlinks the same path. Capture is file-based so it kept
working; only *input* degraded, to idb.

This had been happening on the development machine for an unknown period. It was
invisible because nothing reported which input driver was in use, and it is the
exact failure shape the strict checks exist for — found by the loud-degradation
work on the day it was written, on the author's own machine, not by a test.

`stop()` now records the socket file's inode at bind time and removes it only if
the file still has that inode.

### A caveat this puts on the Phase 6c and 6d timings

Because input was silently on idb, every tap in those tours paid ~285 ms through
the idb client instead of going over the daemon socket. The wall-clock figures in
those two sections were measured on the fallback input path and are pessimistic
by roughly that much per tap. They are left as recorded — they were honest
measurements of what the tool actually did at the time — but they are not a
measurement of the daemon's input path, and the tours should be re-run now that
`--strict` can prove which path is in use.

### Two stale idb dependencies, found by running CI without idb

A hosted runner has no idb, which turned out to be a better test of the "idb is
only needed for the accessibility tree" claim than any assertion. It was false
in two places:

- **`runScript` demanded idb for every batch flow.** It called
  `detectDriver()`, which asks specifically whether idb is installed, rather
  than `driverFor(udid)`, which prefers the daemon's control socket. Single-step
  `simframe tap` already used `driverFor`, so `tap` worked without idb and `do`
  did not — the batch path, which is the one that matters for an agent.
- **Device geometry came from `idb describe`.** The daemon already reports the
  device's point size and scale in its status, so this was both an unnecessary
  dependency and a slower one. The fallback when idb was missing was a hardcoded
  402x874 at 3x — an iPhone 17 Pro — which is silently wrong on any other
  device, an iPad especially, and every tap point derived from it lands in the
  wrong place.

Both now go through the daemon. The claim in `simframe doctor` that idb is "the
only thing idb is still required for" is true as of this change; it was not true
when it was written.

### The CI flow assertion, wrong twice before it was right

Worth recording because both wrong versions would have passed by luck:

1. Assert a frame counter advances. It cannot on an idle screen — the daemon
   captures on damage, so nothing moving means no new frames.
2. Assert launching an app changes the screen. It does not, if that app is
   already in front. This passed locally only because the simulator happened to
   be showing something else.

The working version normalises first: press home, take the baseline there, then
launch. The before state is always the home screen and the after state always an
app, whatever the runner was showing.

## What an independent run found

A peer session installed the packed tarball from GitHub HEAD on its own clone
and ran the four steps. `doctor --json --strict` came back clean — exit 0,
`capture.engine=simframed`, `input.driver=simframed`, `ocr.available=true` — and
then it found five things that were broken *while reporting success*, which is
the category this project cares about most.

Two confounds it flagged correctly and I have to own: it was testing against a
simulator **I was driving at the same time**, so some screen changes and graph
edges in its notes are mine, and the state directory already held screens from
earlier sessions. Its observations still stand; only the attribution of a few
screen changes was affected.

### The state version had drifted, and every command respawned the daemon

`daemon.js` declared `STATE_VERSION = 5`; the Swift daemon wrote `6`. So
`daemonStatus` judged the live daemon stale on **every CLI call**, `stopDaemon`
declined to kill it (its heartbeat was fresh), and `ensureDaemon` started
another. One log held **993** "superseded by another capture loop" lines.

Capture kept working throughout, and `doctor` stayed green, which is why this
survived so long. What it broke, silently:

| | Symptom |
| --- | --- |
| `recall` | "1 frames buffered" — the memory it reported was created by the `recall` call itself |
| `state --since=<mark>` | the baseline "is not in the buffered history" — the documented mark/wait pattern could not work |
| `wait --since` | reported settling against a baseline the new daemon had never seen |
| `start` | printed "started" while replacing a working daemon |
| every flow timing | measured across daemon restarts |

Fixed by aligning the constant, and a unit test now reads `stateVersion` out of
`FrameStore.swift` and asserts the two match, because nothing else would have
noticed. After the fix: four consecutive commands, one daemon, zero new
"superseded" lines.

### `simframe tap <label>` crashed on any screen the graph recognised

`simframe tap X` built its step as `{tap: X, index: undefined}`. The undefined
key survived normalization, and `actionSignature` fell through to a generic tail
that did `JSON.stringify(step[key]).slice(...)` — `JSON.stringify(undefined)` is
`undefined`, so it threw `Cannot read properties of undefined (reading
'slice')`. It threw inside `graph.predict`, before the tap was sent, so the
headline command failed on exactly those screens where memory should have made
it fastest. Invisible in this session because a mid-transition screen has no
identity, so `predict` was skipped.

### A tap and a type on the same text shared one graph edge

Underneath that: `actionSignature` looked for `{tap: ...}`, but every step
reaching the graph has been normalized to `{action, value}`. So no shorthand
branch ever matched and everything fell to the generic tail — signatures read
`value:"Contacts"`, losing the action type entirely. `tap "Contacts"` and
`type "Contacts"` produced the same signature and therefore the same edge. Every
prediction in Phases 6 through 6d was keyed this way. It was self-consistent, so
it worked, but it could not tell two different actions apart.

### Three smaller ones

- The unit tests wrote `TEST-*` directories into the real `~/.simframe`, where
  `simframe status` showed them as five phantom devices. Tests now run against a
  temp `SIMFRAME_HOME`, and `status` ignores any directory not named like a UDID.
- `doctor` compiled the daemon mid-run and printed "present, not yet built" in
  output that was already false, and it left a detached daemon behind. It now
  builds before reporting, and stops any daemon it had to start.
- The help text still said "Input needs idb".

### The timings in Phases 6c and 6d are now doubly suspect

Those tours ran with input silently on idb *and* with the daemon being replaced
on every command. Neither figure measures the tool as it now stands. They are
left in place as an honest record of what was measured, and they should not be
quoted.

## The first tour numbers worth quoting

Everything before this was measured on a broken stack: input silently going
through idb at ~285 ms a tap, and the daemon being killed and respawned by every
CLI command. Both are fixed, and this run records its own preconditions — input
driver, daemon pid at both ends, and the count of "superseded" lines — so a
regression in any of them shows up in the measurement instead of hiding inside
it.

Four-tab tour, iPhone 17 Pro (iOS 26.5), M4 Pro, graph and screen maps cleared
first. One daemon throughout, zero new "superseded" lines, input over the
control socket.

| Pass | Wall clock | Steps verified `ok` | Controls from memory | Verdicts |
| --- | --- | --- | --- | --- |
| 1 | 10.2 s | 0/4 | **4/4** | all `unverified` — correct, nothing is known yet |
| 2 | **3.6 s** | **4/4** | **4/4** | all `ok` |
| 3 | **3.7 s** | **4/4** | **4/4** | all `ok` |

For scale, the same tour measured 30-58 s per pass on the broken stack. That is
not a 10x improvement in the tool; it is the difference between measuring the
tool and measuring two bugs.

### The transition kind stopped being a verdict

Identity and transition kind are not equally reliable, and the verdict now rests
only on the reliable one. Measured on the passes above, the Phase 4 classifier
disagreed with its own earlier answer on **1, 3 and 2 of 4** steps — calling the
same tab switch `replace` on one run and `pop` on the next — while the screen
landed exactly where predicted every time.

Had kind stayed part of the verdict, that is 25-75% of correct steps reported as
failures. A verdict that says something is wrong when nothing is wrong trains
you to ignore verdicts. The mismatch is still reported, as `kindDiffers` inside
an `ok` verdict, and a `kind-noise` column is now measured alongside `ok` so
that trading this signal away would be visible rather than assumed.

### Variants fired on a real app, and the checker did not know

While the app was reconnecting to its bundler it put an alert over one screen,
giving that screen a second genuine structure. The variant mechanism admitted it
correctly — one node with `variants=1` instead of a fifth screen appearing.

`verdict()` still reported `unexpected-screen`, because it compared the observed
fingerprint to the predicted one as strings. That was right when a screen had
exactly one fingerprint; once a node answers to several it is wrong by
construction. The verdict now asks the graph whether both fingerprints resolve
to the same node. The feature had worked and the check around it had not been
updated to match.

### OCR was shelling out to simctl on a machine whose daemon had the frame

`fullFrameFor` trusted `state.json`'s `fullFile` pointer and fell straight
through to `simctl io screenshot` when that file was missing. The pointer names
a frame that **retention routinely thins away** — observed locally naming
`full/2475.png` while the directory held 2470, 2869 and 2870 — so a share of
every machine's screen-map builds paid a shell-out for a screenshot the daemon
had already written.

On CI it was fatal rather than merely slow: the shell-out failed and took the
whole step with it, reporting only "Command failed: xcrun simctl io …" with
simctl's reason left in an unread stderr. Both `screenshot` and `launchApp` now
surface that stderr, for the same reason a silent fallback is unacceptable.

`fullFrameFor` now falls back to the newest frame in the daemon's own `full/`
directory before considering simctl. Verified by deleting the exact frame the
state pointer named and confirming the flow still completes.

### A still screen looked like a dead capture loop

`liveness()` reported `capture loop is stalled: newest frame is 2984ms old`
whenever the newest frame was older than the threshold. That was correct for the
`simctl` engine, which captures at a fixed rate, and wrong for `simframed`,
which captures on damage: a genuinely still screen produces **no frames at
all**, which is exactly the state `settle` exists to detect.

So a flow that settled on a static page failed immediately after a step had
succeeded. The pid check is the honest liveness signal for a damage-driven loop;
the heartbeat file cannot substitute, because clients write it, not the daemon.
The age check now applies only to the fixed-rate engine.

This is the same mistake as two earlier versions of the CI flow assertion —
expecting frames from a screen that is deliberately not producing any. Three
instances of one wrong assumption, in three different places.

---

## Phase 7 — what Claude sees

Machine: M-series Mac, Xcode 26, iOS 26.5, iPhone 17 Pro simulator, capture
engine `simframed`, input driver `simframed`, OCR on, accessibility via idb.
App under test: a real production React Native app with a five-tab bar, live
dashboard tiles and two long list screens. Ten steps, driven through the MCP
server over stdio by a harness that counts blocks, images and characters —
because "how many images does this return" is not a question to answer by
reading the code.

### The headline

A ten-step flow, five consecutive runs after the graph had learned the route:

| | Steps | Tool calls | Images | Text chars | Est. tokens | Wall clock |
| --- | --- | --- | --- | --- | --- | --- |
| run 1 | 10/10 ok | 1 | 0 | 1700 | ~490 | 5.5 s |
| run 2 | 10/10 ok | 1 | 0 | 1621 | ~463 | 5.6 s |
| run 3 | 10/10 ok | 1 | 0 | 1685 | ~481 | 5.0 s |
| run 4 | 10/10 ok | 1 | 0 | 1621 | ~463 | 5.9 s |
| run 5 | 10/10 ok | 1 | 0 | 1620 | ~463 | 5.1 s |

The phase asked for ≤3 model turns and 0 images for a flow whose screens are in
memory. It is **1 turn and 0 images**, because a flow is one tool call and
nothing in it returns a frame any more.

The wall-clock column here did not survive a re-run — see below.

Token estimates divide characters by 3.5. That is an estimate, not a
measurement — there is no tokenizer in this repo, and the character counts are
the measured figures.

### What an image actually cost

Measured on the same screen, `--detail=normal` (700 px long edge):

| | Size | Est. tokens |
| --- | --- | --- |
| PNG | 107,248 bytes | — |
| base64 of it | 143,000 chars | ~41,000 if handled as text |
| as a native image block | — | ~1,600 (published figure) |
| the compact text map of that screen | 1,159 chars, 29 lines | ~330 |

So the map is roughly **5× cheaper than an image handled correctly, and 120×
cheaper than one handled the way claude-code issue #31208 describes** — where
41,000 tokens would also blow through the 25,000-token tool-result ceiling and
be truncated. And unlike the image it carries tap points, so nothing has to be
measured by eye.

Every model-facing image is now capped at 1024 px on the long edge.
`detail: 'full'` no longer reaches a model at all; the CLI can still write a
native-resolution frame to a file, where it costs nothing.

### Folding the map down

The first version of the map, run against a real screen, was 36 rows for 25
controls. The accessibility tree and OCR each describe the same control, and
the screen map keeps both on purpose — identity is computed from that list, so
dropping a target would change what a screen *is*.

So the folding happens in the presentation and the fingerprint never sees it:

| | Rows |
| --- | --- |
| raw targets | 36 |
| after folding OCR text into the control it is printed on | 30 |
| after dropping containers (a tab bar is not a thing you tap) | 26 |
| after dropping punctuation-only OCR and redundant aliases | 25 |

The rule that separates a dashboard tile from a tab bar is not size — they are
the same few thousand square points — it is how much text a candidate would
absorb. A control's visible text is a fragment or three; a container swallows
five, and a tab bar that ate its own tabs would leave nothing to tap.

### Two bugs the measurement found

**A fingerprint that expires at midnight, again.** Phase 6d removed a date
banner from one screen's identity. Dumping the structural tokens of all 20
learned screens found it back through a different door: three screens carried
content in their identity because the positional region bands had called it
chrome — a store address, a phone number, and a nav title reading *"Tuesday,
September 8"*. That last screen's identity had until midnight to live.

The band misclassification is the root cause and is still deferred. What is
fixed is the narrower question: a chrome label that is a date, a time, a phone
number, a price or a bare count is a *value*, not a name, and values change
while the screen stays the same screen. Two of the three cases are gone; the
third (a stable-looking store address in a misfiled list row) is not, and no
text pattern can see why it is wrong. After the fix, 0 of the rebuilt screens
carry a date-like label.

**A flow that halted reported success.** `ok` on a script result meant only
"nothing threw". A flow stopped dead at step 0 by an `unexpected-screen`
verdict came back saying *"flow completed"* with `isError: false` — the exact
shape of silent failure the verdict exists to prevent. Found because the CLI
now prints verdicts in `do`, which it never used to. Fixed, and the decision is
now a pure function with a test rather than a condition inside a loop.

### One inconsistency worth naming

The map folds two readings of one control into one row. `locate` did not, so a
map showing a single row `Location (All) ~ Location (AII)` was followed by a tap
refusing as ambiguous between them — two candidates one point apart. Asking
which was meant is not caution there, it is a question with no answer: either
tap lands on the same pixel. Candidates within 12 points of each other are now
collapsed before ambiguity is declared, and the accessibility element wins
because it is the real hit target. Two controls genuinely far apart — "Work
Orders" as both a nav title and a tab, 746 points apart — still ask.

### Cost of the tool surface

20 MCP tools, 15,996 characters of schema, ~4,570 estimated tokens, paid once
per session. Eight of the twenty are single-action tools the phase asked for
(`sim_tap`, `sim_type_into`, `sim_scroll_to`, `sim_wait_for`, `sim_assert`,
`sim_launch`, `sim_open_url`, `sim_permission`). Each is one `sim_do` step
under the hood, so they verify identically, and every description points back
at `sim_do` for anything longer than one step — a per-step tool costs a round
trip that a batch does not.

### What is not measured here

Turn count for a flow whose screens are **not** in memory. A first pass through
new screens is mostly `unverified` verdicts and costs a map read per novel
screen; the five runs above are all warm. The cold number belongs with the
Phase 6 tour numbers, and the honest version of it is still the 10.2 s figure
recorded there.

### Re-run: the wall clock was not ~5 s

Six more warm runs of the same ten-step flow, later the same day, on the same
machine and the same app:

| Batch | Runs | Wall clock | Model turns | Images | Text chars |
| --- | --- | --- | --- | --- | --- |
| first | 5 | 5.0–5.9 s | 1 | 0 | 1620–1700 |
| second | 6 | 6.6–7.4 s | 1 | 0 | 1621–1661 |

Eleven runs, and the honest figure for wall clock is **5.0–7.4 s**, not ~5 s.
Nothing about simframe changed between the batches; the app's own loading did.
What did not move across any of the eleven runs is everything the phase was
actually about: **1 turn, 0 images, 1,620–1,700 characters.** Those are the
numbers to quote. The wall clock belongs to the app under test as much as to the
tool, and quoting the first batch alone would have been the fourth time in this
project that a measurement agreeing with the hypothesis went unrepeated.

---

## Phase 2a baseline — what the last idb dependency actually costs

Taken before starting Phase 2a, to answer "would removing idb change any
published number?" rather than assume it. Same machine and app as Phase 7.

### The accessibility read against the OCR it runs beside

Both warmed first, then twelve alternating reads of the same screen (33
accessibility targets, 34 OCR elements):

| Path | N | Median | Range |
| --- | --- | --- | --- |
| accessibility tree via `idb ui describe-all` | 12 | **255 ms** | 249–352 ms |
| OCR in-process, off the framebuffer | 12 | **123 ms** | 114–138 ms |

They run concurrently, so a screen-map build costs the slower of the two: the
**~305 ms first visit is accessibility-bound, and idb is twice OCR's cost.** At
Phase 2a's 60 ms target the build becomes OCR-bound at roughly 130 ms.

### How often a flow reads the tree

Counted, not reasoned about, with a logging shim ahead of the real `idb` on
`PATH`:

| Ten-step flow | `ui describe-all` calls | Wall clock |
| --- | --- | --- |
| warm — screens and graph in memory | **0** | 6.6–7.4 s |
| cold — `screens/` and `graph/` cleared | **14** | 17.0 s |

Zero, warm. Screen memory answers from a file and the tree is never asked, so
**every warm number simframe publishes is already independent of idb** — which
is a stronger result than the "idb is only needed for the accessibility tree"
claim, and the opposite of what the CI work assumed twice.

Cold, 14 reads at 255 ms is ~3.8 s, about 22% of a cold run. At the 60 ms target
that is 0.8 s, so Phase 2a should take a cold ten-step flow from ~17.0 s to
roughly **14.0 s** — a real gain, entirely on the first pass through unfamiliar
screens.

### What this does not do

Phase 2a changes *who reads* the accessibility tree, not *what the app
publishes*. The custom tab bar with no children, the icon buttons carrying
private-use glyphs, the React Native text inputs absent from the tree — those
are the app's, and OCR will still be what carries those screens afterwards. The
case for 2a is the install story (idb is the last heavyweight requirement), plus
the cold path. It is not a perception-quality improvement, and nothing in the
warm path moves at all.

---

## CI for the memory layer, and the four bugs writing it found

The integration job asserted capture, input and OCR. Everything above them —
the screen map, element refs, the transition graph, verdicts, saved flows,
`goto` — had no coverage at all, which is where every expensive bug in this
project has lived: the state version that had drifted so every command
respawned the daemon, `tap <label>` crashing on any screen the graph
recognised, a tap and a type sharing one edge, a halted flow reporting success.
Each was found by hand or by somebody else running the tool. None by CI.

`scripts/ci-memory.mjs` is now a required step. It drives the real CLI, so it
tests what an agent actually calls, and it runs OCR-only because idb is not
installed on a hosted runner — which is the point: a warm flow makes zero
accessibility reads, and this is what holds that claim up.

### A stale ref resolved on the wrong screen

The worst of the four, and it was in Phase 7's own work. A ref is only
meaningful while the screen it was numbered on is showing, so `resolveRef`
compared the current pixel layout hash against the one the numbers were
assigned on, refusing beyond a Hamming distance of 20 in 288 bits.

Measured: refs numbered on the springboard resolved happily on a completely
different screen. **A dark or near-uniform screen hashes to almost all zeros,
and two degenerate hashes sit within any sane tolerance of each other** — the
guard was comparing two absences of evidence and finding them similar.

The fix is not a tighter tolerance. Structural identity now decides, fetched
from screen memory, which is a file read rather than a perception pass — so a
ref still costs nothing. The pixel check survives as a backstop that only
speaks when the hash carries at least 16 set bits, and a screen simframe does
not recognise at all refuses outright.

### Two commands that needed a live daemon and should not have

`simframe screens` and `simframe flow list` are directory reads, and both went
through `ensureDaemon`. So a device whose capture had stopped could not list the
screens and flows already sitting on its disk: the tool went blind about things
it already knew, at exactly the moment you would want to ask.

### `--json` did not survive failure

Phase 7 put `--json` on every command's success path and none of its failures.
The top-level handler printed `simframe: <message>` to stderr, so a caller that
asked for machine-readable output got a `SyntaxError` from `JSON.parse` and no
way to tell "the daemon lost the display" from "simframe is broken". It now
emits `{ok: false, error}` whenever `--json` was passed.

### What the check deliberately does not assert

That every pass converges to all-`ok`. The springboard is the worst screen on
the device to demand that of — a live weather widget and a clock give it several
genuine settled structures against a cap of four variants — and measured over
four passes the `home` step read `[ok, unverified]`, `[ok, ok]`,
`[ok, unexpected-screen]`, `[ok, unexpected-screen]`. That is the known
multiple-structures problem in `docs/DEFERRED.md`, and a CI check demanding
otherwise would be flaky about something simframe does not claim.

What it asserts instead is exact: an action never taken here before reports
`unverified` (asked with a URL nobody has opened, so it is novel by
construction); once seen, the outcome is predicted; and **a run that reported a
wrong turn never also reports success** — the Phase 7 silent-failure bug,
pinned.

### A note on the two blackouts

The simulator wedged on a blank screen twice while this was being written, both
times during the check, and had to be restarted. I cannot say the check caused
it: the device had been under heavy use for hours by then, and the daemon's
behaviour throughout was correct — it reported "the display surface could not be
read" rather than serving a stale frame, which is exactly right. The check is
now gentler (three convergence passes, not four, with a pause between them) and
opens with a liveness assertion, so a wedged device produces one clear
diagnosis instead of a dozen unrelated failures.

### The bug that broke three runs of this check

Capture stopped and never came back, three times in one session. Twice I read
it as a wedged simulator and asked for a device restart; the third time the
device was awake and visibly fine, which settled it:

| | |
| --- | --- |
| old daemon, device untouched | `the display surface could not be read`, newest frame **353 s** stale, ~6 minutes, never recovered |
| fresh daemon, same device, nothing else changed | frame #1 at **60 ms** |

`attach(udid:)` resolves the display port once — several IO ports conform to
`SimDisplayIOSurfaceRenderable` and only the one with a non-zero `displaySize`
vends a surface — and caches that descriptor. The simulator can tear that port
down and build a new one under a live daemon, and every `framebufferSurface`
read on the cached object returns nil from then on. The capture loop logged the
failure, slept half a second, and did it again forever.

Reporting the failure loudly was right. Never recovering was not, and the only
cure was a restart nobody would think to try, because the message points at the
display rather than at the handle on it.

Fixed: `reattachDisplay()` re-resolves the port on the device already attached,
and the capture loop calls it after six consecutive failed reads (~3 s at the
loop's back-off), re-arms the damage callback, and logs that it did. Input is
deliberately left alone — the HID session is independent of the display port and
survives it being replaced, so tearing it down to fix capture would break the
half that still worked.

**Not covered by a test.** A port teardown cannot be induced on demand, and the
capture loop is inline in `main.swift` rather than factored into something a
stub can drive. `StubPlatform` counts `reattachDisplay()` calls so the loop
could be tested once it is extracted; that is in `docs/DEFERRED.md`.

---

## Region bands from clustering

The bands decided what counted as chrome by fraction of screen height, and
because chrome labels are the only text that enters a structural fingerprint,
every misclassification landed in a screen's identity. Three phases paid for
that. The fix derives the bands from where the elements themselves sit: chrome
is separated from content by a gap that is an **outlier relative to that
screen's own row spacing**, which is also how a detector concludes a springboard
has no nav bar at all.

### Measured either side, with `scripts/eval-fingerprint.mjs`

Four device-native screens (Settings, a static web page, Reminders, Contacts),
three rounds, every reading cold. Jaccard over structural token sets.

| | positional bands | clustered bands |
| --- | --- | --- |
| same screen, revisited (min) | 1.00 | 1.00 |
| different screens (max) | 0.04 | 0.05 |
| gap | 0.96 | 0.95 |
| threshold 0.36 inside the gap | yes | yes |
| **chrome labels entering identity** | **14** | **6** |

No regression in either distribution, and the point of the change lands in the
last row. What stopped entering identity: `dictate`, `screen time`, `settings`,
`continue`, `q search`, `a`, `+` — controls and content that the positional
bands had filed as chrome. What survived is a browser's actual toolbar.

### The case chrome labels exist for

A gap-based rule could have thrown out real nav titles along with the noise, and
the four screens above are too structurally distinct to notice. So the tour
gained the adversarial pair: **Settings → General and Settings →
Accessibility**, two lists under a nav bar with near-identical structure, told
apart by their title and nothing else.

| six screens, clustered bands | min | median | max |
| --- | --- | --- | --- |
| same screen, revisited (n=18) | 0.67 | 1.00 | 1.00 |
| different screens (n=135) | 0.00 | 0.00 | 0.05 |

Gap **0.62**, threshold inside it, and the adversarial pair sits at **0.05** —
they stay separable because `general`, `accessibility` and the `settings` back
label all still enter identity. Nine chrome labels survive across the whole
tour and every one of them is a real piece of chrome.

The weakest same-screen pair is `settings-general` against itself at 0.67: a
sub-page whose fingerprint varies by a token or two between visits. Comfortably
above 0.36, and worth watching.

### Five measurements that were measuring something else

This section is longer than the result, and it is the more useful half.

**1. The harness's own tour.** The first version used a `settle` step between
screens. `settle` defaults to mode `stable`, which is documented to return
instantly in the moment before an animation begins — so readings were taken on
the previous screen, two different screens produced the same fingerprint, and
the harness reported that the distributions overlapped completely and identity
was impossible. Action steps already settle against a baseline captured before
them; the explicit step was not just redundant but harmful.

**2. The arrival check that passed a failure.** After fixing the tour, the
harness compared consecutive screens by *hash* and let anything through that
differed. A "springboard" reading that was really Settings shared **11 of its 12
tokens** with the Settings reading beside it and differed in one, so the hashes
differed and the check passed. It now compares by similarity and refuses to
report any distribution when two consecutive tour screens exceed 0.7.

**3. The 0.88 different-screen ceiling.** Measured before those two fixes and
genuinely alarming: two unrelated screens 0.88 similar against a threshold of
0.36 would mean identity could not tell them apart. It was entirely the artifact
above. On a valid tour the ceiling is 0.04.

**4. `press home` reports success and does nothing.** The reason those readings
were of the wrong screen. On a long-running daemon the Indigo HOME press returns
`press in 64ms via simframed` and the screen never moves; on a freshly started
daemon the same press works. Recorded separately below.

**5. A cell and the text printed on it, called ambiguous.** Blocking the
adversarial pair entirely: `tap "General"` refused because the accessibility
cell spans the row (centre 201,326) and the OCR text is left-aligned inside it
(centre 102,327). A hundred points apart, one tap target. The 12-point collapse
from Phase 7 could not see it; containment can, and the screen map had been
folding that pair correctly all along — `locate` has now caught up with it.

## `press home` succeeds and does nothing

Input is the one path with no feedback. A dispatched Indigo message reports
success when the *send* succeeds, and nothing asks the device whether it acted —
so `simframe press home` returned `press in 66ms via simframed` while the screen
sat frozen, and a flow using it silently drove the wrong screens. It had been
visible all along as `no-visible-change` verdicts in the CI memory check, which
I read as screen noise.

### Chasing the cause, and three wrong theories

| Theory | Test | Result |
| --- | --- | --- |
| The HID session goes stale with daemon age | tap and press on a 16-minute-old daemon | both worked — not age |
| `resetHIDSession` will recover it | reset, then press, on a failing device | still dead — not the client |
| The `up` op is wrong, so HOME sticks down | fresh iOS 18.0 device, then fresh iOS 26.5 device, 4 presses each | **8/8 worked** — a wrong release would fail on the second press anywhere |

The last one had me telling the user that simframe was probably wedging their
simulator into the black screens they had been restarting through. It was not:
two clean devices took eight consecutive presses without sticking, and their own
device took three immediately after a restart. I said it before I had the
evidence, and the evidence contradicted it.

### What it actually is

Device state, on a simulator that has been under heavy automation for hours. It
survives a daemon restart and is cleared by a **device** restart. It is not
reproducible on a fresh device of either iOS version, so there is nothing in
simframe to fix at the source and no claim here about the mechanism.

### What was simframe's to fix, and is fixed

Reporting it. A failure that announces itself is the whole policy, and this one
announced success.

- `simframe press` now compares the frame hash either side and says whether the
  screen moved — deliberately without accusing anything, because pressing home
  while already on the springboard legitimately changes nothing and a warning
  that cries wolf is how a real one gets ignored.
- A `button` step inside a flow that produces no visible change rebuilds the HID
  session and retries once, saying so in the step detail. Only buttons: home and
  lock always move the screen, so nothing moving is unambiguous, whereas a tap
  that changes nothing is ordinary and retrying one could act twice. Retrying an
  action that provably did nothing is not a repeat — it is the first attempt
  that counts. Bounded to one recovery per run.
- `resetInput` is now a control-socket action, so the session can be rebuilt
  without restarting the daemon.

The retry does not fix the device-state case — the reset was measured not to
help there. It fixes the case where the session, rather than the device, is the
stale thing, and in every case it turns a silent failure into a visible one.

---

## Phase 2a — the accessibility tree, host-side

Machine: M-series Mac, Xcode 26, iOS 26.5, iPhone 17 Pro simulator. Same device
and same screens as the Phase 2a baseline above, which predicted what this
should be worth before it was attempted.

The tree is now read in the daemon through `AXPTranslator`, with nothing
injected into the guest and no `NSView`. What unblocked it — two mistakes, not
the four leads the baseline listed — is in `docs/PRIVATE_API.md`.

### The read itself

Both paths warmed, then twelve alternating reads of the same screen. Two
screens, because the baseline's 255 ms was measured on a screen with 33 targets
and these are device-native ones; measuring both paths on the *same* screen is
what makes the comparison hold regardless.

| Screen | Elements | `idb ui describe-all` | host-side, in-process |
| --- | --- | --- | --- |
| Settings, root | 15 | 222 ms (214–230) | **47 ms** (45–51) |
| Settings › General | 14 | 203 ms (194–212) | **45 ms** (44–46) |
| Settings › Search, confirmed independently | 16 | 224 ms (201–310) | **55 ms** (47–62) |

The element count is whatever the screen was showing, and both paths always
reported the same one. The third row is a separate reviewer reproducing this on
their own; their idb median is higher and their host-side median is higher too,
because both runs had idb subprocesses competing for the machine. Their quiet
follow-up put the daemon's own `axMs` at 42–43 ms.

The phase's target was 60 ms warm. In-process OCR on the same screens is 108–146
ms, so **the first visit is now bound by the pixels, not by the tree** — the
reverse of the baseline, which is exactly what the baseline predicted would
happen at 60 ms.

A read taken just after switching apps costs 700–900 ms once, while the guest
populates, then settles back. An app still launching genuinely has no tree yet
and returns the application node alone; that is reported as it is rather than
retried until it looks populated.

### A cold flow, four runs each way

Eleven steps inside Settings, taps only — no app launches, because a three-second
cold launch per step buries the signal. `SIMFRAME_AX_DRIVER=idb` selects the old
path, so this is the same tour, same device, same session.

| Tree read by | N | Median | Range |
| --- | --- | --- | --- |
| idb | 4 | 20.0 s | 19.4–20.1 s |
| host-side | 4 | **17.3 s** | 16.9–18.0 s |

**2.7 s**, non-overlapping. The tour makes 14 tree reads cold, and 14 × 158 ms
predicts 2.2 s — the same order, 23% under. Close enough to say the flow-level
saving is the tree reads and not something else; not close enough to call the
two numbers agreement, which an earlier draft of this line did.

The first attempt at this measurement did not. A ten-step tour built out of app
launches gave 40.0 s against 45.2 s with a warm spread of 20.4–29.9 s — a
difference well inside its own noise, from an instrument measuring six cold app
launches rather than fourteen tree reads. The number only became trustworthy
once the launches came out of the timed window.

Warm is unchanged, and was always going to be: a warm flow makes zero
accessibility reads, which the baseline established before any of this was
built.

### Nothing idb finds is missing

The phase's own verification, on the three screen kinds it named. Labelled nodes
compared by label and by frame, at the same moment:

| Screen | idb | host-side | Missing here | Extra here |
| --- | --- | --- | --- | --- |
| a native list (Settings) | 16 | 16 | 0 | 0 |
| a WebView (Safari, example.com) | 6 | 6 | 0 | 0 |
| a React Native app | 2 | 2 | 0 | 0 |

The React Native screen publishing two nodes is not a regression and not
something 2a could have changed: it is what the app publishes, and OCR is what
carries that screen. 2a changed who reads the tree, not what is in it.

### What this removes

idb is no longer required for anything. Capture, input, text recognition and the
accessibility tree all run in one daemon built from source on first use, and
`simframe doctor` reports four `simframed` lines where it used to report one
`idb`. idb stays as a fallback for input and for the tree, and
`SIMFRAME_AX_DRIVER=idb` forces the tree back onto it — every private-framework
path here is version-coupled, and an Xcode upgrade that breaks the host-side
translator should not be the end of someone's day.

### What an independent review found, and what it cost

A separate reviewer was asked to confirm the above rather than accept it, with
the instruction to re-derive the numbers. It reproduced claims 1, 2, 4, 5 and 6
— including verifying the round-trip claim directly (combined `ui` 126 ms
against ax-only 43 ms and OCR-only 126 ms, so the call costs the slower layer
and not the sum) and verifying the idb removal by putting a shim that exits 127
first on `PATH` and watching `simframe ui` render a full map without invoking
it. It also found four defects, all mine, all now fixed:

**A failed daemon read returned an empty screen map, silently, and cached it.**
The worst of the four and the newest: it was introduced by this phase's own
change. When the daemon was listening but the request failed, the rejection was
flattened to null, and the guard that would have rethrown it was skipped —
`build` returned `{sources: [], targets: []}` with no error, and `persist`
defaults true, so that emptiness was written into screen memory under the
current layout hash for the next warm visit to read back. A loud failure turned
into a poisoned cache entry. Before this phase the same situation threw. There
is now a test that stands a socket where the daemon's would be, answers every
request with a failure, and asserts the daemon's own reason reaches the caller.

**A truncated tree was reported as a complete one.** The walk has three ways to
stop early — depth, node cap, time budget — and the bridge has a fourth, a guest
request that misses its deadline and is answered with `emptyResponse`, which
makes that subtree look genuinely childless. All four produced something
indistinguishable from a small screen, and `sources` claimed `ax` regardless.
Since accessibility elements are treated as the real hit targets and then
persisted, half a screen could be remembered as a whole one. The tree now
carries whether it is all of one; a partial tree is returned as nodes with a
reason, and is not claimed as a source, so the caller falls back rather than
trusting it. Verified by dropping the node cap to 3 and rebuilding:
`sources ["ocr"], axCount 3, truncated: the tree has more than 3 nodes, which is
a cycle rather than a screen`.

**The documented escape hatch failed `doctor --strict`.** `SIMFRAME_AX_DRIVER=idb`
graded as a degraded layer, so the thing offered as the answer to "an Xcode
upgrade broke the host-side path" turned CI red on exactly the day you reached
for it. A driver someone selected deliberately is not a silent downgrade, and
`doctor` now says so: `ok idb: … — selected by SIMFRAME_AX_DRIVER`, exit 0
under `--strict`.

**`accessibilityStatus()` reported `ok` without ever reading anything.** It
returned available as soon as the bridge constructed, and constructing only
proves the classes and selectors exist. That is *precisely* the state the first
attempt at this phase was in for a week — bridge fine, transport fine, reads
nothing — and `doctor` would have called it healthy. It now performs a one-attribute
read against the frontmost application before claiming the layer works.

A fifth finding is latent rather than live: the translator is a process
singleton and the bridge caches one device's token, so re-attaching to a
different UDID would have kept reading the first device's tree. Unreachable
today — one device per daemon — but nothing stated the invariant, so `attach`
now clears the bridge when the device changes.

The reviewer's `ci-memory` run also failed once on the stale-ref check with an
all-zeros layout hash, on a device that had been under automation for hours and
blacked out during the session. That is the degenerate-hash class this file
already documents, and structural identity is what is supposed to carry it. It
passed on a re-run and is worth re-checking on a fresh device rather than
assuming it was noise.

---

## 0.6.0, from the published package

The gap `docs/DEFERRED.md` had been carrying since 0.5.0: every number in this
file came from the working copy, and nobody had run a multi-step verified flow
from what npm actually serves. This is that run.

`npm install simframe@0.6.0` into an empty directory, then driven entirely
through `./node_modules/.bin/simframe`. The install built its own daemon from
the tarball's Swift sources — verified by path, so it is not borrowing the
repository's binary:

```
/…/scratchpad/fresh/node_modules/simframe/native/simframed/.build/release/simframed
```

`doctor` reports every layer on the daemon, with nothing installed but Xcode:

```
ok   capture engine (iPhone 17 Pro)      simframed
ok   input driver (iPhone 17 Pro)        simframed: Indigo HID
ok   text recognition (iPhone 17 Pro)    simframed (in-process, off the framebuffer)
ok   accessibility tree (iPhone 17 Pro)  simframed: AXPTranslator, host-side
```

### A ten-step flow, one command

| Pass | Result | Steps | From memory | Verdicts |
| --- | --- | --- | --- | --- |
| cold | halted | 3/10 | 1 | `no-visible-change`, `unexpected-screen` |
| warm 1 | ok | **10/10** | 6 | `unverified`, then `ok` ×8 |
| warm 2 | ok | **10/10** | 6 | `unverified`, then `ok` ×8 |

Warm output is **1,326 characters and zero images**, identical across runs — so
the Phase 7 claim holds from the published package, and slightly better than the
~1,650 measured in the working copy on a different flow.

Two things worth noting rather than glossing:

The cold pass **halted at step 3 and reported `ok: false`**. That is the flaky
first-pass convergence recorded in DEFERRED, and it is the behaviour a new user
meets on their first run — the second pass onwards is stable and stayed stable.
It is also the halt-reporting fix working as intended: a run that stopped on a
wrong turn said so instead of reporting success, which is the failure this
project cares most about not having.

`no-visible-change` on the cold `launch` step is honest rather than wrong: the
app was already frontmost from the `doctor` run before it.

---

## 0.6.1 — what the review changed

Every item an independent review of 0.6.0 raised, closed. The measurements that
moved:

### The first install stopped being worse on its second run

Six consecutive runs of a ten-step flow from a cleared graph, halting enabled:

| | before | after |
| --- | --- | --- |
| run 1 | **halted 3/10** | 10/10 |
| runs 2–6 | 10/10 | 10/10 |
| converged to all-`ok` by | run 2, then oscillated | **run 3, and stayed** |

The cause was a policy error rather than a perception one: `verdict` returned
`unexpected-screen` whether an edge had been seen once or fifty times, and any
`unexpected-screen` halts a run. Run one learns every edge at count 1 and cannot
contradict itself; run two has an expectation for every step and stops on the
first screen whose identity wobbles. A single-observation miss now reports
`unverified`, and so does a miss on an edge that has already reached more than
one destination — which the graph had been recording as `changedOutcomes` while
nothing read it.

### The memory harness went green for the first time

`33/33, exit 0`. Every previous attempt was cut short by the device rather than
by a check failing on its merits, and the best before this was 32/33. Two things
were needed: the harness fixes, and the graph fix above — the transition-graph
section had been asserting convergence within three passes, which was a coin
flip while one observation could halt a run.

### Two wrong-action paths, reproduced and closed

Neither was a performance problem, and the DEFERRED entries had described both
as costing convergence:

- A reading sharing **zero** tokens with an edge's destination was merged into it
  as a second face, after which arriving there returned `ok` — "matches the
  outcome seen 3x before" — so nothing halted and a flow kept walking, tapping
  real controls on a screen its plan never contained.
- `hashTokens([])` was sha256 of the empty string, so every unreadable screen
  shared one structural identity, and `similarity([], [])` returned 1, so two
  unreadable reads agreed and promoted the non-identity to a confirmed screen.
  That defeats all three `resolveRef` guards at once, and a ref numbered on one
  screen resolves onto another and taps it.

### Tree reads, restated honestly

`accessibilityMultipleAttributes:` batches eight attributes into one guest hop:
**112 calls / 25 ms one at a time against 14 calls / 10 ms batched** on the same
fourteen nodes, identical values. The commit that introduced it claimed one call
per node; it is three — one batch, one `accessibilityLabel`, one `AXChildren`.
The eight-fold reduction in round trips is what matters on a slow machine, and
that part stands.

### A bound picked for feel, corrected

The `ui` handler's wait was bounded at 12 s. That number came from a runner that
had once spent 28 s inside a *tree* read — a cost the attribute batching then
removed — so it was calibrated against a problem that no longer existed. A
hosted runner, where Vision has no GPU, then failed a screen read outright with
`text recognition did not finish within 12s`. OCR is 100–400 ms on this machine
and evidently much slower on a shared one; guessing its ceiling was the mistake,
and the guess turned a slow-but-correct read into a failed step.

The bound is now derived rather than chosen: 25 s, just inside the client's own
30 s give-up. A read the caller has already abandoned is worth nothing, and
stopping any earlier only fails reads that would have worked. The reason to
bound it at all is unchanged — the control socket is serial, so a long read
holds up every command behind it.

## Phase 8 — Android, first numbers

Apple M-series, macOS 26, Android 16 (API 36), `Small_Phone_API_36`,
720x1280 @320dpi, emulator 36.1.9, adb 1.0.41. Medians of 5–9 runs.

| Path | Median | Note |
| --- | --- | --- |
| emulator console `screenrecord screenshot <dir>` | **41 ms** | the emulator writes the PNG onto the host filesystem itself |
| `adb exec-out screencap -p`, from a shell | 113 ms | 9 KB PNG across the adb transport |
| `adb exec-out screencap -p`, in process | 401 ms | how simframe would actually pay for it, spawn included |
| `adb exec-out screencap` (raw RGBA) | 218 ms | 3.7 MB — the transfer dominates, not the encode |
| emulator gRPC `setClipboard` | 48 ms cold, 10 ms warm | `node:http2`, no dependency |
| `event mouse` down/up over a held console | 3 ms | the whole reason the session is held open |
| `adb shell input keyevent` | 35 ms | the key path; public API, so no guessing at codes |
| `am start -W -S --activity-clear-task` | 6,117 ms | a cold start with the task cleared, which is what `relaunch` means |
| `adb shell getprop` x5, one hop | 28 ms | the same batching lesson as `accessibilityMultipleAttributes:` |
| `adb shell dumpsys package <pkg>` | 130 ms | the permission read-back |
| `adb shell dumpsys window displays` | 27 ms | names the focused activity — cheap, and not a screen map |
| `uiautomator dump` | **2,012 ms** | the accessibility tree, and the reason it is not wired yet |

**Capture on the second platform costs 41 ms, which nobody expected.** The
plan assumed Android capture would be the emulator's gRPC streaming endpoint
(port 8554, which the clipboard now uses) with a scrcpy-style fallback, and that
`adb screencap` would be the slow stopgap. It turns out the console's
`screenrecord screenshot` writes the frame to a host path with no device-to-host
transfer at all, over a plain TCP socket with no protobuf and no dependency —
an order of magnitude faster than adb as simframe would actually pay for it,
though **not** in the same range as the iOS framebuffer callback's 16-20 ms.
gRPC is still the path to *streaming*; it is no longer the path to a frame.

**This was published as 21 ms and that was wrong.** Four measurements of one
number, each wrong in its own way, kept because the sequence is the lesson:

- **2,400 ms**, which looked like the adb fallback and was one. `completePng`
  looked for the `IEND` chunk type four bytes from the end of the file, which is
  the CRC and never spells anything, so no frame was ever judged complete and
  every capture fell through to adb after a 2 s poll. A fallback that works is
  the hardest kind of bug to see.
- **67 ms**, which was mostly a 10 ms poll interval waiting for a file that had
  already arrived. At 3 ms it read 21 ms.
- **21 ms**, which was not a measurement of a screenshot at all. The console
  emits an extra `OK` after `auth` — its banner — so the script sent `quit` one
  response early and closed the socket while the emulator was still writing the
  PNG, then read the *previous* run's file out of a shared directory. Five
  consecutive runs reporting byte-identical file sizes was the tell, and it got
  explained away as a static screen. This number reached BENCHMARKS, the README,
  PHASES and a commit message before it was caught.
- **41 ms**, phase-timed: the console answers `OK` at 41 ms and the PNG is
  complete the instant it answers, so nothing is spent polling.

The fix for a number that keeps being wrong is not more care. It is timing the
phases separately, so a measurement can never be the sum of one thing finishing
and another thing not having started.

**`uiautomator dump` at 2 s a read is the real problem of the phase.** iOS's
tree went 203 ms → 45 ms by moving the read host-side and batching it; there is
no equivalent move here, because the cost is a fresh instrumentation process per
dump. A resident server (what Appium does) would need an APK, which would be
this project's first runtime dependency. Undecided, and recorded in
`docs/DEFERRED.md` rather than guessed at.

### What the boundary bought, measured in changes not made

`simframe ui` produced a full screen map of an Android emulator — 9 elements
with points, refs and a structural identity — with **no change to any layer
above `src/platform/`**. The frame store, the ring, the dHash, settle, the
fingerprint, the screen map, refs and the graph all ran unmodified on a platform
they were never written for, because the capture loop asks the boundary for a
screenshot and a resize and both are real on Android. The only edits outside
`src/platform/` were to stop *claiming iOS mechanisms* for a non-iOS device:
engine selection, and four lines of `doctor`.

### The two distributions, stated exactly

The number people quote as "the fingerprint margin" is not one number, and
"0.67–0.75 against 0.36" was ambiguous. Precisely:

A screen's identity is a **set of structural tokens** — role, region, nav slot,
quantised width and height, chrome label where the element is plausibly chrome,
quantised anchor, and a one-or-many sibling bucket. Two readings are compared by
**Jaccard similarity** of those sets: `|A ∩ B| / |A ∪ B|`, so 1.00 is identical
and 0.00 is disjoint. **Higher means more alike.** Nothing in the comparison
knows about content: the *text* of a content-region element never enters a
token. Its presence, size and position do.

From that, two distributions over a tour that visits every screen several times:

| Distribution | What it is | Where "fine" lies |
| --- | --- | --- |
| **same screen, revisited** | every pair of readings of the *same* tour screen, taken cold on separate visits | **high** — 1.00 is perfect |
| **different screens** | every pair of readings of *different* tour screens | **low** — 0.00 is perfect |

`graph.SIMILARITY_THRESHOLD` is **0.36**: at or above it, two readings are the
same screen. So the requirement is that the whole same-screen distribution sits
above 0.36 and the whole different-screen distribution sits below it, with room
either side. Measured on an iPhone 17, 36 same-screen pairs across four apps:

| | n | min | median | max |
| --- | --- | --- | --- | --- |
| same screen, revisited | 36 | **0.75** | 1.00 | 1.00 |
| different screens | 240 | 0.00 | 0.00 | **0.05** |

So "0.67–0.75" is the **worst same-screen pair** across runs — the closest any
screen came to failing to recognise itself — and 0.36 is the threshold it must
stay above. It is not a distance, and lower is not better. CI enforces
clearance rather than a bare gap: every same-screen pair at or above
`threshold + 0.10` and every different-screen pair at or below
`threshold - 0.10`, because a wide gap with the threshold at its edge is
exactly where a screen gets misclassified.

The residual instability is one thing only: a content-region text element's
quantised box and its group's anchor move between reads, because OCR decides
where lines break. Six divergent tokens across 36 pairs, all of them
`content/text`.

### Why the obvious fix cannot be applied: Android

The clean fix on iOS is to stop letting content-region text into identity at
all. Simulated over recorded elements by re-running the real tokeniser, it is
dramatic: same-screen min **1.00**, different-screen max 0.10, gap 0.90, against
0.75/0.05/0.70 today.

It would also leave Android with no identity. Measured on `Small_Phone_API_36`,
tokens per screen and where they come from:

| Screen | Tokens | Regions | Roles | Chrome labels |
| --- | --- | --- | --- | --- |
| launcher | **1** | nav-bar 1 | text 1 | 0 |
| Settings root | 9 | content 9 | text 9 | 0 |
| example.com in Chrome | 6 | content 3, nav-bar 3 | text 6 | 3 → **0** |

Every token on every screen has role `text`, because without an accessibility
tree nothing infers a button from a rectangle reliably enough to say so. Two of
those three screens carry **no chrome label at all**, and Settings' root is nine
content-text tokens and nothing else — so the iOS fix would take it to zero
tokens, and `hashTokens([])` is deliberately `null`, which is "no identity" and
means no screen memory, no refs, no graph.

**Android identity is therefore weaker by construction until Phase 8b**, and
weak in three specific ways rather than vaguely:

1. **Thin.** One token on the launcher. A one-token identity matches anything
   else with that token, and there is no margin in a Jaccard of one element.
2. **Single-roled.** Everything is `text`, so the structural half of the
   fingerprint — "the same kinds of thing in the same places" — has only one
   kind of thing to work with.
3. **Content in identity.** The three "chrome labels" on the browser screen are
   `"== example.com"`, `":"` and `"+"`. The first is a URL, so a different page
   is a different screen; the other two are OCR reading punctuation off icons.
   The positional region bands put the URL bar in `nav-bar`, and chrome labels
   are the one text that enters identity.

That third one was **not** the region-bands bug, and mistaking it for one is
worth recording. The bands are clustered, not positional, and they were right:
Chrome's address bar *is* chrome — a short row at the top with a gap under it.
The fault was one layer along, in which labels are allowed to be names.
`isVolatileLabel` rejected dates and mostly-digit strings and accepted a URL,
a colon and a plus sign.

Fixed in `TOKEN_RULES_VERSION` 3: a chrome label needs at least two letters and
must not be an address, matched after stripping the punctuation OCR decorates it
with. Measured either side —

- **Android**, the case that motivated it: the same Chrome screen went from
  three chrome labels to none, so a different page is no longer a different
  screen.
- **iOS**: chrome labels entering identity fell from 9 to 8 — the one lost was
  `"..."` — and the distributions did not move: same-screen min 0.75, median
  1.00, different-screen max 0.05, gap 0.70, with `general`, `accessibility`
  and `settings` all correctly retained.

A URL in a fingerprint is worse than it sounds, and worth stating for whoever
meets it next: it does not degrade recognition, it *inverts* it. Every visit to
a browser on a new page mints a new screen, the graph fills with screens that
will never be seen again, and every route through the browser breaks the moment
the page changes.

## What the accessibility tier is actually worth

Measured 2026-09-09, because two decisions rested on it and neither had a
number: how hard to push the tree on iOS, and whether Android's missing tree
justifies shipping an APK (`docs/DEFERRED.md`, Phase 8b).
`scripts/eval-ax-tier.mjs` walks a tour and reads every screen **twice from the
same frame** — once with the tree and once without — persisting neither.

iPhone 17, iOS 26.5, six screens across four Apple apps, two rounds, 12
readings, 334 elements.

### Where a screen's elements come from

| | Count | Share |
| --- | --- | --- |
| From the tree, OCR saw nothing there | 90 | 27% |
| From OCR/CV alone | 204 | 61% |
| From the tree, with OCR text inside it | 40 | 12% |
| **Interactive elements** | **72** | |
| …of which the tree supplied | 72 | **100%** |
| …of which have no text at all (icons) | 60 | **83%** |

The first three rows are a partition and the way they are counted matters:
agreement between the sensors is not recorded in an element's `source`. When
OCR text falls inside an accessibility element the map keeps the element and
files the text as an *alias*, so `source` stays `ax` — counting sources alone
reports that the two sensors never see the same thing, which was this
harness's first, wrong answer.

**Every interactive element came from the tree.** Not most — all 72. OCR and CV
produce text, and nothing in that pipeline infers a button from a rectangle
confidently enough to say so, which is why an OCR-only reading of these screens
has zero elements with an actionable role. And 83% of those controls carry no
text at all: they are icons, so there is nothing for OCR to read even in
principle.

### Tier on, tier off

| | tree + OCR | OCR/CV only |
| --- | --- | --- |
| elements per reading | 27.8 | 21.3 |
| screens recognised on revisit | 6/6 | 6/6 |
| weakest revisit similarity | 0.71 | 0.67 |
| intents resolved correctly | **26/28 (93%)** | **22/28 (79%)** |

**Screen memory does not need the tree.** Every revisit was recognised either
way, and the weakest similarity barely moved. That is worth knowing on its own:
the tier earns its place in *acting*, not in *recognising*, which is exactly the
half Android is missing and exactly why Android reads well and acts with less
certainty.

**Intent resolution is where it shows, and the failure modes differ.** Without
the tree: `refresh` and `Address` on the browser resolve to *nothing* — both are
icon-only, so OCR has nothing to match — and `Back` on Contacts resolves to
`"B"`, the section-index letter. That last one is the dangerous shape. A refusal
tells a caller to look again; a confident wrong answer taps the wrong thing, and
that is one in fourteen of these intents.

With the tree, the two failures are both `"Kate Bell"` reported as *ambiguous*,
because a contact row arrives as a row and as its own text and the two score
within the ambiguity margin. Filed in `docs/DEFERRED.md`; a refusal that asks
for an index is the safe failure, but it is still a failure.

### What this settles

**On iOS:** the tree is not an optimisation, it is the whole of role
information. Any change that risks it — an Xcode upgrade moving a private
symbol, say — costs 100% of interactive-role knowledge and 14 points of intent
accuracy, and `SIMFRAME_AX_DRIVER=idb` exists for exactly that reason.

**On Android:** what an APK would buy is now a number rather than an intuition.
83% of the interactive controls on these screens have no text, so on a platform
with no tree they cannot be named at all; the OCR-only condition is a fair model
of Android, and it resolved 79% of intents with one mis-resolution in fourteen.
That is the cost of Phase 8b staying unbuilt, and it is a real cost rather than
a theoretical one — but it also shows Android is not blind: 79% is a working
tool, and screen memory is unaffected.

One caveat, stated because it bounds the whole table: these are Apple's own
apps, which have unusually complete accessibility. A third-party app with poor
labelling shifts the tree's contribution down, and an app with icon-only
navigation shifts it up.

## Phase 10 — instrumentation: the first HPI numbers

Apple M2 Pro, Xcode 26.6, iPhone 17 Pro on iOS 26.5, capture/input/OCR/tree all
`simframed`. Flows are `flows/hpi-suite.json` — stock apps only, because these
numbers get committed to a public repo. N=5 both sides, medians with quartiles,
because with N=5 a median alone hides the spread and the spread is part of the
finding.

Phase 10 changed no perception and no action behaviour. This is a measurement of
0.8.0, and it is the denominator every later phase is compared against.

### The human side — measured, not assumed

One person, five runs per flow, on this same booted simulator, at a natural
pace after practice runs.

| flow | taps | runs | p50 | IQR | min–max | median gap between transitions |
|---|---|---|---|---|---|---|
| `settings-larger-text` | 4 | 5 | **7799 ms** | 498 | 7487–8180 | 3682 ms |
| `contacts-kate-bell` | 2 | 5 | **4300 ms** | 1055 | 3714–5301 | 978 ms |

An IQR of 498 ms on a 7.8 s flow is a tester who knows the flow, which is what
a baseline is supposed to measure. Nine runs of the Settings flow were
recorded; the first four are marked excluded in the log — a capture task had
wedged the device, and one of them recorded 2.2 s with zero transitions. They
are annotated rather than deleted: a measurement log that gets edited when the
numbers are inconvenient is not evidence, so the runs stay carrying why they do
not count, and `summarizeRuns` skips them.

### The agent side

| flow | min steps | runs | p50 | IQR | min–max | ms/step | model turns |
|---|---|---|---|---|---|---|---|
| `settings-larger-text` | 4 | 5 | **13977 ms** | 4591 | 11982–18270 | 3494 | 1 |
| `contacts-kate-bell` | 2 | 5 | **10407 ms** | 1204 | 10360–12517 | 5204 | 2 |

### HPI, first reading

Measured warm, N=5 per flow, against the human baseline above:

| | |
|---|---|
| `HPI_time` `settings-larger-text` | **0.558** — the agent takes 1.79× the human's time |
| `HPI_time` `contacts-kate-bell` | **0.413** — 2.42× |
| `HPI_time` overall (harmonic mean) | **0.475** |
| `HPI_accuracy` | **0.5** |
| **`HPI`** | **0.237** |
| `step_ratio` | **1.0** (target ≤1.5) |
| model turns, median per flow | 1.5 |

Read plainly: **the agent is about twice as slow as a human and half as
accurate**, and it wastes no steps getting there. Both halves have a single
named cause, which is the point of measuring.

Accuracy is 0.5 because `contacts-kate-bell` fails on every run, refusing
rather than guessing, on the contact-row ambiguity already filed in
`docs/DEFERRED.md` and quantified in `docs/ESCALATIONS.md`. One fix is worth
the whole 0.5.

### The same code, measured three times

This matters more than any single number above, and it was found by running the
gate rather than by reasoning about it:

| run | conditions | `HPI_time` | `HPI_accuracy` | settings p50 / IQR | contacts p50 / IQR |
|---|---|---|---|---|---|
| A | warm device, N=5 | 0.475 | 0.5 | 13977 / 4591 | 10407 / 1204 |
| B | after a capture wedge and a SpringBoard crash, N=3 | 0.413 | 0.167 | 15376 / 5006 | 12325 / 1198 |
| C | freshly restarted device, N=5 | 0.406 | 0.5 | 19199 / 5803 | 10570 / 110 |

Identical code, identical flows, identical human baseline. **`HPI_time` spans
0.406–0.475 — a 17% spread — against a gate threshold of 10%.** Run B is a
legitimate catch: accuracy fell to 0.167 because SpringBoard crashed and two
runs landed on the wrong screen, and the gate should fail that. Runs A and C
differ only in how warm the simulator was, and the gate fails C against A.

The variance is not spread evenly. `contacts-kate-bell` is stable to ±110 ms
in the best run; `settings-larger-text` carries an IQR of a third of its own
median in every run. A four-step flow whose per-step cost swings by seconds is
the signature of waiting being waited out rather than observed — the same
conclusion "where the time goes" reaches below, arrived at from a different
direction.

**The committed baseline is run C, the cold one**, on the reasoning that CI
boots a fresh simulator for every job and would otherwise be compared against a
warmth it never has. That removes the systematic half of the problem and not
the random half; `docs/DEFERRED.md` records what is left, because the 10%
threshold is a fixed decision in `CLAUDE.md` and now has data it did not have
when it was made.

### Where the time goes

`step_ratio` is exactly 1.0 on both flows: the agent takes precisely the
authored minimum number of steps. Nothing is being wasted on wandering — the
cost is per step, ~3.5 s on Settings against a human's 3.7 s median gap between
transitions, which sounds like parity until you notice the human's gap includes
reading the screen and deciding, while the agent's does not.

Not measured per-component here, because instrumenting perception is what this
phase's prompt forbids. What is known from the numbers already in this file:
each action step pays a settle wait plus a structural-identity reading, and the
before-reading is carried forward from the previous step, so the marginal cost
is one settle plus one perception pass per step. The Settings flow's IQR of
4591 ms — a third of its own median — says that cost is also *variable*, which
is the shape of a fixed timeout being waited out rather than a screen being
observed.

That makes Phase 11 (adaptive waiting) the next faculty, and it makes it so on
this evidence rather than on the default order: no escalation in the log blames
waiting, so this cost is invisible to the escalation log and only HPI_time can
see it.

### Two faults found by measuring, both worth recording

**The instrumentation broke the thing it was measuring, for one run.** The
escalation recorder was called `note`; the step loop already had a `note`
string for the no-visible-change suffix. The shadowed call threw `note is not a
function` from inside the step's try block, so the catch turned it into a
failed step — an instrumentation bug that failed real flows, which is exactly
the property the recorder's internal try/catch was supposed to guarantee. The
guard was one scope too deep to help. Renamed, and the reason is in the code.

**A device restart leaves a live daemon's HID session dead for taps.** After the
simulator was restarted mid-session, every tap was dispatched successfully and
moved nothing: `tapped "Accessibility" at 201,380 (memory d=0, via ax) [no
visible change]`, on the correct coordinates for the correct element, five runs
in a row. `simframe stop && simframe start` fixed it completely. simframe's
existing input recovery covers hardware buttons only — deliberately, because
retrying a tap can act twice — so a tap has no such path. Two things this
confirms: the Indigo dispatch reporting success is not evidence the device
acted, which this file already recorded for buttons, and the verdict layer
caught it honestly every time rather than reporting a completed flow. Filed in
`docs/DEFERRED.md`.

### One limitation of the human recorder, since the research assumed otherwise

§1 calls human baseline collection "essentially free" because HID events are
already logged. That holds for events simframe *injects*. A person tapping the
Simulator window leaves no host-readable HID log, so wall time is measured
between an explicit start and stop, while the step count is derived from screen
transitions in the frame history.

That derived count was filed as a lower bound on taps, and the first human
recording disproved it in both directions within the hour: the 4-tap Settings
flow produced a median of **3** transitions — two taps merging inside one
400 ms window — and the 2-tap Contacts flow produced **3**, because one tap
launched an app whose launch animation and whose content arrived more than a
window apart. It is an estimate, not a bound. Nothing numeric rests on it:
`min_steps` comes from the flow definition and `step_ratio` uses that, so
`steps_observed` stays a shape-of-the-run signal with the label it deserves.

## The de-duplication the escalation log asked for

Same machine and device as Phase 10. The escalation log said 16 of 19
escalations were one pair of elements on one screen; this is what fixing them
was worth.

### What the existing rules were and why neither could see it

| rule | where | why it missed |
|---|---|---|
| a container within 8× the text's own area, containing the text's centre | `screenmap.build` | a full-width list row is **18.8×** the area of the words printed in it |
| centres within 12 pt | `matching.collapseSamePlace` | the row's centre is (194,286), the text's is (103,286) — 91 pt apart |
| containment, when the container is an interactive role | `matching.sameControl` | the row is published as `StaticText`, not a button or a cell |

For the record, since it was the first guess: an IoU test could not have caught
it either. The OCR box is 1227 pt² inside a 23040 pt² row, so IoU is **0.053** —
far below any usable threshold. Containment is 1.000. The discriminating
measurement is which of those two numbers you take.

### The rule now

An OCR reading whose frame is ≥90% inside a labelled accessibility element,
**and** whose text matches that element's label or value, is that element:
merged, keeping the tree's role and frame, marked `source: ax|ocr`. The text
test is what keeps the old size cap's job — a tab bar contains all five of its
tab labels and is not labelled "Assets", so it still refuses. Both halves have
tests, including the tab-bar negative and the exact frames measured here.

### What it bought

| | before | after |
|---|---|---|
| `contacts-kate-bell` runs completing | 0 of 5 | **5 of 5** |
| `HPI_accuracy` (suite) | 0.5 | **1.0** |
| escalations added by a 5-run contacts measurement | 5 | **0** |
| weakest same-screen fingerprint pair (local, 3 rounds) | 0.33 on CI | **0.67** |

The last row needs a correction to how it was first written here. CI's
fingerprint gate failed on the 0.8.0 push — `FAIL every same-screen revisit
scores at least 0.46 (worst 0.33)` — and its own diagnosis was two readings of
Settings disagreeing about token roles: `only in r1: text:…` against `only in
r2: button:…, heading:…`, which is this bug seen from the identity side. But
the very next push **passed that gate with none of this work in it**, so the
gate is intermittent, not broken, and this fix cannot be credited with
repairing it. What can be said: the failing run's own diagnosis names the token
class this merge removes, and locally the weakest same-screen pair is 0.67
against a 0.46 bar. Whether that raises the floor on CI is a claim for several
runs to settle, not one.

The browser tour's pause moved from 1400 ms to 3000 ms in the same change, for
an unrelated reason the eval refused to measure past: Safari read one token,
from OCR alone, before the page had arrived.

Changing what feeds identity changes identity, so `TOKEN_RULES_VERSION` and
`MAP_VERSION` both move and every stored map and graph node is discarded. The
first run after that is cold by construction: `settings-larger-text` measured
21.0 s on its first post-bump run against 11.6 s warm, and four `unverified`
verdicts where a warm graph would have predicted. Any HPI_time compared across
a version bump is comparing a cold run with a warm one.

## What the gate is set to, and why

Three measurements of **identical code** on the same device the same afternoon:

| measurement | HPI_time | `settings` p50 | `contacts` p50 |
|---|---|---|---|
| A (5 runs/flow, warm) | 0.475 | 13977 ms | 10407 ms |
| B (3 runs/flow, after a device restart) | 0.413 | 15376 ms | 12325 ms |
| C (5 runs/flow, cold after the version bump) | 0.371 | 17630 ms | 13491 ms |

A→B is a 13% move in HPI_time with nothing changed but the device's mood, and
per flow the medians moved up to 18%. Research §1 proposed a 10% band, which
these numbers would have tripped roughly half the time on noise alone — and a
gate that cries wolf gets ignored, which costs more than having no gate.

So the band is **25%**, and two things keep it from being slack: the gate reads
the **median of three passes** rather than a single measurement, and
`HPI_accuracy` stays strict — any drop at all fails. C is also a reminder that
the band has to cover a cold-cache run, because a version bump produces one
legitimately.

## The capture wedge, measured rather than described

Four times in one session, capture stopped: `the display surface could not be
read`, the daemon re-resolved the display port, and every subsequent read
failed the same way until the device was restarted. It cost three flow runs of
one measurement and four of another, and it is why `scripts/bench-hpi.mjs` now
aborts the suite with exit 2 on a wedge instead of reporting a partial HPI.

What is known: it is the failure documented in `src/index.js` as curable only
by restarting the device, and re-resolving the display port does not help. What
is measured but not yet explained: the daemon's RSS was **732 MB** after 11
minutes and 2831 frames — and then fell to **530 MB** over the next 25 seconds,
so it is not a monotonic leak. What is missing: there is no `autoreleasepool`
anywhere in the capture loop (only in `AccessibilityBridge`), which is the
usual cause of a working set that size in a Darwin capture loop. Whether that
pressure is what invalidates the surface is unproven, and saying so is the
point — filed in `docs/DEFERRED.md` with what it would take to settle it.

## The capture wedge, diagnosed

Two candidate mechanisms were filed for it. Both were built and both are now
falsified, and the answer turned out to be neither.

### What was tried

**Choose the display port by evidence, not by its own claim.** The resolver
accepted any port reporting a nonzero `displaySize`, which is why the daemon
could log `re-resolved the display port after 6 failed reads` and then fail six
more, forever: a torn-down port keeps reporting a size while
`framebufferSurface` returns nil. It now validates a candidate by taking a
surface from it, and escalates to rebinding the device — a fresh device object
from a fresh `devices()` call — when two re-resolves have not helped.

**An `autoreleasepool` per capture, and RSS in the log every second.** There was
no pool anywhere in the capture loop, which is the standard way to get the
working set this daemon had.

### What they measured

| | |
|---|---|
| port re-resolves in one session's log | **223** |
| device rebinds, after the escalation landed | **6** |
| wedges cured by either | **0** |
| `capture recovered on its own` lines in the same log | **9** |
| `simctl io screenshot` on a wedged device | **succeeds** — 16.2 s, and **0** non-black pixels of 3,162,132 |

So the display pipeline stops rendering, and simframe's failed read is an
accurate report of that. Apple's own screenshot path agrees: it returns a valid
PNG that is entirely black. Nothing about the handle is stale — which is why
223 re-resolves and 6 rebinds changed nothing — and a screenshot-engine
fallback, the third option on the table, would have captured the same black
frames. Measuring first is what stopped that one being built.

It also frequently recovers by itself. simframe had been telling users the
opposite: `only restarting the device is known to cure it`, in the same daemon
whose log contained nine self-recoveries. Corrected.

### What changed as a result

The port validation and the rebind escalation stay: selecting a port by whether
it produces a surface is better than trusting a size claim whether or not it
cures anything, and the escalation is bounded at two attempts per episode.
Neither is now described as a cure.

`simframe doctor` runs a screenshot probe when capture publishes a stall and
distinguishes the two faults it could be: *the device's display is rendering
black — this is the simulator*, or *simctl can see lit pixels while the daemon
cannot read the surface at all — that is a simframe bug, worth reporting with
this line*. Telling those apart by hand took an hour.

### Memory, exonerated

RSS is logged every second now, and the shape is a sawtooth rather than a leak:
202 MB climbing to 306 MB under a flow suite, then 313 MB falling to 265 MB
while idle. Peak was 303 MB over 957 frames against 732 MB over 2831 frames
before the pool — roughly the same per-frame accumulation, so the pool did not
change the profile materially. It stays as hygiene. And a few hundred megabytes
on a machine with tens of gigabytes cannot exhaust anything, so memory pressure
is not the wedge either. That is the value of the number: it removed a suspect.

## The wedge is load-induced, and the load was mine

Better characterised than "four times in one session". One 8-run loop of
`settings-larger-text`, each run resetting the app and relaunching it:

| run | wall time | steps |
|---|---|---|
| 1 | 19542 ms | 4/4 |
| 2 | 15208 ms | 4/4 |
| 3 | 15178 ms | 4/4 |
| 4 | 6974 ms | 3/4 |
| 5 | 25657 ms | 1/4 |
| 6 | 25701 ms | 1/4 |
| 7 | — | the display wedged |

It then wedged **again within a couple of minutes** of resuming the same load
after a full device restart. So it is not a slow drift over an afternoon: rapid
app relaunch cycling induces it in about six runs, reliably, and a restart buys
only as long as it takes to do it again. `simctl launch` itself degrades on the
way down — the 25.7 s runs are simctl taking that long to answer, which is the
same fault the hosted CI runner shows at 47-55 s.

Two changes follow, and neither is a workaround for a simframe bug — the
simulator's display failing is not something simframe can fix:

- The suite's flows **resume** the app instead of forcing `relaunch: true`. The
  reset already guarantees the app starts on its root screen, so terminating it
  again bought nothing and cost an extra terminate+launch per run. It is also
  closer to what the human baseline did: they tapped the icon.
- `bench-hpi` paces itself with `--cooldown` (1.5 s default) between runs.
  Relaunching an app as fast as a script can is not what this suite measures.

The user watching the simulator was the source of the diagnosis twice over —
first "the device is blacked out", which is what identified the fault as the
display pipeline, and then "performance gets degraded on each test", which is
the table above.

## Phase 11 so far, including a regression it caught

Per-edge timing is in and persisted with the graph: a rolling window of the
last 50 observed settle durations, `adaptiveTimeout` at p95 + max(150 ms, 20%)
capped at Nielsen's 10 s, and cold edges (<5 samples) keeping the previous fixed
8 s default and reporting themselves as cold. A measured tab switch drops from
an 8000 ms budget to 240 ms.

**A shorter timeout does not make a passing flow faster, and it is worth being
explicit about why.** A settle returns as soon as the screen holds still, so the
timeout only bounds the failure path. On four clean runs of the Settings flow
the split is 64% waiting for the screen and 36% everything else (perception,
locate, dispatch), and the reducible part of the waiting is the fixed 500 ms
stillness window every step pays — not the timeout.

So learned stillness was built, and then reverted for cause. It worked, in the
sense that the flow went from 11.5 s to 8.0 s. It was also **wrong**: eight runs
in a row failed at step 2 with the screen still showing Settings root, because
step 1's settle returned mid-push, `screenIdentity` read the screen we had not
left, and the graph learned `root -> root` as a verified edge and began
predicting it. The estimator is the flaw: the gap statistic is gathered from
what a wait itself observed, so a wait that ends early never sees the later
pauses, the gaps read as zero, the window ratchets down, and the next wait ends
earlier still. A self-reinforcing bias with a corrupt graph at the end of it.

The gaps are still recorded and no longer act on anything. The unbiased
estimator is available and is the next piece of work: the frame history holds
every frame's timestamp and diff, so a transition's true motion profile can be
computed *after* it is over rather than from inside the wait that cut it short.

### Phase 11, as closed

Done and live:

1. **Per-edge timing**, persisted with the graph — last 50 settle durations, and
   the longest pause inside each transition recorded alongside them.
2. **Adaptive timeout**, p95 + max(150 ms, 20%), capped at 10 s, cold edges
   (<5 samples) keeping the previous fixed 8 s and reporting themselves cold.
3. **A working screen earns patience.** A settle that runs out while the
   transition classifier still says `loading` gets the rest of the 10 s cap,
   and anything else that exceeds p95 stays `no-visible-change` as before. The
   escalation record carries the timing that produced it: `waited 8000ms of a
   2400ms budget; p95 2000ms`.
5. **`sim_state` reports timing**, from research §7 and free of any perception
   pass — the layout hash and the structural hash are already on disk:

   ```
   timing: this screen usually arrives in 2703ms (p95 2781ms, 4 samples);
           6283ms since the last change
   ```

Not done, both deliberately:

4. **The fixed sleeps are still there.** Step 0's inventory separates two
   kinds. The poll intervals — 40, 60, 80, 250 ms — are loop cadence, not
   guessed waits, and removing them would mean polling faster for no reason.
   The genuinely fixed waits are the focus window after tapping a field
   (250/900/3000 ms) and the identity settle (300 ms), and both sit on the
   perception path this phase was told not to touch. They want the same
   per-edge treatment and the same eval harness behind it.

   **Learned stillness** is the other half and is reverted for cause, above.

Measured after: the Settings flow runs 15.3 s cold and 11.1 s warm, 4/4 steps,
which is where it was before Phase 11 — as expected, because a shorter timeout
cannot speed up a flow that never times out. HPI_time is unmoved. The phase's
value is what it makes possible next: a distribution per edge, and a
`slower_than_usual` an agent can read instead of a fixed budget it cannot.

## Phase 11 step 4: the last two fixed waits on the action path

M4 Max, Xcode 26.0, iOS 26.5, iPhone 17 Pro (`326464A4-…`).

Step 0's inventory left two genuinely fixed waits after the phase closed — the
focus window after tapping a text field (250/900/3000 ms) and the structural
identity settle (300 ms) — plus a set of poll intervals (40, 60, 80, 250 ms)
that are loop cadence rather than guessed waits and are deliberately still
there. Polling faster to satisfy a rule about sleeps would be the rule winning
an argument against the reason for it.

### The focus window: learned, and asymmetric on purpose

A `type into` step taps the field and waits before it types. That wait is not
the step's settle — it is measured between the tap and the field reacting,
inside a step whose settle is measured after the typing — so it is now its own
distribution on the same graph edge: `focuses`, alongside `settles` and
`quietGaps`, same 50-sample window.

What makes this window different from the step budget is the shape of its
failure, and it decides the design:

| | too short | too long |
|---|---|---|
| step budget | reports `no-visible-change`, flow sees it | costs time on a failing step |
| focus wait | **types into an unfocused field and reports success** | costs time on the honest case |

Input has no feedback channel, so `typeText` succeeds whether or not the field
was listening. That is the failure this helper was written to fix in the first
place — measured on Android, where tapping a search box starts a whole separate
activity and the text went before the field existed.

So the learned window may **only ever lengthen** the wait. `max`, not `min`. A
field whose p95 is 4.2 s stops being typed into at 3 s; a field whose p95 is
260 ms keeps the 900/3000 constants, and the saving is declined. Five percent of
a distribution is one silent wrong type in twenty runs, and no amount of median
wall time buys that back.

The one shortening is not a learned number at all, it is positive evidence: if
the keyboard was already up before the tap, the tap moves a caret and there is
no keyboard animation to wait for, so the reaction window collapses to the
stillness window. `beforeScreen` already carries `keyboard`, so the evidence
costs nothing — it is the same perception pass the step was going to run anyway.

**Measured, live**, on the Contacts search field (`~/.simframe/<udid>/graph`,
edge `type:{"into":"Q Search","text":"Kate"}`):

```
focuses  [446, 325]     settles [678, 619]     quietGaps [174, 7209]
```

The wiring is verified end to end: the focus wait is satisfied, its duration is
recorded on the right edge, and `timingOf` reads it back. The threshold
arithmetic — cold below five samples, lengthen-only above it, Nielsen's cap
above that — is unit-tested rather than measured, because the edge did not
reach five samples: another session took the benchmark device four runs in.

The keyboard branch is unit-tested and **unverified live**, and the reason is
worth recording rather than glossing: this simulator has Connect Hardware
Keyboard on, so the software keyboard never rises and `keyboard` is false on
every screen here. `detectKeyboardTop` needs twelve small uniform elements low
on the screen and gets four. What is covered is the decision, not the event —
the same disposition as `CaptureRecovery`'s teardown.

### The identity settle: the same guarantee, minus the part already paid

`screenIdentity` makes a novel fingerprint prove itself across two readings,
and slept 300 ms between them. Unlike every other fixed wait in the engine this
one cannot be replaced by waiting for a signal, because there is no signal: the
race it guards is a screen whose *pixels* have gone still while its structure
has not — a list whose spinner has gone and whose rows have not landed is
perfectly quiet and structurally wrong, so the settle detector, which watches
pixels, has nothing to report. Only elapsed time separates the two readings.

What was wrong was that the wait was *additional*. The guarantee wanted is
300 ms between the frames the two samples read; the code slept 300 ms *after* a
sample that had already spent an unbounded settle wait and a full perception
pass getting there. So credit what has passed and wait for the remainder.

Measured over eight `screenIdentity` passes on the device, the frame age at the
moment the old code began sleeping:

```
age at the sleep   923, 167, 156, 612, 161, 518, 218, 165 ms   (median 218)
owed after credit    0, 133, 144,   0, 139,   0,  82, 135 ms   (median 133)
```

Median 167 ms saved per extra sample, up to two samples per unrecognised
screen, and three of eight owed nothing at all — the separation was already
there and the sleep was buying a second copy of it. The guarantee is unchanged:
sample two still reads a frame captured at least 300 ms after sample one's.

This does not move the warm suite, where screens are already known and the loop
never runs. It is the cold and exploratory paths that pay it.

### A statistic that was quietly not being taken

Found in the data above, not in the code. `graph.record` calls `noteSettle` from
three places, and the one on the main path — the branch nearly every recorded
edge takes — passed `settleMs` alone. `quietGapMs` was therefore only ever
recorded when an edge was brand new or when it went through the variant branch.

The window that reads it (`stillnessFor`, which needs five samples) looked
permanently cold on every edge that had been traversed more than once. Nothing
complained, because a measurement not being taken is indistinguishable from a
cold one. `quietGaps [174, 7209]` above is two traversals of one edge; before
the fix it would have read `[174]`.

Worth stating plainly: this bug was in the code the whole time the learned
stillness experiment was being run and reverted. It does not rescue that
experiment — the estimator is biased for the reason already written up, and
more samples of a biased statistic is a better-measured wrong number.

### Measured: the suite, A/B, clean graph each round

Six runs each side, three per round, the device's graph deleted before every
round so neither side inherits the other's learning. `settings-larger-text`
only — the flow with four known steps and no typing, so it isolates the
identity settle from the focus window.

| | run 1 | run 2 | run 3 | passed |
|---|---|---|---|---|
| HEAD, round 1 | 17304 ms 4/4 | 6927 ms **3/4** | 7208 ms **3/4** | 1/3 |
| HEAD, round 2 | 15907 ms 4/4 | 7498 ms **3/4** | 10143 ms **3/4** | 1/3 |
| step 4, round 1 | 14699 ms 4/4 | 15417 ms 4/4 | 14098 ms 4/4 | 3/3 |
| step 4, round 2 | 17253 ms 4/4 | 17947 ms 4/4 | 7167 ms **3/4** | 2/3 |

**2/6 against 5/6**, and the failures are not randomly placed: on HEAD they are
always runs 2 and 3, never run 1. That is the signature of a *cold* run passing
and a *warm* one failing, which points at what the first run wrote down.

The failure itself is the same one every time. Step 1 taps Accessibility,
reports `settled 124ms`, and step 2 cannot find "Display & Text Size" because
the screen never left the Settings root. A settle satisfied in 124 ms cannot
have observed the 500 ms of stillness it requires, so `since` must already have
differed from the live hash when the wait began — the baseline was captured
mid-animation, `sawChange` was true before the tap did anything, and the wait
returned on stillness that predated it. `screenIdentity` then reads the screen
we have not left, and the graph records **Settings root → Settings root** for
`tap Accessibility`. The stored edge for that has `count: 11` and
`changedOutcomes: 5`: it has been flipping between the right screen and itself
all day. This is the same corruption the learned-stillness revert cleaned up,
and it came back without learned stillness, so learned stillness was never its
only cause. Filed in `docs/DEFERRED.md`.

Why the credit changes the pass rate is a hypothesis with a mechanism, not a
proven cause, and the difference between those two is the whole reason this
file exists. Confirmation is "two structural readings agree". The old code
guaranteed 300 ms between the readings and *delivered* about 600 — the sleep
plus the perception pass that followed it — and on a screen with anything live
on it, a clock included, a wider separation is less likely to agree. Fewer
confirmations mean fewer recorded edges, which is exactly what the HEAD verdict
column shows: `unverified, unverified, unverified, unverified` on run 1, so run
2 walks in with nothing learned. With the credit the separation is the 300 ms
the window was designed for, run 1 records edges, and runs 2 and 3 predict
correctly.

What this is **not** is a fix. Step 4 still failed once in six, with the same
signature, and the defect is upstream of anything measured here: a settle that
can be satisfied by stillness older than the action it is waiting on. Until
that is fixed the pass rate is a symptom being nudged, and it is filed as such.

HPI over the two step-4 rounds: `HPI_accuracy` 1.0 and 0.667, `HPI_time` 0.531
and 0.452. Unmoved, as expected — none of this makes a passing flow faster.

### Not done, and no longer a Phase 11 item

The structural window itself (300 ms) is per-screen learnable, and its
estimator has the *opposite* feedback sign to the one that corrupted the graph:
a window too short produces disagreeing samples, which lengthens it.
Self-correcting rather than self-reinforcing. It still waits on the perception
eval harness, because "the two samples agreed" is only evidence the window was
long enough if the readings themselves can be trusted.

## Gate A, item 1: a settle that will not accept stillness older than its action

M4 Max, Xcode 26.0, iOS 26.5, iPhone 17 Pro (`326464A4-…`).

The defect, restated from the Phase 11 step 4 A/B where it was found: `since`
means "the screen as it was before the action", and time also passes between
capturing that baseline and dispatching the action. In a flow step that gap
holds a `locate`, a perception pass and a settle wait — hundreds of
milliseconds. A transition can begin *and finish* inside it, so `sawChange` is
already true when the wait starts, because of the **previous** action's
animation.

Two fixes, and the second is the one that stops the damage.

1. `waitFor` re-baselines when the screen already differs from the baseline
   *and has already been at rest for the full stillness window*. That test is
   unambiguous rather than clever: stillness cannot accumulate in the
   milliseconds between a dispatch returning and a wait beginning. A screen
   that differs and is still *moving* is left alone, because after an action
   the ordinary reading is the right one.
2. The graph records no edge for an action with no observed effect. The
   recorder used to ask only whether the *reading* was confirmed, so a tap that
   moved nothing still wrote an edge.

### Measured

Six runs, two rounds of three, graph deleted before each round.

| | run 1 | run 2 | run 3 | passed |
|---|---|---|---|---|
| round 1 | 16967 ms 4/4 | 11747 ms 4/4 | 6841 ms **2/4** | 2/3 |
| round 2 | 14946 ms 4/4 | 12178 ms 4/4 | 13520 ms 4/4 | 3/3 |

**Self-edges in the resulting graph: 0, of 4 edges across 4 nodes.** That is the
number this was for. The same six runs before this change left
`tap:accessibility → itself` with `count: 11` and `changedOutcomes: 5`,
oscillating between the real destination and the screen it never left.

The pass rate is unchanged at 5/6, and the **failure mode is not**. It was
`"Display & Text Size" is not on this screen` at step 2 — the flow walking on,
believing step 1 had worked. It is now `unexpected-screen: expected the screen
this action reached 2x before, and landed somewhere else`, at the step that
made the wrong turn, and the run halts there. A caught wrong turn and a silent
one are the same line in an accuracy column and not the same thing at all: the
first is the verify barrier doing its job, and it is what an agent can act on.

`HPI_accuracy` 0.667 and 1.0 over the two rounds; `HPI_time` 0.664 and 0.577.
Unmoved, as expected — none of this makes a passing flow faster.

### One real case is now temporarily invisible

A control that genuinely returns to the same screen — a toggle — reads as
`no-visible-change`, because the change detector sits eight times above what a
switch flip produces (Gate A/B item 3). So its edge is no longer recorded. That
is the right trade while the detector cannot see it: a missing true edge costs
a perception pass, and a false self-edge costs a wrong prediction on every
later visit. It comes back on its own when item 3 lands.

## Gate C item 10: the pause statistic, measured after the fact

M4 Max, Xcode 26.0, iOS 26.5, iPhone 17 Pro (`326464A4-…`). Two runs of
`settings-larger-text`, graph deleted first.

Phase 11 recorded `quietGaps` from *inside* the wait — the longest stretch of
stillness the wait itself happened to observe — and the write-up explained why
that is biased: a wait that ends early never sees the pauses that come later, so
the gaps read low, and feeding that back into how long to wait eats itself.

`index.longestQuietGap` reads the same statistic off the frame history once the
transition is definitely over, in the *next* step, over a window whose end
nothing about the wait decided. It returns `null` rather than a number when the
frame ring no longer reaches back to the action, because a partial window
produces a short gap — the exact direction of the bias being removed.

| edge | settles (ms) | biased gaps | **true gaps** |
|---|---|---|---|
| `launch com.apple.preferences` | 311, 1109 | 0, 392 | **1641, 1161** |
| `tap accessibility` | 1728, 2475 | 957, 636 | **2047, 2081** |
| `tap display & text size` | 992, 985 | 1148, 787 | **533, 175** |
| `tap larger text` | 2215, 2221 | 1398, 614 | **173, 88** |

### The bias goes both ways, which the earlier write-up got wrong

Phase 11 described a one-directional error: gaps read as zero, the window
ratchets down. Two of these edges do exactly that — a launch whose true pause is
1641 ms was recorded as **0**, and `tap accessibility` reads 957 against a true
2047.

The other two go the other way, and the mechanism is different. The biased
figure tracks `state.stableForMs`, which accumulates stillness from *before* the
wait began; the unbiased one only counts pauses between two observed changes
inside the window. So `tap larger text` recorded 1398 ms of "pause" for a
transition whose real longest pause was 88 ms — it was counting quiet that
belonged to the previous screen.

So the statistic was not an underestimate. It was noise with a sign that depends
on what happened before the step, which is a considerably better reason never to
have built a wait on it than the one written down at the time.

### What it says about the window that corrupted the graph

`tap accessibility` genuinely pauses for **about two seconds** mid-transition.
The stillness window is 500 ms. Any window shorter than the true pause mistakes
mid-flight quiet for a finished screen — which is precisely the edge whose
`root → root` self-loop had to be deleted twice, and it now has a measured
explanation rather than an inferred one.

### Nothing acts on it

`trueGaps` is written and reported and read by no decision, and the unit test
asserts that `stillnessFor` does not consult it. Phase 11 built a wait on the
biased version and corrupted the graph inside an afternoon; the lesson taken was
not "use a better estimator" but that a number earns the right to act by first
being watched for a while doing nothing. Four edges over two runs is the start
of that, not the end of it.

## Phase 11.5 — cheaper thinking

M4 Max, Xcode 26.0, iOS 26.5, iPhone 17 Pro. Baseline in `docs/ESCALATIONS.md`,
"Phase 11.5 — thinking cost baseline".

The phase's own hypothesis was that flows arrive one step at a time. They do
not: `model_turns`/step is 0.56 and 84% of real calls are already batched. What
the data shows instead is **short batches** — 48 of 62 calls were three steps or
fewer, so a twelve-step flow arrived as five calls and every boundary was a
think nothing had asked for.

### What each change is worth

| | before | after |
|---|---|---|
| tool descriptions, longest | 109 words | **60** |
| tool descriptions over 60 words | 5 of 19 | **0** |
| default screen map, 14 recorded screens | 8495 chars | **7202** (−15%) |
| map rows | 167 | **154** |

The map cut is body prose. On one Settings screen four of sixteen rows were the
explanatory paragraph under each switch — 31% of that map's characters spent
describing things nobody can tap. The rule is narrow on purpose: non-interactive
only, outside the chrome regions only, and only past a length no label reaches,
so a long *button* label survives. iOS writes whole sentences into those and
they are still the thing you tap.

### The `next:` line is a call saving, not a size saving

It adds ~130 characters to a result, and on a single call it is roughly break-even
against the map cut. That is not where its value is. It answers, locally and for
free, the question that was producing the extra calls:

```
next: settled; screen known (0f660efb, 2 known exits); 16 elements;
      nothing ambiguous — chain the next steps in one sim_do without looking again.
```

Everything in it was already computed while assembling the result. It reports
the strongest reason to think first — flow stopped, screen still moving, screen
unknown, labels repeat — and says "carry on" only when it can rule all four out.

### Verified

Both suite flows, run through the MCP tools as an agent would, each as a single
call:

| flow | steps | model turns | images |
|---|---|---|---|
| Settings → Accessibility → Display & Text Size → Larger Text + assert | 5/5 | **1** | 0 |
| Contacts → Kate Bell + 2 asserts | 4/4 | **1** | 0 |

Against a target of ≤2 turns each. Both include asserts, which is the point:
the asserts are what make it safe not to look between steps.

### What this phase cannot move, said plainly

It cannot manufacture `ok` verdicts on an app nobody has driven before. The
measured session had 6 `ok` against 43 `unverified` in 179 steps, because the
graph was cold — and a cold graph means almost every step returns something the
model has to interpret. That is Phase 12–16 work, not tool-surface work.

Two caveats on the numbers above. The map and description figures are measured
offline and exactly. The turn counts were measured through an MCP server process
started before today's changes, so those two runs show the *old* result format —
the turn count is real, the `next:` line and the prose cut are not visible in
them and are verified by unit test and by the offline measurement instead.
