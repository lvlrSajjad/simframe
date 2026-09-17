// Navigating by memory.
//
// Once the graph knows which screens exist and which action leads from one to
// the next, getting somewhere is a search over known edges rather than a
// question for a model. `goto` plans a path and walks it; a flow is a path
// somebody already walked, saved so it can be walked again.
import { runScript } from './actions.js';
import * as graph from './graph.js';
import * as metrics from './metrics.js';
import * as screenmap from './screenmap.js';
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
 * A refusal to act, written down.
 *
 * `goto` and `flow run` refuse rather than guess, and a refusal is exactly
 * "the tool handed the decision back" — the thing the escalation log exists to
 * count. The reason mapping lives in metrics.PLAN_REASONS so the five reasons
 * have one owner.
 */
function refuse(udid, result, { detail = null, flowName = null } = {}) {
  try {
    const reason = metrics.PLAN_REASONS[result.reason];
    if (reason) {
      metrics.recordEscalation(udid, {
        reason,
        // Read, not assumed. `recordEscalation` defaults `classified` to false
        // so a careless caller cannot claim precision it does not have, which
        // is right — and this caller is not careless: `result.reason` is a
        // named refusal (`no-route`, `unreplayable-edge`, `unknown-flow`,
        // `arrived-elsewhere`…) and PLAN_REASONS maps it deterministically.
        // Saying nothing filed 82 records on the bench device as "reason
        // assumed" when the reason was known exactly, which makes the log
        // understate its own knowledge and the report decline to name a
        // faculty it was entitled to name.
        classified: true,
        // A refusal by `goto` is about a destination and one by `flow run` is
        // about a named flow. Either is what a breakdown wants to group by.
        flowName,
        fingerprint: metrics.fingerprintNow(udid, screenmap),
        outcome: 'escalated_to_model',
        detail: detail ?? result.reason,
      });
    }
  } catch {
    /* a log that cannot be written must not change what is returned */
  }
  return result;
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
  if (!found) return refuse(udid, { ok: false, reason: 'unknown-screen', known: knownScreens(udid) }, { detail: `no screen matches "${target}"`, flowName: `goto:${target}` });
  if (found.ambiguous) return refuse(udid, { ok: false, reason: 'ambiguous', candidates: found.ambiguous }, { detail: `"${target}" fits ${found.ambiguous.length} screens`, flowName: `goto:${target}` });

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
  if (!here.hash) return refuse(udid, { ok: false, reason: 'no-identity', to: found.name }, { flowName: `goto:${target}` });
  const path_ = graph.route(udid, { hash: here.hash, tokens: here.tokens }, found.node.hash);
  if (!path_) return refuse(udid, { ok: false, reason: 'no-route', from: here.hash.slice(0, 8), to: found.name }, { flowName: `goto:${target}` });

  const steps = path_.map(stepFor);
  if (steps.some((s) => !s)) return refuse(udid, { ok: false, reason: 'unreplayable-edge', to: found.name }, { flowName: `goto:${target}` });

  const result = await runScript(udid, { steps, stopOnUnexpected: true, ...runOptions });
  const arrived = await api.screenIdentity(udid, {});
  const walk = {
    screen: found.name,
    steps,
    ranSteps: result.ranSteps,
    results: result.results,
    arrived: arrived.hash ? arrived.hash.slice(0, 8) : null,
  };
  if (arrived.hash === found.node.hash) return { ok: true, ...walk };

  // A walk that ran and did not land had no name, and it was the only outcome
  // here that did not.
  //
  // Every refusal above is named, logged and groupable; this one returned
  // `{ok: false}` with no `reason` at all, so `simframe goto <known hash>` on
  // CI failed the check that says *"it either walks there or names why it
  // cannot"* with an empty detail — which is exactly what the check is for, and
  // it had been sitting under an outcome nobody had named rather than under a
  // crash.
  //
  // Two names, because they are two different faults and only one of them is
  // about the graph. `route-halted` means a step on the route failed, which is
  // an ordinary failure of the app or the moment. `arrived-elsewhere` means
  // every step ran and we are *not where the graph promised* — an edge it
  // remembers is wrong, and that is worth reading as a claim about memory
  // rather than about this attempt.
  const reason = !arrived.hash
    ? 'no-identity'
    : (result.ranSteps < steps.length ? 'route-halted' : 'arrived-elsewhere');
  return refuse(udid, { ok: false, reason, to: found.name, ...walk }, {
    detail: reason === 'arrived-elsewhere'
      ? `route to "${found.name}" ran to the end and landed on ${walk.arrived}`
      : `route to "${found.name}" stopped after ${result.ranSteps} of ${steps.length} step(s)`,
    flowName: `goto:${target}`,
  });
}

