// Tests for the pure pixelization functions. Run: npm test   (needs Node 18+)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boxScale,
  applyAdjustments,
  NO_ADJUST,
  samplePixels,
  kmeansFit,
  quantize,
  removeSpecks,
  finalizePalette,
  generate,
  suggestColorCount,
  MODES,
  normalizeParams,
  pickCellColors,
  smoothFlat,
  settle,
  cleanPalette,
  ditherRamps,
  smoothGradients,
  srgbToLab,
  unifyLines,
} from "../js/engine.js";

/** RGBA image filled by fn(x, y) -> [r, g, b]. */
function image(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  return { data, width, height };
}

test("boxScale averages every source pixel under an output pixel", () => {
  // 2x2 checkerboard of black/white -> one gray pixel
  const src = image(2, 2, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0]));
  const out = boxScale(src, 1, 1);
  assert.ok(Math.abs(out[0] - 127.5) <= 1);
  assert.equal(out[3], 255);
});

test("boxScale handles non-integer ratios without losing brightness", () => {
  const src = image(7, 5, () => [200, 100, 50]);
  const out = boxScale(src, 3, 2);
  for (let i = 0; i < out.length; i += 4) assert.deepEqual([...out.subarray(i, i + 3)], [200, 100, 50]);
});

test("applyAdjustments with neutral settings changes nothing", () => {
  const src = image(4, 4, (x, y) => [x * 60, y * 60, 90]);
  const copy = new Uint8ClampedArray(src.data);
  applyAdjustments(src.data, 4, 4, NO_ADJUST);
  assert.deepEqual(src.data, copy);
});

test("applyAdjustments: saturation 0 makes gray", () => {
  const src = image(1, 1, () => [200, 50, 50]);
  applyAdjustments(src.data, 1, 1, { ...NO_ADJUST, sat: 0 });
  assert.equal(src.data[0], src.data[1]);
  assert.equal(src.data[1], src.data[2]);
});

test("kmeansFit finds the clear clusters and is deterministic", async () => {
  // three flat colors
  const colors = [
    [230, 30, 30],
    [30, 200, 40],
    [20, 40, 220],
  ];
  const src = image(30, 30, (x) => colors[Math.floor(x / 10)]);
  const sample = samplePixels(src.data, 900, 900);
  const a = await kmeansFit(sample, 3, 8);
  const b = await kmeansFit(sample, 3, 8);
  assert.deepEqual(a.palette, b.palette);
  const found = [];
  for (let k = 0; k < 3; k++) found.push([...a.palette.subarray(k * 3, k * 3 + 3)].join());
  for (const c of colors) assert.ok(found.includes(c.join()), `missing ${c}`);
  assert.ok(a.error < 0.01);
});

test("quantize maps pixels to the nearest palette color", async () => {
  const pal = new Float32Array([0, 0, 0, 255, 255, 255]);
  const src = image(4, 1, (x) => [x * 80, x * 80, x * 80]); // 0, 80, 160, 240
  const idx = await quantize(src.data, 4, 1, pal, 2);
  assert.deepEqual([...idx], [0, 0, 1, 1]);
});

test("quantize stops when the job is cancelled", async () => {
  const pal = new Float32Array([0, 0, 0, 255, 255, 255]);
  const src = image(10, 200, () => [10, 10, 10]);
  const idx = await quantize(src.data, 10, 200, pal, 2, false, { pause: async () => false, progress() {} });
  assert.equal(idx, null);
});

test("removeSpecks merges regions smaller than the limit into a neighbour", () => {
  // 5x5 of color 0 with a single cell of color 1 in the middle
  const idx = new Uint16Array(25);
  idx[12] = 1;
  removeSpecks(idx, 5, 5, 2, new Uint8Array([0, 0, 0, 250, 250, 250]));
  assert.equal(idx[12], 0);
});

