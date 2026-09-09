// The capture loop. Runs detached, one process per simulator, and keeps the
// newest frame permanently warm on disk so a reader never waits on simctl.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, scaleBitmap } from './png.js';
import {
  frameHash,
  layoutHash,
  regionSignature,
  signatureDiff,
  regionDeltas,
  signatureToHex,
} from './analyze.js';
import * as store from './store.js';
import { isBootedSync, resize, screenshot } from './platform/index.js';

// Bump whenever the shape of state.json changes, so an upgraded client retires
// a capture loop left running by an older install instead of misreading it.
// MUST equal SimframeCore.FrameStore.stateVersion in the Swift daemon. When
// these drifted — Node on 5, Swift writing 6 — every single CLI command judged
// the live daemon stale and spawned a replacement: 993 "superseded by another
// capture loop" lines in one log. Capture still worked, so nothing looked
// wrong, but each command lost the previous daemon's history, which silently
// broke `recall`, `state --since`, `wait --since` and every timing measured
// through a flow. A unit test asserts these two constants match.
export const STATE_VERSION = 6;

/**
 * How many failed captures in a row mean this loop is wedged rather than
 * unlucky.
 *
 * Four, against the ten that make it give up: far enough in that a single
 * hiccup does not raise an alarm, early enough that a reader learns about it
 * while the loop is still trying. The Swift daemon reaches the same conclusion
 * differently — it counts re-resolves of the display port, because there a
 * successful re-resolve resets the failure count and hides the loop.
 */
export const STALLED_AFTER_ERRORS = 4;

