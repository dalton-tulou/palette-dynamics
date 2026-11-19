import { IndexedImage, bitsFor, padPalette } from '../types';

export function isIlbm(b: Uint8Array): boolean {
  const id = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  return b.length >= 12 && id(0) === 'FORM' && (id(8) === 'ILBM' || id(8) === 'PBM ');
}

function unpackByteRun1(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0, o = 0;
  while (o < expected && i < src.length) {
    const n = (src[i++] << 24) >> 24; // signed
    if (n >= 0) {
      for (let k = 0; k <= n && o < expected; k++) out[o++] = src[i++];
    } else if (n !== -128) {
      const v = src[i++];
      for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = v;
    }
  }
  return out;
}

const CAMG_HAM = 0x800;
const CAMG_EHB = 0x80;

/** Decodes IFF ILBM (planar) and PBM (chunky) images. */
export function decodeIlbm(b: Uint8Array): IndexedImage {
  if (!isIlbm(b)) throw new Error('Not an IFF ILBM/PBM file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunky = String.fromCharCode(b[8], b[9], b[10], b[11]) === 'PBM ';
  const end = Math.min(b.length, 8 + dv.getUint32(4));
  let p = 12;
  let width = 0, height = 0, planes = 0, masking = 0, compression = 0, transparent = 0;
  let cmap: Uint8Array | null = null;
  let body: Uint8Array | null = null;
  let camg = 0;
  while (p + 8 <= end) {
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    const len = dv.getUint32(p + 4);
    const d = p + 8;
    if (id === 'BMHD') {
      width = dv.getUint16(d);
      height = dv.getUint16(d + 2);
      planes = b[d + 8];
      masking = b[d + 9];
      compression = b[d + 10];
      transparent = dv.getUint16(d + 12);
    } else if (id === 'CMAP') cmap = b.slice(d, d + len);
    else if (id === 'CAMG') camg = dv.getUint32(d);
    else if (id === 'BODY') body = b.subarray(d, d + len);
    p = d + len + (len & 1);
  }
  if (!width || !height || !body) throw new Error('ILBM: missing BMHD or BODY');
  if (camg & CAMG_HAM) throw new Error('ILBM: HAM images are not palette-indexed');
  if (planes > 8) throw new Error(`ILBM: ${planes} bitplanes (true color) not supported`);

  let rowBytes: number;
  let planesInData = planes;
  if (chunky) rowBytes = width + (width & 1);
  else {
    rowBytes = ((width + 15) >> 4) << 1;
    if (masking === 1) planesInData++;
  }
  const lineBytes = chunky ? rowBytes : rowBytes * planesInData;
  const raw = compression === 1 ? unpackByteRun1(body, lineBytes * height) : body;
  if (compression > 1) throw new Error(`ILBM: unsupported compression ${compression}`);

  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const lo = y * lineBytes;
    if (chunky) {
      indices.set(raw.subarray(lo, lo + width), y * width);
      continue;
    }
    for (let pl = 0; pl < planes; pl++) {
      const po = lo + pl * rowBytes;
      const bit = 1 << pl;
      for (let x = 0; x < width; x++) {
        if (raw[po + (x >> 3)] & (0x80 >> (x & 7))) indices[y * width + x] |= bit;
      }
    }
  }

  let palette: Uint8Array;
  if (cmap) palette = cmap.slice(0, Math.floor(cmap.length / 3) * 3);
  else {
    const n = 1 << planes;
    palette = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) palette.fill(Math.round((i * 255) / (n - 1)), i * 3, i * 3 + 3);
  }
  // Old 4-bit-per-gun CMAPs (low nibble zero): scale up so 0xF0 becomes 0xFF.
  if (palette.every((v) => (v & 0x0f) === 0)) for (let i = 0; i < palette.length; i++) palette[i] |= palette[i] >> 4;

  let ehb = false;
  if (camg & CAMG_EHB && planes === 6) {
    ehb = true;
    const full = new Uint8Array(64 * 3);
    full.set(palette.subarray(0, 32 * 3));
    for (let i = 0; i < 32 * 3; i++) full[32 * 3 + i] = full[i] >> 1;
    palette = full;
  }

  const bits = Math.max(planes, bitsFor(palette.length / 3));
  return {
    width,
    height,
    indices,
    palette: padPalette(palette, bits),
    bits,
    transparentIndex: masking === 2 ? transparent : undefined,
    source: `IFF ${chunky ? 'PBM' : 'ILBM'}, ${planes} planes${ehb ? ', EHB' : ''}${compression ? ', ByteRun1' : ''}`,
  };
}

function writeChunk(parts: Uint8Array[], id: string, body: Uint8Array) {
  const h = new Uint8Array(8);
  for (let i = 0; i < 4; i++) h[i] = id.charCodeAt(i);
  new DataView(h.buffer).setUint32(4, body.length);
  parts.push(h, body);
  if (body.length & 1) parts.push(new Uint8Array(1));
}

function packByteRun1(row: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run >= 3) {
      out.push((257 - run) & 0xff, row[i]);
      i += run;
      continue;
    }
    let j = i;
    while (j < row.length && j - i < 128) {
      if (j + 2 < row.length && row[j] === row[j + 1] && row[j] === row[j + 2]) break;
      j++;
    }
    out.push(j - i - 1);
    for (let k = i; k < j; k++) out.push(row[k]);
    i = j;
  }
  return out;
}

/** Encodes a ByteRun1-compressed planar ILBM. */
export function encodeIlbm(img: IndexedImage): Uint8Array {
  const { width, height, bits } = img;
  const rowBytes = ((width + 15) >> 4) << 1;
  const bmhd = new Uint8Array(20);
  const dv = new DataView(bmhd.buffer);
  dv.setUint16(0, width);
  dv.setUint16(2, height);
  bmhd[8] = bits;
  bmhd[9] = img.transparentIndex !== undefined ? 2 : 0;
  bmhd[10] = 1;
  dv.setUint16(12, img.transparentIndex ?? 0);
  bmhd[14] = 10;
  bmhd[15] = 11;
  dv.setInt16(16, width);
  dv.setInt16(18, height);

  const body: number[] = [];
  const plane = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    for (let pl = 0; pl < bits; pl++) {
      plane.fill(0);
      for (let x = 0; x < width; x++) {
        if (img.indices[y * width + x] & (1 << pl)) plane[x >> 3] |= 0x80 >> (x & 7);
      }
      for (const v of packByteRun1(plane)) body.push(v);
    }
  }

  const parts: Uint8Array[] = [];
  writeChunk(parts, 'BMHD', bmhd);
  writeChunk(parts, 'CMAP', img.palette);
  writeChunk(parts, 'BODY', new Uint8Array(body));
  const inner = parts.reduce((s, x) => s + x.length, 0);
  const out = new Uint8Array(12 + inner);
  out.set([0x46, 0x4f, 0x52, 0x4d]);
  new DataView(out.buffer).setUint32(4, inner + 4);
  out.set([0x49, 0x4c, 0x42, 0x4d], 8);
  let off = 12;
  for (const x of parts) { out.set(x, off); off += x.length; }
  return out;
}
