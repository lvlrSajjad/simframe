#!/usr/bin/env node
// Why do same-screen revisits disagree? Aggregate, not anecdotal.
//
// `eval-fingerprint.mjs` says how far apart the two distributions are and names
// the single worst pair. That was enough while the gap was wide and stopped
// being enough the day it narrowed: one pair is an anecdote, and the fix has to
// be aimed at whatever causes most of the divergence.
//
// So this reads an eval's `--out` JSON and classifies every divergent token in
// every same-screen pair. The token grammar is
// `role:region[:@slot]:w:h["label"]:x:y#count`, which is enough to say what
// moved:
//
//   label      the same structure under a different chrome label — a dynamic or
//              misread name, the thing chrome labels were most feared to do
//   role       the same geometry and place under a different role — inference
//              flipping, e.g. a field that sometimes gets a rectangle
//   bucket     the same key, `#1` on one side and `#many` on the other — a
//              sibling count straddling the boundary
//   anchor     the same key at a different quantised x/y — the group's topmost
//              member moved by half a grid cell
//   size       the same role and place at a different quantised w/h — usually
//              OCR returning a different bounding box for the same text
//   presence   a structural key on one side only — an element that came or went
import fs from 'node:fs';
import * as fingerprint from '../src/fingerprint.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/analyse-fingerprint.mjs <eval --out file.json>');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const readings = data.readings ?? [];
if (!readings.length || !readings[0].tokens) {
  console.error('that eval was written without tokens — re-run the eval, it keeps them now');
  process.exit(2);
}

/**
 * A token, taken apart.
 *
 * `role:region[:@slot]:w<n>:h<n>[:"label"]:x<n>:y<n>#<count>` — every field is
 * separated so a pair of tokens can be compared field by field. The first
 * version of this file matched tokens by stripping one field at a time and
 * asking whether the rest was equal, which sounds equivalent and is not: the
 * size-stripped form of a content text token is `text:content`, which matches
 * *every* content text token, so whichever candidate happened to be left over
 * got called a size change. It reported 100% `size` for a sample the eval
 * itself had already shown contained a count flip.
 */
const FIELDS = ['role', 'region', 'slot', 'w', 'h', 'label', 'x', 'y', 'count'];
const TOKEN = /^([^:]+):([^:]+)(?::@([^:]+))?:w(\d+):h(\d+)(?::"([^"]*)")?:x(-?\d+):y(-?\d+)#(1|many)$/;

function parse(token) {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const [, role, region, slot, w, h, label, x, y, count] = m;
  return { token, role, region, slot: slot ?? null, w, h, label: label ?? null, x, y, count };
}

/** Which fields differ, in a stable order. */
function differing(a, b) {
  return FIELDS.filter((f) => a[f] !== b[f]);
}

/**
 * What to call a difference of these fields.
 *
 * Named after the cause rather than the field, because the fix is different for
 * each: a label that moves is normalisation, a role that flips is inference, a
 * count that straddles is bucketing, a box that changes is OCR segmentation.
 */
function nameOf(fields) {
  if (!fields.length) return 'identical';
  const names = new Set();
  for (const f of fields) {
    if (f === 'label') names.add('label');
    else if (f === 'role') names.add('role');
    else if (f === 'count') names.add('bucket');
    else if (f === 'x' || f === 'y') names.add('anchor');
    else if (f === 'w' || f === 'h') names.add('size');
    else names.add(f);
  }
  return [...names].sort().join('+');
}

/** Beyond this many differing fields, two tokens are not the same thing moved. */
const RELATED_MAX_FIELDS = 3;

const causes = new Map();
const byRegion = new Map();
const bump = (map, k, n = 1) => map.set(k, (map.get(k) ?? 0) + n);

const pairs = [];
for (let i = 0; i < readings.length; i += 1) {
  for (let j = i + 1; j < readings.length; j += 1) {
    if (readings[i].name !== readings[j].name) continue;
    const a = readings[i];
    const b = readings[j];
    const similarity = fingerprint.similarity(a.tokens, b.tokens);
    const setA = new Set(a.tokens);
    const setB = new Set(b.tokens);
    const onlyA = a.tokens.filter((t) => !setB.has(t)).map(parse).filter(Boolean);
    const onlyB = b.tokens.filter((t) => !setA.has(t)).map(parse).filter(Boolean);
    pairs.push({ name: a.name, ra: a.round, rb: b.round, similarity, divergent: onlyA.length + onlyB.length });

    // Best match, not first match: each unmatched token on the left is paired
    // with the candidate on the right that differs in the fewest fields, and
    // that pairing is consumed. Greedy-by-preference-order is what produced the
    // wrong answer above.
    const remaining = [...onlyB];
    for (const left of onlyA) {
      let best = null;
      for (let k = 0; k < remaining.length; k += 1) {
        const fields = differing(left, remaining[k]);
        if (!best || fields.length < best.fields.length) best = { k, fields };
      }
      const related = best && best.fields.length <= RELATED_MAX_FIELDS;
      const cause = related ? nameOf(best.fields) : 'presence';
      if (related) remaining.splice(best.k, 1);
      bump(causes, cause);
      bump(byRegion, `${left.region}/${left.role}`);
    }
    for (const right of remaining) {
      bump(causes, 'presence');
      bump(byRegion, `${right.region}/${right.role}`);
    }
  }
}

pairs.sort((x, y) => x.similarity - y.similarity);
const totalDivergent = [...causes.values()].reduce((a, b) => a + b, 0);
const pct = (n) => `${((n / totalDivergent) * 100).toFixed(0)}%`;

console.log(`${pairs.length} same-screen pairs from ${readings.length} readings (${data.label ?? 'unlabelled'}, ${data.device ?? '?'})`);
console.log(`similarity: min ${pairs[0]?.similarity.toFixed(2)}  median ${pairs[pairs.length >> 1]?.similarity.toFixed(2)}  max ${pairs[pairs.length - 1]?.similarity.toFixed(2)}`);
console.log(`\n${totalDivergent} divergent token(s) across those pairs, by cause:`);
for (const [cause, n] of [...causes].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${pct(n).padStart(4)}  ${cause}`);
}
console.log('\nby region/role — where the instability lives:');
for (const [where, n] of [...byRegion].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${pct(n).padStart(4)}  ${where}`);
}
console.log('\nweakest pairs:');
for (const p of pairs.slice(0, 8)) {
  console.log(`  ${p.similarity.toFixed(2)}  ${p.name} r${p.ra} vs r${p.rb}  (${p.divergent} divergent)`);
}
