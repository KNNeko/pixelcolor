// Pixelization engine. Pure functions only: no DOM, no global app state.
// Runs inside the Web Worker (engine.worker.js) and in Node tests.
//
// Three modes:
//   art     stylized pictures (digital art, anime). Thin lines (line art, strands) become unbroken one-cell
//           lines in their own color; a cell on the border of two areas takes the color of one side instead of
//           a mix of both; soft gradients are smoothed so their bands run as clean curves.
//   photo   realistic photos. A cell is the average of the photo under it.
//   dither  photos with compression artifacts or banding: in-between shades are built from dots.
//
// Pipeline (generate):
//   source photo pixels
//   -> prepareImage: one color per cell (art: chosen from k*k sub-samples with thin lines drawn separately,
//      then gradients smoothed; photo/dither: area average), then smoothFlat flattens weak noise and JPEG
//      blocks inside areas without touching borders
//   -> kmeansPalette: pick K colors (k-means in Lab with lightness weighted double; rare colors count for more
//      than their share of cells)
//   -> quantize: map every cell to the nearest palette color (dither: with error diffusion)
//   -> settle: a cell that fits its neighbours' color almost as well as its own joins them (no stray dots;
//      strongly inside gradients, gently elsewhere; thin-line cells are left alone by this and what follows)
//   -> removeSpecks: tiny islands that barely differ from their surroundings join a neighbour
//   -> ditherRamps: borders between the bands of a gradient get a soft one-cell checker edge
//   -> cleanPalette: merge colors the eye cannot tell apart and colors used by a couple of cells
//   -> finalizePalette: drop unused colors, number them dark -> light

/* ---------- modes ---------- */

export const MODES = ["art", "photo", "dither"];
export const DEFAULT_MODE = "art";
/** "Cleanliness" slider, 0..10: how hard weak noise, stray dots and tiny islands are removed. */
export const DEFAULT_CLEAN = 3;

export const NO_ADJUST = { bri: 100, con: 100, sat: 100, tmp: 0, shp: 0, blk: 0, wht: 255, enh: 0 };

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
 * "Enhance": cleans up a picture before it is pixelized. level 1..10, in place.
 * Compression artifacts (the speckle around edges and the faint 8x8 blocks of JPEG) are small differences
 * between neighbouring pixels, real edges are big ones. Every pixel is averaged with those neighbours that
 * differ from it only a little; across an edge nothing is mixed, so the picture gets cleaner without getting
 * softer. applyAdjustments then sharpens the cleaned picture a little.
 */
function cleanArtifacts(rgba, w, h, level) {
  const limit = 8 + 4 * level; // |dR|+|dG|+|dB| that still counts as "the same surface"
  const weight = new Float32Array(766);
  for (let d = 0; d < 766; d++) weight[d] = Math.max(0, Math.min(1, 2 - d / limit));
  const out = new Uint8ClampedArray(rgba.length);
  for (let pass = level >= 6 ? 2 : 1; pass > 0; pass--) {
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < h - 1 ? y + 1 : y;
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const r = rgba[p];
        const g = rgba[p + 1];
        const b = rgba[p + 2];
        const x0 = x > 0 ? x - 1 : 0;
        const x1 = x < w - 1 ? x + 1 : x;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sw = 0;
        for (let yy = y0; yy <= y1; yy++)
          for (let xx = x0; xx <= x1; xx++) {
            const q = (yy * w + xx) * 4;
            const k = weight[Math.abs(rgba[q] - r) + Math.abs(rgba[q + 1] - g) + Math.abs(rgba[q + 2] - b)];
            sr += rgba[q] * k;
            sg += rgba[q + 1] * k;
            sb += rgba[q + 2] * k;
            sw += k;
          }
        out[p] = sr / sw;
        out[p + 1] = sg / sw;
        out[p + 2] = sb / sw;
        out[p + 3] = 255;
      }
    }
    rgba.set(out);
  }
}

/**
 * Enhance / brightness / contrast / saturation / temperature / sharpen / black & white point, in place.
 * a = { enh (0..10), bri, con, sat (percent), tmp (-50..50), shp (0..150), blk (0..40), wht (200..255) }
 */
export function applyAdjustments(rgba, w, h, a) {
  const enhance = a.enh || 0; // settings saved before "enhance" existed have no such field
  if (a.bri === 100 && a.con === 100 && a.sat === 100 && !a.tmp && !a.shp && !a.blk && a.wht === 255 && !enhance)
    return rgba;
  if (enhance) cleanArtifacts(rgba, w, h, enhance);
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
  if (a.shp || enhance) {
    // unsharp-style 4-neighbour sharpen
    const s = a.shp / 100 + enhance * 0.07;
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
export function smoothFlat(rgba, w, h, clean, lines = null) {
  if (clean <= 0) return rgba;
  const limit = 6 * clean; // |dR|+|dG|+|dB| that still counts as "the same area"
  const weight = new Float32Array(766);
  for (let d = 0; d < 766; d++) weight[d] = Math.max(0, Math.min(1, 2 - d / limit));
  // low settings only touch the nearest neighbours once: fine texture and faint lines keep their contrast
  const big = w * h > 2e6;
  const radius = big || clean < 4 ? 1 : 2;
  const passes = big ? 1 : 1 + (clean >= 6) + (clean >= 9);
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
        if (lines && lines[y * w + x]) {
          // thin-line cells keep their color
          out[p] = r;
          out[p + 1] = g;
          out[p + 2] = b;
          out[p + 3] = 255;
          continue;
        }
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
 * Art mode: inside soft gradients and flat areas (the 5x5 block around a cell holds only close colors) each
 * cell becomes the average of its block. Then noise (JPEG, grain) no longer decides on which side of a band
 * border a cell falls, and the borders between the bands of a gradient run as smooth curves instead of ragged
 * blotches. Blocks with any real detail or border in them are left as they are. Thin-line cells are skipped.
 * range: largest |dR|+|dG|+|dB| between any two cells of a block that still counts as smooth.
 */
export function smoothGradients(rgba, W, H, range, lines = null) {
  if (range <= 0) return rgba;
  const out = new Uint8ClampedArray(rgba);
  const smooth = new Uint8Array(W * H); // 1 = inside a soft gradient or flat area (for settle)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (lines && lines[i]) continue;
      let r0 = 255;
      let r1 = 0;
      let g0 = 255;
      let g1 = 0;
      let b0 = 255;
      let b1 = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let m = 0;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++)
        for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) {
          const j = yy * W + xx;
          if (lines && lines[j]) continue;
          const r = rgba[j * 4];
          const g = rgba[j * 4 + 1];
          const b = rgba[j * 4 + 2];
          if (r < r0) r0 = r;
          if (r > r1) r1 = r;
          if (g < g0) g0 = g;
          if (g > g1) g1 = g;
          if (b < b0) b0 = b;
          if (b > b1) b1 = b;
          sr += r;
          sg += g;
          sb += b;
          m++;
        }
      if (r1 - r0 + g1 - g0 + b1 - b0 > range) continue;
      smooth[i] = 1;
      out[i * 4] = sr / m;
      out[i * 4 + 1] = sg / m;
      out[i * 4 + 2] = sb / m;
    }
  out.smooth = smooth;
  return out;
}

