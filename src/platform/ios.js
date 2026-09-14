// The iOS backend: everything that shells out to Xcode's command line tools.
//
// Nothing outside src/platform/ may import this file. Callers go through
// src/platform/index.js, which is why every function here is module-private
// and reachable only through the `platform` object at the bottom — the
// JavaScript counterpart of the `SimulatorPlatform` protocol in Swift.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as plist from './plist.js';

const run = promisify(execFile);

// `simctl list` costs ~130ms, which would otherwise dominate every warm read,
// so the parsed list is cached for a few seconds.
const DEVICE_CACHE_MS = 4000;
let deviceCache = { at: 0, devices: null, inflight: null };

/** @returns {Promise<Array<{udid: string, name: string, runtime: string, state: string}>>} */
async function listDevices({ maxAgeMs = DEVICE_CACHE_MS } = {}) {
  if (deviceCache.devices && Date.now() - deviceCache.at <= maxAgeMs) return deviceCache.devices;
  if (deviceCache.inflight) return deviceCache.inflight;
  deviceCache.inflight = fetchDevices()
    .then((devices) => {
      deviceCache = { at: Date.now(), devices, inflight: null };
      return devices;
    })
    .catch((err) => {
      deviceCache.inflight = null;
      throw err;
    });
  return deviceCache.inflight;
}

async function fetchDevices() {
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '--json'], {
    maxBuffer: 8 << 20,
  });
  const parsed = JSON.parse(stdout);
  const out = [];
  for (const [runtime, devices] of Object.entries(parsed.devices || {})) {
    for (const d of devices) {
      out.push({
        udid: d.udid,
        name: d.name,
        runtime: runtime
          .replace('com.apple.CoreSimulator.SimRuntime.', '')
          .replace(/-/, ' ')
          .replace(/-/g, '.'),
        state: d.state,
      });
    }
  }
  return out;
}

async function bootedDevices(opts) {
  return (await listDevices(opts)).filter((d) => d.state === 'Booted');
}

/**
 * Resolve a user-supplied device string (UDID, exact name, or substring) to one
 * booted device. Prefers booted devices; falls back to a clear error listing
 * what is actually available.
 */
async function resolveDevice(query, opts) {
  const all = await listDevices(opts);
  return pickDevice(query, all);
}

/**
 * Which device a query means, given the whole list.
 *
 * Separated from the listing so the decision can be **tested** rather than
 * reasoned about, because two peer rounds in a row reported being handed the
 * wrong device and both were decided here. The same move as `decisionOf` in the
 * supervisor: the one line where a wrong answer is expensive should be a
 * function somebody can call with adversarial input.
 */
