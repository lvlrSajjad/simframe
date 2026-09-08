#!/usr/bin/env node
// Does the memory layer actually work, on a machine that is not the author's?
//
// The integration job asserts capture, input and OCR. It has never touched the
// layer above them — the screen map, element refs, the transition graph,
// verdicts, saved flows, goto — and that is precisely where every expensive bug
// in this project has lived: a state version that had drifted so every command
// respawned the daemon, `tap <label>` crashing on any screen the graph
// recognised, a tap and a type sharing one edge, a halted flow reporting
// success. Every one of those was found by hand or by somebody else running the
// tool. None was found by CI.
//
// Two rules this file follows, both learned from the step next to it in
// ci.yml, which was wrong three times:
//
//   1. Assert simframe's own bookkeeping, not iOS's behaviour. A test that
//      needs Notification Center to open is measuring iOS.
//   2. Prefer actions whose effect is already proven. `openUrl` launches
//      Safari, which every simulator has; `home` from inside an app always
//      leaves it. Those two make a closed loop, so every pass starts from the
//      same screen.
//
// idb is not installed on a hosted runner, so everything here runs OCR-only.
// That is deliberate: a warm flow makes zero accessibility reads (measured in
// docs/BENCHMARKS.md), and this is what holds that claim up.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const device = process.argv.find((a) => a.startsWith('--device='))?.slice('--device='.length);
const FLOW_NAME = 'ci-memory-loop';
/** The graph converges over a few passes as variants are admitted; it is not instant. */
const CONVERGE_PASSES = 3;
/** Breathing room between passes. Each one launches Safari; a simulator asked to
 *  do that as fast as it can is being stress-tested, which is not the subject. */
const BETWEEN_PASSES_MS = 1200;

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * `expectFail` asserts a non-zero exit; `allowFail` tolerates one.
 *
 * The difference matters more than it looks. `simframe do` exits non-zero when
 * a step does not verify, which is correct and is sometimes exactly the outcome
 * under test — so the JSON has to be readable either way, or the test cannot
 * tell "the flow reported a wrong turn" from "the command blew up".
 */