/** Sub-samples of one cell closer than this (in color levels) are one flat color. */
const FLAT_RANGE = 12;
/** A neighbour cell whose samples differ by less than this counts as nearly flat (border detection). */
const FLAT_NEIGHBOUR = 26;
/** ...and two such neighbours on opposite sides that differ by at least this have a border between them. */
const STEP = 40;
/**
 * A neighbour cell counts as "mixed" when between this share and (1 - this share) of its samples belong to
 * the smaller group. A two-color cell whose four neighbours are all mixed is fine texture, not an edge.
 */
const TEXTURE_MIX = 0.12;

/* ---------- thin lines (art mode) ----------
   Line art and strands thinner than about 1.75 cells are found on the sub-samples and drawn as unbroken
   one-cell lines in their own color. Cells next to a line take their color from the samples that are not
   line, so no half-line, half-background colors appear along contours. */

/**
 * Luma difference (0..255) from its surroundings that makes a sub-sample part of a thin dark or light line:
 * LINE_MIN_CONTRAST on a light background, less on a dark one (the eye sees small steps in the dark; a strand
 * on black hair is only a few levels apart). The anti-aliased rim along a plain border stays below it.
 */
const LINE_MIN_CONTRAST = 32;
const lineThreshold = new Uint8Array(256);
for (let v = 0; v < 256; v++) lineThreshold[v] = Math.round(18 + ((LINE_MIN_CONTRAST - 18) * v) / 255);
/** Share of a cell covered by a line from which it is drawn as line whatever the thinning says. */
const LINE_CORE = 0.5;
/** A one-cell dot with no line next to it is kept only if it stands out at least this much (luma, rms). */
const LONE_DOT_CONTRAST = 60;
/** A line's color comes from its samples that stand out at least this share of its strongest one. */
const LINE_INK = 0.7;
/** Lines of at most this many cells (dots, short dashes: a pupil, a highlight) never give way to another line. */
const SHORT_LINE = 3;

/**
 * Running maximum (or minimum) over a window of 2r+1 samples along the rows of a w x h byte image, in O(1) per
 * sample (van Herk / Gil-Werman: running extremes inside blocks of 2r+1, read from both ends).
 * For the minimum, call it on the inverted image (255 - v): the loops stay simple and fast.
 * g and hb are scratch rows of length >= w.
 */
function maxRows(src, dst, w, h, r, g, hb) {
  const s = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    g[0] = src[base];
    for (let x = 1, c = 1; x < w; x++, c++) {
      if (c === s) c = 0;
      const v = src[base + x];
      if (c === 0) g[x] = v;
      else {
        const p = g[x - 1];
        g[x] = v > p ? v : p;
      }
    }
    hb[w - 1] = src[base + w - 1];
    // block ends where (x + 1) is a multiple of s
    for (let x = w - 2, c = (w - 1) % s; x >= 0; x--, c--) {
      if (c === 0) c = s;
      const v = src[base + x];
      if (c === s) hb[x] = v;
      else {
        const p = hb[x + 1];
        hb[x] = v > p ? v : p;
      }
    }
    for (let x = 0; x < w; x++) {
      const right = g[x + r < w ? x + r : w - 1];
      if (x < r) dst[base + x] = right;
      else {
        const left = hb[x - r];
        dst[base + x] = left > right ? left : right;
      }
    }
  }
}

/** The same along the columns, worked row by row (memory in order); G and HB are scratch images of w x h. */
function maxCols(src, dst, w, h, r, G, HB) {
  const s = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    if (y % s === 0) for (let x = 0; x < w; x++) G[row + x] = src[row + x];
    else
      for (let x = 0; x < w; x++) {
        const v = src[row + x];
        const p = G[row - w + x];
        G[row + x] = v > p ? v : p;
      }
  }
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    if (y === h - 1 || (y + 1) % s === 0) for (let x = 0; x < w; x++) HB[row + x] = src[row + x];
    else
      for (let x = 0; x < w; x++) {
        const v = src[row + x];
        const p = HB[row + w + x];
        HB[row + x] = v > p ? v : p;
      }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const right = (y + r < h ? y + r : h - 1) * w;
    if (y < r) for (let x = 0; x < w; x++) dst[row + x] = G[right + x];
    else {
      const left = (y - r) * w;
      for (let x = 0; x < w; x++) {
        const a = HB[left + x];
        const b = G[right + x];
        dst[row + x] = a > b ? a : b;
      }
    }
  }
}

/** Square running max over (2r+1)^2: rows then columns. */
function dilate(src, dst, tmp, w, h, r, g, hb, G, HB) {
  maxRows(src, tmp, w, h, r, g, hb);
  maxCols(tmp, dst, w, h, r, G, HB);
}

/**
 * Sub-samples on thin lines: darker (type 1) or lighter (type 2) than their surroundings by LINE_MIN_CONTRAST,
 * in a feature narrower than 2r+1 samples (morphological closing / opening of the luma). The rim of a wide
 * area is not a line: closing and opening leave plain borders where they are.
 */
