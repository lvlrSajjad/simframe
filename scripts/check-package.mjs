#!/usr/bin/env node
// Does the tarball contain everything the installed tool needs?
//
// This is the cheapest catch for the two worst regressions this project has
// shipped, both of which passed every test and printed nothing:
//
//   - `Tests/` was absent, so Package.swift declared a test target with no
//     directory, SwiftPM reported overlapping sources, and every install
//     silently fell back to the simctl engine.
//   - `native/ocr.swift` was absent, so OCR was silently off for all users.
//
// The required list is DERIVED from what the build actually reads, never
// hand-maintained. A hand-written list is how `files` rotted in the first
// place: it was correct when written and wrong three commits later. Add a new
// Swift source or a new module here and it becomes required automatically.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function walk(dir, filter, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    // .build holds compiled output, not inputs, and is never published.
    if (e.isDirectory()) {
      if (e.name === '.build' || e.name === 'node_modules') continue;
      walk(full, filter, out);
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Everything the SwiftPM build and the Node runtime read at install or run time. */
function requiredFiles() {
  const swiftPackage = path.join(ROOT, 'native', 'simframed');
  const required = new Set();

  // The SwiftPM manifest, and every source under the targets it declares.
  required.add(rel(path.join(swiftPackage, 'Package.swift')));
  for (const dir of ['Sources', 'Tests']) {
    for (const f of walk(path.join(swiftPackage, dir), (p) => p.endsWith('.swift'))) {
      required.add(rel(f));
    }
  }
  // Test targets are build inputs whether or not anyone runs them: a declared
  // target with a missing directory fails the whole build.
  if (!walk(path.join(swiftPackage, 'Tests'), (p) => p.endsWith('.swift')).length) {
    throw new Error('no Swift test sources found — has the layout moved? This check would silently pass.');
  }

  // The standalone OCR helper, compiled on demand by src/ocr.js.
  required.add(rel(path.join(ROOT, 'native', 'ocr.swift')));

  // Every runtime module. `files` ships "src" wholesale today; asserting each
  // one catches anybody narrowing that later.
  for (const f of walk(path.join(ROOT, 'src'), (p) => p.endsWith('.js'))) required.add(rel(f));

  // The Claude Code skill. It is the low-token path this tool is designed
  // around, and an installed copy without it is an installation of half the
  // idea — silently, which is the failure mode this whole check exists for.
  for (const f of walk(path.join(ROOT, 'skills'), (p) => p.endsWith('.md'))) required.add(rel(f));
  if (!walk(path.join(ROOT, 'skills'), (p) => p.endsWith('.md')).length) {
    throw new Error('no skill found under skills/ — has the layout moved? This check would silently pass.');
  }

  // Anything package.json points at to run.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const target of Object.values(pkg.bin ?? {})) required.add(target.replace(/^\.\//, ''));
  if (pkg.main) required.add(pkg.main.replace(/^\.\//, ''));

  return [...required].sort();
}

const required = requiredFiles();
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' }));
const shipped = new Set(packed[0].files.map((f) => f.path));
const missing = required.filter((f) => !shipped.has(f));

console.log(`${required.length} build inputs required, ${shipped.size} files in the tarball`);
for (const f of missing) console.log(`MISSING ${f}`);
if (missing.length) {
  console.error(
    `\n${missing.length} file(s) the build needs are absent from the published package.` +
      `\nThis does not fail a build or a test — it fails silently for whoever installs it.`,
  );
  process.exit(1);
}
console.log('ok — every build input ships');
