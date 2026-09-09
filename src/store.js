// On-disk layout for a device's frame cache. Files are the whole IPC mechanism:
// the daemon renames completed frames into place, readers just stat and read.
// A rename is atomic, so a reader can never observe a half-written frame.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A directory under ROOT is a device only if it is named like a UDID.
 *
 * `simframe status` listed five phantom `? ` rows once, which were test
 * fixtures. Anything that is not a UDID is not a device, whoever wrote it.
 */
export const isUdid = (name) => /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(name);

export const ROOT = process.env.SIMFRAME_HOME || path.join(os.homedir(), '.simframe');

export function deviceDir(udid) {
  return path.join(ROOT, udid);
}

export function paths(udid) {
  const dir = deviceDir(udid);
  return {
    dir,
    ring: path.join(dir, 'ring'),
    full: path.join(dir, 'full'),
    state: path.join(dir, 'state.json'),
    meta: path.join(dir, 'meta.json'),
    heartbeat: path.join(dir, 'heartbeat'),
    log: path.join(dir, 'daemon.log'),
    lock: path.join(dir, 'daemon.lock'),
    // Written by whichever capture loop is running, and only when capture is
    // wedged. It cannot ride in state.json: that is written when a frame is
    // recorded, and a stall is the absence of frames.
    captureHealth: path.join(dir, 'capture-health.json'),
  };
}

/** What the capture loop last said about its own health, or null if it has no complaint. */
export function captureHealth(udid) {
  return readJson(paths(udid).captureHealth);
}

/**
 * Publish a complaint, or clear it with `null`.
 *
 * The directory is created rather than assumed. A capture loop has always made
 * it already, so the first version of this left it out and swallowed the
 * failure — which meant the write silently did nothing for every other caller,
 * and the test that caught it was the first thing to ask.
 */
export function writeCaptureHealth(udid, health) {
  const p = paths(udid);
  try {
    if (health) {
      fs.mkdirSync(p.dir, { recursive: true });
      writeAtomic(p.captureHealth, JSON.stringify(health));
    } else {
      fs.rmSync(p.captureHealth, { force: true });
    }
  } catch {
    // Never let bookkeeping stop capture. Anything that reaches here has
    // already failed to make a directory, which capture itself will report.
  }
}

export function ensureDirs(udid) {
  const p = paths(udid);
  fs.mkdirSync(p.ring, { recursive: true });
  fs.mkdirSync(p.full, { recursive: true });
  return p;
}

export function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function touchHeartbeat(udid) {
  const p = paths(udid);
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    writeAtomic(p.heartbeat, String(Date.now()));
  } catch {
    /* a missing heartbeat only costs the daemon an earlier idle exit */
  }
}

export function heartbeatAge(udid) {
  const raw = readJson(paths(udid).heartbeat);
  if (typeof raw === 'number') return Date.now() - raw;
  try {
    return Date.now() - fs.statSync(paths(udid).heartbeat).mtimeMs;
  } catch {
    return Infinity;
  }
}

export function pruneDir(dir, keep) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.png'));
  } catch {
    return;
  }
  names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* another process may have pruned it already */
    }
  }
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
