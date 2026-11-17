// Pixelization engine. Pure functions only: no DOM, no global app state.
// Runs inside the Web Worker (engine.worker.js) and in Node tests.
//
// Three modes:
//   art     stylized pictures (digital art, anime). A cell on the border of two areas takes the color of
//           one side instead of a mix of both; thin lines and small highlights survive.
//   photo   realistic photos. A cell is the average of the photo under it.
//   dither  photos with compression artifacts or banding: in-between shades are built from dots.
//
// Pipeline (generate):
//   source photo pixels
//   -> prepareImage: one color per cell (art: chosen from k*k sub-samples, photo/dither: area average),
//      then smoothFlat flattens weak noise and JPEG blocks inside areas without touching borders
//   -> kmeansPalette: pick K colors (k-means in Lab; rare colors count for more than their share of cells)
//   -> quantize: map every cell to the nearest palette color (dither: with error diffusion)
//   -> settle: a cell that fits its neighbours' color almost as well as its own joins them (no stray dots)
//   -> removeSpecks: tiny islands that barely differ from their surroundings join a neighbour
//   -> cleanPalette: merge colors the eye cannot tell apart and colors used by a couple of cells
//   -> finalizePalette: drop unused colors, number them dark -> light

/* ---------- modes ---------- */

export const MODES = ["art", "photo", "dither"];
export const DEFAULT_MODE = "art";
/** "Cleanliness" slider, 0..10: how hard weak noise, stray dots and tiny islands are removed. */
export const DEFAULT_CLEAN = 3;

export const NO_ADJUST = { bri: 100, con: 100, sat: 100, tmp: 0, shp: 0, blk: 0, wht: 255 };

/** Style ids stored with canvases made before the three modes existed. */
const OLD_STYLES = {
  smooth: "photo",
  paint: "photo",
  hc: "photo",
  dom: "art",
  klines: "art",
  outl: "art",
  retro: "art",
  fs: "dither",
  bay: "dither",
  halo: "dither",
};

/** Fills in mode and cleanliness for settings saved by older versions (style ids, denoise + specks sliders). */
export function normalizeParams(p) {
  const style = MODES.includes(p.style) ? p.style : OLD_STYLES[p.style] || DEFAULT_MODE;
  let clean = p.clean;
  if (clean == null) clean = p.denoise == null ? DEFAULT_CLEAN : Math.round(p.denoise * 1.2 + (p.specks || 0) / 4);
  return { ...p, style, clean: Math.max(0, Math.min(10, clean)) };
}

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

/**
 * Edge-preserving smoothing of the cell image. Neighbours that differ only slightly (noise, JPEG blocks,
 * banding steps) are averaged with full weight; neighbours that differ clearly get none, so borders stay sharp.
 * The weight is flat up to the threshold on purpose: inside a soft gradient this is then a plain blur, which
 * keeps the gradient smooth. (A bell-shaped weight pulls every cell towards its own value and turns gradients
 * into flat blotches.)
 */
