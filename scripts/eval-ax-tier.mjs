#!/usr/bin/env node
// What is the accessibility tier actually worth?
//
// Phase 2a moved the tree host-side and made it fast; the tree is also absent
// on Android and will stay absent until an APK is worth shipping
// (docs/DEFERRED.md, Phase 8b). Both of those decisions rest on the same
// unmeasured quantity: how much of what simframe knows about a screen comes
// from the tree rather than from OCR and CV.
//
// So this walks a tour and, on every screen, builds the map twice — once with
// the tree and once without — from the same frame. Neither map is persisted, so
// measuring does not teach the graph anything.
//
// Three questions, because they have different answers:
//
//   provenance   of the elements on a screen, and of the *interactive* ones,
//                how many only the tree can see
//   recognition  would a revisit be recognised as the same screen, per tier —
//                the graph's own rule, `similarity >= SIMILARITY_THRESHOLD`
//   intents      given a name a user would type, does the right element come
//                back, per tier
import fs from 'node:fs';
import * as actions from '../src/actions.js';
import * as api from '../src/index.js';
import * as fingerprint from '../src/fingerprint.js';
import * as graph from '../src/graph.js';
import * as matching from '../src/matching.js';
import * as screenmap from '../src/screenmap.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const tourFile = arg('tour');
const rounds = Number(arg('rounds', 2));
const device = arg('device');
const outFile = arg('out');
const listLabels = process.argv.includes('--labels');

if (!tourFile) {
  console.error('usage: node scripts/eval-ax-tier.mjs --tour=<tour.json> [--rounds=2] [--device=<udid>] [--labels] [--out=<file>]');
  process.exit(2);
}
const tour = JSON.parse(fs.readFileSync(tourFile, 'utf8'));

const { device: dev } = await api.ensureDaemon(device);
console.log(`device: ${dev.name} (${dev.runtime})`);
console.log(`tour: ${tour.length} screens x ${rounds} rounds, each screen read twice — with the tree and without\n`);

/** Roles a user can act on. Text is not one: it is what a screen says, not what it offers. */
const INTERACTIVE = new Set(['button', 'field', 'switch', 'cell', 'link']);
const isInteractive = (t) => INTERACTIVE.has(fingerprint.roleOf(t));
const sourcesOf = (t) => String(t.source ?? '').split(/[+,]/).filter(Boolean);

const readings = [];
for (let round = 1; round <= rounds; round += 1) {
  for (const screen of tour) {
    if (screen.steps?.length) await actions.runScript(device, { steps: screen.steps, verify: false });
    // One frame, two maps. `api.screenIdentity` is not used here because it
    // decides for itself which layers to read; this has to pin them.
    const withTree = await api.readScreenWith(device, { useAx: true });
    const withoutTree = await api.readScreenWith(device, { useAx: false });
    readings.push({ name: screen.name, round, withTree, withoutTree, intents: screen.intents ?? [] });
    const t = withTree.entry.targets ?? [];
    const o = withoutTree.entry.targets ?? [];
    console.log(
      `  round ${round}  ${screen.name.padEnd(22)} tree: ${String(t.length).padStart(3)} elements ` +
      `(${t.filter(isInteractive).length} interactive)   no tree: ${String(o.length).padStart(3)} ` +
      `(${o.filter(isInteractive).length} interactive)`,
    );
    if (listLabels) {
      for (const e of t) {
        console.log(`      [${String(e.source ?? '?').padEnd(6)}] ${fingerprint.roleOf(e).padEnd(7)} ${JSON.stringify(String(e.label ?? '').slice(0, 40))}`);
      }
    }
  }
}

// --- provenance -------------------------------------------------------------
// Agreement between the two sensors is not recorded in `source`. When OCR text
// falls inside an accessibility element the map keeps the element and files the
// text as an *alias* on it, so `source` stays 'ax' — which means counting
// sources alone reports that the two sensors never see the same thing, and they
// do. An alias is the evidence that they agreed.
let all = 0;
let axAndOcr = 0;
let axAlone = 0;
let ocrOnly = 0;
let inter = 0;
let interAxOnly = 0;
let interAxInvisible = 0;
for (const r of readings) {
  for (const t of r.withTree.entry.targets ?? []) {
    const src = sourcesOf(t);
    all += 1;
    const hasAx = src.includes('ax');
    const alsoSeen = (t.aliases ?? []).length > 0;
    if (hasAx && alsoSeen) axAndOcr += 1;
    else if (hasAx) axAlone += 1;
    else ocrOnly += 1;
    if (isInteractive(t)) {
      inter += 1;
      if (hasAx) interAxOnly += 1;
      // The interesting class: a control the tree knows about that OCR cannot
      // see at all, because it has no text — an icon. This is what a platform
      // without a tree simply cannot offer.
      if (hasAx && !alsoSeen) interAxInvisible += 1;
    }
  }
}
const both = axAndOcr;
const axOnly = axAlone;
const pct = (n, of) => (of ? `${((n / of) * 100).toFixed(0)}%` : '—');

