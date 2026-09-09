// The Android backend: everything that shells out to the Android SDK, plus the
// emulator's own console socket where that is faster than adb.
//
// Nothing outside src/platform/ may import this file. Callers go through
// src/platform/index.js — see the note there about why every function here is
// module-private and reachable only through the `platform` object at the bottom.
//
// Measured on this machine (M-series, Android 16 / API 36, Small_Phone_API_36,
// 720x1280 @320dpi), medians of 5-7 runs — the numbers that shaped the choices
// below, and the reason two of them are not the obvious command:
//
//   emulator console `screenrecord screenshot <dir>`     20 ms, written host-side
//   adb exec-out screencap -p                           113 ms, 9 KB over adb
//   adb exec-out screencap (raw RGBA, 3.7 MB)           218 ms — the transfer, not the encode
//   adb shell getprop x4 in one hop                      28 ms
//   adb shell dumpsys package <pkg>                     130 ms
//   uiautomator dump                                  2,012 ms  ← see docs/DEFERRED.md
//
// The console path wins because the emulator writes the PNG to the host
// filesystem itself: there is no device-to-host transfer at all. adb screencap
// stays as the fallback for the case where the console is unreachable.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Same reasoning as the iOS backend: a listing costs enough to dominate a warm
// read, so the parsed list is cached for a few seconds.
const DEVICE_CACHE_MS = 4000;
let deviceCache = { at: 0, devices: null, inflight: null };

let adbCache = null;

/**
 * Where adb is.
 *
 * PATH first, because a developer who put it there meant it. Then the two
 * environment variables Google has used, then the default install location on
 * macOS. Resolved once: this is called on every device operation.
 */
function adbPath() {
  if (adbCache) return adbCache;
  const candidates = [];
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Library/Android/sdk')];
  try {
    candidates.push(execFileSync('command', ['-v', 'adb'], { encoding: 'utf8', shell: true }).trim());
  } catch {
    /* not on PATH; the SDK locations below are the usual case */
  }
  for (const root of roots) if (root) candidates.push(path.join(root, 'platform-tools', 'adb'));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      adbCache = candidate;
      return adbCache;
    }
  }
  throw new Error(
    'adb not found — install Android platform-tools, or set ANDROID_HOME to your SDK ' +
      '(looked on PATH and in platform-tools/ under ANDROID_HOME, ANDROID_SDK_ROOT and ~/Library/Android/sdk)',
  );
}

/** One adb invocation. `serial` is null for commands that are not about a device. */
async function adb(serial, args, opts = {}) {
  const argv = serial ? ['-s', serial, ...args] : args;
  return run(adbPath(), argv, { timeout: 20_000, maxBuffer: 8 << 20, ...opts });
}

/** adb's own message, which is in stderr, rather than execFile's "Command failed". */
function detailOf(err) {
  const stderr = (err.stderr || '').trim().split('\n').filter(Boolean).pop();
  return stderr || err.message;
}

/** @returns {Promise<Array<{udid: string, name: string, runtime: string, state: string}>>} */
async function listDevices({ maxAgeMs = DEVICE_CACHE_MS } = {}) {
  if (deviceCache.devices && Date.now() - deviceCache.at <= maxAgeMs) return deviceCache.devices;
  if (deviceCache.inflight) return deviceCache.inflight;
  deviceCache.inflight = fetchDevices()
    .then((devices) => {
      deviceCache = { at: Date.now(), devices, inflight: null };
      return devices;
    })
    .catch((err) => {
      deviceCache.inflight = null;
      throw err;
    });
  return deviceCache.inflight;
}

async function fetchDevices() {
  let stdout = '';
  try {
    ({ stdout } = await adb(null, ['devices', '-l']));
  } catch (err) {
    // No adb, or no adb server: no Android devices, which is not an error on a
    // machine that only has simulators. A missing toolchain is doctor's business
    // (see `toolchain` below), not something that should break `simframe devices`.
    if (/adb not found/.test(err.message)) return [];
    throw new Error(`adb devices failed: ${detailOf(err)}`);
  }
  const serials = [];
  for (const line of stdout.split('\n').slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state) serials.push({ serial, adbState: state });
  }
  const out = [];
  for (const { serial, adbState } of serials) {
    // Every property in one hop. The iOS a11y read taught this the expensive
    // way: eight attributes in one call instead of eight calls was 112 hops
    // down to 14, and the same arithmetic applies to a device shell.
    let props = [];
    if (adbState === 'device') {
      try {
        const { stdout: raw } = await adb(serial, [
          'shell',
          'getprop ro.boot.qemu.avd_name; getprop ro.product.model; ' +
            'getprop ro.build.version.release; getprop ro.build.version.sdk; getprop sys.boot_completed',
        ]);
        props = raw.replace(/\r/g, '').split('\n');
      } catch {
        /* the device answered `adb devices` and not a shell: treat it as offline */
      }
    }
    const [avdName, model, release, sdk, bootCompleted] = props;
    out.push({
      udid: serial,
      name: avdName || model || serial,
      runtime: release ? `Android ${release} (API ${sdk})` : 'Android',
      // A device that is present but has not finished booting is not one a flow
      // may be pointed at, and `Booting` says which of the two it is rather
      // than flattening both to "not booted".
      state: adbState !== 'device' ? 'Shutdown' : bootCompleted?.trim() === '1' ? 'Booted' : 'Booting',
    });
  }
  return out;
}

