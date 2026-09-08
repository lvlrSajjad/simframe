// Input driver. simframe observes without any of this; input is an optional
// capability layered on top, so every entry point here has to answer "is this
// even available?" before it answers anything else.
import { execFile } from 'node:child_process';
import * as control from './control.js';
import { promisify } from 'node:util';

const run = promisify(execFile);

const IDB_HINT =
  'install it with: brew tap facebook/fb && brew install idb-companion && pipx install fb-idb';

let driverCache = null;

/**
 * Which input driver to use for a device.
 *
 * simframed is preferred when its control socket is live: it needs no install,
 * speaks points natively, and is the path that survives idb breaking on a new
 * iOS. idb remains the fallback so a machine without the daemon still works.
 */
export async function driverFor(udid) {
  if (udid && control.available(udid)) {
    try {
      const status = await control.status(udid);
      if (status.input?.available) {
        return { name: 'simframed', available: true, version: status.input.detail, reason: null, viaSocket: true };
      }
      return { name: 'simframed', available: false, version: null, reason: status.input?.detail ?? 'input unavailable', viaSocket: true };
    } catch {
      /* daemon went away mid-call; fall through to idb */
    }
  }
  return detectDriver();
}

/**
 * An escape hatch back to idb for the tree.
 *
 * Every private-framework path here is version-coupled, and the host-side
 * translator is no exception: an Xcode upgrade could break it on a machine
 * where work still has to happen that day. Reading it per call rather than
 * caching means the switch takes effect without restarting anything.
 */
function preferIdbTree() {
  return process.env.SIMFRAME_AX_DRIVER === 'idb';
}

/**
 * Which driver reads the accessibility tree for a device.
 *
 * Separate from `driverFor` because these are separate capabilities: a device
 * can be perfectly touchable by the daemon while the translation framework is
 * missing, and reporting one number for both hides which layer is down.
 */
export async function axDriverFor(udid) {
  if (udid && control.available(udid) && !preferIdbTree()) {
    try {
      const status = await control.status(udid);
      if (status.accessibility?.available) {
        return { name: 'simframed', available: true, chosen: false, version: status.accessibility.detail, reason: null };
      }
      // The daemon is up and says it cannot read the tree. idb might still,
      // so this is a reason to fall through rather than an answer.
    } catch {
      /* daemon went away mid-call; fall through to idb */
    }
  }
  const idbDriver = await detectDriver();
  // Asked for, or fallen back to? A driver someone chose is not a degradation,
  // and grading it as one turns the documented escape hatch into a red CI run
  // on exactly the day an Xcode upgrade makes you reach for it.
  const chosen = preferIdbTree();
  if (idbDriver.available) {
    return {
      name: 'idb',
      available: true,
      chosen,
      version: chosen ? `${idbDriver.version} — selected by SIMFRAME_AX_DRIVER` : idbDriver.version,
      reason: null,
    };
  }
  return { name: null, available: false, chosen, version: null, reason: idbDriver.reason };
}

/** @returns {Promise<{name: string, available: boolean, version: string|null, reason: string|null}>} */
export async function detectDriver({ refresh = false } = {}) {
  if (driverCache && !refresh) return driverCache;
  try {
    // idb has no --version; `--help` is the cheapest proof the client runs.
    await run('idb', ['--help'], { timeout: 8000 });
    let version = 'installed';
    try {
      const { stdout } = await run('idb_companion', ['--version'], { timeout: 5000 });
      const info = JSON.parse(stdout.trim());
      version = `companion built ${info.build_date}`;
    } catch {
      /* the companion is spawned on demand; its absence surfaces at first use */
    }
    driverCache = { name: 'idb', available: true, version, reason: null };
  } catch (err) {
    driverCache = {
      name: 'idb',
      available: false,
      version: null,
      reason:
        err.code === 'ENOENT'
          ? `idb is not installed, so simframe can observe the screen but cannot touch it — ${IDB_HINT}`
          : `idb is present but did not run: ${err.message}`,
    };
  }
  return driverCache;
}

async function requireDriver() {
  const driver = await detectDriver();
  if (!driver.available) throw new Error(driver.reason);
  return driver;
}

async function idb(args, { timeout = 20_000 } = {}) {
  await requireDriver();
  const { stdout } = await run('idb', args, { timeout, maxBuffer: 32 << 20 });
  return stdout;
}

/**
 * Screen geometry, needed because the accessibility tree speaks in points while
 * a simframe frame is a scaled bitmap. Without this mapping, a coordinate read
 * off an image lands in the wrong place.
 */
const geometryCache = new Map();

