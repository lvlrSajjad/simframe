/**
 * Carrying what simframe learned across a change to its fingerprint rules, and
 * saying out loud what could not be carried.
 *
 * A screen's identity is a hash of tokens, and the token rules have a version.
 * When the rules changed, every node and every screen map written under the old
 * version stopped being read — `allNodes` and `screenmap.usable` filter on the
 * version — and nothing said so. Measured on 2026-10-01: a multi-step request form
 * path on the bench device, learned over a week, had become invisible, and the
 * agent was told "new to simframe" on screens it had driven dozens of times.
 *
 * Most of it was never wrong. A screen map keeps the full element list it was
 * built from, so its identity can be recomputed under today's rules: 209 of 209
 * version-5 readings on that device reproduced their stored hash exactly, and
 * 199 of them still did after their regions were re-derived from geometry,
 * which is what a live read does. So the identity a reading would get today is
 * computable offline, and a graph node is keyed by that identity.
 *
 * What this does, once per device per process, before the first read:
 *   1. Re-fingerprint every screen map written under older rules, the way a live
 *      read would (regions re-derived, then the current token rules). Update it
 *      in place; it is now usable again.
 *   2. Build old-hash → new-hash from those readings. One old hash that maps to
 *      two new ones is a *split* under the new rules and is not guessed at.
 *   3. Rewrite each old graph node under its new hash with its edges re-pointed,
 *      merging into a current node of the same identity rather than replacing
 *      it. Carried edges are marked `carriedFrom`, so a first live traversal is
 *      known to be the first under these rules. Their prediction is checked like
 *      any edge's, and a mismatch stops a flow as `unexpected-screen`.
 *   4. Anything with no reading to recompute from is *lost*. It is moved to
 *      `graph/retired/` and counted, and the count is what `doctor`, `screens`
 *      and the screen header report. "Lost" is a fact about memory, and memory
 *      that vanishes silently is the failure this module exists to end.
 *
 * Nothing is deleted. Retired files keep their old version fields.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as fingerprint from './fingerprint.js';
import * as graph from './graph.js';
import * as regions from './regions.js';
import * as screenmap from './screenmap.js';
import * as store from './store.js';
import * as typed from './typed.js';

// Beside the graph, not in it: graph/ is read as one node per .json file.
const REPORT = 'memory-carry.json';
const reportFile = (udid) => path.join(store.deviceDir(udid), REPORT);

const readDir = (dir) => {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
};

const currentGraph = (n) => n?.version === graph.GRAPH_VERSION && n?.fingerprintVersion === graph.FINGERPRINT_VERSION;
const currentMap = (e) => e?.version === screenmap.MAP_VERSION && e?.fingerprintVersion === fingerprint.TOKEN_RULES_VERSION;

/** What on disk is not being read, without changing anything. */
export function staleness(udid) {
  const out = { graph: { files: 0, edges: 0, versions: {} }, screens: { files: 0, versions: {} } };
  const gdir = graph.graphDir(udid);
  for (const f of readDir(gdir)) {
    const n = store.readJson(path.join(gdir, f));
    if (!n || currentGraph(n)) continue;
    out.graph.files += 1;
    out.graph.edges += n.edges?.length ?? 0;
    const v = `v${n.fingerprintVersion ?? '?'}`;
    out.graph.versions[v] = (out.graph.versions[v] ?? 0) + 1;
  }
  const sdir = screenmap.mapDir(udid);
  for (const f of readDir(sdir)) {
    const e = store.readJson(path.join(sdir, f));
    if (!e || currentMap(e)) continue;
    out.screens.files += 1;
    const v = `v${e.fingerprintVersion ?? '?'}`;
    out.screens.versions[v] = (out.screens.versions[v] ?? 0) + 1;
  }
  return out;
}

/** The last carry's report for this device, or null if none ever ran. */
export function lastReport(udid) {
  return store.readJson(reportFile(udid)) ?? null;
}

/** A reading re-fingerprinted the way a live read would do it today. */
function refingerprint(entry, screen) {
  const targets = structuredClone(entry.targets ?? []).map(({ region, navSlot, ...t }) => t);
  regions.annotate(targets, screen);
  const fp = fingerprint.fingerprint(targets, screen);
  return { targets, ...fp };
}

function mergeEdges(into, edges) {
  const have = new Set((into.edges ?? []).map((e) => e.action));
  for (const e of edges) if (!have.has(e.action)) into.edges.push(e);
  return into;
}

