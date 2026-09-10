// The batch engine. A flow that would cost one model round trip per tap runs
// here as a single call: act, wait for the screen to settle, assert, repeat.
// Waiting uses a baseline captured BEFORE each action, which is the whole
// reason these scripts are reliable rather than racy.
import * as api from './index.js';
import * as graph from './graph.js';
import * as input from './input.js';
import * as intent from './intent.js';
import * as metrics from './metrics.js';
import * as screenmap from './screenmap.js';
import { launchApp, openUrl, setPermission, terminateApp } from './platform/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_PAUSE_MS = 5000;
/**
 * A tapped field is typed into once the screen has settled, not after a fixed
 * wait.
 *
 * It was 150 ms, which is enough for a keyboard to rise over the screen you are
 * already on and nowhere near enough for a tap that opens a whole activity.
 * Measured on Android: tapping Settings' search box starts a separate search
 * screen, the text went before its field had focus, and the step reported
 * success while nothing had been typed — the worst shape a failure can take.
 *
 * `settle` needs a change before it will report stillness, so a tap that
 * visibly does nothing (a field that already had focus) cannot satisfy it and
 * falls out at `reaction` instead. That bounds the cost of the honest case
 * rather than the broken one.
 */
/**
 * The stillness window stays fixed, and that is a decision rather than an
 * oversight. Learning a stillness window is the half of Phase 11 that was
 * reverted for cause: a wait that ends early never observes the pauses that
 * come later, so the estimator ratchets itself down and the graph learns
 * transitions that never happened. See docs/BENCHMARKS.md, Phase 11.
 */
const FOCUS_STABLE_MS = 250;
/** How far a control's centre may move between the read and the readback. */
const FIELD_READBACK_RADIUS = 40;
/**
 * The cold defaults, unchanged, for a field this screen has not been measured
 * focusing. `graph.focusPlan` takes over once it has been, and may only make
 * the wait longer.
 *
 * 900 ms is long enough for a slow capture loop to produce a frame or two. The
 * screenshot engine idles at 1.5 fps — 667 ms between frames — so anything
 * under that is a verdict reached before there was anything to look at.
 */
const FOCUS_REACTION_MS = 900;
const FOCUS_TIMEOUT_MS = 3000;
const POLL_MS = 250;
/** A list that has not produced the target in this many screens does not contain it. */
const MAX_SCROLLS = 20;

/**
 * Steps that change the device. Only these get a settle wait and a verified
 * edge in the graph — asserting something is on screen does not move it.
 * `scrollTo` is here because it scrolls; `permission` because a granted
 * permission can change what the app shows.
 */
const ACTION_STEPS = new Set([
  'tap', 'tapAt', 'type', 'paste', 'swipe', 'scroll', 'scrollTo', 'button', 'key',
  'launch', 'terminate', 'openUrl', 'confirm', 'chooseAny', 'permission',
]);

/** Accept both `{tap: "Save"}` shorthand and `{action: "tap", target: "Save"}`. */
export function normalizeStep(raw) {
  if (typeof raw === 'string') return { action: raw };
  if (raw.action) return { ...raw };
  const [key] = Object.keys(raw);
  if (!key) throw new Error('empty step');
  // Siblings like timeoutMs sit alongside the shorthand key and must survive.
  const { [key]: value, ...rest } = raw;
  const inline = value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
  const step = { ...rest, ...inline, action: key };
  // Drop keys that are present but undefined. `simframe tap X` used to pass
  // `index: undefined`, which survived here and then crashed the signature
  // builder before the tap was ever sent.
  for (const k of Object.keys(step)) if (step[k] === undefined) delete step[k];
  return step;
}

/**
 * Does this verdict mean the flow went somewhere nobody intended?
 *
 * Only an unexpected *screen* does. `unexpected-transition` is not a verdict at
 * all any more — a noisy classifier disagreeing about whether a tab switch was
 * a push or a pop is not a reason to call a correct navigation wrong, and a
 * verdict that cries wolf trains you to ignore verdicts.
 */
export function wrongTurnFrom(verification) {
  return verification?.verdict === 'unexpected-screen';
}

/**
 * What a step was asked to act on, in the caller's words.
 *
 * Every escalation wants this and two sites were spelling it out separately —
 * one of them not at all.
 */
export function goalOf(step = {}) {
  return step.value ?? step.target ?? step.label ?? step.into ?? null;
}

/**
 * What a halted step does to the run as a whole.
 *
 * Both halves matter, and only one of them used to happen: the step is marked
 * failed, AND so is the run. Without the second, `ok` meant no more than
 * "nothing threw", so a flow stopped dead at step 0 by a wrong turn reported
 * "flow completed" with no error — the exact shape of failure the verdict
 * exists to make loud.
 */
export function haltDecision({ verification, stopOnUnexpected = true, continueOnError = false } = {}) {
  if (!wrongTurnFrom(verification) || !stopOnUnexpected || continueOnError) {
    return { halt: false, failRun: false, error: null };
  }
  return { halt: true, failRun: true, error: `${verification.verdict}: ${verification.detail}` };
}