function findThinLines(rgba, w, h, r) {
  const N = w * h;
  // luma, padded by r on every side with copies of the edge: at the picture's border a ramp would otherwise
  // look like a valley (the window would see only one side of it)
  const pw = w + 2 * r;
  const ph = h + 2 * r;
  const Y = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - r));
    for (let x = 0; x < pw; x++) {
      const p = (sy * w + Math.min(w - 1, Math.max(0, x - r))) * 4;
      Y[y * pw + x] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
    }
  }
  const P = pw * ph;
  const a = new Uint8Array(P);
  const b = new Uint8Array(P);
  const tmp = new Uint8Array(P);
  const G = new Uint8Array(P);
  const HB = new Uint8Array(P);
  const g = new Uint8Array(pw);
  const hb = new Uint8Array(pw);
  const type = new Uint8Array(N);
  const strength = new Uint8Array(N);
  // min(v) = 255 - max(255 - v): erosion is a dilation of the inverted image
  const invert = (src, dst) => {
    for (let i = 0; i < P; i++) dst[i] = 255 - src[i];
  };
  const morph = (closing, src) => {
    if (closing) {
      dilate(src, a, tmp, pw, ph, r, g, hb, G, HB); // a = max
      invert(a, a);
      dilate(a, b, tmp, pw, ph, r, g, hb, G, HB); // b = 255 - min(max)
      invert(b, b);
    } else {
      invert(src, a);
      dilate(a, b, tmp, pw, ph, r, g, hb, G, HB); // b = 255 - min
      invert(b, b);
      dilate(b, a, tmp, pw, ph, r, g, hb, G, HB); // a = max(min)
      b.set(a);
    }
  };
  morph(true, Y); // closing: dark features narrower than the window are filled in
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const q = (y + r) * pw + x + r;
      const d = b[q] - Y[q];
      if (d >= lineThreshold[b[q]]) {
        type[y * w + x] = 1;
        strength[y * w + x] = d;
      }
    }
  const closed = new Uint8Array(b);
  // Opening: light features narrower than the window are removed. Plain, on the picture itself, it shows every
  // light stripe; fine hatching then shows as both kinds everywhere (`raw`, for the texture test).
  const raw = new Uint8Array(type);
  const rawStrength = new Uint8Array(N);
  morph(false, Y);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const q = (y + r) * pw + x + r;
      const i = y * w + x;
      const d = Y[q] - b[q];
      if (d >= lineThreshold[b[q]] && d > strength[i]) {
        raw[i] = 2;
        rawStrength[i] = d;
      }
    }
  // As a line, though, a long light stripe only counts where it is lighter than the area around it (a light
  // strand): the gaps between dark lines (between eyelashes, hair strands, fingers) are no features of their
  // own. A small light spot (a highlight in an eye, even inside a small dark iris) always counts.
  const dot = 2 * r + 1;
  const seen = new Uint8Array(N);
  const spot = [];
  for (let start = 0; start < N; start++) {
    if (raw[start] !== 2 || seen[start]) continue;
    spot.length = 0;
    spot.push(start);
    seen[start] = 1;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let k = 0; k < spot.length; k++) {
      const p = spot[k];
      const px = p % w;
      const py = (p - px) / w;
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
      for (let yy = Math.max(0, py - 1); yy <= Math.min(h - 1, py + 1); yy++)
        for (let xx = Math.max(0, px - 1); xx <= Math.min(w - 1, px + 1); xx++) {
          const j = yy * w + xx;
          if (raw[j] === 2 && !seen[j]) {
            seen[j] = 1;
            spot.push(j);
          }
        }
    }
    if (x1 - x0 < dot && y1 - y0 < dot)
      for (const p of spot) {
        type[p] = 2;
        strength[p] = rawStrength[p];
      }
  }
  morph(false, closed);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const q = (y + r) * pw + x + r;
      const i = y * w + x;
      const d = Y[q] - b[q];
      if (d >= lineThreshold[b[q]] && d > strength[i]) {
        type[i] = 2;
        strength[i] = d;
      }
    }
  // JPEG rings: a light line gets a faint dark shadow line beside it (and a dark one a light one). Of a dark
  // and a light line sample lying within two samples of each other, only the stronger is a line.
  const drop = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = type[i];
      if (!t) continue;
      let weaker = false;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2) && !weaker; yy++)
        for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) {
          const j = yy * w + xx;
          if (type[j] && type[j] !== t && strength[j] > strength[i]) {
            weaker = true;
            break;
          }
        }
      if (weaker) drop.push(i);
    }
  for (const i of drop) type[i] = strength[i] = 0;
  return { type, strength, raw };
}

/**
 * Zhang-Suen thinning of the pixels of type t in `type` (w x h), in place on `skel` (1 = skeleton).
 * Works on the list of line pixels only, so it costs little when lines are a small part of the picture.
 */
function thinLines(type, t, w, h, skel) {
  let list = [];
  for (let i = 0; i < type.length; i++)
    if (type[i] === t) {
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        skel[i] = 1;
        list.push(i);
      }
    }
  const nb = new Uint8Array(9);
  const remove = [];
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (let sub = 0; sub < 2; sub++) {
      remove.length = 0;
      for (const i of list) {
        // P2..P9 clockwise from north
        nb[1] = skel[i - w];
        nb[2] = skel[i - w + 1];
        nb[3] = skel[i + 1];
        nb[4] = skel[i + w + 1];
        nb[5] = skel[i + w];
        nb[6] = skel[i + w - 1];
        nb[7] = skel[i - 1];
        nb[8] = skel[i - w - 1];
        let B = 0;
        let A = 0;
        for (let k = 1; k <= 8; k++) {
          B += nb[k];
          if (!nb[k] && nb[k === 8 ? 1 : k + 1]) A++;
        }
        if (B < 2 || B > 6 || A !== 1) continue;
        if (sub === 0 ? nb[1] * nb[3] * nb[5] || nb[3] * nb[5] * nb[7] : nb[1] * nb[3] * nb[7] || nb[1] * nb[5] * nb[7])
          continue;
        remove.push(i);
      }
      for (const i of remove) skel[i] = 0;
      if (remove.length) {
        changed = true;
        list = list.filter((i) => skel[i]);
      }
    }
    if (!changed) break;
  }
  return list;
}

/**
 * Which cells are drawn as thin line, and in what color. Returns { kind: Uint8Array (0 no, 1 dark, 2 light),
 * color: Uint8ClampedArray RGB, texture: Uint8Array (1 = fine hatching: keep its average tone) }.
 */
