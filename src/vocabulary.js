/**
 * The words simframe may not act on by itself.
 *
 * CLAUDE.md has required this since the human-parity series was written — *"a
 * reflex never taps anything whose label matches the destructive vocabulary
 * (Delete, Remove, Pay, Send, Sign out, Reset…). Add the list to the same data
 * file."* — and several of my own comments already talk about "the destructive
 * vocabulary" as though it existed. It did not. This is it.
 *
 * **What it gates, precisely.** This restricts what simframe does *on its own
 * initiative*: a retry, an alternative selector, an exploration step, a reflex,
 * a speculative tap. It never restricts what the caller explicitly asked for.
 * `{"tap": "DELETE ACCOUNT"}` is a request and is honoured; substituting
 * "DELETE ACCOUNT" for a "Done" that did not resolve is not, and that is the
 * whole distinction. Getting it backwards would make the tool refuse the thing
 * a tester most needs to test.
 *
 * Data, not code, and locale-keyed, so another language is a file rather than a
 * release.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data', 'vocabulary');

const cache = new Map();

/** The vocabulary for a locale, falling back to English. */
export function load(locale = process.env.SIMFRAME_LOCALE || 'en') {
  const key = String(locale).toLowerCase().split(/[-_]/)[0];
  if (cache.has(key)) return cache.get(key);
  let data = null;
  for (const candidate of [key, 'en']) {
    try {
      data = JSON.parse(fs.readFileSync(path.join(DATA, `${candidate}.json`), 'utf8'));
      break;
    } catch { /* try the fallback */ }
  }
  // A missing file must not silently disable the barrier. An empty vocabulary
  // would make every label safe, which is the wrong direction to fail in, so
  // this throws rather than returning nothing.
  if (!data) throw new Error(`no vocabulary for "${locale}" and no en fallback in ${DATA}`);
  cache.set(key, data);
  return data;
}

const alnum = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Does this phrase occur in the label as whole words?
 *
 * Word boundaries, not substrings, and the reason is a real screen: an app's
 * "Work Orders" tab contains the letters of "order", and a substring match would
 * make its main navigation untouchable by anything local. Matching whole words
 * means "order" does not match "orders", which is the behaviour wanted here —
 * an exact tappable word is the signal, and a longer word is a different word.
 */
function saysPhrase(label, phrase) {
  const l = ` ${alnum(label)} `;
  const p = alnum(phrase);
  if (!p) return false;
  return l.includes(` ${p} `);
}

/**
 * May simframe act on this label on its own initiative?
 *
 * @returns {{allowed: boolean, reason?: string, matched?: string}}
 */
export function mayActLocally(label, { locale } = {}) {
  const text = String(label ?? '').trim();
  if (!text) return { allowed: true };
  const vocab = load(locale);

  // Exceptions first, and matched against the **whole** label rather than as a
  // phrase inside it. "Cancel" is how you *decline* a dialog and a barrier that
  // refused it would strand a local tier on every confirmation it met — but
  // "Cancel order" is a different act, and a phrase match would have waved it
  // through on the strength of its first word.
  const whole = alnum(text);
  for (const ok of vocab.destructive?.notWords?.words ?? []) {
    if (whole === alnum(ok)) return { allowed: true, reason: 'listed as safe', matched: ok };
  }
  for (const word of vocab.destructive?.words ?? []) {
    if (saysPhrase(text, word)) {
      return { allowed: false, reason: 'destructive vocabulary', matched: word };
    }
  }
  for (const word of vocab.leavesTheApp?.words ?? []) {
    if (saysPhrase(text, word)) {
      return { allowed: false, reason: 'leaves the app', matched: word };
    }
  }
  return { allowed: true };
}

/** Convenience for a filter: keep only what a local tier may act on. */
export const actableLocally = (label, options) => mayActLocally(label, options).allowed;
