#!/usr/bin/env node
// Ask several supervisors the same questions.
//
//   node scripts/replay-rulings.mjs --device=<udid> --arms=apple,ollama:qwen3:8b,ollama:qwen3:14b
//
// The owner's call, 2026-09-11: settle the capacity question with numbers
// rather than speculation. This is how, and the shape matters more than the
// result.
//
// **Why replay rather than re-drive.** Collecting a population per arm means
// driving the simulator once per arm — about half an hour each — and, worse, it
// puts the *device's* variance inside a comparison that is supposed to be about
// the judges. A list that happened to arrive faster on one pass than another is
// not a fact about a model. So one device pass records the situations (see
// `situation` in metrics.recordSupervision) and every arm answers the identical
// set.
//
// **What replay cannot measure**, stated here rather than discovered later: the
// `outcome` column. Whether acting on a ruling actually recovered the flow is a
// fact about the device at that moment, and it belongs to the arm that was
// live. Replay scores *decisions*. The distinction is load-bearing — the live
// population scored 91% by decision and 69% by outcome, and almost all of that
// gap was one fixture that took the right word eight times and recovered once.
import * as metrics from '../src/metrics.js';
import * as ollama from '../src/ollama.js';
import * as supervisor from '../src/supervisor.js';
import { resolveDevice } from '../src/platform/index.js';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

/** The fixtures and the word each situation actually calls for. Same table as the scorer. */
const CORRECT = {
  'the list is still loading; its rows arrive shortly after launch': 'wait',
  'the detail screen is still fetching; its text arrives shortly': 'wait',
  'the list arrives in waves and this row is in the last one': 'wait',
  'Review is blocked until Species is filled in, and it is empty': 'stop',
  'the first submit always fails and the second works, so waiting cannot help': 'stop',
};

/** `retry` and `wait` differ only in how long they settle, so both satisfy a wait. */
const satisfies = (d, want) => (want === 'wait' ? d === 'wait' || d === 'retry' : d === want);

const dev = await resolveDevice(arg('device'));
const arms = String(arg('arms', 'apple')).split(',').map((a) => a.trim()).filter(Boolean);
const lastN = Number(arg('last', 0));

const all = metrics.readSupervisions(dev.udid)
  .filter((r) => CORRECT[r.expect] && r.situation?.step && r.situation?.failure);
const rows = lastN > 0 ? all.slice(-lastN) : all;

if (rows.length < 8) {
  console.error(`only ${rows.length} replayable ruling(s) — need situations recorded, which`);
  console.error('means a population collected after the situation field was added.');
  console.error('Run: SIMFRAME_SUPERVISOR=apple node scripts/collect-rulings.mjs --device=<udid>');
  process.exit(2);
}

const want = (r) => CORRECT[r.expect];
const counts = rows.reduce((a, r) => ({ ...a, [want(r)]: (a[want(r)] ?? 0) + 1 }), {});
const commonest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
const baseline = commonest[1] / rows.length;
const pct = (x) => `${(100 * x).toFixed(0)}%`;

console.log(`${rows.length} situations from ${dev.name}`);
console.log(`balance: ${JSON.stringify(counts)}`);
console.log(`majority-class baseline: always "${commonest[0]}" scores ${pct(baseline)}`);
if (baseline > 0.65) {
  console.log('\nSKEWED — any accuracy below is mostly a fact about the fixture set.');
}
// The free comparison, computed here so it is in the same table as the models
// rather than in a different report. It is not an arm; it is the thing every
// arm has to beat to be worth its latency.
const STILL_MS_THRESHOLD = 3000;
console.log(`\nthe brief every model arm gets is ${ollama.readBrief().length} characters, read from native/supervise.swift`);

const results = [];
for (const arm of arms) {
  const judged = [];
  let unanswered = 0;
  // Weights first, so the first situation is not timing a disk read.
  if (arm.startsWith('ollama')) await ollama.preload(ollama.parseTarget(arm));
  process.stdout.write(`\nasking ${arm} …`);
  for (const r of rows) {
    const detail = {};
    const ruling = await supervisor.judge({
      ...r.situation,
      options: { supervisor: arm },
      // Wide on purpose. The shipped budget is 2.5s and a 14B will exceed it;
      // capping here would score the larger model on *latency* while calling it
      // accuracy, and latency is reported separately below where it can be read
      // for what it is.
      timeoutMs: 30_000,
      detail,
    });
    if (!ruling) unanswered += 1;
    judged.push({ r, ruling, detail });
    process.stdout.write('.');
  }
  const answered = judged.filter((j) => j.ruling);
  const right = answered.filter((j) => satisfies(j.ruling.decision, want(j.r))).length;
  const lat = answered.map((j) => j.ruling.ms).filter(Number.isFinite).sort((a, b) => a - b);
  results.push({
    arm,
    judged,
    n: rows.length,
    unanswered,
    // Scored over every situation, not only the answered ones. A judge that
    // declines half the questions and is right about the rest is not an 100%
    // judge, and scoring only its answers would say it was.
    accuracy: right / rows.length,
    medianMs: lat.length ? lat[lat.length >> 1] : null,
    errors: answered
      .filter((j) => !satisfies(j.ruling.decision, want(j.r)))
      .map((j) => `said "${j.ruling.decision}" where "${want(j.r)}" was right — ${j.r.expect.slice(0, 48)}`),
  });
  process.stdout.write(' done\n');
}

