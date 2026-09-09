// What Claude sees.
//
// Every action used to answer with an image. An image costs 1,600 tokens when
// Claude Code handles it natively and 15,000–25,000 when it does not, and it
// answers the one question the tool already knew: what is on the screen and
// what can be tapped. This module answers that in text, with a number in front
// of every element so the next call can name one without describing it.
//
// The format is deliberately dense. Region first, because "Assets" the nav
// title and "Assets" the tab differ only by where they are; a tap point,
// because that is what an action needs; and the source, because an element the
// app published and one OCR read off the pixels deserve different amounts of
// trust.
import * as api from './index.js';
import * as graph from './graph.js';
import { writeRefs } from './refs.js';
import * as matching from './matching.js';

/** Reading order. Chrome frames the screen, so it reads first and last. */
const REGION_ORDER = ['nav-bar', 'content', 'tab-bar', 'keyboard', 'status-bar'];

/**
 * The status bar says the time and the battery level. It is on every screen,
 * it is never what anybody wants to tap, and it costs a row every time.
 */
const HIDDEN_REGIONS = new Set(['status-bar']);

/** A keyboard is 30-odd keys nobody refers to by name. One line says it. */
const COLLAPSE_REGIONS = new Set(['keyboard']);

/** Past this many rows the map stops being cheaper than looking. */
export const DEFAULT_LIMIT = 60;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Types that are hit targets rather than description. */
const INTERACTIVE = /button|field|cell|link|switch|slider|tab|menu|segment|checkbox/i;

/** A label past this length is a paragraph, and no selector needs a paragraph. */
const MAX_LABEL = 64;

/** Anything covering more of the screen than this is scenery, not a control. */
const CONTAINER_AREA_FRACTION = 0.35;

const area = (f) => (f ? Math.max(1, f.width) * Math.max(1, f.height) : 0);

const centerInside = (t, f) =>
  Boolean(f) && t.x >= f.x && t.x <= f.x + f.width && t.y >= f.y && t.y <= f.y + f.height;

/**
 * Fold read text into the control it is printed on.
 *
 * The screen map keeps an accessibility element and the text OCR read off it as
 * separate targets, deliberately: identity is computed from that list and
 * throwing away a target would change what a screen is. But as something to
 * show a model it is nearly twice as long as it needs to be — "TRACK TIME" the
 * button and "TRACK TIME" the pixels are one thing to tap.
 *
 * So the folding happens here, in the presentation, and the fingerprint never
 * sees it. The rule is containment plus interactivity: text sitting inside a
 * button belongs to that button. Size is not part of it — that check exists in
 * screenmap.build to stop a tab bar swallowing its five tabs, and a tab bar is
 * not interactive.
 */
/**
 * How many pieces of text one control may absorb.
 *
 * A control's visible text is a fragment or three: a title, a count, a unit. A
 * container swallows five, and a tab bar that absorbed its own tabs would leave
 * nothing to tap. This is what separates the two, because size does not: a
 * dashboard tile and a tab bar are the same few thousand square points.
 */
const MAX_ABSORBED = 3;

/** Could this be the thing the text is printed on? */
function isHost(t) {
  if (!t.frame) return false;
  if (INTERACTIVE.test(t.type || '')) return true;
  // An accessibility element the app gave a label to is a unit the app itself
  // considers one thing — a dashboard tile reading "WOs past ETA, 1910" is one
  // tap target whose parts OCR happens to read separately.
  return matching.isAxTarget(t) && Boolean(t.label);
}

/**
 * Fold read text into the control it is printed on.
 *
 * The screen map keeps an accessibility element and the text OCR read off it as
 * separate targets, deliberately: identity is computed from that list and
 * dropping a target would change what a screen is. But as something to show a
 * model it is nearly twice as long as it needs to be — "TRACK TIME" the button
 * and "TRACK TIME" the pixels are one thing to tap.
 *
 * So the folding happens here, in the presentation, and the fingerprint never
 * sees it.
 */
