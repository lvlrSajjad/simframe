#!/usr/bin/env node
// Builds the Smithery bundle for the current version:
//   node scripts/smithery-bundle.mjs            -> simframe-<version>.mcpb
//   npx -y @smithery/cli mcp publish ./simframe-<version>.mcpb -n lvlr-xaus/simframe
//
// Smithery does not sync from the official MCP Registry, and its web form
// takes only an HTTPS URL, so a local stdio server reaches it as an MCPB
// bundle through the CLI. Two things learned publishing 0.18.0, both
// load-bearing:
//
// - Smithery's validator wants an `inputSchema` on every tool it is told
//   about, and Anthropic's `mcpb pack` refuses that key as unknown. So the
//   tool list is taken from the server's own tools/list answer, schemas
//   included, and the archive is a plain zip — a .mcpb is nothing else.
// - The bundle is the packed npm tarball plus its runtime dependency
//   installed inside it, because a bundle runs from its own directory.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'simframe-mcpb-'));
const dir = path.join(work, 'pkg');
fs.mkdirSync(dir);

const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: root }).toString().trim();
execFileSync('tar', ['-xzf', path.join(work, tarball), '-C', dir, '--strip-components=1']);
execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], { cwd: dir, stdio: 'inherit' });
fs.copyFileSync(path.join(root, 'scripts/smithery/icon.png'), path.join(dir, 'icon.png'));

// The tool list, with schemas, from the server that ships in the bundle.
const tools = await new Promise((resolve, reject) => {
  const child = spawn('node', [path.join(dir, 'src/cli.js'), 'mcp'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', () => {
    const line = out.split('\n').find((l) => l.includes('"id":2'));
    line ? resolve(JSON.parse(line).result.tools) : reject(new Error('the bundled server did not answer tools/list'));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bundle', version: '0' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.end();
});

const firstSentence = (s) => s.trim().split(/(?<=[.!?])\s/)[0].slice(0, 200);
const manifest = {
  manifest_version: '0.3',
  name: 'simframe',
  display_name: 'simframe',
  version: pkg.version,
  description: 'Eyes, hands and memory for a coding agent driving the iOS Simulator or an Android emulator.',
  long_description: 'simframe reads the simulator screen as a numbered text element map with tap points (accessibility tree + on-device OCR, ~20 ms warm frames instead of screenshots), runs whole tap/type/scroll/assert flows in one call with every step verified against what it did last time, and remembers screens so repeated flows need no model calls. Needs a Mac with Xcode; the first call builds a small Swift daemon from source (~15 s, once). Android emulators are driven with the same tools, without an accessibility tree.',
  author: { name: 'Sadjad Asadi', url: 'https://github.com/lvlrSajjad' },
  repository: { type: 'git', url: 'https://github.com/lvlrSajjad/simframe.git' },
  homepage: 'https://lvlrsajjad.github.io/simframe/',
  documentation: 'https://github.com/lvlrSajjad/simframe#readme',
  support: 'https://github.com/lvlrSajjad/simframe/issues',
  icon: 'icon.png',
  server: { type: 'node', entry_point: 'src/cli.js', mcp_config: { command: 'node', args: ['${__dirname}/src/cli.js', 'mcp'] } },
  tools: tools.map((t) => ({ name: t.name, description: firstSentence(t.description ?? ''), inputSchema: t.inputSchema ?? { type: 'object', properties: {} } })),
  tools_generated: false,
  keywords: pkg.keywords,
  license: 'MIT',
  compatibility: { platforms: ['darwin'], runtimes: { node: '>=18.17' } },
};
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const out = path.join(root, `simframe-${pkg.version}.mcpb`);
fs.rmSync(out, { force: true });
execFileSync('zip', ['-qr', out, '.', '-x', '*.DS_Store'], { cwd: dir });
fs.rmSync(work, { recursive: true, force: true });
console.log(`${path.relative(root, out)}: ${tools.length} tools, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
console.log(`publish: npx -y @smithery/cli mcp publish ./${path.relative(root, out)} -n lvlr-xaus/simframe`);
