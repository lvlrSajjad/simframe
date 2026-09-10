// What happens when you do something here.
//
// Keyed by the same layout hash as screen memory, so a screen the map already
// recognises is a screen the graph already knows. Edges are observations, never
// predictions: an edge exists because an action was taken and the result was
// seen, and a screen with no edges is a screen we have nothing to say about.
import fs from 'node:fs';
import path from 'node:path';
import { hashDistance } from './analyze.js';
import { informative } from './refs.js';
import * as fingerprint from './fingerprint.js';
import * as metrics from './metrics.js';
import * as matching from './matching.js';
import * as store from './store.js';

const GRAPH_VERSION = 3;

/**
 * How many observed settle durations an edge remembers. Research §7.
 *
 * Fifty is a window, not a history: an app that got faster after an update
 * should stop being waited for at its old speed, and a mean over everything
 * ever observed never forgets.
 */
export const TIMING_WINDOW = 50;
/** Below this many samples an edge has no distribution worth trusting. */
export const COLD_SAMPLES = 5;
/**
 * What a cold edge waits: exactly what every step waited before Phase 11.
 *
 * Deliberately unchanged, so the first traversal of an edge behaves as it
 * always did and only a *measured* edge gets a tighter bound. A conservative
 * default that is also the historical default cannot make anything worse.
 */
export const COLD_TIMEOUT_MS = 8000;
/**
 * The hard cap on waiting, from research §7: Nielsen's attention limit. Past
 * ten seconds a person has stopped believing the screen is coming, and so
 * should the agent — it escalates instead.
 */
export const HARD_CAP_MS = 10_000;

/**
 * How long to wait for a transition that has been measured.
 *
 * p95 plus a margin, where the margin is the larger of 150 ms and a fifth of
 * p95. The floor matters for fast edges: a tab switch with a p95 of 90 ms
 * would otherwise get a 108 ms budget, and one slow frame would call a
 * perfectly ordinary transition a timeout.
 */
export function adaptiveTimeout({ p95, samples } = {}) {
  if (!Number.isFinite(p95) || !Number.isFinite(samples) || samples < COLD_SAMPLES) {
    return { timeoutMs: COLD_TIMEOUT_MS, cold: true, reason: `fewer than ${COLD_SAMPLES} samples` };
  }
  const margin = Math.max(150, Math.round(p95 * 0.2));
  return { timeoutMs: Math.min(HARD_CAP_MS, p95 + margin), cold: false, reason: null, margin };
}

/**
 * Is this transition taking longer than this edge usually does?
 *
 * Two different answers hide behind a slow transition, and §7 asks for both:
 * a screen that is *working* (a spinner, a load) should be waited for up to
 * the hard cap, while a screen that is doing nothing visible has already
 * given its answer. The classifier's `loading` kind is what separates them.
 */
export function slowerThanUsual({ elapsedMs, p95, settled, kind } = {}) {
  if (settled || !Number.isFinite(elapsedMs) || !Number.isFinite(p95)) return { slower: false };
  if (elapsedMs <= p95) return { slower: false };
  const working = kind === 'loading';
  return {
    slower: true,
    working,
    keepWaiting: working && elapsedMs < HARD_CAP_MS,
    note: working
      ? `slower than usual (${elapsedMs}ms against a p95 of ${p95}ms) and still loading`
      : `slower than usual (${elapsedMs}ms against a p95 of ${p95}ms) with nothing visibly happening`,
  };
}

/**
 * Which fingerprint produced the hashes in these files.
 *
 * Separate from `GRAPH_VERSION` because it answers a different question: not
 * "is this file shaped the way I expect" but "were these hashes computed by the
 * same rules I am about to compare them with". A stored graph whose hashes came
 * from an older fingerprint is not stale, it is *incomparable* — and the failure
 * is silent, because an old hash is a perfectly well-formed hash that simply
 * never matches anything.
 *
 * On a mismatch the graph is discarded and rebuilt, never translated. A rebuild
 * costs a few hundred milliseconds per screen and happens once. A mis-merged
 * graph costs a wrong tap, and costs it for as long as the file survives.
 */
export const FINGERPRINT_VERSION = fingerprint.TOKEN_RULES_VERSION;
/**
 * Screens are matched by structural hash, exactly, and then by how alike their
 * token sets are — which tolerates one optional element appearing (a badge, a
 * banner) without tolerating a different screen.
 *
 * The pixel layout hash is not used for identity here. Measured, a same-screen
 * revisit with changed content reached 62 bits against a different-screen floor
 * of 74; no threshold separates those. See docs/BENCHMARKS.md, Phase 6.
 *
 * Structurally the two distributions do separate, but not by much: measured
 * with the screen map forced cold, revisits score 0.41 to 1.00 against a
 * different-screen ceiling of 0.31. 0.36 is the middle of that gap.
 *
 * The gap is narrow because of one screen, and a settle gate did not fix it
 * (docs/BENCHMARKS.md, Phase 6c): that screen loads its sections from different
 * sources and genuinely has more than one settled structure. Two structures of
 * one screen are as far apart as two different screens, so no threshold can
 * express the difference — which is why a screen may hold several accepted
 * fingerprints instead. See `variants` below.
 *
 * This still errs toward recording a duplicate screen, which costs a
 * re-derivation, over merging two, which costs a tap on the wrong element.
 *
 * Most revisits match on a hash outright and never reach this at all.
 */