export function pickDevice(query, all) {
  const booted = all.filter((d) => d.state === 'Booted');
  if (!query) {
    if (booted.length === 0) throw new Error('no booted simulator (open Simulator.app or run `xcrun simctl boot <udid>`)');
    // `booted[0]` was the wrong-device bug, and it was worse than it looked.
    // simctl's order is not "yours" by any definition, so on a machine with
    // more than one booted simulator a bare `simframe ui` read whichever came
    // first — and a bare `simframe tap` would have *injected input* into it. A
    // reviewer reproduced it deterministically against a colleague's simulator.
    //
    // `doctor` got a guard for its own fan-out and this default did not, which
    // is how the same command set could pick two different devices in one
    // moment. Refusing is the only safe answer here: the seam cannot see which
    // device simframe is already driving (that is store state, above the
    // boundary), and a backend must never guess when the cost of guessing wrong
    // is a tap on somebody else's screen. `ambiguous` so that a second platform
    // matching cleanly cannot override this — see resolveAcross.
    if (booted.length > 1) {
      throw Object.assign(
        new Error(
          `${booted.length} simulators are booted and none was named: ` +
            `${booted.map((d) => `${d.name} (${d.udid})`).join(', ')} — name one with --device, ` +
            'or set SIMFRAME_DEVICE to pick a default for this shell. Over MCP there is no shell: ' +
            'pass "device" once on any call and the rest of the session remembers it',
        ),
        { ambiguous: true },
      );
    }
    return booted[0];
  }
  const q = query.toLowerCase();
  const pools = [booted, all];
  for (const pool of pools) {
    // A UDID is unique, so an exact UDID match needs no further thought.
    const byUdid = pool.find((d) => d.udid.toLowerCase() === q);
    if (byUdid) return byUdid;
    // A **name is not unique**, and this branch used to treat it as though it
    // were: one `find` over both fields returned whichever device the list
    // happened to put first, and short-circuited past the ambiguity guard
    // below. Item 83 recorded that two booted devices on this machine are both
    // called "iPhone 17 Pro" and answered it by warning in `sim_devices` and
    // printing a UDID prefix in headers — leaving the resolver, which is where
    // the choice is actually made, untouched.
    //
    // What that cost, reported from a three-hour session on a real app: a
    // caller passed the shared name, read a screen that was "38ms old" and an
    // hour wrong, concluded the app had signed itself out, and abandoned a
    // verification run that was fine. The frame was fresh — it was the *other*
    // device's, idling on a login screen. `refresh: true` returned the matching
    // tree because it refreshed the same wrong device. Two independent-looking
    // sources agreeing with each other and both wrong.
    //
    // So a name that names two devices is an ambiguity, exactly like a partial
    // match that hits two, and it refuses for the same reason: the cost of
    // guessing wrong is reading somebody else's screen and believing it.
    const byName = pool.filter((d) => d.name.toLowerCase() === q);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw Object.assign(
        new Error(
          `"${query}" is the name of ${byName.length} devices: `
          + `${byName.map((d) => d.udid).join(', ')} — a name cannot say which one you mean, `
          + 'so pass the UDID',
        ),
        { ambiguous: true },
      );
    }
    const partial = pool.filter((d) => d.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      // Marked, because the seam asks every backend to resolve and must not
      // answer with an Android device when the query was ambiguous here. A
      // plain "no match" may be passed over; an ambiguity may not.
      throw Object.assign(
        new Error(`"${query}" matches ${partial.length} devices: ${partial.map((d) => d.name).join(', ')}`),
        { ambiguous: true },
      );
    }
  }
  throw new Error(`no simulator matches "${query}"; booted: ${booted.map((d) => d.name).join(', ') || 'none'}`);
}

function isBootedSync(udid) {
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
      maxBuffer: 8 << 20,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    for (const devices of Object.values(parsed.devices || {})) {
      const hit = devices.find((d) => d.udid === udid);
      if (hit) return hit.state === 'Booted';
    }
  } catch {
    /* treat an unreadable device list as "still booted" and retry next tick */
    return true;
  }
  return false;
}

/**
 * What went wrong with a `simctl io screenshot`, in one sentence.
 *
 * Extracted so it can be *tested* rather than reasoned about, for the same
 * reason `pickDevice` and `decisionOf` were: this is the line where a wrong
 * answer was expensive, and it was wrong for a day.
 */
export function screenshotFailure(err) {
  const killed = err.killed || err.signal === 'SIGTERM';
  // `simctl` opens with `Note: No display specified …` on every run, success or
  // failure. When the display surface is dead the command does not fail, it
  // *hangs* — so at kill time that Note is the only thing on stderr, and the
  // tool reported a benign informational line as the reason a capture failed.
  // That is how this wedge stayed nameless through five CI failures.
  const lines = String(err.stderr || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const real = lines.filter((l) => !/^Note:/i.test(l)).pop();
  if (killed && !real) {
    // Run to completion the device names it exactly:
    //   NSPOSIXErrorDomain code 60 — Timeout waiting for screen surfaces
    // which is CoreSimulator saying the surface is gone, and the closest thing
    // to a positive test for the wedge that exists.
    return 'simctl screenshot did not return within 10s. The display surface is not answering'
      + ' — run to completion it reports "Timeout waiting for screen surfaces" (NSPOSIXErrorDomain 60).'
      + ' This is the device, not the capture loop: `simframe revive` restarts it.';
  }
  const detail = real ?? lines.pop();
  return detail ? `simctl screenshot failed: ${detail}` : `simctl screenshot failed: ${err.message}`;
}

async function screenshot(udid, outFile, { mask = 'ignored' } = {}) {
  try {
    await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', `--mask=${mask}`, outFile], {
      timeout: 10_000,
    });
  } catch (err) {
    throw new Error(screenshotFailure(err));
  }
}