async function cli(args, { expectFail = false, allowFail = false } = {}) {
  const full = device ? [...args, `--device=${device}`] : args;
  try {
    const { stdout } = await run('node', [CLI, ...full], { timeout: 180_000, maxBuffer: 32 << 20 });
    if (expectFail) throw Object.assign(new Error('expected a non-zero exit'), { unexpectedSuccess: true, stdout });
    return stdout;
  } catch (err) {
    if (err.unexpectedSuccess) throw err;
    if (expectFail || allowFail) return `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const why = (err.stdout || err.stderr || err.message || '').trim();
    throw new Error(`simframe ${full.join(' ')} failed: ${why.slice(0, 400)}`);
  }
}

async function json(args, opts) {
  const out = await cli([...args, '--json'], opts);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`simframe ${args.join(' ')} --json did not return JSON: ${out.trim().slice(0, 200)}`);
  }
}

/**
 * The simulator's display can briefly become unreadable — the daemon says so
 * rather than serving a stale frame, which is the right behaviour and a
 * transient condition. Retry those, and only those.
 */
const TRANSIENT = /did not produce a frame|display surface could not be read|no frames buffered/i;

async function jsonRetry(args, opts, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await json(args, opts);
    } catch (err) {
      last = err;
      if (!TRANSIENT.test(err.message)) throw err;
      console.log(`     (capture dropped out; retrying \`${args.join(' ')}\`)`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw last;
}

const markHash = async () => (await jsonRetry(['mark'])).hash;

function writeFlow(name, steps) {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, JSON.stringify(steps));
  return file;
}

// A closed loop: openUrl puts Safari in front, home leaves it. Both ends are
// screens the graph can learn, and every pass starts where the last one ended.
const LOOP = writeFlow('simframe-ci-loop.json', [
  { openUrl: 'https://example.com' },
  { button: 'home' },
]);
// Leaving whatever screen the map was read on.
//
// There is no single action that always does it, and assuming one is how the
// first two versions of this test proved nothing: `home` does not leave the
// home screen, and opening Safari does not leave Safari. Worse, the loop above
// can halt partway on a wrong turn, so where we are standing is not knowable in
// advance. So: try both, and take whichever moves the screen.
// Several genuinely different destinations, tried in turn until one of them
// moves the screen.
//
// Two was not enough, and the reason is worth keeping: the second leaver
// navigated to example.com, which is exactly where the first one had already
// left the device on an earlier run. Start a run there with `home` not being
// delivered — the long-running-simulator device state in DEFERRED — and neither
// leaver changes anything, so the stale-ref precondition fails and takes the
// check that depends on it down with it. That is a harness that cannot tell
// "the ref guard is broken" from "the device did not move", which is the one
// distinction this check exists to make.
const LEAVERS = [
  writeFlow('simframe-ci-leave-home.json', [{ button: 'home' }, { settle: true }]),
  writeFlow('simframe-ci-leave-settings.json',
    [{ launch: { value: 'com.apple.Preferences', relaunch: true } }, { settle: true }]),
  writeFlow('simframe-ci-leave-reminders.json',
    [{ launch: { value: 'com.apple.reminders', relaunch: true } }, { settle: true }]),
  writeFlow('simframe-ci-leave-safari.json', [{ openUrl: 'https://example.com' }, { settle: true }]),
];

async function leaveThisScreen() {
  const before = await markHash();
  for (const flow of LEAVERS) {
    await jsonRetry(['do', flow], { allowFail: true });
    const after = await markHash();
    if (after !== before) return { before, after };
  }
  return { before, after: before };
}

// Before anything else: is the device actually alive? A blank or wedged
// simulator produces "the display surface could not be read" on every call, and
// every check below then fails for a reason that has nothing to do with the
// memory layer. Diagnose it once, up front.
console.log('--- the device is alive ---');
const health = await jsonRetry(['state']);
check(/^[0-9a-f]{32}$/.test(health.hash ?? ''), 'capture is producing frames',
  `frame #${health.seq}, ${health.width}x${health.height}`);
if (failures) {
  console.error('\nthe device is not producing frames — nothing below would mean anything.');
  console.error('a wedged or blank simulator needs restarting; `simframe doctor` says which layer is down.');
  process.exit(1);
}

console.log('\n--- the screen map ---');
await jsonRetry(['do', LOOP], { allowFail: true });
const map = await jsonRetry(['ui']);

// Report what actually answered rather than asserting the runner's situation.
// This line used to read "with no accessibility tree available" unconditionally,
// which is true on a hosted runner and a lie on a developer's machine.
const sources = map.sources ?? [];
check(Array.isArray(map.elements) && map.elements.length > 0,
  'the screen map has elements',
  `${map.elements?.length ?? 0} element(s)${sources.length ? ` from ${sources.join('+')}` : ''}`);
check(/^[0-9a-f]{32}$/.test(map.screen?.hash ?? ''),
  'the screen has a structural identity', map.screen?.hash?.slice(0, 12));
check(Number.isFinite(map.points?.width) && Number.isFinite(map.points?.height),
  'the map knows the screen size in points', `${map.points?.width}x${map.points?.height}pt`);

const refs = (map.elements ?? []).map((e) => e.ref);
check(refs.every((r, i) => r === i + 1),
  'refs are numbered 1..n with no gaps', `#1..#${refs.length}`);
check((map.elements ?? []).every((e) =>
  Number.isInteger(e.x) && Number.isInteger(e.y)
  && e.y >= 0 && e.y <= map.points.height && e.x >= 0 && e.x <= map.points.width),
  'every element has a tap point on the screen');
check(!(map.elements ?? []).some((e) => e.region === 'status-bar'),
  'the status bar is not offered as something to tap');

console.log('\n--- element refs ---');
const first = map.elements?.[0];
if (first) {
  // A ref must resolve to exactly the point the map published, or the number in
  // front of a row means nothing.
  const found = await jsonRetry(['find', `#${first.ref}`]);
  check(found.target?.x === first.x && found.target?.y === first.y,
    `#${first.ref} resolves to the point the map gave it`,
    `(${found.target?.x},${found.target?.y}) vs (${first.x},${first.y})`);

  // Now leave that screen WITHOUT re-reading it: `--json` skips the end-state
  // map, so the ref table still describes the screen we have left.
  const { before, after } = await leaveThisScreen();
  const moved = before !== after;
  check(moved, 'the screen actually changed before testing the stale ref',
    `${before.slice(0, 10)} -> ${after.slice(0, 10)}`);
  // Only assert the guard if the precondition actually held. Running it anyway
  // reports "the stale-ref guard failed" for a device that never left the
  // screen, which is a false accusation against the one layer this file exists
  // to defend — and it is how this check has failed twice.
  if (moved) {
    const stale = await cli(['find', `#${first.ref}`], { expectFail: true });
    check(/different screen|read the screen/i.test(stale),
      'a ref numbered on another screen refuses instead of tapping those coordinates',
      stale.trim().split('\n')[0]?.slice(0, 90));
  }
} else {
  check(false, 'element refs', 'no elements to number');
}

console.log('\n--- the transition graph learns ---');
// What this asserts, and what it deliberately does not.
//
// It asserts that edges get recorded and that predictions start happening: the
// first pass reports `unverified` because nothing has been seen here before,
// and a later one reports `ok` because it has.
//
// It does NOT assert that every pass converges to all-`ok`. The springboard is
// the worst screen on the device to demand that of — it carries a live weather
// widget and a clock, so it has several genuine settled structures and a cap of
// four variants to hold them. Measured here: `home` read [ok, unverified],
// [ok, ok], [ok, unexpected-screen], [ok, unexpected-screen] over four passes.
// That is the known multiple-structures problem in docs/DEFERRED.md, not a
// regression, and a CI check that demanded otherwise would be flaky about
// something simframe does not claim.
//
// What IS worth pinning, and is exact, is that the run's own success flag
// agrees with its verdicts. `ok` used to mean no more than "nothing threw", so
// a flow halted at step 0 by a wrong turn reported "flow completed" with no
// error. That is a silent failure, and it is the one thing here that must never
// come back.
// A run that failed outright has no `results` at all — `--json` reports
// `{ok:false, error}`. Reaching into it crashed the harness with a TypeError
// pointing at this line, which says nothing about what went wrong on the
// device. A check script whose own failure mode is a stack trace is one more
// thing to debug at the moment you can least afford it.
const verdictsOf = (run) =>
  Array.isArray(run?.results)
    ? run.results.map((r) => r.verification?.verdict ?? 'none')
    : [`did not run: ${run?.error ?? 'no results'}`];

const passes = [];
for (let pass = 1; pass <= CONVERGE_PASSES; pass += 1) {
  const run = await jsonRetry(['do', LOOP], { allowFail: true });
  const verdicts = verdictsOf(run);
  passes.push({ run, verdicts });
  console.log(`     pass ${pass}: ${run.ranSteps ?? 0}/${run.totalSteps ?? '?'} steps, verdicts [${verdicts.join(', ')}]`);
  if (pass < CONVERGE_PASSES) await new Promise((r) => setTimeout(r, BETWEEN_PASSES_MS));
}

// An action the graph has never seen must say so. Asserting that from the loop
// above only works on a virgin graph, which a developer's machine is not after
// the first run — so ask with an action that is novel by construction: a URL
// nobody has opened before.
const NOVEL = writeFlow('simframe-ci-novel.json', [
  { openUrl: `https://example.com/?simframe-ci=${Date.now()}` },
]);
const novel = await jsonRetry(['do', NOVEL], { allowFail: true });
const novelVerdicts = Array.isArray(novel?.results)
  ? novel.results.map((r) => r.verification?.verdict ?? (r.ok ? 'none' : `error: ${r.error}`))
  : [`did not run: ${novel?.error ?? 'no results'}`];
check(Array.isArray(novel?.results) && novel.results.some((r) => r.verification?.verdict === 'unverified'),
  'an action never taken here before is reported as unverified, not as verified',
  `[${novelVerdicts.join(', ')}]`);
check(passes.some((p) => p.verdicts.includes('ok')),
  'and once the graph has seen it, the outcome is predicted',
  `pass ${passes.findIndex((p) => p.verdicts.includes('ok')) + 1}`);

// One direction only: a wrong turn must fail the run. The converse does not
// hold — a run can fail for reasons that are not wrong turns, such as a step
// that threw.
const silent = passes.filter((p) => p.verdicts.includes('unexpected-screen') && p.run.ok);
check(silent.length === 0,
  'a run that reported a wrong turn never also reports success',
  passes.map((p) => `${p.run.ok ? 'ok' : 'failed'}:[${p.verdicts.join(',')}]`).join(' '));

const halted = passes.find((p) => !p.run.ok);
if (halted) {
  check(halted.run.ranSteps < halted.run.totalSteps
      || (Array.isArray(halted.run.results) && halted.run.results.some((r) => !r.ok)),
    'and a halted run says which step stopped it',
    `${halted.run.ranSteps}/${halted.run.totalSteps}`);
}

console.log('\n--- screens, and navigating to one ---');
const screens = await jsonRetry(['screens']);
check(Array.isArray(screens) && screens.length >= 2,
  'more than one screen is remembered', `${screens.length ?? 0} known`);

// Worth writing down, because the first version of this check assumed
// otherwise: `screens` lists graph NODES, and a screen becomes a node when
// something is done *from* it. A destination that has only ever been arrived at
// is a hash on an edge, not yet a node — so the screen you are standing on
// after a flow is often not in this list, and that is correct.
const here = await jsonRetry(['ui']);
check(/^[0-9a-f]{32}$/.test(here.screen?.hash ?? ''),
  'the screen we are standing on has an identity', here.screen?.hash?.slice(0, 8));

// The contract under test is refuse-rather-than-guess, and both halves of it
// are exact.
const nonsense = await jsonRetry(['goto', 'no-such-screen-zzz'], { allowFail: true });
check(nonsense.ok === false && nonsense.reason === 'unknown-screen',
  'goto refuses a screen it has never seen', nonsense.reason);
check(Array.isArray(nonsense.known) && nonsense.known.length > 0,
  'and says what it does know instead of guessing', `${nonsense.known?.length} screens offered`);

const target = screens[0];
const walked = await jsonRetry(['goto', target.hash], { allowFail: true });
const outcomes = ['no-route', 'unreplayable-edge', 'ambiguous', 'unknown-screen'];
check(walked.ok === true || outcomes.includes(walked.reason),
  'and asked for a screen it knows, it either walks there or names why it cannot',
  walked.ok ? (walked.already ? 'already there' : `walked ${walked.ranSteps} step(s)`) : walked.reason);

console.log('\n--- what may be saved, and what may not ---');
// A flow with an unverified step in it is a recording of something that may not
// have worked, and replaying it faithfully reproduces the doubt. So the
// contract runs both ways and both directions are checked against whatever the
// run actually produced, rather than assuming it verified.
const attempt = await jsonRetry(['do', LOOP, `--save=${FLOW_NAME}`], { allowFail: true });
const clean = attempt.results.every((r) => !r.verification || r.verification.verdict === 'ok');
if (clean) {
  check(attempt.saved?.ok === true, 'a flow whose every step verified is saved',
    `${attempt.saved?.steps} steps`);
} else {
  check(attempt.saved?.ok === false && attempt.saved?.reason === 'unverified-steps',
    'a flow with an unverified step is refused, not quietly saved',
    `${attempt.saved?.reason} (${(attempt.saved?.verdicts ?? []).join(', ')})`);
}

// --force is the deliberate override, and it is what lets the replay machinery
// be tested without waiting on a screen that may never settle into one shape.
const forced = await jsonRetry(['do', LOOP, `--save=${FLOW_NAME}`, '--force'], { allowFail: true });
if (check(forced.saved?.ok === true, 'and --force saves it anyway', `${forced.saved?.steps} steps`)) {
  const listed = await jsonRetry(['flow', 'list']);
  check(listed.some((f) => f.name === FLOW_NAME), 'the saved flow is listed');
  const replayed = await jsonRetry(['flow', 'run', FLOW_NAME], { allowFail: true });
  check(replayed.ranSteps >= 1 && Array.isArray(replayed.results),
    'and replays from disk with no model in the loop',
    `${replayed.ranSteps}/${replayed.totalSteps} steps`);
  const unknown = await cli(['flow', 'run', 'no-such-flow'], { expectFail: true });
  check(/no flow/i.test(unknown), 'an unknown flow name is refused with what is known');
}

console.log('\n--- every command speaks JSON ---');
// The --json plumbing is per-command and hand-written, so one command quietly
// printing prose is exactly the kind of thing nothing else would catch.
for (const args of [['status'], ['state'], ['mark'], ['ui'], ['screens'], ['devices'], ['doctor'], ['flow', 'list'], ['recall']]) {
  try {
    const parsed = JSON.parse(await cli([...args, '--json']));
    check(parsed !== null && parsed !== undefined, `simframe ${args.join(' ')} --json`);
  } catch (err) {
    check(false, `simframe ${args.join(' ')} --json`, err.message.slice(0, 120));
  }
}

// Leave the device as it was found, minus the flow this test invented.
try {
  const dir = path.join(process.env.SIMFRAME_HOME || path.join(os.homedir(), '.simframe'));
  for (const udid of fs.readdirSync(dir)) {
    const f = path.join(dir, udid, 'flows', `${FLOW_NAME}.json`);
    if (fs.existsSync(f)) fs.rmSync(f);
  }
} catch { /* nothing to clean up */ }

console.log(`\n${failures ? `${failures} check(s) failed` : 'every check passed'}`);
process.exit(failures ? 1 : 0);