test("removeSpecks keeps regions at the limit", () => {
  const idx = new Uint16Array(25);
  idx[12] = idx[13] = 1; // 2-cell region
  removeSpecks(idx, 5, 5, 2, new Uint8Array([0, 0, 0, 250, 250, 250]));
  assert.equal(idx[12], 1);
});

test("finalizePalette drops unused colors and numbers them dark to light", () => {
  const pal = new Float32Array([255, 255, 255, 50, 50, 50, 128, 0, 0]); // white, dark gray (unused), red
  const idx = new Uint16Array([0, 2, 2, 0]);
  const out = finalizePalette(idx, pal, 3);
  assert.equal(out.length, 6); // 2 colors
  assert.deepEqual([...out.subarray(0, 3)], [128, 0, 0]); // red is darker -> number 1
  assert.deepEqual([...idx], [1, 0, 0, 1]);
});

test("removeSpecks leaves a small island alone when it clearly stands out", () => {
  const idx = new Uint16Array(25);
  idx[12] = 1; // white dot on black: an eye highlight, not noise
  removeSpecks(idx, 5, 5, 3, new Uint8Array([0, 0, 0, 250, 250, 250]), 8);
  assert.equal(idx[12], 1);
  const dull = new Uint16Array(25);
  dull[12] = 1; // nearly the same gray: noise
  removeSpecks(dull, 5, 5, 3, new Uint8Array([100, 100, 100, 104, 104, 104]), 8);
  assert.equal(dull[12], 0);
});

test("removeSpecks treats a thin diagonal line as one region, not as separate specks", () => {
  const idx = new Uint16Array(36);
  for (let k = 0; k < 6; k++) idx[k * 6 + k] = 1; // diagonal of faintly different cells
  removeSpecks(idx, 6, 6, 3, new Uint8Array([100, 100, 100, 108, 108, 108]), 8);
  for (let k = 0; k < 6; k++) assert.equal(idx[k * 6 + k], 1);
});

test("ditherRamps interlocks two similar colors along their border and leaves a real edge alone", () => {
  // left half color 0, right half color 1; the real colors form a smooth ramp, so border cells are "halfway"
  const W = 8;
  const H = 6;
  const src = image(W, H, (x) => [101 + x * 2, 101 + x * 2, 101 + x * 2]);
  const similar = new Float32Array([104, 104, 104, 112, 112, 112]);
  const idx = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) idx[i] = i % W < 4 ? 0 : 1;
  ditherRamps(idx, src.data, W, H, similar, 2, 0.2);
  let switched = 0;
  for (let y = 0; y < H; y++) {
    if (idx[y * W + 3] === 1) switched++;
    if (idx[y * W + 4] === 0) switched++;
    assert.equal(idx[y * W + 1], 0); // cells away from the border are untouched
    assert.equal(idx[y * W + 6], 1);
  }
  assert.equal(switched, H); // one tooth per row, alternating sides

  const different = new Float32Array([20, 20, 20, 230, 230, 230]);
  const hard = new Uint16Array(W * H);
  for (let i = 0; i < W * H; i++) hard[i] = i % W < 4 ? 0 : 1;
  ditherRamps(hard, src.data, W, H, different, 2, 0.2);
  for (let i = 0; i < W * H; i++) assert.equal(hard[i], i % W < 4 ? 0 : 1);
});

test("quantize with dithering mixes two colors for an in-between shade and never uses a far-off one", async () => {
  const pal = new Float32Array([100, 100, 100, 120, 120, 120, 250, 20, 20]); // two grays and a red
  const src = image(40, 40, () => [110, 110, 110]);
  const idx = await quantize(src.data, 40, 40, pal, 3, true);
  const counts = [0, 0, 0];
  for (const v of idx) counts[v]++;
  assert.equal(counts[2], 0);
  assert.ok(Math.abs(counts[0] - counts[1]) < 200, `${counts}`); // about half and half
});

