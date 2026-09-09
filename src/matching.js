// Resolving "what did they mean" against what is on screen.
//
// The rule throughout: never guess between two plausible answers. A wrong tap
// is worse than a question, because a wrong tap can do something and the caller
// will believe it did the right thing.

/** Names for controls that carry an icon and no readable label. */
const SYNONYMS = {
  back: ['back', 'chevron.left', 'navigate back', 'previous', 'return'],
  close: ['close', 'dismiss', 'xmark', 'cancel', 'done'],
  search: ['search', 'find', 'magnifyingglass'],
  add: ['add', 'new', 'create', 'plus', 'compose'],
  more: ['more', 'options', 'ellipsis', 'overflow', 'menu'],
  settings: ['settings', 'preferences', 'gear', 'configure'],
  share: ['share', 'export', 'send'],
  delete: ['delete', 'remove', 'trash', 'bin'],
  edit: ['edit', 'modify', 'change'],
  save: ['save', 'apply', 'confirm', 'ok', 'submit'],
};

/** Words that say what kind of control the caller means. */
const ROLE_HINTS = [
  { pattern: /\b(type|enter|fill|input)\b/i, roles: /field|textfield|textview|searchfield/i },
  { pattern: /\b(tap|press|click|hit)\b/i, roles: /button|link|cell|tab/i },
  { pattern: /\b(toggle|switch|enable|disable|turn)\b/i, roles: /switch|toggle|checkbox/i },
  { pattern: /\b(tab)\b/i, roles: /tab/i },
];

/** Words that say where on screen the caller means. */
const REGION_HINTS = [
  { pattern: /\btab\b/i, region: 'tab-bar' },
  { pattern: /\b(back|nav|title|toolbar)\b/i, region: 'nav-bar' },
];

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Levenshtein distance, capped: beyond the cap the exact value is irrelevant. */
export function editDistance(a, b, cap = 8) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length];
}

/** How well one name answers to a query, 0 to 1. */
export function nameScore(name, query) {
  const n = norm(name);
  const q = norm(query);
  if (!n || !q) return 0;
  if (n === q) return 1;
  if (n.startsWith(q) || q.startsWith(n)) return 0.86;
  // A substring match is only as good as the share of the name it covers.
  // Without this, "back" scores 0.78 against a two-hundred-character list row
  // that happens to contain "Back of House", and beats the actual back button.
  if (n.includes(q)) return 0.78 * Math.max(0.15, q.length / n.length);
  if (q.includes(n)) return 0.7 * Math.max(0.15, n.length / q.length);
  // Fuzzy, so a typo or a stray plural still resolves.
  //
  // editDistance returns cap+1 as a sentinel when it gives up early. Treating
  // that as a measurement made every long string score well: 1 - 9/200 is
  // 0.955, so a two-hundred-character list row scored 0.687 against any query
  // at all. A bail-out is "no answer", not "nearly identical".
  const cap = 8;
  const distance = editDistance(n, q, cap);
  if (distance > cap) return 0;
  const longest = Math.max(n.length, q.length);
  const similarity = 1 - distance / longest;
  return similarity >= 0.7 ? similarity * 0.72 : 0;
}

function synonymGroup(query) {
  const q = norm(query);
  for (const [key, words] of Object.entries(SYNONYMS)) {
    if (words.some((w) => w === q || q.includes(w))) return { key, words };
  }
  return null;
}

/**
 * Rank what is on screen against an intent.
 *
 * Returns candidates sorted best first, each with the reasons behind its score
 * so a caller — or a person reading a failure — can see why.
 */
