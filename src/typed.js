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

/**
 * Labels that name who is signing in. A username is half a credential, and the
 * owner's rule is that no username or password reaches disk, so these are kept
 * off saved flows and the write journal the same way a password is.
 *
 * Wider than strictly needed on purpose: an "Email" field on an ordinary form
 * is stripped too, and its replay then asks for the text. Asking costs one
 * argument; keeping a sign-in address in a file costs the address.
 */
export const IDENTITY_FIELD = /\be-?mail\b|\buser\s*-?\s*(name|id)\b|\busername\b|\blog\s*-?\s*in\b|\bsign[\s-]*in\b|\baccount\s*(id|name|number)\b/i;

/** A value that is an email address, whatever field it went into. */
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;

/** A field whose contents are a credential: a secret, or the name it belongs to. */
export function isCredentialField(label) {
  return label != null && (isSecureField(label) || IDENTITY_FIELD.test(String(label)));
}

/** Text that is a credential by its own shape, wherever it was typed. */
export function looksLikeCredential(text) {
  return text != null && EMAIL_VALUE.test(String(text));
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
export function forSavedFlow(step, { focusedField = null } = {}) {
  if (!step || typeof step !== 'object') return step;
  if (isTextStep(step)) {
    const s = flat(step);
    const field = s.into ?? focusedField;
    const text = s.into != null ? (s.text ?? s.value2 ?? s.with) : (s.text ?? s.value);
    // A field named by a ref or a point ("#3", "@201,481") says nothing about
    // what it is, so it gets the cautious answer: the flow asks for the text.
    const unnamed = s.into != null && !/[a-z]/i.test(String(s.into).replace(/^#\d+$/, ''));
    return isCredentialField(field) || looksLikeCredential(text) || unnamed ? withoutText(step) : step;
  }
  const inner = step.fill ? step : (step.sweep && typeof step.sweep === 'object' ? step.sweep : null);
  if (!inner?.fill || typeof inner.fill !== 'object') return step;
  const secure = Object.keys(inner.fill).filter((label) => isCredentialField(label) || looksLikeCredential(inner.fill[label]));
  if (!secure.length) return step;
  const fill = { ...inner.fill };
  for (const label of secure) fill[label] = { needsText: true };
  return step.fill ? { ...step, fill } : { ...step, sweep: { ...step.sweep, fill } };
}

/** The label a step tapped, if it was a tap on a named control. */
function tappedLabel(step) {
  if (!step || typeof step !== 'object') return null;
  if (step.action === 'tap') return step.value ?? step.target ?? null;
  if (typeof step.tap === 'string') return step.tap;
  if (step.tap && typeof step.tap === 'object') return step.tap.value ?? step.tap.sel ?? null;
  return null;
}

/**
 * A whole flow as it may be saved. A text step that named no field typed into
 * whatever had focus, which is usually the field the step before it tapped — so
 * "tap Password, then type" is judged as typing into Password.
 */
export function forSavedFlowSteps(steps) {
  let focusedField = null;
  return (steps ?? []).map((step) => {
    const out = forSavedFlow(step, { focusedField });
    const label = tappedLabel(step);
    if (label != null) focusedField = label;
    else if (!isTextStep(step)) focusedField = null;
    return out;
  });
}

/** An email address inside any text, for masking. Never spans a quote or a backslash. */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** What an email address is written down as. */
export const MASKED_EMAIL = '<email>';

/**
 * A value as it may be written to disk: every email address in every string
 * replaced by `<email>`, at any depth.
 *
 * simframe keeps what it read off a screen (the screen map, refs, the
 * escalation log), and a sign-in screen shows the username it was given. The
 * owner's rule is that no username reaches disk, so the memory of a screen
 * keeps its shape and forgets the address. What the agent is shown live is not
 * masked: this is for what is written down, nothing else. A recall that misses
 * because of the mask is a miss, and a miss out of memory earns a fresh read.
 */
export function maskCredentials(value) {
  if (typeof value === 'string') return value.includes('@') ? value.replace(EMAIL_IN_TEXT, MASKED_EMAIL) : value;
  if (Array.isArray(value)) return value.map(maskCredentials);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskCredentials(v);
    return out;
  }
  return value;
}

/** What typed text is written down as, in a stored screen reading. */
export const MASKED_TYPED = '<typed>';

const FIELD_TYPE = /field|textview|searchfield|securetext|textarea/i;

/**
 * A screen reading as it may be written to disk: what is in its text fields is
 * replaced by `<typed>`, and so is that same text anywhere else on the screen.
 *
 * Found by a peer test of 0.21.0: a username typed into "First Name" was kept in
 * the stored reading five ways — the field's value, the keyboard's suggestion
 * bar (which echoes the word above itself, whatever the field is called), the
 * suggestion's OCR alias, OCR's own reading of the field, and an occlusion note.
 * Field names cannot catch the suggestion bar, so the values themselves are the
 * thing to take out. A placeholder (a value equal to the field's own label) is
 * not typed text and stays.
 */
export function maskTyped(entry) {
  const targets = entry?.targets ?? [];
  const typedValues = [...new Set(targets
    .filter((t) => FIELD_TYPE.test(String(t.type ?? '')) && typeof t.value === 'string')
    .map((t) => ({ v: t.value.trim(), l: String(t.label ?? '').trim() }))
    .filter(({ v, l }) => v.length >= 2 && v !== l && v !== MASKED_TYPED)
    .map(({ v }) => v))].sort((a, b) => b.length - a.length);
  if (!typedValues.length) return entry;
  const scrub = (value) => {
    if (typeof value === 'string') {
      let out = value;
      for (const v of typedValues) out = out.split(v).join(MASKED_TYPED);
      return out;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(value)) o[k] = scrub(v);
      return o;
    }
    return value;
  };
  return scrub(entry);
}
