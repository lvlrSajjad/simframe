#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runDaemon, DEFAULTS } from './daemon.js';
import { bootedDevices, listDevices, resolveDevice } from './simctl.js';
import * as actions from './actions.js';
import * as api from './index.js';
import * as input from './input.js';
import * as navigate from './navigate.js';
import * as store from './store.js';

const USAGE = `simframe — always-warm iOS Simulator frames

  simframe mcp                       run the MCP server on stdio (for agents)
  simframe start   [device]          start the capture loop in the background
  simframe stop    [device|--all]    stop the capture loop
  simframe status  [device]          show daemon and newest-frame status
  simframe frame   [device]          write the newest frame to a file
  simframe state   [device]          print frame metadata and the change map
  simframe mark    [device]          print the current frame hash, to use as --since
  simframe wait    [device]          wait for the screen to react (see --mode)
  simframe strip   [device]          write a contact sheet of recent frames
  simframe recall  [device]          what happened in the last minute (--ago=<ms> for a frame)
  simframe tapAt   <x> <y>           tap at a point, in points
  simframe swipe   <x1> <y1> <x2> <y2>   swipe between two points
  simframe type    <text>            enter text (exact; uses the pasteboard)
  simframe keys    <text>            send key events instead (layout-dependent)
  simframe press   <button>          a hardware button, e.g. home
  simframe ui      [device]          read the screen as an accessibility tree
  simframe tap     <label>            tap an element by its accessibility label
  simframe do      <script.json>      run a scripted flow (see below)
  simframe screens [device]          list screens this device has learned
  simframe goto    <screen>          walk to a known screen through known steps
  simframe flow    save <name> <script.json>   run a flow and save it if every step verifies
  simframe flow    run  <name>       replay a saved flow
  simframe flow    list              list saved flows
  simframe devices                   list simulators
  simframe doctor [--json]           check that this machine can capture
                                     (--strict, or SIMFRAME_STRICT=1, makes any
                                      degraded layer a non-zero exit)

Options
  --device=<udid|name>   simulator to target (default: the booted one)
  --out=<file>           output path for frame/strip
  --detail=low|normal|high|full   or --detail=<max pixels>
  --engine=simframed|simctl   capture engine (default simframed)
  --fps=<n>              capture rate while the screen is moving (simctl engine only)
  --count=<n>            frames in a strip (default 5)
  --since=<hash|seq>     compare against this frame (see: simframe mark)
  --mode=settle|change|stable   what wait waits for (default settle)
  --stable-ms=<n>        settle window for wait (default 600)
  --timeout-ms=<n>       give up after this long (default 8000)
  --force                let stop kill a loop another client is using
  --json                 machine-readable output

A script is a JSON array of steps, run in one go with a settle between each:

  [{"tap":"Assets"},{"tap":"Add Asset"},
   {"type":{"into":"Name","text":"Fryer 3"}},
   {"tap":"Save"},{"waitText":"Saved","timeoutMs":5000}]

Input comes from the daemon. idb is needed only for the accessibility tree
(brew tap facebook/fb && brew install idb-companion,
then pipx install fb-idb). Observation works without it.

The reliable pattern around an action is:

  H=$(simframe mark)
  ...tap, launch or navigate...
  simframe wait --since=$H --mode=settle
  simframe state --since=$H
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[camel] = value === undefined ? true : value;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const num = (v, fallback) => (v == null ? fallback : Number(v));

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  const device = flags.device || positional[0];
  const options = {};
  if (flags.fps) options.fps = num(flags.fps);
  if (flags.maxDim) options.maxDim = num(flags.maxDim);
  if (flags.ringSize) options.ringSize = num(flags.ringSize);
  if (flags.engine) options.engine = String(flags.engine);

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
      const running = engineModule.runningEngine(dev.udid) ?? 'simctl';
      console.log(
        `${started ? 'started' : 'already running'} — ${dev.name} (${dev.runtime}) ` +
          `engine=${running} frame #${state.seq} ${state.width}x${state.height}`,
      );
      // Say which engine, and if it is the slow one, say why. A downgrade that
      // prints nothing is how this shipped broken twice.
      if (running !== 'simframed') {
        const why = api.fallbackReason(dev.udid);
        console.log(
          `WARN engine=simctl — roughly 30x slower per frame. ` +
            (why ? `simframed unavailable: ${why}` : 'reason unrecorded; run simframe doctor'),
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
      console.log(`${out} — ${res.width}x${res.height}, ${res.ageMs}ms old, frame #${res.state.seq}`);
      return;
    }

    case 'mark': {
      const res = await api.getState(device, { options });
      console.log(res.state.hash);
      return;
    }

    case 'state': {
      const res = await api.getState(device, { since: flags.since, options });
      if (flags.json) {
        console.log(JSON.stringify({ ...res.state, history: undefined, ageMs: res.ageMs, since: res.since, live: res.live }, null, 2));
      } else {
        const s = res.state;
        const out = [];
        if (!res.live.ok) out.push(`WARNING: ${res.live.note}`);
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
      if (res.satisfied) {
        console.log(
          `${res.mode === 'change' ? 'changed' : 'settled'} after ${res.waitedMs}ms — frame #${res.state.seq}` +
            (res.changedBeforeWait ? ' (change had already happened before the call)' : ''),
        );
      } else if (res.noVisibleChange) {
        console.log(
          `no visible change after ${res.waitedMs}ms — screen stable, nothing moved (the action may have had no visible effect)`,
        );
      } else if (res.stalled) {
        console.log(`capture stalled after ${res.waitedMs}ms — ${res.live.note}`);
      } else {
        console.log(
          `timed out after ${res.waitedMs}ms — no ${res.mode === 'change' ? 'change' : 'settle'}` +
            (res.sawChange ? '' : '; if the change happened before this call, pass `--since` from `simframe mark`'),
        );
      }
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
      console.log(
        `${out} — ${res.frames.length} frames over ${res.spanMs}ms (${res.width}x${res.height})`,
      );
      return;
    }

    case 'recall': {
      if (flags.ago != null) {
        const res = await api.getFrameAt(device, { msAgo: num(flags.ago), options });
        const out = flags.out || path.join(process.cwd(), 'simframe-recall.png');
        fs.writeFileSync(out, res.png);
        console.log(
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
      const { device: dev } = await api.ensureDaemon(device, options);
      const driver = await input.detectDriver();
      if (!driver.available) {
        process.stderr.write(`${driver.reason}\n`);
        process.exitCode = 1;
        return;
      }
      let nodes = await input.describeAll(dev.udid);
      if (flags.filter) {
        const q = String(flags.filter).toLowerCase();
        nodes = nodes.filter((n) => [n.label, n.value, n.identifier].filter(Boolean).join(' ').toLowerCase().includes(q));
      }
      if (flags.json) {
        console.log(JSON.stringify(nodes.map(({ raw, ...n }) => n), null, 2));
        return;
      }
      for (const n of nodes) {
        const c = input.centerOf(n);
        console.log(
          `${(n.type || '?').padEnd(14)} ${String(`${c.x},${c.y}`).padEnd(10)} ` +
            `${[n.label, n.value && `= ${n.value}`, n.identifier && `#${n.identifier}`].filter(Boolean).join(' ') || '(unlabelled)'}`,
        );
      }
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
      if (!step.ok) throw new Error(step.error);
      console.log(`${step.detail}${step.settled?.ok ? `, settled in ${step.settled.waitedMs}ms` : ''}`);
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
        options,
      });
      for (const r of res.results) {
        const settle = r.settled ? (r.settled.ok ? ` (settled ${r.settled.waitedMs}ms)` : ' (never settled)') : '';
        console.log(`${r.ok ? 'ok  ' : 'FAIL'} [${r.index}] ${r.action}: ${r.ok ? r.detail : r.error}${settle}`);
      }
      console.log(`${res.ok ? 'flow completed' : 'FLOW FAILED'} — ${res.ranSteps}/${res.totalSteps} steps in ${res.totalMs}ms`);
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
      if (!res.ok && res.reason === 'unknown-screen') {
        console.log(`no screen matching "${target}". known screens:`);
        for (const s of res.known) console.log(`  ${s.name}  (${s.hash}, ${s.edges} edges)`);
        process.exitCode = 1;
        return;
      }
      if (!res.ok && res.reason === 'ambiguous') {
        console.log(`"${target}" matches more than one screen:`);
        for (const c of res.candidates) console.log(`  ${c.name}  (${c.hash.slice(0, 8)})`);
        process.exitCode = 1;
        return;
      }
      if (!res.ok && res.reason) {
        console.log(`${res.reason}: cannot reach "${res.to ?? target}" from here`);
        process.exitCode = 1;
        return;
      }
      if (res.already) {
        console.log(`already on ${res.screen}`);
        return;
      }
      for (const r of res.results ?? []) {
        console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.action}: ${r.verification?.verdict ?? (r.ok ? r.detail : r.error)}`);
      }
      console.log(res.ok ? `arrived at ${res.screen} in ${res.ranSteps} step(s)` : `ended at ${res.arrived}, wanted ${res.screen}`);
      process.exitCode = res.ok ? 0 : 1;
      return;
    }

    case 'screens': {
      const { device } = await api.ensureDaemon(flags.device, options);
      const known = navigate.knownScreens(device.udid);
      if (!known.length) {
        console.log('no screens known yet — run a flow first');
        return;
      }
      for (const s of known) console.log(`${s.hash}  ${s.edges} edges  ${s.name}`);
      return;
    }

    case 'flow': {
      const [sub, name] = positional;
      const { device } = await api.ensureDaemon(flags.device, options);
      if (sub === 'list') {
        const flows = navigate.listFlows(device.udid);
        if (!flows.length) console.log('no saved flows');
        for (const f of flows) console.log(`${f.name}  ${f.steps} steps`);
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
          console.log(`not saved: ${saved.reason} (${saved.verdicts.join(', ')}) — re-run, or pass --force`);
          process.exitCode = 1;
          return;
        }
        console.log(`saved ${saved.name} — ${saved.steps} steps`);
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
          console.log(`no flow "${name}". known: ${res.known.join(', ') || '(none)'}`);
          process.exitCode = 1;
          return;
        }
        for (const r of res.results ?? []) {
          console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.action}: ${r.verification?.verdict ?? (r.ok ? r.detail : r.error)}`);
        }
        console.log(`${res.ok ? 'flow completed' : 'FLOW FAILED'} — ${res.ranSteps}/${res.totalSteps} steps`);
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
      const t0 = Date.now();
      switch (command) {
        case 'tapAt': {
          if (positional.length < 2 || nums.slice(0, 2).some(Number.isNaN)) {
            throw new Error('usage: simframe tapAt <x> <y>');
          }
          await input.tapPoint(dev.udid, nums[0], nums[1], flags.durationMs ? { durationMs: num(flags.durationMs) } : {});
          break;
        }
        case 'swipe': {
          if (positional.length < 4 || nums.slice(0, 4).some(Number.isNaN)) {
            throw new Error('usage: simframe swipe <x1> <y1> <x2> <y2>');
          }
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
      console.log(`${command} in ${Date.now() - t0}ms via ${driver.name}`);
      return;
    }

    case 'find': {
      const intent = positional.join(' ');
      if (!intent) throw new Error('usage: simframe find "<intent>"');
      try {
        const r = await api.locate(flags.device, intent, { options });
        console.log(
          `${r.target.label ?? '(icon-only)'}  @(${r.target.x},${r.target.y})  ` +
            `${r.target.region ?? 'content'}  ${r.target.type ?? '?'}/${r.target.source}  score ${r.score ?? '-'}`,
        );
        if (r.reasons?.length) console.log(`  because: ${r.reasons.join(', ')}`);
        for (const a of r.alternatives ?? []) console.log(`  also considered: "${a.label}" ${a.score}`);
      } catch (err) {
        console.log(err.message);
        process.exitCode = 1;
      }
      return;
    }

    case 'devices': {
      const all = await listDevices();
      const shown = flags.all ? all : all.filter((d) => d.state === 'Booted');
      if (flags.json) {
        console.log(JSON.stringify(shown, null, 2));
      } else if (!shown.length) {
        console.log('no booted simulators (pass --all to list every device)');
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
async function doctor({ json = false, strict = false, device } = {}) {
  const checks = [];
  // `level` is 'ok' | 'warn' | 'fail'. A warn means it works but not the way it
  // should — the exact state that used to be invisible.
  const add = (name, level, detail, extra = {}) => checks.push({ name, level, detail, ...extra });
  const startedHere = [];

  add('node', 'ok', process.version);
  const { execFileSync } = await import('node:child_process');
  try {
    add('xcrun', 'ok', execFileSync('xcrun', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch (err) {
    add('xcrun', 'fail', err.message);
  }
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

  try {
    let booted = await bootedDevices();
    // Respect --device. Without this, doctor reports on every booted simulator,
    // which on a CI runner meant checking an Apple Vision Pro nobody asked
    // about and failing strict on its layers.
    if (device) {
      const wanted = await resolveDevice(device);
      booted = booted.filter((d) => d.udid === wanted.udid);
    }
    add('booted simulator', booted.length ? 'ok' : 'warn',
      booted.map((d) => `${d.name} (${d.runtime})`).join(', ') || 'none');
    for (const d of booted) {
      const input = await import('./input.js');
      const control = await import('./control.js');
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
      for (let i = 0; i < 40 && !control.available(d.udid); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const driver = await input.driverFor(d.udid, { refresh: true });
      // Which engine is actually capturing, from the daemon's own record.
      // `control.available` answers a different question — whether the input
      // socket is up — and using it here reported simctl on a machine that was
      // capturing with simframed perfectly well.
      const captureEngine = engineModule.runningEngine(d.udid) ?? 'simctl';
      const daemon = captureEngine === 'simframed';
      const why = captureEngine === 'simctl' ? api.fallbackReason(d.udid) : null;
      add(`capture engine (${d.name})`, captureEngine === 'simframed' ? 'ok' : 'warn',
        captureEngine === 'simframed'
          ? 'simframed'
          : `simctl — roughly 30x slower per frame${why ? `; simframed unavailable: ${why}` : '. Run simframe start to see why'}`,
        { key: 'capture.engine', value: captureEngine });
      add(`input driver (${d.name})`, driver.available ? (driver.name === 'simframed' ? 'ok' : 'warn') : 'warn',
        driver.available ? `${driver.name}: ${driver.version}` : driver.reason,
        { key: 'input.driver', value: driver.available ? driver.name : null });
      add(`text recognition (${d.name})`, 'ok',
        daemon ? 'simframed (in-process, off the framebuffer)' : 'sips + helper binary');
      const ax = await input.detectDriver();
      add(`accessibility tree (${d.name})`, ax.available ? 'ok' : 'optional',
        ax.available ? 'idb — the only thing idb is still required for' : `not installed: ${ax.reason}`,
        { key: 'ax.driver', value: ax.available ? 'idb' : null });
    }
    if (booted.length) {
      const t0 = Date.now();
      const res = await api.getFrame(booted[0].udid);
      add('capture', 'ok',
        `frame #${res.state.seq} ${res.width}x${res.height} in ${Date.now() - t0}ms (age ${res.ageMs}ms)`,
        { key: 'capture.frames', value: res.state.seq });
    }
  } catch (err) {
    add('capture', 'fail', err.message);
  }

  // doctor is a diagnostic, not a way to start things. If it had to start a
  // daemon to answer "which engine is in use", it stops it again rather than
  // leaving a detached process behind.
  for (const udid of startedHere) {
    try { await api.stopDaemon(udid); } catch { /* best effort */ }
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

main().catch((err) => {
  process.stderr.write(`simframe: ${err.message}\n`);
  process.exitCode = 1;
});
