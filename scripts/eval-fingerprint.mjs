#!/usr/bin/env node
// Do the two fingerprint distributions still separate?
//
// Screen identity is a Jaccard comparison of structural token sets against a
// threshold. That only works while two distributions stay apart: the similarity
// of a screen to *itself on a later visit*, and its similarity to *other
// screens*. Phase 6b measured them by hand at 0.41–1.00 against 0.00–0.31 — a
// gap of 0.11, with the threshold at 0.36 in the middle of it.
//
// By hand is not good enough for anything that changes what goes into a
// fingerprint. Region bands do: chrome labels are the only text in a token set,
// so how the bands are drawn decides which labels enter identity at all. This
// harness exists so that change can be measured either side instead of argued
// about.
//
// Every reading is taken COLD. `screenIdentity({fresh: true})` rebuilds the
// screen map rather than recalling it, because a recalled map returns the
// tokens of the visit that built it and would measure the cache rather than the
// fingerprint — which is exactly how 6b's warm row came out flatteringly wrong.
import fs from 'node:fs';
import * as actions from '../src/actions.js';
import * as fingerprint from '../src/fingerprint.js';
import * as graph from '../src/graph.js';
import * as api from '../src/index.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const tourFile = arg('tour');
const rounds = Number(arg('rounds', 3));
/**
 * Above this, two consecutive tour screens are the same screen and the
 * navigation between them failed. Deliberately well above the identity
 * threshold: this is not "might be the same screen", it is "obviously is".
 */
const ARRIVAL_SUSPICION = 0.7;
const outFile = arg('out');
const device = arg('device');
const label = arg('label', 'unnamed');

if (!tourFile) {
  console.error(`usage: node scripts/eval-fingerprint.mjs --tour=<tour.json> [--rounds=3] [--device=<udid>] [--out=<file>] [--label=<name>]

A tour is a JSON array of screens to visit in a cycle:

  [{"name": "home",     "steps": [{"button": "home"}]},
   {"name": "browser",  "steps": [{"openUrl": "https://example.com"}]}]

Each round walks the whole cycle, so every screen is left and re-arrived at
between readings — which is what makes "the same screen, revisited" a real
question rather than a re-read of the same frame.`);
  process.exit(2);
}

const tour = JSON.parse(fs.readFileSync(tourFile, 'utf8'));
if (!Array.isArray(tour) || tour.length < 2) {
  console.error('a tour needs at least two screens, or there are no different-screen pairs to measure');
  process.exit(2);
}

const { device: dev } = await api.ensureDaemon(device);
console.log(`device: ${dev.name} (${dev.runtime})`);
console.log(`tour: ${tour.length} screens x ${rounds} rounds, every reading cold\n`);

/** @type {Array<{name: string, round: number, hash: string, tokens: string[], count: number}>} */
const readings = [];
/** Navigations that did not land before the reading was taken. */
const arrivalFailures = [];

for (let round = 1; round <= rounds; round += 1) {
  for (const screen of tour) {
    if (screen.steps?.length) {
      // Verification is off: this measures fingerprints, and a wrong-turn
      // verdict computed from the very tokens under test would be circular.
      await actions.runScript(device, { steps: screen.steps, verify: false });
    }
    const id = await api.screenIdentity(device, { fresh: true, confirmNovel: false });
    // Did we actually arrive? Two differently-named screens reading the same
    // fingerprint means the navigation did not land before the reading was
    // taken, and every distribution below it is then measuring the tour rather
    // than the fingerprint. The first version of this harness did exactly that
    // and reported that the distributions overlapped completely.
    const previous = readings[readings.length - 1];
    if (previous && previous.name !== screen.name) {
      // Not just an identical hash. Two readings of the same screen can differ
      // by a token and still obviously be the same screen — measured: a
      // "springboard" reading that was actually Settings shared 11 of its 12
      // tokens with the Settings reading beside it, and the harness passed it
      // because the hashes differed. Anything this similar across a navigation
      // means the navigation did not happen.
      const s = fingerprint.similarity(previous.tokens, id.tokens ?? []);
      if (s >= ARRIVAL_SUSPICION) {
        arrivalFailures.push(
          `${previous.name} -> ${screen.name}: similarity ${s.toFixed(2)} — the screen did not change`);
      }
    }
    readings.push({
      name: screen.name,
      round,
      hash: id.hash,
      tokens: id.tokens ?? [],
      count: (id.tokens ?? []).length,
      settled: id.settled,
    });
    process.stdout.write(
      `  round ${round}  ${screen.name.padEnd(14)} ${String(id.hash).slice(0, 10)}  ${String((id.tokens ?? []).length).padStart(3)} tokens${id.settled ? '' : '  (never settled)'}\n`,
    );
  }
}

