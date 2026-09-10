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
import * as fingerprint from './fingerprint.js';
import * as input from './input.js';
import * as ocr from './ocr.js';
import * as matching from './matching.js';
import * as regions from './regions.js';
import { informative } from './refs.js';
import * as store from './store.js';

const MAP_VERSION = 9; // ax targets carry value, selected and focused

/**
 * A stored map also holds a `structuralHash`, which the *fingerprint* rules
 * produced. So a token-rule change invalidates every stored map, and relying on
 * someone to remember to bump `MAP_VERSION` too is exactly how the phantom
 * keyboard survived a fix: two copies of one dependency, one of them updated.
 *
 * Stating the dependency instead of remembering it. A map is only valid for the
 * token rules that hashed it.
 */
const usable = (e) => Boolean(e)
  && e.version === MAP_VERSION
  && e.fingerprintVersion === fingerprint.TOKEN_RULES_VERSION;

function mapDir(udid) {
  return path.join(store.deviceDir(udid), 'screens');
}

/**
 * How many of the 288 layout bits may differ and still count as the same screen.
 *
 * Re-measured across four visits to each of five screens: a revisit is usually
 * identical (median 0) but the tail reaches 62 when list content has changed,
 * while different screens sit at 74 and above. That margin is much narrower
 * than the first calibration suggested, and it is the reason this number stays
 * conservative rather than being raised to cover the tail.
 *
 * The consequence is deliberate: a heavily changed screen is rebuilt rather
 * than recognised. A rebuild costs ~300ms; a false match taps the wrong
 * control. See docs/DEFERRED.md on fingerprinting structure instead of pixels.
 */
export const DEFAULT_TOLERANCE = 20;

export function recall(udid, hash) {
  if (!hash) return null;
  const entry = store.readJson(path.join(mapDir(udid), `${hash}.json`));
  return usable(entry) ? entry : null;
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
    .filter(usable);
}

/**
 * The closest screen we have seen, by layout rather than by content. A list with
 * new rows in it is still the same screen, and should not cost another map build.
 */
