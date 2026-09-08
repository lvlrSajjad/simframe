// What happens when you do something here.
//
// Keyed by the same layout hash as screen memory, so a screen the map already
// recognises is a screen the graph already knows. Edges are observations, never
// predictions: an edge exists because an action was taken and the result was
// seen, and a screen with no edges is a screen we have nothing to say about.
import fs from 'node:fs';
import path from 'node:path';
import { hashDistance } from './analyze.js';
import * as fingerprint from './fingerprint.js';
import * as matching from './matching.js';
import * as store from './store.js';

const GRAPH_VERSION = 2;
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
  const [key] = Object.keys(step);
  return `${key}:${JSON.stringify(step[key]).slice(0, 40)}`;
}

/** Every fingerprint a node answers to: its canonical one, plus its variants. */
function fingerprintsOf(node) {
  return [{ hash: node.hash, tokens: node.tokens ?? [] }, ...(node.variants ?? [])];
}

function load(udid, screen) {
  const key = typeof screen === 'string' ? { hash: screen, tokens: [] } : screen;
  const entry = store.readJson(path.join(graphDir(udid), `${key.hash}.json`));
  if (entry?.version === GRAPH_VERSION) return entry;
  // The hash may be a variant of a node filed under a different name.
  const byVariant = allNodes(udid).find((n) => (n.variants ?? []).some((v) => v.hash === key.hash));
  if (byVariant) return byVariant;
  return { version: GRAPH_VERSION, hash: key.hash, tokens: key.tokens ?? [], variants: [], edges: [] };
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
      .filter((n) => n?.version === GRAPH_VERSION);
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
  const tabs = labels(/:tab-bar:/);
  if (tabs.length) return tabs.join(' / ');
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
export function record(udid, { from, action, to, kind }) {
  const fromKey = typeof from === 'string' ? { hash: from } : from;
  const toHash = typeof to === 'string' ? to : to?.hash;
  if (!fromKey?.hash || !toHash) return null;
  const node = nearestScreen(udid, fromKey)?.node ?? load(udid, fromKey);
  // Never overwrite the canonical fingerprint with the one we happened to
  // arrive as — that is what variants are for, and rewriting it here would let
  // a node drift screen by screen into something it never was.
  if (!node.tokens?.length && fromKey.tokens?.length) node.tokens = fromKey.tokens;
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
      if (unclaimed && target.hash !== to_ && reading.tokens?.length) {
        addVariant(target, reading);
        save(udid, target);
        existing.count += 1;
        existing.lastSeen = Date.now();
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
    });
  }
  save(udid, node);
  return node;
}

/** What this action did last time, if we have ever seen it here. */
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
  const goal = (h) => h === toHash;
  if (goal(start.node.hash)) return [];

  const byHash = new Map(allNodes(udid).map((n) => [n.hash, n]));
  const seen = new Set([start.node.hash]);
  const queue = [{ hash: start.node.hash, path: [] }];
  while (queue.length) {
    const { hash, path: taken } = queue.shift();
    if (taken.length >= maxDepth) continue;
    const node = byHash.get(hash);
    for (const edge of node?.edges ?? []) {
      if (seen.has(edge.to)) continue;
      const next = [...taken, edge];
      if (goal(edge.to)) return next;
      seen.add(edge.to);
      queue.push({ hash: edge.to, path: next });
    }
  }
  return null;
}

/** Verdicts a verified step can produce. */
export const VERDICTS = ['ok', 'no-visible-change', 'unexpected-screen', 'unexpected-transition', 'unverified'];

/**
 * Compare what happened against what was expected.
 *
 * With no prediction the outcome is `unverified` rather than `ok`: not knowing
 * what should have happened is not evidence that the right thing did.
 */
export function verdict({ prediction, before, after, kind }) {
  if (!before || !after) return { verdict: 'unverified', detail: 'no state to compare' };
  const moved = before !== after;
  if (!prediction) {
    if (!moved) return { verdict: 'no-visible-change', detail: 'the screen did not change, and nothing predicted it would' };
    return { verdict: 'unverified', detail: 'this action has not been seen on this screen before' };
  }
  const expectedMove = prediction.to !== before;
  if (!moved && expectedMove) {
    return { verdict: 'no-visible-change', detail: `expected to reach a different screen (seen ${prediction.count}x)` };
  }
  if (prediction.to !== after) {
    return {
      verdict: 'unexpected-screen',
      detail: `expected the screen this action reached ${prediction.count}x before, and landed somewhere else`,
    };
  }
  if (prediction.kind && kind && prediction.kind !== kind && kind !== 'none') {
    return { verdict: 'unexpected-transition', detail: `expected ${prediction.kind}, saw ${kind}` };
  }
  return { verdict: 'ok', detail: `matches the outcome seen ${prediction.count}x before` };
}
