#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runDaemon, DEFAULTS } from './daemon.js';
import { bootedDevices, listDevices, resolveDevice } from './simctl.js';
import * as api from './index.js';
import * as store from './store.js';

const USAGE = `simframe — always-warm iOS Simulator frames

  simframe mcp                       run the MCP server on stdio (for agents)
  simframe start   [device]          start the capture loop in the background
  simframe stop    [device|--all]    stop the capture loop
  simframe status  [device]          show daemon and newest-frame status
  simframe frame   [device]          write the newest frame to a file
  simframe state   [device]          print frame metadata and the change map
  simframe wait    [device]          wait for the screen to settle
  simframe strip   [device]          write a contact sheet of recent frames
  simframe devices                   list simulators
  simframe doctor                    check that this machine can capture

Options
  --device=<udid|name>   simulator to target (default: the booted one)
  --out=<file>           output path for frame/strip
  --detail=low|normal|high|full   or --detail=<max pixels>
  --fps=<n>              capture rate while the screen is moving (default ${DEFAULTS.fps})
  --count=<n>            frames in a strip (default 5)
  --stable-ms=<n>        settle window for wait (default 600)
  --timeout-ms=<n>       give up after this long (default 8000)
  --json                 machine-readable output
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
      console.log(
        `${started ? 'started' : 'already running'} — ${dev.name} (${dev.runtime}) frame #${state.seq} ${state.width}x${state.height}`,
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
      for (const udid of targets) if (api.stopDaemon(udid)) stopped++;
      console.log(`stopped ${stopped} daemon${stopped === 1 ? '' : 's'}`);
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

    case 'state': {
      const res = await api.getState(device, { options });
      if (flags.json) {
        console.log(JSON.stringify({ ...res.state, ageMs: res.ageMs }, null, 2));
      } else {
        const s = res.state;
        console.log(
          `${res.device.name}  frame #${s.seq}  age ${res.ageMs}ms  ${s.width}x${s.height}\n` +
            `hash ${s.hash}  diff ${s.diff}  stable ${s.stableForMs}ms\n${res.map}`,
        );
      }
      return;
    }

    case 'wait': {
      const res = await api.waitFor(device, {
        mode: flags.mode || (flags.change ? 'change' : 'stable'),
        stableMs: num(flags.stableMs, 600),
        timeoutMs: num(flags.timeoutMs, 8000),
        options,
      });
      console.log(
        `${res.satisfied ? 'settled' : 'timed out'} after ${res.waitedMs}ms — frame #${res.state.seq}, stable ${res.state.stableForMs}ms`,
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
      console.log(
        `${out} — ${res.frames.length} frames over ${res.spanMs}ms (${res.width}x${res.height})`,
      );
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
    const booted = await bootedDevices();
    add('booted simulator', booted.length > 0, booted.map((d) => `${d.name} (${d.runtime})`).join(', ') || 'none');
    if (booted.length) {
      const t0 = Date.now();
      const res = await api.getFrame(booted[0].udid);
      add('capture', true, `frame #${res.state.seq} ${res.width}x${res.height} in ${Date.now() - t0}ms (age ${res.ageMs}ms)`);
    }
  } catch (err) {
    add('capture', false, err.message);
  }

  for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(18)} ${c.detail}`);
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`simframe: ${err.message}\n`);
  process.exitCode = 1;
});
