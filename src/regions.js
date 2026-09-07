// Where on the screen something is, in the terms iOS itself uses.
//
// A label alone is ambiguous — "Assets" is both a screen title and a tab — but
// a label plus a region rarely is. These are geometric priors from the Human
// Interface Guidelines rather than anything read from the app, so they are
// cheap, always available, and occasionally wrong in the same ways the
// guidelines are.
export const REGIONS = [
  'status-bar',
  'nav-bar',
  'tab-bar',
  'keyboard',
  'content',
];

/**
 * Fractions of screen height. Deliberately conservative: a band that is too
 * greedy mislabels content as chrome, and content is the common case.
 */
const BANDS = {
  statusBar: 0.065,   // through the notch / dynamic island
  navBar: 0.14,       // title and its leading/trailing controls
  tabBar: 0.92,       // home indicator sits below this
};

/** Keyboards occupy the bottom of the screen and are unusually tall. */
const KEYBOARD_MIN_FRACTION = 0.28;

/**
 * Chrome is short. Position alone is not enough: the last row of a long list
 * reaches into the tab-bar band, and calling a 90pt cell a tab item makes a
 * seven-row list a different screen from a three-row one.
 */
const CHROME_MAX_HEIGHT_FRACTION = 0.075;

export function regionFor(frame, screen, { keyboardTop } = {}) {
  if (!frame || !screen?.height) return 'content';
  const top = frame.y / screen.height;
  const bottom = (frame.y + (frame.height ?? 0)) / screen.height;
  if (keyboardTop != null && frame.y >= keyboardTop) return 'keyboard';
  const short = (frame.height ?? 0) <= screen.height * CHROME_MAX_HEIGHT_FRACTION;
  if (bottom <= BANDS.statusBar) return 'status-bar';
  if (short && top < BANDS.navBar && bottom < BANDS.navBar * 1.6) return 'nav-bar';
  if (short && top >= BANDS.tabBar - 0.06) return 'tab-bar';
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
 * common case and must stay cheap.
 */
export function detectKeyboardTop(elements, screen) {
  if (!screen?.height || elements.length < 12) return null;
  const threshold = screen.height * (1 - KEYBOARD_MIN_FRACTION);
  const low = elements.filter((e) => e.frame && e.frame.y > threshold);
  if (low.length < 12) return null;
  const heights = low.map((e) => e.frame.height ?? 0).sort((a, b) => a - b);
  const median = heights[heights.length >> 1];
  // Keys are small and uniform; a list of cells down there is not.
  const uniform = heights.filter((h) => Math.abs(h - median) <= Math.max(3, median * 0.4)).length;
  if (uniform / low.length < 0.7 || median > screen.height * 0.07) return null;
  return Math.min(...low.map((e) => e.frame.y));
}

/** Annotate a target list with region and nav slot. Mutates and returns it. */
export function annotate(targets, screen) {
  const keyboardTop = detectKeyboardTop(targets, screen);
  for (const t of targets) {
    t.region = regionFor(t.frame, screen, { keyboardTop });
    if (t.region === 'nav-bar') t.navSlot = navSlot(t.frame, screen);
  }
  return targets;
}
