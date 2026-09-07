# simframe

[![ci](https://github.com/lvlrSajjad/simframe/actions/workflows/ci.yml/badge.svg)](https://github.com/lvlrSajjad/simframe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/simframe.svg)](https://www.npmjs.com/package/simframe)
[![license](https://img.shields.io/npm/l/simframe.svg)](./LICENSE)

**Always-warm iOS Simulator frames for coding agents.**

[Website](https://lvlrsajjad.github.io/simframe/) · [npm](https://www.npmjs.com/package/simframe)

An agent that drives the iOS Simulator spends most of its time waiting on
screenshots. Every "let me check the screen" is a fresh `simctl io screenshot`:
a process spawn, a framebuffer grab, a file write, an image encode. On this
machine that is ~130 ms of pure blocking latency, paid again on every look — and
the agent pays it *twice* whenever it screenshots too early, sees a
mid-animation frame, and has to look again.

simframe removes the wait from the request path. A tiny background loop keeps
the newest frame of your simulator permanently warm on disk, so when the agent
asks what's on screen it gets an answer in **~20 ms** instead of ~130 ms — and
can ask "did anything change?" for **~2 ms and no image at all**.

```
                    without simframe                  with simframe
agent asks    ──►  spawn simctl ──► grab ──► encode ──► image      ~130-400 ms
agent asks    ──►  read the frame that is already there ──► image   ~20 ms
agent polls   ──►  read 300 bytes of JSON ──► text                  ~2 ms
```

## Why this makes an agent faster

Speed is not only latency. It is also *how many* round trips a question takes
and how many tokens each one costs.

| Question the agent has | Before | With simframe |
| --- | --- | --- |
| "What's on screen?" | screenshot, ~130-400 ms, full image every time | `sim_look`, ~20 ms, warm frame |
| "Has it finished loading yet?" | screenshot in a loop, an image per attempt | `sim_state`, ~2 ms, **text only** |
| "Did my tap do anything?" | screenshot, compare by eye | `sim_state` — tells you what changed **since your last look**, as text |
| "Wait for the animation to end" | sleep, screenshot, hope, repeat | `sim_wait` — waits for the screen to change *and then* settle |
| "What did that transition look like?" | 5 screenshots, 5 round trips, 5 images | `sim_strip` — N buffered frames tiled into **one** image, spread across the window you ask for |
| "The screen is already different — what did I miss?" | nothing; re-run and watch harder | `sim_recall` — a text timeline of what changed in the last minute, and any past frame |

The change map is the part that pays for itself. A screen hash and a
4×8 movement grid cost a couple of hundred bytes, so an agent can poll freely
and only spend image tokens when there is genuinely something new to look at:

```
$ simframe state --since=$H
iPhone 17 Pro  frame #22  age 41ms  322x700
hash 10ff8f3effef8f8f8fcf8fcfcfefcf83  stable 2351ms
CHANGED since 3523ms ago: 25.4% of the screen
#@@@
*#*@
#@@@
##@@
##@#
##@#
@@@@
@@@@     ← a new screen replaced the old one while you were not looking
```

## Install

```bash
npm install -g simframe
simframe doctor
```

`doctor` verifies Xcode's command line tools, `sips`, a booted simulator, and
an actual round-trip capture.

### Claude Code

```bash
claude mcp add simframe -- npx -y simframe mcp
```

### Any other MCP client

```json
{
  "mcpServers": {
    "simframe": {
      "command": "npx",
      "args": ["-y", "simframe", "mcp"]
    }
  }
}
```

Nothing else to set up. Capture starts on the first tool call, targets the
booted simulator, and stops itself 15 minutes after the last request.

## MCP tools

| Tool | What it does |
| --- | --- |
| `sim_look` | The newest buffered frame as an image, no capture wait. `detail`: `low` (~420 px) / `normal` (~700 px, default) / `high` (~1100 px) / `full` (native). |
| `sim_state` | Text only: screen hash, whether anything changed **since your last look**, how long the screen has been still, and a region movement map. Takes an optional `since` hash. |
| `sim_wait` | Waits for the screen to react, then returns the frame. `mode`: `settle` (default — change, then stillness), `change`, or `stable`. Baseline defaults to your last look. |
| `sim_strip` | N buffered frames tiled into one image, oldest first, with millisecond offsets. With `spanMs`, frames are spread evenly across that window rather than taken from the end. |
| `sim_recall` | Look backwards. `timeline` (default) is a text summary of what changed in the last minute and when; `at` returns the buffered frame from a moment in the past. |
| `sim_do` | Run a whole flow in one call — tap, type, scroll, wait, assert — settling between steps. The main speedup. Needs idb for input. |
| `sim_ui` | The screen as an accessibility tree: labels, types and exact tap points. Often cheaper than an image. Needs idb. |
| `sim_capture` | `status` / `start` / `stop` for the background loops. Rarely needed. |
| `sim_devices` | Booted simulators simframe can capture. |

Every tool takes an optional `device` (UDID or a substring of the name) and
defaults to the booted simulator.

## CLI

The same capabilities without an agent, useful for debugging and scripts:

```bash
simframe start                 # start the capture loop
simframe mark                  # hash of the current frame, to use as --since
simframe state --since=$H      # what changed since that frame, as text
simframe frame --out=now.png   # newest frame, --detail=low|normal|high|full
simframe wait --since=$H       # change, then settle (default mode)
simframe wait --mode=change    # return as soon as it differs
simframe recall                # text timeline of the last minute
simframe recall --ago=25000    # the frame from 25 seconds ago
simframe strip --count=6 --span-ms=45000   # six frames spread across 45s
simframe status                # what is running, and how fresh
simframe stop [--force]        # --force stops a loop another client is using
simframe ui                    # accessibility tree, with tap points
simframe tap "Save"            # tap by label, then wait for the screen to settle
simframe do flow.json          # run a scripted flow
simframe devices --all
simframe doctor                # reports whether input is available
```

## How it works

```
┌──────────────────────────── background, one per simulator ───┐
│  xcrun simctl io screenshot  ──►  sips -Z  ──►  decode PNG   │
│         ~130 ms                    ~30 ms        ~6 ms       │
│                          │                                   │
│              rename into ~/.simframe/<udid>/                  │
│              latest.png · ring/<seq>.png · state.json         │
└───────────────────────────────────────────────────────────────┘
                           │  a rename is atomic
┌──────────────────────────▼────────────────────────────────────┐
│  MCP server / CLI: stat + read. No simctl in the request path.│
└───────────────────────────────────────────────────────────────┘
```

A few decisions worth knowing about:

- **Files are the IPC.** The loop renames completed frames into place and
  readers just read them. A rename is atomic, so a reader can never see a
  half-written frame, and there is no socket, port or protocol to get wrong.
- **Zero image dependencies.** Resizing uses `sips`, which ships with macOS.
  PNG encode/decode and all frame comparison are a few hundred lines of plain
  JavaScript over `node:zlib`. The only runtime dependency is the MCP SDK.
- **It backs off when nothing is happening.** 4 fps while the screen is moving,
  1.5 fps once it has been still for 2.5 s, snapping back instantly on change.
  Measured on an M-series Mac: **1.1 % CPU idle, 3.1 % active.**
- **Comparison is done on a small grayscale grid,** which is why "did anything
  change?" costs microseconds. The screen hash is a 128-bit mean-threshold
  hash: the same screen always produces the same hash, even though the JPEG and
  PNG bytes coming out of `simctl` are not stable frame to frame.
- **One writer per device.** Ownership is recorded in `meta.json`; a second loop
  refuses to start, and a loop that has been superseded retires itself. Two
  loops would otherwise overwrite and prune each other's frames. `stop` also
  refuses to kill a loop another client used in the last minute, unless forced.
- **A wedged capture loop never looks like a calm screen.** Every answer carries
  a liveness check, and `wait` fails loudly if frames stop advancing instead of
  quietly timing out.
- **The last ~90 seconds of frame signatures are kept,** so "what changed since
  this hash?" is answerable for any recent baseline. Older baselines still get a
  correct yes/no from the last-change timestamp, just without a region map.
- **Frame memory is thinned by age, not by count.** Everything inside 6 s, then
  ~2 fps out to 60 s, with aged frames re-encoded at half size by the bundled
  PNG codec — 14 MB of raw frames becomes under 3 MB. A hard byte budget caps
  the buffer regardless.
- **Capture is independent of the Simulator window.** `simctl` reads the
  framebuffer, so frames keep flowing while the window is hidden, behind other
  windows, or on another Space.

## Measured

iPhone 17 Pro, iOS 26.5, Apple Silicon, default settings:

| | |
| --- | --- |
| Warm frame read (`sim_look`) | ~20 ms |
| State check (`sim_state`) | ~2 ms |
| Contact sheet (`sim_strip`, 5 frames) | ~30 ms |
| Cold start (first frame after boot) | ~400 ms, once |
| Frame age when read | ≤ ~250 ms active, ≤ ~670 ms idle |
| Raw `simctl io screenshot` for comparison | ~130 ms, on every single look |
| CPU | 1.1 % idle, 3.1 % active |
| Disk | ~2.7 MB for 32 s of memory; 12 MB hard cap per device |

Image sizes are chosen for token cost as much as legibility: at `detail: normal`
a frame is ~322×700, roughly a third of the pixels — and so roughly a third of
the image tokens — of a native-resolution screenshot, while the status bar stays
readable. `sim_state` sends no image at all.

## Requirements

- macOS with Xcode command line tools (`xcrun simctl`)
- Node.js ≥ 18.17
- A booted iOS Simulator

## Limitations

- Simulators only. `simctl` cannot capture a physical device.
- Input depends on idb, which uses private CoreSimulator APIs and can lag a new
  Xcode release. Observation depends only on `simctl` and keeps working.
- Capture tops out near 6 fps, because `simctl io screenshot` costs ~130 ms.
  Fast animations are sampled, not recorded.
- Region maps need a baseline within the ~90 s history window. Beyond that you
  still get a reliable "changed / did not change", but not a map of what moved.
- Frame memory reaches back ~60 s. Beyond that the timeline is gone, and a
  change occurring in the very first moments of a capture loop is not recorded,
  because there is nothing yet to compare it against.
- It speeds up *confirming* a fix, not *locating* one. A bug that lives in a memo
  comparator or a stale closure is not visible in any frame.

## Roadmap

- A higher-frame-rate backend via `simctl io recordVideo` piped through ffmpeg,
  used automatically when ffmpeg is present.
- Optional accessibility-tree text alongside the frame, so an agent can read
  labels without spending image tokens.
- Recording a walked path as a named, replayable flow, so a regression check is
  one call with no reasoning at all.
- Reading text from the frame itself, so assertions work on apps with thin
  accessibility coverage.

## Releasing

`npm version <patch|minor|major>` does not update `server.json`, so bump both,
then push the tag:

```bash
npm version minor --no-git-tag-version      # bumps package.json
$EDITOR server.json                         # match "version" and packages[0].version
git commit -am "Release v0.2.0" && git tag v0.2.0
git push && git push --tags
```

The `release` workflow then verifies that the tag, `package.json` and
`server.json` all agree, validates `server.json` against the live registry, and
publishes to npm and to the MCP Registry. It needs an npm automation token in
the `NPM_TOKEN` repository secret; the MCP Registry needs no secret, because it
trusts the workflow's GitHub OIDC identity.

To publish by hand instead:

```bash
npm publish --access public

curl -fsSL https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_darwin_arm64.tar.gz | tar -xz mcp-publisher
./mcp-publisher validate
./mcp-publisher login github
./mcp-publisher publish
```

## License

MIT
