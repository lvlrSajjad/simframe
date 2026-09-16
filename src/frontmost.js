// Did the app we launched actually come forward?
//
// `launch` could not answer that, and item 169 is what it cost: `launch
// com.apple.Preferences (relaunch: true)` returning ok, reporting `[no visible
// change]`, with the device still on the previous app. The CI workflow's own
// step vehicle retries `simctl launch` three times by hand for exactly this, so
// the failure was known at the harness layer and unhandled at the library
// layer, where every user meets it.
//
// **Screen change cannot settle it, and that dead end was checked first.**
// Relaunching an app that is already frontmost legitimately lands on the same
// screen, so "no visible change" is shared by the success and the failure. The
// discriminator has to be identity.
//
// The identity is a **pid**, not a name, and that is the whole reason this works
// cheaply: `simctl launch` prints the pid it started, and the daemon's
// `frontmost` action reports the pid of the application AXPTranslator says is in
// front. Measured on a real device — 10695/10695 for Preferences,
// 10762/10762 for Contacts — so the caller compares two integers instead of
// matching a display name against a bundle id.
//
// Its own module, with the device read injectable, because the only thing that
// ever exercises a launch is a device: a unit test replays pid sequences
// through `landed` and never boots anything.
import * as control from './control.js';

/**
 * How long to wait for the app to reach the front.
 *
 * Measured, not chosen for feel: an already-running app fronts in ~240 ms and a
 * cold switch to Contacts took 1552 ms on this machine. 5 s leaves room for a
 * loaded runner — the same host where `simctl launch` itself has measured
 * 47–55 s — while still being far below the point where a caller gives up.
 */
export const FRONT_BUDGET_MS = 5000;
export const POLL_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Words the translator hands back when it has no name to give.
 *
 * Measured on a device: the application element's title is "Settings" while
 * Settings is on screen, and after a press of home the **same pid** is still
 * frontmost with the title degraded to the bare word "application". That is
 * not a name, and printing it as one would be a confident wrong answer in
 * precisely the state worth noticing — an app frontmost by pid that has
 * stopped naming itself. So the word is kept (the daemon reports raw) and
 * phrased honestly here, where it can be tested without a device.
 */
const GENERIC_NAMES = new Set(['application', 'window', 'unknown', 'group', 'element']);

/** How to refer to whoever holds the front. */
export function nameHolder(pid, title) {
  if (pid === null || pid === undefined) return 'nothing';
  // Blank counts as absent, not as a degraded answer: whitespace is the
  // translator saying nothing, and "no longer names itself" is a claim about
  // an app that answered.
  const said = typeof title === 'string' ? title.trim() : '';
  if (!said) return `pid ${pid}`;
  return GENERIC_NAMES.has(said.toLowerCase())
    ? `pid ${pid} (an app that no longer names itself)`
    : `pid ${pid} (${said})`;
}

/** Who is on screen — pid to compare, title to report. Nulls mean "cannot say". */
export async function read(udid) {
  if (!udid || !control.available(udid)) return { pid: null, title: null };
  try {
    const r = await control.request(udid, { action: 'frontmost' });
    return { pid: typeof r?.pid === 'number' ? r.pid : null, title: r?.title ?? null };
  } catch {
    // A daemon that cannot answer is "cannot say". Reporting it as "not that
    // app" would turn a missing sensor into a failed launch, which is the
    // false refusal item 161 was reverted for.
    return { pid: null, title: null };
  }
}

/** The pid alone, for callers that only compare. */
export const frontmostPid = async (udid) => (await read(udid)).pid;

/**
 * Wait for `pid` to be the app in front.
 *
 * Three verdicts, and the third is not a failure:
 *
 * - `fronted` — the launched pid is the frontmost pid. The launch worked,
 *   whether or not the screen moved.
 * - `did-not-front` — the budget expired with someone else in front. This is
 *   the defect, now visible.
 * - `cannot-say` — no pid from the launch, or nothing on this platform reports
 *   who is frontmost. The caller keeps whatever it said before this existed.
 *
 * @param {object} o
 * @param {number|null} o.pid   what the launch reported
 * @param {() => Promise<{pid: number|null, title: string|null}>} o.read who is in front now
 */
export async function landed({
  pid, read, budgetMs = FRONT_BUDGET_MS, pollMs = POLL_MS,
  now = () => Date.now(), wait = sleep,
} = {}) {
  if (typeof pid !== 'number') {
    return { verdict: 'cannot-say', reason: 'the launch did not report a pid' };
  }
  const started = now();
  let seen = null;
  let asked = 0;
  // Who held the front while we waited, in order. The instrument, not decoration:
  // "the budget was too short" and "the app never went anywhere" produce the same
  // verdict and want opposite remedies, and one list of pids tells them apart —
  // a front that changed hands twice is a slow device, a single pid for the whole
  // budget is a launch that did not happen. Widening a budget without this is the
  // mistake item 146 was, twice.
  const held = [];
  let holder = null;
  for (;;) {
    const look = await read();
    seen = look?.pid ?? null;
    asked += 1;
    if (held[held.length - 1] !== seen) held.push(seen);
    if (seen !== null) holder = look;
    if (seen === pid) return { verdict: 'fronted', ms: now() - started, polls: asked, held };
    // Checked after at least one read, so a platform that cannot answer says so
    // rather than spending the whole budget finding that out.
    if (seen === null && asked === 1) {
      return { verdict: 'cannot-say', reason: 'nothing on this device reports which app is frontmost' };
    }
    if (now() - started >= budgetMs) {
      return {
        verdict: 'did-not-front',
        ms: now() - started,
        polls: asked,
        frontmost: seen,
        held,
        // Named, not just numbered. A runner held the front at pid 7797 through
        // nine consecutive failed launches and the only question that mattered
        // — *what* is 7797 — was the one a number could not answer.
        holder: nameHolder(seen, holder?.pid === seen ? holder.title : null),
      };
    }
    await wait(pollMs);
  }
}

/**
 * `held` as a sentence, because a list of pids is not a diagnosis by itself.
 *
 * **Only meaningful for a `did-not-front`.** Handed a successful wait's `held`
 * it says the launch never took effect about a launch that plainly did — I did
 * exactly that while testing this — so `pid` is taken and the success is
 * refused rather than described. Callers that hold the verdict gate on it;
 * this is the belt for the one that forgets.
 */
export function describeHeld(held = [], pid = null) {
  const real = held.filter((p) => p !== null);
  if (pid !== null && real[real.length - 1] === pid) {
    return `pid ${pid} did reach the front — there is nothing to explain`;
  }
  if (real.length <= 1) {
    return real.length === 1
      ? `pid ${real[0]} held the front for the whole wait, so the launch never took effect`
      : 'nothing held the front at any point';
  }
  return `the front changed hands ${real.length - 1} time(s) (${real.join(' → ')}),`
    + ' so the device was switching apps and simply never reached this one';
}

/** `landed`, reading from the daemon. */
export const check = (udid, pid, opts = {}) =>
  landed({ pid, read: () => read(udid), ...opts });
