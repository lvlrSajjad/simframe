#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runDaemon, DEFAULTS } from './daemon.js';
import { bootedDevices, listDevices, resolveDevice } from './simctl.js';
import * as actions from './actions.js';
import * as api from './index.js';
import * as input from './input.js';
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
  simframe devices                   list simulators
  simframe doctor                    check that this machine can capture

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

Input needs idb (brew tap facebook/fb && brew install idb-companion,
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
      const note = api.engineFallbackReason ? ` (simframed unavailable: ${api.engineFallbackReason})` : '';
      console.log(
        `${started ? 'started' : 'already running'} — ${dev.name} (${dev.runtime}) ` +
          `engine=${running} frame #${state.seq} ${state.width}x${state.height}${note}`,
      );
      return;
    }

    case 'stop': {
      const targets = flags.all
        ? fs.existsSync(store.ROOT)
          ? fs.readdirSync(store.ROOT)
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
          ? fs.readdirSync(store.ROOT)
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
        steps: [{ tap: label, index: flags.index != null ? num(flags.index) : undefined }],
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
      await doctor();
      return;
    }

    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

async function doctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('node', true, process.version);
  try {
    const { execFileSync } = await import('node:child_process');
    add('xcrun', true, execFileSync('xcrun', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch (err) {
    add('xcrun', false, err.message);
  }
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('sips', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
    add('sips', true, 'available');
  } catch (err) {
    add('sips', false, err.message);
  }
  try {
    const ocr = await import('./ocr.js');
    const built = await ocr.ensureBinary();
    add('on-device OCR', built.available, built.available ? 'available' : built.reason);
  } catch (err) {
    add('on-device OCR', false, err.message);
  }
  try {
    const booted = await bootedDevices();
    add('booted simulator', booted.length > 0, booted.map((d) => `${d.name} (${d.runtime})`).join(', ') || 'none');
    if (booted.length) {
      const input = await import('./input.js');
      const control = await import('./control.js');
      for (const d of booted) {
        const driver = await input.driverFor(d.udid);
        const daemon = control.available(d.udid);
        add(`capture engine (${d.name})`, true, daemon ? 'simframed' : 'simctl');
        add(`input driver (${d.name})`, driver.available, driver.available ? `${driver.name}: ${driver.version}` : driver.reason);
        add(
          `text recognition (${d.name})`,
          true,
          daemon ? 'simframed (in-process, off the framebuffer)' : 'sips + helper binary',
        );
        // idb's only remaining job. Say so, so nobody assumes it is load-bearing
        // for capture or input, which it no longer is.
        const ax = await input.detectDriver();
        add(
          `accessibility tree (${d.name})`,
          ax.available,
          ax.available ? 'idb — the only thing idb is still required for' : `unavailable: ${ax.reason}`,
        );
      }
    }
    if (booted.length) {
      const t0 = Date.now();
      const res = await api.getFrame(booted[0].udid);
      add('capture', true, `frame #${res.state.seq} ${res.width}x${res.height} in ${Date.now() - t0}ms (age ${res.ageMs}ms)`);
    }
  } catch (err) {
    add('capture', false, err.message);
  }

  for (const c of checks) {
    const mark = c.ok ? 'ok  ' : c.name.startsWith('input driver') ? 'none' : 'FAIL';
    console.log(`${mark} ${c.name.padEnd(18)} ${c.detail}`);
  }
  // Input is optional: simframe is still useful as a pure observer.
  const required = checks.filter((c) => !c.name.startsWith('input driver'));
  process.exitCode = required.every((c) => c.ok) ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`simframe: ${err.message}\n`);
  process.exitCode = 1;
});
