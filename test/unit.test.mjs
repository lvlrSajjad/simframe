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
import { stepFor, saveFlow } from '../src/navigate.js';
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

test('a screen with no title falls back to its tabs, then to its hash', () => {
  assert.equal(describe(node([tabItem('Home', 20), tabItem('More', 300)])), 'home / more');
  assert.equal(describe(node([])), 'a'.repeat(8));
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

test('a flow with an unverified step is not saved', () => {
  const script = { steps: [{ tap: 'A' }], results: [{ verification: { verdict: 'unverified' } }] };
  assert.equal(saveFlow('nonexistent-udid', 'x', script).ok, false);
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
  const src = await fs.promises.readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const handler = src.slice(src.indexOf('main().catch('));
  assert.match(handler, /--json/, 'the top-level error handler must honour --json');
  assert.match(handler, /JSON\.stringify/);
  assert.match(handler, /ok: false/);
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
    setPermission: async () => 'granted nothing',
    setPasteboard: async () => {},
    permissionServices: () => [],
    capabilities: () => ({
      captureEngines: ['screenshot'],
      input: { supported: false, note: 'a fake device has no input' },
      ax: { supported: false, note: 'nor an accessibility tree' },
    }),
    toolchain: () => [{ name: 'nothing', level: 'ok', detail: 'no tools needed' }],
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
  assert.equal(report.overall.hpi_time, 1.333);
  assert.equal(report.overall.hpi, Number((0.667 * 1.333).toFixed(3)));
  // Flows with no name are ad-hoc runs; they are timed but have no counterpart.
  assert.equal(metrics.hpi({ flows: [{ wall_time_ms: 10, completed: true }] }).flows.length, 0);
});

test('the escalation breakdown says which faculty would remove each one', async () => {
  const metrics = await import('../src/metrics.js');
  const at = (reason, outcome, fingerprint) => ({
    reason, outcome, screen_fingerprint: fingerprint, model_turns_spent: outcome === 'resolved_locally' ? 0 : 1,
  });
  const b = metrics.breakdown([
    at('novel_dialog', 'escalated_to_model', 'aaa'),
    at('novel_dialog', 'resolved_locally', 'aaa'),
    at('unknown_screen', 'failed', 'bbb'),
    at('verification_failed', 'escalated_to_model', 'aaa'),
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

test('the HPI gate fails on the two conditions it is supposed to, and no others', async () => {
  const metrics = await import('../src/metrics.js');
  const base = { overall: { hpi_accuracy: 0.5, hpi_time: 0.475 } };
  const at = (hpi_accuracy, hpi_time) => ({ overall: { hpi_accuracy, hpi_time } });

  assert.deepEqual(metrics.gateAgainst(base, at(0.5, 0.475)), [], 'the baseline passes against itself');
  assert.deepEqual(metrics.gateAgainst(base, at(1, 0.9)), [], 'better on both passes');
  // 25%, a band measured from the noise between identical-code runs rather
  // than chosen: 0.35625 sits exactly on the bound and passes.
  assert.deepEqual(metrics.gateAgainst(base, at(0.5, 0.35625)), []);
  assert.equal(metrics.gateAgainst(base, at(0.5, 0.35)).length, 1);
  assert.match(metrics.gateAgainst(base, at(0.5, 0.35))[0], /HPI_time regressed/);
  // The gate reads the median of three passes when a report carries them, so
  // one slow pass cannot fail a build on its own — and one fast pass cannot
  // hide a real regression either.
  assert.deepEqual(
    metrics.gateAgainst(base, { overall: { hpi_accuracy: 0.5, hpi_time: 0.2, hpi_time_median_of_passes: 0.46 } }),
    [],
  );
  assert.equal(
    metrics.gateAgainst(base, { overall: { hpi_accuracy: 0.5, hpi_time: 0.5, hpi_time_median_of_passes: 0.2 } }).length,
    1,
  );
  assert.equal(metrics.TIME_REGRESSION, 0.25);
  // Any accuracy drop at all, however small.
  assert.match(metrics.gateAgainst(base, at(0.499, 0.475))[0], /HPI_accuracy dropped/);
  assert.equal(metrics.gateAgainst(base, at(0.4, 0.3)).length, 2);
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
