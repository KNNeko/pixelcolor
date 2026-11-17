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

test("vivid and muted shades of one hue come in runs instead of alternating", () => {
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
  const isPeach = (k) => peach.some((c) => c.join() === rgb(pal, k));
  const order = paletteOrder(pal, "col", []);
  const byLightness = [...order].sort(
    (a, b) => toOklab(...rgb(pal, a).split(",").map(Number))[0] - toOklab(...rgb(pal, b).split(",").map(Number))[0],
  );
  const switches = (seq) => seq.slice(1).filter((k, i) => isPeach(k) !== isPeach(seq[i])).length;
  assert.ok(switches(order) < switches(byLightness), `${switches(order)} vs ${switches(byLightness)}`);
});

test("by color is a snake: neighbouring families meet at the same end (dark with dark or light with light)", () => {
  const reds = [
    [100, 0, 20],
    [150, 20, 40],
    [200, 40, 60],
    [240, 70, 90],
  ];
  const blues = [
    [10, 20, 110],
    [30, 50, 160],
    [60, 90, 210],
    [110, 140, 240],
  ];
  const pal = makePalette(shuffle([...reds, ...blues]));
  const out = paletteOrder(pal, "col", []).map((k) => rgb(pal, k));
  const text = (list) => list.map((c) => c.join());
  const meetLight = [...text(reds), ...text(blues).reverse()];
  const meetDark = [...text(reds).reverse(), ...text(blues)];
  assert.ok([meetLight.join(";"), meetDark.join(";")].includes(out.join(";")), out.join(";"));
});

test("families are turned so that the jumps between them are as small as possible", () => {
  // dark reds only, then light blues only: whichever way the reds run, the blues must start at the nearer end
  const pal = makePalette([
    [90, 0, 10],
    [120, 10, 20],
    [150, 20, 30],
    [170, 30, 40],
    [150, 180, 250],
    [170, 200, 252],
    [190, 215, 253],
    [210, 230, 255],
  ]);
  const order = paletteOrder(pal, "col", []);
  const L = order.map((k) => toOklab(pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2])[0]);
  assert.deepEqual(
    L,
    [...L].sort((x, y) => x - y),
  ); // dark red ... light red, then the darkest blue first
});

test("a small family of muted colors joins the family of its nearest colors; a lone distinct color stays", () => {
  const browns = Array.from({ length: 60 }, (_, i) => [70 + i * 3, 45 + i * 2.6, 30 + i * 2.2]);
  const nearlyBrown = [[150, 140, 100]]; // yellowish by hue, but it looks like the browns
  const green = [[20, 200, 60]];
  const pal = makePalette([...browns, ...nearlyBrown, ...green]);
  const rows = colorFamilies(pal);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], [61]); // the green alone
  assert.ok(rows[0].includes(60));
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
