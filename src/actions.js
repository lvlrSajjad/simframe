// The batch engine. A flow that would cost one model round trip per tap runs
// here as a single call: act, wait for the screen to settle, assert, repeat.
// Waiting uses a baseline captured BEFORE each action, which is the whole
// reason these scripts are reliable rather than racy.
import * as api from './index.js';
import * as graph from './graph.js';
import * as input from './input.js';
import * as intent from './intent.js';
import * as vocabulary from './vocabulary.js';
import * as supervisor from './supervisor.js';
import * as view from './view.js';
import * as planner from './planner.js';
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

/**
 * The settle budget for an action that is not supposed to navigate.
 *
 * A change-based settle cannot be satisfied by an action that changes nothing,
 * so the only question is how long to spend finding that out. Long enough for
 * keystrokes to land and no longer.
 */
const STAYS_PUT_STILLNESS_MS = 200;
const STAYS_PUT_BUDGET_MS = 600;
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
    // What the plan wants its supervisor to know.
    //
    // The owner's insight, and it is what made the supervisor usable. Asked
    // cold, it called a list that was plainly still arriving a dead end —
    // because it does not know this app and Claude, by the time it writes the
    // plan, does. So the plan briefs its own first responder: `supervise` is
    // the batch's standing guidance, and a step may add `expect` of its own.
    //
    // It is also the correction channel. When the supervisor stops a run, the
    // result says so, names the remaining steps, and tells the caller that
    // re-issuing them with a `supervise` note will not stop again for that
    // reason. A wrong local decision costs one message, not a re-plan.
    supervise = null,
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
  const supervisions = [];
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

  let consecutiveFailures = 0;
  let lastFailureScreen = null;
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
      let detail;
      // A selector that did not resolve gets the step's own alternatives before
      // the batch is abandoned. Anything else propagates: retrying from a screen
      // we did not expect to be on is not a retry, it is a second guess.
      try {
        detail = await runStep(deviceQuery, udid, step, { screen, options, frames, focus });
      } catch (thrown) {
        let err = thrown;
        // Ask the supervisor before anything is abandoned. It sits behind the
        // hands and in front of the reasoner: first responder, not
        // decision-maker, and its whole vocabulary is wait/retry/stop.
        const ruling = await superviseFailure(deviceQuery, {
          goal: supervise ?? flowName, step, expected: step.expect, err, options,
        });
        if (ruling?.decision === 'wait' || ruling?.decision === 'retry') {
          if (ruling.decision === 'wait') {
            await api.waitFor(deviceQuery, {
              mode: 'settle', stableMs: 400, timeoutMs: SUPERVISOR_WAIT_MS, options,
            }).catch(() => null);
          }
          try {
            detail = await runStep(deviceQuery, udid, step, { screen, options, frames, focus });
            detail += ` [the local supervisor said ${ruling.decision}; it worked on the second attempt]`;
            supervisions.push({ index: i, decision: ruling.decision, reason: ruling.reason, outcome: 'recovered' });
            continue;
          } catch (again) {
            supervisions.push({ index: i, decision: ruling.decision, reason: ruling.reason, outcome: 'still failed' });
            err = again;
          }
        } else if (ruling?.decision === 'stop') {
          supervisions.push({ index: i, decision: 'stop', reason: ruling.reason, outcome: 'stopped the run' });
          const remaining = steps.slice(i);
          err.message += ` — the local supervisor stopped the run here.`
            + ` ${remaining.length} step(s) were not attempted.`
            + ' If that judgement was wrong, re-issue the remaining steps with a `supervise` note'
            + ' telling it what to expect, and it will not stop for this reason again.';
          err.remainingSteps = remaining;
        }
        const { allowed, refused } = permittedAlternatives(step);
        if (!allowed.length || !mayRetryAfter(err)) {
          if (refused.length) {
            err.message += ` (${refused.length} alternative(s) refused locally: `
              + `${refused.map((r) => `"${r.label}" — ${r.reason}`).join('; ')})`;
          }
          throw err;
        }
        const tried = [step.value ?? step.target ?? step.label ?? step.into];
        let last = err;
        for (const label of allowed) {
          try {
            detail = await runStep(deviceQuery, udid, stepWithTarget(step, label), { screen, options, frames, focus });
            detail += ` [after ${tried.map((t) => JSON.stringify(String(t))).join(', ')} did not resolve]`;
            last = null;
            break;
          } catch (again) {
            tried.push(label);
            last = again;
            if (!mayRetryAfter(again)) break;
          }
        }
        if (last) {
          // When every selector misses and the screen moved a moment ago, the
          // problem is timing and not naming. Reported: three fallbacks all
          // failed because an asset list had not arrived, and the three-label
          // failure message read like a naming problem and pointed away from
          // the cause. The reporter's summary — *"fallbacks are a cure for 'I
          // named it wrong'; almost everything that actually failed failed
          // because 'it is not there yet'"* — is the finding, and the least a
          // failure can do is not mislead about which of the two it was.
          const churning = await recentlyChanged(deviceQuery, options);
          last.message = `none of ${tried.length} selector(s) resolved `
            + `(${tried.map((t) => JSON.stringify(String(t))).join(', ')}).`
            + (churning
              ? ` The screen has only been still for ${churning}ms, so this is very likely timing rather than naming:`
                + ' waitFor a string from the loaded state instead of adding more labels.'
              : ` Last: ${last.message}`);
          throw last;
        }
      }
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
        // An action whose correct outcome is that the screen stays put cannot
        // satisfy a change-based settle, so it pays the whole budget and then
        // reports failure. Measured on a still screen: 1.9-2.0 seconds burned,
        // `satisfied: false`, `sawChange: false`. Typing two fields on one form
        // spent about four seconds waiting for transitions that were never
        // going to happen, which is most of the gap a user sees between two
        // fields and none of it is thinking.
        //
        // These steps are verified by reading the field back instead — see
        // `fieldContents` — so the wait only has to cover the keystrokes
        // landing, not a navigation. A short budget, and no pretence that an
        // unsatisfied one means anything.
        const staysPut = graph.STAYS_ON_SCREEN.has(step.action);
        const w = await api.waitFor(deviceQuery, {
          mode: 'settle',
          since: before,
          stableMs: staysPut ? Math.min(stillness, STAYS_PUT_STILLNESS_MS) : stillness,
          timeoutMs: staysPut ? STAYS_PUT_BUDGET_MS : budgetMs,
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
          budgetMs: graph.STAYS_ON_SCREEN.has(step.action) ? STAYS_PUT_BUDGET_MS : budgetMs,
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
      // Hoisted because the note below is assembled outside the verification
      // block that owns `afterScreen`. Reaching into that scope from here threw
      // `afterScreen is not defined` on the very first step of a real run,
      // which is what running it on a device catches and reading it does not.
      let afterReading = null;
      if (verify && ACTION_STEPS.has(step.action) && beforeScreen?.hash) {
        const afterState = (await api.getState(deviceQuery, { options })).state;
        const kind = afterState.transition?.kind;
        const afterScreen = await api.screenIdentity(deviceQuery, { options, settleMs: stableMs, timeoutMs, confirmNovel });
        afterReading = afterScreen;
        verification = {
          ...withWayBack(
            stillArriving(
              belowThreshold(
                graph.verdict({
                  udid,
                  prediction,
                  before: beforeScreen,
                  // The whole reading, not just its name: it carries the tokens
                  // that let `nearestScreen`'s similarity tolerance recognise a
                  // screen whose content has changed. Passing hashes here is
                  // what made `unexpected-screen` fire on every run that varied
                  // its test data.
                  after: afterScreen,
                  kind,
                  action: step.action,
                }),
                settled,
              ),
              afterScreen,
            ),
            { udid, from: beforeScreen, landed: afterScreen },
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
      const filling = stillFillingIn(afterReading?.entry);
      const note = launchNote
        + (filling ? ` [settled, but ${filling} — waitFor content, do not act on this yet]` : '')
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
      // A variant that satisfies the next step is a note, not a halt.
      //
      // Reported twice in one round, and it is the direct cause of two flows
      // needing three calls instead of one. A tap landed on a *hash variant* of
      // the screen the edge remembered — the action had plainly worked, the
      // state was right, the CTA was enabled — and 26 remaining steps were
      // thrown away. Variant absorption cannot help once the variant has been
      // recorded as a node of its own, because absorption only claims an
      // unclaimed reading, so the mismatch becomes permanent.
      //
      // The evidence that settles it is the flow itself: if the next step's
      // target is on the screen we actually reached, we are somewhere the plan
      // can continue from, whatever the fingerprint thinks. That costs one
      // resolve on a path that otherwise costs a whole round trip, and it does
      // not soften the verdict — the mismatch is still reported and still
      // logged, because it is still the thing that found a real bug for a
      // reporter twice.
      const canContinue = await stillOnPlan(deviceQuery, verification, steps[i + 1], options);
      const halt = haltDecision({
        verification: canContinue ? { ...verification, verdict: 'unverified' } : verification,
        stopOnUnexpected,
        continueOnError,
      });
      if (canContinue) {
        results[results.length - 1].detail +=
          ` [landed on a variant of the expected screen; the next step resolves here, so continuing]`;
      }
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
      // Nothing downstream of a navigation that never happened can succeed, and
      // paying its timeouts one at a time is how `--continueOnError` spent 79
      // seconds on ten steps that could not possibly work — two `waitFor`s
      // serving their full 9,000 ms against a screen that had not moved. What
      // the operator saw was "you look stuck", and they were right.
      //
      // The evidence is the screen hash: consecutive failures against an
      // unchanged screen are not independent attempts, they are one failure
      // being re-paid. `continueOnError` means "do not stop at the first
      // problem"; it does not mean "keep going after the screen has stopped
      // responding to anything".
      const failedOn = beforeScreen?.hash ?? null;
      if (failedOn && failedOn === lastFailureScreen) {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 1;
        lastFailureScreen = failedOn;
      }
      if (consecutiveFailures >= STUCK_AFTER) {
        results[results.length - 1].error +=
          ` — ${consecutiveFailures} consecutive failures on an unchanged screen; stopping rather than paying the remaining timeouts`;
        failed = true;
        break;
      }
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
    // Every local ruling, so a wrong one is correctable rather than mysterious.
    // A `stop` also carries the steps it did not attempt, so the caller resumes
    // instead of re-planning.
    supervisions: supervisions.length ? supervisions : undefined,
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
 * Is this screen still filling in?
 *
 * Three times in one reported run, every list in an app arrived *after* the
 * settle declared the screen stable. `waitFor` on a row label fixes it, but
 * that requires already knowing a string that only exists once loaded — which
 * you can only learn by having failed once.
 *
 * Two signals, both already in hand and neither previously read. The tree often
 * publishes the spinner itself: the reporter's own map contained
 * `#13 element 201,263 loading`. And a list that renders its count before its
 * rows announces itself — the sharpest case in that round was a `waitFor` on
 * "Records" satisfied by the header **"21 Records"** while zero of the 21 rows
 * existed. Even a correctly written wait can be satisfied by a promise of
 * content rather than by content.
 */
const LOADING_LABEL = /^(loading|loading…|loading\.\.\.|please wait|fetching|refreshing)$/i;
const COUNT_HEADER = /^(\d[\d,]*)\s+(records?|results?|items?|rows?|entries)\b/i;

export function stillFillingIn(entry) {
  const targets = entry?.targets ?? [];
  if (!targets.length) return null;
  for (const t of targets) {
    if (LOADING_LABEL.test(String(t.label ?? '').trim())) {
      return 'a control on this screen still reads "loading"';
    }
  }
  const content = targets.filter((t) => (t.region ?? 'content') === 'content' && t.label);
  for (const t of content) {
    const m = COUNT_HEADER.exec(String(t.label).trim());
    if (!m) continue;
    const promised = Number(String(m[1]).replace(/,/g, ''));
    // The header itself, plus whatever chrome shares the region. Well short of
    // what it promised means the rows are still coming.
    if (Number.isFinite(promised) && promised >= 3 && content.length < promised / 2) {
      return `a header promises ${promised} ${m[2].toLowerCase()} and only ${content.length - 1} row(s) are here yet`;
    }
  }
  return null;
}

/**
 * Ask the local supervisor whether the plan can proceed past this failure.
 *
 * Everything it needs is already in hand: the step, the failure, what is on
 * screen, how long the screen has been still, and whatever the plan told it to
 * expect. It never sees pixels and never chooses an action.
 *
 * Its own prose is deliberately not trusted as an explanation. In testing it
 * returned a correct decision with a reason citing a rule that did not apply,
 * so the decision is used and the reason is recorded — never presented to the
 * caller as the ground for what happened. Presenting a confabulated rationale
 * as fact is the mistake `seek`'s documentation already made once.
 */
const SUPERVISOR_WAIT_MS = 4000;

async function superviseFailure(deviceQuery, { goal, step, expected, err, options }) {
  if (!supervisor.requested(options)) return null;
  try {
    const map = await view.screenMap(deviceQuery, { options, refresh: false });
    const stillMs = map.identity?.state?.motion?.stillForMs;
    return await supervisor.judge({
      goal,
      step: `${step.action} ${JSON.stringify(String(step.value ?? step.target ?? step.into ?? step.seek ?? '').slice(0, 60))}`,
      expected,
      failure: err.message,
      screen: (map.rows ?? []).filter((r) => r.label).map((r) => r.label),
      stillMs,
      note: stillFillingIn(map.identity?.entry),
      options,
    });
  } catch {
    return null;
  }
}

/**
 * How long ago the screen last moved, or null if it has been still.
 *
 * Used only to tell a timing failure from a naming failure, which is a
 * distinction every `or` chain in a reported round got wrong.
 */
async function recentlyChanged(deviceQuery, options, withinMs = 2500) {
  try {
    const { state } = await api.getState(deviceQuery, { options });
    // `changed` is a boolean and `motion.stillForMs` is the age. Reading
    // `changed` as a timestamp is a mistake worth naming, because it would have
    // silently reported "0ms ago" on every still screen and turned this hint
    // into the opposite of information.
    if (state?.changed === true) return 0;
    if (state?.transition?.kind === 'loading') return 0;
    const still = state?.motion?.stillForMs;
    if (!Number.isFinite(still)) return null;
    return still <= withinMs ? Math.round(still) : null;
  } catch {
    return null;
  }
}

/**
 * Try a step's alternatives before giving up on it.
 *
 * Four situations the owner gave, one after another, turned out to be one
 * problem: a location with no assets, a misclicked like, hunting a setting
 * through an unfamiliar menu tree, a search that returns nothing useful. *"All
 * done in maybe less than a second or a few seconds."* *"When I don't find what
 * I need somewhere I don't fall into an existential crisis. I look for it
 * somewhere else."*
 *
 * simframe answered all four the same way: the step threw, the batch was
 * abandoned, and the reasoner was asked. A step could only succeed or throw, and
 * throwing costs a round trip — `continueOnError` is all-or-nothing for a whole
 * run, which is why nobody used it.
 *
 * So a step may now carry its own fallbacks:
 *
 *     {"tap": "Save", "or": ["Done", "Confirm"]}
 *
 * They are tried locally, in order, and only an exhausted list reaches the
 * model. This lengthens the *batch* instead of multiplying the round trips,
 * which is the whole objective.
 *
 * **Which failures are eligible, and why the list is short.** Only a selector
 * that did not resolve — "that label is not here, try this one". A step that
 * resolved and then went somewhere unexpected is *not* eligible: retrying from
 * the wrong screen is nonsense, and the verdict now names the way back instead.
 * Getting this wrong turns a retry primitive into a way to hammer an app until
 * something gives.
 *
 * And an alternative is simframe's own initiative, so the destructive
 * vocabulary applies to it even though it does not apply to the step the caller
 * wrote. `{"tap": "DELETE"}` is a request and is honoured; substituting
 * "DELETE" for a "Done" that did not resolve is not.
 */
const RESOLVE_FAILURES = new Set(['unknown_screen', 'ambiguous_intent']);

export function alternativesFor(step) {
  const raw = step?.or ?? step?.orElse ?? step?.alternatives;
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v) => (typeof v === 'string' ? v : v?.value ?? v?.target ?? v?.label)).filter(Boolean);
}

export function mayRetryAfter(err) {
  const tagged = metrics.escalationOf(err);
  return Boolean(tagged && RESOLVE_FAILURES.has(tagged.reason));
}

/**
 * Which alternatives a local retry is permitted to try, and what was refused.
 */
export function permittedAlternatives(step, { locale } = {}) {
  const allowed = [];
  const refused = [];
  for (const label of alternativesFor(step)) {
    const verdict = vocabulary.mayActLocally(label, { locale });
    if (verdict.allowed) allowed.push(label);
    else refused.push({ label, reason: verdict.reason });
  }
  return { allowed, refused };
}

/** The step to run for an alternative: the same step, aimed somewhere else. */
export function stepWithTarget(step, label) {
  const next = { ...step };
  delete next.or;
  delete next.orElse;
  delete next.alternatives;
  for (const key of ['value', 'target', 'label', 'into']) {
    if (key in step) { next[key] = label; return next; }
  }
  next.value = label;
  return next;
}

/**
 * Say the way back, in the same breath as saying we went the wrong way.
 *
 * The owner's generalisation of the recovery problem, and it is the right one:
 * *"I go to Instagram, misclick a like button — humans aren't as accurate as
 * bots. I notice immediately, I go back or I remove the like. No need to think
 * for minutes and scan the whole of Instagram's philosophy. I use what I see."*
 *
 * That recovery needs no knowledge of the app at all. It needs to notice, and
 * to know the way back — and simframe already has both. `unexpected-screen`
 * notices in about 200ms, and `graph.route` can compute a path from where we
 * landed to where we were, from edges already recorded.
 *
 * It just never said so. The step threw, the batch died, and a model round trip
 * was spent deciding something the graph could already answer. This does not
 * remove the round trip — going back changes what happens next, so a person
 * should still choose it — but it makes one round trip sufficient instead of the
 * three to six the field reports spent working out where they were.
 */
export function wayBack(udid, from, landed, { graph: g = graph } = {}) {
  const fromHash = typeof from === 'string' ? from : from?.hash;
  const landedHash = typeof landed === 'string' ? landed : landed?.hash;
  if (!udid || !fromHash || !landedHash || fromHash === landedHash) return null;
  let path;
  try {
    path = g.route(udid, landedHash, fromHash, { maxDepth: 3 });
  } catch {
    return null;
  }
  if (!path?.length) return null;
  const steps = path.map((e) => {
    const st = e.step ?? {};
    const label = st.value ?? st.target ?? st.label ?? st.into;
    return label ? `${st.action ?? 'tap'} ${JSON.stringify(String(label).slice(0, 28))}` : (st.action ?? 'tap');
  });
  return `back to where you were: ${steps.join(' then ')}`
    + (path.length === 1 && path[0].count > 1 ? ` (seen ${path[0].count}x)` : '');
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
export function withWayBack(verification, { udid, from, landed, graph: g } = {}) {
  if (verification?.verdict !== 'unexpected-screen') return verification;
  const route = wayBack(udid, from, landed, g ? { graph: g } : undefined);
  return route ? { ...verification, detail: `${verification.detail} — ${route}` } : verification;
}

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
 * Can the plan continue from where we actually landed?
 *
 * Only asked when the verdict is `unexpected-screen`, and only answered by the
 * next step's own selector resolving here. A screen that can serve the next step
 * is not a wrong turn in any sense the caller cares about.
 */
async function stillOnPlan(deviceQuery, verification, nextStep, options) {
  if (verification?.verdict !== 'unexpected-screen' || !nextStep) return false;
  const target = nextStep.value ?? nextStep.target ?? nextStep.label ?? nextStep.into;
  // A coordinate resolves anywhere and a ref was numbered on another screen, so
  // neither is evidence about where we are.
  if (!target || /^#\d+$/.test(String(target).trim()) || /^@?-?\d+\s*,\s*-?\d+$/.test(String(target).trim())) return false;
  if (!ACTION_STEPS.has(nextStep.action) && nextStep.action !== 'assert' && nextStep.action !== 'waitFor') return false;
  try {
    const hit = await api.locate(deviceQuery, String(target), { options });
    return Boolean(hit?.target);
  } catch {
    return false;
  }
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

/**
 * Is the field focused? One read, and the answer is advisory.
 *
 * Filling one field used to be verified five times: the field exists, it took
 * focus, the text landed, the screen settled, the screen is still the screen.
 * None of that involves a model — it is all local — which is why several
 * seconds could pass between two fields with no thinking in them at all.
 *
 * Two of the five were change-based waits, and an action that changes nothing
 * cannot satisfy one: measured on a still screen, 1.9-2.0 seconds each, both
 * returning `satisfied: false`. Tapping into a text field barely moves the
 * screen, and with a hardware keyboard attached to the simulator no software
 * keyboard appears, so there is often nothing to see.
 *
 * The collapse is to verify the *result* rather than each precondition. If the
 * text landed, focus obviously worked, so checking focus first is redundant
 * with checking the outcome. This stays as a single ~85 ms accessibility read
 * because typing into an unfocused field loses the keystrokes, so it is worth
 * one cheap look — but it never blocks and it never fails the step. The
 * readback after typing decides.
 */
async function focusHint(deviceQuery, target, ctx) {
  try {
    const { entry } = await api.readScreenWith(deviceQuery, { useOcr: false, options: ctx.options });
    let elsewhere = false;
    for (const t of entry.targets ?? []) {
      if (t.focused !== true) continue;
      if (Math.hypot((t.x ?? 0) - target.x, (t.y ?? 0) - target.y) <= FIELD_READBACK_RADIUS) {
        return { focused: true, elsewhere: false };
      }
      elsewhere = true;
    }
    return { focused: false, elsewhere };
  } catch {
    return { focused: false, elsewhere: false };
  }
}

async function focusField(deviceQuery, udid, step, ctx) {
  const found = await api.locate(deviceQuery, step.into, { index: step.index, refresh: step.refresh });
  const tappedAt = Date.now();
  await input.tapPoint(udid, found.target.x, found.target.y);
  const focused = await focusHint(deviceQuery, found.target, ctx);
  // The focus distribution is no longer collected, and that is deliberate.
  // It existed to size the focus *wait*, and there is no focus wait any more —
  // one accessibility read replaced it. Banking the duration of that read under
  // the same name would keep a number nobody uses, measuring something other
  // than what its name says, which is the shape of the learned-stillness
  // mistake. `graph.focusPlan` and the `focusSamples` it reads stay in place
  // for now, unfed; if nothing claims them they should go.
  void tappedAt;
  return {
    found,
    where: `"${found.target.label}" at ${found.target.x},${found.target.y}`,
    // Only claimed when the tree named a *different* focused element. "The
    // tree says nothing about focus" is not evidence the tap missed, and
    // asserting it from a screen that simply did not move is what made this
    // note wrong on a correctly focused field.
    // Only claimed when the tree named a *different* focused element. Silence
    // about focus is not evidence the tap missed, and asserting it from a
    // screen that simply did not move is what made this note wrong on a
    // correctly focused field.
    quiet: focused.elsewhere && !focused.focused ? ' [focus is on another element of this screen]' : '',
  };
}

/**
 * Look for something that is not on this screen, the way a person does.
 *
 * The owner's description, and it is the behaviour this implements: *"I am in a
 * new app's settings, I look for something like change username. I go to each
 * menu, check the items, nothing like that? Next menu, until I find it."* And:
 * *"when I don't find what I need somewhere, I don't fall into an existential
 * crisis. I look for it somewhere else."*
 *
 * Today a miss is an existential crisis — nothing resolves, the step throws, the
 * batch dies, and the reasoner is asked. Twelve of 173 escalations, each one
 * stopping a batch, so a five-menu hunt costs ten or more round trips for
 * something a person does in seconds.
 *
 * `seek` opens containers, checks, and comes back, inside a hard budget.
 *
 * **It acts, and saying otherwise is what made it dangerous.** The first
 * version of this comment said it "finds and does not act", meaning it does not
 * tap the *target* — but opening a door is an action, doors change state, and a
 * reader who trusted that sentence handed `seek` a flow it could destroy. It
 * did: it opened CANCEL, then AI TROUBLESHOOTING, then pressed "YES, THIS FIXED
 * MY PROBLEM", ending five screens deep in a live support chat with a
 * half-completed service request gone. One label further along was SUBMIT
 * SERVICE REQUEST.
 *
 * What is true: it does not tap the target — it leaves you on the screen where
 * the target resolves and says so, and the caller taps it as the next step of
 * the same batch. What it *does* tap is doors, filtered by the exploration
 * vocabulary (`vocabulary.openableAsDoor`), which is much stricter than the
 * substitution list and refuses anything that commits, abandons, answers or
 * leaves. And it returns to the screen it started from before handing back,
 * saying plainly when it could not.
 *
 * Ordering is the pluggable part, and the only part a local model touches. With
 * `SIMFRAME_PLANNER` unset the order is mechanical — the screen's own reading
 * order — and every candidate gets tried anyway; the model only changes which
 * comes first. That is why it is safe to try and why it is A/B-testable: run the
 * same flow with the flag off and on and compare steps to target.
 */
export const SEEK_BUDGET = 6;

/** How many candidates a ranker is asked about, and how long a door gets to open. */
export const SEEK_RANK_CANDIDATES = 12;
/** How many back-steps a failed seek may spend returning to where it began. */
const RETURN_BUDGET = 8;
/** How long a disagreeing assert waits before looking again. */
const ASSERT_RETAKE_MS = 900;
/** Consecutive failures on one unchanged screen before a continue-on-error run gives up. */
export const STUCK_AFTER = 3;
const SEEK_SETTLE_MS = 1200;

async function candidatesToOpen(deviceQuery, udid, { visited, options }) {
  const map = await view.screenMap(deviceQuery, { options, refresh: true });
  const here = map.identity?.hash ?? null;
  const labels = [];
  for (const r of map.rows ?? []) {
    // Content only. A nav-bar title is not a door — the first version of this
    // opened "Settings", which is the name of the screen it was already on.
    if ((r.region ?? 'content') !== 'content') continue;
    if (!r.label || r.enabled === false) continue;
    if (visited.has(String(r.label))) continue;
    // Permissive about *shape*, strict about *vocabulary* — and that pairing is
    // the correction, not a loosening. Requiring `actsInteractive` found **zero
    // doors** on a screen holding two real pickers, because a React Native
    // picker is a generic element with no value and the tree has been wrong
    // about roles in every round. Meanwhile the door vocabulary was too loose
    // and opened CANCEL. The tree is unreliable about what is tappable and the
    // label is reliable about what must not be opened, so trust each where it
    // is trustworthy.
    if (!vocabulary.openableAsDoor(r.label)) continue;
    // A paragraph is not a door.
    if (String(r.label).length > 48) continue;
    labels.push(String(r.label));
  }
  return { here, map, labels: [...new Set(labels)] };
}

/**
 * Get back to the screen above, by whatever means this app offers.
 *
 * This is where `seek` first stranded itself, on a finding already in
 * DEFERRED: the nav-bar back chevron is invisible to simframe, so
 * `locate("back")` throws and one door was all it ever opened. The left-edge
 * gesture needs no label and works on any pushed screen, so it is the fallback
 * rather than the exception — and the return is confirmed, because a swipe that
 * did nothing would make the next candidate a tap on a screen we did not mean
 * to be on.
 */
async function goBack(deviceQuery, udid, step, ctx, { from, to }) {
  const byLabel = await (async () => {
    try {
      const route = from && to ? graph.route(udid, from, to, { maxDepth: 1 }) : null;
      const st = route?.length === 1 ? route[0].step ?? {} : {};
      const label = st.value ?? st.target ?? st.label;
      return label && vocabulary.actableLocally(label) ? String(label) : 'back';
    } catch {
      return 'back';
    }
  })();
  let acted = false;
  try {
    const b = await api.locate(deviceQuery, byLabel, { options: ctx.options });
    await input.tapPoint(udid, b.target.x, b.target.y);
    acted = true;
  } catch { /* no visible back control — use the gesture */ }
  if (!acted) {
    try {
      const geo = await ctx.screen();
      const y = Math.round((geo.pointHeight ?? 874) / 2);
      await input.swipe(udid, { x: 2, y }, { x: Math.round((geo.pointWidth ?? 402) * 0.6), y }, { durationMs: 250 });
      acted = true;
    } catch {
      return false;
    }
  }
  await api.waitFor(deviceQuery, { mode: 'settle', stableMs: step.stableMs ?? 400, timeoutMs: step.timeoutMs ?? SEEK_SETTLE_MS, options: ctx.options });
  try {
    const now = await api.screenIdentity(deviceQuery, { options: ctx.options, confirmNovel: false });
    return Boolean(now.hash) && now.hash !== from;
  } catch {
    return false;
  }
}

async function seek(deviceQuery, udid, step, ctx) {
  const goal = step.seek ?? step.value ?? step.target;
  if (!goal) throw new Error('usage: {"seek": "what you are looking for"}');
  const budget = Math.max(1, Math.min(step.budget ?? SEEK_BUDGET, 12));
  const options = ctx.options;

  const found = async () => {
    try {
      const r = await api.locate(deviceQuery, String(goal), { options });
      return r?.target ? r : null;
    } catch {
      return null;
    }
  };

  const already = await found();
  if (already) return `"${goal}" is already here: "${already.target.label}" at ${already.target.x},${already.target.y}`;

  // Keyed on the label alone, not label-per-screen. Keying it per screen let it
  // cycle — General, About, General, Screen Capture, General, About — because a
  // list's identity is not perfectly stable across a return to it, so the same
  // door read as unvisited. Within one seek, one attempt per label is enough.
  const visited = new Set();
  const opened = [];
  const trail = [];
  let spent = 0;
  const origin = await (async () => {
    try {
      return (await api.screenIdentity(deviceQuery, { options, confirmNovel: false })).hash ?? null;
    } catch {
      return null;
    }
  })();

  // Depth-first, because that is what a person does: Accessibility, then
  // Display & Text Size, then Larger Text. The first version always came back
  // after one probe and could never reach anything two levels down, which is
  // where most settings live.
  while (spent < budget) {
    const { here, labels } = await candidatesToOpen(deviceQuery, udid, { visited, options });
    if (!labels.length) {
      // Nothing new here. Back out to the screen above and try its next door.
      if (!trail.length) break;
      const to = trail.pop();
      if (!await goBack(deviceQuery, udid, step, ctx, { from: here, to })) break;
      continue;
    }
    // Only the first handful go to the ranker. A forty-label prompt costs more
    // to answer and the budget will never reach the tail anyway; and the model
    // is asked about candidates, not given the screen.
    const asked = labels.slice(0, SEEK_RANK_CANDIDATES);
    const ranked = await planner.rank(String(goal), asked, { deviceOptions: options });
    const ordered = ranked ? [...ranked, ...labels.slice(SEEK_RANK_CANDIDATES)] : labels;
    const pick = ordered[0];
    visited.add(pick);
    spent += 1;

    try {
      const door = await api.locate(deviceQuery, pick, { options });
      await input.tapPoint(udid, door.target.x, door.target.y);
    } catch {
      continue; // a label that will not resolve is not a door
    }
    await api.waitFor(deviceQuery, { mode: 'settle', stableMs: step.stableMs ?? 400, timeoutMs: step.timeoutMs ?? SEEK_SETTLE_MS, options });

    let landed = null;
    try {
      landed = (await api.screenIdentity(deviceQuery, { options, confirmNovel: false })).hash;
    } catch { /* unknown where we are; the found() check still decides */ }
    // A door that led nowhere is not a door, and descending would corrupt the
    // trail with a screen we never left.
    if (landed && landed !== here) trail.push(here);

    const hit = await found();
    if (hit) {
      return `found "${goal}" as "${hit.target.label}" at ${hit.target.x},${hit.target.y}`
        + ` after opening ${opened.concat(pick).map((l) => JSON.stringify(l)).join(' -> ')}`
        + ` (${spent} of ${budget} step(s)${planner.requested(options) ? ', planner-ordered' : ''})`;
    }
    opened.push(pick);
  }

  // Come back before handing over.
  //
  // The contract is depth-first *with return*, and on failure it was not: a
  // reported run ended five doors deep in a live support chat, on an unrelated
  // screen, with the flow it started from destroyed. Leaving a caller somewhere
  // they did not ask to be is worse than failing, because everything they try
  // next is aimed at the wrong screen.
  let restored = origin == null;
  for (let i = 0; i < RETURN_BUDGET && !restored; i += 1) {
    let now = null;
    try {
      now = (await api.screenIdentity(deviceQuery, { options, confirmNovel: false })).hash;
    } catch { break; }
    if (now === origin) { restored = true; break; }
    if (!await goBack(deviceQuery, udid, step, ctx, { from: now, to: origin })) break;
  }

  // Say where we got to and what is there, not just that we failed.
  //
  // Measured on the first real run of this: with the ranker on, `seek "make the
  // text bigger"` went Accessibility -> Display & Text Size in two steps — the
  // right place — and then reported "not found", because the control is called
  // "Larger Text" and `locate` matches labels lexically. The navigation was
  // right and the arrival was unreportable, so the caller learned nothing from a
  // 20-second search.
  //
  // The whole point of a local tier is to make ONE round trip sufficient. So the
  // hand-back carries the landing: where we are, and what is on it.
  const landing = await (async () => {
    try {
      const map = await view.screenMap(deviceQuery, { options, refresh: false });
      const here = (map.rows ?? [])
        .filter((r) => (r.region ?? 'content') === 'content' && r.label)
        .slice(0, 12)
        .map((r) => JSON.stringify(String(r.label).slice(0, 32)));
      return here.length ? ` Now on ${map.name ? `"${map.name}"` : (map.identity?.hash ?? 'an unnamed screen').slice(0, 8)}, which offers: ${here.join(', ')}.` : '';
    } catch {
      return '';
    }
  })();
  throw metrics.tag(
    new Error(
      `"${goal}" did not resolve by label within ${spent} of ${budget} steps.`
      + (opened.length ? ` Opened: ${opened.map((l) => JSON.stringify(l)).join(' -> ')}.` : ' Nothing here looked like a container.')
      + landing
      + (restored
        ? ' Back on the screen you started from.'
        : ' **You are not back where you started** — the way back could not be found, so read the screen before acting.')
      + ' If one of those is what you meant, tap it by name; otherwise say where to look or raise the budget.',
    ),
    'no_plan',
    { intent: String(goal), tried: opened },
  );
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
        let back = readbackNote(sent, await fieldContents(deviceQuery, field.found.target, sent, ctx));
        // Verifying the outcome instead of the precondition puts the race where
        // it actually shows up. If the keystrokes arrived before the field had
        // focus they are simply gone — one local retry costs about 200ms, and
        // throwing here cost an aborted batch and a model round trip.
        if (back.empty) {
          await input.tapPoint(udid, field.found.target.x, field.found.target.y);
          await input.typeText(udid, sent);
          back = readbackNote(sent, await fieldContents(deviceQuery, field.found.target, sent, ctx));
          if (back.empty) {
            throw new Error(
              `typed into ${field.where} twice and the field still reads empty — the text is not landing.`
              + ' paste is more reliable than type on this path; keys sends literal characters, not named keys.',
            );
          }
          return `typed into ${field.where}${back.note} [took two attempts; the first keystrokes did not land]`;
        }
        return `typed into ${field.where}${back.note}${back.landed ? '' : field.quiet}`;
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
        return `pasted into ${field.where}${back.note}${back.landed ? '' : field.quiet}`;
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
    case 'seek':
      return seek(deviceQuery, udid, step, ctx);
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
        // Fresh by default, and this was the single most expensive finding in a
        // reported round. `assert REVIEW is enabled` failed while the map
        // printed by that very call showed the button enabled three lines
        // below: the assert had resolved against screen *memory*, and state
        // changes without a screen's identity changing.
        //
        // A verification step reading a cached map is self-defeating. It costs
        // one perception pass, which is the same trade Phase 11.5 made for the
        // trailing map and for the same reason — a read is cheaper than the
        // round trip a wrong verdict causes.
        //
        // The reporter's framing is why this is worth a paragraph: *"I put an
        // assert in to be careful, and being careful is what broke the flow.
        // The lesson an agent learns is 'do not assert inside batches', which
        // is the opposite of what you want learned."*
        found = await api.locate(deviceQuery, query, { index: step.index, refresh: step.refresh !== false, options: ctx.options });
      } catch (err) {
        if (want === 'gone') return `${query} is gone`;
        throw new Error(`${query}: ${err.message}`);
      }
      // A state that disagrees earns one more look, because the state may have
      // arrived between the action and the assert — which is exactly what a
      // batch does. `tap` already re-takes a stale baseline and says so.
      const disagrees = (t) => (want === 'enabled' && t.enabled === false)
        || (want === 'disabled' && t.enabled !== false);
      let retook = '';
      if (disagrees(found.target)) {
        await api.waitFor(deviceQuery, {
          mode: 'settle', stableMs: 250, timeoutMs: ASSERT_RETAKE_MS, options: ctx.options,
        }).catch(() => null);
        try {
          const again = await api.locate(deviceQuery, query, { index: step.index, refresh: true, options: ctx.options });
          if (!disagrees(again.target)) {
            found = again;
            retook = ' [state arrived between the action and the assert; re-read from the live screen]';
          }
        } catch { /* keep the first reading and report it */ }
      }
      const t = found.target;
      switch (want) {
        case 'visible':
          return `${query} is on screen at ${t.x},${t.y}`;
        case 'gone':
          throw new Error(`${query} is still on screen at ${t.x},${t.y}`);
        case 'enabled':
          if (t.enabled === false) throw new Error(`"${t.label}" is disabled, and still disabled on a second look`);
          return `"${t.label}" is enabled${retook}`;
        case 'disabled':
          if (t.enabled !== false) throw new Error(`"${t.label}" is not disabled, on two looks`);
          return `"${t.label}" is disabled${retook}`;
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