async function bootedDevices(opts) {
  return (await listDevices(opts)).filter((d) => d.state === 'Booted');
}

/** An AVD name is `Small_Phone_API_36`; nobody wants to type the underscores. */
const loose = (s) => String(s ?? '').toLowerCase().replace(/[\s_]+/g, ' ').trim();

/**
 * Resolve a user-supplied device string (serial, AVD name, or substring) to one
 * booted device. Same shape as the iOS backend, including the marked ambiguity
 * error the seam relies on to refuse rather than guess.
 */
async function resolveDevice(query, opts) {
  const all = await listDevices(opts);
  const booted = all.filter((d) => d.state === 'Booted');
  if (!query) {
    if (booted.length === 0) {
      const booting = all.filter((d) => d.state === 'Booting');
      throw new Error(
        booting.length
          ? `no booted emulator yet — ${booting.map((d) => d.name).join(', ')} is still starting`
          : 'no booted emulator (start one with `emulator -avd <name>`)',
      );
    }
    return booted[0];
  }
  const q = loose(query);
  for (const pool of [booted, all]) {
    const exact = pool.find((d) => loose(d.udid) === q || loose(d.name) === q);
    if (exact) return exact;
    const partial = pool.filter((d) => loose(d.name).includes(q));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw Object.assign(
        new Error(`"${query}" matches ${partial.length} devices: ${partial.map((d) => d.name).join(', ')}`),
        { ambiguous: true },
      );
    }
  }
  throw new Error(`no emulator matches "${query}"; booted: ${booted.map((d) => d.name).join(', ') || 'none'}`);
}

function isBootedSync(udid) {
  try {
    const state = execFileSync(adbPath(), ['-s', udid, 'get-state'], { encoding: 'utf8', timeout: 10_000 }).trim();
    return state === 'device';
  } catch {
    /* same convention as the iOS backend: an unreadable state is not a death */
    return true;
  }
}

/**
 * Does this backend own that device id, judged without touching the device?
 *
 * Only emulators, and only the serial the emulator itself uses:
 * `emulator-<console port>`. Deliberately narrow — physical devices are a
 * non-goal, and a backend that claimed every non-UUID string would swallow a
 * mistyped simulator udid and report it as a missing emulator.
 */
function ownsUdid(udid) {
  return /^emulator-\d+$/.test(String(udid ?? ''));
}

// --- the emulator console --------------------------------------------------
//
// `emulator-5554` means console port 5554. The token in
// ~/.emulator_console_auth_token is what the emulator wrote there for whoever
// can read the file; it is not a secret of ours to handle, and it never leaves
// this process.

function consolePort(udid) {
  const port = /^emulator-(\d+)$/.exec(String(udid))?.[1];
  return port ? Number(port) : null;
}

function consoleToken() {
  return fs.readFileSync(path.join(os.homedir(), '.emulator_console_auth_token'), 'utf8').trim();
}

/**
 * The emulator console, held open per device.
 *
 * The console is a line protocol: every command is answered with `OK` or `KO`,
 * and the greeting is itself terminated by an `OK`, so the handshake is two
 * responses — the greeting, then the answer to `auth` — after which it is
 * strictly request/response.
 *
 * Held open rather than opened per command, for two reasons. The capture loop
 * asks for a frame several times a second, and a connect plus an auth is not
 * free. And a
 * gesture is not one command — a tap is a down, a hold and an up, a swipe is a
 * run of moves with time between them — and paying for a handshake between the
 * down and the up would make the timing a fiction.
 *
 * Commands are serialised on the session. Two callers sharing one socket
 * interleaving their writes would each read the other's `OK`.
 */
