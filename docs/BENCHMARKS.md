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
