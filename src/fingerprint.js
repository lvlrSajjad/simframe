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

/**
 * Bumped whenever the token rules change, and read by `graph.FINGERPRINT_VERSION`
 * and `screenmap.MAP_VERSION` so stored hashes are discarded rather than
 * compared against hashes computed by different rules. An old hash is a
 * perfectly well-formed hash that never matches anything, which is the quietest
 * kind of wrong.
 *
 * 2 — elements with no visible footprint, and containers holding two or more
 *     others, no longer enter identity: only one sensor can see either.
 * 3 — a chrome label must be a name: at least two letters, and not a URL. A
 *     browser's address bar put "== example.com" into a screen's identity, so
 *     a different page read as a different screen, and OCR's ":" and "+" read
 *     off icons were identities of their own.
 * 4 — not a token-rule change at all, and bumped anyway: the screen map now
 *     merges an OCR reading that sits inside a labelled ax element into that
 *     element, so the target list these rules run over is shorter on every
 *     list screen. Same rules, different input, therefore different hashes —
 *     and a stored hash that can never match again is the quietest kind of
 *     wrong, which is what this counter exists to prevent.
 * 5 — a phantom keyboard was deleting screens' content from their identity. A
 *     dozen short text rows of uniform height stacked low on a read-only
 *     summary satisfied every size-and-uniformity test for a keyboard, and
 *     `tokens` discards everything below `keyboardTop` — so two screens of one
 *     wizard, sharing a nav title and a step indicator, collapsed onto a single
 *     hash. `detectKeyboardTop` now requires the small uniform boxes to be
 *     key-shaped. Every screen with content in its lower half hashes
 *     differently, so the stored graph and maps must go.
 * 6 — the opposite half of the same bug, and it took a recorded screen to see.
 *     `KEYBOARD_MIN_FRACTION` is a *detection window*, not a keyboard's height,
 *     and its edge was being used as the boundary — so on an iPhone 17 Pro with
 *     the software keyboard up, the window starts at y=629 while the `q`–`p`
 *     row's frame top is **590**, and that whole row fell outside it. Ten
 *     keyboard keys were reported as page content and counted into the screen's
 *     identity, in the same map that said `keyboard up`. The boundary now
 *     extends upward while the rows above keep being key-shaped, which page
 *     content is not. Any screen fingerprinted with a keyboard up hashes
 *     differently, so the stored graph and maps must go again.
 */
export const TOKEN_RULES_VERSION = 6;

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
 * A value, not a name.
 *
 * Phase 6d removed a date banner from one screen's identity after that
 * fingerprint would have expired at midnight. It came back through a different
 * door: measured across twenty screens of a real app, three carried content in
 * their identity because the positional region bands had called it chrome — a
 * store address, a phone number, and a nav title reading "Tuesday, September 8".
 * That last one is a screen whose identity has until midnight to live.
 *
 * The band misclassification is the root cause and is fixed by clustering, not
 * by another threshold (docs/DEFERRED.md). What can be fixed here without
 * guessing at geometry is the narrower question: is this text a name for the
 * screen, or is it today's value? A name is words. A date, a phone number, a
 * price and a bare count are not, and every one of them changes while the
 * screen stays the same screen.
 */
const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
const WEEKDAYS = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*day?\b/i;
const DATE_LIKE = /\d{1,4}[/.-]\d{1,2}([/.-]\d{1,4})?|\b\d{1,2}:\d{2}\b/;

/**
 * A URL is the most volatile thing a nav bar can hold.
 *
 * Measured on Android, where a browser's address bar is chrome by every
 * structural test there is: the screen's identity contained `"== example.com"`,
 * so the same browser on a different page was a different screen, and every
 * route through it broke on navigation. The `==` is OCR reading the lock icon.
 *
 * Matched after stripping the punctuation OCR decorates it with, and only when
 * the whole label is the address — a sentence that happens to mention a domain
 * is still a sentence.
 */
const URL_LIKE = /^(https?:\/\/|www\.)|^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i;

/** How many letters a name has to have. One is a glyph, not a name. */
const NAME_MIN_LETTERS = 2;

export function isVolatileLabel(label) {
  const text = String(label ?? '').trim();
  if (!text) return true;
  if (MONTHS.test(text) || WEEKDAYS.test(text) || DATE_LIKE.test(text)) return true;
  // Strip what OCR hangs off an icon before asking whether the rest is an
  // address: the observed label was `== example.com`.
  const bare = text.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}/]+$/u, '');
  if (URL_LIKE.test(bare)) return true;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const digits = (text.match(/\p{N}/gu) ?? []).length;
  // A label with no word in it is not a name for anything. OCR reads `:`, `+`,
  // `...` and `—` off icons, and each of those became an identity of its own.
  if (letters < NAME_MIN_LETTERS) return true;
  // Mostly digits: a count, a price, a phone number, an ID. "1020" and
  // "+1 (111) 111-1111" are both this; "Assets" is not.
  return digits > 0 && digits >= letters;
}

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

  // Identity is what the screen *is*, not which sensor happened to see it, so
  // two things that only one sensor can produce must not enter it: an element
  // with no visible footprint, and a container that exists to hold others.
  // Pixels cannot see either, and the accessibility tree reports both.
  const encloses = (frame) => targets.filter((o) => {
    const f = o.frame;
    if (!f || f === frame) return false;
    const cx = f.x + (f.width ?? 0) / 2;
    const cy = f.y + (f.height ?? 0) / 2;
    return cx > frame.x && cx < frame.x + (frame.width ?? 0)
      && cy > frame.y && cy < frame.y + (frame.height ?? 0);
  }).length;

  for (const t of targets) {
    const frame = t.frame ?? { x: t.x, y: t.y, width: 0, height: 0 };
    // Off-screen elements are not part of what this screen looks like.
    if (frame.y + (frame.height ?? 0) <= 0 || frame.y >= screen.height) continue;
    // Nor is anything with no footprint to be seen.
    if (!(frame.width > 0) || !(frame.height > 0)) continue;
    const region = t.region ?? regions.regionFor(frame, screen, { keyboardTop });
    if (region === 'status-bar') continue;
    if (keyboardTop != null && frame.y >= keyboardTop) continue;
    // A thing that holds two or more other things is scenery, and only the
    // tree can see it. Its children are already in the fingerprint.
    if (/group|other|generic/i.test(String(t.type ?? '')) && encloses(frame) >= 2) continue;

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
      && !isVolatileLabel(t.label)
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
  // No tokens is not an identity. It is the absence of one.
  //
  // sha256 of the empty string is a constant, so every unreadable screen used
  // to hash to `e3b0c442…` — one identity shared by a dark screen, a screen
  // whose OCR failed, and a screen read mid-transition. Different screens
  // collapsing onto a single hash is a wrong *merge*, which is worse than a
  // missed match: a ref numbered on one screen resolved happily on another,
  // and an edge learned on one predicted the other, with a verdict of `ok`.
  //
  // The pixel layout hash had exactly this degeneracy and got an
  // `informative()` guard for it. The structural hash did not, and the guard
  // could not have helped: a constant is perfectly informative-looking.
  if (!list.length) return null;
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
  // Two empty token sets are not a match, they are two absences of evidence.
  // Returning 1 here made unreadability *self-confirming*: two consecutive
  // unreadable reads "agreed", which promoted the non-identity to a confirmed
  // screen and let it be written into memory and learned as an edge.
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}
