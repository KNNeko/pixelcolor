// Coloring screen: canvas state, drawing, palette, tools, touch input, saving.
import {
  $,
  $$,
  icon,
  toast,
  vibrate,
  showScreen,
  setBusy,
  yieldToBrowser,
  openSheet,
  closeSheet,
  actionButton,
  createCanvas,
} from "./ui.js";
import { t } from "./i18n.js";
import { settings, saveSettings, canvasTheme, hexToPixel } from "./settings.js";
import { saveCanvas } from "./storage.js";
import { paletteOrder } from "./colorsort.js";
import { renderThumbnails } from "./render.js";
import { openPngExport } from "./export-png.js";
import { refreshLibrary } from "./library.js";
import {
  renderPartChips,
  startSplitMode,
  stopSplitMode,
  openPartsDialog,
  splitPointerDown,
  splitPointerMove,
  splitPointerUp,
  drawSplitOverlay,
} from "./parts.js";
import { openTimelapse } from "./timelapse.js";

/** Off-screen canvas with direct pixel access that remembers which rectangle changed. */
export class PixelBuffer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext("2d");
    this.image = this.ctx.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.dirty = null; // [x0, y0, x1, y1]
  }
  set(i, value) {
    this.pixels[i] = value;
    const x = i % this.width;
    const y = (i / this.width) | 0;
    const d = this.dirty;
    if (!d) this.dirty = [x, y, x, y];
    else {
      if (x < d[0]) d[0] = x;
      if (y < d[1]) d[1] = y;
      if (x > d[2]) d[2] = x;
      if (y > d[3]) d[3] = y;
    }
  }
  markAll() {
    this.dirty = [0, 0, this.width - 1, this.height - 1];
  }
  flush() {
    const d = this.dirty;
    if (!d) return;
    this.ctx.putImageData(this.image, 0, 0, d[0], d[1], d[2] - d[0] + 1, d[3] - d[1] + 1);
    this.dirty = null;
  }
}

/* ---------- state ---------- */

export const game = {
  canvas: null, // see storage.toCanvas
  paint: null, // Uint16Array per cell: 0 = empty, otherwise (color index + 1)
  events: [], // [{ cells: Int32Array, values: Uint16Array }] every paint action, in order
  savedEvents: 0, // how many events are already in the database
  unsaved: false,
  canvasChanged: false, // the big pixel record (parts/mode/done) must be rewritten
  thumbsStale: false,
  buffer: null,

  // colors as 32-bit pixels
  theme: null,
  colorPixel: [],
  emptyPixel: [], // unpainted cell (silhouette shade)
  highlightPixel: [], // unpainted cell of the selected number
  backgroundPixel: 0,
  partTint: [],

  // cells grouped by target color: cells of color k are cellsByColor[colorStart[k] .. colorStart[k+1]-1]
  cellsByColor: null,
  colorStart: null,

  // progress
  totalOfColor: [], // cells per color
  remaining: [], // unpainted-or-wrong cells per color
  correct: 0,
  partCells: [], // per part id
  partCorrectCells: [],
  part: -1, // part being worked on, -1 = whole picture
  partColorCount: [], // cells per color inside the current part
  partRemaining: [],
  partCorrect: 0,
  partTotal: 0,
  touchedColors: new Set(),

  // tools
  selected: 0, // 1-based color number, 0 = none
  tool: "brush",
  brushSize: 1,
  wandConnected: false,
  wandTolerance: 20,
  stroke: null, // action being built: { cells: [], values: [], warned }
  hintCell: null,

  // view: screen = view.x + cell * view.scale
  view: { x: 0, y: 0, scale: 1, fitScale: 1 },
  screen: { width: 0, height: 0, dpr: 1 },
  dockHidden: false,
  splitting: false,
};

const view = game.view;
const screen = game.screen;
const playCanvas = $("#play-canvas");
const ctx = playCanvas.getContext("2d");
const PART_TINTS = ["#ff4d73", "#4da3ff", "#3ecf8e", "#ffb84d", "#a66bff", "#ff7ad9", "#4de0d0", "#c2e04d"];
const SILHOUETTE_TINTS = { sg: 0, se: "#7a4a1c", sb: "#2c5fb3", sm: "#17866a", sr: "#c23a72", sv: "#6a46c8" };

export const inCurrentPart = (i) => game.part < 0 || game.canvas.partOf[i] === game.part;
export const remainingOf = (k) => (game.part < 0 ? game.remaining[k] : game.partRemaining[k]);
const colorCount = () => game.canvas.palette.length / 3;
const cellCount = () => game.canvas.target.length;

const mixPixel = (c, d, a) => {
  const r = (c & 255) * (1 - a) + (d & 255) * a;
  const g = ((c >> 8) & 255) * (1 - a) + ((d >> 8) & 255) * a;
  const b = ((c >> 16) & 255) * (1 - a) + ((d >> 16) & 255) * a;
  return 0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
};

