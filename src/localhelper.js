/**
 * A warm, line-oriented local helper process.
 *
 * Extracted rather than duplicated, because writing this twice would mean
 * risking the same two bugs twice — and both were subtle enough to look like
 * something else entirely.
 *
 * A timed-out request left its waiter in the queue, so every later answer went
 * to the wrong asker and the run simply never finished; it read as the model
 * being slow. And unreferencing the child's stdout unreferenced the pipe every
 * request waits on, so the process exited silently in the middle of an await
 * and printed nothing at all, returning 0.
 *
 * The helper is kept warm because the first answer in a process pays model load
 * — measured at ~880ms against ~560ms for every answer after it.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Compile a Swift source once and reuse the binary.
 *
 * `swiftc`, not `xcrun swiftc`: nothing above the platform boundary may name a
 * platform tool, and the boundary test catches it. A compiler is not a device
 * tool, which is the precedent `src/ocr.js` set.
 */
export function compiler({ source, binary, what }) {
  let building = null;
  return async function ensureBinary() {
    if (building) return building;
    building = (async () => {
      try {
        const src = fs.statSync(source).mtimeMs;
        const bin = fs.existsSync(binary) ? fs.statSync(binary).mtimeMs : 0;
        if (bin > src) return { available: true, binary };
      } catch {
        return { available: false, reason: `the ${what} source is missing from this install` };
      }
      try {
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        await run('swiftc', ['-O', source, '-o', binary], { timeout: 180_000 });
        return { available: true, binary };
      } catch (err) {
        building = null; // let a later call retry once a toolchain is present
        return {
          available: false,
          reason: err.code === 'ENOENT'
            ? `swiftc is not installed, so the ${what} cannot be built (install Xcode command line tools)`
            : `could not build the ${what}: ${String(err.message).split('\n')[0]}`,
        };
      }
    })();
    return building;
  };
}

/**
 * Open a helper and speak JSON lines to it.
 *
 * @returns {{ask: (o: object, ms: number) => Promise<object|null>, close: () => void, ok: boolean, reason?: string}}
 */
export function lineServer({ ensureBinary, what }) {
  let session = null;

  async function open() {
    if (session) return session;
    const built = await ensureBinary();
    if (!built.available) return { ok: false, reason: built.reason };
    session = await new Promise((resolve) => {
      const child = spawn(built.binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      // Deliberately NOT unref'd — see the note at the top of this file.
      let buffer = '';
      const waiters = [];
      let settled = false;
      const fail = (reason) => {
        if (!settled) { settled = true; resolve({ ok: false, reason }); }
        while (waiters.length) waiters.shift()(null);
      };
      child.on('error', (err) => fail(`the ${what} would not start: ${err.message}`));
      child.on('exit', () => { session = null; fail(`the ${what} exited`); });
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
            else resolve({ ok: false, reason: msg.unavailable ?? `the ${what} did not become ready` });
            continue;
          }
          const next = waiters.shift();
          if (next) next(msg);
        }
      });
    });
    return session;
  }

  return {
    async ask(question, timeoutMs = 3000) {
      let live;
      try {
        live = await open();
      } catch {
        return null;
      }
      if (!live?.ok) return null;
      return new Promise((resolve) => {
        // A timed-out waiter is retired, not merely resolved. Leaving it queued
        // sent the next answer to it instead of to the next asker, and every
        // call after that was off by one.
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
          live.child.stdin.write(`${JSON.stringify(question)}\n`);
        } catch {
          clearTimeout(timer);
          done = true;
          resolve(null);
        }
      });
    },
    async status() {
      const live = await open();
      return live?.ok ? { ok: true } : { ok: false, reason: live?.reason ?? 'unavailable' };
    },
    close() {
      try { session?.child?.kill(); } catch { /* already gone */ }
      session = null;
    },
  };
}
