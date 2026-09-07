# simframe

**Always-warm iOS Simulator frames for coding agents.**

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
| "Did my tap do anything?" | screenshot, compare by eye | `sim_state` — a stable screen hash plus an ASCII map of which regions moved |
| "Wait for the animation to end" | sleep, screenshot, hope, repeat | `sim_wait` — blocks until the screen actually settles, then returns the frame |
| "What did that transition look like?" | 5 screenshots, 5 round trips, 5 images | `sim_strip` — the last N buffered frames tiled into **one** image, looking backwards in time |

The change map is the part that pays for itself. A screen hash and a
4×8 movement grid cost a couple of hundred bytes, so an agent can poll freely
and only spend image tokens when there is genuinely something new to look at:

```
$ simframe state
iPhone 17 Pro  frame #3  age 124ms  322x700
hash 007cfefefefefefefefefefefefefe00  diff 0.15453  stable 0ms
@@@@
###*
+*#*
:.#*
..#*
..#*
..#*
@@@@      ← a screen sliding in from the right, mid-transition
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
| `sim_state` | Text only: screen hash, how long the screen has been still, change since the previous frame, and the region movement map. |
| `sim_wait` | Blocks until the screen settles (`mode: "stable"`) or moves away from what it shows now (`mode: "change"`), then returns the frame. |
| `sim_strip` | The last N buffered frames tiled into one image, oldest first, with millisecond offsets. |
| `sim_capture` | `status` / `start` / `stop` for the background loops. Rarely needed. |
| `sim_devices` | Booted simulators simframe can capture. |

Every tool takes an optional `device` (UDID or a substring of the name) and
defaults to the booted simulator.

## CLI

The same capabilities without an agent, useful for debugging and scripts:

```bash
simframe start                 # start the capture loop
simframe state                 # metadata + change map
simframe frame --out=now.png   # newest frame, --detail=low|normal|high|full
simframe wait --stable-ms=700  # block until the screen settles
simframe wait --change         # block until the screen changes
simframe strip --count=6       # contact sheet of recent frames
simframe status                # what is running, and how fresh
simframe stop --all
simframe devices --all
simframe doctor
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
  loops would otherwise overwrite and prune each other's frames.
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
| Disk | ~2 MB per device (24-frame ring) |

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
- simframe **reads** the screen; it does not tap, swipe or type. It is meant to
  sit alongside whatever already drives input, replacing only the screenshot.
- Capture tops out near 6 fps, because `simctl io screenshot` costs ~130 ms.
  Fast animations are sampled, not recorded.

## Roadmap

- A higher-frame-rate backend via `simctl io recordVideo` piped through ffmpeg,
  used automatically when ffmpeg is present.
- Optional accessibility-tree text alongside the frame, so an agent can read
  labels without spending image tokens.
- Fusing input with settle-and-look, so tap → wait → see is one round trip
  rather than three.

## License

MIT