function rasterizeThinLines(rgba, W, H, k) {
  const w = W * k;
  const h = H * k;
  const n = k * k;
  const { type, strength, raw } = findThinLines(rgba, w, h, Math.max(1, Math.floor(0.875 * k)));
  const cells = W * H;
  // per cell and line type: covered share, and color weighted by how strongly each sample stands out
  const count = [null, new Uint16Array(cells), new Uint16Array(cells)];
  const sum = [null, new Float32Array(cells * 4), new Float32Array(cells * 4)];
  for (let y = 0; y < h; y++) {
    const row = ((y / k) | 0) * W;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = type[i];
      if (!t) continue;
      const c = row + ((x / k) | 0);
      count[t][c]++;
      const wt = strength[i] * strength[i];
      const s = sum[t];
      s[c * 4] += rgba[i * 4] * wt;
      s[c * 4 + 1] += rgba[i * 4 + 1] * wt;
      s[c * 4 + 2] += rgba[i * 4 + 2] * wt;
      s[c * 4 + 3] += wt;
    }
  }
  // skeleton of each line type, mapped to cells
  const skel = new Uint8Array(w * h);
  const onSkeleton = [null, new Uint8Array(cells), new Uint8Array(cells)];
  // each separate line (8-connected piece of skeleton): its mean contrast; each cell: the line most of its
  // skeleton belongs to (-1: none)
  const lineOf = [null, new Int32Array(cells).fill(-1), new Int32Array(cells).fill(-1)];
  const lineStrength = [null, [], []];
  const label = new Int32Array(w * h);
  const stack = [];
  for (const t of [1, 2]) {
    skel.fill(0);
    const list = thinLines(type, t, w, h, skel);
    for (const i of list) {
      const x = i % w;
      onSkeleton[t][(((i - x) / w / k) | 0) * W + ((x / k) | 0)] = 1;
    }
    label.fill(-1);
    const strengths = lineStrength[t];
    for (const start of list) {
      if (label[start] >= 0) continue;
      const id = strengths.length;
      let total = 0;
      let count = 0;
      label[start] = id;
      stack.push(start);
      while (stack.length) {
        const p = stack.pop();
        total += strength[p];
        count++;
        const px = p % w;
        const py = (p - px) / w;
        for (let yy = Math.max(0, py - 1); yy <= Math.min(h - 1, py + 1); yy++)
          for (let xx = Math.max(0, px - 1); xx <= Math.min(w - 1, px + 1); xx++) {
            const q = yy * w + xx;
            if (skel[q] && label[q] < 0) {
              label[q] = id;
              stack.push(q);
            }
          }
      }
      strengths.push(total / count);
    }
    const ids = new Int32Array(n);
    for (let c = 0; c < cells; c++) {
      if (!onSkeleton[t][c]) continue;
      const cx = c % W;
      const cy = (c - cx) / W;
      let m = 0;
      for (let sy = cy * k; sy < cy * k + k; sy++)
        for (let sx = cx * k; sx < cx * k + k; sx++) if (label[sy * w + sx] >= 0) ids[m++] = label[sy * w + sx];
      let best = -1;
      let bestCount = 0;
      for (let a = 0; a < m; a++) {
        let same = 0;
        for (let b = 0; b < m; b++) same += ids[b] === ids[a] ? 1 : 0;
        if (same > bestCount || (same === bestCount && strengths[ids[a]] > strengths[best])) {
          bestCount = same;
          best = ids[a];
        }
      }
      lineOf[t][c] = best;
    }
  }
  const kind = new Uint8Array(cells);
  const share = new Float32Array(cells);
  for (let c = 0; c < cells; c++) {
    const d = count[1][c] / n;
    const l = count[2][c] / n;
    const t = d >= l ? 1 : 2;
    const f = t === 1 ? d : l;
    if (f >= LINE_CORE || (onSkeleton[t][c] && f > 0)) {
      kind[c] = t;
      share[c] = f;
    }
  }
  // Fine hatching (parallel lines closer than about 1.5 cells): no single line can be drawn, keep the patch's
  // tone instead. There the dark lines and the light gaps between them both read as thin lines, in the cell
  // and all around it.
  const both = new Uint8Array(cells);
  {
    const rawCount = [null, new Uint16Array(cells), new Uint16Array(cells)];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const t = raw[y * w + x];
        if (t) rawCount[t][((y / k) | 0) * W + ((x / k) | 0)]++;
      }
    for (let c = 0; c < cells; c++) both[c] = rawCount[1][c] >= 0.15 * n && rawCount[2][c] >= 0.15 * n ? 1 : 0;
  }
  const texture = new Uint8Array(cells);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = y * W + x;
      if (!both[c]) continue;
      let around = 0;
      if (x > 0) around += both[c - 1];
      if (x < W - 1) around += both[c + 1];
      if (y > 0) around += both[c - W];
      if (y < H - 1) around += both[c + W];
      if (around >= 3) texture[c] = 1;
    }
  for (let c = 0; c < cells; c++) if (texture[c]) kind[c] = 0;
  const same = (x, y, t) => x >= 0 && y >= 0 && x < W && y < H && kind[y * W + x] === t;
  // Clean one-cell lines, the way a pixel artist draws them. Cells that the line does not need go, the
  // weakest first (core cells always stay):
  //   - any cell whose line neighbours stay connected without it (a "simple" cell: the inner corner of an L,
  //     a bump on the side, the second cell of a two-cell-wide stretch), unless it is the end of a line;
  //   - a one-cell spur sticking out of a line;
  //   - a faint dot alone (noise).
  const order = [];
  for (let c = 0; c < cells; c++) if (kind[c] && share[c] < LINE_CORE) order.push(c);
  order.sort((p, q) => share[p] - share[q]);
  const nb = new Uint8Array(8); // E, NE, N, NW, W, SW, S, SE
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, -1, -1, -1, 0, 1, 1, 1];
  const countAround = (x, y, t) => {
    let around = 0;
    for (let d = 0; d < 8; d++) around += same(x + DX[d], y + DY[d], t) ? 1 : 0;
    return around;
  };
  for (let round = 0; round < 2; round++)
    for (const c of order) {
      const t = kind[c];
      if (!t) continue;
      const x = c % W;
      const y = (c - x) / W;
      let around = 0;
      for (let d = 0; d < 8; d++) around += nb[d] = same(x + DX[d], y + DY[d], t) ? 1 : 0;
      let drop = false;
      // alone: a real dot (a star, a highlight) stands out strongly; a faint one is ringing or noise
      if (around === 0) drop = share[c] < 0.25 || sum[t][c * 4 + 3] < count[t][c] * LONE_DOT_CONTRAST ** 2;
      else if (around === 1) {
        // spur: its only neighbour is a junction of three or more line cells
        const d = nb.indexOf(1);
        drop = countAround(x + DX[d], y + DY[d], t) >= 3;
      } else if (around < 8) {
        // Yokoi's 8-connectivity number: 1 = removing the cell changes nothing about how the line connects
        let connectivity = 0;
        for (let d = 0; d < 8; d += 2) {
          const a = 1 - nb[d];
          connectivity += a - a * (1 - nb[(d + 1) & 7]) * (1 - nb[(d + 2) & 7]);
        }
        drop = connectivity === 1;
      }
      if (drop) kind[c] = 0;
    }
  // Lines closer together than one cell (hair strands, the lines between small fingers, dense folds) would
  // merge into a dark patch when drawn side by side. Where two different lines run alongside each other in
  // touching cells, the weaker one gives way there; what is left of it in pieces of one or two cells goes too.
  // Line ends may touch (a line meeting another), and short lines (a pupil, a highlight) always stay.
  for (const t of [1, 2]) {
    const of = lineOf[t];
    const strengths = lineStrength[t];
    const size = new Int32Array(strengths.length);
    for (let c = 0; c < cells; c++) if (kind[c] === t && of[c] >= 0) size[of[c]]++;
    const ownNeighbours = (c) => {
      const x = c % W;
      const y = (c - x) / W;
      let count = 0;
      for (let d = 0; d < 8; d++) {
        const xx = x + DX[d];
        const yy = y + DY[d];
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && kind[yy * W + xx] === t && of[yy * W + xx] === of[c]) count++;
      }
      return count;
    };
    const stronger = (B, A) =>
      strengths[B] > strengths[A] ||
      (strengths[B] === strengths[A] && (size[B] > size[A] || (size[B] === size[A] && B < A)));
    const order = [];
    for (let c = 0; c < cells; c++) if (kind[c] === t && of[c] >= 0 && size[of[c]] > SHORT_LINE) order.push(c);
    order.sort((p, q) => strengths[of[p]] - strengths[of[q]] || size[of[p]] - size[of[q]]);
    const cut = new Uint8Array(strengths.length);
    for (const c of order) {
      const A = of[c];
      if (ownNeighbours(c) < 2) continue; // a line end
      const x = c % W;
      const y = (c - x) / W;
      let yields = false;
      for (let d = 0; d < 8 && !yields; d++) {
        const xx = x + DX[d];
        const yy = y + DY[d];
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        const B = of[j];
        if (kind[j] !== t || B < 0 || B === A || !stronger(B, A)) continue;
        if (ownNeighbours(j) >= 2) yields = true; // alongside, not end to end
      }
      if (yields) {
        kind[c] = 0;
        cut[A] = 1;
      }
    }
    // leftovers of lines that gave way
    const seen = new Uint8Array(cells);
    const piece = [];
    for (let c = 0; c < cells; c++) {
      if (seen[c] || kind[c] !== t || of[c] < 0 || !cut[of[c]]) continue;
      const A = of[c];
      piece.length = 0;
      seen[c] = 1;
      piece.push(c);
      for (let p = 0; p < piece.length; p++) {
        const x = piece[p] % W;
        const y = (piece[p] - x) / W;
        for (let d = 0; d < 8; d++) {
          const xx = x + DX[d];
          const yy = y + DY[d];
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (!seen[j] && kind[j] === t && of[j] === A) {
            seen[j] = 1;
            piece.push(j);
          }
        }
      }
      if (piece.length <= 2) for (const j of piece) kind[j] = 0;
    }
  }
  // a line's color is pooled from the cell and its line neighbours: a cell the line only grazes would get
  // a paler, half-blended color of its own, and the line would flicker between shades along its length
  // samples on a line or touching one: the line's anti-aliased rim and its JPEG halo are neither line nor
  // background, and a cell next to the line must not take its color from them
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!type[y * w + x]) continue;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) near[yy * w + xx] = 1;
    }
  // The line's own color (its ink, its highlight) is that of its strongest samples: those that stand out at
  // least LINE_INK of the most any sample of the line does here. A plain average would mix in the anti-aliased
  // rim and give pale lines and bluish-gray highlights.
  const peak = [null, new Uint8Array(cells), new Uint8Array(cells)];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = type[i];
      if (!t) continue;
      const c = ((y / k) | 0) * W + ((x / k) | 0);
      if (strength[i] > peak[t][c]) peak[t][c] = strength[i];
    }
  const color = new Uint8ClampedArray(cells * 3);
  for (let c = 0; c < cells; c++) {
    const t = kind[c];
    if (!t) continue;
    const x = c % W;
    const y = (c - x) / W;
    let top = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (same(x + dx, y + dy, t)) top = Math.max(top, peak[t][(y + dy) * W + x + dx]);
    const floor = top * LINE_INK;
    let r = 0;
    let gg = 0;
    let b = 0;
    let wt = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!same(x + dx, y + dy, t)) continue;
        for (let sy = (y + dy) * k; sy < (y + dy + 1) * k; sy++)
          for (let sx = (x + dx) * k; sx < (x + dx + 1) * k; sx++) {
            const i = sy * w + sx;
            if (type[i] !== t || strength[i] < floor) continue;
            const wgt = strength[i];
            r += rgba[i * 4] * wgt;
            gg += rgba[i * 4 + 1] * wgt;
            b += rgba[i * 4 + 2] * wgt;
            wt += wgt;
          }
      }
    color[c * 3] = r / wt;
    color[c * 3 + 1] = gg / wt;
    color[c * 3 + 2] = b / wt;
  }
  return { kind, color, texture, type, near };
}

