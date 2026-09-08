// Pure-function tests: no simulator required, so these run anywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodePng, encodePng, grayGrid, scaleBitmap } from '../src/png.js';
import { frameHash, rampLevel, regionMap, regionSignature, signatureDiff } from '../src/analyze.js';
import { elementToNode } from '../src/input.js';

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
import { haltDecision, normalizeStep } from '../src/actions.js';
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
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
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
// store.ROOT is read once at import, so setting SIMFRAME_HOME here would be too
// late — `npm test` sets it to a temp dir for the whole process instead. These
// tests used to write TEST-* directories into the real ~/.simframe, where they
// showed up as phantom devices in `simframe status`.
const freshDevice = (name) => {
  const udid = `TEST-${name}`;
  graphmod.forget(udid);
  return udid;
};

test('a known edge landing on an unrecognised screen grows a variant, not a screen', () => {
  const UDID = freshDevice('variant-grows');
  const A = { hash: 'a'.repeat(32), tokens: tok(6, 'a') };
  const B = { hash: 'b'.repeat(32), tokens: tok(6, 'b') };
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: B, kind: 'push' });
  // Same action from A, but B has arrived wearing a different structure.
  const Bprime = { hash: 'c'.repeat(32), tokens: tok(6, 'c') };
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: Bprime, kind: 'push' });

  assert.equal(graphmod.stats(UDID).screens, 2, 'B prime must not become a third screen');
  // Both structures now resolve to the same node.
  assert.equal(graphmod.nearestScreen(UDID, B).node.hash, B.hash);
  assert.equal(graphmod.nearestScreen(UDID, Bprime).node.hash, B.hash);
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
  graphmod.record(UDID, { from: A, action: { tap: 'go' }, to: { hash: 'b'.repeat(32), tokens: tok(6, 'b') } });
  for (let i = 0; i < graphmod.MAX_VARIANTS + 3; i += 1) {
    graphmod.record(UDID, {
      from: A,
      action: { tap: 'go' },
      to: { hash: String(i).padStart(32, 'd'), tokens: tok(6, `v${i}`) },
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
