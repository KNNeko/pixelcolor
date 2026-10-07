// Pixelization engine. Pure functions only: no DOM, no global app state.
// Runs inside the Web Worker (engine.worker.js) and in Node tests.
//
// Pipeline (generate):
//   source photo pixels
//   -> boxScale to W*H (or W*k x H*k for styles that look at sub-cells)
//   -> optional bilateral smoothing, user adjustments, style adjustments
//   -> kmeansPalette: pick K colors (k-means in Lab color space)
//   -> quantize: map every cell to a palette index (optionally with dithering)
//   -> clean-up: mode filter, outlines, small-speck removal
//   -> finalizePalette: drop unused colors, number them dark -> light

/* ---------- styles ---------- */

export const STYLE_GROUPS = [
  ["g_pix", ["smooth", "dom", "paint"]],
  ["g_det", ["klines", "hc", "outl"]],
  ["g_ret", ["retro", "fs", "bay", "halo"]],
];
export const STYLE_IDS = STYLE_GROUPS.flatMap(([, ids]) => ids);

export const NO_ADJUST = { bri: 100, con: 100, sat: 100, tmp: 0, shp: 0, blk: 0, wht: 255 };

/** Extra color adjustments a style applies on top of the user's own. */
const STYLE_ADJUST = {
  hc: { bri: 100, con: 150, sat: 118, tmp: 0, shp: 35, blk: 8, wht: 242 },
  outl: { bri: 100, con: 115, sat: 140, tmp: 0, shp: 0, blk: 0, wht: 255 },
  retro: { bri: 100, con: 110, sat: 125, tmp: 0, shp: 0, blk: 0, wht: 255 },
};

/** Error-diffusion kernels: [dx, dy, weight, ...]. */
const DIFFUSION = { fs: [1, 0, 7 / 16, -1, 1, 3 / 16, 0, 1, 5 / 16, 1, 1, 1 / 16] };

/** Ordered-dither threshold maps: (x, y) -> 0..1. */
const bayerMatrix = (levels) => (x, y) => {
  let v = 0;
  for (let i = 0; i < levels; i++) {
    const a = (x >> i) & 1;
    const b = (y >> i) & 1;
    v += ((a ^ b) * 2 + b) * 4 ** (levels - 1 - i);
  }
  return (v + 0.5) / 4 ** levels;
};
const THRESHOLD = {
  bay: bayerMatrix(2), // 4x4 Bayer
  halo: (x, y) => (2 - Math.cos(((x + y) * Math.PI) / 4) - Math.cos(((x - y) * Math.PI) / 4)) / 4,
};

/** Styles that pick colors from sub-cells instead of the cell average (need a supersampled image). */
const SUBCELL_STYLES = ["dom", "klines"];

/* ---------- helpers ---------- */

/** Deterministic random generator (same photo + settings => same result). */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const noHooks = { pause: async () => true, progress: () => {} };

/* ---------- resampling and adjustments ---------- */

/**
 * Area-average downscale. Every output pixel is the weighted mean of all source pixels it covers,
 * including partial pixels at the edges (avoids moire you get from simple sampling).
 * source: { data: RGBA bytes, width, height } -> RGBA Uint8ClampedArray of W*H.
 */
