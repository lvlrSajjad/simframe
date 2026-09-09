#!/usr/bin/env node
// Strings that must never enter this repository.
//
// This is a personal project and some of the work that exercises it is not.
// A client's app name and its bundle id are theirs, not material for a public
// repo, and one of them reached two public commit diffs before anybody was
// checking. The history is staying as it is — the reasoning is in
// docs/DEFERRED.md — so the part still worth controlling is recurrence.
//
// The denylist deliberately does not live here. A file in the repo listing the
// strings that must not be in the repo is a puzzle that solves itself, and so
// is a file of their hashes: an unsalted hash of a low-entropy string is a
// confirmation oracle for anyone who already has a candidate. So the list comes
// from outside:
//
//   .private-strings        one pattern per line, gitignored, on this machine
//   SIMFRAME_PRIVATE_STRINGS  newline- or comma-separated, for CI as a secret
//
// With neither, this exits 0 and says it did nothing. That is not a silent
// pass: a check that fails on every fork and every fresh clone would be turned
// off within a week, and a check nobody has turned off is worth more than a
// check nobody can run.
//
// Nothing here ever prints a match. It prints the file and the line number, so
// the output of a failed run is safe to paste into an issue, a CI log, or a
// conversation with an agent — which is exactly where the last one would have
// gone.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST_FILE = path.join(ROOT, '.private-strings');

/** Patterns from the environment first, so CI can supply them without a file. */
export function patternsFrom({ env, file } = {}) {
  const raw = [
    ...String(env ?? '').split(/[\n,]/),
    ...String(file ?? '').split(/\n/),
  ];
  return [...new Set(
    raw
      .map((s) => s.trim())
      // A comment line, and a blank line, are both "no pattern".
      .filter((s) => s && !s.startsWith('#'))
      // One character would match everything, which is a check that only ever
      // fails and therefore only ever gets disabled.
      .filter((s) => s.length >= 3)
      .map((s) => s.toLowerCase()),
  )];
}

/** Which lines of `text` contain any pattern. Line numbers only, never matches. */
export function offendingLines(text, patterns) {
  const hits = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const lower = lines[i].toLowerCase();
    // Reported as a count, not as the pattern that matched: knowing *which*
    // secret leaked is worth less than not restating it.
    const n = patterns.filter((p) => lower.includes(p)).length;
    if (n) hits.push({ line: i + 1, patterns: n });
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
  if (!patterns.length) {
    console.log('check-private: no denylist supplied (.private-strings or $SIMFRAME_PRIVATE_STRINGS) — nothing checked');
    return;
  }
  let failed = 0;
  for (const rel of trackedFiles()) {
    const full = path.join(ROOT, rel);
    let text;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > 4_000_000) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    // Binary-ish: a NUL byte means this is not text and a substring hit in it
    // would be noise.
    if (text.includes('\0')) continue;
    for (const hit of offendingLines(text, patterns)) {
      console.error(`check-private: ${rel}:${hit.line} matches ${hit.patterns} denied pattern(s)`);
      failed += 1;
    }
  }
  console.log(`check-private: ${patterns.length} pattern(s) against ${trackedFiles().length} tracked file(s)`);
  if (failed) {
    console.error(`check-private: ${failed} line(s) must not be committed. Nothing above prints the match itself.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
