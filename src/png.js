// Minimal PNG codec. sips only ever hands us 8-bit non-interlaced RGB/RGBA, so
// that is all we decode; encoding is filter-0 RGBA, which is all we produce.
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @typedef {{ width: number, height: number, data: Buffer }} Bitmap RGBA, 4 bytes per pixel. */

/** @returns {Bitmap} */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8;
  let hdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      hdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!hdr) throw new Error('PNG has no IHDR');
  if (hdr.depth !== 8) throw new Error(`unsupported PNG bit depth ${hdr.depth}`);
  if (hdr.interlace !== 0) throw new Error('interlaced PNG is unsupported');
  const channels = hdr.colorType === 6 ? 4 : hdr.colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported PNG color type ${hdr.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = hdr;
  const stride = width * channels;
  const out = Buffer.allocUnsafe(width * height * 4);
  let prev = Buffer.alloc(stride);
  const line = Buffer.allocUnsafe(stride);

  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    raw.copy(line, 0, start + 1, start + 1 + stride);
    unfilter(filter, line, prev, channels, stride);
    if (channels === 4) {
      line.copy(out, y * width * 4);
    } else {
      for (let x = 0; x < width; x++) {
        const s = x * 3;
        const d = (y * width + x) * 4;
        out[d] = line[s];
        out[d + 1] = line[s + 1];
        out[d + 2] = line[s + 2];
        out[d + 3] = 255;
      }
    }
    prev = Buffer.from(line);
  }
  return { width, height, data: out };
}

function unfilter(filter, line, prev, bpp, stride) {
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < stride; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pred) & 0xff;
      }
      return;
    default:
      throw new Error(`unknown PNG filter ${filter}`);
  }
}

/** @param {Bitmap} bmp */
export function encodePng(bmp) {
  const { width, height, data } = bmp;
  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, body) {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Box-average a bitmap down to a small grayscale grid. This is the basis for
 * every cheap comparison simframe makes: hashes, diffs and region maps.
 * @param {Bitmap} bmp
 * @returns {{ cols: number, rows: number, gray: Uint8Array }}
 */
export function grayGrid(bmp, cols, rows) {
  const gray = new Uint8Array(cols * rows);
  const { width, height, data } = bmp;
  for (let ry = 0; ry < rows; ry++) {
    const y0 = Math.floor((ry * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * height) / rows));
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor((rx * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * width) / cols));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          sum += (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
          n++;
        }
      }
      gray[ry * cols + rx] = Math.round(sum / n);
    }
  }
  return { cols, rows, gray };
}

/** Nearest-neighbour scale. Only used for contact sheets, where speed beats quality. */
/**
 * A rectangle out of a bitmap, clamped to it.
 *
 * Exists because a whole screen at 1024px on the long edge cannot answer a
 * question about one control. Reported from a real session: a selected filter
 * chip and an unselected one are indistinguishable at that size, and selection
 * state was the entire question the ticket turned on — so the agent shelled out
 * to `simctl io` and PIL to crop and upscale the chip row, **for every single
 * check**. Their estimate: six round trips.
 *
 * Coordinates are pixels; the caller converts from points, because only the
 * caller knows the density it read them at.
 */
export function cropBitmap(bmp, x, y, width, height) {
  const left = Math.max(0, Math.min(bmp.width - 1, Math.round(x)));
  const top = Math.max(0, Math.min(bmp.height - 1, Math.round(y)));
  const w = Math.max(1, Math.min(bmp.width - left, Math.round(width)));
  const h = Math.max(1, Math.min(bmp.height - top, Math.round(height)));
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    const from = ((top + row) * bmp.width + left) * 4;
    bmp.data.copy(out, row * w * 4, from, from + w * 4);
  }
  return { width: w, height: h, data: out };
}

export function scaleBitmap(bmp, width, height) {
  const out = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(bmp.height - 1, Math.floor((y * bmp.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(bmp.width - 1, Math.floor((x * bmp.width) / width));
      bmp.data.copy(out, (y * width + x) * 4, (sy * bmp.width + sx) * 4, (sy * bmp.width + sx) * 4 + 4);
    }
  }
  return { width, height, data: out };
}