export function boxScale(source, W, H) {
  const src = source.data;
  const sw = source.width;
  const sh = source.height;
  const out = new Uint8ClampedArray(W * H * 4);
  const fx = sw / W;
  const fy = sh / H;
  const rowAvg = new Float32Array(W * 3); // one source row, horizontally averaged
  const acc = new Float32Array(W * 3);
  let cachedRow = -1;

  const averageRow = (j) => {
    if (j === cachedRow) return;
    cachedRow = j;
    const rowStart = j * sw * 4;
    for (let x = 0; x < W; x++) {
      const a = x * fx;
      const b = a + fx;
      let r = 0;
      let g = 0;
      let bl = 0;
      let total = 0;
      for (let i = Math.floor(a); i < b && i < sw; i++) {
        const w = Math.min(i + 1, b) - Math.max(i, a);
        if (w <= 0) continue;
        const p = rowStart + i * 4;
        r += src[p] * w;
        g += src[p + 1] * w;
        bl += src[p + 2] * w;
        total += w;
      }
      rowAvg[x * 3] = r / total;
      rowAvg[x * 3 + 1] = g / total;
      rowAvg[x * 3 + 2] = bl / total;
    }
  };

  for (let y = 0; y < H; y++) {
    acc.fill(0);
    const a = y * fy;
    const b = a + fy;
    let total = 0;
    for (let j = Math.floor(a); j < b && j < sh; j++) {
      const w = Math.min(j + 1, b) - Math.max(j, a);
      if (w <= 0) continue;
      averageRow(j);
      for (let q = 0; q < W * 3; q++) acc[q] += rowAvg[q] * w;
      total += w;
    }
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      out[p] = acc[x * 3] / total;
      out[p + 1] = acc[x * 3 + 1] / total;
      out[p + 2] = acc[x * 3 + 2] / total;
      out[p + 3] = 255;
    }
  }
  return out;
}

/**
 * Brightness / contrast / saturation / temperature / sharpen / black & white point, in place.
 * a = { bri, con, sat (percent), tmp (-50..50), shp (0..150), blk (0..40), wht (200..255) }
 */
export function applyAdjustments(rgba, w, h, a) {
  if (a.bri === 100 && a.con === 100 && a.sat === 100 && !a.tmp && !a.shp && !a.blk && a.wht === 255) return rgba;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = ((i - a.blk * 2.55) / Math.max(1, a.wht - a.blk * 2.55)) * 255;
    v = (v * a.bri) / 100;
    lut[i] = ((v - 128) * a.con) / 100 + 128;
  }
  const saturation = a.sat / 100;
  const warm = a.tmp * 0.6;
  for (let i = 0, n = w * h; i < n; i++) {
    const p = i * 4;
    const r = lut[rgba[p]];
    const g = lut[rgba[p + 1]];
    const b = lut[rgba[p + 2]];
    const luma = 0.3 * r + 0.59 * g + 0.11 * b;
    rgba[p] = luma + (r - luma) * saturation + warm;
    rgba[p + 1] = luma + (g - luma) * saturation;
    rgba[p + 2] = luma + (b - luma) * saturation - warm;
  }
  if (a.shp) {
    // unsharp-style 4-neighbour sharpen
    const s = a.shp / 100;
    const copy = new Uint8ClampedArray(rgba);
    const stride = w * 4;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const p = (y * w + x) * 4;
        for (let c = 0; c < 3; c++)
          rgba[p + c] =
            copy[p + c] * (1 + 4 * s) -
            s * (copy[p + c - 4] + copy[p + c + 4] + copy[p + c - stride] + copy[p + c + stride]);
      }
  }
  return rgba;
}

/** Edge-preserving smoothing: neighbours that differ a lot in color get little weight. level 0..5. */
export function bilateral(rgba, w, h, level) {
  if (!level) return rgba;
  const sigma = 6 + level * 9;
  const weight = new Float32Array(766); // indexed by |dR|+|dG|+|dB|
  for (let d = 0; d < 766; d++) weight[d] = Math.exp((-d * d) / (2 * sigma * sigma));
  const radius = level > 2 && w * h < 4e6 ? 2 : 1;
  const passes = level > 3 ? 2 : 1;
  let src = rgba;
  for (let pass = 0; pass < passes; pass++) {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const r = src[p];
        const g = src[p + 1];
        const b = src[p + 2];
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(w - 1, x + radius);
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sw = 0;
        for (let yy = y0; yy <= y1; yy++)
          for (let xx = x0; xx <= x1; xx++) {
            const q = (yy * w + xx) * 4;
            const k = weight[Math.abs(src[q] - r) + Math.abs(src[q + 1] - g) + Math.abs(src[q + 2] - b)];
            sr += src[q] * k;
            sg += src[q + 1] * k;
            sb += src[q + 2] * k;
            sw += k;
          }
        out[p] = sr / sw;
        out[p + 1] = sg / sw;
        out[p + 2] = sb / sw;
        out[p + 3] = 255;
      }
    }
    src = out;
  }
  return src;
}

