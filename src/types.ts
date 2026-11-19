/** An image made of palette indices. */
export interface IndexedImage {
  width: number;
  height: number;
  /** One palette index per pixel, row-major. */
  indices: Uint8Array;
  /** Palette as packed RGB triplets; length is 3 * colorCount. */
  palette: Uint8Array;
  /** Bits per pixel. The palette always has exactly 2^bits entries. */
  bits: number;
  /** Index treated as transparent, if any. */
  transparentIndex?: number;
  /** Human-readable description of where the image came from. */
  source: string;
}

export function colorCount(img: IndexedImage): number {
  return img.palette.length / 3;
}

/** Smallest b such that 2^b >= n (minimum 1). */
export function bitsFor(n: number): number {
  let b = 1;
  while (1 << b < n) b++;
  return b;
}

/** Pad a palette with black so it has exactly 2^bits entries. */
export function padPalette(palette: Uint8Array, bits: number): Uint8Array {
  const n = 1 << bits;
  if (palette.length === n * 3) return palette;
  const out = new Uint8Array(n * 3);
  out.set(palette.subarray(0, Math.min(palette.length, n * 3)));
  return out;
}
