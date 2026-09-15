// What the app believes.
//
// The perception tools answer "what is drawn". This answers "what did the app
// save", and the field report that asked for it put the pairing better than we
// did: *"`sim_ui` says what is drawn, `sim_storage` says what the app
// believes."* Their highest-leverage moment in a whole session was not a
// simframe call at all — they read the persisted store straight out of the data
// container, found the exact wrong value the app had written, and proved the bug
// with no live session, no login, and the device not yet booted.
//
// That last property is the design constraint, not a bonus. Measured on this
// Xcode, `simctl get_app_container` and `simctl listapps` both refuse on a
// device that is not running. So nothing here goes through the device: the
// backend reads the container off the host filesystem, and a shut-down device
// answers exactly as well as a running one.
//
// Nothing in this file knows which platform it is on. Where a container lives
// and how a property list is decoded are the backend's business; what a store
// is, and how to say what is in one, are this file's.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as platform from './platform/index.js';

/**
 * How much of a single value is printed before the rest is summarised.
 *
 * Generous on purpose — the whole point is to see what the app actually wrote,
 * and a value clipped to eighty characters answers nothing. What this must
 * never do is clip *silently*: item 141 in DEFERRED is a harness that cut a
 * failure report one character before the only content that mattered, and the
 * lesson was that a reader who is not told about a cut reads the fragment as
 * the whole. So past this, the text says how many bytes it is not showing and
 * how to get them.
 */
export const VALUE_PREVIEW_BYTES = 4096;

/** React Native's own store, in the layout its iOS implementation writes. */
const ASYNC_STORAGE_DIR = 'RCTAsyncLocalStorage_V1';
const ASYNC_STORAGE_MANIFEST = 'manifest.json';

/**
 * Where AsyncStorage actually lives, newest layout first.
 *
 * **`Documents/` alone was wrong, and wrong in the worst available way.** That
 * is the *legacy* React Native location. The community package every current RN
 * app uses — `@react-native-async-storage/async-storage` — writes to
 * `Library/Application Support/<bundle-id>/`, and on a real app measured by an
 * external tester the `Documents/` path **did not exist at all**. So
 * `readAsyncStorage` returned null, `format()` omitted the section, and the
 * output read as "this app has no AsyncStorage" while 25 keys sat on disk,
 * including a 1.5 MB MobX-State-Tree root store.
 *
 * Their diagnosis was exact: *"The decoder is correct; only the path is wrong."*
 * Which makes this the precise class of confident wrong answer the whole feature
 * exists to prevent, shipped inside it.
 *
 * Both are tried because both are real — an older app still writes to
 * `Documents/` — and every path looked in is reported, because "found nothing"
 * and "did not look there" are different facts and only one of them is about
 * the app.
 */
const asyncStorageDirs = (container, bundleId) => [
  path.join(container, 'Library', 'Application Support', String(bundleId ?? ''), ASYNC_STORAGE_DIR),
  path.join(container, 'Library', 'Application Support', ASYNC_STORAGE_DIR),
  path.join(container, 'Documents', ASYNC_STORAGE_DIR),
];

/** Files that are plainly a store but that nothing here can decode yet. */
const OPAQUE_STORES = /\.(sqlite3?|db|realm|leveldb|mmkv)$/i;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return null; } };

/** Every app with a data container on the device, whether or not it is running. */
export async function apps(udid) {
  return platform.listApps(udid);
}

/**
 * React Native's AsyncStorage.
 *
 * The manifest holds small values inline. A value past RN's inline threshold is
 * stored as `null` in the manifest and written to a file beside it named by the
 * MD5 of the key — so a manifest full of nulls is not an empty store, and
 * reporting it as one would be the exact class of wrong answer this feature
 * exists to stop.
 */
export function readAsyncStorage(container, bundleId) {
  const looked = asyncStorageDirs(container, bundleId);
  const dir = looked.find((d) => fs.existsSync(path.join(d, ASYNC_STORAGE_MANIFEST)));
  // The paths travel with the miss. A reader told only "no AsyncStorage" cannot
  // tell a bare app from a store we failed to find, and the second is ours.
  if (!dir) return { missing: true, looked: looked.map((d) => path.relative(container, d)) };
  const manifestPath = path.join(dir, ASYNC_STORAGE_MANIFEST);
  const manifest = readJson(manifestPath);
  const entries = [];
  for (const [key, inline] of Object.entries(manifest)) {
    if (inline !== null && inline !== undefined) {
      entries.push({ key, value: inline, type: typeof inline, where: 'manifest' });
      continue;
    }
    const spilled = path.join(dir, crypto.createHash('md5').update(key).digest('hex'));
    if (fs.existsSync(spilled)) {
      const value = fs.readFileSync(spilled, 'utf8');
      entries.push({ key, value, type: 'string', bytes: sizeOf(spilled), where: 'spilled to its own file' });
    } else {
      // Say which of the two this is. "Null" and "too big to inline, and the
      // file is missing" are different facts about the app.
      entries.push({ key, value: null, type: 'null', where: 'manifest says null and no spill file exists' });
    }
  }
  return { name: 'AsyncStorage', source: dir, entries };
}

