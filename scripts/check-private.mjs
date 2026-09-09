#!/usr/bin/env node
// No third-party app identifiers in this repository. Ever, from anyone.
//
// simframe is a general-purpose tool: you install it and Claude Code drives
// *your* app on the simulator. It has no relationship with any particular app,
// so no particular app's bundle id belongs in it — not in the source, not in
// the docs, and not in a secret either. A denylist of specific strings would
// assume there is one app to protect, which is the wrong shape for this.
//
// So the rule is a pattern, not a list, and it needs no configuration at all.
// Anything shaped like a reverse-DNS bundle id is flagged unless it is one of:
//
//   * a platform's own                 com.apple.*, com.android.*, com.google.*
//   * a documentation placeholder      com.example.*, com.acme.*, com.mycompany.*
//   * this project's own identifiers
//
// That works on a fresh clone, on a fork, and in a pull request from a stranger,
// which a secret does not. An optional `.private-strings` file (gitignored) or
// $SIMFRAME_PRIVATE_STRINGS still adds extra patterns for anyone who wants them,
// but nothing depends on either existing.
//
// How this got written: a 282-line field-notes file about a real third-party app
// was committed here by `git add -A` and pushed, an hour after the first version
// of this script was written to prevent exactly that. It could not fire, because
// it was waiting for a denylist nobody had supplied. A guard with a
// precondition is a guard that is off.
//
// Nothing here ever prints a match. It prints the file and the line number, so
// the output of a failed run is safe to paste into an issue, a CI log, or a
// conversation with an agent — which is where the last one would have gone.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST_FILE = path.join(ROOT, '.private-strings');

/**
 * Bundle-id-shaped strings, and the ones that are fine.
 *
 * The first segment is restricted to real reverse-DNS prefixes, which is what
 * keeps ordinary property chains out: `res.state.seq`, `registry.paths.dir` and
 * `import.meta.url` all look exactly like bundle ids until you require the head
 * to be a TLD.
 */
const BUNDLE = /\b(?:com|io|org|net|dev|co|app|me|xyz|uk|de|fr|jp|nl|se|ca|au)\.[A-Za-z][A-Za-z0-9_-]{1,30}(?:\.[A-Za-z][A-Za-z0-9_-]{0,30}){1,3}\b/g;

/** Platform-owned, placeholder, or ours. Anything else is somebody's app. */
export const ALLOWED = [
  /^com\.apple\./i,
  /^com\.android\./i,
  /^com\.google\./i,
  /^org\.swift\./i,
  /^org\.json\./i,
  /^com\.facebook\./i,     // idb, a reference implementation named in the docs
  /^com\.example\./i,
  /^com\.acme\./i,
  /^com\.mycompany\./i,
  /^com\.yourcompany\./i,
  /^io\.github\./i,
];

export function isAllowedIdentifier(id) {
  return ALLOWED.some((re) => re.test(id));
}

/** Extra patterns, for anyone who wants them. Nothing depends on this existing. */
export function patternsFrom({ env, file } = {}) {
  const raw = [
    ...String(env ?? '').split(/[\n,]/),
    ...String(file ?? '').split(/\n/),
  ];
  return [...new Set(
    raw
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
      // One character would match everything, which is a check that only ever
      // fails and therefore only ever gets disabled.
      .filter((s) => s.length >= 3)
      .map((s) => s.toLowerCase()),
  )];
}

/** Which lines of `text` are a problem. Line numbers only, never matches. */
export function offendingLines(text, patterns = []) {
  const hits = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const lower = lines[i].toLowerCase();
    const why = [];
    const extra = patterns.filter((p) => lower.includes(p)).length;
    if (extra) why.push(`${extra} denied pattern(s)`);
    const ids = (lines[i].match(BUNDLE) ?? []).filter((id) => !isAllowedIdentifier(id));
    // Reported as a count and a shape, never as the identifier: knowing which
    // app leaked is worth less to a bug report than not restating it.
    if (ids.length) why.push(`${ids.length} third-party bundle id(s)`);
    if (why.length) hits.push({ line: i + 1, why: why.join(', ') });
  }
  return hits;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function main() {
  const patterns = patternsFrom({
    env: process.env.SIMFRAME_PRIVATE_STRINGS,
    file: fs.existsSync(LIST_FILE) ? fs.readFileSync(LIST_FILE, 'utf8') : '',
  });
  const files = trackedFiles();
  let failed = 0;
  for (const rel of files) {
    const full = path.join(ROOT, rel);
    let text;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > 4_000_000) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    // A NUL byte means this is not text, and a substring hit in it is noise.
    if (text.includes('\0')) continue;
    for (const hit of offendingLines(text, patterns)) {
      console.error(`check-private: ${rel}:${hit.line} — ${hit.why}`);
      failed += 1;
    }
  }
  console.log(`check-private: ${files.length} tracked file(s); no third-party bundle ids`
    + (patterns.length ? `, plus ${patterns.length} local pattern(s)` : '')
    + ` — ${failed} line(s) flagged`);
  if (failed) {
    console.error('check-private: nothing above prints the match itself. '
      + 'A third-party app identifier does not belong in a general-purpose tool.');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