test("pickCellColors: a border cell takes one side's color, not a mix", () => {
  // 3 sub-samples per cell; the border between red and blue runs through the middle column of cells
  const red = [220, 40, 40];
  const blue = [30, 40, 200];
  const src = image(9, 9, (x) => (x < 4 ? red : blue)); // cell 1 holds 1 red column and 2 blue ones
  const out = pickCellColors(src.data, 3, 3, 3);
  for (let y = 0; y < 3; y++) {
    assert.deepEqual([...out.subarray((y * 3 + 0) * 4, (y * 3 + 0) * 4 + 3)], red);
    assert.deepEqual([...out.subarray((y * 3 + 1) * 4, (y * 3 + 1) * 4 + 3)], blue);
    assert.deepEqual([...out.subarray((y * 3 + 2) * 4, (y * 3 + 2) * 4 + 3)], blue);
  }
});

test("pickCellColors keeps a thin dark line as an unbroken one-cell line", () => {
  // 4 sub-samples per cell, a 2-sample-wide black line on white: straddling cells 2 and 3 (1 sample each side
  // would be lost by "bigger group wins"; here the line sits 1 sample in cell 2 and 1 in cell 3)
  const src = image(24, 24, (x) => (x === 11 || x === 12 ? [10, 10, 10] : [240, 240, 240]));
  const out = pickCellColors(src.data, 6, 6, 4);
  for (let y = 0; y < 6; y++) {
    const dark = [];
    // (half a cell wide: drawn lighter than its ink, see the next test, but clearly a line)
    for (let x = 0; x < 6; x++) if (out[(y * 6 + x) * 4] < 160) dark.push(x);
    assert.equal(dark.length, 1, `row ${y}: ${dark}`);
    assert.ok(dark[0] === 2 || dark[0] === 3);
  }
});

test("pickCellColors averages a soft gradient instead of picking a side", () => {
  const src = image(16, 4, (x) => [x * 16, x * 16, x * 16]);
  const out = pickCellColors(src.data, 4, 1, 4);
  for (let x = 0; x < 4; x++) assert.ok(Math.abs(out[x * 4] - (x * 4 + 1.5) * 16) <= 4, `cell ${x}: ${out[x * 4]}`);
});

test("pickCellColors: a thin line is drawn lighter than its ink, by how little of its cells it covers", () => {
  // 4 sub-samples per cell side; a dark red line one sample wide plus a half-tone rim on each side: it darkens
  // its cells about half way. Drawn as a full cell of ink it looked far heavier than in the picture.
  const line = image(40, 40, (x) =>
    x === 18 ? [60, 20, 20] : x === 17 || x === 19 ? [150, 120, 110] : [240, 220, 200],
  );
  const out = pickCellColors(line.data, 10, 10, 4);
  for (let y = 2; y < 8; y++) {
    const i = (y * 10 + 4) * 4;
    const [r, g, b] = [out[i], out[i + 1], out[i + 2]];
    assert.ok(r > 85 && r < 160, `cell 4,${y}: ${r},${g},${b} (between ink and paper)`);
    assert.ok(r - g > 25 && r - b > 25, `cell 4,${y}: ${r},${g},${b} (still red)`);
  }
  // a line as wide as a cell keeps its full ink
  const wide = image(40, 40, (x) => (x >= 16 && x < 20 ? [60, 20, 20] : [240, 220, 200]));
  const full = pickCellColors(wide.data, 10, 10, 4);
  for (let y = 2; y < 8; y++) {
    const i = (y * 10 + 4) * 4;
    assert.ok(full[i] < 85 && full[i + 1] < 45, `wide line, cell 4,${y}: ${full[i]},${full[i + 1]}`);
  }
});