/**
 * Launch, optionally with arguments and environment.
 *
 * simctl passes launch arguments after the bundle id and environment through
 * `SIMCTL_CHILD_`-prefixed variables of its own process — which is why env has
 * to be set on the child rather than passed as flags.
 */
async function launchApp(udid, bundleId, { args = [], env = {}, terminateFirst = false } = {}) {
  if (terminateFirst) {
    // A launch against an already-running app is a no-op that reports success,
    // which is how a flow "relaunched" an app and tested the screen it was
    // already on.
    try {
      await terminateApp(udid, bundleId);
    } catch {
      /* not running; that is the state we wanted */
    }
  }
  const childEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) childEnv[`SIMCTL_CHILD_${k}`] = String(v);
  try {
    await run('xcrun', ['simctl', 'launch', udid, bundleId, ...args.map(String)], {
      timeout: 20_000,
      env: childEnv,
    });
  } catch (err) {
    // execFile's message is just "Command failed: ..." with simctl's actual
    // complaint left in stderr. A CI run failed here and said nothing about
    // why, which is the same sin as a silent fallback.
    const detail = (err.stderr || '').trim().split('\n').filter(Boolean).pop();
    throw new Error(detail ? `could not launch ${bundleId}: ${detail}` : `could not launch ${bundleId}: ${err.message}`);
  }
}

async function terminateApp(udid, bundleId) {
  await run('xcrun', ['simctl', 'terminate', udid, bundleId], { timeout: 20_000 });
}

async function openUrl(udid, url) {
  await run('xcrun', ['simctl', 'openurl', udid, url], { timeout: 20_000 });
}

/**
 * Shut a device down and bring it back, waiting for the boot to finish.
 *
 * The remedy for a display that has stopped rendering, which the capture loop
 * can detect and must not perform: it reports `stalled` and stops, because a
 * capture loop that rebooted the device it was watching would be a tool
 * reaching for the mains when a reading looks wrong. This is the operator's
 * decision, reached by `simframe revive`.
 *
 * `bootstatus -b` and not `boot`, for the reason it is used in CI: `boot`
 * returns before the device is usable, and everything downstream then races the
 * boot. Timeboxed generously — a cold boot on a busy machine is slow, and a
 * boot that never finishes should fail here with a reason rather than as a
 * puzzle further down.
 */
async function restartDevice(udid) {
  // Tolerated: a device that is already off cannot be shut down, and that is
  // the state this command is most often reached from.
  await run('xcrun', ['simctl', 'shutdown', udid], { timeout: 60_000 }).catch(() => null);
  await run('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeout: 240_000 });
}

const PERMISSION_SERVICES = [
  'all', 'calendar', 'contacts-limited', 'contacts', 'location', 'location-always',
  'photos-add', 'photos', 'media-library', 'microphone', 'motion', 'reminders', 'siri',
];

/**
 * Grant, revoke or reset a privacy permission.
 *
 * The point of doing this from a test harness is that the alternative is
 * tapping a system alert, and a system alert is not part of the app under test:
 * its buttons move between iOS versions and its appearance is a race.
 */
async function setPermission(udid, action, service, bundleId) {
  const verb = String(action).toLowerCase();
  if (!['grant', 'revoke', 'reset'].includes(verb)) {
    throw new Error(`permission action must be grant, revoke or reset (got "${action}")`);
  }
  if (!PERMISSION_SERVICES.includes(service)) {
    throw new Error(`unknown permission "${service}" — one of: ${PERMISSION_SERVICES.join(', ')}`);
  }
  const args = ['simctl', 'privacy', udid, verb, service];
  if (bundleId) args.push(bundleId);
  try {
    await run('xcrun', args, { timeout: 20_000 });
  } catch (err) {
    const detail = (err.stderr || '').trim().split('\n').filter(Boolean).pop();
    throw new Error(`could not ${verb} ${service}: ${detail || err.message}`);
  }
  return `${verb === 'reset' ? 'reset' : verb + 'ed'} ${service}${bundleId ? ` for ${bundleId}` : ''}`;
}

/** Put text on the device pasteboard — far faster than typing a long string. */
async function setPasteboard(udid, value) {
  const child = execFile('xcrun', ['simctl', 'pbcopy', udid], { timeout: 10_000 });
  child.stdin.end(value);
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))));
  });
}

