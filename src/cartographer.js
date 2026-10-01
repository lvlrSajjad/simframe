/**
 * The app cartographer: crawl an app on purpose and write every screen and
 * transition into the graph, so a later goal can be served from memory.
 *
 * **Opt-in, and bounded the way CLAUDE.md bounds exploration.** "Exploration is
 * bounded: six actions per attempt." A crawl is a sequence of attempts, each of
 * at most `ATTEMPT_ACTIONS` actions, each starting from a screen the graph
 * already holds. Between attempts the barrier and the budget are checked again
 * and state is saved, so a run can stop at any attempt boundary and resume.
 * "Never explore when a graph path exists" holds by construction: a control is
 * explored only when the graph has no edge for it, and getting back to a
 * screen with unexplored controls walks the graph's own path rather than
 * exploring.
 *
 * **The verify barrier is absolute here.** A control is never opened when its
 * label is destructive vocabulary, leaves the app, or is on the exploration
 * list of things that commit, abandon or answer (`vocabulary.openableAsDoor`).
 * A control whose last tap here was `unexpected-*` is never tapped again. An
 * action that puts another app in front is recorded as leaving the app, and the
 * crawl relaunches. Logged-in apps hold real data, so the default is read-only:
 * no typing, no switches or other state-changing types, nothing on the
 * `cartographer.opensWrite` list. `allowCreate` lifts that list only. Nothing
 * here ever commits: save, submit, apply and confirm are barred either way.
 *
 * **Deterministic and injectable.** The crawl talks to a driver (`read`, `tap`,
 * `back`, `launch`, `walk`, `route`, `sameScreen`, `inApp`). Tests drive a fake
 * app; `deviceDriver` drives a simulator through the same code paths `sim_do`
 * uses, so every transition is verified and recorded by the ordinary graph.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import * as vocabulary from './vocabulary.js';

export const ATTEMPT_ACTIONS = 6;
export const STATE_VERSION = 1;
/**
 * Rows of one shape are opened until two of them land on the same screen (or
 * on screens of the same name): from then on the rest of that shape are rows
 * of a list and lead to the same kind of screen. A menu's rows look alike too,
 * and each of them goes somewhere different, which is why shape alone is not
 * the test. `LIST_CAP` stops a list whose rows each split into a new identity
 * (DEFERRED 174) from eating the budget.
 */
export const LIST_CAP = 6;

const alnum = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function words(locale) {
  const v = vocabulary.load(locale);
  const c = v.cartographer ?? {};
  return {
    opensWrite: c.opensWrite ?? [],
    back: (c.back ?? []).map(alnum),
    rawBack: c.back ?? [],
    stateTypes: new RegExp(`^(${(c.stateChangingTypes ?? []).join('|') || 'switch'})$`, 'i'),
  };
}

const says = (label, phrase) => ` ${alnum(label)} `.includes(` ${alnum(phrase)} `);

/** The text that says the app did not start, if this reading shows one. */
export function didNotStart(reading, { locale } = {}) {
  const pats = vocabulary.load(locale).cartographer?.didNotStart ?? [];
  for (const r of reading?.rows ?? []) {
    const label = String(r.label ?? '');
    if (pats.some((p) => label.toLowerCase().includes(p.toLowerCase()))) return label.split('\n')[0].slice(0, 120);
  }
  return null;
}

/** Is this row how a screen is left, rather than a door out of it? */
export function isBackAffordance(row, { locale } = {}) {
  const w = words(locale);
  const label = String(row?.label ?? '').trim();
  if (w.rawBack.includes(label) || w.back.includes(alnum(label))) return true;
  // A nav bar's leading button is a back button whatever it is called — RN
  // apps name theirs after a testID ("screen-toolbar-back-button").
  if (row?.region === 'nav-bar' && row?.navSlot === 'leading' && /back|close|dismiss/i.test(label)) return true;
  return /(^|[-_ ])back([-_ ]|$)|header-back|toolbar-back/i.test(label);
}

/** A stable name for a control on a screen. */
export function controlKey(row) {
  return `${row.region ?? 'content'}|${alnum(row.label)}`;
}

/**
 * May the crawl open this control? `{open: true}` or `{open: false, reason}`.
 * The order is the order of how bad a wrong answer would be.
 */
