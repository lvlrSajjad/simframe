// The human half of the Human Parity Index.
//
// HPI is a ratio and the human is its denominator, so nothing in this series
// produces a number until a person has performed the same flows on the same
// simulator. This module records those runs and reduces them to a committed
// median + IQR.
//
// One assumption in the research does not survive contact: §1 says human
// baseline collection is "essentially free" because HID events are already
// logged. That is true of the events simframe *injects*. A person tapping the
// Simulator window produces no HID log simframe can read — there is no such
// log on the host side. So the two numbers come from different places and are
// labelled accordingly:
//
//   wall time     measured, from an explicit start and an explicit stop
//   step count    derived from screen transitions in the frame history, which
//                 is a lower bound (two taps inside one animation window read
//                 as one) and is recorded as `source: screen-transitions`
//                 rather than as taps
//
// `min_steps` therefore comes from the authored flow definition, never from a
// human run. What the human run is authoritative about is time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from './index.js';
import * as input from './input.js';
import { terminateApp } from './platform/index.js';
import * as metrics from './metrics.js';
import * as store from './store.js';

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The flow suite is a runtime input, not a test fixture: `simframe baseline`
 * reads it. It lived under test/ for exactly one commit, which would have
 * shipped a package whose new command died with ENOENT — `files` does not
 * include test/. scripts/check-package.mjs now requires it.
 */
export const SUITE_FILE = path.join(PKG_ROOT, 'flows', 'hpi-suite.json');

/**
 * Where committed human baselines live.
 *
 * In a checkout that is docs/research/human-baselines, because the phase
 * commits them and CI reads them from there. An installed package has no
 * docs/, so it keeps its own under ~/.simframe rather than writing inside
 * node_modules or pretending the directory exists.
 */
export function baselineDir() {
  const repo = path.join(PKG_ROOT, 'docs', 'research', 'human-baselines');
  return fs.existsSync(path.dirname(repo)) ? repo : path.join(store.ROOT, 'human-baselines');
}
export const BASELINE_DIR = baselineDir();

/**
 * A screen change, not a pixel change. `MINOR_CHANGE` is a clock digit; a
 * human tapping a row moves the whole screen, which is what MAJOR_CHANGE
 * measures.
 */
export const CHANGE_THRESHOLD = api.MAJOR_CHANGE;
/**
 * Frames closer together than this belong to the same transition.
 *
 * A push animation is ~300 ms of continuously changing frames and must count
 * as one step. Human inter-tap intervals are an order of magnitude longer —
 * research §1 puts a deliberate tester near a second — so the two do not
 * overlap at 400 ms. Two taps genuinely inside one window read as one step,
 * which is why this produces a lower bound and says so.
 */
export const TRANSITION_GAP_MS = 400;

export function loadSuite(file = SUITE_FILE) {
  const suite = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(suite) || !suite.length) throw new Error(`${file}: not a flow suite`);
  return suite;
}

export function flowFrom(suite, name) {
  const flow = suite.find((f) => f.name === name);
  if (!flow) {
    throw new Error(`no flow "${name}" in the suite. known: ${suite.map((f) => f.name).join(', ')}`);
  }
  return flow;
}

/**
 * Group a frame history into transitions.
 *
 * Pure, so the grouping rule is testable without a simulator — which matters,
 * because this is the rule that decides what a "step" was.
 */
export function transitionsIn(history, { from = 0, to = Infinity, threshold = CHANGE_THRESHOLD, gapMs = TRANSITION_GAP_MS } = {}) {
  const changed = (history ?? [])
    .filter((h) => h && h.at >= from && h.at <= to && Number(h.diff) > threshold)
    .sort((a, b) => a.at - b.at);
  const groups = [];
  for (const h of changed) {
    const last = groups[groups.length - 1];
    if (last && h.at - last.endedAt <= gapMs) {
      last.endedAt = h.at;
      last.frames += 1;
      last.peakDiff = Math.max(last.peakDiff, Number(h.diff));
      continue;
    }
    groups.push({ at: h.at, endedAt: h.at, frames: 1, peakDiff: Number(h.diff) });
  }
  return groups;
}

/** Gaps between the starts of consecutive transitions. */
export function intervalsBetween(transitions) {
  return transitions.slice(1).map((t, i) => t.at - transitions[i].at);
}

/**
 * Turn one recorded run into a record.
 *
 * `history_complete` is not decoration. The daemon keeps 90 s of frame
 * history, so a run longer than that has transitions the log can no longer
 * see, and its step count would be wrong while looking fine. A run that
 * cannot be counted says so instead.
 */
