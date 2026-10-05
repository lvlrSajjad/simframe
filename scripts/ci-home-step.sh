#!/usr/bin/env bash
# A step runs, and capture notices the screen change: launch Settings, press
# home, assert the frame hash moved. The reasoning for that pairing is the
# comment on the step in .github/workflows/ci.yml.
#
#   node scripts/ci-device-guard.mjs "$DEVICE" -- bash scripts/ci-home-step.sh "$DEVICE"
#
# A script rather than inline YAML so the guard can run it whole. The guard's
# cure is `simframe revive`, which restarts the device and leaves it on the
# home screen, so retrying only the home press after a revive would press home
# on home and assert a change that cannot happen. The setup has to run again
# with it, and that is only possible if they are one command.
#
# Inline, it was outside the guard entirely. The scheduled run of 2026-10-05
# had the display go black after the press — the capture wedge, which DEFERRED
# records as the simulator's — retried it three times on the same black
# screen with no revive between, and printed "this is not the runner".
set -euo pipefail
DEVICE="${1:?usage: ci-home-step.sh <udid>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The guard's own classifier, so this script and the guard cannot disagree
# about what is the device.
is_device() {
  node --input-type=module -e "
    import { deviceCause } from '$ROOT/src/device-state.js';
    process.exit(deviceCause(process.argv[1]) ? 0 : 1);
  " "$1"
}

read_state() {
  simframe state --device="$DEVICE" --json \
    | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(s.hash+" "+s.seq)'
}

# Setup, not the assertion: get to a known screen that is not the home screen.
# Retried, because `simctl launch` is merely slow on a loaded runner rather
# than broken, and a launch that has not happened makes the assertion
# meaningless rather than failing.
SETUP=$(mktemp -t simframe-ci-setup)
printf '[{"launch":{"value":"com.apple.Preferences","relaunch":true}},{"settle":{"timeoutMs":25000}}]\n' > "$SETUP"
for attempt in 1 2 3; do
  if simframe do "$SETUP" --device="$DEVICE"; then
    break
  fi
  if [ "$attempt" = 3 ]; then
    echo "FAIL could not reach a known screen in 3 attempts — nothing below would mean anything" >&2
    simframe state --device="$DEVICE" --json || true
    simframe ui --device="$DEVICE" || true
    exit 1
  fi
  echo "     (setup launch failed on attempt $attempt — retrying)"
  sleep 5
done
BEFORE=$(read_state)

# The assertion. Pressing home from inside an app always changes the screen,
# and it is simframe's own HID path end to end.
#
# Retried here too, but not past a device condition: three more presses on a
# wedged display cost two minutes and learn nothing. This stops at once, and
# the guard, reading the same output with the same `deviceCause`, revives and
# runs the whole script again.
FLOW=$(mktemp -t simframe-ci-home)
printf '[{"button":"home"},{"settle":{"timeoutMs":25000}}]\n' > "$FLOW"
for attempt in 1 2 3; do
  if OUT=$(simframe do "$FLOW" --device="$DEVICE" 2>&1); then
    printf '%s\n' "$OUT"
    break
  fi
  printf '%s\n' "$OUT"
  if [ "$attempt" = 3 ] || is_device "$OUT"; then
    echo "FAIL home through simframe failed on attempt $attempt" >&2
    simframe ui --device="$DEVICE" || true
    exit 1
  fi
  echo "     (the home flow failed on attempt $attempt — retrying)"
  sleep 5
done
AFTER=$(read_state)

node -e '
  const [bh, bs] = process.argv[1].split(" ");
  const [ah, as] = process.argv[2].split(" ");
  const moved = bh !== ah;
  console.log(`${moved ? "ok  " : "FAIL"} frame hash changed: ${bh.slice(0, 10)} -> ${ah.slice(0, 10)}`);
  console.log(`     seq ${bs} -> ${as}`);
  if (!moved) console.error("a step ran cleanly but capture saw no change; the pipeline is not live");
  process.exit(moved ? 0 : 1);
' "$BEFORE" "$AFTER"
