/**
 * Goal mode: hand simframe a goal in words, and it drives to a milestone on its
 * own — done, blocked, ambiguous, not found, or out of budget — and only then
 * hands back.
 *
 * Why it exists. Measured on 24 real sessions of a field app (Phase 0,
 * docs/BENCHMARKS.md): an agent got about 1.1 actions per model call, and in a
 * hand-labelled sample up to 46 of 59 hand-backs were things a local runner
 * could have done itself — walk a known path, pick the row the goal names,
 * wait, retry, look one level down. CLAUDE.md's goal is a model consulted at
 * milestones, not per step. This is that.
 *
 * How it decides, cheapest first, for each target the goal names in order
 * ("Settings > Accessibility > Larger Text"):
 *   1. On screen now? Then it is found (a `find` goal ends here) or tapped.
 *   2. Known to the graph — a screen of that name, or a door with that label —
 *      and reachable by a remembered route? Walk it. No exploration, no model.
 *   3. Otherwise explore for it: one bounded `seek`, at most six actions
 *      (CLAUDE.md: "six actions per attempt, then escalate"; never explore
 *      when a graph path exists).
 *
 * What it will not do. Tap anything the verify barrier forbids, even when the
 * goal names it ("delete the draft" stops at Delete and asks). Guess between
 * two matches. Report done on a screen it has not confirmed: the evidence is a
 * fresh read with the final target on it, or the screen the last tap reached.
 * Every hand-back carries one of the five escalation reasons.
 *
 * Injectable, like the cartographer: `runGoal(driver, …)` is pure decision
 * logic; `deviceDriver` in this file drives a simulator through `locate`,
 * `runScript` and the graph.
 */
import * as actions from './actions.js';
import * as api from './index.js';
import * as graph from './graph.js';
import * as matching from './matching.js';
import * as metrics from './metrics.js';
import * as navigate from './navigate.js';
import * as vocabulary from './vocabulary.js';

export const SEEK_ACTIONS = 6;
export const DEFAULT_MAX_ACTIONS = 30;
export const DEFAULT_BUDGET_MS = 120000;

const FIND_VERBS = /^(find|show( me)?|check( for| that)?|look for|is there|see|locate|verify|confirm that)\s+/i;
const OPEN_VERBS = /^(open|go to|navigate to|get to|reach|take me to|tap|press|select|choose|enter|visit)\s+/i;

/**
 * A goal in words → `{ mode, targets }`. `find` ends with the last target on
 * screen; `open` ends having tapped it, or standing on the screen it names.
 * Targets are split on ">", "→" and " then ", never on commas: a label such as
 * "Display & Text Size" or "Brentwood, Store 9" has them.
 */
export function parseGoal(text) {
  let s = String(text ?? '').trim().replace(/[.!]+$/, '');
  let mode = 'open';
  if (FIND_VERBS.test(s)) { mode = 'find'; s = s.replace(FIND_VERBS, ''); } else s = s.replace(OPEN_VERBS, '');
  const targets = s.split(/\s*(?:>|→|->|\bthen\b)\s*/i)
    .map((t) => t.replace(OPEN_VERBS, '')
      .replace(/^(the|a|an)\s+/i, '')
      .replace(/\s+(is|are)\s+(there|visible|shown|on screen)$/i, '')
      .replace(/\s+(screen|page|tab|button)$/i, '')
      .trim())
    .filter(Boolean);
  return { mode, targets };
}

/** Is this element the screen's title rather than a control? */
export function isTitle(el) {
  return /heading/i.test(String(el?.type ?? '')) || (el?.region === 'nav-bar' && el?.navSlot === 'title');
}

/** May goal mode tap this label itself? Destructive or leave-the-app words stop it. */
export function barrierFor(label, { locale } = {}) {
  const v = vocabulary.mayActLocally(label, { locale, purpose: 'substitute' });
  return v.allowed ? null : `${v.reason} ("${v.matched}")`;
}

/**
 * Drive to the goal. Returns a milestone:
 * `{ status: 'done'|'blocked'|'ambiguous'|'not-found'|'failed'|'budget', reason?, … }`
 * plus `log` (what was done, in order) and `actions`.
 */
