// Painting statistics.
//
// Per canvas, kept in its library entry (storage.js): { time, cells, started, finished, days, lastDay }
//   time      ms of painting: the time between two touches counts only when it is under IDLE_LIMIT
//   cells     cells painted with their right color while this was counted (a cell painted again counts again)
//   started   first paint; 0 for canvases from before statistics existed (their creation time stands in)
//   finished  when the last cell was painted
//   days      days on which something was painted; lastDay is the last of them, as yyyymmdd
//
// Lifetime totals, settings.tot, stay when canvases are deleted or reset:
//   { done: canvases finished, base: cells already painted when counting began, cells, time }

import { settings, saveSettings } from "./settings.js";
import { t } from "./i18n.js";

export const IDLE_LIMIT = 60000; // a longer pause is not painting time

export const emptyStats = () => ({ time: 0, cells: 0, started: 0, finished: 0, days: 0, lastDay: 0 });

export const dayKey = (d = new Date()) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

/** Starts the lifetime totals (once) from what the library already holds. entries: listLibrary() */
export function ensureTotals(entries) {
  if (settings.tot) return;
  const canvases = entries.filter((e) => !e.folder);
  settings.tot = {
    done: canvases.filter((e) => e.done).length,
    base: canvases.reduce((n, e) => n + Math.round(e.progress * e.width * e.height), 0),
    cells: 0,
    time: canvases.reduce((n, e) => n + ((e.stats && e.stats.time) || 0), 0),
  };
  saveSettings();
}

/* ---------- formatting ---------- */

const locale = () => (settings.lang === "ru" ? "ru-RU" : "en-US");

export const formatCount = (n) => Math.round(n).toLocaleString(locale());

export function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return Math.round(ms / 1000) + " " + t("u_s");
  if (minutes < 60) return minutes + " " + t("u_min");
  const rest = minutes % 60;
  return Math.floor(minutes / 60) + " " + t("u_h") + (rest ? " " + rest + " " + t("u_min") : "");
}

export function formatSpeed(cells, ms) {
  const perMinute = cells / (ms / 60000);
  return (perMinute < 10 ? perMinute.toFixed(1) : formatCount(perMinute)) + " " + t("u_cpm");
}

export function formatDate(ts) {
  const d = new Date(ts);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(
    locale(),
    thisYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "short", year: "numeric" },
  );
}

/** Speed only means something after half a minute of painting. */
const hasSpeed = (cells, time) => time >= 30000 && cells > 0;

const statsGrid = (rows) =>
  rows.length ? `<div class="stats">${rows.map(([key, v]) => `<span>${t(key)}</span><b>${v}</b>`).join("")}</div>` : "";

/** One canvas: time, speed, start and finish dates, days. canvas: { id, done, updated? } */
export function canvasStatsHtml(stats, canvas) {
  const s = stats || emptyStats();
  const rows = [];
  if (s.time) rows.push(["st_time", formatDuration(s.time)]);
  if (hasSpeed(s.cells, s.time)) rows.push(["st_speed", formatSpeed(s.cells, s.time)]);
  const started = s.started || (+canvas.id > 1e12 ? +canvas.id : 0); // ids are creation times
  if (started) rows.push(["st_start", formatDate(started)]);
  const finished = canvas.done && (s.finished || canvas.updated);
  if (finished) rows.push(["st_end", formatDate(finished)]);
  if (s.days) rows.push(["st_days", s.days]);
  return statsGrid(rows);
}

/** Lifetime totals for the settings screen. */
export function totalsHtml() {
  const tot = settings.tot || { done: 0, base: 0, cells: 0, time: 0 };
  return statsGrid([
    ["st_done", formatCount(tot.done)],
    ["st_cells", formatCount(tot.base + tot.cells)],
    ["st_time", tot.time ? formatDuration(tot.time) : "—"],
    ["st_avg", hasSpeed(tot.cells, tot.time) ? formatSpeed(tot.cells, tot.time) : "—"],
  ]);
}