export function smoothFlat(rgba, w, h, clean) {
  if (clean <= 0) return rgba;
  const limit = 6 * clean; // |dR|+|dG|+|dB| that still counts as "the same area"
  const weight = new Float32Array(766);
  for (let d = 0; d < 766; d++) weight[d] = Math.max(0, Math.min(1, 2 - d / limit));
  const big = w * h > 2e6;
  const radius = big ? 1 : 2;
  const passes = big ? 1 : 1 + (clean >= 2) + (clean >= 7);
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

/** Sub-samples of one cell closer than this (in color levels) are one flat color. */
const FLAT_RANGE = 12;
/** A thin line or small detail is kept only if it differs from its surroundings by at least this much. */
const LINE_CONTRAST = 40;
/** ...and covers at least this share of the cell. */
const LINE_SHARE = 0.15;

/**
 * Art mode: collapses each k*k block of a supersampled image into one cell color without mixing areas.
 *
 * Every cell's sub-samples are split into two groups (2-means). Three cases:
 *   - the samples are nearly equal, or spread evenly (a soft gradient): the cell is their average;
 *   - two clear groups (the border of two areas): the cell takes the bigger group's color, so the border
 *     stays crisp and no in-between color appears;
 *   - the smaller group is a thin line or a dot (not the rim of an area of that color in a neighbour cell):
 *     the cell on the line's ridge takes the line color, so lines stay one cell wide and unbroken.
 */
export function pickCellColors(rgba, W, H, k) {
  const n = k * k;
  const rowWidth = W * k;
  const out = new Uint8ClampedArray(W * H * 4);
  const minorShare = new Float32Array(W * H); // > 0: the cell has a line/detail candidate
  const pair = new Uint8ClampedArray(W * H * 6); // candidate cells: bigger group RGB, smaller group RGB
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const side = new Uint8Array(n);
  // perceptual-ish squared distance; equals d*d for a gray difference of d levels
  const dist2 = (r, g, b) => (3 * r * r + 4 * g * g + 2 * b * b) / 9;

  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let mr = 0;
      let mg = 0;
      let mb = 0;
      for (let j = 0; j < n; j++) {
        const p = ((y * k + ((j / k) | 0)) * rowWidth + x * k + (j % k)) * 4;
        mr += R[j] = rgba[p];
        mg += G[j] = rgba[p + 1];
        mb += B[j] = rgba[p + 2];
      }
      mr /= n;
      mg /= n;
      mb /= n;
      const q = (y * W + x) * 4;
      out[q] = mr;
      out[q + 1] = mg;
      out[q + 2] = mb;
      out[q + 3] = 255;

      // two samples far apart: the one farthest from the average, and the one farthest from that
      let a = 0;
      let best = -1;
      for (let j = 0; j < n; j++) {
        const d = dist2(R[j] - mr, G[j] - mg, B[j] - mb);
        if (d > best) {
          best = d;
          a = j;
        }
      }
      let b = 0;
      best = -1;
      for (let j = 0; j < n; j++) {
        const d = dist2(R[j] - R[a], G[j] - G[a], B[j] - B[a]);
        if (d > best) {
          best = d;
          b = j;
        }
      }
      if (best < FLAT_RANGE * FLAT_RANGE) continue; // flat cell: keep the average

      // 2-means from those two samples
      const c = [R[a], G[a], B[a], R[b], G[b], B[b]];
      let countB = 0;
      for (let round = 0; round < 3; round++) {
        const sum = [0, 0, 0, 0, 0, 0];
        countB = 0;
        for (let j = 0; j < n; j++) {
          const toA = dist2(R[j] - c[0], G[j] - c[1], B[j] - c[2]);
          const toB = dist2(R[j] - c[3], G[j] - c[4], B[j] - c[5]);
          const s = (side[j] = toB < toA ? 1 : 0);
          countB += s;
          sum[s * 3] += R[j];
          sum[s * 3 + 1] += G[j];
          sum[s * 3 + 2] += B[j];
        }
        if (!countB || countB === n) break;
        for (let j = 0; j < 3; j++) {
          c[j] = sum[j] / (n - countB);
          c[3 + j] = sum[3 + j] / countB;
        }
      }
      if (!countB || countB === n) continue;
      // how tight the groups are compared with the gap between them:
      // an even spread (gradient) gives ~0.25, two clean colors with a few blended samples ~0.1
      let spread = 0;
      for (let j = 0; j < n; j++) {
        const o = side[j] * 3;
        spread += Math.sqrt(dist2(R[j] - c[o], G[j] - c[o + 1], B[j] - c[o + 2]));
      }
      const gap = Math.sqrt(dist2(c[0] - c[3], c[1] - c[4], c[2] - c[5]));
      const edge = Math.max(0, Math.min(1, (0.26 - spread / n / gap) / 0.12));
      if (!edge) continue;
      // bigger group wins; on a tie the darker one (keeps outlines whole)
      const lumaA = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
      const lumaB = 0.3 * c[3] + 0.59 * c[4] + 0.11 * c[5];
      const major = countB * 2 > n || (countB * 2 === n && lumaB < lumaA) ? 3 : 0;
      const minor = 3 - major;
      out[q] = mr + (c[major] - mr) * edge;
      out[q + 1] = mg + (c[major + 1] - mg) * edge;
      out[q + 2] = mb + (c[major + 2] - mb) * edge;
      const share = (major ? n - countB : countB) / n;
      if (edge > 0.2 && gap >= LINE_CONTRAST && share >= LINE_SHARE) {
        const i = y * W + x;
        minorShare[i] = share;
        for (let j = 0; j < 3; j++) {
          pair[i * 6 + j] = c[major + j];
          pair[i * 6 + 3 + j] = c[minor + j];
        }
      }
    }

  // thin lines and dots: the smaller group wins on the ridge of a line
  const changes = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const f = minorShare[i];
      if (!f) continue;
      const o = i * 6;
      /** Share of the neighbour cell's samples that belong to this cell's smaller group. */
      const shareIn = (cx, cy) => {
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) return 0;
        let count = 0;
        for (let j = 0; j < n; j++) {
          const p = ((cy * k + ((j / k) | 0)) * rowWidth + cx * k + (j % k)) * 4;
          const toMajor = dist2(rgba[p] - pair[o], rgba[p + 1] - pair[o + 1], rgba[p + 2] - pair[o + 2]);
          const toMinor = dist2(rgba[p] - pair[o + 3], rgba[p + 1] - pair[o + 4], rgba[p + 2] - pair[o + 5]);
          if (toMinor < toMajor) count++;
        }
        return count / n;
      };
      const left = shareIn(x - 1, y);
      const right = shareIn(x + 1, y);
      const up = shareIn(x, y - 1);
      const down = shareIn(x, y + 1);
      // The line runs along the axis where it continues on both sides; a and b are the cells across it.
      // If one of those holds mostly this color, the cell is the rim of an area (or of a thicker line that
      // the neighbour already shows) and keeps the bigger group's color.
      const alongRow = Math.min(left, right) > Math.min(up, down);
      const a = alongRow ? up : left;
      const b = alongRow ? down : right;
      if (a >= 0.5 || b >= 0.5) continue;
      const ridge = f > a && f >= b; // of two cells sharing a line, exactly one takes it
      if (ridge) changes.push(i);
    }
  for (const i of changes) for (let j = 0; j < 3; j++) out[i * 4 + j] = pair[i * 6 + 3 + j];
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
 * How strongly rare colors are favoured when the palette is picked (0 = every cell counts the same).
 * A group of n similar cells counts as n^(1 - RARE_BOOST): a huge flat background no longer takes most of
 * the palette as near-identical shades, and small details (eyes, lips, highlights) get colors of their own.
 */
