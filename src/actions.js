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
const FOCUS_STABLE_MS = 250;
/**
 * Long enough for a slow capture loop to produce a frame or two. The screenshot
 * engine idles at 1.5 fps — 667 ms between frames — so anything under that is a
 * verdict reached before there was anything to look at.
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
      escalations.push(metrics.recordEscalation(udid, { flowId, ...record }));
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

  for (const [i, raw] of steps.entries()) {
    const step = normalizeStep(raw);
    const stepStart = Date.now();
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
      let detail = await runStep(deviceQuery, udid, step, { screen, options, frames });
      // How long this transition has cost before, on this screen, for this
      // action. A cold edge gets the old fixed default and says so; a measured
      // one gets p95 plus a margin. Research §7.
      const learned = verify && beforeScreen?.hash ? graph.timingFor(udid, beforeScreen, step) : null;
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
          ...graph.verdict({ udid, prediction, before: beforeScreen.hash, after: afterScreen.hash, kind }),
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
        if (afterScreen.confirmed && afterScreen.hash) {
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
          });
          carriedScreen = afterScreen;
        }
      }

      const wrongTurn = wrongTurnFrom(verification);
      const note = settled?.noVisibleChange ? ' [no visible change]' : '';
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
        outcome: 'failed',
        wallMs: Date.now() - stepStart,
        detail: err.message,
      });
      failed = true;
      if (!continueOnError) break;
    }
  }

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
async function focusField(deviceQuery, udid, step, ctx) {
  const found = await api.locate(deviceQuery, step.into, { index: step.index, refresh: step.refresh });
  await input.tapPoint(udid, found.target.x, found.target.y);
  const focused = await api.waitFor(deviceQuery, {
    mode: 'settle',
    stableMs: FOCUS_STABLE_MS,
    reactionMs: FOCUS_REACTION_MS,
    timeoutMs: FOCUS_TIMEOUT_MS,
    options: ctx.options,
  });
  return {
    found,
    where: `"${found.target.label}" at ${found.target.x},${found.target.y}`,
    quiet: focused.satisfied ? '' : ' [the field did not visibly take focus]',
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
        await input.typeText(udid, step.text ?? step.value);
        return `typed into ${field.where}${field.quiet}`;
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
        await input.pasteText(udid, step.text ?? step.value);
        return `pasted into ${field.where}${field.quiet}`;
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
