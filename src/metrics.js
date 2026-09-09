// Phase 10: simframe measuring itself.
//
// Two logs, both JSONL, both per device. `escalations.jsonl` records every
// point where simframe handed a decision back to the agent; `flows.jsonl`
// records one line per flow run. Nothing here changes what simframe does — it
// only writes down what happened, which is the only way the phases after this
// one can be prioritised or proven.
//
// The escalation log is the steering wheel: the reason breakdown decides which
// faculty is built next. So a reason is mandatory, "unknown" is not one of
// them, and every existing hand-back path maps to exactly one of the five.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';

/** The five reasons, from docs/research/03-human-parity.md §8. Nothing else is a reason. */
export const REASONS = [
  'unknown_screen',
  'ambiguous_intent',
  'verification_failed',
  'novel_dialog',
  'no_plan',
];

export const OUTCOMES = ['resolved_locally', 'escalated_to_model', 'failed'];

/**
 * Which faculty would have removed this escalation.
 *
 * This is the mapping that turns the reason breakdown into a phase order, so
 * it lives next to the reasons rather than in prose. `built` is empty today
 * and each phase moves its own faculty into it — see avoidableRate() for why
 * that matters and what the rate honestly means before then.
 */
export const FACULTY = {
  unknown_screen: 'exploration (Phase 14)',
  ambiguous_intent: 'icon semantics (Phase 15)',
  verification_failed: 'sense of time (Phase 11)',
  novel_dialog: 'reflexes (Phase 12)',
  no_plan: 'exploration (Phase 14)',
};

/** Faculties that exist. Empty until Phase 11 lands the first one. */
export const BUILT_FACULTIES = new Set();

function metricPaths(udid) {
  const dir = store.deviceDir(udid);
  return {
    dir,
    escalations: path.join(dir, 'escalations.jsonl'),
    flows: path.join(dir, 'flows.jsonl'),
    baselines: path.join(dir, 'baselines'),
  };
}

export { metricPaths as paths };

/**
 * Append one record. Bookkeeping must never be able to fail a flow, so this
 * swallows — but it swallows loudly enough to be found: the reason lands in
 * `lastWriteError`, which `simframe escalations` prints.
 */
let lastWriteError = null;
export const writeError = () => lastWriteError;

export function appendJsonl(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    return true;
  } catch (err) {
    lastWriteError = `${file}: ${err.message}`;
    return false;
  }
}

/**
 * Read a JSONL log, tolerating a torn last line.
 *
 * Two processes appending is not forbidden here, and a half-written line is a
 * thing to skip rather than a reason to report no history at all.
 */
export function readJsonl(file, { limit } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn append, or something else's file. Skip the line, keep the log. */
    }
  }
  return limit ? out.slice(-limit) : out;
}

export const readEscalations = (udid, opts) => readJsonl(metricPaths(udid).escalations, opts);
export const readFlows = (udid, opts) => readJsonl(metricPaths(udid).flows, opts);

/**
 * Mark an error as an escalation with a reason, at the site that knows why.
 *
 * Only ever adds a property: the message and the error class stay exactly what
 * they were, so nothing above can behave differently for having been told.
 * That is the whole reason classification happens by tagging rather than by
 * matching error strings at the boundary — a regexed message is a reason that
 * silently becomes "unknown" the day somebody rewords it.
 */
export function tag(err, reason, { candidates = [], tried = [] } = {}) {
  if (!REASONS.includes(reason)) throw new Error(`not an escalation reason: ${reason}`);
  err.escalation = { reason, candidates, tried };
  return err;
}

/** The tag an error carries, or null. */
export function escalationOf(err) {
  const e = err?.escalation;
  if (!e || !REASONS.includes(e.reason)) return null;
  return e;
}

/**
 * Steps whose failure is a verification failure rather than a perception one.
 *
 * An assert that did not hold, or a wait that timed out, is simframe saying
 * "I could not confirm this" — which is `verification_failed`, and is a
 * different question from not knowing what is on screen.
 */
const VERIFYING_STEPS = new Set([
  'assert', 'assertText', 'assertGone', 'waitText', 'waitFor', 'settle',
]);

/**
 * The reason a thrown step is an escalation.
 *
 * A tagged error wins, because the site that threw it knew more than this
 * does. Everything else maps by step, and the fallback is
 * `verification_failed` — a step that threw is a step whose effect could not
 * be confirmed. There is no "unknown" branch on purpose.
 */