export const DEFAULTS = {
  fps: 4,
  idleFps: 1.5,
  idleAfterMs: 2500,
  maxDim: 700,
  // Frame memory: every frame for the last few seconds, thinned to roughly
  // 2fps further back. Fine detail where transitions live, cheap recall beyond.
  retainMs: 60_000,
  fineMs: 6_000,
  keyframeMs: 450,
  // Frames older than fineMs are re-encoded at half size: still legible enough
  // to tell which screen was showing, at roughly a quarter of the bytes.
  recallScale: 0.5,
  maxRingBytes: 12 << 20,
  ringSize: 400,
  historySize: 400,
  historyMs: 90_000,
  fullKeep: 8,
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
  /** Recent frames, so a caller can diff against whatever it last saw rather
   *  than only against the frame that happened to precede this one. */
  let history = [];
  /** seq + timestamp for every frame still on disk, so retention can be thinned by age. */
  let ringIndex = [];
  let lastChangeAt = Date.now();
  let consecutiveErrors = 0;
  let stalledSince = null;
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
      const prevWasNull = prevSignature === null;
      const diff = signatureDiff(signature, prevSignature);
      const deltas = regionDeltas(signature, prevSignature);
      const changed = diff > opts.changeThreshold;
      const now = Date.now();
      if (changed || prevSignature === null) lastChangeAt = now;

      seq = nextSeq;
      prevSignature = signature;
      if (consecutiveErrors >= STALLED_AFTER_ERRORS) {
        log('capture recovered on its own');
        store.writeCaptureHealth(udid, null);
      }
      consecutiveErrors = 0;

      const hash = frameHash(bmp);
      const layout = layoutHash(bmp);
      history.push({
        seq,
        at: now,
        hash,
        sig: signatureToHex(signature),
        diff: prevWasNull ? 0 : Number(diff.toFixed(5)),
      });
      const historyCutoff = now - opts.historyMs;
      history = history.filter((h) => h.at >= historyCutoff).slice(-opts.historySize);

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
          hash,
          layoutHash: layout,
          diff: prevWasNull ? null : Number(diff.toFixed(5)),
          changed: prevWasNull ? false : changed,
          firstFrame: prevWasNull,
          stableForMs: now - lastChangeAt,
          regions: prevWasNull ? deltas.map(() => 0) : deltas.map((d) => Number(d.toFixed(4))),
          // Absolute instant of the last detected change: lets a caller reason
          // about baselines older than the history window.
          lastChangeAt,
          history,
          ring: ringIndex,
          fullFile,
          ringFile,
          device,
        }),
      );

      ringIndex.push({ seq, at: now });
      ringIndex = thinRing(ringIndex, now, opts, (dropped) => {
        try {
          fs.unlinkSync(path.join(p.ring, `${dropped}.png`));
        } catch {
          /* already gone */
        }
      });
      shrinkAgedFrames(p.ring, ringIndex, now, opts, log);
      enforceByteBudget(p.ring, ringIndex, opts);
      store.pruneDir(p.ring, opts.ringSize);
      store.pruneDir(p.full, opts.fullKeep);
    } catch (err) {
      consecutiveErrors++;
      log(`capture error (${consecutiveErrors}): ${err.message}`);
      // Say that capture is wedged rather than merely slow, and do nothing
      // about it: the cure is a device restart, and that is the user's to make.
      // Published rather than only logged, because a reader of `state` sees the
      // last healthy frame with nothing in it to say the device stopped
      // answering — the same frames a merely idle screen produces.
      if (consecutiveErrors >= STALLED_AFTER_ERRORS) {
        stalledSince ??= Date.now();
        store.writeCaptureHealth(udid, {
          stalled: true,
          since: stalledSince,
          at: Date.now(),
          consecutiveFailures: consecutiveErrors,
          reattaches: 0,
          reason: err.message,
        });
      }
      if (consecutiveErrors >= 10) {
        // Left published on purpose. The file is how a reader learns why this
        // loop is not running any more.
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

/**
 * Decide which buffered frames to keep. Everything inside `fineMs` survives, so
 * a transition can be replayed frame by frame; beyond that only one frame per
 * `keyframeMs` is kept, out to `retainMs`. Calls `drop` for each discarded seq
 * and returns the retained index.
 */
export function thinRing(index, now, opts, drop = () => {}) {
  const kept = [];
  let lastKeptAt = null;
  for (let i = index.length - 1; i >= 0; i--) {
    const frame = index[i];
    const age = now - frame.at;
    if (age > opts.retainMs) {
      drop(frame.seq);
      continue;
    }
    if (age <= opts.fineMs || lastKeptAt === null || lastKeptAt - frame.at >= opts.keyframeMs) {
      kept.push(frame);
      lastKeptAt = frame.at;
    } else {
      drop(frame.seq);
    }
  }
  return kept.reverse();
}

/**
 * Re-encode frames that have aged out of the fine window at a smaller size.
 * Done in-process with the bundled PNG codec, so recall stays cheap on disk
 * without adding a dependency or another process spawn per frame.
 */
function shrinkAgedFrames(dir, index, now, opts, log) {
  for (const frame of index) {
    if (frame.small || now - frame.at <= opts.fineMs) continue;
    const file = path.join(dir, `${frame.seq}.png`);
    try {
      const bmp = decodePng(fs.readFileSync(file));
      const small = scaleBitmap(
        bmp,
        Math.max(1, Math.round(bmp.width * opts.recallScale)),
        Math.max(1, Math.round(bmp.height * opts.recallScale)),
      );
      store.writeAtomic(file, encodePng(small));
      frame.small = true;
    } catch (err) {
      // A frame we cannot shrink is still a frame we can serve.
      frame.small = true;
      log?.(`shrink failed for #${frame.seq}: ${err.message}`);
    }
  }
}

/** Last-resort cap so a long session cannot grow the buffer without bound. */
function enforceByteBudget(dir, index, opts) {
  let total = 0;
  const sizes = index.map((frame) => {
    let size = 0;
    try {
      size = fs.statSync(path.join(dir, `${frame.seq}.png`)).size;
    } catch {
      /* counted as zero */
    }
    total += size;
    return size;
  });
  for (let i = 0; i < index.length && total > opts.maxRingBytes; i++) {
    try {
      fs.unlinkSync(path.join(dir, `${index[i].seq}.png`));
      total -= sizes[i];
      index[i].dropped = true;
    } catch {
      /* already gone */
    }
  }
  for (let i = index.length - 1; i >= 0; i--) if (index[i].dropped) index.splice(i, 1);
}