const RARE_BOOST = 0.15;

/** Evenly spaced sample of the cell image for the palette search, with rarity weights. */
export function paletteSample(rgba, pixelCount, count) {
  const sample = samplePixels(rgba, pixelCount, count);
  const { rgb } = sample;
  const bins = new Uint32Array(32768); // 5 bits per channel
  const keys = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    keys[i] = ((rgb[i * 3] >> 3) << 10) | ((rgb[i * 3 + 1] >> 3) << 5) | (rgb[i * 3 + 2] >> 3);
    bins[keys[i]]++;
  }
  sample.weight = new Float32Array(count);
  for (let i = 0; i < count; i++) sample.weight[i] = Math.pow(bins[keys[i]], -RARE_BOOST);
  return sample;
}

/**
 * k-means on Lab points with k-means++ seeding (next center chosen with probability ~ weight * distance²).
 * sample.weight is optional (all 1 without it).
 * Returns { palette: RGB Float32Array (averaged in RGB so colors don't drift), error: mean Lab distance }.
 */
export async function kmeansFit(sample, K, iterations, hooks = noHooks) {
  const { lab: pts, rgb, count: S } = sample;
  const weight = sample.weight || new Float32Array(S).fill(1);
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
      total += nearestDist[i] * weight[i];
    }
    let r = random() * total;
    for (s = 0; s < S - 1 && (r -= nearestDist[s] * weight[s]) > 0; s++);
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
  const mass = new Float64Array(K);
  for (let it = 0; it < iterations; it++) {
    sums.fill(0);
    mass.fill(0);
    for (let i = 0; i < S; i++) {
      const [k] = nearestCenter(i);
      const w = weight[i];
      mass[k] += w;
      sums[k * 3] += pts[i * 3] * w;
      sums[k * 3 + 1] += pts[i * 3 + 1] * w;
      sums[k * 3 + 2] += pts[i * 3 + 2] * w;
    }
    for (let k = 0; k < K; k++) if (mass[k]) for (let j = 0; j < 3; j++) centers[k * 3 + j] = sums[k * 3 + j] / mass[k];
    if (!(await hooks.pause())) return null;
  }

  // final assignment: average the RGB values of each cluster
  sums.fill(0);
  mass.fill(0);
  let error = 0;
  for (let i = 0; i < S; i++) {
    const [k, d] = nearestCenter(i);
    const w = weight[i];
    error += Math.sqrt(d);
    mass[k] += w;
    sums[k * 3] += rgb[i * 3] * w;
    sums[k * 3 + 1] += rgb[i * 3 + 1] * w;
    sums[k * 3 + 2] += rgb[i * 3 + 2] * w;
  }
  const palette = new Float32Array(K * 3);
  for (let k = 0; k < K; k++)
    for (let j = 0; j < 3; j++)
      palette[k * 3 + j] = Math.round(mass[k] ? sums[k * 3 + j] / mass[k] : rgb[seedIndex[k] * 3 + j]);
  return { palette, error: error / S };
}

