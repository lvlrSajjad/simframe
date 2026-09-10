// Where on the screen something is, in the terms iOS itself uses.
//
// A label alone is ambiguous — "Assets" is both a screen title and a tab — but
// a label plus a region rarely is. And the region matters more than it looks:
// chrome labels are the only text that enters a screen's structural
// fingerprint, so anything misfiled as chrome lands directly in that screen's
// identity.
//
// This used to be fractions of screen height, and it cost three bugs in three
// phases: a nav button read as a title, an identity containing "sep 08, 2026"
// that would have expired at midnight, and a springboard whose identity was the
// name of the city in its weather widget. Each was patched with another rule.
//
// The bands are now derived from where the elements themselves sit, because the
// thing that actually distinguishes chrome from content is not height on the
// screen — it is separation. A nav bar sits above a gap; a tab bar sits below
// one; and a springboard, whose icon rows are evenly spaced from top to bottom,
// has neither and should be told it has neither.
export const REGIONS = [
  'status-bar',
  'nav-bar',
  'tab-bar',
  'keyboard',
  'content',
];

/**
 * The status bar stays positional, and deliberately.
 *
 * It is a device inset — the notch or dynamic island — not app layout, so its
 * position is a property of the hardware rather than of the screen. It has
 * never been the source of a misclassification, and clustering it would mean
 * inferring a constant from noise.
 */
const STATUS_BAR_FRACTION = 0.065;

/** Keyboards occupy the bottom of the screen and are unusually tall. */
const KEYBOARD_MIN_FRACTION = 0.28;
/** Most of a keyboard is keys. Below this it is a list that happens to be small. */
const KEYBOARD_MIN_KEYISH = 0.6;

/** Chrome is short. A 90pt list cell is not a tab item however low it sits. */
const CHROME_MAX_HEIGHT_FRACTION = 0.075;

/**
 * How far into the screen chrome may reach.
 *
 * Not the decision — the gap is the decision — but a precondition, because a
 * gap in the middle of a screen separates two pieces of content and nothing
 * else. Generous on both ends so that a tall nav bar with a search field in it,
 * or a tab bar above a home indicator, still qualifies.
 */
const TOP_CHROME_LIMIT = 0.28;
const BOTTOM_CHROME_LIMIT = 0.82;

/**
 * What makes a gap a boundary rather than spacing.
 *
 * Both conditions, because either alone is wrong. An absolute floor, since two
 * rows 4pt apart are one visual group whatever the rest of the screen does; and
 * a multiple of the screen's own median row gap, since 16pt is a boundary on a
 * dense list and ordinary spacing on a sparse one. This is the whole idea: the
 * screen sets its own scale.
 */
const MIN_BOUNDARY_GAP_PT = 10;
const BOUNDARY_GAP_FACTOR = 1.9;

/** A tab bar is several things spread across the width, not one thing at the bottom. */
const TAB_BAR_MIN_ITEMS = 2;
const TAB_BAR_MIN_SPREAD = 0.4;

/** Below this many elements there is no distribution to cluster; fall back. */
const MIN_ELEMENTS_TO_CLUSTER = 6;

/**
 * Fractions of screen height, used only when clustering has nothing to work
 * with. These are the old rules, kept because a screen with four elements on it
 * still needs an answer and the HIG is a better guess than none.
 */
const FALLBACK = { navBar: 0.14, tabBar: 0.86 };

const heightOf = (frame) => frame?.height ?? 0;
const midY = (frame) => frame.y + heightOf(frame) / 2;

/** Group elements into horizontal rows: a sweep down the screen, joining anything that overlaps. */
export function rowsOf(elements) {
  const items = elements
    .filter((e) => e.frame && Number.isFinite(e.frame.y))
    .map((e) => ({ e, top: e.frame.y, bottom: e.frame.y + heightOf(e.frame) }))
    .sort((a, b) => midY(a.e.frame) - midY(b.e.frame));
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    // Overlapping vertically means side by side, which means one row.
    if (row && it.top < row.bottom) {
      row.items.push(it.e);
      row.top = Math.min(row.top, it.top);
      row.bottom = Math.max(row.bottom, it.bottom);
    } else {
      rows.push({ items: [it.e], top: it.top, bottom: it.bottom });
    }
  }
  return rows;
}

function medianOf(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  return v[v.length >> 1];
}

/**
 * The horizontal reach of a row, as a fraction of screen width.
 *
 * A tab bar spans the screen; a single centred label does not. Measured between
 * the outermost centres rather than the outermost edges, so one wide element
 * cannot fake a spread on its own.
 */
function spreadOf(row, screen) {
  if (!screen?.width || row.items.length < 2) return 0;
  const centres = row.items.map((e) => e.frame.x + (e.frame.width ?? 0) / 2);
  return (Math.max(...centres) - Math.min(...centres)) / screen.width;
}

