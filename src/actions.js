// The batch engine. A flow that would cost one model round trip per tap runs
// here as a single call: act, wait for the screen to settle, assert, repeat.
// Waiting uses a baseline captured BEFORE each action, which is the whole
// reason these scripts are reliable rather than racy.
import * as api from './index.js';
import * as graph from './graph.js';
import * as input from './input.js';
import * as intent from './intent.js';
import { launchApp, openUrl, setPasteboard, setPermission, terminateApp } from './simctl.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_PAUSE_MS = 5000;
/** How long a text field needs after being tapped before it holds the keyboard focus. */
const FOCUS_SETTLE_MS = 150;
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
    options,
  } = {},
) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('a script needs at least one step');
  const { device } = await api.ensureDaemon(deviceQuery, options);
  const udid = device.udid;
  const startedAt = Date.now();

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
      const detail = await runStep(deviceQuery, udid, step, { screen, options, frames });
      let settled = null;
      if (autoSettle && ACTION_STEPS.has(step.action)) {
        const w = await api.waitFor(deviceQuery, {
          mode: 'settle',
          since: before,
          stableMs: step.stableMs ?? stableMs,
          timeoutMs: step.timeoutMs ?? timeoutMs,
          options,
        });
        settled = {
          ok: w.satisfied,
          waitedMs: w.waitedMs,
          sawChange: w.sawChange,
          stalled: Boolean(w.stalled),
          noVisibleChange: Boolean(w.noVisibleChange),
        };
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
          graph.record(udid, { from: beforeScreen, action: step, to: afterScreen, kind });
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
      if (halt.halt) {
        results[results.length - 1].ok = false;
        results[results.length - 1].error = halt.error;
        failed = halt.failRun;
        break;
      }
    } catch (err) {
      results.push({ index: i, action: step.action, ok: false, ms: Date.now() - stepStart, error: err.message });
      failed = true;
      if (!continueOnError) break;
    }
  }

  return {
    device,
    // Returned so a run that verified end to end can be handed straight to
    // navigate.saveFlow without the caller reassembling what it just ran.
    steps,
    endScreen,
    results,
    ok: !failed,
    totalMs: Date.now() - startedAt,
    ranSteps: results.length,
    totalSteps: steps.length,
    frames,
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
        // locate, not tapLabel: tapLabel asks the accessibility tree directly,
        // so a field that only OCR can see was untypeable, and a selector
        // (`#4`, `@x,y`) meant nothing here.
        const found = await api.locate(deviceQuery, step.into, { index: step.index, refresh: step.refresh });
        await input.tapPoint(udid, found.target.x, found.target.y);
        await sleep(FOCUS_SETTLE_MS);
        await input.typeText(udid, step.text ?? step.value);
        return `typed into "${found.target.label}" at ${found.target.x},${found.target.y}`;
      }
      await input.typeText(udid, step.text ?? step.value);
      return 'typed text';
    }
    case 'paste': {
      // Long strings are much faster on the pasteboard than through the keyboard.
      await setPasteboard(udid, step.text ?? step.value);
      if (step.into) await input.tapLabel(udid, step.into, { index: step.index, durationMs: 900 });
      return 'placed text on the pasteboard';
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
