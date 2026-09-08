// Element refs and selectors.
//
// A number in front of every element is what lets the next call name one
// without describing it: `#3` instead of "the second Save button, the one in
// the nav bar". The table lives on disk because the call that numbered the
// elements and the call that acts on one are separate MCP round trips.
//
// Kept apart from view.js so that index.js can resolve a selector without
// importing the renderer that in turn imports index.js.
import fs from 'node:fs';
import path from 'node:path';
import { hashDistance } from './analyze.js';
import * as store from './store.js';

/**
 * How far the pixel layout may drift before a ref is no longer trustworthy.
 *
 * The same number screen memory uses to decide two frames are the same screen,
 * and for the same reason: a list that gained a row is still the screen the
 * elements were numbered on, but a different screen is not.
 */
export const REF_TOLERANCE = 20;

/**
 * Does this layout hash carry enough signal to compare?
 *
 * A blank, dark or near-uniform screen hashes to almost all zeros, and the
 * Hamming distance between two such hashes is tiny however different the
 * screens are. Below this many set bits the hash is not evidence.
 */
const MIN_SET_BITS = 16;

export function informative(hex) {
  let bits = 0;
  for (const ch of String(hex ?? '')) {
    const v = parseInt(ch, 16);
    if (Number.isNaN(v)) continue;
    bits += (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1);
    if (bits >= MIN_SET_BITS) return true;
  }
  return false;
}

const refsFile = (udid) => path.join(store.deviceDir(udid), 'refs.json');

/**
 * Number the elements and write the table down.
 *
 * A ref is only meaningful while the screen it was numbered on is still
 * showing, so the table records the screen's structural hash and resolving a
 * ref against a different screen is an error rather than a tap somewhere
 * unintended.
 */
export function writeRefs(udid, { structuralHash, layoutHash, rows }) {
  const body = {
    structuralHash: structuralHash ?? null,
    layoutHash: layoutHash ?? null,
    at: Date.now(),
    refs: rows.map((r) => ({
      ref: r.ref,
      label: r.label ?? null,
      x: r.x,
      y: r.y,
      type: r.type ?? null,
      region: r.region ?? 'content',
      source: r.source ?? null,
    })),
  };
  try {
    fs.mkdirSync(path.dirname(refsFile(udid)), { recursive: true });
    store.writeAtomic(refsFile(udid), JSON.stringify(body));
  } catch {
    /* refs are a convenience; failing to cache them must not fail the call */
  }
  return body;
}

export function readRefs(udid) {
  return store.readJson(refsFile(udid));
}

/**
 * `#3` | `@120,400` | anything else.
 *
 * Parsing is separate from resolving so a caller can tell a selector from a
 * label without touching the device.
 */
export function parseSelector(query) {
  const raw = String(query ?? '').trim();
  const ref = /^#(\d+)$/.exec(raw);
  if (ref) return { kind: 'ref', ref: Number(ref[1]) };
  const at = /^@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(raw);
  if (at) return { kind: 'point', x: Math.round(Number(at[1])), y: Math.round(Number(at[2])) };
  // A quoted label is an explicit "this exact text", not an intent.
  const quoted = /^"(.*)"$/.exec(raw) || /^'(.*)'$/.exec(raw);
  if (quoted) return { kind: 'label', label: quoted[1], exact: true };
  return { kind: 'label', label: raw, exact: false };
}

/**
 * Turn a `#n` back into a point.
 *
 * Refuses when the screen has moved on. A stale ref is the one failure mode
 * numbering introduces that labels do not have, and a ref resolved against the
 * wrong screen taps whatever now happens to sit at those coordinates.
 */
export function resolveRef(udid, n, { structuralHash, layoutHash, screenKnown, tolerance = REF_TOLERANCE } = {}) {
  const table = readRefs(udid);
  if (!table) throw new Error(`#${n} means nothing yet — read the screen first (sim_ui, or simframe ui)`);
  const stale = (was, now) =>
    `#${n} was numbered on a different screen (${was} → ${now}) — read the screen again before using refs`;

  // Structural identity first, because it is the question actually being asked:
  // is this the screen those numbers were assigned on? The caller gets it
  // cheaply — screen memory is a file read, not a perception pass.
  if (table.structuralHash && structuralHash && table.structuralHash !== structuralHash) {
    throw new Error(stale(table.structuralHash.slice(0, 8), structuralHash.slice(0, 8)));
  }
  // Nothing recognises the screen we are on, so nothing can vouch for the
  // numbers. Refusing costs a re-read; guessing taps whatever is at those
  // coordinates now.
  if (screenKnown === false) {
    throw new Error(`#${n} cannot be trusted here — simframe does not recognise this screen. Read it again (sim_ui) to renumber.`);
  }
  // The pixel check stays, but only as a backstop, and only where it means
  // something. A dark or near-uniform screen produces a layout hash of almost
  // all zeros, and two such screens sit within any sane tolerance of each
  // other — measured: refs numbered on the springboard resolved happily on a
  // different screen because both hashes were degenerate. A hash with almost
  // no bits set is not evidence of anything.
  if (layoutHash && table.layoutHash && informative(table.layoutHash) && informative(layoutHash)
    && hashDistance(table.layoutHash, layoutHash) > tolerance) {
    throw new Error(stale(table.layoutHash.slice(0, 8), layoutHash.slice(0, 8)));
  }
  const hit = table.refs.find((r) => r.ref === n);
  if (!hit) {
    const available = table.refs.length ? `#1-#${table.refs.length}` : 'none';
    throw new Error(`#${n} is not on this screen (numbered: ${available})`);
  }
  return hit;
}