export async function kmeansPalette(rgba, pixelCount, K, hooks) {
  const sample = paletteSample(rgba, pixelCount, Math.min(pixelCount, K > 300 ? 16000 : 30000));
  const fit = await kmeansFit(sample, K, 8, hooks);
  return fit && fit.palette;
}

/* ---------- quantization ---------- */

/**
 * Exact "nearest palette color" lookup that does not scan the whole palette for every cell:
 * RGB space is cut into 8x8x8 buckets, and for each bucket in use the colors that can win somewhere
 * inside it are listed once. A cell then compares only those few.
 * Distances are measured in Lab (what the eye sees), or in plain RGB with inRgb = true. Dithering needs RGB:
 * it spreads the rounding error in RGB, and the error only cancels out if "nearest" means the same thing there.
 */
function makeNearest(pal, K, inRgb = false) {
  const convert = inRgb
    ? (r, g, b, out) => {
        out[0] = r;
        out[1] = g;
        out[2] = b;
      }
    : (r, g, b, out) => srgbToLab(r, g, b, out, 0);
  const points = new Float32Array(K * 3);
  const point = new Float32Array(3);
  for (let k = 0; k < K; k++) {
    convert(pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2], point);
    points.set(point, k * 3);
  }
  const buckets = new Array(32768);
  const corner = new Float32Array(3);
  const dist = new Float32Array(K);
  const build = (key) => {
    const r0 = (key >> 10) << 3;
    const g0 = ((key >> 5) & 31) << 3;
    const b0 = (key & 31) << 3;
    convert(r0 + 4, g0 + 4, b0 + 4, point);
    let radius = 0;
    for (let c = 0; c < 8; c++) {
      convert(r0 + (c & 1 ? 7 : 0), g0 + (c & 2 ? 7 : 0), b0 + (c & 4 ? 7 : 0), corner);
      radius = Math.max(radius, Math.hypot(corner[0] - point[0], corner[1] - point[1], corner[2] - point[2]));
    }
    let best = 1e12;
    for (let k = 0; k < K; k++) {
      dist[k] = Math.hypot(point[0] - points[k * 3], point[1] - points[k * 3 + 1], point[2] - points[k * 3 + 2]);
      if (dist[k] < best) best = dist[k];
    }
    // a color further than this from the bucket center cannot be the nearest for any point of the bucket
    const list = [];
    for (let k = 0; k < K; k++) if (dist[k] <= best + 2 * radius + 1e-3) list.push(k);
    return (buckets[key] = Uint16Array.from(list));
  };
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const list = buckets[key] || build(key);
    if (list.length === 1) return list[0];
    convert(r, g, b, point);
    let best = 0;
    let bestD = 1e12;
    for (let m = 0; m < list.length; m++) {
      const k = list[m];
      const x = point[0] - points[k * 3];
      const y = point[1] - points[k * 3 + 1];
      const z = point[2] - points[k * 3 + 2];
      const d = x * x + y * y + z * z;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };
}