/** Cached: geometry costs an idb round trip and never changes while booted. */
export async function screenInfo(udid, { refresh = false } = {}) {
  if (!refresh && geometryCache.has(udid)) return geometryCache.get(udid);
  const info = await readScreenInfo(udid);
  geometryCache.set(udid, info);
  return info;
}

async function readScreenInfo(udid) {
  // Ask the daemon first. It holds the device's own point size and scale, which
  // makes it both authoritative and free — and it means geometry no longer
  // needs idb at all. Going to idb first meant a machine without idb could
  // capture and tap perfectly well but could not run a verified flow, because
  // building a screen map needs the point size.
  if (control.available(udid)) {
    try {
      const { device } = await control.status(udid);
      if (device?.pointWidth && device?.pointHeight) {
        const density = device.scale ?? 1;
        return {
          pixelWidth: Math.round(device.pointWidth * density),
          pixelHeight: Math.round(device.pointHeight * density),
          density,
          pointWidth: device.pointWidth,
          pointHeight: device.pointHeight,
        };
      }
    } catch {
      /* daemon went away mid-call; fall through to idb */
    }
  }
  const out = await idb(['describe', '--json', '--udid', udid]);
  const info = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
  const dims = info.screen_dimensions || {};
  const density = dims.density || 1;
  return {
    pixelWidth: dims.width ?? null,
    pixelHeight: dims.height ?? null,
    density,
    pointWidth: dims.width_points ?? (dims.width ? Math.round(dims.width / density) : null),
    pointHeight: dims.height_points ?? (dims.height ? Math.round(dims.height / density) : null),
  };
}

/** The accessibility tree, flattened. This is what makes tap-by-label possible. */
export async function describeAll(udid) {
  // The daemon reads the tree host-side through AXPTranslator: no install, and
  // measured at 45ms against idb's 203ms on the same screen. idb stays as the
  // fallback, so a machine without the daemon still reads.
  if (control.available(udid) && !preferIdbTree()) {
    try {
      const { screen } = await control.request(udid, { action: 'ui', ocr: false });
      // An app mid-launch genuinely has no tree yet. Falling through to idb
      // here would just ask a second time and report the same emptiness more
      // slowly, so the honest answer is the empty one.
      if (screen?.sources?.includes('ax')) return (screen.elements ?? []).map(elementToNode);
    } catch {
      /* daemon went away mid-call; fall through to idb */
    }
  }
  // Passing --json here yields empty output; the default already emits JSON.
  const out = await idb(['ui', 'describe-all', '--udid', udid]);
  const nodes = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const node = stack.shift();
        nodes.push(normalizeNode(node));
        if (Array.isArray(node.children)) stack.unshift(...node.children);
      }
    } catch {
      /* idb interleaves non-JSON status lines; skip them */
    }
  }
  return nodes.filter((n) => n.frame);
}

/** A daemon element back into the node shape every caller here expects. */
export function elementToNode(e) {
  return {
    label: cleanLabel(e.label),
    rawLabel: e.label ?? null,
    value: e.value ?? null,
    type: e.role ?? null,
    identifier: e.identifier ?? null,
    enabled: e.state?.enabled ?? null,
    frame: e.frame ?? null,
    raw: e,
  };
}

// Icon fonts put glyphs in the Unicode private use areas, so a label arrives as
// "<glyph>, My Tools". Matching has to see through that to the readable text.
const PRIVATE_USE = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

