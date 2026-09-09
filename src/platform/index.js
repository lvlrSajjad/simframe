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
// **Selection is deliberately still trivial.** There is one backend, so
// `activePlatform()` returns it. When Android lands, a device is iOS *or*
// Android and the dispatch becomes device-keyed: `listDevices` unions the
// backends, each device record carries its own `platform`, and every function
// taking a udid routes on that record rather than on a process-wide default.
// Writing that dispatch now, against one backend, would be writing it blind —
// so this step moves the code and fixes the shape, and changes no behaviour.
import { platform as ios } from './ios.js';

export { resize } from './host.js';

/**
 * @typedef {object} Platform
 * @property {string} id
 * @property {string} deviceNoun            what to call a device in user-facing text
 * @property {Function} listDevices
 * @property {Function} bootedDevices
 * @property {Function} resolveDevice
 * @property {Function} isBootedSync
 * @property {Function} screenshot
 * @property {Function} launchApp
 * @property {Function} terminateApp
 * @property {Function} openUrl
 * @property {Function} setPermission
 * @property {Function} setPasteboard
 * @property {() => string[]} permissionServices
 * @property {() => Array<{name: string, level: string, detail: string}>} toolchain
 */

/** Every member a backend must provide. A backend missing one fails a test, not a user. */
export const PLATFORM_SURFACE = Object.freeze([
  'id', 'deviceNoun',
  'listDevices', 'bootedDevices', 'resolveDevice', 'isBootedSync',
  'screenshot', 'launchApp', 'terminateApp', 'openUrl',
  'setPermission', 'setPasteboard', 'permissionServices', 'toolchain',
]);

/** @type {Record<string, Platform>} */
export const PLATFORMS = Object.freeze({ ios });

/** @returns {Platform} */
export function activePlatform() {
  return PLATFORMS.ios;
}

// Thin dispatch, so a call site reads the same as it did before the boundary
// existed. Arguments are forwarded untouched: the seam decides *which* backend,
// never *what* the call means.
export const listDevices = (...args) => activePlatform().listDevices(...args);
export const bootedDevices = (...args) => activePlatform().bootedDevices(...args);
export const resolveDevice = (...args) => activePlatform().resolveDevice(...args);
export const isBootedSync = (...args) => activePlatform().isBootedSync(...args);
export const screenshot = (...args) => activePlatform().screenshot(...args);
export const launchApp = (...args) => activePlatform().launchApp(...args);
export const terminateApp = (...args) => activePlatform().terminateApp(...args);
export const openUrl = (...args) => activePlatform().openUrl(...args);
export const setPermission = (...args) => activePlatform().setPermission(...args);
export const setPasteboard = (...args) => activePlatform().setPasteboard(...args);

/** The permission services this backend understands. simctl's list is not Android's. */
export const permissionServices = () => activePlatform().permissionServices();

/** What `simframe doctor` should check for the active backend's own toolchain. */
export const toolchainChecks = () => activePlatform().toolchain();