export async function runScript(
  deviceQuery,
  {
    steps,
    autoSettle = true,
    stableMs = 500,
    timeoutMs = 8000,
    confirmNovel = true,
    continueOnError = false,
    // Check each action against what it did last time, and remember what it
    // does this time. On by default: a flow that cannot tell a wrong turn from
    // a right one is worse than no flow.
    verify = true,
    // Stop when a verified step lands somewhere it should not have. A flow
    // continuing past a wrong turn taps controls on a screen nobody intended.
    stopOnUnexpected = true,
    // Rebuild the HID session and retry once when a hardware button provably
    // did nothing. Off only for a caller deliberately testing that path.
    recoverInput = true,
    // What this run is called and how few steps it could take, for the flow
    // record. A bare `sim_do` has neither and says so with nulls rather than
    // inventing a name — an unnamed run still gets timed, it just cannot be
    // compared against a human baseline.
    flowName = null,
    minSteps = null,
    options,
  } = {},
) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('a script needs at least one step');
  const { device } = await api.ensureDaemon(deviceQuery, options);
  const udid = device.udid;
  const startedAt = Date.now();
  // Measurement only. Nothing below reads these, and a failure to write one
  // can never change what a step does — see `note`.
  const flowId = metrics.newFlowId();
  const escalations = [];
  const verdicts = [];
  // Named noteEscalation, not note: the step loop below declares its own
  // `note` string for the no-visible-change suffix, which shadowed this and
  // turned every escalating verdict into a failed step reading "note is not a
  // function". The try/catch inside here could not help — the throw was at the
  // call site, one scope out. Instrumentation that can fail a flow is worse
  // than no instrumentation.
  const noteEscalation = (record) => {
    try {
      escalations.push(metrics.recordEscalation(udid, { flowId, flowName, ...record }));
    } catch {
      /* instrumentation must not be able to fail a flow it is only watching */
    }
  };

  const needsInput = steps.some((s) => ACTION_STEPS.has(normalizeStep(s).action));
  if (needsInput) {
    // driverFor, not detectDriver: detectDriver asks specifically whether idb
    // is installed, so every batch flow demanded idb even on a machine where
    // the daemon was doing the input perfectly well. Single-step `simframe tap`
    // already went through driverFor, so `tap` worked and `do` did not.
    const driver = await input.driverFor(udid);
    if (!driver.available) throw new Error(driver.reason);
  }

  let geometry = null;
  const screen = async () => (geometry ??= await input.screenInfo(udid));

  const results = [];
  const frames = [];
  let failed = false;
  let carriedScreen = null;
  // The last reading of where we ended up, confirmed or not. The compact map
  // the caller returns to Claude is rendered from this, so describing the end
  // state costs nothing beyond the verification pass the flow already ran.
  let endScreen = null;
  // At most one recovery per run. Pressing home while already on the springboard
  // moves nothing and is not a failure, so an unbounded retry would rebuild the
  // session and press again on every such step for no reason.
  let inputRecovered = false;
  /**
   * The previous step's transition, still to be measured.
   *
   * Its pause profile cannot be read while the step is running — that is the
   * biased measurement that corrupted the graph — so it is read one step later,
   * off a frame history whose end nothing about the wait decided. See
   * `api.longestQuietGap`.
   */
  let pendingGap = null;
  const measurePendingGap = async () => {
    if (!pendingGap) return;
    const { from, step: prevStep, actionAt } = pendingGap;
    pendingGap = null;
    try {
      const history = (await api.getState(deviceQuery, { options })).state.history ?? [];
      const trueGapMs = api.longestQuietGap(history, actionAt);
      if (trueGapMs != null) graph.noteTrueGap(udid, from, prevStep, trueGapMs);
    } catch {
      /* a statistic nothing acts on must never be able to fail a flow */
    }
  };

  for (const [i, raw] of steps.entries()) {
    const step = normalizeStep(raw);
    const stepStart = Date.now();
    // Before anything else, and before this step disturbs the screen: the
    // previous transition is definitely over by now, so its true pause profile
    // is readable.
    await measurePendingGap();
    // The baseline for "did the screen react" must predate the action itself.
    const beforeState = (await api.getState(deviceQuery, { options })).state;
    const before = beforeState.hash;
    // Identity is structural: a list with new rows is the same screen, and the
    // pixel hash cannot say so.
    // The screen this step starts on is the screen the last one ended on —
    // nothing happens in between. Recomputing it cost a full perception pass
    // per step for an answer already in hand.
    const beforeScreen = verify
      ? (carriedScreen ?? await api.screenIdentity(deviceQuery, { options, settleMs: stableMs, timeoutMs, confirmNovel }))
      : null;
    carriedScreen = null;
    // What this action did last time it was taken here, if ever.
    const prediction = verify && beforeScreen?.hash ? graph.predict(udid, beforeScreen, step) : null;
    try {
      // How long this transition has cost before, on this screen, for this
      // action. A cold edge gets the old fixed default and says so; a measured
      // one gets p95 plus a margin. Research §7.
      //
      // Read before the step, not after, because one of the waits it informs
      // happens *inside* the step: a `type into` taps the field and waits for
      // focus before it types, and that wait used to be three constants.
      const learned = verify && beforeScreen?.hash ? graph.timingFor(udid, beforeScreen, step) : null;
      const focus = {
        plan: graph.focusPlan(learned, {
          reactionMs: FOCUS_REACTION_MS,
          timeoutMs: FOCUS_TIMEOUT_MS,
          stillnessMs: FOCUS_STABLE_MS,
          keyboardUp: Boolean(beforeScreen?.keyboard),
        }),
        observedMs: null,
      };
      let detail = await runStep(deviceQuery, udid, step, { screen, options, frames, focus });
      // How long this screen must hold still before it counts as settled.
      //
      // 500 ms was a constant paid by every step of every flow, and it is the
      // reducible half of a settle: the rest is the transition genuinely
      // taking time. An edge whose transition has never paused mid-flight
      // needs 150 ms of quiet, not 500. Capped at the caller's own value, so
      // this can only ever shorten a wait.
      // NOT YET USED TO DECIDE ANYTHING, and the reason is worth the space.
      //
      // `graph.stillnessFor` computes a shorter window from the longest pause
      // ever observed inside this transition, and measured live it made the
      // Settings flow 8.0 s instead of 11.5 s — and wrong. Eight runs in a row
      // failed at step 2 with the screen still showing Settings root, because
      // step 1's settle returned mid-push, `screenIdentity` then read the
      // screen we had not left yet, and the graph learned root -> root as a
      // verified edge and started predicting it.
      //
      // The flaw is in the estimator, not the idea: the gap statistic is
      // gathered only from what a wait itself observed, so a wait that ends
      // early never sees the pauses that come later, the gaps look like zero,
      // the window ratchets down, and the next wait ends earlier still. A
      // self-reinforcing bias with a wrong graph at the end of it.
      //
      // The unbiased estimator is available and is a separate piece of work:
      // the frame history holds every frame's timestamp and diff, so the true
      // motion profile of a transition can be computed *after* it is over
      // rather than from inside the wait that cut it short. Until then the
      // gaps are recorded and not acted on — measuring is safe, and this is
      // Phase 11's own rule that a learned number may only ever shorten a
      // wait, applied to itself.
      const stillness = step.stableMs ?? stableMs;
      const stillnessPlan = learned ? graph.stillnessFor(learned, stillness) : { cold: true };
      // A settle is not satisfied until the screen has held still for
      // `stillness`, so a budget below that can never be met — and the learned
      // p95 is measured from waits that include the stillness window, which
      // makes it self-consistent but not self-evidently so. A tab switch with
      // a p95 of 90ms would get a 240ms budget and then time out at 240ms
      // waiting for 500ms of quiet, turning every fast edge into a failure.
      const floorMs = stillness + 250;
      const budgetMs = step.timeoutMs
        ?? (learned && !learned.cold ? Math.max(learned.timeoutMs, floorMs) : timeoutMs);
      const settleFor = async () => {
        if (!autoSettle || !ACTION_STEPS.has(step.action)) return null;
        const w = await api.waitFor(deviceQuery, {
          mode: 'settle',
          since: before,
          stableMs: stillness,
          timeoutMs: budgetMs,
          options,
        });
        return {
          ok: w.satisfied,
          waitedMs: w.waitedMs,
          sawChange: w.sawChange,
          stalled: Boolean(w.stalled),
          noVisibleChange: Boolean(w.noVisibleChange),
          // What this wait was allowed, and where the number came from. A
          // timeout nobody can explain is how a fixed sleep comes back as a
          // constant with a comment.
          budgetMs,
          stillnessMs: stillness,
          quietGapMs: w.quietGapMs,
          // The baseline had already finished moving when the wait began, so it
          // was re-taken from the live screen. Surfaced because it means the
          // step before this one had not finished when this one started.
          staleBaseline: Boolean(w.staleBaseline),
          // Something moved in one region only — a switch, a radio dot, a
          // segment highlight. Worth saying, because it is the difference
          // between "the action did nothing" and "the action did something the
          // whole-screen mean cannot see".
          smallChange: Boolean(w.smallChange),
          timing: learned
            ? {
              p50: learned.p50,
              p95: learned.p95,
              samples: learned.samples,
              cold: learned.cold,
              gapP95: learned.gapP95,
              gapSamples: learned.gapSamples,
              // What it *would* have been, for the eval that has to happen
              // before this is trusted with a wait.
              stillnessWouldBe: stillnessPlan.stillnessMs ?? null,
            }
            : null,
        };
      };
      let settled = await settleFor();
      // A screen that is still working earns more time; a screen doing nothing
      // visible has already answered. Research §7: keep waiting past p95 only
      // while the transition classifier says something is loading, and never
      // past Nielsen's 10 s — at which point it escalates with the timing
      // attached rather than waiting longer.
      if (settled && !settled.ok && !settled.noVisibleChange && learned && !learned.cold) {
        const kind = (await api.getState(deviceQuery, { options })).state.transition?.kind;
        const verdict = graph.slowerThanUsual({
          elapsedMs: settled.waitedMs, p95: learned.p95, settled: false, kind,
        });
        if (verdict.keepWaiting) {
          const remaining = graph.HARD_CAP_MS - settled.waitedMs;
          const more = await api.waitFor(deviceQuery, {
            mode: 'settle', since: before, stableMs: stillness, timeoutMs: remaining, options,
          });
          settled = {
            ...settled,
            ok: more.satisfied,
            waitedMs: settled.waitedMs + more.waitedMs,
            sawChange: settled.sawChange || more.sawChange,
            quietGapMs: Math.max(settled.quietGapMs ?? 0, more.quietGapMs ?? 0),
            slowerThanUsual: verdict.note,
          };
        } else if (verdict.slower) {
          settled = { ...settled, slowerThanUsual: verdict.note };
        }
      }

      // A hardware button that moved nothing did not arrive.
      //
      // Input is the one path with no feedback, so a dispatched Indigo message
      // reports success whether or not the device acted on it — measured, a
      // long-running daemon returned `press in 66ms` with the screen frozen,
      // and the same press worked on a fresh daemon. The frames are the only
      // witness, and by here we have them.
      //
      // Only buttons, and only on no visible change. Home and lock always move
      // the screen, so nothing moving is unambiguous; a tap that changes
      // nothing is ordinary, and retrying one could act twice. Retrying an
      // action that provably did nothing is not a repeat — it is the first
      // attempt that counts.
      if (recoverInput && !inputRecovered && step.action === 'button' && settled?.noVisibleChange) {
        inputRecovered = true;
        const reset = await input.resetSession(udid);
        if (reset) {
          detail += ' [input was not being delivered; HID session reset and retried]';
          await runStep(deviceQuery, udid, step, { screen, options, frames });
          settled = await settleFor();
        }
      }
      // Verify against what was predicted, and remember what actually
      // happened. Without this a step that moved the screen the wrong way
      // reports success, and the flow carries on believing it worked.
      let verification = null;
      if (verify && ACTION_STEPS.has(step.action) && beforeScreen?.hash) {
        const afterState = (await api.getState(deviceQuery, { options })).state;
        const kind = afterState.transition?.kind;
        const afterScreen = await api.screenIdentity(deviceQuery, { options, settleMs: stableMs, timeoutMs, confirmNovel });
        verification = {
          ...stillArriving(
            belowThreshold(
              graph.verdict({ udid, prediction, before: beforeScreen.hash, after: afterScreen.hash, kind, action: step.action }),
              settled,
            ),
            afterScreen,
          ),
          predicted: prediction ? { to: prediction.to.slice(0, 10), kind: prediction.kind, seen: prediction.count } : null,
          observed: { to: afterScreen.hash?.slice(0, 10), kind },
        };
        // Only remember what was seen on a settled screen: an edge recorded
        // mid-transition points at a screen that never really existed.
        // `confirmed` already means the fingerprint held still across two
        // independent readings, which is the thing `settled` was standing in
        // for. Requiring both meant a screen that settled slowly recorded
        // nothing at all.
        endScreen = afterScreen;
        // An action with no observed effect teaches the graph nothing, and
        // recording it teaches something false.
        //
        // This is the second half of the same bug. A settle that returned on a
        // stale baseline reported `ok` for a tap that moved nothing, and the
        // recorder asked only whether the *reading* was confirmed — so
        // `root -> root` went in as a verified edge and started being
        // predicted. Re-baselining stops the settle lying; this stops the
        // graph learning from a step that has no evidence behind it either way.
        //
        // It does cost a real case for now: a control that genuinely returns to
        // the same screen — a toggle — is invisible to the change detector at
        // eight times below its threshold, so it reads as no-visible-change and
        // its edge is no longer recorded. That is the right trade while the
        // detector cannot see it, and it comes back on its own once it can.
        const noEvidence = Boolean(settled?.noVisibleChange);
        if (afterScreen.confirmed && afterScreen.hash && !noEvidence) {
          // The observed cost of this transition, which is what makes the next
          // one adaptive. Only from a settle that was actually satisfied: a
          // timeout is not a measurement of how long the screen takes, it is a
          // measurement of how long we were prepared to wait.
          graph.record(udid, {
            from: beforeScreen, action: step, to: afterScreen, kind,
            settleMs: settled?.ok ? settled.waitedMs : undefined,
            // The pause statistic is worth having from any settle that saw the
            // screen move, satisfied or not: a transition that paused for
            // 400ms and then timed out is exactly the case a 150ms stillness
            // window would have got wrong.
            quietGapMs: settled?.sawChange ? settled.quietGapMs : undefined,
            // The focus wait's own distribution, kept apart from the step's.
            // Only set when a field was tapped and visibly took focus.
            focusMs: focus.observedMs ?? undefined,
          });
          pendingGap = { from: beforeScreen, step, actionAt: stepStart };
          carriedScreen = afterScreen;
        } else if (afterScreen.confirmed && afterScreen.hash) {
          // Where we are is still known; only what got us here is not worth
          // remembering. Carrying it saves the next step a perception pass.
          carriedScreen = afterScreen;
        }
      }

      const wrongTurn = wrongTurnFrom(verification);
      // `[no visible change]` after a launch is ambiguous between two very
      // different things, and a real session read it the wrong way twice:
      // "the app was already in front, so nothing needed to move" and "the app
      // did not come forward". Measured on this Xcode, `simctl launch` *does*
      // front an already-running app, so the first reading is the likely one —
      // but likely is not the same as said, and the step is the only place that
      // can say it.
      const launchNote = step.action === 'launch' && settled?.noVisibleChange
        ? ' [the screen did not change, so this app was already in front — or it did not come forward]'
        : '';
      const note = launchNote
        + (settled?.smallChange ? ' [a small change, in one region only]' : '')
        + (settled?.noVisibleChange ? ' [no visible change]' : '')
        + (settled?.staleBaseline ? ' [baseline had already settled; re-taken from the live screen]' : '')
        + (settled?.blackFrames
          ? ` [${settled.blackFrames} black frame(s) waited through${settled.blackMs ? `, still black after ${settled.blackMs}ms` : ''}]`
          : '');
      results.push({
        index: i,
        action: step.action,
        verification,
        ok: true,
        ms: Date.now() - stepStart,
        detail: `${detail}${note}${wrongTurn ? ` [${verification.verdict}: ${verification.detail}]` : ''}`,
        settled,
      });
      const halt = haltDecision({ verification, stopOnUnexpected, continueOnError });
      if (verification?.verdict) verdicts.push(verification.verdict);
      if (metrics.ESCALATING_VERDICTS.has(verification?.verdict)) {
        noteEscalation({
          stepIndex: i,
          fingerprint: beforeScreen?.hash ?? null,
          reason: 'verification_failed',
          candidates: [],
          // `verification_failed` is the largest reason class in the log and it
          // was the only one carrying no intent, which made most of the corpus
          // useless for asking what kind of decision costs us. The step knows
          // what was asked for; there is no reason to drop it here.
          intent: goalOf(step),
          // A halted run is a decision simframe made and stopped on; a step
          // that moved nothing carries on and leaves the judgement to whoever
          // reads the result.
          outcome: halt.halt ? 'failed' : 'escalated_to_model',
          wallMs: Date.now() - stepStart,
          detail: `${verification.verdict}: ${verification.detail}`
            + (settled?.slowerThanUsual ? ` [${settled.slowerThanUsual}]` : '')
            + (settled?.timing && !settled.timing.cold
              ? ` [waited ${settled.waitedMs}ms of a ${settled.budgetMs}ms budget; p95 ${settled.timing.p95}ms]`
              : ''),
        });
      }
      if (halt.halt) {
        results[results.length - 1].ok = false;
        results[results.length - 1].error = halt.error;
        failed = halt.failRun;
        break;
      }
    } catch (err) {
      results.push({ index: i, action: step.action, ok: false, ms: Date.now() - stepStart, error: err.message });
      const why = metrics.reasonForStepError(step, err);
      noteEscalation({
        stepIndex: i,
        fingerprint: beforeScreen?.hash ?? metrics.fingerprintNow(udid, screenmap),
        reason: why.reason,
        candidates: why.candidates,
        tried: why.tried,
        // Carried from the throw site where it exists, and otherwise the step's
        // own target — which is what was asked for either way.
        intent: why.intent ?? goalOf(step),
        outcome: 'failed',
        wallMs: Date.now() - stepStart,
        detail: err.message,
      });
      failed = true;
      if (!continueOnError) break;
    }
  }

  // The last step has no next step to measure it, and its transition is over by
  // the time the loop exits.
  await measurePendingGap();

  const wallMs = Date.now() - startedAt;
  try {
    metrics.recordFlow(udid, metrics.flowRecordFrom({
      flowId,
      flowName,
      udid,
      startedAt,
      wallMs,
      stepsTaken: results.length,
      totalSteps: steps.length,
      minSteps,
      imagesSent: frames.length,
      escalations,
      verdicts,
      completed: !failed && results.length === steps.length,
    }));
  } catch {
    /* as above: a flow that ran is not a flow that failed because of a log */
  }

  return {
    device,
    // Returned so a run that verified end to end can be handed straight to
    // navigate.saveFlow without the caller reassembling what it just ran.
    steps,
    flowId,
    endScreen,
    results,
    ok: !failed,
    totalMs: wallMs,
    ranSteps: results.length,
    totalSteps: steps.length,
    frames,
  };
}

