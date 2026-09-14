#!/usr/bin/env node
// Run a CI step, and tell a sick simulator apart from a failing check.
//
//   node scripts/ci-device-guard.mjs <udid> -- <command> [args...]
//
// **Why this exists, with the number that justifies it.** Over the last 25 CI
// runs the `integration` job failed 17 times and passed 5. Eight of the nine
// most recent failures name a device-state condition in their own output —
// `NSPOSIXErrorDomain code=60`, `the display produced no frame in 60s`, `the
// second app never launched` — and one of those runs was a **docs-only commit**
// that changed a single markdown file. Two runs of byte-identical code failed at
// two different steps.
//
// So the job has been answering two questions at once — *does simframe work* and
// *did this hosted simulator survive twenty minutes* — and the second dominates.
// A red build that is usually the device is the cry-wolf failure this repo keeps
// writing items about, and it cost two days of re-reading logs to learn nothing.
//
// This does not paper over failures. It distinguishes them: a named device
// condition gets the cure this project already ships (`simframe revive`) and one
// retry, exactly as DEFERRED 126 says to; anything else fails on the spot,
// untouched. The classification is written to the job summary so the *rate*
// becomes visible instead of arguable.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** Conditions that are the simulator, not the code. Each seen in a real run. */
const DEVICE_STATE = [
  [/NSPOSIXErrorDomain.*code=?\s*60|Operation timed out/i, 'simctl stopped answering (NSPOSIXErrorDomain 60)'],
  [/did not produce a frame|produced no frame in \d+s/i, 'the daemon is up and the display renders nothing'],
  [/Timeout waiting for screen surfaces|display surface is not answering|display surface could not be read/i, 'the display surface is wedged'],
  [/no frames buffered|capture is wedged/i, 'capture stopped'],
  [/the second app never launched|could not be dispatched/i, 'an app would not launch'],
];

const udid = process.argv[2];
const sep = process.argv.indexOf('--');
if (!udid || sep < 0) {
  console.error('usage: ci-device-guard.mjs <udid> -- <command> [args...]');
  process.exit(2);
}
const cmd = process.argv.slice(sep + 1);

function run(argv, { capture = true } = {}) {
  return new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    p.stdout?.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr?.on('data', (d) => { out += d; process.stderr.write(d); });
    p.on('close', (code) => resolve({ code, out }));
  });
}

const summary = (line) => {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { fs.appendFileSync(f, `${line}\n`); } catch { /* summaries are a nicety */ } }
};

const deviceCause = (text) => DEVICE_STATE.find(([re]) => re.test(text))?.[1] ?? null;

const first = await run(cmd);
if (first.code === 0) process.exit(0);

const cause = deviceCause(first.out);
if (!cause) {
  console.error(`\n     (this step failed on its merits, not on the device — not retrying)`);
  summary(`- \`${cmd.join(' ')}\` — **check failed** (exit ${first.code})`);
  process.exit(first.code ?? 1);
}

console.error(`\n     (${cause} — DEFERRED 126. Reviving once and running again.)`);
await run(['node', 'src/cli.js', 'revive', `--device=${udid}`], { capture: false });
const second = await run(cmd);
if (second.code === 0) {
  summary(`- \`${cmd.join(' ')}\` — passed after one revive (${cause})`);
  process.exit(0);
}
// Twice in a row, on a condition we know the cure for. Reported as what it is.
const again = deviceCause(second.out);
summary(`- \`${cmd.join(' ')}\` — **${again ? 'device unavailable' : 'check failed'}** after a revive${again ? ` (${again})` : ''}`);
if (again) console.error(`\nFAIL the simulator is still in a bad state after a revive: ${again}`);
process.exit(second.code ?? 1);
