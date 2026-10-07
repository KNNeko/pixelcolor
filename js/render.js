// Draws a canvas (palette + target cells + paint) into images: library thumbnails and PNG export.
// Works from data only, so the library can export a canvas without opening it.
import { createCanvas } from "./ui.js";

const rgbPixel = (r, g, b, a = 255) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** 32-bit pixel per palette color, and a light gray "not painted yet" shade of each. */
function paletteColors(palette) {
  const K = palette.length / 3;
  const color = new Uint32Array(K);
  const unpainted = new Uint32Array(K);
  for (let k = 0; k < K; k++) {
    const r = palette[k * 3];
    const g = palette[k * 3 + 1];
    const b = palette[k * 3 + 2];
    color[k] = rgbPixel(r, g, b);
    const v = Math.round(255 - (255 - (0.3 * r + 0.59 * g + 0.11 * b)) * 0.5);
    unpainted[k] = rgbPixel(v, v, v);
  }
  return { color, unpainted };
}

const canvasToBlob = (c) => new Promise((resolve) => c.toBlob(resolve, "image/png"));

/**
 * Renders the rectangle (x0,y0,w,h) of the canvas into an image whose longest side is at most maxSide.
 * Small areas are scaled up by a whole number (crisp), big ones averaged down.
 * onlyPart: draw only cells of that part (others transparent).
 */
function renderRegion(canvas, paint, x0, y0, w, h, maxSide, onlyPart) {
  const W = canvas.width;
  const { color, unpainted } = paletteColors(canvas.palette);
  const cellColor = (i) => (paint[i] ? color[paint[i] - 1] : unpainted[canvas.target[i]]);
  const skip = (i) => onlyPart != null && canvas.partOf[i] !== onlyPart;
  const longest = Math.max(w, h);
  const out = createCanvas(1, 1);

  if (longest <= maxSide) {
    const s = Math.floor(maxSide / longest);
    out.width = w * s;
    out.height = h * s;
    const img = out.getContext("2d").createImageData(out.width, out.height);
    const px = new Uint32Array(img.data.buffer);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y0 + y) * W + x0 + x;
        if (skip(i)) continue;
        const v = cellColor(i);
        for (let dy = 0; dy < s; dy++)
          px.fill(v, (y * s + dy) * out.width + x * s, (y * s + dy) * out.width + x * s + s);
      }
    out.getContext("2d").putImageData(img, 0, 0);
    return out;
  }

  const scale = maxSide / longest;
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const n = out.width * out.height;
  const sumR = new Float32Array(n);
  const sumG = new Float32Array(n);
  const sumB = new Float32Array(n);
  const counted = new Uint32Array(n);
  const total = new Uint32Array(n);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(out.height - 1, Math.floor((y * out.height) / h));
    for (let x = 0; x < w; x++) {
      const i = (y0 + y) * W + x0 + x;
      const t = ty * out.width + Math.min(out.width - 1, Math.floor((x * out.width) / w));
      total[t]++;
      if (skip(i)) continue;
      const v = cellColor(i);
      sumR[t] += v & 255;
      sumG[t] += (v >> 8) & 255;
      sumB[t] += (v >> 16) & 255;
      counted[t]++;
    }
  }
  const img = out.getContext("2d").createImageData(out.width, out.height);
  const px = new Uint32Array(img.data.buffer);
  for (let t = 0; t < n; t++)
    if (counted[t])
      px[t] = rgbPixel(
        Math.round(sumR[t] / counted[t]),
        Math.round(sumG[t] / counted[t]),
        Math.round(sumB[t] / counted[t]),
        Math.round((255 * counted[t]) / total[t]),
      );
  out.getContext("2d").putImageData(img, 0, 0);
  return out;
}

/** Library thumbnails: the whole picture, plus one per part. Returns { main: Blob, parts: Blob[] }. */
export async function renderThumbnails(canvas, paint, maxSide = 384) {
  const W = canvas.width;
  const H = canvas.height;
  const main = await canvasToBlob(renderRegion(canvas, paint, 0, 0, W, H, maxSide, null));
  const parts = [];
  if (canvas.parts.length) {
    const minX = new Int32Array(256).fill(1e9);
    const minY = new Int32Array(256).fill(1e9);
    const maxX = new Int32Array(256).fill(-1);
    const maxY = new Int32Array(256).fill(-1);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = canvas.partOf[y * W + x];
        if (x < minX[p]) minX[p] = x;
        if (y < minY[p]) minY[p] = y;
        if (x > maxX[p]) maxX[p] = x;
        if (y > maxY[p]) maxY[p] = y;
      }
    for (let p = 0; p < 256; p++)
      if (maxX[p] >= 0)
        parts.push(
          await canvasToBlob(
            renderRegion(canvas, paint, minX[p], minY[p], maxX[p] - minX[p] + 1, maxY[p] - minY[p] + 1, maxSide, p),
          ),
        );
  }
  return { main, parts };
}

/** Largest output allowed for PNG export (pixels per side / total). */
export const EXPORT_MAX_SIDE = 16384;
const EXPORT_MAX_PIXELS = 64e6;

export function maxCellSize(canvas) {
  const bySide = Math.floor(EXPORT_MAX_SIDE / Math.max(canvas.width, canvas.height));
  const byArea = Math.floor(Math.sqrt(EXPORT_MAX_PIXELS / (canvas.width * canvas.height)));
  return Math.max(1, Math.min(bySide, byArea));
}

/**
 * Sharp PNG where every cell is exactly cellSize x cellSize pixels.
 * finished: true = every cell in its final color; false = current progress (unpainted cells light gray).
 * grid: thin darker line on the top/left edge of each cell (only when cellSize >= 4).
 */
export async function renderPng(canvas, paint, { cellSize, finished, grid }) {
  const W = canvas.width;
  const H = canvas.height;
  const s = Math.max(1, Math.min(cellSize, maxCellSize(canvas)));
  const out = createCanvas(W * s, H * s);
  const ctx = out.getContext("2d");
  const img = ctx.createImageData(out.width, out.height);
  const px = new Uint32Array(img.data.buffer);
  const { color, unpainted } = paletteColors(canvas.palette);
  const drawGrid = grid && s >= 4;
  const darken = (v) =>
    rgbPixel(Math.round((v & 255) * 0.82), Math.round(((v >> 8) & 255) * 0.82), Math.round(((v >> 16) & 255) * 0.82));

  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = finished ? color[canvas.target[i]] : paint[i] ? color[paint[i] - 1] : unpainted[canvas.target[i]];
      const line = drawGrid ? darken(v) : v;
      for (let dy = 0; dy < s; dy++) {
        const row = (y * s + dy) * out.width + x * s;
        if (drawGrid && dy === 0) px.fill(line, row, row + s);
        else {
          px.fill(v, row, row + s);
          if (drawGrid) px[row] = line;
        }
      }
    }
  ctx.putImageData(img, 0, 0);
  return canvasToBlob(out);
}
