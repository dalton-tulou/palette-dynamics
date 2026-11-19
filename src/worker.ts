import { rearrange } from './rearrange';

export interface RearrangeRequest {
  indices: Uint8Array;
  palette: Uint8Array;
  bits: number;
  pinZero: boolean;
  timeBudgetMs: number;
}

self.onmessage = (e: MessageEvent<RearrangeRequest>) => {
  const { indices, palette, bits, pinZero, timeBudgetMs } = e.data;
  try {
    const result = rearrange(indices, palette, bits, {
      pinZero,
      timeBudgetMs,
      onProgress: (f) => self.postMessage({ type: 'progress', value: f }),
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
};