/** Share of the rounding error that dithering passes on (below 1 = calmer texture, no runaway speckles). */
const DITHER_STRENGTH = 0.9;
/** Dithering does not carry error across a border this strong (|dR|+|dG|+|dB|): edges stay clean. */
const DITHER_EDGE = 90;

/**
 * Maps every cell to the nearest palette color (in Lab). With dither = true the rounding error is spread to
 * the cells not visited yet (Floyd-Steinberg, rows scanned alternately left-to-right and right-to-left so
 * the dots form no diagonal "worms").
 * Returns Uint16Array of palette indices, or null if cancelled.
 */
export async function quantize(rgba, W, H, pal, K, dither = false, hooks = noHooks) {
  const idx = new Uint16Array(W * H);
  const nearest = makeNearest(pal, K, dither);
  let errRow = new Float32Array(W * 3); // error arriving at the current row
  let errNext = new Float32Array(W * 3);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  // a cell is never pushed further from its real color than about one palette step: no stray far-off dots
  const reach = Math.max(6, Math.min(64, 0.75 * (255 / Math.cbrt(K))));
  const limit = (e) => (e < -reach ? -reach : e > reach ? reach : e);

  for (let y = 0; y < H; y++) {
    const reverse = dither && y & 1;
    const step = reverse ? -1 : 1;
    for (let n = 0, x = reverse ? W - 1 : 0; n < W; n++, x += step) {
      const i = y * W + x;
      const p = i * 4;
      if (!dither) {
        idx[i] = nearest(rgba[p], rgba[p + 1], rgba[p + 2]);
        continue;
      }
      const r = clamp(rgba[p] + limit(errRow[x * 3]));
      const g = clamp(rgba[p + 1] + limit(errRow[x * 3 + 1]));
      const b = clamp(rgba[p + 2] + limit(errRow[x * 3 + 2]));
      const j = (idx[i] = nearest(Math.round(r), Math.round(g), Math.round(b)));
      const er = (r - pal[j * 3]) * DITHER_STRENGTH;
      const eg = (g - pal[j * 3 + 1]) * DITHER_STRENGTH;
      const eb = (b - pal[j * 3 + 2]) * DITHER_STRENGTH;
      const give = (xx, row, target, w) => {
        if (xx < 0 || xx >= W || row >= H) return;
        const q = (row * W + xx) * 4;
        if (
          Math.abs(rgba[q] - rgba[p]) + Math.abs(rgba[q + 1] - rgba[p + 1]) + Math.abs(rgba[q + 2] - rgba[p + 2]) >
          DITHER_EDGE
        )
          return;
        target[xx * 3] += er * w;
        target[xx * 3 + 1] += eg * w;
        target[xx * 3 + 2] += eb * w;
      };
      give(x + step, y, errRow, 7 / 16);
      give(x - step, y + 1, errNext, 3 / 16);
      give(x, y + 1, errNext, 5 / 16);
      give(x + step, y + 1, errNext, 1 / 16);
    }
    if (dither) {
      [errRow, errNext] = [errNext, errRow];
      errNext.fill(0);
    }
    if (y % 64 === 63) {
      hooks.progress(y / H);
      if (!(await hooks.pause())) return null;
    }
  }
  return idx;
}

/* ---------- clean-up passes on the index map ---------- */

/**
 * Neighbour-aware assignment. Nearest-color quantization decides every cell alone, so where two palette
 * colors fit almost equally (a soft gradient, slight noise) the choice flips from cell to cell: random dots
 * and ragged band borders. Here a cell may switch to a color its neighbours have if that costs little:
 *   cost(color) = (Lab distance to the cell's real color)² + strength * (neighbours that have another color)
 * A dot that really differs from its surroundings (a highlight, a thin line) is far from their color, so it stays.
 */