/**
 * Tap a field and wait for it to take focus, for the steps that then put text
 * in it.
 *
 * `locate`, not `tapLabel`: tapLabel asks the accessibility tree directly, so a
 * field only OCR can see was untypeable and a selector (`#4`, `@x,y`) meant
 * nothing here. The returned `quiet` says when the field never visibly took
 * focus — usually fine, since a field that already had focus does not move, but
 * also exactly what a tap that missed looks like, so the caller should be told.
 */
/**
 * What the field holds now, read back from the tree after the text commits.
 *
 * Reported three rounds running, and the third round is what forced this: the
 * `type` verdict is wrong in *both* directions. A step that reported a clean
 * `ok` had silently done nothing, while the step warned about as
 * `no-visible-change` had landed — anti-correlated with reality, on the one
 * path where acting on the warning is destructive. An operator who re-types on
 * that warning doubles the field, and there is no way to clear it.
 *
 * A change verdict is the wrong instrument. Typing does not change the screen,
 * so screen-identity movement can only ever answer a question nobody asked.
 * The field's own contents answer the real one, and the tree already carries
 * them — `value` has been on an AX target since MAP_VERSION 9.
 *
 * Accessibility only: `value` never comes from OCR, and skipping OCR keeps this
 * to one cheap read. Best effort — a readback that fails must not fail the
 * step, because the text may well have landed.
 */
