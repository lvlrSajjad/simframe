// The batch engine. A flow that would cost one model round trip per tap runs
// here as a single call: act, wait for the screen to settle, assert, repeat.
// Waiting uses a baseline captured BEFORE each action, which is the whole
// reason these scripts are reliable rather than racy.
import * as api from './index.js';
import * as graph from './graph.js';
import * as input from './input.js';
import * as intent from './intent.js';
import { launchApp, openUrl, setPasteboard, terminateApp } from './simctl.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_PAUSE_MS = 5000;

const ACTION_STEPS = new Set([
  'tap', 'tapAt', 'type', 'paste', 'swipe', 'scroll', 'button', 'key',
  'launch', 'terminate', 'openUrl', 'confirm', 'chooseAny',
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
          ...graph.verdict({ prediction, before: beforeScreen.hash, after: afterScreen.hash, kind }),
          predicted: prediction ? { to: prediction.to.slice(0, 10), kind: prediction.kind, seen: prediction.count } : null,
          observed: { to: afterScreen.hash?.slice(0, 10), kind },
        };
        // Only remember what was seen on a settled screen: an edge recorded
        // mid-transition points at a screen that never really existed.
        // `confirmed` already means the fingerprint held still across two
        // independent readings, which is the thing `settled` was standing in
        // for. Requiring both meant a screen that settled slowly recorded
        // nothing at all.
        if (afterScreen.confirmed && afterScreen.hash) {
          graph.record(udid, { from: beforeScreen, action: step, to: afterScreen, kind });
          carriedScreen = afterScreen;
        }
      }

      // Only an unexpected *screen* stops a flow. Identity is reliable now
      // that it is structural; the transition kind is not — Phase 4's
      // classifier reports `replace` for a scroll that rubber-bands, and
      // halting a correct flow on that is worse than noting it.
      const wrongTurn = verification?.verdict === 'unexpected-screen';
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
      if (wrongTurn && stopOnUnexpected && !continueOnError) {
        results[results.length - 1].ok = false;
        results[results.length - 1].error = `${verification.verdict}: ${verification.detail}`;
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
        const { node } = await input.tapLabel(udid, step.into, { index: step.index });
        await sleep(150);
        await input.typeText(udid, step.text ?? step.value);
        return `typed into "${node.label ?? step.into}"`;
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
    case 'launch':
      await launchApp(udid, step.value ?? step.bundleId);
      return `launched ${step.value ?? step.bundleId}`;
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