/**
 * Carry older memory forward to the current rules. `screen` is the device's
 * size in points, which identity depends on and an old reading did not store.
 */
export function carryForward(udid, { screen, dryRun = false, now = Date.now() } = {}) {
  const report = {
    at: now,
    toVersion: fingerprint.TOKEN_RULES_VERSION,
    screens: { carried: 0, sameIdentity: 0, newIdentity: 0, unreadable: 0 },
    graph: { carried: 0, merged: 0, edgesCarried: 0, edgesLost: 0, lost: 0, split: 0, lostEdges: 0 },
    fromVersions: {},
  };
  if (!screen?.width || !screen?.height) return { ...report, skipped: 'no screen size' };

  // 1 + 2: readings, and what each old identity is called now.
  const mapping = new Map();
  const note = (oldHash, newHash) => {
    if (!oldHash || !newHash) return;
    if (!mapping.has(oldHash)) mapping.set(oldHash, new Set());
    mapping.get(oldHash).add(newHash);
  };
  const currentIds = new Set();
  const tokensOf = new Map();
  const sdir = screenmap.mapDir(udid);
  for (const f of readDir(sdir)) {
    const file = path.join(sdir, f);
    const e = store.readJson(file);
    if (!e) continue;
    if (currentMap(e)) {
      if (e.structuralHash) { currentIds.add(e.structuralHash); tokensOf.set(e.structuralHash, e.structuralTokens ?? []); }
      continue;
    }
    // A different map schema is a different shape of record, not a different
    // rule over the same record. Not guessed at.
    if (e.version !== screenmap.MAP_VERSION || !Array.isArray(e.targets)) {
      report.screens.unreadable += 1;
      // Moved aside, not left to be found stale on every start: a reading that
      // stayed here made every process carry again, and each carry rewrote the
      // report with zeros, so doctor said "nothing lost" (peer test, 0.21.0).
      if (!dryRun) {
        fs.mkdirSync(path.join(sdir, 'retired'), { recursive: true });
        fs.renameSync(file, path.join(sdir, 'retired', f));
      }
      continue;
    }
    const fp = refingerprint(e, screen);
    if (!fp.hash) { report.screens.unreadable += 1; continue; }
    note(e.structuralHash, fp.hash);
    currentIds.add(fp.hash);
    if (!tokensOf.has(fp.hash)) tokensOf.set(fp.hash, fp.tokens);
    report.screens.carried += 1;
    if (fp.hash === e.structuralHash) report.screens.sameIdentity += 1; else report.screens.newIdentity += 1;
    if (!dryRun) {
      store.writeAtomic(file, JSON.stringify(typed.maskCredentials({
        ...e,
        fingerprintVersion: fingerprint.TOKEN_RULES_VERSION,
        structuralHash: fp.hash,
        structuralTokens: fp.tokens,
        keyboard: fp.keyboard,
        targets: fp.targets,
        carriedFrom: e.fingerprintVersion ?? null,
      })));
    }
  }

  // 3 + 4: graph nodes.
  const gdir = graph.graphDir(udid);
  const raw = readDir(gdir).map((f) => ({ f, n: store.readJson(path.join(gdir, f)) })).filter((x) => x.n);
  for (const { n } of raw) if (currentGraph(n)) currentIds.add(n.hash);
  const single = (h) => {
    const s = mapping.get(h);
    if (s?.size === 1) return [...s][0];
    if (!s && currentIds.has(h)) return h;
    return null;
  };
  const retire = (f, n) => {
    if (dryRun) return;
    const dir = path.join(gdir, 'retired');
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(path.join(gdir, f), path.join(dir, `${n.hash}.v${n.fingerprintVersion ?? 'x'}.json`));
  };
  for (const { f, n } of raw) {
    if (currentGraph(n)) continue;
    const v = `v${n.fingerprintVersion ?? '?'}`;
    report.fromVersions[v] = (report.fromVersions[v] ?? 0) + 1;
    const edges = n.edges ?? [];
    if (n.version !== graph.GRAPH_VERSION || mapping.get(n.hash)?.size > 1 || !single(n.hash)) {
      if (mapping.get(n.hash)?.size > 1) report.graph.split += 1; else report.graph.lost += 1;
      report.graph.lostEdges += edges.length;
      retire(f, n);
      continue;
    }
    const hash = single(n.hash);
    const carried = [];
    for (const e of edges) {
      const to = single(e.to);
      if (!to) { report.graph.edgesLost += 1; continue; }
      carried.push({ ...e, to, carriedFrom: n.fingerprintVersion ?? null });
    }
    const fresh = {
      version: graph.GRAPH_VERSION,
      fingerprintVersion: graph.FINGERPRINT_VERSION,
      hash,
      // Tokens come from the reading that produced this identity, not the old node.
      tokens: [],
      layoutHash: n.layoutHash ?? null,
      variants: [],
      edges: [],
    };
    const sameFile = hash === n.hash;
    const existing = sameFile ? null : store.readJson(path.join(gdir, `${hash}.json`));
    const target = existing && currentGraph(existing) ? existing : fresh;
    if (target === existing) report.graph.merged += 1;
    mergeEdges(target, carried);
    if (!target.tokens?.length) target.tokens = tokensOf.get(hash) ?? [];
    report.graph.carried += 1;
    report.graph.edgesCarried += carried.length;
    if (!dryRun) {
      if (!sameFile) retire(f, n);
      graph.saveNode(udid, target);
    }
  }
  // A current node's edge can point at an identity that was just renamed.
  for (const { n } of raw) {
    if (!currentGraph(n)) continue;
    let changed = false;
    for (const e of n.edges ?? []) {
      const to = mapping.get(e.to)?.size === 1 ? [...mapping.get(e.to)][0] : null;
      if (to && to !== e.to) { e.to = to; changed = true; }
    }
    if (changed && !dryRun) graph.saveNode(udid, n);
  }
  if (!dryRun) {
    store.writeAtomic(reportFile(udid), JSON.stringify(report));
    lines.delete(udid);
  }
  return report;
}

