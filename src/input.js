// Input driver. simframe observes without any of this; input is an optional
// capability layered on top, so every entry point here has to answer "is this
// even available?" before it answers anything else.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as control from './control.js';
import * as store from './store.js';
import { bootedAtFor, capabilitiesFor, geometryFor, inputDriverFor, setPasteboard } from './platform/index.js';
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
  // A platform that carries its own input path answers first: there is no
  // daemon to ask and no idb to fall back to, and reporting either for an
  // Android emulator is how doctor came to claim "input driver: idb" about a
  // tool that has never spoken to one.
  const own = udid ? inputDriverFor(udid) : null;
  if (own) return { name: own.id, available: true, version: own.detail, reason: null, viaSocket: false };
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
  // The platform first, where it can answer at all: on Android it is the only
  // source, and the alternative is `deviceGeometry`'s last-resort guess, which
  // is an iPhone's numbers and silently wrong for everything else.
  try {
    const geo = await geometryFor(udid);
    if (geo?.pointWidth && geo?.pointHeight) return geo;
  } catch {
    /* the backend could not say; the daemon or idb may still be able to */
  }
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
  // A platform with no accessibility tree is not a machine missing idb.
  // `doctor` learned that when it reported "input driver: idb" for an emulator;
  // this path had not, so every Android screen map carried a note telling the
  // reader to brew-install a tool that has never spoken to an Android device —
  // and on a machine where idb *is* installed, spawned it against an emulator
  // serial on every map build.
  const ax = capabilitiesFor(udid).ax;
  if (!ax.supported) throw new Error(`no accessibility tree on this device — ${ax.note}`);
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
    // The daemon batches AXSelected and AXFocused alongside AXEnabled and has
    // since 0.6.0. This converter took one of the three, and it is the one on
    // the path that actually runs — `normalizeNode` below is the idb fallback.
    selected: e.state?.selected ?? null,
    focused: e.state?.focused ?? null,
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
    // The daemon has asked the tree for AXSelected and AXFocused since 0.6.0 —
    // they are two of the eight attributes in its batched round trip — and this
    // function dropped both. `view.renderRow` has printed `selected` for as
    // long as it has existed, against a field nobody set.
    selected: node.AXSelected ?? node.selected ?? null,
    focused: node.AXFocused ?? node.focused ?? null,
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
  await ensureFreshSession(udid);
  const point = { x: Math.round(x), y: Math.round(y) };
  const own = inputDriverFor(udid);
  if (own) {
    await own.tap(udid, point.x, point.y, durationMs ? { durationMs } : {});
    return point;
  }
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
  await ensureFreshSession(udid);
  const own = inputDriverFor(udid);
  if (own) {
    // No pasteboard on Android (docs/DEFERRED.md), so exact text goes through
    // the same keystroke path as everything else. `event text` carries
    // characters rather than key positions, so a non-Latin host layout does not
    // reinterpret them — which is the reason the pasteboard exists on iOS.
    await own.text(udid, String(value));
    return;
  }
  if (control.available(udid)) {
    // The daemon's paste path carries characters rather than key positions, so
    // it is not reinterpreted by the device's keyboard layout.
    await control.paste(udid, String(value));
    return;
  }
  await idb(['ui', 'text', '--udid', udid, String(value)]);
}

/**
 * Put text on the pasteboard **and deliver it** into the focused field.
 *
 * The delivery is the whole point, and it is what was missing: the `paste` step
 * used to set the pasteboard, long-press the field, and report success while
 * the field stayed empty — on both platforms, not just the one it was filed
 * against. iOS had the mechanism and did not use it (the daemon's `paste` is
 * pbcopy *plus* Cmd-V) and Android had the keycode sitting unused in `KEYS`.
 *
 * When nothing can deliver the keystroke this throws rather than returning a
 * cheerful description of half the job. A step that cannot do what it says has
 * to say so; `type` still works on every device.
 */
export async function pasteText(udid, value) {
  await ensureFreshSession(udid);
  const own = inputDriverFor(udid);
  if (own?.key) {
    // The clipboard goes over gRPC; KEYCODE_PASTE is what puts it in the field.
    await setPasteboard(udid, String(value));
    await own.key(udid, 'paste');
    return;
  }
  if (control.available(udid)) {
    // One round trip: the daemon copies and presses Cmd-V.
    await control.paste(udid, String(value));
    return;
  }
  await setPasteboard(udid, String(value));
  throw new Error(
    'the text is on the pasteboard but nothing here can paste it: the keystroke needs the simframe ' +
      'daemon (start it with `simframe start`), or use `type`, which carries the characters itself',
  );
}

/** Key events rather than text: for shortcuts and search-as-you-type. */
export async function typeKeys(udid, value) {
  const own = inputDriverFor(udid);
  if (own) {
    await own.text(udid, String(value));
    return;
  }
  if (control.available(udid)) {
    await control.type(udid, String(value));
    return;
  }
  await idb(['ui', 'text', '--udid', udid, String(value)]);
}