console.log('\n--- provenance, over every element on every reading ---');
console.log(`  elements                       ${all}`);
console.log(`  from the tree, OCR saw nothing ${axOnly}  ${pct(axOnly, all)}`);
console.log(`  from OCR/CV alone              ${ocrOnly}  ${pct(ocrOnly, all)}`);
console.log(`  from the tree, OCR agreed      ${both}  ${pct(both, all)}  (text found inside the element)`);
console.log(`  interactive elements           ${inter}`);
console.log(`  interactive, from the tree      ${interAxOnly}  ${pct(interAxOnly, inter)}`);
console.log(`  interactive with no text at all ${interAxInvisible}  ${pct(interAxInvisible, inter)}  (icons — OCR cannot see these)`);

// --- recognition ------------------------------------------------------------
function recognition(pick) {
  const byName = new Map();
  for (const r of readings) byName.set(r.name, [...(byName.get(r.name) ?? []), pick(r)]);
  let pairs = 0;
  let recognised = 0;
  const worst = [];
  for (const [name, list] of byName) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const s = fingerprint.similarity(list[i].entry.structuralTokens ?? [], list[j].entry.structuralTokens ?? []);
        pairs += 1;
        if (s >= graph.SIMILARITY_THRESHOLD) recognised += 1;
        worst.push({ name, s });
      }
    }
  }
  worst.sort((a, b) => a.s - b.s);
  return { pairs, recognised, worst: worst[0] };
}
const treeRec = recognition((r) => r.withTree);
const bareRec = recognition((r) => r.withoutTree);

// --- intents ----------------------------------------------------------------
function intents(pick) {
  let asked = 0;
  let right = 0;
  const misses = [];
  for (const r of readings) {
    const entry = pick(r);
    for (const want of r.intents) {
      asked += 1;
      const hit = matching.resolve(entry.entry.targets ?? [], want, { screen: entry.points });
      // `ambiguous` is not a resolution: a caller gets an error and has to say
      // which, so counting it as correct would flatter the tier that produced it.
      const label = hit.status === 'ok' ? String(hit.target.label ?? '') : '';
      if (label.toLowerCase().includes(String(want).toLowerCase())) right += 1;
      else misses.push(`${r.name} r${r.round}: "${want}" → ${label ? JSON.stringify(label.slice(0, 30)) : hit.status}`);
    }
  }
  return { asked, right, misses };
}
const treeInt = intents((r) => r.withTree);
const bareInt = intents((r) => r.withoutTree);

console.log('\n--- with the tree, and without ---');
console.log(`${''.padEnd(30)} ${'tree + OCR'.padStart(12)} ${'OCR/CV only'.padStart(12)}`);
console.log(`${'elements per reading'.padEnd(30)} ${(all / readings.length).toFixed(1).padStart(12)} ${((readings.reduce((n, r) => n + (r.withoutTree.entry.targets ?? []).length, 0)) / readings.length).toFixed(1).padStart(12)}`);
console.log(`${'screens recognised on revisit'.padEnd(30)} ${`${treeRec.recognised}/${treeRec.pairs}`.padStart(12)} ${`${bareRec.recognised}/${bareRec.pairs}`.padStart(12)}`);
console.log(`${'weakest revisit similarity'.padEnd(30)} ${treeRec.worst?.s.toFixed(2).padStart(12)} ${bareRec.worst?.s.toFixed(2).padStart(12)}`);
console.log(`${'intents resolved correctly'.padEnd(30)} ${`${treeInt.right}/${treeInt.asked}`.padStart(12)} ${`${bareInt.right}/${bareInt.asked}`.padStart(12)}`);

for (const [label, res] of [['tree + OCR', treeInt], ['OCR/CV only', bareInt]]) {
  if (res.misses.length) {
    console.log(`\nintents ${label} got wrong:`);
    for (const m of res.misses.slice(0, 12)) console.log(`   ${m}`);
  }
}

if (outFile) {
  fs.writeFileSync(outFile, JSON.stringify({
    device: dev.name, runtime: dev.runtime, rounds, at: Date.now(),
    provenance: { all, axOnly, ocrOnly, both, interactive: inter, interactiveAxOnly: interAxOnly, interactiveIconOnly: interAxInvisible },
    recognition: { tree: treeRec, bare: bareRec },
    intents: { tree: treeInt, bare: bareInt },
  }, null, 2));
  console.log(`\nwrote ${outFile}`);
}