const allShort = (row, screen) =>
  row.items.every((e) => heightOf(e.frame) <= screen.height * CHROME_MAX_HEIGHT_FRACTION);

/**
 * Where this screen's bands actually are.
 *
 * Returns boundaries in points, so `regionFor` stays a cheap comparison and the
 * clustering is paid for once per screen rather than once per element.
 */
export function bands(elements, screen) {
  const keyboardTop = detectKeyboardTop(elements, screen);
  const statusBarBottom = screen?.height ? screen.height * STATUS_BAR_FRACTION : 0;
  if (!screen?.width || !screen?.height) {
    return { statusBarBottom: 0, navBarBottom: 0, tabBarTop: Infinity, keyboardTop, clustered: false };
  }

  // Everything the bands are inferred from: on-screen, below the status bar,
  // and above the keyboard if one is up. The status bar is a clock and a battery
  // icon, and letting them vote on where the nav bar ends is how a nav bar came
  // to include the clock.
  const considered = elements.filter((e) => {
    if (!e.frame || !Number.isFinite(e.frame.y)) return false;
    if (e.frame.y + heightOf(e.frame) <= statusBarBottom) return false;
    if (keyboardTop != null && e.frame.y >= keyboardTop) return false;
    return e.frame.y < screen.height && e.frame.y + heightOf(e.frame) > 0;
  });

  const rows = rowsOf(considered);
  if (rows.length < 3 || considered.length < MIN_ELEMENTS_TO_CLUSTER) {
    return {
      statusBarBottom,
      navBarBottom: screen.height * FALLBACK.navBar,
      tabBarTop: screen.height * FALLBACK.tabBar,
      keyboardTop,
      clustered: false,
    };
  }

  const gaps = rows.slice(1).map((row, i) => row.top - rows[i].bottom);
  const typical = medianOf(gaps.filter((g) => g > 0));
  const isBoundary = (gap) => gap >= Math.max(MIN_BOUNDARY_GAP_PT, typical * BOUNDARY_GAP_FACTOR);

  // --- top chrome. Up to two rows, because a nav bar can be a title above a
  // search field, and no more, because three rows of anything is content.
  let navBarBottom = 0;
  for (let i = 0; i < Math.min(2, rows.length - 1); i += 1) {
    const gap = rows[i + 1].top - rows[i].bottom;
    const withinReach = rows[i].bottom <= screen.height * TOP_CHROME_LIMIT;
    if (!withinReach) break;
    if (isBoundary(gap) && rows.slice(0, i + 1).every((r) => allShort(r, screen))) {
      navBarBottom = rows[i].bottom;
      break;
    }
  }

  // --- bottom chrome. One row: a tab bar is one row by construction, and the
  // gap above it is what separates it from the list it floats over.
  let tabBarTop = Infinity;
  const last = rows[rows.length - 1];
  const gapAbove = last.top - rows[rows.length - 2].bottom;
  if (
    last.top >= screen.height * BOTTOM_CHROME_LIMIT
    && allShort(last, screen)
    && last.items.length >= TAB_BAR_MIN_ITEMS
    && spreadOf(last, screen) >= TAB_BAR_MIN_SPREAD
    && isBoundary(gapAbove)
  ) {
    tabBarTop = last.top;
  }

  return { statusBarBottom, navBarBottom, tabBarTop, keyboardTop, clustered: true, typicalGap: typical };
}

/**
 * Which band this frame falls in.
 *
 * `band` comes from `bands()`. Passing only `{keyboardTop}` still works and
 * falls back to the HIG fractions, which is what callers that have one element
 * and no screen context get.
 */
export function regionFor(frame, screen, band = {}) {
  if (!frame || !screen?.height) return 'content';
  const { keyboardTop } = band;
  if (keyboardTop != null && frame.y >= keyboardTop) return 'keyboard';

  const top = frame.y;
  const bottom = frame.y + heightOf(frame);
  const statusBarBottom = band.statusBarBottom ?? screen.height * STATUS_BAR_FRACTION;
  if (bottom <= statusBarBottom) return 'status-bar';

  const short = heightOf(frame) <= screen.height * CHROME_MAX_HEIGHT_FRACTION;
  const navBarBottom = band.navBarBottom ?? screen.height * FALLBACK.navBar;
  const tabBarTop = band.tabBarTop ?? screen.height * FALLBACK.tabBar;
  // A screen with no top chrome has navBarBottom 0, so nothing is a nav bar —
  // which is the correct answer for a springboard, and the answer the old
  // positional rule could not give.
  if (short && navBarBottom > 0 && bottom <= navBarBottom + 1) return 'nav-bar';
  if (short && top >= tabBarTop - 1) return 'tab-bar';
  return 'content';
}

/**
 * Where a nav-bar control sits across the bar: leading, title or trailing.
 * A back button is leading; an edit or done button is trailing. Callers use it
 * to disambiguate two controls that share a label.
 */
