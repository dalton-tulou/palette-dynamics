import { IndexedImage, bitsFor, padPalette } from '../types';
import { crc32, deflate, inflate } from './zlib';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPng(b: Uint8Array): boolean {
  return SIGNATURE.every((v, i) => b[i] === v);
}

const ADAM7 = [
  // [xStart, yStart, xStep, yStep]
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Undo PNG scanline filters in place-ish; returns raw rows (without filter bytes). */
function unfilter(data: Uint8Array, offset: number, rowBytes: number, rows: number): Uint8Array {
  const out = new Uint8Array(rowBytes * rows);
  const bpp = 1; // all supported formats have <= 8 bits per pixel
  for (let y = 0; y < rows; y++) {
    const ft = data[offset++];
    const o = y * rowBytes;
    const p = o - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[offset++];
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[p + x] : 0;
      const c = x >= bpp && y > 0 ? out[p + x - bpp] : 0;
      let v: number;
      switch (ft) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: v = raw + paeth(a, b, c); break;
        default: throw new Error(`PNG: bad filter type ${ft}`);
      }
      out[o + x] = v & 0xff;
    }
  }
  return out;
}

function readSample(row: Uint8Array, rowStart: number, x: number, depth: number): number {
  if (depth === 8) return row[rowStart + x];
  const perByte = 8 / depth;
  const byte = row[rowStart + Math.floor(x / perByte)];
  const shift = 8 - depth * ((x % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

export async function decodePng(bytes: Uint8Array): Promise<IndexedImage> {
  if (!isPng(bytes)) throw new Error('Not a PNG file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = dv.getUint32(body.byteOffset - bytes.byteOffset);
      height = dv.getUint32(body.byteOffset - bytes.byteOffset + 4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') palette = body.slice();
    else if (type === 'tRNS') trns = body.slice();
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (!width || !height) throw new Error('PNG: missing IHDR');
  if (depth > 8) throw new Error(`PNG: ${depth}-bit samples are not indexed`);

  if (colorType === 0) {
    // Grayscale: treat as indexed with a gray ramp.
    const n = 1 << depth;
    palette = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const g = Math.round((i * 255) / (n - 1));
      palette[i * 3] = palette[i * 3 + 1] = palette[i * 3 + 2] = g;
    }
  } else if (colorType !== 3) {
    throw new Error('PNG is truecolor, not indexed. Save it as an 8-bit (palette) PNG first.');
  }
  if (!palette) throw new Error('PNG: indexed image without PLTE');

  const total = idat.reduce((s, c) => s + c.length, 0);
  const z = new Uint8Array(total);
  let off = 0;
  for (const c of idat) { z.set(c, off); off += c.length; }
  const data = await inflate(z);

  const indices = new Uint8Array(width * height);
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  let dpos = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * depth) / 8);
    const rows = unfilter(data, dpos, rowBytes, ph);
    dpos += (rowBytes + 1) * ph;
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        indices[(y0 + y * dy) * width + x0 + x * dx] = readSample(rows, y * rowBytes, x, depth);
      }
    }
  }

  let transparentIndex: number | undefined;
  if (trns && colorType === 3) {
    // Use the first fully transparent entry as the transparent index.
    const t = trns.findIndex((a) => a === 0);
    if (t >= 0) transparentIndex = t;
  }

  let maxIdx = 0;
  for (let i = 0; i < indices.length; i++) if (indices[i] > maxIdx) maxIdx = indices[i];
  const bits = Math.max(bitsFor(palette.length / 3), bitsFor(maxIdx + 1));
  return {
    width,
    height,
    indices,
    palette: padPalette(palette, bits),
    bits,
    transparentIndex,
    source: `PNG, ${depth}-bit ${colorType === 0 ? 'grayscale' : 'indexed'}${interlace ? ', interlaced' : ''}`,
  };
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, (crc32(out.subarray(4, 8 + body.length)) ^ 0xffffffff) >>> 0);
  return out;
}

export async function encodePng(img: IndexedImage): Promise<Uint8Array> {
  const depth = img.bits <= 1 ? 1 : img.bits <= 2 ? 2 : img.bits <= 4 ? 4 : 8;
  const rowBytes = Math.ceil((img.width * depth) / 8);
  const raw = new Uint8Array((rowBytes + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    const o = y * (rowBytes + 1) + 1;
    for (let x = 0; x < img.width; x++) {
      const v = img.indices[y * img.width + x];
      if (depth === 8) raw[o + x] = v;
      else {
        const perByte = 8 / depth;
        raw[o + Math.floor(x / perByte)] |= v << (8 - depth * ((x % perByte) + 1));
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, img.width);
  dv.setUint32(4, img.height);
  ihdr[8] = depth;
  ihdr[9] = 3;
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('PLTE', img.palette),
  ];
  if (img.transparentIndex !== undefined) {
    const t = new Uint8Array(img.transparentIndex + 1).fill(255);
    t[img.transparentIndex] = 0;
    parts.push(chunk('tRNS', t));
  }
  parts.push(chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
