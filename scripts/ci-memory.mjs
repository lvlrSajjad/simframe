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
/**
 * The device is gone, as distinct from having blinked. See `jsonRetry`, which
 * is the only thing that sets it: a dropped frame is retryable and this file
 * already treats it that way, so calling the first one fatal would fight the
 * retry rather than help it. Exhausted attempts are the difference between a
 * blink and a death.
 */
let deviceDied = null;

/** EX_TEMPFAIL: the device died under the checks, so nothing was tested. */
const DEVICE_DIED_EXIT = 75;

function check(ok, label, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

let skipped = 0;

/**
 * A check whose *setup* did not happen, reported as untested rather than failed.
 *
 * This exists because the harness did to itself what three peer reports spent a
 * day telling us not to do to callers. A `simctl launch` timed out on a loaded
 * runner, `allowFail` swallowed it, and the next check announced `FAIL the
 * screen actually changed before testing the stale ref — 7070f77757 ->
 * 7070f77757`. Every word of that is true and it names the wrong thing: the
 * screen did not change because **the app never launched**, which the run knew
 * and did not say. Two more checks failed downstream of the same cause.
 *
 * A skip does not fail the build, and that is deliberate. A red build caused by
 * somebody else's build farm is the cry-wolf failure this project keeps writing
 * down: it trains everyone to re-run rather than to read. But it is counted and
 * printed, because a run that tested less than it claims must say so.
 */
function skip(label, why) {
  skipped += 1;
  console.log(`skip ${label} — NOT TESTED: ${why}`);
  return false;
}

/** Did a setup flow actually do what it was there for? */
function ran(res) {
  if (!res || res.ok === false) return false;
  return !(res.steps ?? []).some((st) => st.ok === false);
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
    // Noted here, not in `check`: by the time a failure reaches a check its
    // detail has been truncated for legibility, and the first version of this
    // guard looked for "did not produce a frame" in a string that had been cut
    // to "simframe daemon di". The full text only exists at this boundary.
    //
    // And when the payload is a JSON report, say what failed rather than
    // handing back its first hundred characters. A run of this printed
    // `simframe doctor --json failed: {\n "ok": false,\n "strict": true,\n
    // "failu` — the word "failures" cut in half, one character before the only
    // content that mattered. A harness that truncates away the reason is doing
    // to its reader exactly what this repo keeps writing items about.
    throw new Error(`simframe ${full.join(' ')} failed: ${summarise(why)}`);
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
// Capture dropping out, and — since 2026-09-11 — simctl timing out.
//
// The second one is this repo's oldest CI complaint and it was never in this
// pattern, so `jsonRetry` sailed past it: `simctl launch` takes 47-55s per
// attempt on a loaded hosted runner and `simctl openurl` times out internally,
// which means simframe is handed a failure it did not cause and cannot fix.
// Three checks in one run failed downstream of exactly that.
//
// Retried HERE and deliberately not inside simframe, which is the rule DEFERRED
// already wrote down for the bench script: a retried launch is an action that
// fires twice, and the verify barrier exists to stop simframe doing that on its
// own initiative. A test harness re-running its own setup is a different thing
// from a driver silently repeating a user's action.
const TRANSIENT = /did not produce a frame|display surface could not be read|no frames buffered/i;
const SIMCTL_FLAKE = /simctl|Command failed: xcrun|timed out/i;

async function jsonRetry(args, opts, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await json(args, opts);
    } catch (err) {
      last = err;
      const capture = TRANSIENT.test(err.message);
      const simctl = SIMCTL_FLAKE.test(err.message);
      if (!capture && !simctl) throw err;
      console.log(`     (${capture ? 'capture dropped out' : 'simctl did not answer'}; retrying \`${args.join(' ')}\`)`);
      // simctl's own timeouts are tens of seconds, so a 1.5s pause is not a
      // wait, it is a formality. Give the runner room when that is the cause.
      await new Promise((r) => setTimeout(r, simctl ? 5000 : 1500));
    }
  }
  // Out of attempts on a capture error: the device is not blinking, it is gone.
  //
  // Diagnosed and exited here rather than flagged for a later `check` to
  // notice, because most call sites do not wrap this — the throw escapes, the
  // run dies on an unhandled rejection, and the operator gets a stack trace
  // pointing at this file instead of a sentence about their simulator. Which is
  // exactly what the first version of this did.
  if (TRANSIENT.test(last?.message ?? '')) {
    deviceDied = last.message;
    console.error(`\nFAIL the device stopped producing frames, and did not come back after ${attempts} attempts:`);
    console.error(`  ${String(last.message).split('\n')[0]}`);
    console.error('\nEverything after this point would be testing a dead simulator, so the run');
    console.error('stops here. This is not a memory-layer failure — it is the device-state');
    console.error('problem in docs/DEFERRED.md (126). A device restart is the only known cure,');
    console.error('and `simframe revive` is that restart.');
    // Exit 75, not 1, and the distinction is the whole point of this file.
    //
    // "A check about the memory layer failed" and "the simulator died under the
    // checks" are different conditions with different responses, and for two CI
    // rounds they were one exit code — so a caller could only retry everything
    // or retry nothing. 75 is EX_TEMPFAIL, which is exactly what this is: the
    // subject under test was never reached.
    //
    // The caller reviving and running again is not papering over a product bug.
    // The wedge is a documented CoreSimulator condition, `frame --fresh` names
    // it, and `revive` is the cure this project ships for it — CI simply had no
    // way to say "use it".
    process.exit(DEVICE_DIED_EXIT);
  }
  throw last;
}

