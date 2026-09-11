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

// Before anything else, because the device may already be wedged from the last
// run — `ensureDaemon` throws on a display that has stopped rendering, and it
// threw here on the third attempt of the afternoon, before the loop's own check
// could ever run. Driving one simulator hard for a few minutes is what does it.
{
  const { execFileSync } = await import('node:child_process');
  try {
    await api.ensureDaemon(device);
  } catch {
    console.log('the device is not producing frames; reviving before starting');
    try {
      execFileSync(process.execPath, ['src/cli.js', 'revive', `--device=${device}`],
        { cwd: new URL('..', import.meta.url).pathname, timeout: 300_000, stdio: 'inherit' });
    } catch { /* reported below by the throw from ensureDaemon */ }
  }
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
/**
 * Scaffolding runs with the supervisor OFF, and that is not a detail.
 *
 * The first collection run produced 18 rulings of which **14 came from the
 * harness's own plumbing** — seven from tapping an "Open in …?" dialog that was
 * not always there, two from terminating an app that was not running, three
 * from typing into a form we had failed to reach. Every one was a real
 * consultation and every one would have landed in the population that 101 and
 * 96 are going to measure.
 *
 * A fixture is a claim about what the supervisor should say. Plumbing is not,
 * and a harness that cannot tell them apart is measuring itself.
 */
const SCAFFOLD = { supervisor: 'none' };

const launchSeeded = async (seed) => {
  // Terminating an app that is not running fails, and a failed step aborts the
  // rest of the batch — so it gets its own call and its own shrug.
  await actions.runScript(device, { steps: [{ terminate: BUNDLE }], verify: false, options: SCAFFOLD }).catch(() => null);
  await actions.runScript(device, {
    steps: [{ openUrl: `simframetestbed://seed/${seed}` }, { pause: 1200 }],
    verify: false,
    options: SCAFFOLD,
  });
  // iOS asks "Open in ...?" whenever a custom scheme is opened by another
  // process, springboard included, and it asks on every launch. Answered here
  // rather than designed around: the alternative is launch arguments, which RN
  // does not expose to JavaScript without a native module.
  await actions.runScript(device, {
    steps: [{ tap: 'Open' }, { pause: 2200 }],
    verify: false,
    options: SCAFFOLD,
  }).catch(async () => {
    // No dialog this time. Give the app the same settling time anyway, so the
    // fixture's timing does not depend on whether iOS felt like asking.
    await actions.runScript(device, { steps: [{ pause: 2200 }], verify: false, options: SCAFFOLD }).catch(() => null);
  });
};

/**
 * Walk to where a fixture starts, unjudged — and *prove* you arrived.
 *
 * Navigation is scaffolding too. Three of the first run's stray rulings were a
 * `type` that failed because the form had never been reached.
 *
 * The `arrive` half is the harder lesson, and it cost a wrong number. A walk
 * that does not throw is not a walk that arrived: two `Next` taps landed on a
 * live button, threw nothing, and advanced nothing, so **three of four rulings
 * in the first clean run were taken on step 1 of a three-step form** while the
 * fixture claimed they were about the review step. The scoreboard read 25% and
 * was measuring the harness.
 *
 * `eval-fingerprint.mjs` already learned exactly this — it checks that each
 * reading was taken on the screen the tour named, having once measured a
 * distribution against readings taken somewhere else. The check simply had not
 * been carried over.
 */
const walk = async (steps, arrive) => {
  try {
    if (steps.length) await actions.runScript(device, { steps, verify: false, options: SCAFFOLD });
    if (!arrive) return true;
    // Asserted, not assumed. An assert that throws means we are not there.
    await actions.runScript(device, {
      steps: [{ assert: { value: arrive, is: 'visible' } }],
      verify: false,
      options: SCAFFOLD,
    });
    return true;
  } catch {
    return false;
  }
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
    // Pull to refresh rather than relying on the launch, because reaching the
    // fixture now takes three seconds of its own — answering iOS's "Open in …?"
    // — and by then the list has always arrived. The first clean run produced
    // *no rulings at all* from this fixture for that reason. A refresh empties
    // the list and reloads it on a fresh seeded delay, right where we want it.
    walk: [{ swipe: { from: [201, 300], to: [201, 620] } }],
    arrive: null,
    judge: { waitFor: { value: 'Monstera #1', timeoutMs: 700 } },
    expect: 'the list is still loading; its rows arrive shortly after launch',
  },
  {
    name: 'detail',
    want: 'recovered',
    // A detail screen that is still fetching. Waiting is the right answer and
    // re-running the step proves it, which is what makes this scoreable.
    walk: [{ tap: 'Monstera #1' }],
    arrive: null,
    judge: { waitFor: { value: 'Prefers bright indirect light', timeoutMs: 700 } },
    expect: 'the detail screen is still fetching; its text arrives shortly',
  },
  {
    name: 'secondwave',
    want: 'recovered',
    // The list renders its count header, then a third of its rows, then the
    // rest. `Jade #24` is in the last wave, so a tight wait for it fails while
    // the screen is *stable and incomplete at the same moment* — the state that
    // has fooled settle detection and the supervisor alike.
    walk: [{ swipe: { from: [201, 300], to: [201, 620] } }],
    arrive: null,
    judge: { waitFor: { value: 'Jade #24', timeoutMs: 700 } },
    expect: 'the list arrives in waves and this row is in the last one',
  },
  {
    name: 'blocked',
    want: 'stopped',
    walk: [
      { tap: 'Forms, tab, 2 of 3' }, { pause: 900 }, { tap: 'Stepped form' }, { pause: 900 },
      { tap: 'Next' }, { pause: 1200 }, { tap: 'Next' }, { pause: 1200 },
    ],
    // The review step, proved rather than hoped for.
    arrive: 'Step 3 of 3',
    judge: { waitFor: { value: 'Submitted', timeoutMs: 2500 } },
    expect: 'Review is blocked until Species is filled in, and it is empty',
  },
  {
    name: 'refused',
    want: 'stopped',
    walk: [
      { tap: 'Forms, tab, 2 of 3' }, { pause: 900 }, { tap: 'One-step form' },
      { pause: 6500 },
      { type: { into: 'Your Name', text: 'Ada' } },
      { tap: 'Submit' }, { pause: 1200 },
    ],
    // The rejection is on screen, so the submit demonstrably happened and
    // failed — otherwise this fixture can pass by never having submitted.
    arrive: 'The order was rejected',
    // "Saved" was the string here and it fuzzy-matched "Could not save: …", so
    // the judge step *succeeded* on the failure it was meant to catch and the
    // fixture produced no rulings at all. Success and failure now share no words.
    judge: { waitFor: { value: 'Order placed', timeoutMs: 2500 } },
    expect: 'the first submit always fails and the second works, so waiting cannot help',
  },
];