export function runFrom({ flow, startedAt, endedAt, history, oldestHistoryAt = null }) {
  const transitions = transitionsIn(history, { from: startedAt, to: endedAt });
  const complete = oldestHistoryAt == null ? null : oldestHistoryAt <= startedAt;
  return {
    flow,
    recorded_at: new Date(startedAt).toISOString(),
    wall_time_ms: endedAt - startedAt,
    steps_observed: transitions.length,
    steps_source: 'screen-transitions',
    interaction_intervals_ms: intervalsBetween(transitions),
    transitions: transitions.map((t) => ({ at_ms: t.at - startedAt, frames: t.frames, peak_diff: Number(t.peakDiff.toFixed(4)) })),
    history_complete: complete,
  };
}

/**
 * Put the device where the flow starts: the app not running, on the home
 * screen.
 *
 * iOS restores an app to the screen you left it on, so without this the second
 * recorded run of a Settings flow starts on its own destination and takes no
 * time at all. It is deliberately not expressed as flow steps — terminating an
 * app that is not running throws, and a reset is not a step anybody is timing.
 */
export async function resetFor(udid, flow) {
  const reset = flow.reset ?? {};
  const failures = [];
  for (const bundle of reset.terminate ?? []) {
    try {
      await terminateApp(udid, bundle);
    } catch (err) {
      // Not running is the expected case, and it is indistinguishable here
      // from a real failure. Both are reported rather than swallowed.
      failures.push(`${bundle}: ${err.message}`);
    }
  }
  if (reset.home !== false) await input.pressButton(udid, 'home');
  return { failures };
}

const runsFile = (udid, flow) => path.join(metrics.paths(udid).baselines, `${encodeURIComponent(flow)}.jsonl`);

export const recordRun = (udid, flow, run) => metrics.appendJsonl(runsFile(udid, flow), run);
export const readRuns = (udid, flow) => metrics.readJsonl(runsFile(udid, flow));

/** How few runs is not a baseline. §1 recommends N≥5; below three there is no IQR worth printing. */
export const MIN_RUNS = 3;
export const WANT_RUNS = 5;

/**
 * Median and IQR over recorded runs.
 *
 * Refuses under three, per the phase prompt: a median of two numbers is one of
 * them and an IQR of two is the range, and publishing either as a baseline
 * invites a comparison it cannot support.
 */
export function summarizeRuns(flow, runs, { minSteps = null, device = null } = {}) {
  const usable = runs.filter((r) => Number.isFinite(r?.wall_time_ms));
  if (usable.length < MIN_RUNS) {
    return { ok: false, reason: 'too-few-runs', runs: usable.length, need: MIN_RUNS };
  }
  const incomplete = usable.filter((r) => r.history_complete === false).length;
  return {
    ok: true,
    summary: {
      flow,
      device,
      generated_at: new Date().toISOString(),
      runs: usable.length,
      // The number HPI divides by. Everything else here is context for it.
      wall_time_ms: metrics.quartiles(usable.map((r) => r.wall_time_ms)),
      steps_observed: metrics.quartiles(usable.map((r) => r.steps_observed)),
      steps_source: 'screen-transitions',
      min_steps: minSteps,
      interaction_intervals_ms: metrics.quartiles(usable.flatMap((r) => r.interaction_intervals_ms ?? [])),
      runs_with_incomplete_history: incomplete,
      note: 'wall_time_ms is measured from an explicit start and stop. steps_observed is derived from screen transitions and is a lower bound on taps; min_steps comes from the flow definition. There is no host-readable HID log for human input.',
    },
  };
}

export function writeSummary(summary, { dir = BASELINE_DIR } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${encodeURIComponent(summary.flow)}.json`);
  store.writeAtomic(file, `${JSON.stringify(summary, null, 2)}\n`);
  return file;
}

/** Every committed human baseline, keyed by flow name. */
export function readBaselines({ dir = BASELINE_DIR } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return {};
  }
  const out = {};
  for (const name of names) {
    const body = store.readJson(path.join(dir, name));
    if (body?.flow) out[body.flow] = body;
  }
  return out;
}

/**
 * Record one human run.
 *
 * `waitForStop` is injected rather than reading stdin here, so the thing that
 * decides when the run ended is the CLI's problem and this stays testable.
 * The frame history is read after the stop, which is the only reason this
 * works at all: the daemon is already writing every frame down, so a human
 * run needs no new capture path — only two timestamps and the honesty about
 * what sits between them.
 */
export async function recordHumanRun(deviceQuery, flowName, { waitForStop, suite = loadSuite(), options } = {}) {
  const flow = flowFrom(suite, flowName);
  const { device } = await api.ensureDaemon(deviceQuery, options);
  const udid = device.udid;

  const startedAt = Date.now();
  await waitForStop({ flow, device });
  const endedAt = Date.now();

  const state = store.readJson(store.paths(udid).state);
  const history = state?.history ?? [];
  const run = runFrom({
    flow: flowName,
    startedAt,
    endedAt,
    history,
    oldestHistoryAt: history.length ? Math.min(...history.map((h) => h.at)) : null,
  });
  recordRun(udid, flowName, run);
  return { device, flow, run, runs: readRuns(udid, flowName).length };
}
