#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDaemon, DEFAULTS } from './daemon.js';
import { bootedDevices, capabilitiesFor, listDevices, PLATFORMS, resolveDevice, restartDevice, screenshot, toolchainChecks } from './platform/index.js';
import * as actions from './actions.js';
import * as analyze from './analyze.js';
import * as api from './index.js';
import * as input from './input.js';
import * as baseline from './baseline.js';
import * as metrics from './metrics.js';
import * as navigate from './navigate.js';
import { decodePng } from './png.js';
import * as store from './store.js';
import * as view from './view.js';

const USAGE = `simframe — always-warm iOS Simulator frames

  simframe mcp                       run the MCP server on stdio (for agents)
  simframe start   [device]          start the capture loop in the background
  simframe stop    [device|--all]    stop the capture loop
  simframe status  [device]          show daemon and newest-frame status
  simframe input   reset             rebuild the HID session (see doctor)
  simframe frame   [device]          write the newest frame to a file
  simframe state   [device]          print frame metadata and the change map
  simframe mark    [device]          print the current frame hash, to use as --since
  simframe wait    [device]          wait for the screen to react (see --mode)
  simframe strip   [device]          write a contact sheet of recent frames
  simframe recall  [device]          what happened in the last minute (--ago=<ms> for a frame)
  simframe ui      [device]          the screen as a numbered element map
  simframe find    "<intent>"        resolve an intent to one control
  simframe tap     <selector>        tap #3, "Save", or @120,400
  simframe do      <script.json>     run a scripted flow (see below)
  simframe screens [device]          list screens this device has learned
  simframe goto    <screen>          walk to a known screen through known steps
  simframe flow    save <name> <script.json>   run a flow and save it if every step verifies
  simframe flow    run  <name>       replay a saved flow
  simframe flow    list              list saved flows
  simframe tapAt   <x> <y>           tap at a point, in points
  simframe swipe   <x1> <y1> <x2> <y2>   swipe between two points
  simframe type    <text>            enter text (exact; uses the pasteboard)
  simframe keys    <text>            send key events instead (layout-dependent)
  simframe press   <button>          a hardware button, e.g. home
  simframe baseline record <flow>    record a human performing a flow (see below)
  simframe baseline summarize <flow> write the median/IQR baseline for it
  simframe baseline list             recorded runs per flow, and what is committed
  simframe hpi     [device]          Human Parity Index, per flow and overall
  simframe escalations [device]      why simframe handed decisions back, by reason
  simframe supervisions [device]     local supervisor rulings, and what came of each
  simframe revive [device]           power-cycle a wedged device: stop, shutdown, boot, start, reset input
                                     (--session=<id> narrows to one agent; the
                                     ids are listed in the output. SIMFRAME_SESSION
                                     names one, but only at process start — an
                                     already-running MCP server cannot pick it up)
  simframe devices                   list simulators
  simframe doctor                    check that this machine can capture
                                     (--strict, or SIMFRAME_STRICT=1, makes any
                                      degraded layer a non-zero exit)

Selectors — anywhere a control is named, best first
  "Save"        a label or a phrase, resolved by intent (verbs, typos, synonyms,
                icon-only controls by their common name). Start here.
  #3            the number \`simframe ui\` gave it. Exact, but only inside the
                round trip that numbered it — the screen moves and it does not.
  @120,400      raw point coordinates. Last resort: it cannot tell you it missed.

Measuring against a human — the Human Parity Index

  A flow's agent time is measured every time it runs; the human half has to be
  recorded once, by a person, on the same simulator:

    simframe baseline record settings-larger-text --device=<udid> --runs=5
    simframe baseline summarize settings-larger-text
    simframe hpi --device=<udid>

  \`record\` puts the device on the home screen, waits for you to start, and
  waits again for you to stop. Wall time is measured between those two; the
  step count is derived from screen transitions, because a human tapping the
  Simulator window leaves no HID log to read. Five runs is the recommendation
  and three is the floor. The flows live in flows/hpi-suite.json.

Options
  --device=<udid|name>   simulator to target (default: the booted one)
  --json                 machine-readable output — on every command
  --out=<file>           output path for frame/strip/recall
  --detail=low|normal|high|full   or --detail=<max pixels>
  --engine=simframed|screenshot  capture engine (default: the fastest the device has)
  --fps=<n>              capture rate while the screen is moving (screenshot engine only)
  --count=<n>            frames in a strip (default 5)
  --since=<hash|seq>     compare against this frame (see: simframe mark)
  --mode=settle|change|stable   what wait waits for (default settle)
  --stable-ms=<n>        settle window for wait (default 600)
  --timeout-ms=<n>       give up after this long (default 8000)
  --filter=<text>        ui: only elements whose text contains this
  --interactive          ui: only elements that look tappable
  --all                  ui: include the status bar and collapsed regions
  --refresh              ui: re-read this screen instead of using memory
  --save=<name>          do: save the flow if every step verifies
  --force                let stop kill a loop another client is using;
                         let flow save keep an unverified flow

A script is a JSON array of steps, run in one go with a settle between each:

  [{"tap":"Assets"},{"tap":"Add Asset"},
   {"type":{"into":"Name","text":"Fryer 3"}},
   {"scrollTo":"Save"},{"tap":"Save"},
   {"waitFor":{"value":"Saved","timeoutMs":5000}},
   {"assert":{"value":"Saved","is":"visible"}}]

Input, text recognition and the accessibility tree all come from the daemon.
Nothing else needs installing; idb remains a fallback for the tree and for
input on a machine where the daemon cannot run.

The reliable pattern around an action is:

  H=$(simframe mark)
  ...tap, launch or navigate...
  simframe wait --since=$H --mode=settle
  simframe state --since=$H
`;

/**
 * Flags that take a value, so `--flag value` can mean what it looks like.
 *
 * Deliberately not every flag: `--json`, `--refresh` and friends have a bare
 * form, and letting those swallow the next argument would turn
 * `simframe tap --refresh Save` into a tap on nothing.
 */
const VALUE_FLAGS = new Set([
  'ago', 'count', 'detail', 'device', 'durationMs', 'engine', 'filter', 'fps', 'index', 'maxDim',
  'mode', 'out', 'ringSize', 'since', 'spanMs', 'stableMs', 'timeoutMs',
  'last', 'runs', 'suite', 'keepLast', 'reason',
]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (value !== undefined) {
        flags[camel] = value;
      } else if (VALUE_FLAGS.has(camel) && argv[i + 1] != null && !argv[i + 1].startsWith('--')) {
        // `--device X` as well as `--device=X`. Only for flags whose bare form
        // means nothing: `simframe doctor --device B55AB0AE` used to set
        // `device` to `true`, push the udid to positional, and resolve the
        // literal string "true" — and doctor's own advice is to name a device
        // with --device, which is exactly how someone would write it.
        flags[camel] = argv[i + 1];
        i += 1;
      } else {
        flags[camel] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const num = (v, fallback) => (v == null ? fallback : Number(v));

/**
 * Print one thing, two ways.
 *
 * `--json` is on every command rather than most of them, because a skill or a
 * script that has to parse one command's prose and another's JSON will parse
 * the prose wrong exactly once and then be trusted anyway.
 */
/**
 * The machine-readable half of a failure.
 *
 * A refusal recognisable only by reading its prose is a refusal nobody can
 * depend on. Our own CI asserted the stale-ref guard by matching three
 * phrasings and went red when a fourth arrived — a *better* one, naming the
 * label the number stood for. The sentence is for a person; these fields are
 * the contract, and they live in one function because `find` reports its own
 * failures and the top-level handler reports the rest.
 */
function failureJson(err) {
  return {
    ok: false,
    error: err.message,
    reason: metrics.escalationOf(err)?.reason ?? null,
    ...(err.staleRef ? { staleRef: true, staleKind: err.staleKind ?? null, staleLabel: err.staleLabel ?? null } : {}),
  };
}

function emit(flags, json, lines) {
  if (flags.json) {
    console.log(JSON.stringify(json, null, 2));
    return;
  }
  const body = typeof lines === 'function' ? lines() : lines;
  if (body != null) console.log(Array.isArray(body) ? body.filter((l) => l != null).join('\n') : body);
}

/**
 * The end-state screen map, re-read rather than recalled, with its hint.
 *
 * Both halves were reported against Phase 11.5 and both were right. The map was
 * rendered from whatever reading the flow already had, which is memory-first —
 * so a trailing map could describe the screen as it was seconds ago, and the
 * remedy in practice was a `ui --refresh` after nearly every call, which is a
 * whole extra turn to save a few hundred milliseconds. Wrong way round.
 *
 * And the hint was only ever printed by the MCP server, so no CLI user could
 * see it and no CLI run could test it.
 */
async function mapText(device, options, identity, { flowOk = true, escalated = false, refresh = true } = {}) {
  try {
    const m = await view.screenMap(device, {
      options,
      refresh,
      identity: refresh ? undefined : (identity?.entry ? identity : undefined),
    });
    return `${m.text}\n${view.hintFor(m, { flowOk, escalated })}`;
  } catch (err) {
    return `(could not read the screen: ${err.message})`;
  }
}

/**
 * Wait for Enter, on a terminal or on a pipe.
 *
 * `readline/promises` looked like the obvious choice and threw "readline was
 * closed" the first time it was asked a question after piped input ran out —
 * which is how a smoke test of `baseline record` would have handed a stack
 * trace to the person recording. Buffered lines are queued, and a closed
 * stream is reported as what it is rather than thrown from inside a library.
 */
async function lineReader() {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY) });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => (waiters.length ? waiters.shift()({ line }) : queue.push(line)));
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()({ closed: true });
  });
  return {
    async enter(prompt) {
      process.stdout.write(prompt);
      const got = queue.length ? { line: queue.shift() } : closed ? { closed: true } : await new Promise((r) => waiters.push(r));
      if (got.closed) {
        throw new Error('stdin closed before the run ended — baseline record needs an interactive terminal');
      }
      process.stdout.write('\n');
      return got.line;
    },
    close: () => rl.close(),
  };
}

