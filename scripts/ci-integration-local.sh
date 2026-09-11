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
printf '[{"openUrl":"https://example.com"},{"settle":true}]\n' > /tmp/flow-local.json
if node src/cli.js do /tmp/flow-local.json --device="$DEVICE" >/dev/null 2>&1; then
  AFTER=$(read_state)
  if [ "${BEFORE%% *}" != "${AFTER%% *}" ]; then ok "frame hash changed: ${BEFORE%% *} -> ${AFTER%% *}"
  else bad "a step ran cleanly but capture saw no change"; fi
else
  bad "openUrl flow failed"
fi

step "The memory layer — screen map, refs, graph, verdicts, flows"
node scripts/ci-memory.mjs --device="$DEVICE" && ok "ci-memory" || bad "ci-memory"

step "The fingerprint distributions, measured and bounded"
node scripts/eval-fingerprint.mjs --tour=test/tours/device-native.json --rounds=3 \
  --device="$DEVICE" --out=/tmp/fp-local-ci.json --label=local-ci >/tmp/fp-out.txt 2>&1 \
  && ok "fingerprint distributions" || { bad "fingerprint distributions"; tail -25 /tmp/fp-out.txt; }

printf '\n=== %s failure(s) ===\n' "$fails"
exit $((fails > 0))