function foldText(targets) {
  const hosts = targets.filter(isHost);
  // Who would absorb what, before absorbing anything: a host that turns out to
  // be a container must not have already eaten two of its children.
  const claims = new Map(hosts.map((h) => [h, []]));
  for (const t of targets) {
    if (isHost(t)) continue;
    const host = hosts
      .filter((h) => centerInside(t, h.frame))
      .sort((a, b) => area(a.frame) - area(b.frame))[0];
    if (host) claims.get(host).push(t);
  }

  const absorbed = new Set();
  for (const [host, texts] of claims) {
    if (!texts.length || texts.length > MAX_ABSORBED) continue;
    for (const t of texts) {
      absorbed.add(t);
      const text = String(t.label ?? '').trim();
      if (text && !saysTheSame(host, text)) host.aliases = [...(host.aliases ?? []), text];
    }
  }
  return targets.filter((t) => !absorbed.has(t));
}

/** Comparison that ignores what OCR adds: a stray bullet, a mangled glyph. */
const alnum = (s_) => String(s_ ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function saysTheSame(host, text) {
  const t = alnum(text);
  if (!t) return true;
  return [host.label, ...(host.aliases ?? [])]
    .filter(Boolean)
    .some((known) => alnum(known).includes(t));
}

/**
 * Drop the scenery.
 *
 * A group that encloses several other elements is the thing they are arranged
 * in, not a thing anybody means to tap — and it is exactly what "tap the tab
 * bar" would resolve to if it were listed.
 */
function dropContainers(targets, screen) {
  const screenArea = screen?.width && screen?.height ? screen.width * screen.height : Infinity;
  return targets.filter((t) => {
    if (!t.frame) return true;
    if (INTERACTIVE.test(t.type || '')) return true;
    if (area(t.frame) > screenArea * CONTAINER_AREA_FRACTION) return false;
    const encloses = targets.filter((o) => o !== t && centerInside(o, t.frame)).length;
    return encloses < 2;
  });
}

/**
 * Text with no letters or digits in it is OCR reading the furniture: a divider,
 * an ellipsis menu, a chevron it decided was a period. Nothing can be tapped by
 * that name, so listing it is pure cost.
 */
const isNoise = (t) => !matching.isAxTarget(t) && t.source === 'ocr' && !alnum(t.label);

const trim = (text) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > MAX_LABEL ? `${one.slice(0, MAX_LABEL - 1)}…` : one;
};