/**
 * Preference plists in the container.
 *
 * The one named after the bundle id is the app's own `UserDefaults`; the others
 * are real and are named rather than hidden, because a framework writing its
 * state beside the app's is often exactly what the reader is hunting.
 */
async function readPreferences(udid, container, bundleId) {
  const dir = path.join(container, 'Library', 'Preferences');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.plist'));
  } catch {
    return [];
  }
  const stores = [];
  for (const file of files.sort()) {
    const full = path.join(dir, file);
    const own = file === `${bundleId}.plist`;
    try {
      const parsed = await platform.readPropertyList(udid, full);
      stores.push({
        name: own ? 'UserDefaults' : `UserDefaults (${file.replace(/\.plist$/, '')})`,
        source: full,
        entries: Object.entries(parsed ?? {}).map(([key, value]) => ({ key, value, type: typeOf(value) })),
      });
    } catch (err) {
      // Degrade rather than fail: one unreadable plist must not cost the
      // reader every other store in the container.
      stores.push({ name: own ? 'UserDefaults' : file, source: full, entries: [], error: err.message });
    }
  }
  // The app's own defaults first; that is what was asked about.
  return stores.sort((a, b) => Number(b.name === 'UserDefaults') - Number(a.name === 'UserDefaults'));
}

/** Stores that are plainly present and that nothing here can decode. */
export function opaqueStores(container) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (OPAQUE_STORES.test(e.name)) found.push({ file: path.relative(container, full), bytes: sizeOf(full) });
    }
  };
  walk(container, 0);
  return found;
}

/** One word for what a value is, including the tagged shapes a plist produces. */
export function typeOf(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return value.__type ?? 'dict';
  return typeof value;
}

/**
 * Everything one app has persisted that this can read, and an honest list of
 * what it could not.
 */
export async function read(udid, bundleId) {
  const container = await platform.appContainer(udid, bundleId);
  const stores = await readPreferences(udid, container, bundleId);
  const async_ = readAsyncStorage(container, bundleId);
  if (async_ && !async_.missing) stores.push(async_);
  return {
    bundleId,
    container,
    stores,
    opaque: opaqueStores(container),
    asyncStorageMissing: async_?.missing ? async_.looked : null,
  };
}

/** One value, rendered for reading, saying so whenever it is not the whole thing. */
export function renderValue(value) {
  if (value && typeof value === 'object' && value.__type === 'data') {
    return `<${value.bytes} bytes of data> ${value.base64.slice(0, 64)}${value.base64.length > 64 ? '…' : ''}`;
  }
  if (value && typeof value === 'object' && value.__type === 'date') return value.iso;
  if (value && typeof value === 'object' && value.__type === 'integer') return value.exact;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text == null) return String(value);
  if (text.length <= VALUE_PREVIEW_BYTES) return text;
  // Announced, never silent. See VALUE_PREVIEW_BYTES.
  return `${text.slice(0, VALUE_PREVIEW_BYTES)}\n    … ${text.length - VALUE_PREVIEW_BYTES} more character(s) not shown`
    + ' — read the file named under `from:` for the whole value';
}

/** The text form: what the app believes, one store at a time. */
export function format(result) {
  const lines = [`${result.bundleId}`, `  container ${result.container}`];
  if (!result.stores.length) lines.push('  no readable store — the app has persisted nothing this can decode');
  for (const store of result.stores) {
    lines.push('');
    lines.push(`  ${store.name} — ${store.entries.length} key(s)`);
    lines.push(`  from: ${store.source}`);
    if (store.error) lines.push(`    unreadable: ${store.error}`);
    for (const e of store.entries) {
      const where = e.where && e.where !== 'manifest' ? `  (${e.where})` : '';
      lines.push(`    ${e.key}  [${e.type}]${where}`);
      lines.push(`      ${renderValue(e.value).split('\n').join('\n      ')}`);
    }
  }
  // Say where we looked and did not find it. See `asyncStorageDirs`.
  if (result.asyncStorageMissing) {
    lines.push('');
    lines.push('  no AsyncStorage found. Looked in:');
    for (const d of result.asyncStorageMissing) lines.push(`    ${d}`);
    lines.push('  (an app that does not use AsyncStorage will have none of these)');
  }
  if (result.opaque?.length) {
    lines.push('');
    lines.push(`  ${result.opaque.length} store(s) present that this cannot decode yet:`);
    for (const o of result.opaque) lines.push(`    ${o.file}  ${o.bytes} bytes`);
  }
  // Asked for by the external tester, and they were right to: mid-session the
  // app restored a session from the Keychain and walked past its own login
  // screen, so "logged out" as read from storage was not the whole truth.
  // Saying what is NOT readable sets expectations that silence does not.
  lines.push('');
  lines.push('  Keychain is not readable from here — auth state may differ from what is above.');
  return lines.join('\n');
}

/** The listing form. */
export function formatApps(list) {
  if (!list.length) return 'no app has a data container on this device';
  return [`${list.length} app(s) with a data container`, ...list.map((a) => `  ${a.bundleId}`)].join('\n');
}