test("pickCellColors: a highlight inside a small dark iris stays light; the gap between two dark lines is no line", () => {
  // a dark disk (radius 6 samples) with a white dot (2 x 2 samples) in it, on skin
  const iris = image(40, 40, (x, y) => {
    const d = Math.hypot(x - 20, y - 20);
    if (x >= 19 && x <= 20 && y >= 17 && y <= 18) return [255, 255, 255];
    return d < 6 ? [40, 40, 90] : [240, 220, 200];
  });
  const a = pickCellColors(iris.data, 10, 10, 4);
  const lightest = Math.max(...[4, 5].flatMap((y) => [4, 5].map((x) => a[(y * 10 + x) * 4 + 1])));
  assert.ok(lightest > 150, `highlight cell: ${lightest}`);
  // two dark lines 3 samples apart on skin: the skin between them is no light line
  const lines = image(40, 40, (x) => (x === 16 || x === 20 ? [60, 30, 30] : [240, 220, 200]));
  const out = pickCellColors(lines.data, 10, 10, 4);
  assert.ok(out.lines, "has lines");
  for (let y = 2; y < 8; y++)
    for (let x = 3; x < 6; x++) {
      const i = y * 10 + x;
      if (!out.lines[i]) continue;
      assert.ok(out[i * 4] < 180, `cell ${x},${y} is a light line: ${out[i * 4]},${out[i * 4 + 1]}`);
    }
});

test("pickCellColors: hatching finer than the grid keeps its average tone instead of one of its colors", () => {
  // 4 sub-samples per cell side; vertical stripes 3 samples red, 2 samples white: every cell holds both
  const src = image(40, 40, (x) => (x % 5 < 3 ? [200, 40, 40] : [250, 240, 240]));
  const out = pickCellColors(src.data, 10, 10, 4);
  for (let y = 2; y < 8; y++)
    for (let x = 2; x < 8; x++) {
      const r = out[(y * 10 + x) * 4];
      const g = out[(y * 10 + x) * 4 + 1];
      assert.ok(r > 205 && g > 80 && g < 200, `cell ${x},${y}: ${r},${g}`); // a mix, not pure red or white
    }
});

test("enhance removes compression speckle but keeps an edge sharp", () => {
  // two flat areas with +-6 speckle, meeting at a hard edge
  const src = image(20, 10, (x, y) => {
    const base = x < 10 ? 60 : 200;
    const noise = ((x * 7 + y * 13) % 3) * 6 - 6;
    return [base + noise, base + noise, base + noise];
  });
  applyAdjustments(src.data, 20, 10, { ...NO_ADJUST, enh: 5 });
  const at = (x, y) => src.data[(y * 20 + x) * 4];
  for (let y = 2; y < 8; y++) {
    assert.ok(Math.abs(at(4, y) - 60) <= 3, `left ${at(4, y)}`);
    assert.ok(Math.abs(at(15, y) - 200) <= 3, `right ${at(15, y)}`);
    assert.ok(at(9, y) < 90 && at(10, y) > 170, `edge ${at(9, y)} ${at(10, y)}`);
  }
});

test("smoothFlat flattens weak noise but does not blur a real border", () => {
  const src = image(12, 6, (x, y) => (x < 6 ? [100 + ((x + y) % 2) * 4, 100, 100] : [200, 100, 100]));
  const out = smoothFlat(src.data, 12, 6, 3);
  assert.ok(Math.abs(out[(2 * 12 + 2) * 4] - 102) <= 1); // noise averaged
  assert.equal(out[(2 * 12 + 8) * 4], 200); // other side untouched
  assert.ok(out[(2 * 12 + 5) * 4] < 106); // cell right at the border did not pick up the other side
});

test("settle moves a noise dot to its surroundings and keeps a dot that really differs", () => {
  const pal = new Float32Array([100, 100, 100, 104, 104, 104, 250, 250, 250]);
  const src = image(5, 5, () => [102, 102, 102]);
  src.data.set([250, 250, 250, 255], 18 * 4);
  const idx = new Uint16Array(25);
  idx[12] = 1; // cell 12 is really 102 gray: as close to color 0 as to color 1
  idx[18] = 2; // cell 18 is really white
  settle(idx, src.data, 5, 5, pal, 3, 3);
  assert.equal(idx[12], 0);
  assert.equal(idx[18], 2);
});

