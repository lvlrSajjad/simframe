/**
 * `simframe map <bundle-id>`: the cartographer on a real device.
 *
 * The crawl itself is in cartographer.js and knows nothing about devices. This
 * is the driver it is handed: every action goes through `runScript` with
 * verification on, exactly as a `sim_do` step does, so each transition is
 * checked against the graph and recorded by it. Nothing here writes the graph
 * directly. The map is a by-product of ordinary verified steps.
 */
import * as actions from './actions.js';
import * as api from './index.js';
import * as cartographer from './cartographer.js';
import * as frontmost from './frontmost.js';
import * as graph from './graph.js';
import * as navigate from './navigate.js';
import * as platform from './platform/index.js';
import * as typed from './typed.js';
import * as view from './view.js';

const READ_LIMIT = 400;

function selectorFor(door, before) {
  // A control with no label is addressed by where it is.
  if (!String(door.label ?? '').trim()) return { tapAt: { x: Math.round(door.x), y: Math.round(door.y) } };
  const same = (before?.rows ?? []).filter((r) => String(r.label ?? '').trim() === String(door.label).trim());
  // A label that names one thing is the replayable selector. Two things wearing
  // it means the label is not an address; the point is.
  return same.length <= 1 ? { tap: door.label } : { tapAt: { x: Math.round(door.x), y: Math.round(door.y) } };
}

/** The driver the crawl is handed, for one device and one app. */
export function deviceDriver(udid, bundle, { options = {} } = {}) {
  let appPid = null;
  const flowName = `map ${bundle}`;
  const run = (steps, extra = {}) => actions.runScript(udid, { steps, options, flowName, stopOnUnexpected: true, ...extra });

  const read = async () => {
    const m = await view.screenMap(udid, { options, limit: READ_LIMIT });
    return {
      hash: m.identity?.hash ?? null,
      tokens: m.identity?.tokens ?? [],
      name: m.name ?? null,
      rows: m.rows ?? [],
      keyboard: Boolean(m.identity?.keyboard),
    };
  };

  return {
    read,
    async launch({ relaunch = false } = {}) {
      await run([{ launch: { value: bundle, relaunch } }]);
      appPid = (await frontmost.read(udid)).pid;
      return read();
    },
    async relaunchBlocked() {
      const needs = await platform.relaunchNeeds(udid, bundle).catch(() => null);
      return needs && !needs.running ? `it is ${needs.detail}` : null;
    },
    async inApp() {
      // "Cannot say" is not "somewhere else", and neither is one read taken
      // mid-transition: the front can belong to the system for a moment while
      // a sheet or the app itself animates. Measured on Ecotrak: three false
      // "left the app" in one 43 s run. Out means out on three reads.
      for (let i = 0; i < 3; i += 1) {
        const { pid } = await frontmost.read(udid);
        if (pid == null || appPid == null || pid === appPid) return true;
      }
      return false;
    },
    async tap(door, before) {
      const res = await run([selectorFor(door, before)]);
      const r = res.results?.[0] ?? {};
      // A wrong turn with stopOnUnexpected arrives as a failed step whose error
      // names the verdict, not as a verification object.
      const named = /\b(unexpected-[a-z-]+)/.exec(String(r.error ?? ''))?.[1] ?? null;
      return {
        ok: res.ok,
        verdict: r.verification?.verdict ?? named,
        detail: r.error ?? r.note ?? null,
      };
    },
    async back(here) {
      const rows = here?.rows ?? [];
      // A dialog first: nothing behind it can be reached until it is dismissed.
      const affordance = cartographer.dialogDismiss(rows)
        ?? rows.find((r) => r.region === 'nav-bar' && cartographer.isBackAffordance(r))
        ?? rows.find((r) => cartographer.isBackAffordance(r));
      const step = affordance
        ? selectorFor({ label: affordance.label, x: affordance.x, y: affordance.y }, here)
        // The system's own back gesture, from the leading edge.
        : { swipe: { from: [6, 420], to: [320, 420] } };
      const res = await run([step]);
      return { acted: res.ranSteps > 0, via: affordance ? `"${affordance.label}"` : 'edge swipe' };
    },
    // By reading, not by bare hash: the graph files an edge under the stored
    // screen a reading resembles, which may carry a different hash than this
    // reading, and a bare hash only ever matches exactly.
    // Cheap: a state read, not a screen map. Did anything move since `here`?
    async stillHere(here) {
      const id = await api.screenIdentity(udid, { options, confirmNovel: false }).catch(() => null);
      return !id?.hash || id.hash === here.hash || graph.sameScreen(udid, here, id);
    },
    route: (from, to) => {
      const target = graph.nearestScreen(udid, to)?.node?.hash ?? to.hash;
      return graph.route(udid, from, target);
    },
    async walk(route) {
      const steps = route.map(navigate.stepFor);
      // A route that would type is not walked by a crawl: it has no text to
      // give, and the read-only rule says it would not type it anyway.
      if (steps.some((s) => !s || typed.needsText(s))) return { steps: 0, after: null };
      const res = await run(steps);
      return { steps: res.ranSteps ?? 0, after: null };
    },
    sameScreen: async (a, b) => graph.sameScreen(udid, a, b),
  };
}

/**
 * Map an app: resume its saved state, crawl within the budget, save, report.
 * Returns `{ state, coverage, text }`.
 */
export async function map(deviceQuery, bundle, {
  options = {},
  minutes = 10,
  maxActions = 200,
  allowCreate = false,
  fresh = false,
} = {}) {
  if (!bundle) throw new Error('usage: simframe map <bundle-id> [--minutes=10] [--actions=200] [--allow-create] [--fresh]');
  const { device } = await api.ensureDaemon(deviceQuery, options);
  const udid = device.udid;
  const state = fresh ? null : cartographer.loadState(udid, bundle);
  const result = await cartographer.crawl(deviceDriver(udid, bundle, { options }), {
    bundle,
    budgetMs: Math.max(1, Number(minutes)) * 60 * 1000,
    maxActions: Math.max(1, Number(maxActions)),
    allowCreate,
    state: state && Object.keys(state.screens).length ? state : null,
    persist: (s) => cartographer.saveState(udid, s),
  });
  cartographer.saveState(udid, result);
  const coverage = cartographer.coverage(result);
  return { device, state: result, coverage, text: cartographer.renderReport(coverage) };
}