/** A step result, the same shape in every command that runs steps. */
const stepLine = (r) => {
  const settle = r.settled ? (r.settled.ok ? ` (settled ${r.settled.waitedMs}ms)` : ' (never settled)') : '';
  const verdict = r.verification && r.verification.verdict !== 'ok' ? ` [${r.verification.verdict}]` : '';
  return `${r.ok ? 'ok  ' : 'FAIL'} [${r.index}] ${r.action}: ${r.ok ? r.detail : r.error}${settle}${verdict}`;
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  const device = flags.device || positional[0];
  const options = {};
  if (flags.fps) options.fps = num(flags.fps);
  if (flags.maxDim) options.maxDim = num(flags.maxDim);
  if (flags.ringSize) options.ringSize = num(flags.ringSize);
  if (flags.engine) options.engine = String(flags.engine);
  // Per-command overrides for the two experiment knobs, so an A/B is an
  // argument rather than a restart. `--sensor=ax-first`, `--planner=apple`.
  if (flags.sensor) options.sensor = String(flags.sensor);
  if (flags.planner) options.planner = String(flags.planner);
  if (flags.supervisor) options.supervisor = String(flags.supervisor);
  // Stated rather than defaulted, which is the same rule the settle budgets
  // follow. The default is sized on a developer's machine; a loaded build farm
  // is a different machine and should say so rather than be guessed at.
  if (flags.readyTimeoutMs) options.readyTimeoutMs = num(flags.readyTimeoutMs);

  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return;

    case '--version':
    case 'version': {
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      console.log(pkg.version);
      return;
    }

    case 'mcp': {
      const { serve } = await import('./mcp.js');
      await serve({ device, options });
      return;
    }

    // Internal: the detached capture process.
    case 'daemon': {
      const resolved = await resolveDevice(device);
      await runDaemon(resolved, options);
      return;
    }

    case 'start': {
      const { device: dev, state, started } = await api.ensureDaemon(device, options);
      const engineModule = await import('./engine.js');
      const best = capabilitiesFor(dev.udid).captureEngines[0];
      const running = engineModule.runningEngine(dev.udid) ?? best;
      console.log(
        `${started ? 'started' : 'already running'} — ${dev.name} (${dev.runtime}) ` +
          `engine=${running} frame #${state.seq} ${state.width}x${state.height}`,
      );
      // Say which engine, and if it is the slow one, say why. A downgrade that
      // prints nothing is how this shipped broken twice. But it is only a
      // downgrade if this platform has something better: the screenshot loop is
      // the whole of Android's capture, not a fallback from anything.
      if (running !== best) {
        const why = api.fallbackReason(dev.udid);
        console.log(
          `WARN engine=${running} — roughly 30x slower per frame than ${best}. ` +
            (why ? `${best} unavailable: ${why}` : 'reason unrecorded; run simframe doctor'),
        );
        if (Boolean(flags.strict) || process.env.SIMFRAME_STRICT === '1') {
          console.error('--strict: refusing to run on a degraded engine');
          process.exitCode = 1;
        }
      }
      return;
    }

    case 'stop': {
      const targets = flags.all
        ? fs.existsSync(store.ROOT)
          ? fs.readdirSync(store.ROOT).filter(store.isUdid)
          : []
        : [(await resolveDevice(device)).udid];
      let stopped = 0;
      let inUse = 0;
      for (const udid of targets) {
        const result = api.stopDaemon(udid, { force: Boolean(flags.force) });
        if (result === 'in-use') inUse++;
        else if (result) stopped++;
      }
      console.log(
        `stopped ${stopped} daemon${stopped === 1 ? '' : 's'}` +
          (inUse ? `; left ${inUse} in use by another client (pass --force to stop anyway)` : ''),
      );
      // Asked to stop one device, refused, and exited 0 — which is a success
      // code for work not done, and a script checking `$?` could not tell the
      // difference. `--all` is informational by nature, so it keeps exiting 0
      // when it skips a device somebody else holds.
      if (!flags.all && inUse && !stopped) process.exitCode = 1;
      return;
    }

    // Rebuild the daemon's HID session, and nothing else.
    //
    // The narrow remedy for the narrow fault. Restarting the daemon also cures
    // a stale session and throws away the frame ring and every warm cache to do
    // it, which is the difference between a fix and a power cycle.
    case 'input': {
      const what = positional[0];
      if (what !== 'reset') throw new Error('usage: simframe input reset [--device <udid>]');
      const dev = await resolveDevice(device);
      const before = await input.sessionHealth(dev.udid);
      const reset = await input.resetSession(dev.udid);
      if (!reset) {
        // Said plainly rather than as a success: there is no daemon holding a
        // session to rebuild, so nothing was wrong and nothing was done.
        console.log(`no simframed session to rebuild for ${dev.name} — the daemon is not running, or this device is not driven by it`);
        process.exitCode = 1;
        return;
      }
      console.log(`rebuilt the HID session for ${dev.name}`
        + (before.stale ? `\n  it was stale: ${before.reason}` : '\n  it did not report stale; rebuilt anyway, as asked'));
      return;
    }

    // The power cycle, when the narrow remedies are spent.
    //
    // Deliberately a command and not a behaviour. The capture loop tries two
    // things — re-resolve the display port, then rebind the device — and then
    // reports `stalled` and stops, because a capture loop that rebooted the
    // device it was watching would be a tool reaching for the mains when a
    // reading looks wrong. Restarting is the operator's call.
    //
    // But it was the operator's call *and* their four commands, remembered from
    // a handoff note: stop the daemon, shut the device down, boot it and wait,
    // start capture, rebuild the HID session. Done by hand three times in one
    // afternoon, in that order, because any other order leaves a daemon holding
    // a dead device. So the tool knows the order now; the decision is still
    // yours.
    case 'revive': {
      const dev = await resolveDevice(device);
      const say = (line) => { if (!flags.json) console.log(line); };
      const steps = [];
      const did = async (what, fn) => {
        try { await fn(); steps.push({ step: what, ok: true }); say(`  ok   ${what}`); } catch (err) {
          steps.push({ step: what, ok: false, error: err.message });
          say(`  ..   ${what} — ${err.message.split('\n')[0]}`);
        }
      };
      say(`reviving ${dev.name}`);
      // Forced: the point of this command is that the device is wedged, so
      // something is certainly still holding it.
      await did('stopped the daemon', async () => { api.stopDaemon(dev.udid, { force: true }); });
      // Through the boundary, which is the whole point of the boundary: the
      // first version of this shelled out to `xcrun` from here and the test
      // that forbids it failed immediately, correctly.
      await did('restarted the device, and waited for the boot to finish',
        () => restartDevice(dev.udid));
      await did('started capture', () => api.ensureDaemon(dev.udid));
      await did('rebuilt the HID session', () => input.resetSession(dev.udid));
      const health = await api.getState(dev.udid).then((s) => s?.state ?? null).catch(() => null);
      const alive = Boolean(health?.hash);
      emit(flags, { ok: alive, device: dev.udid, steps }, alive
        ? `\n${dev.name} is producing frames again`
        : `\n${dev.name} is still not producing frames. This is past what simframe can do —`
          + ' check Simulator.app is not showing an error, and see docs/DEFERRED.md item 95.');
      if (!alive) process.exitCode = 1;
      return;
    }

    case 'status': {
      const udids = device
        ? [(await resolveDevice(device)).udid]
        : fs.existsSync(store.ROOT)
          ? fs.readdirSync(store.ROOT).filter(store.isUdid)
          : [];
      const rows = udids.map((udid) => {
        const { meta, pid, alive, stale } = api.daemonStatus(udid);
        const state = store.readJson(store.paths(udid).state);
        return {
          udid,
          device: meta?.device?.name ?? '?',
          pid,
          running: alive || stale,
          stale,
          seq: state?.seq ?? null,
          ageMs: state ? Date.now() - state.capturedAt : null,
          size: state ? `${state.width}x${state.height}` : null,
          stableForMs: state?.stableForMs ?? null,
        };
      });
      if (flags.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (!rows.length) {
        console.log('no simframe daemons have run yet');
      } else {
        for (const r of rows) {
          console.log(
            `${r.running ? '●' : '○'} ${r.device.padEnd(18)} pid=${r.pid ?? '-'} frame=#${r.seq ?? '-'} age=${r.ageMs ?? '-'}ms ${r.size ?? ''} stable=${r.stableForMs ?? '-'}ms`,
          );
        }
      }
      return;
    }

    case 'frame': {
      const res = await api.getFrame(device, { detail: flags.detail ?? 'normal', options });
      const out = flags.out || path.join(process.cwd(), 'simframe.png');
      fs.writeFileSync(out, res.png);
      emit(
        flags,
        { file: out, width: res.width, height: res.height, ageMs: res.ageMs, seq: res.state.seq, hash: res.state.hash },
        `${out} — ${res.width}x${res.height}, ${res.ageMs}ms old, frame #${res.state.seq}`,
      );
      return;
    }

    case 'mark': {
      const res = await api.getState(device, { options });
      emit(flags, { hash: res.state.hash, seq: res.state.seq }, res.state.hash);
      return;
    }

    case 'state': {
      const res = await api.getState(device, { since: flags.since, options, inputHealth: true });
      if (flags.json) {
        console.log(JSON.stringify({ ...res.state, history: undefined, ageMs: res.ageMs, since: res.since, live: res.live }, null, 2));
      } else {
        const s = res.state;
        const out = [];
        // Any note, not only a failing one: a dead surface reports `ok` with
        // something important to say. See `liveness`.
        if (res.live.note) out.push(`WARNING: ${res.live.note}`);
        // A cause, rather than five silent no-ops. Every tap on a stale
        // session is dispatched successfully and moves nothing.
        if (res.input?.stale) out.push(`input: stale — ${res.input.reason}`);
        if (res.timing?.samples) {
          out.push(
            `timing: this screen usually arrives in ${res.timing.edge_p50}ms (p95 ${res.timing.edge_p95}ms, `
            + `${res.timing.samples} samples); ${res.timing.elapsed_ms}ms since the last change`
            + (res.timing.slower_than_usual ? ` — ${res.timing.note}` : ''),
          );
        }
        out.push(`${res.device.name}  frame #${s.seq}  age ${res.ageMs}ms  ${s.width}x${s.height}`);
        out.push(`hash ${s.hash}  stable ${s.stableForMs}ms`);
        if (res.since?.kind === 'history') {
          out.push(
            res.since.changed
              ? `CHANGED since ${res.since.ageMs}ms ago: ${(res.since.diff * 100).toFixed(1)}% of the screen`
              : `unchanged since ${res.since.ageMs}ms ago`,
            res.since.map,
          );
        } else if (res.since?.kind === 'coarse') {
          out.push(`${res.since.changed ? 'CHANGED' : 'unchanged'} since your baseline (too old for a detailed diff)`);
        } else if (res.since?.kind === 'unmatched') {
          out.push(`baseline ${res.since.requested} is not in the buffered history`);
        } else {
          out.push(
            s.firstFrame
              ? 'first frame of this capture loop — nothing to compare against yet'
              : `change vs the previous frame only: ${(s.diff * 100).toFixed(1)}%`,
          );
          if (!s.firstFrame) out.push(res.map);
        }
        console.log(out.join('\n'));
      }
      return;
    }

    case 'wait': {
      const res = await api.waitFor(device, {
        mode: flags.mode || (flags.change ? 'change' : 'settle'),
        since: flags.since,
        stableMs: num(flags.stableMs, 600),
        timeoutMs: num(flags.timeoutMs, 8000),
        options,
      });
      emit(
        flags,
        {
          satisfied: res.satisfied,
          mode: res.mode,
          waitedMs: res.waitedMs,
          sawChange: res.sawChange,
          changedBeforeWait: Boolean(res.changedBeforeWait),
          noVisibleChange: Boolean(res.noVisibleChange),
          stalled: Boolean(res.stalled),
          hash: res.state?.hash,
          seq: res.state?.seq,
        },
        () => {
          if (res.satisfied) {
            return `${res.mode === 'change' ? 'changed' : 'settled'} after ${res.waitedMs}ms — frame #${res.state.seq}` +
              (res.changedBeforeWait ? ' (change had already happened before the call)' : '');
          }
          if (res.noVisibleChange) {
            return `no visible change after ${res.waitedMs}ms — screen stable, nothing moved (the action may have had no visible effect)`;
          }
          if (res.stalled) return `capture stalled after ${res.waitedMs}ms — ${res.live.note}`;
          return `timed out after ${res.waitedMs}ms — no ${res.mode === 'change' ? 'change' : 'settle'}` +
            (res.sawChange ? '' : '; if the change happened before this call, pass `--since` from `simframe mark`');
        },
      );
      process.exitCode = res.satisfied ? 0 : 1;
      return;
    }

    case 'strip': {
      const res = await api.getStrip(device, {
        count: num(flags.count, 5),
        spanMs: flags.spanMs ? num(flags.spanMs) : undefined,
        options,
      });
      const out = flags.out || path.join(process.cwd(), 'simframe-strip.png');
      fs.writeFileSync(out, res.png);
      emit(
        flags,
        { file: out, frames: res.frames.length, spanMs: res.spanMs, width: res.width, height: res.height },
        `${out} — ${res.frames.length} frames over ${res.spanMs}ms (${res.width}x${res.height})`,
      );
      return;
    }

    case 'recall': {
      if (flags.ago != null) {
        const res = await api.getFrameAt(device, { msAgo: num(flags.ago), options });
        const out = flags.out || path.join(process.cwd(), 'simframe-recall.png');
        fs.writeFileSync(out, res.png);
        emit(
          flags,
          { file: out, seq: res.seq, actualMsAgo: res.actualMsAgo, requestedMsAgo: res.requestedMsAgo, oldestMsAgo: res.oldestMsAgo },
          `${out} — frame #${res.seq} from ${Math.round(res.actualMsAgo)}ms ago ` +
            `(memory reaches back ${Math.round(res.oldestMsAgo / 1000)}s)`,
        );
        return;
      }
      const res = await api.getTimeline(device, { spanMs: num(flags.spanMs, 60_000), options });
      if (flags.json) {
        console.log(JSON.stringify({ ...res, state: undefined }, null, 2));
        return;
      }
      console.log(
        `${res.device.name} — remembering ${Math.round(res.coveredMs / 1000)}s, ${res.buffered} frames buffered`,
      );
      if (!res.events.length) {
        console.log(`nothing changed; still for ${Math.round(res.idleForMs / 1000)}s`);
      } else {
        for (const e of res.events) {
          console.log(
            `  ${(e.startedMsAgo / 1000).toFixed(1)}s ago  ${e.level === 'major' ? 'screen changed' : 'small change '}  ` +
              `${(e.magnitude * 100).toFixed(0)}%  over ${(e.durationMs / 1000).toFixed(1)}s`,
          );
        }
        console.log(`still for ${(res.idleForMs / 1000).toFixed(1)}s`);
      }
      return;
    }

    case 'ui': {
      // The compact map, not a raw tree dump: region, a ref number, type, tap
      // point, label. And no idb gate — OCR reads most screens on its own, and
      // refusing to describe a screen because idb is missing was the surest way
      // to make the fallback look broken.
      const m = await view.screenMap(device, {
        options,
        filter: flags.filter,
        interactive: Boolean(flags.interactive),
        all: Boolean(flags.all),
        refresh: Boolean(flags.refresh),
      });
      m.text = `${m.text}\n${view.hintFor(m)}`;
      emit(
        flags,
        {
          device: m.device.name,
          screen: { hash: m.identity.hash, name: m.name, exits: m.exits, keyboard: m.identity.keyboard },
          sources: m.identity.entry?.sources ?? [],
          // Which layer is missing and why. A map built from one perception
          // layer looks exactly like a map built from two until this says so.
          degraded: m.identity.entry?.degraded ?? [],
          points: m.screen,
          elements: m.rows,
          truncated: m.truncated,
        },
        m.text,
      );
      return;
    }

    case 'tap': {
      const label = positional[0];
      if (!label) throw new Error('usage: simframe tap <label>');
      const res = await actions.runScript(flags.device, {
        steps: [flags.index != null ? { tap: label, index: num(flags.index) } : { tap: label }],
        options,
      });
      const step = res.results[0];
      if (!step.ok) {
        if (flags.json) {
          console.log(JSON.stringify({ ok: false, error: step.error }, null, 2));
          process.exitCode = 1;
          return;
        }
        throw new Error(step.error);
      }
      emit(
        flags,
        { ok: true, ...step },
        `${step.detail}${step.settled?.ok ? `, settled in ${step.settled.waitedMs}ms` : ''}`,
      );
      return;
    }

    case 'do': {
      const file = positional[0];
      if (!file) throw new Error('usage: simframe do <script.json>');
      const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
      const res = await actions.runScript(flags.device, {
        steps,
        autoSettle: flags.autoSettle !== 'false',
        stableMs: num(flags.stableMs, 500),
        timeoutMs: num(flags.timeoutMs, 8000),
        continueOnError: Boolean(flags.continueOnError),
        supervise: flags.supervise ? String(flags.supervise) : undefined,
        options,
      });
      const saved = flags.save
        ? navigate.saveFlow(res.device.udid, String(flags.save), res, { force: Boolean(flags.force) })
        : null;
      // `--map=false` arrives as the string "false"; `--no-map` as true.
      const wantMap = !flags.json && flags.noMap !== true && String(flags.map ?? 'true') !== 'false';
      // Every local ruling, so a wrong one is correctable rather than
      // mysterious — and the model's stated reason is shown as its claim.
      for (const s_ of res.supervisions ?? []) {
        console.log(`supervisor at step ${s_.index}: ${s_.decision} — ${s_.outcome}`
          + (s_.reason ? ` (it said: "${s_.reason}")` : ''));
      }
      const escalated = (res.results ?? []).some((r) => metrics.ESCALATING_VERDICTS.has(r.verification?.verdict));
      const map = wantMap
        ? await mapText(flags.device, options, res.endScreen, { flowOk: res.ok, escalated })
        : null;
      emit(
        flags,
        {
          ok: res.ok,
          ranSteps: res.ranSteps,
          totalSteps: res.totalSteps,
          totalMs: res.totalMs,
          results: res.results,
          saved,
        },
        [
          ...res.results.map(stepLine),
          `${res.ok ? 'flow completed' : 'FLOW FAILED'} — ${res.ranSteps}/${res.totalSteps} steps in ${res.totalMs}ms`,
          saved && (saved.ok ? `saved flow "${saved.name}" — ${saved.steps} steps` : `not saved: ${saved.reason}`),
          map && `\n${map}`,
        ],
      );
      process.exitCode = res.ok ? 0 : 1;
      return;
    }

    case 'goto': {
      const target = positional.join(' ').trim();
      if (!target) throw new Error('usage: simframe goto "<screen>"');
      const res = await navigate.goto(flags.device, target, {
        stableMs: num(flags.stableMs, 500),
        timeoutMs: num(flags.timeoutMs, 8000),
        options,
      });
      const refusal = {
        'unknown-screen': () => [
          `no screen matching "${target}". known screens:`,
          ...(res.known ?? []).map((k) => `  ${k.name}  (${k.hash}, ${k.edges} edges)`),
        ],
        ambiguous: () => [
          `"${target}" matches more than one screen:`,
          ...(res.candidates ?? []).map((c) => `  ${c.name}  (${c.hash.slice(0, 8)})`),
        ],
        // Both of these walked, so the steps they took are the useful part and
        // are printed exactly as a flow prints them.
        'route-halted': () => [
          ...(res.results ?? []).map(stepLine),
          `stopped after ${res.ranSteps} of ${res.steps?.length} step(s) on the way to ${res.screen}`,
        ],
        'arrived-elsewhere': () => [
          ...(res.results ?? []).map(stepLine),
          `ended at ${res.arrived}, wanted ${res.screen} — every step ran, so an edge the graph`
            + ' remembers no longer leads where it says. Re-walk it and the graph will relearn.',
        ],
      };
      if (!res.ok && res.reason) {
        emit(flags, res, refusal[res.reason] ?? `${res.reason}: cannot reach "${res.to ?? target}" from here`);
        process.exitCode = 1;
        return;
      }
      // Everything that is not ok now carries a reason and was handled above,
      // so this is the arrival path only.
      emit(
        flags,
        res,
        res.already
          ? `already on ${res.screen}`
          : [
              ...(res.results ?? []).map(stepLine),
              `arrived at ${res.screen} in ${res.ranSteps} step(s)`,
            ],
      );
      process.exitCode = res.ok ? 0 : 1;
      return;
    }

    case 'screens': {
      // Reading what this device has learned is a file read. It used to go
      // through ensureDaemon, so a device whose capture had stopped could not
      // even list the screens already on disk — the tool went blind about
      // things it already knew.
      const device = await resolveDevice(flags.device);
      const known = navigate.knownScreens(device.udid);
      emit(
        flags,
        known,
        known.length
          ? known.map((k) => `${k.hash}  ${k.edges} edges  ${k.name}`)
          : 'no screens known yet — run a flow first',
      );
      return;
    }

    case 'flow': {
      const [sub, name] = positional;
      // `list` is a directory read; `save` and `run` genuinely need the device
      // awake, and each starts the daemon on its own path.
      const device = await resolveDevice(flags.device);
      if (sub === 'list') {
        const flows = navigate.listFlows(device.udid);
        emit(flags, flows, flows.length ? flows.map((f) => `${f.name}  ${f.steps} steps`) : 'no saved flows');
        return;
      }
      if (sub === 'save') {
        const file = positional[2];
        if (!name || !file) throw new Error('usage: simframe flow save <name> <script.json>');
        const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
        const res = await actions.runScript(flags.device, {
          steps,
          stableMs: num(flags.stableMs, 500),
          timeoutMs: num(flags.timeoutMs, 8000),
          options,
        });
        const saved = navigate.saveFlow(device.udid, name, res, { force: Boolean(flags.force) });
        if (!saved.ok) {
          emit(flags, saved, `not saved: ${saved.reason} (${(saved.verdicts ?? []).join(', ')}) — re-run, or pass --force`);
          process.exitCode = 1;
          return;
        }
        emit(flags, saved, `saved ${saved.name} — ${saved.steps} steps`);
        return;
      }
      if (sub === 'run') {
        if (!name) throw new Error('usage: simframe flow run <name>');
        const res = await navigate.runFlow(flags.device, name, {
          stableMs: num(flags.stableMs, 500),
          timeoutMs: num(flags.timeoutMs, 8000),
          options,
        });
        if (res.reason === 'unknown-flow') {
          emit(flags, res, `no flow "${name}". known: ${res.known.join(', ') || '(none)'}`);
          process.exitCode = 1;
          return;
        }
        emit(flags, res, [
          ...(res.results ?? []).map(stepLine),
          `${res.ok ? 'flow completed' : 'FLOW FAILED'} — ${res.ranSteps}/${res.totalSteps} steps`,
        ]);
        process.exitCode = res.ok ? 0 : 1;
        return;
      }
      throw new Error('usage: simframe flow <list|save|run>');
    }

    case 'tapAt':
    case 'swipe':
    case 'type':
    case 'keys':
    case 'press': {
      const input = await import('./input.js');
      const dev = await resolveDevice(flags.device);
      const nums = positional.map(Number);
      // Only meaningful when frames are being captured; without them there is
      // nothing to compare against and the command says only what it sent.
      let before = null;
      try {
        before = (await api.getState(flags.device, { options })).state.hash;
      } catch {
        /* capture not running: fall through and report the send alone */
      }
      const t0 = Date.now();
      // Item 120, the single-shot half: a coordinate that changed nothing owes
      // an answer about what it landed on.
      let aim = null;
      switch (command) {
        case 'tapAt': {
          if (positional.length < 2 || nums.slice(0, 2).some(Number.isNaN)) {
            throw new Error('usage: simframe tapAt <x> <y>');
          }
          aim = { point: { x: nums[0], y: nums[1] }, what: 'the tap point' };
          await input.tapPoint(dev.udid, nums[0], nums[1], flags.durationMs ? { durationMs: num(flags.durationMs) } : {});
          break;
        }
        case 'swipe': {
          if (positional.length < 4 || nums.slice(0, 4).some(Number.isNaN)) {
            throw new Error('usage: simframe swipe <x1> <y1> <x2> <y2>');
          }
          aim = { point: { x: nums[0], y: nums[1] }, what: 'the swipe start point' };
          await input.swipe(dev.udid, { x: nums[0], y: nums[1] }, { x: nums[2], y: nums[3] }, { durationMs: num(flags.durationMs, 300) });
          break;
        }
        case 'type':
          if (!positional.length) throw new Error('usage: simframe type <text>');
          await input.typeText(dev.udid, positional.join(' '));
          break;
        case 'keys':
          if (!positional.length) throw new Error('usage: simframe keys <text>');
          await input.typeKeys(dev.udid, positional.join(' '));
          break;
        default:
          if (!positional.length) throw new Error('usage: simframe press <button>');
          await input.pressButton(dev.udid, positional[0]);
      }
      const driver = await input.driverFor(dev.udid);
      const ms = Date.now() - t0;
      // Did the device act on it? Input has no feedback channel — a dispatched
      // Indigo message reports success whether or not the device did anything,
      // and this command once reported `press in 66ms` while the screen sat
      // frozen. The frames are the only witness there is, so ask them.
      let changed = null;
      if (before) {
        try {
          await new Promise((r) => setTimeout(r, 400));
          changed = (await api.getState(flags.device, { options })).state.hash !== before;
        } catch {
          /* no daemon, or capture is down: report the send and say nothing more */
        }
      }
      // Deliberately not an accusation. Pressing home while already on the
      // springboard legitimately changes nothing, and a warning that cries wolf
      // is how a real one gets ignored.
      // The map for the screen as it was before the send. Free when the screen
      // has been perceived once — and silent when it has not, because "we did
      // not look" must not be printed as "there is nothing there".
      const hit = changed === false && aim
        ? api.screenmap.describePoint(api.screenmap.recall(dev.udid, before), aim.point, { what: aim.what })
        : null;
      const note = changed === false
        ? ' — the screen did not change'
          + (hit ? `, and ${hit}` : '')
          + '. That is expected if the press had nothing to do here;'
          + ' if you expected a change, input may not be reaching the device —'
          + ' `simframe stop --force && simframe start` rebuilds the session.'
        : '';
      emit(
        flags,
        { ok: true, command, ms, driver: driver.name, screenChanged: changed, hit: hit ?? undefined },
        `${command} in ${ms}ms via ${driver.name}${changed === true ? ' — screen changed' : ''}${note}`,
      );
      return;
    }

    case 'find': {
      const intent = positional.join(' ');
      if (!intent) throw new Error('usage: simframe find "<intent>"');
      try {
        const r = await api.locate(flags.device, intent, { options });
        emit(
          flags,
          { ok: true, target: r.target, score: r.score, from: r.from, reasons: r.reasons, alternatives: r.alternatives },
          [
            `${r.target.label ?? '(icon-only)'}  @(${r.target.x},${r.target.y})  ` +
              `${r.target.region ?? 'content'}  ${r.target.type ?? '?'}/${r.target.source}  score ${r.score ?? '-'}`,
            r.reasons?.length ? `  because: ${r.reasons.join(', ')}` : null,
            ...(r.alternatives ?? []).map((a) => `  also considered: "${a.label}" ${a.score}`),
          ],
        );
      } catch (err) {
        emit(flags, failureJson(err), err.message);
        process.exitCode = 1;
      }
      return;
    }

    case 'baseline': {
      const [sub, name] = positional;
      const suite = baseline.loadSuite(flags.suite ?? baseline.SUITE_FILE);

      if (sub === 'list' || sub == null) {
        const dev = await resolveDevice(flags.device);
        const committed = baseline.readBaselines();
        const rows = suite.map((f) => {
          const runs = baseline.readRuns(dev.udid, f.name);
          return {
            flow: f.name,
            recorded_runs: runs.length,
            committed: Boolean(committed[f.name]),
            human_median_ms: committed[f.name]?.wall_time_ms?.p50 ?? null,
            min_steps: f.minSteps ?? null,
          };
        });
        emit(flags, rows, rows.map((r) =>
          `${r.flow.padEnd(24)} ${String(r.recorded_runs).padStart(2)} run${r.recorded_runs === 1 ? ' ' : 's'}` +
          `  ${r.committed ? `committed, human p50 ${r.human_median_ms}ms` : 'not committed'}`));
        return;
      }

      if (sub === 'exclude') {
        if (!name) throw new Error('usage: simframe baseline exclude <flow> --keep-last=<n> [--reason="..."]');
        const dev = await resolveDevice(flags.device);
        baseline.flowFrom(suite, name);
        const keepLast = num(flags.keepLast, NaN);
        if (!Number.isFinite(keepLast)) throw new Error('pass --keep-last=<n>: how many of the most recent runs to keep');
        const res = baseline.excludeRuns(dev.udid, name, { keepLast, reason: flags.reason ? String(flags.reason) : undefined });
        emit(flags, res, `${name}: ${res.excluded} of ${res.total} run(s) marked excluded — the runs stay in the log, carrying why`);
        return;
      }

      if (sub === 'summarize') {
        if (!name) throw new Error('usage: simframe baseline summarize <flow>');
        const dev = await resolveDevice(flags.device);
        const flow = baseline.flowFrom(suite, name);
        const runs = baseline.readRuns(dev.udid, name);
        const res = baseline.summarizeRuns(name, runs, { minSteps: flow.minSteps ?? null, device: dev.udid });
        if (!res.ok) {
          emit(flags, res, `${runs.length} recorded run${runs.length === 1 ? '' : 's'} for "${name}" — ` +
            `${baseline.MIN_RUNS} is the floor and ${baseline.WANT_RUNS} is the recommendation. ` +
            `Record more: simframe baseline record ${name} --device=${dev.udid}`);
          process.exitCode = 1;
          return;
        }
        const file = flags.out ? baseline.writeSummary(res.summary, { dir: path.dirname(flags.out) }) : baseline.writeSummary(res.summary);
        const w = res.summary.wall_time_ms;
        emit(flags, { ...res.summary, file }, [
          `${name}: ${res.summary.runs} runs`,
          `  wall time  p50 ${w.p50}ms   IQR ${w.p25}–${w.p75}ms   range ${w.min}–${w.max}ms`,
          `  steps      p50 ${res.summary.steps_observed.p50} (from screen transitions; min_steps ${res.summary.min_steps ?? '?'} from the flow)`,
          res.summary.runs_with_incomplete_history
            ? `  WARNING ${res.summary.runs_with_incomplete_history} run(s) outran the 90s frame history; their step counts are undercounts`
            : null,
          `  wrote ${file}`,
        ]);
        return;
      }

      if (sub === 'record') {
        if (!name) throw new Error('usage: simframe baseline record <flow>');
        const flow = baseline.flowFrom(suite, name);
        const dev = await resolveDevice(flags.device);
        const wanted = Math.max(1, num(flags.runs, 1));
        const rl = await lineReader();
        const done = [];
        try {
          console.log(`${name} on ${dev.name} (${dev.udid})`);
          console.log(`${flow.note ?? ''}\n`);
          console.log('Do this, at your natural pace:');
          for (const [i, line] of (flow.human ?? []).entries()) console.log(`  ${i + 1}. ${line}`);
          console.log(`\nThe shortest route is ${flow.minSteps} steps. Practise once or twice first —`);
          console.log('a baseline should measure a tester who knows the flow, not one discovering it.\n');
          for (let run = 1; run <= wanted; run += 1) {
            const reset = await baseline.resetFor(dev.udid, flow);
            if (reset.failures.length) console.log(`  (reset: ${reset.failures.join('; ')})`);
            await rl.enter(`run ${run}/${wanted} — device is on the home screen. Press Enter, then do the flow: `);
            const res = await baseline.recordHumanRun(dev.udid, name, {
              suite,
              options,
              waitForStop: () => rl.enter(`  timing... press Enter the moment you are on "${flow.endsOn ?? 'the last screen'}": `),
            });
            done.push(res.run);
            const r = res.run;
            console.log(`  ${r.wall_time_ms}ms, ${r.steps_observed} screen transitions` +
              (r.history_complete === false ? ' — WARNING: longer than the frame history, steps undercounted' : ''));
          }
        } finally {
          rl.close();
        }
        const total = baseline.readRuns(dev.udid, name).length;
        emit(flags, { flow: name, recorded: done, runs_on_file: total }, [
          '',
          `${done.length} run${done.length === 1 ? '' : 's'} recorded — ${total} on file for "${name}"`,
          total < baseline.WANT_RUNS
            ? `${baseline.WANT_RUNS - total} more would meet the recommendation; ${Math.max(0, baseline.MIN_RUNS - total)} more is the floor`
            : `enough to summarize: simframe baseline summarize ${name} --device=${dev.udid}`,
        ]);
        return;
      }

      throw new Error('usage: simframe baseline <record|summarize|list> [flow]');
    }

    case 'hpi': {
      const dev = await resolveDevice(flags.device);
      const suite = baseline.loadSuite(flags.suite ?? baseline.SUITE_FILE);
      const names = new Set(suite.map((f) => f.name));
      const all = metrics.readFlows(dev.udid);
      // Named runs only, and only flows this suite defines. An ad-hoc `sim_do`
      // is timed and logged, but it has no human counterpart and averaging it
      // into a parity index would be inventing a comparison.
      let runs = all.filter((f) => f.flow_name && names.has(f.flow_name) && (!flags.flow || f.flow_name === flags.flow));
      // `--last=n` keeps the n most recent runs of each flow. The log is
      // append-only on purpose — it is the trend — but a local log carries
      // runs from a wedged device and from a bug since fixed, and averaging
      // those into today's number describes neither day. CI computes its
      // number from one process's own runs and never needs this.
      if (flags.last) {
        const keep = num(flags.last);
        const perFlow = new Map();
        for (const r of runs) perFlow.set(r.flow_name, [...(perFlow.get(r.flow_name) ?? []), r]);
        runs = [...perFlow.values()].flatMap((rs) => rs.slice(-keep));
      }
      const report = metrics.hpi({ flows: runs, baselines: baseline.readBaselines() });
      if (flags.out) store.writeAtomic(String(flags.out), `${JSON.stringify(report, null, 2)}\n`);
      if (!runs.length) {
        emit(flags, report, [
          `no runs of any suite flow on this device yet (${all.length} unnamed run${all.length === 1 ? '' : 's'} in the log)`,
          'run the agent side: node scripts/bench-hpi.mjs --device=' + dev.udid,
        ]);
        return;
      }
      emit(flags, report, [
        flags.last ? `the last ${num(flags.last)} run(s) of each flow, of ${all.filter((f) => f.flow_name).length} named runs in the log` : null,
        'flow                      runs  agent p50   human p50   HPI_time  step_ratio  turns  esc',
        ...report.flows.map((f) =>
          `${f.flow.padEnd(24)} ${String(f.runs).padStart(5)}  ${`${f.agent_ms.p50}ms`.padStart(9)}   ` +
          `${(f.human_median_ms ? `${f.human_median_ms}ms` : '—').padStart(9)}   ` +
          `${(f.hpi_time ?? '—').toString().padStart(8)}  ${(f.step_ratio ?? '—').toString().padStart(10)}  ` +
          `${(f.model_turns ?? '—').toString().padStart(5)}  ${String(f.escalations).padStart(3)}`),
        '',
        `HPI_accuracy ${report.overall.hpi_accuracy} (${report.overall.runs} runs, ` +
          `${report.overall.runs - runs.filter((r) => r.completed && !r.wrong_action_taken).length} not clean)`,
        report.overall.hpi_time == null
          ? `HPI_time and HPI need a human baseline — none of ${report.overall.flows_measured} measured flow(s) has one yet.`
          : `HPI_time ${report.overall.hpi_time} (harmonic mean over ${report.overall.flows_with_human_baseline} flow(s)), HPI ${report.overall.hpi}`,
        `step_ratio ${report.overall.step_ratio ?? '—'} (target ≤1.5), model turns per flow ${report.overall.model_turns_median ?? '—'}`,
        flags.out ? `wrote ${flags.out}` : null,
      ]);
      return;
    }

    case 'supervisions': {
      const dev = await resolveDevice(flags.device);
      const records = metrics.readSupervisions(dev.udid, { limit: flags.last ? num(flags.last) : undefined });
      const b = metrics.supervisionBreakdown(records);
      if (flags.out) store.writeAtomic(String(flags.out), `${JSON.stringify({ ...b, records }, null, 2)}\n`);
      emit(flags, { ...b, records: flags.verbose ? records : undefined }, [
        `${b.total} supervisor ruling${b.total === 1 ? '' : 's'} on ${dev.name}`,
        b.total ? '' : 'Nothing has been judged on this device yet. The supervisor is off unless'
          + ' SIMFRAME_SUPERVISOR=apple, and a ruling is only recorded when a step actually fails.',
        ...Object.entries(b.decision_to_outcome)
          .sort((a, c) => c[1] - a[1])
          .map(([k, n]) => `  ${k.padEnd(28)} ${String(n).padStart(4)}`),
        b.total ? '' : null,
        b.total ? `sourced: ${Object.entries(b.by_from).map(([k, n]) => `${k} ${n}`).join(', ')}` : null,
        b.median_latency_ms != null ? `median latency: ${b.median_latency_ms}ms` : null,
        // Said out loud, because the first version of item 101 claimed its
        // measurement ran "on logs we already have" when nothing persisted a
        // ruling at all. This line is what stops that claim being made twice.
        b.total
          ? `edges the graph had timed: ${b.p95_known}/${b.total}`
            + (b.p95_unknown
              ? ` — ${b.p95_unknown} ruling(s) are on edges with no p95, so they cannot take part in 101's comparison`
              : '')
          : null,
        b.sessions.length > 1
          ? `WARNING ${b.sessions.length} sessions are pooled here; two agents on one device write one file`
          : null,
      ].filter((l) => l !== null).join('\n'));
      break;
    }

    case 'escalations': {
      const dev = await resolveDevice(flags.device);
      const records = metrics.readEscalations(dev.udid, { limit: flags.last ? num(flags.last) : undefined });
      const b = metrics.breakdown(records, {
        session: flags.session === true ? metrics.sessionId() : (flags.session ? String(flags.session) : null),
        flow: flags.flow ? String(flags.flow) : null,
      });
      if (flags.out) store.writeAtomic(String(flags.out), `${JSON.stringify(b, null, 2)}\n`);
      emit(flags, b, [
        `${b.total} escalation${b.total === 1 ? '' : 's'} on ${dev.name}`,
        ...metrics.REASONS
          .filter((r) => b.by_reason[r])
          .sort((a, c) => b.by_reason[c] - b.by_reason[a])
          .map((r) => `  ${r.padEnd(20)} ${String(b.by_reason[r]).padStart(4)}   `
            + (metrics.BUILT_FACULTIES.has(metrics.FACULTY[r])
              ? `not removed by: ${metrics.FACULTY[r]} [built]`
              : `would be removed by: ${metrics.FACULTY[r]}`)),
        b.total ? '' : null,
        b.total ? `avoidable ${b.avoidable}/${b.total} (${b.avoidable_escalation_rate})` : null,
        // Said out loud rather than left for someone to discover: the rate is
        // 1.0 while no faculty exists, so the breakdown above is the number
        // that decides the next phase.
        b.total && b.avoidable_escalation_rate === 1
          ? (metrics.REASONS.some((r) => b.by_reason[r] && metrics.BUILT_FACULTIES.has(metrics.FACULTY[r]))
            ? '  the rate is 1.0 because nothing resolves locally yet. A reason marked [built] is not a queue waiting on a phase — it is evidence the phase that shipped is not sufficient.'
            : '  every reason maps to a faculty that is not built yet, so this rate is 1.0 by construction. The per-reason counts are the steering wheel.')
          : null,
        b.total ? `model turns spent on escalations: ${b.model_turns_spent}` : null,
        // The log is per-device and shared. Said before the counts are used,
        // not after: two agents on one booted simulator write one interleaved
        // file, and CLAUDE.md makes these counts the thing that picks the next
        // faculty. A pooled breakdown errs toward whichever session made more
        // mistakes, which is a different question.
        b.pooled
          ? 'WARNING these counts may pool more than one agent\'s work: '
            + [
              b.session_count > 1 ? `${b.session_count} sessions` : null,
              b.unattributed ? `${b.unattributed} record(s) written before sessions were logged` : null,
            ].filter(Boolean).join(', ')
            + '. Narrow with --session (this process), --session=<id>, or --flow=<name>.'
          : null,
        b.session_count > 1 ? 'sessions:' : null,
        ...(b.session_count > 1
          ? b.sessions.map((x) => `  ${x.session_id.padEnd(22)} ${String(x.count).padStart(4)}  ${x.client}`)
          : []),
        Object.keys(b.by_flow).length > 1 ? 'flows:' : null,
        ...(Object.keys(b.by_flow).length > 1
          ? Object.entries(b.by_flow).slice(0, 10).map(([n, c]) => `  ${n.padEnd(28)} ${String(c).padStart(4)}`)
          : []),
        b.top_screens.length ? 'top screens:' : null,
        ...b.top_screens.map((s) => `  ${s.fingerprint.slice(0, 16).padEnd(18)} ${s.count}`),
        metrics.writeError() ? `WARNING a log write failed: ${metrics.writeError()}` : null,
      ]);
      return;
    }

    case 'devices': {
      const all = await listDevices();
      const shown = flags.all ? all : all.filter((d) => d.state === 'Booted');
      if (flags.json) {
        console.log(JSON.stringify(shown, null, 2));
      } else if (!shown.length) {
        console.log('no booted devices (pass --all to list every device)');
      } else {
        for (const d of shown) console.log(`${d.state === 'Booted' ? '●' : '○'} ${d.name}  ${d.runtime}  ${d.udid}`);
      }
      return;
    }

    case 'doctor': {
      await doctor({
        json: Boolean(flags.json),
        strict: Boolean(flags.strict) || process.env.SIMFRAME_STRICT === '1',
        device: flags.device,
        // So `doctor --sensor=ax-first --planner=apple` reports the mode the
        // caller is about to use, not the one the environment happens to hold.
        // Confirming the mode before a run is the whole reason to read this.
        options,
      });
      return;
    }

    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

/**
 * Report every layer, and treat a silent downgrade as a problem.
 *
 * The tool's policy is to degrade rather than fail, which is right — a machine
 * without a Swift toolchain should still capture frames. What was wrong was
 * that degrading looked identical to working: a published package missing one
 * file made every install fall back to the simctl engine, and another shipped
 * OCR disabled. Both passed CI, and nothing printed a word.
 *
 * So a fallback is a `warn`, not an `ok`, and `--strict` (or SIMFRAME_STRICT=1)
 * makes any warn a non-zero exit. CI runs strict; users see the warning.
 *
 * `optional` is a fourth level and a deliberate distinction, not a softer warn.
 * A `warn` means this machine could be doing better and silently is not — the
 * failure this whole mechanism exists to catch. `optional` means a dependency
 * documented as optional is simply not installed, which doctor says plainly
 * with install instructions. idb is the only one: it is optional, it is being
 * removed, and a fresh machine without it has not degraded from anything.
 * Strict fails on warn and fail, never on optional.
 */
/**
 * Is the device's display black, or is it only simframe that cannot read it?
 *
 * Two very different faults with one symptom, and telling them apart by hand
 * took an hour: `simctl io screenshot` on a wedged device wrote a valid PNG
 * whose 3.16 million pixels were all black, in 16.2 s. So the display pipeline
 * had failed and simframe's read was an accurate report of it.
 *
 * Slow on purpose-built-in: this runs once, only when capture has already
 * declared itself stalled, and 16 s of certainty beats an hour of guessing.
 */
async function blackScreenProbe(udid) {
  const file = path.join(os.tmpdir(), `simframe-probe-${Date.now()}.png`);
  const startedAt = Date.now();
  try {
    await screenshot(udid, file);
    const png = decodePng(fs.readFileSync(file));
    let lit = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i] > 12 || png.data[i + 1] > 12 || png.data[i + 2] > 12) lit += 1;
    }
    const ms = Date.now() - startedAt;
    const pixels = png.data.length / 4;
    if (lit === 0) {
      return {
        value: 'black',
        detail: `the device's display is rendering black — every one of ${pixels.toLocaleString()} pixels, `
          + `confirmed through Apple's own screenshot path in ${ms}ms. This is the simulator, not simframe: `
          + 'it often recovers on its own, and restarting the device also cures it. Re-resolving the '
          + 'display port and rebinding the device have both been tried — 223 and 6 times — and neither '
          + 'makes any difference, because there is nothing wrong with the handle.',
      };
    }
    return {
      value: 'readable-by-simctl',
      detail: `simctl can see ${lit.toLocaleString()} lit pixels of ${pixels.toLocaleString()} in ${ms}ms `
        + 'while the daemon cannot read the surface at all. That is a simframe bug, not a wedged simulator — '
        + 'worth reporting with this line.',
    };
  } catch (err) {
    return { value: 'unreadable', detail: `even simctl could not screenshot this device: ${err.message}` };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function doctor({ json = false, strict = false, device, options = {} } = {}) {
  const checks = [];
  // `level` is 'ok' | 'warn' | 'fail'. A warn means it works but not the way it
  // should — the exact state that used to be invisible.
  const add = (name, level, detail, extra = {}) => checks.push({ name, level, detail, ...extra });
  const startedHere = [];

  add('node', 'ok', process.version);
  const { execFileSync } = await import('node:child_process');
  // The active backend names its own prerequisites — doctor renders them and
  // does not know what they are. On iOS that is xcrun; on Android it will be
  // adb, and this line will not change.
  for (const check of toolchainChecks()) add(check.name, check.level, check.detail);
  try {
    execFileSync('sips', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
    add('sips', 'ok', 'available');
  } catch (err) {
    add('sips', 'fail', err.message);
  }

  const engineModule = await import('./engine.js');
  // Build first, then report. doctor compiles the daemon on demand, so
  // reporting the state beforehand printed "present, not yet built" in output
  // that was already false by the time it reached the terminal.
  await engineModule.ensureBuilt().catch(() => {});
  const build = engineModule.status();
  if (!build.haveSource) {
    add('simframed sources', 'fail', 'not present in this install — the daemon cannot be built', {
      key: 'daemon.sources',
    });
  } else {
    add('simframed sources', 'ok', build.haveBinary ? (build.stale ? 'present, binary stale' : 'present, built') : 'present, not yet built', {
      key: 'daemon.sources',
    });
  }

  let ocrAvailable = false;
  try {
    const ocr = await import('./ocr.js');
    const built = await ocr.ensureBinary();
    ocrAvailable = Boolean(built.available);
    add('on-device OCR', ocrAvailable ? 'ok' : 'warn', ocrAvailable ? 'available' : built.reason, {
      key: 'ocr.available',
      value: ocrAvailable,
    });
  } catch (err) {
    add('on-device OCR', 'warn', err.message, { key: 'ocr.available', value: false });
  }

  // Which sensors a read asks for, and what the recognition-level flag can and
  // cannot reach. Stated because `SIMFRAME_OCR` looks like it configures the
  // OCR everyone uses and does not: the daemon reads text in-process off the
  // framebuffer and owns its own recognition level, so the flag only reaches
  // the no-daemon fallback in `native/ocr.swift`.
  try {
    const api = await import('./index.js');
    const ocrMod = await import('./ocr.js');
    const mode = api.sensorMode(options);
    add('sensor mode', 'ok',
      mode === 'ax-first'
        ? 'ax-first — the tree alone (~50ms), paying for OCR only when a resolve fails'
        : 'full — accessibility and OCR fused on every read (~164ms)',
      { key: 'sensor.mode', value: mode });
    add('OCR level', 'ok', `${ocrMod.level()} (fallback helper only; the daemon owns its own)`, {
      key: 'ocr.level',
      value: ocrMod.level(),
    });
  } catch { /* reported by the layers above */ }

  // The local supervisor. Behind the hands and in front of the reasoner, and
  // able to say only wait/retry/stop.
  try {
    const supervisor = await import('./supervisor.js');
    const st = await supervisor.status(options);
    add('local supervisor', 'ok', `${st.supervisor} — ${st.detail}`, {
      key: 'supervisor.backend',
      value: st.supervisor,
    });
    supervisor.close();
  } catch (err) {
    add('local supervisor', 'ok', `none — ${err.message}`, { key: 'supervisor.backend', value: 'none' });
  }

  // The local planner tier. `none` is the normal answer and not a fault: it is
  // off unless SIMFRAME_PLANNER asks for it, and it only ever reorders
  // candidates that exploration was going to try anyway.
  try {
    const planner = await import('./planner.js');
    const st = await planner.status(options);
    add('local planner', 'ok', `${st.planner} — ${st.detail}`, {
      key: 'planner.backend',
      value: st.planner,
    });
    planner.close();
  } catch (err) {
    add('local planner', 'ok', `none — ${err.message}`, { key: 'planner.backend', value: 'none' });
  }

  try {
    let booted = await bootedDevices();
    // Respect --device. Without this, doctor reports on every booted simulator,
    // which on a CI runner meant checking an Apple Vision Pro nobody asked
    // about and failing strict on its layers.
    if (device) {
      const wanted = await resolveDevice(device);
      booted = booted.filter((d) => d.udid === wanted.udid);
    }
    // Which devices get *probed*, as opposed to listed. The probes below start
    // a capture loop and read frames, and doctor used to do that to every
    // booted device on the host. On a shared machine that means starting a
    // daemon on a colleague's simulator and capturing their screen to answer a
    // question about this one. Listing is free and stays; probing is not, so
    // without --device it goes to a device already running its own capture loop
    // (nothing new is started), or to the only booted device, and otherwise to
    // none, with a line saying which flag would pick one.
    let probed = booted;
    if (!device && booted.length > 1) {
      probed = booted.filter((d) => engineModule.runningEngine(d.udid));
      if (probed.length !== 1) {
        probed = [];
        add('device probes', 'warn',
          `${booted.length} devices are booted and none is clearly yours — name one with --device ` +
            'to check its capture, input and accessibility layers',
          { key: 'probes.skipped', value: booted.length });
      }
    }
    // `deviceNoun` earns its place here: one platform's devices are called by
    // its own word, and a mixed set by the neutral one. An emulator reported as
    // a "booted simulator" is the same small lie as an emulator reported as
    // having an idb input driver.
    const nouns = [...new Set(booted.map((d) => capabilitiesFor(d.udid) && PLATFORMS[d.platform].deviceNoun))];
    add(`booted ${nouns.length === 1 ? nouns[0] : 'device'}`, booted.length ? 'ok' : 'warn',
      booted.map((d) => `${d.name} (${d.runtime})`).join(', ') || 'none');
    for (const d of probed) {
      const input = await import('./input.js');
      const control = await import('./control.js');
      // What this device's platform can do at all. Without asking, doctor
      // described an Android emulator in iOS terms — "input driver: idb" about
      // a tool that has never spoken to one.
      const caps = capabilitiesFor(d.udid);
      const bestEngine = caps.captureEngines[0];
      // Start the engine before asking which engine is in use. Reading it first
      // reports `simctl` on any machine where nothing happens to be running
      // yet — a warning about a downgrade that has not occurred, and one that
      // would have made the CI assertion fail for the wrong reason.
      const wasRunning = Boolean(engineModule.runningEngine(d.udid));
      await api.ensureDaemon(d.udid).catch(() => {});
      if (!wasRunning) startedHere.push(d.udid);
      // ensureDaemon waits for a frame; the control socket comes up a moment
      // later. Asking immediately reports `idb` for a device whose own input
      // path is seconds from ready — a race that would read as CI flake.
      for (let i = 0; i < 40 && caps.input.supported && !control.available(d.udid); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const driver = caps.input.supported ? await input.driverFor(d.udid, { refresh: true }) : null;
      // Which engine is actually capturing, from the daemon's own record.
      // `control.available` answers a different question — whether the input
      // socket is up — and using it here reported simctl on a machine that was
      // capturing with simframed perfectly well.
      const captureEngine = engineModule.runningEngine(d.udid) ?? bestEngine;
      const daemon = captureEngine === 'simframed';
      const why = captureEngine === bestEngine ? null : api.fallbackReason(d.udid);
      add(`capture engine (${d.name})`, captureEngine === bestEngine ? 'ok' : 'warn',
        captureEngine === bestEngine
          ? captureEngine
          : `${captureEngine} — roughly 30x slower per frame than ${bestEngine}${why ? `; ${bestEngine} unavailable: ${why}` : '. Run simframe start to see why'}`,
        { key: 'capture.engine', value: captureEngine });
      // A layer this platform does not have yet is `optional`, the level that
      // means "documented as absent" rather than "this machine is degraded".
      if (!caps.input.supported) {
        add(`input driver (${d.name})`, 'optional', caps.input.note, { key: 'input.driver', value: null });
      } else {
        // `warn` means this machine could be doing better and silently is not —
        // which is true of idb on a simulator and false of the platform's own
        // driver. The console is not a downgrade on Android; it is the only
        // input path there is, and grading it a downgrade made `--strict` fail
        // on a device that was working perfectly.
        const best = driver.name === 'simframed' || driver.name === caps.input.via;
        add(`input driver (${d.name})`, driver.available ? (best ? 'ok' : 'warn') : 'warn',
          driver.available ? `${driver.name}: ${driver.version}` : driver.reason,
          { key: 'input.driver', value: driver.available ? driver.name : null });
      }
      // When capture is wedged, say whose fault it is.
      //
      // Established the hard way: on a wedged device, Apple's own
      // `simctl io screenshot` still succeeds — and returns an image with zero
      // non-black pixels, in 16 seconds instead of one. The simulator's
      // display pipeline is rendering black; simframe's IOSurface read is not
      // the thing that broke. Re-resolving the port does not help, and neither
      // does rebinding the device: both were tried, the second six times.
      //
      // That distinction is the whole value of this check. "simframe cannot
      // read the display" invites someone to debug simframe; "the device's
      // display is black and Apple's screenshot agrees" tells them to restart
      // the device. The probe costs one screenshot and only runs when capture
      // has already given up.
      const wedged = store.captureHealth(d.udid)?.stalled;
      if (wedged) {
        const probe = await blackScreenProbe(d.udid);
        add(`display (${d.name})`, 'fail', probe.detail, { key: 'display.probe', value: probe.value });
      }

      // Reported next to the driver it is about. A driver that is present and
      // working is still useless if it holds a session for a device session
      // that no longer exists, and that state was invisible: taps were
      // dispatched successfully and moved nothing, five runs in a row.
      const session = await input.sessionHealth(d.udid);
      if (session.stale) {
        // The remedy used to read "the next action rebuilds it automatically;
        // simframe stop && simframe start does it now", and both halves were
        // wrong. The first was false wherever it mattered, because the rebuild
        // check was gated once per process and the MCP server is one process
        // for a whole session. The second names a command that fails twice:
        // `stop` needs `--device` when two simulators are booted, and then
        // refuses because a client holds the daemon, so the sequence that
        // actually works is `stop --device <udid> --force && start --device
        // <udid>` — a daemon restart, to fix a session, when rebuilding the
        // session is a thing the daemon can already do on request. It just had
        // no way in from outside. It does now.
        add(`input session (${d.name})`, 'warn', `stale — ${session.reason}. The next action rebuilds it; simframe input reset --device ${d.udid} does it now`,
          { key: 'input.session', value: 'stale' });
      } else if (caps.input.supported) {
        add(`input session (${d.name})`, 'ok', session.reason ?? 'current with this device session',
          { key: 'input.session', value: 'current' });
      }
      add(`text recognition (${d.name})`, 'ok',
        daemon ? 'simframed (in-process, off the framebuffer)' : 'sips + helper binary');
      if (!caps.ax.supported) {
        add(`accessibility tree (${d.name})`, 'optional', caps.ax.note, { key: 'ax.driver', value: null });
        continue;
      }
      const ax = await input.axDriverFor(d.udid);
      // idb here is a downgrade unless it was asked for. `warn` means this
      // machine could be doing better and silently is not; a driver someone
      // selected on purpose is neither silent nor a surprise.
      const axState = !ax.available ? 'optional' : ax.name === 'simframed' || ax.chosen ? 'ok' : 'warn';
      add(`accessibility tree (${d.name})`, axState,
        ax.available ? `${ax.name}: ${ax.version}` : `unavailable: ${ax.reason}`,
        { key: 'ax.driver', value: ax.name });
    }
    if (probed.length) {
      const t0 = Date.now();
      const res = await api.getFrame(probed[0].udid);
      // The wedge's whole signature is that everything here reports success.
      // A black frame is 32 integer comparisons on a signature already
      // computed, and it is what separates "captured a frame" from "captured
      // a frame of a display that has stopped rendering".
      const dark = analyze.isBlackFrame(
        (res.state.history ?? []).find((h) => h.seq === res.state.seq)?.sig ?? null,
      );
      add('capture', dark ? 'warn' : 'ok',
        `frame #${res.state.seq} ${res.width}x${res.height} in ${Date.now() - t0}ms (age ${res.ageMs}ms)`
        + (dark
          ? ' — and every pixel of it is black. If the device is not showing a black screen on purpose,'
            + ' this is the display pipeline having stopped rendering; it usually recovers on its own,'
            + ` and ${'xcrun simctl shutdown'} / boot is the cure that always works.`
          : ''),
        { key: 'capture.frames', value: res.state.seq });
      // A wedged device produces the same nothing as a quiet one, so doctor has
      // to ask the capture loop rather than look at the frames. `fail`, not
      // `warn`: nothing here is degraded-but-working, and the cure is a device
      // restart that simframe deliberately does not perform.
      for (const d of probed) {
        const live = api.liveness(d.udid, (await api.getState(d.udid)).state);
        if (live.stalled) add(`capture health (${d.name})`, 'fail', live.note, { key: 'capture.stalled', value: true });
        // A `warn` rather than a `fail`, because a genuinely inert screen is
        // possible and this is a contradiction between two numbers rather than
        // a proven fault. It is still the loudest thing `doctor` can say about
        // the failure that made a tester report a false application state.
        else if (live.suspectSurface) {
          add(`capture surface (${d.name})`, 'warn', live.note, { key: 'capture.suspectSurface', value: true });
        }
      }
    }
  } catch (err) {
    add('capture', 'fail', err.message);
  }

  // doctor is a diagnostic, not a way to start things. If it had to start a
  // daemon to answer "which engine is in use", it stops it again rather than
  // leaving a detached process behind.
  //
  // And it says when it could not. This was `catch { /* best effort */ }`, and
  // best effort silently failed: a stop refused because another client holds
  // the device left a capture loop running on a machine somebody else was
  // using, with doctor reporting a clean bill of health. A diagnostic that
  // leaves something behind has to name it.
  for (const udid of startedHere) {
    try {
      await api.stopDaemon(udid);
    } catch (err) {
      add('cleanup', 'warn',
        `started a capture loop on ${udid} to answer a question and could not stop it again ` +
          `(${err.message}) — stop it with: simframe stop --device=${udid}`,
        { key: 'cleanup.left', value: udid });
    }
  }

  const failed = checks.filter((c) => c.level === 'fail');
  const warned = checks.filter((c) => c.level === 'warn');
  const optional = checks.filter((c) => c.level === 'optional');

  if (json) {
    const flat = {};
    for (const c of checks) if (c.key) flat[c.key] = c.value;
    console.log(JSON.stringify({
      ok: failed.length === 0 && (!strict || warned.length === 0),
      strict,
      failures: failed.length,
      warnings: warned.length,
      optional: optional.length,
      ...flat,
      checks: checks.map(({ name, level, detail }) => ({ name, level, detail })),
    }, null, 2));
  } else {
    const mark = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', optional: '--  ' };
    for (const c of checks) console.log(`${mark[c.level]} ${c.name.padEnd(24)} ${c.detail}`);
    if (warned.length) {
      console.log(`\n${warned.length} layer(s) degraded. simframe still works, but not at full speed or coverage:`);
      for (const c of warned) console.log(`  - ${c.name}: ${c.detail}`);
      if (!strict) console.log('Use --strict to make this an error (CI does).');
    }
    if (optional.length) {
      console.log(`\n${optional.length} optional layer(s) not installed (not a downgrade):`);
      for (const c of optional) console.log(`  - ${c.name}: ${c.detail}`);
    }
  }

  process.exitCode = failed.length || (strict && warned.length) ? 1 : 0;
}

// A long-lived local helper must not decide when the CLI exits. It is closed
// after every command, whether or not one was ever started — `close()` on an
// unopened planner is a no-op, and leaving it open made a finished flow hang.
const closeHelpers = async () => {
  try {
    const planner = await import('./planner.js');
    planner.close();
    const supervisor = await import('./supervisor.js');
    supervisor.close();
  } catch { /* nothing to close */ }
};

main().then(closeHelpers, async (err) => {
  await closeHelpers();
  throw err;
}).catch((err) => {
  // A caller that asked for JSON gets JSON, failures included. Printing prose
  // here handed `JSON.parse` a SyntaxError instead of a reason, so a script
  // could not tell "the daemon lost the display" from "simframe is broken" —
  // which is the whole point of a machine-readable interface.
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(failureJson(err), null, 2)}\n`);
  } else {
    process.stderr.write(`simframe: ${err.message}\n`);
  }
  process.exitCode = 1;
});
