// Palette ordering for the color picker. Pure functions (tested in tests/colorsort.test.js).
//
// "By color" = one continuous strip through the color families in rainbow order, built so that neighbours
// differ as little as possible:
//   dark red -> light red -> light orange -> dark orange -> dark yellow -> ... and so on, grays last.
// 1. Every color gets a hue angle in OKLCH (a hue scale where equal steps look equally different); the angle
//    decides the family (red, orange/brown, yellow, green, teal, blue, purple, magenta). Colors with no usable
//    hue (grays, near-black, near-white) form their own family.
// 2. The borders between families are not fixed: each one slides (within limits) to where the palette has the
//    fewest colors, so a tight group of similar colors is never cut in two.
// 3. A family with only a couple of colors joins the family that holds its nearest color: a lone color between
//    two big families would be a jump on both sides.
// 4. Inside a family the order is the shortest path from its darkest to its lightest color (OKLab distance):
//    vivid and muted shades of one hue come as separate runs instead of alternating.
// 5. Families are chained as a snake (dark -> light, then light -> dark, ...); which way each one runs is
//    chosen so that the jumps between families are as small as possible.

/** OKLCH chroma below which a color counts as gray (no usable hue). */
const GRAY_CHROMA = 0.02;
/** Near-black and near-white colors have an unreliable hue at higher chroma too. */
const isNeutral = (c) => c.C < GRAY_CHROMA || (c.L < 0.25 && c.C < 0.045) || (c.L > 0.94 && c.C < 0.03);
/** A family with fewer colors than this (or than 2.5% of the palette) is merged into the family of its nearest color. */
const MIN_FAMILY = 4;
/** ...but only if every one of its colors has a color this close (OKLab distance) in another family. */
const MERGE_REACH = 0.1;
/** How far (degrees) a family border may slide from its nominal hue. */
const BORDER_SLACK = 14;

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

/** Distance between two OKLab colors. */
const labDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Family borders for this palette: each nominal border moves to the emptiest hue within BORDER_SLACK degrees
 * (colors counted in a +-6 degree window; on a tie the hue closest to the nominal border wins).
 */
function familyBorders(colors) {
  const density = new Float32Array(360);
  for (const c of colors) for (let d = -6; d <= 6; d++) density[(Math.round(c.h) + d + 720) % 360] += 1;
  return FAMILIES.map(([, from]) => {
    let best = from;
    for (let d = 1; d <= BORDER_SLACK; d++)
      for (const h of [from - d, from + d]) if (density[(h + 360) % 360] < density[(best + 360) % 360] - 1e-6) best = h;
    return (best + 360) % 360;
  });
}

/**
 * Orders one family as the shortest path from its darkest color to its lightest one: greedy nearest-neighbour
 * path, then improved by reversing stretches (2-opt) and moving single colors (or-opt) while that shortens it.
 * The ends stay fixed, so the family still reads dark -> light.
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
    // 2-opt: reverse path[i..j]
    for (let i = 1; i < n - 2; i++)
      for (let j = i + 1; j < n - 1; j++) {
        const before = d(path[i - 1], path[i]) + d(path[j], path[j + 1]);
        const after = d(path[i - 1], path[j]) + d(path[i], path[j + 1]);
        if (after < before - 1e-9) {
          for (let a = i, b = j; a < b; a++, b--) [path[a], path[b]] = [path[b], path[a]];
          improved = true;
        }
      }
    // or-opt: take path[i] out and put it between path[j] and path[j + 1]
    for (let i = 1; i < n - 1; i++) {
      const saved = d(path[i - 1], path[i]) + d(path[i], path[i + 1]) - d(path[i - 1], path[i + 1]);
      let bestGain = 1e-9;
      let bestAt = -1;
      for (let j = 0; j < n - 1; j++) {
        if (j === i || j === i - 1) continue;
        const added = d(path[j], path[i]) + d(path[i], path[j + 1]) - d(path[j], path[j + 1]);
        if (saved - added > bestGain) {
          bestGain = saved - added;
          bestAt = j;
        }
      }
      if (bestAt < 0) continue;
      const [moved] = path.splice(i, 1);
      path.splice(bestAt < i ? bestAt + 1 : bestAt, 0, moved);
      improved = true;
    }
    if (!improved) break;
  }
  return path.map((i) => row[i]);
}

/**
 * Colors grouped into families in rainbow order (grays last); every family runs from its darkest to its
 * lightest color along the smoothest path. Returns arrays of palette indices.
 */
