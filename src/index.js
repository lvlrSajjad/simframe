// Client API shared by the CLI and the MCP server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, STATE_VERSION } from './daemon.js';
import * as engine from './engine.js';
import { decodePng, encodePng, scaleBitmap } from './png.js';
import {
  REGION_COLS,
  hexToSignature,
  isBlackFrame,
  maxCellDelta,
  CELL_CHANGE,
  regionDeltas,
  regionMap,
  signatureDiff,
} from './analyze.js';
import * as input from './input.js';
import * as fingerprint from './fingerprint.js';
import * as graph from './graph.js';
import * as matching from './matching.js';
import * as refs from './refs.js';
import * as screenmap from './screenmap.js';
import * as metrics from './metrics.js';
import { capabilitiesFor, resolveDevice, resize, screenshot } from './platform/index.js';
import * as store from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DETAIL_LEVELS = { low: 420, normal: 700, high: 1024, full: 0 };

/**
 * The ceiling on any image handed to a model.
 *
 * An image costs ~1,600 tokens when Claude Code handles it as a native image
 * block, and 15,000–25,000 when the base64 is treated as text (claude-code
 * issue #31208) — enough to trip the 25,000-token tool-result limit on its own.
 * A native-resolution frame buys nothing at either price: 1024 px on the long
 * edge is already more than a 393-point screen has to say. Only the CLI, which
 * writes to a file rather than into a context window, may exceed it.
 */
export const MODEL_MAX_IMAGE_DIM = 1024;

export function modelDetail(detail) {
  const dim = resolveMaxDim(detail);
  return dim === 0 || dim > MODEL_MAX_IMAGE_DIM ? MODEL_MAX_IMAGE_DIM : dim;
}

export function resolveMaxDim(detail) {
  if (typeof detail === 'number') return detail;
  if (detail && detail in DETAIL_LEVELS) return DETAIL_LEVELS[detail];
  return DETAIL_LEVELS.normal;
}

/**
 * A full-resolution frame to read text from. The capture loop prunes these
 * aggressively, so by the time a caller wants one it is often already gone —
 * in which case take a fresh shot rather than silently skipping OCR.
 */
async function fullFrameFor(udid, state) {
  if (state.fullFile && fs.existsSync(state.fullFile)) return state.fullFile;
  const p = store.paths(udid);
  // The pointer in state.json can name a frame retention has already thinned
  // away, and it does so routinely — state named full/2475.png while the
  // directory held 2470, 2869 and 2870. Falling straight through to simctl
  // meant OCR quietly shelled out for a screenshot on a machine whose daemon
  // was capturing full frames the whole time: slower, and it made the whole
  // step fail on a runner where that shell-out did not work.
  try {
    const newest = fs.readdirSync(p.full)
      .filter((f) => f.endsWith('.png'))
      .map((f) => ({ f, seq: Number.parseInt(f, 10) }))
      .filter((x) => Number.isFinite(x.seq))
      .sort((a, b) => b.seq - a.seq)[0];
    if (newest) return path.join(p.full, newest.f);
  } catch {
    /* no full directory yet; fall through */
  }
  const file = path.join(p.dir, 'ocr-source.png');
  await screenshot(udid, file, { mask: 'ignored' });
  return file;
}

/**
 * Points-per-pixel and screen size for this device. idb reports both exactly;
 * without it, fall back to the captured frame's aspect and a 3x guess, which is
 * only used for OCR coordinates that nothing can tap anyway.
 */
async function deviceGeometry(udid, state) {
  try {
    const geo = await input.screenInfo(udid);
    if (geo.pointWidth && geo.pointHeight) return geo;
  } catch {
    /* idb absent: fall through */
  }
  // Last resort only. These numbers are an iPhone 17 Pro, so on anything else —
  // an iPad especially — they are silently wrong, and every tap point derived
  // from them lands in the wrong place. screenInfo asks the daemon first now,
  // so reaching here means neither the daemon nor idb could answer.
  const density = 3;
  return {
    density,
    pointWidth: Math.round((state.width * (state.nativeScale ?? 1)) / 1) || 402,
    pointHeight: Math.round((state.height * (state.nativeScale ?? 1)) / 1) || 874,
    guessed: true,
  };
}

export function daemonStatus(udid) {
  const meta = store.readJson(store.paths(udid).meta);
  const pid = meta?.pid ?? null;
  const running = store.isProcessAlive(pid);
  const stale = running && meta?.version !== STATE_VERSION;
  // A loop from an older install is treated as not usable, so callers replace it.
  return { meta, pid, running, stale, alive: running && !stale };
}

/**
 * Make sure a capture loop is running for `deviceQuery`, then return once a
 * frame is actually available. Safe to call on every request: it is a stat
 * when the daemon is already up.
 */
export async function ensureDaemon(deviceQuery, options = {}) {
  const device = await resolveDevice(deviceQuery);
  const p = store.ensureDirs(device.udid);
  store.touchHeartbeat(device.udid);

  const existing = daemonStatus(device.udid);
  if (existing.stale) stopDaemon(device.udid);
  // A dead daemon leaves its last state.json behind. Anything captured before
  // we (re)started the loop is not evidence of a live screen, so ignore it.
  const minCapturedAt = existing.alive ? 0 : Date.now();
  if (!existing.alive) {
    if (acquireSpawnLock(p.lock)) {
      try {
        await startEngine(device.udid, options);
      } finally {
        // Hold the lock briefly so a burst of callers does not double-spawn.
        setTimeout(() => releaseSpawnLock(p.lock), 1500).unref?.();
      }
    }
  }

  // The daemon may need a first build, which is slower than a spawn.
  const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    const state = store.readJson(p.state);
    if (state && state.capturedAt >= minCapturedAt && Date.now() - state.capturedAt < 30_000) {
      return { device, state, started: !existing.alive };
    }
    await sleep(80);
  }
  const tail = readLogTail(p.log);
  throw new Error(`simframe daemon did not produce a frame for ${device.name}${tail ? `\n${tail}` : ''}`);
}

/** Why the daemon was not used, when it was not. Surfaced by doctor. */
export let engineFallbackReason = null;

/**
 * Degrading has to announce itself.
 *
 * "Degrade rather than fail" is the right policy and it nearly sank the tool
 * twice: a file missing from the published package made every install fall back
 * to the simctl engine, and OCR ship disabled, both **silently**. Tests passed,
 * CI passed, nothing printed. The failure was not the missing file; it was that
 * the degradation was invisible.
 *
 * So the reason is written next to the device's state, not just held in this
 * process's memory — otherwise a later `doctor` or `start` sees `engine=simctl`
 * with no explanation, because the process that chose it has exited.
 */
