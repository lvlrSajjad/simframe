// Frame comparison. Everything here works on a small grayscale grid, so a
// "did anything change?" question costs microseconds and no image tokens.
import { grayGrid } from './png.js';

export const HASH_COLS = 8;
export const HASH_ROWS = 16;
export const REGION_COLS = 4;
export const REGION_ROWS = 8;

/** A 128-bit mean-threshold hash, rendered as hex. Same screen => same hash. */
export function frameHash(bmp) {
  const { gray } = grayGrid(bmp, HASH_COLS, HASH_ROWS);
  let mean = 0;
  for (const v of gray) mean += v;
  mean /= gray.length;
  let hex = '';
  for (let i = 0; i < gray.length; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) if (gray[i + b] > mean) nibble |= 1 << b;
    hex += nibble.toString(16);
  }
  return hex;
}

/** Coarse per-region change, 0-100, laid out row-major over REGION_COLS x REGION_ROWS. */
export function regionSignature(bmp) {
  return Array.from(grayGrid(bmp, REGION_COLS, REGION_ROWS).gray);
}

/** Mean absolute difference of two region signatures, as a 0-1 fraction. */
export function signatureDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
}

/** Per-region change fractions, so callers can tell a toast from a screen push. */
export function regionDeltas(a, b) {
  if (!a || !b || a.length !== b.length) return a ? a.map(() => 1) : [];
  return a.map((v, i) => Math.abs(v - b[i]) / 255);
}

const RAMP = ['.', ':', '+', '*', '#', '@'];
// Screen changes span orders of magnitude — a moving caret is ~0.3%, a screen
// push is ~30% — so the ramp is bucketed logarithmically rather than linearly.
const RAMP_STOPS = [0.002, 0.01, 0.03, 0.08, 0.2];

export function rampLevel(delta) {
  let level = 0;
  for (const stop of RAMP_STOPS) if (delta >= stop) level++;
  return level;
}

/** Render region deltas as a tiny ASCII map: readable in text, ~40 tokens. */
export function regionMap(deltas, cols = REGION_COLS) {
  if (!deltas.length) return '';
  const lines = [];
  for (let r = 0; r < deltas.length / cols; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) line += RAMP[rampLevel(deltas[r * cols + c] ?? 0)];
    lines.push(line);
  }
  return lines.join('\n');
}

/** Signatures live in state.json, so they are stored as compact hex. */
export function signatureToHex(sig) {
  return sig.map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function hexToSignature(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/**
 * A hash of the screen's LAYOUT rather than its content.
 *
 * The frame hash changes whenever any pixel group changes — a clock digit, a new
 * row of data — which makes it useless as a key for "have I seen this screen
 * before?". This one skips the status bar and thresholds a coarse grid, so two
 * visits to the same list with different rows still land close together, while a
 * genuinely different screen lands far away.
 */
export const LAYOUT_COLS = 12;
export const LAYOUT_ROWS = 24;
export const LAYOUT_TOP_SKIP = 0.055; // the status bar, as a fraction of height

export function layoutHash(bmp) {
  const top = Math.floor(bmp.height * LAYOUT_TOP_SKIP);
  const cropped = {
    width: bmp.width,
    height: bmp.height - top,
    data: bmp.data.subarray(top * bmp.width * 4),
  };
  // A difference hash: each bit compares a cell with its right-hand neighbour.
  // Thresholding against a global mean collapses low-contrast app screens onto
  // the same value; local gradients stay discriminative.
  const { gray } = grayGrid(cropped, LAYOUT_COLS + 1, LAYOUT_ROWS);
  const bits = [];
  for (let r = 0; r < LAYOUT_ROWS; r++) {
    for (let c = 0; c < LAYOUT_COLS; c++) {
      const i = r * (LAYOUT_COLS + 1) + c;
      bits.push(gray[i] > gray[i + 1] ? 1 : 0);
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += (bits[i] | (bits[i + 1] << 1) | (bits[i + 2] << 2) | (bits[i + 3] << 3)).toString(16);
  }
  return hex;
}

const BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Hamming distance between two hex hashes of equal length. */
export function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += BITS[(parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf];
  return d;
}