export const SIMILARITY_THRESHOLD = 0.36;

/**
 * How many of the 288 layout bits may differ and still be the same arrangement
 * of light. The same number `screenmap` recalls maps by, and for the same
 * reason: measured, a revisit is usually identical and different screens sit at
 * 74 and above, so 20 is well inside the gap.
 */
export const SAME_SCREEN_LAYOUT_BITS = 20;
/**
 * A screen with three async sections has a few settled structures, not endless
 * ones. Capping this keeps a genuinely wrong merge bounded: if a node starts
 * collecting variants without limit, that is a signal the action is
 * non-deterministic, not that the screen has many faces.
 */
export const MAX_VARIANTS = 4;

/** Only for the legacy pixel path, kept so old graphs still load. */
export const TOLERANCE = 20;

function graphDir(udid) {
  return path.join(store.deviceDir(udid), 'graph');
}

/** A stable name for an action, so the same step matches its own history. */
export function actionSignature(step) {
  if (!step || typeof step !== 'object') return String(step ?? '');
  // Normalized steps carry `{action, value}`, not `{tap: "..."}`, and every
  // step reaching the graph has been normalized. Without this the shorthand
  // branches below never matched and everything fell to the generic tail, so a
  // tap on "Contacts" and a type of "Contacts" produced the SAME signature —
  // two different actions sharing one edge — and a stray `index: undefined`
  // key made the tail throw outright.
  if (step.action) {
    // Bookkeeping is not part of what the action IS: the same tap with a longer
    // timeout is the same edge.
    const { action, timeoutMs, stableMs, autoSettle, ...rest } = step;
    const value = rest.value ?? rest.target ?? rest.label;
    if (value != null && typeof value !== 'object') return `${action}:${String(value).toLowerCase()}`;
    // Shapes like tapAt and swipe are spread inline, so they have no `value` —
    // their coordinates ARE their identity and must stay in the signature, or
    // two taps at different points share one edge.
    const keys = Object.keys(rest).filter((k) => rest[k] !== undefined).sort();
    if (!keys.length) return String(action);
    return `${action}:${stableValue(Object.fromEntries(keys.map((k) => [k, rest[k]])))}`;
  }
  if (step.tap != null) return `tap:${String(step.tap).toLowerCase()}`;
  if (step.tapAt) return `tapAt:${Math.round(step.tapAt.x)},${Math.round(step.tapAt.y)}`;
  if (step.swipe) {
    const { from = [], to = [] } = step.swipe;
    return `swipe:${from.join(',')}->${to.join(',')}`;
  }
  if (step.scroll) return `scroll:${step.scroll}`;
  if (step.button) return `button:${step.button}`;
  if (step.launch) return `launch:${step.launch}`;
  if (step.openUrl) return `openUrl:${step.openUrl}`;
  // Last resort. Skip keys whose value is undefined: JSON.stringify(undefined)
  // is undefined, and calling .slice on it threw before any action was sent.
  const key = Object.keys(step).find((k) => step[k] !== undefined);
  if (!key) return '';
  return `${key}:${stableValue(step[key])}`;
}

/** JSON, but never undefined, and always short enough to use as a key. */
function stableValue(value) {
  return String(JSON.stringify(value) ?? '').slice(0, 40);
}

/** Every fingerprint a node answers to: its canonical one, plus its variants. */
function fingerprintsOf(node) {
  return [{ hash: node.hash, tokens: node.tokens ?? [] }, ...(node.variants ?? [])];
}

function load(udid, screen) {
  const key = typeof screen === 'string' ? { hash: screen, tokens: [] } : screen;
  const entry = store.readJson(path.join(graphDir(udid), `${key.hash}.json`));
  if (entry?.version === GRAPH_VERSION && entry?.fingerprintVersion === FINGERPRINT_VERSION) return entry;
  // The hash may be a variant of a node filed under a different name.
  const byVariant = allNodes(udid).find((n) => (n.variants ?? []).some((v) => v.hash === key.hash));
  if (byVariant) return byVariant;
  return {
    version: GRAPH_VERSION,
    fingerprintVersion: FINGERPRINT_VERSION,
    hash: key.hash,
    tokens: key.tokens ?? [],
    // What the pixels looked like here. Kept because it is the evidence that
    // two structurally different readings are the same screen — see `record`.
    layoutHash: key.layoutHash ?? null,
    variants: [],
    edges: [],
  };
}

/** Keep the pixel baseline current for a screen we are standing on. */
function noteLayout(node, reading) {
  const now = typeof reading === 'string' ? null : reading?.layoutHash;
  if (now && informative(now)) node.layoutHash = now;
  return node;
}

function save(udid, node) {
  const dir = graphDir(udid);
  fs.mkdirSync(dir, { recursive: true });
  store.writeAtomic(path.join(dir, `${node.hash}.json`), JSON.stringify(node));
}

export function allNodes(udid) {
  try {
    return fs
      .readdirSync(graphDir(udid))
      .filter((f) => f.endsWith('.json'))
      .map((f) => store.readJson(path.join(graphDir(udid), f)))
      .filter((n) => n?.version === GRAPH_VERSION && n?.fingerprintVersion === FINGERPRINT_VERSION);
  } catch {
    return [];
  }
}