function recordFallback(udid, reason) {
  const file = path.join(store.deviceDir(udid), 'engine-fallback.json');
  try {
    if (reason) store.writeAtomic(file, JSON.stringify({ reason, at: Date.now() }));
    else fs.rmSync(file, { force: true });
  } catch {
    // Never let bookkeeping stop capture from starting.
  }
}

/** Why the running engine is not simframed, if it is not. Survives the process that chose it. */
export function fallbackReason(udid) {
  if (engineFallbackReason) return engineFallbackReason;
  return store.readJson(path.join(store.deviceDir(udid), 'engine-fallback.json'))?.reason ?? null;
}

/**
 * Start whichever engine was asked for, out of the ones this device's platform
 * has.
 *
 * On iOS that is simframed unless told otherwise: it reads the framebuffer
 * directly and is roughly thirty times faster per frame, and the screenshot
 * loop stays reachable with `engine: 'screenshot'` for a machine with no Swift
 * toolchain. On Android the loop is the only engine there is — and asking for
 * simframed there is refused rather than attempted, because a Swift daemon
 * built against CoreSimulator has nothing to say to an emulator, and the
 * failure it produces says nothing useful about why.
 */
async function startEngine(udid, options) {
  const supported = capabilitiesFor(udid).captureEngines;
  const wanted = engine.normalizeEngine(options.engine ?? supported[0]);
  if (!supported.includes(wanted)) {
    throw new Error(`this device cannot run the ${wanted} capture engine — it supports ${supported.join(', ')}`);
  }
  if (wanted === 'simframed') {
    const built = await engine.ensureBuilt();
    if (built.ok) {
      engineFallbackReason = null;
      recordFallback(udid, null);
      engine.spawnDaemon(udid, options);
      return 'simframed';
    }
    engineFallbackReason = built.reason ?? 'simframed unavailable';
    recordFallback(udid, engineFallbackReason);
  }
  spawnNodeDaemon(udid, options);
  return 'screenshot';
}

function spawnNodeDaemon(udid, options) {
  const args = [CLI, 'daemon', udid];
  for (const key of ['fps', 'maxDim', 'ringSize', 'idleExitMs']) {
    if (options[key] != null) args.push(`--${key}=${options[key]}`);
  }
  // stderr goes to the device's own log, the way the Swift daemon's does
  // (engine.js). It was `stdio: 'ignore'`, so anything this loop said about
  // itself went to /dev/null — including the Android backend's notice that the
  // console capture path had failed and it had fallen back to adb at five times
  // the latency. A silent fallback is the failure mode this project has been
  // bitten by twice; it does not get a third time for want of a file handle.
  // The directory may not exist yet on a first start, and `writeCaptureHealth`
  // already taught this project that an unwritable path here fails silently.
  fs.mkdirSync(store.paths(udid).dir, { recursive: true });
  const log = fs.openSync(store.paths(udid).log, 'a');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
}