export function reasonForStepError(step, err) {
  const tagged = escalationOf(err);
  if (tagged) return tagged;
  const action = step?.action;
  if (action === 'confirm' || action === 'chooseAny') return { reason: 'novel_dialog', candidates: [], tried: [] };
  if (VERIFYING_STEPS.has(action)) return { reason: 'verification_failed', candidates: [], tried: [] };
  return { reason: 'verification_failed', candidates: [], tried: [] };
}

/**
 * Which verdicts hand a decision back.
 *
 * `unverified` does not: it means "this action has not been seen here before",
 * which is a fact about the graph and not a question for anybody. The other
 * two are — an unexpected screen halts the flow, and a step that moved nothing
 * leaves the agent to judge whether the flow really did what it says.
 */
export const ESCALATING_VERDICTS = new Set(['unexpected-screen', 'no-visible-change']);

/** How `goto`/`flow run` refusals map. They refuse rather than guess, and the refusal is the hand-back. */
export const PLAN_REASONS = {
  'unknown-screen': 'unknown_screen',
  'no-identity': 'unknown_screen',
  ambiguous: 'ambiguous_intent',
  'no-route': 'no_plan',
  'unreplayable-edge': 'no_plan',
  'unknown-flow': 'no_plan',
};

/** A short, bounded description of a candidate element, for the log. */
export function candidateOf(t) {
  if (!t) return null;
  if (typeof t === 'string') return { label: t.slice(0, 40) };
  return {
    label: typeof t.label === 'string' ? t.label.slice(0, 40) : null,
    x: t.x ?? null,
    y: t.y ?? null,
    region: t.region ?? null,
    score: t.score ?? null,
  };
}

/**
 * What screen this is, for free.
 *
 * Read off what is already on disk — the newest frame's layout hash, and the
 * structural fingerprint screen memory filed under it. A perception pass here
 * would make logging cost something, and an instrumentation phase that slows
 * the thing it measures has broken its own numbers.
 */
export function fingerprintNow(udid, screenmap) {
  try {
    const state = store.readJson(store.paths(udid).state);
    if (!state?.layoutHash) return null;
    const near = screenmap?.recallNearest?.(udid, state.layoutHash);
    return near?.entry?.structuralHash ?? null;
  } catch {
    return null;
  }
}

/**
 * Write one escalation.
 *
 * `tokens_spent` is null and stays null: the schema asks for it, and simframe
 * is on the other side of the model from the thing that counts tokens. A
 * plausible number derived from output length would be a guess wearing a
 * measurement's clothes, and every number in this project is supposed to say
 * where it came from.
 */
export function recordEscalation(udid, {
  flowId = null,
  stepIndex = null,
  fingerprint = null,
  reason,
  candidates = [],
  tried = [],
  outcome = 'escalated_to_model',
  modelTurns = 1,
  wallMs = null,
  detail = null,
} = {}) {
  if (!REASONS.includes(reason)) throw new Error(`not an escalation reason: ${reason}`);
  if (!OUTCOMES.includes(outcome)) throw new Error(`not an escalation outcome: ${outcome}`);
  const record = {
    timestamp: new Date().toISOString(),
    flow_id: flowId,
    step_index: stepIndex,
    screen_fingerprint: fingerprint,
    reason,
    candidate_elements: candidates.map(candidateOf).filter(Boolean).slice(0, 8),
    reflex_or_exploration_tried: tried,
    outcome,
    model_turns_spent: modelTurns,
    tokens_spent: null,
    wall_time_ms: wallMs,
    detail: detail ? String(detail).slice(0, 200) : null,
  };
  appendJsonl(metricPaths(udid).escalations, record);
  return record;
}

/** Write one flow record. Shape is docs/research/03-human-parity.md §1. */
export function recordFlow(udid, record) {
  appendJsonl(metricPaths(udid).flows, record);
  return record;
}

/**
 * Assemble a flow record from what a run already knows.
 *
 * `model_turns` counts the call itself as one, then adds one per escalation
 * the agent has to answer. That is the number the whole series is trying to
 * drive down, so it is defined here rather than left to whoever reads the log.
 */