class ConsoleSession {
  constructor(sock, port) {
    this.sock = sock;
    this.port = port;
    this.buf = '';
    this.waiting = null;
    this.tail = Promise.resolve();
    this.dead = null;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      this.buf += chunk;
      const done = /(OK|KO)([^\n]*)\r?\n/.exec(this.buf);
      if (!done || !this.waiting) return;
      const text = this.buf;
      this.buf = '';
      const settle = this.waiting;
      this.waiting = null;
      if (done[1] === 'KO') settle.reject(new Error(`emulator console refused: ${done[2].trim() || 'KO'}`));
      else settle.resolve(text);
    });
    const die = (err) => {
      this.dead = err ?? new Error(`emulator console on ${port} closed`);
      // A close with a command outstanding is that command failing, not it
      // succeeding. Anything else is nobody's error to hear about: a session
      // closed on purpose must not surface as an unhandled rejection, which is
      // exactly what a stored `close` promise did.
      if (this.waiting) {
        const settle = this.waiting;
        this.waiting = null;
        settle.reject(this.dead);
      }
    };
    sock.on('error', die);
    sock.on('close', () => die());
  }

  get usable() {
    return !this.dead && !this.sock.destroyed;
  }

  /** Wait for one OK/KO. Used for the greeting, and by `send`. */
  answer({ timeoutMs = 10_000 } = {}) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        this.sock.destroy();
        reject(new Error(`emulator console on ${this.port} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiting = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  /** One command, queued behind anything already in flight on this socket. */
  send(line, opts) {
    const mine = this.tail.then(async () => {
      if (!this.usable) throw this.dead ?? new Error('emulator console is closed');
      const answer = this.answer(opts);
      this.sock.write(`${line}\n`);
      return answer;
    });
    // The queue must survive a failed command, or one refusal wedges the
    // session for every caller behind it.
    this.tail = mine.then(() => undefined, () => undefined);
    return mine;
  }

  close() {
    try {
      this.sock.write('quit\n');
    } catch {
      /* already gone */
    }
    this.sock.destroy();
  }
}

const sessions = new Map();

/** The open session for a device, reconnected if the last one went away. */
async function sessionFor(udid, { timeoutMs = 10_000 } = {}) {
  const existing = sessions.get(udid);
  if (existing) {
    const session = await existing;
    if (session.usable) return session;
    sessions.delete(udid);
  }
  const opening = (async () => {
    const port = consolePort(udid);
    if (!port) throw new Error(`${udid} is not an emulator serial`);
    const session = new ConsoleSession(net.connect(port, '127.0.0.1'), port);
    await session.answer({ timeoutMs });
    await session.send(`auth ${consoleToken()}`, { timeoutMs });
    return session;
  })();
  sessions.set(udid, opening);
  try {
    return await opening;
  } catch (err) {
    sessions.delete(udid);
    throw err;
  }
}

/** Run commands on the device's console, in order. */
async function consoleScript(udid, lines, { timeoutMs = 10_000 } = {}) {
  const session = await sessionFor(udid, { timeoutMs });
  const out = [];
  for (const line of lines) out.push(await session.send(line, { timeoutMs }));
  return out.join('');
}

// --- the emulator's gRPC endpoint -------------------------------------------
//
// Reached with nothing but `node:http2`, because a unary gRPC call is a plain
// HTTP/2 POST: a five-byte frame header in front of the message, `grpc-status`
// in the trailers, and that is the whole protocol for this purpose. No
// dependency, which is what makes it usable here at all.
//
// It exists for one thing so far: the clipboard. `cmd clipboard` does not exist
// on API 36 and `service call clipboard` depends on transaction numbers that
// move between platform versions, so this was written up as "no path to the
// Android clipboard" until the emulator's own service definitions turned out to
// declare `setClipboard`, `getClipboard` and `streamClipboard`. `ClipData` is
// the simplest message protobuf can express — one string field — so the encoder
// below is three lines rather than a library.

/** Where a running emulator writes its own port and token. */
function runningAvdDirs() {
  return [
    path.join(os.homedir(), 'Library/Caches/TemporaryItems/avd/running'),
    process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'avd/running') : null,
    path.join(os.tmpdir(), `android-${os.userInfo().username}`, 'avd/running'),
  ].filter(Boolean);
}

const endpointCache = new Map();

/**
 * The gRPC port and token for a device.
 *
 * The emulator writes both into a per-process ini alongside the AVD it is
 * running, which is how this avoids hardcoding 8554 and works with a second
 * emulator on another port. The token is a local credential the emulator wrote
 * for whoever can read the file — the same status as the console auth token —
 * and it is read at call time, never logged and never stored anywhere else.
 */
function grpcEndpoint(udid) {
  const cached = endpointCache.get(udid);
  if (cached && Date.now() - cached.at < DEVICE_CACHE_MS) return cached.endpoint;
  const serial = consolePort(udid);
  if (!serial) throw new Error(`${udid} is not an emulator serial`);
  for (const dir of runningAvdDirs()) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((f) => /^pid_\d+\.ini$/.test(f));
    } catch {
      continue;
    }
    for (const name of names) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      const field = (key) => new RegExp(`^${key.replace('.', '\\.')}=(.*)$`, 'm').exec(text)?.[1]?.trim();
      if (field('port.serial') !== String(serial)) continue;
      const port = Number(field('grpc.port'));
      const token = field('grpc.token');
      if (!port) continue;
      const endpoint = { port, token: token || null };
      endpointCache.set(udid, { at: Date.now(), endpoint });
      return endpoint;
    }
  }
  throw new Error(
    `could not find the gRPC endpoint for ${udid} — no running-AVD record names console port ${serial}`,
  );
}

/** A length-delimited protobuf string field. */
function protoString(fieldNumber, value) {
  const body = Buffer.from(String(value), 'utf8');
  const length = [];
  let remaining = body.length;
  do {
    length.push((remaining & 0x7f) | (remaining > 0x7f ? 0x80 : 0));
    remaining >>>= 7;
  } while (remaining > 0);
  return Buffer.concat([Buffer.from([(fieldNumber << 3) | 2]), Buffer.from(length), body]);
}

/** Read the first length-delimited field out of a protobuf message. */
function firstString(message) {
  if (!message.length || (message[0] >> 3) !== 1) return '';
  let offset = 1;
  let length = 0;
  let shift = 0;
  for (;;) {
    const byte = message[offset];
    offset += 1;
    length |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return message.subarray(offset, offset + length).toString('utf8');
}

function grpcCall(udid, method, message, { timeoutMs = 10_000 } = {}) {
  const { port, token } = grpcEndpoint(udid);
  return new Promise((resolve, reject) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    const fail = (err) => {
      client.close();
      reject(err);
    };
    client.on('error', fail);
    const header = Buffer.alloc(5);
    header.writeUInt8(0, 0);
    header.writeUInt32BE(message.length, 1);
    const req = client.request({
      ':method': 'POST',
      ':path': `/android.emulation.control.EmulatorController/${method}`,
      'content-type': 'application/grpc',
      te: 'trailers',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    });
    req.setTimeout(timeoutMs, () => fail(new Error(`emulator gRPC ${method} timed out after ${timeoutMs}ms`)));
    const chunks = [];
    let status = null;
    let detail = '';
    const readStatus = (headers) => {
      if (headers['grpc-status'] == null) return;
      status = Number(headers['grpc-status']);
      detail = headers['grpc-message'] ?? '';
    };
    req.on('response', readStatus);
    req.on('trailers', readStatus);
    req.on('error', fail);
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      client.close();
      if (status !== 0) {
        // 16 is UNAUTHENTICATED, which here means the token was missing or
        // stale rather than anything the caller did wrong.
        const why = status === 16 ? 'the emulator refused the gRPC token' : `grpc-status ${status}`;
        return reject(new Error(`${method} failed: ${why}${detail ? ` (${detail})` : ''}`));
      }
      // Strip the five-byte frame header the response carries too.
      resolve(Buffer.concat(chunks).subarray(5));
    });
    req.end(Buffer.concat([header, message]));
  });
}

/** A PNG that has not been written all the way to its IEND chunk is a truncated read. */
function completePng(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      if (size < 20) return false;
      // The last chunk of a PNG is 12 bytes: a zero length, the type `IEND`,
      // and a CRC. The type is therefore four bytes in from the end of those
      // twelve — not four bytes in from the end of the file, which is the CRC
      // and never spells anything.
      const tail = Buffer.alloc(12);
      fs.readSync(fd, tail, 0, 12, size - 12);
      return tail.toString('latin1', 4, 8) === 'IEND';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * A screenshot, host-side where possible.
 *
 * `screenrecord screenshot <dir>` makes the emulator write the PNG onto the
 * host filesystem itself — 20 ms against 113 ms for `adb exec-out screencap -p`,
 * because nothing crosses the adb transport. Its filename carries a
 * one-second-resolution timestamp, so it goes into a directory of its own per
 * call rather than into a shared one where two frames in the same second would
 * collide.
 *
 * The console answers OK before the file is necessarily complete, so the read
 * waits for a PNG that ends in IEND rather than for a file that exists.
 *
 * `mask` is a simctl concept (the device bezel) and has no Android meaning.
 */
async function screenshot(udid, outFile, { mask: _mask = 'ignored' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simframe-shot-'));
  try {
    await consoleScript(udid, [`screenrecord screenshot ${dir}`]);
    const deadline = Date.now() + 2000;
    for (;;) {
      const shot = fs.readdirSync(dir).map((f) => path.join(dir, f)).find(completePng);
      if (shot) {
        fs.renameSync(shot, outFile);
        return;
      }
      if (Date.now() > deadline) throw new Error('the emulator console wrote no complete PNG within 2s');
      await new Promise((r) => setTimeout(r, 3));
    }
  } catch (consoleErr) {
    // Fall back to adb, and say what the faster path complained about: a silent
    // fallback to a path five times slower is the failure mode this project has
    // been bitten by twice.
    try {
      const { stdout } = await adb(udid, ['exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 20_000 });
      fs.writeFileSync(outFile, stdout);
      process.env.SIMFRAME_QUIET === '1' ||
        process.stderr.write(`simframe: emulator console unavailable (${consoleErr.message}); used adb screencap\n`);
    } catch (adbErr) {
      throw new Error(`screenshot failed: ${detailOf(adbErr)} (console path: ${consoleErr.message})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The device's real geometry.
 *
 * Without this, `deviceGeometry` fell through to a guess derived from the ring
 * image — an Android emulator reported "393x700pt", which is the capture size
 * and not a coordinate space anything on the device has ever heard of. Every
 * tap point derived from it would have been wrong, silently, which is the worst
 * available outcome for an input path.
 *
 * `wm size` is physical pixels and `wm density` is dpi; Android's density
 * independent pixel is 1/160th of an inch, so the scale factor is dpi/160 and
 * the point size is the pixel size divided by it. Both in one shell hop.
 */
const geometryCache = new Map();

async function geometry(udid) {
  const cached = geometryCache.get(udid);
  if (cached && Date.now() - cached.at < DEVICE_CACHE_MS) return cached.geo;
  const { stdout } = await adb(udid, ['shell', 'wm size; wm density']);
  const text = stdout.replace(/\r/g, '');
  const size = /Physical size:\s*(\d+)x(\d+)/.exec(text);
  const dpi = /Physical density:\s*(\d+)/.exec(text);
  if (!size || !dpi) throw new Error(`could not read the screen geometry: ${text.trim() || 'no answer'}`);
  const density = Number(dpi[1]) / 160;
  const geo = {
    pixelWidth: Number(size[1]),
    pixelHeight: Number(size[2]),
    density,
    pointWidth: Math.round(Number(size[1]) / density),
    pointHeight: Math.round(Number(size[2]) / density),
  };
  geometryCache.set(udid, { at: Date.now(), geo });
  return geo;
}

// --- input ------------------------------------------------------------------
//
// `event mouse <x> <y> <device> <buttonstate>` with device 0 is the touch
// screen, and buttonstate 1 and 0 are down and up. It takes **device pixels**,
// which was settled by watching the kernel rather than by reading the help
// text: sending (360, 640) on a 720x1280 screen makes the touch driver report
// 0x3fff on both axes, exactly half of its 0-32767 range. In device-independent
// pixels 360 would have been the full width and reported the maximum.
//
// Everything above the boundary works in points, so the conversion happens
// here, at the only place that knows the density.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Points to device pixels, clamped to the screen so a bad point cannot be silently off-device. */
function toPixels(geo, x, y) {
  const px = Math.round(x * geo.density);
  const py = Math.round(y * geo.density);
  if (px < 0 || py < 0 || px > geo.pixelWidth || py > geo.pixelHeight) {
    throw new Error(
      `${Math.round(x)},${Math.round(y)}pt is off a ${geo.pointWidth}x${geo.pointHeight}pt screen`,
    );
  }
  return { x: px, y: py };
}

/**
 * A tap: down, a hold, up.
 *
 * The hold is not decoration. A down and an up in the same millisecond is not
 * something a finger can do, and Android's own gesture detectors time
 * touches — a tap with no duration is exactly the "teleporting tap" this
 * project rules out on iOS. 60 ms is a short human tap; anything over 500 ms is
 * a long press, and that is the same code path.
 */
async function tap(udid, x, y, { durationMs = 60 } = {}) {
  const geo = await geometry(udid);
  const p = toPixels(geo, x, y);
  const session = await sessionFor(udid);
  await session.send(`event mouse ${p.x} ${p.y} 0 1`);
  await sleep(Math.max(1, durationMs));
  await session.send(`event mouse ${p.x} ${p.y} 0 0`);
}

/** How many moves a swipe is made of. Enough to be a gesture, few enough to keep the timing. */
const SWIPE_STEPS = 12;

/**
 * A swipe: down, a run of moves with time between them, up.
 *
 * Eased rather than linear, because a real finger accelerates and decelerates
 * and Android's fling detector reads velocity off the last few moves. A linear
 * drag that stops dead reads as a drag; an eased one that is still moving at
 * the end reads as a fling, and which of those you get changes where a list
 * lands.
 */
async function swipe(udid, from, to, { durationMs = 300 } = {}) {
  const geo = await geometry(udid);
  const start = toPixels(geo, from.x, from.y);
  const end = toPixels(geo, to.x, to.y);
  const session = await sessionFor(udid);
  const gap = Math.max(1, Math.round(durationMs / SWIPE_STEPS));
  await session.send(`event mouse ${start.x} ${start.y} 0 1`);
  for (let step = 1; step < SWIPE_STEPS; step += 1) {
    const t = step / SWIPE_STEPS;
    // Ease in-out: slow at both ends, quickest in the middle.
    const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    const x = Math.round(start.x + (end.x - start.x) * eased);
    const y = Math.round(start.y + (end.y - start.y) * eased);
    await sleep(gap);
    await session.send(`event mouse ${x} ${y} 0 1`);
  }
  await sleep(gap);
  await session.send(`event mouse ${end.x} ${end.y} 0 0`);
}

/**
 * Type text as keystrokes.
 *
 * `event text` takes the rest of the line, so a newline cannot be sent through
 * it and is refused rather than silently dropped — `key enter` is the way to
 * send one, and a caller that meant a line break should say so.
 */
async function text(udid, value) {
  const string = String(value);
  if (/[\r\n]/.test(string)) {
    throw new Error('a newline cannot be typed through the emulator console — send an `enter` key instead');
  }
  const session = await sessionFor(udid);
  await session.send(`event text ${string}`);
}

/**
 * The hardware and system keys, by name.
 *
 * Through `adb shell input keyevent`, not through raw kernel codes. On iOS the
 * unverified Indigo button codes are refused outright because a wrong one can
 * crash `backboardd` — here the public API takes names, so there is nothing to
 * guess at and the whole vocabulary is safe to offer. It costs about 35 ms.
 */
const KEYS = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  recents: 'KEYCODE_APP_SWITCH',
  appswitch: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER',
  lock: 'KEYCODE_POWER',
  volumeup: 'KEYCODE_VOLUME_UP',
  volumedown: 'KEYCODE_VOLUME_DOWN',
  enter: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB',
  escape: 'KEYCODE_ESCAPE',
  backspace: 'KEYCODE_DEL',
  delete: 'KEYCODE_DEL',
  menu: 'KEYCODE_MENU',
  search: 'KEYCODE_SEARCH',
  paste: 'KEYCODE_PASTE',
};

async function key(udid, name) {
  const wanted = String(name).toLowerCase().replace(/[\s_-]+/g, '');
  const keycode = KEYS[wanted]
    ?? (/^keycode_[a-z0-9_]+$/i.test(String(name)) ? String(name).toUpperCase() : null)
    ?? (/^\d+$/.test(String(name)) ? String(name) : null);
  if (!keycode) {
    throw new Error(`unknown key "${name}" on Android — one of: ${Object.keys(KEYS).join(', ')}`);
  }
  await adb(udid, ['shell', 'input', 'keyevent', keycode]);
}

/**
 * This backend's own input path, or null if it has none.
 *
 * iOS returns null here: its input is Indigo HID inside the daemon, which is
 * simframe's own engine rather than anything the platform provides. Android's
 * is the emulator console, host-side, with no adb in the gesture path at all.
 */
function inputDriver() {
  return {
    id: 'console',
    detail: 'emulator console (event mouse/text), host-side',
    tap,
    swipe,
    text,
    key,
  };
}

/**
 * Launch a package's launcher activity.
 *
 * `am start` needs a component, not a package, so the launcher activity is
 * resolved first. `args` and `env` are simctl concepts: an Android app has no
 * argv and no environment of its own, and quietly dropping them would let a
 * flow think it had launched an app in a mode it never launched in.
 */
async function launchApp(udid, bundleId, { args = [], env = {}, terminateFirst = false } = {}) {
  if (args.length || Object.keys(env).length) {
    throw new Error(
      'launch arguments and environment are simctl-only — an Android app has no argv or environment ' +
        '(use intent extras from the app side, or drop them for this platform)',
    );
  }
  let component;
  try {
    const { stdout } = await adb(udid, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', bundleId]);
    component = stdout.replace(/\r/g, '').trim().split('\n').pop();
  } catch (err) {
    throw new Error(`could not launch ${bundleId}: ${detailOf(err)}`);
  }
  if (!component || !component.includes('/')) {
    throw new Error(`could not launch ${bundleId}: no launcher activity (is the package installed?)`);
  }
  // Relaunching means starting at the app's root, and on Android
  // `force-stop` then `am start` does not: the platform restores the task's
  // saved activity stack, so a "relaunched" Settings came back on the search
  // screen a previous step had left it on — a flow testing the screen it was
  // already on, which is the exact bug `relaunch` exists to prevent on iOS.
  // `-S` stops the app and `--activity-clear-task` drops the restored stack.
  const fresh = terminateFirst ? ['-S', '--activity-clear-task'] : [];
  // `-W` waits for the activity to be idle and `-S` makes it a cold start:
  // measured at 6.1 s for Settings on an idle emulator, and it exceeded the
  // 20 s default while OCR and capture were competing for the same cores. The
  // bound belongs to the app's start-up, not to adb.
  const { stdout, stderr } = await adb(udid, ['shell', 'am', 'start', '-W', ...fresh, '-n', component], {
    timeout: 60_000,
  });
  const said = `${stdout}${stderr}`;
  // `am start` reports its failures on stdout and exits 0 — the same silent
  // success `pm grant` has, and the reason setPermission below reads back.
  const error = /^Error:.*$/m.exec(said);
  if (error) throw new Error(`could not launch ${bundleId}: ${error[0].replace(/^Error:\s*/, '')}`);
}

async function terminateApp(udid, bundleId) {
  await adb(udid, ['shell', 'am', 'force-stop', bundleId]);
}

async function openUrl(udid, url) {
  const { stdout, stderr } = await adb(udid, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
  const error = /^Error:.*$/m.exec(`${stdout}${stderr}`);
  if (error) throw new Error(`could not open ${url}: ${error[0].replace(/^Error:\s*/, '')}`);
}

/**
 * The permission names simframe accepts on Android, and what each one is.
 *
 * These are not simctl's names and could not be: the two platforms do not have
 * the same permissions. `reminders`, `siri`, `motion` and `media-library` have
 * no Android equivalent and are absent rather than mapped to something close;
 * `notifications` is real here and has no iOS equivalent. A name that means
 * different things on two platforms would be worse than a name that only exists
 * on one.
 */
const PERMISSION_MAP = {
  calendar: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
  camera: ['android.permission.CAMERA'],
  contacts: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'],
  location: ['android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_FINE_LOCATION'],
  'location-always': ['android.permission.ACCESS_BACKGROUND_LOCATION'],
  microphone: ['android.permission.RECORD_AUDIO'],
  notifications: ['android.permission.POST_NOTIFICATIONS'],
  phone: ['android.permission.READ_PHONE_STATE'],
  photos: ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO'],
};

const PERMISSION_SERVICES = ['all', ...Object.keys(PERMISSION_MAP)];

/** What the device says is actually granted, which is not always what was asked for. */
async function grantedPermissions(udid, bundleId) {
  const { stdout } = await adb(udid, ['shell', 'dumpsys', 'package', bundleId]);
  const granted = new Map();
  for (const [, name, value] of stdout.matchAll(/^\s+(android\.permission\.[A-Z_]+): granted=(true|false)/gm)) {
    granted.set(name, value === 'true');
  }
  return granted;
}

/**
 * Grant, revoke or reset a runtime permission, and then check that it happened.
 *
 * The read-back is the whole point. `pm grant` for a permission the package
 * never declared prints nothing, writes nothing and exits 0 — measured — so a
 * grant that reports success proves only that adb ran. This asks the device
 * what it now believes and reports that instead.
 */
async function setPermission(udid, action, service, bundleId) {
  const verb = String(action).toLowerCase();
  if (!['grant', 'revoke', 'reset'].includes(verb)) {
    throw new Error(`permission action must be grant, revoke or reset (got "${action}")`);
  }
  if (!PERMISSION_SERVICES.includes(service)) {
    throw new Error(`unknown permission "${service}" on Android — one of: ${PERMISSION_SERVICES.join(', ')}`);
  }
  if (!bundleId) {
    throw new Error('Android permissions are per app — name the package to grant it to');
  }
  const wanted = service === 'all' ? Object.values(PERMISSION_MAP).flat() : PERMISSION_MAP[service];

  if (verb === 'reset') {
    await adb(udid, ['shell', 'pm', 'reset-permissions', '-p', bundleId]);
    return `reset all permissions for ${bundleId}`;
  }

  const declared = await grantedPermissions(udid, bundleId);
  const undeclared = wanted.filter((p) => !declared.has(p));
  const actionable = wanted.filter((p) => declared.has(p));
  if (!actionable.length) {
    throw new Error(
      `${bundleId} does not declare ${undeclared.join(', ')}, so ${verb} would do nothing ` +
        '(an app can only be granted permissions it asks for)',
    );
  }
  for (const permission of actionable) {
    await adb(udid, ['shell', 'pm', verb, bundleId, permission]);
  }
  const after = await grantedPermissions(udid, bundleId);
  const disagreed = actionable.filter((p) => after.get(p) !== (verb === 'grant'));
  if (disagreed.length) {
    throw new Error(`${verb} ${service} did not take effect for ${disagreed.join(', ')} — the device still disagrees`);
  }
  const skipped = undeclared.length ? ` (${bundleId} does not declare ${undeclared.join(', ')})` : '';
  return `${verb === 'grant' ? 'granted' : 'revoked'} ${service} for ${bundleId}${skipped}`;
}

/**
 * Put text on the device clipboard.
 *
 * Not over adb, which has no path to it: `cmd clipboard` does not exist on API
 * 36 and `service call clipboard` depends on transaction numbers that move
 * between platform versions. The emulator's gRPC endpoint declares
 * `setClipboard(ClipData)` and that is the whole answer — about 48 ms, no
 * dependency, no helper app on the device.
 */
async function setPasteboard(udid, value) {
  await grpcCall(udid, 'setClipboard', protoString(1, String(value)));
}

/** What the device currently holds. Mostly here to make the setter checkable. */
async function getPasteboard(udid) {
  return firstString(await grpcCall(udid, 'getClipboard', Buffer.alloc(0)));
}

/**
 * The prerequisites `simframe doctor` reports for this backend. Returned rather
 * than printed so doctor stays one renderer: a backend says what it needs, and
 * a machine missing it is told which tool, not which platform.
 */
function toolchain() {
  try {
    const version = execFileSync(adbPath(), ['version'], { encoding: 'utf8' }).trim().split('\n')[0];
    return [{ name: 'adb', level: 'ok', detail: version }];
  } catch (err) {
    // Optional, not broken: a machine with no Android SDK has not degraded from
    // anything, and doctor's `optional` level exists for exactly this.
    return [{ name: 'adb', level: 'optional', detail: `${err.message.split('—')[0].trim()} — Android devices unavailable` }];
  }
}

/**
 * What this backend can currently do.
 *
 * Frames: yes — the whole Node capture loop runs on Android unchanged, because
 * it asks the boundary for a screenshot and a resize and both are real here.
 * There is no framebuffer engine, so `screenshot` is not a downgrade on this
 * platform and doctor must not report it as one.
 *
 * Input and the accessibility tree: not yet, and said so rather than answered
 * with the iOS driver's name. Both paths are measured and unwired — the console's
 * `event mouse` puts a real down/move/up on the touch screen in ~20 ms, and
 * `uiautomator dump` costs 2 s a read, which is the interesting problem.
 */
function capabilities() {
  return {
    captureEngines: ['screenshot'],
    input: { supported: true, via: 'console' },
    ax: {
      supported: false,
      note: 'not built for Android yet — `uiautomator dump` costs ~2s a read; see docs/DEFERRED.md',
    },
  };
}

/** @type {import('./index.js').Platform} */
export const platform = {
  id: 'android',
  deviceNoun: 'emulator',
  listDevices,
  bootedDevices,
  resolveDevice,
  isBootedSync,
  ownsUdid,
  geometry,
  inputDriver,
  screenshot,
  launchApp,
  terminateApp,
  openUrl,
  setPermission,
  setPasteboard,
  getPasteboard,
  permissionServices: () => PERMISSION_SERVICES,
  capabilities,
  toolchain,
};