export function rank(targets, intent, { screen } = {}) {
  // Never offer something that is not on screen. A scrolled-away row still sits
  // in the map with a negative y, and tapping it lands somewhere else entirely.
  const visible = screen?.width && screen?.height
    ? targets.filter((t) => {
        const f = t.frame;
        if (!f) return t.y >= 0 && t.y <= screen.height && t.x >= 0 && t.x <= screen.width;
        return f.y + (f.height ?? 0) > 0 && f.y < screen.height
          && f.x + (f.width ?? 0) > 0 && f.x < screen.width;
      })
    : targets;
  const group = synonymGroup(intent);
  const roleHint = ROLE_HINTS.find((h) => h.pattern.test(intent));
  const regionHint = REGION_HINTS.find((h) => h.pattern.test(intent));
  // Strip the verb: "tap the Save button" should match a control called "Save".
  const bare = norm(intent)
    .replace(/^(please\s+)?(tap|press|click|hit|type|enter|fill|open|select|choose|toggle|switch)\s+/i, '')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+(button|tab|field|cell|link|icon)$/i, '');

  const scored = [];
  for (const t of visible) {
    const names = [t.label, ...(t.aliases ?? [])].filter(Boolean);
    let base = 0;
    let matched = null;
    for (const name of names) {
      const s = Math.max(nameScore(name, intent), nameScore(name, bare));
      if (s > base) {
        base = s;
        matched = name;
      }
    }
    // An icon-only control has no readable name, so a synonym is the only way
    // to reach it — this is how "back" finds a bare chevron.
    if (group && base < 0.5 && !t.label && t.rawLabel) base = 0.55;
    if (group && base < 0.5 && names.some((n) => group.words.includes(norm(n)))) base = 0.9;
    if (base <= 0) continue;

    const reasons = [matched ? `label "${matched}"` : 'icon-only'];
    let score = base;
    if (roleHint && roleHint.roles.test(t.type ?? '')) {
      score += 0.12;
      reasons.push(`role ${t.type}`);
    }
    if (regionHint && t.region === regionHint.region) {
      score += 0.15;
      reasons.push(`region ${t.region}`);
    }
    // A caption is not a control. Prefer something tappable when the names tie.
    if (/button|link|cell|field|switch|tab/i.test(t.type ?? '')) {
      score += 0.05;
      reasons.push('interactive');
    }
    // Not capped here: clamping to 1 before comparing throws away exactly the
    // signal the bonuses exist to provide. Two elements sharing a label both
    // reach 1.0 on the name alone, and the region bonus that should separate
    // them disappears into the ceiling.
    scored.push({ target: t, score, reasons });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** How close two candidates may be before the answer counts as ambiguous. */
export const AMBIGUITY_MARGIN = 0.08;
/** Below this, no candidate is worth acting on. */
export const MINIMUM_SCORE = 0.45;

/**
 * How close two tap points have to be to mean the same control.
 *
 * Deliberately small. Two genuinely different controls are not twelve points
 * apart centre to centre on any screen iOS lays out; two *readings* of one
 * control are one or two points apart, because the accessibility tree and OCR
 * are describing the same rectangle. Measured on a real filter row: the tree
 * published "Location (All)" at (201,181) and OCR read "Location (AII)" at
 * (200,182), and the caller was asked which of the two it meant.
 */
export const SAME_CONTROL_POINTS = 12;

/**
 * Two candidates in the same place are one control read twice.
 *
 * Asking which one was meant is not caution here, it is a question with no
 * answer — either tap lands on the same pixel. So the readings are collapsed,
 * and the accessibility one wins, because it is the actual hit target and its
 * label has not been through OCR.
 */
const INTERACTIVE_ROLE = /button|field|cell|row|link|switch|slider|tab|menu|segment|checkbox/i;

/**
 * Is this target the accessibility tree's reading of a control?
 *
 * A merged target carries `ax|ocr`, because both sensors saw it. Every
 * comparison against the string `'ax'` had to become this: an element does not
 * stop being the tree's element because OCR agreed with it, and treating
 * `ax|ocr` as "not ax" would have quietly demoted exactly the elements the
 * merge is most confident about.
 */
export const isAxTarget = (t) => /(^|\|)ax(\||$)/.test(t?.source ?? '');

/** How much of `inner` lies inside `outer`, as a fraction of inner's own area. */
export function containedFraction(inner, outer) {
  if (!inner || !outer) return 0;
  const iw = Math.max(0, inner.width ?? 0);
  const ih = Math.max(0, inner.height ?? 0);
  const innerArea = iw * ih;
  if (innerArea <= 0) return 0;
  const x = Math.max(inner.x, outer.x);
  const y = Math.max(inner.y, outer.y);
  const right = Math.min(inner.x + iw, outer.x + (outer.width ?? 0));
  const bottom = Math.min(inner.y + ih, outer.y + (outer.height ?? 0));
  const overlap = Math.max(0, right - x) * Math.max(0, bottom - y);
  // Clamped: float arithmetic on sub-pixel OCR frames put a fully contained
  // box at 1.0000000000000007, and a fraction of an area cannot exceed 1.
  return Math.min(1, overlap / innerArea);
}

/**
 * How much of the smaller box must sit inside the larger one to be the same
 * element. OCR boxes sit a pixel or two outside the row they are printed on
 * often enough that 1.0 would miss them.
 */
export const CONTAINMENT = 0.9;

/**
 * Do these two strings name the same thing?
 *
 * The discriminator that makes containment safe. A tab bar contains all five
 * of its tab labels, and merging a container with its contents is the failure
 * the old size cap was defending against — but a tab bar's own label is not
 * "Assets", so the text test refuses that merge while allowing a row labelled
 * "Kate Bell" to absorb OCR's reading of "Kate Bell".
 *
 * Substring counts because iOS labels carry state the printed text does not:
 * a row reads "Larger Text" on screen and publishes "Larger Text, Off".
 */
export function sameText(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) >= 3;
  // Fuzzy, because OCR misreads a letter or two — measured: "Location (AII)"
  // for "Location (All)", and a Cyrillic К for a K in a monogram.
  return nameScore(x, y) >= 0.5;
}

