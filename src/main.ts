import { decodeImage, encodeIlbm, encodePng } from './codecs';
import { distanceMatrix, errorByDepth, histogram } from './rearrange';
import { makeSample } from './sample';
import { IndexedImage, colorCount } from './types';
import type { RearrangeRequest } from './worker';
import type { RearrangeResult } from './rearrange';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewer = $<HTMLElement>('viewer');
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const panel = $<HTMLElement>('panel');
const depthInput = $<HTMLInputElement>('depth');
const depthLabel = $<HTMLOutputElement>('depth-label');
const paletteEl = $<HTMLDivElement>('palette');
const errorsEl = $<HTMLTableElement>('errors');
const info = $<HTMLSpanElement>('info');
const pixelInfo = $<HTMLSpanElement>('pixel-info');
const zoomSelect = $<HTMLSelectElement>('zoom');
const rearrangeBtn = $<HTMLButtonElement>('rearrange');
const pinZero = $<HTMLInputElement>('pin-zero');
const progress = $<HTMLProgressElement>('progress');
const showOriginal = $<HTMLButtonElement>('show-original');
const showRearranged = $<HTMLButtonElement>('show-rearranged');
const toastEl = $<HTMLDivElement>('toast');
const busyEl = $<HTMLDivElement>('busy');

interface State {
  name: string;
  original: IndexedImage;
  rearranged: IndexedImage | null;
  result: RearrangeResult | null;
  show: 'original' | 'rearranged';
  depth: number;
}
let state: State | null = null;
let worker: Worker | null = null;

function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout((toast as unknown as { t: number }).t);
  (toast as unknown as { t: number }).t = window.setTimeout(() => (toastEl.hidden = true), 4500);
}

function busy(msg: string | null) {
  busyEl.hidden = !msg;
  busyEl.textContent = msg ?? '';
}

function current(): IndexedImage {
  return state!.show === 'rearranged' && state!.rearranged ? state!.rearranged : state!.original;
}

function hex(p: Uint8Array, i: number) {
  return '#' + [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function applyPermutation(img: IndexedImage, oldToNew: Uint16Array): IndexedImage {
  const indices = new Uint8Array(img.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = oldToNew[img.indices[i]];
  const palette = new Uint8Array(img.palette.length);
  for (let c = 0; c < oldToNew.length; c++) palette.set(img.palette.subarray(c * 3, c * 3 + 3), oldToNew[c] * 3);
  return {
    ...img,
    indices,
    palette,
    transparentIndex: img.transparentIndex === undefined ? undefined : oldToNew[img.transparentIndex],
  };
}

function render() {
  if (!state) return;
  const img = current();
  const mask = (1 << state.depth) - 1;
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
  }
  const data = ctx.createImageData(img.width, img.height);
  const px = data.data;
  const pal = img.palette;
  for (let i = 0; i < img.indices.length; i++) {
    const full = img.indices[i];
    const c = (full & mask) * 3;
    const o = i * 4;
    px[o] = pal[c];
    px[o + 1] = pal[c + 1];
    px[o + 2] = pal[c + 2];
    px[o + 3] = full === img.transparentIndex ? 0 : 255;
  }
  ctx.putImageData(data, 0, 0);
  layoutCanvas();
  renderPalette();
  renderErrors();
  const n = 1 << state.depth;
  depthLabel.textContent = `${state.depth} bit${state.depth === 1 ? '' : 's'} · ${n} color${n === 1 ? '' : 's'}`;
}

function layoutCanvas() {
  if (!state) return;
  const img = current();
  let scale: number;
  if (zoomSelect.value === 'fit') {
    const bar = viewer.querySelector('.viewer-bar') as HTMLElement;
    const aw = viewer.clientWidth - 32;
    const ah = viewer.clientHeight - bar.offsetHeight - 32;
    scale = Math.min(aw / img.width, ah / img.height);
    if (scale >= 1) scale = Math.floor(scale);
  } else scale = Number(zoomSelect.value);
  canvas.style.width = `${img.width * scale}px`;
  canvas.style.height = `${img.height * scale}px`;
}

function renderPalette() {
  const img = current();
  const n = colorCount(img);
  const mask = (1 << state!.depth) - 1;
  const counts = histogram(img.indices, n);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    s.className = 'swatch';
    s.style.background = hex(img.palette, i);
    const shownAs = i & mask;
    let title = `#${i}  ${hex(img.palette, i)}  ·  ${counts[i]} px`;
    if (shownAs !== i) {
      s.classList.add('off');
      const to = document.createElement('div');
      to.className = 'to';
      to.style.background = hex(img.palette, shownAs);
      s.appendChild(to);
      title += `\nshown as #${shownAs} ${hex(img.palette, shownAs)}`;
    }
    s.title = title;
    frag.appendChild(s);
  }
  paletteEl.replaceChildren(frag);
}

function renderErrors() {
  const s = state!;
  const bits = s.original.bits;
  const before = s.result?.errorBefore ?? errorOfOriginal();
  const after = s.result?.errorAfter;
  const max = Math.max(...before, ...(after ?? [0]), 1e-9);
  const rows: string[] = [`<tr><th>Bits</th><th>Original</th>${after ? '<th>Rearranged</th><th>Change</th>' : ''}<th></th></tr>`];
  for (let k = bits; k >= 0; k--) {
    const b = before[k];
    const a = after?.[k];
    let change = '';
    if (a !== undefined) {
      const pct = b > 0 ? ((a - b) / b) * 100 : 0;
      const cls = pct < -0.5 ? 'better' : pct > 0.5 ? 'worse' : '';
      change = `<td class="${cls}">${b > 0 ? `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%` : '—'}</td>`;
    }
    rows.push(
      `<tr class="${k === s.depth ? 'current' : ''}"><td>${k}</td><td>${b.toFixed(2)}</td>` +
        (a !== undefined ? `<td>${a.toFixed(2)}</td>${change}` : '') +
        `<td class="bar"><div class="bars"><span class="before" style="width:${(b / max) * 100}%"></span>` +
        (a !== undefined ? `<span class="after" style="width:${(a / max) * 100}%"></span>` : '') +
        `</div></td></tr>`,
    );
  }
  errorsEl.innerHTML = rows.join('');
}

let originalErrorCache: { img: IndexedImage; err: number[] } | null = null;
function errorOfOriginal(): number[] {
  const img = state!.original;
  if (originalErrorCache?.img === img) return originalErrorCache.err;
  const err = computeErrors(img);
  originalErrorCache = { img, err };
  return err;
}

function computeErrors(img: IndexedImage): number[] {
  const n = colorCount(img);
  const order = Array.from({ length: n }, (_, i) => i);
  return errorByDepth(order, histogram(img.indices, n), distanceMatrix(img.palette), img.bits);
}

function setShow(which: 'original' | 'rearranged') {
  if (!state) return;
  state.show = which;
  showOriginal.setAttribute('aria-checked', String(which === 'original'));
  showRearranged.setAttribute('aria-checked', String(which === 'rearranged'));
  render();
}

function load(img: IndexedImage, name: string) {
  worker?.terminate();
  worker = null;
  progress.hidden = true;
  rearrangeBtn.disabled = false;
  state = { name, original: img, rearranged: null, result: null, show: 'original', depth: img.bits };
  depthInput.max = String(img.bits);
  depthInput.value = String(img.bits);
  showRearranged.disabled = true;
  setShow('original');
  viewer.classList.remove('empty');
  panel.hidden = false;
  info.textContent = `${name} · ${img.width}×${img.height} · ${img.source}`;
  render();
}

async function loadFile(file: File) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const img = await decodeImage(bytes, async () => {
      busy(`Converting ${file.name} to 256 colors…`);
      // Let the message paint before the (synchronous) conversion starts.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    });
    busy(null);
    load(img, file.name);
  } catch (err) {
    busy(null);
    toast(err instanceof Error ? err.message : String(err));
  }
}

function runRearrange() {
  if (!state) return;
  const s = state;
  worker?.terminate();
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  rearrangeBtn.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  const req: RearrangeRequest = {
    indices: s.original.indices,
    palette: s.original.palette,
    bits: s.original.bits,
    pinZero: pinZero.checked,
    timeBudgetMs: 4000,
  };
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') progress.value = msg.value;
    else if (msg.type === 'done') {
      worker?.terminate();
      worker = null;
      progress.hidden = true;
      rearrangeBtn.disabled = false;
      s.result = msg.result as RearrangeResult;
      s.rearranged = applyPermutation(s.original, s.result.oldToNew);
      showRearranged.disabled = false;
      setShow('rearranged');
    } else if (msg.type === 'error') {
      toast(msg.message);
      rearrangeBtn.disabled = false;
      progress.hidden = true;
    }
  };
  worker.postMessage(req);
}