/** Silhouette shade of a color with luma L, tinted with the chosen silhouette color (0 = no tint). */
function tintedShade(L, highlighted) {
  const hex = settings.sit === "cus" ? settings.sic : SILHOUETTE_TINTS[settings.sit];
  if (!hex) return 0;
  const n = parseInt(hex.slice(1), 16);
  const tint = [n >> 16, (n >> 8) & 255, n & 255];
  let rgb;
  if (game.theme.dark) {
    const b = Math.min(1, (L / 255) * 0.395 + (highlighted ? 0.3 : 0));
    rgb = tint.map((v) => 28 + (v * 0.4 + 125) * b);
  } else {
    const a = (255 - L) / 510;
    const e = highlighted ? 1 - 0.6 * (1 - a) : a;
    rgb = tint.map((v) => 255 + (v - 255) * e);
  }
  return 0xff000000 | ((rgb[2] | 0) << 16) | ((rgb[1] | 0) << 8) | (rgb[0] | 0);
}

/** Recomputes all derived colors (after opening a canvas or changing a theme setting). */
export function updateColors() {
  const theme = (game.theme = canvasTheme());
  const pal = game.canvas.palette;
  const gray = (v) => {
    v = Math.round(v);
    return 0xff000000 | (v << 16) | (v << 8) | v;
  };
  game.colorPixel = [];
  game.emptyPixel = [];
  game.highlightPixel = [];
  game.backgroundPixel = hexToPixel(theme.bg);
  for (let k = 0; k < colorCount(); k++) {
    const r = pal[k * 3];
    const g = pal[k * 3 + 1];
    const b = pal[k * 3 + 2];
    const L = 0.3 * r + 0.59 * g + 0.11 * b;
    game.colorPixel.push(0xff000000 | (b << 16) | (g << 8) | r);
    if (settings.sil) {
      const shade = theme.dark ? 28 + L * 0.35 : 255 - (255 - L) * 0.5;
      game.emptyPixel.push(tintedShade(L, false) || gray(shade));
      game.highlightPixel.push(tintedShade(L, true) || gray(theme.dark ? shade + 60 : shade * 0.6));
    } else {
      game.emptyPixel.push(hexToPixel(theme.cell));
      game.highlightPixel.push(hexToPixel(theme.highlight));
    }
  }
  game.partTint = PART_TINTS.map(hexToPixel);
}

/** What a cell looks like on screen right now. */
export function cellPixel(i) {
  const painted = game.paint[i];
  const target = game.canvas.target[i];
  let c = painted
    ? game.colorPixel[painted - 1]
    : settings.hl && target + 1 === game.selected
      ? game.highlightPixel[target]
      : game.emptyPixel[target];
  const part = game.canvas.partOf[i];
  if (game.splitting && part) c = mixPixel(c, game.partTint[part % game.partTint.length], 0.4);
  else if (game.part >= 0 && part !== game.part) c = settings.oth ? mixPixel(c, game.backgroundPixel, 0.62) : 0;
  return c;
}

/** Counts cells per color / part and how many are painted correctly. */
export function recountProgress() {
  const K = colorCount();
  const { target, partOf } = game.canvas;
  game.remaining = new Array(K).fill(0);
  game.totalOfColor = new Array(K).fill(0);
  game.correct = 0;
  game.partCells = new Array(256).fill(0);
  game.partCorrectCells = new Array(256).fill(0);
  for (let i = 0; i < target.length; i++) {
    const k = target[i];
    const p = partOf[i];
    game.partCells[p]++;
    game.totalOfColor[k]++;
    if (game.paint[i] === k + 1) {
      game.correct++;
      game.partCorrectCells[p]++;
    } else game.remaining[k]++;
  }
}

/** Groups cell indices by target color (counting sort), so one color can be redrawn without scanning everything. */
function indexCellsByColor() {
  const K = colorCount();
  const target = game.canvas.target;
  const start = new Int32Array(K + 1);
  for (let i = 0; i < target.length; i++) start[target[i] + 1]++;
  for (let k = 0; k < K; k++) start[k + 1] += start[k];
  const fill = start.slice(0, K);
  const cells = new Int32Array(target.length);
  for (let i = 0; i < target.length; i++) cells[fill[target[i]]++] = i;
  game.cellsByColor = cells;
  game.colorStart = start;
}

function forEachCellOfColor(k, fn) {
  for (let n = game.colorStart[k]; n < game.colorStart[k + 1]; n++) fn(game.cellsByColor[n]);
}

/* ---------- opening / closing ---------- */

/** Opens a canvas for coloring. events: stored paint actions. isNew: not in the database yet. */
export async function openGame(canvas, events, isNew = false) {
  setBusy(true);
  await yieldToBrowser();
  const N = canvas.width * canvas.height;
  canvas.partOf = canvas.partOf || new Uint8Array(N);
  game.canvas = canvas;
  game.events = events;
  game.savedEvents = isNew ? 0 : events.length;
  game.unsaved = isNew;
  game.canvasChanged = isNew;
  game.thumbsStale = isNew;
  game.paint = new Uint16Array(N);
  for (const e of events) for (let k = 0; k < e.cells.length; k++) game.paint[e.cells[k]] = e.values[k];
  game.hintCell = null;
  game.selected = 0;
  game.touchedColors.clear();
  game.part = -1;
  game.splitting = false;
  floodQueue = floodSeen = null;
  game.buffer = new PixelBuffer(canvas.width, canvas.height);
  indexCellsByColor();
  recountProgress();
  updateColors();
  renderPalette();
  redrawAll();
  renderPartChips();
  updateLayout();
  showScreen("screen-play");
  setBusy(false);
  await yieldToBrowser();
  handleResize();
  fitView();
  updateStatus();
  restartAutosave();
}

