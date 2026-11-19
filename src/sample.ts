import { IndexedImage } from './types';

/**
 * A procedurally drawn 64-colour test image whose palette is deliberately
 * shuffled, so dropping bits looks bad until the palette is rearranged.
 */
export function makeSample(): IndexedImage {
  const width = 320, height = 200, bits = 6, n = 1 << bits;
  // Palette: 4 hue ramps of 16 shades.
  const ramps = [
    [40, 90, 200], [230, 120, 40], [60, 170, 80], [210, 200, 190],
  ];
  const ordered: number[][] = [];
  for (const [r, g, b] of ramps) {
    for (let s = 0; s < 16; s++) {
      const t = (s + 1) / 16;
      const hi = Math.max(0, t - 0.7) * 1.6;
      ordered.push([r, g, b].map((v) => Math.min(255, Math.round(v * t + 255 * hi))));
    }
  }
  // Deterministic shuffle.
  const perm = Array.from({ length: n }, (_, i) => i);
  let seed = 1234567;
  for (let i = n - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const palette = new Uint8Array(n * 3);
  perm.forEach((slot, src) => palette.set(ordered[src], slot * 3));

  const indices = new Uint8Array(width * height);
  const put = (x: number, y: number, ramp: number, shade: number) => {
    const s = Math.max(0, Math.min(15, Math.round(shade)));
    indices[y * width + x] = perm[ramp * 16 + s];
  };
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dither = bayer[(y & 3) * 4 + (x & 3)] / 16 - 0.5;
      // Sky
      let ramp = 0, shade = 3 + (y / height) * 10;
      // Ground with hills
      const hill = 140 + 18 * Math.sin(x / 37) + 9 * Math.sin(x / 13 + 1);
      if (y > hill) { ramp = 2; shade = 12 - ((y - hill) / (height - hill)) * 9; }
      // Sun
      const dx = x - 230, dy = y - 60, r = Math.hypot(dx, dy);
      if (r < 34) { ramp = 1; shade = 15 - (r / 34) * 8 - (dy / 34) * 3; }
      // Sphere
      const sx = x - 95, sy = y - 105, sr = Math.hypot(sx, sy);
      if (sr < 52) {
        const nz = Math.sqrt(1 - (sr / 52) ** 2);
        const lit = Math.max(0, (-sx * 0.5 - sy * 0.6) / 52 + nz * 0.7);
        ramp = 3; shade = 1 + lit * 14;
      }
      put(x, y, ramp, shade + dither);
    }
  }
  return { width, height, indices, palette, bits, source: 'Built-in sample, 64 colors (shuffled palette)' };
}
