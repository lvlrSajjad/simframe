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
import * as regions from './regions.js';
import * as wrote from './wrote.js';
import * as graph from './graph.js';
import { writeRefs } from './refs.js';
import * as matching from './matching.js';

/** Reading order. Chrome frames the screen, so it reads first and last. */
const REGION_ORDER = ['nav-bar', 'content', 'tab-bar', 'keyboard', 'status-bar'];

/**
 * Which regions the map will not offer now lives in `regions.js`, because it is
 * not only a presentation rule — see `regions.offerable`. A target this hides
 * must also be one nothing resolves onto behind the caller's back.
 */

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

/**
 * Why no row is dropped for being long — reverted 2026-09-10, same day.
 *
 * There was a rule here that dropped non-interactive rows whose label ran past
 * 45 characters, on the evidence that four of sixteen rows on a Settings screen
 * were the explanatory paragraph under each switch: 31% of that map's
 * characters describing things nobody can tap. Across fourteen recorded screens
 * it cut the map 15%.
 *
 * It was wrong, and the counter-example is decisive. A React Native list card
 * exposes all of its children as one concatenated accessibility label —
 * `Anaheim | Store # 1020, , 1234 Main St, … | Quick Casual Restaurant`, 105
 * characters, type `GenericElement`, region `content`. Every property my rule
 * tested is identical to the Settings caption's, and that card is *the only
 * tappable thing on the screen*.
 *
 * Nothing became untappable — `locate`, `assert` and `waitFor` read
 * `entry.targets`, so the rows are a view and the data survived. What was lost
 * is **discovery**: the map stopped saying what was on screen, so an agent
 * could only tap labels it already knew, and the fallback on a screen of
 * unknown data is a ~1600-token screenshot. It saved characters on
 * settings-shaped screens and spent an image on list-shaped ones, which is the
 * exact cost the phase existed to remove. Blast radius: every data list in
 * every RN app.
 *
 * The lesson is not "find a better discriminator". It is that this was a
 * threshold shipped with no harness case that could catch its failure, in the
 * same session as building the harness. So `expect.discoverable` now exists,
 * and there is a fixture of the reported shape — a rule like this may return
 * only when it can be gated.
 *
 * What survives is what the reporter suggested instead: truncate, do not drop.
 * Position and tappability are the valuable parts of a row, not the full text.
 * See `MAX_LABEL`.
 */

/**
 * Whether a target in the keyboard band really is a key.
 *
 * Region bands are positional, and this was the fourth and fifth bug they
 * produced. With the keyboard up, the bottom band is collapsed to one line —
 * thirty keys nobody names — and a primary action pinned above the keyboard was
 * collapsed with them: four reads running printed `keyboard: 6 keys` and **no
 * forward control**, while the hint said "nothing ambiguous — chain the next
 * steps without looking again". That it was an emission bug and not a
 * perception one was proved by the next call, which hit the button instantly at
 * a coordinate the map had never printed.
 *
 * Delegates to `regions.looksLikeKey`, which is the canonical test. These two
 * having separate copies is what let a phantom keyboard survive in the
 * fingerprint after it had already been fixed in the map — and there it was
 * deleting screens' content from their own identity.
 */
export const isKey = regions.looksLikeKey;

/**
 * Whether a target can be acted on, by role *or* by evidence.
 *
 * The role alone was wrong twice on real forms. A React Native composite select
 * surfaces as a generic element, and a text input shows only its placeholder as
 * `StaticText` — so `--interactive` answered "1 element" on a form with two
 * visible, bordered, *required* inputs and an agent concluded there was nothing
 * to fill in.
 *
 * Evidence is used rather than a longer list of role names, because the roles
 * are what the tree got wrong. Only a control carries a `value`, only a
 * focusable thing is `focused`, and `enabled` is a state a caption never
 * declares. A generic element that is none of those really is a container.
 *
 * The case this still cannot see: an empty, unfocused input whose placeholder is
 * its only text. Nothing in the tree distinguishes it from a caption, which is
 * why a filtered view now says it is filtered rather than implying it is the
 * whole screen.
 */
export function actsInteractive(t) {
  if (INTERACTIVE.test(t?.type || '')) return true;
  if (t?.value != null && t.value !== '') return true;
  if (t?.focused) return true;
  if (t?.enabled === false) return true;
  return false;
}

