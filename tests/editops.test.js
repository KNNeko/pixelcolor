import { test } from "node:test";
import assert from "node:assert/strict";
import { floodFillMask, blendMask, recolor, coverScale, edgeColor, rgbToOklab, oklabToRgb } from "../js/editops.js";
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } from "../js/colorpicker.js";

/** w x h RGBA image from fn(x, y) -> [r, g, b]. */
function image(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  return data;
}

test("flood fill stays inside an outline and ignores a same-colored area outside it", () => {
  // white picture, a black square outline from 2 to 7, a white area inside and outside
  const data = image(10, 10, (x, y) =>
    (x === 2 || x === 7) && y >= 2 && y <= 7
      ? [0, 0, 0]
      : (y === 2 || y === 7) && x >= 2 && x <= 7
        ? [0, 0, 0]
        : [250, 250, 250],
  );
  const mask = floodFillMask(data, 10, 10, 4, 4, [250, 250, 250], 20);
  assert.equal(mask[4 * 10 + 4], 255);
  assert.equal(mask[3 * 10 + 6], 255);
  assert.equal(mask[0], 0); // outside the outline
  assert.equal(mask[2 * 10 + 4], 0); // the outline itself (far from the seed color: no soft edge either)
});

test("flood fill tolerates JPEG-like noise and gives a soft edge to in-between pixels", () => {
  const data = image(12, 1, (x) => (x < 6 ? [200 + (x % 2) * 6, 200, 200] : x === 6 ? [182, 182, 182] : [40, 40, 40]));
  const mask = floodFillMask(data, 12, 1, 0, 0, [200, 200, 200], 12);
  for (let x = 0; x < 6; x++) assert.equal(mask[x], 255);
  assert.ok(mask[6] > 0 && mask[6] < 255, `edge ${mask[6]}`); // 18 levels away: between 12 and 2 x 12
  assert.equal(mask[7], 0);
});

test("blendMask paints full and partial weights", () => {
  const data = image(3, 1, () => [0, 0, 0]);
  blendMask(data, Uint8Array.from([255, 0, 128]), [200, 100, 50]);
  assert.deepEqual([...data.subarray(0, 3)], [200, 100, 50]);
  assert.deepEqual([...data.subarray(4, 7)], [0, 0, 0]);
  assert.ok(Math.abs(data[8] - 100) <= 1);
});

test("recolor moves similar colors to the new one and keeps their shading", () => {
  // brown hair: a light and a dark shade; a blue sky that must not change
  const data = image(
    3,
    1,
    (x) =>
      [
        [150, 100, 70],
        [120, 80, 55],
        [60, 120, 220],
      ][x],
  );
  recolor(data, [150, 100, 70], [230, 120, 170], 40);
  const [r0, g0, b0] = data.subarray(0, 3);
  const [r1, g1, b1] = data.subarray(4, 7);
  assert.ok(Math.abs(r0 - 230) <= 2 && Math.abs(g0 - 120) <= 2 && Math.abs(b0 - 170) <= 2, `${r0},${g0},${b0}`);
  assert.ok(b1 > g1 && r1 > g1, `dark shade became pinkish: ${r1},${g1},${b1}`);
  assert.ok(r1 + g1 + b1 < r0 + g0 + b0, "dark shade stays darker");
  assert.deepEqual([...data.subarray(8, 11)], [60, 120, 220]);
});

test("OKLab round trip", () => {
  for (const c of [
    [0, 0, 0],
    [255, 255, 255],
    [200, 30, 90],
    [12, 200, 140],
  ]) {
    const back = oklabToRgb(...rgbToOklab(...c));
    back.forEach((v, i) => assert.ok(Math.abs(v - c[i]) < 0.6, `${c} -> ${back}`));
  }
});

test("coverScale: no tilt = 1, the more tilt the bigger, square at 45 degrees = sqrt(2)", () => {
  assert.equal(coverScale(400, 300, 0), 1);
  assert.ok(coverScale(400, 300, 10) > coverScale(400, 300, 5));
  assert.ok(Math.abs(coverScale(100, 100, 45) - Math.SQRT2) < 1e-9);
  assert.equal(coverScale(400, 300, -10), coverScale(400, 300, 10));
});

test("edgeColor averages the outer ring only", () => {
  const data = image(5, 5, (x, y) => (x === 0 || y === 0 || x === 4 || y === 4 ? [10, 20, 30] : [255, 0, 0]));
  assert.deepEqual(edgeColor(data, 5, 5), [10, 20, 30]);
});

test("color picker conversions", () => {
  assert.deepEqual(hexToRgb("#ff8000"), [255, 128, 0]);
  assert.deepEqual(hexToRgb("0f0"), [0, 255, 0]);
  assert.equal(hexToRgb("#12345"), null);
  assert.equal(rgbToHex(255, 128, 0), "#ff8000");
  for (const c of [
    [255, 0, 0],
    [12, 200, 140],
    [128, 128, 128],
    [0, 0, 0],
    [255, 255, 255],
    [37, 99, 201],
  ])
    assert.deepEqual(hsvToRgb(...rgbToHsv(...c)), c);
});
