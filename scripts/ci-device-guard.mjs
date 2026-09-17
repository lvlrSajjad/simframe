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
import { deviceCause } from './device-state.mjs';


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

const first = await run(cmd);
if (first.code === 0) process.exit(0);

const cause = deviceCause(first.out);
if (!cause) {
  console.error(`\n     (this step failed on its merits, not on the device — not retrying)`);
  summary(`- \`${cmd.join(' ')}\` — **check failed** (exit ${first.code})`);
  process.exit(first.code ?? 1);
}

// Diagnose BEFORE reviving, because reviving is what destroys the evidence.
//
// This guard has been recognising wedges from the shape of the failure text
// since 126, and then immediately power-cycling the device — so item 173 has
// accumulated a dozen occurrences and not one observation of what the device
// was doing at the time. `cause` above names a *consequence* ("a launched app
// never came to the front"); this names what the two sensors actually saw, and
// the difference decides between a stale framebuffer, a screen that is not the
// app, and capture being down. Its cost is one read on a path that is already
// failing.
const diagnose = async (when) => {
  const d = await run(['node', 'src/cli.js', 'diagnose', `--device=${udid}`]);
  console.error(`\n     (diagnosis ${when} — for DEFERRED 173)`);
  const verdict = /— (\S+)\n/.exec(d.out)?.[1] ?? 'unreadable';
  summary(`  - diagnosis ${when}: \`${verdict}\``);
  return verdict;
};
const before = await diagnose('before the revive');

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
// Twice is the interesting case: a revive cured it and it came back, or the
// revive did not cure it at all. Those are different faults and the pair of
// diagnoses says which.
const after = await diagnose('after the revive');
if (before !== after) {
  console.error(`\n     (the device changed state across the revive: ${before} -> ${after})`);
  summary(`  - state changed across the revive: \`${before}\` -> \`${after}\``);
}
process.exit(second.code ?? 1);
