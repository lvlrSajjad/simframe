#!/usr/bin/env node
// Score a ruling population against the baselines that could embarrass it.
//
// Written **before** the population it first scored was finished, deliberately.
// The previous attempt computed a `stillMs` threshold after seeing the answers,
// on 14 samples of which 12 shared one label, and produced "100%" — a number
// that was fitted, not measured. Fixing that afterwards is not possible: you
// cannot un-see the data. So the split rule, the candidate thresholds and the
// baselines are all fixed here in advance.
//
//   node scripts/score-rulings.mjs --device=<udid>
//
// What it will not do: pick the best threshold and report its score. It fits on
// the first half and scores on the second, and prints both numbers so a gap
// between them is visible as overfitting rather than hidden as success.
import * as metrics from '../src/metrics.js';
import { resolveDevice } from '../src/platform/index.js';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

/** The fixtures, and the word each one's situation actually calls for. */
const CORRECT = {
  'the list is still loading; its rows arrive shortly after launch': 'wait',
  'the detail screen is still fetching; its text arrives shortly': 'wait',
  'the list arrives in waves and this row is in the last one': 'wait',
  'Review is blocked until Species is filled in, and it is empty': 'stop',
  'the first submit always fails and the second works, so waiting cannot help': 'stop',
};

/** `retry` and `wait` differ only in how long they settle, so both satisfy a wait. */
const satisfies = (decision, want) =>
  (want === 'wait' ? decision === 'wait' || decision === 'retry' : decision === want);

const dev = await resolveDevice(arg('device'));
const all = metrics.readSupervisions(dev.udid).filter((r) => CORRECT[r.expect]);
// `--last=N` scores one batch rather than the whole log. Needed the first time
// this ran: the log still held rulings from a deliberately skewed population,
// so the balance read 19/35 and the baseline 65% when the batch actually under
// test was 16/16. Mixing a known-bad population into the denominator is the
// same error as before wearing a different hat.
const lastN = Number(arg('last', 0));
// Which judge. Every arm of the capacity comparison writes to one log, so
// scoring without this would average a 3B, an 8B and a 14B into a single
// meaningless number — and it would look like a result.
const arm = arg('arm', null);
const armOf = (r) => r.supervisor ?? 'unrecorded';
const scoped = arm ? all.filter((r) => armOf(r) === arm) : all;
const rows = lastN > 0 ? scoped.slice(-lastN) : scoped;

// A population spanning several arms is not one population. Say so, and say
// what to pass, rather than printing an average of things that were never
// comparable.
const arms = [...new Set(rows.map(armOf))];
if (arms.length > 1) {
  console.log(`this log holds rulings from ${arms.length} supervisor arms:`);
  for (const a of arms) console.log(`  ${String(rows.filter((r) => armOf(r) === a).length).padStart(4)}  ${a}`);
  console.log('\nScore one at a time — `--arm=<name>` — because averaging them is not a result.');
  process.exit(2);
}
if (rows.length) console.log(`arm: ${arms[0]}\n`);
if (rows.length < 8) {
  console.error(`only ${rows.length} labelled ruling(s) — run scripts/collect-rulings.mjs first`);
  process.exit(2);
}

const want = (r) => CORRECT[r.expect];
const counts = rows.reduce((a, r) => ({ ...a, [want(r)]: (a[want(r)] ?? 0) + 1 }), {});
const commonest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
const baseline = commonest[1] / rows.length;

console.log(`${rows.length} labelled rulings on ${dev.name}`);
console.log(`balance: ${JSON.stringify(counts)}`);
console.log(`majority-class baseline: always "${commonest[0]}" scores ${(100 * baseline).toFixed(0)}%`);
if (baseline > 0.65) {
  console.log('\nSKEWED — any accuracy below is mostly a fact about the fixture set.');
}

const acc = (rs, predict) => rs.filter((r) => satisfies(predict(r), want(r))).length / (rs.length || 1);
const pct = (x) => `${(100 * x).toFixed(0)}%`;

console.log(`\n${'the model'.padEnd(30)} ${pct(acc(rows, (r) => r.decision))}`);
console.log(`${`always "${commonest[0]}"`.padEnd(30)} ${pct(baseline)}`);

// --- the stillMs rule, fitted on one half and scored on the other.
//
// Split by *recording order* rather than at random or by fixture, because the
// alternative is choosing a split, and choosing is the thing that went wrong.
const half = Math.floor(rows.length / 2);
const fit = rows.slice(0, half);
const held = rows.slice(half);
const CANDIDATES = [1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000];
const rule = (t) => (r) => ((r.still_ms ?? 0) > t ? 'stop' : 'wait');

let best = null;
for (const t of CANDIDATES) {
  const a = acc(fit, rule(t));
  if (!best || a > best.a) best = { t, a };
}
console.log(`\nstillMs threshold, fitted on the first ${fit.length} and scored on the last ${held.length}:`);
console.log(`  chosen on the fit half:  > ${best.t}ms  (${pct(best.a)} there)`);
console.log(`  ${'on the held-out half:'.padEnd(24)} ${pct(acc(held, rule(best.t)))}`);
console.log(`  ${'the model, same half:'.padEnd(24)} ${pct(acc(held, (r) => r.decision))}`);
console.log('\nA rule that scores far better on the fit half than the held-out half was');
console.log('fitted to noise. That gap is the number this script exists to print.');

// --- the direction of the errors, which does not depend on the balance at all.
const wrong = rows.filter((r) => !satisfies(r.decision, want(r)));
const dirs = wrong.reduce((a, r) => {
  const k = `said "${r.decision}" where "${want(r)}" was right`;
  return { ...a, [k]: (a[k] ?? 0) + 1 };
}, {});
console.log(`\n${wrong.length} error(s) of ${rows.length}:`);
for (const [k, n] of Object.entries(dirs).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}x ${k}`);
if (Object.keys(dirs).length === 1 && wrong.length > 2) {
  console.log('\nAll errors in one direction. A one-directional bias is what an abstain');
  console.log('token addresses (DEFERRED 100), whatever the headline accuracy says.');
}

const lat = rows.map((r) => r.latency_ms).filter(Number.isFinite).sort((a, b) => a - b);
if (lat.length) console.log(`\nmedian judgement latency: ${lat[lat.length >> 1]}ms`);
const timed = rows.filter((r) => Number.isFinite(r.edge_p95_ms)).length;
console.log(`edges the graph had timed: ${timed}/${rows.length}`);
