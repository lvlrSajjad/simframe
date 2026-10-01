/**
 * What simframe typed is never written down by the graph.
 *
 * The graph keyed every edge by `actionSignature(step)` and kept the whole step
 * on it so a route could be replayed exactly. For a `type` or `paste` step the
 * whole step *is* the text, so both the edge key and the edge body carried it
 * verbatim — and a password typed into a field named "Password" was found in a
 * graph file on a working device, in plain JSON, where `goto` would also have
 * replayed it into whatever field the route led to next.
 *
 * So the rule is structural rather than a list of fields to be careful with:
 * a text step is remembered by **where** it typed, never by **what**. Its edge
 * is keyed `type:<field>`, its stored step carries `needsText: true` instead of
 * the text, and a replay has to be handed the text by its caller. Nothing that
 * replays from memory can type something nobody asked it to type today.
 *
 * Saved flows are different — a flow is an artifact somebody asked for, and a
 * flow that fills a search box is worth keeping whole. A secure field is the
 * exception there, and `isSecureField` is how a flow tells.
 */

/** Steps whose payload is text the caller supplied. */
export const TEXT_ACTIONS = new Set(['type', 'paste']);

/** Where a text step keeps its text, depending on whether it names a field. */
const TEXT_KEYS_WITH_FIELD = ['text', 'value2', 'with'];
const TEXT_KEYS_WITHOUT_FIELD = ['text', 'value'];

/** What a text step with no `into` is filed under: it typed into whatever had focus. */
export const FOCUSED = '(focused)';

/**
 * Labels that name a field whose contents must never reach disk.
 *
 * By name, because the step is all a saved flow or a journal has to go on —
 * the element's secure-entry trait is not on the step. `\b` around `pin` so a
 * "Spinner" or a "Pinned" tab is not a secret; "passcode" and "passphrase" are
 * spelled out because `pass` alone would catch "Passenger" and "Bypass".
 */
export const SECURE_FIELD = /pass\s*(word|code|phrase)|\bpwd\b|\bpin\b|secret|\botp\b|one[\s-]*time\s*(code|password)|verification\s*code|security\s*code|\bcvv\b|\bcvc\b|\bssn\b/i;

export function isSecureField(label) {
  return label != null && SECURE_FIELD.test(String(label));
}

/** The action of a step in either shape, `{action: 'type'}` or `{type: …}`. */
function actionOf(step) {
  if (!step || typeof step !== 'object') return null;
  if (step.action) return step.action;
  const [key] = Object.keys(step);
  return key === 'type_into' || key === 'typeInto' ? 'type' : key ?? null;
}

export function isTextStep(step) {
  return TEXT_ACTIONS.has(actionOf(step));
}

/** The step's fields as one flat object, whichever shape it came in. */
function flat(step) {
  if (step.action) return step;
  const action = actionOf(step);
  const { [Object.keys(step)[0]]: value, ...rest } = step;
  const inline = value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
  return { ...rest, ...inline, action };
}

/** The field a text step typed into, or `(focused)` when it named none. */
export function fieldOf(step) {
  const s = flat(step);
  return s.into != null ? String(s.into) : FOCUSED;
}

/**
 * The step with its text removed and a note that replay needs some.
 *
 * Returned in the normalized `{action, …}` shape, which `normalizeStep` passes
 * through unchanged — so a stripped step replays through exactly the same path
 * as the step it was stripped from, once the text is put back.
 */
export function withoutText(step) {
  if (!isTextStep(step)) return step;
  const s = { ...flat(step) };
  for (const k of s.into != null ? TEXT_KEYS_WITH_FIELD : TEXT_KEYS_WITHOUT_FIELD) delete s[k];
  s.needsText = true;
  return s;
}

/** Has this stripped step, or this sweep, still got text to be given? */
export function needsText(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.needsText === true) return true;
  const fill = step.fill ?? step.sweep?.fill;
  return Boolean(fill && typeof fill === 'object'
    && Object.values(fill).some((v) => v && typeof v === 'object' && v.needsText === true));
}

/** Look a field up in the caller's texts without caring about case or spacing. */
function lookup(texts, field) {
  if (!texts || typeof texts !== 'object') return undefined;
  const norm = (k) => String(k).trim().toLowerCase();
  const key = Object.keys(texts).find((k) => norm(k) === norm(field));
  return key == null ? undefined : texts[key];
}

/**
 * Put the caller's text back into steps that were stored without it.
 *
 * `texts` maps a field name to what should be typed there — `(focused)` for a
 * step that named no field. A field the caller did not supply is reported in
 * `missing` rather than skipped or guessed: a route that silently types nothing
 * into a login form arrives at the wrong screen and blames the graph.
 */
export function supplyText(steps, texts) {
  const missing = [];
  const filled = steps.map((step) => {
    if (!needsText(step)) return step;
    if (step.needsText === true) {
      const field = fieldOf(step);
      const text = lookup(texts, field);
      if (text == null) { missing.push(field); return step; }
      const { needsText: _, ...rest } = step;
      return { ...rest, text: String(text) };
    }
    // A sweep whose fill held a secure field: fill each held-back entry.
    const inner = step.fill ? step : step.sweep;
    const fill = { ...inner.fill };
    for (const [label, v] of Object.entries(fill)) {
      if (!(v && typeof v === 'object' && v.needsText === true)) continue;
      const text = lookup(texts, label);
      if (text == null) missing.push(label);
      else fill[label] = String(text);
    }
    return step.fill ? { ...step, fill } : { ...step, sweep: { ...step.sweep, fill } };
  });
  return { steps: filled, missing: [...new Set(missing)] };
}

/**
 * A step as a saved flow may keep it.
 *
 * Text into an ordinary field stays — the flow is the caller's own artifact —
 * but text into a secure field is replaced by `needsText`, and so is a sweep's
 * fill entry for one. A step that named no field cannot be judged by name and
 * is kept; say so where it matters rather than pretend otherwise.
 */
export function forSavedFlow(step) {
  if (!step || typeof step !== 'object') return step;
  if (isTextStep(step)) {
    const s = flat(step);
    return s.into != null && isSecureField(s.into) ? withoutText(step) : step;
  }
  const inner = step.fill ? step : (step.sweep && typeof step.sweep === 'object' ? step.sweep : null);
  if (!inner?.fill || typeof inner.fill !== 'object') return step;
  const secure = Object.keys(inner.fill).filter(isSecureField);
  if (!secure.length) return step;
  const fill = { ...inner.fill };
  for (const label of secure) fill[label] = { needsText: true };
  return step.fill ? { ...step, fill } : { ...step, sweep: { ...step.sweep, fill } };
}