export function recallNearest(udid, layoutHash, { tolerance = DEFAULT_TOLERANCE } = {}) {
  if (!layoutHash) return null;
  // A hash of almost no set bits is a dark or uniform screen, and two of them
  // are within any tolerance of each other while being evidence of nothing.
  // `refs.js` documents this and guards for it; this function fed that one's
  // `screenKnown` and `structuralHash` inputs without a guard of its own, so a
  // near-uniform screen could hand back a different screen's element map.
  if (!informative(layoutHash)) return null;
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
  // Why a layer is missing, kept rather than swallowed.
  //
  // A partial map used to be indistinguishable from a whole one: `sources` said
  // ["ax"] and nothing said why OCR was not there. On CI this produced a map
  // with zero elements reported as a successful read, and the only way to find
  // out what had happened was to guess. Before the tree came in-process the
  // same failure was loud, because with no idb the ax layer failed too and an
  // empty `sources` rethrew — so making a layer work turned a loud failure into
  // a quiet one.
  const degraded = [];
  // One round trip for both, because the daemon runs the tree read and the
  // recognition pass concurrently against the same instant of the screen. Asked
  // separately they would queue: the control socket serves one request at a
  // time, so a second call pays the first one's latency before it starts.
  //
  // The daemon reads text straight off the framebuffer. The fallback encodes a
  // PNG, writes it, spawns a helper and decodes it again — measured at 555ms
  // against 174ms — so it is only used when no daemon is listening.
  const viaDaemon = (useOcr || useAx) && control.available(udid);
  const axViaDaemon = useAx && process.env.SIMFRAME_AX_DRIVER !== 'idb';
  const daemonPromise = viaDaemon
    ? control.request(udid, { action: 'ui', ax: axViaDaemon, ocr: useOcr }).catch((err) => err)
    : null;
  const ocrPromise = !useOcr || viaDaemon
    ? null
    : fullFrame && fs.existsSync(fullFrame)
      ? ocr.readText(fullFrame, { density }).catch((err) => err)
      : null;
  const daemonAnswer = daemonPromise ? await daemonPromise : null;
  // Keep the failure rather than flattening it to null. A daemon that was
  // listening and then did not answer is a loud failure, and the version of
  // this that dropped it returned an empty map with no error — which `persist`
  // then wrote into screen memory, so a later warm visit read the emptiness
  // back instead of perceiving the screen again.
  const daemonError = daemonAnswer instanceof Error ? daemonAnswer : null;
  const daemonScreen = daemonError ? null : daemonAnswer?.screen ?? null;
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
      // The tree is already in hand when the daemon answered; describeAll would
      // only ask for it a second time.
      const nodes = daemonScreen?.sources?.includes('ax')
        ? daemonScreen.elements.filter((e) => e.source?.includes('ax')).map(input.elementToNode)
        : await input.describeAll(udid);

      sources.push('ax');
      for (const n of nodes) {
        if (!n.frame || !n.label || isContainer(n)) continue;
        targets.push({
          label: n.label,
          // What the control *contains*, whether it is on, and whether it has
          // focus. All three come off the accessibility tree, the daemon has
          // asked for all three since 0.6.0, and all three were dropped before
          // this — `value` here and the other two one layer up in
          // `normalizeNode` — so nothing above this line ever saw them.
          //
          // The cost was not theoretical. A real session could not verify the
          // contents of a text field at all: they reached a row only as the OCR
          // alias, which made them as old as the map and unauthoritative. An
          // assert failed against a field that did contain the string, the
          // operator retyped, and the field ended up with a doubled value and a
          // validation error.
          //
          // `focused` is worth naming separately: it is a direct answer to "did
          // this field take focus", which the focus wait in actions.js infers
          // from elapsed time because it had nothing better to use.
          value: n.value ?? undefined,
          x: input.centerOf(n).x,
          y: input.centerOf(n).y,
          frame: n.frame,
          type: n.type,
          enabled: n.enabled,
          selected: n.selected ?? undefined,
          focused: n.focused ?? undefined,
          source: 'ax',
        });
      }
    } catch (err) {
      /* no idb, or the tree read failed; OCR alone is still useful */
      degraded.push(`accessibility: ${err.message}`);
    }
  }

  // Neither layer was even attempted: nothing below can report the failure, so
  // it has to be reported here rather than returned as an empty screen.
  if (daemonError && !useOcr) throw daemonError;

  if (ocrPromise || (useOcr && viaDaemon)) {
    try {
      const result = ocrPromise ? await ocrPromise : (daemonError ?? daemonScreen);
      if (result instanceof Error) throw result;
      if (!result) throw new Error('the daemon did not answer');
      // A daemon that answered without reading text is not an OCR source, and
      // saying it was would claim the screen had been read when it had not.
      if (viaDaemon && !result.sources?.includes('ocr')) throw new Error(result.ocrError ?? 'no text was read');
      // The daemon answers in points; readText answers in points too, having
      // divided by density. Normalise the daemon's element shape to match.
      const words = viaDaemon
        ? (result.elements ?? [])
            .filter((e) => e.source?.includes('ocr') && e.label?.trim())
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
        //
        // Two rules, and the second one cost 16 escalations and half of
        // HPI_accuracy. The first is a size test: an element close to the
        // text's own size, containing it, is that text. It exists to stop a
        // tab bar from swallowing all five of its tab labels — containing text
        // is not the same as being that control.
        //
        // But a full-width list row is 19× the area of the words printed in
        // it, so the size test could never fire for the shape it matters most
        // on: every Contacts and Settings row arrived as an ax element AND as
        // an OCR text box, both scoring 1.00 for the same query, and `tap
        // "Kate Bell"` refused as ambiguous on all five runs of the
        // instrumented flow suite. The second rule is the one the size test
        // was standing in for: near-total containment AND the same text. A tab
        // bar contains "Assets" but is not labelled "Assets", so it is still
        // refused; a row labelled "Kate Bell" containing OCR's "Kate Bell" is
        // one element that two sensors saw.
        const textArea = Math.max(1, w.width * w.height);
        const box = { x: w.x, y: w.y, width: w.width, height: w.height };
        const eligible = (t) =>
          matching.isAxTarget(t) &&
          t.frame &&
          !/^(Group|Application|ScrollView|Table|Collection)$/i.test(t.type || '');
        const covering = targets
          .filter((t) => eligible(t) && inside(point, t.frame) && area(t.frame) <= textArea * 8)
          .sort((a, b) => area(a.frame) - area(b.frame))[0]
          ?? targets
            .filter((t) => eligible(t) && matching.sameElementSeenTwice(t, { ...w, frame: box, label: w.text }))
            .sort((a, b) => area(a.frame) - area(b.frame))[0];
        if (covering) {
          covering.aliases = [...(covering.aliases || []), w.text];
          // Keep the ax role and frame — it is the hit target — and record that
          // both sensors saw it. Anything asking "is this the tree's element?"
          // must ask matching.isAxTarget, not `=== 'ax'`.
          if (!String(covering.source ?? '').includes('ocr')) {
            covering.source = `${covering.source ?? 'ax'}|ocr`;
          }
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
      degraded.push(`text recognition: ${err.message}`);
      if (!sources.length) throw err;
    }
  }

  return finish();

  function finish() {
    // Region priors are geometry, so they cost nothing and disambiguate a great
    // deal: "Assets" the nav title and "Assets" the tab differ only by where
    // they are.
    if (screen?.width && screen?.height) regions.annotate(targets, screen);
    // Two hashes, two jobs. The pixel layout hash indexes this entry, because
    // it can be computed from a frame alone and so can find a map without
    // building one. The structural hash identifies the screen, because content
    // is pixels and a list with new rows is not a new screen.
    const structure = screen?.width && screen?.height
      ? fingerprint.fingerprint(targets, screen)
      : { hash: null, tokens: [], keyboard: false };
    const entry = {
      version: MAP_VERSION,
      fingerprintVersion: fingerprint.TOKEN_RULES_VERSION,
      hash,
      layoutHash,
      structuralHash: structure.hash,
      structuralTokens: structure.tokens,
      keyboard: structure.keyboard,
      at: Date.now(),
      sources,
      targets,
    };
    // A truncated tree is nodes without authority; the daemon says so and the
    // map has to carry it, because this is what gets written into memory.
    if (daemonScreen?.axTruncated) degraded.push(`accessibility tree cut short: ${daemonScreen.axTruncated}`);
    if (degraded.length) entry.degraded = degraded;
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
    .map((t) => ({ target: t, score: (isInteractive(t) ? 2 : 0) + (matching.isAxTarget(t) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.target);
}

export function match(entry, query) {
  return rank(entry, query)[0] ?? null;
}