/**
 * Keyboard keys, by name.
 *
 * A peer was blocked outright for want of Return: half of mobile search fields
 * submit on the keyboard return key, `button` covers only the hardware buttons,
 * and `key` wanted a raw HID usage code that nobody should have to know. Typing
 * "\n" as text is not a substitute — text goes through whatever keyboard layout
 * iOS has active, and measured, it turned "Coke Display" into "Coke In Display".
 *
 * These are HID keyboard usage codes, which name a key *position* and are never
 * translated by a layout. That property is the whole reason this path exists on
 * a device whose own doctor warns that two extra layouts are installed.
 */
export const KEYS = {
  return: 40, enter: 40, escape: 41, esc: 41, backspace: 42, delete: 42,
  tab: 43, space: 44, up: 82, down: 81, left: 80, right: 79,
  a: 4,
};

/** Modifier usage codes, held while another key is pressed. */
export const MODIFIERS = { control: 224, shift: 225, alt: 226, option: 226, command: 227, cmd: 227, gui: 227 };

/** The usage code for a name, a number, or null when it is neither. */
export function keyUsage(key) {
  if (Number.isFinite(Number(key))) return Number(key);
  const name = String(key ?? '').trim().toLowerCase();
  return Object.hasOwn(KEYS, name) ? KEYS[name] : null;
}

export async function pressKey(udid, keycode, { modifiers = [] } = {}) {
  await ensureFreshSession(udid);
  const usage = keyUsage(keycode);
  const held = modifiers
    .map((m) => (Number.isFinite(Number(m)) ? Number(m) : MODIFIERS[String(m).trim().toLowerCase()]))
    .filter((m) => Number.isFinite(m));
  if (usage == null) {
    throw new Error(`unknown key ${JSON.stringify(String(keycode))} — known names: ${Object.keys(KEYS).join(', ')}`
      + ', or a HID usage code');
  }
  const own = inputDriverFor(udid);
  if (own) {
    await own.key(udid, usage, held);
    return;
  }
  // The daemon owns the keyboard usage path on iOS. It was implemented in the
  // HID layer and never exposed as a verb, so this fell through to idb — which
  // is absent on a machine using the daemon, and so there was no way to press a
  // keyboard key at all.
  if (control.available(udid)) {
    await control.key(udid, usage, held);
    return;
  }
  if (held.length) throw new Error('modifier keys need the daemon; idb cannot hold one');
  await idb(['ui', 'key', '--udid', udid, String(usage)]);
}

/**
 * Empty the focused field.
 *
 * Command-A then Delete, over HID. There is no clear primitive anywhere —
 * XCUITest, Appium and idb all lack one, and re-typing appends — so this is the
 * standard answer rather than a trick of ours. It is layout-independent for the
 * reason that matters on a device with Farsi and Armenian keyboards installed:
 * a modifier and Delete are key *positions*, and so is the `a` in Command-A, so
 * none of the three is translated by the active layout.
 *
 * It clears whatever has focus, which is why every caller focuses first.
 */
