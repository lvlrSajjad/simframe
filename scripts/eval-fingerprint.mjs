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
 * How much room the threshold must have on each side.
 *
 * `gap > 0` was the only bar until the margin narrowed, and a gap can be wide
 * while the threshold sits at the edge of it — which is the state that actually
 * misclassifies a screen. So the bar is stated as clearance around the
 * threshold itself: every same-screen revisit must score at least
 * `threshold + CLEARANCE`, and every different-screen pair at most
 * `threshold - CLEARANCE`.
 *
 * 0.10 is chosen against measurement, not taste. Clean runs on this machine
 * put same-min at 0.67-0.75 and different-max at 0.05, so the clearance in
 * hand is roughly 0.3 either way; requiring 0.10 fails well before a
 * misclassification and does not fire on ordinary variation. Raise it when the
 * recorded distributions say it can be raised.
 */
const CLEARANCE = 0.1;

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

/**
 * The tokens that carry a name, as opposed to a shape.
 *
 * A fingerprint is deliberately geometry — role, region, size, position — and
 * chrome labels are the only text that survives into it (`fingerprint.js`).
 * That module's own comment states the consequence: "two list screens with
 * identical structure differ by their title, and nothing else says so". So a
 * reading with none of these has no identity to speak of, and two such
 * readings of *different* screens can hash identically. Counted here because
 * that is diagnosable and "the tour went somewhere unintended" is not.
 */
const namedTokens = (tokens) => tokens.filter((t) => t.includes('"'));

/**
 * Write the readings out now, rather than after the checks.
 *
 * The write used to sit past every `process.exit(1)`, so the only run that
 * kept its evidence was the run with nothing to explain. A failing run exited
 * before the file existed and `if: always()` on the upload step faithfully
 * uploaded nothing — which is how one red integration job cost an evening of
 * inferring from a summary line while `analyse-fingerprint.mjs`, which exists
 * to classify exactly these divergences, had no file to read. Called as soon
 * as the tour is done and again with the analysis, so every exit below this
 * point still leaves the readings behind.
 */
const save = (extra = {}) => {
  if (!outFile) return;
  fs.writeFileSync(outFile, JSON.stringify({
    label, device: dev.name, runtime: dev.runtime, rounds, at: Date.now(),
    threshold: graph.SIMILARITY_THRESHOLD,
    // Tokens are kept. They were stripped here once, and the first time the
    // margin narrowed the run could not be diagnosed from its own output.
    readings,
    ...extra,
  }, null, 2));
};

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
      // The elements the tokens were computed from, and the screen they were
      // measured in. Kept so a candidate change to the token rules can be
      // simulated against recorded readings by re-running the real tokeniser,
      // instead of by transforming its output and hoping that is equivalent.
      targets: id.entry?.targets ?? [],
      screen: id.points,
      // Which sensors answered. Two readings of one screen taken with
      // different sensors are *known* not to agree — the tree and OCR share
      // 0.33-0.47 of a screen's structural tokens (docs/DEFERRED.md) — and
      // absorbing that is the graph's job, through aliasing, not the
      // fingerprint's. So the distributions below are split by sensor mix
      // rather than averaged over it, which is what made a mixed pair look
      // like fingerprint drift.
      sources: id.entry?.sources ?? [],
    });
    // Sensors and named tokens are on every line, not only inside a failure.
    // Both were invisible until a run failed, and both are what the failure
    // turns out to be about: two readings of one screen taken by different
    // sensors do not share a hash by design, and a reading carrying no chrome
    // label cannot be told from any other screen of the same shape. A summary
    // line that hid those sent an evening after hosted-runner speed.
    process.stdout.write(
      `  round ${round}  ${screen.name.padEnd(22)} ${String(id.hash).slice(0, 10)}  `
      + `${String((id.tokens ?? []).length).padStart(3)} tokens  `
      + `${String(namedTokens(id.tokens ?? []).length).padStart(2)} named  `
      + `${((id.entry?.sources ?? []).join('+') || 'none').padEnd(9)}`
      + `${id.settled ? '' : '  (never settled)'}\n`,
    );
  }
}

save();
if (outFile) console.log(`\nwrote ${readings.length} readings to ${outFile}`);

if (arrivalFailures.length) {
  console.error(`\nFAIL ${arrivalFailures.length} reading(s) were taken on the previous screen:`);
  for (const f of arrivalFailures) console.error(`       ${f}`);
  console.error('\nThe tour did not settle before being read, so the distributions below would');
  console.error('measure the tour rather than the fingerprint. Fix the tour and re-run.');
  console.error('A `settle` step defaults to mode "stable", which returns instantly in the');
  console.error('moment before an animation begins — action steps already settle on their own.');
  process.exit(1);
}