export async function closeGame() {
  if (!game.canvas) return;
  if (game.splitting) return stopSplitMode();
  commitStroke();
  await saveGame(true);
  game.canvas = game.buffer = game.paint = null;
  floodQueue = floodSeen = null;
  clearInterval(autosaveTimer);
  showScreen("screen-home");
  refreshLibrary();
}

/* ---------- saving ---------- */

let autosaveTimer = 0;
export function restartAutosave() {
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => saveGame(false), settings.asv * 60000);
}

/** Writes new paint events + library entry; with withThumbs also re-renders the library thumbnails. */
export async function saveGame(withThumbs) {
  const g = game;
  if (!g.canvas) return;
  const wantThumbs = withThumbs && g.thumbsStale;
  if (!g.unsaved && !wantThumbs) return;
  g.buffer.flush();
  const canvas = g.canvas;
  const meta = {
    id: canvas.id,
    name: canvas.name,
    width: canvas.width,
    height: canvas.height,
    progress: g.correct / cellCount(),
    done: canvas.done,
    folderId: canvas.folderId,
    updated: Date.now(),
  };
  const writeCanvas = g.canvasChanged;
  g.unsaved = false;
  g.canvasChanged = false;
  try {
    const thumbs = wantThumbs ? await renderThumbnails(canvas, g.paint) : null;
    g.savedEvents = await saveCanvas({
      canvas,
      writeCanvas,
      meta,
      events: g.events,
      savedCount: g.savedEvents,
      thumbs,
    });
    if (thumbs) g.thumbsStale = false;
    toast(t("saved"));
  } catch (e) {
    g.unsaved = true;
    g.canvasChanged = g.canvasChanged || writeCanvas;
    toast(String(e));
  }
}

/** Something outside the paint log changed (parts, mode, done flag). */
export function markCanvasChanged() {
  game.unsaved = game.canvasChanged = game.thumbsStale = true;
}

/* ---------- palette ---------- */

let orderCache = { key: "", order: [] };
/** Palette indices in the chosen display order (cached per canvas / sort mode / part). */
export function paletteDisplayOrder() {
  const key = `${game.canvas.id}|${settings.ps}|${colorCount()}|${game.part}`;
  if (orderCache.key === key) return orderCache.order;
  const counts = game.part < 0 ? game.totalOfColor : game.partColorCount;
  orderCache = { key, order: paletteOrder(game.canvas.palette, settings.ps, counts) };
  return orderCache.order;
}

const SWATCH_PATH = "M26 2H37A13 13 0 0 1 50 15V37A13 13 0 0 1 37 50H15A13 13 0 0 1 2 37V15A13 13 0 0 1 15 2Z";
const swatches = [];
const textColorFor = (r, g, b) => (0.3 * r + 0.59 * g + 0.11 * b > 140 ? "#000" : "#fff");

export function renderPalette() {
  const el = $("#palette");
  el.innerHTML = "";
  swatches.length = 0;
  const utility = (iconName, onClick) => {
    const b = document.createElement("button");
    b.className = "swatch utility";
    b.innerHTML = icon(iconName);
    b.onclick = onClick;
    el.append(b);
  };
  utility("grid", openAllColors);
  utility("sort", cyclePaletteSort);
  const pal = game.canvas.palette;
  for (const k of paletteDisplayOrder()) {
    if (game.part >= 0 && !game.partColorCount[k]) continue;
    const [r, g, b] = [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]];
    const btn = document.createElement("button");
    btn.className = "swatch with-progress";
    btn.innerHTML =
      `<svg viewBox="0 0 52 52"><path class="ring" d="${SWATCH_PATH}"/><path class="ring-progress" pathLength="100" d="${SWATCH_PATH}"/></svg>` +
      `<u style="background:rgb(${r},${g},${b});color:${textColorFor(r, g, b)}">${k + 1}<i></i></u>`;
    btn.onclick = () => selectColor(k + 1);
    el.append(btn);
    swatches[k] = btn;
    updateSwatch(k);
  }
}

export function updateSwatch(k) {
  const btn = swatches[k];
  if (!btn) return;
  const left = remainingOf(k);
  const total = game.part < 0 ? game.totalOfColor[k] : game.partColorCount[k];
  btn.querySelector("i").textContent = left || "✓";
  btn.querySelector(".ring-progress").style.strokeDasharray = (total ? (100 * (total - left)) / total : 100) + " 101";
  btn.classList.toggle("on", game.selected === k + 1);
  btn.classList.toggle("done", !left);
  btn.style.display = settings.hide && !left ? "none" : "";
}

function cyclePaletteSort() {
  const modes = ["num", "col", "cnt"];
  settings.ps = modes[(modes.indexOf(settings.ps) + 1) % 3];
  saveSettings();
  toast(t("s_" + settings.ps));
  renderPalette();
}

/** Selects color number n (1-based, 0 = none). With highlighting on, only the two affected colors are redrawn. */
export function selectColor(n) {
  const previous = game.selected;
  game.selected = n;
  if (previous) updateSwatch(previous - 1);
  if (n) {
    updateSwatch(n - 1);
    swatches[n - 1]?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }
  if (settings.hl && previous !== n) {
    const redraw = (k) => forEachCellOfColor(k, (i) => game.buffer.set(i, cellPixel(i)));
    if (previous) redraw(previous - 1);
    if (n) redraw(n - 1);
    requestDraw();
  }
}