const ran = new Set();

/**
 * Carry once per device per process, when there is something to carry. Cheap
 * when there is not: one directory listing of version fields.
 */
export function ensureCarried(udid, screen) {
  if (ran.has(udid) || !screen?.width) return null;
  ran.add(udid);
  try {
    const s = staleness(udid);
    if (!s.graph.files && !s.screens.files) return null;
    return carryForward(udid, { screen });
  } catch {
    // Memory that cannot be carried must not stop a read. `doctor` still sees
    // the stale files and says so.
    return null;
  }
}

const lines = new Map();

/**
 * Short form for the screen header, from cache: a header is printed on every
 * call and a staleness scan reads every file, so it is scanned once per process.
 */
export function headerNote(udid) {
  if (!udid) return null;
  if (!lines.has(udid)) lines.set(udid, memoryCounts(udid));
  const c = lines.get(udid);
  if (!c?.missing) return null;
  return `${c.missing} screen(s) learned under older fingerprint rules are not in memory; see doctor`;
}

/**
 * What is retired, counted from the folders themselves. The last carry's report
 * only knows its own run, and a later run with nothing to do wrote zeros over
 * an earlier one's losses.
 */
export function retired(udid) {
  const count = (dir) => readDir(dir).length;
  const gdir = path.join(graph.graphDir(udid), 'retired');
  let edges = 0;
  for (const f of readDir(gdir)) edges += store.readJson(path.join(gdir, f))?.edges?.length ?? 0;
  return { screens: count(gdir), edges, readings: count(path.join(screenmap.mapDir(udid), 'retired')) };
}

function memoryCounts(udid) {
  try {
    return { missing: retired(udid).screens + staleness(udid).graph.files };
  } catch {
    return null;
  }
}

/** One line for a human about memory that is not in use, or null. */
export function memoryLine(udid) {
  const s = staleness(udid);
  const gone = retired(udid);
  const parts = [];
  if (gone.screens) {
    parts.push(`${gone.screens} screen(s) and ${gone.edges} step(s) learned under older fingerprint rules could not be carried over — they are in graph/retired/`);
  }
  if (gone.readings) parts.push(`${gone.readings} stored screen reading(s) were in an older format and could not be rebuilt — they are in screens/retired/`);
  if (s.graph.files) parts.push(`${s.graph.files} screen(s) and ${s.graph.edges} step(s) are under older fingerprint rules and not in use yet (${Object.entries(s.graph.versions).map(([v, n]) => `${n} ${v}`).join(', ')})`);
  return parts.length ? `memory: ${parts.join('; ')}` : null;
}