/**
 * Collapses each k*k block of a supersampled image into one pixel.
 * mode "dominant": the most common (coarsely bucketed) color of the block.
 * mode "klines": the darkest sample if it is clearly darker than the block average (keeps thin lines).
 */
export function pickFromSubcells(rgba, W, H, k, mode) {
  const out = new Uint8ClampedArray(W * H * 4);
  const rowWidth = W * k;
  const n = k * k;
  const keys = new Int32Array(n);
  const offsets = new Int32Array(n);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      for (let j = 0; j < n; j++) {
        const p = ((y * k + ((j / k) | 0)) * rowWidth + x * k + (j % k)) * 4;
        offsets[j] = p;
        keys[j] = ((rgba[p] >> 4) << 8) | ((rgba[p + 1] >> 4) << 4) | (rgba[p + 2] >> 4);
      }
      const q = (y * W + x) * 4;
      out[q + 3] = 255;
      if (mode === "klines") {
        let lumaSum = 0;
        let darkest = 1e9;
        let darkestAt = 0;
        const sum = [0, 0, 0];
        for (let j = 0; j < n; j++) {
          const p = offsets[j];
          const luma = 0.3 * rgba[p] + 0.59 * rgba[p + 1] + 0.11 * rgba[p + 2];
          lumaSum += luma;
          sum[0] += rgba[p];
          sum[1] += rgba[p + 1];
          sum[2] += rgba[p + 2];
          if (luma < darkest) {
            darkest = luma;
            darkestAt = p;
          }
        }
        const useDark = darkest < lumaSum / n - 45;
        for (let c = 0; c < 3; c++) out[q + c] = useDark ? rgba[darkestAt + c] : sum[c] / n;
        continue;
      }
      // dominant bucket, then average the samples inside it
      let bestKey = 0;
      let bestCount = 0;
      for (let a = 0; a < n; a++) {
        let count = 0;
        for (let b = 0; b < n; b++) if (keys[a] === keys[b]) count++;
        if (count > bestCount) {
          bestCount = count;
          bestKey = keys[a];
        }
      }
      let r = 0;
      let g = 0;
      let bl = 0;
      let c = 0;
      for (let j = 0; j < n; j++)
        if (keys[j] === bestKey) {
          r += rgba[offsets[j]];
          g += rgba[offsets[j] + 1];
          bl += rgba[offsets[j] + 2];
          c++;
        }
      out[q] = r / c;
      out[q + 1] = g / c;
      out[q + 2] = bl / c;
    }
  return out;
}

/* ---------- color space ---------- */

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  SRGB_TO_LINEAR[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** sRGB bytes -> CIE Lab, written to out[at..at+2]. Distances in Lab roughly match perceived difference. */
export function srgbToLab(r, g, b, out, at) {
  const R = SRGB_TO_LINEAR[r];
  const G = SRGB_TO_LINEAR[g];
  const B = SRGB_TO_LINEAR[b];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  out[at] = 116 * y - 16;
  out[at + 1] = 500 * (x - y);
  out[at + 2] = 200 * (y - z);
}

function paletteToLab(pal, K) {
  const lab = new Float32Array(K * 3);
  for (let k = 0; k < K; k++) srgbToLab(pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2], lab, k * 3);
  return lab;
}

/** Evenly spaced sample of `count` pixels, in Lab and RGB. */
export function samplePixels(rgba, pixelCount, count) {
  const step = pixelCount / count;
  const lab = new Float32Array(count * 3);
  const rgb = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const p = ((i * step) | 0) * 4;
    rgb[i * 3] = rgba[p];
    rgb[i * 3 + 1] = rgba[p + 1];
    rgb[i * 3 + 2] = rgba[p + 2];
    srgbToLab(rgba[p] | 0, rgba[p + 1] | 0, rgba[p + 2] | 0, lab, i * 3);
  }
  return { lab, rgb, count };
}