function openAllColors() {
  const pal = game.canvas.palette;
  let html =
    `<b>${t("allc")}</b><div class="chips segmented">` +
    ["num", "col", "cnt"]
      .map((m) => `<button class="chip ${settings.ps === m ? "on" : ""}" data-sort="${m}">${t("s_" + m)}</button>`)
      .join("") +
    '</div><div class="all-colors">';
  for (const k of paletteDisplayOrder()) {
    if (game.part >= 0 && !game.partColorCount[k]) continue;
    const [r, g, b] = [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]];
    html += `<button class="swatch ${remainingOf(k) ? "" : "done"}" data-color="${k + 1}" style="background:rgb(${r},${g},${b});color:${textColorFor(r, g, b)}">${k + 1}<i>${remainingOf(k) || "✓"}</i></button>`;
  }
  const sheet = openSheet(html + "</div>");
  sheet.onclick = (e) => {
    const sortBtn = e.target.closest("[data-sort]");
    if (sortBtn) {
      settings.ps = sortBtn.dataset.sort;
      saveSettings();
      renderPalette();
      return openAllColors();
    }
    const colorBtn = e.target.closest("[data-color]");
    if (colorBtn) {
      closeSheet();
      selectColor(+colorBtn.dataset.color);
    }
  };
}

/** Selects the next unfinished color in display order. */
function selectNextColor() {
  const order = paletteDisplayOrder();
  const from = Math.max(0, order.indexOf(game.selected - 1));
  for (let step = 1; step <= order.length; step++) {
    const k = order[(from + step) % order.length];
    if (remainingOf(k) > 0 && (game.part < 0 || game.partColorCount[k])) return selectColor(k + 1);
  }
}

/* ---------- painting ---------- */

export function redrawAll() {
  const px = game.buffer.pixels;
  for (let i = 0; i < px.length; i++) px[i] = cellPixel(i);
  game.buffer.markAll();
  requestDraw();
}

/** Sets cell i to value v (0 or color+1) and keeps all counters in sync. */
function putCell(i, v) {
  const old = game.paint[i];
  if (old === v) return;
  const right = game.canvas.target[i] + 1;
  const part = game.canvas.partOf[i];
  const inPart = game.part >= 0 && part === game.part;
  if (old === right) {
    game.remaining[right - 1]++;
    game.correct--;
    game.partCorrectCells[part]--;
    game.touchedColors.add(right - 1);
    if (inPart) {
      game.partRemaining[right - 1]++;
      game.partCorrect--;
    }
  }
  if (v === right) {
    game.remaining[right - 1]--;
    game.correct++;
    game.partCorrectCells[part]++;
    game.touchedColors.add(right - 1);
    if (inPart) {
      game.partRemaining[right - 1]--;
      game.partCorrect++;
    }
  }
  game.paint[i] = v;
  game.buffer.set(i, cellPixel(i));
}

/** Paints a cell as part of the current action (recorded for saving and the time-lapse). */
function paintCell(i, v) {
  if (!inCurrentPart(i) || game.paint[i] === v) return;
  game.stroke.cells.push(i);
  game.stroke.values.push(v);
  putCell(i, v);
}

/** Finishes the current action and appends it to the event log. */
export function commitStroke() {
  const s = game.stroke;
  if (s && s.cells.length) {
    game.events.push({ cells: Int32Array.from(s.cells), values: Uint16Array.from(s.values) });
    game.unsaved = game.thumbsStale = true;
  }
  game.stroke = null;
  updateStatus();
  requestDraw();
}

/** Progress pill, swatches, auto-advance to the next color, "finished" sheet. */
export function updateStatus() {
  const total = game.part < 0 ? cellCount() : game.partTotal;
  const correct = game.part < 0 ? game.correct : game.partCorrect;
  $("#play-progress").textContent = (total ? (correct / total) * 100 : 0).toFixed(1) + "%";
  if (game.selected && game.touchedColors.has(game.selected - 1) && remainingOf(game.selected - 1) === 0)
    selectNextColor();
  game.touchedColors.forEach(updateSwatch);
  game.touchedColors.clear();
  if (game.canvas.parts.length) renderPartChips();
  if (game.correct === cellCount() && !game.canvas.done) {
    game.canvas.done = true;
    markCanvasChanged();
    vibrate([80, 40, 80, 40, 300]);
    const sheet = openSheet(
      `<div class="finished">🎉 ${t("fin")}</div><div class="actions">${actionButton("film", "tlapse", "fin-timelapse")}${actionButton("image", "png", "fin-png")}${actionButton("check", "done", "fin-close")}</div>`,
    );
    sheet.querySelector("#fin-timelapse").onclick = () => {
      closeSheet();
      openTimelapse();
    };
    sheet.querySelector("#fin-png").onclick = () => openPngExport(game.canvas, game.paint);
    sheet.querySelector("#fin-close").onclick = closeSheet;
  }
}

/** Paints with the brush around cell [x, y]. */
function stampBrush([cx, cy]) {
  const r = game.brushSize >> 1;
  const W = game.canvas.width;
  let wrong = false;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= game.canvas.height) continue;
      const i = y * W + x;
      const right = game.canvas.target[i] + 1;
      if (game.paint[i] === right || !inCurrentPart(i)) continue;
      if (right !== game.selected && !settings.wrong) {
        wrong = true;
        continue;
      }
      paintCell(i, game.selected);
    }
  if (wrong && !game.stroke.warned) {
    game.stroke.warned = true;
    vibrate(30);
    toast(t("wrongt"));
  }
  requestDraw();
}

