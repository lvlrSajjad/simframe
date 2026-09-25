# The README GIF, and how to remake it

`docs/simframe-demo.gif` is a `simctl` recording of the benchmark simulator
composed with the flow's own JSON verdicts. No dependency was added: the
compositor is one Swift file on AVFoundation, CoreText and ImageIO.

1. Boot a simulator, launch Settings so the flow starts at its root, then
   record while the flow runs and keep the wall-clock bounds:

   ```bash
   D=<udid>
   xcrun simctl launch $D com.apple.Preferences; sleep 4
   xcrun simctl io $D recordVideo --codec h264 --force take.mp4 & REC=$!; sleep 4
   T0=$(python3 -c 'import time;print(int(time.time()*1000))')
   simframe do scripts/demo-gif/flow.json --device=$D --json > do.json
   T1=$(python3 -c 'import time;print(int(time.time()*1000))')
   sleep 2; kill -INT $REC; wait $REC
   ```

   Record with the app already launched: a `launch` step inside the recording
   took 8–10 s on two takes because the launch did not front on the first
   attempt while `recordVideo` was attached, against 89 ms without it.

2. Build `events.json` from `do.json`, `T0` and `T1` — the shape is in
   `events.example.json`: every `t` is an epoch millisecond, and
   `videoEndEpochMs` is `T1 + 2000`, which is how the compositor finds where
   the recording starts without a timestamp from `simctl`.

3. Compose:

   ```bash
   swift scripts/demo-gif/compose.swift take.mp4 events.json docs/simframe-demo.gif
   ```

   760×560, 10 fps, the last frame held two seconds; the example take is
   85 frames and 336 KB.