function acquireSpawnLock(lockFile) {
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    const holder = Number(safeRead(lockFile));
    if (holder && !store.isProcessAlive(holder)) {
      try {
        fs.unlinkSync(lockFile);
        fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function releaseSpawnLock(lockFile) {
  try {
    if (safeRead(lockFile) === String(process.pid)) fs.unlinkSync(lockFile);
  } catch {
    /* a stale lock is reclaimed by the next caller */
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readLogTail(file, lines = 6) {
  return safeRead(file).trim().split('\n').slice(-lines).join('\n');
}

/** A frame this old means the capture loop is wedged, not that the screen is calm. */
export const STALE_FRAME_MS = 2500;

/**
 * How still the screen must be before a frame may be used to key screen memory.
 *
 * A screen map describes a screen, so it must be built from a frame that shows
 * one — not from the middle of a transition, where the layout belongs to
 * neither the screen you left nor the one you are arriving at. Without this,
 * the capture rate leaks into the hit rate: a faster loop samples more
 * transitional frames and remembers more layouts that will never recur.
 *
 * Phase 4 replaces this with the real settle detector, which can tell a
 * spinner from a still screen. Until then, "nothing moved for a while" is
 * enough to decouple memory from frame rate.
 */
export const MEMORY_SETTLE_MS = 250;

/** Below this a "change" is a clock digit or a caret, not a new screen. */
export const MINOR_CHANGE = 0.004;
export const MAJOR_CHANGE = 0.03;

export function changeLevel(diff) {
  if (diff > MAJOR_CHANGE) return 'major';
  if (diff > MINOR_CHANGE) return 'minor';
  return 'none';
}

/** How long a stall has been going on, in words an agent can act on. */
function stallNote(health) {
  const forMs = Math.max(0, Date.now() - (health.since ?? Date.now()));
  const parts = [`capture: stalled — the display surface has been unreadable for ${Math.round(forMs / 1000)}s`];
  if (health.reattaches) parts.push(`${health.reattaches} re-attach${health.reattaches === 1 ? '' : 'es'} did not help`);
  if (health.reason) parts.push(String(health.reason).slice(0, 120));
  // What to do about it, and this line has been wrong until now.
  //
  // It said "only restarting the device is known to cure it". Then the same
  // daemon's log turned out to contain nine "capture recovered on its own"
  // lines, and a wedge that had survived 223 port re-resolves and 6 device
  // rebinds cleared by itself while nobody touched it. Meanwhile Apple's own
  // `simctl io screenshot` on a wedged device returns a valid PNG whose every
  // pixel is black, in 16 s — so the display pipeline has stopped rendering
  // and simframe's read is an accurate report of that, not a bug in it.
  //
  // So: it is the simulator, it often comes back, and restarting the device
  // also cures it. `simframe doctor` runs a screenshot probe when this is
  // published and says which of the two faults it is.
  parts.push(
    "this is the simulator's display, not simframe's read of it: Apple's own screenshot path "
    + 'returns an all-black image on a wedged device. It frequently recovers on its own; '
    + 'restarting the device also cures it, and `simframe doctor` will confirm which fault this is',
  );
  return parts.join('; ');
}

export function liveness(udid, state) {
  const ageMs = Date.now() - state.capturedAt;
  const { running } = daemonStatus(udid);
  // A wedged device and a quiet one look identical from the frames alone: both
  // produce nothing. The difference is that a wedged one is failing reads, and
  // only the capture loop knows that, so it writes it down.
  const health = store.captureHealth(udid);
  const stalled = Boolean(health?.stalled);
  if (!running) {
    return {
      ok: false,
      ageMs,
      stalled,
      note: stalled
        ? `the capture loop has died, and it was stalled before it did — ${stallNote(health)}`
        : 'the capture loop has died; the frame you are looking at is the last one it wrote',
    };
  }
  if (stalled) return { ok: false, ageMs, stalled: true, note: stallNote(health) };
  // Frame age means "stalled" only for a fixed-rate loop.
  //
  // simframed captures on damage, so a screen that is genuinely still produces
  // no frames at all — which is precisely the state `settle` exists to detect.
  // Treating that as a stall made a flow fail on a static page with "capture
  // loop is stalled: newest frame is 2984ms old" immediately after a step had
  // succeeded. The pid check above is the honest liveness signal for this
  // engine; the heartbeat file cannot help, because clients write it, not the
  // daemon.
  const damageDriven = engine.runningEngine(udid) === 'simframed';
  if (!damageDriven && ageMs > STALE_FRAME_MS) {
    return { ok: false, ageMs, stalled: false, note: `capture loop is stalled: newest frame is ${ageMs}ms old` };
  }
  return { ok: true, ageMs, stalled: false, note: null };
}

/**
 * Find the frame a caller is diffing against. `since` may be a frame hash, a
 * sequence number, or a millisecond timestamp. Baselines older than the history
 * window fall back to a coarse answer derived from lastChangeAt, which is still
 * correct about *whether* anything changed.
 */
export function resolveBaseline(state, since) {
  if (since == null) return null;
  const history = state.history || [];
  const key = String(since);
  let entry = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.hash === key || String(h.seq) === key) {
      entry = h;
      break;
    }
  }
  if (entry) return { kind: 'history', entry };

  const at = Number(since);
  if (Number.isFinite(at) && at > 1e12) {
    return { kind: 'coarse', at, changed: (state.lastChangeAt ?? 0) > at };
  }
  return { kind: 'unmatched', requested: key };
}

/**
 * Is the baseline describing a screen that had already finished moving?
 *
 * Pure, so the rule can be argued with in a test rather than only observed on
 * a device. The full reasoning is at the call site in `waitFor`; the short
 * version is that stillness cannot accumulate in the milliseconds between a
 * dispatch returning and a wait beginning, so a screen that already differs
 * from the baseline *and* has already been at rest for the whole stillness
 * window changed for some earlier reason.
 */
/** The newest frame's region signature, which the state already carries. */
function currentSig(state) {
  const h = state?.history;
  if (!h?.length) return null;
  const newest = h.find((x) => x.seq === state.seq) ?? h[h.length - 1];
  return newest?.sig ?? null;
}

/**
 * The longest pause inside a transition, measured after the transition is over.
 *
 * This is the unbiased half of the estimator that was reverted in Phase 11, and
 * the difference is entirely about *when* the measurement stops.
 *
 * The biased version accumulated the statistic from inside the wait: the
 * longest stretch of stillness the wait itself happened to observe. Feed that
 * back into how long the next wait runs and it eats itself — a wait that ends
 * early never sees the pauses that come later, so the gaps read as zero, the
 * window ratchets down, the next wait ends earlier still, and eventually a
 * settle returns mid-transition and the graph learns a screen it never reached.
 * That is not a theory; it corrupted this device's graph in one afternoon.
 *
 * This one reads the frame history *after* the fact, over a window whose end is
 * not decided by the wait. The frames are already on disk with their timestamps
 * and their hashes, so the true profile of a transition is recoverable as long
 * as the history still reaches back to it.
 *
 * That last condition is the whole reason this returns null rather than a
 * number: the ring is bounded, and during fast motion it holds a second or two.
 * A partial window would produce a *shorter* gap than really occurred, which is
 * the exact direction of the bias being removed. Reporting nothing is the only
 * honest answer to a question the evidence cannot reach.
 */
export function longestQuietGap(history, sinceMs, untilMs = Date.now()) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const frames = history
    .filter((f) => Number.isFinite(f?.at) && f.at >= sinceMs && f.at <= untilMs)
    .sort((a, b) => a.at - b.at);
  if (frames.length < 2) return null;
  // The history has to reach back to the action itself. One frame interval of
  // slack, because the frame that captures the moment of the action is not
  // required to land exactly on it.
  const span = frames[1].at - frames[0].at;
  if (frames[0].at > sinceMs + Math.max(250, span)) return null;

  let longest = 0;
  let lastChangeAt = frames[0].at;
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i].hash !== frames[i - 1].hash) {
      longest = Math.max(longest, frames[i].at - lastChangeAt);
      lastChangeAt = frames[i].at;
    }
  }
  // The quiet after the last change is not a pause *inside* the transition —
  // it is the transition being over, which is what a settle already measures.
  return longest;
}

export function baselineAlreadySettled({ mode, changedAtStart, stableForMs, stableMs } = {}) {
  if (mode === 'stable' || !changedAtStart) return false;
  if (!Number.isFinite(stableForMs) || !Number.isFinite(stableMs)) return false;
  return stableForMs >= stableMs;
}

function compareToBaseline(state, baseline) {
  if (!baseline) return null;
  if (baseline.kind === 'history') {
    const from = hexToSignature(baseline.entry.sig);
    const to = hexToSignature(
      (state.history || []).find((h) => h.seq === state.seq)?.sig || '',
    );
    if (!to.length) return { kind: 'unmatched', requested: String(baseline.entry.seq) };
    const diff = signatureDiff(to, from);
    const deltas = regionDeltas(to, from);
    return {
      kind: 'history',
      matched: true,
      seq: baseline.entry.seq,
      hash: baseline.entry.hash,
      at: baseline.entry.at,
      ageMs: Date.now() - baseline.entry.at,
      changed: diff > MINOR_CHANGE,
      level: changeLevel(diff),
      diff: Number(diff.toFixed(5)),
      regions: deltas.map((d) => Number(d.toFixed(4))),
      map: regionMap(deltas, REGION_COLS),
    };
  }
  if (baseline.kind === 'coarse') {
    return {
      kind: 'coarse',
      matched: false,
      at: baseline.at,
      ageMs: Date.now() - baseline.at,
      changed: baseline.changed,
      note: 'baseline is older than the buffered history; only whether-it-changed is known',
    };
  }
  return { kind: 'unmatched', matched: false, requested: baseline.requested };
}

