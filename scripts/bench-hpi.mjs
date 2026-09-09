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

const suite = baseline.loadSuite(arg('suite', baseline.SUITE_FILE)).filter((f) => !only || f.name === only);
if (!suite.length) {
  console.error(`no flows to run${only ? ` matching "${only}"` : ''}`);
  process.exit(2);
}

const { device: dev } = await api.ensureDaemon(device);
console.log(`device: ${dev.name} (${dev.udid})`);
console.log(`suite: ${suite.map((f) => f.name).join(', ')} × ${runs} run(s)\n`);

const ids = new Set();
let hardFailures = 0;

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
      continue;
    }
    ids.add(res.flowId);
    const verdicts = res.results.map((r) => r.verification?.verdict).filter(Boolean);
    console.log(
      `${res.ok ? 'ok  ' : 'FAIL'} ${flow.name.padEnd(24)} run ${run}/${runs}  ` +
        `${String(res.totalMs).padStart(6)}ms  ${res.ranSteps}/${res.totalSteps} steps  ` +
        `${verdicts.filter((v) => v !== 'ok').length ? `verdicts: ${verdicts.join(',')}` : 'all ok'}`,
    );
    if (!res.ok) console.log(`     ${res.results.filter((r) => !r.ok).map((r) => r.error).join('; ')}`);
  }
}

// This process's runs only. The log is append-only and holds every earlier
// measurement, which is what makes it a trend — but a CI number computed over
// somebody's local runs from last week is not this commit's number.
const flows = metrics.readFlows(dev.udid).filter((f) => ids.has(f.flow_id));
const humans = baseline.readBaselines();
const report = {
  ...metrics.hpi({ flows, baselines: humans }),
  measured_at: new Date().toISOString(),
  device: { udid: dev.udid, name: dev.name, runtime: dev.runtime },
  runs_per_flow: runs,
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
const o = report.overall;
console.log(`\nHPI_accuracy ${o.hpi_accuracy}   HPI_time ${o.hpi_time ?? '—'}   HPI ${o.hpi ?? '—'}   step_ratio ${o.step_ratio ?? '—'}`);
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
console.log(`  HPI_time     ${base.hpi_time ?? '—'} -> ${o.hpi_time ?? '—'}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