/**
 * Does this backend own that device id, judged without touching the device?
 *
 * The routing question is asked from inside a capture loop and from a daemon
 * process that never resolved the device itself, so it has to be answered
 * synchronously and for free. A simulator udid is a UUID; an emulator serial
 * (`emulator-5554`) is not, and cannot be mistaken for one.
 */
function ownsUdid(udid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(udid ?? ''));
}

/**
 * Where CoreSimulator keeps a device's data.
 *
 * Read straight off disk, and that is the whole point of this family rather
 * than an optimisation. Measured on this Xcode: `simctl get_app_container` and
 * `simctl listapps` **both** fail on a device that is not running —
 * `Unable to lookup in current state: Shutdown`. The field report that asked
 * for this feature rated it highest-leverage precisely because it answered
 * "what did the app save?" *before the device was booted*, and simctl cannot do
 * that. The filesystem can, so this reads the filesystem.
 */
const deviceRoot = (udid) =>
  path.join(os.homedir(), 'Library/Developer/CoreSimulator/Devices', String(udid));

const containerRoot = (udid) => path.join(deviceRoot(udid), 'data/Containers/Data/Application');

/** The per-container metadata file that says which app owns it. */
const METADATA = '.com.apple.mobile_container_manager.metadata.plist';

/**
 * Every app with a data container on this device, booted or not.
 *
 * The bundle id lives in `MCMMetadataIdentifier` in each container's metadata
 * plist. It is *not* recoverable by grepping the file — the binary plist
 * encodes strings in a way that does not leave the id as a plain substring, and
 * an early version of this that tried to pre-filter that way matched nothing.
 * So each metadata file is asked properly. Measured at **0.52s for 150
 * containers**, which is a listing cost rather than a per-read one.
 */
async function listApps(udid) {
  const root = containerRoot(udid);
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      const exists = fs.existsSync(deviceRoot(udid));
      throw new Error(exists
        ? `device ${udid} has no app data containers yet — nothing has been installed on it`
        : `no simulator data directory for ${udid} (looked in ${root})`);
    }
    throw err;
  }
  const apps = [];
  await Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => {
    const dir = path.join(root, e.name);
    try {
      const { stdout } = await run('plutil',
        ['-extract', 'MCMMetadataIdentifier', 'raw', '-o', '-', path.join(dir, METADATA)],
        { timeout: 10_000 });
      const bundleId = stdout.trim();
      if (bundleId) apps.push({ bundleId, container: dir });
    } catch {
      // A container without readable metadata is not an app we can name, and
      // naming it by its UUID would be offering an id nobody can use.
    }
  }));
  return apps.sort((a, b) => a.bundleId.localeCompare(b.bundleId));
}

/** The data container for one app, or a listing of what is there instead. */
async function appContainer(udid, bundleId) {
  const apps = await listApps(udid);
  const hit = apps.find((a) => a.bundleId === bundleId);
  if (hit) return hit.container;
  // Near misses first: the id is the thing people get wrong, and a bare "not
  // installed" on a device with the app under a slightly different id is the
  // least useful true sentence available.
  const needle = String(bundleId).toLowerCase();
  const near = apps.filter((a) => a.bundleId.toLowerCase().includes(needle)
    || needle.includes(a.bundleId.toLowerCase())).slice(0, 5);
  throw new Error(
    `"${bundleId}" has no data container on ${udid}`
    + (near.length ? ` — did you mean ${near.map((a) => a.bundleId).join(', ')}?` : '')
    + ` (${apps.length} app(s) have one)`,
  );
}