export async function runGoal(driver, {
  goal,
  maxActions = DEFAULT_MAX_ACTIONS,
  budgetMs = DEFAULT_BUDGET_MS,
  locale,
  now = () => Date.now(),
} = {}) {
  const { mode, targets } = parseGoal(goal);
  const log = [];
  let actions_ = 0;
  const t0 = now();
  const out = (status, extra = {}) => ({ status, goal, mode, targets, log, actions: actions_, ms: now() - t0, ...extra });
  if (!targets.length) return out('not-found', { reason: 'no_plan', detail: 'the goal names nothing to reach' });

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const last = i === targets.length - 1;
    if (actions_ >= maxActions || now() - t0 >= budgetMs) {
      return out('budget', { reason: 'no_plan', detail: `budget spent before "${target}"` });
    }

    // 1. On screen now.
    let here = await driver.locate(target);
    if (here.status === 'ambiguous') {
      return out('ambiguous', { reason: 'ambiguous_intent', detail: `"${target}" matches ${here.candidates.length} things on this screen`, candidates: here.candidates });
    }

    if (here.status !== 'found') {
      // 2. A remembered route: to a screen of that name, or through a door
      //    with that label.
      // A find goal stops where the door is visible; it does not open it.
      const known = await driver.knownRoute(target, { through: !(last && mode === 'find') });
      if (known?.ambiguous) {
        return out('ambiguous', { reason: 'ambiguous_intent', detail: `"${target}" fits ${known.ambiguous.length} remembered screens`, candidates: known.ambiguous });
      }
      if (known?.route?.length) {
        const walked = await driver.walk(known.route);
        actions_ += walked.steps ?? known.route.length;
        log.push(`walked a remembered route of ${known.route.length} step(s) to "${target}"${known.via === 'door' ? ' (through a door with that label)' : ''}`);
        if (walked.ok && known.stoppedBefore) {
          // Standing where the door is: it is looked up below like any control.
          here = await driver.locate(target);
        } else if (walked.ok) {
          // A route through the door ends on the screen behind it; a route to
          // a named screen ends on it. Either way the target is reached.
          if (last) return finish(driver, out, { target, mode, reached: known.via });
          continue;
        }
        if (!walked.ok) {
        // A remembered route that does not hold — the graph can confuse two
        // screens that look alike (DEFERRED 174) — is not the end. A person
        // would look; so does this, from wherever the route left off.
        log.push(`the remembered route did not hold (${walked.detail ?? 'did not arrive'}); looking instead`);
        here = await driver.locate(target);
        }
        if (here.status === 'ambiguous') return out('ambiguous', { reason: 'ambiguous_intent', detail: `"${target}" matches ${here.candidates.length} things on this screen`, candidates: here.candidates });
      } else if (known?.already) {
        log.push(`already on "${target}"`);
        if (last) return finish(driver, out, { target, mode, reached: 'screen' });
        continue;
      }

    }
    if (here.status !== 'found') {
      // 3. Explore for it, bounded.
      if (actions_ + SEEK_ACTIONS > maxActions) return out('budget', { reason: 'no_plan', detail: `no remembered route to "${target}", and not enough budget left to look for it` });
      const sought = await driver.seek(target, SEEK_ACTIONS);
      actions_ += sought.steps ?? 0;
      log.push(sought.found ? `found "${target}" by looking (${sought.steps ?? 0} step(s))` : `looked for "${target}" (${sought.steps ?? 0} step(s)) and did not find it`);
      if (!sought.found) {
        return out('not-found', { reason: sought.reason ?? 'no_plan', detail: sought.detail ?? `"${target}" is not on this screen, not in memory, and not within ${SEEK_ACTIONS} steps of here`, opened: sought.opened });
      }
      here = await driver.locate(target);
      if (here.status === 'ambiguous') return out('ambiguous', { reason: 'ambiguous_intent', detail: `"${target}" matches ${here.candidates.length} things on this screen`, candidates: here.candidates });
      if (here.status !== 'found') return out('failed', { reason: 'verification_failed', detail: `the search reported "${target}" found, and a fresh read does not show it` });
    }

    // Found on screen. A find goal's last target ends here.
    if (last && mode === 'find') return finish(driver, out, { target, mode, element: here.target });

    // The screen's own title names where you already are: "Settings > General"
    // started by tapping the "Settings" heading. Nothing to tap.
    if (isTitle(here.target)) {
      log.push(`already on "${target}"`);
      if (last) return finish(driver, out, { target, mode, reached: 'screen' });
      continue;
    }

    // Tapping it is an action goal mode takes on its own initiative, so the
    // barrier decides — even when the goal named the control.
    const blocked = barrierFor(here.target.label, { locale });
    if (blocked) {
      return out('blocked', { reason: 'no_plan', detail: `"${here.target.label}" is ${blocked}; goal mode does not tap it. Tap it yourself if you mean to.`, element: here.target });
    }
    const tapped = await driver.tap(here.target);
    actions_ += 1;
    log.push(`tapped "${here.target.label}"`);
    if (!tapped.ok || /^unexpected/.test(tapped.verdict ?? '')) {
      return out('failed', { reason: 'verification_failed', detail: tapped.detail ?? `tapping "${here.target.label}" ${tapped.verdict ?? 'failed'}` });
    }
    if (last) return finish(driver, out, { target, mode, tapped, element: here.target });
  }
  return out('failed', { reason: 'no_plan', detail: 'ran out of targets without a milestone' });
}

