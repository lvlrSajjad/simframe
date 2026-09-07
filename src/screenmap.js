// Muscle memory.
//
// A person does not re-read a screen they have seen before; they remember where
// things are. Screens repeat constantly while driving an app, and simframe
// already computes a stable hash per screen, so that hash is the natural key for
// "what is tappable here". First visit pays for a tree read and an OCR pass;
// every later visit is a file read.
import fs from 'node:fs';
import path from 'node:path';
import { hashDistance } from './analyze.js';
import * as control from './control.js';
import * as input from './input.js';
import * as ocr from './ocr.js';
import * as store from './store.js';

const MAP_VERSION = 2; // layout hash crop changed; old maps no longer comparable

function mapDir(udid) {
  return path.join(store.deviceDir(udid), 'screens');
}

/**
 * How many of the 288 layout bits may differ and still count as the same screen.
 * Measured on a real app: revisiting a screen (with different list rows and a
 * different clock) moved 0-3 bits; different screens were 77-96 apart. 12 sits
 * well clear of both.
 */
export const DEFAULT_TOLERANCE = 12;

export function recall(udid, hash) {
  if (!hash) return null;
  const entry = store.readJson(path.join(mapDir(udid), `${hash}.json`));
  return entry && entry.version === MAP_VERSION ? entry : null;
}

function loadAll(udid) {
  let files;
  try {
    files = fs.readdirSync(mapDir(udid)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => store.readJson(path.join(mapDir(udid), f)))
    .filter((e) => e && e.version === MAP_VERSION);
}

/**
 * The closest screen we have seen, by layout rather than by content. A list with
 * new rows in it is still the same screen, and should not cost another map build.
 */
export function recallNearest(udid, layoutHash, { tolerance = DEFAULT_TOLERANCE } = {}) {
  if (!layoutHash) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const entry of loadAll(udid)) {
    const d = hashDistance(entry.layoutHash, layoutHash);
    if (d < bestDistance) {
      bestDistance = d;
      best = entry;
    }
  }
  return best && bestDistance <= tolerance ? { entry: best, distance: bestDistance } : null;
}

export function remember(udid, entry) {
  const dir = mapDir(udid);
  fs.mkdirSync(dir, { recursive: true });
  store.writeAtomic(path.join(dir, `${entry.hash}.json`), JSON.stringify(entry));
  return entry;
}

export function stats(udid) {
  try {
    const files = fs.readdirSync(mapDir(udid)).filter((f) => f.endsWith('.json'));
    return { screens: files.length };
  } catch {
    return { screens: 0 };
  }
}

export function forget(udid) {
  try {
    fs.rmSync(mapDir(udid), { recursive: true, force: true });
  } catch {
    /* nothing to forget */
  }
}

const inside = (point, frame) =>
  point.x >= frame.x &&
  point.x <= frame.x + frame.width &&
  point.y >= frame.y &&
  point.y <= frame.y + frame.height;

/**
 * Build the map for the screen currently showing. Accessibility elements are the
 * real hit targets, so they win where they exist; OCR fills in everything the
 * app never published — custom tab bars, unlabelled controls, plain text.
 */
