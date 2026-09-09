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
 * Run a short script on the console and resolve when it has all been answered.
 *
 * The console is a line protocol that answers every command with OK or KO, so
 * the next line is sent when the previous one has been answered rather than on
 * a timer.
 */
function consoleScript(udid, lines, { timeoutMs = 10_000 } = {}) {
  const port = consolePort(udid);
  if (!port) return Promise.reject(new Error(`${udid} is not an emulator serial`));
  return new Promise((resolve, reject) => {
    const script = [`auth ${consoleToken()}`, ...lines, 'quit'];
    const transcript = [];
    const sock = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`emulator console on ${port} did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      if (!/OK\r?\n|KO/.test(buf)) return;
      transcript.push(buf);
      const next = script.shift();
      buf = '';
      if (next) sock.write(`${next}\n`);
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('close', () => {
      clearTimeout(timer);
      const text = transcript.join('');
      if (/KO/.test(text)) reject(new Error(`emulator console refused: ${/KO:?\s*(.*)/.exec(text)?.[1] || 'KO'}`));
      else resolve(text);
    });
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
  if (terminateFirst) {
    try {
      await terminateApp(udid, bundleId);
    } catch {
      /* not running; that is the state we wanted */
    }
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
  const { stdout, stderr } = await adb(udid, ['shell', 'am', 'start', '-W', '-n', component]);
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
 * There is no pasteboard path on Android.
 *
 * `cmd clipboard` does not exist (API 36 answers "No shell command
 * implementation"), and the clipboard service cannot be driven over `service
 * call` in any way that survives a platform version. The alternatives both cost
 * something honest: type the text, or install a helper APK, which would be the
 * first runtime dependency this project has taken. See docs/DEFERRED.md.
 */
async function setPasteboard(udid, _value) {
  throw new Error(
    'setting the pasteboard is not supported on Android — there is no adb path to the clipboard ' +
      '(type the text instead, which is slower but real)',
  );
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
    input: {
      supported: false,
      note: 'not built for Android yet — the emulator console `event mouse` path is measured but unwired',
    },
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
  screenshot,
  launchApp,
  terminateApp,
  openUrl,
  setPermission,
  setPasteboard,
  permissionServices: () => PERMISSION_SERVICES,
  capabilities,
  toolchain,
};
