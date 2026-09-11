#!/usr/bin/env node
// Generate a population of supervisor rulings, and score them.
//
// Items 101, 96, 106 and 109a all need rulings to replay, and the log held one,
// because a ruling requires a step that genuinely fails and Apple's own apps do
// not fail on command. The React Native testbed does, from a seeded stream, so
// this turns "we need dozens of rulings" into a script.
//
// Every fixture here has a **known correct outcome**, which is what makes the
// population scoreable rather than merely large:
//
//   arriving  a list still loading. Re-running the step works, so the right
//             answer is wait/retry and the right outcome is `recovered`.
//   blocked   a required field is empty, so the thing waited for can never
//             appear. Waiting and retrying are both wrong; `stopped` is right.
//   refused   a submit that failed. Re-running the *wait* cannot help — only
//             re-submitting could, and that is the planner's call, not the
//             supervisor's — so `stopped` is right here too.
//
// Note `refused` and `blocked` want the same answer for different reasons. That
// is deliberate: a judge that says stop for the wrong reason is still right, and
// a population that only contains obvious cases measures nothing.
//
//   SIMFRAME_SUPERVISOR=apple node scripts/collect-rulings.mjs --device=<udid> --seeds=8
import { execFile } from 'node:child_process';
import * as actions from '../src/actions.js';
import * as api from '../src/index.js';
import * as metrics from '../src/metrics.js';
import * as store from '../src/store.js';
import * as supervisor from '../src/supervisor.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const device = arg('device');
const seeds = Number(arg('seeds', 6));
const BUNDLE = 'com.example.simframetestbed';

if (!supervisor.requested({})) {
  console.error('SIMFRAME_SUPERVISOR is not set, so nothing would be judged and no ruling would be recorded.');
  process.exit(2);
}

const { device: dev } = await api.ensureDaemon(device);
console.log(`device: ${dev.name} (${dev.runtime})`);

/**
 * Cold-launch the app with a seed.
 *
 * `openUrl` on a terminated app launches it with that URL as its initial URL,
 * which is the only way to set the seed *before* the first screen mounts and
 * starts its own timers. Relaunching and then opening the URL would be too
 * late: the list's delay has already been drawn from the default stream.
 */
const launchSeeded = async (seed) => {
  // Terminating an app that is not running fails, and a failed step aborts the
  // rest of the batch — so it gets its own call and its own shrug.
  await actions.runScript(device, { steps: [{ terminate: BUNDLE }], verify: false }).catch(() => null);
  await actions.runScript(device, {
    steps: [{ openUrl: `simframetestbed://seed/${seed}` }, { pause: 1200 }],
    verify: false,
  });
  // iOS asks "Open in ...?" whenever a custom scheme is opened by another
  // process, springboard included, and it asks on every launch. Answered here
  // rather than designed around: the alternative is launch arguments, which RN
  // does not expose to JavaScript without a native module.
  await actions.runScript(device, {
    steps: [{ tap: 'Open' }, { pause: 2200 }],
    verify: false,
  }).catch(async () => {
    // No dialog this time. Give the app the same settling time anyway, so the
    // fixture's timing does not depend on whether iOS felt like asking.
    await actions.runScript(device, { steps: [{ pause: 2200 }], verify: false }).catch(() => null);
  });
};

/**
 * Revive the device if capture has given up, and keep going.
 *
 * Collecting a population means driving one simulator hard for several minutes,
 * and the display stops rendering when you do — twice in one afternoon here. The
 * daemon detects it, tries both its recoveries, reports `stalled` and stops,
 * because a capture loop that rebooted the device it was watching would be a
 * tool reaching for the mains. This is a harness, not the product, and the
 * operator's answer is exactly what it is here to automate — otherwise a run of
 * twenty fixtures ends at the third and the population is however many rulings
 * the device survived.
 */
const reviveIfWedged = async () => {
  const health = store.captureHealth(dev.udid);
  if (!health?.stalled) return false;
  process.stdout.write('  (capture stalled — reviving the device before continuing)\n');
  await new Promise((resolve) => {
    execFile(process.execPath, ['src/cli.js', 'revive', `--device=${dev.udid}`],
      { timeout: 300_000, cwd: new URL('..', import.meta.url).pathname }, () => resolve());
  });
  return true;
};

const FIXTURES = [
  {
    name: 'arriving',
    want: 'recovered',
    steps: [{ waitFor: { value: 'Monstera #1', timeoutMs: 900 } }],
    expect: 'the list is still loading; its rows arrive shortly after launch',
  },
  {
    name: 'blocked',
    want: 'stopped',
    steps: [
      { tap: 'Forms, tab, 2 of 3' }, { tap: 'Stepped form' },
      { tap: 'Next' }, { tap: 'Next' },
      { waitFor: { value: 'Submitted', timeoutMs: 2500 } },
    ],
    expect: 'Review is blocked until Species is filled in, and it is empty',
  },
  {
    name: 'refused',
    want: 'stopped',
    steps: [
      { tap: 'Forms, tab, 2 of 3' }, { tap: 'One-step form' },
      { pause: 6500 },
      { type: { into: 'Your Name', text: 'Ada' } },
      { tap: 'Submit' },
      { waitFor: { value: 'Saved', timeoutMs: 2500 } },
    ],
    expect: 'the first submit always fails and the second works, so waiting cannot help',
  },
];

const before = metrics.readSupervisions(dev.udid).length;
let runs = 0;

for (let i = 0; i < seeds; i += 1) {
  const seed = 1000 + i * 7;
  for (const fx of FIXTURES) {
    await reviveIfWedged();
    await launchSeeded(seed);
    const steps = fx.steps.map((s, idx) => (idx === fx.steps.length - 1 ? { ...s, expect: fx.expect } : s));
    try {
      await actions.runScript(device, { steps, supervise: fx.name, verify: true });
    } catch { /* a failing flow is the point */ }
    runs += 1;
    process.stdout.write(`  seed ${seed}  ${fx.name.padEnd(9)} run\n`);
  }
}

const all = metrics.readSupervisions(dev.udid);
const fresh = all.slice(before);
console.log(`\n${runs} runs produced ${fresh.length} ruling(s)\n`);

const byFixture = new Map(FIXTURES.map((f) => [f.expect, f]));
const score = new Map(FIXTURES.map((f) => [f.name, { n: 0, right: 0, decisions: {}, outcomes: {} }]));
let unattributed = 0;
for (const r of fresh) {
  const fx = byFixture.get(r.expect);
  if (!fx) { unattributed += 1; continue; }
  const s = score.get(fx.name);
  s.n += 1;
  s.decisions[r.decision] = (s.decisions[r.decision] ?? 0) + 1;
  s.outcomes[r.outcome] = (s.outcomes[r.outcome] ?? 0) + 1;
  if (r.outcome === fx.want) s.right += 1;
}

console.log(`${'fixture'.padEnd(10)} ${'n'.padStart(3)} ${'right'.padStart(6)}  wanted      decisions / outcomes`);
for (const fx of FIXTURES) {
  const s = score.get(fx.name);
  const pct = s.n ? `${Math.round((100 * s.right) / s.n)}%` : '—';
  console.log(
    `${fx.name.padEnd(10)} ${String(s.n).padStart(3)} ${pct.padStart(6)}  ${fx.want.padEnd(10)}  `
    + `${JSON.stringify(s.decisions)} / ${JSON.stringify(s.outcomes)}`,
  );
}
if (unattributed) console.log(`\n${unattributed} ruling(s) came from a step this script did not label.`);
console.log(`\nthe log now holds ${all.length} ruling(s) — simframe supervisions --device=${dev.udid}`);