export function classify(row, { allowCreate = false, locale } = {}) {
  const label = String(row?.label ?? '').trim();
  if (!label || /^\(icon-only\)$/i.test(label)) return { open: false, reason: 'unlabeled', kind: 'skipped' };
  if (row.region === 'status-bar' || row.region === 'keyboard') return { open: false, reason: 'system chrome', kind: 'skipped' };
  if (isBackAffordance(row, { locale })) return { open: false, reason: 'back affordance', kind: 'skipped' };
  const barrier = vocabulary.mayActLocally(label, { locale, purpose: 'explore' });
  if (!barrier.allowed) return { open: false, reason: `${barrier.reason} ("${barrier.matched}")`, kind: 'barrier' };
  const w = words(locale);
  const links = vocabulary.load(locale).cartographer?.contactLinkPatterns ?? [];
  if (links.some((p) => new RegExp(p, 'i').test(label))) return { open: false, reason: 'a phone number, email or web address — it calls, mails or leaves', kind: 'barrier' };
  if (w.stateTypes.test(String(row.type ?? ''))) return { open: false, reason: `changes state (${row.type})`, kind: 'read-only' };
  if (row.enabled === false) return { open: false, reason: 'disabled', kind: 'skipped' };
  if (!allowCreate) {
    const hit = w.opensWrite.find((p) => says(label, p));
    if (hit) return { open: false, reason: `opens a write flow ("${hit}") — read-only run; pass --allow-create to open it`, kind: 'read-only' };
  }
  return { open: true };
}

/**
 * The doors on a screen, in the order a person would try them: chrome tabs
 * once per crawl, then content top to bottom, with a repeated list row sampled
 * rather than opened N times — every row of a work-order list is the same door.
 */
