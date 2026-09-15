#!/usr/bin/env node
/**
 * Of the `verification_failed` escalations, how many happened on a
 * `(screen, action)` the graph had already seen behave consistently?
 * EXPERIMENTS §17. The answer was 3% and 0%, which is why this is kept: it is
 * the measurement that stopped a phase being spent on remembering edge
 * outcomes.
 *
 * Two thirds of those escalations are `no-visible-change`, and 83-100% of them
 * are on a screen or an action the graph has never seen — memory cannot answer
 * a question about a place it has never been.
 *
 * The graph is read as it is NOW, so an edge matched here may have been learned
 * after the escalation. That makes the "addressable" figure an upper bound, and
 * it is already near zero.
 *
 * Aggregate by design, and stricter than it looks: `detail` is app content, so
 * verdicts are classified against a CLOSED vocabulary and the raw string is
 * never printed. The first version of this printed the prefix and put a
 * client's screen labels and a customer email into a terminal.
 *
 * Usage: node scripts/analyse-escalations.mjs <udid-prefix> [<udid-prefix>...] */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = process.env.SIMFRAME_HOME || path.join(os.homedir(), '.simframe');

for (const dev of process.argv.slice(2)) {
  const dir = fs.readdirSync(root).find((d) => d.startsWith(dev));
  if (!dir) continue;
  const base = path.join(root, dir);
  const gdir = path.join(base, 'graph');
  if (!fs.existsSync(gdir)) continue;

  const nodes = fs.readdirSync(gdir).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(gdir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
  const byHash = new Map();
  for (const n of nodes) { byHash.set(n.hash, n); for (const v of n.variants ?? []) if (!byHash.has(v.hash)) byHash.set(v.hash, n); }

  const esc = [];
  const p = path.join(base, 'escalations.jsonl');
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim(); if (!t) continue;
    try { esc.push(JSON.parse(t)); } catch {}
  }
  const vf = esc.filter((e) => e.reason === 'verification_failed');

  const bucket = { noScreen: 0, noEdge: 0, seenOnce: 0, consistent: 0, nondet: 0 };
  const verdicts = new Map();
  for (const e of vf) {
    // Classify against a CLOSED vocabulary and never emit the raw text. The
    // first version split on ':' and printed the prefix, which put a client's
    // screen labels and an email address into a terminal. `detail` is app
    // content; only its shape is ours to report.
    const d = String(e.detail ?? '').toLowerCase();
    const v = d.includes('no-visible-change') || d.includes('did not change') ? 'no-visible-change'
      : d.includes('unexpected-screen') ? 'unexpected-screen'
      : d.includes('did not settle') ? 'settle-timeout'
      : d.includes('waited') ? 'wait-timeout'
      : d.includes('matches') && d.includes('things') ? 'ambiguous'
      : d.includes('numbered on a different') ? 'stale-ref'
      : d.includes('disabled') ? 'disabled-control'
      : d ? 'other' : '(none)';
    verdicts.set(v, (verdicts.get(v) ?? 0) + 1);
    const node = byHash.get(e.screen_fingerprint ?? '');
    if (!node) { bucket.noScreen++; continue; }
    const want = String(e.intent ?? '').toLowerCase();
    const hit = (node.edges ?? []).find((x) => {
      const sig = String(x.action ?? '').toLowerCase();
      return want && (sig.endsWith(`:${want}`) || sig.includes(want));
    });
    if (!hit) { bucket.noEdge++; continue; }
    if ((hit.changedOutcomes ?? 0) > 0) bucket.nondet++;
    else if ((hit.count ?? 0) > 1) bucket.consistent++;
    else bucket.seenOnce++;
  }
  const pct = (n) => (vf.length ? Math.round((100 * n) / vf.length) : 0);
  console.log(`--- ${dev} ---`);
  console.log(`  verification_failed: ${vf.length}`);
  console.log(`  screen not in graph at all:            ${bucket.noScreen} (${pct(bucket.noScreen)}%)`);
  console.log(`  screen known, this action never seen:  ${bucket.noEdge} (${pct(bucket.noEdge)}%)`);
  console.log(`  edge seen exactly once:                ${bucket.seenOnce} (${pct(bucket.seenOnce)}%)`);
  console.log(`  edge NONDETERMINISTIC (rightly asked): ${bucket.nondet} (${pct(bucket.nondet)}%)`);
  console.log(`  edge repeated and CONSISTENT:          ${bucket.consistent} (${pct(bucket.consistent)}%)  <- addressable`);
  console.log(`  verdict words: ${[...verdicts].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,n])=>`${k}=${n}`).join(', ')}`);
}
