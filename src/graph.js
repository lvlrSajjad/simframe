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
      const looksLikeTarget = resembles(target, reading);
      if (unclaimed && looksLikeTarget && target.hash !== to_ && reading.tokens?.length) {
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
function sameScreen(udid, a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (!udid) return false;
  const nodeA = nearestScreen(udid, a)?.node;
  const nodeB = nearestScreen(udid, b)?.node;
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

export function verdict({ udid, prediction, before, after, kind }) {
  if (!before || !after) return { verdict: 'unverified', detail: 'no state to compare' };
  const moved = before !== after;
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
