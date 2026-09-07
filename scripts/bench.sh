#!/usr/bin/env bash
# Reproduces every number in docs/BENCHMARKS.md.
#
# Needs a booted simulator. Numbers are medians; the first sample of anything
# involving Vision is discarded, because its warm-up dwarfs the measurement.
set -uo pipefail
cd "$(dirname "$0")/.."

DEVICE="${1:-}"
BIN=native/simframed/.build/release/simframed

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

say "environment"
printf '  chip    %s\n' "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
printf '  macOS   %s\n' "$(sw_vers -productVersion)"
printf '  Xcode   %s\n' "$(xcodebuild -version 2>/dev/null | head -1)"

say "building simframed (release)"
swift build -c release --package-path native/simframed 2>&1 | tail -1

UDID="$DEVICE"
if [ -z "$UDID" ]; then
  UDID=$($BIN devices | head -1 | awk '{print $1}')
fi
if [ -z "$UDID" ]; then
  echo "  no booted simulator; boot one and re-run" >&2
  exit 1
fi
printf '  device  %s\n' "$($BIN devices | grep "$UDID" | cut -c40-)"

say "capture pipeline (Phase 0)"
$BIN bench --udid="$UDID" --n=300 | sed 's/^/  /'
$BIN bench --udid="$UDID" --n=300 --max-dim=420 | sed 's/^/  /'

say "simctl + sips, the path it replaces"
for _ in 1 2 3 4 5; do
  /usr/bin/time -p sh -c "xcrun simctl io $UDID screenshot --type=png --mask=ignored /tmp/bench.png >/dev/null 2>&1 && sips -Z 700 /tmp/bench.png --out /tmp/bench-s.png >/dev/null 2>&1" 2>&1 | grep real
done | awk '{s+=$2; n++} END {printf "  mean %.0f ms over %d runs\n", s/n*1000, n}'

say "hash compatibility (Swift vs JavaScript, needs a still screen)"
node -e '
const { execSync } = require("child_process");
(async () => {
  const api = await import("./src/index.js");
  const { hashDistance } = await import("./src/analyze.js");
  let a, b;
  for (let i = 0; i < 25; i++) {
    a = (await api.getState(undefined, {})).state;
    await new Promise(r => setTimeout(r, 1000));
    b = (await api.getState(undefined, {})).state;
    if (a.hash === b.hash && a.layoutHash === b.layoutHash) break;
  }
  if (a.hash !== b.hash) { console.log("  screen never settled; skipped"); return; }
  const sw = JSON.parse(execSync("native/simframed/.build/release/simframed hash").toString());
  console.log(`  frameHash  delta ${hashDistance(b.hash, sw.hash)}/128`);
  console.log(`  layoutHash delta ${hashDistance(b.layoutHash, sw.layoutHash)}/288`);
})()' 2>/dev/null

say "control socket round trips (Phase 1)"
node -e '
import("./src/control.js").then(async (c) => {
  const UD = process.argv[1];
  const med = a => { const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };
  const bench = async (label, fn, n) => {
    const t = []; for (let i=0;i<n;i++){ const t0=Date.now(); await fn(i); t.push(Date.now()-t0); }
    console.log(`  ${label.padEnd(22)} n=${String(n).padStart(3)}  median ${med(t)}ms`);
  };
  await bench("ping", () => c.request(UD,{action:"ping"}), 100);
  await bench("status", () => c.status(UD), 50);
  await bench("tap (70ms hold)", i => c.tap(UD, 200+(i%3), 300), 100);
  await bench("tap (10ms hold)", i => c.tap(UD, 200+(i%3), 300, {durationMs:10}), 100);
})' "$UDID" 2>/dev/null

say "text recognition (Phase 2)"
node -e '
import("./src/control.js").then(async (c) => {
  const UD = process.argv[1];
  const med = a => { const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };
  const t=[]; for (let i=0;i<12;i++){ const t0=Date.now(); await c.request(UD,{action:"ui"}); t.push(Date.now()-t0); }
  // Drop the first: Vision warm-up dwarfs it.
  console.log(`  in-process   first ${t[0]}ms  median ${med(t.slice(1))}ms`);
})' "$UDID" 2>/dev/null

say "screen map build (Phase 2)"
node -e '
import("./src/index.js").then(async (api) => {
  const UD = process.argv[1];
  for (const pass of [1,2,3]) {
    api.screenmap.forget(UD);
    const t0 = Date.now();
    try { await api.locate(undefined, "a", {}); } catch { /* the label need not exist */ }
    console.log(`  build ${pass}: ${Date.now()-t0}ms`);
  }
})' "$UDID" 2>/dev/null

say "done — compare against docs/BENCHMARKS.md"