/** Rank and number what is on screen. */
export function rowsFor(entry, { screen, filter, interactive, all = false, limit = DEFAULT_LIMIT } = {}) {
  let kept = (entry?.targets ?? []).map((t) => ({ ...t })).filter((t) => {
    if (!isNum(t.x) || !isNum(t.y)) return false;
    // Off-screen elements are real in the tree and untappable in fact.
    if (screen?.height && (t.y < 0 || t.y > screen.height)) return false;
    if (!all && HIDDEN_REGIONS.has(t.region)) return false;
    if (!all && isNoise(t)) return false;
    return true;
  });

  if (!all) {
    kept = foldText(kept);
    kept = dropContainers(kept, screen);
  }

  if (filter) {
    const q = String(filter).toLowerCase();
    kept = kept.filter((t) =>
      [t.label, ...(t.aliases ?? [])].filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  if (interactive) kept = kept.filter((t) => INTERACTIVE.test(t.type || ''));

  const order = (t) => {
    const i = REGION_ORDER.indexOf(t.region ?? 'content');
    return i === -1 ? REGION_ORDER.indexOf('content') : i;
  };
  kept.sort((a, b) => order(a) - order(b) || a.y - b.y || a.x - b.x);

  const rows = [];
  const collapsed = new Map();
  for (const t of kept) {
    const region = t.region ?? 'content';
    if (COLLAPSE_REGIONS.has(region)) {
      collapsed.set(region, (collapsed.get(region) ?? 0) + 1);
      continue;
    }
    rows.push({ ...t, region, ref: rows.length + 1 });
  }
  return { rows: rows.slice(0, limit), truncated: Math.max(0, rows.length - limit), collapsed };
}

/**
 * Say when the rows below were remembered rather than looked at.
 *
 * Screen memory is deliberately keyed on the pixel layout hash, because a list
 * with new rows is the same screen and re-perceiving it per step is the cost
 * Phase 13 exists to remove. That is right for *identity* and wrong for
 * *contents*, and the map made no distinction: a field's text reaches a row as
 * an OCR alias, so a recalled map reports the text the field held when the map
 * was built. Reported from a real session — a picker described the previous
 * sheet's options and did it in 23 ms, which is the giveaway, because 23 ms is
 * not enough time to have looked.
 *
 * This does not fix that. It stops it being invisible, which is the part that
 * cost two wrong conclusions about an app.
 *
 * Only past a second, because a map built by this very call is not a
 * recollection and saying so on every screen is how a real warning gets
 * skimmed.
 */
export const RECALL_NOTE_FLOOR_MS = 1000;

export function recalledNote(identity, now = Date.now()) {
  const at = identity?.entry?.at;
  if (!Number.isFinite(at)) return null;
  const age = now - at;
  if (age < RECALL_NOTE_FLOOR_MS) return null;
  const ago = age < 60_000 ? `${Math.round(age / 1000)}s` : `${Math.round(age / 60_000)}m`;
  return `elements recalled from ${ago} ago — pass refresh for what is there now`;
}

/**
 * What a control *contains*, from the sensor that actually knows.
 *
 * A field's text reached a row only as the OCR alias, which means it was as old
 * as the map and had no authoritative source at all. Reported from a real
 * session: an `assert` on a field's contents failed against a field that did
 * contain the string, the operator retyped, and the field ended up with a
 * doubled value and a validation error. A character counter read `0/1000` in
 * the map and `56/1000` in a screenshot of the same frame.
 *
 * The accessibility tree carries `value` and always has —
 * `input.elementToNode` sets it on every node — and the renderer simply never
 * printed it. Printed as `= <value>` and *alongside* the OCR alias rather than
 * instead of it, so when the two disagree that is visible instead of resolved
 * by whichever one the renderer preferred. Disagreement is the signal.
 *
 * Skipped when the label already says it, which is most switches and rows: iOS
 * labels a settings row "Larger Text, Off" and printing `= Off` after that is
 * noise.
 */
function valueNote(r) {
  if (r.value == null || r.value === '') return null;
  const v = trim(String(r.value));
  if (!v) return null;
  const said = alnum(r.label);
  if (said && alnum(v) && said.includes(alnum(v))) return null;
  return `= ${v}`;
}

function renderRow(r) {
  const name = [
    trim(r.label) || (matching.isAxTarget(r) ? '(unlabelled)' : '(no text)'),
    valueNote(r),
    aliasNote(r),
  ].filter(Boolean).join(' ');
  const state = [
    r.enabled === false ? 'disabled' : null,
    r.selected ? 'selected' : null,
  ].filter(Boolean).join(',');
  return [
    `#${r.ref}`.padStart(4),
    shortType(r.type).padEnd(9),
    `${r.x},${r.y}`.padEnd(9),
    state ? `${state} ` : '',
    name,
  ].join(' ');
}

/**
 * Only aliases that say something the label does not.
 *
 * The screen map records OCR's reading of an element it already had a label
 * for, which is useful when they disagree and pure cost when they agree —
 * "WELCOME ~ WELCOME" was a third of some rows.
 */
function aliasNote(r) {
  const extra = (r.aliases ?? [])
    .filter((a) => {
      const t = alnum(a);
      return t && !alnum(r.label).includes(t);
    })
    .slice(0, 2);
  return extra.length ? `~ ${trim(extra.join(' '))}` : null;
}

/**
 * Element types, in as few characters as carry the meaning. iOS calls things
 * `GenericElement` and `StaticText`; nothing is lost by calling them `element`
 * and `text`, and a column of them costs a third as much.
 */
const TYPE_NAMES = [
  [/textfield|textview|searchfield|field/i, 'field'],
  [/button/i, 'button'],
  [/statictext|^text$/i, 'text'],
  [/cell|row/i, 'cell'],
  [/^link$/i, 'link'],
  [/switch|toggle/i, 'switch'],
  [/tab/i, 'tab'],
  [/image|icon/i, 'image'],
  [/generic|other|group|^any$/i, 'element'],
];

function shortType(type) {
  const t = String(type ?? '').trim();
  if (!t) return '?';
  for (const [pattern, name] of TYPE_NAMES) if (pattern.test(t)) return name;
  return t.slice(0, 9).toLowerCase();
}

/**
 * The whole map as text.
 *
 * One read of the screen produces the identity, the elements and the verdict,
 * so this is the same cost as the `screenIdentity` call an action already makes
 * to verify itself.
 */
export async function screenMap(deviceQuery, {
  options,
  filter,
  interactive,
  all = false,
  limit = DEFAULT_LIMIT,
  refresh = false,
  identity: given,
} = {}) {
  // `refresh` rebuilds this screen's map; it does not wipe the device's memory.
  // Forgetting everything to re-read one screen would throw away every other
  // screen's muscle memory to answer a question about this one.
  const identity = given ?? await api.screenIdentity(deviceQuery, { options, confirmNovel: false, fresh: refresh });
  const { device } = await api.ensureDaemon(deviceQuery, options);
  const udid = device.udid;
  const entry = identity.entry;
  const screen = identity.points;

  const { rows, truncated, collapsed } = rowsFor(entry, { screen, filter, interactive, all, limit });
  writeRefs(udid, { structuralHash: identity.hash, layoutHash: identity.layoutHash, rows });

  const found = identity.hash ? graph.nearestScreen(udid, identity) : null;
  const node = found?.node ?? null;
  const name = node ? graph.describe(node) : null;
  // Not a visit count — nothing stores one. The number of edges out of this
  // screen is what the agent can actually use: it says how much of this screen
  // the graph can navigate from without being told.
  const exits = node ? node.edges.length : null;

  return {
    device,
    identity,
    rows,
    truncated,
    collapsed,
    screen,
    name,
    exits,
    text: render({ device, identity, rows, truncated, collapsed, screen, name, exits }),
  };
}

export function render({ device, identity, rows, truncated, collapsed, screen, name, exits, verdictLine, ambiguities }) {
  const head = [
    device?.name,
    screen?.width ? `${screen.width}x${screen.height}pt` : null,
    identity?.hash
      ? `screen ${identity.hash.slice(0, 8)}${name ? ` "${name}"` : ''}` +
        (exits == null ? ' (new to simframe)' : ` (known, ${exits} known exit${exits === 1 ? '' : 's'})`)
      : 'screen unidentified',
    identity?.keyboard ? 'keyboard up' : null,
    identity?.settled === false ? 'STILL MOVING' : null,
    recalledNote(identity),
  ].filter(Boolean).join(' · ');

  const lines = [head];
  if (verdictLine) lines.push(verdictLine);

  let region = null;
  for (const r of rows) {
    if (r.region !== region) {
      region = r.region;
      lines.push(`${region}:`);
    }
    lines.push(renderRow(r));
  }
  for (const [name_, count] of collapsed ?? []) lines.push(`${name_}: ${count} keys (tap by label or type directly)`);
  if (!rows.length) lines.push('no elements read on this screen — try sim_look, or the app may still be drawing');
  if (truncated) lines.push(`... ${truncated} more; pass filter to narrow`);
  if (ambiguities?.length) {
    for (const a of ambiguities) lines.push(`ambiguous "${a.query}": ${a.options.join(', ')}`);
  }
  return lines.join('\n');
}