async function fieldContents(deviceQuery, target, sent, ctx) {
  try {
    const { entry } = await api.readScreenWith(deviceQuery, { useOcr: false, options: ctx.options });
    const near = (entry.targets ?? []).filter(
      (t) => Math.hypot((t.x ?? 0) - target.x, (t.y ?? 0) - target.y) <= FIELD_READBACK_RADIUS,
    );
    if (!near.length) return null;
    // The text may arrive as the control's `value` or as a sibling's label —
    // a React Native input renders its contents as a separate text node — so
    // look for what was sent across both before concluding anything. Getting
    // this wrong is what made the first version of this check fail a step whose
    // text was visible in the very map the failure returned.
    const wanted = alnum(sent);
    for (const t of near) {
      for (const seen of [t.value, t.label]) {
        if (!seen) continue;
        // `includes`, not equals: the caret is OCR'd into the value ("Maryam
        // Hatami" reads back as "Maryam Hatamil"), and a long value is
        // truncated by the renderer.
        if (wanted && alnum(seen).includes(wanted)) {
          return { value: String(seen), landed: true, focused: Boolean(t.focused) };
        }
      }
    }
    // Not found. Only an *empty* valued control is evidence of absence; a
    // control with no `value` attribute at all is no evidence either way.
    const valued = near.find((t) => t.value != null);
    if (valued && String(valued.value) === '') {
      return { value: '', landed: false, focused: Boolean(valued.focused) };
    }
    return null;
  } catch {
    return null;
  }
}