/** A failed JSON report, reduced to the part that says what went wrong. */
function summarise(why) {
  try {
    const parsed = JSON.parse(why);
    const failures = parsed.failures ?? parsed.failing ?? null;
    if (Array.isArray(failures) && failures.length) {
      return failures
        .map((f) => (typeof f === 'string' ? f : `${f.name ?? f.check ?? '?'}: ${f.detail ?? f.note ?? f.message ?? ''}`.trim()))
        .join('; ')
        .slice(0, 400);
    }
    const bad = (parsed.checks ?? []).filter((c) => c.ok === false);
    if (bad.length) return bad.map((c) => `${c.name}: ${c.detail ?? ''}`.trim()).join('; ').slice(0, 400);
  } catch { /* not JSON, or not a shape we know — fall through to the raw text */ }
  return why.slice(0, 400);
}

const markHash = async () => (await jsonRetry(['mark'])).hash;

function writeFlow(name, steps) {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, JSON.stringify(steps));
  return file;
}

// A closed loop: launching an app puts it in front, home leaves it. Both ends
// are screens the graph can learn, and every pass starts where the last one
// ended.
//
// **It used to be `openUrl https://example.com`, and that was the bug.** Item
// 142 catalogued `simctl openurl` timing out on a loaded runner as a failure
// class, marked it "fixed — vehicle changed", and changed the vehicle in the
// *workflow's* step only. This loop was left on it, and so was the novel action
// below. That is the same class-versus-symptom error the `waitFor`/`assert`
// twin recorded: the fix went where the report pointed instead of everywhere
// the cause reached.
//
// It came back on 2026-09-14: passes 2 and 3 halted at step 0, the graph never
// got the chance to predict, and the failure read as "the outcome is predicted
// — pass 0", which names the graph for something Safari did.
//
// The replacement is the vehicle item 142 measured and proved for exactly this:
// **from inside an app, pressing home always changes the screen.** Settings is
// already installed everywhere this runs, the launch needs no network, and
// neither end depends on a browser cold-starting on a shared machine.
const LOOP = writeFlow('simframe-ci-loop.json', [
  { launch: { value: 'com.apple.Preferences', relaunch: true } },
  { button: 'home' },
]);
// Leaving whatever screen the map was read on.
//
// Four versions of this proved nothing, each for the same reason: the harness
// guessed where the device was standing and guessed wrong.
//
//  1. `home` does not leave the home screen.
//  2. Opening Safari does not leave Safari.
//  3. Adding a Settings leaver does not leave Settings — it walks straight back
//     to the screen the refs were numbered on, and the guard then *correctly*
//     resolves the ref, which reads as the guard being broken.
//  4. Two pixel hashes are not evidence of anything when both are degenerate. A
//     run here went `0000000000 -> 10ffffffff` — black, then uniform — and the
//     precondition "the screen changed" passed on two hashes that cannot tell
//     any screen from any other. This project has learned that lesson twice
//     before, in the fingerprint and in the ref guard itself.
//
// So this no longer guesses. It puts the device on a named screen, reads the
// refs there, then puts it on a different named screen — two different apps, so
// they cannot be the same screen — and the pixel hash is used only as a
// corroborating signal, and only when it is informative.
//
// The pause is not padding. `settle` waits for a change and then for stillness,
// and called before the launch animation has begun it returns at once — so the
// map was read on a screen still arriving, the refs were numbered on that, and
// by the time the very next command ran simframe did not recognise where it
// was. The guard was right; the harness had numbered a ghost.
const AT_HOME_SCREEN = writeFlow('simframe-ci-at-reminders.json',
  [{ launch: { value: 'com.apple.reminders', relaunch: true } }, { pause: 1600 }, { settle: true }]);
