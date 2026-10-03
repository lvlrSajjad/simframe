#!/usr/bin/env node
// Tokens and model calls per verified flow: simframe's ways of driving a flow
// against the way screenshot-driven tools drive one.
//
//   node scripts/bench-headtohead.mjs --device=<udid> [--runs=3] [--flows=flows/hpi-suite.json] [--out=file.json]
//
// Four arms, each on the same device, flow and simframe actions, so the only
// thing that differs is what the model is handed and how often it is asked:
//
//   batch       one `simframe do` with the whole flow — 1 model call
//   goal        `do` the launch, then `simframe goal "A > B > C"` — 2 calls
//   step        what agents did in the field: per step, read the text map then
//               tap — 2 calls a step (+1 for the launch)
//   screenshot  what screenshot-driven tools do: per step, a full screenshot
//               then a tap, plus a final screenshot to see the result —
//               2 calls a step (+1 launch, +1 final look)
//
// Measured: the text each command prints (what an agent reads), the pixel size
// of every screenshot, wall time, and whether the flow ended where it should
// (a fresh `find` of the flow's end marker). Derived: tokens, as characters ÷
// 3.5 for text (the repo's convention) and width × height ÷ 750 for an image
// after the Claude API's own downscale to ≤1568 px on the long edge and ≤1.15
// megapixels. Model calls follow each protocol; they are not counted from a live
// agent, and the screenshot arm drives taps by label through simframe rather
// than by coordinates a model read off the image — so it is the screenshot
// protocol's cost, not any one product's.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenshot } from '../src/platform/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const device = args.device;
if (!device) { console.error('usage: bench-headtohead.mjs --device=<udid> [--runs=3] [--flows=...] [--out=...]'); process.exit(2); }
const RUNS = Number(args.runs ?? 3);
const flows = JSON.parse(fs.readFileSync(path.join(ROOT, args.flows ?? 'flows/hpi-suite.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simframe-h2h-'));

const textTokens = (chars) => Math.ceil(chars / 3.5);
function imageTokens(w, h) {
  let s = Math.min(1, 1568 / Math.max(w, h));
  if (w * s * h * s > 1150000) s = Math.sqrt(1150000 / (w * h));
  return Math.ceil((Math.round(w * s) * Math.round(h * s)) / 750);
}
const pngSize = (file) => { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length }; };

function cli(argv) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src/cli.js'), ...argv, `--device=${device}`], { encoding: 'utf8', timeout: 300000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ms: Date.now() - t };
}
function script(steps) {
  const f = path.join(tmp, `s-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(steps));
  return f;
}
const launchOf = (flow) => flow.steps.find((s) => s.launch);
const tapsOf = (flow) => flow.steps.filter((s) => s.tap).map((s) => s.tap);
function reset(flow) {
  // Relaunch to the app's start, through simframe, and wait for it (the launch
  // step waits until the app can be operated).
  const l = launchOf(flow).launch;
  return cli(['do', script([{ launch: { value: l.value ?? l, relaunch: true } }])]);
}
function verified(flow) {
  return cli(['find', flow.endsOn]).ok;
}

const arms = {
  batch(flow) {
    const r = cli(['do', script(flow.steps)]);
    return { calls: 1, textChars: r.out.length, imageTokens: 0, images: 0, ms: r.ms };
  },
  goal(flow) {
    const l = cli(['do', script([launchOf(flow)])]);
    const g = cli(['goal', tapsOf(flow).join(' > ')]);
    return { calls: 2, textChars: l.out.length + g.out.length, imageTokens: 0, images: 0, ms: l.ms + g.ms };
  },
  step(flow) {
    let chars = 0; let ms = 0; let calls = 0;
    const l = cli(['do', script([launchOf(flow)])]); chars += l.out.length; ms += l.ms; calls += 1;
    for (const label of tapsOf(flow)) {
      const u = cli(['ui']); chars += u.out.length; ms += u.ms; calls += 1;
      const t = cli(['tap', label]); chars += t.out.length; ms += t.ms; calls += 1;
    }
    return { calls, textChars: chars, imageTokens: 0, images: 0, ms };
  },
  async screenshot(flow) {
    let chars = 0; let ms = 0; let calls = 0; let img = 0; let images = 0; const sizes = [];
    const l = cli(['do', script([launchOf(flow)])]); chars += l.out.length; ms += l.ms; calls += 1;
    const look = async () => {
      const f = path.join(tmp, `shot-${Date.now()}.png`);
      const t = Date.now();
      await screenshot(device, f);
      ms += Date.now() - t;
      const s = pngSize(f);
      sizes.push(`${s.w}x${s.h}`);
      img += imageTokens(s.w, s.h); images += 1; calls += 1;
    };
    for (const label of tapsOf(flow)) {
      await look();
      const t = cli(['tap', label]); chars += t.out.length; ms += t.ms; calls += 1;
    }
    await look(); // to see where it ended
    return { calls, textChars: chars, imageTokens: img, images, ms, sizes: [...new Set(sizes)] };
  },
};

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const results = [];
for (const flow of flows) {
  for (const arm of Object.keys(arms)) {
    for (let run = 0; run < RUNS; run += 1) {
      reset(flow);
      const r = await arms[arm](flow);
      const ok = verified(flow);
      const tokens = textTokens(r.textChars) + r.imageTokens;
      results.push({ flow: flow.name, arm, run, ok, ...r, tokens });
      console.error(`${flow.name.padEnd(20)} ${arm.padEnd(10)} run ${run + 1}: ${ok ? 'verified' : 'NOT verified'}, ${r.calls} calls, ~${tokens} tokens (${r.images} image(s)), ${(r.ms / 1000).toFixed(1)}s`);
    }
  }
}

const rows = [];
for (const flow of flows) {
  for (const arm of Object.keys(arms)) {
    const rs = results.filter((r) => r.flow === flow.name && r.arm === arm);
    const ok = rs.filter((r) => r.ok);
    rows.push({
      flow: flow.name, arm, runs: rs.length, verified: ok.length,
      calls: median(rs.map((r) => r.calls)),
      tokens: median(rs.map((r) => r.tokens)),
      imageTokens: median(rs.map((r) => r.imageTokens)),
      seconds: median(rs.map((r) => r.ms)) / 1000,
      tokensPerVerifiedFlow: ok.length ? Math.round(rs.reduce((n, r) => n + r.tokens, 0) / ok.length) : null,
      sizes: rs.find((r) => r.sizes)?.sizes,
    });
  }
}
// The wall time above is the tool's alone. A model turn per call is the larger
// cost; 20 s a call is the figure `simframe hpi` uses (docs/GUIDE.md, the latency
// model), so the projection is labelled as one.
const MODEL_TURN_S = 20;
console.log('| flow | arm | verified | model calls | tokens (median) | of which images | tool wall (median) | projected with model turns | tokens per verified flow |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(`| ${r.flow} | ${r.arm} | ${r.verified}/${r.runs} | ${r.calls} | ${r.tokens} | ${r.imageTokens} | ${r.seconds.toFixed(1)} s | ${(r.seconds + r.calls * MODEL_TURN_S).toFixed(0)} s | ${r.tokensPerVerifiedFlow ?? '—'} |`);
}
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify({ device, runs: RUNS, at: new Date().toISOString(), results, rows }, null, 2));