/**
 * Done only with evidence. A fresh read of where it stands; a tap that changed
 * nothing visible is not reported as done.
 */
async function finish(driver, out, { target, mode, element = null, tapped = null, reached = null }) {
  const at = await driver.here();
  if (tapped && tapped.verdict === 'no-visible-change') {
    return out('failed', { reason: 'verification_failed', detail: `tapped "${element.label}", and the screen did not visibly change — not reporting the goal done`, at });
  }
  if (!at?.hash) return out('failed', { reason: 'unknown_screen', detail: 'could not identify the screen it ended on — not reporting the goal done' });
  const evidence = mode === 'find'
    ? `"${element.label}" is on screen at ${element.x},${element.y}`
    : tapped
      ? `tapped "${element.label}"${tapped.verdict ? ` (${tapped.verdict})` : ''}`
      : `reached the screen for "${target}" by a remembered route`;
  return out('done', { at, evidence, reached });
}

// ── the report ───────────────────────────────────────────────────────────

/** A milestone as text, for the CLI and MCP. No images. */
export function renderGoal(r) {
  const secs = (r.ms / 1000).toFixed(1);
  const head = {
    done: 'GOAL DONE',
    blocked: 'GOAL STOPPED — blocked by the verify barrier',
    ambiguous: 'GOAL STOPPED — ambiguous',
    'not-found': 'GOAL STOPPED — not found',
    failed: 'GOAL STOPPED — could not confirm a step',
    budget: 'GOAL STOPPED — budget spent',
  }[r.status] ?? `GOAL ${r.status}`;
  const lines = [`${head}: "${r.goal}" — ${r.actions} action(s), ${secs}s, no model calls in between`];
  if (r.status === 'done') {
    lines.push(`evidence: ${r.evidence}; now on screen ${String(r.at.hash).slice(0, 8)}${r.at.name ? ` "${r.at.name}"` : ''}`);
  } else {
    lines.push(`why: ${r.detail}${r.reason ? ` [${r.reason}]` : ''}`);
    if (r.candidates?.length) {
      lines.push(`candidates: ${r.candidates.slice(0, 6).map((c, i) => `[${i}] "${c.label ?? c.name}"${c.x != null ? ` (${c.x},${c.y})` : ''}`).join(', ')} — name one exactly and call again`);
    }
    if (r.opened?.length) lines.push(`opened while looking: ${r.opened.map((o) => `"${o}"`).join(' → ')}`);
  }
  if (r.log.length) lines.push(`done so far: ${r.log.join('; ')}`);
  return lines.join('\n');
}

// ── the device driver ────────────────────────────────────────────────────

