import { RgbaImage, toIndexed } from '../quantize';
import { IndexedImage } from '../types';
import { decodeGif, isGif } from './gif';
import { decodeIlbm, isIlbm } from './ilbm';
import { decodePng, isPng } from './png';

export { encodePng } from './png';
export { encodeIlbm } from './ilbm';

const UNRECOGNISED = 'Unrecognised file. Drop a PNG, GIF, IFF ILBM or another image format.';

/** Let the browser decode anything else it understands (JPEG, WebP, BMP, AVIF…). */
async function decodeWithBrowser(bytes: Uint8Array): Promise<RgbaImage> {
  const blob = new Blob([bytes]);
  let source: CanvasImageSource & { width: number; height: number };
  try {
    source = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch {
    // Some browsers reject the options or the format here; an <img> is more forgiving.
    source = await loadImageElement(blob);
  }
  const { width, height } = source;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  return { width, height, data, source: 'Image decoded by the browser' };
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  if (typeof Image !== 'function') return Promise.reject(new Error(UNRECOGNISED));
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(UNRECOGNISED)); };
    img.src = url;
  });
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

/**
 * Decode any supported file. `onConvert` is called (and awaited) before a
 * truecolor image is converted, so the UI can show that work is happening.
 */
export async function decodeImage(bytes: Uint8Array, onConvert?: () => Promise<void>): Promise<IndexedImage> {
  let img: IndexedImage | RgbaImage;
  if (isPng(bytes)) img = await decodePng(bytes);
  else if (isGif(bytes)) img = decodeGif(bytes);
  else if (isIlbm(bytes)) img = decodeIlbm(bytes);
  else img = await decodeWithBrowser(bytes);
  if (!('data' in img)) return img;
  await onConvert?.();
  return indexRgba(img);
}
