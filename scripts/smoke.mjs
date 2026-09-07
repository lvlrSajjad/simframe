// End-to-end smoke test: speaks JSON-RPC to `simframe mcp` over stdio.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const summarize = (res) =>
  (res.result?.content || []).map((c) =>
    c.type === 'image' ? `[image ${Math.round(c.data.length * 0.75 / 1024)}KB]` : c.text,
  );

const init = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
console.log('initialize ->', init.result.serverInfo);
notify('notifications/initialized');

const tools = await send('tools/list', {});
console.log('tools ->', tools.result.tools.map((t) => t.name).join(', '));

for (const [name, args] of [
  ['sim_devices', {}],
  ['sim_state', {}],
  ['sim_look', { detail: 'low' }],
  ['sim_strip', { count: 4 }],
  ['sim_recall', { action: 'timeline' }],
  ['sim_recall', { action: 'at', msAgo: 8000 }],
  ['sim_capture', { action: 'status' }],
]) {
  const t0 = Date.now();
  const res = await send('tools/call', { name, arguments: args });
  console.log(`\n--- ${name} (${Date.now() - t0}ms)${res.result?.isError ? ' ERROR' : ''}`);
  console.log(summarize(res).join('\n'));
}

const t0 = Date.now();
const w = await send('tools/call', {
  name: 'sim_wait',
  arguments: { mode: 'stable', stableMs: 400, timeoutMs: 5000, includeImage: false },
});
console.log(`\n--- sim_wait (${Date.now() - t0}ms)\n${summarize(w).join('\n')}`);

child.kill();
