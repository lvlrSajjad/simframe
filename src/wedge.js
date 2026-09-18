// What is this device actually doing right now?
//
// `doctor` answers "can this machine capture". This answers a different
// question, and it is the one item 173 has never been able to answer: when a
// device stops presenting the app, *which* of several failures is it?
//
// The reason this exists is that the evidence has been arriving as a
// consequence rather than an observation. `scripts/device-state.mjs` recognises
// a wedge from the shape of a tour's failure text — "two labels, one of them a
// clock, on a still screen" — and names it "a launched app never came to the
// front". That classification is useful for deciding whether to revive, and it
// is not a diagnosis: it cannot tell a dead framebuffer from a device that is
// genuinely showing a lock screen from an app that never fronted. Three
// hypotheses, one symptom, and a regex standing where a measurement should be.
//
// So the facts get gathered at the moment of the wedge instead of inferred
// afterwards, and the classifier over them is a **pure function** with fixtures.
// That part is deliberate: `device-state.mjs` records that "two runtime bugs in
// this project came from logic that was correct and had never executed",
// because the only thing exercising it was a hosted runner at minute fifteen of
// a job. Nothing here needs a device to be tested.
import * as api from './index.js';
import * as frontmost from './frontmost.js';
import * as input from './input.js';
import { launchApp, restartDevice } from './platform/index.js';

/**
 * How little agreement between the sensors counts as "these are different
 * screens".
 *
 * **Measured, and the first version of this constant was justified with the
 * wrong number.** It cited CLAUDE.md's "the tree and OCR agree on 0.33–0.47",
 * which is a figure about *structural tokens* — a different quantity from the
 * element-level fusion counted here. Printing a healthy band of 0.33–0.47 next
 * to a live reading of 0.846 is how that got noticed.
 *
 * Sampled on `326464A4` (iPhone 17 Pro, iOS 26.5) across five real screens —
 * Settings root, General, About, springboard, Reminders:
 *
 *   0.857  0.833  0.929  0.846  0.667      median 0.846
 *
 * So healthy element fusion is **0.67-0.93** (stated as 0.66 so a reading at the floor does not print as below it), and the floor belongs to the
 * sparsest screen, which is also the case `ENOUGH_TO_COMPARE` withholds
 * judgement on. A threshold of 0.1 sits 6.7x below the observed floor: this is
 * not a band inside the metric's own noise, which is the mistake the HPI_time
 * gate made.
 *
 * What the collapse means: the tree is read live and in-process, OCR reads a
 * framebuffer that can go stale without saying so. If both sensors report
 * plenty and almost nothing fuses, they are looking at different screens, and
 * the frame is the one that is behind. A peer hit exactly this — `sim_look`
 * returned a web form from an earlier session on the device while the element
 * map, taken at the same moment, correctly described the app in front of them.
 */
export const DISAGREEMENT = 0.1;

/** The range observed on healthy screens, for the report to print honestly. */
export const HEALTHY_FUSION = '0.66-0.93';

/**
 * Both sensors need at least this many elements before their disagreement means
 * anything. A screen with one label from each cannot be said to disagree, and a
 * springboard or a lock screen is legitimately sparse.
 */
export const ENOUGH_TO_COMPARE = 3;

/** At or below this from both sensors, there is effectively nothing on screen. */
export const SPARSE = 2;

const seenBy = (targets, sensor) =>
  targets.filter((t) => String(t.source ?? '').split('|').includes(sensor)).length;

/**
 * Read everything that discriminates between the failure modes, in one pass.
 *
 * Every field here exists because it separates two hypotheses. Nothing is
 * collected because it is interesting.
 */
export async function snapshot(deviceQuery, { options } = {}) {
  // **`ensureDaemon` throws on the loudest condition this module exists to
  // name.** "the daemon is running and the display produced no frame in 60s" is
  // reported as an exception, so the first version of this function propagated
  // it and `simframe diagnose` died with a stack trace on a genuinely wedged
  // device — the one moment it is worth running. Caught within an hour of
  // shipping, by the device wedging.
  //
  // So a snapshot of a dead device is a snapshot, not an error. `classify`
  // already has a verdict for it.
  let device;
  let state = null;
  let daemonError = null;
  try {
    ({ device, state } = await api.ensureDaemon(deviceQuery, options));
  } catch (err) {
    daemonError = err.message;
    device = { udid: String(deviceQuery ?? '?'), name: String(deviceQuery ?? 'unknown device') };
  }
  const udid = device.udid;
  if (daemonError) {
    return {
      device: { udid, name: device.name },
      readError: daemonError,
      frame: null,
      elements: { total: 0, ax: 0, ocr: 0, fused: 0 },
      agreement: null,
      frontmost: null,
    };
  }

  let identity = null;
  let readError = null;
  try {
    identity = await api.screenIdentity(udid, { options, confirmNovel: false });
  } catch (err) {
    readError = err.message;
  }
  const targets = identity?.entry?.targets ?? [];

  // Who holds the front, by pid, which is item 169's contribution and the only
  // sensor here that does not go through the display at all.
  let front = null;
  try {
    front = await frontmost.read(udid);
  } catch (err) {
    front = { pid: null, title: null, error: err.message };
  }

  const ax = seenBy(targets, 'ax');
  const ocr = seenBy(targets, 'ocr');
  const fused = targets.filter((t) => {
    const parts = String(t.source ?? '').split('|');
    return parts.includes('ax') && parts.includes('ocr');
  }).length;

  return {
    device: { udid, name: device.name },
    readError,
    frame: state
      ? {
          seq: state.seq ?? null,
          ageMs: state.capturedAt ? Date.now() - state.capturedAt : null,
          stableForMs: state.stableForMs ?? null,
          size: state.width && state.height ? `${state.width}x${state.height}` : null,
          hash: state.hash ? String(state.hash).slice(0, 8) : null,
        }
      : null,
    elements: { total: targets.length, ax, ocr, fused },
    // Null rather than a number when it cannot be computed, so a caller cannot
    // read "0 agreement" off a screen nobody could compare.
    agreement: ax > 0 && ocr > 0 ? Number((fused / Math.min(ax, ocr)).toFixed(3)) : null,
    frontmost: front,
  };
}

