#!/usr/bin/env node
/**
 * Phase 17, go/no-go step 1: build the corpus and ask whether there is a job.
 *
 * The plan in docs/PHASES-HUMAN-PARITY.md said to export 200 `ambiguous_intent`
 * and `no_plan` escalations. That corpus cannot be assembled: `no_plan` has
 * never been logged once, `ambiguous_intent` is the reason the ranking bug
 * produced (so the pre-fix records encode a bug), and the session id is minted
 * per process — so a CLI-driven agent gets one "session" per command and the
 * "filter to one session id" step has nothing to filter.
 *
 * There is a better corpus and it was there all along. Every verified graph edge
 * is a decision that *worked*: the goal is in `step`, the screen it was taken on
 * is the node, and the element list for that screen is in the screen map. That
 * is (goal, element list, action) for every successful step, not just the rare
 * failures — and the ground truth is stronger, because the tap was verified.
 *
 * What this measures is the question the whole phase turns on: of the decisions
 * an agent actually makes, how many does the local matcher already resolve? A
 * local planner can only earn its keep on the remainder. If the remainder is
 * small, Phase 17 is a no-go regardless of how good the model is.
 *
 * Output is aggregate by design. This reads a real device's memory of real
 * third-party apps, so it prints counts and never a label, an app name or a
 * screen's contents. See the standing rule in scripts/check-private.mjs.
 *
 * Usage: node scripts/phase17-corpus.mjs [--device <udid>] [--json]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as matching from '../src/matching.js';
import { goalOf } from '../src/actions.js';

const ROOT = process.env.SIMFRAME_HOME || join(homedir(), '.simframe');

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};
const listDir = (p) => (existsSync(p) ? readdirSync(p).filter((f) => f.endsWith('.json')) : []);

/** Screens are keyed by frame hash; graph nodes carry a layoutHash. Index both. */
function screenIndex(dev) {
  const idx = new Map();
  for (const f of listDir(join(dev, 'screens'))) {
    const s = readJson(join(dev, 'screens', f));
    if (!s?.targets?.length) continue;
    for (const k of ['layoutHash', 'structuralHash', 'hash']) {
      if (s[k] && !idx.has(s[k])) idx.set(s[k], s);
    }
  }
  return idx;
}

/**
 * Only some steps involve choosing an element. `launch` names an app, `button`
 * names hardware, `openUrl` names a URL, `scroll` names a direction — none of
 * them is a decision a planner could help with, and counting them was inflating
 * the "not found" bucket to 45% on the first run of this script.
 */
const CHOOSES_AN_ELEMENT = new Set(['tap', 'type', 'scroll_to', 'scrollTo', 'assert', 'swipe_from', 'longPress']);

/** A "#3" is answered by the ref table and a "@x,y" by arithmetic. Neither is a decision. */
const isSelectorNotIntent = (goal) => /^#\d+$/.test(goal) || /^@?-?\d+\s*,\s*-?\d+$/.test(goal);

export function classify(dev) {
  const idx = screenIndex(dev);
  const out = {
    screens_stored: idx.size,
    edges: 0,
    unjoinable: 0,
    no_goal: 0,
    not_an_element_step: 0,
    selector_not_intent: 0,
    cases: 0,
    resolved: 0,
    ambiguous: 0,
    none: 0,
  };
  for (const f of listDir(join(dev, 'graph'))) {
    const g = readJson(join(dev, 'graph', f));
    const screen = idx.get(g?.layoutHash) ?? idx.get(g?.hash);
    for (const e of g?.edges ?? []) {
      out.edges += 1;
      if (!screen) { out.unjoinable += 1; continue; }
      const goal = goalOf(e.step);
      if (!goal) { out.no_goal += 1; continue; }
      if (!CHOOSES_AN_ELEMENT.has(e.step?.action)) { out.not_an_element_step += 1; continue; }
      if (isSelectorNotIntent(String(goal).trim())) { out.selector_not_intent += 1; continue; }
      out.cases += 1;
      const r = matching.resolve(screen.targets, String(goal));
      if (r.status === 'ok') out.resolved += 1;
      else if (r.status === 'ambiguous') out.ambiguous += 1;
      else out.none += 1;
    }
  }
  return out;
}

