/**
 * A second supervisor arm, for measuring whether capacity matters.
 *
 * The owner's call, 2026-09-11: *"we can of course do our own test with a
 * chosen model… and decide based on the numbers rather than speculations."*
 * This exists to answer that and nothing else. It is **not** a recommendation,
 * it is off unless asked for by name, and a model used to measure whether
 * capacity matters is not a model we ship — conflating those is how a non-goal
 * erodes.
 *
 * No dependency is added: Node has had a global `fetch` since 18, and Ollama
 * is a process already on the machine, reached over the loopback interface.
 *
 * **The fairness condition, which is the whole reason this file is shaped the
 * way it is.** Most small-model errors are invalid-output faults, and Apple's
 * guided generation eliminates those at the sampling layer — constraints are
 * enforced by logit masking, so a fourth word is unrepresentable rather than
 * rejected afterwards (WWDC25 301; Tech Report §7). An unconstrained challenger
 * would lose on formatting and we would read it as losing on judgement. So this
 * arm passes a JSON schema whose `decision` is an enum of the same three words,
 * and Ollama constrains sampling to it the same way.
 *
 * And the briefing is not a second copy. It is **read out of
 * `native/supervise.swift`**, because two hand-maintained copies of a prompt is
 * two arms answering different questions, and the difference would be invisible
 * in the numbers. See `readBrief`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWIFT = path.join(HERE, '..', 'native', 'supervise.swift');

export const DEFAULT_MODEL = 'qwen3:8b';
export const DEFAULT_HOST = 'http://127.0.0.1:11434';

/**
 * The Apple arm's own instructions, read from its source.
 *
 * Not duplicated. Two arms of a comparison that are briefed differently are
 * measuring two different things, and nothing in the output would say so — the
 * numbers would simply be wrong and look fine. The Swift file is the canonical
 * copy because it is the shipped one; this parses the `let instructions = """
 * … """` block out of it and un-escapes Swift's trailing-backslash line
 * continuations, which is how that literal is wrapped.
 *
 * Throws rather than falling back to a built-in string. A silent fallback here
 * would produce exactly the invisible unfairness this function exists to
 * prevent.
 */
export function readBrief(file = SWIFT) {
  const src = fs.readFileSync(file, 'utf8');
  const open = src.indexOf('let instructions = """');
  if (open === -1) throw new Error(`no instructions block in ${file}`);
  const bodyStart = src.indexOf('\n', open) + 1;
  const close = src.indexOf('"""', bodyStart);
  if (close === -1) throw new Error(`unterminated instructions block in ${file}`);
  return src
    .slice(bodyStart, close)
    .split('\n')
    // A Swift multi-line literal strips the closing delimiter's indentation
    // from every line; here that is four spaces.
    .map((l) => l.replace(/^ {4}/, ''))
    .join('\n')
    // Swift's line continuation: a trailing backslash removes the newline and
    // nothing else. Joining with a space instead would insert one after the
    // space the line already ends with, and the two arms would be reading
    // briefs that differ — invisibly, and in the one place this whole file
    // exists to keep identical.
    .replace(/\\\n/g, '')
    .trim();
}

