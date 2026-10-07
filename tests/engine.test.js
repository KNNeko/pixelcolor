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
  retroPalette,
  generate,
  suggestColorCount,
  STYLE_IDS,
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
  const idx = await quantize(src.data, 4, 1, pal, 2, "smooth");
  assert.deepEqual([...idx], [0, 0, 1, 1]);
});

test("quantize stops when the job is cancelled", async () => {
  const pal = new Float32Array([0, 0, 0, 255, 255, 255]);
  const src = image(10, 200, () => [10, 10, 10]);
  const idx = await quantize(src.data, 10, 200, pal, 2, "smooth", { pause: async () => false, progress() {} });
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

test("retroPalette snaps to 4 levels per channel and removes duplicates", () => {
  const out = retroPalette(new Float32Array([250, 10, 10, 240, 20, 0, 100, 100, 100]));
  for (const v of out) assert.ok([0, 85, 170, 255].includes(v));
  assert.equal(out.length / 3, 2);
});

test("generate works for every style", async () => {
  const src = image(64, 48, (x, y) => [x * 4, y * 5, (x * y) % 255]);
  for (const style of STYLE_IDS) {
    const r = await generate(src, { width: 32, height: 24, colors: 12, style, specks: 2, denoise: 1 }, NO_ADJUST);
    assert.equal(r.idx.length, 32 * 24, style);
    const K = r.pal.length / 3;
    assert.ok(K >= 2 && K <= 12, `${style}: ${K} colors`);
    for (const v of r.idx) assert.ok(v < K, style);
  }
});

test("suggestColorCount: few colors for a flat image, more for a detailed one, not the maximum for a simple one", async () => {
  const params = { width: 60, height: 60, style: "smooth", denoise: 0 };
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
