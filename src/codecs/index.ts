import { RgbaImage, toIndexed } from '../quantize';
import { IndexedImage } from '../types';
import { decodeGif, isGif } from './gif';
import { decodeIlbm, isIlbm } from './ilbm';
import { decodePng, isPng } from './png';

export { encodePng } from './png';
export { encodeIlbm } from './ilbm';

/** Let the browser decode anything else it understands (JPEG, WebP, BMP, AVIF…). */
async function decodeWithBrowser(bytes: Uint8Array): Promise<RgbaImage> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('Unrecognised file. Drop a PNG, GIF, IFF ILBM or another image format.');
  }
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch {
    throw new Error('Unrecognised file. Drop a PNG, GIF, IFF ILBM or another image format.');
  }
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: bmp.width, height: bmp.height, data, source: 'Image decoded by the browser' };
}

/** Convert a truecolor image to indexed (exact palette if it fits, else dithered). */
export function indexRgba(rgba: RgbaImage): IndexedImage {
  const r = toIndexed(rgba);
  return {
    width: rgba.width,
    height: rgba.height,
    indices: r.indices,
    palette: r.palette,
    bits: r.bits,
    transparentIndex: r.transparentIndex,
    source: `${rgba.source} → ${r.note}`,
  };
}

export async function decodeImage(bytes: Uint8Array): Promise<IndexedImage> {
  let img: IndexedImage | RgbaImage;
  if (isPng(bytes)) img = await decodePng(bytes);
  else if (isGif(bytes)) img = decodeGif(bytes);
  else if (isIlbm(bytes)) img = decodeIlbm(bytes);
  else img = await decodeWithBrowser(bytes);
  return 'data' in img ? indexRgba(img) : img;
}