const AT_OTHER_SCREEN = writeFlow('simframe-ci-at-contacts.json',
  [{ launch: { value: 'com.apple.MobileAddressBook', relaunch: true } }, { pause: 1600 }, { settle: true }]);

// A hash of one repeated character carries no information: an all-black screen
// and an all-white one are each a perfectly stable nothing, and two of them are
// within any tolerance of each other.
const informativeHash = (h) => typeof h === 'string' && h.length > 1 && !/^(.)\1*$/.test(h);

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
const map = await readableMap();

/**
 * A map that is empty *and* says a sensor failed is a blink, not a result.
 *
 * `jsonRetry` retries a command that throws, and this one did not throw: `ui`
 * returned 200 with zero elements and a degraded note, which is the shape of
 * failure this whole repo keeps writing rules about. The run that made this
 * necessary had the accessibility read time out once, report an empty map, and
 * then resolve a ref correctly sixty seconds later on the same device — so the
 * device was fine and the check had caught one bad read.
 *
 * Deliberately narrow. An empty map with **no** degraded sensor is a real
 * answer — that is a blank screen and the check should fail on it. Only an
 * empty map that admits a layer did not answer is worth asking again, and after
 * three attempts it fails with what the sensor said, which is the diagnosis
 * either way.
 */
async function readableMap(attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    last = await jsonRetry(['ui']);
    if (last.elements?.length || !(last.degraded ?? []).length) return last;
    if (i < attempts - 1) {
      console.log(`     (the map came back empty and a sensor said why — retrying \`ui\`: ${(last.degraded ?? []).join('; ')})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return last;
}

// Report what actually answered rather than asserting the runner's situation.
// This line used to read "with no accessibility tree available" unconditionally,
// which is true on a hosted runner and a lie on a developer's machine.
const sources = map.sources ?? [];
// If this fails, the next question is always "which layer was missing, and
// why" — so answer it here rather than sending someone to the daemon log.
const degraded = map.degraded ?? [];
check(Array.isArray(map.elements) && map.elements.length > 0,
  'the screen map has elements',
  `${map.elements?.length ?? 0} element(s)${sources.length ? ` from ${sources.join('+')}` : ''}`
  + (degraded.length ? ` — degraded: ${degraded.join('; ')}` : ''));
check(/^[0-9a-f]{32}$/.test(map.screen?.hash ?? ''),
  'the screen has a structural identity', map.screen?.hash?.slice(0, 12));
check(Number.isFinite(map.points?.width) && Number.isFinite(map.points?.height),
  'the map knows the screen size in points', `${map.points?.width}x${map.points?.height}pt`);

const refs = (map.elements ?? []).map((e) => e.ref);
// Three checks over a collection, and `every`/`!some` are all true of an empty
// one. On a CI run whose map came back with **0 elements** they printed
// `ok   refs are numbered 1..n with no gaps — #1..#0` and two more like it:
// three lines of reassurance about nothing, directly under the failure that
// said the map was empty.
//
// That is the exact defect three field reports spent a day describing — a
// confident statement that verified nothing — and the harness was doing it to
// itself in the same output. Untested is not passed.
if (!map.elements?.length) {
  for (const label of [
    'refs are numbered 1..n with no gaps',
    'every element has a tap point on the screen',
    'the status bar is not offered as something to tap',
  ]) skip(label, 'the map was empty, so there was nothing to check');
  // And say what the device was showing, because an empty map on a live device
  // is the shape this project has chased under four different symptoms. The
  // liveness note carries the ignored-gesture check; `stableForMs` and the
  // frame age are the two numbers whose disagreement names a dead surface.
  const st = await jsonRetry(['state'], { allowFail: true });
  console.log(`     the device at that moment: frame #${st?.seq ?? '?'}, `
    + `${st?.stableForMs ?? '?'}ms still, ${st?.live?.note ?? 'liveness reported nothing'}`);
} else {
  check(refs.every((r, i) => r === i + 1),
    'refs are numbered 1..n with no gaps', `#1..#${refs.length}`);
  check(map.elements.every((e) =>
    Number.isInteger(e.x) && Number.isInteger(e.y)
    && e.y >= 0 && e.y <= map.points.height && e.x >= 0 && e.x <= map.points.width),
    'every element has a tap point on the screen');
  check(!map.elements.some((e) => e.region === 'status-bar'),
    'the status bar is not offered as something to tap');
}

console.log('\n--- element refs ---');
// Re-read on a screen we chose, rather than on whatever the device happened to
// be showing when this script started. `map` above is still the map of the
// as-found screen, and everything asserted about its shape holds either way.
await jsonRetry(['do', AT_HOME_SCREEN], { allowFail: true });
const refMap = await jsonRetry(['ui']);
const first = refMap.elements?.[0];
if (first) {
  // A ref must resolve to exactly the point the map published, or the number in
  // front of a row means nothing.
  const found = await jsonRetry(['find', `#${first.ref}`]);
  check(found.target?.x === first.x && found.target?.y === first.y,
    `#${first.ref} resolves to the point the map gave it`,
    `(${found.target?.x},${found.target?.y}) vs (${first.x},${first.y})`);

  // Now leave that screen WITHOUT re-reading it: `--json` skips the end-state
  // map, so the ref table still describes the screen we have left.
  const before = await markHash();
  const left = await jsonRetry(['do', AT_OTHER_SCREEN], { allowFail: true });
  const after = await markHash();
  // Two different apps are two different screens by construction. The pixel
  // hashes only have to agree with that, and they only get a say when they are
  // informative enough to have one.
  const moved = !informativeHash(before) || !informativeHash(after) || before !== after;
  const launched = ran(left);
  if (!launched) skip('the screen actually changed before testing the stale ref',
    'the second app never launched, so there was no screen change to test against');
  else check(moved, 'the screen actually changed before testing the stale ref',
    `${before.slice(0, 10)} -> ${after.slice(0, 10)}`
    + (informativeHash(before) && informativeHash(after) ? '' : ' (degenerate hash: not evidence either way)'));
  // Only assert the guard if the precondition actually held. Running it anyway
  // reports "the stale-ref guard failed" for a device that never left the
  // screen, which is a false accusation against the one layer this file exists
  // to defend — and it is how this check has failed twice.
  // A skip has to propagate. The precondition above reported NOT TESTED and this
  // check ran anyway and failed — which is the harness doing to itself, one line
  // later, exactly what `skip` was written to stop it doing. `moved` is true
  // when a hash is too degenerate to have a say, and that is right for "did the
  // screen change" and wrong as a licence to run a check whose setup is known
  // not to have happened.
  if (!launched) {
    skip('a ref numbered on another screen refuses instead of tapping those coordinates',
      'we never reached another screen, so there was nothing to refuse from');
  } else if (moved) {
    // This matched on prose twice and went red twice, both times for a refusal
    // that was correct and better worded than the alternation knew — most
    // recently `"Welcome to Reminders" is not on this screen`, which refuses
    // *and* names what the number stood for. `find --json` now carries the
    // reason as a field, so the check reads the contract instead of the
    // sentence. What is under test is unchanged: the ref must not resolve to
    // the coordinates it was numbered at on the screen we have left.
    // A refusal that cannot be parsed is a failed check, not a dead script:
    // `json` throws on anything non-JSON reaching the stream, and this is the
    // one call site that expects a failure, so it is the one that would take
    // the whole file down with it.
    let stale;
    try {
      stale = await json(['find', `#${first.ref}`], { expectFail: true });
    } catch (err) {
      stale = { ok: null, error: err.message };
    }
    const refused = stale.ok === false
      && (stale.staleRef === true || stale.reason === 'unknown_screen' || stale.reason === 'ambiguous_intent');
    check(refused,
      'a ref numbered on another screen refuses instead of tapping those coordinates',
      `${stale.reason ?? 'no reason'}${stale.staleRef ? ' staleRef' : ''} — ${String(stale.error ?? '').split('\n')[0].slice(0, 70)}`);
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
//
// Two things have to be true for this to mean anything, and getting either
// wrong makes the check lie rather than fail.
//
// The device must not already be on example.com. The URL is novel only in its
// query string, and that page renders identically whatever you put there, so
// from there the verdict is `no-visible-change` — the honest answer to what
// happened, and not the question being asked.
//
// And the positioning must happen in a *separate* run. Folding a launch into
// this flow made the check pass whenever the launch was unverified, whether or
// not the novel action was — a check that passes for the wrong reason is worse
// than one that fails, because nothing ever tells you.
await jsonRetry(['do', AT_HOME_SCREEN], { allowFail: true });
const NOVEL = writeFlow('simframe-ci-novel.json', [
  { openUrl: `https://example.com/?simframe-ci=${Date.now()}` },
]);
const novel = await jsonRetry(['do', NOVEL], { allowFail: true });
const novelSteps = Array.isArray(novel?.results) ? novel.results : [];
const novelVerdicts = novelSteps.length
  ? novelSteps.map((r) => r.verification?.verdict ?? (r.ok ? 'none' : `error: ${r.error}`))
  : [`did not run: ${novel?.error ?? 'no results'}`];
// "Could this be tested" is a different question from "was the claim broken",
// and reporting the first as the second is how this file has spent the day
// accusing the layer underneath it. A device that crashed SpringBoard mid-run
// has not told us anything about the graph.
const novelRan = novelSteps.length > 0 && novelSteps.every((r) => r.ok !== false);
// The comment above states the principle and this line used to contradict it:
// it called `check`, so a `simctl openurl` that timed out on the runner failed
// the build and said "the novel action ran at all" as though the graph were at
// fault. It is a precondition. Untested is not broken.
if (!novelRan) {
  skip('the novel action ran at all', `the action could not be dispatched — [${novelVerdicts.join(', ')}]`);
} else {
  check(true, 'the novel action ran at all', `[${novelVerdicts.join(', ')}]`);
}
// The other half of the precondition, which was written above as a comment and
// then trusted. It is not trustworthy: the positioning run sends the device
// home, and a simulator that has been driven hard stops delivering `home` while
// still reporting success (docs/DEFERRED.md). From a screen the action cannot
// change, `no-visible-change` is the honest verdict and the claim below was
// never asked — so this is a precondition, and saying otherwise is how this
// file has spent the day accusing the graph of something the device did.
const novelMoved = novelRan && !novelVerdicts.every((v) => v === 'no-visible-change');
if (novelRan) {
  check(novelMoved, 'and the device was somewhere the novel action could change',
    novelMoved ? `[${novelVerdicts.join(', ')}]` : 'the screen never moved — the device was already there, or ignored being sent home');
}
if (novelRan && novelMoved) {
  check(novelSteps.some((r) => r.verification?.verdict === 'unverified'),
    'an action never taken here before is reported as unverified, not as verified',
    `[${novelVerdicts.join(', ')}]`);
}
// The same precondition rule as the two above. The graph can only predict an
// outcome it has seen, and it can only have seen one if a pass actually ran —
// so a run in which every pass failed to dispatch says nothing about
// prediction. It failed the build as `pass 0` while the real cause was a
// simctl launch timing out, three checks upstream.
//
// **The rule was right and the test of it was too coarse.** `anyPassRan` asks
// whether *any* pass ran, but prediction can only be observed on a pass AFTER
// the one that taught the edge — so pass 1 running is not enough. On
// 2026-09-14 pass 1 ran, passes 2 and 3 halted at step 0, and this reported
// `pass 0` as though the graph had declined to predict. Nothing had asked it
// to. Same sentence as the novel action three checks above: untested is not
// broken, and the guard has to test the pass the claim actually depends on.
const dispatched = (p) => Array.isArray(p.run?.results) && p.run.results.some((r) => r.ok !== false);
const laterPassRan = passes.slice(1).some(dispatched);
if (!passes.some(dispatched)) {
  skip('and once the graph has seen it, the outcome is predicted',
    'no pass dispatched a step, so the graph was never given anything to learn');
} else if (!laterPassRan) {
  skip('and once the graph has seen it, the outcome is predicted',
    `only the first pass dispatched a step (${passes.slice(1).map((p, i) => `pass ${i + 2}: [${p.verdicts.join(', ')}]`).join('; ')})`
    + ' — prediction is only observable on a pass after the one that taught the edge');
} else {
  check(passes.some((p) => p.verdicts.includes('ok')),
    'and once the graph has seen it, the outcome is predicted',
    `pass ${passes.findIndex((p) => p.verdicts.includes('ok')) + 1}`);
}

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
// `no-identity` is new in 0.7.2 and belongs here: `goto` used to *throw*
// `Cannot read properties of null (reading 'slice')` on a screen whose token set
// was empty, because `hashTokens` returns null for one on purpose. A crash is
// neither walking there nor naming why it cannot, so this check failed with an
// empty detail — the reason was `undefined` — and the check was right to fail.
// Now there is a name for it, and the list has to know the name.
// `route-halted` and `arrived-elsewhere` are new: a walk that ran and did not
// land used to return `{ok: false}` with no reason at all, which failed this
// very check with an empty detail. It was the one outcome here nobody had
// named, and the check found it.
const outcomes = ['no-route', 'unreplayable-edge', 'ambiguous', 'unknown-screen', 'no-identity',
  'route-halted', 'arrived-elsewhere'];
check(walked.ok === true || outcomes.includes(walked.reason),
  'and asked for a screen it knows, it either walks there or names why it cannot',
  walked.ok ? (walked.already ? 'already there' : `walked ${walked.ranSteps} step(s)`) : walked.reason);

console.log('\n--- what may be saved, and what may not ---');
// **A first traversal must be recordable**, which is the opposite of what this
// check used to assert. The old contract refused any flow with a non-`ok`
// verdict — and a first traversal is all-`unverified` by construction, since
// there is no prior observation to compare against. So no flow could ever be
// recorded, replay was unreachable, and the only zero-model-call path in the
// tool was sealed shut behind a gate nobody could pass.
//
// The refusal now needs evidence *against* a step rather than the absence of
// evidence for it. Checked against whatever the run actually produced rather
// than assuming a shape, as before.
const attempt = await jsonRetry(['do', LOOP, `--save=${FLOW_NAME}`], { allowFail: true });
//
// Three outcomes, not two. The missing one is a step that ran and *failed*: a
// failing step stops the batch, so a failure on the last step leaves
// `ranSteps === steps.length` and the run reads as complete. A peer watched
// `FLOW FAILED — 4 ok, 1 failed (of 5)` save itself. This branch is also the
// one that goes stale: yesterday the save contract was replaced, the unit test
// was updated, and this file was left asserting the old rule — so the three
// cases are enumerated here explicitly rather than left as an `else`.
const contradicted = attempt.results.some((r) => /^unexpected/.test(r.verification?.verdict ?? ''));
const anyFailed = attempt.results.some((r) => !r.ok);
const clean = attempt.results.every((r) => !r.verification || r.verification.verdict === 'ok');
if (contradicted) {
  check(attempt.saved?.ok === false && attempt.saved?.reason === 'contradicted-steps',
    'a flow with a contradicted step is refused, not quietly saved',
    `${attempt.saved?.reason} (${(attempt.saved?.verdicts ?? []).join(', ')})`);
} else if (anyFailed) {
  check(attempt.saved?.ok === false && attempt.saved?.reason === 'failed-steps',
    'a flow with a step that ran and failed is refused, not quietly saved',
    `${attempt.saved?.reason} (failed step ${(attempt.saved?.failed ?? []).join(', ')})`);
} else {
  check(attempt.saved?.ok === true, 'a first traversal is recordable',
    `${attempt.saved?.steps} steps`);
  check(attempt.saved?.provisional === !clean,
    clean
      ? 'and a flow whose every step verified is confirmed outright'
      : 'and it is marked provisional, because nothing had been seen before to compare against',
    `provisional=${attempt.saved?.provisional}`);
}

// --force is the deliberate override, and it is what lets the replay machinery
// be tested without waiting on a screen that may never settle into one shape.
const forced = await jsonRetry(['do', LOOP, `--save=${FLOW_NAME}`, '--force'], { allowFail: true });
if (check(forced.saved?.ok === true, 'and --force saves it anyway',
  `${forced.saved?.steps} steps, provisional=${forced.saved?.provisional}`)) {
  const listed = await jsonRetry(['flow', 'list']);
  const before = listed.find((f) => f.name === FLOW_NAME);
  check(Boolean(before), 'the saved flow is listed');
  // Whether there is anything to promote is a fact about *this* save, not the
  // first attempt's. The forced save is another traversal of the same loop,
  // and by then the graph has seen every edge in it: measured on the bench
  // device, the first run saved `provisional=true` and every run after it
  // saved confirmed outright. Both checks below used to assume a provisional
  // flow — so the positive one passed on a flow that had never been
  // provisional, and the negative one failed CI on it — main was red on a
  // precondition the harness never established, while the product did exactly
  // what it should.
  const wasProvisional = before?.provisional === true;
  const replayed = await jsonRetry(['flow', 'run', FLOW_NAME], { allowFail: true });
  // A replay that stopped early says which step stopped it and why. 1dcce18's
  // red run printed `1/2 steps` and nothing else, so the one fact that would
  // say whether the replay itself is broken was never on the page.
  const stoppedAt = (replayed.results ?? []).find((r) => !r.ok);
  check(replayed.ranSteps >= 1 && Array.isArray(replayed.results),
    'and replays from disk with no model in the loop',
    `${replayed.ranSteps}/${replayed.totalSteps} steps`
      + (stoppedAt ? `; stopped at [${stoppedAt.index}] ${stoppedAt.action}: ${String(stoppedAt.detail ?? '').slice(0, 160)}` : ''));
  // The other half of the bootstrap, and the reason "provisional" is not a
  // state nothing ever leaves: a clean replay is the confirmation a first
  // traversal could not give. Only asserted when the replay actually ran to
  // the end — a partial replay promotes nothing, deliberately.
  const after = await jsonRetry(['flow', 'list']);
  const entry = after.find((f) => f.name === FLOW_NAME);
  // Whatever the replay did, it must not lose the flow. Neither branch below
  // could say this: an entry that vanished and an entry without the field both
  // read `undefined`.
  check(Boolean(entry), 'a replay leaves the flow it replayed on disk',
    entry ? '' : 'the entry is gone from the listing');
  if (!wasProvisional) {
    skip(replayed.ok
      ? 'and a clean replay confirms a provisional flow'
      : 'and a replay that failed does NOT confirm the flow it just disproved',
    'the forced save verified every step, so the flow was confirmed before the replay and there was nothing to promote');
  } else if (replayed.ok) {
    check(entry && !entry.provisional,
      'and a clean replay confirms a provisional flow',
      `provisional=${entry ? entry.provisional : 'gone'}`);
  } else {
    // The other direction, and it is the one that was silently wrong: promotion
    // keyed on `ranSteps === steps.length`, which a failure on the *last* step
    // satisfies. Both of a peer's saved flows were marked confirmed by replays
    // that failed. A confirmation that a failing replay can grant is not a
    // confirmation, so the negative case has to be checked too.
    check(entry?.provisional === true,
      'and a replay that failed does NOT confirm the flow it just disproved',
      `ok=${replayed.ok}, provisional=${entry ? entry.provisional : 'gone'}`);
  }
  const unknown = await cli(['flow', 'run', 'no-such-flow'], { expectFail: true });
  check(/no flow/i.test(unknown), 'an unknown flow name is refused with what is known');
}

console.log('\n--- every command speaks JSON ---');
// The --json plumbing is per-command and hand-written, so one command quietly
// printing prose is exactly the kind of thing nothing else would catch.
// Through `jsonRetry` like everything else. This loop used to call `cli`
// directly, and it is the last section of a run that takes minutes — so a
// capture dropout here failed five checks about `--json` plumbing that was
// working perfectly, while every earlier section shrugged the same dropout off.
// The one place that did not retry was the one place most likely to need it.
for (const args of [['status'], ['state'], ['mark'], ['ui'], ['screens'], ['devices'], ['doctor'], ['flow', 'list'], ['recall']]) {
  try {
    const parsed = await jsonRetry([...args]);
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

const summary = [
  failures ? `${failures} check(s) failed` : 'every check passed',
  skipped ? `${skipped} check(s) NOT TESTED — the runner could not set them up` : null,
].filter(Boolean).join('; ');
console.log(`\n${summary}`);
process.exit(failures ? 1 : 0);