/** Brush along a line of cells (Bresenham), so fast swipes leave no gaps. */
function brushLine(from, to) {
  let [x0, y0] = from;
  const [x1, y1] = to;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stampBrush([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

let floodQueue = null;
let floodSeen = null;
/** 4-neighbour flood fill from cell i over cells where accept(j) is true. Result is floodQueue[0..count). */
function flood(i, accept) {
  const { width: W, height: H } = game.canvas;
  floodQueue = floodQueue || new Int32Array(W * H);
  floodSeen = floodSeen || new Uint8Array(W * H);
  let head = 0;
  let tail = 0;
  floodQueue[tail++] = i;
  floodSeen[i] = 1;
  while (head < tail) {
    const c = floodQueue[head++];
    const x = c % W;
    const y = (c / W) | 0;
    for (const j of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1])
      if (j >= 0 && !floodSeen[j] && accept(j)) {
        floodSeen[j] = 1;
        floodQueue[tail++] = j;
      }
  }
  for (let k = 0; k < tail; k++) floodSeen[floodQueue[k]] = 0;
  return tail;
}

/** Bucket: fills the connected area of the tapped cell's number with its correct color. */
function bucketFill(i) {
  if (!inCurrentPart(i)) return;
  const k = game.canvas.target[i];
  const n = flood(i, (j) => game.canvas.target[j] === k && inCurrentPart(j));
  for (let m = 0; m < n; m++) paintCell(floodQueue[m], k + 1);
}

/** Wand: all cells of the tapped number, or (connected mode) the connected area of similar colors. */
function wandFill(i) {
  if (!inCurrentPart(i)) return;
  const { target, palette: pal } = game.canvas;
  const k = target[i];
  if (!game.wandConnected) return forEachCellOfColor(k, (j) => paintCell(j, k + 1));
  const dist = (c) =>
    Math.hypot(pal[c * 3] - pal[k * 3], pal[c * 3 + 1] - pal[k * 3 + 1], pal[c * 3 + 2] - pal[k * 3 + 2]);
  const n = flood(i, (j) => inCurrentPart(j) && dist(target[j]) <= game.wandTolerance);
  for (let m = 0; m < n; m++) paintCell(floodQueue[m], target[floodQueue[m]] + 1);
}

function tapCell([x, y]) {
  const i = y * game.canvas.width + x;
  game.stroke = { cells: [], values: [] };
  if (game.tool === "bucket") bucketFill(i);
  else if (game.tool === "wand") wandFill(i);
  commitStroke();
}

/** Hint: zooms to the unfinished cell (of the selected color, if any) closest to the screen center. */
function showHint() {
  const W = game.canvas.width;
  const cx = (screen.width / 2 - view.x) / view.scale;
  const cy = (screen.height / 2 - view.y) / view.scale;
  let best = -1;
  let bestD = Infinity;
  const consider = (i) => {
    if (game.paint[i] === game.canvas.target[i] + 1 || !inCurrentPart(i)) return;
    const dx = (i % W) - cx;
    const dy = ((i / W) | 0) - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  };
  if (game.selected) forEachCellOfColor(game.selected - 1, consider);
  else for (let i = 0; i < cellCount(); i++) consider(i);
  if (best < 0) return;
  if (!game.selected) selectColor(game.canvas.target[best] + 1);
  game.hintCell = best;
  view.scale = Math.max(view.scale, 24);
  view.x = screen.width / 2 - ((best % W) + 0.5) * view.scale;
  view.y = screen.height / 2 - (((best / W) | 0) + 0.5) * view.scale;
  requestDraw();
}

/* ---------- tools bar ---------- */

const TOOLS = [
  ["move", "hand"],
  ["pen", "brush"],
  ["bucket", "bucket"],
  ["wand", "wand"],
  ["bulb", "hint"],
];
for (const [iconName, tool] of TOOLS) {
  const b = document.createElement("button");
  b.className = "tool" + (tool === "brush" ? " on" : "");
  b.innerHTML = icon(iconName);
  b.onclick = () => {
    if (tool === "hint") return showHint();
    if (game.tool === tool && (tool === "brush" || tool === "wand")) return openToolOptions();
    game.tool = tool;
    $$("#toolbar .tool").forEach((x) => x.classList.toggle("on", x === b));
  };
  $("#toolbar").append(b);
}

export function openToolOptions() {
  const sheet = openSheet(
    `<b>${t("size")}</b><div class="chips">${[1, 3, 5, 9].map((n) => `<button class="chip ${n === game.brushSize ? "on" : ""}" data-size="${n}">${n}</button>`).join("")}</div>` +
      `<div class="chips"><button class="chip ${game.wandConnected ? "" : "on"}" data-wand="0">${t("wall")}</button><button class="chip ${game.wandConnected ? "on" : ""}" data-wand="1">${t("wcon")}</button></div>` +
      `<div class="field"><span>${t("tol")}</span><b>${game.wandTolerance}</b><div class="range" data-min="0" data-max="120" data-v="${game.wandTolerance}" data-step="1"></div></div>` +
      `<button class="chip primary" data-close>${t("done")}</button>`,
  );
  sheet.onclick = (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    if ("close" in b.dataset) return closeSheet();
    if (b.dataset.size) game.brushSize = +b.dataset.size;
    else game.wandConnected = b.dataset.wand === "1";
    b.parentNode.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b));
  };
  const range = sheet.querySelector(".range");
  range.oninput = () => {
    game.wandTolerance = +range.value;
    range.previousElementSibling.textContent = range.value;
  };
}

