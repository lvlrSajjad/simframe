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
import * as vocabulary from './vocabulary.js';
import * as regions from './regions.js';
import { informative } from './refs.js';
import * as store from './store.js';
import * as glyphs from './glyphs.js';
import { maskCredentials, maskTyped } from './typed.js';

export const MAP_VERSION = 9; // ax targets carry value, selected and focused

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

export function mapDir(udid) {
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
/**
 * Is an OCR word inside an accessibility element evidence of another layer?
 *
 * Only when it is plainly something else. Counted on every stored reading,
 * the old test (any word not contained in the label) fired on 126 of 268 of
 * a field app's readings and 95 of 575 on the bench device, almost all of it
 * OCR misreading the same text ("Location (AII)", "Oh Om Os"), an icon glyph
 * ("Close" / "X"), a field's own contents or a row's value — so a warning
 * that should mean "a sheet is over this" meant nothing (field report,
 * 0.22.0). With this test: 32 and 40, mostly toasts, banners and sheets.
 */
const CONTENT_HOLDER = /field|textarea|textview|search/i;
export function anotherLayer(cover, text) {
  const seen = alnum(text);
  if ((seen.match(/\p{L}/gu) ?? []).length < 3) return false;
  if (CONTENT_HOLDER.test(String(cover?.type ?? ''))) return false;
  const fold = (v) => matching.confusableFold(alnum(v));
  const b = fold(text);
  for (const name of [cover?.label, cover?.value, ...(cover?.aliases ?? [])].filter((v) => v != null && String(v).trim())) {
    const a = fold(name);
    if (!a || a.includes(b) || b.includes(a)) return false;
    // A misread of the same words: close in edit distance.
    if (matching.editDistance(a.slice(0, Math.max(a.length, b.length)), b, 12) / Math.max(1, b.length) <= 0.4) return false;
  }
  return true;
}

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
  // Masked on the way to disk only: a sign-in screen shows its username. See typed.js.
  store.writeAtomic(path.join(dir, `${entry.hash}.json`), JSON.stringify(maskCredentials(maskTyped(entry))));
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
  // Memory from older fingerprint rules is carried forward before the first
  // read, so this read can recognise it. Once per device per process; see carry.js.
  if (persist && screen?.width) (await import('./carry.js')).ensureCarried(udid, screen);
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
      //
      // And when the daemon answered *without* a tree, asking again is asking
      // the thing that just failed. That path cost a red CI run and a wrong
      // diagnosis: the daemon's ax read timed out, `describeAll` re-asked it
      // (another 20s), got the same nothing, fell through to idb, and the map
      // reported **"idb is not installed, so simframe can observe the screen but
      // cannot touch it"**. A sentence about a tool this project deliberately
      // does not use on CI, printed because a different tool had a bad read —
      // and it points whoever reads it at installing idb, which would change
      // nothing. The same read worked a minute later.
      //
      // The daemon has sent `axError` since it learned to time its own reads,
      // and nothing here had ever read it. The OCR branch below reads
      // `ocrError`, which is what makes the asymmetry visible: one sensor could
      // say why it failed and the other borrowed a different tool's excuse.
      let nodes;
      if (daemonScreen?.sources?.includes('ax')) {
        nodes = daemonScreen.elements.filter((e) => e.source?.includes('ax')).map(input.elementToNode);
      } else if (daemonScreen) {
        throw new Error(daemonScreen.axError ?? 'the daemon read the screen and the accessibility tree did not answer');
      } else {
        nodes = await input.describeAll(udid);
      }

      sources.push('ax');
      // A control the tree gives no name to is still a control — item 122.
      //
      // This line used to read `!n.label`, on the reasoning that a row nobody
      // can name is a row nobody can tap. The whole of item 122 is that the
      // opposite is true, and three field reports in a row said so
      // independently: icon-only overflow menus on every card, a bottom-sheet
      // drag handle, a back chevron. Real, tappable, on screen, and absent from
      // the map — so every one of them needed a raw `@x,y` read off a
      // screenshot, which is the exact round trip the text map exists to
      // remove. Knowing that *a hit target is there* is most of the value even
      // with no semantics attached to it.
      //
      // Measured on the testbed before it was written, because the premise
      // could have been false: on the list screen, of 39 accessibility nodes
      // exactly **one** is nameless — and it is the one control on that screen
      // no caller could reach. This does not flood the map.
      //
      // It also settles a thing the reports could not: those controls were
      // called "absent from the tree", and AXPTranslator had them all along.
      // What is genuinely absent is the drag handle, a plain view holding a
      // responder that UIKit is never told is accessible. No filter here can
      // recover that one; see 122's second half.
      for (const n of nodes) {
        if (!n.frame || isContainer(n)) continue;
        if (nameless(n) && !namelessHitTarget(n, nodes)) continue;
        targets.push({
          label: n.label ?? undefined,
          // A `testID` arrives as AXIdentifier, and `tap` has matched on it
          // since long before this — but only down the tree path, because the
          // map never carried it. So the one name an unlabelled React Native
          // control usually does have was invisible in the map and worked if
          // you guessed it.
          identifier: n.identifier ?? undefined,
          // The icon-font characters the label carried before cleanLabel took
          // them out: an exact address into the app's own icon font. See glyphs.js.
          ...(glyphs.codepointsOf(n.rawLabel).length ? { glyphs: glyphs.codepointsOf(n.rawLabel) } : {}),
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
      // An icon-only control whose label was one icon-font glyph is named from
      // the app's own font. Never fails a read: no fonts, no names.
      await glyphs.nameIcons(udid, targets).catch(() => {});
      nameFieldsByCaption(targets);
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
          if (anotherLayer(covering, w.text)) occluded.push({ over: covering.label, under: w.text });
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
    if (screen?.height) markBehindSheet(targets, screen);
    if (screen?.height && screen?.width) markUnderBottomBar(targets, screen);
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

const INTERACTIVE = /button|field|textarea|textview|cell|link|checkbox|switch|slider|tab|menu|segment/i;

export function isInteractive(target) {
  return INTERACTIVE.test(target.type || '');
}

/** No name from any source: not a label, not an identifier. */
export const nameless = (n) => !n?.label && !n?.identifier;

/**
 * Whether a nameless accessibility node is worth printing as a hit target.
 *
 * Two guards, because "has no name" is not the same as "is a control".
 *
 * The role has to be one the tree calls interactive. A nameless `Other` is a
 * layout view and a real screen has hundreds of them; emitting those would bury
 * the one node that matters under the scenery it sits in.
 *
 * And it must not enclose two or more other elements. That is the same test the
 * fingerprint uses for scenery, reused deliberately rather than invented here:
 * a table cell holding its own labels is not the target, its labels are.
 */
export function namelessHitTarget(node, nodes) {
  const f = node?.frame;
  if (!f || !(f.width > 0) || !(f.height > 0)) return false;
  if (!INTERACTIVE.test(node.type || '')) return false;
  const encloses = nodes.filter((o) => {
    const g = o.frame;
    if (!g || o === node) return false;
    const cx = g.x + (g.width ?? 0) / 2;
    const cy = g.y + (g.height ?? 0) / 2;
    return cx > f.x && cx < f.x + f.width && cy > f.y && cy < f.y + f.height;
  }).length;
  return encloses < 2;
}

/**
 * Rank candidates for a label. Exact beats substring, and a real control beats
 * a caption that happens to read the same — a screen title and a tab are often
 * the same word, and tapping the title silently does nothing.
 */
export function rank(entry, query) {
  if (!entry) return [];
  const q = norm(query);
  const names = (t) => [t.label, t.identifier, ...(t.aliases || [])].map(norm);
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

/**
 * Text that differs between two readings of one screen, outside the status
 * bar, or null. Pure. The first difference is described; that is enough to
 * say the tap landed.
 */
export function textChange(before, after) {
  const texts = (entry) => (entry?.targets ?? [])
    .filter((t) => t.region !== 'status-bar' && t.region !== 'keyboard')
    .map((t) => [t.label, t.value].filter((x) => x != null && String(x).trim()).join(' = '))
    .filter(Boolean);
  if (!before?.targets || !after?.targets) return null;
  const a = new Set(texts(before));
  const b = new Set(texts(after));
  const gone = [...a].find((x) => !b.has(x));
  const came = [...b].find((x) => !a.has(x));
  if (!gone && !came) return null;
  const clip = (x) => (x.length > 60 ? `${x.slice(0, 57)}…` : x);
  return gone && came ? `"${clip(gone)}" → "${clip(came)}"` : came ? `"${clip(came)}" appeared` : `"${clip(gone)}" went away`;
}

/**
 * An unlabeled field takes the name of the caption printed on its top edge.
 *
 * React Native inputs often carry a testID and no accessibility label, with
 * the visible name in a separate text node above ("Description*"). The field
 * report (0.22.0) could not `type into "Description"` or `fill` it, while
 * "Requested By*" worked through a different path. The name is marked
 * `labelFrom: 'caption'`, so it never enters a fingerprint, and the required
 * marker and a trailing colon are dropped.
 */
const FIELD_ROLE = /field|textarea|textview/i;
const CAPTION_ROLE = /^(statictext|text|label)$/i;
export function nameFieldsByCaption(targets) {
  const captions = targets.filter((t) => CAPTION_ROLE.test(String(t.type ?? '')) && String(t.label ?? '').trim() && t.frame);
  for (const f of targets) {
    if (!FIELD_ROLE.test(String(f.type ?? '')) || String(f.label ?? '').trim() || !f.frame) continue;
    const top = f.frame.y;
    const best = captions
      .filter((c) => {
        const mid = c.frame.y + (c.frame.height ?? 0) / 2;
        const overlapsX = c.frame.x < f.frame.x + (f.frame.width ?? 0) && c.frame.x + (c.frame.width ?? 0) > f.frame.x;
        return overlapsX && mid >= top - 30 && mid <= top + 14;
      })
      .sort((a, b) => Math.abs(a.frame.y + a.frame.height / 2 - top) - Math.abs(b.frame.y + b.frame.height / 2 - top))[0];
    if (!best) continue;
    const name = String(best.label).trim().replace(/\s*[*:]+\s*$/, '').trim();
    if (name) { f.label = name; f.labelFrom = 'caption'; }
  }
  return targets;
}

/**
 * Text OCR read above a sheet or alert belongs to the screen behind it.
 *
 * An app hides the background from accessibility while a sheet is open, which
 * is right, and OCR still reads it through the dimming — so the Problem
 * picker's map offered "Asset", "Anaheim" and the step tabs as tappable text,
 * with nothing to say they were behind it (field report, 0.22.0; both runs).
 *
 * The shape: every accessibility element sits low on the screen, one of them
 * is a way to dismiss (Close, Cancel, Not now…), and OCR-only text lies above
 * all of them. The dismiss control is what separates a sheet from a web page
 * (whose content is not in the tree) or a screen with an unlabeled header.
 * Marked with a flag, not a region, so no screen's identity moves. Returns how
 * many were marked.
 */
export const SHEET_TOP_MIN_FRACTION = 0.3;
export const SHEET_MIN_HEIGHT_FRACTION = 0.2;
export function markBehindSheet(targets, screen) {
  const placed = targets.filter((t) => t.frame && t.region !== 'status-bar');
  // Keys are not the sheet; a toolbar is too thin to be one (a web page's
  // content is not in the tree, its toolbar is).
  const ax = placed.filter((t) => matching.isAxTarget(t) && t.region !== 'keyboard');
  if (ax.length < 2) return 0;
  const top = Math.min(...ax.map((t) => t.frame.y));
  if (top < screen.height * SHEET_TOP_MIN_FRACTION) return 0;
  const bottom = Math.max(...ax.map((t) => t.frame.y + (t.frame.height ?? 0)));
  if (bottom - top < screen.height * SHEET_MIN_HEIGHT_FRACTION) return 0;
  const dismiss = new Set((vocabulary.load().cartographer?.dismiss ?? []).map((w) => alnum(w)));
  if (!ax.some((t) => dismiss.has(alnum(t.label)))) return 0;
  const above = placed.filter((t) => t.source === 'ocr' && t.frame.y + (t.frame.height ?? 0) <= top);
  // One stray word above a form (a logo) is not a screen behind a sheet.
  if (above.length < 2) return 0;
  for (const t of above) t.behind = true;
  return above.length;
}

/**
 * List rows scrolled under a sticky bottom bar.
 *
 * The accessibility tree keeps every row of a list at its scrolled position,
 * including the ones a pinned footer covers, so a picker's rows behind its
 * CLEAN / SELECT bar were listed as ordinary tappable rows (field report,
 * 0.22.0, both runs). A tap there hits the bar.
 *
 * The bar: buttons in the lower part of the screen, side by side on one line,
 * spanning most of its width and no taller than a button. Under it: anything
 * from the tree whose centre is below the bar's top edge and that OCR did not
 * see — a covered row is in the tree and not in the pixels. Marked
 * `behind: 'bar'`, a flag like the sheet's, so nothing is hidden and no
 * identity moves. Returns how many were marked.
 */
export const BOTTOM_BAR_MIN_SPAN = 0.6;
export const BOTTOM_BAR_MAX_INSET = 130;
export function markUnderBottomBar(targets, screen) {
  const buttons = targets.filter((t) => t.frame && matching.isAxTarget(t)
    && /button/i.test(String(t.type ?? ''))
    && !['keyboard', 'tab-bar', 'status-bar'].includes(t.region)
    && t.frame.y > screen.height * 0.6
    && (t.frame.height ?? 0) <= screen.height * 0.08);
  let marked = 0;
  for (const seed of buttons) {
    // Two or more buttons on one line: a single full-width button is
    // indistinguishable from a list row.
    const line = buttons.filter((b) => Math.abs(b.frame.y - seed.frame.y) <= 8);
    if (line.length < 2) continue;
    const left = Math.min(...line.map((b) => b.frame.x));
    const right = Math.max(...line.map((b) => b.frame.x + (b.frame.width ?? 0)));
    if (right - left < screen.width * BOTTOM_BAR_MIN_SPAN) continue;
    const barTop = Math.min(...line.map((b) => b.frame.y));
    const barBottom = Math.max(...line.map((b) => b.frame.y + (b.frame.height ?? 0)));
    // Pinned to the bottom, not a row of chips or a grid mid-screen.
    if (barBottom < screen.height - BOTTOM_BAR_MAX_INSET) continue;
    const under = targets.filter((t) => t.frame && !line.includes(t) && !t.behind
      && !['keyboard', 'tab-bar', 'status-bar'].includes(t.region)
      && matching.isAxTarget(t) && !String(t.source ?? '').includes('ocr')
      && t.frame.y < screen.height
      && t.frame.y + (t.frame.height ?? 0) / 2 >= barTop + 4
      // Part of the bar, not under it: its container, or a sibling on its line.
      && !/tab ?bar|toolbar/i.test(`${t.type ?? ''} ${t.label ?? ''}`)
      && !line.some((b) => inside({ x: b.frame.x + 1, y: b.frame.y + 1 }, t.frame)
        && inside({ x: b.frame.x + b.frame.width - 1, y: b.frame.y + b.frame.height - 1 }, t.frame))
      && !(t.frame.y >= barTop - 2 && t.frame.y + (t.frame.height ?? 0) <= barBottom + 2));
    // And content passes under it: something straddles its top edge.
    if (!under.some((t) => t.frame.y < barBottom && t.frame.y + (t.frame.height ?? 0) > barTop)) continue;
    for (const t of under) t.behind = 'bar';
    marked += under.length;
    break;
  }
  return marked;
}