/* ---------- k-means palette ---------- */

/**
 * k-means on Lab points with k-means++ seeding (next center chosen with probability ~ distance²).
 * Returns { palette: RGB Float32Array (averaged in RGB so colors don't drift), error: mean Lab distance }.
 */
export async function kmeansFit(sample, K, iterations, hooks = noHooks) {
  const { lab: pts, rgb, count: S } = sample;
  const random = makeRandom(7);
  const centers = new Float32Array(K * 3);
  const nearestDist = new Float32Array(S).fill(1e12);
  const seedIndex = new Int32Array(K);

  let s = (random() * S) | 0;
  for (let k = 0; k < K; k++) {
    seedIndex[k] = s;
    for (let j = 0; j < 3; j++) centers[k * 3 + j] = pts[s * 3 + j];
    let total = 0;
    for (let i = 0; i < S; i++) {
      const a = pts[i * 3] - centers[k * 3];
      const b = pts[i * 3 + 1] - centers[k * 3 + 1];
      const c = pts[i * 3 + 2] - centers[k * 3 + 2];
      const d = a * a + b * b + c * c;
      if (d < nearestDist[i]) nearestDist[i] = d;
      total += nearestDist[i];
    }
    let r = random() * total;
    for (s = 0; s < S - 1 && (r -= nearestDist[s]) > 0; s++);
    if ((k & 63) === 63 && !(await hooks.pause())) return null;
  }

  const nearestCenter = (i) => {
    let best = 0;
    let bestD = 1e12;
    const L = pts[i * 3];
    const A = pts[i * 3 + 1];
    const B = pts[i * 3 + 2];
    for (let k = 0; k < K; k++) {
      const a = L - centers[k * 3];
      const b = A - centers[k * 3 + 1];
      const c = B - centers[k * 3 + 2];
      const d = a * a + b * b + c * c;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return [best, bestD];
  };

  const sums = new Float64Array(K * 3);
  const counts = new Int32Array(K);
  for (let it = 0; it < iterations; it++) {
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < S; i++) {
      const [k] = nearestCenter(i);
      counts[k]++;
      sums[k * 3] += pts[i * 3];
      sums[k * 3 + 1] += pts[i * 3 + 1];
      sums[k * 3 + 2] += pts[i * 3 + 2];
    }
    for (let k = 0; k < K; k++)
      if (counts[k]) for (let j = 0; j < 3; j++) centers[k * 3 + j] = sums[k * 3 + j] / counts[k];
    if (!(await hooks.pause())) return null;
  }

  // final assignment: average the RGB values of each cluster
  sums.fill(0);
  counts.fill(0);
  let error = 0;
  for (let i = 0; i < S; i++) {
    const [k, d] = nearestCenter(i);
    error += Math.sqrt(d);
    counts[k]++;
    sums[k * 3] += rgb[i * 3];
    sums[k * 3 + 1] += rgb[i * 3 + 1];
    sums[k * 3 + 2] += rgb[i * 3 + 2];
  }
  const palette = new Float32Array(K * 3);
  for (let k = 0; k < K; k++)
    for (let j = 0; j < 3; j++)
      palette[k * 3 + j] = Math.round(counts[k] ? sums[k * 3 + j] / counts[k] : rgb[seedIndex[k] * 3 + j]);
  return { palette, error: error / S };
}

export async function kmeansPalette(rgba, pixelCount, K, hooks) {
  const sample = samplePixels(rgba, pixelCount, Math.min(pixelCount, K > 300 ? 16000 : 30000));
  const fit = await kmeansFit(sample, K, 8, hooks);
  return fit && fit.palette;
}