export function navSlot(frame, screen) {
  if (!frame || !screen?.width) return null;
  const centre = frame.x + (frame.width ?? 0) / 2;
  const third = screen.width / 3;
  if (centre < third) return 'leading';
  if (centre > third * 2) return 'trailing';
  return 'title';
}

/**
 * The top of the keyboard, if one appears to be up.
 *
 * Inferred from a dense band of similar-height elements filling the bottom of
 * the screen — keys. Returns null when nothing looks like one, which is the
 * common case and must stay cheap. This was the first band derived from the
 * elements rather than from a fraction, and it is the model the rest now follow.
 */
/**
 * Whether an element is shaped like a key rather than like content.
 *
 * The canonical version of this test, because two places need it and getting
 * them out of step is what produced the bug below. A key is finger-sized and
 * says almost nothing: a single character, a short named key, or nothing at
 * all. A row of content is wider, or carries words.
 */
export const KEY_MAX_WIDTH = 120;

const NAMED_KEY = /^(space|return|enter|shift|delete|backspace|done|globe|dictate|emoji|caps ?lock|number|numbers|symbols|letters|more|search|go|send|join|route|abc|123)$/i;

export function looksLikeKey(t) {
  if (/^key$/i.test(String(t?.type ?? ''))) return true;
  const width = t?.frame?.width;
  if (Number.isFinite(width) && width > KEY_MAX_WIDTH) return false;
  const label = String(t?.label ?? '').trim();
  if (!label) return true;
  if (label.length <= 2) return true;
  return NAMED_KEY.test(label);
}

/**
 * Where the software keyboard starts, or null.
 *
 * Size and uniformity alone were not enough, and the failure was expensive. A
 * read-only summary screen stacks a dozen short text rows of near-identical
 * height in the bottom half — which satisfied every test here, so a keyboard
 * was detected on a screen that had none.
 *
 * That mattered far beyond a mislabelled band, because `fingerprint.tokens`
 * discards everything below `keyboardTop`. A phantom keyboard therefore
 * deleted the screen's entire content from its own identity, leaving only
 * chrome — so a wizard's form step and its read-only review screen, which
 * share a nav title and a step indicator, **collapsed onto one hash**. From
 * there: the graph offered one screen's remembered controls on the other (three
 * absent controls, one of them beside a button that submits for real), and
 * `locate` resolved against the wrong screen's stored element list, which is
 * why `assert` insisted a string was absent while the map printed it four lines
 * below. One phantom, three findings.
 *
 * So the test is now what a keyboard actually is: keys. A dozen small uniform
 * boxes are a keyboard only if most of them are key-shaped.
 */
export function detectKeyboardTop(elements, screen) {
  if (!screen?.height || elements.length < 12) return null;
  const threshold = screen.height * (1 - KEYBOARD_MIN_FRACTION);
  const low = elements.filter((e) => e.frame && e.frame.y > threshold);
  if (low.length < 12) return null;
  const heights = low.map((e) => heightOf(e.frame)).sort((a, b) => a - b);
  const median = heights[heights.length >> 1];
  // Keys are small and uniform; a list of cells down there is not.
  const uniform = heights.filter((h) => Math.abs(h - median) <= Math.max(3, median * 0.4)).length;
  if (uniform / low.length < 0.7 || median > screen.height * 0.07) return null;
  // And they are keys. Uniformity says "a grid of something"; this says of what.
  const keyish = low.filter(looksLikeKey).length;
  if (keyish / low.length < KEYBOARD_MIN_KEYISH) return null;
  return Math.min(...low.map((e) => e.frame.y));
}

/**
 * Is this element outside the viewport?
 *
 * **Both axes.** Every filter in this project checked `y` and ignored `x`,
 * which is fine until a horizontal row: a filter chip reported at **x=422 on a
 * 402pt-wide screen** counted as visible, and `scroll_to` then said *"'Assigned
 * to Me' is in view at 422,277 already"* — confidently wrong about the one thing
 * it exists to answer. Off-screen chips came back at **x=-247** the same way.
 *
 * Reported as the most expensive finding of an agent's session, and the cost was
 * not the wrong answer itself: it was that the wrong answer was *confident*, so
 * the recovery was hand-tuned swipes and two overshoots.
 */
export function offViewport(t, screen) {
  if (!t) return false;
  const w = screen?.width;
  const h = screen?.height;
  if (Number.isFinite(h) && (t.y < 0 || t.y > h)) return true;
  if (Number.isFinite(w) && (t.x < 0 || t.x > w)) return true;
  return false;
}

/** Annotate a target list with region and nav slot. Mutates and returns it. */
export function annotate(targets, screen) {
  const band = bands(targets, screen);
  for (const t of targets) {
    t.region = regionFor(t.frame, screen, band);
    if (t.region === 'nav-bar') t.navSlot = navSlot(t.frame, screen);
  }
  return targets;
}
