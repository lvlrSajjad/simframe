// On-device OCR via Apple's Vision framework.
//
// This exists because an accessibility tree is a promise the app has to keep,
// and plenty of apps do not: custom tab bars publish no children, icon buttons
// carry unreadable glyphs, React Native inputs are invisible. Pixels never lie
// about what a person can see, and Vision turns them into text plus coordinates
// locally in ~300ms with no model round trip.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as store from './store.js';

const run = promisify(execFile);
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'ocr.swift');
const BIN_DIR = path.join(store.ROOT, 'bin');
const BIN = path.join(BIN_DIR, 'ocr');

let ready = null;

/** Compile once, then reuse. Recompiles only if the source is newer than the binary. */
export async function ensureBinary() {
  if (ready) return ready;
  ready = (async () => {
    try {
      const src = fs.statSync(SOURCE).mtimeMs;
      const bin = fs.existsSync(BIN) ? fs.statSync(BIN).mtimeMs : 0;
      if (bin > src) return { available: true, binary: BIN, compiled: false };
    } catch {
      return { available: false, reason: 'the OCR source is missing from this install' };
    }
    try {
      fs.mkdirSync(BIN_DIR, { recursive: true });
      await run('swiftc', ['-O', SOURCE, '-o', BIN], { timeout: 120_000 });
      return { available: true, binary: BIN, compiled: true };
    } catch (err) {
      ready = null; // let a later call retry once the toolchain is present
      return {
        available: false,
        reason:
          err.code === 'ENOENT'
            ? 'swiftc is not installed, so on-device OCR is unavailable (install Xcode command line tools)'
            : `could not build the OCR helper: ${err.message.split('\n')[0]}`,
      };
    }
  })();
  return ready;
}

/**
 * Recognised text with point coordinates.
 * @returns {Promise<Array<{text,x,y,width,height,centerX,centerY,confidence}>>}
 */
export async function readText(pngFile, { density = 3 } = {}) {
  const built = await ensureBinary();
  if (!built.available) throw new Error(built.reason);
  const { stdout } = await run(built.binary, [pngFile], { timeout: 30_000, maxBuffer: 16 << 20 });
  const raw = JSON.parse(stdout || '[]');
  return raw.map((r) => ({
    text: r.text,
    confidence: r.confidence,
    // Vision reports pixels; everything that drives input speaks points.
    x: r.x / density,
    y: r.y / density,
    width: r.width / density,
    height: r.height / density,
    centerX: Math.round((r.x + r.width / 2) / density),
    centerY: Math.round((r.y + r.height / 2) / density),
  }));
}
