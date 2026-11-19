/**
 * Palette rearrangement so an indexed image degrades gracefully when the
 * most significant bits of each pixel index are dropped.
 *
 * Dropping MSBs down to k bits shows pixel index i as palette[i mod 2^k].
 * That makes the palette a binary tree: at level k, slot j (< 2^k) stands in
 * for every slot j + n*2^k. A good order puts, in each such class, a colour
 * that resembles the others (weighted by how many pixels use them).
 *
 * Strategy:
 *   1. Greedy top-down balanced splitting: slot 0 gets the weighted medoid;
 *      each level then splits every class in two, keeping its representative
 *      and picking the best new one for the other half.
 *   2. Local search: swap pairs of slots while that lowers the summed
 *      error over all bit depths (each depth normalised so all count equally).
 */

export interface RearrangeOptions {
  /** Keep palette entry 0 at index 0 (e.g. Amiga background colour). */
  pinZero?: boolean;
  /** Time budget for the local search, in milliseconds. */
  timeBudgetMs?: number;
  onProgress?: (fraction: number) => void;
}

export interface RearrangeResult {
  /** oldToNew[oldIndex] = newIndex */
  oldToNew: Uint16Array;
  /** Error per bit depth for the original order, index = bit depth. */
  errorBefore: number[];
  /** Error per bit depth for the new order. */
  errorAfter: number[];
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB bytes -> OKLab. */
export function toOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Pairwise squared OKLab distances, N x N. */
export function distanceMatrix(palette: Uint8Array): Float64Array {
  const n = palette.length / 3;
  const lab = [] as [number, number, number][];
  for (let i = 0; i < n; i++) lab.push(toOklab(palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]));
  const d = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dl = lab[i][0] - lab[j][0], da = lab[i][1] - lab[j][1], db = lab[i][2] - lab[j][2];
      d[i * n + j] = d[j * n + i] = dl * dl + da * da + db * db;
    }
  }
  return d;
}

export function histogram(indices: Uint8Array, n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < indices.length; i++) w[indices[i]]++;
  return w;
}

/**
 * Mean perceptual error (mean OKLab distance x 100, roughly ΔE) at every
 * bit depth 0..bits, for a slot order. order[slot] = original palette index.
 */
export function errorByDepth(order: ArrayLike<number>, w: Float64Array, d: Float64Array, bits: number): number[] {
  const n = 1 << bits;
  let total = 0;
  for (let i = 0; i < n; i++) total += w[i];
  const out: number[] = [];
  for (let k = 0; k <= bits; k++) {
    const m = (1 << k) - 1;
    let e = 0;
    for (let pos = 0; pos < n; pos++) {
      const c = order[pos];
      if (w[c]) e += w[c] * Math.sqrt(d[c * n + order[pos & m]]);
    }
    out.push(total ? (100 * e) / total : 0);
  }
  return out;
}

/** Greedy top-down construction. Returns order[slot] = original index. */
export function greedyOrder(w: Float64Array, d: Float64Array, bits: number, pinZero = false): Int32Array {
  const n = 1 << bits;
  const order = new Int32Array(n).fill(-1);

  // Level 0: weighted medoid (or entry 0 when pinned).
  let root = 0;
  if (!pinZero) {
    let best = Infinity;
    for (let c = 0; c < n; c++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += w[i] * d[i * n + c];
      if (s < best) { best = s; root = c; }
    }
  }
  order[0] = root;
  let groups: number[][] = [Array.from({ length: n }, (_, i) => i)];

  for (let k = 0; k < bits; k++) {
    const next: number[][] = new Array(groups.length * 2);
    for (let j = 0; j < groups.length; j++) {
      const members = groups[j];
      const a = order[j];
      const half = members.length / 2;
      const others = members.filter((x) => x !== a);
      let bestCost = Infinity;
      let bestB = others[0];
      let bestSplit: number[] = [];
      const scratch = others.map((i) => ({ i, delta: 0 }));
      for (const b of others) {
        // Assign the half-1 members that gain most from b (besides b itself).
        let base = 0;
        for (const s of scratch) {
          s.delta = s.i === b ? -Infinity : w[s.i] * (d[s.i * n + b] - d[s.i * n + a]);
          base += w[s.i] * d[s.i * n + a];
        }
        scratch.sort((x, y) => x.delta - y.delta);
        let cost = base - w[b] * d[b * n + a];
        for (let t = 1; t < half; t++) cost += scratch[t].delta;
        if (cost < bestCost) {
          bestCost = cost;
          bestB = b;
          bestSplit = scratch.slice(0, half).map((s) => s.i);
        }
      }
      const inB = new Set(bestSplit);
      order[j + groups.length] = bestB;
      next[j] = members.filter((x) => !inB.has(x));
      next[j + groups.length] = bestSplit;
    }
    groups = next;
  }
  return order;
}

