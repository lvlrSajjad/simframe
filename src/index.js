// Client API shared by the CLI and the MCP server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, STATE_VERSION } from './daemon.js';
import { decodePng, encodePng, scaleBitmap } from './png.js';
import {
  REGION_COLS,
  hexToSignature,
  regionDeltas,
  regionMap,
  signatureDiff,
} from './analyze.js';
import * as input from './input.js';
import * as screenmap from './screenmap.js';
import { resolveDevice, resize, screenshot } from './simctl.js';
import * as store from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DETAIL_LEVELS = { low: 420, normal: 700, high: 1100, full: 0 };

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
  const density = 3;
  return {
    density,
    pointWidth: Math.round((state.width * (state.nativeScale ?? 1)) / 1) || 402,
    pointHeight: Math.round((state.height * (state.nativeScale ?? 1)) / 1) || 874,
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
        spawnDaemon(device.udid, options);
      } finally {
        // Hold the lock briefly so a burst of callers does not double-spawn.
        setTimeout(() => releaseSpawnLock(p.lock), 1500).unref?.();
      }
    }
  }

  const deadline = Date.now() + (options.readyTimeoutMs ?? 8000);
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

function spawnDaemon(udid, options) {
  const args = [CLI, 'daemon', udid];
  for (const key of ['fps', 'maxDim', 'ringSize', 'idleExitMs']) {
    if (options[key] != null) args.push(`--${key}=${options[key]}`);
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
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

/** Below this a "change" is a clock digit or a caret, not a new screen. */
export const MINOR_CHANGE = 0.004;
export const MAJOR_CHANGE = 0.03;

export function changeLevel(diff) {
  if (diff > MAJOR_CHANGE) return 'major';
  if (diff > MINOR_CHANGE) return 'minor';
  return 'none';
}

export function liveness(udid, state) {
  const ageMs = Date.now() - state.capturedAt;
  const { running } = daemonStatus(udid);
  if (!running) {
    return { ok: false, ageMs, note: 'the capture loop has died; the frame you are looking at is the last one it wrote' };
  }
  if (ageMs > STALE_FRAME_MS) {
    return { ok: false, ageMs, note: `capture loop is stalled: newest frame is ${ageMs}ms old` };
  }
  return { ok: true, ageMs, note: null };
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

export async function getState(deviceQuery, { since, options } = {}) {
  const { device, state } = await ensureDaemon(deviceQuery, options);
  return {
    device,
    state,
    ageMs: Date.now() - state.capturedAt,
    map: regionMap(state.regions || [], REGION_COLS),
    since: compareToBaseline(state, resolveBaseline(state, since)),
    live: liveness(device.udid, state),
  };
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
  { mode = 'settle', since, stableMs = 600, timeoutMs = 8000, baselineHash, options } = {},
) {
  const { device, state: first } = await ensureDaemon(deviceQuery, options);
  const p = store.paths(device.udid);
  const requested = since ?? baselineHash;
  const resolved = resolveBaseline(first, requested);
  const baselineHashValue =
    resolved?.kind === 'history' ? resolved.entry.hash : (requested ?? first.hash);
  const baselineResolved = resolved?.kind === 'history' || requested == null;

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const startSeq = first.seq;
  let last = first;
  let sawChange = mode === 'stable' || first.hash !== baselineHashValue;
  const changedAtStart = sawChange && mode !== 'stable';

  const done = (satisfied, extra = {}) => ({
    device,
    state: last,
    satisfied,
    mode,
    sawChange,
    changedBeforeWait: changedAtStart,
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

      if (!sawChange && state.hash !== baselineHashValue) sawChange = true;

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
export async function locate(deviceQuery, query, { index, refresh = false, useAx = true, useOcr = true, options } = {}) {
  const { device, state } = await ensureDaemon(deviceQuery, options);
  const udid = device.udid;
  let entry = null;
  let from = 'memory';
  let distance = 0;

  if (!refresh) {
    const near = screenmap.recallNearest(udid, state.layoutHash);
    if (near) {
      entry = near.entry;
      distance = near.distance;
    }
  }

  if (!entry) {
    const geo = await deviceGeometry(udid, state);
    entry = await screenmap.build(udid, {
      hash: state.hash,
      layoutHash: state.layoutHash,
      fullFrame: await fullFrameFor(udid, state),
      density: geo.density,
      screen: { width: geo.pointWidth, height: geo.pointHeight },
      useAx,
      useOcr,
    });
    from = 'built';
  }

  const candidates = screenmap.rank(entry, query);
  if (candidates.length > 1 && index == null) {
    const top = candidates[0];
    const second = candidates[1];
    const decisive = screenmap.isInteractive(top) && !screenmap.isInteractive(second);
    if (!decisive) {
      const list = candidates
        .slice(0, 6)
        .map((t, i) => `[${i}] "${t.label}" (${t.x},${t.y}) ${t.type}/${t.source}`)
        .join(', ');
      throw new Error(
        `"${query}" matches ${candidates.length} things on this screen — pass index to choose: ${list}`,
      );
    }
  }
  const target = index != null ? candidates[index] : candidates[0];
  if (!target) {
    const sample = entry.targets
      .filter((t) => t.label)
      .slice(0, 12)
      .map((t) => t.label)
      .join(', ');
    throw new Error(
      `"${query}" is not on this screen. Visible: ${sample || '(nothing readable)'}`,
    );
  }
  return { device, state, entry, target, from, distance, screens: screenmap.stats(udid).screens };
}

export { DEFAULTS, screenmap, store };