export function cleanLabel(label) {
  if (!label) return label ?? null;
  const stripped = label.replace(PRIVATE_USE, '');
  return stripped.replace(/\s*,\s*/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').trim() || null;
}

function normalizeNode(node) {
  const frame = node.frame || node.AXFrame || null;
  const rawLabel = node.AXLabel ?? node.label ?? null;
  return {
    label: cleanLabel(rawLabel),
    rawLabel,
    value: node.AXValue ?? node.value ?? null,
    type: node.type ?? node.AXType ?? null,
    identifier: node.AXUniqueId ?? node.identifier ?? null,
    enabled: node.AXEnabled ?? node.enabled ?? null,
    frame: frame
      ? {
          x: frame.x ?? frame.X ?? 0,
          y: frame.y ?? frame.Y ?? 0,
          width: frame.width ?? frame.Width ?? 0,
          height: frame.height ?? frame.Height ?? 0,
        }
      : null,
    raw: node,
  };
}

const text = (n) => [n.label, n.value, n.identifier].filter(Boolean).join(' ');

/**
 * Find the element a caller means. Exact label first, then identifier, then a
 * case-insensitive substring — and an ambiguous match is an error rather than a
 * guess, because a wrong tap is worse than no tap.
 */
export function matchElement(nodes, query, { index } = {}) {
  const q = String(query).toLowerCase();
  const tiers = [
    nodes.filter((n) => (n.label ?? '').toLowerCase() === q),
    nodes.filter((n) => (n.identifier ?? '').toLowerCase() === q),
    nodes.filter((n) => text(n).toLowerCase().includes(q)),
  ];
  for (const tier of tiers) {
    if (!tier.length) continue;
    if (index != null) {
      if (index >= tier.length) {
        throw new Error(`"${query}" matched ${tier.length} elements; index ${index} is out of range`);
      }
      return tier[index];
    }
    if (tier.length > 1) {
      const shown = tier.slice(0, 6).map((n, i) => `[${i}] ${text(n) || n.type}`).join(', ');
      throw new Error(
        `"${query}" matched ${tier.length} elements — pass index to choose: ${shown}`,
      );
    }
    return tier[0];
  }
  throw new Error(`no element matching "${query}" is on screen`);
}

export function centerOf(node) {
  return {
    x: Math.round(node.frame.x + node.frame.width / 2),
    y: Math.round(node.frame.y + node.frame.height / 2),
  };
}

export async function tapPoint(udid, x, y, { durationMs } = {}) {
  const point = { x: Math.round(x), y: Math.round(y) };
  if (control.available(udid)) {
    await control.tap(udid, point.x, point.y, durationMs ? { durationMs } : {});
    return point;
  }
  const args = ['ui', 'tap', '--udid', udid, String(point.x), String(point.y)];
  if (durationMs) args.push('--duration', String(durationMs / 1000));
  await idb(args);
  return point;
}

export async function tapLabel(udid, query, { index, durationMs } = {}) {
  const node = matchElement(await describeAll(udid), query, { index });
  const point = centerOf(node);
  await tapPoint(udid, point.x, point.y, { durationMs });
  return { node, point };
}

export async function typeText(udid, value) {
  if (control.available(udid)) {
    // The daemon's paste path carries characters rather than key positions, so
    // it is not reinterpreted by the device's keyboard layout.
    await control.paste(udid, String(value));
    return;
  }
  await idb(['ui', 'text', '--udid', udid, String(value)]);
}

/** Key events rather than text: for shortcuts and search-as-you-type. */
export async function typeKeys(udid, value) {
  if (control.available(udid)) {
    await control.type(udid, String(value));
    return;
  }
  await idb(['ui', 'text', '--udid', udid, String(value)]);
}

export async function pressKey(udid, keycode) {
  await idb(['ui', 'key', '--udid', udid, String(keycode)]);
}

/**
 * Rebuild the daemon's HID session.
 *
 * Input is the one path with no feedback: a dispatched Indigo message reports
 * success when the send succeeds, and nothing asks the device whether anything
 * happened. Measured on a long-running daemon, a HOME press returned in 66ms
 * and the screen did not move; the same press on a freshly started daemon
 * worked. Whoever holds the frames is the only one who can notice, which is why
 * this is something callers invoke rather than something input does for itself.
 *
 * @returns {Promise<boolean>} whether a session was actually reset.
 */
export async function resetSession(udid) {
  if (!control.available(udid)) return false;
  try {
    await control.resetInput(udid);
    return true;
  } catch {
    return false;
  }
}

export async function pressButton(udid, name) {
  if (control.available(udid)) {
    try {
      await control.press(udid, String(name).toLowerCase());
      return;
    } catch (err) {
      // Only home is verified through Indigo; anything else falls back.
      if (!(await detectDriver()).available) throw err;
    }
  }
  await idb(['ui', 'button', '--udid', udid, String(name).toUpperCase()]);
}

export async function swipe(udid, from, to, { durationMs = 300 } = {}) {
  if (control.available(udid)) {
    await control.swipe(udid, from, to, { durationMs });
    return;
  }
  await idb([
    'ui', 'swipe', '--udid', udid,
    String(Math.round(from.x)), String(Math.round(from.y)),
    String(Math.round(to.x)), String(Math.round(to.y)),
    '--duration', String(durationMs / 1000),
  ]);
}

/** Map a coordinate read off a simframe image into the points idb expects. */
export function imageToPoints({ x, y }, { imageWidth, imageHeight, pointWidth, pointHeight }) {
  if (!pointWidth || !pointHeight) throw new Error('screen geometry is unknown');
  return {
    x: Math.round((x / imageWidth) * pointWidth),
    y: Math.round((y / imageHeight) * pointHeight),
  };
}