/** Improve an order in place with pairwise slot swaps. */
export function refineOrder(
  order: Int32Array,
  w: Float64Array,
  d: Float64Array,
  bits: number,
  opts: RearrangeOptions = {},
): void {
  const n = 1 << bits;
  const budget = opts.timeBudgetMs ?? 3000;
  const start = performance.now();

  // Normalise each depth by its starting cost so every depth counts equally.
  const scale = new Float64Array(bits);
  for (let k = 1; k < bits; k++) {
    const m = (1 << k) - 1;
    let e = 0;
    for (let pos = 0; pos < n; pos++) e += w[order[pos]] * d[order[pos] * n + order[pos & m]];
    scale[k] = e > 0 ? 1 / e : 0;
  }

  const term = (pos: number, m: number) => {
    const c = order[pos];
    return w[c] * d[c * n + order[pos & m]];
  };
  const affected = (p: number, q: number, m: number, fn: (pos: number) => void) => {
    const step = m + 1;
    if (p <= m) for (let pos = p; pos < n; pos += step) fn(pos);
    else if (!(q <= m && (p & m) === q)) fn(p);
    if (q <= m) for (let pos = q; pos < n; pos += step) fn(pos);
    else if (!(p <= m && (q & m) === p)) fn(q);
  };
  const swapDelta = (p: number, q: number): number => {
    let delta = 0;
    for (let k = 1; k < bits; k++) {
      if (!scale[k]) continue;
      const m = (1 << k) - 1;
      let before = 0, after = 0;
      affected(p, q, m, (pos) => { before += term(pos, m); });
      const t = order[p]; order[p] = order[q]; order[q] = t;
      affected(p, q, m, (pos) => { after += term(pos, m); });
      order[q] = order[p]; order[p] = t;
      delta += (after - before) * scale[k];
    }
    return delta;
  };

  const first = opts.pinZero ? 1 : 0;
  for (let pass = 0; pass < 50; pass++) {
    let improved = false;
    for (let p = first; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (swapDelta(p, q) < -1e-12) {
          const t = order[p]; order[p] = order[q]; order[q] = t;
          improved = true;
        }
      }
      if (performance.now() - start > budget) return;
      opts.onProgress?.(Math.min(0.99, (performance.now() - start) / budget));
    }
    if (!improved) return;
  }
}

export function rearrange(
  indices: Uint8Array,
  palette: Uint8Array,
  bits: number,
  opts: RearrangeOptions = {},
): RearrangeResult {
  const n = 1 << bits;
  const w = histogram(indices, n);
  const d = distanceMatrix(palette);
  const identity = Int32Array.from({ length: n }, (_, i) => i);
  const order = greedyOrder(w, d, bits, opts.pinZero);
  refineOrder(order, w, d, bits, opts);
  const oldToNew = new Uint16Array(n);
  for (let pos = 0; pos < n; pos++) oldToNew[order[pos]] = pos;
  return {
    oldToNew,
    errorBefore: errorByDepth(identity, w, d, bits),
    errorAfter: errorByDepth(order, w, d, bits),
  };
}
