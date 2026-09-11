#!/usr/bin/env node
// How long can this device be driven before capture wedges?
//
// The wedge is the thing standing between us and a ruling population: the
// display stops rendering after a few minutes of hard driving, `simctl
// screenshot` fails too, both of the daemon's recoveries fail, and only a
// device restart cures it. Three times in one afternoon.
//
// A leak was found in our own code on 2026-09-12 — damage-callback registration
// was not idempotent, and the recovery loop called it on every attempt, so one
// log's 670 port re-resolves meant up to 670 live callbacks on one port, each
// invoked per redraw. That is a real leak with a plausible path to saturating
// the display service, and it is **not proof** that it is the cause. This is
// how we find out: drive until it dies, and report how long that took.
//
//   node scripts/soak-capture.mjs --device=<udid> --minutes=25
//
// A number to compare against, not a pass/fail. Before the fix, the device
// wedged roughly every 10-20 minutes of this kind of work.
import * as actions from '../src/actions.js';
import * as api from '../src/index.js';
import * as store from '../src/store.js';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const device = arg('device');
const minutes = Number(arg('minutes', 20));
const BUNDLE = 'com.example.simframetestbed';

const { device: dev } = await api.ensureDaemon(device);
console.log(`device: ${dev.name} (${dev.runtime})   budget: ${minutes} minutes`);

const started = Date.now();
const deadline = started + minutes * 60_000;
let laps = 0;
let reads = 0;
const elapsed = () => ((Date.now() - started) / 60_000).toFixed(1);

// A lap is deliberately the kind of work that provokes it: launching, moving
// between screens, and a cold read on each — not idling with a poll.
const LAP = [
  [{ launch: { value: BUNDLE, relaunch: true } }, { pause: 2500 }],
  [{ tap: 'Forms, tab, 2 of 3' }, { pause: 800 }],
  [{ tap: 'Long form' }, { pause: 900 }],
  [{ scroll: 'down' }, { pause: 500 }],
  [{ scroll: 'down' }, { pause: 500 }],
  [{ tap: 'Plants, tab, 1 of 3' }, { pause: 900 }],
  [{ tap: 'Diagnostics, tab, 3 of 3' }, { pause: 900 }],
];

while (Date.now() < deadline) {
  for (const steps of LAP) {
    try {
      await actions.runScript(device, { steps, verify: false, options: { supervisor: 'none' } });
    } catch { /* a failed step is not the subject; a dead display is */ }
    try {
      await api.screenIdentity(device, { fresh: true, confirmNovel: false });
      reads += 1;
    } catch (err) {
      console.log(`\nWEDGED after ${elapsed()} minutes, ${laps} laps, ${reads} cold reads`);
      console.log(`  ${String(err.message).split('\n')[0]}`);
      const health = store.captureHealth(dev.udid);
      if (health) console.log(`  captureHealth: ${JSON.stringify(health)}`);
      process.exit(1);
    }
  }
  laps += 1;
  if (laps % 5 === 0) process.stdout.write(`  ${elapsed()}m  ${laps} laps  ${reads} reads  still alive\n`);
}
console.log(`\nSURVIVED ${minutes} minutes: ${laps} laps, ${reads} cold reads, no wedge`);