function download(bytes: Uint8Array, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportName(ext: string) {
  const base = state!.name.replace(/\.[^.]+$/, '');
  return `${base}${state!.show === 'rearranged' ? '-rearranged' : ''}.${ext}`;
}

// --- events ---
$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void loadFile(f);
});
$<HTMLButtonElement>('sample').addEventListener('click', () => load(makeSample(), 'sample.png'));

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; viewer.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; viewer.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  viewer.classList.remove('dragging');
  const f = e.dataTransfer?.files[0];
  if (f) void loadFile(f);
});

depthInput.addEventListener('input', () => {
  if (!state) return;
  state.depth = Number(depthInput.value);
  render();
});
zoomSelect.addEventListener('change', layoutCanvas);
window.addEventListener('resize', layoutCanvas);
rearrangeBtn.addEventListener('click', runRearrange);
showOriginal.addEventListener('click', () => setShow('original'));
showRearranged.addEventListener('click', () => setShow('rearranged'));

window.addEventListener('keydown', (e) => {
  if (!state || e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (e.key === ' ' && state.rearranged) {
    e.preventDefault();
    setShow(state.show === 'original' ? 'rearranged' : 'original');
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!state) return;
  const img = current();
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * img.width);
  const y = Math.floor(((e.clientY - r.top) / r.height) * img.height);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const idx = img.indices[y * img.width + x];
  const shown = idx & ((1 << state.depth) - 1);
  pixelInfo.textContent = `(${x}, ${y}) index ${idx}${shown !== idx ? ` → ${shown}` : ''}`;
});
canvas.addEventListener('mouseleave', () => (pixelInfo.textContent = ''));

$<HTMLButtonElement>('export-png').addEventListener('click', async () => {
  if (state) download(await encodePng(current()), exportName('png'), 'image/png');
});
$<HTMLButtonElement>('export-ilbm').addEventListener('click', () => {
  if (state) download(encodeIlbm(current()), exportName('iff'), 'application/octet-stream');
});