export function colorFamilies(pal) {
  const K = pal.length / 3;
  const colors = [];
  for (let k = 0; k < K; k++) {
    const lab = toOklab(pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]);
    const c = { k, lab, L: lab[0], C: Math.hypot(lab[1], lab[2]) };
    c.h = ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360;
    colors.push(c);
  }
  const chromatic = colors.filter((c) => !isNeutral(c));
  const borders = familyBorders(chromatic);
  const families = Array.from({ length: FAMILIES.length + 1 }, () => []);
  for (const c of colors) {
    if (isNeutral(c)) {
      families[FAMILIES.length].push(c);
      continue;
    }
    // the family whose border is the last one at or before this hue, going around the circle from the first border
    const turn = (c.h - borders[0] + 360) % 360;
    let f = 0;
    for (let i = 1; i < borders.length; i++) if (turn >= (borders[i] - borders[0] + 360) % 360) f = i;
    families[f].push(c);
  }
  // A tiny family joins the family that holds its nearest color, if that color is close: a few muted shades
  // whose hue happens to fall in another family then sit among the colors they resemble. A small family of
  // colors unlike anything else (the only green in the picture) stays where the rainbow puts it.
  const minFamily = Math.max(MIN_FAMILY, Math.round(K * 0.025));
  const nearestOutside = (c, own) => {
    let best = -1;
    let bestD = Infinity;
    for (let f = 0; f < families.length; f++) {
      if (f === own) continue;
      for (const other of families[f]) {
        const dd = labDistance(c.lab, other.lab);
        if (dd < bestD) {
          bestD = dd;
          best = f;
        }
      }
    }
    return [best, bestD];
  };
  const settled = new Set(); // tiny families that stay
  for (;;) {
    let tiny = -1;
    for (let f = 0; f < families.length; f++) {
      const size = families[f].length;
      if (size && size < minFamily && !settled.has(f) && (tiny < 0 || size < families[tiny].length)) tiny = f;
    }
    if (tiny < 0) break;
    const moves = families[tiny].map((c) => nearestOutside(c, tiny));
    if (moves.some(([f, d]) => f < 0 || d > MERGE_REACH)) {
      settled.add(tiny);
      continue;
    }
    families[tiny].forEach((c, n) => families[moves[n][0]].push(c));
    families[tiny] = [];
  }
  return families.filter((f) => f.length).map((f) => smoothRow(f).map((c) => c.k));
}

/**
 * Chains the families into one strip: every family runs either dark -> light or light -> dark, and the
 * directions are chosen (exactly, by dynamic programming) so that the jumps between families add up to the least.
 */
function chainFamilies(pal, rows) {
  if (rows.length < 2) return rows.flat();
  const lab = (k) => toOklab(pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]);
  // ends[r] = [first color, last color] of row r as stored (dark, light)
  const ends = rows.map((row) => [lab(row[0]), lab(row[row.length - 1])]);
  // cost[r][o]: least total jump up to row r when it runs forward (o = 0) or reversed (o = 1)
  const cost = [[0, 0]];
  const from = [[0, 0]];
  for (let r = 1; r < rows.length; r++) {
    cost.push([0, 0]);
    from.push([0, 0]);
    for (let o = 0; o < 2; o++) {
      const head = ends[r][o]; // the color this row starts with
      let best = Infinity;
      for (let prev = 0; prev < 2; prev++) {
        const tail = ends[r - 1][1 - prev]; // the color the previous row ends with
        const v = cost[r - 1][prev] + labDistance(tail, head);
        if (v < best) {
          best = v;
          from[r][o] = prev;
        }
      }
      cost[r][o] = best;
    }
  }
  const last = rows.length - 1;
  // on a tie prefer the strip that starts dark -> light
  let o = cost[last][1] < cost[last][0] - 1e-9 ? 1 : 0;
  const reversed = new Array(rows.length);
  for (let r = last; r >= 0; r--) {
    reversed[r] = o;
    o = from[r][o];
  }
  return rows.flatMap((row, r) => (reversed[r] ? [...row].reverse() : row));
}

/**
 * mode: "num" (palette number), "cnt" (most cells first), "col" (color families).
 * counts: cells per color (for "cnt"). Returns palette indices in display order.
 */
export function paletteOrder(pal, mode, counts) {
  const K = pal.length / 3;
  const order = [...Array(K).keys()];
  if (mode === "cnt") return order.sort((i, j) => counts[j] - counts[i] || i - j);
  if (mode === "col") return chainFamilies(pal, colorFamilies(pal));
  return order;
}
