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
        runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-/g, '.'),
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
  await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', `--mask=${mask}`, outFile], {
    timeout: 10_000,
  });
}

/** Resample with sips, which ships with macOS, so simframe needs no image deps. */
export async function resize(inFile, outFile, maxDim) {
  await run('sips', ['-Z', String(maxDim), inFile, '--out', outFile], { timeout: 10_000 });
}

export async function launchApp(udid, bundleId) {
  await run('xcrun', ['simctl', 'launch', udid, bundleId], { timeout: 20_000 });
}

export async function terminateApp(udid, bundleId) {
  await run('xcrun', ['simctl', 'terminate', udid, bundleId], { timeout: 20_000 });
}

export async function openUrl(udid, url) {
  await run('xcrun', ['simctl', 'openurl', udid, url], { timeout: 20_000 });
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