/** Snaps palette colors to 4 levels per channel (64-color 8-bit console palette), removing duplicates. */
export function retroPalette(pal) {
  const LEVELS = [0, 85, 170, 255];
  const seen = new Set();
  const out = [];
  for (let k = 0; k < pal.length / 3; k++) {
    const c = [0, 1, 2].map((j) => LEVELS[Math.min(3, Math.round(pal[k * 3 + j] / 85))]);
    const key = c.join();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(...c);
    }
  }
  if (out.length < 6) out.push(...(out[0] ? [255, 255, 255] : [0, 0, 0])); // at least 2 colors
  return new Float32Array(out);
}

/* ---------- quantization ---------- */

/**
 * Maps every pixel to the nearest palette color (in Lab). With style "fs" the rounding error is
 * spread to neighbours (Floyd-Steinberg); with "bay"/"halo" a threshold pattern is added first.
 * Returns Uint16Array of palette indices, or null if cancelled.
 */
export async function quantize(rgba, W, H, pal, K, style, hooks = noHooks) {
  const idx = new Uint16Array(W * H);
  const cache = new Int16Array(262144).fill(-1); // 6 bits per channel
  const palLab = paletteToLab(pal, K);
  const tmp = new Float32Array(3);
  const nearest = (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let v = cache[key];
    if (v < 0) {
      srgbToLab(((r >> 2) << 2) + 2, ((g >> 2) << 2) + 2, ((b >> 2) << 2) + 2, tmp, 0);
      let bestD = 1e12;
      for (let k = 0; k < K; k++) {
        const a = tmp[0] - palLab[k * 3];
        const e = tmp[1] - palLab[k * 3 + 1];
        const f = tmp[2] - palLab[k * 3 + 2];
        const d = a * a + e * e + f * f;
        if (d < bestD) {
          bestD = d;
          v = k;
        }
      }
      cache[key] = v;
    }
    return v;
  };

  const kernel = DIFFUSION[style];
  const threshold = THRESHOLD[style];
  const errorRows = [0, 1, 2].map(() => new Float32Array(W * 3)); // ring buffer of 3 rows
  const spread = 255 / Math.cbrt(K);

  for (let y = 0; y < H; y++) {
    const rowErr = errorRows[y % 3];
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let r = rgba[i * 4];
      let g = rgba[i * 4 + 1];
      let b = rgba[i * 4 + 2];
      if (kernel) {
        r += rowErr[x * 3];
        g += rowErr[x * 3 + 1];
        b += rowErr[x * 3 + 2];
      } else if (threshold) {
        const o = (threshold(x, y) - 0.5) * spread;
        r += o;
        g += o;
        b += o;
      }
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      const j = nearest(r | 0, g | 0, b | 0);
      idx[i] = j;
      if (kernel) {
        const er = r - pal[j * 3];
        const eg = g - pal[j * 3 + 1];
        const eb = b - pal[j * 3 + 2];
        for (let q = 0; q < kernel.length; q += 3) {
          const xx = x + kernel[q];
          if (xx < 0 || xx >= W) continue;
          const target = errorRows[(y + kernel[q + 1]) % 3];
          const w = kernel[q + 2];
          target[xx * 3] += er * w;
          target[xx * 3 + 1] += eg * w;
          target[xx * 3 + 2] += eb * w;
        }
      }
    }
    if (kernel) rowErr.fill(0);
    if (y % 64 === 63) {
      hooks.progress(y / H);
      if (!(await hooks.pause())) return null;
    }
  }
  return idx;
}

/* ---------- clean-up passes on the index map ---------- */

