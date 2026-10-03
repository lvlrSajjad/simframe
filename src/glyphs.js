/**
 * Names for icon-font glyphs, read from the app's own fonts.
 *
 * react-native-vector-icons, @expo/vector-icons and every other icon font draw
 * an icon as text: one character in a Unicode private use area, set in the
 * icon font. The accessibility tree hands that character over in the label,
 * and simframe has stripped it since it first met one (`input.cleanLabel`),
 * because "<glyph>, My Tools" has to match "My Tools". An icon-only button's
 * whole label is that one character, so it came out with no name at all.
 *
 * The character is not noise. It is an exact address into a font the app
 * ships, and community icon fonts name their glyphs: a field
 * app's MaterialDesignIcons.ttf names all 7,431 ("bell-outline", "dots-horizontal",
 * "delete"). So a code point plus the font's own `cmap` (character → glyph)
 * and `post` (glyph → name) tables is the icon's name — no pixels, no model,
 * no guessing. See docs/research/07-icon-naming.md.
 *
 * Pure: buffers in, names out. Where the fonts are, and which app is in front,
 * is the platform's business (`platform.appIconFonts`, `platform.bundleForPid`).
 */

import fs from 'node:fs';
import * as frontmost from './frontmost.js';
import * as platform from './platform/index.js';

/** Unicode private use areas: where icon fonts put their glyphs. */
export const PRIVATE_USE = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

/** The private-use code points in a label, in order. */
export function codepointsOf(label) {
  return [...String(label ?? '')].filter((c) => PRIVATE_USE.test(c)).map((c) => c.codePointAt(0));
}

function tables(buf) {
  const n = buf.readUInt16BE(4);
  const out = {};
  for (let i = 0; i < n; i += 1) {
    const at = 12 + 16 * i;
    out[buf.toString('latin1', at, at + 4)] = { offset: buf.readUInt32BE(at + 8), length: buf.readUInt32BE(at + 12) };
  }
  return out;
}

/** Character → glyph id, from a format 4 or format 12 cmap subtable. */
function readCmap(buf, { offset }) {
  const map = new Map();
  const count = buf.readUInt16BE(offset + 2);
  const subtables = [];
  for (let i = 0; i < count; i += 1) {
    const sub = offset + buf.readUInt32BE(offset + 4 + 8 * i + 4);
    subtables.push({ at: sub, format: buf.readUInt16BE(sub) });
  }
  // Format 12 covers the supplementary planes, where MaterialDesignIcons lives
  // (U+F0001 onward); format 4 covers the BMP. Read both, 12 first.
  for (const { at, format } of subtables.sort((a, b) => b.format - a.format)) {
    if (format === 12) {
      const groups = buf.readUInt32BE(at + 12);
      for (let g = 0; g < groups; g += 1) {
        const p = at + 16 + 12 * g;
        const start = buf.readUInt32BE(p);
        const end = buf.readUInt32BE(p + 4);
        const glyph = buf.readUInt32BE(p + 8);
        for (let c = start; c <= end; c += 1) if (!map.has(c)) map.set(c, glyph + (c - start));
      }
    } else if (format === 4) {
      const segX2 = buf.readUInt16BE(at + 6);
      const ends = at + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s += 1) {
        const end = buf.readUInt16BE(ends + 2 * s);
        const start = buf.readUInt16BE(starts + 2 * s);
        const delta = buf.readInt16BE(deltas + 2 * s);
        const rangeAt = ranges + 2 * s;
        const range = buf.readUInt16BE(rangeAt);
        for (let c = start; c <= end && c !== 0xffff; c += 1) {
          let glyph;
          if (range === 0) glyph = (c + delta) & 0xffff;
          else {
            const g = buf.readUInt16BE(rangeAt + range + 2 * (c - start));
            glyph = g === 0 ? 0 : (g + delta) & 0xffff;
          }
          if (glyph && !map.has(c)) map.set(c, glyph);
        }
      }
    }
  }
  return map;
}

const MAC_STANDARD = ['.notdef', '.null', 'nonmarkingreturn'];