export function knownScreens(udid) {
  // A listing needs a handle for every row, so an unnamed screen falls back to
  // its own short hash here — where it is plainly the hash column's value and
  // not a title in quotes.
  return graph.allNodes(udid).map((n) => ({ name: graph.describe(n) ?? n.hash.slice(0, 8), hash: n.hash.slice(0, 8), edges: n.edges.length }));
}

/**
 * A verdict that is evidence *against* a step, as opposed to no evidence yet.
 *
 * This distinction is the whole of the fix below. `unexpected-*` means the step
 * did something other than what memory predicted — a real objection. `unverified`
 * means this edge has never been walked before, which on a first traversal is
 * true of every step by definition and says nothing about whether it worked.
 */
const CONTRADICTED = /^unexpected/;

/**
 * Save a flow.
 *
 * The rule was "only flows that verified end to end", and it was right about
 * replay safety and wrong about arithmetic: **a first successful traversal is
 * all-`unverified` by construction**, so nothing could ever be recorded, so
 * `sim_flow_run` was unreachable. A field report hit it on a clean 10-of-10
 * batch — *"I never obtained a saved flow, so `sim_flow_run` went untested"* —
 * and it matters far more than its severity suggests: a replayed flow costs
 * **zero model calls**, which is the only path to human-level wall clock. A
 * gate nobody can pass protects nothing and blocks the fastest thing here.
 *
 * So the refusal now needs evidence against a step, not the absence of evidence
 * for it. A flow that ran every step with nothing contradicted saves as
 * **provisional**, and one clean replay promotes it — a bootstrap in two runs,
 * where the second run is the confirmation and is useful anyway.
 *
 * Still refused, because these are real objections: any `unexpected-*` verdict,
 * and a flow that did not reach its own last step.
 */
export function saveFlow(udid, name, script, { force = false } = {}) {
  const results = script.results ?? [];
  const verdicts = results.map((r) => r.verification?.verdict);
  const contradicted = verdicts.filter((v) => v && CONTRADICTED.test(v));
  const ranAll = script.ranSteps == null
    || script.steps == null
    || script.ranSteps >= (script.steps?.length ?? 0);
  // A step that ran and failed is not a step that ran.
  //
  // `ranSteps` counts steps *attempted*, and a failing step stops the batch —
  // so a run whose failure is on the **last** step has `ranSteps === steps.length`
  // and passed the gate above. A peer watched `FLOW FAILED — 4 ok, 1 failed (of
  // 5)` save itself as a flow, which is a flow guaranteed to fail forever. The
  // predicate wanted "every step succeeded" and was written as "every step was
  // reached"; on every run except one they are the same sentence.
  //
  // `!r.ok` rather than `r.ok === false` on purpose: a result that does not say
  // it succeeded has not said it succeeded, and a gate that only catches an
  // explicit `false` is one absent field away from being unable to fail.
  const failedSteps = results.filter((r) => !r.ok);
  if (!force && contradicted.length) {
    return { ok: false, reason: 'contradicted-steps', verdicts };
  }
  if (!force && failedSteps.length) {
    return { ok: false, reason: 'failed-steps', verdicts, failed: failedSteps.map((r) => r.index ?? null) };
  }
  if (!force && !ranAll) {
    return { ok: false, reason: 'incomplete-run', verdicts };
  }
  // Provisional whenever any step lacked a confirming verdict. Recorded on the
  // flow rather than inferred later, so a replay can promote it and a listing
  // can say which flows are still on their first observation.
  const provisional = verdicts.some((v) => !v || v !== 'ok');
  const dir = flowDir(udid);
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    name,
    savedAt: Date.now(),
    steps: script.steps ?? (script.results ?? []).map((r) => r.step).filter(Boolean),
    startScreen: script.startScreen ?? null,
    ...(provisional ? { provisional: verdicts.filter(Boolean) } : {}),
  };
  store.writeAtomic(path.join(dir, `${encodeURIComponent(name)}.json`), JSON.stringify(body, null, 2));
  return { ok: true, name, steps: body.steps.length, provisional };
}

