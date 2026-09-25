#!/usr/bin/env node
// Sets the simframe listing's metadata on Smithery — description, links,
// license and icon — which the bundle publish does not carry.
//   node scripts/smithery-metadata.mjs
//
// The API key is the one `npx @smithery/cli` stored when it asked for it;
// SMITHERY_API_KEY in the environment wins if set. Nothing is printed but
// the server's answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = 'lvlr-xaus/simframe';

function apiKey() {
  if (process.env.SMITHERY_API_KEY) return process.env.SMITHERY_API_KEY;
  const dir = process.env.SMITHERY_CONFIG_PATH
    ?? (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'smithery') : path.join(os.homedir(), '.config', 'smithery'));
  const file = path.join(dir, 'settings.json');
  const key = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).apiKey : null;
  if (!key) throw new Error(`no Smithery API key: set SMITHERY_API_KEY or run any \`npx @smithery/cli mcp publish\` once so it stores one in ${file}`);
  return key;
}

const headers = { Authorization: `Bearer ${apiKey()}` };
const base = `https://api.smithery.ai/servers/${encodeURIComponent(server)}`;

const meta = await fetch(base, {
  method: 'PATCH',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'simframe',
    description: 'Eyes, hands and memory for a coding agent driving the iOS Simulator or an Android emulator. Reads the screen as text with tap points, runs whole flows in one call with every step verified, and remembers screens so repeated flows need no model calls.',
    homepage: 'https://lvlrsajjad.github.io/simframe/',
    repositoryUrl: 'https://github.com/lvlrSajjad/simframe',
    backlinkUrl: 'https://lvlrsajjad.github.io/simframe/agents-shouldnt-blink.html',
    license: 'MIT',
  }),
});
console.log(`metadata: ${meta.status} ${await meta.text()}`);

const icon = new FormData();
icon.append('icon', new Blob([fs.readFileSync(path.join(root, 'scripts/smithery/icon.png'))], { type: 'image/png' }), 'icon.png');
const up = await fetch(`${base}/icon`, { method: 'PUT', headers, body: icon });
console.log(`icon: ${up.status} ${await up.text()}`);
