// Identity, as distinct from change.
//
// The pixel dHash answers "did this move?", which is a question about pixels
// and which it answers well. It is a poor answer to "is this the same screen?",
// because content is pixels: a list whose rows changed drifts as far as a
// different screen does. Measured, same-screen revisits reached 62 bits against
// a different-screen floor of 74 — no threshold separates those.
//
// This fingerprints layout instead. Two screens are the same when the same
// kinds of thing sit in the same places, whatever they currently say.
import crypto from 'node:crypto';
import * as regions from './regions.js';

/** Frames are quantised to this, so sub-pixel drift and a nudged row do not matter. */
export const GRID = 24;

/** Regions whose labels identify the screen rather than describe its contents. */
const CHROME = new Set(['nav-bar', 'tab-bar']);

/**
 * How wide a tab label can be before it is not a tab label.
 *
 * The region bands are positional, so anything low enough on the screen lands
 * in `tab-bar` — including page content sitting just above the real tabs. One
 * app put a date banner there, and because chrome labels go into the
 * fingerprint, that screen's identity contained "sep 08, 2026" and would have
 * become a different screen at midnight. Every stored map, node and route
 * touching it would have broken overnight.
 *
 * A tab bar divides its width between its tabs, so a tab's label is a fraction
 * of the screen: measured on that app, real tab labels ran 24-72 px against the
 * banner's 144 px on a 402 px screen. The element still contributes its shape
 * to the fingerprint — presence is structure — it just stops contributing text.
 */
const TAB_LABEL_MAX_WIDTH_FRACTION = 0.3;

const quantise = (v) => Math.round((v ?? 0) / GRID);

/** Coarse role, so "Button" and "AXButton" and an OCR-inferred button agree. */
export function roleOf(target) {
  const t = String(target.type ?? '').toLowerCase();
  if (/button/.test(t)) return 'button';
  if (/textfield|textview|searchfield|field/.test(t)) return 'field';
  if (/switch|toggle|checkbox/.test(t)) return 'switch';
  if (/cell|row/.test(t)) return 'cell';
  if (/link/.test(t)) return 'link';
  if (/image|icon/.test(t)) return 'image';
  if (/statictext|text|label/.test(t)) return 'text';
  if (/group|other|generic/.test(t)) return 'group';
  return t || 'unknown';
}

/**
 * One, or several.
 *
 * Finer buckets were tried and are worse: a list that grows from three rows to
 * seven crosses a 2-4 / 5+ boundary and changes identity, which is exactly the
 * instability the bucketing existed to prevent. "A group of these lives here"
 * is the stable fact; how many there are today is content.
 */
function bucket(n) {
  return n <= 1 ? '1' : 'many';
}

const normLabel = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);

/**
 * The canonical tokens this screen is made of.
 *
 * Deliberately excluded: the status bar (a clock is not identity), everything
 * inside the keyboard when one is up (it is the same keyboard on every screen),
 * and the text of anything in the content region (that is the content).
 */
export function tokens(targets, screen) {
  if (!screen?.width || !screen?.height) return { tokens: [], keyboard: false };
  const keyboardTop = regions.detectKeyboardTop(targets, screen);
  const groups = new Map();

  for (const t of targets) {
    const frame = t.frame ?? { x: t.x, y: t.y, width: 0, height: 0 };
    // Off-screen elements are not part of what this screen looks like.
    if (frame.y + (frame.height ?? 0) <= 0 || frame.y >= screen.height) continue;
    const region = t.region ?? regions.regionFor(frame, screen, { keyboardTop });
    if (region === 'status-bar') continue;
    if (keyboardTop != null && frame.y >= keyboardTop) continue;

    const role = roleOf(t);
    // Group by what a thing IS and how big it is, not where it is. Repeated
    // siblings — the rows of a list — differ only in position, and including
    // position in the key makes a four-row list a different screen from a
    // three-row one.
    const parts = [role, region];
    // Where in the nav bar a thing sits is structure, not content — and it is
    // what tells a title apart from a button that happens to be up there.
    if (CHROME.has(region) && t.navSlot) parts.push(`@${t.navSlot}`);
    parts.push(`w${quantise(frame.width)}`, `h${quantise(frame.height)}`);
    // Chrome labels are the only text that survives: two list screens with
    // identical structure differ by their title, and nothing else says so. But
    // only where the element is plausibly chrome — a nav bar has slots, and a
    // tab label is narrow; content that merely fell into the band is not a name.
    const labelWorthKeeping = CHROME.has(region)
      && t.label
      && (region !== 'tab-bar' || (frame.width ?? 0) <= screen.width * TAB_LABEL_MAX_WIDTH_FRACTION);
    if (labelWorthKeeping) parts.push(`"${normLabel(t.label)}"`);
    const key = parts.join(':');
    const group = groups.get(key) ?? { count: 0, x: quantise(frame.x), y: quantise(frame.y) };
    group.count += 1;
    // Anchor the group at its topmost member, which is stable as a list grows.
    if (quantise(frame.y) < group.y) {
      group.x = quantise(frame.x);
      group.y = quantise(frame.y);
    }
    groups.set(key, group);
  }

  const out = [...groups.entries()]
    .map(([key, g]) => (g.count > 1
      // A repeated group is identified by its anchor and how many of it there
      // roughly are, never by an exact count.
      ? `${key}:x${g.x}:y${g.y}#${bucket(g.count)}`
      : `${key}:x${g.x}:y${g.y}#1`))
    .sort();
  return { tokens: out, keyboard: keyboardTop != null };
}

export function hashTokens(list) {
  return crypto.createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 32);
}

/** Structural fingerprint of a screen, plus the tokens it was built from. */
export function fingerprint(targets, screen) {
  const { tokens: list, keyboard } = tokens(targets, screen);
  return { hash: hashTokens(list), tokens: list, keyboard, count: list.length };
}

/**
 * How alike two token sets are, 0 to 1.
 *
 * Jaccard rather than Hamming: the sets are of different sizes when an optional
 * element appears — a badge, a banner — and that should cost a little, not
 * everything.
 */
export function similarity(a = [], b = []) {
  if (!a.length && !b.length) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}