test("cleanPalette merges look-alike colors and colors used by a couple of cells", () => {
  // 0: gray, 1: nearly the same gray, 2: a slightly different gray used by one cell, 3: red used by one cell
  const pal = new Float32Array([100, 100, 100, 101, 100, 100, 110, 110, 110, 230, 30, 30]);
  const idx = new Uint16Array(100).fill(0);
  idx.fill(1, 50, 98);
  idx[98] = 2;
  idx[99] = 3;
  cleanPalette(idx, pal, 4, 2);
  assert.equal(idx[60], idx[0]); // look-alikes merged
  assert.equal(idx[98], idx[0]); // tiny color joined its close neighbour
  assert.equal(idx[99], 3); // tiny color that stands out stays
});

test("normalizeParams maps settings of older versions", () => {
  assert.equal(normalizeParams({ style: "klines", denoise: 2, specks: 3 }).style, "art");
  assert.equal(normalizeParams({ style: "fs" }).style, "dither");
  assert.equal(normalizeParams({ style: "photo", clean: 7 }).clean, 7);
  const old = normalizeParams({ style: "smooth", denoise: 5, specks: 12 }).clean;
  assert.ok(old >= 0 && old <= 10);
});

test("generate works for every mode", async () => {
  const src = image(64, 48, (x, y) => [x * 4, y * 5, (x * y) % 255]);
  for (const style of [...MODES, "klines"]) {
    const r = await generate(src, { width: 32, height: 24, colors: 12, style, clean: 2 }, NO_ADJUST);
    assert.equal(r.idx.length, 32 * 24, style);
    const K = r.pal.length / 3;
    assert.ok(K >= 2 && K <= 12, `${style}: ${K} colors`);
    for (const v of r.idx) assert.ok(v < K, style);
  }
});

test("suggestColorCount: few colors for a flat image, more for a detailed one, not the maximum for a simple one", async () => {
  const params = { width: 60, height: 60, style: "photo", clean: 0 };
  const maxK = Math.floor((60 * 60) / 12);
  const flat = image(60, 60, (x) => (x < 30 ? [200, 40, 40] : [40, 40, 200]));
  const ramp = image(120, 120, (x) => [x * 2, 60, 90]); // one smooth gradient
  const detailed = image(120, 120, (x, y) => [x * 2, y * 2, 100]); // 2D gradient: needs many colors
  const a = await suggestColorCount(flat, params, NO_ADJUST);
  const b = await suggestColorCount(ramp, params, NO_ADJUST);
  const c = await suggestColorCount(detailed, params, NO_ADJUST);
  assert.ok(a <= 16, `flat: ${a}`);
  assert.ok(b > a && b < maxK, `ramp: ${b} (max ${maxK})`);
  assert.ok(c > b, `detailed: ${c}`);
});

test("suggestColorCount: texture noise does not run the count up to the maximum", async () => {
  // two areas with strong pixel noise (a scan, a JPEG of skin): the noise is not worth colors of its own
  const params = { width: 60, height: 60, style: "photo", clean: 0 };
  const maxK = Math.floor((60 * 60) / 12);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const noisy = image(60, 60, (x) => {
    const n = rnd() * 14;
    return x < 30 ? [200 + n, 120 + n, 100 + n] : [60 + n, 90 + n, 160 + n];
  });
  const k = await suggestColorCount(noisy, params, NO_ADJUST);
  assert.ok(k <= maxK / 2, `noisy: ${k} (max ${maxK})`);
});