export function settle(idx, rgba, W, H, pal, K, clean) {
  const strength = 0.18 * clean * clean;
  if (!strength) return;
  const palLab = paletteToLab(pal, K);
  const lab = new Float32Array(3);
  const labels = new Int32Array(8);
  const weights = new Float32Array(8);
  const passes = W * H > 4e6 ? 1 : clean >= 5 ? 3 : 2;
  for (let pass = 0; pass < passes; pass++) {
    let changed = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const own = idx[i];
        let m = 0;
        let different = false;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((!dx && !dy) || xx < 0 || xx >= W) continue;
            const label = idx[yy * W + xx];
            labels[m] = label;
            weights[m++] = dx && dy ? 0.7 : 1;
            if (label !== own) different = true;
          }
        }
        if (!different) continue;
        srgbToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], lab, 0);
        const cost = (c) => {
          const a = lab[0] - palLab[c * 3];
          const b = lab[1] - palLab[c * 3 + 1];
          const e = lab[2] - palLab[c * 3 + 2];
          let disagree = 0;
          for (let n = 0; n < m; n++) if (labels[n] !== c) disagree += weights[n];
          return a * a + b * b + e * e + strength * disagree;
        };
        let best = own;
        let bestCost = cost(own);
        for (let n = 0; n < m; n++) {
          const c = labels[n];
          if (c === best || c === own) continue;
          const v = cost(c);
          if (v < bestCost - 1e-6) {
            bestCost = v;
            best = c;
          }
        }
        if (best !== own) {
          idx[i] = best;
          changed++;
        }
      }
    if (!changed) break;
  }
}

/**
 * Removes connected same-color regions smaller than minSize cells: each one takes the neighbouring color
 * closest to its own (in Lab), but only if that color is within maxDelta, so a small island that clearly
 * stands out (an eye highlight) is left alone.
 */
export function removeSpecks(idx, W, H, minSize, pal, maxDelta = Infinity) {
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
  const limit = maxDelta * maxDelta;
  for (let i = 0; i < N; i++) {
    const L = region[i];
    if (regionSize[L] < minSize && bestColor[L] >= 0 && bestDist[L] <= limit) idx[i] = bestColor[L];
  }
}

/** Two palette colors closer than this (Lab distance; ~2.3 is the smallest difference people notice) become one. */
export const SAME_COLOR = 1.2;
/** A color used by only a few cells joins its nearest color if that one is within this distance. */
const TINY_COLOR_REACH = 10;

/**
 * Palette clean-up for playing: nobody wants two numbers that look the same, or a number with 2 cells.
 *   1. colors closer than SAME_COLOR are merged (closest pairs first; the merged color is their weighted mean);
 *   2. colors used by at most tinyCells cells join the nearest other color, unless they really stand out.
 * Rewrites idx and pal in place; colors that end up unused are dropped later by finalizePalette.
 */
