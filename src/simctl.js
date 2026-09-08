// Everything that shells out to Xcode's command line tools.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// `simctl list` costs ~130ms, which would otherwise dominate every warm read,
// so the parsed list is cached for a few seconds.
const DEVICE_CACHE_MS = 4000;
let deviceCache = { at: 0, devices: null, inflight: null };

/** @returns {Promise<Array<{udid: string, name: string, runtime: string, state: string}>>} */
export async function listDevices({ maxAgeMs = DEVICE_CACHE_MS } = {}) {
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

export async function bootedDevices(opts) {
  return (await listDevices(opts)).filter((d) => d.state === 'Booted');
}

/**
 * Resolve a user-supplied device string (UDID, exact name, or substring) to one
 * booted device. Prefers booted devices; falls back to a clear error listing
 * what is actually available.
 */
export async function resolveDevice(query, opts) {
  const all = await listDevices(opts);
  const booted = all.filter((d) => d.state === 'Booted');
  if (!query) {
    if (booted.length === 0) throw new Error('no booted simulator (open Simulator.app or run `xcrun simctl boot <udid>`)');
    return booted[0];
  }
  const q = query.toLowerCase();
  const pools = [booted, all];
  for (const pool of pools) {
    const exact = pool.find((d) => d.udid.toLowerCase() === q || d.name.toLowerCase() === q);
    if (exact) return exact;
    const partial = pool.filter((d) => d.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new Error(`"${query}" matches ${partial.length} devices: ${partial.map((d) => d.name).join(', ')}`);
    }
  }
  throw new Error(`no simulator matches "${query}"; booted: ${booted.map((d) => d.name).join(', ') || 'none'}`);
}

export function isBootedSync(udid) {
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

export async function screenshot(udid, outFile, { mask = 'ignored' } = {}) {
  try {
    await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', `--mask=${mask}`, outFile], {
      timeout: 10_000,
    });
  } catch (err) {
    // Same reason as launchApp: execFile's message is "Command failed: <the
    // whole command>" and simctl's actual complaint is in stderr. A CI failure
    // here reported the command and nothing about why it did not work.
    const detail = (err.stderr || '').trim().split('\n').filter(Boolean).pop();
    throw new Error(detail ? `simctl screenshot failed: ${detail}` : `simctl screenshot failed: ${err.message}`);
  }
}

/** Resample with sips, which ships with macOS, so simframe needs no image deps. */
export async function resize(inFile, outFile, maxDim) {
  await run('sips', ['-Z', String(maxDim), inFile, '--out', outFile], { timeout: 10_000 });
}

/**
 * Launch, optionally with arguments and environment.
 *
 * simctl passes launch arguments after the bundle id and environment through
 * `SIMCTL_CHILD_`-prefixed variables of its own process — which is why env has
 * to be set on the child rather than passed as flags.
 */
export async function launchApp(udid, bundleId, { args = [], env = {}, terminateFirst = false } = {}) {
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

export async function terminateApp(udid, bundleId) {
  await run('xcrun', ['simctl', 'terminate', udid, bundleId], { timeout: 20_000 });
}

export async function openUrl(udid, url) {
  await run('xcrun', ['simctl', 'openurl', udid, url], { timeout: 20_000 });
}

export const PERMISSION_SERVICES = [
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
export async function setPermission(udid, action, service, bundleId) {
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
export async function setPasteboard(udid, value) {
  const child = execFile('xcrun', ['simctl', 'pbcopy', udid], { timeout: 10_000 });
  child.stdin.end(value);
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))));
  });
}