export function flowRecordFrom({
  flowId,
  flowName = null,
  udid,
  startedAt,
  wallMs,
  stepsTaken,
  totalSteps,
  minSteps = null,
  imagesSent = 0,
  escalations = [],
  verdicts = [],
  completed,
}) {
  const histogram = {};
  for (const v of verdicts) if (v) histogram[v] = (histogram[v] ?? 0) + 1;
  const misTaps = verdicts.filter((v) => ESCALATING_VERDICTS.has(v)).length;
  return {
    flow_id: flowId,
    flow_name: flowName,
    device: udid,
    started_at: new Date(startedAt).toISOString(),
    wall_time_ms: wallMs,
    steps_taken: stepsTaken,
    total_steps: totalSteps,
    min_steps: minSteps,
    step_ratio: minSteps ? Number((stepsTaken / minSteps).toFixed(3)) : null,
    model_turns: 1 + escalations.filter((e) => e.outcome !== 'resolved_locally').length,
    images_sent: imagesSent,
    input_tokens: null,
    output_tokens: null,
    escalations: escalations.map((e) => ({ reason: e.reason, step_index: e.step_index, outcome: e.outcome })),
    escalation_count: escalations.length,
    mis_taps: misTaps,
    verdict_histogram: histogram,
    reflex_firings: [],
    exploration_events: [],
    completed: Boolean(completed),
    wrong_action_taken: verdicts.includes('unexpected-screen'),
  };
}

// ---------------------------------------------------------------- statistics

export function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Quartiles by the "exclusive median" convention: each half excludes the
 * median of an odd-length sample. Named because IQR is meaningless without it.
 */
export function quartiles(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  const lower = s.slice(0, mid);
  const upper = s.length % 2 ? s.slice(mid + 1) : s.slice(mid);
  const p25 = median(lower) ?? s[0];
  const p75 = median(upper) ?? s[s.length - 1];
  return { min: s[0], p25, p50: median(s), p75, max: s[s.length - 1], iqr: p75 - p25, n: s.length };
}

/** The mean that punishes one slow flow, which is why §1 asks for it. */
export function harmonicMean(xs) {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0);
  if (!s.length) return null;
  return s.length / s.reduce((acc, x) => acc + 1 / x, 0);
}

/**
 * HPI, exactly as §1 defines it.
 *
 * `flows` are agent runs (flows.jsonl records); `baselines` maps flow name to
 * a human baseline. A flow with no human baseline gets no HPI_time — reported
 * as null, never as 1.0, because a missing denominator is not parity.
 */
export function hpi({ flows, baselines = {} }) {
  const byName = new Map();
  for (const f of flows) {
    if (!f?.flow_name) continue;
    if (!byName.has(f.flow_name)) byName.set(f.flow_name, []);
    byName.get(f.flow_name).push(f);
  }

  const perFlow = [...byName.entries()].map(([name, runs]) => {
    const agent = quartiles(runs.map((r) => r.wall_time_ms));
    const human = baselines[name]?.wall_time_ms ?? null;
    const humanMedian = human?.p50 ?? null;
    const stepRatios = runs.map((r) => r.step_ratio).filter((x) => Number.isFinite(x));
    return {
      flow: name,
      runs: runs.length,
      agent_ms: agent,
      human_median_ms: humanMedian,
      hpi_time: humanMedian && agent?.p50 ? Number((humanMedian / agent.p50).toFixed(3)) : null,
      step_ratio: median(stepRatios),
      completed: runs.filter((r) => r.completed).length,
      wrong_action: runs.filter((r) => r.wrong_action_taken).length,
      escalations: runs.reduce((acc, r) => acc + (r.escalation_count ?? 0), 0),
      model_turns: median(runs.map((r) => r.model_turns)),
    };
  }).sort((a, b) => a.flow.localeCompare(b.flow));

  const total = flows.length;
  const clean = flows.filter((f) => f.completed && !f.wrong_action_taken).length;
  const accuracy = total ? Number((clean / total).toFixed(3)) : null;
  const times = perFlow.map((f) => f.hpi_time).filter((x) => Number.isFinite(x));
  const hpiTime = harmonicMean(times);
  return {
    flows: perFlow,
    overall: {
      runs: total,
      flows_measured: perFlow.length,
      flows_with_human_baseline: times.length,
      hpi_accuracy: accuracy,
      hpi_time: hpiTime == null ? null : Number(hpiTime.toFixed(3)),
      hpi: hpiTime == null || accuracy == null ? null : Number((accuracy * hpiTime).toFixed(3)),
      step_ratio: median(perFlow.map((f) => f.step_ratio)),
      model_turns_median: median(perFlow.map((f) => f.model_turns)),
    },
  };
}

