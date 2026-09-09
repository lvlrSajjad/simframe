// Navigating by memory.
//
// Once the graph knows which screens exist and which action leads from one to
// the next, getting somewhere is a search over known edges rather than a
// question for a model. `goto` plans a path and walks it; a flow is a path
// somebody already walked, saved so it can be walked again.
import { runScript } from './actions.js';
import * as graph from './graph.js';
import * as api from './index.js';
import * as store from './store.js';
import fs from 'node:fs';
import path from 'node:path';

const flowDir = (udid) => path.join(store.deviceDir(udid), 'flows');

/** The signature is lossy; older edges predate `step` and have to be reconstructed. */
export function stepFor(edge) {
  if (edge.step) return edge.step;
  const [kind, rest] = [edge.action.slice(0, edge.action.indexOf(':')), edge.action.slice(edge.action.indexOf(':') + 1)];
  if (kind === 'tap') return { tap: rest };
  if (kind === 'scroll') return { scroll: rest };
  if (kind === 'button') return { button: rest };
  if (kind === 'tapAt') {
    const [x, y] = rest.split(',').map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? { tapAt: { x, y } } : null;
  }
  if (kind === 'swipe') {
    const [from, to] = rest.split('->').map((p) => p.split(',').map(Number));
    return from?.length === 2 && to?.length === 2 ? { swipe: { from, to } } : null;
  }
  return null;
}

/**
 * Walk to a known screen.
 *
 * Fails rather than guesses: if the destination is not in the graph, or the
 * query fits two screens equally, or no path of known edges reaches it, that is
 * reported. A wrong route is worse than no route, because it taps things.
 */
export async function goto(deviceQuery, target, { options, ...runOptions } = {}) {
  const { device } = await api.ensureDaemon(deviceQuery, options);
  const udid = device.udid;

  const found = graph.findScreen(udid, target);
  if (!found) return { ok: false, reason: 'unknown-screen', known: knownScreens(udid) };
  if (found.ambiguous) return { ok: false, reason: 'ambiguous', candidates: found.ambiguous };

  const here = await api.screenIdentity(udid, {});
  if (here.hash === found.node.hash) {
    return { ok: true, already: true, screen: found.name, steps: [] };
  }

  // `hashTokens` returns null for an empty token set on purpose — a constant
  // hash for "I could read nothing" is the self-confirming-emptiness bug. So a
  // screen with no identity has to be reported, not sliced: this threw
  // `Cannot read properties of null (reading 'slice')` instead of answering.
  // Not hypothetical on Android, where README's own table puts the launcher at
  // one token.
  if (!here.hash) return { ok: false, reason: 'no-identity', to: found.name };
  const path_ = graph.route(udid, { hash: here.hash, tokens: here.tokens }, found.node.hash);
  if (!path_) return { ok: false, reason: 'no-route', from: here.hash.slice(0, 8), to: found.name };

  const steps = path_.map(stepFor);
  if (steps.some((s) => !s)) return { ok: false, reason: 'unreplayable-edge', to: found.name };

  const result = await runScript(udid, { steps, stopOnUnexpected: true, ...runOptions });
  const arrived = await api.screenIdentity(udid, {});
  return {
    ok: arrived.hash === found.node.hash,
    screen: found.name,
    steps,
    ranSteps: result.ranSteps,
    results: result.results,
    arrived: arrived.hash ? arrived.hash.slice(0, 8) : null,
  };
}

export function knownScreens(udid) {
  return graph.allNodes(udid).map((n) => ({ name: graph.describe(n), hash: n.hash.slice(0, 8), edges: n.edges.length }));
}

/**
 * Save a flow.
 *
 * Only flows that verified end to end are worth saving: a flow with an
 * unverified step in it is a recording of something that may not have worked,
 * and replaying it faithfully reproduces the doubt.
 */
export function saveFlow(udid, name, script, { force = false } = {}) {
  const verdicts = (script.results ?? []).map((r) => r.verification?.verdict);
  if (!force && verdicts.some((v) => v && v !== 'ok')) {
    return { ok: false, reason: 'unverified-steps', verdicts };
  }
  const dir = flowDir(udid);
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    name,
    savedAt: Date.now(),
    steps: script.steps ?? (script.results ?? []).map((r) => r.step).filter(Boolean),
    startScreen: script.startScreen ?? null,
  };
  store.writeAtomic(path.join(dir, `${encodeURIComponent(name)}.json`), JSON.stringify(body, null, 2));
  return { ok: true, name, steps: body.steps.length };
}

export function loadFlow(udid, name) {
  return store.readJson(path.join(flowDir(udid), `${encodeURIComponent(name)}.json`));
}

export function listFlows(udid) {
  const dir = flowDir(udid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => store.readJson(path.join(dir, f)))
    .filter(Boolean)
    .map((f) => ({ name: f.name, steps: f.steps?.length ?? 0, savedAt: f.savedAt }));
}

export async function runFlow(deviceQuery, name, { options, ...runOptions } = {}) {
  const { device } = await api.ensureDaemon(deviceQuery, options);
  const flow = loadFlow(device.udid, name);
  if (!flow) return { ok: false, reason: 'unknown-flow', known: listFlows(device.udid).map((f) => f.name) };
  const result = await runScript(device.udid, { steps: flow.steps, stopOnUnexpected: true, ...runOptions });
  return { ok: result.ranSteps === flow.steps.length, name, ...result };
}
