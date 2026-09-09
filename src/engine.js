// Chooses and starts the capture engine.
//
// Two exist: `simframed`, a Swift daemon that reads the framebuffer directly,
// and `screenshot`, the loop that asks the platform boundary for one frame at a
// time. The daemon is the default on iOS because it is roughly thirty times
// faster, but the loop stays reachable — a machine without a Swift toolchain,
// or an Xcode version where a private symbol has moved, still needs to work.
//
// The loop used to be called `simctl`, after the tool it shelled out to. It no
// longer shells out to anything in particular: on Android the same loop reaches
// the emulator console and captures a frame in ~41 ms, which is not `simctl` by
// any reading. `simctl` stays accepted as an alias, because it is in shipped
// meta.json files, in documentation and in people's shell history.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as store from './store.js';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.join(HERE, '..', 'native', 'simframed');
const BINARY = path.join(PACKAGE, '.build', 'release', 'simframed');

export const ENGINES = ['simframed', 'screenshot'];

/** `simctl` was this engine's name until it ran on a second platform. */
const ENGINE_ALIASES = { simctl: 'screenshot' };

export function normalizeEngine(name) {
  return ENGINE_ALIASES[name] ?? name;
}

export function binaryPath() {
  return BINARY;
}

/** Newest mtime across the Swift sources, so a stale binary is rebuilt. */
function sourceMtime() {
  const roots = [path.join(PACKAGE, 'Sources'), path.join(PACKAGE, 'Package.swift')];
  let newest = 0;
  const walk = (p) => {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
      return;
    }
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  };
  for (const r of roots) walk(r);
  return newest;
}

export function status() {
  const haveSource = fs.existsSync(path.join(PACKAGE, 'Package.swift'));
  const haveBinary = fs.existsSync(BINARY);
  const stale = haveBinary && haveSource && fs.statSync(BINARY).mtimeMs < sourceMtime();
  return { haveSource, haveBinary, stale, binary: BINARY };
}

/**
 * Make sure the daemon binary exists and is current.
 * @returns {Promise<{ok: boolean, built: boolean, reason?: string}>}
 */
export async function ensureBuilt({ rebuild = false } = {}) {
  const state = status();
  if (!state.haveSource) {
    return { ok: false, built: false, reason: 'the simframed sources are not in this install' };
  }
  if (state.haveBinary && !state.stale && !rebuild) return { ok: true, built: false };
  try {
    // Release, because a debug build is several times slower per frame and
    // this binary's whole purpose is latency.
    await run('swift', ['build', '-c', 'release', '--package-path', PACKAGE], { timeout: 300_000 });
    return { ok: fs.existsSync(BINARY), built: true };
  } catch (err) {
    const detail = (err.stderr || err.message || '').split('\n').filter(Boolean).slice(-2).join(' ');
    return {
      ok: false,
      built: false,
      reason:
        err.code === 'ENOENT'
          ? 'swift is not installed, so the daemon cannot be built (install Xcode command line tools)'
          : `building simframed failed: ${detail}`,
    };
  }
}

/** Start the Swift daemon detached, the way the Node loop is started. */
export function spawnDaemon(udid, { maxDim, minIntervalMs, idleExitMs } = {}) {
  const args = ['run', `--udid=${udid}`];
  if (maxDim != null) args.push(`--max-dim=${maxDim}`);
  if (minIntervalMs != null) args.push(`--min-interval-ms=${minIntervalMs}`);
  if (idleExitMs != null) args.push(`--idle-exit-ms=${idleExitMs}`);
  const log = fs.openSync(path.join(store.deviceDir(udid), 'simframed.log'), 'a');
  const child = spawn(BINARY, args, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  return child;
}

/** Which engine wrote the state we are reading, according to meta.json. */
export function runningEngine(udid) {
  const meta = store.readJson(path.join(store.deviceDir(udid), 'meta.json'));
  if (!meta || !store.isProcessAlive(meta.pid)) return null;
  return meta.options?.engine === 'simframed' ? 'simframed' : 'screenshot';
}
