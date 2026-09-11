/**
 * Seeded randomness, because a delay you cannot replay is not a test fixture.
 *
 * The testbed's whole purpose is producing failures on demand — a control that
 * is disabled for a while, a list whose rows arrive after its count header, a
 * step that fails once and then works. Those have to vary, or they stop
 * exercising the thing that waits. And they have to be *reproducible*, or a
 * red run is a ghost story.
 *
 * Two days of chasing a fingerprint collision is the argument. The failing run
 * was unrepeatable, so every hypothesis had to be tested against a fresh roll
 * of the dice, and three of them were wrong for reasons nobody could see.
 *
 * So: one seed per app launch, printed on screen and settable from outside.
 *
 *   simframe do '[{"openUrl":"simframetestbed://seed/1234"}]'
 *
 * Every delay and every injected failure in the app comes from this stream, in
 * a fixed order, so the same seed produces the same run.
 */

/** mulberry32 — small, fast, and good enough for timings. */
function mulberry32(a: number): () => number {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let seed = 1;
let next = mulberry32(seed);

/** The seed in force. Rendered in the UI so a screenshot carries it. */
export const currentSeed = (): number => seed;

/**
 * Re-seed and restart the stream.
 *
 * Resets the sequence as well as the seed: re-seeding to the same number
 * mid-run has to give the same continuation, or "same seed, same run" is not
 * true and the guarantee is worthless.
 */
export function reseed(to: number): void {
  seed = Number.isFinite(to) ? Math.trunc(to) : 1;
  next = mulberry32(seed);
}

/** A float in [0, 1). */
export const random = (): number => next();

/** An integer in [min, max], inclusive. */
export const between = (min: number, max: number): number =>
  min + Math.floor(next() * (max - min + 1));

/**
 * True with this probability.
 *
 * Named `chance` rather than `maybe` because the call sites read as claims
 * about the world: `chance(0.3)` at a fetch site means "this endpoint fails
 * three times in ten", which is a property of the fixture, not a coin toss.
 */
export const chance = (p: number): boolean => next() < p;

/** A delay long enough to be worth waiting for, short enough to test against. */
export const delayMs = (min = 300, max = 2500): number => between(min, max);
