// Client API shared by the CLI and the MCP server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, STATE_VERSION } from './daemon.js';
import { decodePng, encodePng, scaleBitmap } from './png.js';
import { REGION_COLS, regionMap } from './analyze.js';
import { resolveDevice, resize } from './simctl.js';
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

export function stopDaemon(udid) {
  const { pid, running } = daemonStatus(udid);
  if (!running) return false;
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

export async function getState(deviceQuery, { options } = {}) {
  const { device, state } = await ensureDaemon(deviceQuery, options);
  return {
    device,
    state,
    ageMs: Date.now() - state.capturedAt,
    map: regionMap(state.regions || [], REGION_COLS),
  };
}

/**
 * Wait for the screen to settle (`mode: 'stable'`) or to move away from what it
 * shows right now (`mode: 'change'`). Removes the screenshot-retry loop.
 */
export async function waitFor(
  deviceQuery,
  { mode = 'stable', stableMs = 600, timeoutMs = 8000, baselineHash, options } = {},
) {
  const { device, state: first } = await ensureDaemon(deviceQuery, options);
  const p = store.paths(device.udid);
  const baseline = baselineHash || first.hash;
  const deadline = Date.now() + timeoutMs;
  let last = first;

  while (Date.now() < deadline) {
    const state = store.readJson(p.state);
    if (state) {
      last = state;
      if (mode === 'change') {
        if (state.hash !== baseline) return { device, state, satisfied: true, mode, waitedMs: timeoutMs - (deadline - Date.now()) };
      } else if (state.stableForMs >= stableMs) {
        return { device, state, satisfied: true, mode, waitedMs: timeoutMs - (deadline - Date.now()) };
      }
    }
    await sleep(60);
  }
  return { device, state: last, satisfied: false, mode, waitedMs: timeoutMs };
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

  entries = entries.map((e) => ({ ...e, mtimeMs: safeMtime(e.file) })).filter((e) => e.mtimeMs);
  if (spanMs) {
    const cutoff = Date.now() - spanMs;
    const within = entries.filter((e) => e.mtimeMs >= cutoff);
    if (within.length) entries = within;
  }
  entries = entries.slice(-Math.max(1, count));
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

function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export { DEFAULTS, store };
