// The capture loop. Runs detached, one process per simulator, and keeps the
// newest frame permanently warm on disk so a reader never waits on simctl.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.js';
import { frameHash, regionSignature, signatureDiff, regionDeltas } from './analyze.js';
import * as store from './store.js';
import { isBootedSync, resize, screenshot } from './simctl.js';

// Bump whenever the shape of state.json changes, so an upgraded client retires
// a capture loop left running by an older install instead of misreading it.
export const STATE_VERSION = 2;

export const DEFAULTS = {
  fps: 4,
  idleFps: 1.5,
  idleAfterMs: 2500,
  maxDim: 700,
  ringSize: 24,
  fullKeep: 3,
  changeThreshold: 0.004,
  idleExitMs: 15 * 60_000,
};

const BOOT_CHECK_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runDaemon(device, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const udid = device.udid;
  const p = store.ensureDirs(udid);

  // Exactly one loop may own a device: two loops would both write ring/1.png
  // and prune each other's frames. meta.json is the ownership record.
  const incumbent = store.readJson(p.meta);
  if (
    incumbent?.pid &&
    incumbent.pid !== process.pid &&
    incumbent.version === STATE_VERSION &&
    store.isProcessAlive(incumbent.pid)
  ) {
    return { started: false, reason: `already captured by pid ${incumbent.pid}` };
  }

  store.writeAtomic(
    p.meta,
    JSON.stringify(
      { pid: process.pid, device, options: opts, startedAt: Date.now(), version: STATE_VERSION },
      null,
      2,
    ),
  );

  let seq = 0;
  let prevSignature = null;
  let lastChangeAt = Date.now();
  let consecutiveErrors = 0;
  let lastBootCheck = Date.now();
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const log = (msg) => {
    try {
      fs.appendFileSync(p.log, `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* logging is best effort */
    }
  };
  log(`start pid=${process.pid} device=${device.name} udid=${udid}`);

  while (running) {
    const tickStart = Date.now();

    if (store.heartbeatAge(udid) > opts.idleExitMs) {
      log('exit: no client heartbeat');
      break;
    }
    // Checking the boot state means shelling out to simctl, which costs more
    // than a capture does; every few seconds is soon enough to notice a shutdown.
    if (tickStart - lastBootCheck > BOOT_CHECK_MS) {
      lastBootCheck = tickStart;
      if (store.readJson(p.meta)?.pid !== process.pid) {
      log('exit: superseded by another capture loop');
      break;
    }
    if (!isBootedSync(udid)) {
        log('exit: device is no longer booted');
        break;
      }
    }

    try {
      const nextSeq = seq + 1;
      const fullFile = path.join(p.full, `${nextSeq}.png`);
      const ringFile = path.join(p.ring, `${nextSeq}.png`);
      await screenshot(udid, fullFile, { mask: 'ignored' });
      await resize(fullFile, ringFile, opts.maxDim);

      const bmp = decodePng(fs.readFileSync(ringFile));
      const signature = regionSignature(bmp);
      const diff = signatureDiff(signature, prevSignature);
      const deltas = regionDeltas(signature, prevSignature);
      const changed = diff > opts.changeThreshold;
      const now = Date.now();
      if (changed || prevSignature === null) lastChangeAt = now;

      seq = nextSeq;
      prevSignature = signature;
      consecutiveErrors = 0;

      fs.copyFileSync(ringFile, path.join(p.dir, 'latest.png.tmp'));
      fs.renameSync(path.join(p.dir, 'latest.png.tmp'), path.join(p.dir, 'latest.png'));

      store.writeAtomic(
        p.state,
        JSON.stringify({
          seq,
          capturedAt: now,
          captureMs: now - tickStart,
          width: bmp.width,
          height: bmp.height,
          hash: frameHash(bmp),
          diff: Number(diff.toFixed(5)),
          changed,
          stableForMs: now - lastChangeAt,
          regions: deltas.map((d) => Number(d.toFixed(4))),
          fullFile,
          ringFile,
          device,
        }),
      );

      store.pruneDir(p.ring, opts.ringSize);
      store.pruneDir(p.full, opts.fullKeep);
    } catch (err) {
      consecutiveErrors++;
      log(`capture error (${consecutiveErrors}): ${err.message}`);
      if (consecutiveErrors >= 10) {
        log('exit: too many consecutive capture errors');
        break;
      }
      await sleep(Math.min(5000, 250 * consecutiveErrors));
      continue;
    }

    // Back off while the screen sits still, and snap back the moment it moves.
    const idle = Date.now() - lastChangeAt > opts.idleAfterMs;
    const interval = 1000 / (idle ? opts.idleFps : opts.fps);
    const wait = interval - (Date.now() - tickStart);
    if (wait > 0) await sleep(wait);
  }

  log('stopped');
  const outcome = { started: true };
  try {
    // A replacement loop may already have registered itself while this one was
    // winding down; only deregister if meta.json still points at us.
    const meta = store.readJson(p.meta);
    if (meta?.pid === process.pid) {
      store.writeAtomic(p.meta, JSON.stringify({ ...meta, pid: null, stoppedAt: Date.now() }, null, 2));
    }
  } catch {
    /* nothing useful to do on the way out */
  }
  return outcome;
}