/** The stored screen closest to `hash`, by layout rather than content. */
/**
 * The stored screen matching this one.
 *
 * `screen` is `{ hash, tokens }` from the structural fingerprint. An exact hash
 * match is the common case; the token comparison catches the screen that gained
 * a badge since last time.
 */
export function nearestScreen(udid, screen, { threshold = SIMILARITY_THRESHOLD } = {}) {
  const key = typeof screen === 'string' ? { hash: screen, tokens: null } : screen;
  if (!key?.hash) return null;
  const nodes = allNodes(udid);
  // Any of a node's accepted fingerprints matching exactly is still an exact
  // match: a screen with two settled structures is one screen.
  const exact = nodes.find((n) => fingerprintsOf(n).some((f) => f.hash === key.hash));
  if (exact) return { node: exact, similarity: 1 };
  if (!key.tokens?.length) return null;
  let best = null;
  let bestSimilarity = 0;
  for (const node of nodes) {
    for (const f of fingerprintsOf(node)) {
      if (!f.tokens?.length) continue;
      const s = fingerprint.similarity(f.tokens, key.tokens);
      if (s > bestSimilarity) {
        bestSimilarity = s;
        best = node;
      }
    }
  }
  return best && bestSimilarity >= threshold ? { node: best, similarity: bestSimilarity } : null;
}

/**
 * Teach a node that it also looks like this.
 *
 * Called only when a known edge has landed somewhere its target does not
 * recognise — the edge is the evidence. A screen whose sections arrive from
 * different sources has several genuine settled structures, and this is how the
 * second one stops being a screen of its own.
 */
function addVariant(node, reading) {
  node.variants ??= [];
  const existing = node.variants.find((v) => v.hash === reading.hash);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = Date.now();
    return false;
  }
  if (node.variants.length >= MAX_VARIANTS) return false;
  node.variants.push({ hash: reading.hash, tokens: reading.tokens ?? [], count: 1, lastSeen: Date.now() });
  return true;
}

/** Only actions worth replaying — a launch or a URL open is a flow's start, not a step within it. */
function replayable(step) {
  if (!step || typeof step !== 'object') return null;
  return step.launch != null || step.openUrl != null ? null : step;
}

/**
 * What has worked from this screen before, in the caller's own vocabulary.
 *
 * The graph has always known this and never said it. A map reported
 * `(known, 3 known exits)` — the *count* — so an agent on a screen simframe had
 * driven successfully six times still had to read it to learn what was tappable.
 * Measured across two peer rounds: a flow whose steps were known in advance ran
 * 16 steps in **one** call, and the same agent on a screen the graph also knew
 * but whose labels it did not spent 25 calls on 31 steps. The difference was not
 * perception. It was whether a plan existed before execution started.
 *
 * Ordered by how often each has worked, because that is the order an agent
 * should try them in.
 */
