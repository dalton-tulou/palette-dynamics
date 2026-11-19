import { IndexedImage } from '../types';
import { decodeGif, isGif } from './gif';
import { decodeIlbm, isIlbm } from './ilbm';
import { decodePng, isPng } from './png';

export { encodePng } from './png';
export { encodeIlbm } from './ilbm';

export async function decodeImage(bytes: Uint8Array): Promise<IndexedImage> {
  if (isPng(bytes)) return decodePng(bytes);
  if (isGif(bytes)) return decodeGif(bytes);
  if (isIlbm(bytes)) return decodeIlbm(bytes);
  throw new Error('Unrecognised file. Drop an indexed PNG, a GIF, or an IFF ILBM.');
}
