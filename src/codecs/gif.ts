import { IndexedImage, bitsFor, padPalette } from '../types';

export function isGif(b: Uint8Array): boolean {
  return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
}

function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const lengths = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    lengths[i] = 1;
  }
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let outPos = 0;
  let bitBuf = 0, bitCount = 0, p = 0;

  const emit = (code: number): number => {
    // Write the string for `code` and return its first byte.
    const len = lengths[code];
    let c = code;
    for (let i = len - 1; i >= 0; i--) {
      if (outPos + i < pixelCount) out[outPos + i] = suffix[c];
      c = prefix[c];
    }
    outPos += len;
    let first = code;
    while (prefix[first] !== -1) first = prefix[first];
    return suffix[first];
  };

  while (outPos < pixelCount) {
    while (bitCount < codeSize) {
      if (p >= data.length) return out;
      bitBuf |= data[p++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCount -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;

    if (prev === -1) {
      emit(code);
      prev = code;
      continue;
    }
    let first: number;
    if (code < next) {
      first = emit(code);
    } else {
      // KwKwK case: code == next
      let f = prev;
      while (prefix[f] !== -1) f = prefix[f];
      first = suffix[f];
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = first;
        lengths[next] = lengths[prev] + 1;
        next++;
      }
      emit(code);
      prev = code;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
      continue;
    }
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      lengths[next] = lengths[prev] + 1;
      next++;
    }
    if (next === 1 << codeSize && codeSize < 12) codeSize++;
    prev = code;
  }
  return out;
}

/** Decodes the first frame of a GIF. */
export function decodeGif(b: Uint8Array): IndexedImage {
  if (!isGif(b)) throw new Error('Not a GIF file');
  const width = b[6] | (b[7] << 8);
  const height = b[8] | (b[9] << 8);
  const flags = b[10];
  const bg = b[11];
  let p = 13;
  let globalPalette: Uint8Array | null = null;
  if (flags & 0x80) {
    const n = 2 << (flags & 7);
    globalPalette = b.slice(p, p + n * 3);
    p += n * 3;
  }
  let transparentIndex: number | undefined;

  while (p < b.length) {
    const block = b[p++];
    if (block === 0x21) {
      const label = b[p++];
      if (label === 0xf9 && b[p] >= 4) {
        if (b[p + 1] & 1) transparentIndex = b[p + 4];
      }
      // skip sub-blocks
      while (b[p] !== 0) p += b[p] + 1;
      p++;
    } else if (block === 0x2c) {
      const ix = b[p] | (b[p + 1] << 8);
      const iy = b[p + 2] | (b[p + 3] << 8);
      const iw = b[p + 4] | (b[p + 5] << 8);
      const ih = b[p + 6] | (b[p + 7] << 8);
      const iflags = b[p + 8];
      p += 9;
      let palette = globalPalette;
      if (iflags & 0x80) {
        const n = 2 << (iflags & 7);
        palette = b.slice(p, p + n * 3);
        p += n * 3;
      }
      if (!palette) throw new Error('GIF: no color table');
      const minCodeSize = b[p++];
      const parts: Uint8Array[] = [];
      let total = 0;
      while (b[p] !== 0 && p < b.length) {
        const len = b[p];
        parts.push(b.subarray(p + 1, p + 1 + len));
        total += len;
        p += len + 1;
      }
      const data = new Uint8Array(total);
      let off = 0;
      for (const s of parts) { data.set(s, off); off += s.length; }
      const frame = lzwDecode(data, minCodeSize, iw * ih);

      const indices = new Uint8Array(width * height).fill(transparentIndex ?? bg);
      const rowOrder: number[] = [];
      if (iflags & 0x40) {
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
          for (let y = start; y < ih; y += step) rowOrder.push(y);
        }
      } else for (let y = 0; y < ih; y++) rowOrder.push(y);
      for (let r = 0; r < ih; r++) {
        const y = iy + rowOrder[r];
        if (y >= height) continue;
        for (let x = 0; x < iw; x++) {
          if (ix + x >= width) continue;
          indices[y * width + ix + x] = frame[r * iw + x];
        }
      }
      const bits = bitsFor(palette.length / 3);
      return {
        width,
        height,
        indices,
        palette: padPalette(palette, bits),
        bits,
        transparentIndex,
        source: `GIF, ${palette.length / 3} colors${iflags & 0x40 ? ', interlaced' : ''}`,
      };
    } else if (block === 0x3b) break;
    else throw new Error(`GIF: unexpected block 0x${block.toString(16)}`);
  }
  throw new Error('GIF: no image data');
}