/** Comparison that ignores what OCR adds — a caret, a stray glyph, spacing. */
const alnum = (v) => String(v ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** How the readback is reported, and whether it contradicts what was sent. */
export function readbackNote(sent, seen) {
  // No readback, or a readback that found no valued control: no evidence, and
  // no evidence is not counter-evidence. The first version of this treated a
  // missing `value` attribute as an empty field and failed a step whose text was
  // visible in the same map the failure returned — reported, correctly, as
  // worse than the verdict it replaced.
  if (!seen) return { note: '', empty: false, landed: false };
  if (seen.landed) {
    const v = String(seen.value);
    const shown = v.length > 60 ? `${v.slice(0, 60)}…` : v;
    return { note: ` = ${JSON.stringify(shown)}`, empty: false, landed: true };
  }
  return { note: ' [the field reads empty]', empty: Boolean(sent), landed: false };
}

/**
 * Do not call a screen a wrong turn while it is still arriving.
 *
 * `unexpected-screen` fired three times in one reported run and was wrong all
 * three. One cause was this: a tap applied a selection correctly and enabled
 * the submit button, but an async panel on the same screen had not come back
 * yet, so the structure differed from the settled screen the edge remembered.
 * Nothing had gone wrong; the screen was half there.
 *
 * A settle can be satisfied while content is still loading — that is Phase
 * 11.5's finding and the reason `loading` exists — so the two must be read
 * together. An incomplete screen cannot contradict a prediction, and
 * `unverified` is the honest verdict: we do not know yet.
 *
 * The other cause was data variation, which this does not address: picking a
 * different test asset changes the content and the check reads it as a wrong
 * turn. That needs structural comparison and is filed, not fixed.
 */
export function stillArriving(verification, afterScreen) {
  if (verification?.verdict !== 'unexpected-screen') return verification;
  if (afterScreen?.loading !== true) return verification;
  return {
    ...verification,
    verdict: 'unverified',
    detail: 'the screen this reached is still loading, so it cannot be compared yet'
      + ' — re-read it, or waitFor the content you expect, before treating this as a wrong turn',
  };
}

/**
 * Reconcile the two sensors when they disagree about "did anything happen".
 *
 * The wait watches regions and the verdict compares screen identity, so a tap
 * that moved one cell produced `[a small change, in one region only]` and
 * `no-visible-change: the screen did not change` four lines apart. Both were
 * true of different questions, and the pair reads as a contradiction rather
 * than as a measurement.
 *
 * The verdict stands — a change too small to move the screen's identity is the
 * finding — but it should say what was actually observed.
 */
export function belowThreshold(verification, settled) {
  if (verification?.verdict !== 'no-visible-change' || !settled?.smallChange) return verification;
  return {
    ...verification,
    detail: 'the screen changed in one region only, by too little to be a different screen'
      + ' — if that was the whole effect, this is fine; if a transition was expected, it did not happen',
  };
}

async function focusField(deviceQuery, udid, step, ctx) {
  const found = await api.locate(deviceQuery, step.into, { index: step.index, refresh: step.refresh });
  // What this field has cost to focus before, on this screen. Cold, or with no
  // verification running, that is exactly the three constants above; measured,
  // it can only be longer. `graph.focusPlan` carries the reason it is either.
  const plan = ctx.focus?.plan ?? {
    reactionMs: FOCUS_REACTION_MS, timeoutMs: FOCUS_TIMEOUT_MS, cold: true, from: 'no timing in hand',
  };
  const tappedAt = Date.now();
  await input.tapPoint(udid, found.target.x, found.target.y);
  const focused = await api.waitFor(deviceQuery, {
    mode: 'settle',
    stableMs: FOCUS_STABLE_MS,
    reactionMs: plan.reactionMs,
    timeoutMs: plan.timeoutMs,
    options: ctx.options,
  });
  // Only a wait that was satisfied is a measurement of how long focus takes. A
  // reaction window that ran out measures how long we were prepared to watch a
  // screen that did not move, and banking that would teach the edge the cost of
  // its own impatience — the estimator mistake learned stillness made.
  if (ctx.focus && focused.satisfied) ctx.focus.observedMs = Date.now() - tappedAt;
  return {
    found,
    where: `"${found.target.label}" at ${found.target.x},${found.target.y}`,
    quiet: focused.satisfied ? '' : ' [the field did not visibly take focus]',
    waited: focused.satisfied && !plan.cold ? ` [focus in ${focused.waitedMs}ms, ${plan.from}]` : '',
  };
}

async function runStep(deviceQuery, udid, step, ctx) {
  switch (step.action) {
    case 'tap': {
      const query = step.value ?? step.target ?? step.label;
      // Screen memory first: a familiar screen needs no tree read and no OCR.
      const found = await api.locate(deviceQuery, query, { index: step.index, refresh: step.refresh });
      await input.tapPoint(udid, found.target.x, found.target.y, { durationMs: step.durationMs });
      return `tapped "${found.target.label}" at ${found.target.x},${found.target.y} (${found.from}${found.from === 'memory' ? ` d=${found.distance}` : ''}, via ${found.target.source})`;
    }
    case 'tapAt': {
      const geo = await ctx.screen();
      let { x, y } = step;
      if (step.space === 'image') {
        const frame = await api.getFrame(deviceQuery, { options: ctx.options });
        ({ x, y } = input.imageToPoints({ x, y }, {
          imageWidth: frame.width,
          imageHeight: frame.height,
          pointWidth: geo.pointWidth,
          pointHeight: geo.pointHeight,
        }));
      }
      await input.tapPoint(udid, x, y, { durationMs: step.durationMs });
      return `tapped ${x},${y}`;
    }
    case 'type': {
      if (step.into) {
        const field = await focusField(deviceQuery, udid, step, ctx);
        const sent = step.text ?? step.value;
        await input.typeText(udid, sent);
        const seen = await fieldContents(deviceQuery, field.found.target, sent, ctx);
        const back = readbackNote(sent, seen);
        if (back.empty) {
          throw new Error(
            `typed into ${field.where} and the field reads empty — the text did not land.`
            + ' paste is more reliable than type on this path; keys sends literal characters, not named keys.',
          );
        }
        // The focus warning is suppressed once the readback has confirmed the
        // text landed. It fires whenever the screen does not visibly react to
        // the tap, and with a hardware keyboard attached to the simulator none
        // ever does — so a correctly focused field was reported as unfocused,
        // the reporter went hunting, and that cascade cost three calls. Where
        // there is direct evidence, a proxy for it is noise.
        return `typed into ${field.where}${back.note}${back.landed ? '' : field.quiet}${field.waited}`;
      }
      await input.typeText(udid, step.text ?? step.value);
      return 'typed text';
    }
    case 'paste': {
      // Long strings are much faster on the pasteboard than through the
      // keyboard. `pasteText` delivers the keystroke as well as setting the
      // pasteboard, and throws if it cannot — this step used to do neither and
      // report success anyway.
      if (step.into) {
        const field = await focusField(deviceQuery, udid, step, ctx);
        const sent = step.text ?? step.value;
        await input.pasteText(udid, sent);
        const seen = await fieldContents(deviceQuery, field.found.target, sent, ctx);
        const back = readbackNote(sent, seen);
        if (back.empty) {
          throw new Error(
            `pasted into ${field.where} and the field reads empty — the text did not land.`
            + ' A first paste can raise the system paste-consent dialog and lose the text; dismiss it and retry.',
          );
        }
        return `pasted into ${field.where}${back.note}${back.landed ? '' : field.quiet}${field.waited}`;
      }
      await input.pasteText(udid, step.text ?? step.value);
      return 'pasted into the focused field';
    }
    case 'swipe': {
      const from = { x: step.from?.[0] ?? step.from?.x, y: step.from?.[1] ?? step.from?.y };
      const to = { x: step.to?.[0] ?? step.to?.x, y: step.to?.[1] ?? step.to?.y };
      await input.swipe(udid, from, to, { durationMs: step.durationMs });
      return `swiped ${from.x},${from.y} -> ${to.x},${to.y}`;
    }
    case 'scroll': {
      const geo = await ctx.screen();
      const dir = String(step.value ?? step.direction ?? 'down').toLowerCase();
      const midX = Math.round(geo.pointWidth / 2);
      const midY = Math.round(geo.pointHeight / 2);
      const span = Math.round(geo.pointHeight * 0.3);
      const moves = {
        down: [{ x: midX, y: midY + span }, { x: midX, y: midY - span }],
        up: [{ x: midX, y: midY - span }, { x: midX, y: midY + span }],
        left: [{ x: midX + span, y: midY }, { x: midX - span, y: midY }],
        right: [{ x: midX - span, y: midY }, { x: midX + span, y: midY }],
      };
      if (!moves[dir]) throw new Error(`unknown scroll direction "${dir}"`);
      await input.swipe(udid, moves[dir][0], moves[dir][1], { durationMs: step.durationMs ?? 250 });
      return `scrolled ${dir}`;
    }
    case 'button':
      await input.pressButton(udid, step.value ?? step.name);
      return `pressed ${step.value ?? step.name}`;
    case 'key':
      await input.pressKey(udid, step.value ?? step.code);
      return `pressed key ${step.value ?? step.code}`;
    case 'launch': {
      const bundleId = step.value ?? step.bundleId;
      await launchApp(udid, bundleId, {
        args: step.args ?? [],
        env: step.env ?? {},
        terminateFirst: step.relaunch === true,
      });
      return `launched ${bundleId}${step.relaunch ? ' (relaunched)' : ''}`;
    }
    case 'terminate':
      await terminateApp(udid, step.value ?? step.bundleId);
      return `terminated ${step.value ?? step.bundleId}`;
    case 'openUrl':
      await openUrl(udid, step.value ?? step.url);
      return `opened ${step.value ?? step.url}`;

    // Human-level steps: act on what is on screen without reasoning about it.
    case 'confirm': {
      const geo = await ctx.screen();
      const r = await intent.confirm(udid, { geo });
      return `confirmed via "${r.label}" at ${r.point.x},${r.point.y}`;
    }
    case 'chooseAny': {
      const geo = await ctx.screen();
      const r = await intent.chooseAny(udid, { prefer: step.value ?? step.prefer, geo });
      return `chose "${r.label}" of ${r.optionCount} options`;
    }
    case 'settle': {
      const w = await api.waitFor(deviceQuery, {
        mode: step.mode ?? 'stable',
        stableMs: step.stableMs ?? 500,
        timeoutMs: step.timeoutMs ?? 8000,
        options: ctx.options,
      });
      if (!w.satisfied) throw new Error(w.stalled ? w.live.note : `screen did not settle within ${w.waitedMs}ms`);
      return `settled after ${w.waitedMs}ms`;
    }
    case 'waitText': {
      const target = step.value ?? step.text;
      const limit = Date.now() + (step.timeoutMs ?? 8000);
      let lastError = 'never appeared';
      while (Date.now() < limit) {
        try {
          const node = input.matchElement(await input.describeAll(udid), target, { index: step.index });
          return `"${node.label ?? target}" appeared`;
        } catch (err) {
          lastError = err.message;
          // Same rule as `waitFor`, and `matchElement` says it in its own
          // words: a query that matched several elements has found them all
          // already.
          if (/matched \d+ elements/.test(err.message)) {
            throw new Error(
              `${err.message}\n  (not waiting: it is already on screen, and waiting cannot make it unique)`,
            );
          }
        }
        await sleep(250);
      }
      throw new Error(`waited ${step.timeoutMs ?? 8000}ms for "${target}": ${lastError}`);
    }
    case 'assertText': {
      const target = step.value ?? step.text;
      const node = input.matchElement(await input.describeAll(udid), target, { index: step.index });
      return `"${node.label ?? target}" is on screen`;
    }
    case 'assertGone': {
      const target = step.value ?? step.text;
      try {
        input.matchElement(await input.describeAll(udid), target, { index: step.index });
      } catch {
        return `"${target}" is gone`;
      }
      throw new Error(`"${target}" is still on screen`);
    }
    // Bring something into view. A control that scrolled off the bottom of a
    // list is not missing, and "not on this screen" is the wrong answer to give
    // about it.
    case 'scrollTo': {
      const query = step.value ?? step.target ?? step.label;
      const dir = String(step.direction ?? 'down').toLowerCase();
      const max = Math.min(MAX_SCROLLS, step.maxScrolls ?? 6);
      for (let i = 0; i <= max; i += 1) {
        try {
          const found = await api.locate(deviceQuery, query, { index: step.index, refresh: i > 0 });
          return `"${found.target.label}" is in view at ${found.target.x},${found.target.y}` +
            (i ? ` after ${i} scroll${i === 1 ? '' : 's'}` : ' already');
        } catch (err) {
          if (i === max) throw new Error(`scrolled ${dir} ${max}x without finding ${query}: ${err.message}`);
        }
        await runStep(deviceQuery, udid, { action: 'scroll', value: dir }, ctx);
        await api.waitFor(deviceQuery, { mode: 'stable', stableMs: 250, timeoutMs: 2500, options: ctx.options });
      }
      throw new Error(`could not bring ${query} into view`);
    }

    // Wait for a selector rather than a label, so it works on screens the
    // accessibility tree never described.
    case 'waitFor': {
      const query = step.value ?? step.target ?? step.text;
      const limit = Date.now() + (step.timeoutMs ?? 8000);
      let lastError = 'never appeared';
      for (let attempt = 0; ; attempt += 1) {
        try {
          const found = await api.locate(deviceQuery, query, { index: step.index, refresh: attempt > 0 });
          return `"${found.target.label}" appeared at ${found.target.x},${found.target.y}`;
        } catch (err) {
          lastError = err.message;
          // Waiting cannot make a thing unique.
          //
          // Reported from a real session: a wait on an ambiguous string spent
          // the full 30 s and then listed four matches, all four of which were
          // on the very first frame. The disambiguation is good and it arrived
          // twenty-nine seconds after everything it needed. `ambiguous` means
          // the target is *present*, several times over — which is precisely
          // the case where more time changes nothing.
          //
          // Distinguished by the tag at the throw site rather than by reading
          // the message, because "not on this screen" tags the same reason.
          if (metrics.escalationOf(err)?.ambiguous) {
            throw new Error(
              `${err.message}\n  (not waiting: it is already on screen, and waiting cannot make it unique)`,
            );
          }
        }
        if (Date.now() >= limit) break;
        await sleep(POLL_MS);
      }
      throw new Error(`waited ${step.timeoutMs ?? 8000}ms for ${query}: ${lastError}`);
    }

    // One assert step for every condition, because `assertText` could only ask
    // one question and the interesting ones are about state: is Save enabled
    // yet, does the field hold what was typed into it.
    case 'assert': {
      const query = step.value ?? step.target ?? step.text;
      const want = String(step.is ?? (step.gone ? 'gone' : 'visible')).toLowerCase();
      let found = null;
      try {
        found = await api.locate(deviceQuery, query, { index: step.index, refresh: step.refresh });
      } catch (err) {
        if (want === 'gone') return `${query} is gone`;
        throw new Error(`${query}: ${err.message}`);
      }
      const t = found.target;
      switch (want) {
        case 'visible':
          return `${query} is on screen at ${t.x},${t.y}`;
        case 'gone':
          throw new Error(`${query} is still on screen at ${t.x},${t.y}`);
        case 'enabled':
          if (t.enabled === false) throw new Error(`"${t.label}" is disabled`);
          return `"${t.label}" is enabled`;
        case 'disabled':
          if (t.enabled !== false) throw new Error(`"${t.label}" is not disabled`);
          return `"${t.label}" is disabled`;
        case 'value': {
          const expected = String(step.equals ?? step.text ?? '');
          const actual = [t.label, t.value, ...(t.aliases ?? [])].filter(Boolean).join(' ');
          if (!actual.toLowerCase().includes(expected.toLowerCase())) {
            throw new Error(`expected "${expected}" but read "${actual}"`);
          }
          return `"${expected}" is what ${query} reads`;
        }
        default:
          throw new Error(`unknown assert condition "${want}" — visible, gone, enabled, disabled or value`);
      }
    }

    // Answering a system permission alert is not a test of the app. Setting the
    // permission is.
    case 'permission': {
      const service = step.value ?? step.service;
      return await setPermission(udid, step.grant ?? step.action ?? 'grant', service, step.bundleId);
    }

    case 'look': {
      const frame = await api.getFrame(deviceQuery, { detail: step.detail ?? 'normal', options: ctx.options });
      ctx.frames.push({ label: step.label ?? `step frame`, png: frame.png });
      return `captured a frame (${frame.width}x${frame.height})`;
    }
    case 'pause': {
      const ms = Math.min(MAX_PAUSE_MS, Number(step.value ?? step.ms ?? 0));
      await sleep(ms);
      return `paused ${ms}ms`;
    }
    default:
      throw new Error(`unknown step "${step.action}"`);
  }
}
