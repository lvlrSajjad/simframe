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

/** Comparison that ignores what OCR adds — a caret, a stray glyph, spacing. */
const alnum = (v) => String(v ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * May an OCR word be recorded as an alias of the element enclosing it?
 *
 * Only when they are plausibly the same thing. A row labelled "Kate Bell"
 * containing OCR's "Kate Bell" is one element two sensors saw; a sheet's
 * "Area (Optional)" enclosing a dimmed page's "Exterior Building" is two things
 * at one coordinate on different z-layers, and aliasing them reads as though
 * the field contains that value.
 *
 * An element with **no label** takes the text outright — that is how an
 * icon-only control gets a name, and it cannot contradict a label it does not
 * have.
 *
 * A function rather than three lines inline, because the inline version read
 * `covering.label` before anything checked that `covering` existed, and the
 * TypeError that followed was swallowed by the OCR try/catch — silently
 * disabling the sensor. A pure function can be tested with the value that broke
 * it, and the source-shape assertion this replaces could not.
 */
export function aliasRelates(coveringLabel, text) {
  const own = alnum(coveringLabel);
  const seen = alnum(text);
  return !own || !seen || own.includes(seen) || seen.includes(own);
}

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

const frameArea = (f) => (f ? Math.max(1, f.width) * Math.max(1, f.height) : Infinity);

/**
 * What the map says is at a point — everything containing it, smallest first.
 *
 * Item 120. Six consecutive `swipe [201,750] -> [201,250]` reported
 * `no visible change` while a support banner sat at y≈753 swallowing every
 * gesture. The banner was *in the element list the same call printed*; nothing
 * connected "your swipe started at y=750" to "there is an element at y=753".
 * The geometry was already in hand, so this is arithmetic over data we hold,
 * not a new perception pass.
 *
 * Smallest first is a deliberately weaker claim than z-order. We do not know
 * what is on top — the accessibility tree's order is not a paint order and OCR
 * has none at all — and the honest statement is "these are the elements that
 * cover that point", innermost first because the innermost is the one a
 * gesture most often goes to. Saying "overlay" would be a guess wearing the
 * clothes of a measurement.
 */
export function hitTest(entry, point) {
  if (!entry?.targets || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return [];
  return entry.targets
    .filter((t) => t.frame && inside(point, t.frame))
    .sort((a, b) => frameArea(a.frame) - frameArea(b.frame));
}

const describeTarget = (t) => {
  const name = t.label || t.text || (t.type ? `(unlabelled ${t.type})` : '(unlabelled)');
  return t.region ? `"${name}" (${t.region})` : `"${name}"`;
};

/**
 * One line saying what a coordinate resolved to, for a gesture that did
 * nothing visible.
 *
 * Returns `null` when there is no map for the screen, because "we did not
 * look" and "we looked and found nothing" are different answers and only one
 * of them is worth printing.
 */
export function describePoint(entry, point, { what = 'the point' } = {}) {
  if (!entry?.targets?.length) return null;
  const at = `${Math.round(point.x)},${Math.round(point.y)}`;
  const hits = hitTest(entry, point);
  if (!hits.length) {
    return `${what} ${at} is not inside any element on the map`
      + ' — empty space, or a view with no label (nothing can be said about what caught it)';
  }
  // The contention clause only where there is contention. On one hit the
  // element's name *is* the diagnosis and anything after it is noise — and a
  // note that pads every case is how a real one stops being read.
  const others = hits.length > 1
    ? `, the smallest of ${hits.length} elements covering it — a gesture goes to whatever is on top there`
    : '';
  return `${what} ${at} is inside ${describeTarget(hits[0])}${others}`;
}

/**
 * The point a step is aimed at, when it is aimed at a coordinate at all.
 *
 * A swipe is captured by whatever sits under where the finger goes *down*, so
 * the start point is the one worth diagnosing; the end point never decides who
 * receives the gesture.
 */
export function aimedAt(step) {
  if (!step) return null;
  if (step.action === 'tapAt' && Number.isFinite(step.x) && Number.isFinite(step.y)) {
    return { point: { x: step.x, y: step.y }, what: 'the tap point' };
  }
  if (step.action === 'swipe') {
    const x = step.from?.[0] ?? step.from?.x;
    const y = step.from?.[1] ?? step.from?.y;
    if (Number.isFinite(x) && Number.isFinite(y)) return { point: { x, y }, what: 'the swipe start point' };
  }
  return null;
}

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
  // Pairs where an ax element and an OCR word share a coordinate and disagree
  // about what is there — the signature of one layer covering another.
  const occluded = [];
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
        // An alias must be the *same thing*, read twice.
        //
        // The geometric branch above pairs an OCR word with whichever ax
        // element encloses it, and across z-layers that is simply wrong.
        // Reported on a modal-heavy screen, with a Select Area sheet open over a
        // dimmed page: `#15 text 167,316 Area (Optional) ~ Exterior Building`,
        // which reads as though the field "Area (Optional)" contains "Exterior
        // Building". They are two unrelated things at one coordinate on
        // different layers, and the reporter had to fall back to a screenshot to
        // count five radio options — precisely the case the text map exists to
        // remove.
        //
        // So a labelled ax element only takes an alias that relates to its own
        // label. The justification for aliasing was always "a row labelled 'Kate
        // Bell' containing OCR's 'Kate Bell' is one element two sensors saw" —
        // that still holds. An *unlabelled* element still takes the text
        // outright, because that is how an icon-only control gets a name at all,
        // and it cannot contradict a label it does not have.
        // NOTE the nesting, which is the whole point of this shape: `covering`
        // is undefined whenever no ax element encloses this word, which is most
        // words on most screens. Reading `covering.label` before checking that
        // threw a TypeError inside the OCR try/catch — so the entire OCR pass
        // was swallowed and reported as `degraded: text recognition`, silently
        // disabling the sensor on every screen with one uncovered word. Neither
        // the unit tests nor the perception harness caught it: the harness feeds
        // *already fused* element lists, so it never runs this loop. The
        // integration job caught it, which is what it is for.
        if (covering) {
          if (aliasRelates(covering.label, w.text)) {
            covering.aliases = [...(covering.aliases || []), w.text];
            // Keep the ax role and frame — it is the hit target — and record
            // that both sensors saw it. Anything asking "is this the tree's
            // element?" must ask matching.isAxTarget, not `=== 'ax'`.
            if (!String(covering.source ?? '').includes('ocr')) {
              covering.source = `${covering.source ?? 'ax'}|ocr`;
            }
            continue;
          }
          // Rejected as an alias, so it falls through and becomes an element of
          // its own — which is what it is. Marked, because "these two things
          // overlap and disagree" is exactly the shape of an occluding layer,
          // and a caller counting radio options needs to know it is there.
          occluded.push({ over: covering.label, under: w.text });
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
    if (occluded.length) entry.occluded = occluded;
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