if (arrivalFailures.length) {
  console.error(`\nFAIL ${arrivalFailures.length} reading(s) were taken on the previous screen:`);
  for (const f of arrivalFailures) console.error(`       ${f}`);
  console.error('\nThe tour did not settle before being read, so the distributions below would');
  console.error('measure the tour rather than the fingerprint. Fix the tour and re-run.');
  console.error('A `settle` step defaults to mode "stable", which returns instantly in the');
  console.error('moment before an animation begins — action steps already settle on their own.');
  process.exit(1);
}

const same = [];
const different = [];
for (let i = 0; i < readings.length; i += 1) {
  for (let j = i + 1; j < readings.length; j += 1) {
    const s = fingerprint.similarity(readings[i].tokens, readings[j].tokens);
    (readings[i].name === readings[j].name ? same : different).push({
      a: readings[i], b: readings[j], similarity: s,
    });
  }
}

const stats = (rows) => {
  if (!rows.length) return null;
  const v = rows.map((r) => r.similarity).sort((x, y) => x - y);
  return {
    n: v.length,
    min: v[0],
    max: v[v.length - 1],
    median: v[v.length >> 1],
  };
};

const s = stats(same);
const d = stats(different);
const gap = s && d ? s.min - d.max : null;
const threshold = graph.SIMILARITY_THRESHOLD;

const f = (x) => (x == null ? '—' : x.toFixed(2));
console.log(`\n${'distribution'.padEnd(26)} ${'n'.padStart(4)} ${'min'.padStart(6)} ${'median'.padStart(7)} ${'max'.padStart(6)}`);
console.log(`${'same screen, revisited'.padEnd(26)} ${String(s?.n ?? 0).padStart(4)} ${f(s?.min).padStart(6)} ${f(s?.median).padStart(7)} ${f(s?.max).padStart(6)}`);
console.log(`${'different screens'.padEnd(26)} ${String(d?.n ?? 0).padStart(4)} ${f(d?.min).padStart(6)} ${f(d?.median).padStart(7)} ${f(d?.max).padStart(6)}`);
console.log(`\ngap (same-min − different-max): ${f(gap)}`);
console.log(`threshold in use: ${threshold}`);

const separated = gap != null && gap > 0;
const thresholdInGap = s && d && threshold > d.max && threshold < s.min;
console.log(`${separated ? 'ok  ' : 'FAIL'} the distributions ${separated ? 'separate' : 'OVERLAP — no threshold can tell these screens apart'}`);
console.log(`${thresholdInGap ? 'ok  ' : 'WARN'} the threshold ${thresholdInGap ? 'sits inside the gap' : 'is NOT inside the gap'}`);

// The worst offenders, because a distribution is not actionable and a pair is.
const worstSame = [...same].sort((a, b) => a.similarity - b.similarity)[0];
const worstDifferent = [...different].sort((a, b) => b.similarity - a.similarity)[0];
if (worstSame) {
  console.log(`\nweakest same-screen pair:   ${worstSame.a.name} r${worstSame.a.round} vs r${worstSame.b.round} = ${f(worstSame.similarity)} (${worstSame.a.count} vs ${worstSame.b.count} tokens)`);
}
if (worstDifferent) {
  console.log(`closest different-screen pair: ${worstDifferent.a.name} vs ${worstDifferent.b.name} = ${f(worstDifferent.similarity)}`);
}

// Chrome labels are the only text in a fingerprint, so which of them got in is
// the thing a band change actually moves.
const labels = new Set();
for (const r of readings) {
  for (const t of r.tokens) {
    if (t.includes('"')) labels.add(t.slice(t.indexOf('"') + 1, t.lastIndexOf('"')));
  }
}
console.log(`\n${labels.size} distinct chrome label(s) entered identity: ${[...labels].sort().join(' · ') || '(none)'}`);

if (outFile) {
  fs.writeFileSync(outFile, JSON.stringify({
    label, device: dev.name, runtime: dev.runtime, rounds, at: Date.now(),
    threshold, same: s, different: d, gap, separated, thresholdInGap,
    labels: [...labels].sort(),
    readings: readings.map(({ tokens, ...r }) => ({ ...r, tokenCount: tokens.length })),
  }, null, 2));
  console.log(`\nwrote ${outFile}`);
}

process.exit(separated ? 0 : 1);