/**
 * Name the state, or say it looks fine.
 *
 * Ordered most specific first, and each verdict says what it is evidence *of*
 * rather than what to do about it — the same discipline as the escalation
 * reasons, where a vocabulary that admits "other" collects a pile of "other".
 */
export function classify(snap) {
  if (!snap?.frame) {
    return {
      state: 'capture-down',
      // The daemon's own words when it has them. They are more specific than
      // anything derivable here — "produced no frame in 60s" distinguishes a
      // live daemon over a dead display from a daemon that is not running.
      detail: snap?.readError
        ? `capture is not producing frames: ${snap.readError}`
        : 'no frame state at all — the daemon is not producing frames',
      revive: true,
    };
  }
  const { total, ax, ocr } = snap.elements ?? { total: 0, ax: 0, ocr: 0 };
  if (snap.readError) {
    return { state: 'read-failed', detail: `the screen could not be read: ${snap.readError}`, revive: true };
  }
  if (total === 0) {
    return {
      state: 'nothing-readable',
      detail: 'neither the accessibility tree nor OCR found a single element',
      revive: true,
    };
  }
  // The two sensors are describing different screens. The tree is read live and
  // in-process; OCR reads the framebuffer. So the frame is the stale one.
  if (ax >= ENOUGH_TO_COMPARE && ocr >= ENOUGH_TO_COMPARE
    && snap.agreement != null && snap.agreement <= DISAGREEMENT) {
    return {
      state: 'stale-frame',
      detail: `the tree found ${ax} element(s) and OCR found ${ocr}, and they fuse on `
        + `${snap.agreement} of them (measured healthy: ${HEALTHY_FUSION}). The tree is read live, `
        + 'so the framebuffer is the one that is behind — an image from this device is not safe to trust',
      revive: true,
    };
  }
  // One sensor is reading and the other is silent.
  //
  // **Found within an hour of shipping this classifier, by it calling a device
  // `healthy` while the accessibility tree returned nothing at all** — 0 by
  // tree, 20 by OCR. `agreement` is null unless both sensors report something,
  // so the disagreement check above cannot fire on this, and nothing else was
  // looking. A classifier blind to a whole sensor being dead is worse than no
  // classifier, because it answers.
  //
  // It is not cosmetic. CLAUDE.md's perception order makes the tree
  // authoritative when present, so a silent tree means every intent resolves
  // against OCR alone — the reading quality a field report called "materially
  // less reliable" on web content, applied to the whole device, with nothing
  // saying so.
  if (total >= ENOUGH_TO_COMPARE && (ax === 0 || ocr === 0)) {
    const treeDead = ax === 0;
    return {
      state: treeDead ? 'tree-silent' : 'ocr-silent',
      detail: `${treeDead ? 'OCR' : 'the accessibility tree'} found ${Math.max(ax, ocr)} element(s)`
        + ` and ${treeDead ? 'the accessibility tree' : 'OCR'} found none.`
        + (treeDead
          ? ' The tree is authoritative when present, so every intent is now resolving against'
            + ' OCR alone — materially less reliable, and nothing else says so.'
          : ' Frames are not being read, so anything that needs pixels is unavailable.'),
      revive: true,
    };
  }
  // An app holds the front, and the display is showing almost nothing. This is
  // the CI signature that `device-state.mjs` recognises as "a clock and nothing
  // else", now stated as an observation. It deliberately does NOT claim to know
  // whether this is a lock screen, a dead surface or a crashed SpringBoard —
  // that is the next question, and pretending to answer it is what put a regex
  // where a measurement belongs.
  if (snap.frontmost?.pid && ax <= SPARSE && ocr <= SPARSE) {
    return {
      state: 'not-presenting',
      detail: `pid ${snap.frontmost.pid}`
        + `${snap.frontmost.title ? ` (${snap.frontmost.title})` : ''} holds the front, but the `
        + `display shows ${total} element(s). Something is in front of the app, or the display is `
        + 'not painting it. Which of those it is, is not knowable from here',
      revive: true,
    };
  }
  return { state: 'healthy', detail: `${total} element(s), sensors agree on ${snap.agreement ?? 'n/a'}`, revive: false };
}

