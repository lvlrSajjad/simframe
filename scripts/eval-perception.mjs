#!/usr/bin/env node
// The perception eval harness. Deferred since Phase 5; four things wait on it.
//
// What it is, and the design decision behind it. The obvious harness replays
// stored frames through the perception path and diffs the element lists, which
// is what Phase 13 step 5 describes. That harness cannot exist: the element
// list is the accessibility tree fused with OCR, the tree is not in the frame,
// and OCR runs in the daemon against a live framebuffer. A frame on disk is
// half the input.
//
// So the split is different and, for what actually needs gating, better. The
// machine records the *input* — the fused element list for a screen, exactly as
// perception produced it. A person authors the *expected output*. Everything
// downstream of the element list is a pure function, so the check runs offline,
// deterministically, with no simulator and no daemon:
//
//   resolution   matching.resolve(targets, query)  — which element a query picks
//   identity     fingerprint.tokens(targets)       — which screen this is
//   change       analyze.signatureDiff(a, b)       — whether a frame moved
//
// Those three are precisely the thresholds every blocked item wants to change.
// What it does *not* cover is whether perception found the elements at all,
// which is inherently live and stays with eval-fingerprint.mjs and the
// integration job. Said plainly here rather than implied, because a harness
// that is trusted for more than it measures is worse than no harness.
//
// Two rules from this repo:
//   - The gate is an exit code. Nothing is verified through a pipe: this
//     project has already shipped a check that could not fail because
//     `node script.mjs | tail` reports tail's status.
//   - A fixture with no authored expectations is reported as unauthored, never
//     counted as a pass. An empty test suite is green.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fingerprint from '../src/fingerprint.js';
import * as matching from '../src/matching.js';
import * as analyze from '../src/analyze.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'test', 'perception', 'screens');
const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const has = (n) => process.argv.includes(`--${n}`);

export function fixtures(dir = DIR, only = null) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => (only ? f.includes(only) : true))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

/**
 * Check one screen's authored expectations against the pure layers.
 *
 * Returns findings rather than printing, so the same function backs the CLI and
 * the unit tests — and so a finding can be counted without being formatted.
 */
export function checkScreen(fx) {
  const findings = [];
  const screen = fx.points ?? null;
  const targets = fx.targets ?? [];
  const expect = fx.expect ?? {};
  const authored = (expect.resolutions?.length ?? 0)
    + (expect.ambiguous?.length ?? 0)
    + (expect.none?.length ?? 0)
    + (expect.identity ? 1 : 0);

  for (const r of expect.resolutions ?? []) {
    const out = matching.resolve(targets, r.query, { screen });
    if (out.status !== 'ok') {
      findings.push({
        kind: 'resolution',
        query: r.query,
        want: r.label,
        got: out.status === 'ambiguous'
          ? `ambiguous between ${out.alternatives.map((a) => a.label).join(', ')}`
          : 'nothing resolved',
      });
      continue;
    }
    const got = out.target.label ?? '(icon-only)';
    // Compared on the label because that is what the author can see and mean.
    // Coordinates would make a fixture break every time a row moved a point.
    if (got !== r.label) {
      findings.push({ kind: 'resolution', query: r.query, want: r.label, got: `"${got}" at ${out.target.x},${out.target.y}` });
    }
  }

  // The other half of the contract, and the half with the wrong-tap risk in it:
  // "when two things answer equally well it says so rather than guessing".
  for (const q of expect.ambiguous ?? []) {
    const out = matching.resolve(targets, typeof q === 'string' ? q : q.query, { screen });
    if (out.status !== 'ambiguous') {
      findings.push({
        kind: 'should-ask',
        query: typeof q === 'string' ? q : q.query,
        want: 'ambiguous',
        got: out.status === 'ok' ? `picked "${out.target.label}" at score ${out.score}` : 'nothing resolved',
      });
    }
  }

  for (const q of expect.none ?? []) {
    const out = matching.resolve(targets, q, { screen });
    if (out.status !== 'none') {
      findings.push({
        kind: 'should-find-nothing',
        query: q,
        want: 'none',
        got: out.status === 'ok' ? `picked "${out.target.label}"` : 'ambiguous',
      });
    }
  }

  // Identity drift. A token-rule change that silently alters a screen's
  // structural hash discards every stored map and graph for it, and the failure
  // is invisible — an old hash is a well-formed hash that matches nothing.
  if (expect.identity && screen) {
    const now = fingerprint.fingerprint(targets, screen);
    if (now.hash !== expect.identity.hash) {
      const similarity = fingerprint.similarity(now.tokens, expect.identity.tokens ?? []);
      findings.push({
        kind: 'identity',
        query: '(structural hash)',
        want: `${expect.identity.hash?.slice(0, 12)} (${expect.identity.tokens?.length ?? 0} tokens)`,
        got: `${now.hash?.slice(0, 12)} (${now.tokens.length} tokens), similarity ${similarity.toFixed(2)}`,
      });
    }
  }

  // Frame pairs, for the change detector. `changed: true` means an action that
  // a person would call visible — a switch flipping, a radio dot moving.
  for (const pair of fx.frame_pairs ?? []) {
    const diff = analyze.signatureDiff(analyze.hexToSignature(pair.after), analyze.hexToSignature(pair.before));
    const seen = diff > (pair.threshold ?? 0.004);
    if (seen !== Boolean(pair.changed)) {
      findings.push({
        kind: 'change',
        query: pair.note ?? '(frame pair)',
        want: pair.changed ? 'a visible change' : 'no change',
        got: `diff ${diff.toFixed(5)} against a threshold of ${pair.threshold ?? 0.004}`,
      });
    }
  }

  return { authored, findings };
}