export function rowsFor(entry, { screen, filter, interactive, all = false, limit = DEFAULT_LIMIT } = {}) {
  let kept = (entry?.targets ?? []).map((t) => ({ ...t })).filter((t) => {
    if (!isNum(t.x) || !isNum(t.y)) return false;
    // Off-screen elements are real in the tree and untappable in fact.
    if (regions.offViewport(t, screen)) return false;
    if (!all && !regions.offerable(t.region)) return false;
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
  if (interactive) kept = kept.filter(actsInteractive);

  const order = (t) => {
    const i = REGION_ORDER.indexOf(t.region ?? 'content');
    return i === -1 ? REGION_ORDER.indexOf('content') : i;
  };
  kept.sort((a, b) => order(a) - order(b) || a.y - b.y || a.x - b.x);

  // A band is only the keyboard if there is a keyboard in it.
  //
  // Region bands are positional, so on a screen with no keyboard at all the
  // bottom band was still called `keyboard` and review-summary rows were filed
  // under it, followed by `keyboard: 1 keys (tap by label or type directly)` —
  // advice that is actively wrong about page content. Reported as noise on
  // every map of two screens. Relabelled from the contents rather than the
  // position, which is the only evidence available here.
  const keysPresent = kept.some((t) => COLLAPSE_REGIONS.has(t.region ?? '') && isKey(t));
  const bandOf = (t) => {
    const region = t.region ?? 'content';
    return COLLAPSE_REGIONS.has(region) && !keysPresent ? 'content' : region;
  };

  const rows = [];
  const collapsed = new Map();
  for (const t of kept) {
    const region = bandOf(t);
    if (COLLAPSE_REGIONS.has(region) && isKey(t)) {
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
  // Not just how many — which. The graph has always known what worked here and
  // only ever reported a count, so an agent on a screen simframe had driven ten
  // times still read it to learn what was tappable.
  const remembered = node ? graph.exitsOf(node) : [];
  // Memory intersected with what is actually here, never memory alone.
  //
  // This is the correction to the feature above, and it was reported with the
  // consequence spelled out. A wizard's read-only *review* screen had been given
  // the same identity as its step 1, so it inherited step 1's entire vocabulary:
  // the map offered `tap "APPLY"`, `tap "No Power"`, `tap "PLACE A SERVICE
  // REQUEST"` — **not one of which exists on it** — while the hint said "nothing
  // ambiguous, chain the next steps without looking again". The only control on
  // that screen files a real work order. Confident advice pointed at a
  // destructive button on a screen it had misidentified.
  //
  // The line was right and the identity was wrong, so the line now checks. A
  // remembered action is only offered when its label is on the screen in front
  // of us; the rest are counted and reported as a disagreement, because memory
  // that does not match what is here is itself the most useful thing to say.
  const { exitList, stale: staleExits } = presentOnly(remembered, rows);
  // Values simframe wrote itself and can no longer see. Computed from the same
  // rows the map is about to print, so it costs nothing, and it is the only
  // thing that can notice a form being cleared underneath a caller — six `ok`
  // calls in a row hid exactly that.
  const cleared = wrote.missingLine(wrote.missing(device?.udid, rows));
  // One layer covering another, detected where it shows: an ax element and an
  // OCR word at one coordinate disagreeing about what is there. Reported by a
  // peer who had to fall back to a screenshot to count five radio options
  // through a sheet, which is the case the text map exists to remove.
  const layered = (identity?.entry?.occluded ?? []).length;
  const overlay = layered
    ? `${layered} element(s) on this screen overlap and disagree about what is there`
      + ' — a sheet or overlay is probably covering the screen behind it, so treat anything'
      + ' you did not expect to see as belonging to the layer underneath'
    : null;

  return {
    device,
    identity,
    rows,
    truncated,
    collapsed,
    // A filtered view is not the screen, and the hint used to report its count
    // as though it were: `--interactive` on a form said "1 element; nothing
    // ambiguous — chain the next steps" while two required inputs sat unseen
    // below it. The over-claim was the harmful half, not the filter.
    filtered: Boolean(filter || interactive),
    screen,
    name,
    exits,
    exitList,
    staleExits,
    cleared,
    overlay,
    text: render({ device, identity, rows, truncated, collapsed, screen, name, exits, exitList, staleExits, cleared, overlay }),
  };
}

/**
 * One line saying whether the model needs to stop and think.
 *
 * The measured loop in a real session is observe → think → tap → observe →
 * think, and the thinking dominates wall time. Phases 11–16 reduce how *often*
 * a decision has to reach the model; this reduces how often the model *believes*
 * it has to decide. Measured: 48 of 62 real calls were three steps or fewer, so
 * a twelve-step flow arrived as four or five calls and every boundary was a
 * think — not because anything was ambiguous, but because nothing said it was
 * not.
 *
 * Everything here is already in hand when the result is assembled: whether the
 * flow stopped, whether the screen settled, whether the graph recognises it,
 * how many elements there are, and whether any two of them answer to the same
 * label. No perception pass, no model call, no new state.
 *
 * The order is deliberate. It reports the *strongest reason to think* first,
 * and only says "keep going" when it can rule all of them out — a hint that
 * cheerfully says "carry on" into an unknown screen would be worse than no hint
 * at all.
 */
export function nextHint({ ok, escalated, settled, loading, known, hash, exits, elements, ambiguous, filtered, exitList, staleExits } = {}) {
  if (ok === false) {
    return 'next: the flow stopped here — this is the moment to think. sim_recall shows how you got here; sim_ui re-reads the screen.';
  }
  // A stopped flow and a completed flow carrying a soft verdict are different
  // things, and conflating them printed `flow completed — 16/16 steps` directly
  // above `next: the flow stopped here` on a run where nothing stopped.
  //
  // The conflation was load-bearing, not cosmetic. `no-visible-change` is an
  // escalating verdict and it fires falsely — reported three rounds running —
  // so **one** wrong verdict anywhere in a clean flow told the agent to abandon
  // batching and re-read. That is the exact failure this hint exists to
  // prevent, caused by the hint.
  //
  // A completed flow with an unconfirmed step is worth one targeted look, not a
  // re-plan, so the hint says which and keeps the horizon open.
  if (escalated) {
    return 'next: every step ran, but at least one could not be confirmed — check that one thing landed (re-read the field, or assert it) rather than re-planning the flow.';
  }
  // A screen awaiting a network call is *settled* — nothing is moving — and
  // incomplete. Reported: a settle returned satisfied while a list was still
  // loading, the map showed an empty content region, and an empty region and a
  // still-loading one produced identical output. A person sees a spinner.
  if (loading) {
    return 'next: settled, but the transition classifier still sees loading — an empty-looking region may be a list that has not arrived. waitFor a string you expect rather than acting on this.';
  }
  if (settled === false) {
    return 'next: the screen is still moving. sim_state polls it for a fraction of a map; do not act on this reading yet.';
  }
  if (known === false) {
    return 'next: new screen, nothing predicted here yet — read it before acting on a label you have not seen on it.';
  }
  if (ambiguous > 0) {
    return ambiguous === 1
      ? 'next: one label repeats on this screen — address that one by #ref, and the rest can go in one sim_do.'
      : `next: ${ambiguous} labels repeat on this screen — address those by #ref, and the rest can go in one sim_do.`;
  }
  const known_ = hash ? `known (${hash.slice(0, 8)}${exits ? `, ${exits} known exit${exits === 1 ? '' : 's'}` : ''})` : 'known';
  if (filtered) {
    // The count belongs to the filter, not to the screen. An agent that reads
    // it as the screen concludes a form has nothing to fill in.
    return `next: settled; screen ${known_}; ${elements} element${elements === 1 ? '' : 's'} **matching your filter** — this is not the whole screen, and an empty text input can look like a caption. Read it unfiltered before concluding something is absent.`;
  }
  // Memory that contradicts the screen outranks "carry on", because the reason
  // it contradicts is usually that this screen has been confused with another —
  // and a confident "chain without looking again" on a misidentified screen is
  // how remembered advice ends up pointing at a control that files a work order.
  const offerable = (exitList ?? []).filter((e) => e.label);
  if (!offerable.length && staleExits) {
    return `next: this screen is recognised but ${staleExits} remembered control${staleExits === 1 ? ' is' : 's are'} not on it,`
      + ' so the identity is probably wrong — two screens sharing one hash. Act only on the element list, and re-read before anything irreversible.';
  }
  // Naming the vocabulary is what makes "chain" actionable. A hint that says
  // "chain the next steps" without saying what the steps could be is asking the
  // agent to plan from a map it has to keep re-reading.
  const vocab = offerable.slice(0, 6)
    .map((e) => `${e.action} ${JSON.stringify(String(e.label).slice(0, 28))}`).join(', ');
  return `next: settled; screen ${known_}; ${elements} element${elements === 1 ? '' : 's'}; nothing ambiguous — chain the next steps in one sim_do without looking again.`
    + (vocab ? ` Known to work here: ${vocab}.` : '')
    + (staleExits ? ` (${staleExits} other remembered control${staleExits === 1 ? '' : 's'} not on this screen — the graph may be conflating it with another.)` : '');
}

/**
 * The hint for a rendered map, from the map itself.
 *
 * Lives here rather than in the MCP server because it was only reachable from
 * there, and the MCP server is a long-lived process: a session that started
 * before a change is running the old code, so the headline change of a phase
 * could not be exercised at all. Reported, correctly, as the first finding
 * against Phase 11.5. In `view.js` both front ends share one implementation and
 * a unit test can reach it.
 */
export function hintFor(map, { flowOk = true, escalated = false } = {}) {
  return nextHint({
    ok: flowOk !== false,
    escalated: Boolean(escalated),
    filtered: map?.filtered === true,
    settled: map?.identity?.settled !== false,
    loading: map?.identity?.loading === true,
    known: map?.exits != null,
    hash: map?.identity?.hash ?? null,
    exits: map?.exits ?? 0,
    exitList: map?.exitList ?? [],
    staleExits: map?.staleExits ?? 0,
    elements: map?.rows?.length ?? 0,
    ambiguous: ambiguousLabels(map?.rows),
  });
}

/**
 * Keep only the remembered actions whose control is actually on this screen.
 *
 * @returns {{exitList: Array, stale: number}} what can be offered, and how many
 *   remembered actions found nothing here — which is evidence the screen has
 *   been misidentified, and worth saying out loud.
 */
export function presentOnly(remembered, rows) {
  const here = new Set();
  for (const r of rows ?? []) {
    for (const name of [r.label, ...(r.aliases ?? [])]) {
      const k = alnum(name);
      if (k) here.add(k);
    }
  }
  const has = (label) => {
    const k = alnum(label);
    if (!k) return false;
    if (here.has(k)) return true;
    // A row may carry the label inside a longer one — a list card concatenates
    // its children, and truncation adds an ellipsis.
    for (const seen of here) if (seen.includes(k) || k.includes(seen)) return true;
    return false;
  };
  const exitList = (remembered ?? []).filter((e) => has(e.label));
  return { exitList, stale: (remembered ?? []).length - exitList.length };
}

/**
 * What has worked from this screen before, printed rather than counted.
 *
 * The map said `(known, 3 known exits)` and stopped there, so the graph's own
 * vocabulary never reached the caller. A flow whose labels were known in
 * advance ran 16 steps in one call; the same agent on screens the graph also
 * knew, but whose labels it had to rediscover, spent 25 calls on 31 steps.
 *
 * Deliberately terse and deliberately *not* a promise. These are actions that
 * previously worked here, with how often — evidence for a plan, not a
 * guarantee, and the destructive-label rules apply to them exactly as before.
 */
export function exitsLine(exitList, { limit = 6, stale = 0 } = {}) {
  const list = (exitList ?? []).filter((e) => e.label).slice(0, limit);
  if (!list.length) {
    // Everything remembered here is missing. That is not "no memory" — it is
    // memory that contradicts the screen, which usually means two screens have
    // collapsed into one identity, and it is the most useful thing to say.
    return stale
      ? `memory disagrees with this screen: ${stale} remembered control${stale === 1 ? '' : 's'} not present`
      + ' — this screen has probably been confused with another. Trust the element list, not the graph.'
      : null;
  }
  const parts = list.map((e) => {
    const label = String(e.label).length > 28 ? `${String(e.label).slice(0, 28)}…` : String(e.label);
    return `${e.action} ${JSON.stringify(label)}${e.count > 1 ? ` (${e.count}x)` : ''}`;
  });
  return `worked here before: ${parts.join(', ')}`;
}

/** How many labels are worn by more than one element a caller could act on. */
export function ambiguousLabels(rows) {
  const seen = new Map();
  for (const r of rows ?? []) {
    const key = alnum(r.label);
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].filter((n) => n > 1).length;
}

export function render({ device, identity, rows, truncated, collapsed, screen, name, exits, exitList, staleExits, verdictLine, ambiguities, cleared, overlay }) {
  const head = [
    device?.name,
    screen?.width ? `${screen.width}x${screen.height}pt` : null,
    identity?.hash
      ? `screen ${identity.hash.slice(0, 8)}${name ? ` "${name}"` : ''}` +
        (exits == null ? ' (new to simframe)' : ` (known, ${exits} known exit${exits === 1 ? '' : 's'})`)
      : 'screen unidentified',
    identity?.keyboard ? 'keyboard up' : null,
    identity?.settled === false ? 'STILL MOVING' : null,
    // Still and finished are not the same thing.
    identity?.loading === true ? 'STILL LOADING' : null,
    recalledNote(identity),
  ].filter(Boolean).join(' · ');

  const lines = [head];
  if (verdictLine) lines.push(verdictLine);
  // Above the element list, not below it: it contradicts something the caller
  // already believes, which is the one kind of news that must not be scrolled to.
  if (cleared) lines.push(cleared);
  if (overlay) lines.push(overlay);
  const worked = exitsLine(exitList, { stale: staleExits });
  if (worked) lines.push(worked);

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
