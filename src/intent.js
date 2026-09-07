// Human-level steps.
//
// A person filling an unfamiliar form does not study it. They pick something in
// the picker and hit whatever confirming button is on screen. Reproducing that
// instinct removes the expensive part of driving a UI with an agent: the model
// round trip spent reasoning about controls it has never seen.
import * as input from './input.js';

/** Confirming words, most specific first. The first tier with a hit wins. */
const CONFIRM_TIERS = [
  [/^apply$/i, /^confirm$/i, /^ok$/i],
  [/^done$/i, /^submit$/i, /^save$/i],
  [/^continue$/i, /^next$/i, /^yes$/i],
  [/^select$/i, /^choose$/i, /^add$/i],
];

const DISMISS = /^(cancel|reset|close|back|no|clear|dismiss)$/i;

export function onScreen(node, geo) {
  const f = node.frame;
  return f && f.y >= 0 && f.y < (geo?.pointHeight ?? 874) && f.x >= 0 && f.x < (geo?.pointWidth ?? 402);
}

/**
 * The control a person would press to commit what is on screen. Prefers enabled
 * controls, then the lowest one, then the rightmost — confirm sits bottom-right
 * of cancel by near-universal convention.
 */
export function findConfirm(nodes, geo) {
  const usable = nodes.filter(
    (n) => n.label && onScreen(n, geo) && !DISMISS.test(n.label.trim()),
  );
  for (const tier of CONFIRM_TIERS) {
    const hits = usable.filter((n) => tier.some((re) => re.test(n.label.trim())));
    if (!hits.length) continue;
    return hits.sort(
      (a, b) =>
        (b.enabled !== false) - (a.enabled !== false) ||
        b.frame.y - a.frame.y ||
        b.frame.x - a.frame.x,
    )[0];
  }
  return null;
}

/**
 * Selectable options in an open picker: labelled rows that are neither the
 * confirm/dismiss row nor the search box, sharing a left edge and a row height.
 */
export function findOptions(nodes, geo) {
  const confirm = findConfirm(nodes, geo);
  const floor = confirm ? confirm.frame.y - 8 : (geo?.pointHeight ?? 874);
  const rows = nodes.filter(
    (n) =>
      n.label &&
      onScreen(n, geo) &&
      n.frame.y > 120 &&
      n.frame.y < floor &&
      n.frame.height >= 12 &&
      n.frame.height <= 70 &&
      !DISMISS.test(n.label.trim()) &&
      !CONFIRM_TIERS.flat().some((re) => re.test(n.label.trim())) &&
      !/^search$/i.test(n.label.trim()) &&
      !/required|please select/i.test(n.label),
  );
  // Picker rows repeat a left edge; that is what separates them from headings.
  const byX = new Map();
  for (const r of rows) {
    const key = Math.round(r.frame.x / 8) * 8;
    byX.set(key, [...(byX.get(key) || []), r]);
  }
  const biggest = [...byX.values()].sort((a, b) => b.length - a.length)[0] || [];
  return biggest.length >= 2 ? biggest.sort((a, b) => a.frame.y - b.frame.y) : rows;
}

/** Pick an option without caring which — the human move in an unfamiliar picker. */
export async function chooseAny(udid, { prefer, geo } = {}) {
  const nodes = await input.describeAll(udid);
  const options = findOptions(nodes, geo);
  if (!options.length) throw new Error('no selectable options found on screen');
  const chosen =
    (prefer && options.find((o) => o.label.toLowerCase().includes(String(prefer).toLowerCase()))) ||
    options[0];
  const point = input.centerOf(chosen);
  await input.tapPoint(udid, point.x, point.y);
  return { label: chosen.label, point, optionCount: options.length };
}

export async function confirm(udid, { geo } = {}) {
  const nodes = await input.describeAll(udid);
  const target = findConfirm(nodes, geo);
  if (!target) throw new Error('no confirming control on screen');
  const point = input.centerOf(target);
  await input.tapPoint(udid, point.x, point.y);
  return { label: target.label, point, enabled: target.enabled };
}

export function isTextInput(node) {
  return /TextField|TextView|SearchField/i.test(node.type || '');
}