test("pickCellColors: a thin slanted anti-aliased line becomes one unbroken one-cell line of one color", () => {
  // 4 samples per cell; a dark line 1.5 samples wide, slanted, anti-aliased, on light skin
  const k = 4;
  const W = 20;
  const H = 20;
  const src = image(W * k, H * k, (x, y) => {
    const center = 10 + y * 0.45; // in samples
    const cover = Math.max(0, Math.min(1, 0.75 + 0.5 - Math.abs(x + 0.5 - center)));
    const v = (c, line) => Math.round(c * (1 - cover) + line * cover);
    return [v(250, 30), v(225, 20), v(210, 25)];
  });
  const out = pickCellColors(src.data, W, H, k);
  // (1.5 samples of 4 wide: drawn lighter than its ink, but well apart from the skin)
  const dark = (x, y) => out[(y * W + x) * 4] < 170;
  for (let y = 1; y < H - 1; y++) {
    const row = [];
    for (let x = 0; x < W; x++) if (dark(x, y)) row.push(x);
    assert.ok(row.length >= 1 && row.length <= 2, `row ${y}: ${row}`); // never broken, at most a step
    // connected to the next row (8-neighbours)
    const next = [];
    for (let x = 0; x < W; x++) if (dark(x, y + 1)) next.push(x);
    assert.ok(
      row.some((a) => next.some((b) => Math.abs(a - b) <= 1)),
      `rows ${y}-${y + 1}: ${row} / ${next}`,
    );
  }
  // the line keeps one color along its length (no paler cells where it only grazes a cell)
  const reds = [];
  for (let i = 0; i < W * H; i++) if (out[i * 4] < 170) reds.push(out[i * 4]);
  assert.ok(Math.max(...reds) - Math.min(...reds) <= 25, `line colors ${Math.min(...reds)}..${Math.max(...reds)}`);
  // cells beside the line keep the skin color: no half-line shades
  for (let i = 0; i < W * H; i++) {
    const r = out[i * 4];
    assert.ok(r < 170 || r > 235, `cell ${i % W},${(i / W) | 0}: ${r}`);
  }
});

test("pickCellColors: an anti-aliased border between two flat areas gets no in-between cells", () => {
  // 3 samples per cell (few, so a blended border cell looks like a gradient); a slanted border, anti-aliased
  const k = 3;
  const W = 12;
  const H = 12;
  const src = image(W * k, H * k, (x, y) => {
    const t = Math.max(0, Math.min(1, x - (8 + y * 0.6) + 0.5));
    return [Math.round(230 * (1 - t) + 40 * t), Math.round(220 * (1 - t) + 30 * t), Math.round(225 * (1 - t) + 60 * t)];
  });
  const out = pickCellColors(src.data, W, H, k);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const r = out[(y * W + x) * 4];
      assert.ok(r < 60 || r > 210, `cell ${x},${y}: ${r}`);
    }
});

test("smoothGradients flattens noise inside a soft gradient but leaves a border alone", () => {
  const W = 20;
  const H = 6;
  const noise = (x, y) => ((x * 7 + y * 13) % 5) - 2;
  const src = image(W, H, (x, y) => (x < 10 ? [100 + x * 2 + noise(x, y), 120, 140] : [230, 60, 60]));
  const out = smoothGradients(src.data, W, H, 36);
  // inside the gradient: the noise is averaged away (neighbouring cells differ by about the slope only)
  for (let x = 3; x < 6; x++) {
    const d = out[(2 * W + x + 1) * 4] - out[(2 * W + x) * 4];
    assert.ok(d >= 0 && d <= 4, `cells ${x}-${x + 1}: ${d}`);
  }
  // near the border nothing is mixed
  assert.equal(out[(2 * W + 12) * 4], 230);
  assert.ok(out[(2 * W + 9) * 4] < 130);
});

/** "Important" marks for a W x H source: 255 where fn(x, y) is true. */
function marks(width, height, fn) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fn(x, y) ? 255 : 0;
  return { data, width, height };
}

