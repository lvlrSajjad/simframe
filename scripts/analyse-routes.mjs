#!/usr/bin/env node
/**
 * Would routing by measured time differ from routing by hop count, and by how
 * much? EXPERIMENTS §16, kept runnable because the answer was "barely" and that
 * is the kind of result that gets re-litigated by someone's intuition.
 *
 * `route()` in graph.js is a plain BFS over hop count, while `record()` has
 * been storing a settle sample on nearly every edge all along (97% and 85% of
 * edges on the two real-app graphs measured). This compares the two.
 *
 * Measured: the fastest route differs from the fewest-hops route on 9%, 0% and
 * 7% of reachable pairs, saving a median of 1853ms, — and 615ms. Real, unused,
 * and pointed at the wrong prize — it saves seconds, not round trips, and round
 * trips are what the human-parity series exists to reduce.
 *
 * Output is aggregate by design: this reads a real device's memory of real
 * third-party apps, so it prints counts and never a label, a screen or an app
 * name. Same standing rule as scripts/phase17-corpus.mjs.
 *
 * Usage: node scripts/analyse-routes.mjs <udid-prefix> [<udid-prefix>...] */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = process.env.SIMFRAME_HOME || path.join(os.homedir(), '.simframe');
const median = (a) => { const s=[...a].sort((x,y)=>x-y); return s.length? (s.length%2? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2) : null; };

for (const dev of process.argv.slice(2)) {
  const dir = fs.readdirSync(root).find((d) => d.startsWith(dev));
  if (!dir) continue;
  const gdir = path.join(root, dir, 'graph');
  if (!fs.existsSync(gdir)) continue;
  const nodes = fs.readdirSync(gdir).filter(f=>f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(gdir,f),'utf8')); } catch { return null; } })
    .filter(Boolean);

  const byHash = new Map();
  for (const n of nodes) { byHash.set(n.hash, n); for (const v of n.variants ?? []) if(!byHash.has(v.hash)) byHash.set(v.hash, n); }
  const canonical = (h) => byHash.get(h)?.hash ?? h;

  // Edge costs: the median settle actually measured on that edge.
  const all = [];
  for (const n of nodes) for (const e of n.edges ?? []) { const m = median(e.settles ?? []); if (m!=null) all.push(m); }
  const fallback = median(all) ?? 500;
  const cost = (e) => median(e.settles ?? []) ?? fallback;

  // BFS exactly as graph.js does it: first path found, insertion order.
  const bfs = (start, goal) => {
    const seen = new Set([start]); const q = [{h:start, p:[]}];
    while (q.length) { const {h,p} = q.shift();
      if (p.length >= 12) continue;
      for (const e of byHash.get(h)?.edges ?? []) {
        const to = canonical(e.to); const next=[...p,e];
        if (to === goal) return next;
        if (seen.has(to)) continue; seen.add(to); q.push({h:to,p:next});
      } }
    return null;
  };
  // Dijkstra on measured time.
  const fastest = (start, goal) => {
    const dist = new Map([[start,0]]); const prev = new Map(); const done = new Set();
    while (true) {
      let cur=null, best=Infinity;
      for (const [h,d] of dist) if (!done.has(h) && d<best) { best=d; cur=h; }
      if (cur==null) break;
      if (cur===goal) break;
      done.add(cur);
      for (const e of byHash.get(cur)?.edges ?? []) {
        const to = canonical(e.to); const nd = best + cost(e);
        if (nd < (dist.get(to) ?? Infinity)) { dist.set(to,nd); prev.set(to,[cur,e]); }
      } }
    if (!dist.has(goal)) return null;
    const out=[]; let at=goal;
    while (prev.has(at)) { const [from,e]=prev.get(at); out.unshift(e); at=from; }
    return out;
  };

  const canon = [...new Set(nodes.map(n=>n.hash))];
  let pairs=0, differ=0, saved=[], hopsUp=0;
  for (const s of canon) for (const g of canon) {
    if (s===g) continue;
    const b = bfs(s,g); if (!b) continue;
    const f = fastest(s,g); if (!f) continue;
    pairs++;
    const cb = b.reduce((t,e)=>t+cost(e),0), cf = f.reduce((t,e)=>t+cost(e),0);
    if (cf < cb - 1) { differ++; saved.push(cb-cf); if (f.length > b.length) hopsUp++; }
  }
  saved.sort((a,b)=>a-b);
  console.log(`--- ${dev} ---`);
  console.log(`  reachable pairs: ${pairs}`);
  console.log(`  where the fastest route differs from the fewest-hops route: ${differ} (${pairs?Math.round(100*differ/pairs):0}%)`);
  if (saved.length) {
    console.log(`  time saved per such route — median ${Math.round(median(saved))}ms, max ${Math.round(saved[saved.length-1])}ms`);
    console.log(`  ...of those, routes that take MORE hops to be faster: ${hopsUp}`);
  }
}
