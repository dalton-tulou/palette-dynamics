import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeImage, encodeIlbm, encodePng } from '../src/codecs';
import { rearrange } from '../src/rearrange';
import { makeSample } from '../src/sample';
import { IndexedImage } from '../src/types';

function small(bits: number): IndexedImage {
  const w = 37, h = 11, n = 1 << bits;
  const indices = new Uint8Array(w * h).map((_, i) => (i * 7 + (i >> 3)) % n);
  const palette = new Uint8Array(n * 3).map((_, i) => (i * 53) & 255);
  return { width: w, height: h, indices, palette, bits, source: 't', transparentIndex: bits > 1 ? 1 : undefined };
}

describe('codecs round-trip', () => {
  for (const bits of [1, 2, 4, 5, 8]) {
    it(`PNG ${bits}-bit`, async () => {
      const img = small(bits);
      const back = await decodeImage(await encodePng(img));
      expect(back.width).toBe(img.width);
      expect(back.indices).toEqual(img.indices);
      expect(back.palette).toEqual(img.palette);
      expect(back.transparentIndex).toBe(img.transparentIndex);
    });
    it(`ILBM ${bits} planes`, async () => {
      const img = small(bits);
      const back = await decodeImage(encodeIlbm(img));
      expect(back.bits).toBe(bits);
      expect(back.indices).toEqual(img.indices);
      expect(back.palette).toEqual(img.palette);
    });
  }
  for (const f of ['rose.gif', 'rose-interlaced.gif', 'rose16.png', 'rose-adam7.png']) {
    it(`decodes ${f} like ImageMagick`, async () => {
      const dir = new URL('./fixtures/', import.meta.url);
      const img = await decodeImage(new Uint8Array(readFileSync(new URL(f, dir))));
      const ref = new Uint8Array(readFileSync(new URL(f + '.rgb', dir)));
      const rgb = new Uint8Array(img.width * img.height * 3);
      img.indices.forEach((c, i) => rgb.set(img.palette.subarray(c * 3, c * 3 + 3), i * 3));
      expect(rgb).toEqual(ref);
    });
  }
});

describe('rearrange', () => {
  it('produces a permutation and lowers error on the shuffled sample', () => {
    const s = makeSample();
    const r = rearrange(s.indices, s.palette, s.bits, { timeBudgetMs: 2000 });
    expect(new Set(r.oldToNew).size).toBe(64);
    for (let k = 1; k < s.bits; k++) expect(r.errorAfter[k]).toBeLessThan(r.errorBefore[k]);
    expect(r.errorAfter[s.bits]).toBe(0);
    console.log(r.errorBefore.map((v) => v.toFixed(2)).join(' '), '\n', r.errorAfter.map((v) => v.toFixed(2)).join(' '));
  });
  it('pins color 0', () => {
    const s = makeSample();
    const r = rearrange(s.indices, s.palette, s.bits, { pinZero: true, timeBudgetMs: 500 });
    expect(r.oldToNew[0]).toBe(0);
  });
});