/**
 * The escalation dashboard.
 *
 * `avoidable` is §8's definition — an escalation whose reason maps to a
 * faculty that is not built yet, or is built and still let it through. One
 * consequence is worth stating rather than hiding: with no faculty built, the
 * rate is 1.0 by construction and says nothing. The per-reason breakdown is
 * the part that decides the next phase, and it is informative today.
 */
export function breakdown(records) {
  const byReason = {};
  for (const r of REASONS) byReason[r] = 0;
  const byScreen = new Map();
  const byOutcome = {};
  let avoidable = 0;
  for (const r of records) {
    if (!REASONS.includes(r?.reason)) continue;
    byReason[r.reason] += 1;
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    // Already avoided locally, so not avoidable by anything unbuilt.
    if (r.outcome !== 'resolved_locally') avoidable += 1;
    const key = r.screen_fingerprint ?? '(no fingerprint)';
    byScreen.set(key, (byScreen.get(key) ?? 0) + 1);
  }
  const total = records.filter((r) => REASONS.includes(r?.reason)).length;
  return {
    total,
    by_reason: byReason,
    by_outcome: byOutcome,
    faculty: Object.fromEntries(
      REASONS.filter((r) => byReason[r]).map((r) => [r, `${FACULTY[r]}${BUILT_FACULTIES.has(FACULTY[r]) ? ' [built]' : ''}`]),
    ),
    avoidable,
    avoidable_escalation_rate: total ? Number((avoidable / total).toFixed(3)) : null,
    top_screens: [...byScreen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([fingerprint, count]) => ({ fingerprint, count })),
    model_turns_spent: records.reduce((acc, r) => acc + (r.model_turns_spent ?? 0), 0),
  };
}

/**
 * How much slower than the committed baseline fails the build.
 *
 * 25%, not the 10% research §1 proposed, and the number is traceable to a
 * measurement rather than to taste. Three HPI measurements of *identical code*
 * on the same device the same afternoon gave HPI_time 0.475, 0.413 and 0.371,
 * and per flow the medians moved up to 18% between runs — a 10% gate would
 * have failed on noise roughly half the time, and a gate that cries wolf gets
 * ignored, which costs more than no gate. Two things narrow the band instead
 * of loosening it further: the gate reads the median of three passes rather
 * than one, and accuracy stays strict at any drop at all. Numbers in
 * docs/BENCHMARKS.md under "What the gate is set to, and why".
 */
export const TIME_REGRESSION = 0.25;

/**
 * The HPI_time a gate should compare: the median across passes when a report
 * has them, and the single measurement when it does not — so a baseline
 * committed before passes existed still gates.
 */
export const gateTime = (o) => o?.hpi_time_median_of_passes ?? o?.hpi_time ?? null;

/**
 * Compare a measurement against the committed baseline.
 *
 * A pure function rather than a few lines inside the CI script, because an
 * untested gate is this project's recurring failure: the packaging check and a
 * fingerprint eval both shipped unable to fail, and both looked exactly like
 * this. Returns the reasons it should fail — empty means pass.
 */
export function gateAgainst(baseline, measured, { timeRegression = TIME_REGRESSION } = {}) {
  const base = baseline?.overall ?? {};
  const now = measured?.overall ?? measured ?? {};
  const baseTime = gateTime(base);
  const nowTime = gateTime(now);
  const failures = [];
  if (base.hpi_accuracy != null && now.hpi_accuracy != null && now.hpi_accuracy < base.hpi_accuracy) {
    failures.push(`HPI_accuracy dropped: ${now.hpi_accuracy} < ${base.hpi_accuracy} (any drop fails)`);
  }
  if (baseTime != null && nowTime != null && nowTime < baseTime * (1 - timeRegression)) {
    failures.push(
      `HPI_time regressed >${timeRegression * 100}%: ${nowTime} < ${(baseTime * (1 - timeRegression)).toFixed(3)}`,
    );
  }
  // A checkout missing the human baseline the committed number was computed
  // against would otherwise pass by having nothing to compare.
  if (baseTime != null && nowTime == null) {
    failures.push('HPI_time is null but the baseline has one — the human baseline it needs is missing from this checkout');
  }
  return failures;
}

/** A flow id that sorts by time and is short enough to read in a log. */
export function newFlowId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
