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
/** The longest a crawl waits for an app to leave its launch screen. */
export const LAUNCH_CAP_MS = 10000;
export const STATE_VERSION = 1;
/**
 * Rows of one shape are opened until two of them land on the same screen (or
 * on screens of the same name): from then on the rest of that shape are rows
 * of a list and lead to the same kind of screen. A menu's rows look alike too,
 * and each of them goes somewhere different, which is why shape alone is not
 * the test. `LIST_CAP` stops a list whose rows each split into a new identity
 * (DEFERRED 174) from eating the budget.
 */
export const LIST_CAP = 24;
/** Two destinations whose structure is this alike are the same kind of screen. */
export const ALIKE = 0.8;

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
  // Symbols ("✕", "<") normalise to nothing, so an empty label would match
  // them: every unlabeled button was a "back" until this was checked.
  if (label && (w.rawBack.includes(label) || (alnum(label) && w.back.includes(alnum(label))))) return true;
  // A nav bar's leading button is a back button whatever it is called. iOS
  // labels it with the previous screen's title — "Settings" on every screen
  // under Settings — and RN apps name theirs after a testID
  // ("screen-toolbar-back-button"). Measured: before this, a crawl of Settings
  // took every screen's "Settings" button for a door and backed straight out
  // of each screen after one tap.
  // Unlabeled too: Ecotrak's back chevron has no accessibility label, and a
  // crawl that could not see it as a way back relaunched the app instead.
  if (row?.region === 'nav-bar' && row?.navSlot === 'leading' && /button/i.test(String(row.type ?? 'button'))) return true;
  return /(^|[-_ ])back([-_ ]|$)|header-back|toolbar-back/i.test(label);
}

/**
 * Does this reading look like somewhere an app has arrived: anything a person
 * could operate? A splash has text and nothing to operate. A
 * screen that is genuinely all text costs one capped wait, once per launch.
 */
export function placeLike(reading) {
  // By type only. Region is geometry: a splash's version string sits where a
  // tab bar would and was read as one, which called the splash "arrived".
  return (reading?.rows ?? []).some((r) => /button|cell|link|switch|tab|field|segment|search|slider|picker/i.test(String(r.type ?? '')));
}

/**
 * The dismiss button of a dialog on this screen, if one is up: a button whose
 * whole label declines (Cancel, Not Now…) with another button beside it on the
 * same line. Measured on Ecotrak: "Location Permission Disabled" sat over the
 * work-order list, the crawl tapped list rows behind it 7 times at ~13 s each,
 * and backed out with the nav-bar button underneath.
 */