test("marked cells keep a small highlight that the clean-up would smooth away", async () => {
  const W = 60;
  const H = 60;
  for (const style of ["photo", "art"])
    for (const d of [4, 14, 24]) {
      // a soft skin-like gradient with a 2-cell highlight a little lighter; the marks are coarser than the cells
      const src = image(W, H, (x, y) =>
        (x === 30 || x === 31) && y === 30 ? [200 + d, 160 + d, 140 + d] : [170 + x * 0.5, 130 + y * 0.5, 110],
      );
      src.mask = marks(30, 30, (x, y) => Math.abs(x - 15) < 3 && Math.abs(y - 15) < 3);
      const r = await generate(src, { width: W, height: H, colors: 24, style, clean: 3 }, NO_ADJUST);
      const c = r.idx[30 * W + 30];
      const around = [r.idx[30 * W + 28], r.idx[30 * W + 33], r.idx[28 * W + 30], r.idx[32 * W + 30]];
      assert.ok(!around.includes(c), `${style}, +${d}: the highlight took the color around it`);
    }
});

test("marked cells get more of the palette; Auto colors never drops because of marks", async () => {
  const W = 60;
  const H = 60;
  const inside = (x, y) => x >= 40 && x < 48 && y >= 10 && y < 18;
  // a big two-way gradient and a small detail with a gradient of its own
  const src = image(W, H, (x, y) =>
    inside(x, y)
      ? [200, 120 + (x - 40) * 6, 160 + (y - 10) * 6]
      : [Math.round(40 + x * 3), Math.round(60 + y * 2.5), 90],
  );
  const marked = { ...src, mask: marks(W, H, inside) };
  const params = { width: W, height: H, colors: 16, style: "photo", clean: 3 };
  const used = (r) => {
    const set = new Set();
    for (let y = 10; y < 18; y++) for (let x = 40; x < 48; x++) set.add(r.idx[y * W + x]);
    return set.size;
  };
  const plain = used(await generate(src, params, NO_ADJUST));
  const focused = used(await generate(marked, params, NO_ADJUST));
  assert.ok(focused > plain, `detail colors: ${plain} without marks, ${focused} with`);
  const auto = await suggestColorCount(src, params, NO_ADJUST);
  const autoMarked = await suggestColorCount(marked, params, NO_ADJUST);
  assert.ok(autoMarked >= auto, `auto: ${auto} without marks, ${autoMarked} with`);
});

test("a small detail in a color of its own keeps it (rescueRareColors): a blue iris does not turn gray", async () => {
  const W = 300;
  const H = 300;
  // a big smooth gradient takes the palette, evenly; 2x2 cells of saturated blue are found nowhere else
  // (and fall between the cells the palette search samples)
  const eye = (x, y) => x >= 150 && x < 152 && y >= 100 && y < 102;
  const src = image(W, H, (x, y) => (eye(x, y) ? [40, 120, 230] : [230 - x * 0.4, 190 - x * 0.35, 170 - y * 0.3]));
  for (const style of ["art", "photo"]) {
    const r = await generate(src, { width: W, height: H, colors: 64, style, clean: 3 }, NO_ADJUST);
    const k = r.idx[100 * W + 150];
    const lab = new Float32Array(6);
    srgbToLab(40, 120, 230, lab, 0);
    srgbToLab(r.pal[k * 3], r.pal[k * 3 + 1], r.pal[k * 3 + 2], lab, 3);
    const d = Math.hypot(lab[0] - lab[3], lab[1] - lab[4], lab[2] - lab[5]);
    assert.ok(d < 10, `${style}: the blue cells got rgb(${r.pal.slice(k * 3, k * 3 + 3)}), ΔE ${d.toFixed(1)}`);
    assert.ok(r.pal.length / 3 <= 64, `${style}: ${r.pal.length / 3} colors`);
  }
});

