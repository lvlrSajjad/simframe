// The batch engine. A flow that would cost one model round trip per tap runs
// here as a single call: act, wait for the screen to settle, assert, repeat.
// Waiting uses a baseline captured BEFORE each action, which is the whole
// reason these scripts are reliable rather than racy.
import * as api from './index.js';
import * as input from './input.js';
import * as intent from './intent.js';
import { launchApp, openUrl, setPasteboard, terminateApp } from './simctl.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_PAUSE_MS = 5000;

const ACTION_STEPS = new Set([
  'tap', 'tapAt', 'type', 'paste', 'swipe', 'scroll', 'button', 'key',
  'launch', 'terminate', 'openUrl', 'confirm', 'chooseAny', 'fillRequired',
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
  return { ...rest, ...inline, action: key };
}

export async function runScript(
  deviceQuery,
  { steps, autoSettle = true, stableMs = 500, timeoutMs = 8000, continueOnError = false, options } = {},
) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('a script needs at least one step');
  const { device } = await api.ensureDaemon(deviceQuery, options);
  const udid = device.udid;
  const startedAt = Date.now();

  const needsInput = steps.some((s) => ACTION_STEPS.has(normalizeStep(s).action));
  if (needsInput) {
    const driver = await input.detectDriver();
    if (!driver.available) throw new Error(driver.reason);
  }

  let geometry = null;
  const screen = async () => (geometry ??= await input.screenInfo(udid));

  const results = [];
  const frames = [];
  let failed = false;

  for (const [i, raw] of steps.entries()) {
    const step = normalizeStep(raw);
    const stepStart = Date.now();
    // The baseline for "did the screen react" must predate the action itself.
    const before = (await api.getState(deviceQuery, { options })).state.hash;
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
      const note = settled?.noVisibleChange ? ' [no visible change]' : '';
      results.push({
        index: i,
        action: step.action,
        ok: true,
        ms: Date.now() - stepStart,
        detail: `${detail}${note}`,
        settled,
      });
    } catch (err) {
      results.push({ index: i, action: step.action, ok: false, ms: Date.now() - stepStart, error: err.message });
      failed = true;
      if (!continueOnError) break;
    }
  }

  return {
    device,
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
    case 'fillRequired': {
      const geo = await ctx.screen();
      const filled = [];
      const skipped = [];
      const maxRounds = step.rounds ?? 6;
      for (let round = 0; round < maxRounds; round++) {
        const nodes = await input.describeAll(udid);
        const pending = intent.findUnsatisfied(nodes).filter((n) => intent.onScreen(n, geo));
        const offscreen = intent.findUnsatisfied(nodes).filter((n) => !intent.onScreen(n, geo));
        for (const o of offscreen) {
          const name = (o.label || o.type || '?').slice(0, 40);
          if (!skipped.includes(name)) skipped.push(name);
        }
        if (!pending.length) break;
        const target = pending[0];
        const point = input.centerOf(target);
        const name = (target.label || target.type || 'field').split(',')[0].slice(0, 32);
        await input.tapPoint(udid, point.x, point.y);
        await sleep(step.settleMs ?? 900);
        if (intent.isTextInput(target)) {
          await input.typeText(udid, step.text ?? 'simframe');
          filled.push(`${name}=text`);
        } else {
          try {
            const chosen = await intent.chooseAny(udid, { geo });
            await sleep(400);
            await intent.confirm(udid, { geo });
            filled.push(`${name}="${chosen.label.slice(0, 24)}"`);
          } catch (err) {
            // A control that opened nothing pickable is not worth another round.
            skipped.push(`${name} (${err.message})`);
          }
        }
        await sleep(step.settleMs ?? 900);
      }
      const parts = [];
      if (filled.length) parts.push(`filled ${filled.join(', ')}`);
      if (skipped.length) parts.push(`could not reach: ${skipped.join('; ')}`);
      return parts.join(' | ') || 'nothing required was outstanding';
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