/** Doors in the graph whose label fits the target: the screens behind them. */
function doorsNamed(udid, target) {
  const hits = [];
  for (const node of graph.allNodes(udid)) {
    for (const e of node.edges ?? []) {
      if (!/^tap:/.test(e.action)) continue;
      const label = e.action.slice(4);
      if (/^[@#]/.test(label)) continue;
      const score = matching.nameScore(label, target);
      if (score >= 0.8) hits.push({ from: node.hash, edge: e, label, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

export function deviceDriver(udid, { options = {}, flowName = null } = {}) {
  const run = (steps) => actions.runScript(udid, { steps, options, flowName, stopOnUnexpected: true });
  const identity = () => api.screenIdentity(udid, { options, confirmNovel: false }).catch(() => null);

  return {
    async locate(target) {
      try {
        // Fresh, every time. Memory "may confirm, never deny" — and on a
        // screen the graph has merged with another, memory confirmed a door
        // that was not there, and goal mode walked into it (2026-10-03).
        // Goal mode decides what to tap; it pays the read to be right.
        const r = await api.locate(udid, target, { options, refresh: true });
        return r?.target ? { status: 'found', target: r.target } : { status: 'absent' };
      } catch (err) {
        const e = metrics.escalationOf(err);
        if (e?.ambiguous && e.candidates?.length) return { status: 'ambiguous', candidates: e.candidates };
        return { status: 'absent' };
      }
    },
    async knownRoute(target, { through = true } = {}) {
      const here = await identity();
      if (!here?.hash) return null;
      const screen = graph.findScreen(udid, target);
      if (screen?.ambiguous) return { ambiguous: screen.ambiguous };
      if (screen?.node) {
        if (graph.sameScreen(udid, here, screen.node.hash)) return { already: true };
        const r = graph.route(udid, here, screen.node.hash);
        const first = r?.[0]?.action?.startsWith('tap:') ? r[0].action.slice(4) : null;
        if (r?.length && (!first || await this.visibleControl(first))) return { route: r, via: 'screen', to: screen.name };
      }
      // Through a door the graph remembers with that label.
      const doors = doorsNamed(udid, target);
      const reachable = [];
      for (const d of doors.slice(0, 8)) {
        const toFrom = graph.sameScreen(udid, here, d.from) ? [] : graph.route(udid, here, d.from);
        if (toFrom) reachable.push({ ...d, route: through ? [...toFrom, d.edge] : toFrom });
      }
      // A route whose first step is not on screen starts from a screen the
      // graph mistook for this one (DEFERRED 174): drop it before it costs a tap.
      const firstVisible = async (route) => {
        const label = route[0]?.action?.startsWith('tap:') ? route[0].action.slice(4) : null;
        if (!label) return true;
        return this.visibleControl(label);
      };
      const valid = [];
      for (const r of reachable) if (!r.route.length || await firstVisible(r.route)) valid.push(r);
      // Failing that, a route by labels rather than by identity: from the
      // screen the door is on, back along remembered doors to one visible here.
      if (!valid.length) {
        const chain = await this.labelChain(doors, { through });
        if (chain) return chain;
        return null;
      }
      const best = valid.sort((a, b) => (b.score - a.score) || (a.route.length - b.route.length));
      // Two doors that fit equally well and lead to different screens is a question.
      if (best[1] && best[0].score - best[1].score < 0.05 && best[0].edge.to !== best[1].edge.to) {
        return { ambiguous: best.slice(0, 3).map((d) => ({ name: `${d.label} (from ${d.from.slice(0, 8)})` })) };
      }
      if (!through && !best[0].route.length) return null; // the door is here; locate already said no
      return { route: best[0].route, via: 'door', to: best[0].label, stoppedBefore: !through };
    },
    /**
     * A route found by labels: the target's door is on screen S; a remembered
     * door whose destination is S, visible here, is the first step. Up to three
     * steps back. Identity is used only to join edges, never to say where
     * "here" is — the label being on screen says that.
     */
    async labelChain(doors, { through = true } = {}) {
      const nodes = graph.allNodes(udid);
      const byHash = new Map(nodes.map((n) => [n.hash, n]));
      const nameOf = (hash) => { const n = byHash.get(hash); return n ? graph.describe(n) : null; };
      // Joined by name as well as identity: a screen split into several
      // identities (Settings' Accessibility had three) keeps its doors on one
      // and its way in on another. Every step is still checked on screen and
      // verified when walked, so a wrong join costs a failed step, not a wrong tap.
      const same = (a, b) => graph.sameScreen(udid, a, b) || (nameOf(a) && nameOf(a) === nameOf(b));
      const into = (hash) => nodes.flatMap((n) => (n.edges ?? [])
        .filter((e) => /^tap:[^@#]/.test(e.action) && same(e.to, hash))
        .map((e) => ({ node: n, edge: e })));
      const seen = new Set();
      const checked = new Map(); // one fresh look per label, however many edges carry it
      let frontier = doors.slice(0, 4).map((d) => ({ screen: d.from, path: through ? [d.edge] : [], label: d.label }));
      for (let depth = 0; depth < 3 && frontier.length; depth += 1) {
        const next = [];
        for (const f of frontier) {
          for (const { node, edge } of into(f.screen).slice(0, 12)) {
            const key = `${node.hash}|${edge.action}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const path = [edge, ...f.path];
            const label = edge.action.slice(4);
            if (!checked.has(label)) checked.set(label, await this.visibleControl(label));
            if (checked.get(label)) {
              return { route: path, via: 'door', to: f.label, stoppedBefore: !through, byLabels: true };
            }
            next.push({ screen: node.hash, path, label: f.label });
          }
        }
        frontier = next;
      }
      return null;
    },
    /** Is this label on screen as a control — not the screen's title, not the back button? */
    async visibleControl(label) {
      const r = await this.locate(label);
      if (r.status !== 'found') return false;
      const t = r.target;
      return !isTitle(t) && !((t.x ?? 999) <= 60 && (t.y ?? 999) <= 130);
    },
    async walk(route) {
      const steps = route.map(navigate.stepFor);
      if (steps.some((s) => !s)) return { ok: false, steps: 0, reason: 'no_plan', detail: 'a remembered step cannot be replayed' };
      const res = await run(steps);
      const bad = (res.results ?? []).find((r) => !r.ok || /^unexpected/.test(r.verification?.verdict ?? ''));
      return { ok: res.ok && !bad, steps: res.ranSteps ?? 0, reason: bad ? 'verification_failed' : null, detail: bad?.error ?? bad?.verification?.detail ?? null };
    },
    async seek(target, budget) {
      const res = await run([{ seek: target, budget }]);
      const r = res.results?.[0] ?? {};
      const text = String(r.detail ?? r.note ?? r.error ?? '');
      const steps = Number(/\((\d+) of \d+ step/.exec(text)?.[1] ?? (res.ok ? 0 : budget));
      const openedPart = /Opened: (.*?)\. Now on/.exec(text)?.[1] ?? '';
      const opened = [...openedPart.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      return { found: res.ok && /found|already here/.test(text), steps, detail: res.ok ? null : text, opened };
    },
    async tap(target) {
      // By point: the element was just located on this screen, and its label
      // may be a name simframe derived (an icon glyph) rather than the tree's.
      const res = await run([{ tapAt: { x: Math.round(target.x), y: Math.round(target.y) } }]);
      const r = res.results?.[0] ?? {};
      const named = /\b(unexpected-[a-z-]+)/.exec(String(r.error ?? ''))?.[1] ?? null;
      return { ok: res.ok, verdict: r.verification?.verdict ?? named, detail: r.error ?? null };
    },
    async here() {
      const id = await api.screenIdentity(udid, { options, confirmNovel: false, fresh: true }).catch(() => null);
      if (!id?.hash) return null;
      const node = graph.nearestScreen(udid, id)?.node;
      return { hash: id.hash, name: node ? graph.describe(node) : null };
    },
  };
}

/** Run a goal on a device, log the hand-back, return `{ result, text }`. */
export async function goal(deviceQuery, text, { options = {}, maxActions, minutes } = {}) {
  if (!String(text ?? '').trim()) throw new Error('usage: simframe goal "<goal in words>" [--actions=30] [--minutes=2]');
  const { device } = await api.ensureDaemon(deviceQuery, options);
  const flowName = `goal: ${String(text).slice(0, 60)}`;
  const result = await runGoal(deviceDriver(device.udid, { options, flowName }), {
    goal: text,
    maxActions: maxActions ?? DEFAULT_MAX_ACTIONS,
    budgetMs: minutes ? minutes * 60000 : DEFAULT_BUDGET_MS,
  });
  // A hand-back that is not "done" is an escalation, and carries its reason.
  if (result.status !== 'done') {
    try {
      metrics.recordEscalation(device.udid, {
        reason: result.reason ?? 'no_plan',
        flowName,
        intent: String(text).slice(0, 120),
        classified: true,
        outcome: 'escalated_to_model',
        detail: `goal ${result.status}: ${result.detail ?? ''}`.slice(0, 300),
        candidates: (result.candidates ?? []).slice(0, 6),
      });
    } catch { /* a log that cannot be written must not change the answer */ }
  }
  return { device, result, text: renderGoal(result) };
}