async function record() {
  const api = await import('../src/index.js');
  const device = arg('device');
  const name = arg('name');
  if (!name) throw new Error('--record needs --name=<app>/<screen>');
  const id = await api.screenIdentity(device, { fresh: true, confirmNovel: false });
  const entry = id.entry ?? {};
  const out = {
    app: name.split('/')[0],
    screen: name.split('/').slice(1).join('/') || name,
    note: arg('note') ?? null,
    recorded_at: new Date().toISOString(),
    points: id.points,
    // The recorded input. Trimmed to what the pure layers read, so a fixture
    // is reviewable by a person rather than a wall of machine state.
    targets: (entry.targets ?? []).map((t) => ({
      label: t.label ?? null,
      value: t.value ?? null,
      type: t.type ?? null,
      x: t.x, y: t.y,
      frame: t.frame ?? null,
      region: t.region ?? null,
      source: t.source ?? null,
      aliases: t.aliases ?? undefined,
      navSlot: t.navSlot ?? undefined,
      enabled: t.enabled ?? undefined,
      selected: t.selected ?? undefined,
    })),
    expect: {
      identity: { hash: entry.structuralHash, tokens: entry.structuralTokens ?? [] },
      // Authored by hand. The machine records what perception saw; a person
      // says what it should mean. Deriving these from current behaviour would
      // bake today's bugs in as the specification.
      resolutions: [],
      ambiguous: [],
      none: [],
    },
  };
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${name.replace(/\//g, '__')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`recorded ${out.targets.length} element(s) from ${name} -> ${path.relative(ROOT, file)}`);
  console.log('  now author expect.resolutions / expect.ambiguous / expect.none by hand');
}

function check() {
  const all = fixtures(DIR, arg('only'));
  if (!all.length) {
    console.error('check-perception: no fixtures. Record some with --record --name=<app>/<screen>');
    process.exitCode = 1;
    return;
  }
  let failed = 0;
  let unauthored = 0;
  let checks = 0;
  const apps = new Set();
  for (const fx of all) {
    apps.add(fx.app);
    const { authored, findings } = checkScreen(fx);
    checks += authored;
    if (!authored) {
      unauthored += 1;
      console.log(`  ??  ${fx.app}/${fx.screen}  recorded, no expectations authored`);
      continue;
    }
    if (!findings.length) {
      console.log(`  ok  ${fx.app}/${fx.screen}  ${authored} expectation(s)`);
      continue;
    }
    failed += findings.length;
    console.log(`FAIL  ${fx.app}/${fx.screen}`);
    for (const f of findings) {
      console.log(`        ${f.kind}: ${f.query}\n          want ${f.want}\n          got  ${f.got}`);
    }
  }
  console.log(`\n${all.length} screen(s) across ${apps.size} app(s), ${checks} expectation(s), ${failed} failure(s)`
    + (unauthored ? `, ${unauthored} unauthored` : ''));
  // An unauthored fixture is not a pass. A suite that counts recordings as
  // successes is a suite that goes green by adding files.
  if (failed || unauthored) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (has('record')) await record();
  else if (has('list')) for (const f of fixtures()) console.log(`${f.app}/${f.screen}  ${f.targets?.length ?? 0} elements`);
  else check();
}
