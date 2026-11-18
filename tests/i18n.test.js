import { test } from "node:test";
import assert from "node:assert/strict";

// settings.js keeps its values in localStorage
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
const { settings } = await import("../js/settings.js");
const { plural } = await import("../js/i18n.js");

test("plural: Russian has three forms after a number, English two", () => {
  settings.lang = "ru";
  const ru = (n) => plural(n, "ncol");
  assert.equal(ru(1), "1 цвет");
  assert.equal(ru(2), "2 цвета");
  assert.equal(ru(4), "4 цвета");
  assert.equal(ru(5), "5 цветов");
  assert.equal(ru(11), "11 цветов");
  assert.equal(ru(12), "12 цветов");
  assert.equal(ru(14), "14 цветов");
  assert.equal(ru(21), "21 цвет");
  assert.equal(ru(22), "22 цвета");
  assert.equal(ru(111), "111 цветов");
  assert.equal(ru(121), "121 цвет");
  assert.equal(ru(124), "124 цвета");
  assert.equal(ru(193), "193 цвета");
  assert.equal(ru(200), "200 цветов");
  settings.lang = "en";
  assert.equal(plural(1, "ncol"), "1 color");
  assert.equal(plural(193, "ncol"), "193 colors");
});