/**
 * Art mode: collapses each k*k block of a supersampled image into one cell color without mixing areas.
 *
 * Thin lines (rasterizeThinLines) become unbroken one-cell lines in their own color. For every other cell, its
 * sub-samples that are not part of a thin line are split into two groups (2-means):
 *   - the samples are nearly equal, or spread evenly (a soft gradient): the cell is their average;
 *   - two clear groups (the border of two areas): the cell takes the bigger group's color, so the border
 *     stays crisp and no in-between color appears;
 *   - both colors run through all the neighbouring cells too (hatching finer than the grid): the cell is the
 *     average again, so the hatched patch keeps its overall tone instead of turning into one of the colors.
 * The returned array carries `.lines` (Uint8Array, 1 = thin-line cell), for the clean-up steps to leave alone.
 */
export function pickCellColors(rgba, W, H, k) {
  const n = k * k;
  const rowWidth = W * k;
  const out = new Uint8ClampedArray(W * H * 4);
  const thin = k >= 2 ? rasterizeThinLines(rgba, W, H, k) : null;
  const lines = new Uint8Array(W * H);
  const minorShare = new Float32Array(W * H); // > 0: a two-color cell; the smaller group's share of it
  const pair = new Uint8ClampedArray(W * H * 6); // two-color cells: bigger group RGB, smaller group RGB
  const avg = new Float32Array(W * H * 3); // average color of the cell's samples
  const range2 = new Float32Array(W * H).fill(Infinity); // squared distance between its two most different samples
  const soft = []; // two-color cells that came out as a blend of their average and their bigger group
  const R = new Float32Array(9 * n);
  const G = new Float32Array(9 * n);
  const B = new Float32Array(9 * n);
  const side = new Uint8Array(9 * n);
  const c = new Float64Array(6); // the two group centers of the cell being looked at: RGB, RGB
  const sum = new Float64Array(6);
  // perceptual-ish squared distance; equals d*d for a gray difference of d levels
  const dist2 = (r, g, b) => (3 * r * r + 4 * g * g + 2 * b * b) / 9;

  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const q = i * 4;
      out[q + 3] = 255;
      if (thin && thin.kind[i]) {
        lines[i] = 1;
        for (let j = 0; j < 3; j++) out[q + j] = avg[i * 3 + j] = thin.color[i * 3 + j];
        range2[i] = 0;
        continue;
      }
      // the cell's samples, without the ones on or right beside a thin line (unless the whole patch is fine
      // hatching); if a line fills the cell, the background around it: the same samples of the neighbouring
      // cells; failing that, all but the line samples; failing that, all of them
      const skipLines = thin && !thin.texture[i];
      let m = 0;
      for (let pass = 0; pass < 4 && !m; pass++) {
        if (pass === 1 && !skipLines) continue;
        const x0 = pass === 1 ? Math.max(0, x - 1) : x;
        const x1 = pass === 1 ? Math.min(W - 1, x + 1) : x;
        const y0 = pass === 1 ? Math.max(0, y - 1) : y;
        const y1 = pass === 1 ? Math.min(H - 1, y + 1) : y;
        for (let cy = y0; cy <= y1; cy++)
          for (let cx = x0; cx <= x1; cx++)
            for (let j = 0; j < n; j++) {
              const s = (cy * k + ((j / k) | 0)) * rowWidth + cx * k + (j % k);
              if (skipLines && pass < 2 && thin.near[s]) continue;
              if (skipLines && pass === 2 && thin.type[s]) continue;
              if (m === R.length) continue; // (the 3x3 neighbourhood can hold more samples than one cell)
              R[m] = rgba[s * 4];
              G[m] = rgba[s * 4 + 1];
              B[m] = rgba[s * 4 + 2];
              m++;
            }
      }
      let mr = 0;
      let mg = 0;
      let mb = 0;
      for (let j = 0; j < m; j++) {
        mr += R[j];
        mg += G[j];
        mb += B[j];
      }
      mr /= m;
      mg /= m;
      mb /= m;
      out[q] = avg[i * 3] = mr;
      out[q + 1] = avg[i * 3 + 1] = mg;
      out[q + 2] = avg[i * 3 + 2] = mb;

      // two samples far apart: the one farthest from the average, and the one farthest from that
      let a = 0;
      let best = -1;
      for (let j = 0; j < m; j++) {
        const d = dist2(R[j] - mr, G[j] - mg, B[j] - mb);
        if (d > best) {
          best = d;
          a = j;
        }
      }
      let b = 0;
      best = -1;
      for (let j = 0; j < m; j++) {
        const d = dist2(R[j] - R[a], G[j] - G[a], B[j] - B[a]);
        if (d > best) {
          best = d;
          b = j;
        }
      }
      range2[i] = best;
      if (best < FLAT_RANGE * FLAT_RANGE) continue; // flat cell: keep the average

      // 2-means from those two samples
      c[0] = R[a];
      c[1] = G[a];
      c[2] = B[a];
      c[3] = R[b];
      c[4] = G[b];
      c[5] = B[b];
      let countB = 0;
      for (let round = 0; round < 3; round++) {
        sum.fill(0);
        countB = 0;
        for (let j = 0; j < m; j++) {
          const toA = dist2(R[j] - c[0], G[j] - c[1], B[j] - c[2]);
          const toB = dist2(R[j] - c[3], G[j] - c[4], B[j] - c[5]);
          const s = (side[j] = toB < toA ? 1 : 0);
          countB += s;
          sum[s * 3] += R[j];
          sum[s * 3 + 1] += G[j];
          sum[s * 3 + 2] += B[j];
        }
        if (!countB || countB === m) break;
        for (let j = 0; j < 3; j++) {
          c[j] = sum[j] / (m - countB);
          c[3 + j] = sum[3 + j] / countB;
        }
      }
      if (!countB || countB === m) continue;
      // how tight the groups are compared with the gap between them:
      // an even spread (gradient) gives ~0.25, two clean colors with a few blended samples ~0.1
      let spread = 0;
      for (let j = 0; j < m; j++) {
        const o = side[j] * 3;
        spread += Math.sqrt(dist2(R[j] - c[o], G[j] - c[o + 1], B[j] - c[o + 2]));
      }
      const gap = Math.sqrt(dist2(c[0] - c[3], c[1] - c[4], c[2] - c[5]));
      const edge = Math.max(0, Math.min(1, (0.26 - spread / m / gap) / 0.12));
      if (!edge) continue;
      // bigger group wins; on a tie the darker one (keeps outlines whole)
      const lumaA = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
      const lumaB = 0.3 * c[3] + 0.59 * c[4] + 0.11 * c[5];
      const major = countB * 2 > m || (countB * 2 === m && lumaB < lumaA) ? 3 : 0;
      const minor = 3 - major;
      out[q] = mr + (c[major] - mr) * edge;
      out[q + 1] = mg + (c[major + 1] - mg) * edge;
      out[q + 2] = mb + (c[major + 2] - mb) * edge;
      if (edge < 1) soft.push(i);
      // remembered for the second pass, which needs the neighbours' samples too
      minorShare[i] = (major ? m - countB : countB) / m;
      for (let j = 0; j < 3; j++) {
        pair[i * 6 + j] = c[major + j];
        pair[i * 6 + 3 + j] = c[minor + j];
      }
    }

  // A blend that sits between two nearly flat neighbours of clearly different colors is not a soft gradient
  // but an anti-aliased border (with few samples per cell the two look alike): the border cell takes the color
  // of the side most of its samples are closer to, so contours stay crisp instead of getting a fringe of
  // in-between shades (its own groups would still hold the blended samples).
  for (const i of soft) {
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
    ]) {
      const ax = x - dx;
      const ay = y - dy;
      const bx = x + dx;
      const by = y + dy;
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= W || bx >= W || ay >= H || by >= H) continue;
      const a = ay * W + ax;
      const b = by * W + bx;
      if (range2[a] > FLAT_NEIGHBOUR * FLAT_NEIGHBOUR || range2[b] > FLAT_NEIGHBOUR * FLAT_NEIGHBOUR) continue;
      if (
        dist2(avg[a * 3] - avg[b * 3], avg[a * 3 + 1] - avg[b * 3 + 1], avg[a * 3 + 2] - avg[b * 3 + 2]) <
        STEP * STEP
      )
        continue;
      let toA = 0;
      for (let j = 0; j < n; j++) {
        const p = ((y * k + ((j / k) | 0)) * rowWidth + x * k + (j % k)) * 4;
        const dA = dist2(rgba[p] - avg[a * 3], rgba[p + 1] - avg[a * 3 + 1], rgba[p + 2] - avg[a * 3 + 2]);
        const dB = dist2(rgba[p] - avg[b * 3], rgba[p + 1] - avg[b * 3 + 1], rgba[p + 2] - avg[b * 3 + 2]);
        toA += dA < dB ? 1 : dA > dB ? 0 : 0.5;
      }
      const lumaA = 0.3 * avg[a * 3] + 0.59 * avg[a * 3 + 1] + 0.11 * avg[a * 3 + 2];
      const lumaB = 0.3 * avg[b * 3] + 0.59 * avg[b * 3 + 1] + 0.11 * avg[b * 3 + 2];
      const side = toA * 2 > n || (toA * 2 === n && lumaA < lumaB) ? a : b; // on a tie the darker side
      for (let j = 0; j < 3; j++) out[i * 4 + j] = avg[side * 3 + j];
      minorShare[i] = 0; // decided: not part of a texture
      break;
    }
  }

  // Second pass over the two-color cells: fine texture (hatching, screentone: both colors show up in every
  // neighbour as well) has no single right color; "bigger group wins" would turn the whole patch into its
  // darker or lighter color. The cell becomes the average again, which keeps the patch's overall tone.
  const averaged = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!minorShare[i]) continue;
      const o = i * 6;
      if (
        isMixed(shareIn(o, x - 1, y)) &&
        isMixed(shareIn(o, x + 1, y)) &&
        isMixed(shareIn(o, x, y - 1)) &&
        isMixed(shareIn(o, x, y + 1))
      )
        averaged.push(i);
    }
  for (const i of averaged) {
    const f = minorShare[i];
    for (let j = 0; j < 3; j++) out[i * 4 + j] = pair[i * 6 + j] * (1 - f) + pair[i * 6 + 3 + j] * f;
  }
  out.lines = lines;
  return out;

  /** Share of cell (cx, cy)'s samples that belong to the smaller group of the cell whose colors start at pair[o]. */
  function shareIn(o, cx, cy) {
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return 0;
    let count = 0;
    for (let j = 0; j < n; j++) {
      const p = ((cy * k + ((j / k) | 0)) * rowWidth + cx * k + (j % k)) * 4;
      const toMajor = dist2(rgba[p] - pair[o], rgba[p + 1] - pair[o + 1], rgba[p + 2] - pair[o + 2]);
      const toMinor = dist2(rgba[p] - pair[o + 3], rgba[p + 1] - pair[o + 4], rgba[p + 2] - pair[o + 5]);
      if (toMinor < toMajor) count++;
    }
    return count / n;
  }
  function isMixed(v) {
    return v > TEXTURE_MIX && v < 1 - TEXTURE_MIX;
  }
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

