// Pixel operations of the photo editor (wizard step 1). Pure functions on RGBA byte arrays, no DOM,
// so they can be tested in Node (tests/editops.test.js).

/**
 * How different two colors look, in "gray levels": a gray step of d levels gives exactly d.
 * Green counts most and blue least, roughly like the eye.
 */
export const colorDistance2 = (dr, dg, db) => (3 * dr * dr + 4 * dg * dg + 2 * db * db) / 9;

/* ---------- OKLab (a color space where equal steps look equally different) ---------- */

const toLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toGamma = (c) => {
  c = Math.max(0, Math.min(1, c));
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
};

export function rgbToOklab(r, g, b) {
  r = toLinear(r);
  g = toLinear(g);
  b = toLinear(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/* ---------- geometry ---------- */

/**
 * Turning a w x h picture by `degrees` leaves empty corners; it has to be enlarged by this factor so that
 * it still covers the whole w x h frame (like "straighten" in phone photo editors).
 */
export function coverScale(w, h, degrees) {
  const a = (Math.abs(degrees) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return Math.max(c + (h / w) * s, c + (w / h) * s);
}

/* ---------- fill ---------- */

/**
 * Flood fill from (sx, sy): every pixel connected to it (left/right/up/down) whose color is within
 * `limit` gray levels of `seed` [r, g, b]. Returns a weight per pixel: 255 = filled; pixels just outside the
 * filled area that are within 2 * limit get a partial weight, so the fill has a soft edge instead of a ring
 * of leftover in-between pixels (the blend where the old color met an outline).
 */
export function floodFillMask(data, w, h, sx, sy, seed, limit) {
  const mask = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const limit2 = limit * limit;
  const [R, G, B] = seed;
  const near = (i) => {
    const p = i * 4;
    return colorDistance2(data[p] - R, data[p + 1] - G, data[p + 2] - B) <= limit2;
  };
  if (!near(sy * w + sx)) return mask;

  // scanline fill: fill a whole horizontal run, then look for runs to continue in the rows above and below
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    const row = y * w;
    if (mask[row + x] || !near(row + x)) continue;
    let x0 = x;
    while (x0 > 0 && !mask[row + x0 - 1] && near(row + x0 - 1)) x0--;
    let x1 = x;
    while (x1 < w - 1 && !mask[row + x1 + 1] && near(row + x1 + 1)) x1++;
    mask.fill(255, row + x0, row + x1 + 1);
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let xx = x0; xx <= x1; xx++) {
        const ok = !mask[nrow + xx] && near(nrow + xx);
        if (ok && !inRun) stack.push(xx, ny);
        inRun = ok;
      }
    }
  }

  // soft edge
  const soft = 2 * limit;
  const edge = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) continue;
      const touches =
        (x > 0 && mask[i - 1] === 255) ||
        (x < w - 1 && mask[i + 1] === 255) ||
        (y > 0 && mask[i - w] === 255) ||
        (y < h - 1 && mask[i + w] === 255);
      if (!touches) continue;
      const p = i * 4;
      const d = Math.sqrt(colorDistance2(data[p] - R, data[p + 1] - G, data[p + 2] - B));
      if (d < soft) edge.push(i, Math.max(1, Math.min(254, Math.round(254 * (1 - (d - limit) / limit)))));
    }
  for (let n = 0; n < edge.length; n += 2) mask[edge[n]] = edge[n + 1];
  return mask;
}

/** Paints color [r, g, b] into data wherever mask > 0 (mask 255 = fully, less = partly). */
export function blendMask(data, mask, color) {
  const [R, G, B] = color;
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i];
    if (!m) continue;
    const p = i * 4;
    const f = m / 255;
    data[p] += (R - data[p]) * f;
    data[p + 1] += (G - data[p + 1]) * f;
    data[p + 2] += (B - data[p + 2]) * f;
  }
}

/* ---------- color replace ---------- */

/**
 * Recolors every pixel whose color is within `limit` gray levels of `from` (anywhere in the picture), keeping
 * its shading: in OKLab, the hue and colorfulness move by (to - from) and the lightness is scaled by
 * L(to) / L(from), so shadows stay proportionally darker. Pixels between limit and 1.6 * limit change
 * partly, for a soft edge. Works in place on RGBA bytes.
 */
export function recolor(data, from, to, limit) {
  const [Lf, af, bf] = rgbToOklab(...from);
  const [Lt, at, bt] = rgbToOklab(...to);
  const ratio = Lf > 0.05 ? Math.max(0.2, Math.min(5, Lt / Lf)) : 0;
  const soft = 1.6 * limit;
  const soft2 = soft * soft;
  const cache = new Map(); // drawings repeat the same colors a lot
  for (let p = 0; p < data.length; p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const d2 = colorDistance2(r - from[0], g - from[1], b - from[2]);
    if (d2 > soft2) continue;
    const key = (r << 16) | (g << 8) | b;
    let out = cache.get(key);
    if (out === undefined) {
      const [L, a, bb] = rgbToOklab(r, g, b);
      const [nr, ng, nb] = oklabToRgb(ratio ? L * ratio : L + Lt - Lf, a + at - af, bb + bt - bf);
      const d = Math.sqrt(d2);
      const f = d <= limit ? 1 : 1 - (d - limit) / (soft - limit);
      out = [r + (nr - r) * f, g + (ng - g) * f, b + (nb - b) * f];
      if (cache.size > 200000) cache.clear();
      cache.set(key, out);
    }
    data[p] = out[0];
    data[p + 1] = out[1];
    data[p + 2] = out[2];
  }
}

/* ---------- misc ---------- */

/** Average color of the outermost ring of pixels: a margin in this color continues the picture's edge. */
export function edgeColor(data, w, h) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const add = (x, y) => {
    const p = (y * w + x) * 4;
    r += data[p];
    g += data[p + 1];
    b += data[p + 2];
    n++;
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    if (h > 1) add(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    add(0, y);
    if (w > 1) add(w - 1, y);
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}