export async function build(udid, {
  hash,
  layoutHash,
  fullFrame,
  density = 3,
  useAx = true,
  useOcr = true,
  persist = true,
  screen,
} = {}) {
  const targets = [];
  const sources = [];
  // OCR starts before the tree read: they are independent, and running them in
  // series costs the whole recognition pass.
  //
  // The daemon reads text straight off the framebuffer. The fallback encodes a
  // PNG, writes it, spawns a helper and decodes it again — measured at 555ms
  // against 174ms — so it is only used when no daemon is listening.
  const viaDaemon = useOcr && control.available(udid);
  const ocrPromise = !useOcr
    ? null
    : viaDaemon
      ? control.request(udid, { action: 'ui' }).catch((err) => err)
      : fullFrame && fs.existsSync(fullFrame)
        ? ocr.readText(fullFrame, { density }).catch((err) => err)
        : null;
  // With no geometry, treat every element as a potential control rather than
  // guessing a screen size and mis-classifying containers.
  const screenArea = screen?.width && screen?.height ? screen.width * screen.height : Infinity;
  const area = (f) => (f ? Math.max(1, f.width) * Math.max(1, f.height) : Infinity);
  // A root or full-bleed container is never what someone means by a label, and
  // it contains every other element, so it must not swallow their text.
  const isContainer = (n) =>
    /^Application$/i.test(n.type || '') || area(n.frame) > screenArea * 0.7;

  if (useAx) {
    try {
      const nodes = await input.describeAll(udid);
      sources.push('ax');
      for (const n of nodes) {
        if (!n.frame || !n.label || isContainer(n)) continue;
        targets.push({
          label: n.label,
          x: input.centerOf(n).x,
          y: input.centerOf(n).y,
          frame: n.frame,
          type: n.type,
          enabled: n.enabled,
          source: 'ax',
        });
      }
    } catch {
      /* no idb, or the tree read failed; OCR alone is still useful */
    }
  }

  if (ocrPromise) {
    try {
      const result = await ocrPromise;
      if (result instanceof Error) throw result;
      // The daemon answers in points; readText answers in points too, having
      // divided by density. Normalise the daemon's element shape to match.
      const words = viaDaemon
        ? (result.screen?.elements ?? [])
            .filter((e) => e.label?.trim())
            .map((e) => ({
              text: e.label,
              confidence: e.confidence,
              x: e.frame.x,
              y: e.frame.y,
              width: e.frame.width,
              height: e.frame.height,
              centerX: e.center.x,
              centerY: e.center.y,
            }))
        : result;
      sources.push('ocr');
      for (const w of words) {
        if (!w.text.trim()) continue;
        const point = { x: w.centerX, y: w.centerY };
        // If an accessibility element already covers this text, it is the same
        // control: keep the element and record the visible text as an alias.
        // Containing text is not the same as being that control. A tab bar
        // encloses all five tab labels but is not any of them, so only merge
        // when the element is close to the text's own size.
        const textArea = Math.max(1, w.width * w.height);
        const covering = targets
          .filter(
            (t) =>
              t.source === 'ax' &&
              t.frame &&
              inside(point, t.frame) &&
              !/^(Group|Application|ScrollView|Table|Collection)$/i.test(t.type || '') &&
              area(t.frame) <= textArea * 8,
          )
          .sort((a, b) => area(a.frame) - area(b.frame))[0];
        if (covering) {
          covering.aliases = [...(covering.aliases || []), w.text];
          continue;
        }
        targets.push({
          label: w.text,
          x: w.centerX,
          y: w.centerY,
          frame: { x: w.x, y: w.y, width: w.width, height: w.height },
          type: 'Text',
          confidence: w.confidence,
          source: 'ocr',
        });
      }
    } catch (err) {
      if (!sources.length) throw err;
    }
  }

  return finish();

  function finish() {
    const entry = {
      version: MAP_VERSION,
      hash,
      layoutHash,
      at: Date.now(),
      sources,
      targets,
    };
    // Only a map of a settled screen is worth keeping; remembering a transition
    // fills the store with layouts that will never be seen again.
    return persist ? remember(udid, entry) : entry;
  }
}

const norm = (s) => String(s ?? '').toLowerCase().trim();

const INTERACTIVE = /button|field|cell|link|checkbox|switch|slider|tab|menu|segment/i;

export function isInteractive(target) {
  return INTERACTIVE.test(target.type || '');
}

/**
 * Rank candidates for a label. Exact beats substring, and a real control beats
 * a caption that happens to read the same — a screen title and a tab are often
 * the same word, and tapping the title silently does nothing.
 */
export function rank(entry, query) {
  if (!entry) return [];
  const q = norm(query);
  const names = (t) => [t.label, ...(t.aliases || [])].map(norm);
  const exact = entry.targets.filter((t) => names(t).includes(q));
  const pool = exact.length
    ? exact
    : entry.targets.filter((t) => names(t).some((n) => n.includes(q)));
  return pool
    .map((t) => ({ target: t, score: (isInteractive(t) ? 2 : 0) + (t.source === 'ax' ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.target);
}

export function match(entry, query) {
  return rank(entry, query)[0] ?? null;
}
