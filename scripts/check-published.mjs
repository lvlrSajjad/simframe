#!/usr/bin/env node
/**
 * Does the version on npm contain the code you think it does?
 *
 * **DEFERRED 149.** `0.14.1` was tagged at one commit and a change landed
 * immediately after it, so `npm install simframe@0.14.1` shipped the previous
 * `centerOf()`. An external tester was asked to evaluate that change, diffed
 * the package against the checkout themselves, and wrote: *"I came within one
 * command of filing this report against the wrong binary."*
 *
 * Nothing in the pipeline compared what was tagged against what was being asked
 * for, and the release workflow cannot: it checks that the tag, `package.json`
 * and `server.json` agree, which they did. The gap is between the tag and
 * whatever arrived afterwards.
 *
 * So this is the check to run **before handing someone a version to test**, and
 * before cutting the next one. It fetches the published tarball and compares
 * every shipped source file against the working tree.
 *
 * It deliberately compares against the WORKING TREE rather than a tag: the
 * question being asked is "is what I am about to ask someone to install the code
 * I am looking at", and a tag cannot answer that.
 *
 * Usage:
 *   node scripts/check-published.mjs            # the version in package.json
 *   node scripts/check-published.mjs 0.14.1     # any published version
 *   node scripts/check-published.mjs --latest   # whatever npm serves as latest
 *
 * Exit 0 when every shipped file matches, 1 when any differs, 2 when the
 * version is not published or npm could not be reached — which is a different
 * answer and must not read as "it matches".
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const wantLatest = process.argv.includes('--latest');
const local = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));

let version = arg ?? local.version;
if (wantLatest) {
  try {
    version = execFileSync('npm', ['view', local.name, 'version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error(`could not ask npm for the latest ${local.name}: ${err.message}`);
    process.exit(2);
  }
}

console.log(`comparing ${local.name}@${version} on npm against this working tree`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simframe-published-'));
let tarball;
try {
  tarball = execFileSync('npm', ['pack', `${local.name}@${version}`, '--silent', '--pack-destination', tmp], {
    encoding: 'utf8',
  }).trim().split('\n').pop();
} catch (err) {
  // Not published, unpublished, or no network. None of those is a match.
  console.error(`could not fetch ${local.name}@${version} from npm.`);
  console.error('That is not the same answer as "it differs" — nothing was compared.');
  console.error(String(err.stderr || err.message).trim().split('\n').slice(-3).join('\n'));
  process.exit(2);
}

execFileSync('tar', ['-xzf', path.join(tmp, tarball), '-C', tmp]);
const root = path.join(tmp, 'package');

/** Every file the package ships, relative to the package root. */
const shipped = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else shipped.push(path.relative(root, full));
  }
};
walk(root);

// Only compare what this repo is the source of. `package.json` is rewritten by
// npm on publish (it adds `_id`, `dist`, and normalises fields), so byte
// equality there is not the question and would be a permanent false alarm.
const comparable = shipped.filter((f) => /^(src|scripts|native)\//.test(f) && !f.includes('/.build/'));

const same = [];
const differ = [];
const missing = [];
for (const rel of comparable) {
  const mine = path.join(here, rel);
  if (!fs.existsSync(mine)) { missing.push(rel); continue; }
  if (md5(fs.readFileSync(mine)) === md5(fs.readFileSync(path.join(root, rel)))) same.push(rel);
  else differ.push(rel);
}

const publishedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
console.log(`  published version: ${publishedVersion}`);
console.log(`  files compared:    ${comparable.length}`);
console.log(`  identical:         ${same.length}`);

if (missing.length) {
  console.log(`  shipped but absent here: ${missing.length}`);
  for (const f of missing) console.log(`    ${f}`);
}

if (!differ.length && !missing.length) {
  console.log(`\nok — ${local.name}@${version} is the code in this tree`);
  process.exit(0);
}

console.error(`\nFAIL ${differ.length} shipped file(s) differ from this tree:`);
for (const f of differ) console.error(`    ${f}`);
console.error('\nIf you are about to ask someone to test a change, they would be testing');
console.error('the published bytes above, not what you are reading. Publish first, or point');
console.error('them at the checkout and say so.');
process.exit(1);
