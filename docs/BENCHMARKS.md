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