/** Majority filter: a cell switches to the most common neighbour color if it wins clearly. level 1..5. */
export function modeFilter(idx, W, H, level) {
  const needLead = Math.max(1, 6 - level);
  const nb = new Int32Array(9);
  const passes = level > 3 ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    const out = new Uint16Array(idx);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let m = 0;
        const i = y * W + x;
        const own = idx[i];
        for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++)
          for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) nb[m++] = idx[yy * W + xx];
        let best = own;
        let bestCount = 0;
        let ownCount = 0;
        for (let a = 0; a < m; a++) {
          let count = 0;
          for (let b = 0; b < m; b++) count += nb[a] === nb[b];
          if (nb[a] === own) ownCount = count;
          if (count > bestCount) {
            bestCount = count;
            best = nb[a];
          }
        }
        if (bestCount - ownCount >= needLead) out[i] = best;
      }
    idx.set(out);
  }
}

/**
 * Removes connected same-color regions smaller than minSize cells:
 * each one takes the neighbouring color closest to its own (in Lab).
 */
export function removeSpecks(idx, W, H, minSize, pal) {
  if (minSize < 2) return;
  const N = W * H;
  const palLab = paletteToLab(pal, pal.length / 3);
  const region = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const regionSize = [];
  const regionColor = [];
  let regions = 0;

  // label connected regions (4-neighbour flood fill)
  for (let start = 0; start < N; start++) {
    if (region[start] >= 0) continue;
    const c = idx[start];
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    region[start] = regions;
    while (head < tail) {
      const i = queue[head++];
      const x = i % W;
      const y = (i / W) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1])
        if (j >= 0 && region[j] < 0 && idx[j] === c) {
          region[j] = regions;
          queue[tail++] = j;
        }
    }
    regionSize.push(tail);
    regionColor.push(c);
    regions++;
  }

  const labDist = (a, b) => {
    const x = palLab[a * 3] - palLab[b * 3];
    const y = palLab[a * 3 + 1] - palLab[b * 3 + 1];
    const z = palLab[a * 3 + 2] - palLab[b * 3 + 2];
    return x * x + y * y + z * z;
  };
  const bestDist = new Float32Array(regions).fill(1e12);
  const bestColor = new Int32Array(regions).fill(-1);
  for (let i = 0; i < N; i++) {
    const L = region[i];
    if (regionSize[L] >= minSize) continue;
    const x = i % W;
    const y = (i / W) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      if (j < 0 || region[j] === L) continue;
      const d = labDist(regionColor[L], idx[j]);
      if (d < bestDist[L]) {
        bestDist[L] = d;
        bestColor[L] = idx[j];
      }
    }
  }
  for (let i = 0; i < N; i++) {
    const L = region[i];
    if (regionSize[L] < minSize && bestColor[L] >= 0) idx[i] = bestColor[L];
  }
}

/** Strong light/dark borders get an outline: the lighter cell of the pair takes the darkest palette color. */
export function addOutlines(idx, W, H, pal, K) {
  const luma = [];
  for (let k = 0; k < K; k++) luma[k] = 0.3 * pal[k * 3] + 0.59 * pal[k * 3 + 1] + 0.11 * pal[k * 3 + 2];
  let darkest = 0;
  for (let k = 0; k < K; k++) if (luma[k] < luma[darkest]) darkest = k;
  const mark = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      for (const j of [x < W - 1 ? i + 1 : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0 || idx[j] === idx[i]) continue;
        const a = luma[idx[i]];
        const b = luma[idx[j]];
        if (a - b > 50) mark[i] = 1;
        else if (b - a > 50) mark[j] = 1;
      }
    }
  for (let i = 0; i < mark.length; i++) if (mark[i]) idx[i] = darkest;
}

/** Drops unused colors and renumbers the rest from dark to light. Rewrites idx, returns the new RGB palette. */
export function finalizePalette(idx, pal, K) {
  const used = new Uint32Array(K);
  for (let i = 0; i < idx.length; i++) used[idx[i]]++;
  const luma = (k) => 0.3 * pal[k * 3] + 0.59 * pal[k * 3 + 1] + 0.11 * pal[k * 3 + 2];
  const order = [...used.keys()].filter((k) => used[k]).sort((a, b) => luma(a) - luma(b));
  const remap = new Uint16Array(K);
  const out = new Uint8Array(order.length * 3);
  order.forEach((k, n) => {
    remap[k] = n;
    for (let j = 0; j < 3; j++) out[n * 3 + j] = pal[k * 3 + j];
  });
  for (let i = 0; i < idx.length; i++) idx[i] = remap[idx[i]];
  return out;
}

