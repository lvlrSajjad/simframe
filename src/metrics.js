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
 * What the executor observed after a supervisor ruling — the field that makes a
 * ruling scoreable rather than merely recorded.
 *
 * A ruling on its own says what the supervisor thought. Three items on the
 * deferred list (101's p95 replay, 106's cost of the steps a `stop` skipped,
 * 96's response variable) need what happened *next*, and until now nothing
 * persisted a ruling at all: they went into a `supervisions` array on the
 * result and died with the process. Three rulings had ever existed anywhere.
 *
 * Closed, and mandatory, for the same reason `REASONS` is: a vocabulary that
 * admits "other" collects a pile of "other".
 */
export const RULING_OUTCOMES = ['recovered', 'still_failed', 'stopped', 'no_ruling'];

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

/**
 * Faculties that exist.
 *
 * Phase 11 landed the first one, so `verification_failed` no longer maps to
 * something unbuilt — which changes what those records *mean*. Before, they
 * were a queue waiting on a phase. Now they are evidence that the phase which
 * shipped is not sufficient, and that is a more useful thing for the log to be
 * able to say than a count of things nobody has written yet.
 */
export const BUILT_FACULTIES = new Set(['sense of time (Phase 11)']);

function metricPaths(udid) {
  const dir = store.deviceDir(udid);
  return {
    dir,
    escalations: path.join(dir, 'escalations.jsonl'),
    flows: path.join(dir, 'flows.jsonl'),
    supervisions: path.join(dir, 'supervisions.jsonl'),
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
export const readSupervisions = (udid, opts) => readJsonl(metricPaths(udid).supervisions, opts);

/**
 * Write down one supervisor ruling and what came of it.
 *
 * The fields are chosen so the three items waiting on this can be answered
 * **offline, from the log**, rather than by another device run:
 *
 * - `screen`/`edge` — which `(screen_hash, action)` the ruling was about, so
 *   rulings can be grouped by edge the way the graph groups timings.
 * - `p95`/`samples` — what the graph knew about that edge **at the moment of
 *   the ruling**. Recording it now rather than looking it up later is the
 *   difference between 101 being arithmetic and 101 being archaeology: the
 *   graph keeps learning, so a p95 read next week is not the p95 the
 *   supervisor was implicitly competing with.
 * - `stillMs` — the same input the supervisor got, so a replay sees what it saw.
 * - `expect` — the plan's own note, because a ruling made with a briefing and
 *   one made without are not the same measurement (96's critical arm).
 * - `outcome` — what the executor observed afterwards. Mandatory.
 *
 * `from` separates a deterministic rule from a model answer. Both are rulings
 * and both have outcomes, but a comparison that mixed them would credit the
 * model for what a two-line rule decided.
 */
export function recordSupervision(udid, {
  session, index, step, edge, screen, decision, from, reason, ms,
  stillMs, p95, samples, expect, failure, outcome, supervisor, situation,
}) {
  // Swallowed rather than thrown, unlike `recordEscalation`'s guard, and the
  // difference is deliberate: this is called from inside a flow's failure
  // handler, where a throw would turn a recoverable step failure into a crash.
  // It still lands in `lastWriteError`, which `simframe escalations` prints.
  if (!RULING_OUTCOMES.includes(outcome)) {
    lastWriteError = `supervision outcome must be one of ${RULING_OUTCOMES.join('/')}, got ${JSON.stringify(outcome)}`;
    return false;
  }
  return appendJsonl(metricPaths(udid).supervisions, {
    timestamp: new Date().toISOString(),
    session_id: session ?? SESSION_ID,
    client: CLIENT,
    step_index: index ?? null,
    step: step ?? null,
    edge: edge ?? null,
    screen_fingerprint: screen ?? null,
    decision,
    from: from ?? 'model',
    // *Which* judge, not just that there was one.
    //
    // Every arm of the capacity comparison writes to this one log, and without
    // this field a population collected under Apple and one collected under a
    // 14B are one undifferentiated file — the comparison the owner asked for
    // would be unreadable from its own data. `from` says rule-or-model; this
    // says which model.
    supervisor: supervisor ?? null,
    // The question, not only the answer. Without it, asking a second judge
    // about the same situations means driving the device a second time — which
    // puts the device's own variance inside a comparison that is about the
    // judges. Null for a rule-sourced ruling, which never composed one.
    situation: situation ?? null,
    // Recorded, never presented as the ground for what happened: the supervisor
    // has returned a correct decision with a reason citing a rule that did not
    // apply. Keeping it is how that stays measurable instead of anecdotal.
    reason: reason ? String(reason).slice(0, 200) : null,
    latency_ms: Number.isFinite(ms) ? Math.round(ms) : null,
    still_ms: Number.isFinite(stillMs) ? Math.round(stillMs) : null,
    edge_p95_ms: Number.isFinite(p95) ? Math.round(p95) : null,
    edge_samples: Number.isFinite(samples) ? samples : null,
    expect: expect ? String(expect).slice(0, 200) : null,
    failure: failure ? String(failure).slice(0, 300) : null,
    outcome,
  });
}

/**
 * What the ruling log currently says, and whether it can yet answer 101.
 *
 * Deliberately counts rather than scores. Item 101 asks which `wait`/`retry`
 * rulings a p95-per-edge lookup would have got right, and that is a separate
 * piece of work; what this answers is the question that comes first and was
 * embarrassing to get wrong once already — **is there a population to measure
 * at all, and do its rows carry the fields the measurement needs.** `p95_known`
 * is that readiness check: a ruling recorded on an edge the graph had never
 * timed cannot take part in the comparison, however many of them there are.
 */
export function supervisionBreakdown(records) {
  const by = (key) => {
    const out = {};
    for (const r of records) {
      const k = r[key] ?? 'unknown';
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const matrix = {};
  for (const r of records) {
    const k = `${r.decision ?? 'unknown'} -> ${r.outcome ?? 'unknown'}`;
    matrix[k] = (matrix[k] ?? 0) + 1;
  }
  const timed = records.filter((r) => Number.isFinite(r.edge_p95_ms));
  const latencies = records.map((r) => r.latency_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return {
    total: records.length,
    by_decision: by('decision'),
    by_outcome: by('outcome'),
    by_from: by('from'),
    decision_to_outcome: matrix,
    // Readiness for 101, not a result for it.
    p95_known: timed.length,
    p95_unknown: records.length - timed.length,
    sessions: [...new Set(records.map((r) => r.session_id).filter(Boolean))],
    median_latency_ms: latencies.length ? latencies[latencies.length >> 1] : null,
  };
}

/**
 * Mark an error as an escalation with a reason, at the site that knows why.
 *
 * Only ever adds a property: the message and the error class stay exactly what
 * they were, so nothing above can behave differently for having been told.
 * That is the whole reason classification happens by tagging rather than by
 * matching error strings at the boundary — a regexed message is a reason that
 * silently becomes "unknown" the day somebody rewords it.
 */
export function tag(err, reason, { candidates = [], tried = [], ambiguous = false, intent = null } = {}) {
  if (!REASONS.includes(reason)) throw new Error(`not an escalation reason: ${reason}`);
  // `ambiguous` is narrower than the reason, and that is the point. Two very
  // different failures both tag `ambiguous_intent`: the target is on screen
  // several times over, and the target is not on screen at all on a screen we
  // thought we knew. Only the first is resolvable by *choosing*, and only the
  // first tells a waiting caller that waiting is pointless — the thing it is
  // waiting for has already arrived.
  // `intent` is the goal in the caller's own words, recorded as a field rather
  // than left in the prose of `detail`.
  //
  // Phase 17's go/no-go asks whether an on-device model would pick the element
  // Claude picked, given the goal and the element list. The element list is
  // here as `candidates` and the eventual choice is recoverable from the
  // graph — the tap that finally worked on this screen becomes a verified edge
  // carrying its own step. The goal was the missing third, and it was sitting
  // inside a sentence: `"X" matches 3 things on this screen — say which…`.
  // Regexing it back out at export time is the exact habit this file exists to
  // avoid, and it would silently return nothing the day that sentence is
  // reworded.
  err.escalation = { reason, candidates, tried, ambiguous, intent };
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
  if (tagged) return { ...tagged, classified: true };
  const action = step?.action;
  if (action === 'confirm' || action === 'chooseAny') {
    return { reason: 'novel_dialog', candidates: [], tried: [], classified: true };
  }
  // Everything else is a *fallback*, and it now says so.
  //
  // This had two branches that returned the same value, which made it look
  // like it discriminated. It does not: any step that threw without a site
  // tagging it lands here. In a real field session that was **90% of all
  // escalations** — and `FACULTY` then reported every one of them as evidence
  // against "sense of time (Phase 11)", a claim nothing in the record supports.
  //
  // The tester's own first call failed with `unknown step "wait_for"` — a typo
  // — and that too would be filed as evidence about which faculty to build
  // next. CLAUDE.md calls this log the steering wheel; a steering wheel that
  // pools typos, inert controls and slow lists into one reason is pointing
  // somewhere nobody chose.
  //
  // No sixth reason: "unknown is not a reason" stays, and a vocabulary that
  // admits "other" collects a pile of "other". What changes is that the record
  // carries whether the reason was *read off the failure* or *assumed*, and
  // the report declines to recommend a faculty for the assumed ones.
  return { reason: 'verification_failed', candidates: [], tried: [], classified: false };
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
  // A route that ran and did not land. Not `no_plan`: there *was* a plan and it
  // was followed — what could not be confirmed is that it worked, which is what
  // `verification_failed` means everywhere else in this file.
  'route-halted': 'verification_failed',
  'arrived-elsewhere': 'verification_failed',
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
/**
 * Which run of which program wrote a record.
 *
 * The log is per-device and, until now, anonymous — so two agents driving one
 * booted simulator wrote one interleaved file with no way to separate them.
 * Measured on the bench device in a single evening: 57 records to 81, a third
 * of the new ones naming screens from an app the suite has never launched.
 *
 * That is not a corrupted file, it is a corrupted instrument. CLAUDE.md makes
 * the reason breakdown of this log the thing that chooses which faculty gets
 * built next, and a breakdown that silently pools two sessions errs toward
 * whichever of them made more mistakes — which is not the same question as
 * which faculty is missing.
 *
 * A pid alone would not do: pids are reused, and the useful grouping is "one
 * agent's run", which for the MCP server is the life of the process and for
 * the CLI is a single command. So: the start time, the pid, and a random tail,
 * computed once per process. `client` says what kind of process it was, since
 * "the MCP server did this" and "somebody ran a CLI command" deserve different
 * readings of the same reason.
 *
 * Deliberately not a device id, a username, or anything about the machine. This
 * file is committed to a public repo in summary form, and the question it has
 * to answer is "was this all one agent", which needs no identity to answer.
 */
const SESSION_ID = process.env.SIMFRAME_SESSION
  ? String(process.env.SIMFRAME_SESSION).slice(0, 64)
  : `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/*
 * Minting the id from the pid was right for the MCP server, which is one
 * long-lived process, and wrong for everything else. A CLI-driven agent starts
 * a process per command, so it got one "session" per command: on the benchmark
 * device, 33 session ids for 46 records, 30 of them holding a single record.
 * `escalations --session` was therefore unable to answer the one question it
 * exists for, and Phase 17's go/no-go step 1 — "filter to one session id" —
 * had nothing to filter. `SIMFRAME_SESSION` lets a caller that knows it is one
 * session say so; the per-process id stays the default.
 */

/** How this process is being used, for reading a breakdown afterwards. */
function clientKind() {
  const argv = process.argv.join(' ');
  if (/\bmcp\b/.test(argv)) return 'mcp';
  if (/bench-hpi|scripts\//.test(argv)) return 'script';
  if (/cli\.js|\bsimframe\b/.test(argv)) return 'cli';
  return 'library';
}
const CLIENT = clientKind();

/** The session this process's records belong to. Exported for `escalations`. */
export const sessionId = () => SESSION_ID;
export const clientName = () => CLIENT;

export function recordEscalation(udid, {
  flowId = null,
  flowName = null,
  intent = null,
  stepIndex = null,
  fingerprint = null,
  reason,
  candidates = [],
  tried = [],
  outcome = 'escalated_to_model',
  modelTurns = 1,
  wallMs = null,
  detail = null,
  // Was this reason read off the failure, or assumed because nothing said?
  // Default `false`, so a caller that does not think about it cannot
  // accidentally claim precision it does not have.
  classified = false,
} = {}) {
  if (!REASONS.includes(reason)) throw new Error(`not an escalation reason: ${reason}`);
  if (!OUTCOMES.includes(outcome)) throw new Error(`not an escalation outcome: ${outcome}`);
  const record = {
    timestamp: new Date().toISOString(),
    // Added after the log turned out to pool two agents' work invisibly. Both
    // are cheap and neither is derivable afterwards, which is the test for
    // whether a field belongs in a log at all.
    session_id: SESSION_ID,
    client: CLIENT,
    flow_id: flowId,
    flow_name: flowName,
    // What was asked for, in the caller's words. Ground truth for Phase 17's
    // go/no-go, and on its own it answers "what kind of decision is costing us".
    intent: intent ? String(intent).slice(0, 120) : null,
    classified: Boolean(classified),
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

/**
 * The p-th percentile, by nearest-rank on the sorted sample.
 *
 * Nearest-rank rather than interpolation: with the 5-50 samples a graph edge
 * carries, an interpolated p95 invents a value between two observations, and
 * every number here is supposed to be one that actually happened.
 */
export function percentile(xs, p) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
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
export function breakdown(records, { session = null, flow = null } = {}) {
  const byReason = {};
  const classifiedByReason = {};
  const assumedByReason = {};
  for (const r of REASONS) { byReason[r] = 0; classifiedByReason[r] = 0; assumedByReason[r] = 0; }
  const byScreen = new Map();
  const byOutcome = {};
  const bySession = new Map();
  const byFlow = new Map();
  let avoidable = 0;
  let unattributed = 0;
  // Filtering happens here rather than at the call site so `total` and every
  // rate below it describe the same set of records.
  const kept = records.filter((r) => (session ? r?.session_id === session : true))
    .filter((r) => (flow ? r?.flow_name === flow : true));
  for (const r of kept) {
    if (!REASONS.includes(r?.reason)) continue;
    // Records written before sessions were recorded cannot be attributed, and
    // saying how many there are is the difference between a breakdown that
    // pools two agents and one that says it might be.
    if (r.session_id) {
      const key = `${r.session_id}|${r.client ?? '?'}`;
      bySession.set(key, (bySession.get(key) ?? 0) + 1);
    } else {
      unattributed += 1;
    }
    if (r.flow_name) byFlow.set(r.flow_name, (byFlow.get(r.flow_name) ?? 0) + 1);
    byReason[r.reason] += 1;
    // Three states, not two. A record written before this field existed makes
    // no claim either way, and folding it in with "assumed" would make an old
    // log look like a diagnosis failure — a warning that cries wolf is how a
    // real one gets ignored, which this file already knows in another place.
    if (r.classified === true) classifiedByReason[r.reason] += 1;
    else if (r.classified === false) assumedByReason[r.reason] += 1;
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    // Already avoided locally, so not avoidable by anything unbuilt.
    if (r.outcome !== 'resolved_locally') avoidable += 1;
    const key = r.screen_fingerprint ?? '(no fingerprint)';
    byScreen.set(key, (byScreen.get(key) ?? 0) + 1);
  }
  const total = kept.filter((r) => REASONS.includes(r?.reason)).length;
  const sessions = [...bySession.entries()]
    .map(([key, count]) => {
      const [id, client] = key.split('|');
      return { session_id: id, client, count };
    })
    .sort((a, b) => b.count - a.count);
  return {
    total,
    // The log is per-device and shared: two agents on one booted simulator
    // write one interleaved file. More than one session here means the counts
    // below are a pool, and CLAUDE.md uses those counts to choose a phase.
    sessions,
    session_count: sessions.length,
    unattributed,
    // Any unattributed record at all makes this a pool: the whole point is
    // that they cannot be told apart, and 92 of them is not "one session".
    pooled: sessions.length > 1 || unattributed > 0,
    by_flow: Object.fromEntries([...byFlow.entries()].sort((a, b) => b[1] - a[1])),
    by_reason: byReason,
    // How many of each reason were *read off the failure* rather than assumed.
    //
    // The breakdown above picks the next phase, so its precision has to be
    // visible in it. A reason that is mostly assumed is not a finding about an
    // app; it is a count of things nothing could classify, and reading it as a
    // verdict on a faculty is how the instrument came to disagree with a
    // tester who was right.
    classified_by_reason: classifiedByReason,
    assumed_by_reason: assumedByReason,
    by_outcome: byOutcome,
    // Only where the reason was actually read. A faculty named against a pile
    // of assumptions is advice with nothing behind it.
    faculty: Object.fromEntries(
      REASONS.filter((r) => classifiedByReason[r]).map((r) => [r, `${FACULTY[r]}${BUILT_FACULTIES.has(FACULTY[r]) ? ' [built]' : ''}`]),
    ),
    avoidable,
    avoidable_escalation_rate: total ? Number((avoidable / total).toFixed(3)) : null,
    top_screens: [...byScreen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([fingerprint, count]) => ({ fingerprint, count })),
    // `kept`, not `records` — a filtered breakdown that reports the whole
    // log's model turns is the same class of mistake as pooling two sessions.
    model_turns_spent: kept.reduce((acc, r) => acc + (r.model_turns_spent ?? 0), 0),
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
