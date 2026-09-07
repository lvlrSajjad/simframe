# simframe

[![ci](https://github.com/lvlrSajjad/simframe/actions/workflows/ci.yml/badge.svg)](https://github.com/lvlrSajjad/simframe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/simframe.svg)](https://www.npmjs.com/package/simframe)
[![license](https://img.shields.io/npm/l/simframe.svg)](./LICENSE)

**Eyes, hands and memory for an agent driving the iOS Simulator.**

[Website](https://lvlrsajjad.github.io/simframe/) · [npm](https://www.npmjs.com/package/simframe)

An agent driving the iOS Simulator is slow for three reasons, and only the first
one is obvious:

1. **Every look is a wait.** `simctl io screenshot` costs ~130 ms of blocking
   latency, paid again on every glance — and paid twice whenever the agent
   captures mid-animation and has to look again.
2. **Every step is a round trip.** Tap, screenshot, reason, tap, screenshot. A
   twelve-step flow costs twelve model turns, and the model turns cost far more
   than the milliseconds.
3. **Nothing is remembered.** The same screen gets re-read and re-reasoned about
   every single time it appears.

simframe attacks all three: a background loop keeps the newest frame warm, whole
flows run in one call, and screens the agent has seen before are answered from
memory.

## What changed, measured

Same four-tab navigation flow, on a real production app:

| | Before | With simframe |
| --- | --- | --- |
| Look at the screen | ~130–400 ms, blocking | **~20 ms**, already captured |
| "Did anything change?" | a full image | **~2 ms**, text only |
| A 5-step flow | 5+ model round trips | **1 call**, ~7 s |
| Finding a control | read tree (~570 ms) + reason | **~1 ms** from memory |
| Same flow, 3rd run | no improvement — every run is the first | **5680 ms, 4/4 from memory** |

That last number is the interesting one. 5680 ms across four screen transitions
is **1420 ms each — which is the app's own animation and data-load time.** The
tooling overhead is essentially gone; what remains is the app.

## Install

```bash
npm install -g simframe
simframe doctor
```

`doctor` checks each capability separately and tells you what you have:

```
ok   xcrun              xcrun version 72.
ok   sips               available
ok   input driver (idb) companion built Sep 1 2026
ok   on-device OCR      available
ok   booted simulator   iPhone 17 Pro (iOS 26.5)
ok   capture            frame #888 322x700 in 2ms (age 538ms)
```

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

## Capabilities are independent

Each layer works without the ones above it, and `doctor` tells you which you
have. **Observation needs nothing but Xcode.**

| Capability | Needs | Without it |
| --- | --- | --- |
| Watch the screen, wait, recall | nothing extra | — |
| Read labels + coordinates from pixels | `swiftc` (Xcode CLT) | falls back to the accessibility tree alone |
| Tap, type, swipe | [`idb`](https://fbidb.io) | simframe observes but cannot touch |

```bash
# input, optional
brew tap facebook/fb && brew install idb-companion && pipx install fb-idb
```

Homebrew may ask you to trust the tap first; that is a deliberate prompt for a
human, and the narrow form is `brew trust --formula facebook/fb/idb-companion`.

## The tools

| Tool | What it does |
| --- | --- |
| `sim_look` | Newest frame as an image, no capture wait. |
| `sim_state` | Text only: screen hash, what changed **since your last look**, region movement map. |
| `sim_wait` | Waits for the screen to change *and then* settle. |
| `sim_do` | A whole flow in one call — tap, type, scroll, assert — each step settling before the next. |
| `sim_ui` | The screen as labels + tap coordinates, from accessibility **and** OCR. |
| `sim_recall` | Look backwards: a timeline of what happened, or the frame from N seconds ago. |
| `sim_strip` | Recent frames tiled into one image. |
| `sim_capture` / `sim_devices` | Manage capture loops; list simulators. |

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
- The merge is keyed by a **layout hash**, so the next visit is a file read.

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

### Why a layout hash, not a frame hash

The frame hash changes whenever any pixel group changes — a clock digit, one new
row of data — which makes it useless as a key for "have I seen this screen
before?". The layout hash crops the status bar and takes a difference hash over a
12×24 grid.

A mean-threshold hash was tried first and was actively dangerous: low-contrast
app screens collapsed onto identical values, so unrelated screens matched at
distance 0 and taps landed on the wrong control. Measured on a real app:

| | Hamming distance |
| --- | --- |
| Same screen, revisited (different rows, different clock) | **0–3** |
| Different screens | **77–96** |

The tolerance is 12 — four times the observed noise, six times below the nearest
collision.

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

Two honest caveats. OCR reads **text**, so a purely graphical icon with no label
is invisible to both paths — use `sim_ui` to get its coordinates from the tree,
or tap by position. And the confirm-button vocabulary (`APPLY`, `OK`, `SAVE`,
`DONE`…) is English; a localised UI needs those words extended.

## Measured

iPhone 17 Pro, iOS 26.5, Apple Silicon, default settings.

| | |
| --- | --- |
| Warm frame read (`sim_look`) | ~20 ms |
| State check (`sim_state`) | ~2 ms |
| Contact sheet (`sim_strip`, 5 frames) | ~30 ms |
| Accessibility tree read | ~570 ms |
| On-device OCR of a full frame | ~290 ms |
| Screen map: first visit / remembered | ~1000 ms / **~1 ms** |
| Raw `simctl io screenshot`, for comparison | ~130 ms, every look |
| Cold start, first frame | ~400 ms, once |
| CPU | 1.1 % idle · 3.1 % active |
| Frame memory | ~60 s of screen, ~2.7 MB |

## How it works

```
┌──────────────────── background, one loop per simulator ─────────────────────┐
│   simctl screenshot ──► sips ──► decode ──► hash + diff ──► rename into      │
│      ~130 ms            ~30 ms    ~6 ms                  ~/.simframe/<udid>/ │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │  a rename is atomic
┌────────────────────────────────────▼────────────────────────────────────────┐
│   MCP server / CLI: stat + read. No simctl anywhere in the request path.     │
│   Screen memory: layout hash ──► label → point, built once per screen.       │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Files are the IPC.** The loop renames completed frames into place; readers
  just read them. A rename is atomic, so a reader can never see a half-written
  frame, and there is no socket or protocol to get wrong.
- **Almost no dependencies.** Resizing uses `sips`; PNG codec, hashing and frame
  comparison are plain JavaScript over `node:zlib`. The only runtime dependency
  is the MCP SDK. OCR is a ~60-line Swift file compiled on first use.
- **It backs off when nothing happens.** 4 fps while the screen moves, 1.5 fps
  once still, snapping back instantly on change.
- **One writer per device.** Ownership lives in `meta.json`; `stop` refuses to
  kill a loop another client is using unless forced.
- **A wedged capture loop never looks like a calm screen.** Every answer carries
  a liveness check, and `wait` fails loudly rather than quietly timing out.

## CLI

```bash
simframe start                 # start the capture loop
simframe mark                  # hash of the current frame, for --since
simframe state --since=$H      # what changed, as text
simframe frame --out=now.png   # newest frame
simframe wait --since=$H       # change, then settle
simframe ui                    # labels + tap points (ax and ocr)
simframe recall                # what happened in the last minute
simframe recall --ago=15000    # the frame from 15s ago
simframe strip --count=6       # contact sheet
simframe status / stop [--force] / devices / doctor
```

## Limitations

- Simulators only — `simctl` cannot capture a physical device.
- Capture tops out near 6 fps, because `simctl io screenshot` costs ~130 ms. Fast
  animations are sampled, not recorded.
- Region maps need a baseline inside the ~90 s history window. Older baselines
  still get a reliable changed / did-not-change, without a map of what moved.
- Screen memory assumes a screen's layout is stable. A screen that reflows
  dramatically between visits will simply be rebuilt.
- It speeds up *confirming* a fix, not *locating* one. A bug living in a memo
  comparator or a stale closure is not visible in any frame.

## Roadmap

- Reduce the input dependency: idb is the one heavyweight requirement, and most
  of what it provides for a simulator is reachable other ways.
- Verify-after-tap, so a tap that changes nothing is reported rather than assumed
  to have worked.
- Extend the confirm vocabulary beyond English.

## Releasing

`npm version` does not touch `server.json`, so bump both, then push the tag:

```bash
npm version minor --no-git-tag-version
$EDITOR server.json        # match "version" and packages[0].version
git commit -am "Release vX.Y.Z" && git tag vX.Y.Z && git push && git push --tags
```

The `release` workflow verifies tag/`package.json`/`server.json` agree, validates
`server.json` against the live registry, and publishes to npm and the MCP
Registry. It needs `NPM_TOKEN`; the registry uses GitHub OIDC and needs no secret.

## License

MIT