const clip = (t, n) => {
  const s = String(t ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * The situation, in the words the other arm gets.
 *
 * A line-for-line mirror of `main.swift`'s prompt assembly, including the clip
 * lengths and the 14-label cap on the screen list. The field order matters as
 * much as the content: the brief tells the model to weigh the plan's guidance
 * first, and a prompt that presented it last would be testing a different
 * instruction.
 */
export function promptFor(s = {}) {
  let prompt = `Step: ${clip(s.step, 120)}\nIt failed with: ${clip(s.failure, 220)}`;
  if (s.goal) prompt += `\nThe plan's guidance about this app: ${clip(s.goal, 300)}`;
  if (s.expected) prompt += `\nExpected: ${clip(s.expected, 200)}`;
  if (Number.isFinite(s.stillMs)) prompt += `\nThe screen has been still for ${s.stillMs}ms`;
  if (s.note) prompt += `\nPerception note: ${clip(s.note, 160)}`;
  if (s.screen?.length) {
    prompt += `\nOn screen now: ${s.screen.slice(0, 14).map((l) => clip(l, 28)).join(', ')}`;
  }
  return prompt;
}

/**
 * The schema. Three words and nothing else, enforced at sampling.
 *
 * Deliberately decision-only, matching `Judgement` in the Swift file: that
 * struct has one field. Asking this arm for a rationale it would then be scored
 * against would be a second difference between the arms, and the rationale is
 * the one thing a supervisor is explicitly not trusted for.
 */
export const SCHEMA = {
  type: 'object',
  properties: { decision: { type: 'string', enum: ['wait', 'retry', 'stop'] } },
  required: ['decision'],
};

/** Parse `ollama`, `ollama:qwen3:14b`, `ollama:qwen3:8b@http://host:port`. */
export function parseTarget(raw) {
  const rest = String(raw ?? '').replace(/^ollama:?/, '');
  const [model, host] = rest.split('@');
  return { model: model || DEFAULT_MODEL, host: host || DEFAULT_HOST };
}

async function post(host, route, body, timeoutMs) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: control.signal,
    });
    if (!res.ok) return { kind: 'http', error: `${res.status} ${await res.text().catch(() => '')}`.slice(0, 200) };
    return { json: await res.json() };
  } catch (err) {
    return { kind: err.name === 'AbortError' ? 'timeout' : 'unreachable', error: String(err.message).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One judgement. Same shape as the Apple helper's answer, so `judge` in
 * `supervisor.js` cannot tell which arm it asked — including the failure
 * shapes, because "the supervisor did not answer" covering a timeout, a
 * refusal and a model that was never installed is a bug this project has
 * already paid for once.
 */
export async function ask(target, situation, timeoutMs = 2500) {
  const { model, host } = target;
  const started = Date.now();
  const out = await post(host, '/api/chat', {
    model,
    messages: [
      { role: 'system', content: readBrief() },
      { role: 'user', content: promptFor(situation) },
    ],
    stream: false,
    format: SCHEMA,
    // Qwen3 reasons out loud by default. Turned off for two reasons and both
    // are about fairness rather than speed: the Apple arm does not deliberate
    // either, and a supervisor that takes twenty seconds to answer has already
    // lost the argument it is here to have — it sits in front of a 1.2s budget.
    think: false,
    options: { temperature: 0, num_predict: 32 },
  }, timeoutMs);
  if (!out.json) return { kind: out.kind, error: out.error };
  const ms = Date.now() - started;
  try {
    return { ...JSON.parse(out.json.message?.content ?? ''), ms };
  } catch {
    return { kind: 'unparseable', error: clip(out.json.message?.content, 200), ms };
  }
}

/**
 * Load the weights before timing anything.
 *
 * The Apple arm calls `prewarm()` for exactly this reason, and it was worth
 * ~280ms there. Here it is worth minutes: an 8B at 4-bit is 5.2 GB off disk,
 * and the first `doctor` probe aborted at 20s and reported a working model as
 * one that "did not answer" — a cold load reported as a fault. Ollama's
 * documented preload is a chat with no messages.
 */
export async function preload(target, timeoutMs = 120_000) {
  const { model, host } = target;
  const started = Date.now();
  const out = await post(host, '/api/chat', { model, messages: [], keep_alive: '10m' }, timeoutMs);
  return out.json ? { ok: true, ms: Date.now() - started } : { ok: false, ...out };
}

/** For `doctor`: is this arm actually there, and does it answer? */
export async function status(target, timeoutMs = 20_000) {
  const { model, host } = target;
  const tags = await post(host, '/api/show', { model }, 4000);
  if (!tags.json) {
    return {
      ok: false,
      reason: tags.kind === 'unreachable'
        ? `no Ollama server at ${host} (start it, or pass a host with ollama:<model>@<url>)`
        : `Ollama has no model "${model}" (${tags.error})`,
    };
  }
  return { ok: true, model, host, timeoutMs };
}
