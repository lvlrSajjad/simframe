// Pure-function tests: no simulator required, so these run anywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodePng, encodePng, grayGrid, scaleBitmap } from '../src/png.js';
import { frameHash, rampLevel, regionMap, regionSignature, signatureDiff } from '../src/analyze.js';

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
import { normalizeStep } from '../src/actions.js';
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