export function stopDaemon(udid, { force = false } = {}) {
  const { pid, running } = daemonStatus(udid);
  if (!running) return false;
  // Another client may be mid-session on this device; do not yank it away.
  if (!force && store.heartbeatAge(udid) < 60_000) return 'in-use';
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** The warm read: newest frame as PNG bytes, with no capture in the request path. */
export async function getFrame(deviceQuery, { detail = 'normal', options } = {}) {
  const { device, state } = await ensureDaemon(deviceQuery, options);
  const p = store.paths(device.udid);
  const maxDim = resolveMaxDim(detail);
  const nativeMax = Math.max(state.width, state.height);

  let file = path.join(p.dir, 'latest.png');
  let scaledOnRead = false;
  if (maxDim === 0) {
    file = state.fullFile;
  } else if (maxDim > nativeMax + 8 && fs.existsSync(state.fullFile)) {
    const out = path.join(p.dir, `read-${maxDim}.png`);
    await resize(state.fullFile, out, maxDim);
    file = out;
    scaledOnRead = true;
  } else if (maxDim < nativeMax - 8) {
    const out = path.join(p.dir, `read-${maxDim}.png`);
    await resize(path.join(p.dir, 'latest.png'), out, maxDim);
    file = out;
    scaledOnRead = true;
  }

  const png = fs.readFileSync(file);
  const bmp = pngSize(png);
  return {
    device,
    state,
    png,
    width: bmp.width,
    height: bmp.height,
    ageMs: Date.now() - state.capturedAt,
    scaledOnRead,
  };
}

function pngSize(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export async function getState(deviceQuery, { since, options, inputHealth = false } = {}) {
  const { device, state } = await ensureDaemon(deviceQuery, options);
  return {
    device,
    state,
    ageMs: Date.now() - state.capturedAt,
    map: regionMap(state.regions || [], REGION_COLS),
    since: compareToBaseline(state, resolveBaseline(state, since)),
    live: liveness(device.udid, state),
    // Costs 32 integer comparisons on a signature already computed, and it is
    // the difference between "the screen is calm" and "the display stopped
    // rendering" — which looked identical to everything above this line.
    black: isBlackFrame(currentSig(state)),
    // Off by default and asked for by the state commands only. A flow step
    // calls getState twice, and the fix for a stale session runs before every
    // action anyway (input.ensureFreshSession) — this is the report, not the
    // repair.
    input: inputHealth ? await input.sessionHealth(device.udid) : undefined,
    timing: inputHealth ? timingOfNow(device.udid, state) : undefined,
  };
}

/**
 * How long this screen has been moving, against how long it usually takes.
 *
 * Research §7 asks `sim_state` for this, and the point is a sentence an agent
 * can act on: a screen 400 ms into a transition that normally takes 350 ms is
 * fine, and the same screen four seconds in is not. Elapsed comes from the
 * frame store's own clock; the distribution comes from the edge that was most
 * recently traversed into this screen.
 *
 * Reads no frames and takes no perception pass: the layout hash and the
 * structural hash screen memory filed under it are both already on disk.
 */
function timingOfNow(udid, state) {
  try {
    const near = screenmap.recallNearest(udid, state.layoutHash);
    const edge = graph.timingInto(udid, near?.entry?.structuralHash);
    const elapsed = Number.isFinite(state.lastChangeAt) ? Date.now() - state.lastChangeAt : null;
    const settled = state.stableForMs >= STRUCTURAL_SETTLE_MS;
    const slower = graph.slowerThanUsual({
      elapsedMs: elapsed,
      p95: edge?.p95,
      settled,
      kind: state.transition?.kind,
    });
    return {
      edge_p50: edge?.p50 ?? null,
      edge_p95: edge?.p95 ?? null,
      samples: edge?.samples ?? 0,
      elapsed_ms: elapsed,
      stable_for_ms: state.stableForMs ?? null,
      slower_than_usual: Boolean(slower.slower),
      note: slower.slower ? slower.note : null,
    };
  } catch {
    // Timing is commentary. A screen with no history still has a state.
    return null;
  }
}

/**
 * Wait for the screen to settle (`mode: 'stable'`) or to move away from what it
 * shows right now (`mode: 'change'`). Removes the screenshot-retry loop.
 */
/**
 * Wait for the screen to do something.
 *
 *   change  the screen differs from `since` (or from now, if no baseline)
 *   stable  the screen holds still for `stableMs`, observed within this call
 *   settle  change first, then stable — what you want after a tap or a launch
 *
 * Pass `since` (a hash captured BEFORE the action) whenever you can: a baseline
 * sampled after the fact is the single most common way to wait for a change
 * that has already happened.
 */
export async function waitFor(
  deviceQuery,
  { mode = 'settle', since, stableMs = 600, timeoutMs = 8000, reactionMs = 2500, baselineHash, options } = {},
) {
  const { device, state: first } = await ensureDaemon(deviceQuery, options);
  const p = store.paths(device.udid);
  const requested = since ?? baselineHash;
  const resolved = resolveBaseline(first, requested);
  let baselineHashValue =
    resolved?.kind === 'history' ? resolved.entry.hash : (requested ?? first.hash);
  const baselineResolved = resolved?.kind === 'history' || requested == null;

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const startSeq = first.seq;
  let last = first;
  /**
   * The longest pause *inside* this transition, in ms.
   *
   * This is the statistic a stillness window exists to defeat: a transition
   * that pauses for 180 ms mid-flight will be mistaken for a finished screen
   * by any window shorter than that. Nobody was measuring it, so the window
   * was a constant — 500 ms, chosen once, paid by every step forever.
   *
   * Tracked as the highest `stableForMs` observed before the screen moved
   * again. Reported so a caller can learn it per edge; a settle that ends
   * without a second change has no gap to report and says 0.
   */
  let quietGapMs = 0;
  let quietRun = 0;
  /**
   * The baseline's own signature, for changes the mean cannot see.
   *
   * Only when the baseline was found in the frame history — a hash we cannot
   * place has no signature to compare against, and guessing one would be worse
   * than not looking.
   */
  const baselineSig = resolved?.kind === 'history' && resolved.entry?.sig
    ? hexToSignature(resolved.entry.sig)
    : (requested == null ? hexToSignature(currentSig(first) ?? '') : null);
  let smallChange = false;
  /** Frames the display was not rendering at all. See `isBlackFrame`. */
  let blackFrames = 0;
  let blackSinceStart = null;
  let lastHash = first.hash;
  let sawChange = mode === 'stable' || first.hash !== baselineHashValue;
  const changedAtStart = sawChange && mode !== 'stable';

  /**
   * The baseline describes a screen that has already finished moving.
   *
   * `since` means "the screen as it was before the action", and the whole
   * reliability of these scripts rests on it being captured *before* rather
   * than after — a baseline sampled afterwards is the commonest way to wait for
   * a change that already happened. What was missing is the other end of it:
   * time also passes between capturing the baseline and dispatching the action,
   * and in a flow step that gap holds a `locate`, a perception pass and a
   * settle wait — hundreds of milliseconds, not microseconds.
   *
   * So a transition can begin *and finish* in that gap, and then `sawChange` is
   * true at wait start because of the previous action's animation. Measured:
   * `tap Accessibility` returned `settled 124ms` against a 500 ms stillness
   * window, the screen had never left the Settings root, and the graph recorded
   * `root -> root` as a verified edge — count 11, changedOutcomes 5, flipping
   * between the real destination and itself all day.
   *
   * The test is unambiguous rather than clever: the screen differs from the
   * baseline *and has already been at rest for the full stillness window*.
   * Stillness cannot have accumulated in the milliseconds between a dispatch
   * returning and this call starting, so whatever changed, changed and settled
   * before we looked, and it is not this action's doing. Re-baseline to what is
   * actually on screen and wait for a further change — which is what the caller
   * asked for and what a stale hash prevented.
   *
   * A screen that differs and is *still moving* is left alone: that is
   * genuinely ambiguous, and after an action the usual reading is the right
   * one.
   */
  const staleBaseline = baselineAlreadySettled({
    mode, changedAtStart, stableForMs: first.stableForMs, stableMs,
  });
  if (staleBaseline) {
    baselineHashValue = first.hash;
    sawChange = false;
  }

  const done = (satisfied, extra = {}) => ({
    device,
    state: last,
    satisfied,
    mode,
    quietGapMs,
    sawChange,
    changedBeforeWait: changedAtStart,
    // Something moved, but only in one region — a control changing state
    // rather than a screen changing.
    smallChange,
    staleBaseline,
    blackFrames,
    // Said as an observation, never as a diagnosis: a screen can be black
    // because the app drew black. What makes it the capture wedge is that it
    // stays black while input is being delivered, and the caller knows that.
    blackMs: blackSinceStart ? Date.now() - blackSinceStart : 0,
    baselineHash: baselineHashValue,
    baselineResolved,
    waitedMs: Date.now() - startedAt,
    live: liveness(device.udid, last),
    ...extra,
  });

  while (Date.now() < deadline) {
    const state = store.readJson(p.state);
    if (state) {
      last = state;
      // A wedged capture loop must not look like a calm screen.
      const live = liveness(device.udid, state);
      if (!live.ok) return done(false, { stalled: true });

      // A black frame is not evidence, in either direction.
      //
      // The capture wedge leaves every frame black while the whole capture path
      // reports success, so before this a settle read the black screen as a
      // change (the hash differs from anything) and then as a calm one (nothing
      // moves), and returned `ok` for an action nobody could see the result of.
      // It self-recovers most times, so the useful behaviour is to keep waiting
      // rather than to conclude.
      const black = isBlackFrame(currentSig(state));
      if (black) {
        blackFrames += 1;
        blackSinceStart = blackSinceStart ?? Date.now();
        await sleep(60);
        continue;
      }
      blackSinceStart = null;

      if (!sawChange && state.hash !== baselineHashValue) sawChange = true;

      // A change too small for the whole-screen mean to see.
      //
      // A switch flipping moves one cell of thirty-two by 0.043 and the mean by
      // 0.0013 — a third of the threshold — so every switch, radio dot,
      // checkbox and segment highlight was an action that "changed nothing",
      // and `no-visible-change` is a verdict that escalates. See
      // analyze.CELL_CHANGE for the measured gap this sits in.
      //
      // Deliberately feeding `sawChange` and *not* stillness: `stableForMs`
      // stays on the mean, because a blinking text caret is a small localised
      // change and a screen with a cursor would otherwise never settle.
      if (!sawChange && baselineSig) {
        const sig = currentSig(state);
        if (sig && maxCellDelta(hexToSignature(sig), baselineSig) > CELL_CHANGE) {
          sawChange = true;
          smallChange = true;
        }
      }

      // A pause that turned out not to be the end of the transition. Only
      // pauses followed by more movement count: the quiet at the end of a
      // settle is the answer, not a gap.
      if (state.hash !== lastHash) {
        if (quietRun > quietGapMs) quietGapMs = quietRun;
        quietRun = 0;
        lastHash = state.hash;
      } else if (Number.isFinite(state.stableForMs)) {
        quietRun = Math.max(quietRun, state.stableForMs);
      }

      // Some controls barely move the screen at all — a radio dot, a checkbox,
      // a button changing state. Waiting the full timeout for a change that
      // will never be visible turns a 100ms action into a 12s one, so give up
      // early and say so, rather than silently burning the clock.
      //
      // But "nothing changed" is a claim about something observed, and with no
      // frame captured since this call began, nothing has been. The screenshot
      // engine idles at 1.5 fps, so a 500 ms reaction window expired before the
      // first new frame existed: a tap that opened a whole activity was
      // reported as having no visible effect, and the text meant for the field
      // it opened was typed into nothing. Damage-driven capture on iOS hid this
      // by being fast.
      const observedSomething = state.seq - startSeq >= 1;
      if (!sawChange && observedSomething && Date.now() - startedAt > reactionMs && state.stableForMs >= stableMs) {
        return done(false, { noVisibleChange: true });
      }

      if (mode === 'change') {
        if (sawChange) return done(true);
      } else {
        // "settle" requires a change first, so accumulated stillness from before
        // the caller acted can never satisfy it; once the change is seen,
        // stableForMs is measured from that change. Plain "stable" has no such
        // requirement — an already-still screen genuinely is stable.
        // At least one frame must arrive during the call, so the answer is
        // never derived purely from what was already on disk.
        const freshFrames = state.seq - startSeq;
        if (sawChange && freshFrames >= 1 && state.stableForMs >= stableMs) {
          return done(true);
        }
      }
    }
    await sleep(60);
  }
  return done(false, { timedOut: true });
}

/**
 * Tile the most recent frames into one image. A transition or animation becomes
 * legible in a single tool call instead of a sequence of them.
 */
export async function getStrip(deviceQuery, { count = 5, spanMs, thumbMaxDim = 240, options } = {}) {
  const { device } = await ensureDaemon(deviceQuery, options);
  const p = store.paths(device.udid);
  let entries = fs
    .readdirSync(p.ring)
    .filter((n) => n.endsWith('.png'))
    .map((n) => ({ seq: parseInt(n, 10), file: path.join(p.ring, n) }))
    .filter((e) => Number.isFinite(e.seq))
    .sort((a, b) => a.seq - b.seq);

  const stamps = new Map(((await ensureDaemon(deviceQuery, options)).state.ring || []).map((f) => [f.seq, f.at]));
  entries = entries
    .map((e) => ({ ...e, mtimeMs: stamps.get(e.seq) ?? safeMtime(e.file) }))
    .filter((e) => e.mtimeMs);
  const want = Math.max(1, count);
  if (spanMs) {
    // "Show me the last 40 seconds" means frames spread ACROSS that window, not
    // the newest few frames that happen to fall inside it.
    const cutoff = Date.now() - spanMs;
    const within = entries.filter((e) => e.mtimeMs >= cutoff);
    if (within.length) {
      entries = within.length <= want ? within : spreadEvenly(within, want);
    } else {
      entries = entries.slice(-want);
    }
  } else {
    entries = entries.slice(-want);
  }
  if (!entries.length) throw new Error('no frames buffered yet');

  const frames = entries.map((e) => decodePng(fs.readFileSync(e.file)));
  const ratio = frames[0].height / frames[0].width;
  const tw = Math.max(40, Math.round(thumbMaxDim / Math.max(1, ratio)));
  const th = Math.round(tw * ratio);
  const gap = 6;
  const width = frames.length * tw + gap * (frames.length - 1);
  const sheet = { width, height: th, data: Buffer.alloc(width * th * 4, 0) };

  frames.forEach((frame, i) => {
    const thumb = scaleBitmap(frame, tw, th);
    const x0 = i * (tw + gap);
    for (let y = 0; y < th; y++) {
      thumb.data.copy(sheet.data, (y * width + x0) * 4, y * tw * 4, (y + 1) * tw * 4);
    }
  });

  const t0 = entries[0].mtimeMs;
  return {
    device,
    png: encodePng(sheet),
    width,
    height: th,
    frames: entries.map((e) => ({ seq: e.seq, offsetMs: Math.round(e.mtimeMs - t0) })),
    spanMs: Math.round(entries[entries.length - 1].mtimeMs - t0),
  };
}

/** Pick `count` items spaced as evenly as possible across a list, keeping the ends. */
export function spreadEvenly(items, count) {
  if (count >= items.length) return items;
  if (count === 1) return [items[items.length - 1]];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  }
  return out;
}

function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * What happened on screen over the last `spanMs`, derived from the buffered
 * frame signatures. This is the "memory" view: not every frame, but the events
 * worth knowing about, each with when it started, how long it took and how much
 * of the screen it moved.
 */
export async function getTimeline(deviceQuery, { spanMs = 60_000, options } = {}) {
  const { device, state } = await ensureDaemon(deviceQuery, options);
  const now = Date.now();
  const hist = (state.history || []).filter((h) => h.at >= now - spanMs);
  const events = [];
  let current = null;

  hist.forEach((h, i) => {
    if ((h.diff ?? 0) > MINOR_CHANGE) {
      if (!current) {
        const before = hist[i - 1] || h;
        current = { startAt: before.at, fromSig: before.sig, endAt: h.at, frames: 1, peak: h.diff };
      } else {
        current.endAt = h.at;
        current.frames += 1;
        current.peak = Math.max(current.peak, h.diff);
      }
      current.toSig = h.sig;
    } else if (current) {
      current.endAt = h.at;
      current.toSig = h.sig;
      events.push(current);
      current = null;
    }
  });
  if (current) events.push(current);

  const shaped = events.map((e) => {
    const from = hexToSignature(e.fromSig || '');
    const to = hexToSignature(e.toSig || '');
    const magnitude = from.length && to.length ? signatureDiff(to, from) : e.peak;
    const deltas = from.length && to.length ? regionDeltas(to, from) : [];
    return {
      startedMsAgo: now - e.startAt,
      endedMsAgo: now - e.endAt,
      durationMs: Math.max(0, e.endAt - e.startAt),
      magnitude: Number(magnitude.toFixed(4)),
      level: changeLevel(magnitude),
      frames: e.frames,
      map: deltas.length ? regionMap(deltas, REGION_COLS) : null,
    };
  });

  return {
    device,
    state,
    spanMs,
    coveredMs: hist.length ? now - hist[0].at : 0,
    frames: hist.length,
    buffered: (state.ring || []).length,
    events: shaped,
    idleForMs: state.stableForMs,
    live: liveness(device.udid, state),
  };
}

/** The buffered frame closest to a moment in the past. */
export async function getFrameAt(deviceQuery, { msAgo = 0, options } = {}) {
  const { device, state } = await ensureDaemon(deviceQuery, options);
  const ring = state.ring || [];
  if (!ring.length) throw new Error('no frames buffered yet');
  const target = Date.now() - msAgo;
  let best = ring[0];
  for (const frame of ring) {
    if (Math.abs(frame.at - target) < Math.abs(best.at - target)) best = frame;
  }
  const file = path.join(store.paths(device.udid).ring, `${best.seq}.png`);
  if (!fs.existsSync(file)) throw new Error(`frame #${best.seq} is no longer buffered`);
  const png = fs.readFileSync(file);
  return {
    device,
    state,
    png,
    seq: best.seq,
    at: best.at,
    actualMsAgo: Date.now() - best.at,
    requestedMsAgo: msAgo,
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    oldestMsAgo: Date.now() - ring[0].at,
  };
}

/**
 * Find where to tap for a label on the screen showing right now.
 *
 * Familiar screens answer from memory: no accessibility read, no OCR, no image.
 * A screen seen for the first time pays once to build its map, and every later
 * visit is a file read.
 */
/**
 * Wait, briefly, for a frame that is holding still. Returns whatever the newest
 * frame is once the screen settles or the budget runs out, saying which.
 */
export async function settledState(udid, { settleMs = MEMORY_SETTLE_MS, timeoutMs = 1500 } = {}) {
  const p = store.paths(udid);
  const deadline = Date.now() + timeoutMs;
  let state = store.readJson(p.state);
  while (Date.now() < deadline) {
    state = store.readJson(p.state) ?? state;
    // The daemon runs a real settle detector that can tell a spinner from a
    // still screen. Prefer it; the duration check is the fallback for the
    // simctl engine, which has no such thing.
    if (state?.settled === true) return { state, settled: true };
    if (state && state.settled === undefined && state.stableForMs >= settleMs) {
      return { state, settled: true };
    }
    await sleep(40);
  }
  return { state, settled: false };
}

/**
 * Read the screen with the perception layers pinned, and keep nothing.
 *
 * Every other path decides for itself which layers to read, which is right for
 * doing work and useless for measuring: the question "what is the accessibility
 * tier worth" needs the same frame read twice, once with it and once without.
 * `persist: false` so measuring teaches the graph nothing.
 */
export async function readScreenWith(deviceQuery, { useAx = true, useOcr = true, options } = {}) {
  const { device, state } = await ensureDaemon(deviceQuery, options);
  const udid = device.udid;
  const geo = await deviceGeometry(udid, state);
  const entry = await screenmap.build(udid, {
    hash: state.hash,
    layoutHash: state.layoutHash,
    fullFrame: await fullFrameFor(udid, state),
    density: geo.density,
    screen: { width: geo.pointWidth, height: geo.pointHeight },
    useAx,
    useOcr,
    persist: false,
  });
  return { device, entry, points: { width: geo.pointWidth, height: geo.pointHeight } };
}

export async function locate(
  deviceQuery,
  query,
  { index, refresh = false, useAx = true, useOcr = true, settleMs = MEMORY_SETTLE_MS, options } = {},
) {
  const { device, state: firstState } = await ensureDaemon(deviceQuery, options);
  const udid = device.udid;

  // Selectors resolve before any perception happens: `#3` is already an answer
  // somebody numbered, and `@x,y` was never a question about the screen.
  const selector = refs.parseSelector(query);
  if (selector.kind === 'point') {
    return {
      device,
      state: firstState,
      target: { label: `(${selector.x},${selector.y})`, x: selector.x, y: selector.y, source: 'coordinates' },
      from: 'selector',
      distance: 0,
      settled: true,
    };
  }
  if (selector.kind === 'ref') {
    // Screen memory answers "which screen is this?" from a file, so a ref can
    // be checked against structural identity without paying for a perception
    // pass — which is the whole reason a ref exists.
    const near = screenmap.recallNearest(udid, firstState.layoutHash);
    const hit = refs.resolveRef(udid, selector.ref, {
      layoutHash: firstState.layoutHash,
      structuralHash: near?.entry?.structuralHash ?? null,
      screenKnown: Boolean(near),
    });
    return {
      device,
      state: firstState,
      target: { ...hit, label: hit.label ?? `#${hit.ref}`, source: hit.source ?? 'ref' },
      from: 'ref',
      distance: 0,
      settled: true,
    };
  }
  if (selector.exact) query = selector.label;
  // Key memory off a settled frame, never off whichever frame happened to be
  // newest, so the capture rate cannot change what gets remembered.
  const { state, settled } = await settledState(udid, { settleMs });
  const current = state ?? firstState;
  let entry = null;
  let from = 'memory';
  let distance = 0;

  if (!refresh) {
    const near = screenmap.recallNearest(udid, current.layoutHash);
    if (near) {
      entry = near.entry;
      distance = near.distance;
    }
  }

  if (!entry) {
    const geo = await deviceGeometry(udid, current);
    entry = await screenmap.build(udid, {
      hash: current.hash,
      layoutHash: current.layoutHash,
      fullFrame: await fullFrameFor(udid, current),
      density: geo.density,
      screen: { width: geo.pointWidth, height: geo.pointHeight },
      useAx,
      useOcr,
      // A map built while the screen was moving describes nothing that will
      // recur, so it is used for this call and then thrown away.
      persist: settled,
    });
    from = settled ? 'built' : 'built-unsettled';
  }

  const screenSize = { width: current.width, height: current.height };
  const geo = await deviceGeometry(udid, current);
  const points = { width: geo.pointWidth, height: geo.pointHeight };

  // Intent resolution rather than string matching: it understands verbs
  // ("tap Save"), typos, icon-only controls by synonym ("back"), and where on
  // screen the caller meant ("Assets tab").
  if (index == null) {
    const outcome = matching.resolve(entry.targets, query, { screen: points });
    if (outcome.status === 'ambiguous') {
      const list = outcome.alternatives
        .map((a, i) => `[${i}] "${a.label}" (${a.x},${a.y}) ${a.region ?? 'content'} ${a.score}`)
        .join(', ');
      // Tagged, not just thrown: the reason an escalation happened is known
      // here and nowhere above here. See metrics.tag — it adds a property and
      // changes nothing else about the error.
      throw metrics.tag(
        new Error(
          `"${query}" matches ${outcome.alternatives.length} things on this screen — say which, or pass index: ${list}`,
        ),
        'ambiguous_intent',
        // Present, several times over — as opposed to absent, which also tags
        // ambiguous_intent when the screen was one we thought we knew. A
        // waiting caller needs the difference: more time cannot make a thing
        // unique, and it can make an absent thing arrive.
        { candidates: outcome.alternatives, ambiguous: true, intent: query },
      );
    }
    if (outcome.status === 'ok') {
      return {
        device, state: current, entry, target: outcome.target, from, distance, settled,
        score: outcome.score, reasons: outcome.reasons, alternatives: outcome.alternatives,
        screens: screenmap.stats(udid).screens,
      };
    }
    // Nothing scored well enough. Falling through to plain substring matching
    // here undoes every guard above — it has no off-screen filter and no
    // coverage weighting, and it is what returned a scrolled-away list row for
    // "back". "Not found" is the correct answer.
    const visible = entry.targets.filter((t) => t.label && t.y >= 0 && t.y <= points.height);
    const sample = visible.slice(0, 12).map((t) => t.label.slice(0, 24)).join(', ');
    // Which escalation this is depends on whether the screen was recognised.
    // Screen memory had nothing for it (`from` is one of the built values) and
    // the target is missing: that is not knowing the screen. On a screen
    // recalled from memory, the screen is known and the intent did not resolve.
    throw metrics.tag(
      new Error(`"${query}" is not on this screen. Visible: ${sample || '(nothing readable)'}`),
      from === 'memory' ? 'ambiguous_intent' : 'unknown_screen',
      { candidates: visible.slice(0, 8), intent: query },
    );
  }

  const candidates = screenmap.rank(entry, query);
  const target = index != null ? candidates[index] : candidates[0];
  if (!target) {
    const visible = entry.targets.filter((t) => t.label);
    const sample = visible.slice(0, 12).map((t) => t.label).join(', ');
    throw metrics.tag(
      new Error(`"${query}" is not on this screen. Visible: ${sample || '(nothing readable)'}`),
      from === 'memory' ? 'ambiguous_intent' : 'unknown_screen',
      { candidates: visible.slice(0, 8), intent: query },
    );
  }
  return { device, state: current, entry, target, from, distance, settled, screens: screenmap.stats(udid).screens };
}

/**
 * What screen this is, structurally.
 *
 * Uses the screen map — recalled when the pixel index finds one, built when it
 * does not. The pixel hash is what makes the lookup cheap; the structural hash
 * is what makes the answer right.
 */
/**
 * Structural settle: how long to let a screen finish arriving before believing
 * a fingerprint that nothing recognises.
 */
export const STRUCTURAL_SETTLE_MS = 300;

/**
 * How much of the structural window is still owed, given when the last sample's
 * frame was captured.
 *
 * This was `sleep(300)` between the two readings, and unlike every other fixed
 * wait in the engine it cannot be replaced by waiting for a signal — because
 * there is no signal. The race it guards is a screen whose *pixels* have gone
 * still while its structure has not: a list whose spinner has gone and whose
 * rows have not landed is perfectly quiet and structurally wrong, so the settle
 * detector, which watches pixels, has nothing to report. Only elapsed time
 * separates the two readings.
 *
 * What can be fixed is that the wait was *additional*. The guarantee wanted is
 * 300 ms between the frames the two samples read; the code slept 300 ms after a
 * sample that had already spent an unbounded settle wait and a full perception
 * pass getting there. On a screen that took a second to go quiet the separation
 * was already there and the sleep bought nothing but a second of it. So credit
 * what has passed and wait only for the remainder — the same guarantee, and
 * usually none of the sleep.
 *
 * The window itself is per-screen learnable, and worth noting that its
 * estimator has the *opposite* feedback sign to the one that corrupted the
 * graph: a window too short produces disagreeing samples, which lengthens it.
 * Self-correcting rather than self-reinforcing. It still waits on the
 * perception eval harness, because "the samples agreed" is only evidence the
 * window was long enough if the readings themselves are trustworthy.
 */
export function structuralSettleOwed(capturedAt, now = Date.now(), windowMs = STRUCTURAL_SETTLE_MS) {
  if (!Number.isFinite(capturedAt)) return windowMs;
  return Math.max(0, Math.min(windowMs, windowMs - (now - capturedAt)));
}

/**
 * How long identity will wait for pixels to go quiet.
 *
 * Not the caller's timeout. A flow allows twelve seconds for a screen to
 * arrive, but some screens never report settled at all — live content, a
 * looping animation — and spending the flow's whole budget waiting for a flag
 * that will not come cost 53s on a tour that had taken 7s. Long enough to
 * outlast a normal transition, short enough that a screen which never settles
 * is cheap to give up on.
 */
export const IDENTITY_SETTLE_TIMEOUT_MS = 2500;
const STRUCTURAL_SETTLE_SAMPLES = 3;

/**
 * What screen is this?
 *
 * `settled` is a question about pixels, and it is answered before a screen has
 * necessarily finished arriving: a list whose spinner has gone but whose rows
 * have not landed is perfectly still and structurally wrong. Measured, that put
 * one screen at 17 tokens on one visit and 7 on the next, which is the whole
 * reason the same-screen floor sits at 0.41 instead of somewhere comfortable.
 *
 * So structural identity gets a structural settle of its own — but only where
 * it costs something worth paying for. A fingerprint that matches a screen we
 * already know is taken at face value; the risk is not that we mislabel a known
 * screen, it is that a half-drawn one becomes a new node nobody can navigate
 * to. Novel fingerprints, and only those, are re-sampled until two consecutive
 * readings agree.
 */
export async function screenIdentity(deviceQuery, { options, confirmNovel = true, settleMs, timeoutMs, fresh = false } = {}) {
  const { device, state } = await ensureDaemon(deviceQuery, options);
  const udid = device.udid;

  const read = async ({ fresh = false } = {}) => {
    // Settle with the caller's patience, not a default. settledState times out
    // at 1.5s on its own, so inside a flow that allows twelve seconds this was
    // calling a screen unsettled while the flow was still happily waiting for
    // it — and an unsettled screen records no edge, so the graph learned
    // nothing and every later step read `unverified`.
    const { state: settledFrame, settled } = await settledState(udid, {
      settleMs,
      timeoutMs: Math.min(timeoutMs ?? IDENTITY_SETTLE_TIMEOUT_MS, IDENTITY_SETTLE_TIMEOUT_MS),
    });
    const current = settledFrame ?? state;
    let entry = fresh ? null : screenmap.recallNearest(udid, current.layoutHash)?.entry;
    const geo = await deviceGeometry(udid, current);
    if (!entry) {
      entry = await screenmap.build(udid, {
        hash: current.hash,
        layoutHash: current.layoutHash,
        fullFrame: await fullFrameFor(udid, current),
        density: geo.density,
        screen: { width: geo.pointWidth, height: geo.pointHeight },
        persist: settled,
      });
    }
    return {
      hash: entry.structuralHash,
      tokens: entry.structuralTokens ?? [],
      keyboard: Boolean(entry.keyboard),
      layoutHash: current.layoutHash,
      settled,
      // Settled and incomplete are different states and used to render
      // identically. A screen awaiting a network call is perfectly still; a
      // person sees a spinner and knows to wait. The classifier already says
      // so, and nothing above this line was asking.
      loading: current.transition?.kind === 'loading',
      // Carried out so callers that want the elements as well as the identity
      // do not pay for a second perception pass to get them. The compact
      // screen map needs both, and reading twice was the whole cost of it.
      entry,
      state: current,
      points: { width: geo.pointWidth, height: geo.pointHeight },
    };
  };

  let identity = await read({ fresh });
  if (!confirmNovel) return { ...identity, confirmed: identity.settled };
  // Being recognised is stronger evidence than the pixel settle flag: a
  // fingerprint that matches a screen already trusted has nothing left to
  // prove, and some screens (live content, a looping animation) never report
  // settled at all. The gate exists to stop a half-drawn screen becoming a new
  // node — not to re-interrogate a known one.
  if (graph.nearestScreen(udid, identity)) return { ...identity, confirmed: true, known: true };

  // Nothing recognises this, or the pixels have not gone quiet. Either way, make
  // it prove it is the same screen twice running before it becomes a node.
  for (let i = 1; i < STRUCTURAL_SETTLE_SAMPLES; i += 1) {
    const owed = structuralSettleOwed(identity.state?.capturedAt);
    if (owed > 0) await sleep(owed);
    const again = await read({ fresh: true });
    // Two readings agree if they are the same screen — the same test identity
    // itself uses. Demanding an identical hash is a stricter question than the
    // one being asked, and a row a grid-unit wider fails it.
    const agrees = again.hash === identity.hash
      || fingerprint.similarity(again.tokens, identity.tokens) >= graph.SIMILARITY_THRESHOLD;
    if (agrees) {
      return { ...again, confirmed: true, known: Boolean(graph.nearestScreen(udid, again)) };
    }
    identity = again;
  }
  // Still moving structurally. Report the latest reading and say it is unproven,
  // so callers can decline to record an edge to a screen that never held still.
  return { ...identity, confirmed: false, known: false };
}

export { DEFAULTS, screenmap, store };