/**
 * The same element, seen by both sensors.
 *
 * `ax` is the tree's element, `ocr` a text box. True when the text sits
 * (almost) wholly inside the element AND says the same thing as its label or
 * value.
 */
export function sameElementSeenTwice(ax, ocr) {
  if (!ax?.frame || !ocr?.frame) return false;
  if (containedFraction(ocr.frame, ax.frame) < CONTAINMENT) return false;
  return sameText(ax.label, ocr.label ?? ocr.text) || sameText(ax.value, ocr.label ?? ocr.text);
}

const contains = (frame, target) =>
  Boolean(frame)
  && target.x >= frame.x && target.x <= frame.x + (frame.width ?? 0)
  && target.y >= frame.y && target.y <= frame.y + (frame.height ?? 0);

/**
 * Are these two candidates the same control?
 *
 * Two ways, and the second one cost a measurement. Centres a couple of points
 * apart are one rectangle read twice. But a full-width list cell and the
 * left-aligned text printed inside it have centres a hundred points apart and
 * are still one tap target — measured on a Settings list, where "General" came
 * back as the cell at (201,326) and the OCR text at (102,327) and the caller
 * was asked which of the two it meant. The screen map already folds that pair
 * into one row; this is `locate` catching up with it.
 */
function sameControl(a, b) {
  if (Math.abs(a.x - b.x) <= SAME_CONTROL_POINTS && Math.abs(a.y - b.y) <= SAME_CONTROL_POINTS) return true;
  // Containment only counts when the container is a hit target. A group that
  // merely encloses things is not the thing inside it, which is what stops a
  // tab bar from absorbing its own tabs.
  if (INTERACTIVE_ROLE.test(a.type ?? '') && contains(a.frame, b)) return true;
  if (INTERACTIVE_ROLE.test(b.type ?? '') && contains(b.frame, a)) return true;
  // And a labelled accessibility element that is not an interactive role —
  // a list row published as StaticText — with OCR's reading of its own label
  // inside it. This is the pair that made `tap "Kate Bell"` refuse on every
  // Contacts list: 16 escalations in the first instrumented run, all one
  // screen. Defence in depth: the screen map now merges this pair at fusion,
  // and a map built before that still resolves.
  if (isAxTarget(a) && !isAxTarget(b) && sameElementSeenTwice(a, b)) return true;
  if (isAxTarget(b) && !isAxTarget(a) && sameElementSeenTwice(b, a)) return true;
  return false;
}

function collapseSamePlace(ranked) {
  const kept = [];
  for (const c of ranked) {
    const twin = kept.find((k) => sameControl(k.target, c.target));
    if (!twin) {
      kept.push(c);
      continue;
    }
    // Prefer the real hit target: an accessibility element over OCR's reading of
    // it, and an interactive role over a caption sitting inside it.
    const better = (candidate, incumbent) => {
      if (isAxTarget(candidate.target) && !isAxTarget(incumbent.target)) return true;
      if (!isAxTarget(candidate.target) && isAxTarget(incumbent.target)) return false;
      return INTERACTIVE_ROLE.test(candidate.target.type ?? '')
        && !INTERACTIVE_ROLE.test(incumbent.target.type ?? '');
    };
    if (better(c, twin)) {
      kept[kept.indexOf(twin)] = { ...c, reasons: [...c.reasons, 'the hit target, not the text printed on it'] };
    }
  }
  return kept;
}

/**
 * Resolve an intent to one element, or say why not.
 * @returns {{status: 'ok'|'ambiguous'|'none', target?, score?, reasons?, alternatives?}}
 */
export function resolve(targets, intent, options = {}) {
  const ranked = collapseSamePlace(rank(targets, intent, options).filter((c) => c.score >= MINIMUM_SCORE));
  if (!ranked.length) return { status: 'none', alternatives: [] };
  const [best, second] = ranked;
  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    return {
      status: 'ambiguous',
      alternatives: ranked.slice(0, 5).map((c) => ({
        label: c.target.label ?? '(icon-only)',
        x: c.target.x,
        y: c.target.y,
        region: c.target.region,
        score: Math.round(Math.min(1, c.score) * 100) / 100,
        reasons: c.reasons,
      })),
    };
  }
  return {
    status: 'ok',
    target: best.target,
    score: Math.round(Math.min(1, best.score) * 100) / 100,
    reasons: best.reasons,
    alternatives: ranked.slice(1, 4).map((c) => ({
      label: c.target.label ?? '(icon-only)',
      score: Math.round(Math.min(1, c.score) * 100) / 100,
    })),
  };
}
