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

| | |
| --- | --- |
| freshly started daemon | HOME works — full transition out of the app |
| long-running daemon | `press in 64ms via simframed`, frame hash unchanged |

Input has no feedback channel, so the socket call succeeding is all the Node
side hears. The HID session goes stale independently of the display port — in
this case capture was healthy throughout — and `resetHIDSession` exists on the
client but is never called.

The mechanism is not isolated, so nothing is claimed about the cause. What is
certain is that this is a silent failure of the exact kind this project's
policy forbids, and that it was visible all along as `no-visible-change`
verdicts in the CI memory check, which I read as screen noise.
