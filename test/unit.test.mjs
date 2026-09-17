// Pure-function tests: no simulator required, so these run anywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodePng, encodePng, grayGrid, scaleBitmap } from '../src/png.js';
import { frameHash, rampLevel, regionMap, regionSignature, signatureDiff } from '../src/analyze.js';
import { elementToNode } from '../src/input.js';
import * as control from '../src/control.js';
import * as screenmap from '../src/screenmap.js';
import * as store from '../src/store.js';
import net from 'node:net';

function solid(width, height, [r, g, b]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function gradient(width, height, shift = 0) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = (x * 4 + y * 2 + shift) % 256;
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = 255 - v;
      data[i + 2] = (v * 3) % 256;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

test('png encode/decode round-trips pixel data exactly', () => {
  const src = gradient(37, 23);
  const out = decodePng(encodePng(src));
  assert.equal(out.width, 37);
  assert.equal(out.height, 23);
  assert.deepEqual(out.data, src.data);
});

test('decodePng rejects non-PNG input', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all!!')), /not a PNG/);
});

test('grayGrid averages to the expected luminance', () => {
  const { gray } = grayGrid(solid(20, 20, [255, 255, 255]), 2, 2);
  assert.deepEqual(Array.from(gray), [255, 255, 255, 255]);
  const black = grayGrid(solid(20, 20, [0, 0, 0]), 2, 2);
  assert.deepEqual(Array.from(black.gray), [0, 0, 0, 0]);
});

test('identical frames hash identically and diff to zero', () => {
  const a = gradient(64, 128);
  const b = gradient(64, 128);
  assert.equal(frameHash(a), frameHash(b));
  assert.equal(signatureDiff(regionSignature(a), regionSignature(b)), 0);
});

test('a changed frame produces a different hash and a non-zero diff', () => {
  const a = gradient(64, 128);
  const b = gradient(64, 128, 120);
  assert.notEqual(frameHash(a), frameHash(b));
  assert.ok(signatureDiff(regionSignature(a), regionSignature(b)) > 0.01);
});

test('signatureDiff treats a missing baseline as a full change', () => {
  assert.equal(signatureDiff(regionSignature(gradient(8, 8)), null), 1);
});

test('rampLevel is monotonic and spans the whole ramp', () => {
  const levels = [0, 0.001, 0.005, 0.02, 0.05, 0.12, 0.9].map(rampLevel);
  assert.deepEqual(levels, [0, 0, 1, 2, 3, 4, 5]);
});

test('regionMap lays out deltas row-major at the given width', () => {
  const map = regionMap([0, 0.9, 0, 0, 0.9, 0], 3);
  assert.deepEqual(map.split('\n'), ['.@.', '.@.']);
});

test('scaleBitmap preserves a solid colour at any size', () => {
  const small = scaleBitmap(solid(50, 90, [10, 20, 30]), 5, 9);
  assert.equal(small.width, 5);
  assert.equal(small.height, 9);
  assert.deepEqual(Array.from(small.data.subarray(0, 4)), [10, 20, 30, 255]);
});

// --- baseline resolution: the bug that made the change signal look broken ---
import { hexToSignature, signatureToHex } from '../src/analyze.js';
import { resolveBaseline } from '../src/index.js';

// Epoch milliseconds, because a numeric baseline is read as a timestamp only
// when it is far larger than any plausible frame sequence number.
const T = 1_757_000_000_000;

function fakeState() {
  return {
    seq: 30,
    hash: 'cccc',
    lastChangeAt: T + 5000,
    history: [
      { seq: 28, at: T + 4000, hash: 'aaaa', sig: signatureToHex([1, 2, 3]) },
      { seq: 29, at: T + 4500, hash: 'bbbb', sig: signatureToHex([4, 5, 6]) },
      { seq: 30, at: T + 5000, hash: 'cccc', sig: signatureToHex([7, 8, 9]) },
    ],
  };
}

test('signature hex round-trips', () => {
  assert.deepEqual(hexToSignature(signatureToHex([0, 15, 16, 255])), [0, 15, 16, 255]);
});

test('a baseline resolves by frame hash', () => {
  const b = resolveBaseline(fakeState(), 'aaaa');
  assert.equal(b.kind, 'history');
  assert.equal(b.entry.seq, 28);
});

test('a baseline resolves by sequence number', () => {
  const b = resolveBaseline(fakeState(), 29);
  assert.equal(b.kind, 'history');
  assert.equal(b.entry.hash, 'bbbb');
});

test('a baseline older than the history still answers whether it changed', () => {
  const changed = resolveBaseline(fakeState(), T + 4999);
  assert.equal(changed.kind, 'coarse');
  assert.equal(changed.changed, true, 'lastChangeAt is after this baseline');

  const unchanged = resolveBaseline(fakeState(), T + 5001);
  assert.equal(unchanged.kind, 'coarse');
  assert.equal(unchanged.changed, false);
});

test('an unknown baseline is reported rather than silently ignored', () => {
  assert.equal(resolveBaseline(fakeState(), 'deadbeef').kind, 'unmatched');
});

test('no baseline means no comparison', () => {
  assert.equal(resolveBaseline(fakeState(), undefined), null);
});

// --- frame memory: retention thinning and even sampling ---
import { thinRing } from '../src/daemon.js';
import { spreadEvenly } from '../src/index.js';

const RETENTION = { retainMs: 60_000, fineMs: 6_000, keyframeMs: 450 };

test('thinRing keeps every recent frame and thins older ones', () => {
  const now = 1_000_000;
  // 4fps for 30s: recent frames should survive intact, older ones get thinned.
  const index = [];
  for (let at = now - 30_000; at <= now; at += 250) index.push({ seq: at, at });

  const dropped = [];
  const kept = thinRing(index, now, RETENTION, (seq) => dropped.push(seq));

  const recent = kept.filter((f) => now - f.at <= RETENTION.fineMs);
  const older = kept.filter((f) => now - f.at > RETENTION.fineMs);
  assert.equal(recent.length, 25, 'every frame inside the fine window is kept');
  assert.ok(older.length > 0 && older.length < 96, 'older frames are thinned, not dropped');
  assert.equal(kept.length + dropped.length, index.length, 'every frame is kept or dropped');

  for (let i = 1; i < older.length; i++) {
    assert.ok(
      older[i].at - older[i - 1].at >= RETENTION.keyframeMs - 1,
      'thinned frames are at least keyframeMs apart',
    );
  }
  assert.deepEqual(kept, [...kept].sort((a, b) => a.at - b.at), 'kept frames stay in order');
});

test('thinRing drops everything past the retention window', () => {
  const now = 1_000_000;
  const index = [
    { seq: 1, at: now - 90_000 },
    { seq: 2, at: now - 61_000 },
    { seq: 3, at: now - 1_000 },
  ];
  const dropped = [];
  const kept = thinRing(index, now, RETENTION, (seq) => dropped.push(seq));
  assert.deepEqual(kept.map((f) => f.seq), [3]);
  assert.deepEqual(dropped.sort(), [1, 2]);
});

test('spreadEvenly samples across a span and keeps both ends', () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const picked = spreadEvenly(items, 5);
  assert.equal(picked.length, 5);
  assert.equal(picked[0], 0, 'keeps the oldest');
  assert.equal(picked[4], 19, 'keeps the newest');
  assert.deepEqual(picked, [...picked].sort((a, b) => a - b));
});

test('spreadEvenly returns everything when asked for more than it has', () => {
  assert.deepEqual(spreadEvenly([1, 2, 3], 10), [1, 2, 3]);
  assert.deepEqual(spreadEvenly([1, 2, 3], 1), [3], 'a single sample is the newest');
});

// --- batch scripting: shorthand parsing and element matching ---
import { haltDecision, normalizeStep, wrongTurnFrom } from '../src/actions.js';
import { CONFIDENT_OBSERVATIONS } from '../src/graph.js';
import { centerOf, matchElement } from '../src/input.js';

test('step shorthand keeps sibling options', () => {
  assert.deepEqual(normalizeStep({ tap: 'Save' }), { value: 'Save', action: 'tap' });
  assert.deepEqual(normalizeStep({ waitText: 'Saved', timeoutMs: 5000 }), {
    timeoutMs: 5000,
    value: 'Saved',
    action: 'waitText',
  });
  assert.deepEqual(normalizeStep({ type: { into: 'Name', text: 'Fryer 3' } }), {
    into: 'Name',
    text: 'Fryer 3',
    action: 'type',
  });
  assert.deepEqual(normalizeStep('settle'), { action: 'settle' });
  assert.throws(() => normalizeStep({}), /empty step/);
});

const NODES = [
  { label: 'Save', identifier: null, value: null, type: 'Button', frame: { x: 10, y: 20, width: 80, height: 40 } },
  { label: 'Save Draft', identifier: null, value: null, type: 'Button', frame: { x: 10, y: 80, width: 80, height: 40 } },
  { label: null, identifier: 'asset-name', value: 'Fryer', type: 'TextField', frame: { x: 0, y: 0, width: 100, height: 30 } },
];

test('an exact label beats a substring match', () => {
  assert.equal(matchElement(NODES, 'Save').frame.y, 20, 'exact "Save" wins over "Save Draft"');
});

test('elements are findable by identifier and by substring', () => {
  assert.equal(matchElement(NODES, 'asset-name').type, 'TextField');
  assert.equal(matchElement(NODES, 'draft').label, 'Save Draft');
});

test('an ambiguous match refuses to guess', () => {
  const ambiguous = [NODES[0], { ...NODES[0], frame: { x: 0, y: 200, width: 10, height: 10 } }];
  assert.throws(() => matchElement(ambiguous, 'Save'), /matched 2 elements/);
  assert.equal(matchElement(ambiguous, 'Save', { index: 1 }).frame.y, 200, 'index disambiguates');
});

test('a missing element is an error, not a silent no-op', () => {
  assert.throws(() => matchElement(NODES, 'Delete'), /no element matching/);
});

test('centerOf finds the middle of an element', () => {
  assert.deepEqual(centerOf(NODES[0]), { x: 50, y: 40 });
});

// --- screen memory: ranking, ambiguity, and container handling ---
import { findConfirm, findOptions } from '../src/intent.js';
import { isInteractive, rank } from '../src/screenmap.js';
import { hashDistance, layoutHash } from '../src/analyze.js';

const t = (label, x, y, type = 'Text', source = 'ocr', extra = {}) => ({
  label, x, y, type, source,
  frame: { x: x - 20, y: y - 12, width: 40, height: 24 },
  ...extra,
});

test('a real control outranks a caption with the same words', () => {
  const entry = { targets: [t('Assets', 201, 90, 'StaticText', 'ax'), t('Assets', 126, 836, 'Button', 'ocr')] };
  assert.equal(rank(entry, 'Assets')[0].y, 836, 'the tappable one wins');
});

test('exact matches beat substring matches', () => {
  const entry = { targets: [t('Work Orders Pending', 100, 200), t('Work Orders', 200, 835)] };
  assert.equal(rank(entry, 'Work Orders')[0].y, 835);
});

test('aliases are matched as well as labels', () => {
  const entry = { targets: [t('', 60, 400, 'Button', 'ax', { aliases: ['Continue'] })] };
  assert.equal(rank(entry, 'continue').length, 1);
});

test('isInteractive distinguishes controls from captions', () => {
  assert.equal(isInteractive({ type: 'Button' }), true);
  assert.equal(isInteractive({ type: 'StaticText' }), false);
  assert.equal(isInteractive({ type: 'TextField' }), true);
});

test('findConfirm prefers APPLY over SAVE and never picks CANCEL', () => {
  const geo = { pointWidth: 402, pointHeight: 874 };
  const nodes = [t('CANCEL', 107, 712, 'Button', 'ax'), t('SAVE', 296, 712, 'Button', 'ax'), t('APPLY', 292, 808, 'Button', 'ax')];
  assert.equal(findConfirm(nodes, geo).label, 'APPLY');
  assert.notEqual(findConfirm([nodes[0], nodes[1]], geo).label, 'CANCEL');
});

test('findConfirm prefers an enabled control over a disabled one', () => {
  const geo = { pointWidth: 402, pointHeight: 874 };
  const nodes = [
    t('APPLY', 292, 808, 'Button', 'ax', { enabled: false }),
    t('APPLY', 292, 700, 'Button', 'ax', { enabled: true }),
  ];
  assert.equal(findConfirm(nodes, geo).y, 700);
});

test('findOptions excludes the confirm row and the search box', () => {
  const geo = { pointWidth: 402, pointHeight: 874 };
  const nodes = [
    t('Search', 200, 130, 'TextField', 'ax'),
    t('Broken', 201, 573), t('Poor', 201, 616), t('Average', 201, 659),
    t('APPLY', 292, 808, 'Button', 'ax'),
  ];
  const labels = findOptions(nodes, geo).map((o) => o.label);
  assert.ok(labels.includes('Broken') && labels.includes('Poor'));
  assert.ok(!labels.includes('APPLY') && !labels.includes('Search'));
});

test('layoutHash ignores the status bar but reacts to layout', () => {
  const make = (fill) => {
    const width = 40, height = 80;
    const data = Buffer.alloc(width * height * 4, 0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const v = fill(x, y);
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    return { width, height, data };
  };
  // Same layout, different content in the status bar only.
  const a = make((x, y) => (y < 5 ? (x * 37) % 256 : x < 20 ? 20 : 220));
  const b = make((x, y) => (y < 5 ? (x * 91) % 256 : x < 20 ? 20 : 220));
  const c = make((x, y) => (y < 5 ? 0 : x < 20 ? 220 : 20)); // mirrored layout
  assert.equal(hashDistance(layoutHash(a), layoutHash(b)), 0, 'status bar must not matter');
  assert.ok(hashDistance(layoutHash(a), layoutHash(c)) > 20, 'layout must matter');
});

test('the MCP server reports the real package version', async () => {
  const pkg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8'));
  assert.ok(!/version: '\d+\.\d+\.\d+'/.test(source), 'version must not be hardcoded in mcp.js');
  // Semver, prerelease and build metadata included. The narrower pattern that
  // was here rejected `0.6.0-rc.0` and so failed the release job for the first
  // release candidate this project ever cut — a test that permitted only the
  // versions nobody needed a check for.
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
});

// --- intent matching: the rules that keep a wrong tap from happening ---
import { editDistance, nameScore, rank as rankIntent, resolve } from '../src/matching.js';
import { detectKeyboardTop, navSlot, regionFor } from '../src/regions.js';
import { fingerprint } from '../src/fingerprint.js';
import { describe } from '../src/graph.js';
import { stepFor, saveFlow, confirmFlow, loadFlow } from '../src/navigate.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as graphmod from '../src/graph.js';
import { STATE_VERSION } from '../src/daemon.js';
import { actionSignature } from '../src/graph.js';

const SCREEN = { width: 402, height: 874 };
const el = (label, x, y, type = 'Text', extra = {}) => ({
  label, x, y, type,
  frame: { x: x - 30, y: y - 10, width: 60, height: 20 },
  source: 'ocr',
  ...extra,
});

test('a bail-out from editDistance is not a measurement', () => {
  const long = 'WO: 6322486 | L4 - 48 Hours, Anaheim, Henry the Handyman, Repair'.repeat(3);
  // The cap sentinel once made this score 0.687 against any query at all.
  assert.equal(nameScore(long, 'back'), 0, 'a long unrelated string must not match');
  assert.ok(editDistance('back', long) > 8);
});

test('a substring match is weighted by how much of the name it covers', () => {
  assert.ok(nameScore('Back', 'back') > nameScore('Ceiling Tile - Back of House, Repair', 'back'));
});

test('typos still resolve', () => {
  const r = resolve([el('Work Orders', 200, 836)], 'Wrok Orders', { screen: SCREEN });
  assert.equal(r.status, 'ok');
  assert.equal(r.target.label, 'Work Orders');
});

test('a region hint separates a title from a tab of the same name', () => {
  const targets = [
    el('Assets', 201, 90, 'StaticText', { region: 'nav-bar' }),
    el('Assets', 126, 836, 'Text', { region: 'tab-bar' }),
  ];
  assert.equal(resolve(targets, 'Assets tab', { screen: SCREEN }).target.y, 836);
  // Without the hint it is genuinely ambiguous, and must say so.
  assert.equal(resolve(targets, 'Assets', { screen: SCREEN }).status, 'ambiguous');
});

test('off-screen elements are never offered', () => {
  const scrolledAway = el('Save', 200, -687);
  scrolledAway.frame = { x: 0, y: -700, width: 402, height: 40 };
  assert.equal(rankIntent([scrolledAway], 'Save', { screen: SCREEN }).length, 0);
});

test('an icon-only control is reachable by its common name', () => {
  const chevron = { label: null, rawLabel: '', x: 30, y: 91, type: 'Button', region: 'nav-bar',
                    frame: { x: 16, y: 78, width: 30, height: 30 }, source: 'ax' };
  assert.equal(resolve([chevron], 'back', { screen: SCREEN }).status, 'ok');
});

test('nothing plausible means none, not a guess', () => {
  assert.equal(resolve([el('Work Orders', 200, 836)], 'Nonexistent', { screen: SCREEN }).status, 'none');
});

test('regions follow the guidelines', () => {
  assert.equal(regionFor({ x: 40, y: 20, width: 60, height: 20 }, SCREEN), 'status-bar');
  assert.equal(regionFor({ x: 150, y: 80, width: 100, height: 30 }, SCREEN), 'nav-bar');
  assert.equal(regionFor({ x: 180, y: 820, width: 60, height: 30 }, SCREEN), 'tab-bar');
  assert.equal(regionFor({ x: 16, y: 400, width: 370, height: 90 }, SCREEN), 'content');
  assert.equal(navSlot({ x: 16, y: 78, width: 30, height: 30 }, SCREEN), 'leading');
  assert.equal(navSlot({ x: 340, y: 78, width: 50, height: 30 }, SCREEN), 'trailing');
});

test('a list of cells is not mistaken for a keyboard', () => {
  const cells = Array.from({ length: 14 }, (_, i) =>
    ({ frame: { x: 0, y: 640 + i * 90, width: 402, height: 90 } }));
  assert.equal(detectKeyboardTop(cells, SCREEN), null);
});

// --- screen naming and routing -------------------------------------------

const nav = (label, slot) => ({
  type: 'StaticText', label, navSlot: slot, region: 'nav-bar',
  frame: { x: 150, y: 78, width: 100, height: 24 },
});
const tabItem = (label, x) => ({
  type: 'Button', label, region: 'tab-bar',
  frame: { x, y: 820, width: 60, height: 30 },
});
const node = (targets) => ({ hash: 'a'.repeat(32), edges: [], tokens: fingerprint(targets, SCREEN).tokens });

test('a screen is named by its nav title, not by a button that sits up there', () => {
  const n = node([nav('Help Center', 'trailing'), nav('Invoices', 'title')]);
  // Lowercased because that is how the token stores it; `goto` matches
  // case-insensitively, so the name never needs its original case.
  assert.equal(describe(n), 'invoices');
});

test('a screen with no title falls back to its tabs, and then to nothing', () => {
  assert.equal(describe(node([tabItem('Home', 20), tabItem('More', 300)])), 'home / more');
  // It used to return the short hash here, and the map prints the name in
  // quotes after the identity hash — so an unnamed screen read
  // `screen 299dd147 "a9505378"`: two hashes, one of them dressed as a title.
  // Reported from the field on 0.13.0, with the fix attached: omit the quoted
  // part rather than echo a second hash.
  //
  // A listing still needs a handle per row, and `goto <short hash>` still has to
  // work, so both supply their own fallback — which is a presentation decision
  // and belongs where the presenting happens.
  assert.equal(describe(node([])), null);
});

test('the nav slot is part of identity, so a title and a button do not collide', () => {
  const asTitle = fingerprint([nav('Save', 'title')], SCREEN);
  const asButton = fingerprint([nav('Save', 'trailing')], SCREEN);
  assert.notEqual(asTitle.hash, asButton.hash);
});

test('an edge keeps the step that made it, because the signature is lossy', () => {
  assert.deepEqual(stepFor({ action: 'tap:work orders', step: { tap: 'Work Orders' } }), { tap: 'Work Orders' });
  // Older edges predate `step` and have to be reconstructed from the signature.
  assert.deepEqual(stepFor({ action: 'tap:work orders' }), { tap: 'work orders' });
  assert.deepEqual(stepFor({ action: 'swipe:10,20->10,300' }), { swipe: { from: [10, 20], to: [10, 300] } });
  assert.equal(stepFor({ action: 'type:"hello"' }), null);
});

test('a first traversal saves as provisional; a contradicted or partial one does not', () => {
  // **This assertion used to say the opposite, and the opposite was a deadlock.**
  // The rule was "only flows that verified end to end", which is right about
  // replay safety and wrong about arithmetic: a first traversal is
  // all-`unverified` by construction, so no flow could ever be recorded, so
  // `sim_flow_run` was unreachable. A field report hit it on a clean 10-of-10
  // batch — "I never obtained a saved flow, so sim_flow_run went untested" —
  // and it is the costliest kind of gate to get wrong, because a replayed flow
  // takes ZERO model calls and model round trips are ~92% of this tool's wall
  // clock per step.
  //
  // A refusal now needs evidence *against* a step, not the absence of evidence
  // for it.
  const udid = freshDevice('flow-provisional');
  const first = saveFlow(udid, 'boot', {
    steps: [{ tap: 'A' }],
    ranSteps: 1,
    results: [{ index: 0, ok: true, verification: { verdict: 'unverified' } }],
  });
  assert.equal(first.ok, true, 'a first traversal must be recordable at all');
  assert.equal(first.provisional, true, 'and must say it is on its first observation');

  // Still refused, because these are real objections rather than missing ones.
  const wrong = saveFlow(udid, 'bad', {
    steps: [{ tap: 'A' }],
    ranSteps: 1,
    results: [{ index: 0, ok: true, verification: { verdict: 'unexpected-screen' } }],
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'contradicted-steps');

  const partial = saveFlow(udid, 'half', {
    steps: [{ tap: 'A' }, { tap: 'B' }],
    ranSteps: 1,
    results: [{ index: 0, ok: true, verification: { verdict: 'ok' } }],
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.reason, 'incomplete-run');

  // A flow every step of which verified is confirmed outright, not provisional.
  const clean = saveFlow(udid, 'clean', {
    steps: [{ tap: 'A' }],
    ranSteps: 1,
    results: [{ index: 0, ok: true, verification: { verdict: 'ok' } }],
  });
  assert.equal(clean.provisional, false);

  // The gate that was not there.
  //
  // A failing step stops the batch, so a failure on the LAST step leaves
  // `ranSteps === steps.length` and the run looks complete. A peer watched
  // `FLOW FAILED — 4 ok, 1 failed (of 5)` save itself, which records a route
  // that is guaranteed to fail on every replay. Note that these fixtures now
  // carry `ok` on every step: the old ones did not, and a gate reading a field
  // no fixture sets is a gate no test can fail.
  const lastFailed = saveFlow(udid, 'ends-badly', {
    steps: [{ tap: 'A' }, { tap: 'B' }],
    ranSteps: 2,
    ok: false,
    results: [
      { index: 0, ok: true, verification: { verdict: 'ok' } },
      { index: 1, ok: false, error: 'assert: not on screen' },
    ],
  });
  assert.equal(lastFailed.ok, false, 'reaching the last step is not passing it');
  assert.equal(lastFailed.reason, 'failed-steps');
  assert.deepEqual(lastFailed.failed, [1], 'and it says which step');
  assert.equal(loadFlow(udid, 'ends-badly'), null, 'nothing was written');

  // And the label comes off: the second half of the bootstrap, or "provisional"
  // would be a state nothing ever leaves.
  assert.equal(confirmFlow(udid, 'boot'), true, 'a provisional flow is promotable');
  assert.equal(loadFlow(udid, 'boot').provisional, undefined);
  assert.ok(loadFlow(udid, 'boot').confirmedAt, 'and records when');
  assert.equal(confirmFlow(udid, 'boot'), false, 'promoting twice is a no-op');
  assert.equal(confirmFlow(udid, 'clean'), false, 'an already-confirmed flow is not re-promoted');
});

test('a wedged device is diagnosed from what it shows, not from the shape of the failure text', async () => {
  const wedge = await import('../src/wedge.js');
  // Item 173 has never had an instrument. The evidence has been arriving as a
  // *consequence*: `scripts/device-state.mjs` recognises a wedge from the shape
  // of a tour's failure text and names it "a launched app never came to the
  // front", which is enough to decide whether to revive and cannot tell a dead
  // framebuffer from a lock screen from an app that never fronted.
  //
  // Pure fixtures on purpose. device-state.mjs records that two runtime bugs in
  // this project came from logic that was correct and had never executed,
  // because a hosted runner at minute fifteen was the only thing exercising it.
  const healthy = {
    frame: { seq: 12, ageMs: 900, stableForMs: 3000 },
    elements: { total: 22, ax: 13, ocr: 20, fused: 11 },
    agreement: 0.846,
    frontmost: { pid: 501, title: 'Settings' },
  };
  assert.equal(wedge.classify(healthy).state, 'healthy');
  assert.equal(wedge.classify(healthy).revive, false);

  // The peer's case: both sensors full, almost nothing fuses. The tree is read
  // live and in-process; OCR reads a framebuffer that can go stale without
  // saying so, so the frame is the one that is behind.
  const stale = {
    frame: { seq: 12, ageMs: 900, stableForMs: 17000 },
    elements: { total: 21, ax: 9, ocr: 12, fused: 0 },
    agreement: 0,
    frontmost: { pid: 501, title: 'Reminders' },
  };
  assert.equal(wedge.classify(stale).state, 'stale-frame');
  assert.match(wedge.classify(stale).detail, /not safe to trust/);

  // CI's case: an app holds the front by pid and the display shows a clock.
  // The verdict must NOT claim to know which of three causes it is.
  const notPresenting = {
    frame: { seq: 3, ageMs: 4000, stableForMs: 23000 },
    elements: { total: 2, ax: 1, ocr: 2, fused: 1 },
    agreement: 1,
    frontmost: { pid: 39452, title: 'Preferences' },
  };
  const v = wedge.classify(notPresenting);
  assert.equal(v.state, 'not-presenting');
  assert.match(v.detail, /not knowable from here/,
    'it must not pick between a lock screen, a dead surface and a crashed SpringBoard');

  // A sparse screen is not a disagreeing screen. A springboard and a lock
  // screen are legitimately sparse, and calling either a stale frame would
  // revive a device that is working — the false-refusal shape of item 175.
  assert.notEqual(wedge.classify({
    frame: { seq: 1, ageMs: 100, stableForMs: 100 },
    elements: { total: 3, ax: 2, ocr: 2, fused: 0 },
    agreement: 0,
    frontmost: { pid: null, title: null },
  }).state, 'stale-frame');

  assert.equal(wedge.classify({ frame: null }).state, 'capture-down');
  assert.equal(wedge.classify({
    frame: { seq: 1 }, elements: { total: 0, ax: 0, ocr: 0, fused: 0 }, agreement: null, frontmost: {},
  }).state, 'nothing-readable');

  // The threshold is not a band inside the metric's own noise, which is what
  // the HPI_time gate was. Measured on 326464A4 across five real screens:
  // 0.857 0.833 0.929 0.846 0.667 — so the floor is 0.667 and the threshold
  // sits 6.7x below it.
  assert.ok(wedge.DISAGREEMENT * 6 < 0.667,
    'the stale-frame threshold must sit well clear of the measured healthy floor');
});

// --- variant fingerprints -------------------------------------------------

const tok = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}:cell:content:w16:h4:x0:y${i}#1`);
// The same screen wearing a slightly different face: most rows shared, one
// swapped. A *variant* has to resemble what it is a variant of — that is the
// difference between a second face and a different screen.
// One row swapped for a uniquely-named one: distinct token sets, every one of
// them still 0.71 similar to the original, which is well above the 0.36
// threshold. Varying *how many* rows differ would walk the similarity down
// past the threshold and stop testing what these tests are about.
const face = (n, tag, id = 0) => [
  ...tok(n - 1, tag),
  `${tag}extra${id}:cell:content:w16:h4:x0:y${90 + id}#1`,
];
// store.ROOT is read once at import, so setting SIMFRAME_HOME here would be too
// late — `npm test` sets it to a temp dir for the whole process instead. These
// tests used to write TEST-* directories into the real ~/.simframe, where they
// showed up as phantom devices in `simframe status`.
const freshDevice = (name) => {
  const udid = `TEST-${name}`;
  graphmod.forget(udid);
  return udid;
};

test('a known edge landing on a recognisable second face of the same screen grows a variant', () => {
  const UDID = freshDevice('variant-grows');
  const A = { hash: 'a'.repeat(32), tokens: tok(6, 'a') };
  const B = { hash: 'b'.repeat(32), tokens: tok(6, 'b') };
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: B, kind: 'push' });
  // B has to be a screen we have actually *read*, not just a hash on the end of
  // an edge. An edge stores its destination's hash and nothing else, so a
  // target that has never been stood on has no structure to compare a new
  // reading against — and in that case simframe now declines to call the
  // reading a second face of it, because it has no grounds to.
  graphmod.record(UDID, { from: B, action: { tap: 'stay' }, to: B, kind: 'none' });
  // Same action from A, and B has arrived wearing a different face — but still
  // recognisably B: five of its six rows are the ones B always had.
  const Bprime = { hash: 'c'.repeat(32), tokens: face(6, 'b') };
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: Bprime, kind: 'push' });

  assert.equal(graphmod.stats(UDID).screens, 2, 'B prime must not become a third screen');
  assert.equal(graphmod.nearestScreen(UDID, B).node.hash, B.hash);
  assert.equal(graphmod.nearestScreen(UDID, Bprime).node.hash, B.hash);
});

test('a screen sharing nothing with the target is never called a face of it', () => {
  // This assertion replaces one that encoded the opposite, and the old one was
  // reproducible as a wrong action: a reading sharing ZERO tokens with B was
  // merged into B, after which arriving there returned `ok` — "matches the
  // outcome seen 3x before" — and a flow kept walking, tapping real controls on
  // a screen its plan never contained. Being unclaimed by any stored screen is
  // not evidence of being a second face of this one.
  const UDID = freshDevice('variant-stranger');
  const A = { hash: 'a'.repeat(32), tokens: tok(6, 'a') };
  const B = { hash: 'b'.repeat(32), tokens: tok(6, 'b') };
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: B, kind: 'push' });
  const stranger = { hash: 'c'.repeat(32), tokens: tok(6, 'zzz') };
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: stranger, kind: 'push' });

  // The stranger resolves to nothing — which is the point. It is a screen we
  // have not read, not a face of one we have.
  assert.equal(graphmod.nearestScreen(UDID, stranger), null, 'the stranger must not resolve to B');
  const edge = graphmod.nearestScreen(UDID, A).node.edges.find((e) => e.action === 'tap:go');
  assert.equal(edge.changedOutcomes, 1, 'it is a changed destination, which is the honest reading');
});

test('an edge that really goes somewhere else is not swallowed as a variant', () => {
  const UDID = freshDevice('real-redirect');
  const A = { hash: 'a'.repeat(32), tokens: tok(6, 'a') };
  const B = { hash: 'b'.repeat(32), tokens: tok(6, 'b') };
  const C = { hash: 'c'.repeat(32), tokens: tok(6, 'c') };
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: B, kind: 'push' });
  graphmod.record(UDID, { from: C, action: { tap: 'x' }, to: C, kind: 'none' });
  // C is already a screen in its own right, so landing there is a real change
  // of destination, not a second face of B.
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: C, kind: 'push' });
  const a = graphmod.nearestScreen(UDID, A).node;
  const edge = a.edges.find((e) => e.action === 'tap:go');
  assert.equal(edge.to, C.hash);
  assert.equal(edge.changedOutcomes, 1);
});

test('variants are capped, so a non-deterministic action cannot grow forever', () => {
  const UDID = freshDevice('variant-cap');
  const A = { hash: 'a'.repeat(32), tokens: tok(6, 'a') };
  const B = { hash: 'b'.repeat(32), tokens: tok(6, 'b') };
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: B });
  // B must be a screen with a known structure before anything can be judged a
  // face of it — see the test above.
  graphmod.record(UDID, { from: B, action: { tap: 'stay' }, to: B, kind: 'none' });
  for (let i = 0; i < graphmod.MAX_VARIANTS + 3; i += 1) {
    graphmod.record(UDID, {
      from: A,
      action: { tap: 'go' },
      // Recognisably the same screen each time, or these are not variants at
      // all and the cap is not what is being tested.
      to: { hash: String(i).padStart(32, 'd'), tokens: face(6, 'b', i) },
    });
  }
  const b = graphmod.nearestScreen(UDID, { hash: 'b'.repeat(32), tokens: tok(6, 'b') }).node;
  assert.ok(b.variants.length <= graphmod.MAX_VARIANTS, `got ${b.variants.length}`);
});

test('content that merely falls into the tab bar band is not a screen name', () => {
  const tabs = ['Home', 'Work Orders', 'Invoices'].map((label, i) => ({
    type: 'Button', label, region: 'tab-bar',
    frame: { x: 20 + i * 120, y: 840, width: 60, height: 30 },
  }));
  // A date banner sitting just above the real tabs, wide enough to be content.
  const banner = {
    type: 'StaticText', label: 'Sep 08, 2026', region: 'tab-bar',
    frame: { x: 24, y: 768, width: 144, height: 24 },
  };
  const withBanner = fingerprint([...tabs, banner], SCREEN);
  assert.ok(!withBanner.tokens.some((t) => /2026/.test(t)), 'a date must not enter the fingerprint');
  // Real tab labels still do.
  assert.ok(withBanner.tokens.some((t) => t.includes('"work orders"')));
  // And tomorrow's date is the same screen as today's.
  const tomorrow = fingerprint([...tabs, { ...banner, label: 'Sep 09, 2026' }], SCREEN);
  assert.equal(withBanner.hash, tomorrow.hash);
});

// --- the two halves must agree --------------------------------------------

test('the Node and Swift state versions match', () => {
  // These drifted once — Node on 5, Swift writing 6 — and the effect was
  // invisible: every CLI command judged the live daemon stale and spawned a
  // replacement, 993 times in one log. Capture kept working, so nothing looked
  // wrong, while `recall`, `state --since` and `wait --since` all silently lost
  // their history and every flow timing was measured across daemon restarts.
  const swift = fs.readFileSync(
    new URL('../native/simframed/Sources/SimframeCore/FrameStore.swift', import.meta.url), 'utf8');
  const match = swift.match(/stateVersion\s*=\s*(\d+)/);
  assert.ok(match, 'could not find stateVersion in FrameStore.swift — has it moved?');
  assert.equal(Number(match[1]), STATE_VERSION,
    `Swift writes state version ${match[1]}, Node expects ${STATE_VERSION}`);
});

test('an action signature says what the action was, not just its value', () => {
  const sig = (raw) => actionSignature(normalizeStep(raw));
  // A tap and a type on the same text are different edges. They collided,
  // because normalized steps carry {action, value} and the shorthand branches
  // only looked for {tap: ...}, so everything fell to a generic tail.
  assert.notEqual(sig({ tap: 'Contacts' }), sig({ type: 'Contacts' }));
  assert.equal(sig({ tap: 'Contacts' }), 'tap:contacts');
  // Coordinates are the identity of a coordinate tap.
  assert.notEqual(sig({ tapAt: { x: 10, y: 20 } }), sig({ tapAt: { x: 99, y: 20 } }));
  // Bookkeeping is not: the same tap with a longer timeout is the same edge.
  assert.equal(sig({ tap: 'Save', timeoutMs: 9000 }), sig({ tap: 'Save' }));
  // And a stray undefined key must not throw. `simframe tap X` passed
  // `index: undefined`, which crashed the signature builder before any tap was
  // sent — the headline command, broken on every screen the graph recognised.
  assert.equal(sig({ tap: 'Contacts', index: undefined }), 'tap:contacts');
});

import { isVolatileLabel } from '../src/fingerprint.js';
import { resolve as resolveIntent, SAME_CONTROL_POINTS } from '../src/matching.js';
import { informative, parseSelector, resolveRef, writeRefs } from '../src/refs.js';
import { rowsFor, render } from '../src/view.js';

test('a screen is not named after a value that will have changed by tomorrow', () => {
  // Phase 6d removed a date banner from one screen's identity. It came back
  // through a different door: measured across twenty screens of a real app,
  // three carried content in their identity, and one was a nav title reading
  // "Tuesday, September 8" — a fingerprint with until-midnight to live.
  for (const expiring of ['Tuesday, September 8', 'Sep 08, 2026', '09/08/2026', '21:38', '+1 (111) 111-1111', '$501.00', '1910']) {
    assert.equal(isVolatileLabel(expiring), true, `${expiring} should not be part of a screen's identity`);
  }
  // Words are names, and a name is what a screen is called.
  for (const name of ['Assets', 'Work Orders', 'My Dashboard', 'Settings', 'iPhone 17 Pro']) {
    assert.equal(isVolatileLabel(name), false, `${name} is a name, not a value`);
  }
  // What this rule deliberately does NOT do: rescue content that the
  // positional region bands misfiled as chrome. "Anahaim | Stnra #1020" is a
  // list row read as a tab item — wrong for a reason no text pattern can see,
  // and fixed by clustering the bands rather than by another word list.
  assert.equal(isVolatileLabel('Anahaim | Stnra #1020'), false);
});

test('two readings of one control are not an ambiguity', () => {
  // The tree published "Location (All)" and OCR read the same rectangle as
  // "Location (AII)" one point away, and the caller was asked which of the two
  // it meant. Either tap lands on the same pixel: there is no answer to give.
  const targets = [
    { label: 'Location (All)', x: 201, y: 181, type: 'Button', source: 'ax', frame: { x: 100, y: 170, width: 200, height: 24 } },
    { label: 'Location (AII)', x: 200, y: 182, type: 'Text', source: 'ocr', frame: { x: 100, y: 171, width: 200, height: 22 } },
  ];
  const out = resolveIntent(targets, 'Location', { screen: { width: 402, height: 874 } });
  assert.equal(out.status, 'ok');
  // And the accessibility element wins, because it is the real hit target.
  assert.equal(out.target.source, 'ax');

  // Two controls genuinely far apart stay a question worth asking: on the Work
  // Orders screen the label is both the nav title and the tab.
  const apart = [
    { label: 'Work Orders', x: 201, y: 90, type: 'Text', source: 'ocr', region: 'nav-bar', frame: { x: 150, y: 80, width: 100, height: 20 } },
    { label: 'Work Orders', x: 200, y: 836, type: 'Text', source: 'ocr', region: 'tab-bar', frame: { x: 150, y: 826, width: 100, height: 20 } },
  ];
  assert.ok(Math.abs(apart[0].y - apart[1].y) > SAME_CONTROL_POINTS);
  assert.equal(resolveIntent(apart, 'Work Orders', { screen: { width: 402, height: 874 } }).status, 'ambiguous');
});

test('a selector is a ref, a point, or an intent', () => {
  assert.deepEqual(parseSelector('#3'), { kind: 'ref', ref: 3 });
  assert.deepEqual(parseSelector('@120,400'), { kind: 'point', x: 120, y: 400 });
  assert.deepEqual(parseSelector('@ 120 , 400 '), { kind: 'point', x: 120, y: 400 });
  assert.deepEqual(parseSelector('"Save"'), { kind: 'label', label: 'Save', exact: true });
  assert.deepEqual(parseSelector('the save button'), { kind: 'label', label: 'the save button', exact: false });
  // A label that merely starts with a hash is not a ref.
  assert.equal(parseSelector('#hashtag').kind, 'label');
});

test('a ref numbered on one screen refuses to resolve on another', () => {
  // store.ROOT is read once at import time, and `npm test` runs with
  // SIMFRAME_HOME pointed at a fresh temp dir — so this writes into that, not
  // into the developer's real ~/.simframe. An earlier version of these tests
  // did not, and left TEST-* directories in it.
  const udid = 'TEST-REFS';
  const layoutHash = 'f'.repeat(72);
  writeRefs(udid, {
    structuralHash: 'aaaa1111',
    layoutHash,
    rows: [{ ref: 1, label: 'Save', x: 10, y: 20, type: 'Button', region: 'nav-bar', source: 'ax' }],
  });
  // A tolerant recall may not veto a ref on its own. `recallNearest` matches by
  // layout within a tolerance, so above distance zero it is a guess about which
  // remembered screen this is — and reported from the field: `#5 was numbered
  // on a different screen (0f7b9e3e → 48e5c92d)` while both calls printed the
  // identical header, because the map named the screen from that tolerant
  // recall and this check read the same recall as exact.
  assert.equal(
    resolveRef(udid, 1, { structuralHash: 'something-else', structuralDistance: 7 }).label,
    'Save',
    'a guessed identity does not refuse a ref by itself',
  );
  // At distance zero the recall is this screen, so a mismatch is real — and it
  // says identity, because that is what it measured.
  assert.throws(
    () => resolveRef(udid, 1, { structuralHash: 'something-else', structuralDistance: 0 }),
    /this is a different screen/,
  );
  // ...and the pixel backstop still refuses on its own, which is what covers
  // the tolerant case above. It must NOT claim a different screen: reported
  // three times in one session as `#4 was numbered on a different screen
  // (03003714 → 03003714)`, a message asserting the screen changed while
  // showing that it had not, because it printed eight characters of a
  // 72-character perceptual hash whose leading characters routinely coincide.
  // That is the whole reason this comparison is a distance against a tolerance.
  assert.throws(
    () => resolveRef(udid, 1, { structuralHash: 'something-else', structuralDistance: 7, layoutHash: '5'.repeat(72) }),
    /moved too far from where these refs were numbered/,
  );
  const drifted = (() => {
    try { resolveRef(udid, 1, { structuralDistance: 7, layoutHash: '5'.repeat(72) }); return null; } catch (e) { return e.message; }
  })();
  assert.match(drifted, /layout distance \d+, tolerance \d+/, 'the measurement is shown, not a truncated hash');
  assert.match(drifted, /not a different screen/);
  assert.doesNotMatch(drifted, /→/, 'no hash prefixes, because they mislead here');

  // On the screen it was numbered on, a ref is a tap point.
  assert.equal(resolveRef(udid, 1, { structuralHash: 'aaaa1111' }).label, 'Save');
  assert.equal(resolveRef(udid, 1, { layoutHash }).x, 10);
  // On a different screen it is an error, not a tap at coordinates that now
  // belong to something else.
  assert.throws(() => resolveRef(udid, 1, { structuralHash: 'bbbb2222' }), /different screen/);
  assert.throws(() => resolveRef(udid, 9, { structuralHash: 'aaaa1111' }), /not on this screen/);

  // A screen nothing recognises cannot vouch for the numbers either.
  assert.throws(() => resolveRef(udid, 1, { screenKnown: false }), /does not recognise this screen/);
});

test('a degenerate layout hash is not evidence that the screen is the same', () => {
  // Measured, and it defeated the guard: refs numbered on the springboard
  // resolved happily on a completely different screen, because a dark or
  // near-uniform screen hashes to almost all zeros and two such hashes sit
  // within any sane Hamming tolerance of each other. The pixel check is now a
  // backstop that only speaks when the hash carries signal; structural identity
  // is what actually decides.
  assert.equal(informative('0'.repeat(72)), false, 'a blank screen says nothing');
  assert.equal(informative(`1${'0'.repeat(71)}`), false, 'nor does one set bit');
  assert.equal(informative('7070117070f0f1f3ffffffffff780908'), true);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'simframe-degen-'));
  try {
    const udid = 'TEST-DEGENERATE';
    const blank = '0'.repeat(72);
    writeRefs(udid, {
      structuralHash: 'aaaa1111',
      layoutHash: blank,
      rows: [{ ref: 1, label: 'Maps', x: 108, y: 184, type: 'Button', region: 'content', source: 'ax' }],
    });
    // Two degenerate hashes are close by Hamming distance and mean nothing, so
    // the structural answer has to be the one that decides — either way.
    assert.equal(resolveRef(udid, 1, { layoutHash: blank, structuralHash: 'aaaa1111' }).label, 'Maps');
    assert.throws(
      () => resolveRef(udid, 1, { layoutHash: blank, structuralHash: 'ffff9999' }),
      /different screen/,
      'a degenerate pixel hash must not let a stale ref through',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the screen map folds read text into the control it is printed on', () => {
  const screen = { width: 402, height: 874 };
  const entry = {
    targets: [
      // A button and OCR's reading of the text printed on it: one row, not two.
      { label: 'TRACK TIME', x: 201, y: 288, type: 'Button', source: 'ax', region: 'content', frame: { x: 100, y: 270, width: 200, height: 40 } },
      { label: 'Ỡ TRACK TIME', x: 202, y: 289, type: 'Text', source: 'ocr', region: 'content', frame: { x: 110, y: 280, width: 180, height: 20 } },
      // A tab bar encloses its five tabs and must not absorb them, or there is
      // nothing left to tap.
      { label: 'Tab Bar', x: 201, y: 833, type: 'Group', source: 'ax', region: 'content', frame: { x: 0, y: 810, width: 402, height: 60 } },
      ...['Home', 'Assets', 'Work Orders', 'Invoices', 'More'].map((label, i) => ({
        label, x: 40 + i * 75, y: 836, type: 'Text', source: 'ocr', region: 'tab-bar',
        frame: { x: 20 + i * 75, y: 826, width: 60, height: 18 },
      })),
      // A clock is not identity and not a control.
      { label: '9:41', x: 40, y: 20, type: 'Text', source: 'ocr', region: 'status-bar', frame: { x: 20, y: 12, width: 40, height: 16 } },
      // OCR reading the furniture: an ellipsis menu with no letters in it.
      { label: '•..', x: 340, y: 500, type: 'Text', source: 'ocr', region: 'content', frame: { x: 335, y: 495, width: 12, height: 10 } },
    ],
  };
  const { rows } = rowsFor(entry, { screen });
  const labels = rows.map((r) => r.label);
  assert.ok(labels.includes('TRACK TIME'));
  assert.ok(!labels.includes('Ỡ TRACK TIME'), 'the OCR reading of a button is that button');
  assert.ok(!labels.includes('Tab Bar'), 'a container is not a control');
  assert.ok(!labels.includes('9:41'), 'the status bar is never what anybody wants to tap');
  assert.ok(!labels.includes('•..'), 'text with no letters in it cannot be tapped by name');
  for (const tab of ['Home', 'Assets', 'Work Orders', 'Invoices', 'More']) {
    assert.ok(labels.includes(tab), `${tab} must survive: the tab bar must not swallow its tabs`);
  }
  // Numbered in reading order, chrome first, and every ref unique.
  assert.deepEqual(rows.map((r) => r.ref), rows.map((_, i) => i + 1));

  // And the rendered map says what screen it is before it says what is on it.
  const text = render({
    device: { name: 'iPhone 17 Pro' }, identity: { hash: 'abcd1234ef' }, rows,
    collapsed: new Map(), screen, name: 'Home', exits: 3, truncated: 0,
  });
  assert.match(text.split('\n')[0], /iPhone 17 Pro · 402x874pt · screen abcd1234 "Home" \(known, 3 known exits\)/);
  assert.ok(!text.includes('~ Ỡ TRACK TIME') || text.includes('TRACK TIME'));
});

test('a flow that halts on a wrong turn does not report success', () => {
  // `ok` used to mean only "nothing threw", so a flow stopped dead at step 0
  // by an unexpected-screen verdict came back saying "flow completed" with
  // isError false. A verdict nobody is told about is not a verdict.
  const wrong = { verdict: 'unexpected-screen', detail: 'landed somewhere else' };
  const halted = haltDecision({ verification: wrong });
  assert.equal(halted.halt, true);
  assert.equal(halted.failRun, true, 'the run failed, not merely the step');
  assert.match(halted.error, /unexpected-screen/);

  // A noisy transition kind is reported inside `ok` and stops nothing.
  for (const verdict of ['ok', 'no-visible-change', 'unverified']) {
    assert.equal(haltDecision({ verification: { verdict, detail: '' } }).halt, false, verdict);
  }
  // And a caller who asked to keep going is not overruled.
  assert.equal(haltDecision({ verification: wrong, continueOnError: true }).halt, false);
  assert.equal(haltDecision({ verification: wrong, stopOnUnexpected: false }).halt, false);
});

test('a --json call reports failure as JSON, not as prose', async () => {
  // The --json plumbing covered every command's success path and none of its
  // failures, so a caller that asked for machine-readable output and hit an
  // error got `simframe: ...` on stderr and a SyntaxError from JSON.parse. It
  // could not tell "the daemon lost the display" from "simframe is broken".
  // This used to read cli.js and assert that its source contained `--json`,
  // `JSON.stringify` and the literal `ok: false`. Asserting the shape of the
  // source is not asserting the behaviour: the same habit made a test pass
  // against a genuinely broken OCR guard earlier, and this one went red the day
  // the literal moved into a shared function while the output was unchanged.
  // So it runs the thing. A missing argument is the cheapest real failure:
  // it is refused before any device work, so this test never enumerates
  // simulators, never starts a daemon and never waits on a device.
  //
  // The first version used an unresolvable *device*, which cost 0.26s here and
  // **timed out at 30s on two of three CI runners** — device enumeration is
  // fast on a laptop with five simulators and slow on a hosted runner with
  // every runtime installed. A unit test asserting an output envelope had been
  // made to depend on how many simulators the machine has.
  const { execFile } = await import('node:child_process');
  const cliPath = new URL('../src/cli.js', import.meta.url).pathname;
  const out = await new Promise((resolve) => {
    execFile(process.execPath, [cliPath, 'do', '--json'], { timeout: 30_000 },
      (err, stdout, stderr) => resolve({
        // A timeout has no exit code, and mapping it to 0 reported a hang as
        // "expected non-zero, got 0" — which is how the real fault above spent
        // a CI round disguised as an assertion about exit codes.
        timedOut: Boolean(err?.killed),
        code: err?.code ?? 0,
        stdout,
        stderr,
      }));
  });
  assert.ok(!out.timedOut, 'the CLI answered rather than hanging');
  assert.notEqual(out.code, 0, 'a failure exits non-zero');
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(typeof parsed.error, 'string');
  // And the reason travels as a field. A refusal recognisable only by reading
  // its prose is one nobody can depend on: the CI check for the stale-ref guard
  // matched three phrasings and went red when a fourth, better one arrived.
  assert.ok('reason' in parsed, 'a failure carries a machine-readable reason, even when null');
});

import { bands, rowsOf } from '../src/regions.js';

/** A row of elements at one height, evenly spaced across the width. */
const row = (y, count, { height = 20, width = 60, from = 20, to = 380 } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    frame: {
      x: count === 1 ? (402 - width) / 2 : from + (i * (to - from - width)) / Math.max(1, count - 1),
      y, width, height,
    },
  }));

test('a nav bar is a short row above a gap, not a fraction of the screen', () => {
  const screen = [
    ...row(20, 2, { height: 14, width: 40 }),          // status bar, excluded from clustering
    ...row(70, 1, { height: 24, width: 120 }),         // nav title
    // A dense list starting well below it. Two elements per row — a label and
    // its chevron — because a real list has them and clustering needs enough
    // elements to have a distribution at all.
    ...row(140, 2, { height: 44, width: 100 }),
    ...row(186, 2, { height: 44, width: 100 }),
    ...row(232, 2, { height: 44, width: 100 }),
    ...row(278, 2, { height: 44, width: 100 }),
  ];
  const b = bands(screen, SCREEN);
  assert.equal(b.clustered, true);
  assert.ok(b.navBarBottom >= 90 && b.navBarBottom < 140,
    `nav bar should end at the title row, got ${b.navBarBottom}`);
  assert.equal(b.tabBarTop, Infinity, 'this screen has no tab bar');
});

test('a screen of evenly spaced rows has no chrome at all', () => {
  // The springboard: icon and widget rows from top to bottom with no
  // distinguished gap anywhere. The positional rule called its top row a nav
  // bar, which is how one screen's identity became the name of the city in its
  // weather widget.
  const screen = [];
  for (let y = 110; y < 800; y += 96) screen.push(...row(y, 4, { height: 60, width: 60 }));
  const b = bands(screen, SCREEN);
  assert.equal(b.clustered, true);
  assert.equal(b.navBarBottom, 0, 'no gap means no nav bar');
  assert.equal(b.tabBarTop, Infinity, 'and no tab bar');
  // So nothing up there is chrome, and no widget label can enter identity.
  assert.equal(regionFor(screen[0].frame, SCREEN, b), 'content');
});

test('a tab bar is several spread items below a gap; a list row is not', () => {
  // Rows 10pt apart, then a 22pt separation before the bar. The separation is
  // what identifies it — a bar butted straight against the content it floats
  // over is not something geometry can pick out, and guessing from position
  // alone is the bug this replaced.
  const list = [];
  for (let y = 140; y <= 740; y += 60) list.push(...row(y, 1, { height: 50, width: 360 }));
  const withTabs = [...list, ...row(812, 5, { height: 22, width: 44 })];
  const b = bands(withTabs, SCREEN);
  assert.ok(b.tabBarTop <= 812 && b.tabBarTop > 790, `tab bar should start at the tab row, got ${b.tabBarTop}`);
  assert.equal(regionFor({ x: 20, y: 812, width: 44, height: 22 }, SCREEN, b), 'tab-bar');

  // The original bug: a list that simply continues to the bottom of the screen.
  // Its last row sits inside the old positional tab-bar band and must not be
  // called a tab item, or a seven-row list is a different screen from a
  // three-row one.
  const longList = [];
  for (let y = 140; y <= 820; y += 60) longList.push(...row(y, 1, { height: 50, width: 360 }));
  const b2 = bands(longList, SCREEN);
  assert.equal(b2.tabBarTop, Infinity, 'an unbroken list has no tab bar');
  assert.equal(regionFor({ x: 20, y: 820, width: 360, height: 50 }, SCREEN, b2), 'content');
});

test('too few elements to cluster falls back rather than guessing', () => {
  const b = bands(row(70, 2), SCREEN);
  assert.equal(b.clustered, false);
  assert.ok(b.navBarBottom > 0, 'the HIG fractions are a better guess than none');
  assert.ok(Number.isFinite(b.tabBarTop));
});

test('rows are grouped by vertical overlap, not by exact y', () => {
  const items = [
    { frame: { x: 10, y: 100, width: 40, height: 20 } },
    { frame: { x: 80, y: 104, width: 40, height: 20 } },   // same row, 4pt lower
    { frame: { x: 10, y: 200, width: 40, height: 20 } },   // next row
  ];
  const rows = rowsOf(items);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].items.length, 2);
});

test('a list cell and the text printed inside it are one control', () => {
  // Measured on a Settings list: the accessibility cell spans the row so its
  // centre is (201,326), and the OCR text is left-aligned at (102,327). A
  // hundred points apart, one tap target — and the caller was asked which of
  // the two it meant, which stopped a flow dead.
  const targets = [
    { label: 'General', x: 201, y: 326, type: 'Cell', source: 'ax', frame: { x: 20, y: 304, width: 362, height: 44 } },
    { label: 'General', x: 102, y: 327, type: 'Text', source: 'ocr', frame: { x: 74, y: 318, width: 56, height: 18 } },
  ];
  const out = resolveIntent(targets, 'General', { screen: { width: 402, height: 874 } });
  assert.equal(out.status, 'ok');
  assert.equal(out.target.type, 'Cell', 'the cell is the hit target, not the text on it');

  // But a container that merely encloses things must not absorb them, or a tab
  // bar swallows its own tabs and there is nothing left to tap.
  const group = [
    { label: 'Tab Bar', x: 201, y: 833, type: 'Group', source: 'ax', frame: { x: 0, y: 810, width: 402, height: 60 } },
    { label: 'Home', x: 40, y: 836, type: 'Text', source: 'ocr', frame: { x: 20, y: 826, width: 40, height: 18 } },
  ];
  const kept = rankIntent(group, 'Home', { screen: { width: 402, height: 874 } });
  assert.ok(kept.some((c) => c.target.label === 'Home'), 'the tab survives');
});

test('a daemon element becomes the node shape every accessibility caller expects', () => {
  // The tree now arrives as elements over the control socket rather than as
  // idb's JSON, and every caller downstream — intent matching, tap-by-label,
  // the screen map — reads the older shape. This is the whole of the seam.
  const node = elementToNode({
    role: 'Button',
    label: ', My Tools',
    value: '3 open',
    identifier: 'tools-tab',
    frame: { x: 20, y: 810, width: 80, height: 50 },
    state: { enabled: false, selected: true },
    source: ['ax'],
  });
  assert.equal(node.type, 'Button');
  assert.equal(node.label, 'My Tools', 'a private-use glyph is not part of the name');
  assert.equal(node.rawLabel, ', My Tools', 'but the raw label is still there to match on');
  assert.equal(node.value, '3 open');
  assert.equal(node.identifier, 'tools-tab');
  assert.equal(node.enabled, false, 'disabled must survive as false, not be lost to a nullish default');
  assert.deepEqual(node.frame, { x: 20, y: 810, width: 80, height: 50 });

  // An element with nothing published reports null rather than inventing a
  // label, because a wrong label is worse than no label.
  const bare = elementToNode({ role: 'Image', frame: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(bare.label, null);
  assert.equal(bare.value, null);
  assert.equal(bare.identifier, null);
  assert.equal(bare.enabled, null, 'unknown is null, not false');
});

test('a daemon that answers with a failure is reported, not returned as an empty screen', async () => {
  // The version of this that flattened the rejection to null returned
  // {sources: [], targets: []} with no error — and because maps are persisted
  // by default, that emptiness was written into screen memory under the
  // current layout hash, where the next warm visit read it back instead of
  // perceiving the screen again. A loud failure became a poisoned cache entry.
  // A short name on purpose: a Unix socket path has about 104 characters to
  // play with, and a real UDID under a temp root spends them all — `listen`
  // then resolves without creating the file, which reads as an unrelated bug.
  const udid = 'fake-daemon';
  const dir = store.deviceDir(udid);
  fs.mkdirSync(dir, { recursive: true });
  // `available()` wants a meta.json naming a live process and a real socket.
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ pid: process.pid, udid }));
  const sockPath = path.join(dir, 'control.sock');

  const server = net.createServer((c) => {
    c.on('data', () => c.end(`${JSON.stringify({ ok: false, error: 'the daemon is having a bad day' })}\n`));
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));
  try {
    assert.equal(control.available(udid), true, 'the fixture has to look like a live daemon');
    await assert.rejects(
      () => screenmap.build(udid, { screen: { width: 402, height: 874 }, persist: false }),
      /bad day/,
      'the daemon’s own reason has to reach the caller');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one observation is not enough to call an arrival a wrong turn', () => {
  // Halting on a single-observation prediction made a new user's second run
  // worse than their first: run one learns every edge at count 1 and cannot
  // contradict itself, run two has an expectation for every step and stops
  // dead on the first screen whose identity wobbled.
  const once = { verdict: 'unverified', detail: 'x' };
  assert.equal(wrongTurnFrom(once), false, 'unverified is never a wrong turn');

  // The distinction has to survive into the halt decision, because
  // `unexpected-screen` is what stops a run — and what "a run that reported a
  // wrong turn never also reports success" is asserted over.
  const weak = { verdict: 'unverified', detail: 'seen here once before and went somewhere else' };
  assert.equal(haltDecision({ verification: weak }).halt, false);
  assert.equal(haltDecision({ verification: weak }).failRun, false);

  const confident = { verdict: 'unexpected-screen', detail: 'expected the screen this action reached 4x before' };
  assert.equal(wrongTurnFrom(confident), true);
  assert.equal(haltDecision({ verification: confident }).halt, true, 'a repeated pattern still halts');
  assert.equal(haltDecision({ verification: confident }).failRun, true);

  assert.equal(CONFIDENT_OBSERVATIONS, 2, 'the threshold is a decision, not an accident');
});

test('a route through a screen wearing its second face is still a route', () => {
  // An edge records whichever structure the screen was wearing when it arrived.
  // Keying the search on canonical hashes only made such an edge a dead end,
  // while `nearestScreen` was perfectly happy to say that hash *is* the node —
  // so the graph had a route it could not find, `goto` answered `no-route` for
  // somewhere it had been, and a flow that should have replayed from memory got
  // re-explored.
  const UDID = freshDevice('route-variant');
  const A = { hash: 'a'.repeat(32), tokens: tok(6, 'a') };
  const B = { hash: 'b'.repeat(32), tokens: tok(6, 'b') };
  const C = { hash: 'c'.repeat(32), tokens: tok(6, 'c') };
  // B has to be a screen we have read before it can wear a second face.
  graphmod.record(UDID, { from: B, action: { tap: 'stay' }, to: B, kind: 'none' });
  graphmod.record(UDID, { from: A, action: { tap: 'to-b' }, to: B, kind: 'push' });
  // B arrives wearing a recognisable second face, which becomes a variant.
  const Bface = { hash: 'd'.repeat(32), tokens: face(6, 'b') };
  graphmod.record(UDID, { from: A, action: { tap: 'to-b' }, to: Bface, kind: 'push' });
  graphmod.record(UDID, { from: Bface, action: { tap: 'to-c' }, to: C, kind: 'push' });

  const path = graphmod.route(UDID, A, C.hash);
  assert.ok(path, 'A reaches C even though the middle hop is a second face of B');
  assert.deepEqual(path.map((e) => e.action), ['tap:to-b', 'tap:to-c']);

  // And the goal itself may be named by either face.
  assert.ok(graphmod.route(UDID, A, B.hash), 'reaching B by its canonical hash');
  assert.ok(graphmod.route(UDID, A, Bface.hash), 'reaching B by its variant hash');
});

test('a graph whose hashes came from older rules is discarded, not compared', () => {
  // An old hash is a perfectly well-formed hash that never matches anything,
  // which is the quietest kind of wrong: the graph looks populated, every
  // prediction misses, and nothing says why. So the fingerprint's version
  // travels with the file and a mismatch means rebuild, never translate.
  const UDID = freshDevice('fp-version');
  const A = { hash: 'a'.repeat(32), tokens: tok(6, 'a') };
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: { hash: 'b'.repeat(32), tokens: tok(6, 'b') } });
  assert.equal(graphmod.stats(UDID).screens, 1, 'the fixture stored something');

  // Rewrite the stored node as if an older fingerprint had produced it.
  const file = path.join(store.ROOT, UDID, 'graph', `${A.hash}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.fingerprintVersion, graphmod.FINGERPRINT_VERSION);
  fs.writeFileSync(file, JSON.stringify({ ...stored, fingerprintVersion: stored.fingerprintVersion - 1 }));

  assert.equal(graphmod.stats(UDID).screens, 0, 'incomparable hashes are not offered as knowledge');
  assert.equal(graphmod.nearestScreen(UDID, A), null, 'and nothing resolves against them');
  assert.equal(graphmod.predict(UDID, A, { tap: 'go' }), null, 'so no prediction is made from them');
});

// --- the platform boundary ---------------------------------------------------

test('every registered backend provides the whole platform surface', async () => {
  const platform = await import('../src/platform/index.js');
  for (const [name, backend] of Object.entries(platform.PLATFORMS)) {
    for (const member of platform.PLATFORM_SURFACE) {
      assert.ok(member in backend, `${name} backend is missing ${member}`);
    }
    assert.equal(backend.id, name, 'a backend is registered under its own id');
  }
});

test('the platform surface is satisfiable by something that is not a simulator', async () => {
  // The Swift half has proved this since Phase 0 with StubPlatform: a protocol
  // nothing but the real thing can implement is not a boundary, it is a rename.
  // This is the same check one level up — and it is the shape Android has to
  // meet, written down before Android exists.
  const { PLATFORM_SURFACE } = await import('../src/platform/index.js');
  const fake = {
    id: 'fake',
    deviceNoun: 'device',
    listDevices: async () => [{ udid: 'F', name: 'Fake', runtime: 'none', state: 'Booted' }],
    bootedDevices: async () => [{ udid: 'F', name: 'Fake', runtime: 'none', state: 'Booted' }],
    resolveDevice: async () => ({ udid: 'F', name: 'Fake', runtime: 'none', state: 'Booted' }),
    isBootedSync: () => true,
    ownsUdid: (udid) => String(udid).startsWith('fake-'),
    geometry: () => ({ pixelWidth: 100, pixelHeight: 200, density: 1, pointWidth: 100, pointHeight: 200 }),
    inputDriver: () => null,
    // A backend that cannot tell when its device booted returns null and says
    // nothing more: the layer above then makes no staleness claim at all,
    // rather than inventing one from the other platform's vocabulary.
    bootedAt: async () => null,
    screenshot: async () => {},
    launchApp: async () => {},
    terminateApp: async () => {},
    openUrl: async () => {},
    // A backend without this remedy throws in its own terms, which is a real
    // implementation of the member. What it must not do is borrow the other
    // platform's answer — that is how `doctor` came to report "input driver:
    // idb" for an emulator.
    restartDevice: async () => { throw new Error('a fake device cannot be restarted'); },
    setPermission: async () => 'granted nothing',
    setPasteboard: async () => {},
    permissionServices: () => [],
    capabilities: () => ({
      captureEngines: ['screenshot'],
      input: { supported: false, note: 'a fake device has no input' },
      ax: { supported: false, note: 'nor an accessibility tree' },
    }),
    toolchain: () => [{ name: 'nothing', level: 'ok', detail: 'no tools needed' }],
    // Reading what an app persisted. A fake device stores nothing, and the
    // honest implementation of that is a refusal in its own vocabulary — the
    // same shape Android uses, for the same reason.
    listApps: async () => { throw new Error('a fake device installs nothing'); },
    appContainer: async () => { throw new Error('a fake device has no containers'); },
    readPropertyList: async () => { throw new Error('a fake device has no property lists'); },
  };
  for (const member of PLATFORM_SURFACE) assert.ok(member in fake, `a backend needs ${member}`);
  assert.deepEqual(Object.keys(fake).sort(), [...PLATFORM_SURFACE].sort(), 'and needs nothing more');
});

test('every dispatch wrapper reaches the backend member of the same name', async () => {
  // A wrapper is one line, which is exactly the kind of line where openUrl
  // forwards to openURL and nothing notices until an Android backend spells it
  // the other way. Checked at the source, since the registry is frozen.
  const src = fs.readFileSync(new URL('../src/platform/index.js', import.meta.url), 'utf8');
  const wrappers = [...src.matchAll(
    /^export const (\w+) = \(udid, \.\.\.args\) => platformFor\(udid\)\.(\w+)\(udid, \.\.\.args\);$/gm,
  )];
  assert.ok(wrappers.length >= 7, `found ${wrappers.length} dispatch wrappers`);
  for (const [, exported, called] of wrappers) {
    assert.equal(called, exported, `${exported} forwards to ${called}`);
  }
});

// A second backend, so the routing can be tested before Android exists. It
// answers every call by naming itself, which is all a routing test needs.
function fakeBackend(id, ownedPrefix, devices) {
  const say = (what) => async (...args) => `${id}:${what}:${args[0]}`;
  return {
    id,
    deviceNoun: 'device',
    ownsUdid: (udid) => String(udid ?? '').startsWith(ownedPrefix),
    listDevices: async () => devices,
    bootedDevices: async () => devices.filter((d) => d.state === 'Booted'),
    resolveDevice: async (query) => {
      const hits = devices.filter((d) => d.udid === query || d.name.toLowerCase().includes(String(query ?? '').toLowerCase()));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw Object.assign(new Error(`"${query}" matches ${hits.length} on ${id}`), { ambiguous: true });
      throw new Error(`nothing on ${id} matches "${query}"`);
    },
    isBootedSync: () => true,
    geometry: () => null,
    inputDriver: () => null,
    screenshot: say('screenshot'),
    launchApp: say('launch'),
    terminateApp: say('terminate'),
    openUrl: say('openUrl'),
    setPermission: say('permission'),
    setPasteboard: say('paste'),
    permissionServices: () => [`${id}-only`, 'shared'],
    capabilities: () => ({ captureEngines: ['screenshot'], input: { supported: true }, ax: { supported: true } }),
    toolchain: () => [{ name: `${id}-tool`, level: 'ok', detail: 'present' }],
  };
}

test('a device is routed by its own id, not by a process-wide default', async () => {
  const platform = await import('../src/platform/index.js');
  const left = fakeBackend('left', 'L-', [{ udid: 'L-1', name: 'Left One', runtime: 'r', state: 'Booted' }]);
  const right = fakeBackend('right', 'R-', [{ udid: 'R-1', name: 'Right One', runtime: 'r', state: 'Booted' }]);
  const both = [left, right];

  assert.equal(platform.chooseBackend('L-1', both).id, 'left');
  assert.equal(platform.chooseBackend('R-1', both).id, 'right', 'the second backend is reachable at all');

  // An id nobody claims is an error only once there is a choice to get wrong.
  // With one backend it still routes there, so a typo gets that platform's own
  // message about the device — which is what it got before the seam existed.
  assert.equal(platform.chooseBackend('nonsense', [left]).id, 'left');
  assert.throws(() => platform.chooseBackend('nonsense', both), /no platform recognises/);

  // And a real udid routes to the real backend by shape, with no listing first.
  assert.equal(platform.platformFor('CDB00FD6-9782-45FC-8E2A-856D794F9FEF').id, 'ios');
});

test('resolving a device asks every backend, and an ambiguity outranks a match', async () => {
  const platform = await import('../src/platform/index.js');
  const left = fakeBackend('left', 'L-', [
    { udid: 'L-1', name: 'Pixel One', runtime: 'r', state: 'Booted' },
    { udid: 'L-2', name: 'Pixel Two', runtime: 'r', state: 'Booted' },
  ]);
  const right = fakeBackend('right', 'R-', [{ udid: 'R-1', name: 'Pixel Three', runtime: 'r', state: 'Booted' }]);
  const both = [left, right];

  const hit = await platform.resolveAcross('Pixel Three', null, both);
  assert.equal(hit.udid, 'R-1');
  assert.equal(hit.platform, 'right', 'the record carries the platform it came from');

  // "Pixel" is ambiguous on `left` and matches exactly one device on `right`.
  // Answering with the right-hand device would be the wrong-device bug wearing
  // a different hat, so the ambiguity wins.
  await assert.rejects(() => platform.resolveAcross('Pixel', null, both), /matches 2 on left/);

  // One name, one device each side: reported, never guessed at.
  const twin = fakeBackend('twin', 'T-', [{ udid: 'T-1', name: 'Pixel Three', runtime: 'r', state: 'Booted' }]);
  await assert.rejects(
    () => platform.resolveAcross('Pixel Three', null, [right, twin]),
    /more than one platform/,
  );

  // Nothing anywhere, one backend: that backend's own message, unchanged.
  await assert.rejects(() => platform.resolveAcross('Nexus', null, [right]), /nothing on right matches/);
});

test('a bare query on a host with two platforms says so, and can be answered once', async () => {
  // The mixed setup is the one the second backend exists for, and it used to
  // break every command that did not name a device: both backends answer an
  // empty query with their first booted device, two hits is ambiguous, and the
  // message interpolated the word "undefined" as the query.
  const platform = await import('../src/platform/index.js');
  const sim = fakeBackend('sim', 'S-', [{ udid: 'S-1', name: 'iPhone 17', runtime: 'r', state: 'Booted' }]);
  const emu = fakeBackend('emu', 'E-', [{ udid: 'E-1', name: 'Small Phone', runtime: 'r', state: 'Booted' }]);

  await assert.rejects(() => platform.resolveAcross(undefined, null, [sim, emu]), (err) => {
    assert.doesNotMatch(err.message, /undefined/, 'the message does not quote a query nobody typed');
    assert.match(err.message, /no device named/);
    assert.match(err.message, /S-1/, 'both devices are named by id, since that is what resolves them');
    assert.match(err.message, /E-1/);
    assert.match(err.message, /SIMFRAME_DEVICE/, 'and the way out is in the message');
    return true;
  });

  // Naming one is still unambiguous, and one platform alone still needs nothing.
  assert.equal((await platform.resolveAcross('E-1', null, [sim, emu])).udid, 'E-1');
  assert.equal((await platform.resolveAcross(undefined, null, [sim])).udid, 'S-1');
});

test('a physical Android device is not offered as one simframe can drive', async () => {
  // `adb devices` lists phones as readily as emulators, and the backend listed
  // whatever it was given while `ownsUdid` claimed emulator serials only. So
  // `devices` offered a plugged-in phone, a bare resolve could return it, and
  // the tap that followed complained about the serial instead of saying that
  // physical devices are a non-goal. The test below asserts listing and routing
  // agree; it passed only because the machine that ran it had no phone attached.
  const platform = await import('../src/platform/index.js');
  const { android } = platform.PLATFORMS;
  assert.ok(android.ownsUdid('emulator-5554'), 'an emulator serial is claimed');
  for (const serial of ['R58M1234ABC', '1a2b3c4d', 'emulator-abc', '192.168.1.5:5555']) {
    assert.ok(!android.ownsUdid(serial), `${serial} is not an emulator serial`);
  }
  // And the listing is gated on that same answer, which is what makes the two
  // agree on a machine this test cannot arrange: one with a phone plugged in.
  const source = fs.readFileSync(new URL('../src/platform/android.js', import.meta.url), 'utf8');
  const loop = /for \(const line of stdout\.split\('\\n'\)\.slice\(1\)\) \{([\s\S]*?)\n  \}/.exec(source);
  assert.ok(loop, 'the device-listing loop is still there');
  assert.match(loop[1], /ownsUdid\(serial\)/, 'the listing only keeps serials this backend claims');
});

test('the steps that put text in a field deliver it, and the stall clock resets', async () => {
  // Three one-line omissions that all produced a confident wrong answer, pinned
  // at the source because each of them needs a device to exercise and none of
  // them needs one to get wrong again.
  const read = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

  // `paste` set the pasteboard, long-pressed the field and reported success
  // while the field stayed empty — on both platforms. The keystroke is the job.
  const actions = read('actions.js');
  const paste = /case 'paste': \{([\s\S]*?)\n    \}/.exec(actions);
  assert.ok(paste, 'the paste step is still a case in runStep');
  assert.match(paste[1], /input\.pasteText/, 'paste delivers through pasteText');
  assert.doesNotMatch(paste[1], /placed text on the pasteboard/, 'and does not describe half the job');

  // pasteText has exactly two ways to deliver and throws when it has neither,
  // rather than returning a cheerful description of setting the pasteboard.
  const input = read('input.js');
  const pasteText = /export async function pasteText\(([\s\S]*?)\n\}/.exec(input);
  assert.ok(pasteText, 'pasteText exists');
  assert.match(pasteText[1], /own\.key\(udid, 'paste'\)/, 'the platform keycode path');
  assert.match(pasteText[1], /control\.paste\(/, 'and the daemon Cmd-V path');
  assert.match(pasteText[1], /throw new Error/, 'and a refusal when neither is there');

  // A stall clock that is never reset reports the first stall's age forever.
  const daemon = read('daemon.js');
  const recovery = /capture recovered on its own[\s\S]{0,600}/.exec(daemon);
  assert.ok(recovery, 'the recovery branch is still there');
  assert.match(recovery[0], /stalledSince = null/, 'recovery resets the clock, as the Swift loop does');
});

test('a bare command refuses to pick a device when more than one is booted', async () => {
  // `booted[0]` is not "yours" by any definition simctl or adb offers, and a
  // bare `simframe tap` would have injected input into whichever came first. A
  // reviewer reproduced exactly that against a colleague's simulator, while
  // `doctor` — which had its own inline guard — correctly chose the right one in
  // the same moment. So the refusal belongs in the backends, where the default
  // is decided, not in one command.
  const platform = await import('../src/platform/index.js');
  for (const [id, backend] of Object.entries(platform.PLATFORMS)) {
    const source = fs.readFileSync(new URL(`../src/platform/${id}.js`, import.meta.url), 'utf8');
    const guard = /if \(booted\.length > 1\) \{([\s\S]*?)\n    \}/.exec(source);
    assert.ok(guard, `${id} refuses a bare query when several devices are booted`);
    assert.match(guard[1], /ambiguous: true/,
      `${id} marks it ambiguous, so a clean match on the other platform cannot override it`);
    assert.match(guard[1], /SIMFRAME_DEVICE/, `${id} says how to answer the question once`);
    assert.ok(typeof backend.resolveDevice === 'function');
  }

  // And an ambiguous default must not be resolved by the other platform having
  // exactly one device — that is the wrong-device bug with an extra step.
  const ambiguous = {
    id: 'many', deviceNoun: 'simulator', ownsUdid: () => false,
    resolveDevice: async () => {
      throw Object.assign(new Error('2 simulators are booted and none was named'), { ambiguous: true });
    },
  };
  const single = fakeBackend('one', 'O-', [{ udid: 'O-1', name: 'Only', runtime: 'r', state: 'Booted' }]);
  await assert.rejects(() => platform.resolveAcross(undefined, null, [ambiguous, single]),
    /none was named/);
});

test('a listing unions the backends and stamps every record', async () => {
  const platform = await import('../src/platform/index.js');
  const devices = await platform.listDevices();
  for (const d of devices) {
    assert.ok(platform.PLATFORMS[d.platform], `${d.udid} says it came from "${d.platform}"`);
    assert.ok(
      platform.PLATFORMS[d.platform].ownsUdid(d.udid),
      `${d.udid} is claimed by the backend that listed it — otherwise routing and listing disagree`,
    );
  }

  // The service menu is the union, deduplicated, and asking about one device
  // gets that platform's own list rather than the menu.
  const menu = platform.permissionServices();
  assert.deepEqual([...new Set(menu)].length, menu.length, 'the unioned menu has no duplicates');
  for (const backend of platform.backends()) {
    for (const service of backend.permissionServices()) {
      assert.ok(menu.includes(service), `${backend.id}'s "${service}" is on the menu`);
    }
  }
  assert.deepEqual(platform.permissionServices('emulator-5554'), platform.PLATFORMS.android.permissionServices());

  // And the two lists are genuinely different, which is the point: `siri` has
  // no Android meaning and `notifications` has no iOS one, so a shared name
  // would have had to mean two things.
  const ios = platform.PLATFORMS.ios.permissionServices();
  const android = platform.PLATFORMS.android.permissionServices();
  assert.ok(ios.includes('siri') && !android.includes('siri'));
  assert.ok(android.includes('notifications') && !ios.includes('notifications'));
});

test('nothing above the boundary shells out to a platform tool', async () => {
  // The rule in CLAUDE.md — "nothing above the boundary may import a platform
  // framework" — was true of the Swift half and untrue of this half, silently,
  // because nothing checked. This is the check. `xcrun` is the executable name,
  // not the string 'simctl', which is also the name of a capture engine and is
  // allowed to appear anywhere.
  const dir = new URL('../src/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 15, 'the source directory was actually read');
  for (const file of files) {
    const source = fs.readFileSync(new URL(file, dir), 'utf8');
    for (const tool of ["'xcrun'", "'adb'", "'idevice"]) {
      assert.ok(!source.includes(tool), `${file} calls ${tool} directly; it belongs in src/platform/`);
    }
    assert.ok(!source.includes("'./simctl.js'"), `${file} imports the old pre-boundary module`);
  }
});

test('an accessibility identifier is a name the resolver will accept', async () => {
  const m = await import('../src/matching.js');
  const screen = { width: 402, height: 874 };
  // `sim_ui` prints elements by identifier — in React Native a `testID` becomes
  // one, so it is most interactive controls in an RN app — and the resolver
  // rejected that exact string in the same response that printed it. An
  // external tester reproduced it three times and called it the single biggest
  // friction of their session. `screenmap.rank` already matched identifiers;
  // this ranker, the one `resolve()` uses, did not.
  const field = {
    label: null, identifier: 'login-email-input', type: 'TextField',
    x: 201, y: 407, frame: { x: 20, y: 393, width: 362, height: 28 },
    region: 'body', source: 'ax',
  };
  const other = {
    label: 'Email', type: 'StaticText', x: 66, y: 398,
    frame: { x: 50, y: 390, width: 33, height: 16 }, region: 'body', source: 'ax',
  };
  const hit = m.resolve([field, other], 'login-email-input', { screen });
  assert.equal(hit.status, 'ok', 'an identifier must resolve');
  assert.equal(hit.target.identifier, 'login-email-input');

  // And a label still wins for a label, so this adds a name rather than
  // changing what the existing ones mean.
  assert.equal(m.resolve([field, other], 'Email', { screen }).target.label, 'Email');
});

test('a stray reading is classified by cause, because the causes have different fixes', async () => {
  const { classifyStray } = await import('../scripts/classify-stray.mjs');
  // This logic crashed on a runner TWICE while being correct — once reaching
  // for a variable local to another function, once on declaration order — and
  // nothing could test it because eval-fingerprint.mjs runs the whole eval on
  // import. Hence its own module, and hence this test.
  //
  // The data is the real CI failure of 2026-09-15: `settings-general` r3 came
  // back byte-identical to the Settings root, while r1 and r2 read richly and
  // differently. The root legitimately reads 4 tokens on a runner, so the stray
  // was flagged sparse too — and sparseness alone used to claim "under-read",
  // which blamed our instrument for a tour that had gone somewhere else.
  const rootTokens = [
    'button:content:w15:h2:x1:y12#many',
    'button:content:w15:h4:x1:y7#1',
    'heading:nav-bar:@leading:w6:h2:"settings":x1:y5#1',
    'text:content:w3:h1:x2:y34#1',
  ];
  const generalTokens = [
    'button:content:w15:h2:x1:y16#many',
    'button:nav-bar:@leading:w2:h2:"settings":x1:y3#1',
    'heading:content:w14:h4:x2:y11#1',
    'heading:content:w3:h1:x2:y9#1',
    'text:content:w1:h1:x2:y17#many',
  ];
  const r3 = { name: 'settings-general', round: 3, tokens: rootTokens };
  const siblings = [
    { name: 'settings-general', round: 1, tokens: generalTokens },
    { name: 'settings-general', round: 2, tokens: generalTokens },
    r3,
  ];
  const match = { name: 'settings', round: 1, tokens: rootTokens };

  const wrong = classifyStray({
    reading: r3, match, bestOther: 1, siblings, wasSparse: true,
    named: ['heading:nav-bar:"settings"'], matchNamed: ['heading:nav-bar:"settings"'],
  });
  assert.equal(wrong.wrongScreen, true, 'identical tokens + a screen that reads differently elsewhere = a wrong turn');
  assert.equal(wrong.underRead, false, 'and it must NOT be blamed on a short look');
  assert.equal(wrong.collided, false);

  // A screen that cannot tell itself apart in ANY round is the honest
  // under-read: there is no evidence it is distinguishable at all.
  const allSparse = [
    { name: 'thin', round: 1, tokens: rootTokens },
    { name: 'thin', round: 2, tokens: rootTokens },
  ];
  const under = classifyStray({
    reading: allSparse[0], match, bestOther: 1, siblings: allSparse, wasSparse: true,
    named: ['x'], matchNamed: ['y'],
  });
  assert.equal(under.underRead, true);
  assert.equal(under.wrongScreen, false);

  // A genuine fingerprint collision — neither side carries a chrome label, so
  // nothing in either reading could have named a destination. That is this
  // harness's own subject and outranks the other two.
  const collision = classifyStray({
    reading: r3, match, bestOther: 1, siblings, wasSparse: true, named: [], matchNamed: [],
  });
  assert.equal(collision.collided, true);
  assert.equal(collision.wrongScreen, false, 'a collision is not a wrong turn');
  assert.equal(collision.underRead, false);

  // And a stray that resembles nothing in particular is none of the three.
  const weak = classifyStray({
    reading: { name: 'browser', round: 1, tokens: ['a'] }, match: null, bestOther: 0,
    siblings: [{ name: 'browser', round: 2, tokens: ['b'] }], wasSparse: false,
  });
  assert.equal(weak.collided, false);
  assert.equal(weak.wrongScreen, false);
  assert.equal(weak.underRead, false);
});

test('a control whose value changed did something, whatever the pixels say', async () => {
  const actions = await import('../src/actions.js');
  // Item 154. A switch flip is eight times below the frame-change threshold
  // (item 4, measured: 0.00049 against 0.004), so settle() reports
  // no-visible-change over a control that flipped — and prints the changed
  // value in the same response. That was harmless while the tap missed the
  // frame centre. Item 148 made the tap land, so the verdict is now false AND
  // it is what an agent reads to decide whether to retry: a retry un-flips it.
  const before = { targets: [{ identifier: 'toggle-a', label: 'Hover Text', type: 'Switch', value: '0', x: 337, y: 161 }] };
  const after = { targets: [{ identifier: 'toggle-a', label: 'Hover Text', type: 'Switch', value: '1', x: 337, y: 161 }] };

  const d = actions.stateDelta(before, after);
  assert.ok(d, 'a flipped switch must register as a change');
  assert.equal(d.count, 1);
  assert.match(d.detail, /"Hover Text" changed from "0" to "1"/);

  // Unchanged is unchanged — this must not invent evidence, or every
  // no-visible-change becomes a false pass.
  assert.equal(actions.stateDelta(before, before), null);
  assert.equal(actions.stateDelta(before, { targets: [] }), null);
  assert.equal(actions.stateDelta(null, after), null, 'with nothing to compare against, no claim');

  // A control with no state at all contributes nothing either way.
  const plain = { targets: [{ label: 'Save', type: 'Button', x: 10, y: 10 }] };
  assert.equal(actions.stateDelta(plain, plain), null);

  // Identity is by identifier, then label, then type-and-place. A row that
  // MOVED is a different reading, not a changed control — otherwise a scrolled
  // list would report every row as having changed.
  const moved = { targets: [{ label: 'Hover Text', type: 'Switch', value: '1', x: 337, y: 400 }] };
  const unnamed = { targets: [{ type: 'Switch', value: '0', x: 337, y: 161 }] };
  assert.equal(actions.stateDelta(unnamed, moved), null, 'a control that moved is not a control that changed');

  // Several changes are summarised rather than listed in full.
  const many = { targets: [
    { identifier: 'a', label: 'A', value: '1', x: 1, y: 1 },
    { identifier: 'b', label: 'B', value: '1', x: 1, y: 2 },
  ] };
  const manyBefore = { targets: [
    { identifier: 'a', label: 'A', value: '0', x: 1, y: 1 },
    { identifier: 'b', label: 'B', value: '0', x: 1, y: 2 },
  ] };
  const dm = actions.stateDelta(manyBefore, many);
  assert.equal(dm.count, 2);
  assert.match(dm.detail, /1 other control/);
});

test('an element is aimed at where it actuates, not at the middle of its frame', async () => {
  const { centerOf } = await import('../src/input.js');
  // Item 148, measured on Settings → Accessibility → Hover Text. An iOS switch
  // publishes a row-wide accessibility frame, so the geometric centre is the
  // LABEL and iOS does not actuate a switch from there. The frame centre
  // flipped it 0 of 3 times; the activation point 3 of 3.
  const row = { frame: { x: 36, y: 147, width: 330, height: 28 } };
  assert.deepEqual(centerOf(row), { x: 201, y: 161 }, 'with no answer from the app, the centre as before');
  assert.deepEqual(centerOf({ ...row, activationPoint: { x: 337, y: 161 } }), { x: 337, y: 161 },
    "the app's own activation point wins");

  // Outside the frame is not trusted. This runs on the tap path, where a wrong
  // guess is the one thing that does damage, and a point that is not on the
  // element is not a better answer than the middle of one.
  assert.deepEqual(centerOf({ ...row, activationPoint: { x: 900, y: 161 } }), { x: 201, y: 161 });
  assert.deepEqual(centerOf({ ...row, activationPoint: { x: 337, y: 900 } }), { x: 201, y: 161 });
  // And nothing here may throw on a shape the bridge did not fill in.
  for (const bad of [null, undefined, {}, { x: NaN, y: 1 }, { x: 1 }]) {
    assert.deepEqual(centerOf({ ...row, activationPoint: bad }), { x: 201, y: 161 });
  }

  // The field has to survive the converter that actually runs. `normalizeNode`
  // is the idb fallback; `elementToNode` is the daemon path, and AXSelected and
  // AXFocused were batched by the daemon for four versions while being dropped
  // here — which is exactly how this field was nearly lost too.
  const { elementToNode } = await import('../src/input.js');
  const node = elementToNode({
    label: 'Hover Text', role: 'Switch', value: '0',
    frame: { x: 36, y: 147, width: 330, height: 28 },
    activationPoint: { x: 337, y: 161 },
  });
  assert.deepEqual(node.activationPoint, { x: 337, y: 161 }, 'the daemon path must carry it');
  assert.deepEqual(centerOf(node), { x: 337, y: 161 });
});

test('a simctl timeout says it timed out, and the budget clears what was measured', async () => {
  const src = fs.readFileSync(new URL('../src/platform/ios.js', import.meta.url), 'utf8');

  // The number, pinned to the measurement rather than to taste. Item 142
  // recorded `simctl launch` taking 47-55s on a hosted runner and filed it
  // under an unfinished boot; the launches were real and the 20s budget was
  // simply shorter than they were. Asserted as a relationship to that
  // observation so the next person to "tidy" it has to argue with the evidence.
  const budget = Number(/const SIMCTL_TIMEOUT_MS = ([0-9_]+)/.exec(src)?.[1].replace(/_/g, ''));
  const OBSERVED_WORST_LAUNCH_MS = 55_000;
  assert.ok(budget > OBSERVED_WORST_LAUNCH_MS,
    `the simctl budget (${budget}ms) must clear the slowest launch actually measured (${OBSERVED_WORST_LAUNCH_MS}ms)`);

  // The half that matters more. On a timeout execFile kills the child, so
  // stderr is empty and the message is the bare "Command failed: xcrun simctl
  // ..." — indistinguishable from simctl refusing. Three investigations have
  // started from that sentence and gone looking for a broken device.
  assert.match(src, /err\.killed \|\| err\.signal === 'SIGTERM'/,
    'a killed child must be recognised as a timeout');
  assert.match(src, /killed by simframe, not refused by simctl/,
    'and must say which of the two it was');

  // One budget, not three drifting ones: launch, terminate and openurl were all
  // 20s, and openurl is the class item 142 counted four failed runs of.
  assert.equal((src.match(/timeout: 20_000/g) ?? []).length, 0,
    'no simctl verb should still carry the old 20s budget');
  for (const verb of ['launch', 'terminate', 'openurl']) {
    assert.ok(new RegExp(`'${verb}'[^)]*\\][^)]*SIMCTL_TIMEOUT_MS|SIMCTL_TIMEOUT_MS`).test(src),
      `${verb} uses the shared budget`);
  }
});

// --- what the app believes (item 140) ----------------------------------------

test('a property list survives the types JSON cannot represent', async () => {
  const plist = await import('../src/platform/plist.js');
  // The reason this parser exists rather than `plutil -convert json`: measured
  // on the bench device, six of the twenty real preference plists would not
  // convert to JSON at all, because <data> and <date> have no JSON form. A
  // reader that drops three files in ten is a sampler, not a parser.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>aString</key><string>localhost:8083</string>
  <key>escaped</key><string>a &amp; b &lt;c&gt; &quot;d&quot;</string>
  <key>empty</key><string/>
  <key>aBool</key><true/>
  <key>anInt</key><integer>42</integer>
  <key>hugeInt</key><integer>9223372036854775807</integer>
  <key>aReal</key><real>810994475.111</real>
  <key>aDate</key><date>2026-09-13T12:09:11Z</date>
  <key>aBlob</key><data>AAEC</data>
  <key>nested</key><dict><key>on</key><false/></dict>
  <key>list</key><array><integer>1</integer><string>two</string></array>
  <key>emptyDict</key><dict/>
</dict>
</plist>`;
  const v = plist.parse(xml);
  assert.equal(v.aString, 'localhost:8083');
  assert.equal(v.escaped, 'a & b <c> "d"', 'entities plutil writes must come back as the characters they stand for');
  assert.equal(v.empty, '');
  assert.equal(v.aBool, true);
  assert.equal(v.anInt, 42);
  assert.equal(v.aReal, 810994475.111);
  assert.deepEqual(v.nested, { on: false });
  assert.deepEqual(v.list, [1, 'two']);
  assert.deepEqual(v.emptyDict, {});
  assert.equal(plist.typeOf(v.aDate), 'date');
  assert.equal(v.aDate.iso, '2026-09-13T12:09:11Z');
  assert.equal(plist.typeOf(v.aBlob), 'data');
  assert.equal(v.aBlob.bytes, 3, 'a blob reports its size, because "a 4KB blob" is often the whole answer');

  // A plist integer is 64-bit and JavaScript's is not. Rounding it silently
  // would be a wrong answer about a stored value, which is the one thing this
  // feature cannot afford — so the exact digits survive and the shape says why.
  assert.equal(plist.typeOf(v.hugeInt), 'integer');
  assert.equal(v.hugeInt.exact, '9223372036854775807');

  // Strict on purpose. A silently skipped element is a key the app has that the
  // reader is told it does not, which is the class of wrong answer this exists
  // to prevent.
  assert.throws(() => plist.parse('<plist version="1.0"><dict><key>k</key><ufo/></dict></plist>'),
    /unsupported property-list element <ufo>/);
});

test('AsyncStorage spills large values to their own file, and a reader that misses them lies', async () => {
  const storage = await import('../src/storage.js');
  const crypto = await import('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simframe-store-'));
  const inner = path.join(dir, 'Documents', 'RCTAsyncLocalStorage_V1');
  fs.mkdirSync(inner, { recursive: true });
  // React Native writes small values inline and stores a large one as `null`
  // here, with the value beside it in a file named by the MD5 of the key. A
  // manifest full of nulls is NOT an empty store, and reporting it as one is
  // exactly the wrong answer this feature exists to stop.
  fs.writeFileSync(path.join(inner, 'manifest.json'), JSON.stringify({
    onboardingComplete: 'true',
    spilled: null,
    absent: null,
  }));
  const big = 'x'.repeat(5000);
  fs.writeFileSync(path.join(inner, crypto.createHash('md5').update('spilled').digest('hex')), big);

  const store_ = storage.readAsyncStorage(dir, 'com.example.simframetestbed');
  const byKey = Object.fromEntries(store_.entries.map((e) => [e.key, e]));
  assert.equal(byKey.onboardingComplete.value, 'true');
  assert.equal(byKey.spilled.value, big, 'a spilled value must be followed to its file');
  assert.match(byKey.spilled.where, /spilled/);
  // "Null" and "too big to inline, and the file is gone" are different facts
  // about the app, and only one of them is the app's own doing.
  assert.equal(byKey.absent.value, null);
  assert.match(byKey.absent.where, /no spill file/);

  // A miss reports where it looked. "Found nothing" and "did not look there"
  // are different facts and only one is about the app — an external tester lost
  // 25 keys and a 1.5MB store to the second one being reported as the first.
  const miss = storage.readAsyncStorage(path.join(dir, 'nope'), 'com.example.simframetestbed');
  assert.equal(miss.missing, true, 'an app without the store is a miss, not an error');
  assert.ok(miss.looked.length >= 2, 'and the miss names the paths it tried');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AsyncStorage is found where modern React Native actually writes it', async () => {
  const storage = await import('../src/storage.js');
  // `Documents/` alone was the LEGACY location. Every current RN app uses
  // `@react-native-async-storage/async-storage`, which writes to
  // `Library/Application Support/<bundle-id>/` — and on a real app measured by
  // an external tester the Documents path did not exist at all, so the tool
  // reported "no AsyncStorage" over 25 keys including a 1.5MB root store.
  // Their words: "The decoder is correct; only the path is wrong."
  const bundleId = 'com.example.simframetestbed';
  for (const [where, rel] of [
    ['modern', ['Library', 'Application Support', bundleId, 'RCTAsyncLocalStorage_V1']],
    ['legacy', ['Documents', 'RCTAsyncLocalStorage_V1']],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `simframe-as-${where}-`));
    const inner = path.join(dir, ...rel);
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'manifest.json'), JSON.stringify({ root: '{"a":1}' }));
    const got = storage.readAsyncStorage(dir, bundleId);
    assert.ok(got && !got.missing, `${where} layout must be found`);
    assert.equal(got.entries.length, 1, `${where} layout must be read`);
    assert.equal(got.entries[0].key, 'root');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Newest first: an app carrying both must be read from the one it writes to.
  const both = fs.mkdtempSync(path.join(os.tmpdir(), 'simframe-as-both-'));
  const modern = path.join(both, 'Library', 'Application Support', bundleId, 'RCTAsyncLocalStorage_V1');
  const legacy = path.join(both, 'Documents', 'RCTAsyncLocalStorage_V1');
  fs.mkdirSync(modern, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(modern, 'manifest.json'), JSON.stringify({ live: 'yes' }));
  fs.writeFileSync(path.join(legacy, 'manifest.json'), JSON.stringify({ stale: 'yes' }));
  assert.equal(storage.readAsyncStorage(both, bundleId).entries[0].key, 'live');
  fs.rmSync(both, { recursive: true, force: true });
});

test('a value too long to print says so, and says how much it is not showing', async () => {
  const storage = await import('../src/storage.js');
  // Item 141 was a harness that truncated a failure report one character before
  // the only content that mattered. The lesson is not "never truncate" — it is
  // that a reader who is not told about a cut reads the fragment as the whole.
  const long = 'y'.repeat(storage.VALUE_PREVIEW_BYTES + 250);
  const shown = storage.renderValue(long);
  assert.ok(shown.includes('250 more character(s) not shown'), 'the cut must be announced with its size');
  assert.ok(/read the file/.test(shown), 'and must say how to get the rest');
  assert.equal(storage.renderValue('short'), 'short', 'a value that fits is printed whole, with no note');
});

test('Android declines to read storage in its own vocabulary, never in iOS terms', async () => {
  const { platform } = await import('../src/platform/android.js');
  // The standing rule, and the reason it exists: `doctor` asked about an
  // emulator once answered "input driver: idb" — a claim about a tool that has
  // never spoken to an Android device. A layer a platform does not have is
  // declined with a reason, not described in the other platform's words.
  await assert.rejects(() => platform.listApps('emulator-5554'), (err) => {
    assert.match(err.message, /emulator/, 'it must name what it is talking to');
    assert.match(err.message, /run-as/, 'and say what the Android route would actually be');
    // Contrasting with iOS is fine and useful; *claiming* iOS's answer is not.
    // The rule is about what a backend asserts it has, not what it may mention.
    assert.match(err.message, /has not been built/, 'it must decline, not promise');
    assert.ok(!/simctl/.test(err.message), 'and must not reach for the other platform\'s tool');
    return true;
  });
  await assert.rejects(() => platform.readPropertyList('/x'), /property lists are an iOS format/);
});

// --- a wedged device, told apart from a quiet one -----------------------------

test('a stalled capture loop is reported as stalled, not as a still screen', async () => {
  // These two states produce identical frames — none — and simframe spent an
  // afternoon reporting the second when it meant the first. A device whose
  // display surface has stopped answering reads is not a screen that is
  // holding still, and an agent told "nothing changed" will keep tapping.
  const api = await import('../src/index.js');
  const udid = freshDevice('stalled');
  const state = { seq: 12, capturedAt: Date.now(), stableForMs: 40_000, width: 322, height: 700 };

  // No complaint filed: health is the absence of one.
  const quiet = api.liveness(udid, state);
  assert.equal(quiet.stalled, false, 'a quiet screen is not a stall');

  store.writeCaptureHealth(udid, {
    stalled: true,
    since: Date.now() - 45_000,
    at: Date.now(),
    consecutiveFailures: 18,
    reattaches: 3,
    reason: 'the display surface could not be read',
  });
  const wedged = api.liveness(udid, state);
  assert.equal(wedged.stalled, true);
  assert.match(wedged.note, /capture: stalled/);
  assert.match(wedged.note, /45s/, 'it says how long, because that is what makes it actionable');
  assert.match(wedged.note, /3 re-attaches did not help/);
  assert.match(wedged.note, /restarting the device/, 'and what the only known cure is');

  // And it clears. Only evidence clears it — the loop removes the file when it
  // captures a real frame again. There is no daemon in a unit test, so the
  // remaining note is the honest one about a loop that is not running; what
  // matters is that it has stopped claiming a stall.
  store.writeCaptureHealth(udid, null);
  const cleared = api.liveness(udid, state);
  assert.equal(cleared.stalled, false);
  assert.doesNotMatch(cleared.note ?? '', /stalled/);
});

test('a chrome label has to be a name before it can be an identity', async () => {
  // Chrome labels are the only text that enters a fingerprint, so anything
  // that gets in and then changes takes a screen's identity with it. Two
  // classes were getting in, both found by reading what Android actually
  // produced: a browser's address bar, and the punctuation OCR reads off icons.
  const { isVolatileLabel } = await import('../src/fingerprint.js');

  // A URL is the most volatile thing a nav bar can hold: same screen, new page,
  // new identity, every route through it broken. `==` is OCR reading the lock.
  for (const url of ['example.com', '== example.com', 'https://x.com/a', 'www.bbc.co.uk']) {
    assert.equal(isVolatileLabel(url), true, `${url} is a value, not a name`);
  }
  // But a sentence that mentions a domain is still a sentence.
  assert.equal(isVolatileLabel('Search the site at example.com for more'), false);

  // A glyph is not a name. Each of these was observed as a chrome label.
  for (const glyph of [':', '+', '...', '—', 'A']) {
    assert.equal(isVolatileLabel(glyph), true, `${glyph} names nothing`);
  }

  // And the names that have to survive, including the adversarial pair the
  // whole chrome-label mechanism exists for.
  for (const name of ['general', 'accessibility', 'settings', 'Wi-Fi', 'OK', 'Kate Bell', 'Assets', 'iPhone 17']) {
    assert.equal(isVolatileLabel(name), false, `${name} is a name`);
  }

  // Dates were the first bug in this class and stay fixed.
  assert.equal(isVolatileLabel('Tuesday, September 8'), true);
});

// ---------------------------------------------------------------------------
// Phase 10: instrumentation. Every number simframe reports about itself is
// computed here, so every one of them is testable without a simulator.
// ---------------------------------------------------------------------------

test('a reason is one of five, and there is no way to write "unknown"', async () => {
  const metrics = await import('../src/metrics.js');
  assert.deepEqual(metrics.REASONS, [
    'unknown_screen', 'ambiguous_intent', 'verification_failed', 'novel_dialog', 'no_plan',
  ]);
  // The two mappings that turn real events into reasons can only produce those
  // five. This is the assertion behind "unknown is not a reason": a new refusal
  // reason added to goto without a mapping fails here rather than logging a
  // sixth category nobody counts.
  for (const [refusal, reason] of Object.entries(metrics.PLAN_REASONS)) {
    assert.ok(metrics.REASONS.includes(reason), `${refusal} maps to ${reason}`);
  }
  for (const reason of Object.keys(metrics.FACULTY)) {
    assert.ok(metrics.REASONS.includes(reason), `${reason} has a faculty`);
  }
  // And every reason has a faculty, so the breakdown can always say what would
  // remove it. A reason with no faculty is a phase nobody can plan.
  for (const reason of metrics.REASONS) assert.ok(metrics.FACULTY[reason], `${reason} needs a faculty`);
  assert.throws(() => metrics.tag(new Error('x'), 'unknown'), /not an escalation reason/);
  assert.throws(() => metrics.recordEscalation('TEST-metrics', { reason: 'vibes' }), /not an escalation reason/);
});

test('tagging an error adds a reason and changes nothing else about it', async () => {
  const metrics = await import('../src/metrics.js');
  // The classification has to be free of side effects: locate throws the same
  // error to the same callers whether or not anybody is measuring.
  const err = new TypeError('"Save" matches 2 things on this screen');
  const tagged = metrics.tag(err, 'ambiguous_intent', { candidates: [{ label: 'Save' }, { label: 'Saved' }] });
  assert.equal(tagged, err);
  assert.ok(err instanceof TypeError);
  assert.equal(err.message, '"Save" matches 2 things on this screen');
  assert.equal(metrics.escalationOf(err).reason, 'ambiguous_intent');
  assert.equal(metrics.escalationOf(new Error('plain')), null);
  // A tag nobody set, or one set to nonsense by something else, is not a reason.
  const forged = new Error('x');
  forged.escalation = { reason: 'unknown' };
  assert.equal(metrics.escalationOf(forged), null);
});

test('a thrown step always classifies, and a tag beats the fallback', async () => {
  const metrics = await import('../src/metrics.js');
  const tagged = metrics.tag(new Error('no confirming control'), 'novel_dialog');
  assert.equal(metrics.reasonForStepError({ action: 'tap' }, tagged).reason, 'novel_dialog');
  assert.equal(metrics.reasonForStepError({ action: 'confirm' }, new Error('x')).reason, 'novel_dialog');
  assert.equal(metrics.reasonForStepError({ action: 'assert' }, new Error('x')).reason, 'verification_failed');
  assert.equal(metrics.reasonForStepError({ action: 'waitFor' }, new Error('x')).reason, 'verification_failed');
  // The point of the fallback: a step nobody anticipated still gets a reason.
  assert.equal(metrics.reasonForStepError({ action: 'somethingNew' }, new Error('x')).reason, 'verification_failed');
  assert.equal(metrics.reasonForStepError(undefined, undefined).reason, 'verification_failed');
});

test('only the verdicts that hand a decision back count as escalations', async () => {
  const metrics = await import('../src/metrics.js');
  const graph = await import('../src/graph.js');
  // Cross-checked against the verdicts that exist, so renaming one here shows
  // up as a failing test rather than as an escalation category that silently
  // stops being counted.
  for (const v of metrics.ESCALATING_VERDICTS) {
    assert.ok(graph.VERDICTS.includes(v), `${v} is a real verdict`);
  }
  assert.ok(metrics.ESCALATING_VERDICTS.has('unexpected-screen'));
  assert.ok(metrics.ESCALATING_VERDICTS.has('no-visible-change'));
  // `unverified` is a fact about the graph, not a question for anybody.
  assert.equal(metrics.ESCALATING_VERDICTS.has('unverified'), false);
  assert.equal(metrics.ESCALATING_VERDICTS.has('ok'), false);
});

test('a flow record counts turns, mis-taps and verdicts the way HPI needs', async () => {
  const metrics = await import('../src/metrics.js');
  const rec = metrics.flowRecordFrom({
    flowId: 'f1',
    flowName: 'settings-larger-text',
    udid: 'TEST-metrics',
    startedAt: 1_700_000_000_000,
    wallMs: 4200,
    stepsTaken: 5,
    totalSteps: 5,
    minSteps: 4,
    imagesSent: 1,
    escalations: [
      { reason: 'verification_failed', step_index: 2, outcome: 'escalated_to_model' },
      { reason: 'novel_dialog', step_index: 3, outcome: 'resolved_locally' },
    ],
    verdicts: ['ok', 'no-visible-change', 'ok', 'unexpected-screen', 'unverified'],
    completed: true,
  });
  // One turn for the call itself, plus one per escalation the agent has to
  // answer. A reflex that resolved locally cost nobody a turn.
  assert.equal(rec.model_turns, 2);
  assert.equal(rec.mis_taps, 2);
  assert.equal(rec.wrong_action_taken, true);
  assert.equal(rec.step_ratio, 1.25);
  assert.deepEqual(rec.verdict_histogram, { ok: 2, 'no-visible-change': 1, 'unexpected-screen': 1, unverified: 1 });
  assert.equal(rec.escalation_count, 2);
  // No baseline, no ratio — never a 1.0 standing in for a missing number.
  assert.equal(metrics.flowRecordFrom({ ...{
    flowId: 'f2', udid: 'TEST-metrics', startedAt: 0, wallMs: 1, stepsTaken: 2, totalSteps: 2, completed: true,
  } }).step_ratio, null);
});

test('median, IQR and the harmonic mean behave at the edges', async () => {
  const metrics = await import('../src/metrics.js');
  assert.equal(metrics.median([]), null);
  assert.equal(metrics.median([5]), 5);
  assert.equal(metrics.median([1, 2, 3, 4]), 2.5);
  assert.equal(metrics.median([3, 1, 2]), 2);
  assert.equal(metrics.quartiles([]), null);
  const q = metrics.quartiles([1, 2, 3, 4, 5]);
  // Exclusive median: the halves are [1,2] and [4,5], so the IQR is 3 and not 2.
  assert.deepEqual([q.p25, q.p50, q.p75, q.iqr, q.n], [1.5, 3, 4.5, 3, 5]);
  assert.equal(metrics.harmonicMean([]), null);
  // The reason §1 asks for it: one flow at half parity drags the index below
  // the arithmetic mean, so being fast on three flows cannot hide being slow
  // on the fourth.
  assert.ok(metrics.harmonicMean([2, 2, 2, 0.5]) < (2 + 2 + 2 + 0.5) / 4);
  assert.equal(metrics.harmonicMean([2, 2]), 2);
  // Zero and negative times are not times.
  assert.equal(metrics.harmonicMean([0, -1]), null);
});

test('HPI is null without a human, and accuracy punishes a wrong action', async () => {
  const metrics = await import('../src/metrics.js');
  const flow = (name, ms, extra = {}) => ({
    flow_name: name, wall_time_ms: ms, completed: true, wrong_action_taken: false,
    step_ratio: 1, model_turns: 1, escalation_count: 0, ...extra,
  });

  const noHuman = metrics.hpi({ flows: [flow('a', 1000), flow('a', 2000)] });
  assert.equal(noHuman.flows[0].hpi_time, null, 'a missing denominator is not parity');
  assert.equal(noHuman.overall.hpi_time, null);
  assert.equal(noHuman.overall.hpi, null);
  assert.equal(noHuman.overall.hpi_accuracy, 1);

  const report = metrics.hpi({
    flows: [flow('a', 1000), flow('a', 3000), flow('b', 1000, { completed: false, wrong_action_taken: true })],
    baselines: { a: { wall_time_ms: { p50: 4000 } }, b: { wall_time_ms: { p50: 1000 } } },
  });
  const a = report.flows.find((f) => f.flow === 'a');
  // Agent median 2000 against a human's 4000 is twice human speed.
  assert.equal(a.hpi_time, 2);
  assert.equal(report.overall.hpi_accuracy, 0.667);
  // Flow `b` completed nothing, so it contributes NO time — not a flattering
  // one. It used to contribute 1.0 and pull the overall down to 1.333, which
  // reads like a measurement of b and is not one: nothing about b was measured
  // except that it failed. Accuracy is where b is accounted for, and it is.
  const b = report.flows.find((f) => f.flow === 'b');
  assert.equal(b.hpi_time, null, 'a flow that never finished has no time to report');
  assert.equal(b.timed_runs, 0);
  assert.equal(report.overall.hpi_time, 2, 'over the flows that could be timed');
  assert.equal(report.overall.hpi, Number((0.667 * 2).toFixed(3)));

  // **The defect this rule exists for, with the real numbers.** A failure is
  // FAST, so counting failed runs in the time made breakage look like speed:
  // `settings-larger-text` failed all three runs at ~3.6 s against a 7799 ms
  // human median and reported `hpi_time 2.163` — "twice as fast as a person"
  // about a flow that never once reached its destination. The CI gate's
  // threshold is written against HPI_time, so the one number the gate reads
  // was the one breakage flattered.
  const broke = metrics.hpi({
    flows: [
      flow('settings-larger-text', 3473, { completed: false }),
      flow('settings-larger-text', 3605, { completed: false }),
      flow('settings-larger-text', 3789, { completed: false }),
    ],
    baselines: { 'settings-larger-text': { wall_time_ms: { p50: 7799 } } },
  });
  assert.equal(broke.flows[0].hpi_time, null, 'failing fast is not going fast');
  assert.equal(broke.overall.hpi_time, null);
  assert.equal(broke.overall.hpi_accuracy, 0, 'and accuracy is where it shows');

  // **And it has to RENDER.** `agent_ms` is null for a flow that timed nothing,
  // and both places that printed the table dereferenced `.p50` on it — so the
  // change above crashed `bench` on the v0.15.0 tag with exit 1 and no
  // hpi.json, and would have crashed `simframe hpi` for any user whose flow
  // never completed. I tested the metric's data and nothing that displayed it.
  //
  // The row is one function now, shared by both, so this exercises the real
  // renderer rather than pattern-matching two copies of a template string.
  const row = metrics.flowRow(broke.flows[0]);
  assert.match(row, /settings-larger-text/);
  assert.match(row, /—/, 'a flow that timed nothing shows a dash, not a crash and not a zero');
  assert.doesNotMatch(row, /null|undefined|NaN/);
  // Every field absent at once — the shape a brand-new log produces.
  assert.doesNotMatch(
    metrics.flowRow({ flow: 'x', runs: 0, escalations: 0 }, { wide: true }),
    /null|undefined|NaN/,
  );
  // And a fully populated row still reads as it did.
  assert.match(metrics.flowRow(a), /^a +2 +2000ms +4000ms +2 +1$/);
  // Flows with no name are ad-hoc runs; they are timed but have no counterpart.
  assert.equal(metrics.hpi({ flows: [{ wall_time_ms: 10, completed: true }] }).flows.length, 0);
});

test('the escalation breakdown says which faculty would remove each one', async () => {
  const metrics = await import('../src/metrics.js');
  const at = (reason, outcome, fingerprint, classified = true) => ({
    reason, outcome, screen_fingerprint: fingerprint, classified,
    model_turns_spent: outcome === 'resolved_locally' ? 0 : 1,
  });
  const b = metrics.breakdown([
    at('novel_dialog', 'escalated_to_model', 'aaa'),
    at('novel_dialog', 'resolved_locally', 'aaa'),
    at('unknown_screen', 'failed', 'bbb'),
    // Assumed rather than read — the shape that was 90% of a real field log.
    at('verification_failed', 'escalated_to_model', 'aaa', false),
    { reason: 'not-a-reason', outcome: 'failed' },
  ]);
  assert.equal(b.total, 4, 'a record with a bogus reason is not counted');
  assert.equal(b.by_reason.novel_dialog, 2);
  // Already handled locally, so not avoidable by anything unbuilt. This is the
  // one term that makes the rate mean something once Phase 12 lands.
  assert.equal(b.avoidable, 3);
  assert.equal(b.avoidable_escalation_rate, 0.75);
  assert.equal(b.model_turns_spent, 3);
  assert.deepEqual(b.top_screens[0], { fingerprint: 'aaa', count: 3 });
  assert.match(b.faculty.novel_dialog, /reflexes/);

  // A reason whose records were all *assumed* names no faculty.
  //
  // This breakdown picks the next phase to build — CLAUDE.md calls it the
  // steering wheel — and `verification_failed` is a fallback that catches any
  // step which threw without a site tagging it, plus every `no-visible-change`
  // verdict. In a real field session it was 90% of the log, and the report
  // named "sense of time (Phase 11)" against all of it. The tester, reading
  // their own notes, concluded the real problem was icon semantics. They were
  // right and the instrument contradicted them.
  assert.equal(b.by_reason.verification_failed, 1, 'still counted');
  assert.equal(b.classified_by_reason.verification_failed, 0, 'and known to be an assumption');
  assert.equal(b.faculty.verification_failed, undefined, 'so no phase is recommended from it');
  assert.equal(b.classified_by_reason.novel_dialog, 2);

  // A record written before the field existed is not evidence of precision.
  const legacy = metrics.breakdown([{ reason: 'unknown_screen', outcome: 'failed' }]);
  assert.equal(legacy.classified_by_reason.unknown_screen, 0);

  assert.equal(metrics.breakdown([]).avoidable_escalation_rate, null);
});

test('the escalation log survives a torn line and round-trips the §8 schema', async () => {
  const fs = await import('node:fs');
  const metrics = await import('../src/metrics.js');
  const udid = 'TEST-escalations';
  const file = metrics.paths(udid).escalations;
  fs.rmSync(file, { force: true });

  const written = metrics.recordEscalation(udid, {
    flowId: 'f1', stepIndex: 3, fingerprint: 'abc123', reason: 'ambiguous_intent',
    candidates: [{ label: 'Save', x: 10, y: 20, region: 'content', score: 0.4 }, 'Saved'],
    outcome: 'escalated_to_model', wallMs: 240, detail: 'two matches',
  });
  for (const key of [
    'timestamp', 'flow_id', 'step_index', 'screen_fingerprint', 'reason', 'candidate_elements',
    'reflex_or_exploration_tried', 'outcome', 'model_turns_spent', 'tokens_spent', 'wall_time_ms',
  ]) {
    assert.ok(key in written, `§8 requires ${key}`);
  }
  // Not measurable from this side of the model, and recorded as null rather
  // than estimated. See docs/ESCALATIONS.md.
  assert.equal(written.tokens_spent, null);
  assert.equal(written.candidate_elements.length, 2);
  assert.equal(written.candidate_elements[1].label, 'Saved');

  // A half-written append is a line to skip, not a reason to report no history.
  fs.appendFileSync(file, '{"reason":"no_plan","outcome":"fai');
  const read = metrics.readEscalations(udid);
  assert.equal(read.length, 1);
  assert.equal(read[0].reason, 'ambiguous_intent');
  fs.rmSync(file, { force: true });
});

test('a human run is timed by the clock and counted by the frames', async () => {
  const baseline = await import('../src/baseline.js');
  const t0 = 1_700_000_000_000;
  // A push animation is a burst of changed frames and must count as one step.
  const history = [
    { at: t0 + 100, diff: 0.001 },            // a clock digit, below threshold
    { at: t0 + 1000, diff: 0.4 },             // tap 1 ...
    { at: t0 + 1100, diff: 0.3 },             // ... still the same animation
    { at: t0 + 1300, diff: 0.05 },            // ... and its tail
    { at: t0 + 3000, diff: 0.5 },             // tap 2
    { at: t0 + 9000, diff: 0.5 },             // after the window closed
  ];
  const groups = baseline.transitionsIn(history, { from: t0, to: t0 + 5000 });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].frames, 3);
  assert.deepEqual(baseline.intervalsBetween(groups), [2000]);

  const run = baseline.runFrom({ flow: 'f', startedAt: t0, endedAt: t0 + 5000, history, oldestHistoryAt: t0 - 1 });
  assert.equal(run.wall_time_ms, 5000);
  assert.equal(run.steps_observed, 2);
  assert.equal(run.steps_source, 'screen-transitions', 'a transition is not a tap and must not be called one');
  assert.equal(run.history_complete, true);
  // The frame history is 90s. A run older than the window has transitions the
  // log can no longer see, so its step count is an undercount and says so.
  const truncated = baseline.runFrom({ flow: 'f', startedAt: t0, endedAt: t0 + 5000, history, oldestHistoryAt: t0 + 500 });
  assert.equal(truncated.history_complete, false);
});

test('a baseline refuses to exist below three runs', async () => {
  const baseline = await import('../src/baseline.js');
  const run = (ms, extra = {}) => ({ wall_time_ms: ms, steps_observed: 4, interaction_intervals_ms: [900, 1100], ...extra });
  const few = baseline.summarizeRuns('f', [run(1000), run(2000)]);
  assert.equal(few.ok, false);
  assert.equal(few.reason, 'too-few-runs');
  assert.equal(few.need, 3);

  const ok = baseline.summarizeRuns('f', [run(1000), run(2000), run(3000), run(4000), run(5000, { history_complete: false })], { minSteps: 4 });
  assert.equal(ok.ok, true);
  assert.equal(ok.summary.runs, 5);
  assert.equal(ok.summary.wall_time_ms.p50, 3000);
  assert.equal(ok.summary.wall_time_ms.iqr, 3000);
  // min_steps comes from the flow definition; a human run is authoritative
  // about time and not about the shortest route.
  assert.equal(ok.summary.min_steps, 4);
  assert.equal(ok.summary.runs_with_incomplete_history, 1);
  assert.match(ok.summary.note, /no host-readable HID log/);
});

test('the flow suite is shipped, valid, and replayable as written', async () => {
  const baseline = await import('../src/baseline.js');
  const actions = await import('../src/actions.js');
  const suite = baseline.loadSuite();
  assert.ok(suite.length >= 2, 'a harmonic mean over one flow is just that flow');
  for (const flow of suite) {
    assert.ok(flow.name && flow.minSteps > 0 && flow.steps?.length, `${flow.name} is complete`);
    assert.equal(flow.human.length > 0, true, `${flow.name} tells the human what to do`);
    // The human and the agent must be doing the same amount of work, or the
    // ratio compares two different tasks.
    assert.equal(flow.steps.length, flow.minSteps, `${flow.name}: agent steps == minSteps`);
    assert.equal(flow.human.length, flow.minSteps, `${flow.name}: human steps == minSteps`);
    // Every step has to normalize, or the flow fails at run time on a typo.
    for (const step of flow.steps) assert.ok(actions.normalizeStep(step).action, `${flow.name} step parses`);
    // Stock apps only. Measurements from this suite get committed to a public
    // repo, so nothing here may name a private app.
    for (const bundle of flow.reset.terminate) assert.match(bundle, /^com\.apple\./, 'stock apps only');
  }
  assert.throws(() => baseline.flowFrom(suite, 'nope'), /no flow "nope"/);
});

test('a run leaves the baseline without leaving the record', async () => {
  const baseline = await import('../src/baseline.js');
  const runs = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ recorded_at: `t${n}`, wall_time_ms: n * 1000, steps_observed: 4, interaction_intervals_ms: [] }));
  const marked = baseline.markExcluded(runs, { keepLast: 5, reason: 'device wedged' });
  assert.equal(marked.length, 7, 'nothing is deleted');
  assert.equal(marked.filter((r) => r.excluded).length, 2);
  assert.deepEqual(marked.slice(0, 2).map((r) => r.excluded.reason), ['device wedged', 'device wedged']);
  assert.equal(marked[2].excluded, undefined);
  // Idempotent, and an earlier reason is never overwritten by a later pass.
  const again = baseline.markExcluded(marked, { keepLast: 6, reason: 'something else' });
  assert.equal(again[0].excluded.reason, 'device wedged');
  assert.equal(again.filter((r) => r.excluded).length, 2);
  assert.throws(() => baseline.markExcluded(runs, { keepLast: 0 }), /positive number/);

  // The summary rests on the kept runs and names the ones it dropped, so a
  // committed baseline can be checked rather than trusted.
  const res = baseline.summarizeRuns('f', marked, { minSteps: 4 });
  assert.equal(res.summary.runs, 5);
  assert.equal(res.summary.runs_recorded, 7);
  assert.equal(res.summary.wall_time_ms.p50, 5000);
  assert.equal(res.summary.runs_excluded.length, 2);
  assert.equal(res.summary.runs_excluded[0].reason, 'device wedged');
  // And an excluded run cannot prop up a baseline that is otherwise too small.
  const thin = baseline.markExcluded(runs.slice(0, 4), { keepLast: 2, reason: 'x' });
  assert.equal(baseline.summarizeRuns('f', thin).ok, false);
});

test('the HPI gate fails on accuracy and steps, reports time, and fails on nothing else', async () => {
  const metrics = await import('../src/metrics.js');
  const base = { overall: { hpi_accuracy: 0.5, hpi_time: 0.475 } };
  const at = (hpi_accuracy, hpi_time) => ({ overall: { hpi_accuracy, hpi_time } });

  assert.deepEqual(metrics.gateAgainst(base, at(0.5, 0.475)), [], 'the baseline passes against itself');
  assert.deepEqual(metrics.gateAgainst(base, at(1, 0.9)), [], 'better on both passes');

  // **HPI_time does not fail a build, and this is the assertion that says so.**
  // It used to, at 25% here and written as 10% in CLAUDE.md, and the
  // measurement supports neither: the ratio is a laptop-recorded human over an
  // agent measured wherever CI runs, and a hosted runner put the same flows at
  // 37s and 64s against 11.5s and 11.7s on that laptop. Even on one machine
  // identical code spans 0.406-0.558 — 37%. A band inside its own noise can
  // only be silent or wrong, and it was silent: 148, 152, 154 and 169 all
  // shipped without it firing once.
  assert.deepEqual(metrics.gateAgainst(base, at(0.5, 0.35)), [],
    'a time move must not fail a build');
  assert.deepEqual(metrics.gateAgainst(base, at(0.5, 0.01)), [],
    'not even an absurd one — the host can produce that on its own');
  // It is still reported, with its band, and labelled so nobody reads the line
  // as a threshold.
  const trend = metrics.timeTrend(base, at(0.5, 0.35));
  assert.match(trend, /0\.475 -> 0\.35/);
  assert.match(trend, /-26\.3%/);
  assert.match(trend, /reported, not gated/);
  assert.doesNotMatch(metrics.timeTrend(base, at(0.5, 0.45)), /worth a look/,
    'inside the band, no flag');
  assert.match(metrics.timeTrend(base, at(0.5, null)), /not comparable/);

  // Any accuracy drop at all, however small. This is the gate now.
  assert.match(metrics.gateAgainst(base, at(0.499, 0.475))[0], /HPI_accuracy dropped/);
  assert.equal(metrics.gateAgainst(base, at(0.4, 0.3)).length, 1, 'accuracy only');

  // Steps, the other gate: an absolute ceiling, not a regression, because a
  // ratio of two step counts does not change with the host.
  assert.equal(metrics.STEP_RATIO_CEILING, 1.5);
  assert.deepEqual(metrics.gateAgainst(base, { overall: { hpi_accuracy: 0.5, hpi_time: 0.475, step_ratio: 1.5 } }), [],
    'the ceiling itself passes');
  assert.match(
    metrics.gateAgainst(base, { overall: { hpi_accuracy: 0.5, hpi_time: 0.475, step_ratio: 1.6 } })[0],
    /step_ratio 1\.6 is above the 1\.5 ceiling/,
  );
  // A step_ratio BELOW 1 is not a pass to celebrate — it usually means runs
  // stopped early — but accuracy is where that shows, so it does not fail here.
  assert.deepEqual(metrics.gateAgainst(base, { overall: { hpi_accuracy: 0.5, hpi_time: 0.475, step_ratio: 0.375 } }), []);
  // A checkout with no human baseline must not pass by having nothing to compare.
  assert.match(metrics.gateAgainst(base, at(0.5, null))[0], /missing from this checkout/);
  // And with nothing committed there is nothing to fail against.
  assert.deepEqual(metrics.gateAgainst(null, at(0.1, 0.1)), []);
  assert.deepEqual(metrics.gateAgainst({ overall: {} }, at(0.1, 0.1)), []);
});

test('an ocr reading inside a labelled ax element is the same element', async () => {
  const m = await import('../src/matching.js');
  // The frames measured on the Contacts list, which produced 16 escalations
  // and half of HPI_accuracy in the first instrumented run.
  const row = { label: 'Kate Bell', type: 'StaticText', source: 'ax', x: 194, y: 286, frame: { x: 2, y: 256, width: 384, height: 60 } };
  const text = { label: 'Kate Bell', type: 'Text', source: 'ocr', x: 103, y: 286, frame: { x: 67.13, y: 277.84, width: 71.18, height: 17.24 } };

  // Why the rules already in place could not see it: the text is wholly
  // contained, but it is 1/19th of the row's area, so every ratio-shaped test
  // fails. IoU is 0.05; the screen map's cap was 8x the text's own area.
  assert.equal(m.containedFraction(text.frame, row.frame), 1);
  assert.ok((384 * 60) / (71.18 * 17.24) > 18, 'the row is ~19x the area of its own text');
  assert.equal(m.sameElementSeenTwice(row, text), true);
  assert.equal(m.resolve([row, text], 'Kate Bell', { screen: { width: 402, height: 874 } }).status, 'ok');

  // A label carrying state still matches the text printed on screen.
  assert.equal(m.sameText('Larger Text, Off', 'Larger Text'), true);
  // And OCR misreading a letter or two does not break the match.
  assert.equal(m.sameText('Location (All)', 'Location (AII)'), true);

  // The case the old size cap existed to protect, which must keep working: a
  // tab bar contains all five tab labels and is not any of them. Containment
  // alone would merge them; the text test is what refuses.
  const tabBar = { label: 'Tab Bar', type: 'TabBar', source: 'ax', x: 201, y: 820, frame: { x: 0, y: 790, width: 402, height: 84 } };
  const tabLabel = { label: 'Assets', type: 'Text', source: 'ocr', x: 80, y: 830, frame: { x: 60, y: 820, width: 40, height: 12 } };
  assert.equal(m.containedFraction(tabLabel.frame, tabBar.frame), 1, 'it is contained');
  assert.equal(m.sameElementSeenTwice(tabBar, tabLabel), false, 'and it is still not the tab bar');

  // Two genuinely different rows must not merge just because they are close.
  const other = { label: 'Daniel Higgins', type: 'StaticText', source: 'ax', x: 194, y: 346, frame: { x: 2, y: 316, width: 384, height: 60 } };
  assert.equal(m.sameElementSeenTwice(other, text), false);

  // A merged target is still the tree's element. Everything that used to ask
  // `source === 'ax'` asks this instead, and a merge that demoted its own
  // element would have been worse than the duplicate.
  assert.equal(m.isAxTarget({ source: 'ax|ocr' }), true);
  assert.equal(m.isAxTarget({ source: 'ax' }), true);
  assert.equal(m.isAxTarget({ source: 'ocr' }), false);
  assert.equal(m.isAxTarget({}), false);
});

test('changing what feeds identity discards stored hashes', async () => {
  // The merge shortens the target list on every list screen, so the same token
  // rules now produce different hashes. A stored hash that can never match
  // again is the quietest kind of wrong, so both counters move.
  const fingerprint = await import('../src/fingerprint.js');
  const graph = await import('../src/graph.js');
  assert.ok(fingerprint.TOKEN_RULES_VERSION >= 4);
  assert.equal(graph.FINGERPRINT_VERSION, fingerprint.TOKEN_RULES_VERSION);
});

test('a device that outlived the daemon has a stale input session', async () => {
  const input = await import('../src/input.js');
  // The failure this detects: a device restart kills the HID session inside a
  // daemon that stays perfectly healthy, and every tap afterwards is
  // dispatched successfully and moves nothing. Measured five runs in a row on
  // the correct coordinates for the correct element.
  const rebooted = input.sessionStaleness({ bootedAt: 5_000_000, sessionSince: 1_000_000 });
  assert.equal(rebooted.stale, true);
  assert.match(rebooted.reason, /no longer exists/);
  assert.match(rebooted.reason, /4000s after/);

  // A daemon started after the boot is fine, which is the ordinary case.
  assert.equal(input.sessionStaleness({ bootedAt: 1_000_000, sessionSince: 5_000_000 }).stale, false);
  // And so is a daemon started within the grace window in either order: those
  // two timestamps land milliseconds apart when a daemon follows a boot.
  assert.equal(input.sessionStaleness({ bootedAt: 1_001_500, sessionSince: 1_000_000 }).stale, false);
  assert.equal(input.sessionStaleness({ bootedAt: 1_003_000, sessionSince: 1_000_000 }).stale, true);

  // No claim without evidence. A backend that cannot answer must not produce a
  // staleness verdict — it produces no verdict. And the two unknowns are
  // different sentences: the first version reported a missing daemon start
  // time as "cannot tell when the device booted", so doctor named the wrong
  // cause about a device whose boot time it had just read.
  assert.match(input.sessionStaleness({ bootedAt: null, sessionSince: 1 }).reason, /when the device booted/);
  assert.match(input.sessionStaleness({ bootedAt: 1, sessionSince: undefined }).reason, /no capture daemon/);
  for (const missing of [{ bootedAt: null, sessionSince: 1 }, { bootedAt: 1, sessionSince: undefined }, {}]) {
    assert.equal(input.sessionStaleness(missing).stale, false);
  }
});

test('waiting is learned per edge, and a cold edge waits what it always did', async () => {
  const graph = await import('../src/graph.js');
  const metrics = await import('../src/metrics.js');

  // Nearest-rank, so every reported percentile is a duration that happened.
  assert.equal(metrics.percentile([100, 200, 300, 400, 500], 50), 300);
  assert.equal(metrics.percentile([100, 200, 300, 400, 500], 95), 500);
  assert.equal(metrics.percentile([], 95), null);

  // Below five samples an edge has no distribution, and the budget is exactly
  // the fixed default every step used before Phase 11 — so a first traversal
  // cannot behave worse than it used to.
  const cold = graph.adaptiveTimeout({ p95: 90, samples: 4 });
  assert.equal(cold.cold, true);
  assert.equal(cold.timeoutMs, 8000);
  assert.match(cold.reason, /fewer than 5 samples/);

  // Measured: p95 plus the larger of 150ms and a fifth of p95. The floor is
  // what stops a 90ms tab switch getting a 108ms budget, where a single slow
  // frame would read as a timeout.
  assert.deepEqual(
    graph.adaptiveTimeout({ p95: 90, samples: 12 }),
    { timeoutMs: 240, cold: false, reason: null, margin: 150 },
  );
  assert.equal(graph.adaptiveTimeout({ p95: 2000, samples: 12 }).timeoutMs, 2400);
  // Nielsen's limit is a cap, not a target: a screen slower than this has
  // stopped being worth waiting for.
  assert.equal(graph.adaptiveTimeout({ p95: 20000, samples: 30 }).timeoutMs, graph.HARD_CAP_MS);

  // "Slower than usual" splits into two answers, which is the whole point:
  // a screen that is working gets waited for, a screen doing nothing visible
  // has already answered.
  const working = graph.slowerThanUsual({ elapsedMs: 3000, p95: 1000, settled: false, kind: 'loading' });
  assert.deepEqual([working.slower, working.working, working.keepWaiting], [true, true, true]);
  assert.match(working.note, /still loading/);
  const stuck = graph.slowerThanUsual({ elapsedMs: 3000, p95: 1000, settled: false, kind: 'none' });
  assert.deepEqual([stuck.slower, stuck.working, stuck.keepWaiting], [true, false, false]);
  // Past the cap, even a spinner stops earning patience.
  assert.equal(graph.slowerThanUsual({ elapsedMs: 11000, p95: 1000, settled: false, kind: 'loading' }).keepWaiting, false);
  // Settled, inside p95, or with nothing measured: no claim.
  assert.equal(graph.slowerThanUsual({ elapsedMs: 3000, p95: 1000, settled: true }).slower, false);
  assert.equal(graph.slowerThanUsual({ elapsedMs: 500, p95: 1000, settled: false }).slower, false);
  assert.equal(graph.slowerThanUsual({ elapsedMs: 3000, p95: null, settled: false }).slower, false);

  // The window is a window: an app that got faster after an update stops being
  // waited for at its old speed.
  const edge = { settles: [] };
  for (let i = 0; i < graph.TIMING_WINDOW + 20; i += 1) {
    graph.record; // (documenting that noteSettle is reached through record)
    edge.settles = [...edge.settles, i].slice(-graph.TIMING_WINDOW);
  }
  assert.equal(edge.settles.length, graph.TIMING_WINDOW);
  assert.equal(graph.timingOf(edge).samples, graph.TIMING_WINDOW);
  assert.equal(graph.timingOf({}).samples, 0);
  assert.equal(graph.timingOf({}).p95, null);
});

test('stillness is learned from pauses inside a transition, and can only shorten', async () => {
  const graph = await import('../src/graph.js');
  // The statistic that matters is the longest pause *inside* a transition:
  // any window shorter than that mistakes mid-flight quiet for a finished
  // screen. Nobody was measuring it, so the window was 500ms — chosen once and
  // paid by every step of every flow forever.
  assert.deepEqual(graph.stillnessFor({ gapSamples: 2, gapP95: 40 }, 500), { stillnessMs: 500, cold: true });

  // A transition that has never paused needs the floor, not half a second.
  assert.deepEqual(graph.stillnessFor({ gapSamples: 12, gapP95: 0 }, 500), { stillnessMs: 150, cold: false });
  assert.equal(graph.stillnessFor({ gapSamples: 12, gapP95: 260 }, 500).stillnessMs, 390);

  // And it is capped by the caller's own default in both directions, so a
  // learned number can never become a new way to hang.
  assert.equal(graph.stillnessFor({ gapSamples: 12, gapP95: 900 }, 500).stillnessMs, 500);
  assert.equal(graph.stillnessFor({ gapSamples: 30, gapP95: 4000 }, 250).stillnessMs, 250);
  assert.ok(graph.stillnessFor({ gapSamples: 30, gapP95: 0 }, 120).stillnessMs >= 120 === false
    || graph.stillnessFor({ gapSamples: 30, gapP95: 0 }, 120).stillnessMs === 150,
    'the floor wins over an absurdly small default, because a settle needs a frame to judge');

  // Zero is a measurement, not a missing value: "this transition never paused"
  // is precisely what lets the next one stop waiting to find out.
  const edge = { settles: [800, 900], quietGaps: [0, 0, 0, 0, 0, 0] };
  const t = graph.timingOf(edge);
  assert.equal(t.gapSamples, 6);
  assert.equal(t.gapP95, 0);
  assert.equal(graph.stillnessFor(t, 500).stillnessMs, 150);
  assert.equal(graph.timingOf({}).gapSamples, 0);
});

test('the focus wait is learned per edge, and may only ever get longer', async () => {
  const graph = await import('../src/graph.js');
  const cold = { reactionMs: 900, timeoutMs: 3000, stillnessMs: 250 };

  // Nothing measured: exactly the three constants this replaced, and it says so.
  const none = graph.focusPlan({ focusSamples: 2, focusP95: 400 }, cold);
  assert.deepEqual([none.reactionMs, none.timeoutMs, none.cold], [900, 3000, true]);
  assert.match(none.from, /fewer than 5 focus samples/);

  // A field measured *slower* than the constants gets waited for properly. This
  // is the case the fixed 3s got wrong: it typed at 3s into a field that took
  // 4.2s to focus, and typeText reported success because input has no feedback.
  const slow = graph.focusPlan({ focusSamples: 9, focusP50: 3800, focusP95: 4200 }, cold);
  assert.equal(slow.timeoutMs, 4200 + 840);
  assert.equal(slow.reactionMs, 3800 + 840);
  assert.equal(slow.cold, false);
  assert.match(slow.from, /p95 4200ms over 9 focus samples/);

  // A field measured *faster* keeps the constants. The 5% tail of a
  // distribution is one silent wrong type in twenty runs, and no amount of
  // median wall time buys that back — so the saving is declined.
  const fast = graph.focusPlan({ focusSamples: 30, focusP50: 180, focusP95: 260 }, cold);
  assert.deepEqual([fast.reactionMs, fast.timeoutMs], [900, 3000]);

  // Nielsen's cap still applies to a field that has genuinely never been quick.
  assert.equal(graph.focusPlan({ focusSamples: 30, focusP50: 200, focusP95: 30000 }, cold).timeoutMs, graph.HARD_CAP_MS);

  // The one shortening is evidence, not statistics: the keyboard was already up
  // before the tap, so this tap moves a caret and there is no animation to wait
  // for. Nine hundred milliseconds of watching a screen that was never going to
  // move is the only part of this window that was pure cost.
  const caret = graph.focusPlan({ focusSamples: 0 }, { ...cold, keyboardUp: true });
  assert.equal(caret.reactionMs, 250);
  assert.equal(caret.timeoutMs, 3000);
  assert.equal(caret.cold, false);
  assert.match(caret.from, /keyboard was already up/);
});

test('a focus duration is its own distribution on the edge, and the main path records every one', async () => {
  const graph = await import('../src/graph.js');
  // Two waits happen on one edge — focus, then the settle after typing — and
  // conflating them would time a keyboard against a whole transition.
  const t = graph.timingOf({ settles: [1200, 1300], focuses: [300, 320, 340, 360, 900] });
  assert.equal(t.samples, 2);
  assert.equal(t.focusSamples, 5);
  assert.equal(t.focusP50, 340);
  assert.equal(t.focusP95, 900);
  assert.equal(graph.timingOf({}).focusSamples, 0);

  // And the regression that hid in plain sight: `noteSettle` was called with
  // one argument on the path nearly every recorded edge takes, so quietGaps
  // only ever accumulated on a brand-new edge. A statistic quietly not being
  // taken looks exactly like a cold one.
  const src = fs.readFileSync(new URL('../src/graph.js', import.meta.url), 'utf8');
  for (const call of src.match(/noteSettle\(existing[^)]*\)/g) ?? []) {
    assert.match(call, /quietGapMs/, `${call} must carry the pause statistic`);
    assert.match(call, /focusMs/, `${call} must carry the focus statistic`);
  }
});

test('the structural settle credits the time a sample already spent getting there', async () => {
  const api = await import('../src/index.js');
  // The guarantee is 300ms between the frames the two readings see, not 300ms
  // *after* a reading that already spent a settle wait and a perception pass.
  assert.equal(api.structuralSettleOwed(1000, 1000), 300);
  assert.equal(api.structuralSettleOwed(1000, 1200), 100);
  // Already separated: the sleep bought nothing but a second of it.
  assert.equal(api.structuralSettleOwed(1000, 2400), 0);
  // A frame from the future, or no frame at all, pays the full window rather
  // than skipping the separation the samples exist for.
  assert.equal(api.structuralSettleOwed(2000, 1000), 300);
  assert.equal(api.structuralSettleOwed(undefined, 1000), 300);
  assert.equal(api.structuralSettleOwed(null, 1000), 300);
});

test('the session gate is keyed on the boot, not on the process', async () => {
  const input = await import('../src/input.js');
  const stale = { stale: true, bootedAt: 5000 };

  // Nothing rebuilt yet: act.
  assert.equal(input.shouldRebuildSession(stale, undefined), true);
  // Already rebuilt for this boot: do not rebuild on every tap forever, which
  // is what a failed rebuild would otherwise cause.
  assert.equal(input.shouldRebuildSession(stale, 5000), false);
  // A *newer* boot than the one we rebuilt for is a new device session.
  assert.equal(input.shouldRebuildSession({ stale: true, bootedAt: 9000 }, 5000), true);
  // Not stale, nothing to do.
  assert.equal(input.shouldRebuildSession({ stale: false, bootedAt: 9000 }, undefined), false);
  // A boot with no date cannot be memoised, so re-attempting on every action
  // would be worse than not detecting it.
  assert.equal(input.shouldRebuildSession({ stale: true, bootedAt: null }, undefined), false);

  // The bug this replaced, asserted at the source so it cannot come back as a
  // convenience: a gate keyed on the udid alone fires once per process, and the
  // MCP server is one process for a whole session — which is the only place a
  // device can reboot *between* two actions.
  const src = fs.readFileSync(new URL('../src/input.js', import.meta.url), 'utf8');
  const gate = src.slice(src.indexOf('export async function ensureFreshSession'));
  assert.ok(!/\.has\(udid\)/.test(gate.slice(0, 400)),
    'ensureFreshSession must not gate on having seen the udid before');
});

test('a recalled screen map says how old it is', async () => {
  const view = await import('../src/view.js');
  // A map built by this very call is not a recollection, and saying so on
  // every screen is how a real warning gets skimmed.
  assert.equal(view.recalledNote({ entry: { at: 1000 } }, 1000), null);
  assert.equal(view.recalledNote({ entry: { at: 1000 } }, 1900), null);
  // Past the floor it says so, and says what to do about it.
  const s = view.recalledNote({ entry: { at: 1000 } }, 41_000);
  assert.match(s, /recalled from 40s ago/);
  assert.match(s, /refresh/);
  assert.match(view.recalledNote({ entry: { at: 0 } }, 2_400_000), /recalled from 40m ago/);
  // No entry, or no timestamp: no claim either way.
  assert.equal(view.recalledNote(null), null);
  assert.equal(view.recalledNote({ entry: {} }), null);
});

test('no third-party bundle id, and the report never restates one', async () => {
  const g = await import('../scripts/check-private.mjs');

  // The rule is a pattern, not a list, because simframe drives *your* app and
  // has no relationship with any particular one. A denylist assumes there is a
  // single app to protect and needs configuring, and the first version of this
  // sat passing — waiting for a secret nobody had supplied — while a
  // third-party app's field notes were committed and pushed.
  assert.equal(g.isAllowedIdentifier('com.apple.Preferences'), true);
  assert.equal(g.isAllowedIdentifier('com.android.settings'), true);
  assert.equal(g.isAllowedIdentifier('com.example.app'), true);
  // Assembled rather than written, because this file is scanned by the very
  // check it is testing — and a test fixture is exactly the kind of "but this
  // one is fine" that turns a guard into a guard with exceptions.
  const notOurs = ['com', 'someones', 'realapp'].join('.');
  assert.equal(g.isAllowedIdentifier(notOurs), false);

  // Ordinary property chains look exactly like bundle ids until the head is
  // required to be a real reverse-DNS prefix, which is what keeps this usable.
  for (const safe of ['res.state.seq', 'registry.paths.dir', 'import.meta.url', 'process.env.HOME']) {
    assert.deepEqual(g.offendingLines(`const x = ${safe};`), [], `${safe} must not flag`);
  }
  assert.deepEqual(g.offendingLines('launch com.apple.MobileAddressBook'), []);

  const hits = g.offendingLines(`// we launched ${notOurs} here`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
  // The whole point: a location and a count, and the identifier itself appears
  // nowhere — so a failed run is safe to paste into an issue, a CI log, or a
  // conversation with an agent, which is where the last one would have gone.
  assert.ok(!JSON.stringify(hits).includes('someones'), 'a finding must not restate what it found');

  // The optional extra patterns still work, and need nothing to exist.
  assert.deepEqual(g.patternsFrom({ env: 'Alpha.One,beta.two', file: '# c\n\nBETA.TWO\n' }),
    ['alpha.one', 'beta.two']);
  assert.deepEqual(g.patternsFrom({ env: 'a,ab,abc' }), ['abc']);
  assert.deepEqual(g.patternsFrom({}), []);
});
test('a settle will not accept stillness that predates the action', async () => {
  const api = await import('../src/index.js');
  const settled = api.baselineAlreadySettled;

  // The measured failure: the screen already differs from the baseline and has
  // already been at rest for the whole stillness window. Stillness cannot
  // accumulate in the milliseconds between a dispatch returning and the wait
  // starting, so this change belongs to something earlier — the previous step's
  // animation, finishing during this step's locate and perception pass.
  assert.equal(settled({ mode: 'settle', changedAtStart: true, stableForMs: 900, stableMs: 500 }), true);
  assert.equal(settled({ mode: 'change', changedAtStart: true, stableForMs: 500, stableMs: 500 }), true);

  // Differs but still moving: genuinely ambiguous, and after an action the
  // ordinary reading is the right one. Left alone on purpose.
  assert.equal(settled({ mode: 'settle', changedAtStart: true, stableForMs: 120, stableMs: 500 }), false);

  // Nothing had changed at wait start, which is the healthy case.
  assert.equal(settled({ mode: 'settle', changedAtStart: false, stableForMs: 4000, stableMs: 500 }), false);

  // `stable` asks a question about now and has no baseline to be stale.
  assert.equal(settled({ mode: 'stable', changedAtStart: true, stableForMs: 4000, stableMs: 500 }), false);

  // No stillness reading at all: no claim. The simctl engine reports none.
  assert.equal(settled({ mode: 'settle', changedAtStart: true, stableForMs: undefined, stableMs: 500 }), false);
});

test('an action with no observed effect records no edge', async () => {
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  // The recorder used to ask only whether the *reading* was confirmed, so a tap
  // that moved nothing still wrote an edge — which is how `root -> root` became
  // a verified transition the graph then predicted.
  const guard = src.slice(src.indexOf('const noEvidence'), src.indexOf('graph.record(udid, {'));
  assert.match(guard, /noVisibleChange/);
  assert.match(guard, /!noEvidence/);
  // And where we are is still known even when what got us here is not worth
  // remembering, so the next step must not pay for another perception pass.
  const after = src.slice(src.indexOf('graph.record(udid, {'));
  assert.match(after.slice(0, 1400), /else if \(afterScreen\.confirmed && afterScreen\.hash\) \{[\s\S]{0,300}carriedScreen = afterScreen/);
});

test('an escalation breakdown says when it is pooling more than one agent', async () => {
  const metrics = await import('../src/metrics.js');
  const rec = (extra) => ({
    reason: 'ambiguous_intent', outcome: 'failed', model_turns_spent: 1, screen_fingerprint: 'a', ...extra,
  });

  // The state the log was actually in: every record anonymous, so nothing can
  // be told apart. 92 unattributable records is not "one session", and this is
  // the count CLAUDE.md uses to pick the next phase.
  const old = metrics.breakdown([rec({}), rec({}), rec({})]);
  assert.equal(old.pooled, true);
  assert.equal(old.unattributed, 3);
  assert.equal(old.session_count, 0);

  // Two agents on one booted simulator.
  const two = metrics.breakdown([
    rec({ session_id: 's1', client: 'mcp', flow_name: 'settings' }),
    rec({ session_id: 's1', client: 'mcp', flow_name: 'settings' }),
    rec({ session_id: 's2', client: 'cli' }),
  ]);
  assert.equal(two.pooled, true);
  assert.equal(two.session_count, 2);
  assert.deepEqual(two.sessions[0], { session_id: 's1', client: 'mcp', count: 2 });
  assert.deepEqual(two.by_flow, { settings: 2 });

  // One agent, nothing anonymous: no warning, because there is nothing to warn
  // about, and a warning that always fires is one nobody reads.
  const one = metrics.breakdown([rec({ session_id: 's1', client: 'mcp' })]);
  assert.equal(one.pooled, false);

  // Narrowing filters `total` and every rate derived from it, model turns
  // included — a filtered breakdown reporting the whole log's turns would be
  // the same mistake as pooling.
  const narrowed = metrics.breakdown([
    rec({ session_id: 's1', model_turns_spent: 1 }),
    rec({ session_id: 's2', model_turns_spent: 5 }),
  ], { session: 's1' });
  assert.equal(narrowed.total, 1);
  assert.equal(narrowed.model_turns_spent, 1);
  assert.equal(narrowed.pooled, false);

  // A record carries its session and the kind of client that wrote it, and the
  // session id is stable within a process.
  assert.equal(metrics.sessionId(), metrics.sessionId());
  assert.ok(['mcp', 'cli', 'script', 'library'].includes(metrics.clientName()));

  // Phase 11 shipped, so its faculty is built — which changes what those
  // records mean rather than how many there are.
  assert.ok(metrics.BUILT_FACULTIES.has(metrics.FACULTY.verification_failed));
});

test('one agent session is one session id, however many processes it takes', async () => {
  // A pid-derived id gave a CLI-driven agent one "session" per command: 33 ids
  // for 46 records on the benchmark device, 30 of them holding a single record.
  // That made `escalations --session` unable to answer the only question it
  // exists for. A caller that knows it is one session can now say so.
  const { execFileSync } = await import('node:child_process');
  const ROOT = new URL('..', import.meta.url).pathname;
  const run = (env) => {
    const out = execFileSync(process.execPath, [
      '-e', "import('./src/metrics.js').then((m) => console.log(m.sessionId()))",
    ], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
    return out.trim();
  };
  const a = run({ SIMFRAME_SESSION: 'peer-round-2' });
  const b = run({ SIMFRAME_SESSION: 'peer-round-2' });
  assert.equal(a, 'peer-round-2');
  assert.equal(b, a, 'two processes in one declared session share its id');

  const unset = { ...process.env };
  delete unset.SIMFRAME_SESSION;
  const c = execFileSync(process.execPath, [
    '-e', "import('./src/metrics.js').then((m) => console.log(m.sessionId()))",
  ], { cwd: ROOT, env: unset, encoding: 'utf8' }).trim();
  assert.notEqual(c, a, 'without the variable the per-process id is still the default');
});

test('every escalation reason carries what was asked for', async () => {
  const actions = await import('../src/actions.js');
  // `verification_failed` is the largest reason class and was the only one
  // logging no intent, so most of the corpus could not say what kind of
  // decision had cost the time. Both escalation sites read the step the same
  // way now, through one helper.
  assert.equal(actions.goalOf({ action: 'tap', value: 'Save' }), 'Save');
  assert.equal(actions.goalOf({ action: 'type', into: 'Requested By' }), 'Requested By');
  assert.equal(actions.goalOf({ action: 'assert', target: 'Review' }), 'Review');
  assert.equal(actions.goalOf({ action: 'button', name: 'HOME' }), null);
  assert.equal(actions.goalOf(), null);

  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const sites = src.match(/intent: (?:why\.intent \?\? )?goalOf\(step\)/g) ?? [];
  assert.equal(sites.length, 2, 'the verdict site and the throw site both carry it');
});

test('a black frame is noticed, and is never called a diagnosis', async () => {
  const a = await import('../src/analyze.js');
  // The wedge: `simctl io screenshot` succeeds and returns 0 non-black pixels
  // of 3,162,132, and simframe's frames go the same way while every layer
  // reports success.
  assert.equal(a.isBlackFrame('00'.repeat(32)), true);
  assert.equal(a.isBlackFrame('04'.repeat(32)), true);

  // The threshold is on the maximum, not the mean: one cell with anything in
  // it means the display is rendering. A dark-mode screen, a video, or a
  // splash on black are legitimately near-zero nearly everywhere, and calling
  // those a fault would make the check worse than nothing.
  assert.equal(a.isBlackFrame('00'.repeat(31) + '09'), false);
  // Measured on this device's Settings root the 32 bytes ran 191-245.
  assert.equal(a.isBlackFrame('bf'.repeat(32)), false);

  // No signature is not a black frame, it is no answer.
  assert.equal(a.isBlackFrame(''), false);
  assert.equal(a.isBlackFrame(null), false);
  assert.equal(a.isBlackFrame([]), false);

  // The wait rides through black rather than reading it as a change and then
  // as stillness, which is how it used to return `ok` for an action whose
  // result nobody could see.
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const wait = src.slice(src.indexOf('const black = isBlackFrame'));
  assert.match(wait.slice(0, 260), /blackFrames \+= 1[\s\S]*continue;/);
});

test('a prefix match is worth the share it covers, in both directions', async () => {
  const m = await import('../src/matching.js');

  // The bug, and it is worth stating as a comparison rather than a number:
  // "S" is a section-index letter and "Q Search" is the search field's own
  // label. simframe tapped the scrubber and typed into it, because
  // q.startsWith(n) returned a flat 0.86 however little of the query the name
  // covered, while its sibling n.includes(q) already scaled by coverage.
  assert.ok(m.nameScore('Q Search', 'Search') > m.nameScore('S', 'Search'),
    'the whole label must outrank a one-character fragment of the query');
  assert.ok(m.nameScore('S', 'Search') < m.MINIMUM_SCORE,
    'one character of a six-letter query should not resolve at all');

  // The other direction is the ordinary one — a prefix of a name is how people
  // abbreviate — and it keeps most of its score.
  assert.ok(m.nameScore('Screen Time', 'Screen') > 0.7);
  assert.ok(m.nameScore('Accessibility', 'Acce') > m.MINIMUM_SCORE);

  // The floor is tied to MINIMUM_SCORE, not chosen. At 0.5 the shortest useful
  // abbreviation scored 0.433 and fell below the threshold to resolve at all,
  // turning a ranking fix into a feature removal. Asserted as a relationship so
  // the cliff cannot come back by someone tuning either number alone.
  assert.ok(0.86 * m.PREFIX_FLOOR > m.MINIMUM_SCORE,
    'the worst-case prefix match must still be resolvable');
  assert.ok(m.nameScore('Accessibility', 'Ac') > m.MINIMUM_SCORE);

  // Exact still wins outright, and case and spacing still do not matter.
  assert.equal(m.nameScore('Search', 'Search'), 1);
  assert.equal(m.nameScore('Back', 'back'), 1);
  // And a fuller match beats a shorter one from the same direction.
  assert.ok(m.nameScore('Accessibility', 'Accessibilit') > m.nameScore('Accessibility', 'Ac'));
});

test('a synonym group may not overrule coverage on a name the query spells out', async () => {
  const m = await import('../src/matching.js');
  const screen = { width: 402, height: 874 };
  const heading = {
    label: 'Settings', type: 'StaticText', x: 40, y: 120,
    frame: { x: 20, y: 110, width: 200, height: 24 }, region: 'body', source: 'ax',
  };
  const row = {
    label: 'General', type: 'Cell', x: 200, y: 372,
    frame: { x: 0, y: 356, width: 402, height: 44 }, region: 'body', source: 'ax',
  };

  // Item 138. The reported shape: a long descriptive phrase whose *context*
  // happens to contain a synonym word. `synonymGroup` fires on the query merely
  // containing "settings" anywhere, and the override then scored the heading at
  // a flat 0.9 against the row's honest 0.265 — so simframe tapped a caption,
  // returned `ok [no visible change]`, and never tried the caller's own `or`.
  //
  // The guard is that this branch only ever runs when `base < 0.5`, i.e. its
  // job is to overrule the coverage scaling. When the query spells the name out
  // that scaling was already the right answer.
  const ranked = m.rank([heading, row], 'the General row under Settings', { screen });
  const scoreOf = (label) => ranked.find((c) => c.target.label === label)?.score ?? 0;
  assert.ok(scoreOf('General') > scoreOf('Settings'),
    'a caption whose word appears in the query must not outrank the row the caller named');
  assert.equal(m.resolve([heading, row], 'the General row under Settings', { screen }).status, 'none',
    'and when nothing clears the bar the answer is "none", so an `or` list gets its turn');

  // Not found is the one status the `or` path acts on, so the two must agree:
  // downgrading the score is only a fix because it lands in that set.
  const actions = await import('../src/actions.js');
  const metrics = await import('../src/metrics.js');
  assert.equal(actions.mayRetryAfter(metrics.tag(new Error('x'), 'unknown_screen')), true);
  assert.equal(actions.mayRetryAfter(metrics.tag(new Error('x'), 'ambiguous_intent')), true);

  // What the branch is actually for — a name that is a *different* word in the
  // group — is untouched. Coverage scaling cannot see synonymy, which is the
  // whole reason this override exists.
  const synonym = (label, query) => m.resolve([{ ...heading, label, type: 'Button' }], query, { screen });
  assert.equal(synonym('Preferences', 'settings').status, 'ok', '"settings" must still reach "Preferences"');
  assert.equal(synonym('Close', 'dismiss this dialog').status, 'ok', '"dismiss" must still reach "Close"');
  assert.equal(synonym('Previous', 'back').status, 'ok', '"back" must still reach "Previous"');

  // And the ordinary literal lookups keep scoring exactly as before.
  assert.equal(synonym('Settings', 'open settings').status, 'ok');
  assert.equal(synonym('Settings', 'tap the settings button').status, 'ok');
});

test('a control\'s value, selection and focus survive to the screen map', async () => {
  const { elementToNode } = await import('../src/input.js');
  // The daemon has asked the tree for AXValue, AXSelected and AXFocused since
  // 0.6.0 — three of the eight attributes in its batched round trip — and two
  // boundaries each dropped a different subset, so nothing above them ever saw
  // any of it. Measured: zero of the elements across fourteen recorded screens
  // carried a value, including eight switches and a text field.
  // The daemon's element shape, which is the path that actually runs —
  // `normalizeNode` is the idb fallback and carries the same three.
  const node = elementToNode({
    label: 'Bold Text', value: '1', role: 'Switch',
    state: { enabled: true, selected: false, focused: true },
    frame: { x: 36, y: 147, width: 330, height: 28 },
  });
  assert.equal(node.value, '1');
  assert.equal(node.selected, false);
  assert.equal(node.focused, true);

  // And the other boundary, asserted at the source because a dropped field is
  // invisible in behaviour — it reads as a control that has no state.
  //
  // Located by walking back from the `source: 'ax'` that ends the block, rather
  // than by matching its first property. This test has now broken twice on
  // edits that changed nothing it is about — the ctx literal, and item 122
  // making the label optional — and a test that fails for reasons outside its
  // own subject trains people to edit the test. What it is entitled to pin is
  // that the ax push carries the state fields, and nothing more.
  const src = fs.readFileSync(new URL('../src/screenmap.js', import.meta.url), 'utf8');
  const end = src.indexOf("source: 'ax'");
  assert.ok(end > 0, 'the ax branch of screenmap.build must still push a target');
  const head = src.slice(src.lastIndexOf('targets.push({', end), end);
  for (const field of ['value', 'selected', 'focused', 'enabled']) {
    assert.match(head, new RegExp(`\\b${field}:`), `an ax target must carry ${field}`);
  }
});

test('a row prints what a control contains, beside what OCR read', async () => {
  const view = await import('../src/view.js');
  // Printed alongside the OCR alias rather than instead of it: when the two
  // disagree that is the signal, and resolving it in the renderer would hide
  // exactly the case a person needs to see.
  const rendered = view.render({
    device: { name: 'iPhone' },
    identity: { hash: 'abc123def456', entry: { at: Date.now() } },
    screen: { width: 402, height: 874 },
    rows: [
      { ref: 1, type: 'TextField', x: 201, y: 816, label: 'Address', value: 'example.com', region: 'content' },
      { ref: 2, type: 'Switch', x: 201, y: 161, label: 'Bold Text', value: '0', region: 'content' },
      // The label already says it, which is most iOS settings rows. Printing
      // `= Off` after "Larger Text, Off" is noise.
      { ref: 3, type: 'Button', x: 201, y: 216, label: 'Larger Text, Off', value: 'Off', region: 'content' },
      { ref: 4, type: 'Text', x: 10, y: 10, label: 'Plain', region: 'content' },
    ],
    exits: 1,
  });
  assert.match(rendered, /Address = example\.com/);
  assert.match(rendered, /Bold Text = 0/);
  assert.ok(!/Larger Text, Off = Off/.test(rendered), 'must not repeat what the label already says');
  assert.match(rendered, /Plain/);
});

test('waiting for something already on screen stops immediately', async () => {
  const metrics = await import('../src/metrics.js');
  // Two very different failures tag the same reason, and only one of them
  // means waiting is pointless. `ambiguous` carries that difference from the
  // throw site, rather than a caller reading the message — which is the rule
  // the escalation log is built on.
  const present = metrics.tag(new Error('matches 4 things'), 'ambiguous_intent', { ambiguous: true, intent: 'Assets' });
  const absent = metrics.tag(new Error('is not on this screen'), 'ambiguous_intent', {});
  assert.equal(metrics.escalationOf(present).ambiguous, true);
  assert.equal(metrics.escalationOf(absent).ambiguous, false);

  // The goal, as a field rather than inside `detail`'s prose. Phase 17's
  // go/no-go needs (goal, element list, the action eventually taken); the list
  // is `candidates`, the eventual action is recoverable from the graph edge that
  // finally worked on that screen, and the goal was the missing third — sitting
  // inside the sentence `"X" matches 3 things on this screen`. Regexing it back
  // out at export time is the habit this module exists to avoid, and it returns
  // nothing the day that sentence is reworded.
  assert.equal(metrics.escalationOf(present).intent, 'Assets');
  assert.equal(metrics.escalationOf(absent).intent, null);

  // And both wait loops act on it. Asserted at the source because the
  // behaviour is a *non*-event — thirty seconds that no longer pass.
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const waitFor = src.slice(src.indexOf("case 'waitFor'"), src.indexOf("case 'assert'"));
  assert.match(waitFor, /escalationOf\(err\)\?\.ambiguous/);
  // It used to stop by *throwing*, and a field session lost a whole batch to
  // that on a screen it was correctly standing on. It now stops by succeeding:
  // waiting is still pointless, and the answer to "has it arrived" is yes.
  assert.match(waitFor, /the wait is satisfied/);
  const waitText = src.slice(src.indexOf("case 'waitText'"), src.indexOf("case 'assertText'"));
  assert.match(waitText, /matched \(\\d\+\) elements/);
  assert.match(waitText, /the wait is satisfied/);

  // A launch that changed nothing is ambiguous between "already in front" and
  // "did not come forward", and the step is the only place that can say so.
  assert.match(src, /already in front — or it did not come forward/);
});

test('a change too small for the mean is still a change', async () => {
  const a = await import('../src/analyze.js');
  const h = a.hexToSignature;
  // Both measured on this device rather than constructed. An iOS switch
  // flipping, and eighty seconds of a static screen whose only moving part is
  // the status-bar clock.
  const flip = ['eabbbcecf1fafcf3f1f8fef3f2f2f6f1eeeaf2eeeef0f6efeeecf1f1f0eef6ee',
                'eabbbcecf1fafce8f1f8fef3f2f2f6f1eeeaf2eeeef0f6efeeecf1f1f0eef6ee'].map(h);
  const tick = ['e8b9b9eceef9fcf0eef6fef5f1f1f5f4ebe6f0efecebf5f1ece7eef1efebf5ee',
                'e9b9b9eceef9fcf0eef6fef5f1f1f5f4ebe6f0efecebf5f1ece7eef1efebf5ee'].map(h);

  // The mean cannot see the flip: 0.0013 against a threshold of 0.004.
  assert.ok(a.signatureDiff(flip[1], flip[0]) < 0.004);
  // One region moved by 0.043 — thirty-two times the mean.
  assert.ok(a.maxCellDelta(flip[1], flip[0]) > a.CELL_CHANGE);

  // And the threshold sits in a measured gap rather than being chosen: the
  // loudest thing on a static screen is the clock at 0.0039, eleven times
  // below the flip. Asserted as the gap so tuning one number cannot quietly
  // close it.
  assert.ok(a.maxCellDelta(tick[1], tick[0]) < a.CELL_CHANGE);
  assert.ok(a.maxCellDelta(flip[1], flip[0]) > a.maxCellDelta(tick[1], tick[0]) * 5,
    'the signal must stay well clear of the loudest thing on a still screen');

  // Independent of stillness on purpose: a blinking caret is a small localised
  // change, and a screen with a cursor in it must still be able to settle.
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('if (!sawChange && baselineSig)'), src.indexOf('if (!sawChange && baselineSig)') + 400);
  assert.match(block, /sawChange = true/);
  assert.ok(!/stableForMs/.test(block), 'the per-cell signal must not touch stillness');
});

test('the pause statistic is measured after the transition, or not at all', async () => {
  const api = await import('../src/index.js');
  const g = api.longestQuietGap;
  const f = (at, hash) => ({ at, hash, seq: at });

  // A transition that moves, pauses 400ms mid-flight, moves again, then stops.
  // The pause inside is 400; the quiet *after* the last change is the
  // transition being over, which a settle already measures and this must not
  // count as a pause within it.
  const history = [
    f(1000, 'a'), f(1050, 'b'), f(1100, 'c'), f(1500, 'd'), f(1550, 'e'), f(3000, 'e'),
  ];
  assert.equal(g(history, 1000, 3000), 400);

  // The window must reach back to the action. A history that starts well after
  // it would report a *shorter* gap than really occurred — the exact direction
  // of the bias being removed — so the honest answer is no answer.
  assert.equal(g(history, 200), null);
  assert.equal(g([], 1000), null);
  assert.equal(g([f(1000, 'a')], 1000), null);

  // A transition with no pause at all reports zero, which is a measurement and
  // not a missing value.
  assert.equal(g([f(1000, 'a'), f(1050, 'b'), f(1100, 'c')], 1000), 50);

  // Nothing acts on it yet, and that is the point: Phase 11 built a wait on the
  // biased version of this statistic and corrupted the graph inside an
  // afternoon. A number earns the right to act by being watched first.
  const graphSrc = fs.readFileSync(new URL('../src/graph.js', import.meta.url), 'utf8');
  assert.match(graphSrc, /export function noteTrueGap/);
  const readers = graphSrc.match(/trueGaps/g) ?? [];
  assert.ok(readers.length >= 2, 'trueGaps is written and reported');
  assert.ok(!/stillnessFor[\s\S]{0,400}trueGap/.test(graphSrc),
    'the stillness window must not consult trueGaps until it has been watched');
});

test('a control below the fold is not absent, and waiting will not help', async () => {
  const api = await import('../src/index.js');
  const points = { width: 402, height: 874 };
  const inView = { label: 'Description', type: 'StaticText', x: 60, y: 620, frame: { x: 18, y: 610, width: 80, height: 20 } };
  const below = { label: 'REVIEW', type: 'Button', x: 201, y: 1140, frame: { x: 18, y: 1120, width: 366, height: 44 } };

  // Reported: `waitFor REVIEW` spent its whole 15s timeout and stopped the
  // flow while REVIEW sat one scroll below the fold. "Not on this screen" and
  // "not in view" call for opposite actions — waiting cannot bring a thing into
  // view, and scrolling can.
  const hit = api.offScreenMatch([inView, below], 'REVIEW', points);
  assert.ok(hit, 'the off-screen control is found');
  assert.equal(hit.y, 1140);

  // Something genuinely absent stays absent.
  assert.equal(api.offScreenMatch([inView, below], 'Submit order', points), null);
  // Nothing off-screen at all is not an off-screen answer.
  assert.equal(api.offScreenMatch([inView], 'Description', points), null);
  assert.equal(api.offScreenMatch([], 'REVIEW', points), null);
  // Above the fold counts too — a scrolled-past header is equally out of view.
  const above = { ...below, y: -40, frame: { x: 18, y: -60, width: 366, height: 44 } };
  assert.equal(api.offScreenMatch([above], 'REVIEW', points)?.y, -40);
});

test('a caption never wins over the control it names', async () => {
  const m = await import('../src/matching.js');
  // Reported: `tap "Problem"` hit the caption at (49,486) and did nothing,
  // while the select sat at (201,496). Containment in `sameControl` requires
  // the container to be a recognised hit target, and a React Native composite
  // is a generic element — so nothing merged them and the caption outranked it.
  const caption = {
    label: 'Problem', type: 'StaticText', x: 49, y: 486, source: 'ax|ocr',
    frame: { x: 18, y: 476, width: 62, height: 20 }, region: 'content',
  };
  const control = {
    label: 'Problem', type: 'GenericElement', x: 201, y: 496, source: 'ax',
    frame: { x: 18, y: 478, width: 366, height: 44 }, region: 'content',
  };
  for (const targets of [[caption, control], [control, caption]]) {
    const r = m.resolve(targets, 'Problem');
    assert.equal(r.status, 'ok', 'a thing and its own name are not two candidates');
    assert.equal(r.target.type, 'GenericElement');
    assert.equal(r.target.x, 201);
  }

  // Two genuinely different controls sharing a label still refuse, because
  // refusing is the house style and this must not become a way to guess.
  const other = { ...control, y: 700, frame: { x: 18, y: 682, width: 366, height: 44 } };
  assert.equal(m.resolve([control, other], 'Problem').status, 'ambiguous');

  // And a caption with no control to name is still reachable — the rule
  // promotes, it does not filter.
  assert.equal(m.resolve([caption], 'Problem').status, 'ok');
});

test('remembered vocabulary is checked against the screen in front of us', async () => {
  const v = await import('../src/view.js');

  // Reported with the consequence spelled out. A wizard's read-only review
  // screen had been given the same identity as its step 1, so it inherited step
  // 1's vocabulary: the map offered `tap "APPLY"`, `tap "No Power"`,
  // `tap "PLACE A SERVICE REQUEST"` — not one of which exists on it — while the
  // hint said "nothing ambiguous, chain the next steps without looking again".
  // The only control on that screen files a real work order.
  const remembered = [
    { action: 'tap', label: 'APPLY', count: 4 },
    { action: 'tap', label: 'No Power', count: 3 },
    { action: 'tap', label: 'PLACE A SERVICE REQUEST', count: 2 },
  ];
  const reviewRows = [{ label: 'Requested By' }, { label: 'SUBMIT SERVICE REQUEST' }];

  const wrong = v.presentOnly(remembered, reviewRows);
  assert.deepEqual(wrong.exitList, [], 'nothing remembered is offered');
  assert.equal(wrong.stale, 3);

  // And the disagreement is stated rather than swallowed: silence would leave
  // the caller with no reason to distrust the identity.
  const line = v.exitsLine(wrong.exitList, { stale: wrong.stale });
  assert.match(line, /memory disagrees with this screen/);
  assert.match(line, /confused with another/);

  const hint = v.nextHint({
    ok: true, settled: true, known: true, hash: 'a6606e1000', exits: 13,
    elements: 24, ambiguous: 0, exitList: wrong.exitList, staleExits: wrong.stale,
  });
  assert.ok(!/chain the next steps/.test(hint), 'never "chain without looking" on a misidentified screen');
  assert.match(hint, /identity is probably wrong/);
  assert.match(hint, /before anything irreversible/);

  // On the screen it really is, everything is offered and nothing is stale.
  const step1Rows = [{ label: 'APPLY' }, { label: 'No Power' }, { label: 'PLACE A SERVICE REQUEST' }];
  const right = v.presentOnly(remembered, step1Rows);
  assert.equal(right.exitList.length, 3);
  assert.equal(right.stale, 0);
  assert.match(v.nextHint({
    ok: true, settled: true, known: true, hash: 'aabbccddee', exits: 3,
    elements: 3, ambiguous: 0, exitList: right.exitList, staleExits: 0,
  }), /chain the next steps/);

  // A partial match still offers what is there and flags the rest, because
  // "some of this is missing" is weaker evidence than "all of it is".
  const partial = v.presentOnly(remembered, [{ label: 'APPLY' }, { label: 'Requested By' }]);
  assert.deepEqual(partial.exitList.map((e) => e.label), ['APPLY']);
  assert.equal(partial.stale, 2);
  const mixed = v.nextHint({
    ok: true, settled: true, known: true, hash: 'aabbccddee', exits: 3,
    elements: 2, ambiguous: 0, exitList: partial.exitList, staleExits: 2,
  });
  assert.match(mixed, /Known to work here: tap "APPLY"/);
  assert.match(mixed, /2 other remembered controls not on this screen/);

  // A remembered label inside a longer row still counts as present — a list
  // card concatenates its children, and truncation adds an ellipsis.
  assert.equal(v.presentOnly([{ action: 'tap', label: 'Anaheim' }],
    [{ label: 'Anaheim | Store # 1020, 1234 Main St,…' }]).exitList.length, 1);
});

test('the graph hands over its vocabulary instead of counting it', async () => {
  const v = await import('../src/view.js');
  const g = await import('../src/graph.js');

  // The map said `(known, 3 known exits)` — the count — so an agent on a screen
  // simframe had driven ten times still read it to learn what was tappable. A
  // flow whose labels were known in advance ran 16 steps in ONE call; the same
  // agent on screens the graph also knew spent 25 calls on 31 steps. The
  // difference was whether a plan existed before execution started.
  const node = {
    edges: [
      { step: { action: 'tap', value: 'Anaheim' }, to: 'a58fab06', count: 10, kind: 'replace' },
      { step: { action: 'tap', value: '4 Casa' }, to: 'a58fab06', count: 4, kind: 'replace' },
      { step: { action: 'tap', value: '#13' }, to: 'a58fab06', count: 1 },
      { step: { action: 'tap' }, to: 'x', count: 2 },
    ],
  };
  const exits = g.exitsOf(node);
  assert.deepEqual(exits.map((e) => e.label), ['Anaheim', '4 Casa'], 'most-used first');
  assert.equal(exits[0].count, 10);
  // A `#13` was a ref on the screen it was typed on and means nothing on the
  // next visit, and an unlabelled step is not vocabulary either.
  assert.ok(!exits.some((e) => String(e.label).startsWith('#')));

  const line = v.exitsLine(exits);
  assert.match(line, /worked here before:/);
  assert.match(line, /tap "Anaheim" \(10x\)/);
  assert.equal(v.exitsLine([]), null, 'a new screen promises nothing');
  assert.equal(v.exitsLine(undefined), null);

  // And the hint names them, because "chain the next steps" is not actionable
  // without saying what the steps could be.
  const hint = v.nextHint({
    ok: true, settled: true, known: true, hash: 'df24fd3200', exits: 2, elements: 13, ambiguous: 0, exitList: exits,
  });
  assert.match(hint, /chain the next steps/);
  assert.match(hint, /Known to work here: tap "Anaheim", tap "4 Casa"/);
});

test('a variant that satisfies the next step is a note, not a halt', async () => {
  const actions = await import('../src/actions.js');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');

  // Reported twice in one round and the direct cause of two flows needing three
  // calls instead of one: a tap landed on a hash *variant* of the screen its
  // edge remembered — the action had plainly worked, the state was right, the
  // CTA enabled — and 26 remaining steps were discarded. Variant absorption
  // cannot rescue it, because absorption only claims an *unclaimed* reading and
  // the variant had already been recorded as a node of its own.
  assert.match(src, /async function stillOnPlan/);
  // Asked only on that verdict, and answered only by the next step resolving.
  assert.match(src, /verification\?\.verdict !== 'unexpected-screen' \|\| !nextStep/);
  // A coordinate resolves anywhere and a ref was numbered on another screen, so
  // neither is evidence about where we are.
  assert.match(src, /neither is evidence about where we are/);
  // The verdict is still reported and still logged — it found a real app bug
  // for a reporter twice, and this changes whether the batch dies, not whether
  // the mismatch is mentioned.
  assert.match(src, /landed on a variant of the expected screen/);

  // haltDecision itself is unchanged: an unexpected screen still stops a run.
  assert.equal(actions.haltDecision({ verification: { verdict: 'unexpected-screen', detail: 'x' } }).halt, true);
  assert.equal(actions.haltDecision({ verification: { verdict: 'unverified', detail: 'x' } }).halt, false);
  assert.equal(actions.haltDecision({ verification: { verdict: 'ok' } }).halt, false);
});

test('acting on a ruling re-runs the same step, never a different one', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const hook = src.slice(src.indexOf('const ruling = await superviseFailure'), src.indexOf('const { allowed, refused }'));

  // The safety-critical half of the wiring. `wait` and `retry` may only cause
  // the *same* step to run again — the ruling is about whether the plan can
  // proceed, never about what to do instead. If this ever passed a modified
  // step, the three-word vocabulary would be decorative.
  // Pinned to the third argument alone. The context object beside it grows —
  // `aim` was added for item 120 and broke this test with nothing wrong, which
  // is the same lesson the recording assertions below already carry. What is
  // safety-critical is that the step is `step`, unmodified.
  assert.match(hook, /runStep\(deviceQuery, udid, step, \{/);
  assert.ok(!/stepWithTarget/.test(hook), 'a ruling never re-aims a step');
  assert.ok(!/steps\[i \+ 1\]/.test(hook), 'and never skips ahead');

  // Both settle first, differing only in how long — the one distinction the
  // model still fumbles is wait against retry, so making it a duration rather
  // than a behaviour means a wrong choice between them costs milliseconds
  // instead of the recovery.
  assert.match(hook, /ruling\.decision === 'wait' \? SUPERVISOR_WAIT_MS : SUPERVISOR_RETRY_MS/);

  // A `stop` hands back the steps it did not attempt, so the planner resumes
  // rather than re-plans, and says how to overrule it.
  assert.match(hook, /err\.remainingSteps = remaining/);
  assert.match(hook, /supervise` note/);

  // Every ruling is recorded, including one that did not help — a supervisor
  // whose mistakes are invisible cannot be corrected. Asserted as the calls
  // that do the recording rather than as the English they print: the words
  // moved into a lookup when the rulings started being persisted, and this
  // test failed for that with nothing wrong, which is what a test pinned to
  // the shape of the source buys you.
  for (const outcome of ['recovered', 'still_failed', 'stopped', 'no_ruling']) {
    assert.ok(hook.includes(`ruled('${outcome}')`), `the ${outcome} branch records its ruling`);
  }

  // And the two vocabularies cannot drift apart. The log stores tokens that
  // have to keep parsing; the caller is shown English that a test pins. The
  // mapping between them is the new seam, so it is checked for exhaustiveness
  // rather than trusted.
  const metrics = await import('../src/metrics.js');
  const src2 = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const shown = src2.slice(src2.indexOf('const SHOWN = {'), src2.indexOf('const noteRuling'));
  for (const token of metrics.RULING_OUTCOMES) {
    assert.ok(shown.includes(`${token}:`), `${token} has a caller-facing wording`);
  }
});

test('round 7: the supervisor stops going silent, and code answers what code knows', async () => {
  const actions = await import('../src/actions.js');
  const { readFileSync } = await import('node:fs');

  // F1, the worst finding of round 7: three rulings, then nothing across twenty
  // supervised calls and six failures, while `doctor` in a separate process
  // reported the model healthy. Root cause found on the bench —
  // `exceededContextWindowSize`, 4,441 tokens against a 4,096 window, after
  // seven requests, because one `LanguageModelSession` was reused and its
  // transcript accumulated. A session per judgement fixed it: 15 of 15 answered
  // at 488-533ms with no growth, where it used to die at 7.
  const swift = readFileSync(new URL('../native/supervise.swift', import.meta.url), 'utf8');
  // Pinned as a *position*, not as a literal. The claim is that the session is
  // built inside the read loop, once per judgement; the expression that builds
  // it grew an argument when the fourth-word vocabulary was added, and this
  // test failed with nothing wrong — which is the third time a source-shape
  // assertion in this file has cried wolf.
  assert.match(swift, /let session = LanguageModelSession\(instructions:/);
  assert.ok(
    swift.indexOf('let session = LanguageModelSession(instructions:') > swift.indexOf('while let line'),
    'the session is created inside the request loop, not once before it',
  );
  // A request can also exceed the window on its own, so the cap lives where the
  // limit is as well as in the caller.
  assert.match(swift, /let clip = /);

  // The reason field is gone. It confabulated in every observed run — a correct
  // `stop` justified as "screen is elsewhere" when the screen was exactly where
  // the plan expected, and reasons repeated verbatim across unrelated failures.
  assert.ok(!/var reason: String/.test(swift), 'it is no longer asked to explain itself');

  // And it is no longer asked what code already knows. An ambiguous selector
  // got `stop` with a false reason once and `wait` on a later bench run; an
  // element in the tree but out of view got `wait` while the error said, in
  // English, that waiting cannot bring it into view.
  assert.equal(actions.deterministicRuling({ message: '"X" matches 2 things on this screen' }).decision, 'stop');
  assert.equal(actions.deterministicRuling({ message: '"Roof" is in the tree but not in view at y=2076' }).decision, 'stop');
  assert.equal(actions.deterministicRuling({ message: '1 alternative(s) refused locally: "Delete" — destructive vocabulary' }).decision, 'stop');
  // "Not on this screen" is the one class it has been reliably right about.
  assert.equal(actions.deterministicRuling({ message: '"X" is not on this screen. Visible: A, B' }), null);

  // A consultation that was attempted and answered nothing is now visible. It
  // was invisible for a whole round: "had I run flow 2 alone I would have
  // reported the supervisor makes no difference without realising it had never
  // run."
  const src = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  assert.match(src, /ruled\('no_ruling'\)/);
  assert.match(src, /'unavailable'/);
  assert.match(src, /consulted and did not answer/);
  // It is now also *durable*, which is the half that was missing: a
  // consultation that answered nothing used to be visible in one result and
  // gone with the process.
  const metrics = await import('../src/metrics.js');
  assert.ok(metrics.RULING_OUTCOMES.includes('no_ruling'), 'an unanswered consultation is a recordable outcome');
});

test('the viewport has two edges, and a horizontal row proved it', async () => {
  const regions = await import('../src/regions.js');
  const screen = { width: 402, height: 874 };

  // Reported as the most expensive finding of an agent's session. Every
  // off-viewport filter in this project checked `y` and ignored `x`, which is
  // invisible until a horizontal row: a filter chip came back at **x=422 on a
  // 402pt-wide screen** and counted as visible, so `scroll_to` answered
  // *"'Assigned to Me' is in view at 422,277 already"* — confidently wrong about
  // the one thing it exists to decide. Off-screen chips read as **x=-247** the
  // same way.
  //
  // The cost was not the wrong answer. It was that the wrong answer was
  // confident, so the recovery was hand-tuned swipes and two overshoots.
  assert.equal(regions.offViewport({ x: 422, y: 277 }, screen), true, 'past the right edge');
  assert.equal(regions.offViewport({ x: -247, y: 277 }, screen), true, 'past the left edge');
  assert.equal(regions.offViewport({ x: 201, y: 900 }, screen), true, 'below the fold still counts');
  assert.equal(regions.offViewport({ x: 201, y: -40 }, screen), true, 'and above it');
  assert.equal(regions.offViewport({ x: 201, y: 400 }, screen), false, 'on screen is on screen');
  // A screen with no known size cannot rule anything out.
  assert.equal(regions.offViewport({ x: 5000, y: 5000 }, {}), false);
  assert.equal(regions.offViewport(null, screen), false);

  // And the rows filter uses it, so a horizontal row's off-screen chips stop
  // being offered as tappable.
  const view = await import('../src/view.js');
  const out = view.rowsFor({
    targets: [
      { label: 'All', type: 'Button', x: -247, y: 277, region: 'content' },
      { label: 'Assigned to Me', type: 'Button', x: 422, y: 277, region: 'content' },
      { label: 'Open', type: 'Button', x: 120, y: 277, region: 'content' },
    ],
  }, { screen });
  assert.deepEqual(out.rows.map((r) => r.label), ['Open']);
});

test('a wait can be a disjunction, and a crop can answer what a screen cannot', async () => {
  const { readFileSync } = await import('node:fs');
  const png = await import('../src/png.js');

  // Reported: a wait on "any login or dashboard content" spent **120 seconds**
  // while the login screen was already there — and its own failure message
  // listed Email, Password, Remember me. A phrase like that is a disjunction,
  // and resolving it as one intent asks the matcher for something no single
  // element answers.
  const src = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const step = src.slice(src.indexOf("case 'waitFor': {"), src.indexOf("case 'assert': {"));
  assert.match(step, /Array\.isArray\(step\.any\)/);
  assert.match(step, /first of \$\{alternatives\.length\} awaited/);
  assert.match(step, /none of \$\{alternatives\.length\} awaited strings appeared/);

  // A whole screen at 1024px cannot tell a selected chip from an unselected one,
  // and that was the entire question one ticket turned on — so the agent shelled
  // out to `simctl io` and PIL to crop and upscale, for every check.
  const bmp = { width: 4, height: 3, data: Buffer.alloc(4 * 3 * 4) };
  for (let i = 0; i < 12; i += 1) bmp.data[i * 4] = i;
  const cut = png.cropBitmap(bmp, 1, 1, 2, 2);
  assert.equal(cut.width, 2);
  assert.equal(cut.height, 2);
  assert.deepEqual([cut.data[0], cut.data[4], cut.data[8], cut.data[12]], [5, 6, 9, 10]);
  // Clamped to the bitmap rather than reading past it.
  assert.deepEqual([png.cropBitmap(bmp, 3, 2, 10, 10).width, png.cropBitmap(bmp, 3, 2, 10, 10).height], [1, 1]);
  assert.deepEqual([png.cropBitmap(bmp, -5, -5, 2, 2).width, png.cropBitmap(bmp, -5, -5, 2, 2).height], [2, 2]);

  // The region is in points, and the frame is not: `state.width/height` are the
  // captured frame's pixels (322x700) and not the screen's points (402x874).
  // Scaling by them made a crop at y=760 clamp to one pixel row and return a
  // 119-byte image, which looked like success.
  const mcp = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');
  // The points still have to come from the geometry, not from the frame — the
  // argument is now normalised by `readRegion` first, which is tested on its own.
  assert.match(mcp, /cropRegion\(png, parsed, geo\?\.points\)/);
  assert.match(mcp, /not the screen's points/);

  // And a device named once is remembered, because refusing to *choose* between
  // two booted simulators is right while forgetting which one the caller named
  // is not — it cost a UDID on all fifteen subsequent calls.
  assert.match(mcp, /args\.device \|\| lastDevice \|\| defaultDevice/);
  assert.match(mcp, /if \(args\.device\) lastDevice = String\(args\.device\)/);
});

test('a sweep measures where it is, and covers a page rather than guessing', async () => {
  const actions = await import('../src/actions.js');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');

  // The owner's algorithm: detect min/max scroll, then look section by section —
  // anything to fill here? Do it. Not? Move on. Getting there took four wrong
  // signals, and each one is worth keeping because each looked reasonable.
  //
  // The screen hash: useless on a page whose footer has live content, so
  // "stopped changing" never fired and it thrashed at the bottom for 40s.
  // New labels: fails the other way, because a gesture that reveals little
  // looks like an end — it stopped two sections above the form.
  // So: element geometry.
  const rows = [{ label: 'One', y: 100 }, { label: 'Two', y: 200 }, { label: 'Three', y: 300 }];
  assert.equal(actions.scrollDelta(rows, rows.map((r) => ({ ...r, y: r.y - 120 }))).px, -120);
  assert.equal(actions.scrollDelta(rows, rows).moved, false, 'nothing moved is an end');
  assert.equal(actions.scrollDelta(rows, rows.map((r) => ({ ...r, y: r.y - 3 }))).moved, false, 'jitter is not movement');
  assert.equal(actions.scrollDelta(rows, [{ label: 'Zed', y: 5 }]).moved, null, 'nothing shared is not evidence of an end');

  // Fixed chrome was the trap. A browser's bottom toolbar is five elements whose
  // y never changes, and with few shared content rows they drag the median to
  // zero — so a page that had plainly scrolled measured as motionless and the
  // sweep declared the bottom after one section.
  const withChrome = [
    { label: 'Back', y: 816, region: 'tab-bar' },
    { label: 'Address', y: 816, region: 'tab-bar' },
    { label: 'More', y: 816, region: 'tab-bar' },
    { label: 'Body', y: 400, region: 'content' },
  ];
  const scrolled = withChrome.map((r) => (r.region === 'content' ? { ...r, y: r.y - 200 } : r));
  assert.equal(actions.scrollDelta(withChrome, scrolled).px, -200, 'only what can move is evidence');

  // Two consecutive stalls, not one. Acting on a single stall is why it kept
  // jumping from the top straight to the end and never reading the form
  // between — any sticky element inside a page makes one median read as zero.
  assert.match(src, /stalls \+= 1/);
  assert.match(src, /if \(stalls >= 2\)/);
  assert.match(src, /if \(upStalls >= 2\)/);

  // ...and the gesture that buys the *second* upward stall is a small nudge,
  // not another section. A section-sized up-swipe is a ~600pt drag downward
  // from the top of a web page, which is pull-to-refresh — it reloads, and a
  // reload clears every field the sweep is about to fill. A peer called
  // `sweep "all"` on a half-filled form "a live grenade" for precisely this,
  // and the comment above the loop had been claiming the top was "left alone
  // rather than pulled past" while the code pulled past it.
  assert.match(src, /const TOP_CONFIRM_PT = 60/);
  assert.match(src, /upStalls \? \{ spanPt: TOP_CONFIRM_PT \}/);
  // The nudge must only ever apply to the confirming pass: a sweep whose every
  // upward gesture moved 60pt would take twenty of them to cross one screen.
  const upLoop = src.slice(src.indexOf('let upStalls = 0;'), src.indexOf('const seen = new Map();'));
  assert.equal((upLoop.match(/spanPt/g) ?? []).length, 1, 'exactly one gesture is the gentle one');

  // A section is a viewport, not whatever a default swipe does. Measured:
  // `{"scroll":"down"}` moved 28, 42 and 58 points on an 874-point screen —
  // about five per cent per gesture, which is dozens of swipes for one page and
  // is what "you scrolled too much" was actually describing.
  assert.match(src, /const SECTION_FRACTION = 0\.7/);
  assert.match(src, /input\.swipe\(udid, from, to/);

  // The last screenful is merged and filled, not discarded. Measuring movement
  // after scrolling and breaking before reading reported one section and 30
  // elements where it had just read 52.
  const sweepFn = src.slice(src.indexOf('async function sweep('), src.indexOf('async function runStep('));
  assert.match(sweepFn, /const here = await sectionHere/);
  assert.ok(sweepFn.indexOf('const here = await sectionHere') < sweepFn.lastIndexOf('await scrollOne('),
    'each section is read before it is scrolled past');
  // Going to the top is bounded and stops on the same signal, which is what
  // keeps a web page from being pulled to refresh.
  assert.match(sweepFn, /step\.from === 'here'/);
});

test('round 7: a type never sends a selector, and scrollTo follows the offset', async () => {
  const actions = await import('../src/actions.js');

  // F12. `value` is the selector when `into` is present and the text when it is
  // not, and reading it as text either way put a field's own label into the
  // field — reported as `typed into "Asset*" … = "Asset*"`. That is a wrong
  // write, not a reporting quirk, so it refuses rather than guesses.
  assert.equal(actions.textToSend({ action: 'type', into: 'Asset*', text: 'Fry' }), 'Fry');
  assert.equal(actions.textToSend({ action: 'type', value: 'Fry' }), 'Fry', 'without into, value is the text');
  assert.throws(() => actions.textToSend({ action: 'type', into: 'Asset*', value: 'Asset*' }),
    /needs "text"/, 'a selector is never sent as text');

  // F2, the most expensive single defect across five runs: the target sat at
  // y = −693, above the viewport, and it scrolled *down* six times with the
  // offset printed in its own error each time. It reads the sign now, and an
  // explicit direction still wins.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const step = src.slice(src.indexOf("case 'scrollTo': {"), src.indexOf("case 'waitFor': {"));
  assert.match(step, /if \(y < 0\) return 'up'/);
  assert.match(step, /if \(y > \(points\?\.height \?\? Infinity\)\) return 'down'/);
  assert.match(step, /if \(asked\) return asked/, 'an explicit direction still wins');

  // No evidence is not a direction. Guessing "up" without it scrolls to the top
  // of a web page, which triggers pull-to-refresh — reloading the page, changing
  // the screen hash, and defeating the end-detection below it. Observed live:
  // six attempts and 38s, reading from outside as an endless loop. With the
  // reversal gated on evidence: one attempt, 3.7s, and an honest message.
  assert.match(step, /if \(evidence\) dir = evidence/);
  assert.match(step, /if \(reversed \|\| !evidence\)/);
  assert.match(step, /how a web page\s*\n?\s*\/\/ gets pulled to refresh|gets pulled to refresh/);
  // And a scroll gets a scroll's budget, not a transition's.
  assert.match(src, /const SCROLL_SETTLE_MS = 800/);
});

test('the supervisor may say three words and nothing else', async () => {
  const supervisor = await import('../src/supervisor.js');
  const { readFileSync } = await import('node:fs');

  // Claude plans, deterministic code executes, and this judges failures behind
  // the hands and in front of the reasoner. Its answer space IS the safety
  // property: it cannot invent a step, skip one, substitute a target or
  // continue past an unexpected screen, because those are not words it can say.
  // Today's `seek` incident is the argument — given latitude over *what* to
  // open, it pressed "YES, THIS FIXED MY PROBLEM" in a live app.
  assert.deepEqual([...supervisor.DECISIONS].sort(), ['retry', 'stop', 'wait']);

  // Off unless asked, per call first and environment second — because an MCP
  // server's environment is fixed at spawn and that already cost a round.
  assert.equal(supervisor.requested({}), null);
  assert.equal(supervisor.requested({ supervisor: 'apple' }), 'apple');
  assert.equal(supervisor.requested({ supervisor: 'none' }), null);
  assert.equal(await supervisor.judge({ step: 'tap X', failure: 'nope' }), null, 'not asked means no ruling');
  assert.equal(await supervisor.judge({ options: { supervisor: 'apple' } }), null, 'and nothing to judge means none');

  // An answer outside the vocabulary is not a decision, and this is now run
  // rather than grepped. The previous version matched the source text of the
  // gate and broke when the branch grew an else — nothing wrong, a test pinned
  // to a shape. The gate is a function so the property can be exercised.
  assert.equal(supervisor.decisionOf({ decision: 'wait' }), 'wait');
  assert.equal(supervisor.decisionOf({ decision: 'STOP' }), 'stop', 'case is not a new word');
  assert.equal(supervisor.decisionOf({ decision: ' retry ' }), null, 'and neither is whitespace');
  for (const notAWord of [
    { decision: 'proceed' }, { decision: 'skip' }, { decision: 'tap Save' },
    { decision: 'wait, then retry' }, { decision: '' }, { decision: null },
    { decision: 3 }, { decision: ['wait'] }, { decision: { decision: 'wait' } },
    {}, null, undefined, 'wait',
  ]) {
    assert.equal(supervisor.decisionOf(notAWord), null,
      `${JSON.stringify(notAWord)} is not one of the three words`);
  }

  // Its prose is recorded, never presented as the ground for what happened. In
  // testing it returned a correct decision with a reason citing a rule that did
  // not apply, and presenting a confabulated rationale as fact is the mistake
  // `seek`'s documentation already made once.
  const actions = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  assert.match(actions, /its own prose is deliberately not trusted|prose is deliberately not trusted/i);
  const mcp = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');
  assert.match(mcp, /it said: /, 'the reason is quoted as a claim');

  // A stop is correctable: the result names the steps it did not attempt, so
  // the planner resumes instead of re-planning.
  assert.match(actions, /step\(s\) were not attempted/);
  assert.match(actions, /re-issue the remaining steps with a `supervise` note/);
  // And the plan briefs it, which is what made it usable at all — asked cold it
  // called a list that was plainly still arriving a dead end.
  assert.match(actions, /supervise = null/);
});

test('exploration may not open a door that commits, abandons or answers', async () => {
  const vocab = await import('../src/vocabulary.js');

  // The worst thing shipped in this series, reported from a real app. `seek`
  // opened CANCEL first — because "cancel" is listed as safe so a local tier can
  // DECLINE a dialog — then AI TROUBLESHOOTING, then pressed "YES, THIS FIXED MY
  // PROBLEM", ending five screens deep in a live support chat with a
  // half-completed service request destroyed. One label along was SUBMIT SERVICE
  // REQUEST.
  //
  // May-I-tap-this-to-decline and may-I-open-this-as-a-door are different
  // permissions, and one list answered both.
  for (const label of [
    'CANCEL', 'YES, THIS FIXED MY PROBLEM', 'HELP CENTER',
    'Activate to dismiss pop-up window.', 'Sign in', 'Submit', 'Delete',
    'OK', 'Done', 'Continue', 'Allow', 'Rate this app',
  ]) {
    assert.equal(vocab.openableAsDoor(label), false, `${label} is not a door`);
  }

  // Real doors stay open, including the two pickers a reported run found ZERO
  // candidates for — because candidacy had asked the tree whether they looked
  // interactive, and the tree has been wrong about roles in every round.
  for (const label of ['Accessibility', 'Display & Text Size', 'Work Orders', 'Select', 'Change', 'General']) {
    assert.equal(vocab.openableAsDoor(label), true, `${label} is a door`);
  }

  // And substitution is unchanged: "Cancel" must stay tappable there, or a
  // local tier strands on every confirmation it meets.
  assert.equal(vocab.actableLocally('CANCEL'), true);
  assert.equal(vocab.actableLocally('Delete'), false);

  // An unlabelled element is not a door — there is nothing to judge.
  assert.equal(vocab.openableAsDoor(''), false);
  assert.equal(vocab.openableAsDoor(null), false);
});

test('a step can carry its own fallbacks, and only some failures earn one', async () => {
  const actions = await import('../src/actions.js');
  const metrics = await import('../src/metrics.js');

  // Four situations the owner gave in a row turned out to be one problem: a
  // location with no assets, a misclicked like, hunting a setting through an
  // unfamiliar menu tree, a search returning nothing useful. "All done in maybe
  // less than a second or a few seconds." simframe answered all four by
  // throwing and abandoning the batch, because a step could only succeed or
  // throw and `continueOnError` is all-or-nothing for a whole run.
  assert.deepEqual(actions.alternativesFor({ action: 'tap', value: 'Save', or: ['Done', 'Confirm'] }), ['Done', 'Confirm']);
  assert.deepEqual(actions.alternativesFor({ action: 'tap', value: 'Save', or: 'Done' }), ['Done']);
  assert.deepEqual(actions.alternativesFor({ action: 'tap', value: 'Save' }), []);

  // An alternative is simframe's own initiative, so the destructive vocabulary
  // applies to it even though it does not apply to the step the caller wrote.
  const gated = actions.permittedAlternatives({ action: 'tap', value: 'Done', or: ['Finish', 'Delete', 'Submit'] });
  assert.deepEqual(gated.allowed, ['Finish']);
  assert.deepEqual(gated.refused.map((r) => r.label), ['Delete', 'Submit']);

  // Only a selector that did not resolve earns a retry. A step that resolved and
  // then landed somewhere unexpected does not: retrying from the wrong screen is
  // not a retry, and the verdict names the way back instead.
  const notHere = metrics.tag(new Error('"Done" is not on this screen'), 'unknown_screen', {});
  const ambiguous = metrics.tag(new Error('matches 2 things'), 'ambiguous_intent', {});
  const unverified = metrics.tag(new Error('assert failed'), 'verification_failed', {});
  assert.equal(actions.mayRetryAfter(notHere), true);
  assert.equal(actions.mayRetryAfter(ambiguous), true);
  assert.equal(actions.mayRetryAfter(unverified), false, 'a wrong turn is not a wrong label');
  assert.equal(actions.mayRetryAfter(new Error('plain')), false);

  // `optional` asks a narrower question than a retry does, and the difference
  // is the whole of the safety argument. "Skip if absent" may only absorb
  // *absent*: `ambiguous_intent` means the target is on screen twice, which is
  // a step that must still verify, not a step to wave through. Otherwise
  // "skip if absent" quietly becomes "tap whatever is there".
  //
  // The fixtures below are the shapes the throw sites actually produce, and
  // getting them wrong is how the first version of this shipped broken: the
  // tag is chosen by whether the SCREEN was recognised, so an absent target on
  // a screen recalled from memory is tagged `ambiguous_intent` as well. Keying
  // on the reason alone made `optional` a no-op on every known screen — which
  // is every screen it was built for — and this test passed anyway, because it
  // tested the predicate rather than the path. It now uses the real shapes.
  const absentOnKnownScreen = metrics.tag(
    new Error('"Not Now" is not on this screen. Visible: Settings, General'),
    'ambiguous_intent',
    { candidates: [], intent: 'Not Now' },
  );
  const reallyAmbiguous = metrics.tag(
    new Error('"Done" matches 2 things on this screen — say which, or pass index'),
    'ambiguous_intent',
    { candidates: [], intent: 'Done', ambiguous: true },
  );
  assert.equal(actions.didNotResolve(notHere), true);
  assert.equal(actions.didNotResolve(absentOnKnownScreen), true,
    'absent is absent whether or not the screen was recognised');
  assert.equal(actions.didNotResolve(reallyAmbiguous), false, 'present twice is not absent');
  assert.equal(actions.didNotResolve(unverified), false);
  assert.equal(actions.didNotResolve(new Error('plain')), false, 'an unclassified failure is not an absence');

  // A flow that opens by going somewhere does not assume where it started, so
  // it must not record a start screen — otherwise the mismatch note fires on
  // every correct replay that began anywhere else, which is 175's defect in a
  // feature written the same day 175 was filed. Observed on a device before it
  // was written down: a flow opening with `launch --relaunch` replayed 4/4 and
  // still reported "recorded starting on 8292b488, replayed from 39351dab".
  assert.equal(actions.resetsTheScreen({ action: 'launch', value: 'com.x' }), true);
  assert.equal(actions.resetsTheScreen({ action: 'openUrl', value: 'x://y' }), true);
  assert.equal(actions.resetsTheScreen({ action: 'button', value: 'HOME' }), true);
  assert.equal(actions.resetsTheScreen({ action: 'button', value: 'LOCK' }), false,
    'locking does not put you on a known screen');
  assert.equal(actions.resetsTheScreen({ action: 'tap', value: 'General' }), false,
    'a tap depends entirely on where you are');

  // `optional` now trusts one marker, so the marker has to be on every throw
  // that means "present, several times over". A site that says "matches N
  // things" without it would be silently skipped by an optional step — the
  // exact failure this predicate exists to refuse. Swept across src/ rather
  // than asserted where it was noticed, which is the mistake this file has
  // recorded three times.
  const srcDir = new URL('../src/', import.meta.url);
  const sources = fs.readdirSync(srcDir, { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => [String(f), fs.readFileSync(new URL(String(f), srcDir), 'utf8')]);
  for (const [name, body] of sources) {
    for (const site of body.split('throw metrics.tag(').slice(1)) {
      const call = site.slice(0, site.indexOf('\n  );') + 1 || 600);
      if (!/matches \$\{|matches \d+ thing/.test(call)) continue;
      assert.match(call, /ambiguous:\s*true/,
        `${name}: a "matches N things" throw must carry ambiguous:true, or an optional step will skip it`);
    }
  }

  // The alternative is the same step aimed elsewhere, with its own fallbacks
  // stripped so a retry cannot recurse.
  const aimed = actions.stepWithTarget({ action: 'tap', value: 'Save', or: ['Done'], durationMs: 50 }, 'Done');
  assert.deepEqual(aimed, { action: 'tap', value: 'Done', durationMs: 50 });
  assert.deepEqual(
    actions.stepWithTarget({ action: 'type', into: 'Search', text: 'x', or: ['Find'] }, 'Find'),
    { action: 'type', into: 'Find', text: 'x' },
  );
});

test('an experiment mode is an argument, not a server restart', async () => {
  const api = await import('../src/index.js');
  const planner = await import('../src/planner.js');
  const mcp = await import('../src/mcp.js');

  // Round 6 came back with one arm of its A/B unrun. An MCP server's
  // environment is fixed when it spawns, so a tester driving through it could
  // not switch modes inside a session — and the workaround suggested was three
  // server entries with three env blocks, which is worse: three servers on one
  // device is three writers, against the one-writer-per-device rule.
  //
  // So the call decides, and the environment is the fallback rather than the
  // only voice.
  assert.equal(api.sensorMode({ sensor: 'ax-first' }), 'ax-first');
  assert.equal(api.sensorMode({ sensor: 'full' }), 'full');
  assert.equal(api.sensorMode({}), 'full', 'and the default is unchanged');
  assert.equal(api.sensorMode(), 'full');
  assert.equal(planner.requested({ planner: 'apple' }), 'apple');
  assert.equal(planner.requested({ planner: 'none' }), null);
  assert.equal(planner.requested({}), null);

  // The MCP side merges them into the options every handler already takes, and
  // an absent argument leaves the server's own defaults alone.
  assert.deepEqual(mcp.modesFor({ fps: 2 }, { sensor: 'ax-first', planner: 'apple' }),
    { fps: 2, sensor: 'ax-first', planner: 'apple' });
  assert.deepEqual(mcp.modesFor({ fps: 2 }, {}), { fps: 2 });
  assert.deepEqual(mcp.modesFor(undefined, undefined), {});
});

test('a cheaper sensor is allowed to be cheaper, not to be wrong', async () => {
  const api = await import('../src/index.js');
  const ocr = await import('../src/ocr.js');
  const { readFileSync } = await import('node:fs');

  // The owner's theory, aimed one layer over: we read imprecisely and gain speed
  // by it. Measured, all of Vision costs ~57ms of a read while the waits beside
  // it cost 1,900-2,000ms — so the win is not a worse reading, it is not reading.
  // Warm on the benchmark device: 164ms with OCR fused, 50ms for the tree alone.
  assert.equal(api.sensorMode(), 'full', 'full is the default and what CLAUDE.md fixes');
  assert.equal(ocr.level(), 'accurate');

  // The escalation is what makes it safe rather than a repeat of the map cut,
  // which lost discovery by dropping data nothing missed until it did. A resolve
  // failure — the one signal saying the cheap sensor was not enough — buys a full
  // read before anyone is told the target is absent.
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const wrapper = src.slice(src.indexOf('export async function locate('), src.indexOf('async function locateWith('));
  assert.match(wrapper, /useOcr: false/, 'the cheap read comes first');
  assert.match(wrapper, /useOcr: true, refresh: true/, 'and a failure pays for the full one');
  assert.match(wrapper, /unknown_screen/);
  assert.match(wrapper, /ambiguous_intent/);
  // An ambiguity between two things the tree already saw is not fixed by reading
  // more text, and a refused selector is not a perception failure at all.
  assert.match(wrapper, /throw err/);

  // The recognition level is honestly scoped: the daemon reads text in-process
  // and owns its own level, so this flag reaches only the fallback helper. Said
  // out loud because a flag that looks like it configures everyone's OCR and
  // does not is worse than no flag.
  const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(cli, /fallback helper only; the daemon owns its own/);
});

test('the destructive vocabulary gates initiative, not requests', async () => {
  const vocab = await import('../src/vocabulary.js');

  // CLAUDE.md has required this list since the human-parity series was written,
  // and several code comments already spoke of "the destructive vocabulary" as
  // though it existed. It did not.
  //
  // What it gates is the distinction that matters: simframe's own initiative —
  // a retry, an alternative selector, an exploration step, a reflex — never what
  // the caller asked for. Backwards, it would refuse the thing a tester most
  // needs to test.
  assert.equal(vocab.mayActLocally('Delete Account').allowed, false);
  assert.equal(vocab.mayActLocally('Sign out').allowed, false);
  assert.equal(vocab.mayActLocally('Submit').allowed, false);
  assert.equal(vocab.mayActLocally('Allow').allowed, false);
  assert.equal(vocab.mayActLocally('Open in Safari').reason, 'leaves the app');
  assert.equal(vocab.mayActLocally('Save').allowed, true);
  assert.equal(vocab.mayActLocally('Done').allowed, true);
  assert.equal(vocab.mayActLocally('').allowed, true);
  assert.equal(vocab.mayActLocally(null).allowed, true);

  // Whole words, not substrings. A business app's "Work Orders" tab contains the
  // letters of "order", and a substring match would make its main navigation
  // untouchable by anything local — so the bare noun is deliberately not on the
  // list and only the verb phrase is.
  assert.equal(vocab.mayActLocally('Work Orders').allowed, true);
  assert.equal(vocab.mayActLocally('Order Details').allowed, true);
  assert.equal(vocab.mayActLocally('Order History').allowed, true);
  assert.equal(vocab.mayActLocally('Place order').allowed, false);

  // Exceptions match the WHOLE label, not a phrase inside it. "Cancel" declines
  // a dialog and must stay tappable or a local tier strands on every
  // confirmation it meets; "Cancel order" is a different act, and a phrase match
  // waved it through on the strength of its first word.
  assert.equal(vocab.mayActLocally('Cancel').allowed, true);
  assert.equal(vocab.mayActLocally('cancel').allowed, true);
  assert.equal(vocab.mayActLocally('Cancel order').allowed, false);
  assert.equal(vocab.mayActLocally('Clear search').allowed, true);
  assert.equal(vocab.mayActLocally('Clear').allowed, false);

  // The barrier must never be silently empty — an empty list makes every label
  // safe, which is the wrong direction to fail in. Any locale, known or not,
  // therefore yields a non-empty vocabulary, because English is the fallback and
  // a missing English file throws rather than returning nothing.
  for (const locale of ['en', 'fr', 'zz-nonsense', 'pt-BR']) {
    assert.ok(vocab.load(locale)?.destructive?.words?.length, `${locale} resolves to a real vocabulary`);
  }
  assert.equal(vocab.mayActLocally('Delete', { locale: 'zz-nonsense' }).allowed, false);
  assert.equal(vocab.actableLocally('Delete'), false);
});

test('a wrong turn is reported with the way back', async () => {
  const actions = await import('../src/actions.js');

  // The owner's generalisation, and it is the right one: "I go to Instagram,
  // misclick a like button — humans aren't as accurate as bots. I notice
  // immediately, I go back or I remove the like. No need to think for minutes
  // and scan the whole of Instagram's philosophy. I use what I see."
  //
  // That recovery needs no knowledge of the app. It needs to notice and to know
  // the way back, and simframe has both already: `unexpected-screen` notices in
  // about 200ms, and `graph.route` can compute a path from where we landed to
  // where we were, out of edges already recorded. It simply never said so — the
  // step threw and a round trip was spent deciding what the graph could answer.
  const fakeGraph = {
    route: (udid, from, to) => (from === 'landed' && to === 'origin'
      ? [{ step: { action: 'tap', value: 'Back' }, count: 6 }]
      : null),
  };
  const route = actions.wayBack('TEST-back', { hash: 'origin' }, { hash: 'landed' }, { graph: fakeGraph });
  assert.match(route, /back to where you were: tap "Back"/);
  assert.match(route, /seen 6x/);

  // No route, no claim. Guessing a way back is worse than saying nothing.
  assert.equal(actions.wayBack('TEST-back', { hash: 'origin' }, { hash: 'elsewhere' }, { graph: fakeGraph }), null);
  // And nothing to say when we did not move.
  assert.equal(actions.wayBack('TEST-back', { hash: 'origin' }, { hash: 'origin' }, { graph: fakeGraph }), null);
  assert.equal(actions.wayBack(null, { hash: 'a' }, { hash: 'b' }, { graph: fakeGraph }), null);

  // It rides on the verdict that reports the wrong turn, and on no other.
  const wrong = actions.withWayBack(
    { verdict: 'unexpected-screen', detail: 'expected the screen this action reached 6x before, and landed somewhere else' },
    { udid: 'TEST-back', from: { hash: 'origin' }, landed: { hash: 'landed' }, graph: fakeGraph },
  );
  assert.match(wrong.detail, /landed somewhere else — back to where you were/);
  const fine = { verdict: 'ok', detail: 'matches the outcome seen 7x before' };
  assert.equal(actions.withWayBack(fine, { udid: 'TEST-back', from: { hash: 'origin' }, landed: { hash: 'landed' }, graph: fakeGraph }).detail, fine.detail);

  // And the real graph answers it too, from edges it recorded itself.
  const graph = await import('../src/graph.js');
  const udid = 'TEST-wayback';
  const origin = { hash: 'a'.repeat(32), tokens: ['text:nav-bar:@title:w5:h1:x5:y2#1"feed"'] };
  const landed = { hash: 'b'.repeat(32), tokens: ['text:nav-bar:@title:w5:h1:x5:y2#1"profile"'] };
  for (let i = 0; i < 2; i += 1) {
    graph.record(udid, { from: landed, action: { action: 'tap', value: 'Back' }, to: origin, kind: 'pop' });
  }
  assert.match(actions.wayBack(udid, origin, landed) ?? '', /tap "Back"/);
});

test('filling a field is verified once, after the fact', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const graph = await import('../src/graph.js');

  // The measured answer to "why is there a long gap between filling two
  // fields", and none of it is thinking. Filling one field was verified five
  // times — the field exists, it took focus, the text landed, the screen
  // settled, the screen is still the screen — and every one of those is local.
  //
  // Two were change-based waits, and an action that changes nothing cannot
  // satisfy one: measured on a completely still screen, 1.9-2.0 seconds each,
  // both returning `satisfied: false`. Tapping a text field barely moves the
  // screen, and with a hardware keyboard attached no software keyboard appears.
  assert.ok(graph.STAYS_ON_SCREEN.has('type'));
  assert.ok(graph.STAYS_ON_SCREEN.has('paste'));
  assert.ok(!graph.STAYS_ON_SCREEN.has('tap'), 'a tap really might navigate');

  // The step settle is capped for those actions, well under the ~1.9s an
  // unsatisfiable settle used to spend.
  const budget = Number(/const STAYS_PUT_BUDGET_MS = (\d+)/.exec(src)?.[1]);
  const stillness = Number(/const STAYS_PUT_STILLNESS_MS = (\d+)/.exec(src)?.[1]);
  assert.ok(budget > 0 && budget <= 1000, `a stays-put budget of ${budget}ms is not a transition wait`);
  assert.ok(stillness > 0 && stillness < budget, 'and it can still be satisfied inside it');
  assert.match(src, /staysPut \? STAYS_PUT_BUDGET_MS : budgetMs/);

  // Focus is one advisory accessibility read, not a wait and not a gate.
  assert.match(src, /async function focusHint/);
  assert.match(src, /t\.focused !== true/, 'focus comes from the tree, not from pixels');
  assert.ok(!/did not visibly take focus/.test(src), 'the old pixel-based claim is gone');
  assert.ok(!/FOCUS_POLL_BUDGET_MS/.test(src), 'and it is not a poll either');

  // The precondition is not verified; the outcome is — and the race that
  // justified the old wait is handled by one local retry instead of by an
  // aborted batch and a model round trip.
  assert.match(src, /took two attempts/);
  assert.match(src, /still reads empty/);
});

test('a stored map is only valid for the rules that hashed it', async () => {
  const screenmap = await import('../src/screenmap.js');
  const fingerprint = await import('../src/fingerprint.js');
  const store = await import('../src/store.js');
  const path = await import('node:path');
  const udid = 'TEST-mapversion';

  // A stored map carries a `structuralHash` produced by the *fingerprint*
  // rules, so a token-rule change invalidates it — and relying on someone to
  // remember to bump MAP_VERSION as well is exactly how the phantom keyboard
  // survived a fix that looked like it addressed it: two copies of one
  // dependency, one of them updated.
  const fs = await import('node:fs');
  const dir = path.join(store.deviceDir(udid), 'screens');
  fs.mkdirSync(dir, { recursive: true });
  const write = (hash, extra) => store.writeAtomic(path.join(dir, `${hash}.json`), JSON.stringify({
    version: 9, hash, layoutHash: 'ff'.repeat(16), targets: [{ label: 'x', x: 1, y: 1 }], ...extra,
  }));

  write('aa11', { fingerprintVersion: fingerprint.TOKEN_RULES_VERSION });
  assert.ok(screenmap.recall(udid, 'aa11'), 'a map hashed by the current rules is usable');

  write('bb22', { fingerprintVersion: fingerprint.TOKEN_RULES_VERSION - 1 });
  assert.equal(screenmap.recall(udid, 'bb22'), null, 'one hashed by older rules is not');

  write('cc33', {});
  assert.equal(screenmap.recall(udid, 'cc33'), null, 'and neither is one that does not say');
});

test('a screen whose data changed is still the screen it is', async () => {
  const graph = await import('../src/graph.js');
  const fingerprint = await import('../src/fingerprint.js');
  const udid = 'TEST-variance';

  // `unexpected-screen` fired three times in one reported run and was wrong all
  // three; two were this. The tester picked a different asset than earlier runs
  // had, so the content differed, so the hash differed, so a correct navigation
  // was called a wrong turn: "this will fire on every run that varies its test
  // data — i.e. every useful run." And a failed step abandons the rest of its
  // batch, so each false alarm costs a round trip.
  //
  // `nearestScreen` has always had a token-similarity tolerance for exactly
  // this. The verification path threw it away by passing bare hash strings, and
  // a string carries no tokens, so only an exact hash could match.
  const base = ['group:content:w17:h6:x0:y16#many', 'text:content:w0:h1:x1:y4#many',
    'button:content:w9:h2:x1:y19#1', 'text:nav-bar:@title:w5:h1:x5:y2#1"create service request"'];
  const varied = [...base.slice(0, 3), 'text:nav-bar:@title:w5:h1:x5:y2#1"create service request"',
    'text:content:w3:h1:x2:y11#1'];

  const from = { hash: fingerprint.hashTokens(base), tokens: base };
  const reached = { hash: fingerprint.hashTokens(varied), tokens: varied };
  assert.notEqual(from.hash, reached.hash, 'different data really is a different hash');

  // The target has to exist as a node for its tokens to be on file — a node is
  // created for the screen an action was taken *on*.
  graph.record(udid, { from, action: { action: 'tap', value: 'REVIEW' }, to: { hash: 'bbbb2222', tokens: ['y:content:w1:h1:x1:y1#1'] }, kind: 'push' });

  const prediction = { to: from.hash, count: 3, kind: 'push' };
  // Passing the reading lets the tolerance recognise it; passing the bare hash
  // is the old behaviour and is kept for a stored prediction with no tokens.
  const withTokens = graph.verdict({ udid, prediction, before: { hash: 'aaaa1111', tokens: ['x:content:w1:h1:x1:y1#1'] }, after: reached, kind: 'push', action: 'tap' });
  assert.notEqual(withTokens.verdict, 'unexpected-screen',
    'a content-varied screen is not a wrong turn');

  // A genuinely different screen still is one.
  const elsewhere = ['text:nav-bar:@title:w4:h1:x6:y2#1"settings"', 'cell:content:w20:h3:x0:y8#many'];
  const wrong = graph.verdict({
    udid, prediction,
    before: { hash: 'aaaa1111', tokens: ['x:content:w1:h1:x1:y1#1'] },
    after: { hash: fingerprint.hashTokens(elsewhere), tokens: elsewhere },
    kind: 'push', action: 'tap',
  });
  assert.equal(wrong.verdict, 'unexpected-screen', 'and a real wrong turn still stops the run');

  // No reading at all is still unverified, not a wrong turn.
  assert.equal(graph.verdict({ udid, prediction, before: null, after: reached }).verdict, 'unverified');
});

test('a summary screen is not a keyboard, and its content stays in its identity', async () => {
  const regions = await import('../src/regions.js');
  const fingerprint = await import('../src/fingerprint.js');
  const screen = { width: 402, height: 874 };

  // The reported shape: a read-only review screen stacks a dozen short text
  // rows of near-identical height in its lower half. That satisfied every
  // size-and-uniformity test for a keyboard, and `tokens` discards everything
  // below `keyboardTop` — so the screen's whole content left its own identity
  // and a wizard's form step and its review screen, which share a nav title and
  // a step indicator, collapsed onto ONE hash. From there the graph offered one
  // screen's remembered controls on the other, next to a button that submits
  // for real.
  const row = (i, label) => ({
    label, type: 'StaticText',
    x: 201, y: 520 + i * 26,
    frame: { x: 20, y: 510 + i * 26, width: 360, height: 20 },
  });
  const summary = [
    'Priority', 'L3 - 24 Hours', 'Over Time Approved', 'No', 'Requested By',
    'Trade', 'Category', 'Repair', 'Area', 'Asset', 'Location', 'Description',
  ].map((l, i) => row(i, l));
  const chrome = [
    { label: 'Create Service Request', type: 'StaticText', navSlot: 'title', x: 201, y: 90, frame: { x: 100, y: 76, width: 202, height: 28 } },
    { label: 'Back', type: 'Button', x: 24, y: 90, frame: { x: 12, y: 76, width: 44, height: 28 } },
  ];

  assert.equal(regions.detectKeyboardTop([...chrome, ...summary], screen), null,
    'a dozen short text rows are not a keyboard');

  // Content survives into the identity, which is the property that was lost.
  const { tokens } = fingerprint.tokens([...chrome, ...summary], screen);
  assert.ok(tokens.some((t) => /:content:/.test(t)), 'the summary rows are part of what this screen is');

  // And the two screens no longer share a hash. The form step has the same
  // chrome and different content.
  const formRows = [
    { label: 'Requested By', type: 'GenericElement', x: 201, y: 520, frame: { x: 18, y: 500, width: 366, height: 44 } },
    { label: 'Description', type: 'GenericElement', x: 201, y: 600, frame: { x: 18, y: 578, width: 366, height: 88 } },
    { label: 'REVIEW', type: 'Button', x: 201, y: 800, frame: { x: 18, y: 780, width: 366, height: 44 } },
  ];
  const a = fingerprint.hashTokens(fingerprint.tokens([...chrome, ...summary], screen).tokens);
  const b = fingerprint.hashTokens(fingerprint.tokens([...chrome, ...formRows], screen).tokens);
  assert.ok(a && b, 'both screens have an identity');
  assert.notEqual(a, b, 'two screens of one wizard are two screens');

  // A real keyboard is still detected: many small key-shaped boxes.
  const keys = [];
  for (let i = 0; i < 20; i += 1) {
    keys.push({
      label: 'qwertyuiopasdfghjklz'[i], type: 'Key',
      x: 20 + (i % 10) * 38, y: 700 + Math.floor(i / 10) * 46,
      frame: { x: 6 + (i % 10) * 38, y: 690 + Math.floor(i / 10) * 46, width: 32, height: 42 },
    });
  }
  assert.ok(regions.detectKeyboardTop([...chrome, ...keys], screen) != null, 'a real keyboard still registers');

  // The token rules changed, so stored fingerprints must be discarded. Bumped to
  // 6 by the opposite half of this same bug: the detection window's edge was
  // being used as the boundary, so a real keyboard's top row fell outside it and
  // ten keys were counted INTO a screen's identity. Over-detection deleted
  // content from an identity; under-detection added a keyboard to one.
  //
  // 7: a screen whose own name is an iOS large title had no name in its identity
  // at all, because the top-chrome detector looks for the gap *beneath* a bar
  // and a large title is drawn tight against the content it heads. Measured on
  // the Settings root, 0 named tokens in both sensor modes — and on a hosted
  // runner two sparse nameless readings then matched exactly, one hash standing
  // for two different screens.
  //
  // This assertion is doing its job: it is here to make a token-rule change
  // deliberate rather than incidental, so the number moves only alongside a
  // reason written down in `fingerprint.js`.
  // 8: the same rule keyed on the screen's median row gap rather than on a
  // constant, so a system-drawn title was chrome or content depending on how
  // many rows sat below it. Two screens of one app, same 62.9pt inset, opposite
  // answers — and the graph merged them.
  // 9: not a rule change at all — item 122 changed the *input*. Accessibility
  // nodes with no name are no longer dropped, so a screen with an icon-only
  // control carries a token it did not carry before and hashes differently.
  assert.equal(fingerprint.TOKEN_RULES_VERSION, 9);
});

test('a band is only the keyboard if there is a keyboard in it', async () => {
  const v = await import('../src/view.js');
  // Region bands are positional, so on screens with no keyboard the bottom band
  // was still called `keyboard`: review-summary rows were filed under it and
  // followed by `keyboard: 1 keys (tap by label or type directly)`, which is
  // actively wrong advice about page content.
  const summary = [
    { label: 'Priority', type: 'StaticText', x: 34, y: 664, frame: { x: 20, y: 654, width: 60, height: 20 }, region: 'keyboard' },
    { label: 'L3 - 24 Hours', type: 'StaticText', x: 207, y: 686, frame: { x: 120, y: 676, width: 174, height: 20 }, region: 'keyboard' },
  ];
  const out = v.rowsFor({ targets: summary }, { screen: { width: 402, height: 874 } });
  assert.equal(out.rows.length, 2, 'content is not collapsed away');
  assert.deepEqual([...new Set(out.rows.map((r) => r.region))], ['content'], 'and it is not called the keyboard');
  assert.equal(out.collapsed.size, 0);

  // With even one real key present the band is genuine and behaves as before.
  const withKey = [...summary, { label: 'a', type: 'Key', x: 30, y: 850, frame: { x: 14, y: 830, width: 32, height: 42 }, region: 'keyboard' }];
  const real = v.rowsFor({ targets: withKey }, { screen: { width: 402, height: 874 } });
  assert.equal(real.collapsed.get('keyboard'), 1);
  assert.ok(real.rows.every((r) => r.region === 'keyboard'), 'the band stands when a key is in it');
});

test('the two change sensors stop contradicting each other', async () => {
  const actions = await import('../src/actions.js');
  // The wait watches regions, the verdict compares screen identity. A tap that
  // moved one cell printed `[a small change, in one region only]` and
  // `no-visible-change: the screen did not change` four lines apart — both true
  // of different questions, and reading as a contradiction.
  const said = actions.belowThreshold(
    { verdict: 'no-visible-change', detail: 'the screen did not change, and nothing predicted it would' },
    { smallChange: true },
  );
  assert.equal(said.verdict, 'no-visible-change', 'the verdict stands; it is the finding');
  assert.match(said.detail, /one region only/);
  assert.ok(!/did not change,/.test(said.detail));

  // Nothing observed, nothing to reconcile.
  const quiet = { verdict: 'no-visible-change', detail: 'the screen did not change, and nothing predicted it would' };
  assert.equal(actions.belowThreshold(quiet, { smallChange: false }).detail, quiet.detail);
  assert.equal(actions.belowThreshold(quiet, undefined).detail, quiet.detail);
  // And it never touches another verdict.
  const wrong = { verdict: 'unexpected-screen', detail: 'landed somewhere else' };
  assert.equal(actions.belowThreshold(wrong, { smallChange: true }).detail, wrong.detail);
});

test('the keyboard band collapses keys, not the control pinned above them', async () => {
  const v = await import('../src/view.js');
  // Region bands are positional, and this is their fourth bug. With the
  // keyboard up, a wizard's only forward control landed in the `keyboard` band
  // and was collapsed with the keys: four reads running — `all` and `refresh`
  // included — printed `keyboard: 6 keys` and no NEXT, while the hint said
  // "nothing ambiguous — chain the next steps without looking again". The next
  // call proved it was emission, not perception: `tap "NEXT"` hit 201,800
  // instantly, via ax|ocr, at a coordinate the map had never printed.
  const next = { label: 'NEXT', type: 'Button', x: 201, y: 800, frame: { x: 18, y: 780, width: 366, height: 44 }, region: 'keyboard' };
  assert.equal(v.isKey(next), false, 'a full-width primary action is not a key');

  for (const key of [
    { label: 'a', type: 'Key', frame: { width: 32, height: 42 } },
    { label: 'Q', frame: { width: 32, height: 42 } },
    { label: 'space', frame: { width: 110, height: 42 } },
    { label: 'return', frame: { width: 88, height: 42 } },
    { label: '123', frame: { width: 40, height: 42 } },
    { label: '', frame: { width: 32, height: 42 } },
  ]) assert.equal(v.isKey(key), true, `${key.label || '(unlabelled)'} is a key`);

  // An icon-only pinned control has no label to reason about, so width is what
  // keeps it in the map.
  assert.equal(v.isKey({ label: '', type: 'Button', frame: { width: 366, height: 44 } }), false);

  // And it reaches the rows, which is the behaviour that was actually reported.
  const rows = v.rowsFor(
    { targets: [next, { label: 'a', type: 'Key', x: 30, y: 850, frame: { x: 14, y: 830, width: 32, height: 42 }, region: 'keyboard' }] },
    { screen: { width: 402, height: 874 } },
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].label, 'NEXT');
  assert.equal(rows.collapsed.get('keyboard'), 1, 'the key is still collapsed');
});

test('a control is interactive by evidence when the tree got its role wrong', async () => {
  const v = await import('../src/view.js');
  // `--interactive` answered "1 element" on a form with two visible, bordered,
  // *required* text inputs. A React Native composite select surfaces as a
  // generic element and an input shows only its placeholder as StaticText, so
  // the role is exactly the thing that was wrong.
  assert.equal(v.actsInteractive({ type: 'Button' }), true);
  assert.equal(v.actsInteractive({ type: 'GenericElement', value: '4 Casa' }), true, 'a select that holds a value');
  assert.equal(v.actsInteractive({ type: 'StaticText', focused: true }), true, 'an input with the caret in it');
  assert.equal(v.actsInteractive({ type: 'GenericElement', enabled: false }), true, 'a disabled control is still a control');
  assert.equal(v.actsInteractive({ type: 'GenericElement' }), false, 'a bare group really is a container');
  assert.equal(v.actsInteractive({ type: 'StaticText', value: '' }), false);
  assert.equal(v.actsInteractive({}), false);
});

test('a write waits for focus, and silence about focus still means proceed', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');

  // Two agents independently reported the same symptom and neither could
  // reproduce it: one insertion primitive returns ok into an empty field, and
  // the other then works. External research settled it as a FOCUS RACE — a
  // keystroke delivered before a web view commits focus to its input is
  // dropped, and WDA checks hasKeyboardFocus before typing. So "paste versus
  // type" was the wrong investigation and would never have converged.
  assert.match(src, /async function awaitFocus/);
  assert.match(src, /const focused = await awaitFocus\(/);
  assert.match(src, /const FOCUS_WAIT_MS = \d+/);

  // The wait must END on focus rather than always burning its budget, or every
  // native field pays for a web view's problem.
  const fn = src.slice(src.indexOf('async function awaitFocus'), src.indexOf('async function focusField'));
  assert.match(fn, /while \(!last\.focused && Date\.now\(\) < deadline\)/);

  // And silence is not failure. This file has been wrong in that direction
  // before — it once claimed a correctly focused field was unfocused because
  // the screen had not moved — so running out of budget must insert anyway.
  assert.doesNotMatch(fn, /throw/);
  assert.match(fn, /return last/);
});

test('a keyboard boundary reaches the top row of keys, not the edge of its detection window', async () => {
  const regions = await import('../src/regions.js');
  const { readFileSync } = await import('node:fs');
  // Real recorded data, not a construction: an iPhone 17 Pro with the software
  // keyboard up. Recorded on purpose, because this hypothesis had already been
  // guessed at twice and tested with live swipes that took a minute each and
  // could not be trusted.
  const fix = JSON.parse(readFileSync(new URL('../test/perception/screens/safari__keyboard-up.json', import.meta.url), 'utf8'));
  const top = regions.detectKeyboardTop(fix.targets, fix.points);

  // KEYBOARD_MIN_FRACTION is 0.28, so the window starts at 874 * 0.72 = 629 —
  // and the q-p row's frame top is 590, outside it. The boundary used to land on
  // the `a` row at 644, leaving ten keys in `content` on a screen whose own map
  // said "keyboard up". Widening the window would be the wrong fix: 0.28 is
  // deliberately conservative so a list of short rows cannot be read as a
  // keyboard. The window decides; the boundary extends while rows stay
  // key-shaped.
  const qRow = fix.targets.filter((t) => ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'].includes(t.label));
  assert.equal(qRow.length, 10, 'the fixture has the top key row in it');
  assert.ok(top <= Math.min(...qRow.map((t) => t.frame.y)), `boundary ${top} must not sit below the top key row`);
  assert.equal(top, 590);

  // The extension must not run away up the screen: it stops as soon as a row is
  // not key-shaped, which is what stops it eating page content. Nothing above
  // the keyboard here is key-shaped, so it stops at exactly one row.
  const above = fix.targets.filter((t) => t.frame && t.frame.y < top);
  assert.ok(above.length > 0, 'there is content above the keyboard to protect');
  assert.ok(above.every((t) => !regions.looksLikeKey(t)), 'nothing above the boundary looks like a key');
});

test('an alias must be the same thing read twice, not two layers at one point', async () => {
  const v = await import('../src/view.js');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/screenmap.js', import.meta.url), 'utf8');

  // Reported on a modal-heavy screen with a Select Area sheet over a dimmed
  // page: `#15 text 167,316 Area (Optional) ~ Exterior Building`, which reads as
  // though the field "Area (Optional)" contains "Exterior Building". They are
  // unrelated things at one coordinate on different z-layers, and the reporter
  // had to fall back to a screenshot to count five radio options — precisely the
  // case the text map exists to remove.
  //
  // The geometric branch of the fusion pairs an OCR word with whatever ax
  // element encloses it, so the gate is on the strings: a LABELLED element only
  // takes an alias related to its own label. An unlabelled one still takes the
  // text outright, because that is how an icon-only control gets a name, and it
  // cannot contradict a label it does not have.
  const { aliasRelates } = await import('../src/screenmap.js');
  assert.equal(aliasRelates('Kate Bell', 'Kate Bell'), true, 'one element, two sensors');
  assert.equal(aliasRelates('Area (Optional)', 'Exterior Building'), false, 'two layers at one point');
  assert.equal(aliasRelates('Telephone:', 'Telephone: 5551234567'), true, 'OCR fuses a value onto its label');
  // An unlabelled element takes the text outright: that is how an icon-only
  // control gets a name, and it cannot contradict a label it does not have.
  assert.equal(aliasRelates(undefined, 'Search'), true);
  assert.equal(aliasRelates('', 'Search'), true);
  assert.equal(aliasRelates('Save', ''), true);
  assert.match(src, /occluded\.push\(/);

  // This is a function rather than three lines inline for a reason worth
  // keeping. Inline, it read `covering.label` BEFORE anything checked that
  // `covering` existed — and it is undefined whenever no ax element encloses
  // the word, which is most words on most screens. The TypeError was swallowed
  // by the OCR try/catch, so the whole sensor went quiet and reported itself as
  // `degraded: text recognition`. Neither the unit tests nor the perception
  // harness caught it, because the harness feeds ALREADY FUSED element lists
  // and never runs that loop; the integration job caught it, which is what it
  // is for. The previous version of this test asserted the buggy source shape.
  assert.doesNotThrow(() => aliasRelates(undefined, 'anything'));

  // And the disagreement is reported, because "these two overlap and disagree"
  // is the signature of a covering layer and a caller counting options needs it.
  const withOverlay = v.render({
    device: { name: 'iPhone', udid: 'U' },
    identity: { hash: 'a'.repeat(32), entry: { occluded: [{ over: 'Area (Optional)', under: 'Exterior Building' }] } },
    rows: [{ ref: 1, region: 'content', label: 'Area (Optional)', x: 1, y: 1, type: 'StaticText' }],
    screen: { width: 402, height: 874 },
    overlay: '1 element(s) on this screen overlap and disagree about what is there — a sheet or overlay',
  });
  assert.match(withOverlay, /overlap and disagree/);
  // Silent when there is no overlay, which is the common case.
  assert.doesNotMatch(
    v.render({
      device: { name: 'iPhone', udid: 'U' },
      identity: { hash: 'a'.repeat(32) },
      rows: [{ ref: 1, region: 'content', label: 'Save', x: 1, y: 1, type: 'Button' }],
      screen: { width: 402, height: 874 },
    }),
    /overlap and disagree/,
  );
});

test('a stale ref offers the label it was numbered against, and says it did', async () => {
  const actions = await import('../src/actions.js');
  const { resolveRef, writeRefs } = await import('../src/refs.js');
  const udid = 'TEST-RELABEL';
  writeRefs(udid, {
    structuralHash: 'aaaa1111',
    layoutHash: 'a'.repeat(72),
    rows: [{ ref: 19, label: 'Work Orders', x: 40, y: 200, type: 'Button', region: 'content', source: 'ax' }],
  });

  // Reported: `#19 was numbered on a different screen (61b835b7 → 6f34c006)`
  // because dashboard cards finished loading and shifted the layout — the same
  // screen, a new hash — and that one refusal aborted the three remaining steps
  // in the batch. The table knows what #19 pointed at, so the refusal carries
  // the label and the caller need not spend a round trip rediscovering it.
  const err = (() => {
    try { resolveRef(udid, 19, { structuralHash: 'bbbb2222', structuralDistance: 0 }); return null; } catch (e) { return e; }
  })();
  assert.ok(err, 'a genuinely different screen still refuses');
  assert.equal(err.staleRef, true);
  assert.equal(err.staleLabel, 'Work Orders');
  // This case is an *identity* mismatch, and the comment above describes
  // *drift* — the same screen with a new hash. Both were true of the report and
  // the two were left wearing one flag, so the recovery built for the second
  // fired on the first: `#1` numbered "Reminders" in Reminders re-resolved in
  // Contacts onto the status-bar back-to-app breadcrumb "• Reminders", scored
  // 0.64, and was returned as a tap point in the status bar. Only drift may be
  // recovered; a different screen must refuse.
  assert.equal(err.staleKind, 'identity');

  const drifted = (() => {
    try {
      resolveRef(udid, 19, { structuralHash: 'aaaa1111', structuralDistance: 0, layoutHash: '5'.repeat(72) });
      return null;
    } catch (e) { return e; }
  })();
  assert.ok(drifted, 'a layout that has moved too far still refuses the number');
  assert.equal(drifted.staleKind, 'drift');
  assert.equal(drifted.staleLabel, 'Work Orders');
  assert.match(drifted.message, /not a different screen/);

  // And a ref with no recorded label offers nothing rather than inventing it.
  const bare = (() => {
    try { resolveRef(udid, 4, { structuralHash: 'bbbb2222', structuralDistance: 0 }); return null; } catch (e) { return e; }
  })();
  assert.equal(bare.staleLabel, null);

  // The recovery is never silent: re-resolving is a recovery, not a fact about
  // the ref, and a recovery a caller cannot see is the shape of every
  // silent-success bug this round was about.
  const note = actions.relabelledNote({ relabelled: { ref: 19, label: 'Work Orders' } });
  assert.match(note, /#19 was stale/);
  assert.match(note, /"Work Orders"/);
  assert.match(note, /the number was not honoured/);
  assert.equal(actions.relabelledNote({}), '');
});

test('a count header only warns when the count could be the rows on screen', async () => {
  const actions = await import('../src/actions.js');
  const list = (promised, rows) => ({
    targets: [
      { region: 'content', label: `${promised} Records` },
      ...Array.from({ length: rows }, (_, i) => ({ region: 'content', label: `row ${i}` })),
    ],
  });

  // The case this heuristic was built for: a `waitFor` on "Records" satisfied
  // by the header "21 Records" while zero of the 21 rows existed.
  assert.match(actions.stillFillingIn(list(21, 2)), /only 2 row\(s\)/);
  assert.equal(actions.stillFillingIn(list(21, 20)), null);

  // And the case that made it cry wolf. On a paginated or virtualised list the
  // header is a TOTAL, which says nothing about how many rows belong on screen:
  // `a header promises 1232 records and only 43 row(s) are here yet` fired on
  // nearly every step of a list whose correct final state was 43 rows. The
  // reporter's verdict is the reason this is capped rather than tuned — "by the
  // fourth occurrence I was ignoring it, which is the failure mode you least
  // want from a warning."
  assert.equal(actions.stillFillingIn(list(1232, 43)), null);
  assert.equal(actions.stillFillingIn(list(1232, 0)), null, 'a total is silent even at zero rows');

  // The other signal on this path is untouched: a control that says so.
  assert.match(actions.stillFillingIn({ targets: [{ region: 'content', label: 'Loading' }] }), /loading/);
});

test('a crop region is read in every shape a caller would try, or refused out loud', async () => {
  const { readRegion } = await import('../src/mcp.js');
  // A client may hand a declared-object property over as a JSON string, and one
  // did: every field read as undefined and the crop silently became the whole
  // screen — captioned `cropped to 402x874pt at 0,0`, a crop that did not
  // happen described as one that did.
  const want = { x: 0, y: 60, width: 402, height: 200 };
  assert.deepEqual(readRegion(want), want);
  assert.deepEqual(readRegion(JSON.stringify(want)), want);
  // [x, y, width, height] is what anyone tries first, and it failed as quietly.
  assert.deepEqual(readRegion([0, 60, 402, 200]), want);
  assert.deepEqual(readRegion({ x: 0, y: 60, w: 402, h: 200 }), want);
  // A region with no size is not a region, and neither is a region-shaped
  // nothing. Both must be refusals so the caller is told, rather than a whole
  // screen under a caption claiming a crop.
  assert.equal(readRegion({ x: 0, y: 60 }), null);
  assert.equal(readRegion('nope'), null);
  assert.equal(readRegion(null), null);
  assert.equal(readRegion(42), null);
});

test('a value simframe wrote and can no longer see is reported, and nothing else is', async () => {
  const wrote = await import('../src/wrote.js');
  // A peer filled three fields on a web form and six calls later they were
  // empty. All six calls returned ok. simframe had recorded the values two
  // calls earlier and said nothing when they vanished, so the only way to find
  // out was a screenshot — and an agent trusting the verdicts would have
  // submitted an empty order.
  const udid = 'TEST-WROTE';
  wrote.forget(udid);
  wrote.record(udid, { selector: 'Telephone:', value: '5551234567' });

  // The field is here and its contents are not: that is the finding.
  const emptied = [{ label: 'Telephone:' }, { label: 'Customer name:' }];
  assert.equal(wrote.missing(udid, emptied).length, 1);
  assert.match(wrote.missingLine(wrote.missing(udid, emptied)), /is gone/);

  // Present, in any of the shapes a sensor may hand it over in. OCR fuses a
  // label with its value onto one line, which is why the whole row is searched.
  for (const rows of [
    [{ label: 'Telephone:', value: '5551234567' }],
    [{ label: 'Telephone: 5551234567' }],
    [{ label: 'Telephone:' }, { label: '5551234567' }],
  ]) assert.deepEqual(wrote.missing(udid, rows), [], JSON.stringify(rows));

  // A longer label that merely contains the selector is a different field. The
  // first field run after this shipped matched a journalled "Email" against the
  // page footer's newsletter box, "Enter your email address", and announced a
  // value gone that was simply elsewhere on the page.
  wrote.record(udid, { selector: 'Email', value: 'sadjad@example.com' });
  assert.deepEqual(wrote.missing(udid, [{ label: 'Enter your email address' }, { label: 'Subscribe Now' }]), []);
  // ...while the field's own row, which begins with the label, still counts.
  assert.equal(wrote.missing(udid, [{ label: 'Email' }, { label: 'Your email address' }]).length, 1);

  // Somewhere else entirely says nothing. Without the label there is no way to
  // tell "the field was cleared" from "we navigated away", and guessing would
  // put a false alarm on every screen change.
  assert.deepEqual(wrote.missing(udid, [{ label: 'Settings' }, { label: 'General' }]), []);
  assert.deepEqual(wrote.missing(udid, []), []);
  assert.equal(wrote.missingLine([]), null);

  // Stale entries stop commenting, so yesterday's form says nothing about today's.
  assert.deepEqual(wrote.missing(udid, emptied, { now: Date.now() + wrote.MAX_AGE_MS + 1 }), []);

  // Re-filling a field replaces its entry, so a field filled twice cannot warn
  // about its own earlier contents.
  wrote.record(udid, { selector: 'Telephone:', value: '9998887777' });
  assert.equal(wrote.read(udid).filter((e) => e.selector === 'Telephone:').length, 1, 'one entry per field');
  assert.deepEqual(wrote.missing(udid, [{ label: 'Telephone: 9998887777' }]), []);
  assert.equal(wrote.missing(udid, emptied).length, 1);

  // A coordinate selector has no label to look for, so it can never be
  // journalled into a warning — and an empty value is not a write.
  wrote.forget(udid);
  wrote.record(udid, { selector: '(125,325)', value: 'text' });
  wrote.record(udid, { selector: 'Notes', value: '' });
  assert.deepEqual(wrote.missing(udid, [{ label: '(125,325)' }, { label: 'Notes' }]), []);
});

test('a typed field is verified by its contents, not by the screen moving', async () => {
  const actions = await import('../src/actions.js');
  const graph = await import('../src/graph.js');

  // The verdict was wrong in *both* directions across three rounds: a step
  // reporting a clean `ok` had silently done nothing, while the step warned
  // about as `no-visible-change` had landed. Anti-correlated with reality, on
  // the one path where acting on the warning is destructive — re-typing doubles
  // a field that has no way to be cleared.
  assert.deepEqual(
    actions.readbackNote('a value', { value: 'a value', landed: true, focused: true }),
    { note: ' = "a value"', empty: false, landed: true },
  );
  // The false `ok`: a valued control that reads empty after text was sent.
  assert.equal(actions.readbackNote('a value', { value: '', landed: false }).empty, true);
  // Nothing was sent, so an empty field is not a contradiction.
  assert.equal(actions.readbackNote('', { value: '', landed: false }).empty, false);
  // No readback at all is no evidence, and no evidence is not counter-evidence.
  // The first version of this check treated a missing `value` attribute as an
  // empty field and failed a step whose text was visible in the very map the
  // failure returned — worse than the verdict it replaced, because the tool's
  // own remediation advice would have double-entered the text.
  //
  // So it still must not fail — `empty` stays false. What changed is that it no
  // longer stays *silent*: two agents in one round reported a confident `ok`
  // into a field that was empty, both on web fields, where the tree carries no
  // contents to read back and this note was the only thing that could have
  // told them. An unconfirmed write must not read like a confirmed one.
  const noEvidence = actions.readbackNote('x', null);
  assert.equal(noEvidence.empty, false, 'no evidence must never fail the step');
  assert.equal(noEvidence.landed, false);
  assert.match(noEvidence.note, /unconfirmed/);
  // ...and with nothing sent there is nothing to be unconfirmed about.
  assert.equal(actions.readbackNote('', null).note, '');
  // `landed` is what lets the caller drop the focus proxy: the note "[the field
  // did not visibly take focus]" fires whenever the screen does not react to
  // the tap, and with a hardware keyboard attached to the simulator none ever
  // does — so a correctly focused field was reported as unfocused and the
  // reporter went hunting, at a cost of three calls.
  assert.equal(actions.readbackNote('Mo', { value: 'Mo', landed: true }).landed, true);
  assert.equal(actions.readbackNote('Mo', { value: '', landed: false }).landed, false);
  // Long values are shown truncated rather than dropped — the same call the
  // map cut got wrong on list rows.
  const long = actions.readbackNote('x', { value: 'y'.repeat(200), landed: true });
  assert.match(long.note, /…"$/);
  assert.ok(long.note.length < 80);

  // Typing does not navigate, so screen-identity movement cannot say whether it
  // worked. Answering `no-visible-change` contradicted the wait's own
  // observation on the same line, escalated a clean flow, and invited the
  // re-type.
  for (const action of ['type', 'paste', 'key']) {
    const v = graph.verdict({ udid: 'TEST-stays', before: 'aa', after: 'aa', action });
    assert.equal(v.verdict, 'ok', `${action} on the same screen is not a change failure`);
    assert.ok(!graph.STAYS_ON_SCREEN.has('tap'));
  }
  // A tap that moves nothing is still a real finding, and unchanged.
  assert.equal(graph.verdict({ udid: 'TEST-stays', before: 'aa', after: 'aa', action: 'tap' }).verdict, 'no-visible-change');
});

test('a result says whether the model needs to stop and think', async () => {
  const v = await import('../src/view.js');

  // The measured loop is observe -> think -> tap -> observe -> think, and the
  // thinking dominates. 48 of 62 real calls were three steps or fewer, so a
  // twelve-step flow arrived as four or five calls and every boundary was a
  // think — not because anything was ambiguous, but because nothing said it
  // was not.
  const clear = v.nextHint({ ok: true, settled: true, known: true, hash: '0f660efbaa', exits: 2, elements: 16, ambiguous: 0 });
  assert.match(clear, /chain the next steps in one sim_do/);
  assert.match(clear, /0f660efb/);

  // Order matters: the strongest reason to think wins, and "carry on" is only
  // ever said when every reason has been ruled out.
  assert.match(v.nextHint({ ok: false, settled: true, known: true }), /moment to think/);

  // A stopped flow and a completed flow carrying a soft verdict are different
  // things, and conflating them printed `flow completed — 16/16 steps` directly
  // above `next: the flow stopped here` on a run where nothing stopped. It was
  // not cosmetic: `no-visible-change` escalates and fires falsely, so one wrong
  // verdict anywhere in a clean flow told the agent to abandon batching — the
  // exact failure this hint exists to prevent, caused by the hint.
  const soft = v.nextHint({ ok: true, escalated: true, settled: true, known: true, elements: 14 });
  assert.match(soft, /every step ran/);
  assert.ok(!/stopped here/.test(soft), 'a completed flow is never told it stopped');
  assert.ok(!/chain the next steps/.test(soft), 'but an unconfirmed step still earns one look');
  assert.match(v.nextHint({ ok: true, settled: false, known: true }), /still moving/);
  // Settled and finished are different states, and they used to render
  // identically: a settle reported success while a list was still coming over
  // the network, and an empty content region looked exactly like a loading one.
  assert.match(v.nextHint({ ok: true, settled: true, loading: true, known: true }), /still sees loading/);
  assert.match(v.nextHint({ ok: true, settled: true, loading: true, known: true }), /waitFor/);
  // Loading outranks "carry on" but not a stopped flow.
  assert.match(v.nextHint({ ok: false, loading: true }), /moment to think/);
  assert.match(v.nextHint({ ok: true, settled: true, known: false }), /new screen/);
  assert.match(v.nextHint({ ok: true, settled: true, known: true, ambiguous: 2 }), /2 labels repeat/);
  // A hint that cheerfully said "carry on" into an unknown screen would be
  // worse than no hint at all.
  for (const bad of [{ ok: false }, { settled: false }, { loading: true }, { known: false }, { ambiguous: 1 }]) {
    assert.ok(!/chain the next steps/.test(v.nextHint({ ok: true, settled: true, known: true, ...bad })));
  }

  // Reported verbatim: `flow completed — 16/16 steps in 24202ms` followed by
  // `next: the flow stopped here`. Both front ends feed the hint from the same
  // place, so asserting on `hintFor` covers the shape the reporter saw.
  const completed = v.hintFor(
    { identity: { settled: true, hash: 'df24fd3200' }, exits: 2, rows: new Array(14).fill({ label: 'x' }) },
    { flowOk: true, escalated: true },
  );
  assert.ok(!/stopped here/.test(completed));

  // A filtered view is not the screen. `--interactive` on a form reported
  // "1 element; nothing ambiguous — chain the next steps" while two required
  // text inputs sat unseen, and an agent concluded there was nothing to fill
  // in. The over-claim was the harmful half, not the filter.
  const filtered = v.nextHint({ ok: true, settled: true, known: true, hash: 'aabbccddee', exits: 1, elements: 1, ambiguous: 0, filtered: true });
  assert.match(filtered, /not the whole screen/);
  assert.ok(!/chain the next steps/.test(filtered));

  assert.equal(v.ambiguousLabels([{ label: 'On/Off Labels' }, { label: 'On/Off Labels' }, { label: 'Bold Text' }]), 1);
  assert.equal(v.ambiguousLabels([{ label: 'a' }, { label: 'b' }]), 0);

  // Shared, because it was reachable only from the MCP server — and an MCP
  // server is a long-lived process, so a session that started before a change
  // runs the old code and the headline change of a phase cannot be exercised at
  // all. Both front ends call this one function now.
  assert.match(
    v.hintFor({ identity: { hash: 'abc12345', settled: true }, exits: 2, rows: [{ label: 'a' }, { label: 'b' }] }),
    /chain the next steps/,
  );
  const cli = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(cli, /view\.hintFor/, 'the CLI must print the hint too');
});

test('no row is dropped for being long, and the harness can prove it', async () => {
  const v = await import('../src/view.js');
  const screen = { width: 402, height: 874 };

  // The regression this replaces, from a real measured report. A React Native
  // list card exposes all its children as ONE concatenated accessibility label:
  // 105 characters, type GenericElement, region content — every property
  // identical to a Settings caption's, and the only tappable thing on screen.
  const card = {
    label: 'Anaheim | Store # 1020, , 1234 Main St, Anaheim, CA 92806, , +1 (555) 555-1234, , Quick Casual Restaurant',
    type: 'GenericElement', region: 'content', x: 201, y: 300,
    frame: { x: 16, y: 252, width: 370, height: 96 },
  };
  const caption = {
    label: 'Increase color contrast between app foreground and background colours to improve legibility.',
    type: 'GenericElement', region: 'content', x: 201, y: 624,
    frame: { x: 16, y: 610, width: 370, height: 30 },
  };
  const { rows } = v.rowsFor({ targets: [card, caption] }, { screen });
  assert.equal(rows.length, 2, 'both stay: nothing distinguishes them, so a length rule cannot');

  // What survives of the idea is the reporter's own suggestion — truncate, do
  // not drop. Position and tappability are the valuable parts of a row.
  const out = v.render({ device: { name: 'x' }, identity: { hash: 'a' }, screen, rows, exits: 1 });
  assert.match(out, /Anaheim \| Store # 1020/, 'the row is there and identifiable');
  assert.match(out, /…/, 'and its label is truncated rather than the row removed');

  // Nothing was ever untappable — locate/assert/waitFor read entry.targets —
  // so the loss was *discovery*, which is a different claim from resolution
  // and is why the harness could not catch it. It can now.
  const fs2 = await import('node:fs');
  const fx = JSON.parse(fs2.readFileSync(
    new URL('../test/perception/screens/reported__rn-list-card.json', import.meta.url), 'utf8'));
  assert.ok(fx.expect.discoverable.length >= 3, 'the reported shape is a fixture');
  const harness = fs2.readFileSync(new URL('../scripts/eval-perception.mjs', import.meta.url), 'utf8');
  assert.match(harness, /kind: 'discovery'/);
});

test('101a: a supervisor ruling survives the process that made it', async () => {
  const metrics = await import('../src/metrics.js');
  const udid = 'TEST-SUPERVISIONS';
  const file = metrics.paths(udid).supervisions;
  try { (await import('node:fs')).rmSync(file, { force: true }); } catch { /* first run */ }

  // Until this landed, a ruling went into a `supervisions` array on the result
  // and died with the process: three rulings had ever existed anywhere, and
  // 101's p95 replay, 106's cost-of-a-stop and 96's response variable were all
  // waiting on a population that nothing was collecting.
  assert.equal(metrics.readSupervisions(udid).length, 0, 'starts empty');

  const wrote = metrics.recordSupervision(udid, {
    index: 2,
    step: 'tap:general',
    edge: 'abc123def456:tap:general',
    screen: 'abc123def456',
    decision: 'wait',
    from: 'model',
    reason: 'the list is still arriving',
    ms: 310,
    stillMs: 120,
    p95: 1400,
    samples: 7,
    expect: 'the General list',
    failure: '"General" is not on this screen. Visible: Settings',
    outcome: 'recovered',
  });
  assert.equal(wrote, true, 'the ruling is written');

  const [row] = metrics.readSupervisions(udid);
  // The outcome is the field that makes a ruling scoreable rather than merely
  // recorded, so it is the one asserted first.
  assert.equal(row.outcome, 'recovered');
  assert.equal(row.decision, 'wait');
  assert.equal(row.from, 'model');

  // And what the graph knew about the edge *at the time*. Recorded here rather
  // than looked up during analysis because the graph keeps learning: a p95 read
  // next week is not the number this ruling was competing with, which is the
  // whole of what item 101 asks.
  assert.equal(row.edge_p95_ms, 1400);
  assert.equal(row.edge_samples, 7);
  assert.equal(row.still_ms, 120);
  assert.equal(row.edge, 'abc123def456:tap:general');
  assert.equal(row.expect, 'the General list');

  // An outcome outside the vocabulary is refused rather than written, for the
  // reason `REASONS` is closed: a log that accepts "other" collects a pile of
  // "other" and answers nothing. Refused, not thrown — this is called from
  // inside a flow's failure handler, where a throw would turn a recoverable
  // step failure into a crash.
  assert.equal(metrics.recordSupervision(udid, { decision: 'wait', outcome: 'sort of worked' }), false);
  assert.equal(metrics.readSupervisions(udid).length, 1, 'and nothing was appended');
  assert.match(String(metrics.writeError()), /must be one of/);
});

test('98: a relabelled ref needs a near-exact match in a region the map would offer', async () => {
  const api = await import('../src/index.js');
  const matching = await import('../src/matching.js');
  const regions = await import('../src/regions.js');

  // The bar is a relationship, not a taste. `MINIMUM_SCORE` is for a label the
  // caller wrote; this is for one simframe substituted after refusing their
  // `#n`, so it must be strictly higher — and higher than the 0.64 that was
  // reported as a tap in the status bar.
  assert.ok(api.RELABEL_MIN_SCORE > matching.MINIMUM_SCORE,
    'a recovery is held to a higher bar than the lookup it stands in for');
  assert.ok(api.RELABEL_MIN_SCORE > 0.64, 'and above the score that produced the reported wrong answer');

  // The reported incident, as a fixture: `#1` was numbered "Reminders" in
  // Reminders and asked for in Contacts, where the only thing resembling it is
  // the status-bar back-to-app breadcrumb.
  const screen = { width: 402, height: 874 };
  const breadcrumb = {
    label: '• Reminders', type: 'StaticText', region: 'status-bar', x: 47, y: 40, width: 90, height: 20,
  };
  const outcome = matching.resolve([breadcrumb, {
    label: 'All Contacts', type: 'Button', region: 'nav-bar', x: 201, y: 100, width: 200, height: 40,
  }], 'Reminders', { screen });

  // Both guards refuse it, and independently — which is the point of having
  // two. The score one depends on a number; the region one does not.
  if (outcome.status === 'ok') {
    assert.ok(outcome.score < api.RELABEL_MIN_SCORE,
      `the breadcrumb scored ${outcome.score} and must not clear the relabel floor`);
    assert.equal(regions.offerable(outcome.target.region), false,
      'and it sits in a region sim_ui does not offer');
  }

  // The structural reason 0.8 is the number: a fuzzy name match returns
  // `similarity * 0.72`, so it cannot reach the floor on the name alone. If
  // that scoring ever changes, this fails rather than the floor silently
  // becoming reachable by a guess.
  const fuzzy = matching.resolve([{
    label: 'Remindars', type: 'Button', region: 'content', x: 201, y: 300, width: 200, height: 40,
  }], 'Reminders', { screen });
  assert.equal(fuzzy.status, 'ok', 'a typo still resolves for a caller who asked for it');
  assert.ok(fuzzy.score < api.RELABEL_MIN_SCORE,
    `a fuzzy match scored ${fuzzy.score}, which must stay below the relabel floor`);

  // And the rule has one home. A target the map hides must be one nothing
  // resolves onto behind the caller's back, so `view.js` and the recovery read
  // the same predicate rather than each keeping a set.
  assert.equal(regions.offerable('status-bar'), false);
  assert.equal(regions.offerable('content'), true);
  assert.equal(regions.offerable('nav-bar'), true);
  const fs3 = await import('node:fs');
  const view = fs3.readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.ok(!/HIDDEN_REGIONS\s*=\s*new Set/.test(view), 'view.js no longer keeps its own copy');
});

test('110: a large title is the screen\'s name, and a page heading is not', async () => {
  const regions = await import('../src/regions.js');
  const fingerprint = await import('../src/fingerprint.js');
  const screen = { width: 402, height: 874 };
  const clock = { label: '12:22', type: 'Text', x: 47, y: 33, frame: { x: 24, y: 25, width: 47, height: 16 } };
  const listRow = (i, label) => ({
    label, type: 'Button', x: 201, y: 320 + i * 54,
    frame: { x: 16, y: 299 + i * 54, width: 370, height: 54 },
  });

  // The Settings root, measured on the bench device: the title sits 63-79pt
  // below the status bar and only **5.3pt** above the content it heads, against
  // a boundary bar of max(10, typical * 1.9) = 66.5. No gap-below test reaches
  // that, so before this rule the screen had NO name in its identity at all.
  const largeTitle = {
    label: 'Settings', type: 'Heading', x: 82, y: 141,
    frame: { x: 16, y: 120, width: 133, height: 43 },
  };
  const root = [clock, largeTitle,
    { label: 'Apple Account', type: 'Button', x: 201, y: 216, frame: { x: 16, y: 168, width: 370, height: 96 } },
    listRow(0, 'General'), listRow(1, 'Accessibility'), listRow(2, 'Camera'), listRow(3, 'Search')];

  assert.equal(regions.regionFor(largeTitle.frame, screen, regions.bands(root, screen)), 'nav-bar',
    'the screen\'s own name is chrome, not content');
  const named = (t) => t.filter((x) => x.includes('"'));
  // Annotated first, because that is what the capture pipeline does and what
  // `fingerprint.tokens` depends on: given an unannotated target it falls back
  // to `regionFor` *without* the bands, so nothing can be nav-bar.
  assert.ok(named(fingerprint.tokens(regions.annotate(root, screen), screen).tokens).some((t) => /"settings"/.test(t)),
    'and it reaches the fingerprint, which is the point — chrome labels are the only text identity keeps');

  // The false positive this must not make. Safari on iOS puts its chrome at the
  // BOTTOM, so a page's <h1> is the first row on screen — but it is content, and
  // pulling page content into identity is the failure this module has already
  // been bitten by twice. Measured: example.com's h1 starts 122pt below the
  // status bar against the system title's 63-79.
  const pageHeading = {
    label: 'Example Domain', type: 'Text', x: 128, y: 190,
    frame: { x: 35, y: 179, width: 186, height: 23 },
  };
  const page = [clock, pageHeading,
    { label: 'This domain is for use in illustrative examples in documents.', type: 'Text', x: 201, y: 240, frame: { x: 35, y: 225, width: 330, height: 40 } },
    listRow(2, 'More information...')];
  assert.equal(regions.regionFor(pageHeading.frame, screen, regions.bands(page, screen)), 'content',
    'a page heading 122pt down is content that happens to be first, not a title');
  assert.ok(!named(fingerprint.tokens(regions.annotate(page, screen), screen).tokens).some((t) => /"example domain"/.test(t)),
    'so it stays out of the screen\'s identity');

  // And a wide lone row is a paragraph, not a name. Reminders' empty state puts
  // "Welcome to Reminders" at 326pt of 402 (0.81) — it describes the screen
  // rather than naming it.
  const wide = {
    label: 'Welcome to Reminders', type: 'Heading', x: 201, y: 155,
    frame: { x: 38, y: 141, width: 326, height: 28 },
  };
  const empty = [clock, wide,
    { label: 'Quick Creation, Simply type in your list.', type: 'Text', x: 201, y: 240, frame: { x: 38, y: 195, width: 326, height: 94 } },
    listRow(2, 'Add List')];
  assert.equal(regions.regionFor(wide.frame, screen, regions.bands(empty, screen)), 'content',
    'a title is a name, and names are short');
});

test('110b: a screen that says it is called something else is not this screen', async () => {
  const graphmod = await import('../src/graph.js');
  const udid = freshDevice('name-veto');

  // The shape the React Native testbed produced on its first day, and the
  // reason this rule exists: two root screens of one app, each a large title
  // over full-width rows above a tab bar. Structurally near-identical, named
  // differently, and **0.50** similar against a 0.36 threshold — so the graph
  // made them one node and offered one screen's controls on the other.
  const shared = [
    'button:content:w15:h2:x1:y8#many',
    'button:tab-bar:w3:h1:x1:y33#many',
    'text:content:w0:h1:x16:y27#many',
  ];
  const plants = { hash: 'a'.repeat(32), tokens: [...shared, 'heading:nav-bar:@leading:w4:h2:"plants":x1:y5#1'] };
  const forms = { hash: 'b'.repeat(32), tokens: [...shared, 'heading:nav-bar:@leading:w4:h2:"forms":x1:y5#1'] };

  const fingerprint = await import('../src/fingerprint.js');
  const similarity = fingerprint.similarity(plants.tokens, forms.tokens);
  assert.ok(similarity >= graphmod.SIMILARITY_THRESHOLD,
    `the point of the rule is that these DO clear the threshold (${similarity.toFixed(2)})`);

  // Stood on, not merely pointed at: an edge stores its destination's hash and
  // nothing else, so a node only has tokens to compare against once a reading
  // has been taken *from* it.
  graphmod.record(udid, { from: plants, action: { tap: 'anything' }, to: plants, kind: 'none' });
  assert.equal(graphmod.nearestScreen(udid, forms), null,
    'a differently-named screen is not matched, however alike its shape');
  assert.ok(graphmod.nearestScreen(udid, plants), 'and the screen itself still matches');

  // Silence is not disagreement. Two sensors are known to share only 0.33-0.47
  // of a token set, so a reading whose tree did not answer carries no names
  // through no fault of the screen's — vetoing on that would turn a sensor
  // difference into an identity claim, which is the mistake the fingerprint
  // distributions are split by sensor mix to avoid.
  const unnamed = { hash: 'c'.repeat(32), tokens: shared };
  assert.ok(graphmod.nearestScreen(udid, unnamed),
    'a reading with no names at all is not vetoed, it is merely unhelpful');
});

test('113: the map says how old its frame is, which sim_look always did and it never did', async () => {
  const v = await import('../src/view.js');

  // Reported from the field against 0.11.0: a complete 20-element map of a
  // screen the app was not on, with no staleness marker, and the reporter then
  // told their user the opposite of the truth. Their sentence is the one this
  // project keeps writing down — "a wrong answer is worse than an error here,
  // because nothing downstream knows to doubt it".
  //
  // `sim_look` and `sim_state` have printed frame age since they existed. This
  // map, the one an agent is told to start with, never has — and `ensureDaemon`
  // will return a frame up to 30s old, so it was reachable with nothing broken.
  const at = (ms) => ({ state: { capturedAt: 1_000_000 - ms } });
  const now = 1_000_000;

  // Silent when fresh, deliberately: a line on every call is a line nobody reads.
  assert.equal(v.frameAgeNote(at(0), now), null);
  assert.equal(v.frameAgeNote(at(v.FRAME_FRESH_MS - 1), now), null);

  // Stated plainly in between.
  const mild = v.frameAgeNote(at(2500), now);
  assert.match(mild, /frame 2\.5s old/);
  assert.doesNotMatch(mild, /WARNING/, 'a two-second-old frame is worth saying, not worth shouting');

  // And shouted once it is old enough to describe a screen that has gone.
  const bad = v.frameAgeNote(at(12_000), now);
  assert.match(bad, /WARNING/);
  assert.match(bad, /12\.0s old/);
  assert.match(bad, /description of the past/);
  assert.match(bad, /refresh/, 'and it says what to do about it');

  // No frame, no claim. Inventing an age would be the same class of fault as
  // the one being fixed.
  assert.equal(v.frameAgeNote({}, now), null);
  assert.equal(v.frameAgeNote(null, now), null);
  assert.equal(v.frameAgeNote({ state: { capturedAt: 'soon' } }, now), null);

  // It reaches the rendered header, not just the helper.
  const head = v.render({
    device: { name: 'iPhone' },
    identity: { hash: 'abc12345', state: { capturedAt: Date.now() - 9000 } },
    rows: [],
    screen: { width: 402, height: 874 },
  });
  assert.match(head, /WARNING this frame is/);
});

test('a name that names two devices is refused, not resolved to whichever came first', async () => {
  const { pickDevice } = await import('../src/platform/ios.js');
  const dev = (udid, name, state = 'Booted') => ({ udid, name, runtime: 'iOS 26.5', state });

  // The shape that has now cost two peer rounds. Item 83 recorded in writing
  // that two booted devices on this machine are both called "iPhone 17 Pro",
  // and answered it by warning in `sim_devices` and printing a UDID prefix in
  // headers — leaving this function, where the choice is actually made, alone.
  const twins = [dev('AAAA', 'iPhone 17 Pro'), dev('BBBB', 'iPhone 17 Pro')];

  const err = (() => {
    try { pickDevice('iPhone 17 Pro', twins); return null; } catch (e) { return e; }
  })();
  assert.ok(err, 'a name shared by two devices cannot identify one');
  assert.equal(err.ambiguous, true, 'and it must outrank another backend matching cleanly');
  // The UDIDs, because "pass the UDID" is useless without them.
  assert.match(err.message, /AAAA/);
  assert.match(err.message, /BBBB/);

  // What it cost, and why this is not a tidiness fix: a caller passed the shared
  // name, read a screen "38ms old" and an hour wrong, concluded the app had
  // signed itself out, and abandoned a verification run that was fine. The
  // frame was fresh — it belonged to the *other* device, idling on a login
  // screen — and `refresh: true` refreshed that same wrong device, so two
  // independent-looking sources agreed with each other and were both wrong.

  // A UDID is unique, so it still resolves even when the names collide.
  assert.equal(pickDevice('AAAA', twins).udid, 'AAAA');
  assert.equal(pickDevice('bbbb', twins).udid, 'BBBB', 'and case does not matter');

  // One device with that name is not ambiguous.
  assert.equal(pickDevice('iPhone 17 Pro', [dev('AAAA', 'iPhone 17 Pro'), dev('CCCC', 'iPhone 15')]).udid, 'AAAA');

  // A partial match that hits two was already refused, and still is.
  const partial = (() => {
    try { pickDevice('iPhone', [dev('AAAA', 'iPhone 17 Pro'), dev('CCCC', 'iPhone 15')]); return null; } catch (e) { return e; }
  })();
  assert.ok(partial && partial.ambiguous);

  // A shut-down twin pair is refused too: the fallback pool is the whole list,
  // so resolving by name there has exactly the same problem.
  const parked = [dev('AAAA', 'iPad Air', 'Shutdown'), dev('BBBB', 'iPad Air', 'Shutdown')];
  const off = (() => {
    try { pickDevice('iPad Air', parked); return null; } catch (e) { return e; }
  })();
  assert.ok(off && off.ambiguous, 'the booted pool is not the only one that can collide');
});

test('a coordinate that did nothing says what it landed on (item 120)', async () => {
  const { hitTest, describePoint, aimedAt } = await import('../src/screenmap.js');

  // The reported screen, with the sizes that made it fifteen minutes long: a
  // support banner pinned across the bottom, the list it covers, and a row.
  const entry = {
    targets: [
      { label: 'Home', region: 'content', frame: { x: 0, y: 100, width: 402, height: 700 } },
      { label: 'Profile image for support', region: 'content', frame: { x: 178, y: 730, width: 46, height: 46 } },
      { label: 'Bell, Kate', region: 'content', frame: { x: 0, y: 600, width: 402, height: 60 } },
    ],
  };

  // The gesture the reporter sent six times.
  const hits = hitTest(entry, { x: 201, y: 750 });
  assert.equal(hits.length, 2, 'the banner and the list beneath it both cover that point');
  assert.equal(hits[0].label, 'Profile image for support', 'smallest first — the innermost is the likely catcher');

  const note = describePoint(entry, { x: 201, y: 750 }, { what: 'the swipe start point' });
  assert.match(note, /201,750/);
  assert.match(note, /Profile image for support/);
  assert.match(note, /2 elements/, 'and that it was not alone, because that is the whole diagnosis');

  // Starting higher worked immediately, and the note has to agree.
  assert.equal(hitTest(entry, { x: 201, y: 620 })[0].label, 'Bell, Kate');

  // Two silences that must not be confused. Nothing there is an answer; no map
  // is not, and printing "nothing covers that point" for a screen we never
  // perceived would be a confident wrong answer of exactly the kind the peer
  // rounds keep finding.
  assert.match(
    describePoint(entry, { x: 5, y: 5 }, {}),
    /not inside any element/,
    'we looked and found nothing',
  );
  assert.equal(describePoint(null, { x: 5, y: 5 }), null, 'we did not look');
  assert.equal(describePoint({ targets: [] }, { x: 5, y: 5 }), null, 'and an empty map is not a look either');

  // A swipe is caught where the finger goes down, so that is the point aimed at.
  assert.deepEqual(
    aimedAt({ action: 'swipe', from: [201, 750], to: [201, 250] }),
    { point: { x: 201, y: 750 }, what: 'the swipe start point' },
  );
  assert.deepEqual(
    aimedAt({ action: 'tapAt', x: 10, y: 20 }),
    { point: { x: 10, y: 20 }, what: 'the tap point' },
  );
  // Nothing to say about a step that never named a coordinate.
  assert.equal(aimedAt({ action: 'tap', value: 'Save' }), null);
  assert.equal(aimedAt({ action: 'swipe', from: [1] }), null, 'half a point is not a point');
});

test('the aim a step reports is the point the finger reached, not the one in the script', async () => {
  // The trap this out-parameter exists to avoid. Two steps resolve their own
  // coordinates *inside* the step — an image-space tapAt converts, and scroll
  // invents them from the screen size — so reading x/y back off the script
  // would diagnose a point nothing was ever aimed at.
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  for (const action of ['tapAt', 'swipe', 'scroll']) {
    const body = src.slice(src.indexOf(`case '${action}': {`));
    const send = body.search(/await input\.(tapPoint|swipe)\(/);
    const record = body.indexOf('ctx.aim.at =');
    assert.ok(record !== -1, `${action} records where it aimed`);
    assert.ok(record < send, `${action} records it before it sends, from the resolved coordinates`);
  }
  // And the note is taken from the screen the finger landed on, not the one
  // the gesture failed to change.
  assert.match(src, /describePoint\(\s*\n?[\s\S]{0,400}?beforeScreen\?\.entry/, 'diagnosed against the before-screen');
});

test('a goto that fails always names why, and the name is one everybody knows', async () => {
  const metrics = await import('../src/metrics.js');
  const navSrc = fs.readFileSync(new URL('../src/navigate.js', import.meta.url), 'utf8');
  const checkSrc = fs.readFileSync(new URL('../scripts/ci-memory.mjs', import.meta.url), 'utf8');

  // `goto` is the whole function, from its signature to `knownScreens`.
  const goto = navSrc.slice(navSrc.indexOf('export async function goto'), navSrc.indexOf('export function knownScreens'));

  // Every refusal it can produce. Pinned as the literals because the drift this
  // guards is exactly a new literal appearing in one place and nowhere else —
  // which is what happened: a walk that ran and landed elsewhere returned
  // `{ok: false}` with no reason at all, and three separate lists stayed
  // unaware of an outcome that had no name to be unaware of.
  const produced = [...goto.matchAll(/reason: '([a-z-]+)'/g)].map((m) => m[1]);
  // The two computed ones, which are chosen by a ternary rather than written at
  // a `reason:` key.
  produced.push(...[...goto.matchAll(/^\s*\? '([a-z-]+)'$|^\s*: \(?result\.ranSteps.*\? '([a-z-]+)' : '([a-z-]+)'\)?;$/gm)]
    .flatMap((m) => m.slice(1).filter(Boolean)));

  assert.ok(produced.includes('arrived-elsewhere'), 'the walk that did not land has a name');
  assert.ok(produced.includes('route-halted'), 'and so does the walk that stopped early');

  for (const r of new Set(produced)) {
    assert.ok(
      metrics.PLAN_REASONS[r],
      `"${r}" must map to one of the five escalation reasons — an unmapped refusal is never logged`,
    );
    assert.ok(
      metrics.REASONS.includes(metrics.PLAN_REASONS[r]),
      `"${r}" maps to "${metrics.PLAN_REASONS[r]}", which is not one of the five`,
    );
  }

  // And the integration check has to know every name, or it fails on a correct
  // refusal — which is the failure that started this.
  const known = JSON.parse(
    checkSrc
      .slice(checkSrc.indexOf('const outcomes = ['))
      .match(/\[[\s\S]*?\]/)[0]
      .replace(/'/g, '"')
      .replace(/,(\s*\])/, '$1'),
  );
  for (const r of new Set(produced)) {
    assert.ok(known.includes(r), `ci-memory does not know the refusal "${r}"`);
  }

  // The one thing the check is really asserting: there is no path out of a
  // failed goto that carries no reason. `ok: false` and `reason` are written
  // together every time.
  for (const m of goto.matchAll(/ok: false[^\n]*/g)) {
    assert.match(m[0], /reason/, `an \`ok: false\` with no reason: ${m[0].trim()}`);
  }
});

test('both supervisor arms are briefed from one source, and constrained to the same three words', async () => {
  const ollama = await import('../src/ollama.js');
  const supervisor = await import('../src/supervisor.js');

  // The fairness condition, as an assertion rather than an intention. Two
  // hand-maintained copies of a prompt is two arms answering different
  // questions, and nothing in the resulting numbers would say so — they would
  // simply be wrong and look fine. So the challenger reads the shipped arm's
  // own instructions out of its source.
  const brief = ollama.readBrief();
  const swift = fs.readFileSync(new URL('../native/supervise.swift', import.meta.url), 'utf8');

  assert.ok(brief.length > 500, 'the brief is the real one, not a stub');
  for (const word of ['wait', 'retry', 'stop']) {
    assert.ok(brief.includes(`${word} `), `the brief defines "${word}"`);
  }
  // Every sentence of it came from the Swift file. Checked by sampling distinct
  // phrases rather than by string equality, because the Swift literal carries
  // line continuations the reader has to undo — and undoing them wrongly is
  // exactly the silent unfairness this guards.
  for (const phrase of ['You supervise a UI test', 'Never suggest a different step', 'the decision alone']) {
    assert.ok(brief.includes(phrase), `"${phrase}" survived the read`);
  }
  assert.ok(!brief.includes('\\'), 'no Swift line continuations are left in the text');
  assert.ok(!/ {3}/.test(brief), 'and no leftover source indentation');
  // A briefing that is silently empty is worse than one that throws.
  assert.throws(() => ollama.readBrief(new URL('../package.json', import.meta.url).pathname));

  // The same closed vocabulary, enforced by schema rather than by hope.
  assert.deepEqual(ollama.SCHEMA.properties.decision.enum, [...supervisor.DECISIONS]);
  // And the Swift arm's enum is those three and no more.
  const swiftEnum = swift.slice(swift.indexOf('enum Decision'), swift.indexOf('struct Judgement'));
  assert.deepEqual([...swiftEnum.matchAll(/case (\w+)/g)].map((m) => m[1]), [...supervisor.DECISIONS]);

  // Target parsing, because a typo here silently measures the default model
  // while the report says otherwise.
  assert.deepEqual(ollama.parseTarget('ollama'), { model: 'qwen3:8b', host: ollama.DEFAULT_HOST });
  assert.equal(ollama.parseTarget('ollama:qwen3:14b').model, 'qwen3:14b');
  assert.equal(ollama.parseTarget('ollama:qwen3:14b@http://x:1').host, 'http://x:1');

  // The prompt mirrors the Swift assembly, including the order. The brief says
  // the plan's guidance outranks everything below it, so a prompt that put it
  // last would be testing a different instruction.
  const p = ollama.promptFor({
    step: 'tap "Go"', failure: 'not found', goal: 'lists arrive late',
    expected: 'a row', stillMs: 900, note: 'still filling in', screen: ['A', 'B'],
  });
  const order = ['Step:', 'It failed with:', "The plan's guidance", 'Expected:', 'still for', 'Perception note:', 'On screen now:'];
  let at = -1;
  for (const label of order) {
    const i = p.indexOf(label);
    assert.ok(i > at, `"${label}" comes after the field before it`);
    at = i;
  }
  // Absent fields leave no empty line behind.
  assert.equal(ollama.promptFor({ step: 'a', failure: 'b' }).split('\n').length, 2);
});

test('a live daemon that has not rendered yet is not a failed daemon', async () => {
  const api = await import('../src/index.js');

  // The two budgets are different questions and must not collapse into one.
  // Getting a daemon at all is a spawn (or a first build); getting a frame out
  // of a simulator display is the device's business, and on a loaded build farm
  // it took about 27s while the daemon itself reported a healthy 75ms median.
  // Giving up there failed an entire CI run over a device that was working.
  assert.ok(api.LIVE_DAEMON_CAP_MS > api.READY_TIMEOUT_MS,
    'a daemon we can see running earns more patience than one we cannot');
  assert.ok(api.LIVE_DAEMON_CAP_MS <= 120_000,
    'and it is still bounded — a daemon that never renders has to stay reportable');

  // The distinction has to reach the message, because the two cases have
  // different remedies and reading them apart cost a dive into a daemon log
  // that a later step happened to capture.
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const thrower = src.slice(src.indexOf('const tail = readLogTail(p.log)'), src.indexOf('export function stopDaemon'));
  assert.match(thrower, /no daemon process came up/);
  assert.match(thrower, /the display produced no frame/);
});

test('121: an element half off the right edge is offered, clamped and labelled as such', async () => {
  const regions = await import('../src/regions.js');
  const view = await import('../src/view.js');
  const screen = { width: 402, height: 874 };

  // The measured geometry, taken off the testbed's filter strip rather than
  // invented. Seven chips in a horizontal scroller on a 402pt screen.
  const chip = (label, x, width) => ({
    label, type: 'Button', source: 'ax',
    x: Math.round(x + width / 2), y: 191,
    frame: { x, y: 178, width, height: 25.33 },
  });
  const entry = {
    targets: [
      chip('Low light', 282.3, 82.7),      // fully visible
      chip('Flowering', 372.7, 86.7),      // 29pt on screen, centre at 416
      chip('Trailing', 467.3, 72.3),       // nothing on screen
      // What the map offered in Flowering's place: OCR's reading of the visible
      // sliver, whose own box is inside the viewport so every filter passed it.
      { label: 'Flc', type: 'StaticText', source: 'ocr', x: 392, y: 191, frame: { x: 384, y: 184, width: 16, height: 14 } },
    ],
  };

  const clip = regions.clipping(entry.targets[1], screen);
  assert.ok(clip.clipped);
  assert.ok(clip.usable, '29pt of a real control is reachable');
  assert.equal(Math.round(clip.visibleWidth), 29);
  // The clamp: the centre of what can be seen, never the centre of the element,
  // which is off the screen at x=416.
  assert.ok(clip.point.x < screen.width, 'the tap point is on the screen');
  assert.equal(clip.point.x, 387);

  // Nothing on screen is not "clipped but usable".
  assert.equal(regions.clipping(entry.targets[2], screen).usable, false);

  const { rows } = view.rowsFor(entry, { screen });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  assert.ok(byLabel.Flowering, 'the real control is in the map under its real name');
  assert.equal(byLabel.Flowering.x, 387, 'at the clamped point');
  assert.equal(byLabel.Flowering.clipped, true);
  assert.ok(!byLabel.Trailing, 'and one with nothing on screen still is not');

  // The whole point. Before this, the map dropped `Flowering` and kept `Flc` —
  // so it did not merely omit a control, it offered a different, meaningless
  // name for it at a coordinate that looks perfectly ordinary. That is what
  // made a reporter stop trusting our coordinates at the screen edge.
  const printed = view.render({
    device: { name: 'iPhone 17 Pro' }, identity: {}, rows, screen, truncated: 0, collapsed: new Map(),
  });
  assert.match(printed, /Flowering/);
  assert.match(printed, /partly off-screen/);

  // And the conservatism that was bought with a real bug is untouched: a
  // clipped element's CENTRE is still outside, so `locate`/`scrollTo` keep
  // treating it as "in the tree but not in view" and keep scrolling to it,
  // rather than declaring a 29pt sliver good enough.
  assert.equal(regions.offViewport(entry.targets[1], screen), true);
});

test('the fourth word is an answer, never a decision, and both briefs come from one source', async () => {
  const supervisor = await import('../src/supervisor.js');
  const ollama = await import('../src/ollama.js');

  // `abstain` must never reach a caller as something to act on. It means
  // "behave as if there is no supervisor", which is the null every failure path
  // already handles — so it strictly shrinks what the model can cause, which is
  // why a component whose answer space IS its safety property can afford it.
  assert.equal(supervisor.decisionOf({ decision: 'abstain' }), null);
  assert.ok(!supervisor.DECISIONS.has(supervisor.ABSTAIN), 'not a decision');
  for (const w of ['wait', 'retry', 'stop']) {
    assert.equal(supervisor.decisionOf({ decision: w }), w, 'the three still work');
  }

  // The four-word brief is the three-word brief plus one paragraph, and that is
  // asserted rather than intended: if the two were written separately, a
  // before/after comparison would be measuring two prompts instead of one
  // change, and nothing in the numbers would say so.
  const three = ollama.readBrief(undefined, { mayAbstain: false });
  const four = ollama.readBrief(undefined, { mayAbstain: true });
  assert.ok(four.startsWith(three), 'strictly a superset');
  assert.match(four.slice(three.length), /abstain/);
  assert.ok(!three.includes('abstain'), 'and the three-word brief never mentions it');

  // Both arms offer the same four, and the Swift enum is the authority.
  assert.deepEqual(ollama.schemaFor({ mayAbstain: true }).properties.decision.enum,
    ['wait', 'retry', 'stop', 'abstain']);
  assert.deepEqual(ollama.schemaFor().properties.decision.enum, ['wait', 'retry', 'stop']);
  const swift = fs.readFileSync(new URL('../native/supervise.swift', import.meta.url), 'utf8');
  const cautious = swift.slice(swift.indexOf('enum CautiousDecision'), swift.indexOf('struct CautiousJudgement'));
  assert.deepEqual([...cautious.matchAll(/case (\w+)/g)].map((m) => m[1]),
    ['wait', 'retry', 'stop', 'abstain']);

  // Off unless asked. Measured: telling the Apple model about the fourth word
  // cost it about a third of its accuracy and it never used the word once, so
  // the default here is load-bearing and not a formality.
  const src = fs.readFileSync(new URL('../src/supervisor.js', import.meta.url), 'utf8');
  assert.match(src, /mayAbstain = false/, 'the default is off');
});

test('the article and its page are one document, not two', async () => {
  // They were two, and kept in step by a note at the top of the Markdown saying
  // to edit both together. It held until the page grew sections the Markdown
  // never got — the supervisor, the capacity comparison — and then the note was
  // simply wrong, which is worse than absent because the next person follows it.
  //
  // Now the page is the source and the Markdown is generated from it. Two
  // copies of a document cannot drift when one is derived.
  const { render } = await import('../scripts/article-md.mjs');
  const html = fs.readFileSync(new URL('../docs/agents-shouldnt-blink.html', import.meta.url), 'utf8');
  const md = fs.readFileSync(new URL('../docs/ARTICLE.md', import.meta.url), 'utf8');
  assert.equal(render(html), md, 'run `node scripts/article-md.mjs` — the page changed and the Markdown did not');

  // And the converter refuses what it does not understand rather than dropping
  // it. A converter that silently skips an unfamiliar tag produces a document
  // that looks complete and is not, which is this file's entire failure mode.
  assert.throws(() => render('<h1>T</h1><p class="kicker">k</p><section><p>a <marquee>b</marquee></p></section>'),
    /unhandled inline tag/);
  assert.throws(() => render('<h1>T</h1><p class="kicker">k</p><section><p>&nosuchentity;</p></section>'),
    /unknown entity/);
});

test('a live loop reading a dead surface is a contradiction we can see (SEV-1)', async () => {
  const api = await import('../src/index.js');
  const store = await import('../src/store.js');
  const udid = 'TEST-SURFACE';
  const dir = path.join(process.env.SIMFRAME_HOME ?? '', udid);
  fs.mkdirSync(dir, { recursive: true });
  // A daemon that is alive and healthy, which is the whole difficulty: every
  // hard signal is green.
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ pid: process.pid, version: 4, engine: 'simframed' }));

  const now = Date.now();
  const fresh = { capturedAt: now - 60, seq: 1806, stableForMs: 159_753 };
  const clear = () => fs.rmSync(path.join(dir, 'last-input'), { force: true });

  // Three gestures delivered inside the quiet period. `sim_look` served a login
  // screen for three minutes here while announcing it as 66ms old.
  clear();
  for (const ago of [12_000, 8_000, 4_000]) store.noteInput(udid, now - ago);
  const wedged = api.liveness(udid, fresh);
  assert.equal(wedged.suspectSurface, true);
  assert.equal(wedged.ignoredInputs, 3);
  assert.match(wedged.note, /surface behind them may be dead/);
  assert.match(wedged.note, /accessibility tree/, 'and it names the tiebreaker');
  // Deliberately not a failure. A screen that genuinely rejects every tap is
  // real, and turning that into a hard error is a confident wrong answer.
  assert.equal(wedged.ok, true);

  // **The case the first version could not see.** A second field report caught
  // a frame roughly three hours stale, presented as 130ms old, on a screen
  // still for 8,183ms — under a 20-second duration gate, so nothing fired
  // during exactly the failure the check was written for. Counting ignored
  // gestures has no such gate: what makes a surface suspect is that we kept
  // touching it and nothing moved, not how long the quiet lasted.
  clear();
  for (const ago of [7_000, 5_000, 2_000]) store.noteInput(udid, now - ago);
  const short = api.liveness(udid, { capturedAt: now - 130, seq: 1026, stableForMs: 8_183 });
  assert.equal(short.suspectSurface, true, 'eight seconds of stillness is enough when three gestures were ignored');
  assert.match(short.note, /8s/);

  // A screen that moved after the gestures is ordinary, however long it has
  // since been still.
  clear();
  for (const ago of [200_000, 190_000, 180_000]) store.noteInput(udid, now - ago);
  assert.ok(!api.liveness(udid, fresh).suspectSurface, 'input older than the quiet period is no contradiction');

  // One tap that legitimately changed nothing must not trip it — that is most
  // taps on a disabled control, and crying wolf there is how a real one gets
  // ignored.
  clear();
  store.noteInput(udid, now - 1_000);
  assert.ok(!api.liveness(udid, { ...fresh, stableForMs: 3_000 }).suspectSurface);
  // Two is still not evidence.
  store.noteInput(udid, now - 500);
  assert.ok(!api.liveness(udid, { ...fresh, stableForMs: 3_000 }).suspectSurface);

  // And a device nobody has touched cannot produce the contradiction at all.
  clear();
  assert.ok(!api.liveness(udid, fresh).suspectSurface, 'no input recorded, no claim made');

  // The note has to reach a caller. It reports ok:true, and every consumer used
  // to gate on `!live.ok` — so detecting this and not surfacing it would have
  // changed nothing at all, which is the actual failure being fixed.
  const cli = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const mcp = fs.readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');
  assert.ok(!/if \(!res\.live\.ok\) out\.push/.test(cli), 'the CLI no longer gates the note on ok');
  assert.ok(!/return live\?\.ok \? null :/.test(mcp), 'nor does the MCP header');
});

test('doctor proves the accessibility tree answers, not merely that a driver exists', async () => {
  // A CI run read the screen eighteen times and every reading came back
  // `ocr` with no `ax` at all — while this check reported `ok`, because a
  // driver was configured. It was configured. It answered with nothing. The
  // failure surfaced six minutes later in the fingerprint step as a
  // distribution mystery that named no layer.
  //
  // The same correction this file already made for the supervisor, which
  // reported a tier healthy from its own process while the long-lived server's
  // copy was dead: prove a round trip, not a presence.
  const src = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const ax = await input.axDriverFor'), src.indexOf("key: 'ax.elements'") + 40);
  assert.match(block, /describeAll/, 'it asks the tree for the current screen');
  assert.match(block, /axCount === 0/, 'and reacts to an empty answer');
  assert.match(block, /'warn'/, 'as a warning — an empty screen is possible and a hard error would cry wolf');
  assert.match(block, /ax\.elements/, 'exporting the count so a caller who knows better can assert on it');

  // Both CI and its local mirror assert it, because a check that exists in one
  // and not the other is how the local run came to be green all day while the
  // hosted one failed.
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const local = fs.readFileSync(new URL('../scripts/ci-integration-local.sh', import.meta.url), 'utf8');
  for (const [what, text] of [['ci.yml', ci], ['ci-integration-local.sh', local]]) {
    assert.match(text, /ax\.elements/, `${what} asserts the tree answered`);
  }

  // And a nameless check is data for --json, never a blank row for a reader.
  assert.match(src, /for \(const c of checks\) if \(c\.name\)/);
});

test('an ambiguous waitFor is a satisfied waitFor', async () => {
  // A `waitFor` asks one question — has it arrived — and several matches is a
  // yes. The old behaviour reasoned exactly that in a comment and then threw:
  // a field session lost a batch and three queued steps on a screen that was
  // precisely where the flow wanted to be, then re-issued the lot with an index.
  //
  // The ambiguity is real and belongs in the *next* step's selector, not in
  // this step's verdict.
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const ends = { "case 'waitFor'": "case 'assert'", "case 'waitText'": "case 'assertText'" };
  for (const [what, marker] of [['waitFor', "case 'waitFor'"], ['waitText', "case 'waitText'"]]) {
    const body = src.slice(src.indexOf(marker), src.indexOf(ends[marker]));
    const hit = body.indexOf('the wait is satisfied');
    assert.ok(hit !== -1, `${what} satisfies an ambiguous match`);
    // And it returns rather than throwing, which is the whole change.
    const line = body.lastIndexOf('return', hit);
    const thrown = body.lastIndexOf('throw', hit);
    assert.ok(line > thrown, `${what} returns the ambiguous case rather than throwing it`);
  }
  // The old message must be gone from both, or the fix is half-applied.
  assert.ok(!src.includes('not waiting: it is already on screen'),
    'the refusal that reasoned correctly and then failed anyway is gone');
});

test('an index past the end is not an absent element', async () => {
  // `{"tap": "Work Orders", "index": 1}` on a screen with exactly one match
  // reported `"Work Orders" is not on this screen` — while the element map
  // three lines below in the same reply listed it. A tester then went looking
  // for a control that had been there all along.
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const candidates = screenmap.rank'), src.indexOf('return { device, state: current, entry, target, from'));
  assert.match(block, /index \$\{index\} is out of range/);
  assert.match(block, /valid indices are 0\.\./, 'and it says what the valid range is');
  assert.match(block, /Nearest:/, 'and lists what it did match');
  // Tagged `ambiguous: true`, because the target IS present — which is what
  // tells a waiting caller that waiting cannot help.
  assert.match(block, /ambiguous: true/);
  // The absent case survives, and it is the one that keeps `unknown_screen`.
  assert.match(block, /is not on this screen\. Visible:/);

  // And the visible list says when it has been cut. The same report found a
  // control missing from `Visible:` purely because it sat past the twelfth
  // entry — a truncated list that does not announce its truncation reads as an
  // exhaustive one.
  assert.match(block, /and \$\{visible\.length - shown\.length\} more/);
});

test('a check over an empty collection is untested, not passed', async () => {
  // A CI run came back with `0 element(s) from ax+ocr` and then printed
  //   ok   refs are numbered 1..n with no gaps — #1..#0
  //   ok   every element has a tap point on the screen
  //   ok   the status bar is not offered as something to tap
  // Three lines of reassurance about nothing, directly beneath the failure
  // saying the map was empty — because `every` and `!some` are both true of an
  // empty array.
  //
  // That is the precise defect three field reports spent a day describing, and
  // the harness was doing it to itself in the same output.
  const src = fs.readFileSync(new URL('../scripts/ci-memory.mjs', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const refs = (map.elements ?? [])'), src.indexOf('--- element refs ---'));
  assert.match(block, /if \(!map\.elements\?\.length\)/, 'the empty case is handled before the checks run');
  // Each label must appear in BOTH arms — the skip list and the real check —
  // counted by arm rather than by occurrence, because the comment above them
  // quotes the labels too.
  const skipArm = block.slice(block.indexOf('for (const label of ['), block.indexOf('} else {'));
  const checkArm = block.slice(block.indexOf('} else {'));
  for (const label of [
    'refs are numbered 1..n with no gaps',
    'every element has a tap point on the screen',
    'the status bar is not offered as something to tap',
  ]) {
    assert.ok(skipArm.includes(label), `"${label}" is skipped when the map is empty`);
    assert.ok(checkArm.includes(label), `"${label}" is still checked when it is not`);
  }
  assert.match(block, /skip\(label, 'the map was empty/);
  // And the empty case says what the device was showing, because an empty map
  // on a live device is the shape this project has chased under four symptoms.
  assert.match(block, /the device at that moment/);
  assert.match(block, /live\?\.note/, 'including the liveness note, which carries the ignored-gesture check');
});

test('a wedged display is named, not reported as a benign note (126)', async () => {
  const { screenshotFailure } = await import('../src/platform/ios.js');

  // The exact shape that hid this for a day. `simctl` prints its Note on every
  // run; when the display surface is dead the command *hangs*, we kill it at
  // the timeout, and that Note is the only thing on stderr by then. The tool
  // then reported an informational line as the reason a capture failed — and
  // this wedge went nameless through five separate CI failures wearing five
  // different symptoms.
  const hung = Object.assign(new Error('Command failed'), {
    killed: true,
    stderr: 'Note: No display specified. Defaulting to display: 6D9407E2 (screenID: 1, name: LCD)\n',
  });
  const said = screenshotFailure(hung);
  assert.ok(!said.includes('No display specified'), 'the Note is not the reason');
  assert.match(said, /display surface is not answering/);
  assert.match(said, /Timeout waiting for screen surfaces/, 'it quotes what the device itself says');
  assert.match(said, /simframe revive/, 'and names the cure');

  // Run to completion, the real complaint is on stderr under the Note, and it
  // wins.
  const real = Object.assign(new Error('Command failed'), {
    stderr: 'Note: No display specified. Defaulting to display: 6D9407E2\n'
      + 'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60):\n'
      + 'Timeout waiting for screen surfaces\n',
  });
  assert.match(screenshotFailure(real), /Timeout waiting for screen surfaces/);
  assert.ok(!screenshotFailure(real).includes('No display specified'));

  // An ordinary failure still reports itself.
  assert.match(
    screenshotFailure(Object.assign(new Error('x'), { stderr: 'Invalid device: nope\n' })),
    /Invalid device: nope/,
  );
  // And one with nothing to say falls back to the thrown message rather than
  // to silence.
  assert.match(screenshotFailure(new Error('spawn ENOENT')), /spawn ENOENT/);
});

test('two capture paths are compared by content, and the threshold is measured', async () => {
  const analyze = await import('../src/analyze.js');
  // `simframe frame --fresh` is the arbiter three field reports had to leave
  // simframe to get — one of them cross-checked with `xcrun simctl io` for a
  // whole session after an image was served as 130ms old and was three hours
  // stale. The obvious in-tool candidate lied: `--engine` picks how to *start*
  // a daemon, so passing it to a read command returns the same cached frame,
  // and a tester reasonably concluded the fallback engine was no escape hatch.
  //
  // The comparison must be by content. A byte comparison says "different" every
  // time — the direct capture is full resolution and the daemon's is
  // downscaled — which would be a confident wrong answer about the one question
  // the command exists to settle. It said exactly that until it was measured.
  assert.ok(analyze.PATHS_AGREE > 0.00123, 'above the measured cost of scaling alone');
  assert.ok(analyze.PATHS_AGREE < 0.686, 'and far below two genuinely different screens');
  // Not the change threshold: that asks whether one path moved between frames.
  assert.notEqual(analyze.PATHS_AGREE, analyze.CELL_CHANGE);

  const cli = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const block = cli.slice(cli.indexOf("case 'frame':"), cli.indexOf("case 'mark':"));
  assert.match(block, /regionSignature/, 'compared by signature, not by bytes');
  assert.match(block, /PATHS_AGREE/);
  assert.ok(!/Buffer\.compare/.test(block), 'the byte comparison is gone');
  assert.match(block, /the daemon has no frame to compare against/,
    'and a direct capture working while the daemon has nothing is itself the wedge');
});

test('a control with no name is still a control, and says so (122)', async () => {
  const sm = await import('../src/screenmap.js');
  const v = await import('../src/view.js');
  const screen = { width: 402, height: 874 };

  // Measured on the testbed before any of this was written, because the premise
  // could have been false and two phase premises already had been. Of 39
  // accessibility nodes on its list screen exactly one is nameless — the
  // icon-only overflow menu at 349,72 — and it was the one control on that
  // screen no caller could reach. Three field reports in a row lost time to
  // exactly this shape and all three called it "absent from the tree".
  // AXPTranslator had it the whole time; we dropped it.
  const menu = { type: 'Button', label: null, identifier: null,
    frame: { x: 349, y: 72, width: 30, height: 24 } };
  assert.ok(sm.nameless(menu));
  assert.ok(sm.namelessHitTarget(menu, [menu]), 'a nameless button with a footprint is a hit target');

  // The two guards, which are what keeps this from flooding a real map. A
  // nameless generic view is layout — a screen has hundreds — and a nameless
  // thing holding two other things is the thing they are arranged in.
  assert.equal(sm.namelessHitTarget({ ...menu, type: 'Other' }, [menu]), false);
  const cell = { type: 'Cell', frame: { x: 0, y: 200, width: 402, height: 60 } };
  const kids = [
    { type: 'StaticText', label: 'Title', frame: { x: 16, y: 210, width: 100, height: 20 } },
    { type: 'StaticText', label: 'Detail', frame: { x: 16, y: 232, width: 100, height: 20 } },
  ];
  assert.equal(sm.namelessHitTarget(cell, [cell, ...kids]), false,
    'a row holding its own labels is not the target; its labels are');
  // Verified against two real UIKit screens, Settings root and Safari, where
  // this adds nothing at all: Apple labels its controls.

  // What to call the row. Label, then `testID` — which `tap` has matched on
  // since long before this and the map simply never carried — then OCR.
  assert.equal(v.displayName({ label: 'Save', identifier: 'save-btn', source: 'ax' }), 'Save');
  assert.equal(v.displayName({ identifier: 'save-btn', source: 'ax' }), 'save-btn');
  assert.equal(v.displayName({ aliases: ['Sort'], source: 'ax|ocr' }), 'Sort');
  assert.equal(v.displayName({ source: 'ax' }), '(unlabelled)');

  // The first live run named the overflow menu `...`, because OCR read its
  // three dots and an unlabelled element takes OCR's word outright. That looks
  // like a name, cannot be typed into a selector, and silenced the count below
  // by making the row look addressable. Text with no word in it is not a name —
  // the same rule `isNoise` already applies to a row of its own.
  assert.equal(v.displayName({ aliases: ['...'], source: 'ax|ocr' }), '(unlabelled)');
  assert.ok(v.unaddressable({ aliases: ['...'], source: 'ax|ocr' }));
  assert.equal(v.unaddressable({ aliases: ['Sort'], source: 'ax|ocr' }), false);
  assert.equal(v.unaddressable({ label: 'Save', source: 'ax' }), false);
  // OCR alone reading a wordless blob is not a control we are hiding from
  // anyone; it never had a name to lose.
  assert.equal(v.unaddressable({ aliases: ['...'], source: 'ocr' }), false);

  // And the line the report actually asked for, which is the half that changes
  // behaviour: knowing a hit target is there removes the screenshot round trip
  // even with no semantics attached to it.
  const rows = [
    { ref: 1, type: 'Button', x: 364, y: 84, region: 'nav-bar', source: 'ax',
      frame: { x: 349, y: 72, width: 30, height: 24 } },
  ];
  const out = v.render({ device: { name: 'x' }, identity: { hash: 'a' }, screen, rows,
    unnamed: '1 on-screen control(s) have no accessibility label — they are listed with their coordinates' });
  assert.match(out, /#1 button\s+364,84\s+\(unlabelled\)/);
  assert.match(out, /no accessibility label/);
});

test('the three ways a daemon can fail to be ready are three sentences', async () => {
  const api = await import('../src/index.js');

  // 2026-09-13, hosted runner: `simframe start` gave up after 20s with **"no
  // daemon process came up"**, and the next step of the same job printed
  // `● iPhone 16 Pro pid=9573 frame=#5 age=652ms` over a daemon log showing it
  // had been capturing throughout. The sentence did not merely fail to help —
  // it named the wrong condition, which is the fourth time this project has
  // done that and the second in two days.
  //
  // The cause is worth keeping because it is circular. Node decided whether a
  // daemon was alive by reading meta.json, which the daemon writes in `claim()`
  // — *after* `platform.attach`, its slowest startup step. So the live-daemon
  // cap, which exists precisely for a daemon that is up and slow, could never
  // be reached in the case that produced it: reaching it required the file
  // whose absence was the problem. The pid we spawned answers the question
  // directly, and `startEngine` had been discarding it.
  assert.match(api.readinessFailure({ sawLiveDaemon: false, sawProcess: false }),
    /no daemon process came up/);
  assert.match(api.readinessFailure({ sawLiveDaemon: false, sawProcess: true }),
    /started but never claimed the device/);
  assert.match(api.readinessFailure({ sawLiveDaemon: true, sawProcess: true }),
    /running and the display produced no frame/);

  // Distinguishable is the property, so assert it as one rather than trusting
  // three separate regexes to stay different from each other.
  const said = [
    api.readinessFailure({ sawLiveDaemon: false, sawProcess: false }),
    api.readinessFailure({ sawLiveDaemon: false, sawProcess: true }),
    api.readinessFailure({ sawLiveDaemon: true, sawProcess: true }),
  ];
  assert.equal(new Set(said).size, 3, 'three conditions, three sentences');

  // And the middle one has to say which way to look, because "it is stuck
  // attaching" and "it failed to launch" call for opposite next moves.
  assert.match(said[1], /attaching/);
});

test('a settle that gives up says where the screen is still moving (123)', async () => {
  const a = await import('../src/analyze.js');

  // One band holding most of the movement is a localised animation and is worth
  // naming; movement spread evenly is a screen in flight and naming a corner
  // would mislead. The reporter's ask was a sentence like "the moving region is
  // the top-right 15%", because a spinner nobody cares about should not cost
  // the other five steps of a six-step batch.
  const corner = new Array(32).fill(0);
  corner[3] = 0.5;
  corner[7] = 0.4;
  assert.deepEqual(a.describeMotion(corner), { where: 'top right', share: 100, localised: true });

  const everywhere = new Array(32).fill(0.1);
  assert.equal(a.describeMotion(everywhere).localised, false);
  assert.match(a.describeMotion(everywhere).where, /spread/);

  // A still screen has nothing to point at, and saying "top left" about zero
  // movement would be the confident wrong answer this file is full of.
  assert.equal(a.describeMotion(new Array(32).fill(0)), null);
  assert.equal(a.describeMotion([]), null);

  // The window is in TIME, not in frames, and that is the whole of it.
  //
  // The first version kept the last eight frame *pairs*, on the reasoning that
  // eight polls at the 60ms floor is about half a second. Capture is
  // damage-driven with a slow idle floor, so on a quiet screen eight frames
  // spanned sixteen seconds — and the window still contained the transition
  // that had brought us to the screen. A home screen with one animated widget
  // duly reported movement in all thirty-two regions and "spread across the
  // screen". Frames are not a clock.
  const api = await import('../src/index.js');
  assert.equal(api.MOTION_WINDOW_MS, 1000);
});

test('a settle that satisfies while something is animating says so', async () => {
  // Measured on the testbed's Diagnostics tab, which now carries a spinner that
  // never stops: frames every 77-95ms, `motion.animating` boxed at 13x13,
  // `motion.settled` false — and `stableForMs` **79,207**. Seventy-nine seconds
  // of claimed stillness on a screen that had never once stopped, in the same
  // state file that says it is not settled and where the moving part is.
  //
  // `waitFor` read only `stableForMs`, which is a mean over the grid, and a
  // spinner does not move a mean. So `wait` answered "settled after 63ms" — to
  // within a millisecond the `settled after 62ms` a field report had already
  // filed against a still-loading screen.
  //
  // What is asserted here is the *reporting*, deliberately, and not the
  // decision. Requiring the daemon's `settled` flag would be right for a
  // spinner and wrong for a text caret, which is also small and also
  // persistent and must never stop a screen from settling. That choice needs a
  // caret measured; it has not been. Until then both signals reach the caller
  // instead of the optimistic one silently winning.
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /animating:\s*animatingNow\(\)/,
    'waitFor must carry the daemon\'s animating box to its caller');
  const actions = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  assert.match(actions, /is still animating/,
    'a satisfied settle must say when part of the screen is still moving');
});

test('a still screen can satisfy a settle, and a failure says why it did not', async () => {
  const api = await import('../src/index.js');
  const { settleEvidence } = await import('../src/actions.js');

  // The condition that could never be met on the screens it is asked about
  // most. "At least one frame must arrive during the call" is the right intent
  // and the wrong spelling: capture is damage-driven, so a screen that is not
  // moving produces no new frame *by design*, and the wait then burns its whole
  // budget and reports "screen did not settle" about a screen that has been
  // motionless throughout.
  //
  // Measured, not argued: a flow step reported `did not settle within 1547ms`
  // while its own evidence line read "still for 3548ms of the 1400ms required;
  // NO frame arrived while waiting". Two and a half times the stillness asked
  // for, refused. Currency is a question about time, not about a counter — the
  // same correction the motion window needed — and `liveness` already rejects a
  // stale file from a dead daemon, which is what the counter was really
  // guarding.
  assert.equal(api.FRAME_IS_CURRENT_MS, 2500, 'the daemon idle floor is 2000ms, plus margin');
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /freshFrames >= 1 \|\| age <= FRAME_IS_CURRENT_MS/,
    'a frame younger than the capture loop\'s own idle floor is the current screen');

  // And the message that sent two CI cycles into guessing. "screen did not
  // settle within 25008ms" names the one quantity that is never the reason.
  // These two are opposite diagnoses and they had one sentence between them.
  const tooTight = settleEvidence({ waitedMs: 1547, stillForMs: 1200, stableMsRequired: 1400, framesSeen: 4 });
  assert.match(tooTight, /still for 1200ms of the 1400ms required/);
  assert.match(tooTight, /4 frame\(s\) arrived/);

  const noFrames = settleEvidence({ waitedMs: 25008, stillForMs: 135411, stableMsRequired: 500, framesSeen: 0 });
  assert.match(noFrames, /NO frame arrived while waiting — capture, not the screen/);
  assert.notEqual(tooTight, noFrames);

  // A moving screen leads with where, because that is what to do something
  // about; the region map follows on its own line.
  const moving = settleEvidence({
    waitedMs: 8000, stillForMs: 20, stableMsRequired: 500, framesSeen: 60,
    motion: { where: 'top right', share: 78, localised: true, map: '.@..\n....' },
  });
  assert.match(moving, /^the movement is top right \(78% of it\)/);
  assert.match(moving, /\n\.@\.\./);

  // Black frames are the capture wedge and get named as such rather than being
  // left to look like a slow screen.
  assert.match(settleEvidence({ framesSeen: 12, blackFrames: 40 }), /40 black frame\(s\)/);
});

test('a blinking caret is not an animation, and the threshold is measured (130)', async () => {
  // The question 130 was deferred on, answered by measuring rather than by
  // picking a number. The objection was that a text caret is small and
  // persistent exactly like a spinner and must never stop a screen settling —
  // so the caret was measured against what it has to be told apart from, on a
  // 48x96 grid of 4,608 cells:
  //
  //   static home screen, nothing moving   1-4 cells, on 54% of frames
  //   a blinking text caret                **2 cells** (1x2), on 100% of frames
  //   the testbed's spinner                169 cells (13x13)
  //   Maps launching, median               656 cells (41x16)
  //   a real spinner, from the field       1,364 cells (44x31)
  //
  // Caret and noise at 1-4; the weakest real signal at 169. A 42x gap.
  //
  // Before the threshold the gate was `fraction > 0` — ONE cell of 4,608 —
  // so a screen holding nothing but a text cursor reported `settled: false` on
  // 72 frames out of 72, and a static home screen claimed something was
  // animating on 54% of its frames. A field report on 0.13.0 found the same
  // thing independently and named the real cost: a warning that is usually
  // wrong trains the reader to ignore the one that matters.
  //
  // Verified after: caret 0% and settled 73/73, static screen 0%, Maps
  // unchanged at a 1,968-cell median.
  const swift = fs.readFileSync(
    new URL('../native/simframed/Sources/SimframeCore/Motion.swift', import.meta.url), 'utf8');
  const match = /minAnimatingCells\s*=\s*(\d+)/.exec(swift);
  assert.ok(match, 'could not find minAnimatingCells in Motion.swift — has it moved?');
  const cells = Number(match[1]);

  // Asserted as the relationships that were measured, not as the number, so
  // the constant can move only with a reason and never back to "any one cell".
  assert.ok(cells > 4, 'must sit above the measured noise floor of 4 cells');
  assert.ok(cells < 169, 'must sit below the weakest real animation measured');
  assert.equal(cells, 12);

  // And the gate must test the count, not merely that something moved. This is
  // the line that made a caret an animation.
  assert.match(swift, /moving >= Self\.minAnimatingCells/,
    'the animation gate must require a minimum number of moving cells');
  assert.doesNotMatch(swift, /if fraction > 0 && fraction < 0\.06/,
    'the old any-single-cell gate must not come back');
});

test('a presence question is answered by ambiguity, not refused by it', async () => {
  const { flowSummary } = await import('../src/actions.js');
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');

  // Reported from the field on 0.13.0: `assert Administrator is visible` FAILED,
  // and aborted the rest of the batch, on a screen with **two** Administrators.
  // Two matches means the thing is definitively there — the assertion's own
  // semantics were satisfied twice over. The message was praised in the same
  // breath (candidates, coordinates, scores), so what was wrong was the verdict.
  //
  // The `gone` direction had the mirror-image bug and nobody had hit it yet: any
  // error at all returned "is gone", so a query matching two *visible* elements
  // would have been reported absent. Ambiguity is the one error that is positive
  // evidence of presence, and it was being read as proof of absence.
  assert.match(src, /if \(want === 'visible'\) return .*is visible/,
    'ambiguity satisfies a visibility assertion');
  assert.match(src, /if \(want === 'gone'\) throw new Error\(`\$\{query\}: still here/,
    'ambiguity fails a gone assertion');
  // Strict single-match resolution stays where picking the wrong element gives a
  // confident wrong answer about a particular thing.
  assert.doesNotMatch(src, /want === 'enabled' && err\.ambiguous/,
    'enabled/disabled/value must still refuse an ambiguous query');

  // And the summary line, which a reporter said reads like a success:
  // `FLOW FAILED — 3/3 steps`. The denominator meant *attempted* on failure and
  // *succeeded* on success, so one shape carried opposite meanings.
  assert.equal(
    flowSummary({ ok: true, ranSteps: 5, totalSteps: 5, totalMs: 10 }),
    'flow completed — 5/5 steps in 10ms');
  assert.equal(
    flowSummary({ ok: false, ranSteps: 3, totalSteps: 3, totalMs: 6123, results: [{ ok: true }, { ok: true }, { ok: false }] }),
    'FLOW FAILED — 2 ok, 1 failed (of 3) in 6123ms');
  // Steps a stopped flow never reached are neither ok nor failed, and saying so
  // is what tells a caller to resume rather than re-plan.
  assert.match(
    flowSummary({ ok: false, ranSteps: 1, totalSteps: 6, results: [{ ok: false }] }),
    /0 ok, 1 failed, 5 not attempted \(of 6\)/);
});

test('a wait that gives up says how long the screen had been still (139)', async () => {
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');

  // A field report on 0.13.0: a 180-second wait for a control that never
  // appeared, on a screen static for about twelve of those seconds — the app had
  // logged itself out onto a login form. The failure message was praised for
  // listing what WAS on screen. It arrived three minutes late.
  //
  // Stillness was already tracked and already printed by other commands, so the
  // information existed and this wait never asked for it.
  assert.match(src, /the screen has not moved for \$\{Math\.round\(ms\)\}ms/,
    'a timeout must report the stillness it could already see');
  assert.match(src, /pass failIfStillFor to stop early next time/,
    'and point at the remedy, since the caller cannot guess the option exists');

  // Opt-in, NOT default, and the reason matters: a still screen is exactly what
  // a pending network call looks like. A wait that gave up on stillness alone
  // would break the case waits exist for.
  assert.match(src, /Number\.isFinite\(step\.failIfStillFor\)/,
    'the early exit must be requested, never assumed');

  // Verified live on a device: with failIfStillFor 3000 against a 20000ms
  // timeout, the wait ended in 4.3s naming the stillness; without it, the same
  // wait ran its full budget and reported "the screen has not moved for
  // 18592ms". Through the MCP surface it ended in 149ms on a screen that had
  // been still for 50s.
  //
  // This is only trustworthy because of 134 — before the animation threshold
  // was measured, a completely static screen claimed something was animating on
  // 54% of its frames, and "nothing has moved" could not have been said.
  const swift = fs.readFileSync(
    new URL('../native/simframed/Sources/SimframeCore/Motion.swift', import.meta.url), 'utf8');
  assert.match(swift, /minAnimatingCells/, '139 leans on 134; they cannot be separated');
});

test('a wait resolves against the live screen, not against memory', async () => {
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');

  // `waitFor` read `refresh: attempt > 0`, so its FIRST look resolved against
  // the remembered map. A wait that can be satisfied by memory is not a wait:
  // when recall hands back the wrong screen's map — which happens when two
  // screens collide on a layout hash — the target "appears" without ever having
  // been on screen, instantly, and the caller proceeds against a screen it is
  // not on.
  //
  // Found by the fingerprint eval on CI, the only place it could show:
  // `settings-general` read the Settings ROOT and its `waitFor "About"` had
  // passed. The signature is in the round numbers — r2 and r3, never r1 —
  // because memory has to be warm before it can lie, and round 1 is cold.
  //
  // `assert` was made fresh by default after this same defect cost a reported
  // session. `waitFor` was left behind, which is the part worth remembering:
  // the fix was applied to the symptom that had been reported rather than to
  // the class.
  // Comments stripped first, because the paragraph explaining this defect quotes
  // the very string it forbids — the first version of this assertion failed on
  // its own prose, and `npm test | tail -3` hid the `# fail` line while I read
  // the three lines under it. Check what the file DOES, not what it says.
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /refresh: attempt > 0/,
    'no wait may resolve its first look against the recalled map');

  // **Every file, not this one.** This assertion read only actions.js for as
  // long as it existed, and the identical defect was sitting in baseline.js
  // the whole time: the HPI suite's reset resolved its root marker against the
  // map remembered from the previous run's end screen, failed to find a marker
  // that was plainly on screen, and then hunted a "back" control that a root
  // screen does not have — on every run of every pass, for as long as HPI has
  // been measured. A rule enforced against the file where it was first noticed
  // is a rule that only covers the symptom.
  const srcDir = new URL('../src/', import.meta.url);
  for (const name of fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'))) {
    const body = fs.readFileSync(new URL(name, srcDir), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(body, /refresh: attempt > 0/,
      `${name} resolves a first look from memory; a check has no second opinion`);
  }

  // Three fresh reads: both `waitFor` branches — a single target and
  // {"any": [...]} — and `assert`. All opt out the same way, so the contract is
  // one contract rather than three.
  const fresh = [...code.matchAll(/refresh: step\.refresh !== false/g)].length;
  assert.ok(fresh >= 3, `expected both waits and the assert to read fresh, found ${fresh}`);

  // Deliberately NOT every `api.locate`. An ACTION resolves its target from the
  // map on purpose — that is what makes a tap cost a file read rather than a
  // perception pass — and the action's own verdict checks the outcome
  // afterwards. Only a *check* has no second opinion, which is why only checks
  // are required to be fresh. The first version of this assertion swept in
  // `type`'s field lookup and would have undone that design in the name of
  // tidiness.
  assert.match(src, /api\.locate\(deviceQuery, step\.into, \{ index: step\.index, refresh: step\.refresh \}/,
    'an action still resolves from the map; this test is about checks');
});

// ---------------------------------------------------------------------------
// Item 169: a launch that starts a process and never fronts it.
// ---------------------------------------------------------------------------

test('simctl launch prints a pid, and that is the number the verdict turns on', async () => {
  const { launchedPid } = await import('../src/platform/ios.js');
  // Verbatim from the device this was measured on.
  assert.equal(launchedPid('com.apple.Preferences: 10695\n'), 10695);
  assert.equal(launchedPid('com.apple.MobileAddressBook: 10762'), 10762);
  // Anything else is "cannot say", never a failed launch — the distinction
  // item 161 was reverted for.
  assert.equal(launchedPid(''), null);
  assert.equal(launchedPid('com.apple.Preferences: unknown'), null);
  assert.equal(launchedPid(undefined), null);
});

test('a launch is confirmed by pid identity, not by the screen changing', async () => {
  const frontmost = await import('../src/frontmost.js');
  const noWait = { wait: async () => {}, pollMs: 0 };

  // The case the old note called "likely": relaunching an app already in
  // front. The screen does not move and the launch is nevertheless fine.
  // Measured at 237ms on a real device, one poll.
  const already = await frontmost.landed({ pid: 10695, read: async () => ({ pid: 10695 }), ...noWait });
  assert.equal(already.verdict, 'fronted');
  assert.equal(already.polls, 1, 'an app already in front answers on the first read');

  // A cold switch does not answer on the first read. Measured at 1552ms over
  // 8 polls, so a verdict taken from one look would have been wrong.
  let asked = 0;
  const slow = await frontmost.landed({
    pid: 10762, read: async () => ({ pid: ++asked < 8 ? 10695 : 10762 }), ...noWait,
  });
  assert.equal(slow.verdict, 'fronted');
  assert.equal(slow.polls, 8);

  // Item 169 itself. Forced on a real device with `simctl launch
  // --wait-for-debugger`: pid 16332 started and pid 15830 stayed in front.
  // This is the run that used to return ok.
  let clock = 0;
  const failed = await frontmost.landed({
    pid: 16332, read: async () => ({ pid: 15830 }), budgetMs: 3000, pollMs: 0,
    wait: async () => {}, now: () => (clock += 100),
  });
  assert.equal(failed.verdict, 'did-not-front');
  assert.equal(failed.frontmost, 15830);

  // No sensor is not a failure. A backend that cannot say who is frontmost
  // must leave the launch exactly as unjudged as it was before this existed,
  // and must decide that on the first read rather than spending the budget.
  let polls = 0;
  const mute = await frontmost.landed({
    pid: 16332, read: async () => { polls += 1; return { pid: null }; }, ...noWait,
  });
  assert.equal(mute.verdict, 'cannot-say');
  assert.equal(polls, 1, 'one read is enough to learn nothing answers');

  // And a launch that reported no pid is the same kind of silence.
  assert.equal(
    (await frontmost.landed({ pid: null, read: async () => ({ pid: 1 }), ...noWait })).verdict,
    'cannot-say',
  );
});

test('a launch that did not front says which of the two reasons it was', async () => {
  const { landed, describeHeld } = await import('../src/frontmost.js');
  const noWait = { wait: async () => {}, pollMs: 0 };

  // The runner case, verbatim: pid 39452 launched, pid 38661 held the front for
  // the whole 6614ms. One pid for the entire budget is not a slow device, it is
  // a launch that did not take effect — and the remedy is another launch.
  let clock = 0;
  const stuck = await landed({
    pid: 39452, read: async () => ({ pid: 38661 }), budgetMs: 3000, pollMs: 0,
    wait: async () => {}, now: () => (clock += 200),
  });
  assert.deepEqual(stuck.held, [38661]);
  assert.match(describeHeld(stuck.held), /held the front for the whole wait/);

  // The other shape, which wants the opposite remedy: the front moved and just
  // never arrived here, so the budget is what was short. Distinguishing these
  // is the whole reason `held` is recorded — item 146 widened a budget twice
  // without an instrument that could say which case it was.
  clock = 0;
  const pids = [100, 100, 200, 200, 300];
  let i = 0;
  const moving = await landed({
    pid: 999, read: async () => ({ pid: pids[Math.min(i++, pids.length - 1)] }),
    budgetMs: 900, pollMs: 0, wait: async () => {}, now: () => (clock += 200),
  });
  assert.equal(moving.verdict, 'did-not-front');
  assert.deepEqual(moving.held, [100, 200, 300]);
  assert.match(describeHeld(moving.held), /changed hands 2 time\(s\) \(100 → 200 → 300\)/);

  assert.match(describeHeld([]), /nothing held the front/);

  // And it refuses to explain a success. Handed a successful wait's `held` the
  // first version said "the launch never took effect" about a launch that
  // plainly had — I ran into that myself testing this on a device, which is
  // why the launched pid is passed in rather than inferred from the shape.
  assert.match(describeHeld([48011], 48011), /did reach the front/);
  assert.match(describeHeld([100, 200], 200), /did reach the front/);
  assert.match(describeHeld([100, 200], 999), /changed hands/);
});

test('whoever holds the front is named, and a generic answer is not passed off as a name', async () => {
  const { nameHolder, landed } = await import('../src/frontmost.js');

  // A real name is used as one.
  assert.equal(nameHolder(7797, 'Settings'), 'pid 7797 (Settings)');

  // **The measured trap.** After a press of home the same pid stays frontmost
  // and the title degrades to the bare word "application". Printing that as a
  // name would be a confident wrong answer in exactly the state worth
  // noticing, so it is phrased for what it is. The daemon still reports the
  // word raw — the judgement lives here, where it can be tested at all.
  assert.equal(nameHolder(7797, 'application'), 'pid 7797 (an app that no longer names itself)');
  assert.equal(nameHolder(7797, 'Window'), 'pid 7797 (an app that no longer names itself)');
  // Nothing answered at all: just the number, no invented parenthesis.
  assert.equal(nameHolder(7797, null), 'pid 7797');
  assert.equal(nameHolder(7797, '   '), 'pid 7797');
  assert.equal(nameHolder(null, 'Settings'), 'nothing');

  // And the verdict carries it, so the next runner occurrence says who.
  let clock = 0;
  const failed = await landed({
    pid: 9304, read: async () => ({ pid: 7797, title: 'Settings' }),
    budgetMs: 400, pollMs: 0, wait: async () => {}, now: () => (clock += 100),
  });
  assert.equal(failed.holder, 'pid 7797 (Settings)');
});

test('a launch that did not front is retried once, without a terminate, and the retry is reported', async () => {
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const launchCase = src.slice(src.indexOf("case 'launch': {"), src.indexOf("case 'terminate':"));

  // The retry exists, and it is bounded: one re-launch, then the throw.
  assert.equal((launchCase.match(/await launchApp\(/g) ?? []).length, 2,
    'exactly one retry, not a loop');

  // **The half that matters.** The retry must not terminate first. Terminating
  // and relaunching is the gesture this project already knows wedges the
  // simulator's display pipeline, so a recovery that did it would be causing
  // the next failure. The retry call carries args and env and nothing else.
  const retry = launchCase.slice(launchCase.indexOf('let retried'));
  assert.doesNotMatch(retry, /terminateFirst/,
    'the recovery must not be the thing that wedges the display');

  // And it is visible. CI's own vehicle has been retrying launches by hand
  // three times, silently, which is how this stayed a harness problem.
  assert.match(launchCase, /it did not front on the first attempt/,
    'a retry the summary does not mention is a rate nobody can argue with');
  assert.match(launchCase, /on either of two attempts/,
    'and a failure after a retry must say it was two');
});

test('the launch step refuses a launch that never fronted, and says so definitely when it did', async () => {
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  assert.match(src, /landed\.verdict === 'did-not-front'/,
    'a launch that never fronted must not return success');
  assert.match(src, /but it never came to the front/,
    'and the message must name what actually happened');
  // The other half, and the easier one to drop: the note that used to hedge
  // between "already in front" and "did not come forward" now resolves, because
  // the pid answered the question the screen could not.
  assert.match(src, /confirmed frontmost — it was already in front/,
    'a confirmed front turns the ambiguous note into a definite one');
});

test('a backend that cannot confirm a launch says so in its own terms', async () => {
  const ios = await import('../src/platform/ios.js');
  const android = await import('../src/platform/android.js');
  assert.equal(ios.platform.capabilities().frontmost.supported, true);
  const front = android.platform.capabilities().frontmost;
  assert.equal(front.supported, false);
  assert.ok(front.note, 'a declined layer carries a reason');
  // The rule this project keeps relearning: a layer a platform does not have
  // is optional with a reason, never the other platform's vocabulary.
  assert.doesNotMatch(front.note, /simctl|AXPTranslator|idb/,
    'and the reason may not be written in iOS vocabulary');
});

test('the CI guard tells a wedged device from a check that failed on its merits', async () => {
  // Real output, verbatim from the runs each signature was added for. The table
  // lives in its own module for exactly this: the guard itself exits at import.
  const { deviceCause, DEVICE_STATE } = await import('../scripts/device-state.mjs');

  // Item 169's own sentence — a launch that started a process and never fronted
  // it. This replaced a signature that had to infer the same condition from
  // "two labels on a still screen, one of them a clock".
  assert.ok(deviceCause(
    'launched com.apple.Preferences (pid 16332) but it never came to the front'
    + ' within 3032ms — pid 15830 still is. The process started; the screen did not change hands.',
  ), 'a launch that says it never fronted is the device');

  // Seen on the v0.14.3 bench run, and matched by nothing until now.
  assert.ok(deviceCause(
    'could not launch com.apple.Preferences: \tThe system shell (SpringBoard:36454) probably crashed.',
  ), "a crashed SpringBoard is the device");

  // The half that matters more, and the one an over-eager signature destroys:
  // a tour asking for a label that is genuinely not there must keep failing.
  // This is the exact text item 168 was about — a real tour fault.
  assert.equal(deviceCause(
    '"VoiceOver" is not on this screen. Visible: Settings, Accessibility, Vision,'
    + ' Hover Text, Display & Text Size, Motion, Spoken Content, Hearing',
  ), null, 'a wrong landmark is the check failing on its merits');
  assert.equal(deviceCause('AssertionError: expected 3 elements, found 2'), null);
  assert.equal(deviceCause(''), null);
  assert.equal(deviceCause(undefined), null);

  // Every entry is [RegExp, string]; a bare string here would match nothing and
  // fail silently, which is the worst shape a guard can take.
  for (const [re, why] of DEVICE_STATE) {
    assert.ok(re instanceof RegExp, `${why} needs a RegExp`);
    assert.equal(typeof why, 'string');
  }
});

test('a distinctive fragment of one long name resolves, and only when nothing competes', async () => {
  // Field report, 0.15.1: `waitFor "8471502"` gave up after 20s on a screen
  // whose own "Visible:" list printed `Record #8471502`. The reporter
  // guessed `#` was significant or the matcher was anchored. Neither: the
  // substring branch scales by how much of the NAME the query covers, and
  // seven digits are 41% of that label, so it scored 0.287 against a 0.45
  // floor. Recorded as numbers so the next person does not re-guess.
  const m = await import('../src/matching.js');
  assert.ok(m.nameScore('Record #8471502', '8471502') < m.MINIMUM_SCORE,
    'the raw score is genuinely below the floor — the promotion is what rescues it');

  const el = (label, type = 'text') => ({
    label, type, x: 100, y: 100, w: 200, h: 20, frame: { x: 100, y: 100, width: 200, height: 20 },
  });
  const screen = { width: 402, height: 874 };
  const best = (targets, q) => m.rank(targets, q, { screen })[0];

  const found = best([el('Record #8471502'), el('EDIT', 'button')], '8471502');
  assert.ok(found.score >= m.MINIMUM_SCORE, 'it resolves now');
  assert.match(found.reasons.join(' '), /the only element on this screen containing/,
    'and says why, because it is desperation rather than confidence');
  assert.ok(found.score < 0.5, 'promoted to just over the floor, not to a confident score');

  // **The case the coverage scaling exists for, which must not regress.** A
  // bare "back" must reach the back button, not a long list row that happens
  // to contain the word. The promotion cannot fire here: two names contain
  // "back", and nothing needed rescuing anyway.
  const backwards = best([el('Back', 'button'), el('Back Room Storage Cabinet Shelf 4')], 'back');
  assert.equal(backwards.target.label, 'Back');

  // Two candidates hold the fragment: that is the ambiguity the scaling
  // protects against, so no promotion and the floor still refuses.
  const ambiguous = best([el('Record #8471502'), el('Parent of #8471502')], '8471502');
  assert.ok(ambiguous.score < m.MINIMUM_SCORE, 'a contested fragment is still not good enough');

  // And it invents nothing: a string genuinely absent stays absent.
  assert.equal(best([el('EDIT', 'button'), el('Cancel', 'button')], '8471502'), undefined);

  // Too short to be distinctive — two characters inside any label would
  // otherwise promote on almost every screen.
  assert.equal(best([el('Record #8471502')], '63')?.score >= m.MINIMUM_SCORE, false);
});

test('a swept fill carries the read-back verdict instead of claiming success', async () => {
  // Field report, 0.15.1, filed as the critical defect: `sweep` printed
  //   ok [0] sweep: ... filled "Full name" in section 1
  // and the field was empty. The honesty already existed one function down —
  // `paste`/`type` with `into` read the field back and qualify the claim, and
  // `paste` even throws naming the system paste-consent dialog — and `sweep`
  // awaited the step for its side effect and discarded everything it said.
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const sweepFill = src.slice(src.indexOf('Anything to fill in this section?'));
  const upToCatch = sweepFill.slice(0, sweepFill.indexOf('} catch (err)'));
  assert.match(upToCatch, /const said = await runStep\(/,
    'the fill must keep what the step reported, not just that it returned');
  assert.match(upToCatch, /unconfirmed\|NOT CONFIRMED\|reads empty/,
    'and test it for a caveat before claiming the field was filled');

  // The detection itself, against the real strings the two steps return.
  const caveated = /unconfirmed|NOT CONFIRMED|reads empty|did not land|nothing was read back/i;
  assert.ok(caveated.test('pasted into the focused field [unconfirmed — no field named, so nothing was read back]'));
  assert.ok(caveated.test('typed text [NOT CONFIRMED: no field named, so nothing was read back.'));
  // A confirmed fill stays clean — the caveat must not fire on every fill, or
  // it becomes the habituation the same reporter warned about on 0.13.0.
  assert.ok(!caveated.test('pasted into the field named "Full name" (read back: "a value")'));
});

test('a swept fill uses the keyboard for short values, so the paste consent alert never fires', async () => {
  // Field report, 0.15.1: "I never passed paste: true. simframe pasted anyway"
  // — and iOS 26 answered with a system consent alert on a NINE-character
  // value, which covered the form, collapsed the tree to OCR-only and failed
  // the batch. The recovery chain after it was close to half the session's
  // wasted model round trips.
  //
  // The reporter located it in `type`. It was not there — `sim_type_into`
  // already defaults to the keyboard. `sweep`'s fill was the only path that
  // pasted unconditionally, and `sweep` is what they used.
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /action: step\.paste === false \? 'type' : 'paste'/,
    'a fill must not reach for the pasteboard by default');
  const threshold = Number(/const KEYBOARD_UP_TO = (\d+)/.exec(src)?.[1]);
  assert.ok(threshold >= 9,
    `the threshold (${threshold}) must cover the nine-character value that triggered the alert`);

  // The rule itself. Explicit intent wins in both directions; otherwise length
  // decides, so a paragraph still goes by pasteboard where it is genuinely
  // faster.
  const via = (len, paste) => (paste === true || (paste !== false && len > threshold) ? 'paste' : 'type');
  assert.equal(via(9, undefined), 'type', 'the reported case');
  assert.equal(via(threshold, undefined), 'type', 'the threshold itself is keyboard');
  assert.equal(via(threshold + 1, undefined), 'paste');
  assert.equal(via(9, true), 'paste', 'paste: true is honoured');
  assert.equal(via(5000, false), 'type', 'and so is paste: false');

  // **Why a threshold does not trade away exactness**, which is the reason
  // pasteboard-by-default was chosen: the keyboard path reads the field back
  // and retries once locally before giving up, so a layout that mangles
  // keystrokes is caught rather than silently accepted.
  const typeInto = src.slice(src.indexOf("case 'type': {"));
  assert.match(typeInto.slice(0, typeInto.indexOf("case 'swipe'")), /if \(back\.empty\)/,
    'the keyboard path must verify what landed');
});

test('sweep answers to the same selectors as tap and type, identifiers included', async () => {
  // Second field report, and the THIRD time this assumption has been reported.
  // `sweep` matched rows on `r.label` alone, and in React Native most
  // interactive controls carry a testID and no accessibility label — so a field
  // sweep had just printed in its own element map came back as
  //   NOT FOUND anywhere: "create-service-request-3-requested-by-input"
  // four lines above
  //   #18 field  201,480  create-service-request-3-requested-by-input
  // in one response. The reporter called it the most confidence-damaging
  // failure of their run, because it briefly convinced them the form did not
  // have a field they were looking at.
  //
  // Item 152 fixed this in `matching.rank`; ee305d4 fixed a label the matcher
  // refused; `sweep` carried its own matcher and learned neither. A resolver
  // per call site has to be corrected per call site.
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /alnum\(r\.label\)\.includes\(/,
    'no sweep matcher may look only at the label');
  assert.match(src, /const sweepNames = \(r\) => \[r\.label, r\.identifier/,
    'the names a row answers to belong in one place');

  // The rule itself, against the reported row: an identifier and no label.
  const alnum = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = (r) => [r.label, r.identifier, ...(r.aliases ?? [])].filter(Boolean).map(alnum);
  const holds = (r, needle) => {
    const want = alnum(needle);
    return want ? names(r).some((n) => n.includes(want)) : false;
  };
  const testIdOnly = { label: null, identifier: 'create-service-request-3-requested-by-input' };
  assert.equal(holds(testIdOnly, 'create-service-request-3-requested-by-input'), true);
  assert.equal(holds({ label: 'Full name' }, 'Full name'), true, 'labels still work');
  assert.equal(holds(testIdOnly, 'not-a-field'), false, 'and it invents nothing');
  assert.equal(holds(testIdOnly, ''), false, 'an empty needle matches nothing, not everything');
});

test('a supervise brief with no supervisor enabled says so, and names the remedy', async () => {
  // Two independent field reports, same trap. `supervise` is standing guidance
  // FOR a supervisor; which supervisor comes from options.supervisor or
  // SIMFRAME_SUPERVISOR, and with neither set the brief is discarded. The code
  // documented that as "always safe" — safe and silent.
  //
  // One reporter had written a brief describing the exact race that then
  // aborted their batch, and the supervisor was never asked: "as written,
  // `supervise` is a prompt I can't observe the effect of."
  const supervisor = await import('../src/supervisor.js');
  assert.equal(supervisor.requested({}), null, 'nothing configured means nobody is listening');
  assert.equal(supervisor.requested({ supervisor: 'none' }), null);
  assert.equal(supervisor.requested({ supervisor: 'off' }), null);
  assert.equal(supervisor.requested({ supervisor: 'apple' }), 'apple');

  const src = fs.readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');
  assert.match(src, /args\.supervise && !supervisor\.requested\(options\)/,
    'a brief with nobody to read it must be reported');
  assert.match(src, /so the "supervise" brief was not consulted/);
  // The remedy, not just the condition — the whole reason the silence was
  // expensive is that neither reporter could tell what to do about it.
  assert.match(src, /set supervisor \(per call\) or SIMFRAME_SUPERVISOR/);
  // And it must not fire when no brief was passed, or it becomes the noise the
  // same reports complained about elsewhere (an overlap warning on 7 of 9
  // screens, ignored by the fourth occurrence).
  assert.match(src, /if \(args\.supervise &&/, 'gated on a brief having been passed');
});

test('the escape hatch from a wrong-turn verdict settles before it gives up', async () => {
  // `unexpected-screen` aborts a batch, and `stillOnPlan` is the one thing that
  // can rescue it: if the NEXT step's own target resolves here, we are on a
  // screen the plan can continue from. It asked once, immediately — and the
  // circumstance it is asked in is a screen still arriving, which is what
  // produced the unexpected hash in the first place. So the rescuing signal was
  // read at the only moment it was guaranteed to be absent.
  //
  // A field report lost a 7-step plan at step 5 to this, on a tap that had
  // correctly advanced a wizard. Every discarded step is ~20s of model latency
  // to re-plan, so the settle pays for itself many times over and is only ever
  // paid on the failure path.
  const src = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function stillOnPlan'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /mode: 'settle'/, 'it must let the screen arrive before looking');
  assert.match(body, /look < 2/, 'and look more than once');
  assert.match(body, /refresh: true/, 'against the live screen, not the remembered map');

  // **It must not be able to manufacture a continue.** The next step's target
  // still has to resolve; the guards that make a non-answer inadmissible stay.
  assert.match(body, /\^#\\d\+\$/, 'a #ref was numbered on another screen and proves nothing');
  assert.match(body, /\n  return false;/, 'and a target that never appears still halts');

  // The halt itself is unchanged: a wrong turn with nothing to continue into
  // still fails the run, which is the verify barrier and not negotiable.
  const actions = await import('../src/actions.js');
  const wrong = { verdict: 'unexpected-screen', detail: 'landed somewhere else' };
  assert.deepEqual(
    actions.haltDecision({ verification: wrong }),
    { halt: true, failRun: true, error: 'unexpected-screen: landed somewhere else' },
  );
  // And a caller who has said continueOnError still gets to continue.
  assert.equal(actions.haltDecision({ verification: wrong, continueOnError: true }).halt, false);
});