/**
 * Lightness counts this much more than hue and saturation when the palette is picked and cells are matched to
 * it. Banding in a gradient is seen in its lightness first: with lightness weighted, the palette lays its colors
 * out along the gradient's light-dark course, and the bands follow it as smooth, evenly ordered rings instead of
 * flipping between two look-alike colors of slightly different hue. Dark shades get more colors of their own too.
 */
const L_WEIGHT = 2;

/** Evenly spaced sample of `count` pixels, in Lab (lightness scaled by lightWeight) and RGB. */
export function samplePixels(rgba, pixelCount, count, lightWeight = L_WEIGHT) {
  const step = pixelCount / count;
  const lab = new Float32Array(count * 3);
  const rgb = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const p = ((i * step) | 0) * 4;
    rgb[i * 3] = rgba[p];
    rgb[i * 3 + 1] = rgba[p + 1];
    rgb[i * 3 + 2] = rgba[p + 2];
    srgbToLab(rgba[p] | 0, rgba[p + 1] | 0, rgba[p + 2] | 0, lab, i * 3);
    lab[i * 3] *= lightWeight;
  }
  return { lab, rgb, count };
}

/* ---------- k-means palette ---------- */

/**
 * How strongly rare colors are favoured when the palette is picked (0 = every cell counts the same).
 * A group of n similar cells counts as n^(1 - RARE_BOOST): a huge flat background no longer takes most of
 * the palette as near-identical shades, and small details (eyes, lips, highlights) get colors of their own.
 */
