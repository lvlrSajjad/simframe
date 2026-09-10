/**
 * The local supervisor: three words, behind the hands, in front of Claude.
 *
 * The owner's design. Claude plans; the deterministic executor in `actions.js`
 * runs the plan and verifies each step; and when a step fails, *this* decides
 * whether the plan can proceed — before anything reaches Claude. It sits behind
 * the hands and in front of the reasoner, and it is the first responder rather
 * than the decision-maker.
 *
 * It may say **wait**, **retry** or **stop**. Nothing else. It cannot invent a
 * step, skip one, substitute a target, or continue past an unexpected screen —
 * not because a confidence threshold forbids it but because those are not words
 * it can say. The answer space *is* the safety property. `seek` was given
 * latitude over what to open and pressed "YES, THIS FIXED MY PROBLEM" in a live
 * app; a component that can only choose among three words cannot do that,
 * whatever it believes.
 *
 * **The plan briefs it**, which is the owner's second insight and the thing that
 * made it work. Asked cold, it called a list that was plainly still arriving a
 * dead end — because it does not know the app and Claude, by the time it writes
 * the plan, does. So a batch may carry `supervise` and a step may carry
 * `expect`, and both reach the supervisor as context. That costs a string and no
 * round trips.
 *
 * One thing it is deliberately not trusted for: its own **prose**. In testing it
 * returned a correct decision with a reason citing a rule that did not apply.
 * The decision is used; the reason is logged and never shown as an explanation.
 * Presenting a confabulated rationale as fact is the mistake `seek`'s
 * documentation already made once.
 *
 * Off unless asked: `SIMFRAME_SUPERVISOR=apple`, or `supervisor` per call.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { compiler, lineServer } from './localhelper.js';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'supervise.swift');
const BIN = path.join(store.ROOT, 'bin', 'supervise');

const helper = lineServer({
  ensureBinary: compiler({ source: SOURCE, binary: BIN, what: 'local supervisor' }),
  what: 'local supervisor',
});

export const DECISIONS = new Set(['wait', 'retry', 'stop']);

/** Which backend the caller asked for, per call first and environment second. */
export function requested(options) {
  const raw = String(options?.supervisor ?? process.env.SIMFRAME_SUPERVISOR ?? '').trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'off' || raw === '0' || raw === 'false') return null;
  return raw;
}

/**
 * Can this plan proceed past the step that just failed?
 *
 * @returns {Promise<{decision: 'wait'|'retry'|'stop', reason: string, ms: number}|null>}
 *   null on every failure mode — not asked, unavailable, timed out, unparseable,
 *   or an answer outside the three words. A null means the executor behaves
 *   exactly as it does without a supervisor, which is the only safe default.
 */
export async function judge({
  goal, step, expected, failure, screen, stillMs, note, options, timeoutMs = 2500,
} = {}) {
  if (!requested(options)) return null;
  if (!step || !failure) return null;
  const answer = await helper.ask({
    goal: goal ? String(goal).slice(0, 200) : null,
    step: String(step).slice(0, 200),
    expected: expected ? String(expected).slice(0, 300) : null,
    failure: String(failure).slice(0, 300),
    screen: (screen ?? []).filter(Boolean).map((s) => String(s).slice(0, 40)).slice(0, 25),
    stillMs: Number.isFinite(stillMs) ? Math.round(stillMs) : null,
    note: note ? String(note).slice(0, 200) : null,
  }, timeoutMs);
  const decision = String(answer?.decision ?? '').toLowerCase();
  // An answer outside the vocabulary is not a decision. Refusing it here is
  // what makes the three-word constraint real rather than merely documented.
  if (!DECISIONS.has(decision)) return null;
  return { decision, reason: String(answer.reason ?? '').slice(0, 120), ms: answer.ms ?? null };
}

/** For `doctor`: what the supervisor layer is, in one line. */
export async function status(options) {
  const want = requested(options);
  if (!want) return { supervisor: 'none', detail: 'not requested (SIMFRAME_SUPERVISOR is unset)' };
  if (want !== 'apple') return { supervisor: 'none', detail: `no such supervisor backend: "${want}"` };
  const live = await helper.status();
  if (!live.ok) return { supervisor: 'none', detail: live.reason };
  return { supervisor: 'apple', detail: 'Apple Foundation Models, on-device; may only answer wait/retry/stop' };
}

export const close = helper.close;