/* ---------- full pipeline ---------- */

/** Resized + filtered + adjusted RGBA image (W*H) that the palette and quantizer work on. */
export function prepareImage(source, params, userAdjust) {
  const { width: W, height: H, style } = params;
  const k = SUBCELL_STYLES.includes(style) ? Math.max(1, Math.min(3, Math.floor(Math.sqrt(16e6 / (W * H))))) : 1;
  const w = W * k;
  const h = H * k;
  let rgba = boxScale(source, w, h);
  rgba = bilateral(rgba, w, h, style === "paint" ? Math.max(4, params.denoise || 0) : params.denoise || 0);
  applyAdjustments(rgba, w, h, userAdjust);
  if (STYLE_ADJUST[style]) applyAdjustments(rgba, w, h, STYLE_ADJUST[style]);
  if (k > 1) rgba = pickFromSubcells(rgba, W, H, k, style === "klines" ? "klines" : "dominant");
  return rgba;
}

/**
 * params: { width, height, colors, style, specks, denoise }
 * hooks:  { pause(): Promise<boolean> (false = cancelled), progress(fraction) }
 * Returns { width, height, idx: Uint16Array, pal: Uint8Array RGB } or null if cancelled.
 */
export async function generate(source, params, userAdjust, hooks = noHooks) {
  const { width: W, height: H, style } = params;
  const rgba = prepareImage(source, params, userAdjust);
  let K = params.colors;
  let pal = await kmeansPalette(rgba, W * H, K, hooks);
  if (!pal) return null;
  if (style === "retro") {
    pal = retroPalette(pal);
    K = pal.length / 3;
  }
  const idx = await quantize(rgba, W, H, pal, K, style, hooks);
  if (!idx) return null;
  const smoothLevel = style === "paint" ? Math.max(3, params.denoise) : params.denoise;
  if (smoothLevel && !DIFFUSION[style] && !THRESHOLD[style]) modeFilter(idx, W, H, smoothLevel);
  if (style === "outl") addOutlines(idx, W, H, pal, K);
  removeSpecks(idx, W, H, params.specks, pal);
  return { width: W, height: H, idx, pal: finalizePalette(idx, pal, K) };
}

/**
 * How close the palette must get to the photo for "Auto colors": the mean color difference
 * (Lab ΔE) between a pixel and its palette color. ΔE ≈ 2.3 is the smallest difference people notice,
 * so 1.5 means the colored picture is practically indistinguishable from the photo.
 * Lower = more colors. Measured on real photos, 1.5 gives roughly 80-480 colors depending on detail.
 */
export const AUTO_COLOR_TARGET = 1.3;

/**
 * Smallest color count whose average error is at most AUTO_COLOR_TARGET, +15% headroom.
 * Binary search over quick k-means runs on a sample (error goes down steadily as colors go up).
 */
export async function suggestColorCount(source, params, userAdjust, hooks = noHooks) {
  const N = params.width * params.height;
  const rgba = prepareImage(source, params, userAdjust);
  const sample = samplePixels(rgba, N, Math.min(N, 12000));
  const maxK = Math.max(2, Math.min(1000, Math.floor(N / 12)));
  const fitError = async (k) => {
    const fit = await kmeansFit(sample, k, 4, hooks);
    if (!fit) throw new Error("cancelled");
    return fit.error;
  };
  let lo = 2;
  let hi = maxK;
  let best = maxK; // if even maxK is not enough, use maxK
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    hooks.progress(mid);
    if ((await fitError(mid)) <= AUTO_COLOR_TARGET) {
      best = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return Math.min(maxK, Math.max(Math.min(maxK, 16), Math.round(best * 1.15)));
}