const RARE_BOOST = 0.05;

/** Evenly spaced sample of the cell image for the palette search, with rarity weights. */
export function paletteSample(rgba, pixelCount, count, lightWeight = L_WEIGHT) {
  const sample = samplePixels(rgba, pixelCount, count, lightWeight);
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

  let nearestDistance = 0; // squared distance found by the last nearestCenter call
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
    nearestDistance = bestD;
    return best;
  };

  const sums = new Float64Array(K * 3);
  const mass = new Float64Array(K);
  for (let it = 0; it < iterations; it++) {
    sums.fill(0);
    mass.fill(0);
    for (let i = 0; i < S; i++) {
      const k = nearestCenter(i);
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
    const k = nearestCenter(i);
    const w = weight[i];
    error += Math.sqrt(nearestDistance);
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
    : (r, g, b, out) => {
        srgbToLab(r, g, b, out, 0);
        out[0] *= L_WEIGHT;
      };
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
 * Inside soft gradients (smooth[i], from smoothGradients) the pull of the neighbours is much stronger: there no
 * detail can be lost, and it makes the borders between the bands of a gradient run straight instead of ragged.
 * Elsewhere it is gentle, so small details survive the clean-up.
 */
export function settle(idx, rgba, W, H, pal, K, clean, lines = null, smooth = null) {
  const detailStrength = 0.08 * clean * clean;
  const smoothStrength = Math.max(detailStrength, 2 + 1.2 * clean);
  if (!detailStrength) return;
  let strength = detailStrength;
  const palLab = paletteToLab(pal, K);
  const lab = new Float32Array(3);
  const labels = new Int32Array(8);
  const weights = new Float32Array(8);
  const passes = W * H > 4e6 ? 1 : clean >= 5 ? 3 : 2;
  /** Cost of giving the current cell (its Lab color is in `lab`, its m neighbours in `labels`) color c. */
  const cost = (c, m) => {
    const a = lab[0] - palLab[c * 3];
    const b = lab[1] - palLab[c * 3 + 1];
    const e = lab[2] - palLab[c * 3 + 2];
    let disagree = 0;
    for (let n = 0; n < m; n++) if (labels[n] !== c) disagree += weights[n];
    return a * a + b * b + e * e + strength * disagree;
  };
  for (let pass = 0; pass < passes; pass++) {
    let changed = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (lines && lines[i]) continue;
        strength = smooth && smooth[i] ? smoothStrength : detailStrength;
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
        let best = own;
        let bestCost = cost(own, m);
        for (let n = 0; n < m; n++) {
          const c = labels[n];
          if (c === best || c === own) continue;
          const v = cost(c, m);
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
 * Cells touching by a corner count as connected: a thin diagonal line is one region, not a row of specks.
 */
export function removeSpecks(idx, W, H, minSize, pal, maxDelta = Infinity, lines = null) {
  if (minSize < 2) return;
  const N = W * H;
  const palLab = paletteToLab(pal, pal.length / 3);
  const region = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const regionSize = [];
  const regionColor = [];
  const regionKept = []; // holds a thin-line cell: never merged away
  let regions = 0;

  // label connected regions (8-neighbour flood fill)
  for (let start = 0; start < N; start++) {
    if (region[start] >= 0) continue;
    const c = idx[start];
    let head = 0;
    let tail = 0;
    let kept = false;
    queue[tail++] = start;
    region[start] = regions;
    while (head < tail) {
      const i = queue[head++];
      if (lines && lines[i]) kept = true;
      const x = i % W;
      const y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (region[j] < 0 && idx[j] === c) {
            region[j] = regions;
            queue[tail++] = j;
          }
        }
      }
    }
    regionSize.push(kept ? Infinity : tail);
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

/** Band borders are softened only between palette colors at most this far apart (Lab distance). */
const RAMP_REACH = 7;

/**
 * Softens the borders between the bands of a gradient, the way pixel artists do: along the border the two
 * colors interlock like teeth (a one-cell checker pattern) instead of meeting in a hard line.
 * Only cells right at a border are touched, only between two similar colors (a real edge between different
 * colors stays as it is), and only where the cell's real color is about halfway between the two.
 * width 0..0.5: how far from "exactly halfway" a cell may be (0 = off).
 */
export function ditherRamps(idx, rgba, W, H, pal, K, width, lines = null) {
  if (width <= 0) return;
  const palLab = paletteToLab(pal, K);
  const lab = new Float32Array(3);
  const before = new Uint16Array(idx);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (lines && lines[i]) continue;
      const a = before[i];
      // the neighbouring color that differs from this cell's, nearest in color if there are several
      let b = -1;
      let gap2 = RAMP_REACH * RAMP_REACH;
      for (let side = 0; side < 4; side++) {
        // left, right, up, down
        const j =
          side === 0
            ? x > 0
              ? i - 1
              : -1
            : side === 1
              ? x < W - 1
                ? i + 1
                : -1
              : side === 2
                ? y > 0
                  ? i - W
                  : -1
                : y < H - 1
                  ? i + W
                  : -1;
        if (j < 0 || before[j] === a || (lines && lines[j])) continue;
        const c = before[j];
        const d0 = palLab[c * 3] - palLab[a * 3];
        const d1 = palLab[c * 3 + 1] - palLab[a * 3 + 1];
        const d2 = palLab[c * 3 + 2] - palLab[a * 3 + 2];
        const d = d0 * d0 + d1 * d1 + d2 * d2;
        if (d < gap2) {
          gap2 = d;
          b = c;
        }
      }
      if (b < 0) continue;
      // the color this spot of the checker pattern should have: the lower number on "black" squares
      const wanted = (x + y) & 1 ? Math.max(a, b) : Math.min(a, b);
      if (wanted === a) continue;
      // where the cell's real color lies on the way from a (0) to b (1)
      srgbToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], lab, 0);
      let t = 0;
      for (let j = 0; j < 3; j++) t += (lab[j] - palLab[a * 3 + j]) * (palLab[b * 3 + j] - palLab[a * 3 + j]);
      t /= gap2;
      if (t > 0.5 - width) idx[i] = b;
    }
}

/** Two palette colors closer than this (Lab distance; ~2.3 is the smallest difference people notice) become one. */
export const SAME_COLOR = 0.8;
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
  // art mode looks at several samples per cell; "enhance" also wants finer detail than one cell to work on
  const finest = subsamplesFor(source, W, H);
  const k = style === "art" ? finest : userAdjust.enh ? Math.min(2, finest) : 1;
  let rgba = boxScale(source, W * k, H * k);
  applyAdjustments(rgba, W * k, H * k, userAdjust);
  if (k > 1)
    rgba =
      style === "art" ? pickCellColors(rgba, W, H, k) : boxScale({ data: rgba, width: W * k, height: H * k }, W, H);
  const lines = rgba.lines || null;
  if (style === "art") rgba = smoothGradients(rgba, W, H, clean > 0 ? 24 + 4 * clean : 0, lines);
  const smooth = rgba.smooth || null;
  const out = smoothFlat(rgba, W, H, clean, lines);
  out.lines = lines; // thin-line cells (art mode): the clean-up steps leave them alone
  out.smooth = smooth; // cells inside soft gradients and flat areas (art mode)
  return out;
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
  const lines = rgba.lines; // art mode: thin-line cells, left alone by the clean-up
  const smooth = rgba.smooth; // art mode: cells inside soft gradients
  const K = Math.max(1, Math.min(p.colors, W * H));
  const pal = await kmeansPalette(rgba, W * H, K, hooks);
  if (!pal) return null;
  const idx = await quantize(rgba, W, H, pal, K, dither, hooks);
  if (!idx) return null;
  if (!dither && clean > 0) {
    settle(idx, rgba, W, H, pal, K, clean, lines, smooth);
    // only specks that hardly differ from their surroundings: small details that stand out stay
    removeSpecks(idx, W, H, 2 + (clean >> 2), pal, 3 + clean * 0.8, lines);
  }
  // soft band borders in gradients; the cleaner the picture is asked to be, the less of it
  // (not in art mode: drawn pictures have clean color bands, a checker seam along every band reads as noise)
  if (!dither && p.style !== "art") ditherRamps(idx, rgba, W, H, pal, K, 0.2 - 0.02 * clean, lines);
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
 * Smallest color count whose average error is at most AUTO_COLOR_TARGET, x1.5 headroom (more shades for
 * gradients than the average error alone asks for).
 * Binary search over quick k-means runs on a sample (error goes down steadily as colors go up).
 */
export async function suggestColorCount(source, params, userAdjust, hooks = noHooks) {
  const N = params.width * params.height;
  const rgba = prepareImage(source, params, userAdjust);
  // plain Lab here: the target below is a perceived difference
  const sample = paletteSample(rgba, N, Math.min(N, 12000), 1);
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
  return Math.min(maxK, Math.max(Math.min(maxK, 16), Math.round(best * 1.5)));
}
