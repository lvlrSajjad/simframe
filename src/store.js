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
    lastInput: path.join(dir, 'last-input'),
    lastAction: path.join(dir, 'last-action'),
  };
}

/** What the capture loop last said about its own health, or null if it has no complaint. */
/**
 * When input was last delivered to this device.
 *
 * Written by every input path and read by `liveness`, which needs it to catch
 * the one wedge shape nothing else can see: a capture loop that is alive,
 * incrementing its frame counter, and re-reading a **dead surface**. Field
 * report, 0.12.2: `age=268ms` next to `stable=159753ms` while three screen
 * transitions had just happened, and no warning fired because every signal we
 * had was green. A screen that has not moved since before we last touched it,
 * over and over, is a contradiction the daemon can notice locally.
 */
const INPUT_MEMORY = 8;

export function noteInput(udid, at = Date.now()) {
  try {
    writeAtomic(paths(udid).lastInput, [...inputTimes(udid), at].slice(-INPUT_MEMORY).join(','));
  } catch {
    /* a timestamp nothing depends on for correctness must not fail an action */
  }
  noteAction(udid, at);
}

/**
 * When we last did something that ought to change the screen.
 *
 * Deliberately separate from the input log above, which answers a different
 * question — "have several *gestures* landed with no pixel moving" — and would
 * be wrong to answer it about a launch, since a launch that paints nothing is
 * not evidence of a dead digitizer.
 *
 * This one exists so a settle can tell its own stillness from the *previous*
 * screen's. Measured on 2026-09-18: 283ms after a Settings launch the state
 * read `settled: true` with `stableForMs: 4427` and **zero elements** — 4.4
 * seconds of quiet that began before the launch was issued. 408ms after a
 * `tap General`, `stableForMs: 7753` and the 23 elements of the screen being
 * left. In both, the settle detector was honestly reporting how long the screen
 * we had already abandoned had been sitting still.
 *
 * Every gesture writes it (via `noteInput`), and so does every launch and
 * `openUrl`, because those change the screen without touching the digitizer.
 */
export function noteAction(udid, at = Date.now()) {
  try {
    writeAtomic(paths(udid).lastAction, String(at));
  } catch {
    /* as above: a timestamp may not fail the action it describes */
  }
}

/** When the last screen-changing action was issued, or null if none is recorded. */
export function lastActionAt(udid) {
  try {
    const n = Number(fs.readFileSync(paths(udid).lastAction, 'utf8').trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * The last few input timestamps, oldest first.
 *
 * A list rather than a single timestamp, and that is the whole correction.
 * The first version kept only the latest, so the only question it could ask was
 * "has the screen been still for a long time?" — which needed a duration
 * threshold, and the threshold is what defeated it. A field report caught a
 * three-hour-stale frame on a screen that had been still for **8.2 seconds**,
 * under a 20-second gate, so the check could not fire on the case it was
 * written for.
 *
 * What actually says "dead surface" is not duration. It is **several gestures
 * delivered with no pixel moving at all** — one tap that changes nothing is
 * ordinary, and three in a row are not.
 */
export function inputTimes(udid) {
  try {
    return fs.readFileSync(paths(udid).lastInput, 'utf8')
      .split(',')
      .map(Number)
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

export function lastInputAt(udid) {
  const times = inputTimes(udid);
  return times.length ? times[times.length - 1] : null;
}

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