/**
 * A provisional flow that replays cleanly becomes a confirmed one.
 *
 * The second half of the bootstrap. Without it "provisional" would be a label
 * that never comes off, and the honest state of a flow that has now worked
 * twice is "confirmed".
 */
export function confirmFlow(udid, name) {
  const flow = loadFlow(udid, name);
  if (!flow?.provisional) return false;
  const { provisional, ...rest } = flow;
  store.writeAtomic(
    path.join(flowDir(udid), `${encodeURIComponent(name)}.json`),
    JSON.stringify({ ...rest, confirmedAt: Date.now() }, null, 2),
  );
  return true;
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
    // `provisional` travels with the listing, for two reasons. A caller should
    // be able to see which of their flows are still on a first observation
    // without opening the file — and without it the integration check that
    // asserts promotion reads `undefined`, which is always falsy, so the check
    // would pass whether or not anything was promoted. A vacuous check is worse
    // than no check.
    .map((f) => ({
      name: f.name,
      steps: f.steps?.length ?? 0,
      savedAt: f.savedAt,
      ...(f.provisional ? { provisional: true } : {}),
    }));
}

export async function runFlow(deviceQuery, name, { options, ...runOptions } = {}) {
  const { device } = await api.ensureDaemon(deviceQuery, options);
  const flow = loadFlow(device.udid, name);
  if (!flow) return refuse(device.udid, { ok: false, reason: 'unknown-flow', known: listFlows(device.udid).map((f) => f.name) }, { detail: `no saved flow "${name}"`, flowName: name });
  // A replayed flow knows its own name, so its record can be compared against
  // a human doing the same thing. `minSteps` comes from the flow definition or
  // stays null — the step count of a recorded route is not a claim about the
  // shortest one.
  // Is this the screen the flow was recorded on?
  //
  // Reported, not refused, and the distinction is deliberate. A replay from the
  // wrong screen is mostly self-limiting — the first selector does not resolve
  // and the run stops one step in, and the destructive vocabulary is barred by
  // the verify barrier either way. Refusing on a mismatch would put the exact
  // failure mode of item 174 — content-driven screens fragmenting into several
  // identities — in front of the one path that costs zero model calls. So this
  // says what it saw and lets the run proceed, which also measures how often
  // the mismatch is spurious. If it turns out to be rare, it can become a gate;
  // deciding that by reasoning is how 174 got built in the first place.
  let startedElsewhere = null;
  if (flow.startScreen?.hash) {
    try {
      const here = await api.screenIdentity(device.udid, {});
      if (here.hash && !graph.sameScreen(device.udid, here, flow.startScreen)) {
        startedElsewhere = { recorded: flow.startScreen.hash.slice(0, 8), here: here.hash.slice(0, 8) };
      }
    } catch {
      /* not knowing where we are is not a reason to refuse to try */
    }
  }
  const result = await runScript(device.udid, {
    steps: flow.steps,
    stopOnUnexpected: true,
    flowName: name,
    minSteps: flow.minSteps ?? null,
    ...runOptions,
  });
  // Same arithmetic as `saveFlow`, and the same defect: reaching the last step
  // is not passing it. `result.ok` is the run's own verdict and was ignored
  // here, so a replay that failed on its final assert promoted the flow it had
  // just disproved. Both of a peer's saved flows were marked confirmed by
  // replays that failed; the word "clean" in "confirmed by one clean replay"
  // did not exist in the code path.
  const everyStepPassed = (result.results ?? []).every((r) => r.ok);
  const ok = result.ok !== false && everyStepPassed && result.ranSteps === flow.steps.length;
  // A clean replay is the confirmation a first traversal could not give.
  // Only when nothing was contradicted — a replay that ran to the end while
  // objecting to a step is not a promotion.
  const objected = (result.results ?? []).some((r) => CONTRADICTED.test(r.verification?.verdict ?? ''));
  const promoted = ok && !objected ? confirmFlow(device.udid, name) : false;
  return { ok, name, ...result, ...(promoted ? { promoted: true } : {}), ...(startedElsewhere ? { startedElsewhere } : {}) };
}
