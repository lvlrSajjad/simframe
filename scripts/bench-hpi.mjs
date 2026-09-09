#!/usr/bin/env node
// The agent half of the Human Parity Index.
//
// Runs every flow in the suite N times, exactly as an agent would run it, and
// reduces the flow records to an HPI report. The human half is recorded once
// by a person (`simframe baseline record`) and committed; this side is
// re-measured on every run, which is what makes HPI a trend rather than a
// claim.
//
// Two rules this file follows, both learned in this repo:
//
//   - Nothing is verified through a pipe. `node script.mjs | tail -3` exits
//     with tail's status, and this project has already shipped a check that
//     could not fail because of it. Every gate here is an exit code.
//   - A missing human baseline is reported, never defaulted. HPI_time with no
//     denominator is null; it is not 1.0, and it is not "parity".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScript } from '../src/actions.js';
import * as api from '../src/index.js';
import * as baseline from '../src/baseline.js';
import * as metrics from '../src/metrics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const device = arg('device');
const runs = Math.max(1, Number(arg('runs', '3')));
const only = arg('flow');
const out = arg('out');
const baselineFile = arg('baseline', path.join(ROOT, 'docs', 'research', 'hpi-baseline.json'));
const gate = has('gate');
/**
 * How many times to measure the whole suite.
 *
 * Three when gating, because one measurement is mostly noise: identical code
 * measured three times the same afternoon gave HPI_time 0.475, 0.413 and
 * 0.371. The gate reads the median of the passes, which is what lets the time
 * band stay as tight as 25% instead of being widened to cover a single run's
 * spread.
 */
const passes = Math.max(1, Number(arg('passes', gate ? '3' : '1')));

const suite = baseline.loadSuite(arg('suite', baseline.SUITE_FILE)).filter((f) => !only || f.name === only);
if (!suite.length) {
  console.error(`no flows to run${only ? ` matching "${only}"` : ''}`);
  process.exit(2);
}

const { device: dev } = await api.ensureDaemon(device);
console.log(`device: ${dev.name} (${dev.udid})`);
console.log(`suite: ${suite.map((f) => f.name).join(', ')} × ${runs} run(s) × ${passes} pass(es)\n`);

const ids = new Set();
let hardFailures = 0;
/**
 * A wedged capture loop is not a slow flow, and every run after it is doomed.
 *
 * Measured four times in one session: the display surface stops being readable
 * mid-suite, the daemon re-resolves the display port and still gets nothing,
 * and only restarting the device cures it. Grinding through the remaining runs
 * produced three identical "could not run at all" lines and an HPI computed
 * from whatever happened to finish first — a number with a hole in it, which
 * is worse than no number.
 */
const WEDGED = /display surface could not be read|did not produce a frame/;
/**
 * The host could not do the thing, as distinct from simframe doing it slowly.
 *
 * A hosted runner takes 47-55 s to fail `simctl launch com.apple.Preferences`
 * and then fails it again, three runs in a row — the same class of fault this
 * repo already records for `simctl openurl`, which returns "Operation timed
 * out" on a loaded runner. Six of those is nine minutes of CI spent measuring
 * the runner's patience, and the resulting HPI describes nothing.
 */
const ENVIRONMENT = /could not launch|Command failed: xcrun simctl (launch|terminate)|Operation timed out|timed out/i;
/** Two environmental failures of the same flow is the environment, not a flake. */
const ENV_GIVE_UP = 2;
let abort = null;
const envFailures = new Map();

const passSets = [];
outer: for (let pass = 1; pass <= passes; pass += 1) {
  const thisPass = new Set();
  passSets.push(thisPass);
  if (passes > 1) console.log(`pass ${pass}/${passes}`);
  for (const flow of suite) {
    for (let run = 1; run <= runs; run += 1) {
    // The same start state the human baseline was recorded from: app not
    // running, on the home screen. Not part of the timed flow, and
    // deliberately not expressed as flow steps — see baseline.resetFor.
    const reset = await baseline.resetFor(dev.udid, flow);
    if (reset.failures.length) console.log(`  (reset: ${reset.failures.join('; ')})`);
    await api.waitFor(dev.udid, { mode: 'stable', stableMs: 400, timeoutMs: 4000 });

    let res;
    try {
      res = await runScript(dev.udid, {
        steps: flow.steps,
        flowName: flow.name,
        minSteps: flow.minSteps ?? null,
      });
    } catch (err) {
      // A flow that could not start at all is not a slow flow. It has no
      // record, so it cannot be averaged into anything; it is reported and
      // counted.
      hardFailures += 1;
      console.log(`FAIL ${flow.name} run ${run}: ${err.message}`);
      if (WEDGED.test(err.message)) {
        abort = { kind: 'capture is wedged', message: err.message };
        break outer;
      }
      if (ENVIRONMENT.test(err.message)) {
        const n = (envFailures.get(flow.name) ?? 0) + 1;
        envFailures.set(flow.name, n);
        if (n >= ENV_GIVE_UP) {
          abort = { kind: `the host cannot run "${flow.name}"`, message: err.message.split('\n')[0] };
          break outer;
        }
      }
      continue;
    }
    ids.add(res.flowId);
    thisPass.add(res.flowId);
    const verdicts = res.results.map((r) => r.verification?.verdict).filter(Boolean);
    console.log(
      `${res.ok ? 'ok  ' : 'FAIL'} ${flow.name.padEnd(24)} run ${run}/${runs}  ` +
        `${String(res.totalMs).padStart(6)}ms  ${res.ranSteps}/${res.totalSteps} steps  ` +
        `${verdicts.filter((v) => v !== 'ok').length ? `verdicts: ${verdicts.join(',')}` : 'all ok'}`,
    );
    if (!res.ok) console.log(`     ${res.results.filter((r) => !r.ok).map((r) => r.error).join('; ')}`);
    }
  }
}

