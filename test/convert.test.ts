import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeImage } from '../src/codecs';
import { writePlanarIlbm } from '../src/codecs/ilbm';
import { toOklab } from '../src/rearrange';
import { toIndexed } from '../src/quantize';

const dir = new URL('./fixtures/', import.meta.url);
const load = (f: string) => new Uint8Array(readFileSync(new URL(f, dir)));
const toRgb = (img: { indices: Uint8Array; palette: Uint8Array; width: number; height: number }) => {
  const rgb = new Uint8Array(img.width * img.height * 3);
  img.indices.forEach((c, i) => rgb.set(img.palette.subarray(c * 3, c * 3 + 3), i * 3));
  return rgb;
};

describe('truecolor → indexed', () => {
  it('uses the exact colors when there are 256 or fewer', async () => {
    const img = await decodeImage(load('rose100-rgb.png'));
    expect(img.bits).toBe(7);
    expect(img.source).toContain('100 colors, used as palette');
    expect(toRgb(img)).toEqual(load('rose100-rgb.png.rgb'));
  });

  for (const f of ['rose-rgb.png', 'rose-rgb16.png']) {
    it(`reduces ${f} to 256 colors with dithering`, async () => {
      const img = await decodeImage(load(f));
      expect(img.bits).toBe(8);
      expect(img.source).toContain('dithering');
      // Mean ΔE between original and result should be small.
      const ref = load(f + '.rgb'), out = toRgb(img);
      let e = 0;
      for (let i = 0; i < ref.length; i += 3) {
        const a = toOklab(ref[i], ref[i + 1], ref[i + 2]), b = toOklab(out[i], out[i + 1], out[i + 2]);
        e += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      }
      expect((e / (ref.length / 3)) * 100).toBeLessThan(3);
    });
  }

  it('gives smooth gradients the full 256 colors', () => {
    const width = 300, height = 200;
    const data = new Uint8Array(width * height * 4);
    let seed = 1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const n = (seed >>> 28) - 8; // small JPEG-like noise
        const t = (x + y) / (width + height);
        const o = (y * width + x) * 4;
        data.set([255 * (1 - t) + n, 255 * Math.sin(Math.PI * t) + n, 255 * t + n, 255].map((v) => Math.max(0, Math.min(255, v))), o);
      }
    const r = toIndexed({ width, height, data, source: 't' });
    expect(r.note).toContain('reduced to 256');
  });

  it('maps transparent pixels to their own palette entry', async () => {
    const img = await decodeImage(load('rose-rgba.png'));
    expect(img.transparentIndex).toBeDefined();
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++)
        expect(img.indices[y * img.width + x] === img.transparentIndex).toBe(x < 20);
  });
});

describe('ILBM true color', () => {
  it('decodes 24-bit deep ILBM', async () => {
    const vals = [0x0000ff, 0x00ff00, 0xff0000, 0x804020];
    const img = await decodeImage(writePlanarIlbm(2, 2, 24, vals, new Uint8Array(0)));
    expect(img.source).toContain('4 colors, used as palette');
    expect(Array.from(toRgb(img))).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 0x20, 0x40, 0x80]);
  });

  it('decodes HAM6', async () => {
    const cmap = new Uint8Array(16 * 3);
    cmap.set([0x10, 0x20, 0x30], 0);
    cmap.set([0xff, 0xff, 0xff], 3);
    // row: palette 1, modify red=0, modify green=0x8, modify blue=0xf, then palette 0
    const vals = [0x01, 0x20, 0x38, 0x1f, 0x00];
    const img = await decodeImage(writePlanarIlbm(5, 1, 6, vals, cmap, undefined, 0x800));
    expect(img.source).toContain('HAM6');
    expect(Array.from(toRgb(img))).toEqual([
      255, 255, 255, 0, 255, 255, 0, 0x88, 255, 0, 0x88, 255, 0x10, 0x20, 0x30,
    ]);
  });
});
