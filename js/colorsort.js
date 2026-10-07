// Palette ordering for the color picker. Pure functions (tested in tests/colorsort.test.js).
//
// "By color" = color families in rainbow order, each one running from dark to light:
//   red (dark red -> pink), orange/brown (brown -> tan), yellow, green, teal, blue, purple, magenta,
//   and finally pure grays.
// 1. Every color gets a hue angle in OKLCH (a hue scale where equal steps look equally different);
//    the angle decides the family. Grayish colors keep their slight tint, so a beige gray stays with the browns.
// 2. Each family is split by saturation into rows (vivid / medium / muted), so peach and beige-gray don't alternate.
// 3. Inside a row the order is the shortest path from its darkest to its lightest color (OKLab distance),
//    so it still goes dark -> light, but neighbouring colors are as similar as possible (no speckles).

/** OKLCH chroma below which a color counts as pure gray (no usable hue). */
const GRAY_CHROMA = 0.015;
/**
 * Each family is split by saturation (chroma / lightness) into rows: vivid >= 0.18, medium >= 0.06, muted below.
 * This keeps e.g. peach skin tones and beige-grays in separate rows instead of alternating.
 */
export const SATURATION_TIERS = [0.18, 0.06];
/** A row with fewer colors than this is merged into the neighbouring row of the same family. */
const MIN_ROW = 4;

/** Color families in rainbow order: [name, hue from, hue to) in OKLCH degrees. */
export const FAMILIES = [
  ["red", 10, 42],
  ["orange", 42, 80],
  ["yellow", 80, 120],
  ["green", 120, 170],
  ["teal", 170, 220],
  ["blue", 220, 280],
  ["purple", 280, 320],
  ["magenta", 320, 370], // 370 = wraps around to 10°
];

/** sRGB bytes -> OKLab [L, a, b]. */
export function toOklab(r, g, b) {
  const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** sRGB bytes -> { L, C, h } in OKLCH (h in degrees 0..360). */
export function toOklch(r, g, b) {
  const [L, A, B] = toOklab(r, g, b);
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function familyOf(c) {
  if (c.C < GRAY_CHROMA) return FAMILIES.length; // gray family, last
  const h = c.h < 10 ? c.h + 360 : c.h;
  return FAMILIES.findIndex(([, from, to]) => h >= from && h < to);
}

/** Distance between two OKLab colors. */
const labDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Orders one row as the shortest path from its darkest color to its lightest one:
 * greedy nearest-neighbour path, then 2-opt (reverse a stretch when that shortens the path).
 * The ends stay fixed, so the row still reads dark -> light.
 */
function smoothRow(row) {
  const n = row.length;
  if (n < 4) return row.sort((a, b) => a.L - b.L);
  const P = row.map((c) => c.lab);
  const d = (i, j) => labDistance(P[i], P[j]);
  let start = 0;
  let end = 0;
  for (let i = 0; i < n; i++) {
    if (row[i].L < row[start].L) start = i;
    if (row[i].L > row[end].L) end = i;
  }
  const visited = new Uint8Array(n);
  visited[start] = visited[end] = 1;
  const path = [start];
  for (let step = 1; step < n - 1; step++) {
    const from = path[path.length - 1];
    let best = -1;
    for (let j = 0; j < n; j++) if (!visited[j] && (best < 0 || d(from, j) < d(from, best))) best = j;
    visited[best] = 1;
    path.push(best);
  }
  path.push(end);
  for (let round = 0; round < 40; round++) {
    let improved = false;
    for (let i = 1; i < n - 2; i++)
      for (let j = i + 1; j < n - 1; j++) {
        const before = d(path[i - 1], path[i]) + d(path[j], path[j + 1]);
        const after = d(path[i - 1], path[j]) + d(path[i], path[j + 1]);
        if (after < before - 1e-9) {
          for (let a = i, b = j; a < b; a++, b--) [path[a], path[b]] = [path[b], path[a]];
          improved = true;
        }
      }
    if (!improved) break;
  }
  return path.map((i) => row[i]);
}

/**
 * Colors grouped into families (rainbow order), each family split into saturation rows
 * (vivid, medium, muted); every row runs from its darkest to its lightest color. Returns arrays of palette indices.
 */
export function colorFamilies(pal) {
  const K = pal.length / 3;
  const tiers = SATURATION_TIERS.length + 1;
  const families = Array.from({ length: FAMILIES.length + 1 }, () => Array.from({ length: tiers }, () => []));
  for (let k = 0; k < K; k++) {
    const c = { k, lab: toOklab(pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]) };
    Object.assign(c, { L: c.lab[0], C: Math.hypot(c.lab[1], c.lab[2]) });
    c.h = ((Math.atan2(c.lab[2], c.lab[1]) * 180) / Math.PI + 360) % 360;
    const saturation = c.C / Math.max(c.L, 0.05);
    let tier = SATURATION_TIERS.findIndex((min) => saturation >= min);
    if (tier < 0) tier = tiers - 1;
    families[familyOf(c)][tier].push(c);
  }
  const rows = [];
  for (const family of families) {
    // merge tiny rows into the neighbouring row (towards the middle tier)
    for (let t = 0; t < tiers; t++) {
      const row = family[t];
      if (!row.length || row.length >= MIN_ROW) continue;
      const target = [t + 1, t - 1, t + 2, t - 2].find((n) => n >= 0 && n < tiers && family[n].length);
      if (target === undefined) continue;
      family[target].push(...row);
      family[t] = [];
    }
    for (const row of family) if (row.length) rows.push(smoothRow(row).map((c) => c.k));
  }
  return rows;
}

/**
 * mode: "num" (palette number), "cnt" (most cells first), "col" (color families).
 * counts: cells per color (for "cnt"). Returns palette indices in display order.
 */
export function paletteOrder(pal, mode, counts) {
  const K = pal.length / 3;
  const order = [...Array(K).keys()];
  if (mode === "cnt") return order.sort((i, j) => counts[j] - counts[i] || i - j);
  if (mode === "col") return colorFamilies(pal).flat();
  return order;
}