/* ---------- view ---------- */

let drawQueued = false;
export function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

const dockHeight = () => (game.dockHidden && !game.splitting ? 0 : $("#play-dock").offsetHeight);
const placeMinimap = () => ($("#minimap").style.bottom = dockHeight() + 10 + "px");

export function updateLayout() {
  $("#toolbar").hidden = game.splitting;
  $("#palette").hidden = game.splitting;
  $("#split-bar").hidden = !game.splitting;
  $("#play-dock").classList.toggle("hidden", game.dockHidden && !game.splitting);
  $("#play-panel-toggle").classList.toggle("active", game.dockHidden);
  placeMinimap();
}

export function handleResize() {
  const oldW = screen.width;
  const oldH = screen.height;
  screen.dpr = devicePixelRatio || 1;
  screen.width = playCanvas.clientWidth;
  screen.height = playCanvas.clientHeight;
  if (game.canvas && oldW && oldH) {
    view.x += (screen.width - oldW) / 2;
    view.y += (screen.height - oldH) / 2;
  }
  playCanvas.width = Math.round(screen.width * screen.dpr);
  playCanvas.height = Math.round(screen.height * screen.dpr);
  placeMinimap();
  draw();
}
if (window.ResizeObserver) new ResizeObserver(handleResize).observe($("#play-wrap"));

const TOP_BAR = 64;
export function fitView() {
  const bottom = dockHeight();
  placeMinimap();
  const { width: W, height: H } = game.canvas;
  view.fitScale = Math.min(screen.width / W, (screen.height - TOP_BAR - bottom) / H) * 0.96;
  view.scale = view.fitScale;
  view.x = (screen.width - W * view.scale) / 2;
  view.y = TOP_BAR + (screen.height - TOP_BAR - bottom - H * view.scale) / 2;
  requestDraw();
}

/** Zooms so the cell rectangle x0..x1, y0..y1 fills the screen. */
export function fitToBox(x0, y0, x1, y1) {
  const top = 120;
  const bottom = dockHeight();
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  view.scale = Math.max(
    view.fitScale * 0.5,
    Math.min(80, Math.min(screen.width / w, (screen.height - top - bottom) / h) * 0.95),
  );
  view.x = (screen.width - w * view.scale) / 2 - x0 * view.scale;
  view.y = top + (screen.height - top - bottom - h * view.scale) / 2 - y0 * view.scale;
  requestDraw();
}

function zoomAround(x, y, factor) {
  const scale = Math.max(view.fitScale * 0.5, Math.min(80, view.scale * factor));
  factor = scale / view.scale;
  view.x = x - (x - view.x) * factor;
  view.y = y - (y - view.y) * factor;
  view.scale = scale;
}