/**
 * A reading taken somewhere other than where the tour meant to be.
 *
 * The arrival check above compares each reading with the one before it, which
 * catches "the navigation did not happen" and misses "the navigation went
 * somewhere else". It missed exactly that: a reading labelled
 * settings-accessibility was in fact the Settings root list, and being unlike
 * its own screen at one end and like a different screen at the other, it alone
 * moved the same-screen minimum to 0.00 and the different-screen maximum to
 * 0.40 across 30 pairs. Both distributions were then measuring the tour.
 *
 * So each reading is also checked against its own siblings: a reading that
 * resembles no other reading of its own screen, while resembling some other
 * screen at least as much, was not where it says it was. That needs at least
 * two siblings to be an outlier test rather than a coin toss, so it only
 * applies from three rounds up.
 */
function findStrays(all) {
  const strays = [];
  const byName = new Map();
  for (const r of all) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  for (const r of all) {
    const siblings = byName.get(r.name).filter((o) => o !== r);
    if (siblings.length < 2) continue;
    const bestSelf = Math.max(...siblings.map((o) => fingerprint.similarity(r.tokens, o.tokens)));
    const others = all.filter((o) => o.name !== r.name);
    // Which screen it resembles, not merely how much. A stray that resembles
    // one particular other screen at 1.00 is a different animal from one that
    // resembles everything weakly, and the report could not tell them apart.
    let match = null;
    let bestOther = 0;
    for (const o of others) {
      const s = fingerprint.similarity(r.tokens, o.tokens);
      if (s > bestOther) { bestOther = s; match = o; }
    }
    if (bestSelf < graph.SIMILARITY_THRESHOLD && bestOther >= bestSelf) {
      strays.push({ reading: r, bestSelf, bestOther, match });
    }
  }
  return strays;
}

const strays = findStrays(readings);
if (strays.length) {
  console.error(`\nFAIL ${strays.length} reading(s) do not resemble their own screen:`);
  // Two causes wear the same symptom, and until now the report asserted the
  // second one. A reading can be unlike its siblings because the tour went
  // somewhere unintended — or because the fingerprint could not tell two
  // screens apart, which is the harness's actual subject. They are separable
  // from the data in hand: a collision is a reading that carries no chrome
  // label while matching one particular other screen almost exactly, and a
  // wrong turn is one whose tokens name a screen the tour did not ask for.
  let collisions = 0;
  for (const { reading, bestSelf, bestOther, match } of strays) {
    const named = namedTokens(reading.tokens);
    const matchNamed = match ? namedTokens(match.tokens) : [];
    const collided = bestOther >= 0.99 && named.length === 0 && matchNamed.length === 0;
    if (collided) collisions += 1;
    console.error(`       ${reading.name} r${reading.round}: own screen ${bestSelf.toFixed(2)}, `
      + `${match ? `${match.name} r${match.round}` : 'another screen'} ${bestOther.toFixed(2)} `
      + `(${reading.count} tokens, ${named.length} named, sources ${reading.sources.join('+') || 'none'})`);
    if (collided) {
      console.error('              ^ a COLLISION, not a wrong turn: neither reading carries a chrome');
      console.error('                label, so both are structure with no name and the fingerprint has');
      console.error('                nothing left to tell two list screens apart.');
    }
    if (named.length) console.error(`              names: ${named.map((t) => t.slice(t.indexOf('"'), t.lastIndexOf('"') + 1)).join(' ')}`);
  }
  if (collisions) {
    console.error(`\n${collisions} of ${strays.length} are fingerprint collisions. That is this harness's own subject,`);
    console.error('not a tour fault: a reading whose chrome label went missing cannot establish');
    console.error('identity, and comparing it as though it could is what produced the verdict above.');
  } else {
    console.error('\nThat is the tour going somewhere unintended, not the fingerprint drifting, and');
    console.error('measuring it as either distribution poisons both ends. Fix the tour — a tap that');
    console.error('missed, or a screen that needs longer than its pause — and re-run.');
  }
  console.error(`\nEvery reading is in ${outFile ?? 'the --out file'}; `
    + 'run `node scripts/analyse-fingerprint.mjs <that file>` to classify the divergent tokens.');
  process.exit(1);
}

/** Which sensors produced a reading, as a comparable key. */
const mixOf = (r) => (r.sources ?? []).join('+') || 'unknown';

