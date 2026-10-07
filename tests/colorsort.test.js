// Tests for palette ordering. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { colorFamilies, paletteOrder, toOklch, toOklab } from "../js/colorsort.js";

const random = (() => {
  let s = 12345;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
})();

function makePalette(colors) {
  const pal = new Uint8Array(colors.length * 3);
  colors.forEach((c, k) => pal.set(c, k * 3));
  return pal;
}
const shuffle = (a) => [...a].sort(() => random() - 0.5);
const isPermutation = (order, n) =>
  order.length === n && new Set(order).size === n && order.every((k) => k >= 0 && k < n);
const rgb = (pal, k) => [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]].join();

test("every color appears exactly once", () => {
  const pal = makePalette(Array.from({ length: 300 }, () => [random() * 255, random() * 255, random() * 255]));
  assert.ok(isPermutation(paletteOrder(pal, "col", []), 300));
});

test("families come in rainbow order", () => {
  const rainbow = [
    [220, 30, 40], // red
    [230, 130, 20], // orange
    [235, 215, 30], // yellow
    [40, 170, 60], // green
    [30, 190, 190], // teal
    [40, 70, 220], // blue
    [120, 50, 200], // purple
    [220, 50, 170], // magenta
    [128, 128, 128], // gray
  ];
  const pal = makePalette(shuffle(rainbow));
  const out = colorFamilies(pal).map((g) => rgb(pal, g[0]));
  assert.deepEqual(
    out,
    rainbow.map((c) => c.join()),
  );
});

test("every row starts with its darkest color and ends with its lightest", () => {
  const pal = makePalette(Array.from({ length: 400 }, () => [random() * 255, random() * 255, random() * 255]));
  for (const row of colorFamilies(pal)) {
    const L = row.map((k) => toOklch(pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]).L);
    assert.equal(L[0], Math.min(...L));
    assert.equal(L[L.length - 1], Math.max(...L));
  }
});

test("a family of strong colors is one gradient row, like the reference picture", () => {
  const reds = [
    [100, 0, 20],
    [150, 20, 40],
    [200, 40, 60],
    [240, 70, 90],
  ];
  const pal = makePalette(shuffle(reds));
  const rows = colorFamilies(pal);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].map((k) => rgb(pal, k)),
    reds.map((c) => c.join()),
  );
});

test("grayish colors stay next to their family, pure grays go last", () => {
  const pal = makePalette([
    [128, 128, 128], // 0 pure gray
    [190, 110, 40], // 1 vivid orange-brown
    [190, 178, 160], // 2 beige gray -> same family (tiny rows are merged)
    [40, 40, 40], // 3 pure dark gray
    [30, 60, 200], // 4 blue
  ]);
  assert.deepEqual(colorFamilies(pal), [[1, 2], [4], [3, 0]]);
});

test("peach skin tones and beige-grays get separate rows", () => {
  const peach = [
    [200, 125, 75],
    [215, 145, 95],
    [230, 165, 120],
    [240, 185, 145],
  ];
  const beige = [
    [150, 140, 125],
    [175, 165, 150],
    [200, 190, 175],
    [225, 215, 200],
  ];
  const pal = makePalette(shuffle([...peach, ...beige]));
  const rows = colorFamilies(pal).map((row) => row.map((k) => rgb(pal, k)));
  assert.deepEqual(rows, [peach.map((c) => c.join()), beige.map((c) => c.join())]);
});

test("paletteOrder modes", () => {
  const pal = makePalette([0, 1, 2, 3].map((k) => [k * 60, 0, 0]));
  assert.deepEqual(paletteOrder(pal, "num", []), [0, 1, 2, 3]);
  assert.deepEqual(paletteOrder(pal, "cnt", [5, 50, 5, 9]), [1, 3, 0, 2]);
});

test("inside a row neighbours are closer than with a plain dark-to-light sort", () => {
  // skin-like palette: one family, mixed pinkish / yellowish tones
  const pal = makePalette(
    Array.from({ length: 150 }, () => {
      const l = random();
      const tint = random() * 30 - 15;
      return [120 + 120 * l + tint, 80 + 110 * l, 60 + 100 * l - tint];
    }),
  );
  const lab = (k) => toOklab(pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]);
  const length = (order) =>
    order.slice(1).reduce((s, k, i) => s + Math.hypot(...lab(k).map((v, j) => v - lab(order[i])[j])), 0);
  const rows = colorFamilies(pal);
  const smooth = rows.flat();
  const plain = rows.flatMap((row) => [...row].sort((a, b) => lab(a)[0] - lab(b)[0]));
  assert.ok(length(smooth) < length(plain) * 0.9, `${length(smooth)} vs ${length(plain)}`);
});
