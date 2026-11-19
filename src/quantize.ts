import { toOklab } from './rearrange';
import { bitsFor, padPalette } from './types';

/** A non-indexed image: 4 bytes (RGBA) per pixel. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  source: string;
}

export interface Indexed {
  indices: Uint8Array;
  palette: Uint8Array;
  bits: number;
  transparentIndex?: number;
  /** What the conversion did, for display. */
  note: string;
}

const ALPHA_CUTOFF = 128;

/**
 * Convert RGBA pixels to indexed. With 256 or fewer distinct colours they
 * become the palette as-is; otherwise the image is reduced to 256 colours
 * (median cut + k-means in OKLab) and Floyd–Steinberg dithered.
 * Pixels with alpha < 128 share one transparent palette entry.
 */
export function toIndexed(img: RgbaImage, maxColors = 256): Indexed {
  const { data } = img;
  const count = img.width * img.height;
  let hasTransparent = false;
  for (let i = 0; i < count; i++) if (data[i * 4 + 3] < ALPHA_CUTOFF) { hasTransparent = true; break; }
  const limit = maxColors - (hasTransparent ? 1 : 0);

  const exact = exactPalette(data, count, limit);
  if (exact) {
    const n = exact.colors.length + (hasTransparent ? 1 : 0);
    const bits = bitsFor(n);
    const palette = new Uint8Array(n * 3);
    exact.colors.forEach((c, i) => palette.set([c >> 16, (c >> 8) & 255, c & 255], i * 3));
    const transparentIndex = hasTransparent ? n - 1 : undefined;
    const indices = exact.indices;
    if (hasTransparent) for (let i = 0; i < count; i++) if (data[i * 4 + 3] < ALPHA_CUTOFF) indices[i] = n - 1;
    return {
      indices,
      palette: padPalette(palette, bits),
      bits,
      transparentIndex,
      note: `${exact.colors.length} colors, used as palette`,
    };
  }

  const colors = medianCutKMeans(data, count, limit);
  const n = colors.length / 3 + (hasTransparent ? 1 : 0);
  const bits = bitsFor(n);
  const palette = padPalette(colors, bits);
  const transparentIndex = hasTransparent ? n - 1 : undefined;
  const indices = ditherFloydSteinberg(img, colors, transparentIndex);
  return {
    indices,
    palette,
    bits,
    transparentIndex,
    note: `more than ${limit} colors, reduced to ${colors.length / 3} with Floyd–Steinberg dithering`,
  };
}

/** Exact colour list and indices if there are at most `limit` opaque colours, else null. */
function exactPalette(data: ArrayLike<number>, count: number, limit: number) {
  const map = new Map<number, number>();
  const colors: number[] = [];
  const indices = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (data[o + 3] < ALPHA_CUTOFF) continue;
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
    let idx = map.get(key);
    if (idx === undefined) {
      if (colors.length >= limit) return null;
      idx = colors.length;
      map.set(key, idx);
      colors.push(key);
    }
    indices[i] = idx;
  }
  return { colors, indices };
}

interface Bin {
  r: number; g: number; b: number; // mean sRGB
  w: number;                       // pixel count
  lab: [number, number, number];
}

/**
 * Colour histogram keeping each bin's exact mean colour. Starts at 5 bits per
 * channel; smooth images (few occupied bins) are re-binned at 6 bits, and then
 * exactly, so they still get the full palette.
 */
function buildBins(data: ArrayLike<number>, count: number, k: number): Bin[] {
  const enough = k * 8;
  let bins = binAt(data, count, 5);
  if (bins.length >= enough) return bins;
  bins = binAt(data, count, 6);
  if (bins.length >= enough) return bins;
  return exactBins(data, count, 100_000) ?? bins;
}

function toBin(r: number, g: number, b: number, w: number): Bin {
  return { r, g, b, w, lab: toOklab(r, g, b) };
}

function binAt(data: ArrayLike<number>, count: number, bits: 5 | 6): Bin[] {
  const shift = 8 - bits;
  const size = 1 << (bits * 3);
  const sums = new Float64Array(size * 4);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (data[o + 3] < ALPHA_CUTOFF) continue;
    const key = ((data[o] >> shift) << (2 * bits)) | ((data[o + 1] >> shift) << bits) | (data[o + 2] >> shift);
    sums[key * 4] += data[o];
    sums[key * 4 + 1] += data[o + 1];
    sums[key * 4 + 2] += data[o + 2];
    sums[key * 4 + 3]++;
  }
  const bins: Bin[] = [];
  for (let key = 0; key < size; key++) {
    const w = sums[key * 4 + 3];
    if (w) bins.push(toBin(sums[key * 4] / w, sums[key * 4 + 1] / w, sums[key * 4 + 2] / w, w));
  }
  return bins;
}

/** One bin per distinct colour, or null if there are more than `max`. */
function exactBins(data: ArrayLike<number>, count: number, max: number): Bin[] | null {
  const counts = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (data[o + 3] < ALPHA_CUTOFF) continue;
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.size > max) return null;
  }
  return Array.from(counts, ([key, w]) => toBin(key >> 16, (key >> 8) & 255, key & 255, w));
}

function boxStats(box: Bin[]) {
  let w = 0;
  const mean = [0, 0, 0];
  for (const b of box) { w += b.w; for (let a = 0; a < 3; a++) mean[a] += b.lab[a] * b.w; }
  for (let a = 0; a < 3; a++) mean[a] /= w || 1;
  const v = [0, 0, 0];
  for (const b of box) for (let a = 0; a < 3; a++) v[a] += b.w * (b.lab[a] - mean[a]) ** 2;
  return { sse: v[0] + v[1] + v[2], axis: v.indexOf(Math.max(...v)) };
}

