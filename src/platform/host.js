// Host-side tools, shared by every backend.
//
// `resize` was on the Phase 8 list of eleven platform functions and does not
// belong there: it downscales a PNG file with sips and never touches a device.
// Behind the platform boundary it would have to be declared once per backend,
// identically, for no reason. Here both backends get it and neither owns it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Resample with sips, which ships with macOS, so simframe needs no image deps. */
export async function resize(inFile, outFile, maxDim) {
  await run('sips', ['-Z', String(maxDim), inFile, '--out', outFile], { timeout: 10_000 });
}