export function dialogDismiss(rows, { locale } = {}) {
  const words = (vocabulary.load(locale).cartographer?.dismiss ?? []).map(alnum).filter(Boolean);
  // React Native draws a dialog's buttons as generic elements, not buttons.
  const buttons = (rows ?? []).filter((r) => /button|genericelement|other/i.test(String(r.type ?? ''))
    && (r.region ?? 'content') === 'content' && alnum(r.label));
  return buttons.find((b) => words.includes(alnum(b.label))
    && buttons.some((o) => o !== b && Math.abs((o.y ?? 0) - (b.y ?? 0)) <= 12)) ?? null;
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
  if (isBackAffordance(row, { locale })) return { open: false, reason: 'back affordance', kind: 'skipped' };
  if (!label || /^\(icon-only\)$/i.test(label)) return { open: false, reason: 'unlabeled', kind: 'skipped' };
  if (row.region === 'status-bar' || row.region === 'keyboard') return { open: false, reason: 'system chrome', kind: 'skipped' };
  if (row.region === 'nav-bar' && row.navSlot === 'title') return { open: false, reason: 'screen title', kind: 'skipped' };
  if (/^heading$/i.test(String(row.type ?? ''))) return { open: false, reason: 'heading', kind: 'skipped' };
  const barrier = vocabulary.mayActLocally(label, { locale, purpose: 'explore' });
  if (!barrier.allowed) return { open: false, reason: `${barrier.reason} ("${barrier.matched}")`, kind: 'barrier' };
  const w = words(locale);
  const links = vocabulary.load(locale).cartographer?.contactLinkPatterns ?? [];
  if (links.some((p) => new RegExp(p, 'i').test(label))) return { open: false, reason: 'a phone number, email or web address — it calls, mails or leaves', kind: 'barrier' };
  if (w.stateTypes.test(String(row.type ?? ''))) return { open: false, reason: `changes state (${row.type})`, kind: 'read-only' };
  if (row.enabled === false) return { open: false, reason: 'disabled', kind: 'skipped' };
  // Some controls write the moment they are tapped. Opting in to open forms
  // does not cover them: --allow-create opens forms and never commits, and
  // CHECK IN commits on the tap itself.
  const now_ = (vocabulary.load(locale).cartographer?.actsImmediately ?? []).find((p) => says(label, p));
  if (now_) return { open: false, reason: `writes when tapped ("${now_}")`, kind: 'barrier' };
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
  const skipped = [];
  const seenKeys = new Set();
  const ordered = [...(rows ?? [])].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  // A row that is selected marks a selection list, and choosing another of its
  // options changes a setting by itself — no Save, no write word on the label.
  // A dialog is up: everything behind it is out of reach, and what is in it
  // answers it. The way out is its dismiss button, which `back` takes.
  const dialog = dialogDismiss(ordered, { locale });
  if (dialog) {
    for (const row of ordered) {
      if (row === dialog || !row.label) continue;
      refused.push({ key: controlKey(row), label: row.label, reason: `behind or inside a dialog — dismissed with "${dialog.label}"`, kind: 'skipped-dialog' });
    }
    return { doors, refused: refused.filter((r) => r.kind !== 'skipped-dialog'), skipped: [], dialog };
  }
  const optionShapes = new Set(ordered.filter((r) => r.selected === true).map(shapeOf).filter(Boolean));
  // The accessibility tree is authoritative when it is describing this screen's
  // controls (CLAUDE.md's perception order). Then what it calls static text is
  // static, and tapping it costs a full no-change verification — 13-22 s each,
  // measured on Settings. Where the tree says nothing about controls (many RN
  // screens), text is all there is and stays a candidate.
  // A screen with a commit control is a form, and its rows are what the
  // commit would apply. Measured on Ecotrak: a filter sheet with RESET and
  // APPLY had its radio options tapped one after another — nothing applied,
  // but read-only means not editing a form either, and RN radios carry no
  // `selected` trait to warn by.
  const commits = vocabulary.load(locale).cartographer?.formCommit ?? [];
  const commit = allowCreate ? null : ordered.find((r) => /button/i.test(String(r.type ?? '')) && commits.some((w) => alnum(r.label) === alnum(w)));
  const lowest = Math.max(0, ...ordered.map((r) => (r.frame?.y ?? r.y ?? 0) + (r.frame?.height ?? 0)));
  const bottomBand = lowest * 0.88;
  const treeKnowsControls = ordered.some((r) => /ax/.test(String(r.source ?? '')) && /button|cell|link|switch|tab/i.test(String(r.type ?? '')));
  for (const row of ordered) {
    const key = controlKey(row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    // Text that only OCR sees, mid-screen, where the tree is describing the
    // controls: drawn text — a map's place names, a chart's labels. Ecotrak's
    // map put "Los Angeles" and street names in the door list at ~22 s a
    // no-change tap. The bottom band is spared: that app's tab bar is OCR-only.
    const ocrOnly = !/ax/.test(String(row.source ?? '')) && /^(text|statictext)?$/i.test(String(row.type ?? ''));
    const midScreen = (row.y ?? 0) < bottomBand;
    const verdict = treeKnowsControls && ((/ax/.test(String(row.source ?? '')) && /^(statictext|text|image)$/i.test(String(row.type ?? ''))) || (ocrOnly && midScreen))
      ? { open: false, reason: 'static text', kind: 'skipped' }
      : classify(row, { allowCreate, locale });
    if (!verdict.open) {
      if (verdict.kind !== 'skipped' || verdict.reason === 'unlabeled') refused.push({ key, label: row.label ?? null, reason: verdict.reason, kind: verdict.kind });
      else skipped.push(key);
      continue;
    }
    if (commit && (row.region ?? 'content') === 'content') {
      refused.push({ key, label: row.label ?? null, reason: `on a form committed by "${commit.label}" — read-only run`, kind: 'read-only' });
      continue;
    }
    const shape = shapeOf(row);
    if (shape && optionShapes.has(shape)) {
      refused.push({ key, label: row.label ?? null, reason: 'an option in a selection list — choosing it changes a setting', kind: 'read-only' });
      continue;
    }
    doors.push({ key, label: row.label, region: row.region ?? 'content', x: row.x, y: row.y, type: row.type ?? null, shape, strip: stripOf(row) });
  }
  // What the tree knows to be a control goes first; what only OCR saw, after.
  const known = (d) => (/button|cell|link|tab|genericelement|other/i.test(String(d.type ?? '')) ? 0 : 1);
  doors.sort((a, b) => known(a) - known(b));
  return { doors, refused, skipped };
}

/** What a row looks like, ignoring where it is in a column: its list identity. */
export function shapeOf(row) {
  if ((row?.region ?? 'content') !== 'content' || !(row?.frame?.width > 0)) return null;
  const w = Math.round(row.frame.width / 8);
  const h = Math.round((row.frame.height ?? 0) / 4);
  return `${row.type ?? ''}|${w}|${h}|${Math.round((row.x ?? 0) / 16)}`;
}

/** Controls of one size side by side in one row: a strip — days, chips, segments. */
export function stripOf(row) {
  if ((row?.region ?? 'content') !== 'content' || !(row?.frame?.width > 0)) return null;
  if (row.frame.width > 200) return null;
  return `${row.type ?? ''}|${Math.round(row.frame.width / 8)}|${Math.round((row.frame.height ?? 0) / 4)}|y${Math.round((row.y ?? 0) / 12)}`;
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

/** The last tokens seen for each screen, so a route can be asked by reading, not by bare hash. */
const seenTokens = new WeakMap();
const tokensFor = (state, hash) => seenTokens.get(state)?.get(hash) ?? [];
const asReading = (state, hash) => ({ hash, tokens: tokensFor(state, hash) });

/**
 * The screen a hash is, for the crawl. A tap that changes a screen in place —
 * a day picked in a week strip, a month flipped — can give it a new identity
 * (DEFERRED 174). Measured on Ecotrak's Track Time: 48 actions spent re-tapping
 * the same strip on what the crawl took for six new screens. Such a hash is an
 * alias of the screen it came from, and shares its doors.
 */
const canon = (state, hash) => {
  let h = hash;
  for (let i = 0; i < 8 && state.aliases?.[h]; i += 1) h = state.aliases[h];
  return h;
};

/** Doors two screens share, as a fraction of all their doors. */
export const SAME_DOORS = 0.7;

/**
 * A door's key with its numbers taken out, for comparing screens. A week strip
 * reads "MON, 14" one week and "MON, 28" the next, and Ecotrak's Track Time
 * paged back week after week as a new screen each time because of it.
 */
const shapeKey = (k) => String(k).replace(/\d+/g, '#');

function doorKeys(reading, opts) {
  return doorsOf(reading?.rows, opts).doors.filter((d) => d.region !== 'tab-bar').map((d) => shapeKey(d.key));
}

/**
 * The screen already in the map that this reading is, by its doors. Structure
 * and names both failed on Ecotrak's Track Time — seven identities, no name,
 * too few shared tokens — while every one of them carried the same controls.
 * What a person can do on a screen is what the crawl cares about, so a reading
 * whose doors are mostly an existing screen's doors is that screen.
 */
function sameDoorsAs(state, reading, opts) {
  const mine = doorKeys(reading, opts);
  if (mine.length < 3) return null;
  let best = null;
  for (const [hash, sc] of Object.entries(state.screens)) {
    const theirs = Object.entries(sc.controls).filter(([, c]) => c.region !== 'tab-bar').map(([k]) => shapeKey(k));
    if (theirs.length < 3) continue;
    const j = jaccard(mine, theirs);
    if (j >= SAME_DOORS && (!best || j > best.j)) best = { hash, j };
  }
  return best?.hash ?? null;
}

function register(state, reading, opts) {
  if (!reading?.hash) return null;
  if (!state.screens[canon(state, reading.hash)]) {
    const same = sameDoorsAs(state, reading, opts);
    if (same && same !== reading.hash) (state.aliases ??= {})[reading.hash] = same;
  }
  if (canon(state, reading.hash) !== reading.hash) return registerAs(state, { ...reading, hash: canon(state, reading.hash) }, opts);
  return registerAs(state, reading, opts);
}

function registerAs(state, reading, { allowCreate, locale, via = null }) {
  if (!seenTokens.has(state)) seenTokens.set(state, new Map());
  if (reading.tokens?.length) seenTokens.get(state).set(reading.hash, reading.tokens);
  let s = state.screens[reading.hash];
  if (!s) {
    s = state.screens[reading.hash] = { name: reading.name ?? null, firstSeen: Date.now(), via, samples: [], controls: {} };
  }
  if (!s.name && reading.name) s.name = reading.name;
  const sig = labelSig(reading.rows);
  if (s.samples.length < 4 && !s.samples.some((x) => jaccard(x, sig) > 0.9)) s.samples.push(sig);
  const { doors, refused, skipped } = doorsOf(reading.rows, { allowCreate, locale });
  for (const k of skipped) if (s.controls[k]?.status === 'pending') s.controls[k].status = 'skipped';
  for (const d of doors) {
    if (d.region === 'tab-bar') {
      // A tab is the same door on every screen that shows the bar.
      if (state.chrome[d.key]) continue;
      state.chrome[d.key] = { label: d.label, status: 'pending', from: reading.hash };
    }
    if (!s.controls[d.key]) s.controls[d.key] = { label: d.label, region: d.region, status: 'pending', ...(d.shape ? { shape: d.shape } : {}), ...(d.strip ? { strip: d.strip } : {}) };
  }
  for (const r of refused) {
    // A door saved by an earlier run, refused by today's rules: refused.
    if (s.controls[r.key]?.status === 'pending') s.controls[r.key].status = 'refused';
    const k = `${r.label ?? '(unlabeled)'}|${r.reason}`;
    state.refused[k] ??= { label: r.label, reason: r.reason, kind: r.kind, screens: [] };
    if (!state.refused[k].screens.includes(reading.hash)) state.refused[k].screens.push(reading.hash);
  }
  return s;
}

function pendingOn(state, hash0) {
  const hash = canon(state, hash0);
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
function sampleList(state, hash0, key) {
  const controls = state.screens[canon(state, hash0)]?.controls ?? {};
  const shape = controls[key]?.shape;
  const strip = controls[key]?.strip;
  if (!shape && !strip) return;
  const same = Object.values(controls).filter((c) => (shape && c.shape === shape) || (strip && c.strip === strip));
  // One in-place change in a group is enough: the rest of a day strip or a
  // set of filter chips change the same screen the same way.
  // Two of a group that did nothing visible: the rest of it will not either,
  // and each costs a full no-change verification.
  if (same.some((c) => c.status === 'in-place') || same.filter((c) => c.status === 'no-change').length >= 2) {
    for (const c of same) if (c.status === 'pending') c.status = 'sampled';
    return;
  }
  const opened = same.filter((c) => c.status === 'explored');
  const dests = opened.map((c) => c.to);
  const names = opened.map((c) => c.toName).filter(Boolean).map(alnum);
  // Alike by structure too: a list's detail screens may each get an identity
  // of their own (DEFERRED 174), and a name is not always there to say so.
  const alike = dests.some((a, i) => dests.some((b, j) => j > i && a !== b
    && tokensFor(state, a).length && jaccard(tokensFor(state, a), tokensFor(state, b)) >= ALIKE));
  const repeat = new Set(dests).size < dests.length || new Set(names).size < names.length || alike;
  if (!repeat && opened.length < LIST_CAP) return;
  for (const c of same) if (c.status === 'pending') { c.status = 'sampled'; }
}

function mark(state, hash0, key, patch) {
  const hash = canon(state, hash0);
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

  // An app's launch screen is still and has no doors: a splash, a version
  // string, a spinner that is not moving. It is not a place. Measured on the
  // Ecotrak app: the crawl tapped "Build 260902314" on its splash just as the
  // JavaScript finished loading, and recorded the sign-in screen as where that
  // tap leads. So after a launch, a screen with no doors is read again until it
  // gives way, for at most LAUNCH_CAP_MS — CLAUDE.md's hard cap on any wait.
  const arrive = async (r) => {
    const t = now();
    let cur = r;
    // A reading with no identity is a screen not yet drawn — a black frame
    // mid-launch — and is waited on like a splash. Returning it at once made a
    // crawl of Ecotrak record zero screens and report "nothing reachable".
    const waiting = (x) => !x?.hash || (!didNotStart(x, { locale }) && !placeLike(x));
    while (waiting(cur) && now() - t < LAUNCH_CAP_MS) {
      const next = await driver.read();
      cur = next ?? cur;
    }
    // Still nothing to operate at the cap: the app has not finished launching,
    // and its launch screen must not be crawled as though it were the app.
    if (waiting(cur)) return { ...(cur ?? {}), rows: cur?.rows ?? [], notArrived: true };
    return cur;
  };
  // Back in front without restarting: what leaving the app needs.
  const foreground = async () => {
    act();
    const r = await arrive(await driver.launch({ relaunch: false }));
    return r?.notArrived ? { ...r, rows: [] } : r;
  };
  // Out of a dead end: the graph's own way home first, a restart last, and a
  // restart only when it is safe. A restart of a debug build whose JavaScript
  // came from a packager that has since stopped leaves the app on an error
  // screen with the signed-in session unusable — measured on a real device on
  // 2026-10-01, by this crawler, before this existed.
  const recover = async (here) => {
    if (root && here?.hash && canon(state, here.hash) !== root) {
      const r = driver.route(here, asReading(state, root));
      if (r?.length) {
        const walked = await driver.walk(r);
        for (let i = 0; i < (walked?.steps ?? 0); i += 1) act();
        const after = walked?.after ?? await driver.read();
        if (after?.hash && (after.hash === root || await driver.sameScreen({ hash: root, tokens: [] }, after))) return after;
      }
    }
    // Relaunching from the start screen can only return to it.
    if (root && here?.hash && canon(state, here.hash) === root) return { stop: 'nothing reachable left to open', done: true };
    // A tabbed app has a way home that costs one tap: the tab the start
    // screen showed in its bottom band. Ecotrak's tab bar is OCR-only text, so
    // it is matched by label and position, not by region. Relaunching that app
    // takes 9-16 s, past the 10 s cap, and ended two crawls.
    if (rootTabs.length && here?.rows) {
      const lowest = Math.max(0, ...here.rows.map((r) => r.y ?? 0));
      const tab = here.rows.find((r) => (r.y ?? 0) >= lowest - 30 && rootTabs.includes(alnum(r.label)));
      if (tab) {
        const res = await driver.tap({ key: controlKey(tab), label: tab.label, x: tab.x, y: tab.y, region: tab.region }, here);
        act();
        const after = await driver.read();
        if (res?.ok !== false && after?.hash && (canon(state, after.hash) === root || await driver.sameScreen({ hash: root, tokens: tokensFor(state, root) }, after))) return after;
      }
    }
    const blocked = await driver.relaunchBlocked?.();
    if (blocked) return { stop: `stuck${here?.name ? ` on "${here.name}"` : ''}, and relaunching is not safe: ${blocked}`, blocked: true };
    run.relaunches += 1;
    act();
    const r = await arrive(await driver.launch({ relaunch: true }));
    const dead = didNotStart(r, { locale });
    if (dead) return { stop: `the app did not start after a relaunch: "${dead}"`, failed: true };
    if (r?.notArrived) return { stop: `after a relaunch the app did not finish launching within ${LAUNCH_CAP_MS / 1000} s`, blocked: true };
    return r;
  };

  // Start where the app is: brought forward, never restarted. Restarting to
  // root the map at the app's own start screen was tried and measured: a warm
  // restart of the Ecotrak debug build took more than the 10 s cap to become
  // operable, so the crawl failed before it began. Leave the app on its start
  // screen before mapping it.
  let reading = await arrive(await driver.launch({ relaunch: false }));
  act();
  {
    const dead = didNotStart(reading, { locale });
    if (dead || reading?.notArrived) {
      run.stoppedBecause = dead
        ? `the app is not running: "${dead}"`
        : `the app did not finish launching within ${LAUNCH_CAP_MS / 1000} s — it is still on a screen with nothing to operate`;
      run.failed = true;
      run.endedAt = now();
      persist(state);
      return state;
    }
  }
  let root = reading?.hash ?? null;
  // The start screen's bottom band, by label: the tab that leads home.
  const tabsOf = (r) => {
    const lowest = Math.max(0, ...(r?.rows ?? []).map((x) => x.y ?? 0));
    return (r?.rows ?? []).filter((x) => (x.y ?? 0) >= lowest - 30 && alnum(x.label)).map((x) => alnum(x.label));
  };
  const homeWords = (vocabulary.load(locale).cartographer?.homeTabs ?? []).map(alnum);
  let rootTabs = tabsOf(reading).filter((l) => homeWords.includes(l));
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
      // Where the control is now, not where it was when it was first seen.
      const row = (here.rows ?? []).find((r) => controlKey(r) === door.key);
      // The screen may have moved on its own since it was read (a list
      // arriving, a splash giving way). A tap is only attributed to what it was
      // aimed at if the screen is still the one that was read.
      if (driver.stillHere && !(await driver.stillHere(here))) {
        reading = await driver.read();
        register(state, reading, { allowCreate, locale });
        continue;
      }
      if (!row) {
        mark(state, here.hash, door.key, { status: 'not-on-screen' });
        continue;
      }
      const res = await driver.tap({ ...door, x: row.x, y: row.y }, before);
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
          const shape = state.screens[canon(state, before.hash)]?.controls?.[door.key]?.shape;
          for (const c of Object.values(state.screens[canon(state, before.hash)]?.controls ?? {})) {
            if (shape && c.shape === shape && c.status === 'pending') c.status = 'refused-after-change';
          }
        } else if (!/^unexpected/.test(res?.verdict ?? '')) {
          mark(state, before.hash, door.key, { status: 'no-change' });
          sampleList(state, before.hash, door.key);
        }
        reading = reading?.hash ? reading : before;
        continue;
      }
      // The same screen with a new face: an alias, not a new place.
      const beforeName = state.screens[canon(state, before.hash)]?.name ?? before.name ?? null;
      const unknown = !state.screens[canon(state, reading.hash)];
      const sameDoors = unknown ? sameDoorsAs(state, reading, { allowCreate, locale }) : null;
      const inPlace = (unknown && (
        (beforeName && reading.name && alnum(beforeName) === alnum(reading.name))
        || (before.tokens?.length && reading.tokens?.length && jaccard(before.tokens, reading.tokens) >= ALIKE)))
        || (sameDoors && canon(state, sameDoors) === canon(state, before.hash));
      if (inPlace) {
        (state.aliases ??= {})[reading.hash] = canon(state, before.hash);
        if (!/^unexpected/.test(res?.verdict ?? '')) mark(state, before.hash, door.key, { status: 'in-place', to: reading.hash });
        register(state, reading, { allowCreate, locale });
        sampleList(state, before.hash, door.key);
        continue;
      }
      // A row that sends you back to the screen you came from was an option
      // being chosen (a picker), not a door. One is enough: the rest of that
      // list would each choose something else.
      const via = state.screens[canon(state, before.hash)]?.via;
      const cameFrom = via?.from;
      // The same control that opened this screen closes it: a toggle, which is
      // a way back, not an option chosen.
      if (cameFrom && via.label && alnum(via.label) === alnum(door.label) && canon(state, reading.hash) === canon(state, cameFrom)) {
        mark(state, before.hash, door.key, { status: 'toggle', to: reading.hash });
        register(state, reading, { allowCreate, locale });
        continue;
      }
      if (door.region === 'content' && cameFrom && canon(state, reading.hash) === canon(state, cameFrom)) {
        mark(state, before.hash, door.key, { status: 'picked', to: reading.hash });
        (state.picked ??= []).push({ at: now(), screen: before.name ?? before.hash, label: door.label });
        const ctl = state.screens[canon(state, before.hash)]?.controls ?? {};
        const shape = ctl[door.key]?.shape;
        for (const c of Object.values(ctl)) if (shape && c.shape === shape && c.status === 'pending') c.status = 'sampled';
        register(state, reading, { allowCreate, locale });
        continue;
      }
      if (!/^unexpected/.test(res?.verdict ?? '')) mark(state, before.hash, door.key, { status: 'explored', to: reading.hash, toName: reading.name ?? null });
      const fresh = !state.screens[canon(state, reading.hash)];
      register(state, reading, { allowCreate, locale, via: { from: before.hash, label: door.label } });
      sampleList(state, before.hash, door.key);
      if (fresh) run.newScreens += 1;
      continue;
    }

    // Nothing left here. Back out, the app's own way first — except from the
    // start screen, where there is nowhere to go back to and a "back" is a
    // wasted tap on whatever sits in the nav bar's leading slot.
    // A dialog is dismissed wherever it is, the start screen included — a crawl
    // that began under one called the dialog the app and stopped.
    const underDialog = Boolean(dialogDismiss(here.rows, { locale }));
    const back = canon(state, here.hash) === root && !underDialog ? null : await driver.back(here);
    if (back?.acted) {
      act();
      const after = back.after ?? await driver.read();
      if (after?.hash && !(await driver.sameScreen(here, after))) {
        // The start screen was a dialog over the app: the app is the start.
        if (underDialog && canon(state, here.hash) === root) root = canon(state, after.hash);
        reading = after;
        register(state, reading, { allowCreate, locale });
        continue;
      }
    }
    // Then the graph's own path to the nearest screen that still has doors.
    const targets = Object.keys(state.screens).filter((h) => h !== canon(state, here.hash) && pendingOn(state, h) && (unreachable.get(h) ?? 0) < 2);
    let best = null;
    // A walk is verified step by step and stops on a wrong turn, like `goto`.
    // What the barrier forbids is acting again on what went wrong before, so
    // a route through any edge this crawl saw land somewhere unexpected is not
    // taken. An edge whose destination merely drifted (`changedOutcomes`) is
    // identity churn, not a wrong turn, and refusing those stranded a crawl of
    // Settings in a relaunch loop: 28 relaunches, nothing opened.
    const tainted = new Set(state.unexpected.map((u) => `${u.from}|${alnum(u.label)}`));
    const clean = (route) => route.every((e, i) => {
      const from = i === 0 ? here.hash : route[i - 1].to;
      return !tainted.has(`${from}|${alnum(String(e.action ?? '').split(':').slice(1).join(':'))}`);
    });
    for (const h of targets) {
      const r = driver.route(here, asReading(state, h));
      if (r && r.length && clean(r) && (!best || r.length < best.route.length)) best = { hash: h, route: r };
    }
    if (best) {
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
    if (home?.done) {
      const left = Object.values(state.screens).reduce((n, sc) => n + Object.values(sc.controls).filter((c) => c.status === 'pending').length, 0);
      run.stoppedBecause = left ? `${left} door(s) are left on screens no known path reaches from the start screen` : home.stop;
      break;
    }
    if (home?.stop) {
      run.stoppedBecause = home.stop;
      if (home.failed) run.failed = true;
      if (home.blocked) run.blocked = true;
      break;
    }
    register(state, home, { allowCreate, locale });
    if (!pendingOn(state, home.hash) && !targets.some((h) => driver.route(home, asReading(state, h))?.length)) {
      const left = Object.values(state.screens).reduce((n, sc) => n + Object.values(sc.controls).filter((c) => c.status === 'pending').length, 0);
      run.stoppedBecause = left
        ? `${left} door(s) are left on screens no known path reaches from the start screen`
        : 'nothing reachable left to open';
      reading = home;
      break;
    }
    reading = home;
  }
  run.attempts += inAttempt ? 1 : 0;
  // A crawl that mapped nothing did not succeed, whatever stopped it — and a
  // start screen with no transition out of it is nothing mapped.
  const transitions = Object.values(state.screens).reduce((n, sc) => n + Object.values(sc.controls).filter((c) => c.status === 'explored').length, 0);
  if (!run.failed && (!Object.keys(state.screens).length || (!transitions && !run.blocked))) {
    run.failed = true;
    run.stoppedBecause = Object.keys(state.screens).length
      ? `no transition was recorded: nothing on the start screen could be opened (${run.stoppedBecause ?? 'stopped'})`
      : `no screen was identified (${run.stoppedBecause ?? 'stopped'})`;
  }
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
    inPlace: by('in-place').length,
    aliases: Object.keys(state.aliases ?? {}).length,
    frontier: by('pending').map((c) => ({ screen: c.screen ?? c.hash.slice(0, 8), label: c.label })),
    failed: by('failed').map((c) => ({ screen: c.screen ?? c.hash.slice(0, 8), label: c.label, detail: c.detail })),
    refused: Object.values(state.refused).map((r) => ({ label: r.label, reason: r.reason, kind: r.kind, screens: r.screens.length })),
    leftApp: state.leftApp,
    picked: state.picked ?? [],
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
  if (cov.picked.length) lines.push(`picked an option ${cov.picked.length}x (the tap returned to the previous screen, so the rest of that list was not opened): ${cov.picked.slice(0, limit).map((x) => `"${x.label}" on ${x.screen}`).join('; ')}`);
  if (cov.inPlace) lines.push(`${cov.inPlace} tap(s) changed a screen in place`);
  if (cov.aliases) lines.push(`${cov.aliases} identity(ies) were a screen already mapped, with a new face — splits for DEFERRED 174`);
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
