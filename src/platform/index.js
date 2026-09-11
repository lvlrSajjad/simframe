// The platform boundary.
//
// Above this line nothing knows what a simulator is. `src/index.js`,
// `daemon.js`, `actions.js`, `mcp.js` and `cli.js` used to import
// `src/simctl.js` directly — eleven functions and a constant, none of them
// conceptually iOS: list devices, resolve one, launch and terminate an app,
// open a URL, set the pasteboard, grant a permission, take a screenshot. Every
// one has an `adb` equivalent, which is exactly why the boundary had to exist
// before a second backend rather than beside it.
//
// The Swift half has had this since Phase 0: a 21-method `SimulatorPlatform`
// protocol in `PrivateAPI`, with a stub implementation proving the protocol is
// satisfiable by something that is not a simulator. `PLATFORM_SURFACE` below is
// the same idea for JavaScript, and `test/unit.test.mjs` holds every registered
// backend to it.
//
// **Dispatch is by device, not by a process-wide default.** A device is iOS or
// Android; nothing about the host decides which. So `listDevices` unions the
// backends and stamps each record with the platform it came from, and every
// function that takes a udid routes on that udid — `ownsUdid` answers that from
// the id's own shape, because the question is asked from inside a capture loop
// in a process that never listed anything.
import { platform as android } from './android.js';
import { platform as ios } from './ios.js';

export { resize } from './host.js';

/**
 * @typedef {object} Device
 * @property {string} udid
 * @property {string} name
 * @property {string} runtime
 * @property {string} state    'Booted' when the device can be driven
 * @property {string} platform stamped by the seam, never by the backend
 */

/**
 * @typedef {object} Platform
 * @property {string} id
 * @property {string} deviceNoun            what to call a device in user-facing text
 * @property {(opts?: object) => Promise<Device[]>} listDevices
 * @property {(opts?: object) => Promise<Device[]>} bootedDevices
 * @property {(query?: string, opts?: object) => Promise<Device>} resolveDevice
 * @property {(udid: string) => boolean} isBootedSync
 * @property {(udid: string) => boolean} ownsUdid   sync, no I/O — see ios.js
 * @property {Function} geometry     the device's real point size, or null if this backend cannot say
 * @property {Function} inputDriver  this backend's own input path, or null if input comes from above
 * @property {Function} screenshot
 * @property {Function} launchApp
 * @property {Function} terminateApp
 * @property {Function} openUrl
 * @property {Function} setPermission
 * @property {Function} setPasteboard
 * @property {() => string[]} permissionServices
 * @property {() => {captureEngines: string[], input: object, ax: object}} capabilities
 * @property {() => Array<{name: string, level: string, detail: string}>} toolchain
 */

/** Every member a backend must provide. A backend missing one fails a test, not a user. */
export const PLATFORM_SURFACE = Object.freeze([
  'id', 'deviceNoun',
  'listDevices', 'bootedDevices', 'resolveDevice', 'isBootedSync', 'ownsUdid',
  'geometry', 'inputDriver',
  'screenshot', 'launchApp', 'terminateApp', 'openUrl', 'restartDevice',
  'setPermission', 'setPasteboard', 'permissionServices', 'capabilities', 'toolchain',
  'bootedAt',
]);

/** @type {Record<string, Platform>} */
export const PLATFORMS = Object.freeze({ ios, android });

/** @returns {Platform[]} in registration order, which is the order devices are listed in. */
export function backends() {
  return Object.values(PLATFORMS);
}

// udid → platform id, learned from every listing and every resolve. A device
// cannot change platform, so this never goes stale and never needs clearing.
const learned = new Map();

/**
 * Which backend owns this device.
 *
 * Synchronous by requirement: `isBootedSync` is called from the capture loop,
 * in a daemon process that was handed a udid and never listed anything. So the
 * answer comes from what a listing already taught us, or from the id's own
 * shape, and never from the device.
 *
 * With one backend registered an unrecognised id still routes there, so a
 * typo'd udid gets simctl's own error rather than one from the seam — which is
 * what it got before the seam existed.
 *
 * @returns {Platform}
 */
export function platformFor(udid) {
  return chooseBackend(udid, backends());
}

/**
 * The routing decision itself, over a given set of backends, so it can be
 * tested against two of them before a second one exists. Everything here is a
 * decision about *which* backend; nothing here talks to a device.
 */
export function chooseBackend(udid, all) {
  const remembered = learned.get(udid);
  const known = all.find((b) => b.id === remembered);
  if (known) return known;
  const claimed = all.filter((b) => b.ownsUdid(udid));
  if (claimed.length === 1) return claimed[0];
  if (claimed.length === 0 && all.length === 1) return all[0];
  throw new Error(
    claimed.length > 1
      ? `device id "${udid}" is claimed by ${claimed.map((b) => b.id).join(' and ')}`
      : `no platform recognises the device id "${udid}" (tried ${all.map((b) => b.id).join(', ')})`,
  );
}

/** Stamp the platform onto a record without mutating a backend's cached copy. */
function stamp(device, backend) {
  learned.set(device.udid, backend.id);
  return { ...device, platform: backend.id };
}

/** Every device every backend can see, in registration order. @returns {Promise<Device[]>} */
export async function listDevices(opts) {
  const out = [];
  for (const backend of backends()) {
    for (const device of await backend.listDevices(opts)) out.push(stamp(device, backend));
  }
  return out;
}

/** @returns {Promise<Device[]>} */
export async function bootedDevices(opts) {
  const out = [];
  for (const backend of backends()) {
    for (const device of await backend.bootedDevices(opts)) out.push(stamp(device, backend));
  }
  return out;
}