const same = [];
const mixed = [];
const different = [];
for (let i = 0; i < readings.length; i += 1) {
  for (let j = i + 1; j < readings.length; j += 1) {
    const s = fingerprint.similarity(readings[i].tokens, readings[j].tokens);
    const pair = { a: readings[i], b: readings[j], similarity: s };
    if (readings[i].name !== readings[j].name) different.push(pair);
    else if (mixOf(readings[i]) === mixOf(readings[j])) same.push(pair);
    else mixed.push(pair);
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
const m = stats(mixed);
const d = stats(different);
const gap = s && d ? s.min - d.max : null;
const threshold = graph.SIMILARITY_THRESHOLD;

const f = (x) => (x == null ? '—' : x.toFixed(2));
console.log(`\n${'distribution'.padEnd(26)} ${'n'.padStart(4)} ${'min'.padStart(6)} ${'median'.padStart(7)} ${'max'.padStart(6)}`);
console.log(`${'same screen, revisited'.padEnd(26)} ${String(s?.n ?? 0).padStart(4)} ${f(s?.min).padStart(6)} ${f(s?.median).padStart(7)} ${f(s?.max).padStart(6)}`);
console.log(`${'same screen, mixed sensors'.padEnd(26)} ${String(m?.n ?? 0).padStart(4)} ${f(m?.min).padStart(6)} ${f(m?.median).padStart(7)} ${f(m?.max).padStart(6)}`);
console.log(`${'different screens'.padEnd(26)} ${String(d?.n ?? 0).padStart(4)} ${f(d?.min).padStart(6)} ${f(d?.median).padStart(7)} ${f(d?.max).padStart(6)}`);
if (m) {
  console.log('\nthe mixed-sensor row is not a fingerprint failure: the tree and OCR see a screen');
  console.log('differently by design, and the graph absorbs it by aliasing. It is here so that');
  console.log('it cannot be mistaken for drift, which is what happened when the rows were one.');
}
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

/**
 * Why a pair is as far apart as it is, token by token.
 *
 * A distribution is not actionable and neither is a similarity: 0.42 says the
 * margin narrowed and nothing about what moved. The token grammar is
 * `role:region[:@slot]:w:h["label"]:x:y#count`, so a diff of two token sets
 * names the cause directly — a label that changed is a label token, a role that
 * flipped is the same geometry under two roles, a bucket that straddled is the
 * same key with `#1` against `#many`, and a shifted anchor is the same key at a
 * different `x`/`y`.
 */
function explainPair(pair) {
  const a = new Set(pair.a.tokens);
  const b = new Set(pair.b.tokens);
  const onlyA = [...a].filter((t) => !b.has(t)).sort();
  const onlyB = [...b].filter((t) => !a.has(t)).sort();
  const shared = [...a].filter((t) => b.has(t)).length;
  console.log(`
  shared ${shared}, only in r${pair.a.round} ${onlyA.length}, only in r${pair.b.round} ${onlyB.length}`);
  // The same structural key under two different tails is a drift; a key present
  // on one side only is an element that came or went. Telling those apart is
  // the whole diagnosis, so they are printed apart.
  const keyOf = (t) => t.replace(/:x-?\d+:y-?\d+#(1|many)$/, '');
  const tailOf = (t) => t.slice(keyOf(t).length);
  const keysA = new Map(onlyA.map((t) => [keyOf(t), tailOf(t)]));
  const keysB = new Map(onlyB.map((t) => [keyOf(t), tailOf(t)]));
  const drifted = [...keysA.keys()].filter((k) => keysB.has(k));
  if (drifted.length) {
    console.log('  same structure, moved or re-counted:');
    for (const k of drifted) console.log(`    ${k}   r${pair.a.round}${keysA.get(k)}   r${pair.b.round}${keysB.get(k)}`);
  }
  const goneA = onlyA.filter((t) => !keysB.has(keyOf(t)));
  const goneB = onlyB.filter((t) => !keysA.has(keyOf(t)));
  if (goneA.length) {
    console.log(`  only in r${pair.a.round}:`);
    for (const t of goneA) console.log(`    ${t}`);
  }
  if (goneB.length) {
    console.log(`  only in r${pair.b.round}:`);
    for (const t of goneB) console.log(`    ${t}`);
  }
}

if (worstSame) explainPair(worstSame);

// Chrome labels are the only text in a fingerprint, so which of them got in is
// the thing a band change actually moves.
const labels = new Set();
for (const r of readings) {
  for (const t of r.tokens) {
    if (t.includes('"')) labels.add(t.slice(t.indexOf('"') + 1, t.lastIndexOf('"')));
  }
}
console.log(`\n${labels.size} distinct chrome label(s) entered identity: ${[...labels].sort().join(' · ') || '(none)'}`);

save({
  same: s, mixed: m, different: d, gap, separated, thresholdInGap,
  labels: [...labels].sort(),
});
if (outFile) console.log(`\nwrote ${outFile}`);

// The stated margin, checked rather than eyeballed. A person noticing that a
// number moved is not a test; this is the machine that re-measures it.
const floor = threshold + CLEARANCE;
const ceiling = threshold - CLEARANCE;
const sameOk = s != null && s.min >= floor;
const differentOk = d != null && d.max <= ceiling;
console.log(`${sameOk ? 'ok  ' : 'FAIL'} every same-screen revisit scores at least ${floor.toFixed(2)} (worst ${f(s?.min)})`);
console.log(`${differentOk ? 'ok  ' : 'FAIL'} every different-screen pair scores at most ${ceiling.toFixed(2)} (worst ${f(d?.max)})`);
if (!sameOk || !differentOk) {
  console.error('\nThe threshold no longer has the clearance this bar states. Diagnose before');
  console.error('moving it: `node scripts/analyse-fingerprint.mjs <the --out file>` classifies every');
  console.error('divergent token by cause, and the causes have different fixes. A threshold moved to');
  console.error('make a run pass is a threshold that means nothing.');
}

process.exit(separated && sameOk && differentOk ? 0 : 1);
