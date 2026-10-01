#!/usr/bin/env node
// Take typed text off graph files written before simframe stopped keeping it.
//
//   node scripts/scrub-graph-text.mjs <udid> [<udid> …] [--dry-run]
//   node scripts/scrub-graph-text.mjs --all --skip <udid-prefix>,<udid-prefix> [--dry-run]
//
// Until this fix, every `type`/`paste` edge kept its text twice — in the edge
// key (`actionSignature` took the first 40 characters of the step's JSON) and
// in the stored step — so a password typed into a field named "Password" sat in
// `~/.simframe/<udid>/graph/*.json` in plain JSON. New writes no longer do that
// and any node the graph touches is cleaned on save; this cleans the rest
// without waiting for each node to be visited again.
//
// Also, per store:
//   - saved flows (`flows/*.json`): text into a secure field (Password,
//     Passcode, PIN…) is replaced by `needsText`. Text into an ordinary field
//     stays — a saved flow is an artifact somebody asked for.
//   - the write journal (`wrote.json`): secure-field entries and expired ones
//     are dropped.
//   - `escalations.jsonl` and `supervisions.jsonl` are measurement logs and are
//     NOT rewritten. New records no longer carry typed text.
//
// Devices are named explicitly, or `--all` with an explicit `--skip` list, so
// nobody scrubs a device that is not theirs by running it bare. Prints counts
// only — never a value.
import fs from 'node:fs';
import path from 'node:path';
import * as graph from '../src/graph.js';
import * as store from '../src/store.js';
import * as typed from '../src/typed.js';
import * as wrote from '../src/wrote.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const skipAt = args.indexOf('--skip');
const skip = skipAt >= 0 ? String(args[skipAt + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [];
const named = args.filter((a, i) => !a.startsWith('--') && (skipAt < 0 || i !== skipAt + 1));

if (!all && !named.length) {
  console.error('usage: scrub-graph-text.mjs <udid> […] [--dry-run]\n'
    + '       scrub-graph-text.mjs --all --skip <prefix>,<prefix> [--dry-run]');
  process.exit(2);
}
if (all && skipAt < 0) {
  console.error('--all needs an explicit --skip list (pass --skip "" to skip nothing) — '
    + 'a shared machine has devices that are not yours.');
  process.exit(2);
}

const udids = all
  ? fs.readdirSync(store.ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'bin').map((e) => e.name)
  : named;

function scrubFlows(udid) {
  const dir = path.join(store.deviceDir(udid), 'flows');
  const out = { files: 0, rewritten: 0 };
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const name of names) {
    const file = path.join(dir, name);
    const flow = store.readJson(file);
    if (!Array.isArray(flow?.steps)) continue;
    out.files += 1;
    const steps = flow.steps.map(typed.forSavedFlow);
    if (JSON.stringify(steps) === JSON.stringify(flow.steps)) continue;
    out.rewritten += 1;
    if (!dryRun) store.writeAtomic(file, JSON.stringify({ ...flow, steps }, null, 2));
  }
  return out;
}

function scrubJournal(udid) {
  const entries = wrote.read(udid);
  const now = Date.now();
  const kept = entries.filter((e) => !typed.isSecureField(e.selector) && Number.isFinite(e.at) && now - e.at <= wrote.MAX_AGE_MS);
  const dropped = entries.length - kept.length;
  if (dropped && !dryRun) store.writeAtomic(path.join(store.deviceDir(udid), 'wrote.json'), JSON.stringify(kept));
  return { dropped };
}

for (const udid of udids) {
  if (skip.some((p) => p && udid.startsWith(p))) {
    console.log(`${udid.slice(0, 8)}  skipped`);
    continue;
  }
  if (!fs.existsSync(store.deviceDir(udid))) {
    console.log(`${udid.slice(0, 8)}  no such device directory`);
    continue;
  }
  const g = graph.scrubGraph(udid, { dryRun });
  const f = scrubFlows(udid);
  const j = scrubJournal(udid);
  console.log(`${udid.slice(0, 8)}  graph: ${g.edges} edge(s) in ${g.rewritten}/${g.files} file(s)`
    + `${g.unreadable ? `, ${g.unreadable} unreadable` : ''}`
    + `  flows: ${f.rewritten}/${f.files}  journal: ${j.dropped} dropped`
    + (dryRun ? '  (dry run — nothing written)' : ''));
}