/**
 * Resolve a device string against every backend.
 *
 * A backend that finds nothing is passed over. A backend that finds the query
 * *ambiguous* is not: that error wins even when another backend matched
 * exactly, because answering an ambiguous query with the other platform's
 * device is the wrong-device bug wearing a different hat.
 *
 * Cross-platform ambiguity — one name matching a simulator and an emulator — is
 * reported rather than guessed at, and so is a *bare* query on a host with a
 * booted device on both platforms. That case is not exotic: it is the mixed
 * setup the second backend exists for, and it used to break every command that
 * did not name a device, with the word "undefined" standing in for the query.
 *
 * There is no defensible way to pick for you. Preferring iOS because it came
 * first would silently tap a simulator while you were driving an emulator,
 * which is the one failure this project will not ship. So a bare query on a
 * mixed host says so and names both devices — and `SIMFRAME_DEVICE` exists so
 * the answer can be given once per shell instead of on every command.
 *
 * @returns {Promise<Device>}
 */
export async function resolveDevice(query, opts) {
  return resolveAcross(query ?? process.env.SIMFRAME_DEVICE ?? undefined, opts, backends());
}

/** As above, over a given set of backends — the testable half. @returns {Promise<Device>} */
export async function resolveAcross(query, opts, all) {
  // A backend is entitled to assume a query is a string. `--device X` used to
  // parse as `device: true`, which reached ios.js as `query.toLowerCase` and
  // crashed with a TypeError where an unmatched device should have been a
  // sentence. The parser no longer produces that, and this makes it unable to.
  if (query != null && typeof query !== 'string') query = String(query);
  const hits = [];
  const misses = [];
  for (const backend of all) {
    try {
      hits.push(stamp(await backend.resolveDevice(query, opts), backend));
    } catch (err) {
      if (err?.ambiguous) throw err;
      misses.push(err);
    }
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const named = hits.map((d) => `${d.name} (${d.platform}, ${d.udid})`).join(', ');
    throw new Error(
      (query == null || query === ''
        ? 'no device named, and there is a booted device on more than one platform'
        : `"${query}" matches a device on more than one platform`) +
        `: ${named} — name one by its id, or set SIMFRAME_DEVICE to pick a default`,
    );
  }
  // One backend: its own message, unchanged. It is the better message, because
  // it knows what it looked in.
  if (misses.length === 1) throw misses[0];
  throw new Error(misses.map((e) => e.message).join('; '));
}

// Device-keyed dispatch. The udid is passed through as well as routed on:
// backends keep the signatures they always had, and the seam decides which
// backend a call reaches, never what the call means.
export const isBootedSync = (udid, ...args) => platformFor(udid).isBootedSync(udid, ...args);
export const screenshot = (udid, ...args) => platformFor(udid).screenshot(udid, ...args);
export const launchApp = (udid, ...args) => platformFor(udid).launchApp(udid, ...args);
export const terminateApp = (udid, ...args) => platformFor(udid).terminateApp(udid, ...args);
export const openUrl = (udid, ...args) => platformFor(udid).openUrl(udid, ...args);
export const setPermission = (udid, ...args) => platformFor(udid).setPermission(udid, ...args);
export const setPasteboard = (udid, ...args) => platformFor(udid).setPasteboard(udid, ...args);

/**
 * The permission services a device understands, or every service any backend
 * understands when no device is named.
 *
 * simctl's list has no Android meaning and Android's has no iOS meaning, so the
 * unioned form is only honest as a menu — `setPermission` validates against the
 * backend that will actually run it. `docs/DEFERRED.md` has the open question:
 * the two platforms do not have the same permissions, and the MCP tool
 * description is written once, before any device is chosen.
 */
export function permissionServices(udid) {
  if (udid !== undefined) return platformFor(udid).permissionServices();
  const all = [];
  for (const backend of backends()) {
    for (const service of backend.permissionServices()) if (!all.includes(service)) all.push(service);
  }
  return all;
}

/**
 * The device's real point size and scale, or null when the backend cannot say
 * and something above the boundary has to.
 *
 * Android's only source for this is the backend, and without it the geometry
 * fell through to a guess derived from the capture image — an emulator reported
 * "393x700pt", which is the ring size and not any coordinate space the device
 * knows. Tap points computed from that are wrong, and nothing says so.
 */
export const geometryFor = (udid) => platformFor(udid).geometry(udid);
/** When the device last booted, epoch ms, or null. Both backends answer; neither guesses. */
export const bootedAtFor = (udid) => platformFor(udid).bootedAt(udid);

/**
 * The backend's own input path, or null when input comes from above the
 * boundary. iOS is null: Indigo HID lives in the daemon, which is simframe's
 * engine rather than the platform's. Android is the emulator console.
 */
export const inputDriverFor = (udid) => platformFor(udid).inputDriver(udid);

/**
 * What a device's platform can currently do: which capture engines it has, and
 * whether input and the accessibility tree are implemented for it at all.
 *
 * This exists because doctor, asked about an Android emulator, reported "input
 * driver: idb" and "accessibility tree: idb" — a claim about a tool that has
 * never spoken to an Android device. A layer above the boundary must not
 * describe a device in the other platform's terms, and the only way it can
 * avoid that is to ask.
 */
export const capabilitiesFor = (udid) => platformFor(udid).capabilities();

/**
 * Power-cycle a device, on the backend that owns it.
 *
 * Reached only from `simframe revive`, never from the capture loop: the loop
 * detects a stalled display and reports it, and restarting is the operator's
 * call. A backend that does not have this remedy throws in its own terms rather
 * than borrowing the other's.
 */
export const restartDevice = (udid) => platformFor(udid).restartDevice(udid);

/** What `simframe doctor` should check: each registered backend's own toolchain. */
export function toolchainChecks() {
  return backends().flatMap((backend) => backend.toolchain());
}