const stillRule = rows.filter((r) => {
  const d = (r.situation.stillMs ?? 0) > STILL_MS_THRESHOLD ? 'stop' : 'wait';
  return satisfies(d, want(r));
}).length / rows.length;

console.log(`\n${'arm'.padEnd(26)} ${'accuracy'.padStart(9)} ${'median'.padStart(9)} ${'no answer'.padStart(10)}`);
console.log('-'.repeat(58));
console.log(`${`always "${commonest[0]}"`.padEnd(26)} ${pct(baseline).padStart(9)} ${'—'.padStart(9)} ${'—'.padStart(10)}`);
console.log(`${`stillMs > ${STILL_MS_THRESHOLD}ms`.padEnd(26)} ${pct(stillRule).padStart(9)} ${'0ms'.padStart(9)} ${'—'.padStart(10)}`);
for (const r of results) {
  console.log(`${r.arm.padEnd(26)} ${pct(r.accuracy).padStart(9)} ${`${r.medianMs ?? '—'}ms`.padStart(9)} ${`${r.unanswered}`.padStart(10)}`);
}

console.log('\nerrors, by arm:');
for (const r of results) {
  console.log(`  ${r.arm}`);
  if (!r.errors.length) console.log('    none');
  const seen = new Map();
  for (const e of r.errors) seen.set(e, (seen.get(e) ?? 0) + 1);
  for (const [e, n] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}x ${e}`);
}

// --- the cascade: threshold -> local model -> Claude -----------------------
//
// The owner's proposal, and the numbers are the only way to say whether it
// helps: answer with the free rule where it is confident, fall through to the
// on-device model where it is not, and only then pay a round trip.
//
// **A cascade needs a tier that can decline, and neither tier has one.** The
// threshold is a comparison — it always answers. The supervisor's vocabulary is
// three words and none of them is "I don't know". So the interesting number is
// not "does a cascade help" but "how much would an abstain token be worth", and
// that is item 100. This measures it directly, by letting the rule abstain in a
// band around its own threshold and handing those to the next tier.
const armDecisions = new Map(results.map((r) => [r.arm, r.judged]));
console.log('\n--- cascade: the rule answers, the model covers where it abstains ---');
console.log(`${'abstain band'.padEnd(22)} ${'rule'.padStart(6)} ${'->model'.padStart(8)} ${'cascade'.padStart(9)} ${'model calls'.padStart(12)}`);
for (const band of [0, 250, 500, 750, 1000, 1500]) {
  const lo = STILL_MS_THRESHOLD - band;
  const hi = STILL_MS_THRESHOLD + band;
  for (const arm of arms) {
    const judged = armDecisions.get(arm) ?? [];
    let right = 0;
    let escalated = 0;
    for (const [i, r] of rows.entries()) {
      const still = r.situation.stillMs ?? 0;
      if (band > 0 && still >= lo && still <= hi) {
        escalated += 1;
        const ruling = judged[i]?.ruling;
        if (ruling && satisfies(ruling.decision, want(r))) right += 1;
        continue;
      }
      if (satisfies(still > STILL_MS_THRESHOLD ? 'stop' : 'wait', want(r))) right += 1;
    }
    console.log(`${`+/-${band}ms -> ${arm}`.padEnd(22)} ${pct(stillRule).padStart(6)} ${`${escalated}`.padStart(8)} ${pct(right / rows.length).padStart(9)} ${`${escalated}/${rows.length}`.padStart(12)}`);
  }
  if (band === 0) console.log('  (band 0 = no abstention, the rule alone — every row below adds a tier)');
}

console.log('\nThis scores DECISIONS on identical inputs. It cannot score outcomes —');
console.log('whether acting on a ruling recovered the flow is a fact about the device at');
console.log('that moment, and belongs to whichever arm was live. See docs/EXPERIMENTS.md.');

supervisor.close();
