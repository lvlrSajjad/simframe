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
 * Resolve an intent to one element, or say why not.
 * @returns {{status: 'ok'|'ambiguous'|'none', target?, score?, reasons?, alternatives?}}
 */
export function resolve(targets, intent, options = {}) {
  const ranked = rank(targets, intent, options).filter((c) => c.score >= MINIMUM_SCORE);
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
