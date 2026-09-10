/**
 * The local planner tier: a ranker, behind a flag, that may only reorder.
 *
 * **Why this exists at all, given Phase 17 was a no-go.** That phase asked a
 * local model to *choose the next element*, and the answer was that the matcher
 * already does — 37 of 40 real decisions. This is the complement and the one
 * case a string matcher structurally cannot do: the goal matches **nothing** on
 * screen, and something has to guess which container leads to it. "Change my
 * username" shares no prefix, synonym or typo distance with "Account".
 *
 * Measured on this machine, six hand-written cases: 5 of 6 top-1, 6 of 6 top-3,
 * median 564 ms warm. See `docs/BENCHMARKS.md`. Against a model round trip at
 * 10–16 s that is roughly twenty times cheaper; against the honest baseline —
 * breadth-first ordering, which needs no model — it won five of six.
 *
 * **What it is allowed to do, and it is deliberately almost nothing.** It
 * reorders a list of candidates the caller has already permitted and will try
 * in some order regardless. It cannot invent a label, cannot choose an action,
 * cannot see pixels, and never runs on a destructive label because the caller
 * filtered those out before asking (`src/vocabulary.js`). If it is wrong the
 * exploration budget simply tries the next one. That is strictly weaker
 * authority than Phase 17 proposed, which is what makes it safe to try.
 *
 * **Off unless asked.** `SIMFRAME_PLANNER=apple` turns it on; anything else,
 * or any failure at all, degrades to `null` and the caller keeps its own order.
 * `doctor` reports which. CI runs with it off.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as store from './store.js';

const run = promisify(execFile);
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'rank.swift');
const BIN = path.join(store.ROOT, 'bin', 'rank');

/** Which backend the caller asked for. Absent means no local planner. */
export function requested(options) {
  // Per call first, then the environment, for the reason in `sensorMode`: an
  // MCP server's environment is fixed when it spawns, so a tester could not
  // switch backends inside one session and a round came back with one arm of
  // its A/B unrun.
  const raw = String(options?.planner ?? process.env.SIMFRAME_PLANNER ?? '').trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'off' || raw === '0' || raw === 'false') return null;
  return raw;
}

let building = null;

export async function ensureBinary() {
  if (building) return building;
  building = (async () => {
    try {
      const src = fs.statSync(SOURCE).mtimeMs;
      const bin = fs.existsSync(BIN) ? fs.statSync(BIN).mtimeMs : 0;
      if (bin > src) return { available: true, binary: BIN };
    } catch {
      return { available: false, reason: 'the ranker source is missing from this install' };
    }
    try {
      fs.mkdirSync(path.dirname(BIN), { recursive: true });
      // `swiftc`, not `xcrun swiftc`: nothing above the platform boundary may
      // name a platform tool, and the boundary test catches it. `src/ocr.js`
      // set this precedent — a compiler is not a device tool.
      await run('swiftc', ['-O', SOURCE, '-o', BIN], { timeout: 180_000 });
      return { available: true, binary: BIN };
    } catch (err) {
      building = null; // let a later call retry once a toolchain is present
      return {
        available: false,
        reason: err.code === 'ENOENT'
          ? 'swiftc is not installed, so the local planner cannot be built (install Xcode command line tools)'
          : `could not build the local planner: ${String(err.message).split('\n')[0]}`,
      };
    }
  })();
  return building;
}

let session = null;

/** Start the helper once and keep it, because the first answer pays model load. */
async function open() {
  if (session) return session;
  const built = await ensureBinary();
  if (!built.available) return { ok: false, reason: built.reason };
  session = await new Promise((resolve) => {
    const child = spawn(built.binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    // Deliberately NOT unref'd. Unreffing the child's stdout unreferences the
    // very pipe every request waits on, so the process exited silently in the
    // middle of an await — a flow that printed nothing and returned 0. The
    // helper is closed explicitly instead, by whoever opened it.
    let buffer = '';
    const waiters = [];
    let settled = false;
    const fail = (reason) => {
      if (!settled) { settled = true; resolve({ ok: false, reason }); }
      while (waiters.length) waiters.shift()(null);
    };
    child.on('error', (err) => fail(`the local planner would not start: ${err.message}`));
    child.on('exit', () => { session = null; fail('the local planner exited'); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i = buffer.indexOf('\n');
      while (i >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        i = buffer.indexOf('\n');
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!settled) {
          settled = true;
          if (msg.ready) resolve({ ok: true, child, waiters });
          else resolve({ ok: false, reason: msg.unavailable ?? 'the local planner did not become ready' });
          continue;
        }
        const next = waiters.shift();
        if (next) next(msg);
      }
    });
  });
  return session;
}

/**
 * Reorder `options` by which is likeliest to lead to `goal`.
 *
 * @returns {Promise<string[]|null>} the caller's own order is correct when this
 *   is null, which is every failure mode: flag off, no model, a timeout, a
 *   parse problem, a paraphrasing answer. Never throws.
 */
export async function rank(goal, options, { timeoutMs = 3000, deviceOptions } = {}) {
  if (!requested(deviceOptions)) return null;
  if (!goal || !Array.isArray(options) || options.length < 2) return null;
  let live;
  try {
    live = await open();
  } catch {
    return null;
  }
  if (!live?.ok) return null;
  const answer = await new Promise((resolve) => {
    // A timed-out waiter has to be *retired*, not merely resolved. Leaving it in
    // the queue meant the next answer went to it instead of to the next asker,
    // and every call after that was off by one — which showed up as an
    // exploration run that never finished rather than as an error.
    let done = false;
    const waiter = (msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(msg);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const i = live.waiters.indexOf(waiter);
      if (i >= 0) live.waiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    live.waiters.push(waiter);
    try {
      live.child.stdin.write(`${JSON.stringify({ goal: String(goal), options })}\n`);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
  if (!answer?.order?.length) return null;
  // It often returns a subset, so its order comes first and ours fills the tail.
  // Trusting it to be exhaustive would silently drop candidates the budget was
  // going to try.
  const ranked = answer.order.filter((label) => options.includes(label));
  const seen = new Set(ranked);
  return [...ranked, ...options.filter((o) => !seen.has(o))];
}

/** For `doctor`: what the planner layer is, in one line. */
export async function status(options) {
  const want = requested(options);
  if (!want) return { planner: 'none', detail: 'not requested (SIMFRAME_PLANNER is unset)' };
  if (want !== 'apple') return { planner: 'none', detail: `no such planner backend: "${want}"` };
  const live = await open();
  if (!live?.ok) return { planner: 'none', detail: live?.reason ?? 'unavailable' };
  return { planner: 'apple', detail: 'Apple Foundation Models, on-device, ranking only' };
}

/** Let a process exit without waiting on the helper. */
export function close() {
  try { session?.child?.kill(); } catch { /* already gone */ }
  session = null;
}