/** Returns packed RGB palette with at most k entries. */
export function medianCutKMeans(data: ArrayLike<number>, count: number, k: number): Uint8Array {
  const bins = buildBins(data, count, k);
  // Median cut: repeatedly split the box with the largest weighted variance.
  type Box = { bins: Bin[]; sse: number; axis: number };
  const mk = (b: Bin[]): Box => ({ bins: b, ...boxStats(b) });
  const boxes: Box[] = [mk(bins)];
  while (boxes.length < k) {
    let bi = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].bins.length > 1 && (bi < 0 || boxes[i].sse > boxes[bi].sse)) bi = i;
    }
    if (bi < 0) break;
    const box = boxes[bi];
    const ax = box.axis;
    box.bins.sort((p, q) => p.lab[ax] - q.lab[ax]);
    let total = 0;
    for (const b of box.bins) total += b.w;
    let acc = 0, cut = 1;
    for (let i = 0; i < box.bins.length - 1; i++) {
      acc += box.bins[i].w;
      cut = i + 1;
      if (acc >= total / 2) break;
    }
    boxes.splice(bi, 1, mk(box.bins.slice(0, cut)), mk(box.bins.slice(cut)));
  }

  // Centres as weighted RGB means.
  let centres = boxes.map((box) => {
    let w = 0, r = 0, g = 0, b = 0;
    for (const x of box.bins) { w += x.w; r += x.r * x.w; g += x.g * x.w; b += x.b * x.w; }
    return [r / w, g / w, b / w];
  });

  // A few rounds of k-means (Lloyd) on the bins, distances in OKLab.
  const assign = new Int32Array(bins.length);
  for (let iter = 0; iter < 6; iter++) {
    const labs = centres.map(([r, g, b]) => toOklab(r, g, b));
    for (let i = 0; i < bins.length; i++) {
      const L = bins[i].lab;
      let best = 0, bd = Infinity;
      for (let c = 0; c < labs.length; c++) {
        const d = (L[0] - labs[c][0]) ** 2 + (L[1] - labs[c][1]) ** 2 + (L[2] - labs[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best;
    }
    const acc = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < bins.length; i++) {
      const a = acc[assign[i]], b = bins[i];
      a[0] += b.r * b.w; a[1] += b.g * b.w; a[2] += b.b * b.w; a[3] += b.w;
    }
    centres = centres.map((c, i) => (acc[i][3] ? [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]] : c));
  }

  // Round and drop duplicates.
  const seen = new Set<number>();
  const out: number[] = [];
  for (const [r, g, b] of centres) {
    const p = [Math.round(r), Math.round(g), Math.round(b)];
    const key = (p[0] << 16) | (p[1] << 8) | p[2];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(...p);
  }
  return new Uint8Array(out);
}

/** Serpentine Floyd–Steinberg dithering to `colors` (packed RGB). */
export function ditherFloydSteinberg(img: RgbaImage, colors: Uint8Array, transparentIndex?: number): Uint8Array {
  const { width, height, data } = img;
  const n = colors.length / 3;
  const indices = new Uint8Array(width * height);
  // Nearest-colour cache at 6 bits per channel.
  const cache = new Int16Array(1 << 18).fill(-1);
  const nearest = (r: number, g: number, b: number): number => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let c = cache[key];
    if (c >= 0) return c;
    let bd = Infinity;
    // Weighted RGB distance (rough perceptual weighting).
    for (let i = 0; i < n; i++) {
      const dr = r - colors[i * 3], dg = g - colors[i * 3 + 1], db = b - colors[i * 3 + 2];
      const rm = (r + colors[i * 3]) / 2;
      const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      if (d < bd) { bd = d; c = i; }
    }
    cache[key] = c;
    return c;
  };

  // Error buffers for current and next row (RGB, with 1px padding on each side).
  let cur = new Float32Array((width + 2) * 3);
  let next = new Float32Array((width + 2) * 3);
  for (let y = 0; y < height; y++) {
    const ltr = (y & 1) === 0;
    const dir = ltr ? 1 : -1;
    for (let s = 0; s < width; s++) {
      const x = ltr ? s : width - 1 - s;
      const i = y * width + x;
      const o = i * 4;
      const e = (x + 1) * 3;
      if (data[o + 3] < ALPHA_CUTOFF) {
        indices[i] = transparentIndex ?? 0;
        continue;
      }
      const r = Math.min(255, Math.max(0, data[o] + cur[e]));
      const g = Math.min(255, Math.max(0, data[o + 1] + cur[e + 1]));
      const b = Math.min(255, Math.max(0, data[o + 2] + cur[e + 2]));
      const c = nearest(r | 0, g | 0, b | 0);
      indices[i] = c;
      const er = r - colors[c * 3], eg = g - colors[c * 3 + 1], eb = b - colors[c * 3 + 2];
      const f = e + dir * 3, bk = e - dir * 3;
      cur[f] += er * 7 / 16; cur[f + 1] += eg * 7 / 16; cur[f + 2] += eb * 7 / 16;
      next[bk] += er * 3 / 16; next[bk + 1] += eg * 3 / 16; next[bk + 2] += eb * 3 / 16;
      next[e] += er * 5 / 16; next[e + 1] += eg * 5 / 16; next[e + 2] += eb * 5 / 16;
      next[f] += er / 16; next[f + 1] += eg / 16; next[f + 2] += eb / 16;
    }
    [cur, next] = [next, cur];
    next.fill(0);
  }
  return indices;
}
