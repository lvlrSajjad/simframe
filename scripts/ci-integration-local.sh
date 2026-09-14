#!/bin/bash
# The `integration` job, run here instead of there.
#
# One round trip on a hosted runner is 30+ minutes, and cancel-in-progress means
# a second push while you wait throws the answer away. Most of what that job
# asserts is reproducible on a developer's own simulator in a couple of minutes,
# so there is no reason to learn it from GitHub.
#
# What it cannot reproduce is the runner's *speed*: this machine settles a
# screen in a few hundred milliseconds where a loaded hosted runner has taken
# 45s for a two-step flow. So a green run here means "the code is right", not
# "CI will pass" — see DEFERRED 95. Everything else that has gone red, including
# the fingerprint collision that took an evening to find, would have shown up in
# this script.
#
#   ./scripts/ci-integration-local.sh <udid>
#
# Assumes the device is booted and `simframe start` has been run on it, exactly
# as the job's earlier steps do.
set -u
DEVICE="${1:?usage: ci-integration-local.sh <udid>}"
cd "$(dirname "$0")/.." || exit 1
fails=0
step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf 'ok   %s\n' "$1"; }
bad()  { printf 'FAIL %s\n' "$1"; fails=$((fails+1)); }

export SIMFRAME_STRICT=1

step "Every layer is the good one, or this fails"
node src/cli.js doctor --json --device="$DEVICE" > /tmp/doctor-local.json 2>/dev/null
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/doctor-local.json", "utf8"));
const want = { "capture.engine": "simframed", "ocr.available": true };
let failed = false;
for (const [k, v] of Object.entries(want)) {
  const good = d[k] === v;
  console.log(`${good ? "ok  " : "FAIL"} ${k} = ${JSON.stringify(d[k])} (want ${JSON.stringify(v)})`);
  if (!good) failed = true;
}
for (const key of ["input.driver", "ax.driver"]) {
  const good = d[key] === "simframed";
  console.log(`${good ? "ok  " : "FAIL"} ${key} = ${JSON.stringify(d[key])} (want "simframed")`);
  if (!good) failed = true;
}
// A configured driver is not an answering driver — the same check as ci.yml.
// A whole CI run read the screen eighteen times, every reading came back
// OCR-only, and this step said `ok` because a driver was present.
{
  const n = d["ax.elements"];
  const good = typeof n === "number" && n > 0;
  console.log(`${good ? "ok  " : "FAIL"} ax.elements = ${JSON.stringify(n)} (want > 0 — the tree must answer, not merely exist)`);
  if (!good) failed = true;
}
if (d.warnings > 0) {
  console.log(`\n${d.warnings} degraded layer(s):`);
  for (const c of d.checks.filter((c) => c.level !== "ok")) console.log(`  ${c.level} ${c.name}: ${c.detail}`);
}
process.exit(failed ? 1 : 0);
' && ok "doctor: every layer is the daemon" || bad "doctor"

step "A step runs, and capture notices the screen change"
read_state() {
  node src/cli.js state --device="$DEVICE" --json \
    | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(s.hash+" "+s.seq)'
}
printf '[{"button":"home"},{"settle":true}]\n' > /tmp/reset-local.json
node src/cli.js do /tmp/reset-local.json --device="$DEVICE" >/dev/null 2>&1
BEFORE=$(read_state)
# A tap through simframe, not `simctl openurl` — see the job's comment. The
# assertion is that a step runs and capture notices it, and openurl asserted that
# through simctl, LaunchServices, a Safari cold start and a network fetch.
printf '[{"tap":"Settings","or":["@340,468"]},{"settle":true}]\n' > /tmp/flow-local.json
node src/cli.js do /tmp/flow-local.json --device="$DEVICE" >/tmp/step-local.log 2>&1 || true
AFTER=$(read_state)
if [ "${BEFORE%% *}" != "${AFTER%% *}" ]; then ok "frame hash changed: ${BEFORE%% *} -> ${AFTER%% *}"
else bad "a step ran and capture saw no change"; tail -5 /tmp/step-local.log; fi

step "The memory layer — screen map, refs, graph, verdicts, flows"
# Mirrors the job: exit 75 means the display wedged and nothing was tested, so
# revive once and run again; any other non-zero is a real check failing. The
# wedge lands on an app switch and hit roughly every other run of this script on
# the day it was written, which is most of why the job looked flaky.
if node scripts/ci-memory.mjs --device="$DEVICE"; then
  ok "ci-memory"
elif [ $? = 75 ]; then
  printf '     (the display wedged — DEFERRED 126. Reviving once and running again.)\n'
  node src/cli.js revive --device="$DEVICE" || true
  node scripts/ci-memory.mjs --device="$DEVICE" && ok "ci-memory (after one revive)" || bad "ci-memory"
else
  bad "ci-memory"
fi

step "The fingerprint distributions, measured and bounded"
node scripts/eval-fingerprint.mjs --tour=test/tours/device-native.json --rounds=3 \
  --device="$DEVICE" --out=/tmp/fp-local-ci.json --label=local-ci >/tmp/fp-out.txt 2>&1 \
  && ok "fingerprint distributions" || { bad "fingerprint distributions"; tail -25 /tmp/fp-out.txt; }

printf '\n=== %s failure(s) ===\n' "$fails"
exit $((fails > 0))