/**
 * States that mean the device cannot be driven at all, as opposed to states
 * that mean it is degraded and should be said out loud.
 *
 * The distinction earns its place in `revive`. Demanding `healthy` there turned
 * a **transient** `tree-silent` into a hard failure and a non-zero exit — and it
 * is transient: observed surviving a full revive, then clearing after any app
 * launch, with the springboard reading 13 tree elements again afterwards. A
 * device whose tree is briefly silent still taps, still reads by OCR, and still
 * recovers. Failing it is the false-refusal shape of item 175.
 */
export const UNUSABLE = new Set(['capture-down', 'nothing-readable', 'read-failed']);

export async function diagnose(deviceQuery, { options } = {}) {
  const snap = await snapshot(deviceQuery, { options });
  return { ...snap, verdict: classify(snap) };
}


/**
 * How hard a revive looks before calling a device unhealthy.
 *
 * A device seconds out of a boot is still settling, and one reading would make
 * that a false alarm — the failure shape of item 175.
 */
export const REVIVE_HEALTH_POLLS = 5;
export const REVIVE_HEALTH_WAIT_MS = 2000;

/**
 * What a revive launches to bring a silent accessibility tree back, and the one
 * platform it makes sense on.
 *
 * Settings, because it is on every iOS simulator and opening it changes nothing
 * a caller could be relying on. The app is incidental — what clears the tree is
 * that *something* launched. Android is excluded by name rather than by
 * accident: it has no accessibility tree at all and says so, so `tree-silent`
 * there is the backend's normal state and not a fault.
 */
export const REVIVE_LAUNCH = { ios: 'com.apple.Preferences' };

/**
 * Power-cycle a device and say what state it came back in.
 *
 * The order is load bearing and was learned by hand: stop the daemon, shut the
 * device down, boot it and *wait for the boot to finish*, start capture, rebuild
 * the HID session. Any other order leaves a daemon holding a dead device.
 *
 * Lifted out of `cli.js` on 2026-09-18 so the bench can use it between passes.
 * That is not tidying: `bench-hpi` runs `passes x runs` consecutively with no
 * recovery in between, which on this device is 30 runs against a tolerance of
 * roughly 8-10, so a three-pass suite has never been physically completable and
 * the gate has never produced a hosted-runner reading. DEFERRED 173 listed a
 * revive between passes as worth trying and nothing had tried it.
 *
 * `onStep` is called with each step's outcome so a CLI can print it live and a
 * script can stay quiet.
 */
export async function revive(deviceQuery, { options, onStep = () => {}, device } = {}) {
  const dev = device ?? { udid: String(deviceQuery), name: String(deviceQuery), platform: 'ios' };
  const steps = [];
  const did = async (what, fn) => {
    try {
      await fn();
      steps.push({ step: what, ok: true });
      onStep({ step: what, ok: true });
    } catch (err) {
      steps.push({ step: what, ok: false, error: err.message });
      onStep({ step: what, ok: false, error: err.message });
    }
  };
  // Forced: the point of this is that the device is wedged, so something is
  // certainly still holding it.
  await did('stopped the daemon', async () => { api.stopDaemon(dev.udid, { force: true }); });
  await did('restarted the device, and waited for the boot to finish', () => restartDevice(dev.udid));
  await did('started capture', () => api.ensureDaemon(dev.udid));
  await did('rebuilt the HID session', () => input.resetSession(dev.udid));

  let verdict = null;
  for (let attempt = 0; attempt < REVIVE_HEALTH_POLLS; attempt += 1) {
    verdict = classify(await snapshot(dev.udid, { options }).catch(() => null));
    if (verdict?.state === 'healthy') break;
    if (attempt < REVIVE_HEALTH_POLLS - 1) await new Promise((r) => setTimeout(r, REVIVE_HEALTH_WAIT_MS));
  }
  // A silent tree does not heal with time and does heal with a launch — six
  // reads over 60s at 0 elements, then 14 immediately after one launch.
  const bundle = REVIVE_LAUNCH[dev.platform];
  if (verdict?.state === 'tree-silent' && bundle) {
    await did('launched an app, which is what brings a silent tree back', async () => {
      await launchApp(dev.udid, bundle, { args: [], env: {} });
      await new Promise((r) => setTimeout(r, REVIVE_HEALTH_WAIT_MS));
    });
    verdict = classify(await snapshot(dev.udid, { options }).catch(() => null)) ?? verdict;
  }
  const state = verdict?.state ?? 'read-failed';
  return { device: dev, steps, verdict, state, usable: !UNUSABLE.has(state), healthy: state === 'healthy' };
}