export function cleanPalette(idx, pal, K, tinyCells = 0) {
  const counts = new Float64Array(K);
  for (let i = 0; i < idx.length; i++) counts[idx[i]]++;
  const into = Int32Array.from({ length: K }, (_, k) => k);
  let lab = paletteToLab(pal, K);
  const labDist = (a, b) =>
    Math.hypot(lab[a * 3] - lab[b * 3], lab[a * 3 + 1] - lab[b * 3 + 1], lab[a * 3 + 2] - lab[b * 3 + 2]);

  for (let round = 0; round < 3; round++) {
    const pairs = [];
    for (let a = 0; a < K; a++) {
      if (!counts[a]) continue;
      for (let b = a + 1; b < K; b++) {
        if (!counts[b]) continue;
        const d = labDist(a, b);
        if (d < SAME_COLOR) pairs.push([d, a, b]);
      }
    }
    if (!pairs.length) break;
    pairs.sort((p, q) => p[0] - q[0]);
    const used = new Uint8Array(K); // every color takes part in one merge per round, so chains cannot drift
    for (const [, a, b] of pairs) {
      if (used[a] || used[b]) continue;
      used[a] = used[b] = 1;
      const keep = counts[a] >= counts[b] ? a : b;
      const drop = keep === a ? b : a;
      const total = counts[keep] + counts[drop];
      for (let j = 0; j < 3; j++)
        pal[keep * 3 + j] = Math.round((pal[keep * 3 + j] * counts[keep] + pal[drop * 3 + j] * counts[drop]) / total);
      counts[keep] = total;
      counts[drop] = 0;
      into[drop] = keep;
    }
    lab = paletteToLab(pal, K);
  }

  if (tinyCells > 0)
    for (let a = 0; a < K; a++) {
      if (!counts[a] || counts[a] > tinyCells) continue;
      let best = -1;
      let bestD = TINY_COLOR_REACH;
      for (let b = 0; b < K; b++) {
        if (b === a || counts[b] <= tinyCells) continue;
        const d = labDist(a, b);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      if (best < 0) continue;
      counts[best] += counts[a];
      counts[a] = 0;
      into[a] = best;
    }

  for (let k = 0; k < K; k++) {
    let root = k;
    while (into[root] !== root) root = into[root];
    into[k] = root;
  }
  for (let i = 0; i < idx.length; i++) idx[i] = into[idx[i]];
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

/** Sub-samples per cell side in art mode: as many as memory allows (up to 4), never more than the photo has. */
function subsamplesFor(source, W, H) {
  const byMemory = Math.floor(Math.sqrt(8e6 / (W * H)));
  const byPhoto = Math.min(Math.ceil(source.width / W), Math.ceil(source.height / H));
  return Math.max(1, Math.min(4, byMemory, byPhoto));
}

/** One color per cell (W*H RGBA): resized, adjusted, mode-specific cell colors, weak noise flattened. */
export function prepareImage(source, params, userAdjust) {
  const { width: W, height: H, style, clean } = normalizeParams(params);
  const k = style === "art" ? subsamplesFor(source, W, H) : 1;
  let rgba = boxScale(source, W * k, H * k);
  applyAdjustments(rgba, W * k, H * k, userAdjust);
  if (k > 1) rgba = pickCellColors(rgba, W, H, k);
  return smoothFlat(rgba, W, H, clean);
}

/**
 * params: { width, height, colors, style: "art" | "photo" | "dither", clean: 0..10 }
 * hooks:  { pause(): Promise<boolean> (false = cancelled), progress(fraction) }
 * Returns { width, height, idx: Uint16Array, pal: Uint8Array RGB } or null if cancelled.
 * The palette can come out a little smaller than params.colors (look-alike colors are merged).
 */
export async function generate(source, params, userAdjust, hooks = noHooks) {
  const p = normalizeParams(params);
  const { width: W, height: H, clean } = p;
  const dither = p.style === "dither";
  const rgba = prepareImage(source, p, userAdjust);
  const K = Math.max(1, Math.min(p.colors, W * H));
  const pal = await kmeansPalette(rgba, W * H, K, hooks);
  if (!pal) return null;
  const idx = await quantize(rgba, W, H, pal, K, dither, hooks);
  if (!idx) return null;
  if (!dither && clean > 0) {
    settle(idx, rgba, W, H, pal, K, clean);
    removeSpecks(idx, W, H, 2 + (clean >> 1), pal, 3 + clean * 1.5);
  }
  cleanPalette(idx, pal, K, clean > 0 ? Math.max(2, Math.min(6, Math.round((W * H) / 50000))) : 0);
  return { width: W, height: H, idx, pal: finalizePalette(idx, pal, K) };
}

/**
 * How close the palette must get to the picture for "Auto colors": the mean color difference
 * (Lab ΔE) between a cell and its palette color. ΔE ≈ 2.3 is the smallest difference people notice.
 * Lower = more colors.
 */
export const AUTO_COLOR_TARGET = 1.22;

/**
 * Smallest color count whose average error is at most AUTO_COLOR_TARGET, +15% headroom.
 * Binary search over quick k-means runs on a sample (error goes down steadily as colors go up).
 */
export async function suggestColorCount(source, params, userAdjust, hooks = noHooks) {
  const N = params.width * params.height;
  const rgba = prepareImage(source, params, userAdjust);
  const sample = paletteSample(rgba, N, Math.min(N, 12000));
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