const before = metrics.readSupervisions(dev.udid).length;
let runs = 0;
let skipped = 0;

for (let i = 0; i < seeds; i += 1) {
  const seed = 1000 + i * 7;
  for (const fx of FIXTURES) {
    await reviveIfWedged();
    await launchSeeded(seed);
    const reached = await walk(fx.walk, fx.arrive);
    if (!reached) {
      process.stdout.write(`  seed ${seed}  ${fx.name.padEnd(9)} SKIPPED — could not reach the fixture\n`);
      skipped += 1;
      continue;
    }
    try {
      await actions.runScript(device, {
        steps: [{ ...fx.judge, expect: fx.expect }],
        supervise: fx.name,
        verify: true,
      });
    } catch { /* a failing step is the point */ }
    runs += 1;
    process.stdout.write(`  seed ${seed}  ${fx.name.padEnd(9)} judged\n`);
  }
}

const all = metrics.readSupervisions(dev.udid);
const fresh = all.slice(before);
console.log(`\n${runs} judged step(s), ${skipped} skipped, ${fresh.length} ruling(s)\n`);

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

// Said before the accuracy is read, not after. The first population was 12
// `stop` to 2 `wait`, so a majority-class guess scored 86% against the model's
// 64% — and every number computed from it was an artifact of that skew. A
// scoreboard that prints accuracy without printing its own balance invites
// exactly that mistake a second time.
{
  const want = {};
  for (const fx of FIXTURES) {
    const s = score.get(fx.name);
    want[fx.want] = (want[fx.want] ?? 0) + s.n;
  }
  const total = Object.values(want).reduce((a, b) => a + b, 0);
  const biggest = Math.max(0, ...Object.values(want));
  const baseline = total ? Math.round((100 * biggest) / total) : 0;
  console.log(`\nbalance: ${JSON.stringify(want)} — guessing the commonest answer scores ${baseline}%.`);
  if (baseline > 65) {
    console.log('  SKEWED. Any accuracy above is mostly a fact about the fixture set, not the judge.');
    console.log('  Add fixtures for the under-represented answer before comparing anything against anything.');
  }
}
console.log(`\nthe log now holds ${all.length} ruling(s) — simframe supervisions --device=${dev.udid}`);
