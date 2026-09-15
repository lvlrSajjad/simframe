/**
 * Why does a fingerprint reading not resemble its own screen?
 *
 * Its own module, with no side effects, for one reason: this logic has failed
 * at RUNTIME twice — once reaching for a variable local to another function,
 * once on declaration order — while being correct both times. `eval-fingerprint.mjs`
 * runs the whole eval on import, so nothing could test it there, and the only
 * thing that ever exercised it was a hosted runner at the end of a
 * fifteen-minute job, in the middle of a report. That is the most expensive
 * place in this project to find a typo.
 *
 * Three causes, and they have different remedies — which is the whole reason to
 * tell them apart rather than print one sentence about all three:
 *
 * - **collided** — neither reading carries a chrome label, so both are
 *   structure with no name and the fingerprint has nothing left to separate two
 *   list screens. That is this harness's own subject, and a real finding.
 * - **wrongScreen** — the tokens are identical to another screen AND this
 *   screen reads differently in its other rounds, so it is demonstrably
 *   distinguishable and the tour was simply somewhere else. A tap that missed.
 * - **underRead** — the reading stayed under the token floor and the screen
 *   cannot tell itself apart in any round, so we never looked long enough. Ours
 *   to fix, and nothing about the tour or the fingerprint.
 *
 * The middle case is the correction that prompted this. Sparseness alone used
 * to claim `underRead`, and a wrong turn onto a screen that *legitimately*
 * reads sparse — the Settings root, at 4 tokens on a runner — is flagged sparse
 * too. So a genuine tour failure was reported as our instrument's fault, and
 * the harness's original and correct message had been silenced by an
 * "improvement".
 */
import * as fingerprint from '../src/fingerprint.js';

/**
 * @param {object} o
 * @param {object} o.reading           the stray
 * @param {object|null} o.match        the other screen's reading it most resembles
 * @param {number} o.bestOther         how much it resembles that one, 0..1
 * @param {object[]} o.siblings        every reading of the stray's own screen
 * @param {boolean} o.wasSparse        did it stay under the token floor after retries
 * @param {string[]} [o.named]         chrome-labelled tokens in the stray
 * @param {string[]} [o.matchNamed]    chrome-labelled tokens in the match
 */
export function classifyStray({
  reading, match, bestOther, siblings, wasSparse, named = [], matchNamed = [],
}) {
  // Does any other round of this same screen read differently from the screen
  // we collided with? If so this screen CAN be told apart, and a round that
  // matched the other one exactly was somewhere else.
  const distinguishable = (siblings ?? [])
    .some((o) => o !== reading && fingerprint.similarity(o.tokens, match?.tokens ?? []) < 0.99);
  const identical = bestOther >= 0.99;
  // Checked first and exclusively: a reading with no names at all cannot be
  // said to have gone anywhere, because there is nothing in it that would have
  // named a destination.
  const collided = identical && named.length === 0 && matchNamed.length === 0;
  return {
    collided,
    wrongScreen: !collided && identical && distinguishable,
    underRead: !collided && Boolean(wasSparse) && !distinguishable,
    distinguishable,
  };
}
