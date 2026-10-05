#!/usr/bin/env node
/**
 * The GitHub Release body for a tag: where to get it, what changed, the diff.
 *
 *   node scripts/release-notes.mjs v0.23.1 > notes.md
 *
 * GitHub Releases used to be written by hand, and the release workflow never
 * made one — it publishes to npm and the MCP Registry and stops. So when the
 * hand stopped, the repo's sidebar went on saying 0.19.0 while npm had 0.23.1,
 * seven versions later, and nothing anywhere was red. The workflow now calls
 * this, and the seven were backfilled with it, so they read alike.
 *
 * "What changed" is the commit subjects, because in this repo a subject is a
 * sentence about behaviour ("A blind type after tapping a field reads that
 * field back"), which is the release note. Two kinds are dropped: the bare
 * version-bump commits `npm version` makes, which say nothing, and the
 * project's own housekeeping — handoffs, backlog, plans, research — which is
 * about the next release, not this one.
 *
 * And a subject `check-private` would flag — a third-party bundle id, or a
 * pattern from `.private-strings` / $SIMFRAME_PRIVATE_STRINGS — is left out
 * rather than published on a page more people read than the git log. Counted
 * on stderr, never printed, by that script's own rule.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { offendingLines, patternsFrom } from './check-private.mjs';

const REPO = 'https://github.com/lvlrSajjad/simframe';

/** `npm version` commits are titled with the bare version and nothing else. */
export const isVersionBump = (subject) => /^v?\d+\.\d+\.\d+(-[\w.]+)?$/.test(subject.trim());

/** Commits about planning this project rather than changing what ships. */
export const isHousekeeping = (subject) => /^(Handoff|Backlog|Plans?|Research \d|Record |Phase \d+\b)/.test(subject.trim());

export function releaseNotes({ tag, previous, subjects, registryName, privatePatterns = [], onWithheld = () => {} }) {
  const version = tag.replace(/^v/, '');
  const notable = subjects.filter((s) => s.trim() && !isVersionBump(s) && !isHousekeeping(s));
  const changes = notable.filter((s) => offendingLines(s, privatePatterns).length === 0);
  if (changes.length < notable.length) onWithheld(notable.length - changes.length);
  return [
    `simframe ${version} — on npm as \`simframe@${version}\` and in the official MCP Registry as \`${registryName}\`.`,
    '',
    '```bash',
    'claude mcp add --scope user simframe -- npx -y simframe mcp',
    '```',
    '',
    '**Changes**',
    '',
    ...(changes.length ? changes.map((s) => `- ${s.trim()}`) : ['- No changes beyond the version.']),
    '',
    previous ? `Full history: ${REPO}/compare/${previous}...${tag}` : `Full history: ${REPO}/commits/${tag}`,
    '',
  ].join('\n');
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function main() {
  const tag = process.argv[2];
  if (!tag) {
    console.error('usage: release-notes.mjs <tag>');
    process.exit(2);
  }
  let previous = null;
  try {
    previous = git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`);
  } catch {
    /* the first tag has no predecessor */
  }
  const range = previous ? `${previous}..${tag}` : tag;
  const subjects = git('log', '--no-merges', '--reverse', '--format=%s', range).split('\n');
  const { name } = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  const listFile = new URL('../.private-strings', import.meta.url);
  const privatePatterns = patternsFrom({
    env: process.env.SIMFRAME_PRIVATE_STRINGS,
    file: fs.existsSync(listFile) ? fs.readFileSync(listFile, 'utf8') : '',
  });
  const onWithheld = (n) => console.error(`release-notes: ${n} subject(s) withheld by the private-strings check`);
  process.stdout.write(releaseNotes({ tag, previous, subjects, registryName: name, privatePatterns, onWithheld }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
