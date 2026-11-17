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
    for (let x = 0; x < 6; x++) if (out[(y * 6 + x) * 4] < 60) dark.push(x);
    assert.equal(dark.length, 1, `row ${y}: ${dark}`);
    assert.ok(dark[0] === 2 || dark[0] === 3);
  }
});

test("pickCellColors averages a soft gradient instead of picking a side", () => {
  const src = image(16, 4, (x) => [x * 16, x * 16, x * 16]);
  const out = pickCellColors(src.data, 4, 1, 4);
  for (let x = 0; x < 4; x++) assert.ok(Math.abs(out[x * 4] - (x * 4 + 1.5) * 16) <= 4, `cell ${x}: ${out[x * 4]}`);
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