const smoothstep = (a, b, v) => {
  const x = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

function draw() {
  drawQueued = false;
  if (!game.canvas || !game.buffer || !screen.width) return;
  const { width: W, height: H, target } = game.canvas;
  const theme = game.theme;
  const s = view.scale;
  game.buffer.flush();
  ctx.setTransform(screen.dpr, 0, 0, screen.dpr, 0, 0);
  ctx.globalAlpha = 1;
  if (theme.gradient) {
    const g = ctx.createLinearGradient(0, 0, screen.width * 0.35, screen.height);
    g.addColorStop(0, theme.gradient[0]);
    g.addColorStop(1, theme.gradient[1]);
    ctx.fillStyle = g;
  } else ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, screen.width, screen.height);
  ctx.imageSmoothingEnabled = s < 1;

  // visible cell range
  const x0 = Math.max(0, Math.floor(-view.x / s));
  const y0 = Math.max(0, Math.floor(-view.y / s));
  const x1 = Math.min(W, Math.ceil((screen.width - view.x) / s));
  const y1 = Math.min(H, Math.ceil((screen.height - view.y) / s));
  if (x1 <= x0 || y1 <= y0) return drawMinimap();
  ctx.drawImage(
    game.buffer.canvas,
    x0,
    y0,
    x1 - x0,
    y1 - y0,
    view.x + x0 * s,
    view.y + y0 * s,
    (x1 - x0) * s,
    (y1 - y0) * s,
  );

  // details fade in with zoom: flat cell color, then grid, then numbers
  const numbersMode = game.canvas.mode === "n";
  const cellFade = numbersMode && settings.sil ? smoothstep(4, 16, s) : 0;
  const numberFade = numbersMode ? smoothstep(10, 18, s) : 0;
  const gridFade = smoothstep(5, 10, s);

  if (cellFade > 0) {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (game.paint[i]) continue;
        const outside = game.part >= 0 && game.canvas.partOf[i] !== game.part;
        if (outside && !settings.oth) continue;
        const X = view.x + x * s;
        const Y = view.y + y * s;
        ctx.globalAlpha = cellFade;
        ctx.fillStyle = !outside && settings.hl && target[i] + 1 === game.selected ? theme.highlight : theme.cell;
        ctx.fillRect(X, Y, s, s);
        if (outside) {
          ctx.globalAlpha = 0.62 * cellFade;
          ctx.fillStyle = theme.bg;
          ctx.fillRect(X, Y, s, s);
        }
      }
    ctx.globalAlpha = 1;
  }

  if (settings.grid && gridFade > 0) {
    ctx.globalAlpha = gridFade;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      ctx.moveTo(view.x + x * s, view.y + y0 * s);
      ctx.lineTo(view.x + x * s, view.y + y1 * s);
    }
    for (let y = y0; y <= y1; y++) {
      ctx.moveTo(view.x + x0 * s, view.y + y * s);
      ctx.lineTo(view.x + x1 * s, view.y + y * s);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (numberFade > 0) {
    ctx.globalAlpha = numberFade;
    ctx.font = `${s * 0.5}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.number;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (!game.paint[i] && inCurrentPart(i))
          ctx.fillText(target[i] + 1, view.x + (x + 0.5) * s, view.y + (y + 0.5) * s);
      }
    ctx.globalAlpha = 1;
  }

  if (game.hintCell != null) {
    ctx.strokeStyle = "#ff2d55";
    ctx.lineWidth = 3;
    ctx.strokeRect(view.x + (game.hintCell % W) * s - 2, view.y + ((game.hintCell / W) | 0) * s - 2, s + 4, s + 4);
  }
  if (game.splitting) drawSplitOverlay(ctx);
  drawMinimap();
}

function drawMinimap() {
  const mm = $("#minimap");
  const { width: W, height: H } = game.canvas;
  const s = view.scale;
  const a = Math.max(0, -view.x / s);
  const b = Math.max(0, -view.y / s);
  const c = Math.min(W, (screen.width - view.x) / s);
  const d = Math.min(H, (screen.height - view.y) / s);
  const visible = settings.mini && !game.splitting && s >= 16 && (c - a) * (d - b) < 0.9 * W * H;
  mm.hidden = !visible;
  if (!visible) return;
  const mctx = mm.getContext("2d");
  const dpr = devicePixelRatio || 1;
  const N = Math.round((mm.clientWidth || 78) * dpr);
  if (mm.width !== N || mm.height !== N) mm.width = mm.height = N;
  const k = Math.min(N / W, N / H);
  const ox = (N - W * k) / 2;
  const oy = (N - H * k) / 2;
  mctx.fillStyle = game.theme.bg;
  mctx.fillRect(0, 0, N, N);
  mctx.imageSmoothingEnabled = k < 1;
  mctx.imageSmoothingQuality = "high";
  mctx.drawImage(game.buffer.canvas, ox, oy, W * k, H * k);
  const rect = [ox + a * k, oy + b * k, Math.max(4, (c - a) * k), Math.max(4, (d - b) * k)];
  mctx.lineWidth = 3.2 * dpr;
  mctx.strokeStyle = "#fff";
  mctx.strokeRect(...rect);
  mctx.lineWidth = 1.6 * dpr;
  mctx.strokeStyle = "#ff2d55";
  mctx.strokeRect(...rect);
}

/* ---------- touch / mouse input ---------- */

const pointers = new Map(); // pointerId -> [x, y]
const input = {
  panning: false,
  multiTouch: false, // a second finger joined during this gesture
  moved: 0,
  lastCell: null,
  pinchDist: 0,
  pinchCenter: null,
  lastTapTime: 0,
  lastTapCell: -1,
};

/** Cell under the pointer, or null outside the picture. */
export function cellAt(e) {
  const x = Math.floor((e.offsetX - view.x) / view.scale);
  const y = Math.floor((e.offsetY - view.y) / view.scale);
  return x >= 0 && y >= 0 && x < game.canvas.width && y < game.canvas.height ? [x, y] : null;
}
/** Cell coordinates even outside the picture (for the split rectangle). */
export const rawCellAt = (e) => [
  Math.floor((e.offsetX - view.x) / view.scale),
  Math.floor((e.offsetY - view.y) / view.scale),
];

const brushActive = () => game.tool === "brush";

playCanvas.oncontextmenu = (e) => e.preventDefault();
playCanvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomAround(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    requestDraw();
  },
  { passive: false },
);

playCanvas.addEventListener("pointerdown", (e) => {
  if (!game.canvas) return;
  playCanvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  game.hintCell = null;
  if (pointers.size > 1) {
    commitStroke();
    input.panning = true;
    input.pinchDist = 0;
    input.multiTouch = true;
    if (game.splitting) splitPointerDown(null);
    return;
  }
  input.multiTouch = false;
  input.moved = 0;
  if (game.splitting && e.button < 1) return splitPointerDown(e);
  input.panning = game.tool === "hand" || e.button > 0 || (brushActive() && !settings.slide);
  if (!input.panning && brushActive()) {
    if (!game.selected) {
      toast(t("nocol"));
      input.panning = true;
      return;
    }
    game.stroke = { cells: [], values: [] };
    input.lastCell = cellAt(e);
    if (input.lastCell) stampBrush(input.lastCell);
  }
});

playCanvas.addEventListener("pointermove", (e) => {
  const old = pointers.get(e.pointerId);
  if (!old) return;
  const now = [e.offsetX, e.offsetY];
  pointers.set(e.pointerId, now);
  if (pointers.size > 1) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (input.pinchDist) {
      zoomAround(center[0], center[1], dist / input.pinchDist);
      if (settings.two || game.splitting) {
        view.x += center[0] - input.pinchCenter[0];
        view.y += center[1] - input.pinchCenter[1];
      }
    }
    input.pinchDist = dist;
    input.pinchCenter = center;
    return requestDraw();
  }
  input.moved += Math.abs(now[0] - old[0]) + Math.abs(now[1] - old[1]);
  if (game.splitting && splitPointerMove(e)) return;
  if (input.panning || (!brushActive() && input.moved > 8)) {
    view.x += now[0] - old[0];
    view.y += now[1] - old[1];
    requestDraw();
  } else if (game.stroke && brushActive()) {
    const c = cellAt(e);
    if (c && input.lastCell) brushLine(input.lastCell, c);
    input.lastCell = c || input.lastCell;
  }
});

function pointerUp(e) {
  if (!pointers.delete(e.pointerId) || pointers.size) return;
  if (game.splitting && splitPointerUp()) return;
  const c = cellAt(e);
  const isTap = input.moved < 10 && !input.multiTouch && c;
  if (input.panning) {
    // brush without "sliding": a tap paints one stamp
    if (isTap && brushActive() && !settings.slide && game.selected) {
      game.stroke = { cells: [], values: [] };
      stampBrush(c);
      commitStroke();
    }
  } else if (brushActive()) commitStroke();
  else if (isTap) tapCell(c);

  if (isTap && settings.dbl) {
    const i = c[1] * game.canvas.width + c[0];
    const now = Date.now();
    if (now - input.lastTapTime < 320 && input.lastTapCell === i) selectColor(game.canvas.target[i] + 1);
    input.lastTapTime = now;
    input.lastTapCell = i;
  }
  input.panning = false;
  input.pinchDist = 0;
}
playCanvas.addEventListener("pointerup", pointerUp);
playCanvas.addEventListener("pointercancel", pointerUp);

/* ---------- top bar & menu ---------- */

$("#play-back").onclick = () => closeGame();
$("#play-panel-toggle").onclick = () => {
  game.dockHidden = !game.dockHidden;
  updateLayout();
};

$("#play-more").onclick = () => {
  const toggle = (key) =>
    `<label class="check-row"><span>${t(key)}</span><label class="toggle"><input type="checkbox" data-setting="${key}" ${settings[key] ? "checked" : ""}><i></i></label></label>`;
  const options = (keys, current, labelKey) =>
    keys
      .map((v) => `<option value="${v}" ${current === v ? "selected" : ""}>${t(labelKey)}: ${t(v)}</option>`)
      .join("");
  const sheet = openSheet(
    `<div class="actions">` +
      actionButton("eye", game.canvas.mode === "n" ? "msil" : "mn", "menu-mode") +
      actionButton("split", "parts", "menu-parts") +
      actionButton("plus", "split", "menu-split") +
      actionButton("film", "tlapse", "menu-timelapse") +
      actionButton("wand", "tset", "menu-tools") +
      actionButton("image", "png", "menu-png") +
      `</div>${toggle("sil")}` +
      `<div class="chips nowrap"><select id="menu-sil-tint">${options(["sg", "se", "sb", "sm", "sr", "sv", "cus"], settings.sit, "sit")}</select><input type="color" id="menu-sil-color" value="${settings.sic}"></div>` +
      `<div class="chips nowrap"><select id="menu-canvas-theme">${options(["cw", "clg", "gl1", "gl2", "cd", "cb", "gd1", "gd2", "cus"], settings.ct, "ct")}</select><input type="color" id="menu-canvas-color" value="${settings.cc}"></div>` +
      toggle("mini") +
      toggle("oth"),
  );
  const applyColors = () => {
    saveSettings();
    updateColors();
    redrawAll();
  };
  sheet.querySelector("#menu-sil-tint").onchange = (e) => {
    settings.sit = e.target.value;
    applyColors();
  };
  sheet.querySelector("#menu-sil-color").oninput = (e) => {
    settings.sic = e.target.value;
    settings.sit = "cus";
    sheet.querySelector("#menu-sil-tint").value = "cus";
    applyColors();
  };
  sheet.querySelector("#menu-canvas-theme").onchange = (e) => {
    settings.ct = e.target.value;
    applyColors();
  };
  sheet.querySelector("#menu-canvas-color").oninput = (e) => {
    settings.cc = e.target.value;
    settings.ct = "cus";
    sheet.querySelector("#menu-canvas-theme").value = "cus";
    applyColors();
  };
  sheet.querySelector("#menu-mode").onclick = () => {
    game.canvas.mode = game.canvas.mode === "n" ? "s" : "n";
    markCanvasChanged();
    closeSheet();
    requestDraw();
  };
  sheet.querySelector("#menu-parts").onclick = openPartsDialog;
  sheet.querySelector("#menu-split").onclick = () => {
    closeSheet();
    startSplitMode();
  };
  sheet.querySelector("#menu-timelapse").onclick = () => {
    closeSheet();
    openTimelapse();
  };
  sheet.querySelector("#menu-tools").onclick = openToolOptions;
  sheet.querySelector("#menu-png").onclick = () => {
    commitStroke();
    openPngExport(game.canvas, game.paint);
  };
  sheet.addEventListener("change", (e) => {
    const key = e.target.dataset.setting;
    if (!key) return;
    settings[key] = +e.target.checked;
    saveSettings();
    if (key === "sil") applyColors();
    else if (key === "oth") redrawAll();
    else requestDraw();
  });
};