test("unifyLines: one outline gets one number, a line of another color keeps its own", () => {
  const W = 40;
  const H = 3;
  const rgba = new Uint8ClampedArray(W * H * 4).fill(235); // light background
  const ink = new Uint8Array(W * H);
  // the middle row is a line: 30 cells of two close dark shades, mixed, then 10 cells of red
  const shade = (x) => (x % 3 ? [40, 34, 38] : [52, 44, 50]);
  for (let x = 0; x < W; x++) {
    const i = W + x;
    const c = x < 30 ? shade(x) : [190, 30, 40];
    rgba.set([...c, 255], i * 4);
    ink[i] = 1;
  }
  const pal = [235, 235, 235, 40, 34, 38, 52, 44, 50, 190, 30, 40];
  const idx = new Uint16Array(W * H);
  for (let x = 0; x < W; x++) idx[W + x] = x < 30 ? (x % 3 ? 1 : 2) : 3;
  unifyLines(idx, rgba, W, H, pal, 4, ink);
  const dark = new Set(Array.from(idx.slice(W, W + 30)));
  assert.equal(dark.size, 1, `the dark part has ${dark.size} numbers`);
  assert.ok(
    Array.from(idx.slice(W + 30, W + 40)).every((k) => k === 3),
    "the red part stays red",
  );
  assert.ok(
    Array.from(idx.slice(0, W)).every((k) => k === 0),
    "the background is not touched",
  );
  // cells marked "important" keep their own number
  const marked = new Uint16Array(W * H);
  for (let x = 0; x < W; x++) marked[W + x] = x < 30 ? (x % 3 ? 1 : 2) : 3;
  const focus = new Uint8Array(W * H);
  for (let x = 0; x < 10; x++) focus[W + x] = 255;
  unifyLines(marked, rgba, W, H, pal, 4, ink, focus);
  for (let x = 0; x < 10; x++) assert.equal(marked[W + x], x % 3 ? 1 : 2, `marked cell ${x}`);
});

test("removeSpecks: a lone cell merges a little more readily than a bigger speck, a clearly different one stays", () => {
  const W = 9;
  const H = 9;
  const pal = [128, 128, 128, 148, 148, 148, 200, 200, 200]; // gray; ~7.6 ΔE lighter; ~27 ΔE lighter
  const make = () => new Uint16Array(W * H);
  // a lone cell ~7.6 ΔE off: over the speck limit (5.4 at clean 3), under the lone-cell one
  let idx = make();
  idx[4 * W + 4] = 1;
  idx[1 * W + 1] = 2;
  removeSpecks(idx, W, H, 2, pal, 5.4, null, 5.4 * 1.8);
  assert.equal(idx[4 * W + 4], 0, "the lone light-gray cell joins the gray around it");
  assert.equal(idx[1 * W + 1], 2, "the much lighter cell (a highlight) stays");
  // two touching cells of that color are not a lone cell: they stay
  idx = make();
  idx[4 * W + 4] = idx[4 * W + 5] = 1;
  removeSpecks(idx, W, H, 2, pal, 5.4, null, 5.4 * 1.8);
  assert.equal(idx[4 * W + 4], 1);
});

test("black-and-white pictures: exact grays, and enough of them for smooth shading", async () => {
  // soft gray shading with faint JPEG-like tints
  const src = image(150, 150, (x, y) => {
    const v = Math.round(30 + x * 1.3 + y * 0.2);
    return [v + (x % 3) - 1, v, v + ((x + y) % 3) - 1];
  });
  const params = { width: 150, height: 150, colors: 32, style: "art", clean: 3 };
  const r = await generate(src, params, NO_ADJUST);
  for (let k = 0; k < r.pal.length / 3; k++) {
    const [red, green, blue] = r.pal.slice(k * 3, k * 3 + 3);
    assert.ok(red === green && green === blue, `color ${k}: ${red},${green},${blue}`);
  }
  // the same shading in color needs fewer: on one line of grays, bands show sooner
  const auto = await suggestColorCount(src, params, NO_ADJUST);
  const tinted = image(150, 150, (x, y) => {
    const v = Math.round(30 + x * 1.3 + y * 0.2);
    return [Math.min(255, v + 40), v, Math.max(0, v - 30)];
  });
  const autoColor = await suggestColorCount(tinted, params, NO_ADJUST);
  assert.ok(auto >= 40 && auto > autoColor, `gray: ${auto}, warm: ${autoColor}`);
});
