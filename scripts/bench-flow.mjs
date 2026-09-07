// Times a realistic navigation flow end to end, and reports where the time went.
// Used to check that the input driver works at all, and to measure sim_do.
import { runScript } from '../src/actions.js';
import * as input from '../src/input.js';
import * as api from '../src/index.js';
import { launchApp, terminateApp } from '../src/simctl.js';

const BUNDLE = process.argv[2] || 'com.ecotrak.etm2';
const device = process.argv[3];

const driver = await input.detectDriver();
console.log(`driver: ${driver.available ? driver.version : driver.reason}`);
if (!driver.available) process.exit(1);

const { device: dev } = await api.ensureDaemon(device);
console.log(`device: ${dev.name} (${dev.runtime})`);
const geo = await input.screenInfo(dev.udid);
console.log(`screen: ${geo.pixelWidth}x${geo.pixelHeight}px @${geo.density}x = ${geo.pointWidth}x${geo.pointHeight}pt\n`);

const t0 = Date.now();
try { await terminateApp(dev.udid, BUNDLE); } catch { /* not running */ }
await launchApp(dev.udid, BUNDLE);
const launched = await api.waitFor(device, { mode: 'settle', stableMs: 800, timeoutMs: 20_000 });
console.log(`cold launch + settle: ${Date.now() - t0}ms (satisfied=${launched.satisfied})`);

const nodes = await input.describeAll(dev.udid);
console.log(`accessibility tree: ${nodes.length} elements`);
const labelled = nodes.filter((n) => n.label && n.frame.width > 8 && n.frame.height > 8);
console.log('\nlabelled elements (type, tap point, label):');
for (const n of labelled.slice(0, 40)) {
  const c = input.centerOf(n);
  console.log(`  ${(n.type || '?').padEnd(14)} ${String(`${c.x},${c.y}`).padEnd(10)} ${n.label}`);
}

// Anything sitting in the bottom eighth of the screen is probably a tab bar.
const tabs = labelled.filter((n) => n.frame.y > geo.pointHeight * 0.86);
console.log(`\nlikely tab bar: ${tabs.map((t) => t.label).join(', ') || '(none found)'}`);

if (tabs.length >= 2) {
  const steps = tabs.slice(0, 4).map((t) => ({ tap: t.label }));
  console.log(`\nrunning ${steps.length} tab switches as ONE sim_do call...`);
  const t1 = Date.now();
  const res = await runScript(device, { steps, stableMs: 500, timeoutMs: 10_000 });
  for (const r of res.results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.action}: ${r.ok ? r.detail : r.error}` +
      (r.settled ? ` (settled ${r.settled.waitedMs}ms, changed=${r.settled.sawChange})` : ''));
  }
  console.log(`\n${res.ok ? 'flow completed' : 'FLOW FAILED'} — ${res.ranSteps}/${res.totalSteps} steps in ${Date.now() - t1}ms`);
}
