// On-disk layout for a device's frame cache. Files are the whole IPC mechanism:
// the daemon renames completed frames into place, readers just stat and read.
// A rename is atomic, so a reader can never observe a half-written frame.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  };
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