// This process's runs only. The log is append-only and holds every earlier
// measurement, which is what makes it a trend — but a CI number computed over
// somebody's local runs from last week is not this commit's number.
const flows = metrics.readFlows(dev.udid).filter((f) => ids.has(f.flow_id));
const humans = baseline.readBaselines();
// Each pass measured on its own, so the gate can take a median over them
// rather than trusting one. Accuracy is pooled over every run instead: one
// wrong action in thirty is a wrong action, and a median would hide it.
const allFlows = metrics.readFlows(dev.udid);
const passReports = passSets
  .map((set) => metrics.hpi({ flows: allFlows.filter((f) => set.has(f.flow_id)), baselines: humans }))
  .filter((r) => r.overall.runs > 0);
const passTimes = passReports.map((r) => r.overall.hpi_time).filter((t) => Number.isFinite(t));

const report = {
  ...metrics.hpi({ flows, baselines: humans }),
  measured_at: new Date().toISOString(),
  device: { udid: dev.udid, name: dev.name, runtime: dev.runtime },
  runs_per_flow: runs,
  passes,
  pass_hpi_time: passTimes,
  hard_failures: hardFailures,
  human_baselines: Object.fromEntries(
    Object.entries(humans).map(([k, v]) => [k, { runs: v.runs, p50: v.wall_time_ms?.p50 ?? null }]),
  ),
};

console.log('\nflow                      runs  agent p50   human p50   HPI_time  step_ratio');
for (const f of report.flows) {
  console.log(
    `${f.flow.padEnd(24)} ${String(f.runs).padStart(5)}  ${`${f.agent_ms.p50}ms`.padStart(9)}   ` +
      `${(f.human_median_ms ? `${f.human_median_ms}ms` : '—').padStart(9)}   ` +
      `${String(f.hpi_time ?? '—').padStart(8)}  ${String(f.step_ratio ?? '—').padStart(10)}`,
  );
}
report.overall.hpi_time_median_of_passes = passTimes.length ? Number(metrics.median(passTimes).toFixed(3)) : null;
const o = report.overall;
console.log(`\nHPI_accuracy ${o.hpi_accuracy}   HPI_time ${o.hpi_time ?? '—'}   HPI ${o.hpi ?? '—'}   step_ratio ${o.step_ratio ?? '—'}`);
if (passTimes.length > 1) {
  console.log(`HPI_time per pass: ${passTimes.join(', ')} — median ${o.hpi_time_median_of_passes} (what the gate reads)`);
}
if (o.hpi_time == null) {
  console.log(`no human baseline for any measured flow — HPI_time and HPI are null, not 1.0.`);
  console.log(`record one: simframe baseline record <flow> --device=${dev.udid} --runs=5`);
}

if (out) {
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

const escalations = metrics.breakdown(metrics.readEscalations(dev.udid));
console.log(`\nescalations in this device's log: ${escalations.total} (${Object.entries(escalations.by_reason).filter(([, n]) => n).map(([r, n]) => `${r} ${n}`).join(', ') || 'none'})`);

if (abort) {
  console.error(`\n${abort.kind}: ${abort.message}`);
  console.error('No comparable HPI was measured — what is above is a partial suite and');
  console.error('must not be adopted as a baseline or read as a regression.');
  if (/wedged/.test(abort.kind)) {
    console.error('Only restarting the device is known to cure a wedge:');
    console.error(`  xcrun simctl shutdown ${dev.udid} && xcrun simctl boot ${dev.udid}`);
  }
  // 2, not 1. "I could not measure" and "it got worse" are different answers,
  // and a job that reports them with the same exit code teaches people to
  // ignore both. The workflow treats 2 as a loud warning and 1 as a failure.
  process.exit(2);
}

if (hardFailures) {
  console.error(`\n${hardFailures} flow run(s) could not run at all.`);
  process.exit(1);
}

if (!gate) process.exit(0);

// ------------------------------------------------------------------ the gate
const committed = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null;
if (!committed) {
  // Loudly inactive rather than quietly passing. A gate with nothing to
  // compare against cannot detect a regression, and saying "ok" here is how a
  // CI job comes to mean nothing.
  console.log(`\nGATE INACTIVE — no committed baseline at ${path.relative(ROOT, baselineFile)}.`);
  console.log('Commit this run as the baseline to arm it.');
  process.exit(0);
}

const base = committed.overall ?? {};
const failures = metrics.gateAgainst(committed, report);

console.log(`\ngate vs ${path.relative(ROOT, baselineFile)} (measured ${committed.measured_at ?? '?'})`);
console.log(`  HPI_accuracy ${base.hpi_accuracy ?? '—'} -> ${o.hpi_accuracy ?? '—'}`);
console.log(`  HPI_time     ${metrics.gateTime(base) ?? '—'} -> ${metrics.gateTime(o) ?? '—'}`);
console.log(`  band         ${metrics.TIME_REGRESSION * 100}% (median of ${passTimes.length || 1} pass(es))`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