export function exitsOf(node, { limit = 8 } = {}) {
  return (node?.edges ?? [])
    .map((e) => ({
      action: e.step?.action ?? (e.action ?? '').split(':')[0] ?? 'tap',
      label: e.step?.value ?? e.step?.target ?? e.step?.label ?? e.step?.into ?? null,
      to: e.to ?? null,
      count: e.count ?? 0,
      kind: e.kind ?? null,
    }))
    // A `#13` was a ref on the screen it was typed on and means nothing on the
    // next visit; a raw coordinate is not a name either. Neither is reusable
    // vocabulary, which is the whole point of this list.
    .filter((e) => e.label != null && !/^#\d+$/.test(String(e.label).trim())
      && !/^@?-?\d+\s*,\s*-?\d+$/.test(String(e.label).trim()))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * What to call this screen, for a human typing `goto`.
 *
 * Chrome labels are the only text in a fingerprint, which makes them the only
 * thing available to name it by — and they are the right thing anyway: a screen
 * is called what its nav bar says it is.
 */
export function describe(node) {
  const labels = (pattern) => (node.tokens ?? [])
    .filter((t) => pattern.test(t) && t.includes('"'))
    .map((t) => t.slice(t.indexOf('"') + 1, t.lastIndexOf('"')))
    .filter(Boolean);
  // The nav title first, because that is what the screen is called. A button
  // that happens to sit in the nav bar is not a name for anything.
  const title = labels(/:nav-bar:@title:/);
  if (title.length) return title.join(' ');
  // Three at most. A screen named after seven tab-bar fragments — several of
  // them OCR reading a divider — is not a name anybody can type into `goto`.
  const tabs = labels(/:tab-bar:/);
  if (tabs.length) return tabs.slice(0, 3).join(' / ');
  const anyChrome = labels(/:(nav-bar|tab-bar):/);
  if (anyChrome.length) return anyChrome.slice(0, 3).join(' ');
  return node.hash.slice(0, 8);
}

/** Find a known screen by what a human would call it. */
export function findScreen(udid, query) {
  const wanted = String(query ?? '').trim();
  if (!wanted) return null;
  const scored = allNodes(udid)
    .map((node) => ({ node, name: describe(node) }))
    .map((c) => ({ ...c, score: matching.nameScore(c.name, wanted) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best) return null;
  // Two screens that fit the query equally well is a question for the caller,
  // not a coin flip that navigates somewhere wrong.
  if (next && best.score - next.score < 0.08) {
    return { ambiguous: [best, next].map((c) => ({ name: c.name, hash: c.node.hash })) };
  }
  return { node: best.node, name: best.name, score: best.score };
}

/** Remember that doing `action` on `from` led to `to`. */
/**
 * Add one observed settle duration to an edge's rolling window.
 *
 * Kept on the edge rather than in a separate store because it is a property of
 * this transition on this screen — the same tap costs 90 ms on a tab bar and
 * 2.4 s on a screen that fetches — and because the graph is already persisted,
 * versioned and pruned.
 */
function noteSettle(edge, settleMs, quietGapMs, focusMs) {
  if (Number.isFinite(settleMs) && settleMs >= 0) {
    edge.settles = [...(edge.settles ?? []), Math.round(settleMs)].slice(-TIMING_WINDOW);
  }
  // Recorded even when zero: "this transition never paused" is exactly the
  // observation that lets the next one stop waiting 500ms to find out.
  if (Number.isFinite(quietGapMs) && quietGapMs >= 0) {
    edge.quietGaps = [...(edge.quietGaps ?? []), Math.round(quietGapMs)].slice(-TIMING_WINDOW);
  }
  // How long the *field* took to take focus, which is a different duration from
  // how long the step took: it is measured between the tap and the keyboard,
  // inside a step whose settle is measured after the typing. One edge, two
  // waits, so two distributions.
  if (Number.isFinite(focusMs) && focusMs >= 0) {
    edge.focuses = [...(edge.focuses ?? []), Math.round(focusMs)].slice(-TIMING_WINDOW);
  }
}

/**
 * Record the unbiased pause statistic for an edge already written.
 *
 * Separate from `record` because it arrives later on purpose. The biased
 * `quietGaps` are gathered from inside the wait and are therefore bounded by
 * when the wait chose to stop; `trueGaps` are read off the frame history once
 * the transition is definitely over, which is one step later. So the edge has
 * to be found again rather than passed along.
 *
 * Nothing reads `trueGaps` yet, and that is deliberate. Phase 11 built the
 * learned stillness window on the biased statistic, it corrupted the graph
 * inside an afternoon, and the lesson taken was not "use a better estimator" —
 * it was that a number gets to *act* only after it has been watched for a while
 * doing nothing. This is the watching.
 */
export function noteTrueGap(udid, screen, step, trueGapMs) {
  if (!Number.isFinite(trueGapMs) || trueGapMs < 0) return null;
  const node = screen?.hash ? nearestScreen(udid, screen)?.node : null;
  if (!node) return null;
  const edge = node.edges?.find((e) => e.action === actionSignature(step));
  if (!edge) return null;
  edge.trueGaps = [...(edge.trueGaps ?? []), Math.round(trueGapMs)].slice(-TIMING_WINDOW);
  save(udid, node);
  return edge;
}

/**
 * How long a screen must hold still on this edge before it is finished.
 *
 * Derived from the longest pause ever seen *inside* this transition, plus a
 * margin, and never longer than the caller's own default — this can only make
 * a wait shorter, never longer, which is what keeps a learned number from
 * becoming a new way to hang.
 *
 * The floor is 150 ms because a settle also needs at least one fresh frame to
 * judge, and the capture loop's own idle interval is the limit on how fast an
 * answer can arrive.
 */
export const STILLNESS_FLOOR_MS = 150;

export function stillnessFor({ gapSamples, gapP95 } = {}, fallbackMs) {
  if (!Number.isFinite(gapP95) || !Number.isFinite(gapSamples) || gapSamples < COLD_SAMPLES) {
    return { stillnessMs: fallbackMs, cold: true };
  }
  const margin = Math.max(100, Math.round(gapP95 * 0.5));
  return {
    stillnessMs: Math.max(STILLNESS_FLOOR_MS, Math.min(fallbackMs, gapP95 + margin)),
    cold: false,
  };
}

/**
 * How long to wait for a tapped field to take focus.
 *
 * The three numbers this replaces were the last genuinely fixed waits on the
 * action path: 250 ms of stillness, a 900 ms reaction window, a 3 s timeout.
 * What makes them different from the step budget is the shape of the failure.
 * A step budget that is too short reports `no-visible-change` and the flow can
 * see it. A focus wait that is too short types into a field that does not have
 * focus yet, `typeText` succeeds because input has no feedback channel, and the
 * step reports that it typed — the worst shape a failure can take, and the bug
 * this helper was written to fix in the first place.
 *
 * So this one is asymmetric on purpose: **a learned window may only lengthen
 * the wait**, never shorten it. p95 of what this field has actually cost, when
 * that is longer than 3 s, is a field that was being typed into too early and
 * now is not. Where it is shorter, the measurement is discarded rather than
 * banked as a saving — 5% of a distribution is one silent wrong type in twenty
 * runs, and there is no amount of median wall time worth that.
 *
 * The one shortening is not a learned number at all, it is positive evidence:
 * if the keyboard was already up before the tap, this tap moves a caret. There
 * is no keyboard animation to wait for, so the reaction window collapses to the
 * stillness window instead of paying 900 ms to watch a screen that was never
 * going to move. `beforeScreen` already carries `keyboard`, so the evidence is
 * free — it is the same perception pass the step was going to run anyway.
 */
export function focusPlan(stats, { reactionMs, timeoutMs, stillnessMs, keyboardUp } = {}) {
  if (keyboardUp) {
    return {
      reactionMs: stillnessMs ?? reactionMs,
      timeoutMs,
      cold: false,
      from: 'the keyboard was already up, so this tap moves a caret',
    };
  }
  const { focusP50, focusP95, focusSamples } = stats ?? {};
  if (!Number.isFinite(focusP95) || !Number.isFinite(focusSamples) || focusSamples < COLD_SAMPLES) {
    return { reactionMs, timeoutMs, cold: true, from: `fewer than ${COLD_SAMPLES} focus samples` };
  }
  const margin = Math.max(150, Math.round(focusP95 * 0.2));
  const learnedTimeout = Math.min(HARD_CAP_MS, focusP95 + margin);
  const learnedReaction = Math.min(learnedTimeout, focusP50 + margin);
  return {
    // max, not min. See above: only ever longer.
    reactionMs: Math.max(reactionMs, learnedReaction),
    timeoutMs: Math.max(timeoutMs, learnedTimeout),
    cold: false,
    from: `p95 ${focusP95}ms over ${focusSamples} focus samples`,
  };
}

/** What this edge's observed settle durations say, or that it has none. */
export function timingOf(edge) {
  const samples = edge?.settles ?? [];
  const gaps = edge?.quietGaps ?? [];
  const focuses = edge?.focuses ?? [];
  return {
    samples: samples.length,
    p50: metrics.percentile(samples, 50),
    p95: metrics.percentile(samples, 95),
    gapSamples: gaps.length,
    gapP95: metrics.percentile(gaps, 95),
    // The same statistic measured after the transition rather than during it.
    // Reported side by side so the size of the bias is visible rather than
    // argued about — see `index.longestQuietGap`.
    trueGapSamples: (edge?.trueGaps ?? []).length,
    trueGapP95: metrics.percentile(edge?.trueGaps ?? [], 95),
    focusSamples: focuses.length,
    focusP50: metrics.percentile(focuses, 50),
    focusP95: metrics.percentile(focuses, 95),
  };
}

/**
 * How long to wait for `step` on `screen`, from what it has cost before.
 *
 * Returns the cold default when this screen or this action has not been
 * measured, and says which — a timeout nobody can explain is how a fixed sleep
 * gets reintroduced as a constant with a comment.
 */
export function timingFor(udid, screen, step) {
  const node = screen?.hash ? nearestScreen(udid, screen)?.node : null;
  const edge = node?.edges?.find((e) => e.action === actionSignature(step));
  const stats = timingOf(edge);
  return { ...stats, ...adaptiveTimeout(stats), known: Boolean(edge) };
}

/**
 * What getting *to* this screen has cost before.
 *
 * `sim_state` is asked "what is on screen and is it done moving", with no
 * action in hand, so there is no outgoing edge to consult. The useful answer
 * is the inbound one: the edge most recently traversed into this screen is how
 * we got here, and its distribution is what "slower than usual" means right
 * now. Most recently seen rather than most travelled — a screen reachable two
 * ways is being timed against the way it was just reached.
 */
export function timingInto(udid, hash) {
  if (!hash) return null;
  let best = null;
  for (const node of allNodes(udid)) {
    for (const edge of node.edges ?? []) {
      if (edge.to !== hash) continue;
      if (!best || (edge.lastSeen ?? 0) > (best.lastSeen ?? 0)) best = edge;
    }
  }
  return best ? { ...timingOf(best), action: best.action, kind: best.kind ?? null } : null;
}

export function record(udid, { from, action, to, kind, settleMs, quietGapMs, focusMs }) {
  const fromKey = typeof from === 'string' ? { hash: from } : from;
  const toHash = typeof to === 'string' ? to : to?.hash;
  if (!fromKey?.hash || !toHash) return null;
  const node = nearestScreen(udid, fromKey)?.node ?? load(udid, fromKey);
  // Never overwrite the canonical fingerprint with the one we happened to
  // arrive as — that is what variants are for, and rewriting it here would let
  // a node drift screen by screen into something it never was.
  if (!node.tokens?.length && fromKey.tokens?.length) node.tokens = fromKey.tokens;
  // The pixel baseline, on the other hand, *should* track: it is the evidence
  // for "same arrangement of light as last time I stood here", and a stale one
  // answers a question about a screen as it was weeks ago.
  noteLayout(node, fromKey);
  const to_ = toHash;
  const signature = actionSignature(action);
  const existing = node.edges.find((e) => e.action === signature);
  if (existing) {
    // A different outcome from the same action is worth knowing about: it is
    // how a screen that looks the same but behaves differently shows up.
    if (existing.to !== to_) {
      // A known edge has landed somewhere its target does not recognise. Either
      // the action is genuinely non-deterministic, or this is the same screen
      // wearing a different structure — and the edge is the only evidence that
      // can tell them apart. If some *other* stored screen claims this reading,
      // believe it: that is a real change of destination. If nothing claims it,
      // the screen at the end of this edge has grown a second face.
      const reading = typeof to === 'string' ? { hash: to, tokens: [] } : to;
      const claimant = nearestScreen(udid, reading)?.node;
      const target = load(udid, existing.to);
      const unclaimed = !claimant || claimant.hash === target.hash;
      // "Nothing we have stored claims this reading" is not evidence that the
      // target grew a second face. It is equally consistent with this action
      // being state-dependent and having gone somewhere genuinely new — and
      // treating the two the same welds an unrelated screen onto a learned
      // edge. Reproduced: a screen sharing *zero* tokens with the target got
      // merged into it, after which landing there returned `ok` ("matches the
      // outcome seen 3x before") and a flow kept walking, tapping real controls
      // on a screen its plan never contained.
      //
      // So the reading has to positively look like the target before it is
      // called a face of it. Unclaimed is a necessary condition, not a
      // sufficient one.
      // Two kinds of positive evidence that this reading is a face of the
      // target, and either will do. What will not do is "nothing else claims
      // it", which is an absence of evidence and used to be the whole test.
      //
      //  * It looks like the target — the tokens overlap enough to be the same
      //    screen by the same measure used everywhere else.
      //  * It *looks like* the target on screen. The pixels are within the
      //    same-screen band of what was seen here before, and we arrived
      //    through an edge that has led here. Identity belongs to the graph as
      //    much as to the hash: the transition is evidence the fingerprint
      //    cannot supply, and it is exactly the evidence needed when one
      //    perception layer answered this time and not last time.
      //
      // That second route is what carries a screen whose structure genuinely
      // differs between reads. Measured on four device-native screens, the
      // accessibility tree and OCR agree on only 0.33–0.47 of a screen's
      // tokens and never on its hash, and coarsening the vocabulary barely
      // moved it — so this is not a residual case, it is the common one.
      const looksLikeTarget = resembles(target, reading) || pixelsAgree(target, reading);
      if (unclaimed && looksLikeTarget && target.hash !== to_ && reading.tokens?.length) {
        addVariant(target, reading);
        noteLayout(target, reading);
        save(udid, target);
        existing.count += 1;
        existing.lastSeen = Date.now();
        noteSettle(existing, settleMs, quietGapMs, focusMs);
        save(udid, node);
        return node;
      }
      existing.previousTo = existing.to;
      existing.changedOutcomes = (existing.changedOutcomes ?? 0) + 1;
    }
    existing.to = to_;
    existing.step = replayable(action) ?? existing.step;
    existing.kind = kind ?? existing.kind;
    existing.count += 1;
    existing.lastSeen = Date.now();
    // Every argument, and it is worth saying why this line once passed one.
    // `quietGapMs` was dropped here — on the *main* path, the one nearly every
    // recorded edge takes — so the pause statistic only ever accumulated on a
    // brand-new edge and on the variant branch. The window that reads it looked
    // permanently cold, which is a measurement quietly not being taken rather
    // than a wrong number, and those are the ones nothing complains about.
    noteSettle(existing, settleMs, quietGapMs, focusMs);
  } else {
    node.edges.push({
      action: signature,
      // The signature is lossy — it lowercases labels and truncates. Routing
      // has to replay the action exactly, so keep the step that produced it.
      step: replayable(action),
      to: to_,
      kind,
      count: 1,
      lastSeen: Date.now(),
      settles: Number.isFinite(settleMs) && settleMs >= 0 ? [Math.round(settleMs)] : [],
      quietGaps: Number.isFinite(quietGapMs) && quietGapMs >= 0 ? [Math.round(quietGapMs)] : [],
      focuses: Number.isFinite(focusMs) && focusMs >= 0 ? [Math.round(focusMs)] : [],
    });
  }
  save(udid, node);
  return node;
}

/** What this action did last time, if we have ever seen it here. */
/**
 * Do the pixels say this is the same screen we have stood on here before?
 *
 * The layout hash is a poor answer to "which screen is this" on its own — that
 * is why identity is structural — but it is a good answer to "is this the same
 * arrangement of light", and combined with having arrived through a known edge
 * it is the evidence that two structurally different readings are one screen.
 *
 * Guarded by `informative`, because a dark or uniform screen hashes to almost
 * nothing and two of those are within any tolerance of each other while being
 * evidence of nothing at all.
 */
function pixelsAgree(node, reading) {
  const before = node?.layoutHash;
  const now = reading?.layoutHash;
  if (!before || !now || !informative(before) || !informative(now)) return false;
  return hashDistance(before, now) <= SAME_SCREEN_LAYOUT_BITS;
}

/**
 * Does this reading look like a face of this screen, rather than a different
 * screen we happen not to have stored yet?
 *
 * Compared against every face the screen already wears, because a screen with
 * two structures is exactly the case variants exist for and a new reading may
 * resemble the second one rather than the first.
 */
function resembles(node, reading) {
  if (!node || !reading?.tokens?.length) return false;
  const faces = [node.tokens ?? [], ...(node.variants ?? []).map((v) => v.tokens ?? [])];
  return faces.some((face) => face.length && fingerprint.similarity(face, reading.tokens) >= SIMILARITY_THRESHOLD);
}

export function predict(udid, from, action) {
  const found = nearestScreen(udid, from);
  if (!found) return null;
  const signature = actionSignature(action);
  const edge = found.node.edges.find((e) => e.action === signature);
  return edge ? { ...edge, fromDistance: found.distance } : null;
}

export function stats(udid) {
  const nodes = allNodes(udid);
  return { screens: nodes.length, edges: nodes.reduce((n, s) => n + s.edges.length, 0) };
}

export function forget(udid) {
  try {
    fs.rmSync(graphDir(udid), { recursive: true, force: true });
  } catch {
    /* nothing to forget */
  }
}

/**
 * A route of actions from one screen to another through edges we have taken.
 *
 * Breadth-first over observed edges only. An unknown screen has no path — the
 * graph never guesses, because a guessed route taps real controls.
 */
export function route(udid, fromHash, toHash, { maxDepth = 8 } = {}) {
  const start = nearestScreen(udid, fromHash);
  if (!start) return null;
  if (start.node.hash === toHash) return [];

  // Variants have to resolve here the same way they resolve everywhere else.
  //
  // A screen may wear more than one structure, and an edge records whichever
  // one it arrived on — so an edge whose `to` is a variant hash was a dead end
  // in this search while `nearestScreen` was perfectly happy to say that hash
  // *is* the node. The graph then had a route it could not find, `goto`
  // answered `no-route` for somewhere it had been, and a flow that should have
  // replayed from memory was re-explored instead. That is at least one
  // mechanical cause of the convergence flakiness in DEFERRED.
  const byHash = new Map();
  for (const node of allNodes(udid)) {
    byHash.set(node.hash, node);
    for (const variant of node.variants ?? []) if (!byHash.has(variant.hash)) byHash.set(variant.hash, node);
  }
  // Canonical identity, so a variant and its screen are one place in the search
  // rather than two, and reaching either counts as reaching the goal.
  const canonical = (h) => byHash.get(h)?.hash ?? h;
  const goalHash = canonical(toHash);
  const reached = (h) => canonical(h) === goalHash;
  const seen = new Set([start.node.hash]);
  const queue = [{ hash: start.node.hash, path: [] }];
  while (queue.length) {
    const { hash, path: taken } = queue.shift();
    if (taken.length >= maxDepth) continue;
    const node = byHash.get(hash);
    for (const edge of node?.edges ?? []) {
      const to = canonical(edge.to);
      if (seen.has(to)) continue;
      const next = [...taken, edge];
      if (reached(edge.to)) return next;
      seen.add(to);
      queue.push({ hash: to, path: next });
    }
  }
  return null;
}

/** Verdicts a verified step can produce. */
// `unexpected-transition` was removed: see verdict(). The transition kind is
// reported inside an `ok` verdict now, because the classifier is not reliable
// enough for a correct navigation to be called wrong by it.
export const VERDICTS = ['ok', 'no-visible-change', 'unexpected-screen', 'unverified'];

/**
 * Compare what happened against what was expected.
 *
 * With no prediction the outcome is `unverified` rather than `ok`: not knowing
 * what should have happened is not evidence that the right thing did.
 */
/**
 * Do these two fingerprints mean the same screen?
 *
 * String equality was right when a screen had exactly one fingerprint. Now that
 * a node can answer to several — a list with an alert over it is the same
 * screen — comparing hashes directly reports a wrong turn every time the
 * variant is the one on screen. The variant mechanism fired correctly on a real
 * app and the verdict still said `unexpected-screen`, because the verdict never
 * asked the graph.
 */
/**
 * Are these two readings the same screen?
 *
 * `nearestScreen` has always had a token-similarity tolerance, precisely so
 * that a screen whose *content* differs — a list with different rows, a form
 * showing a different record — still resolves to the screen it is. The
 * verification path threw that away: it passed bare hash strings, and a string
 * carries no tokens, so only an exact hash could ever match.
 *
 * The cost was measured. `unexpected-screen` fired three times in one reported
 * run and was wrong all three; two were this — the tester picked a different
 * asset than earlier runs had, so the content differed, so the hash differed,
 * so a correct navigation was called a wrong turn. Their conclusion: *"this
 * will fire on every run that varies its test data — i.e. every useful run."*
 * And because a failed step abandons the rest of its batch, each false alarm
 * costs a round trip, which is the thing the whole design is trying to buy.
 *
 * So pass the reading, not just its name: `{hash, tokens}` lets the tolerance
 * that already exists do its job. A string still works and still means "exact
 * match only", which is right for a stored prediction that has no tokens.
 */
function sameScreen(udid, a, b) {
  const hashOf = (v) => (typeof v === 'string' ? v : v?.hash);
  const ha = hashOf(a);
  const hb = hashOf(b);
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  if (!udid) return false;
  const nodeA = nearestScreen(udid, typeof a === 'string' ? a : { hash: ha, tokens: a?.tokens })?.node;
  const nodeB = nearestScreen(udid, typeof b === 'string' ? b : { hash: hb, tokens: b?.tokens })?.node;
  return Boolean(nodeA && nodeB && nodeA.hash === nodeB.hash);
}

/**
 * How many times an edge must have been observed before a mismatch counts as a
 * wrong turn rather than as "we do not know yet".
 *
 * Two, because the difference between one and two observations is the
 * difference between a coincidence and a pattern, and the cost of being wrong
 * is asymmetric: halting a correct run is visible and annoying, while
 * continuing one extra step past a genuinely wrong turn is caught by the next
 * step's own verdict.
 */
export const CONFIDENT_OBSERVATIONS = 2;

/**
 * Actions whose correct outcome is that the screen stays where it is.
 *
 * Typing into a field does not navigate, so screen-identity movement cannot
 * say whether it worked — and answering with `no-visible-change` was actively
 * harmful three ways. It printed a verdict contradicting the wait's own
 * observation on the same line (`[a small change, in one region only] …
 * [no-visible-change]`, both true, of different questions). It is an escalating
 * verdict, so a clean flow that typed anything told the caller to stop and
 * think. And it invited a re-type, which doubles a field that cannot be
 * cleared.
 *
 * These steps are verified by reading the field back instead — see
 * `fieldContents` in actions.js.
 */
export const STAYS_ON_SCREEN = new Set(['type', 'paste', 'key']);

export function verdict({ udid, prediction, before, after, kind, action }) {
  // `before`/`after` may be a hash or a whole reading. A reading carries its
  // tokens, which is what lets a content-varied screen still be recognised as
  // the screen it is.
  const hashOf = (v) => (typeof v === 'string' ? v : v?.hash);
  const beforeHash = hashOf(before);
  const afterHash = hashOf(after);
  if (!beforeHash || !afterHash) return { verdict: 'unverified', detail: 'no state to compare' };
  const moved = beforeHash !== afterHash;
  if (STAYS_ON_SCREEN.has(action) && !moved) {
    return { verdict: 'ok', detail: 'the screen was not expected to change, and did not' };
  }
  if (!prediction) {
    if (!moved) return { verdict: 'no-visible-change', detail: 'the screen did not change, and nothing predicted it would' };
    return { verdict: 'unverified', detail: 'this action has not been seen on this screen before' };
  }
  const expectedMove = !sameScreen(udid, prediction.to, before);
  if (!moved && expectedMove) {
    return { verdict: 'no-visible-change', detail: `expected to reach a different screen (seen ${prediction.count}x)` };
  }
  if (!sameScreen(udid, prediction.to, after)) {
    // One observation is not a prediction, and halting on it is what made a new
    // user's *second* run worse than their first.
    //
    // The first run learns every edge at count 1 and cannot contradict itself,
    // so it reports `unverified` throughout and completes. The second run then
    // has an expectation for every step, and any screen whose identity wobbles
    // — a read taken while the tree was still arriving, a screen with more than
    // one legitimate structure — contradicts it and stops the run. Measured
    // from the published package: run 1 halted at 3/10, runs 2 and 3 went
    // 10/10. The halt was not protecting anyone from anything.
    //
    // So a single-observation miss is reported as what it actually is: we do
    // not know yet. It must not be `unexpected-screen`, because that verdict is
    // what halts a run and what "a run that reported a wrong turn never also
    // reports success" is asserted over — and both of those should stay true.
    // Once the same edge has been seen twice, a miss is a real wrong turn.
    if (prediction.count < CONFIDENT_OBSERVATIONS) {
      return {
        verdict: 'unverified',
        detail: `seen here once before and went somewhere else that time`
          + ` — one observation is not enough to call this a wrong turn`,
        weakPrediction: { count: prediction.count, to: prediction.to },
      };
    }
    // This action has already led somewhere different at least once, so its
    // destination is not a fact about the screen — it is a distribution. An app
    // relaunch that lands on restored state, a list whose first row depends on
    // what happened last time: these genuinely have more than one outcome, and
    // calling the second one a wrong turn is calling the world wrong.
    //
    // The graph has always counted this as `changedOutcomes` and nothing ever
    // read it.
    if (prediction.changedOutcomes > 0) {
      return {
        verdict: 'unverified',
        detail: `this action has reached ${prediction.changedOutcomes + 1} different screens from here`
          + ` — its outcome is not predictable, so this is not a wrong turn`,
        nondeterministic: { outcomes: prediction.changedOutcomes + 1, count: prediction.count },
      };
    }
    return {
      verdict: 'unexpected-screen',
      detail: `expected the screen this action reached ${prediction.count}x before, and landed somewhere else`,
    };
  }
  // The screen is where it was predicted to be. That is the reliable signal and
  // it is what the verdict rests on.
  //
  // The transition *kind* is not reliable: Phase 4's classifier calls the same
  // tab switch `replace` on one run and `pop` on the next, and measured against
  // a real app it was the only thing producing non-ok verdicts on navigation
  // that had gone exactly where predicted. A verdict that says something is
  // wrong when nothing is wrong trains you to ignore verdicts, so a kind
  // mismatch is reported alongside `ok` rather than overriding it.
  const kindDiffers = Boolean(prediction.kind && kind && prediction.kind !== kind && kind !== 'none');
  return {
    verdict: 'ok',
    detail: `matches the outcome seen ${prediction.count}x before`
      + (kindDiffers ? ` (transition looked like ${kind}, not ${prediction.kind} — the classifier is noisy)` : ''),
    ...(kindDiffers ? { kindDiffers: { predicted: prediction.kind, observed: kind } } : {}),
  };
}
