import { test } from "node:test";
import assert from "node:assert/strict";

// settings.js keeps its values in localStorage
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
const { settings } = await import("../js/settings.js");
const { formatDuration, formatSpeed, ensureTotals, canvasStatsHtml, totalsHtml, dayKey, emptyStats } =
  await import("../js/stats.js");
settings.lang = "en";

test("durations read as seconds, minutes, hours and minutes", () => {
  assert.equal(formatDuration(45000), "45 s");
  assert.equal(formatDuration(12 * 60000 + 59000), "12 min");
  assert.equal(formatDuration(125 * 60000), "2 h 5 min");
  assert.equal(formatDuration(120 * 60000), "2 h");
});

test("speed in cells per minute, one decimal when small", () => {
  assert.equal(formatSpeed(100, 60000), "100 cells/min");
  assert.equal(formatSpeed(5, 60000), "5.0 cells/min");
  assert.equal(formatSpeed(90, 120000), "45 cells/min");
});

test("lifetime totals start from the library once, then are left alone", () => {
  settings.tot = null;
  const entries = [
    { id: "1", width: 10, height: 10, progress: 0.5, done: false, stats: { time: 1000 } },
    { id: "2", width: 20, height: 10, progress: 1, done: true, stats: emptyStats() },
    { id: "f1", folder: true, name: "folder" },
  ];
  ensureTotals(entries);
  assert.deepEqual(settings.tot, { done: 1, base: 250, cells: 0, time: 1000 });
  settings.tot.cells = 7;
  ensureTotals([]);
  assert.equal(settings.tot.cells, 7);
  assert.ok(JSON.parse(store.get("pxs")).tot, "saved");
  assert.match(totalsHtml(), /257/);
});

test("canvas statistics: creation time stands in for the start, finish only when done", () => {
  const created = Date.UTC(2025, 2, 14, 12);
  const old = canvasStatsHtml(emptyStats(), { id: String(created), done: false });
  assert.match(old, /Started/);
  assert.doesNotMatch(old, /Finished|Painting time|Speed/);
  const s = { ...emptyStats(), time: 600000, cells: 3000, started: created, finished: created + 86400000, days: 2 };
  const html = canvasStatsHtml(s, { id: "x", done: true });
  for (const part of ["10 min", "300 cells/min", "Finished", "Days of painting", "<b>2</b>"])
    assert.ok(html.includes(part), part);
  assert.equal(canvasStatsHtml(null, { id: "x", done: false }), "");
});

test("day keys are local calendar days", () => {
  assert.equal(dayKey(new Date(2026, 10, 17, 23, 59)), 20261117);
  assert.equal(dayKey(new Date(2026, 0, 1, 0, 0)), 20260101);
});