/** Glyph id → name, from a version 2 `post` table. Null when the font keeps none. */
function readPost(buf, { offset, length }) {
  if (buf.readUInt32BE(offset) !== 0x00020000) return null;
  const n = buf.readUInt16BE(offset + 32);
  const index = [];
  for (let i = 0; i < n; i += 1) index.push(buf.readUInt16BE(offset + 34 + 2 * i));
  const custom = [];
  let p = offset + 34 + 2 * n;
  while (p < offset + length) {
    const len = buf[p];
    custom.push(buf.toString('latin1', p + 1, p + 1 + len));
    p += 1 + len;
  }
  return index.map((i) => (i < 258 ? MAC_STANDARD[i] ?? null : custom[i - 258] ?? null));
}

/**
 * A font's code point → glyph name table. Empty when the font names nothing
 * (a subsetted font often drops `post` names), which is reported, not guessed.
 */
export function parseFont(buf) {
  const t = tables(buf);
  if (!t.cmap || !t.post) return new Map();
  const cmap = readCmap(buf, t.cmap);
  const names = readPost(buf, t.post);
  const out = new Map();
  if (!names) return out;
  for (const [cp, glyph] of cmap) {
    const name = names[glyph];
    if (name && !/^(\.notdef|\.null|uni[0-9A-F]{4,6}|u[0-9A-F]{4,6}|glyph\d+)$/i.test(name)) out.set(cp, name);
  }
  return out;
}

/** "bell-outline" → "bell outline": words, so the vocabulary barrier reads them. */
export function humanise(glyphName) {
  return String(glyphName).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[-_.\s]+/).filter(Boolean).join(' ').toLowerCase();
}

/**
 * The name of the icon a label carries, from the fonts of the app in front.
 * Only when every glyph in it resolves in one font, and that font is the only
 * one of the app's fonts that resolves it to that name — two fonts that put
 * different icons at one code point are an ambiguity, not a guess to make.
 */
export function iconName(codepoints, fonts) {
  if (!codepoints?.length || !fonts?.length) return null;
  const answers = new Set();
  for (const font of fonts) {
    const names = codepoints.map((cp) => font.get(cp));
    if (names.every(Boolean)) answers.add(names.join(' '));
  }
  return answers.size === 1 ? humanise([...answers][0]) : null;
}

const bundleByPid = new Map();
const fontsByBundle = new Map();

/** The parsed icon fonts of the app in front, cached per pid and per bundle. */
export async function frontFonts(udid) {
  const { pid } = await frontmost.read(udid);
  if (pid == null) return [];
  if (!bundleByPid.has(`${udid}|${pid}`)) bundleByPid.set(`${udid}|${pid}`, await platform.bundleForPid(udid, pid).catch(() => null));
  const bundle = bundleByPid.get(`${udid}|${pid}`);
  if (!bundle) return [];
  if (!fontsByBundle.has(`${udid}|${bundle}`)) {
    const files = await platform.appIconFonts(udid, bundle).catch(() => []);
    const maps = [];
    for (const file of files) {
      try {
        const m = parseFont(fs.readFileSync(file));
        // Only fonts that name glyphs in a private use area are icon fonts.
        if ([...m.keys()].some((cp) => PRIVATE_USE.test(String.fromCodePoint(cp)))) maps.push(m);
      } catch { /* an unreadable font names nothing */ }
    }
    fontsByBundle.set(`${udid}|${bundle}`, maps);
  }
  return fontsByBundle.get(`${udid}|${bundle}`);
}

/**
 * Give an unlabeled target the name of the icon it shows. Mutates and returns
 * the list. A name made this way is marked `labelFrom: 'icon'`: it is shown as
 * such, it never enters a screen's fingerprint, and the vocabulary barrier
 * reads it like any label, so a "delete" glyph is refused like "Delete".
 */
export async function nameIcons(udid, targets) {
  if (!targets.some((t) => !t.label && t.glyphs?.length)) return targets;
  let fonts = [];
  try { fonts = await frontFonts(udid); } catch { return targets; }
  for (const t of targets) {
    if (t.label || !t.glyphs?.length) continue;
    const name = iconName(t.glyphs, fonts);
    if (name) { t.label = name; t.labelFrom = 'icon'; }
  }
  return targets;
}