export function doorsOf(rows, { allowCreate = false, locale } = {}) {
  const doors = [];
  const refused = [];
  const seenKeys = new Set();
  const ordered = [...(rows ?? [])].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  // A row that is selected marks a selection list, and choosing another of its
  // options changes a setting by itself — no Save, no write word on the label.
  const optionShapes = new Set(ordered.filter((r) => r.selected === true).map(shapeOf).filter(Boolean));
  for (const row of ordered) {
    const key = controlKey(row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const verdict = classify(row, { allowCreate, locale });
    if (!verdict.open) {
      if (verdict.kind !== 'skipped' || verdict.reason === 'unlabeled') refused.push({ key, label: row.label ?? null, reason: verdict.reason, kind: verdict.kind });
      continue;
    }
    const shape = shapeOf(row);
    if (shape && optionShapes.has(shape)) {
      refused.push({ key, label: row.label ?? null, reason: 'an option in a selection list — choosing it changes a setting', kind: 'read-only' });
      continue;
    }
    doors.push({ key, label: row.label, region: row.region ?? 'content', x: row.x, y: row.y, type: row.type ?? null, shape });
  }
  return { doors, refused };
}

/** What a row looks like, ignoring where it is in a column: its list identity. */
export function shapeOf(row) {
  if ((row?.region ?? 'content') !== 'content' || !(row?.frame?.width > 0)) return null;
  const w = Math.round(row.frame.width / 8);
  const h = Math.round((row.frame.height ?? 0) / 4);
  return `${row.type ?? ''}|${w}|${h}|${Math.round((row.x ?? 0) / 16)}`;
}

/** Rows whose selection or value differs between two readings of one screen. */
export function stateDiff(before, after) {
  const sig = (rows) => new Map((rows ?? []).filter((r) => r.label).map((r) => [`${r.region ?? ''}|${alnum(r.label)}`, `${r.selected === true}|${r.value ?? ''}`]));
  const a = sig(before?.rows);
  const b = sig(after?.rows);
  return [...a.entries()].filter(([k, v]) => b.has(k) && b.get(k) !== v).map(([k]) => k.split('|').slice(1).join('|'));
}

// ── state ────────────────────────────────────────────────────────────────

function stateFile(udid, bundle) {
  return path.join(store.deviceDir(udid), 'maps', `${encodeURIComponent(bundle)}.json`);
}

export function loadState(udid, bundle) {
  const s = store.readJson(stateFile(udid, bundle));
  if (s?.version === STATE_VERSION && s.bundle === bundle) return s;
  return { version: STATE_VERSION, bundle, udid, startedAt: Date.now(), runs: [], screens: {}, chrome: {}, refused: {}, leftApp: [], unexpected: [] };
}

export function saveState(udid, state) {
  const file = stateFile(udid, state.bundle);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  state.updatedAt = Date.now();
  store.writeAtomic(file, JSON.stringify(state));
}

function labelSig(rows) {
  return [...new Set((rows ?? []).map((r) => alnum(r.label)).filter(Boolean))].sort();
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 1;
}

function register(state, reading, { allowCreate, locale, via = null }) {
  if (!reading?.hash) return null;
  let s = state.screens[reading.hash];
  if (!s) {
    s = state.screens[reading.hash] = { name: reading.name ?? null, firstSeen: Date.now(), via, samples: [], controls: {} };
  }
  if (!s.name && reading.name) s.name = reading.name;
  const sig = labelSig(reading.rows);
  if (s.samples.length < 4 && !s.samples.some((x) => jaccard(x, sig) > 0.9)) s.samples.push(sig);
  const { doors, refused } = doorsOf(reading.rows, { allowCreate, locale });
  for (const d of doors) {
    if (d.region === 'tab-bar') {
      // A tab is the same door on every screen that shows the bar.
      if (state.chrome[d.key]) continue;
      state.chrome[d.key] = { label: d.label, status: 'pending', from: reading.hash };
    }
    if (!s.controls[d.key]) s.controls[d.key] = { label: d.label, region: d.region, status: 'pending', ...(d.shape ? { shape: d.shape } : {}) };
  }
  for (const r of refused) {
    const k = `${r.label ?? '(unlabeled)'}|${r.reason}`;
    state.refused[k] ??= { label: r.label, reason: r.reason, kind: r.kind, screens: [] };
    if (!state.refused[k].screens.includes(reading.hash)) state.refused[k].screens.push(reading.hash);
  }
  return s;
}

function pendingOn(state, hash) {
  const s = state.screens[hash];
  if (!s) return null;
  for (const [key, c] of Object.entries(s.controls)) {
    if (c.status !== 'pending') continue;
    if (c.region === 'tab-bar' && state.chrome[key]?.status !== 'pending') {
      c.status = 'tab-elsewhere';
      continue;
    }
    return { key, ...c };
  }
  return null;
}

/** After a row of a shape is opened: is the rest of that shape a list? */
function sampleList(state, hash, key) {
  const controls = state.screens[hash]?.controls ?? {};
  const shape = controls[key]?.shape;
  if (!shape) return;
  const same = Object.values(controls).filter((c) => c.shape === shape);
  const opened = same.filter((c) => c.status === 'explored');
  const dests = opened.map((c) => c.to);
  const names = opened.map((c) => c.toName).filter(Boolean).map(alnum);
  const repeat = new Set(dests).size < dests.length || new Set(names).size < names.length;
  if (!repeat && opened.length < LIST_CAP) return;
  for (const c of same) if (c.status === 'pending') { c.status = 'sampled'; }
}

function mark(state, hash, key, patch) {
  const c = state.screens[hash]?.controls?.[key];
  if (c) Object.assign(c, patch);
  if (state.chrome[key] && (patch.status && patch.status !== 'pending')) Object.assign(state.chrome[key], patch);
}

// ── the crawl ────────────────────────────────────────────────────────────

/**
 * Crawl until the budget is spent or nothing reachable is left.
 *
 * @param {object} driver   see the module comment
 * @param {object} o
 * @param {string} o.bundle
 * @param {number} [o.budgetMs]      wall time for this run
 * @param {number} [o.maxActions]    actions for this run
 * @param {boolean} [o.allowCreate]  open write flows (never commits)
 * @param {object} [o.state]         resume from this state
 * @param {(state) => void} [o.persist]  called at every attempt boundary
 */
export async function crawl(driver, {
  bundle,
  budgetMs = 10 * 60 * 1000,
  maxActions = 200,
  allowCreate = false,
  locale,
  state = null,
  persist = () => {},
  now = () => Date.now(),
} = {}) {
  state ??= { version: STATE_VERSION, bundle, startedAt: now(), runs: [], screens: {}, chrome: {}, refused: {}, leftApp: [], unexpected: [] };
  const run = { startedAt: now(), actions: 0, attempts: 0, explored: 0, newScreens: 0, relaunches: 0, stoppedBecause: null };
  state.runs.push(run);
  const t0 = now();
  const spent = () => (now() - t0 >= budgetMs ? 'wall-time budget spent' : run.actions >= maxActions ? 'action budget spent' : null);
  let inAttempt = 0;
  const unreachable = new Map();
  const act = () => { run.actions += 1; inAttempt += 1; };
  const boundary = () => {
    if (inAttempt >= ATTEMPT_ACTIONS) {
      run.attempts += 1;
      inAttempt = 0;
      persist(state);
    }
  };
  const knownBefore = new Set(Object.keys(state.screens));

  // Back in front without restarting: what leaving the app needs.
  const foreground = async () => {
    act();
    return driver.launch({ relaunch: false });
  };
  // Out of a dead end: the graph's own way home first, a restart last, and a
  // restart only when it is safe. A restart of a debug build whose JavaScript
  // came from a packager that has since stopped leaves the app on an error
  // screen with the signed-in session unusable — measured on a real device on
  // 2026-10-01, by this crawler, before this existed.
  const recover = async (here) => {
    if (root && here?.hash && here.hash !== root) {
      const r = driver.route(here.hash, root);
      if (r?.length && r.every((e) => !e.changedOutcomes)) {
        const walked = await driver.walk(r);
        for (let i = 0; i < (walked?.steps ?? 0); i += 1) act();
        const after = walked?.after ?? await driver.read();
        if (after?.hash && (after.hash === root || await driver.sameScreen({ hash: root, tokens: [] }, after))) return after;
      }
    }
    const blocked = await driver.relaunchBlocked?.();
    if (blocked) return { stop: `stuck${here?.name ? ` on "${here.name}"` : ''}, and relaunching is not safe: ${blocked}`, blocked: true };
    run.relaunches += 1;
    act();
    const r = await driver.launch({ relaunch: true });
    const dead = didNotStart(r, { locale });
    if (dead) return { stop: `the app did not start after a relaunch: "${dead}"`, failed: true };
    return r;
  };

  let reading = await driver.launch({ relaunch: false });
  act();
  {
    const dead = didNotStart(reading, { locale });
    if (dead) {
      run.stoppedBecause = `the app is not running: "${dead}"`;
      run.failed = true;
      run.endedAt = now();
      persist(state);
      return state;
    }
  }
  const root = reading?.hash ?? null;
  register(state, reading, { allowCreate, locale });

  while (true) {
    const why = spent();
    if (why) { run.stoppedBecause = why; break; }
    boundary();
    if (!(await driver.inApp())) {
      state.leftApp.push({ at: now(), from: reading?.hash ?? null, note: 'found outside the app at an attempt boundary' });
      reading = await foreground();
      register(state, reading, { allowCreate, locale });
      continue;
    }
    const here = reading;
    const door = pendingOn(state, here.hash);

    if (door) {
      const before = here;
      const res = await driver.tap(door, before);
      act();
      if (!(await driver.inApp())) {
        mark(state, before.hash, door.key, { status: 'left-app' });
        state.leftApp.push({ at: now(), from: before.hash, label: door.label });
        reading = await foreground();
        register(state, reading, { allowCreate, locale });
        continue;
      }
      if (/^unexpected/.test(res?.verdict ?? '')) {
        // Never acted on again: the barrier's third clause.
        mark(state, before.hash, door.key, { status: 'unexpected', verdict: res.verdict });
        state.unexpected.push({ at: now(), from: before.hash, label: door.label, verdict: res.verdict });
      }
      if (res?.ok === false && !/^unexpected/.test(res?.verdict ?? '')) {
        mark(state, before.hash, door.key, { status: 'failed', detail: String(res.detail ?? '').slice(0, 160) });
        reading = await driver.read();
        register(state, reading, { allowCreate, locale });
        continue;
      }
      reading = res?.after ?? await driver.read();
      run.explored += 1;
      if (!reading?.hash || (await driver.sameScreen(before, reading))) {
        const changed = reading?.hash ? stateDiff(before, reading) : [];
        if (changed.length) {
          // The tap changed something in place: a selection, a value. A
          // read-only crawl must not do that twice, so every control of the same
          // shape here is refused from now on, and the change is reported first.
          mark(state, before.hash, door.key, { status: 'changed-state', changed });
          (state.changedState ??= []).push({ at: now(), screen: before.name ?? before.hash, label: door.label, changed });
          const shape = state.screens[before.hash]?.controls?.[door.key]?.shape;
          for (const c of Object.values(state.screens[before.hash]?.controls ?? {})) {
            if (shape && c.shape === shape && c.status === 'pending') c.status = 'refused-after-change';
          }
        } else if (!/^unexpected/.test(res?.verdict ?? '')) mark(state, before.hash, door.key, { status: 'no-change' });
        reading = reading?.hash ? reading : before;
        continue;
      }
      if (!/^unexpected/.test(res?.verdict ?? '')) mark(state, before.hash, door.key, { status: 'explored', to: reading.hash, toName: reading.name ?? null });
      sampleList(state, before.hash, door.key);
      const fresh = !state.screens[reading.hash];
      register(state, reading, { allowCreate, locale, via: { from: before.hash, label: door.label } });
      if (fresh) run.newScreens += 1;
      continue;
    }

    // Nothing left here. Back out, the app's own way first.
    const back = await driver.back(here);
    if (back?.acted) {
      act();
      const after = back.after ?? await driver.read();
      if (after?.hash && !(await driver.sameScreen(here, after))) {
        reading = after;
        register(state, reading, { allowCreate, locale });
        continue;
      }
    }
    // Then the graph's own path to the nearest screen that still has doors.
    const targets = Object.keys(state.screens).filter((h) => h !== here.hash && pendingOn(state, h) && (unreachable.get(h) ?? 0) < 2);
    let best = null;
    for (const h of targets) {
      const r = driver.route(here.hash, h);
      if (r && r.length && (!best || r.length < best.route.length)) best = { hash: h, route: r };
    }
    if (best && best.route.every((e) => !e.changedOutcomes)) {
      const walked = await driver.walk(best.route);
      for (let i = 0; i < (walked?.steps ?? best.route.length); i += 1) act();
      const after = walked?.after ?? await driver.read();
      if (after?.hash && (await driver.sameScreen({ hash: best.hash, tokens: [] }, after) || after.hash === best.hash)) {
        reading = after;
        register(state, reading, { allowCreate, locale });
        continue;
      }
      unreachable.set(best.hash, (unreachable.get(best.hash) ?? 0) + 1);
      reading = after?.hash ? after : await driver.read();
      register(state, reading, { allowCreate, locale });
      continue;
    }
    // No back and no path. Home, by the graph or a safe restart; if home has
    // nothing either, the reachable map is done.
    const home = await recover(here);
    if (home?.stop) {
      run.stoppedBecause = home.stop;
      if (home.failed) run.failed = true;
      if (home.blocked) run.blocked = true;
      break;
    }
    register(state, home, { allowCreate, locale });
    if (!pendingOn(state, home.hash) && !targets.some((h) => driver.route(home.hash, h)?.length)) {
      run.stoppedBecause = 'nothing reachable left to open';
      reading = home;
      break;
    }
    reading = home;
  }
  run.attempts += inAttempt ? 1 : 0;
  run.endedAt = now();
  run.screensBefore = knownBefore.size;
  persist(state);
  return state;
}

// ── the report ───────────────────────────────────────────────────────────

/** Coverage, frontier, refusals, and suspected merges and splits, as data. */
export function coverage(state) {
  const screens = Object.entries(state.screens);
  const controls = screens.flatMap(([hash, s]) => Object.entries(s.controls).map(([key, c]) => ({ hash, screen: s.name, key, ...c })));
  const by = (st) => controls.filter((c) => c.status === st);
  const names = new Map();
  for (const [hash, s] of screens) {
    if (!s.name) continue;
    const k = alnum(s.name);
    names.set(k, [...(names.get(k) ?? []), hash]);
  }
  const splits = [...names.entries()].filter(([, hs]) => hs.length > 1).map(([name, hashes]) => ({ name, hashes }));
  const merges = screens
    .filter(([, s]) => s.samples.length > 1)
    .map(([hash, s]) => {
      let low = 1;
      for (let i = 0; i < s.samples.length; i += 1) for (let j = i + 1; j < s.samples.length; j += 1) low = Math.min(low, jaccard(s.samples[i], s.samples[j]));
      return { hash, name: s.name, similarity: Math.round(low * 100) / 100 };
    })
    .filter((m) => m.similarity < 0.34);
  const last = state.runs.at(-1) ?? {};
  return {
    bundle: state.bundle,
    screens: screens.length,
    named: screens.filter(([, s]) => s.name).length,
    edges: by('explored').length,
    explored: by('explored').length + by('no-change').length,
    noChange: by('no-change').length,
    sampled: by('sampled').length,
    frontier: by('pending').map((c) => ({ screen: c.screen ?? c.hash.slice(0, 8), label: c.label })),
    failed: by('failed').map((c) => ({ screen: c.screen ?? c.hash.slice(0, 8), label: c.label, detail: c.detail })),
    refused: Object.values(state.refused).map((r) => ({ label: r.label, reason: r.reason, kind: r.kind, screens: r.screens.length })),
    leftApp: state.leftApp,
    changedState: state.changedState ?? [],
    unexpected: state.unexpected,
    splits,
    merges,
    lastRun: last,
    runs: state.runs.length,
  };
}

/** The report as text, for the CLI and MCP. No images, ever. */
export function renderReport(cov, { limit = 12 } = {}) {
  const r = cov.lastRun ?? {};
  const secs = r.endedAt && r.startedAt ? Math.round((r.endedAt - r.startedAt) / 1000) : null;
  const lines = [
    ...(r.failed ? [`FAILED — ${r.stoppedBecause}. Nothing below is a map of the app.`] : []),
    ...(r.blocked ? [`STOPPED EARLY — ${r.stoppedBecause}`] : []),
    ...((cov.changedState ?? []).length ? [`CHANGED STATE ${cov.changedState.length}x — a tap changed something in place, which a read-only crawl must not do; check it: ${cov.changedState.map((x) => `"${x.label}" on ${x.screen} (${x.changed.join(', ')})`).join('; ')}`] : []),
    `map of ${cov.bundle}: ${cov.screens} screen(s) (${cov.named} named), ${cov.edges} transition(s) recorded, ${cov.frontier.length} door(s) not yet opened`,
    `this run: ${r.actions ?? 0} action(s) in ${r.attempts ?? 0} attempt(s) of ≤${ATTEMPT_ACTIONS}${secs != null ? `, ${secs}s` : ''}, ${r.newScreens ?? 0} new screen(s), ${r.relaunches ?? 0} relaunch(es); stopped: ${r.stoppedBecause ?? '—'}${cov.runs > 1 ? ` (run ${cov.runs}, resumed)` : ''}`,
  ];
  const barrier = cov.refused.filter((x) => x.kind === 'barrier');
  const readOnly = cov.refused.filter((x) => x.kind === 'read-only');
  const unlabeled = cov.refused.filter((x) => x.reason === 'unlabeled').reduce((n, x) => n + x.screens, 0);
  if (barrier.length) lines.push(`refused by the verify barrier (${barrier.length}): ${barrier.slice(0, limit).map((x) => `"${x.label}" — ${x.reason}`).join('; ')}`);
  if (readOnly.length) lines.push(`not opened, read-only run (${readOnly.length}): ${readOnly.slice(0, limit).map((x) => `"${x.label}" — ${x.reason.replace(/ — read-only run.*$/, '')}`).join('; ')}`);
  if (cov.sampled) lines.push(`${cov.sampled} list row(s) not opened: earlier rows of the same list led to the same screen`);
  if (unlabeled) lines.push(`${unlabeled} unlabeled control(s) were not opened: nothing says what they do`);
  if (cov.leftApp.length) lines.push(`left the app ${cov.leftApp.length}x: ${cov.leftApp.slice(0, limit).map((x) => x.label ? `"${x.label}"` : x.note).join('; ')} — relaunched each time`);
  if (cov.unexpected.length) lines.push(`unexpected-screen ${cov.unexpected.length}x, never tapped again: ${cov.unexpected.slice(0, limit).map((x) => `"${x.label}"`).join('; ')}`);
  if (cov.failed.length) lines.push(`failed taps (${cov.failed.length}): ${cov.failed.slice(0, limit).map((x) => `"${x.label}" on ${x.screen}`).join('; ')}`);
  if (cov.frontier.length) lines.push(`frontier: ${cov.frontier.slice(0, limit).map((x) => `"${x.label}" on ${x.screen}`).join('; ')}${cov.frontier.length > limit ? ` … +${cov.frontier.length - limit}` : ''}`);
  if (cov.splits.length) lines.push(`suspected splits — one name, several identities (${cov.splits.length}): ${cov.splits.slice(0, limit).map((x) => `"${x.name}" ×${x.hashes.length}`).join('; ')}`);
  if (cov.merges.length) lines.push(`suspected merges — one identity, unlike contents (${cov.merges.length}): ${cov.merges.slice(0, limit).map((x) => `${x.hash.slice(0, 8)}${x.name ? ` "${x.name}"` : ''} (labels ${Math.round(x.similarity * 100)}% alike)`).join('; ')}`);
  if (!cov.splits.length && !cov.merges.length) lines.push('no suspected merges or splits');
  return lines.join('\n');
}
