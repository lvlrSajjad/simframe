#!/usr/bin/env node
// Keep server.json's and the Claude Code plugin's versions in step with
// package.json's.
//
// `npm version` only knows about package.json, and the MCP registry manifest
// carries the version twice — once at the top level and once inside the package
// entry. Every release therefore depended on remembering to hand-edit a second
// file between two commands, and the release that did not remember failed at
// the workflow's own agreement check.
//
// npm runs this as the `version` lifecycle script: after the bump, before the
// commit. It stages both files so the version commit contains all three.
//
// The plugin manifest is the second file for the same reason server.json is:
// a `version` in .claude-plugin/plugin.json pins every installed copy to it, so
// a manifest left behind by one release would hold plugin users on the
// previous release's skill forever, with nothing failing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const file = path.join(ROOT, 'server.json');
const server = JSON.parse(fs.readFileSync(file, 'utf8'));

const before = { top: server.version, pkg: server.packages?.[0]?.version };
server.version = pkg.version;
if (!Array.isArray(server.packages) || !server.packages.length) {
  console.error('server.json has no packages[] entry to version — has its shape changed?');
  process.exit(1);
}
server.packages[0].version = pkg.version;

fs.writeFileSync(file, `${JSON.stringify(server, null, 2)}\n`);
console.log(`server.json ${before.top} / ${before.pkg} -> ${pkg.version} / ${pkg.version}`);

const pluginFile = path.join(ROOT, '.claude-plugin', 'plugin.json');
const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf8'));
const pluginBefore = plugin.version;
plugin.version = pkg.version;
fs.writeFileSync(pluginFile, `${JSON.stringify(plugin, null, 2)}\n`);
console.log(`.claude-plugin/plugin.json ${pluginBefore} -> ${pkg.version}`);

// Stage them, so `npm version` commits every file together. Harmless when run
// with --no-git-tag-version; the files are still correct either way.
try {
  execFileSync('git', ['add', '--', file, pluginFile], { cwd: ROOT, stdio: 'pipe' });
} catch {
  console.log('(could not stage server.json and plugin.json — commit them yourself)');
}