/**
 * Read a property list, whatever it contains.
 *
 * `-convert xml1` and not `json`: six of the twenty real preference plists on
 * the bench device cannot be represented as JSON at all, because `<data>` and
 * `<date>` have no JSON form and plutil refuses rather than inventing one. See
 * the note at the top of plist.js.
 */
async function readPropertyList(file) {
  const { stdout } = await run('plutil', ['-convert', 'xml1', '-o', '-', file], {
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return plist.parse(stdout);
}

/**
 * The prerequisites `simframe doctor` reports for this backend. Returned rather
 * than printed so doctor stays one renderer: a backend says what it needs, and
 * a machine missing it is told which tool, not which platform.
 */
function toolchain() {
  try {
    const version = execFileSync('xcrun', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
    return [{ name: 'xcrun', level: 'ok', detail: version }];
  } catch (err) {
    return [{ name: 'xcrun', level: 'fail', detail: err.message }];
  }
}

/**
 * iOS geometry does not come from here.
 *
 * The daemon holds the device's own point size and scale and is both
 * authoritative and free, and idb can answer when the daemon cannot. Both sit
 * above this boundary, so this backend has nothing to add — and returning null
 * says that, where a guess would have been believed.
 */
function geometry() {
  return null;
}

/**
 * Nor does iOS input.
 *
 * It is Indigo HID inside `simframed`, reached over the control socket: that is
 * simframe's own engine, not something the platform provides. Android's input
 * *is* the platform's — the emulator console — which is why this is a question
 * a backend gets asked at all.
 */
/**
 * When this device last booted, in epoch ms, or null if it cannot be told.
 *
 * Why it matters: the HID session lives in the daemon, and a device restart
 * kills it while leaving the daemon perfectly healthy. Every tap after that is
 * dispatched successfully and moves nothing — measured, five runs in a row,
 * on the correct coordinates for the correct element. Only hardware buttons
 * recover on their own, deliberately, because retrying a tap can act twice.
 *
 * The signal is a stat, not a `simctl` call: CoreSimulator writes
 * `data/var/run/syslog.pid` when the device's syslogd starts, and touches
 * `device.plist` on every state change. Both read 21:21:26 on a device booted
 * at 21:21:26. A stat costs microseconds, which matters because this is
 * checked before input.
 *
 * A false positive costs one session rebuild and no action, so the ordering
 * prefers the most boot-specific marker and falls back rather than guessing.
 */
function bootedAt(udid) {
  const dir = path.join(
    os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid,
  );
  for (const marker of [
    path.join(dir, 'data', 'var', 'run', 'syslog.pid'),
    path.join(dir, 'data', 'var', 'run'),
    path.join(dir, 'device.plist'),
  ]) {
    try {
      return fs.statSync(marker).mtimeMs;
    } catch {
      /* try the next marker */
    }
  }
  return null;
}

function inputDriver() {
  return null;
}

/**
 * What this backend can currently do, so nothing above the boundary has to
 * assume. iOS has both capture engines, input through Indigo HID and the
 * accessibility tree through AXPTranslator — which is to say, everything, and
 * that is exactly why the shape of this was invisible until a second backend
 * turned up without it.
 */
function capabilities() {
  return {
    captureEngines: ['simframed', 'screenshot'],
    input: { supported: true, via: 'daemon' },
    ax: { supported: true },
  };
}

/** @type {import('./index.js').Platform} */
export const platform = {
  id: 'ios',
  deviceNoun: 'simulator',
  listDevices,
  bootedDevices,
  resolveDevice,
  isBootedSync,
  ownsUdid,
  geometry,
  bootedAt,
  inputDriver,
  screenshot,
  launchApp,
  terminateApp,
  openUrl,
  restartDevice,
  listApps,
  appContainer,
  readPropertyList,
  setPermission,
  setPasteboard,
  permissionServices: () => PERMISSION_SERVICES,
  capabilities,
  toolchain,
};
