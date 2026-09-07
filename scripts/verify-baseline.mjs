// Proves the agent-facing flow: look, act, ask again — and get a true answer
// without threading any baseline through by hand.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UDID = process.argv[2];
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const child = spawn(process.execPath, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) {
      const m = JSON.parse(line);
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  }
});
let id = 1;
const send = (method, params) => new Promise((r) => {
  const i = id++;
  pending.set(i, r);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`);
});
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await send('tools/call', { name, arguments: args });
  const txt = (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const imgs = (r.result?.content || []).filter((c) => c.type === 'image').length;
  return { ms: Date.now() - t0, txt, imgs };
};
const launch = (bundle) => execFileSync('xcrun', ['simctl', 'launch', UDID, bundle], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v', version: '0' } });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

launch('com.apple.springboard'); await sleep(1500);

console.log('--- 1. agent looks at the screen (implicitly sets its baseline)');
let r = await call('sim_look', { detail: 'low' });
console.log(`   ${r.ms}ms, ${r.imgs} image\n   ${r.txt.split('\n').join('\n   ')}`);

console.log('\n--- 2. agent acts, then waits (no baseline passed by hand)');
launch('com.apple.Preferences');
r = await call('sim_wait', { includeImage: false, stableMs: 700 });
console.log(`   ${r.ms}ms\n   ${r.txt.split('\n').join('\n   ')}`);

console.log('\n--- 3. agent polls in text, seconds later — the peer\'s failing case');
await sleep(2500);
r = await call('sim_state');
console.log(`   ${r.ms}ms, ${r.imgs} images\n   ${r.txt.split('\n').join('\n   ')}`);

console.log('\n--- 4. nothing happens; asking again must say so');
await sleep(1200);
r = await call('sim_state');
console.log(`   ${r.ms}ms\n   ${r.txt.split('\n').join('\n   ')}`);

child.kill();
