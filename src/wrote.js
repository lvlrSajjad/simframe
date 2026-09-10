/**
 * What simframe itself typed into this device, and whether it is still there.
 *
 * A peer filled three fields on a web form, and six calls later they were
 * empty. Every one of those six calls returned `ok`. simframe had *recorded*
 * all three values two calls earlier and said nothing when they vanished — so
 * the agent only found out by paying for a screenshot, and an agent that had
 * trusted the verdicts would have submitted an empty order.
 *
 * Two design decisions, both from how that failure actually presented.
 *
 * **Not keyed on screen identity.** The obvious home for this is the screen
 * map, and it would have missed the whole thing: the wipe was observed under a
 * different screen hash than the one the values were written under, because a
 * pinch-zoom and a horizontal scroll had both moved the identity. What stayed
 * constant was the field's own label. So this is a small per-device journal,
 * and a screen is only relevant in that its labels are what we match against.
 *
 * **Only confirmed writes are journalled.** An unconfirmed write is not
 * evidence a value was ever there, and journalling one would manufacture a
 * "your text disappeared" warning for text that never arrived — trading a
 * silent failure for a confident wrong answer, which is the worse of the two.
 */
import path from 'node:path';
import * as store from './store.js';

const FILE = 'wrote.json';

/** Keep the journal small: this is a recency signal, not a history. */
export const KEEP = 24;

/**
 * How long a journalled value stays interesting.
 *
 * Long enough to span the kind of sequence that lost the peer's three fields
 * (six calls, a little over two minutes), short enough that yesterday's form
 * never comments on today's.
 */
export const MAX_AGE_MS = 15 * 60 * 1000;

const file = (udid) => path.join(store.deviceDir(udid), FILE);

/** Comparison that ignores what OCR adds — the same rule the readback uses. */
const alnum = (v) => String(v ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Does this read as a label at all, rather than as a coordinate or a ref? */
const hasLetters = (v) => /\p{L}/u.test(String(v ?? ''));

export function read(udid) {
  const got = store.readJson(file(udid));
  return Array.isArray(got) ? got : [];
}

/**
 * Record a value that was *confirmed* to have landed.
 *
 * Re-writing the same field replaces its entry rather than adding one, so a
 * field filled twice cannot warn about its own earlier contents.
 */
export function record(udid, { selector, value, screen }) {
  if (!udid || !selector || !alnum(value)) return null;
  // A selector with no letters in it is not a label: "(125,325)", "@120,400",
  // "#3". There is nothing to look for on a later screen, and its digits would
  // happily match some unrelated number — so it is never journalled at all,
  // rather than journalled and then skipped.
  if (!hasLetters(selector)) return null;
  const now = Date.now();
  const key = alnum(selector);
  const kept = read(udid).filter((e) => alnum(e.selector) !== key);
  const next = [{ selector: String(selector), value: String(value), screen: screen ?? null, at: now }, ...kept]
    .slice(0, KEEP);
  try {
    store.ensureDirs(udid);
    store.writeAtomic(file(udid), JSON.stringify(next));
  } catch {
    // A journal that cannot be written must never fail the step that wrote the
    // field. Losing the warning is a smaller cost than losing the write.
    return null;
  }
  return next[0];
}

/**
 * Which journalled values look as though they have been cleared.
 *
 * Deliberately narrow, because a false alarm here would teach an agent to
 * ignore the line. An entry only counts as missing when its own **label is on
 * this screen** — so we are plausibly looking at the same form — and its value
 * appears nowhere in the map. Anything else (the label absent, the value
 * present, the screen empty) says nothing and is reported as nothing.
 */
export function missing(udid, targets, { now = Date.now() } = {}) {
  const rows = targets ?? [];
  if (!rows.length) return [];
  const haystack = rows.map((t) => alnum(`${t.label ?? ''} ${t.value ?? ''}`)).filter(Boolean);
  if (!haystack.length) return [];
  const gone = [];
  for (const e of read(udid)) {
    if (!Number.isFinite(e.at) || now - e.at > MAX_AGE_MS) continue;
    const label = alnum(e.selector);
    const value = alnum(e.value);
    if (!label || !value) continue;
    // `startsWith`, not `includes`. A field's row begins with its own label —
    // and OCR fuses the value onto the end of it ("Telephone: 5551234567"),
    // which is why this cannot be an equality test. A substring test looked
    // equivalent and was not: on the very first field run after this shipped, a
    // journalled "Email" matched the page footer's newsletter box, "Enter your
    // email address", and announced a value gone that was merely on a different
    // part of the page. A false alarm here teaches an agent to ignore the line,
    // which costs more than the line is worth.
    if (!haystack.some((h) => h.startsWith(label))) continue;
    if (haystack.some((h) => h.includes(value))) continue;
    gone.push(e);
  }
  return gone;
}

/** The line the map prints, or null when there is nothing to say. */
export function missingLine(gone) {
  const list = (gone ?? []).slice(0, 3);
  if (!list.length) return null;
  const parts = list.map((e) => {
    const v = String(e.value).length > 24 ? `${String(e.value).slice(0, 24)}…` : String(e.value);
    return `${JSON.stringify(v)} in ${JSON.stringify(String(e.selector))}`;
  });
  const more = (gone?.length ?? 0) - list.length;
  return `a value simframe wrote here is gone: ${parts.join(', ')}${more > 0 ? `, and ${more} more` : ''}`
    + ' — the field is on this screen and its contents are not, so something cleared it. Re-fill before continuing.';
}

/** Forget the journal for a device — used when its memory is reset. */
export function forget(udid) {
  try {
    store.writeAtomic(file(udid), JSON.stringify([]));
  } catch { /* nothing to forget */ }
}