export async function clearField(udid) {
  await pressKey(udid, 'a', { modifiers: ['command'] });
  await pressKey(udid, 'delete');
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
/**
 * Is the daemon's HID session older than the device it talks to?
 *
 * Pure, so the comparison is testable without a device. `graceMs` covers the
 * ordinary case where a daemon is started immediately after a boot and the two
 * timestamps land within milliseconds of each other in either order.
 */
export function sessionStaleness({ bootedAt, sessionSince, graceMs = 2000 }) {
  if (!Number.isFinite(bootedAt)) {
    return { stale: false, reason: 'cannot tell when the device booted' };
  }
  if (!Number.isFinite(sessionSince)) {
    return { stale: false, reason: 'no capture daemon has recorded a start time, so there is no session to compare against' };
  }
  if (bootedAt <= sessionSince + graceMs) return { stale: false, reason: null };
  return {
    stale: true,
    reason: `the device booted ${Math.round((bootedAt - sessionSince) / 1000)}s after the capture daemon started, `
      + 'so the daemon holds an HID session for a device session that no longer exists',
    bootedAt,
    sessionSince,
  };
}

/**
 * What state the input path is in, for doctor and sim_state.
 *
 * Reads two timestamps off disk — the device's boot marker and the daemon's
 * own `startedAt` — and costs a stat each. No input is dispatched to find out,
 * because the whole failure being detected is input that reports success and
 * does nothing.
 */
const bootCache = new Map();
/**
 * Boot time, cached for a moment.
 *
 * iOS answers with a stat; Android runs `adb shell cat /proc/uptime`, a
 * subprocess of 20-40 ms, and `getState` runs twice per flow step. A few
 * seconds of staleness in the staleness detector costs nothing — a device that
 * rebooted three seconds ago is still rebooted at the next check.
 */
async function bootedAtCached(udid, ttlMs = 3000) {
  const hit = bootCache.get(udid);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await bootedAtFor(udid);
  bootCache.set(udid, { at: Date.now(), value });
  return value;
}

export async function sessionHealth(udid) {
  if (!udid || !control.available(udid)) return { stale: false, reason: null };
  let bootedAt = null;
  try {
    bootedAt = await bootedAtCached(udid);
  } catch (err) {
    return { stale: false, reason: `cannot tell when the device booted: ${err.message}` };
  }
  const meta = store.readJson(store.paths(udid).meta);
  const rebuilt = store.readJson(sessionFile(udid))?.rebuiltAt;
  // The newer of the two: the daemon starting creates a session, and rebuilding
  // it replaces one. Either makes the session current as of that moment.
  const sessionSince = Math.max(meta?.startedAt ?? 0, rebuilt ?? 0) || undefined;
  return sessionStaleness({ bootedAt, sessionSince });
}

/**
 * Should this staleness be acted on, given what has already been rebuilt?
 *
 * Pure, and separate from the check because the *key* is the whole bug. This
 * gate used to be a set of udids — "once per process, per device" — and the
 * reasoning was to avoid statting on every action. What it actually bought was
 * that the feature could not fire in the one process that matters. A CLI
 * command is a new process every time, so per-process is per-call there and
 * the gate never showed; the MCP server is a single process that lives for a
 * whole session, so it checked once, at the first action, and then never
 * again — and a device that reboots *mid-session* is precisely the case this
 * exists to catch. Reported from a real session: capture kept working, input
 * died, every tap returned `ok`, and about ten calls went into two wrong
 * conclusions about the app.
 *
 * The right key is the boot the rebuild was for. One attempt per device boot:
 * enough that a failed rebuild does not retry on every tap forever, and not so
 * much that the next boot is invisible.
 */
export function shouldRebuildSession({ stale, bootedAt }, rebuiltFor) {
  if (!stale) return false;
  // A boot we cannot date cannot be memoised against, and re-attempting on
  // every action would be worse than not detecting it. sessionStaleness only
  // reports stale with a finite bootedAt, so this is a belt, not a case.
  if (!Number.isFinite(bootedAt)) return false;
  return rebuiltFor !== bootedAt;
}

/**
 * Rebuild the session if the device outlived it. Once per device boot.
 *
 * Rebuild, and retry nothing: this runs *before* the action, so the action is
 * delivered on a session known to be current. Retrying afterwards is how an
 * action fires twice, which is the hazard the verify barrier exists to
 * prevent — and it is why the existing recovery covers hardware buttons only.
 *
 * The check now runs on every dispatch rather than once. It costs two small
 * `readJson`s and, at most every three seconds, one stat — `bootedAtCached`
 * already caps the part that was expensive, which is what made the
 * once-per-process gate unnecessary as well as wrong.
 */
const rebuiltForBoot = new Map();
export async function ensureFreshSession(udid) {
  if (!udid) return null;
  const health = await sessionHealth(udid);
  if (!shouldRebuildSession(health, rebuiltForBoot.get(udid))) return null;
  rebuiltForBoot.set(udid, health.bootedAt);
  const rebuilt = await resetSession(udid);
  return { ...health, rebuilt };
}

/**
 * When the HID session was last rebuilt, if it has been.
 *
 * The daemon's `startedAt` is the wrong clock on its own: rebuilding the
 * session makes it current again without restarting the daemon, so comparing
 * against the daemon's start left `doctor` reporting `stale` about a session
 * that had just been rebuilt and was demonstrably working. It is a file rather
 * than a variable because every CLI command is a new process and the daemon
 * holding the session outlives all of them.
 */
const sessionFile = (udid) => path.join(store.deviceDir(udid), 'input-session.json');

export async function resetSession(udid) {
  if (!control.available(udid)) return false;
  try {
    await control.resetInput(udid);
    try {
      fs.mkdirSync(store.deviceDir(udid), { recursive: true });
      store.writeAtomic(sessionFile(udid), JSON.stringify({ rebuiltAt: Date.now() }));
    } catch {
      /* the rebuild happened; failing to write it down only costs a stale report */
    }
    return true;
  } catch {
    return false;
  }
}

export async function pressButton(udid, name) {
  await ensureFreshSession(udid);
  const own = inputDriverFor(udid);
  if (own) {
    // Android's whole key vocabulary is safe to offer: `input keyevent` takes
    // names through a public API, so unlike Indigo there is nothing to guess.
    await own.key(udid, name);
    return;
  }
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
  await ensureFreshSession(udid);
  const own = inputDriverFor(udid);
  if (own) {
    await own.swipe(udid, from, to, { durationMs });
    return;
  }
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