/**
 * The second instrument, with the opposite bias.
 *
 * A verified edge is a decision that *succeeded*, so the graph cannot see the
 * ones the matcher fumbled — those became escalations, Claude fixed them, and
 * the edge was written with the corrected goal. Measuring the matcher on its
 * own successes is partly circular. So also count resolution failures from the
 * log against total edge traversals: same question, denominator built from
 * failures instead of successes.
 */
export function resolutionFailureRate(dev) {
  let traversals = 0;
  for (const f of listDir(join(dev, 'graph'))) {
    for (const e of readJson(join(dev, 'graph', f))?.edges ?? []) traversals += e.count ?? 0;
  }
  let failures = 0;
  let escalations = 0;
  const log = join(dev, 'escalations.jsonl');
  if (existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      escalations += 1;
      if (r.reason === 'ambiguous_intent' || r.reason === 'unknown_screen') failures += 1;
    }
  }
  return { traversals, escalations, failures };
}

const flags = process.argv.slice(2);
const only = flags.includes('--device') ? flags[flags.indexOf('--device') + 1] : null;
const devices = (existsSync(ROOT) ? readdirSync(ROOT) : [])
  .filter((d) => !d.startsWith('TEST-') && d !== 'bin')
  .filter((d) => existsSync(join(ROOT, d, 'graph')))
  .filter((d) => !only || d === only);

const totals = { cases: 0, resolved: 0, ambiguous: 0, none: 0, edges: 0, unjoinable: 0, not_an_element_step: 0, selector_not_intent: 0 };
const rows = [];
for (const d of devices) {
  const r = classify(join(ROOT, d));
  if (!r.edges) continue;
  rows.push({ device: `${d.slice(0, 8)}…`, ...r, ...resolutionFailureRate(join(ROOT, d)) });
  for (const k of Object.keys(totals)) totals[k] += r[k];
}

if (flags.includes('--json')) {
  console.log(JSON.stringify({ devices: rows, totals }, null, 2));
} else {
  console.log('Phase 17 corpus — verified graph edges as (goal, element list, action)\n');
  for (const r of rows) {
    console.log(`  ${r.device}  edges ${r.edges}  joinable ${r.edges - r.unjoinable}  decisions ${r.cases}` +
      `  → matcher ok ${r.resolved}, ambiguous ${r.ambiguous}, not found ${r.none}`);
  }
  const { cases, resolved, ambiguous, none } = totals;
  const pct = (n) => (cases ? `${Math.round((n / cases) * 1000) / 10}%` : '—');
  console.log(`\n  ${totals.edges} edges: ${totals.unjoinable} unjoinable, ` +
    `${totals.not_an_element_step} chose no element (launch/button/openUrl/scroll), ` +
    `${totals.selector_not_intent} used a #ref or a coordinate.`);
  console.log(`  TOTAL element decisions: ${cases}`);
  console.log(`    already resolved locally  ${resolved}  ${pct(resolved)}   <- a planner adds nothing here`);
  console.log(`    ambiguous                 ${ambiguous}  ${pct(ambiguous)}   <- a planner could pick`);
  console.log(`    not found                 ${none}  ${pct(none)}   <- a planner cannot invent an element`);
  const addressable = ambiguous;
  console.log(`\n  Addressable by a local planner: ${addressable} of ${cases} (${pct(addressable)}).`);

  console.log('\nSecond instrument — resolution failures from the log, per traversal.');
  console.log('A rate over 100% means the graph was discarded while the log kept appending');
  console.log('(a MAP_VERSION or GRAPH_VERSION bump), so it is not a rate. Read the device');
  console.log('that was driven by an agent doing real work, not the bench device.\n');
  for (const r of rows) {
    const rate = r.traversals ? `${Math.round((r.failures / r.traversals) * 1000) / 10}%` : '—';
    console.log(`  ${r.device}  traversals ${String(r.traversals).padStart(4)}` +
      `  escalations ${String(r.escalations).padStart(4)}` +
      `  resolution failures ${String(r.failures).padStart(3)}  ${rate.padStart(6)}`);
  }
}
