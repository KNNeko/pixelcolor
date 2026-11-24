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
import { settings, saveSettings, canvasTheme, hexToPixel, CANVAS_THEMES } from "./settings.js";
import { saveCanvas } from "./storage.js";
import { paletteOrder, colorFamilies } from "./colorsort.js";
import { renderThumbnails } from "./render.js";
import { openPngExport } from "./export-png.js";
import { refreshLibrary } from "./library.js";
import {
  renderPartChips,
  closePartMenu,
  startSplitMode,
  stopSplitMode,
  openPartsDialog,
  splitPointerDown,
  splitPointerMove,
  splitPointerUp,
  drawSplitOverlay,
} from "./parts.js";
import { openTimelapse } from "./timelapse.js";
import { launchConfetti } from "./confetti.js";
import { createGlView, CELL } from "./glview.js";
import { openColorPicker, colorButtonHtml } from "./colorpicker.js";
import { emptyStats, IDLE_LIMIT, dayKey, canvasStatsHtml } from "./stats.js";

/** Smallest rectangle [x0, y0, x1, y1] containing both (either may be null). */
const unionRect = (a, b) =>
  !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/**
 * The picture as raw pixels (one per cell) that remembers which rectangle changed.
 * Three things read it: the WebGL renderer (uploads the changed rectangle to a texture), the minimap
 * (redraws the part of itself that covers the changed rectangle) and this.canvas, a 2D copy for the
 * fallback renderer.
 * Each of them asks for "what changed since I last looked" with take().
 */
export class PixelBuffer {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    // The 2D copy is made on the first flush(): with WebGL nothing needs it, and for a 4000x4000 canvas
    // it would be another 64 MB of memory.
    this.canvas = null;
    this.ctx = null;
    this.image = new ImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.dirty = null; // [x0, y0, x1, y1] changed since anyone looked
    this.pending = { "2d": null, gl: null, mini: null }; // changed, not yet seen by that reader
    this.version = 0; // goes up on every change
  }
  set(i, value) {
    this.pixels[i] = value;
    this.version++;
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
    this.version++;
  }
  /** The rectangle that changed since this reader ("2d", "gl" or "mini") last asked, or null. */
  take(reader) {
    if (this.dirty) {
      for (const name in this.pending) this.pending[name] = unionRect(this.pending[name], this.dirty);
      this.dirty = null;
    }
    const rect = this.pending[reader];
    this.pending[reader] = null;
    return rect;
  }
  /** Brings this.canvas up to date (creating it the first time). */
  flush() {
    if (!this.canvas) {
      this.canvas = createCanvas(this.width, this.height);
      this.ctx = this.canvas.getContext("2d");
      this.pending["2d"] = [0, 0, this.width - 1, this.height - 1];
    }
    const d = this.take("2d");
    if (d) this.ctx.putImageData(this.image, 0, 0, d[0], d[1], d[2] - d[0] + 1, d[3] - d[1] + 1);
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
  flags: null, // Uint8Array per cell for the WebGL renderer: its state (glview's CELL bits)
  useGl: false, // this canvas is drawn by the WebGL renderer

  // colors as 32-bit pixels
  theme: null,
  colorPixel: [],
  emptyPixel: [], // unpainted cell (silhouette shade)
  highlightPixel: [], // unpainted cell of the selected number
  backgroundPixel: 0,
  partTint: [],
  // with the silhouette: cells of the picture's white background (see findBackdrop), in a shade of the canvas
  backdrop: null, // Uint8Array per cell, 1 = background; null until needed
  backdropOn: false,
  backdropPixel: 0, // how those cells are drawn

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

  // statistics (canvas.stats, settings.tot; see stats.js)
  lastActive: 0, // time of the last touch while painting
  statsChanged: false,

  // tools
  selected: 0, // 1-based color number, 0 = none
  brushColor: 0, // "color with the brush only" (settings.bonly): the brush's color while another tool is out
  tool: "brush",
  brushSize: 1,
  eraserSize: 1,
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
// Two stacked canvases: #play-gl shows the picture (WebGL), #play-canvas above it takes the touches and
// shows the few things drawn with the 2D API (hint frame, split rectangle). Without WebGL, #play-canvas
// draws everything itself.
const playCanvas = $("#play-canvas");
const ctx = playCanvas.getContext("2d");
const glCanvas = $("#play-gl");
let glView; // created when the first canvas is opened; null = WebGL 2 is not available
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

/**
 * Silhouette on a dark canvas: a color of luma L gets the background's brightness (base) plus a share of the
 * way to white (DARK_SILHOUETTE at white), so dark parts sink into the background and light ones stand out.
 * Its highlight (empty cells of the selected number) goes nearly black, to DARK_HIGHLIGHT of its shade (it went
 * lighter before; a darker one was asked for). On a light canvas it is the other way round (white sinks).
 */
const DARK_SILHOUETTE = 0.62;
const DARK_HIGHLIGHT = 0.15;
/**
 * The picture's own white background (see findBackdrop) is drawn as the canvas moved BACKDROP_SHIFT of the
 * way to white (dark canvas) or black (light canvas): plain canvas color, it merged with the screen and
 * the picture's edge was gone.
 */
const BACKDROP_SHIFT = 0.1;
/** Silhouette shade of a color with luma L, tinted with the chosen silhouette color (0 = no tint). */
function tintedShade(L, highlighted) {
  const hex = settings.sit === "cus" ? settings.sic : SILHOUETTE_TINTS[settings.sit];
  if (!hex) return 0;
  const n = parseInt(hex.slice(1), 16);
  const tint = [n >> 16, (n >> 8) & 255, n & 255];
  let rgb;
  if (game.theme.dark) {
    const base = game.theme.base;
    const b = Math.min(1, (L / 255) * DARK_SILHOUETTE);
    rgb = tint.map((v) => Math.min(255, base + (153 + v * 0.4 - base) * b) * (highlighted ? DARK_HIGHLIGHT : 1));
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
      const shade = theme.dark ? theme.base + (L / 255) * DARK_SILHOUETTE * (255 - theme.base) : 255 - (255 - L) * 0.5;
      game.emptyPixel.push(tintedShade(L, false) || gray(shade));
      game.highlightPixel.push(tintedShade(L, true) || gray(theme.dark ? shade * DARK_HIGHLIGHT : shade * 0.6));
    } else {
      game.emptyPixel.push(hexToPixel(theme.cell));
      game.highlightPixel.push(hexToPixel(theme.highlight));
    }
  }
  game.partTint = PART_TINTS.map(hexToPixel);
  game.backdropOn = !!settings.sil;
  game.backdropPixel = backdropShade(theme);
  if (game.backdropOn && !game.backdrop) game.backdrop = findBackdrop();
  if (game.useGl) glView.setHighlightColors(game.highlightPixel);
}

/** The picture's white background on this canvas (see BACKDROP_SHIFT); a gradient's middle color. */
function backdropShade(theme) {
  const [a, b] = (theme.gradient || [theme.bg, theme.bg]).map((hex) => parseInt(hex.slice(1), 16));
  const rgb = [16, 8, 0].map((s) => (((a >> s) & 255) + ((b >> s) & 255)) / 2);
  const to = 0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2] < 128 ? 255 : 0;
  const [r, g, bl] = rgb.map((v) => Math.round(v + (to - v) * BACKDROP_SHIFT));
  return 0xff000000 | (bl << 16) | (g << 8) | r;
}

/** Near-white colors (luma) a picture's background may be made of (see findBackdrop). */
const BACKDROP_LUMA = 228;
/**
 * The picture's white background: near-white cells joined to the picture's edge through near-white cells.
 * The silhouette draws them in a shade of the canvas (see BACKDROP_SHIFT): on a dark canvas they do not
 * glare, on any canvas the picture's edge shows; white inside the figure keeps its light shade. Returns a
 * Uint8Array, 1 = background.
 */
function findBackdrop() {
  const { width: W, height: H, target, palette: pal } = game.canvas;
  const K = pal.length / 3;
  const light = new Uint8Array(K);
  for (let k = 0; k < K; k++)
    light[k] = 0.3 * pal[k * 3] + 0.59 * pal[k * 3 + 1] + 0.11 * pal[k * 3 + 2] >= BACKDROP_LUMA ? 1 : 0;
  const out = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let tail = 0;
  const visit = (i) => {
    if (!out[i] && light[target[i]]) {
      out[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < W; x++) {
    visit(x);
    visit((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    visit(y * W);
    visit(y * W + W - 1);
  }
  for (let head = 0; head < tail; head++) {
    const c = queue[head];
    const x = c % W;
    if (x > 0) visit(c - 1);
    if (x < W - 1) visit(c + 1);
    if (c >= W) visit(c - W);
    if (c < W * (H - 1)) visit(c + W);
  }
  return out;
}

/** What a cell looks like on screen right now. */
/**
 * Pixel of cell i in the pixel buffer. The highlight of the selected number is only stored here for the
 * 2D drawing; with WebGL the shader adds it (and the minimap adds it by itself), so that choosing another
 * number does not rewrite and re-upload every cell of the two colors.
 */
export function cellPixel(i) {
  const painted = game.paint[i];
  const target = game.canvas.target[i];
  let c = painted
    ? game.colorPixel[painted - 1]
    : settings.hl && !game.useGl && target + 1 === game.selected
      ? game.highlightPixel[target]
      : game.backdropOn && game.backdrop[i]
        ? game.backdropPixel
        : game.emptyPixel[target];
  const part = game.canvas.partOf[i];
  if (game.splitting && part) c = mixPixel(c || game.backgroundPixel, game.partTint[part % game.partTint.length], 0.4);
  else if (game.part >= 0 && part !== game.part) c = settings.oth && c ? mixPixel(c, game.backgroundPixel, 0.62) : 0;
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
  canvas.stats = canvas.stats || emptyStats();
  game.canvas = canvas;
  game.lastActive = 0;
  game.statsChanged = false;
  game.events = events;
  game.savedEvents = isNew ? 0 : events.length;
  game.unsaved = isNew;
  game.canvasChanged = isNew;
  game.thumbsStale = isNew;
  game.paint = new Uint16Array(N);
  for (const e of events) for (let k = 0; k < e.cells.length; k++) game.paint[e.cells[k]] = e.values[k];
  game.hintCell = null;
  game.selected = game.brushColor = 0;
  game.backdrop = null;
  dropHeldTap();
  sortVersion++;
  game.touchedColors.clear();
  game.part = -1;
  game.splitting = false;
  closePartMenu();
  floodQueue = floodSeen = null;
  game.buffer = new PixelBuffer(canvas.width, canvas.height);
  if (glView === undefined)
    glView = createGlView(glCanvas, () => {
      // the GPU context came back after being lost: textures are gone, send everything again
      if (!game.canvas) return;
      game.useGl = !!settings.gl && glView.setCanvas(game.canvas.width, game.canvas.height, game.canvas.target);
      if (game.useGl && !game.flags) game.flags = new Uint8Array(game.canvas.target.length);
      updateColors(); // also sends the highlight shades again
      redrawAll(); // the highlight belongs in the pixel buffer only without WebGL
      minimapCache.full = true;
    });
  game.useGl = !!(settings.gl && glView && glView.setCanvas(canvas.width, canvas.height, canvas.target));
  game.flags = game.useGl ? new Uint8Array(N) : null;
  minimapCache.full = true;
  minimapRegion.key = "";
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
  flushHeldTap(); // (may finish the picture: the show below is stopped before it starts)
  stopFinish(false);
  if (finish.stopConfetti) finish.stopConfetti(); // not over the library
  finish.stopConfetti = null;
  await saveGame(true);
  game.canvas = game.buffer = game.paint = game.flags = null;
  floodQueue = floodSeen = null;
  clearInterval(autosaveTimer);
  showScreen("screen-home");
  refreshLibrary();
}

/* ---------- saving ---------- */

let autosaveTimer = 0;
export function restartAutosave() {
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(autosave, settings.asv * 60000);
}
/**
 * Saving costs a weak phone a few frames: not while a finger paints or moves the picture. Then it waits
 * for the finger to lift (see pointerUp).
 */
let autosaveDue = false;
function autosave() {
  if (pointers.size || game.stroke) autosaveDue = true;
  else saveGame(false);
}

/** Writes new paint events + library entry; with withThumbs also re-renders the library thumbnails. */
export async function saveGame(withThumbs) {
  const g = game;
  if (!g.canvas) return;
  const wantThumbs = withThumbs && g.thumbsStale;
  if (!g.unsaved && !g.statsChanged && !wantThumbs) return;
  const canvas = g.canvas;
  const meta = {
    id: canvas.id,
    name: canvas.name,
    width: canvas.width,
    height: canvas.height,
    progress: g.correct / cellCount(),
    colors: colorCount(),
    colorsDone: g.remaining.reduce((n, left) => n + (left === 0), 0),
    done: canvas.done,
    folderId: canvas.folderId,
    updated: Date.now(),
    stats: { ...canvas.stats },
  };
  if (g.statsChanged) saveSettings(); // lifetime totals
  g.statsChanged = false;
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
/**
 * Sorted by count, the strip follows the cells LEFT of each color. It is sorted again only when a finger
 * lifts (see resortPalette), not while painting: swatches moving under the finger would be hard to hit.
 */
let sortVersion = 0;
/** Palette indices in the chosen display order (cached per canvas / sort mode / part / re-sort). */
export function paletteDisplayOrder() {
  const key = `${game.canvas.id}|${settings.ps}|${colorCount()}|${game.part}|${settings.ps === "cnt" ? sortVersion : 0}`;
  if (orderCache.key === key) return orderCache.order;
  const counts = game.part < 0 ? game.remaining : game.partRemaining;
  orderCache = { key, order: paletteOrder(game.canvas.palette, settings.ps, counts) };
  return orderCache.order;
}

/**
 * Sorted by count: puts the swatches in the order of the cells left now. Those in view slide to their new
 * places (the rest just move); the selected color is brought back to the middle.
 */
function resortPalette() {
  if (settings.ps !== "cnt" || !game.canvas) return;
  const old = orderCache.order;
  sortVersion++;
  const order = paletteDisplayOrder();
  if (old.length === order.length && old.every((k, n) => k === order[n])) return;
  const strip = $("#palette");
  const from = strip.scrollLeft - strip.clientWidth;
  const to = strip.scrollLeft + 2 * strip.clientWidth;
  const before = new Map();
  for (const k of order) {
    const b = swatches[k];
    if (b && b.offsetLeft > from && b.offsetLeft < to) before.set(b, b.offsetLeft);
  }
  const moved = document.createDocumentFragment();
  for (const k of order) if (swatches[k]) moved.append(swatches[k]);
  strip.append(moved);
  const sliding = [];
  for (const [b, left] of before) {
    const dx = left - b.offsetLeft;
    if (!dx) continue;
    b.style.transition = "none";
    b.style.transform = `translateX(${dx}px)`;
    sliding.push(b);
  }
  if (sliding.length) {
    strip.offsetWidth; // the start position is laid out before the transition begins
    for (const b of sliding) {
      b.style.transition = "transform .3s ease";
      b.style.transform = "";
    }
    setTimeout(() => sliding.forEach((b) => (b.style.transition = "")), 350);
  }
  if (game.selected) scrollPaletteTo(swatches[game.selected - 1]);
}

const SWATCH_PATH = "M26 2H37A13 13 0 0 1 50 15V37A13 13 0 0 1 37 50H15A13 13 0 0 1 2 37V15A13 13 0 0 1 15 2Z";
const swatches = [];
const textColorFor = (r, g, b) => (0.3 * r + 0.59 * g + 0.11 * b > 140 ? "#000" : "#fff");
/**
 * The progress ring shows on the selected swatch only, so there is one, moved to whichever swatch is
 * selected (hundreds of swatches with a ring each were hundreds of SVGs to build and keep).
 */
const ring = document.createElement("div");
ring.innerHTML = `<svg viewBox="0 0 52 52"><path class="ring" d="${SWATCH_PATH}"/><path class="ring-progress" pathLength="100" d="${SWATCH_PATH}"/></svg>`;
const ringSvg = ring.firstChild;
const ringProgress = ringSvg.lastChild;
let ringDash = "";

/** The strip: built as one piece of HTML; one click handler for all of it (see #palette onclick). */
export function renderPalette() {
  const el = $("#palette");
  swatches.length = 0;
  const pal = game.canvas.palette;
  let html =
    `<button class="swatch utility" data-act="grid">${icon("grid")}</button>` +
    `<button class="swatch utility" data-act="sort">${icon("sort")}</button>`;
  for (const k of paletteDisplayOrder()) {
    if (game.part >= 0 && !game.partColorCount[k]) continue;
    const [r, g, b] = [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]];
    html +=
      `<button class="swatch with-progress" data-k="${k}">` +
      `<u style="background:rgb(${r},${g},${b});color:${textColorFor(r, g, b)}">${k + 1}<i></i></u></button>`;
  }
  el.innerHTML = html;
  for (const btn of el.querySelectorAll("[data-k]")) {
    const k = +btn.dataset.k;
    btn._left = btn.querySelector("i");
    swatches[k] = btn;
    updateSwatch(k);
  }
}
$("#palette").onclick = (e) => {
  const btn = e.target.closest(".swatch");
  if (!btn) return;
  if (btn.dataset.k) pickColor(+btn.dataset.k + 1);
  else if (btn.dataset.act === "grid") openAllColors();
  else if (btn.dataset.act === "sort") cyclePaletteSort();
};
// a finger on the strip stops its scrolling animation (see scrollPaletteTo)
for (const type of ["pointerdown", "wheel"])
  $("#palette").addEventListener(type, () => cancelAnimationFrame(stripAnimation), { passive: true });

/** A color chosen in the strip or the list of all colors: with "color with the brush only", takes the brush. */
function pickColor(n) {
  if (settings.bonly && game.tool !== "brush") setTool("brush", n);
  else selectColor(n);
}

/**
 * The parts of a swatch that change while painting: cells left, and the progress ring if it is the
 * selected one. A value that did not change is not written again (every write makes the browser restyle
 * and repaint the strip).
 */
function updateSwatchProgress(k) {
  const btn = swatches[k];
  if (!btn) return;
  const left = remainingOf(k);
  const text = left ? String(left) : "✓";
  if (btn._text !== text) btn._left.textContent = btn._text = text;
  if (ringSvg.parentNode !== btn) return;
  const total = game.part < 0 ? game.totalOfColor[k] : game.partColorCount[k];
  const dash = (total ? Math.round((1000 * (total - left)) / total) / 10 : 100) + " 101";
  if (ringDash !== dash) ringProgress.style.strokeDasharray = ringDash = dash;
}

const progressPill = $("#play-progress");
/** Percentage in the pill at the top. */
function updateProgressPill() {
  const total = game.part < 0 ? cellCount() : game.partTotal;
  const correct = game.part < 0 ? game.correct : game.partCorrect;
  const text = (total ? (correct / total) * 100 : 0).toFixed(1) + "%";
  if (progressPill.textContent !== text) progressPill.textContent = text;
}

export function updateSwatch(k) {
  const btn = swatches[k];
  if (!btn) return;
  const left = remainingOf(k);
  if (game.selected === k + 1 && ringSvg.parentNode !== btn) btn.prepend(ringSvg);
  updateSwatchProgress(k);
  btn.classList.toggle("on", game.selected === k + 1);
  btn.classList.toggle("done", !left);
  btn.style.display = settings.hide && !left ? "none" : "";
}

function cyclePaletteSort() {
  const modes = ["num", "col", "cnt"];
  settings.ps = modes[(modes.indexOf(settings.ps) + 1) % 3];
  saveSettings();
  renderPalette();
}

/**
 * Scrolls the palette strip so the swatch is centered. Done by hand: scrollIntoView would also scroll
 * the screen itself when the panel is hidden, pushing the top buttons out of reach. "smooth" is a short
 * animation of its own (the browser's smooth scrolling takes its time over long distances); anything else
 * jumps.
 */
const STRIP_SCROLL_MS = 250;
let stripAnimation = 0;
function scrollPaletteTo(btn, behavior = "smooth") {
  if (!btn || game.dockHidden) return;
  const strip = $("#palette");
  const left = Math.max(
    0,
    Math.min(strip.scrollWidth - strip.clientWidth, btn.offsetLeft - strip.clientWidth / 2 + btn.offsetWidth / 2),
  );
  cancelAnimationFrame(stripAnimation);
  const from = strip.scrollLeft;
  if (behavior !== "smooth" || Math.abs(left - from) < 1) {
    strip.scrollLeft = left;
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / STRIP_SCROLL_MS);
    strip.scrollLeft = from + (left - from) * (1 - (1 - t) ** 3); // ease-out
    if (t < 1) stripAnimation = requestAnimationFrame(step);
  };
  stripAnimation = requestAnimationFrame(step);
}

/**
 * Selects color number n (1-based, 0 = none). With highlighting on, only the two affected colors are redrawn.
 * scroll: how the palette strip moves to it (see scrollPaletteTo).
 */
export function selectColor(n, scroll = "smooth") {
  const previous = game.selected;
  game.selected = n;
  if (previous) updateSwatch(previous - 1);
  if (n) {
    updateSwatch(n - 1);
    scrollPaletteTo(swatches[n - 1], scroll);
  }
  if (settings.hl && previous !== n) {
    if (game.useGl)
      minimapCache.full = true; // the shader highlights by itself; only the minimap redraws
    else {
      const redraw = (k) => forEachCellOfColor(k, (i) => game.buffer.set(i, cellPixel(i)));
      if (previous) redraw(previous - 1);
      if (n) redraw(n - 1);
    }
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
  // sorted by color, every family (reds, oranges, ... grays) starts on a new line and runs dark -> light
  const groups = settings.ps === "col" ? colorFamilies(pal) : [paletteDisplayOrder()];
  let first = true;
  for (const group of groups) {
    const shown = group.filter((k) => game.part < 0 || game.partColorCount[k]);
    if (!shown.length) continue;
    if (!first) html += '<i class="family-gap"></i>';
    first = false;
    for (const k of shown) {
      const [r, g, b] = [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]];
      html += `<button class="swatch ${remainingOf(k) ? "" : "done"}" data-color="${k + 1}" style="background:rgb(${r},${g},${b});color:${textColorFor(r, g, b)}">${k + 1}<i>${remainingOf(k) || "✓"}</i></button>`;
    }
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
      pickColor(+colorBtn.dataset.color);
    }
  };
}

/**
 * Selects the next unfinished color after number n in the strip's order (then from its start again), in the
 * part being colored if any: by number, the next number; by color, the next shade; by count (where a
 * finished color has moved to the end), the color with the most cells left. 0 if there is none.
 */
function nextColorAfter(n) {
  const order = paletteDisplayOrder();
  const at = order.indexOf(n - 1);
  for (let step = 1; step <= order.length; step++) {
    const k = order[(at + step) % order.length];
    if (remainingOf(k) > 0 && (game.part < 0 || game.partColorCount[k])) return k + 1;
  }
  return 0;
}
const selectNextColor = () => selectColor(nextColorAfter(game.selected));

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
    game.canvas.stats.cells++;
    if (settings.tot) settings.tot.cells++;
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

/** A new paint action: the cells and their new values. */
const newStroke = () => ({ cells: [], values: [] });

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
    const event = { cells: Int32Array.from(s.cells), values: Uint16Array.from(s.values) };
    game.events.push(event);
    game.unsaved = game.thumbsStale = true;
    countPaintingDay();
  }
  game.stroke = null;
  updateStatus();
  requestDraw();
}

/** Painting time: the time since the last touch counts, unless it was a pause (or the picture is finished). */
function noteActivity() {
  const canvas = game.canvas;
  if (!canvas || canvas.done) return;
  const now = Date.now();
  const gap = now - game.lastActive;
  game.lastActive = now;
  if (gap >= IDLE_LIMIT) return;
  canvas.stats.time += gap;
  if (settings.tot) settings.tot.time += gap;
  game.statsChanged = true;
}

/** Something was painted: first paint and the number of days with painting. */
function countPaintingDay() {
  const s = game.canvas.stats;
  if (!s.started) s.started = Date.now();
  const day = dayKey();
  if (s.lastDay !== day) {
    s.days++;
    s.lastDay = day;
  }
  game.statsChanged = true;
}

/** Progress pill, swatches, auto-advance to the next color, "finished" sheet. */
export function updateStatus() {
  updateProgressPill();
  if (game.touchedColors.size) resortPalette();
  if (game.selected && game.touchedColors.has(game.selected - 1) && remainingOf(game.selected - 1) === 0)
    selectNextColor();
  game.touchedColors.forEach(updateSwatch);
  game.touchedColors.clear();
  if (game.canvas.parts.length) renderPartChips();
  if (game.canvas.done && game.correct < cellCount()) {
    game.canvas.done = false; // the eraser took cells away: finishing again shows the "finished" window again
    markCanvasChanged();
  }
  if (game.correct === cellCount() && !game.canvas.done) {
    game.canvas.done = true;
    if (!game.canvas.stats.finished) {
      game.canvas.stats.finished = Date.now(); // first time only: erasing and repainting is not a new finish
      if (settings.tot) settings.tot.done++;
    }
    game.statsChanged = true;
    markCanvasChanged();
    playFinish();
  }
}

/* ---------- the end of a picture ---------- */

const FINISH_ZOOM_MS = 1000;
const FINISH_HOLD_MS = 2000; // confetti and the finished picture, before the sheet
const finish = { active: false, celebrated: false, raf: 0, timer: 0, to: null, stopConfetti: null };
const playScreen = $("#screen-play");

/**
 * The picture is finished: the buttons and the panel step aside and the picture zooms out to fill the
 * screen; then confetti, a couple of seconds to look at it, and only then the "finished" sheet. A tap on
 * the picture skips to the sheet.
 */
function playFinish() {
  finish.active = true;
  finish.celebrated = false;
  game.hintCell = null;
  closePartMenu();
  playScreen.classList.add("finishing");
  const { width: W, height: H } = game.canvas;
  const scale = Math.min(screen.width / W, screen.height / H) * 0.94;
  const to = (finish.to = { x: (screen.width - W * scale) / 2, y: (screen.height - H * scale) / 2, scale });
  const from = { x: view.x, y: view.y, scale: view.scale };
  // the cell at the screen's center travels in a straight line to the new center, while the scale changes
  // by the same ratio every moment (a big zoom does not rush through its first half)
  const mid = [screen.width / 2, screen.height / 2];
  const c0 = [(mid[0] - from.x) / from.scale, (mid[1] - from.y) / from.scale];
  const c1 = [(mid[0] - to.x) / to.scale, (mid[1] - to.y) / to.scale];
  const start = performance.now();
  const step = (now) => {
    if (!finish.active || !game.canvas) return;
    const t = Math.min(1, (now - start) / FINISH_ZOOM_MS);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; // ease in and out
    view.scale = from.scale * (to.scale / from.scale) ** e;
    view.x = mid[0] - (c0[0] + (c1[0] - c0[0]) * e) * view.scale;
    view.y = mid[1] - (c0[1] + (c1[1] - c0[1]) * e) * view.scale;
    draw();
    if (t < 1) finish.raf = requestAnimationFrame(step);
    else {
      celebrate();
      finish.timer = setTimeout(showFinishSheet, FINISH_HOLD_MS);
    }
  };
  finish.raf = requestAnimationFrame(step);
}

function celebrate() {
  if (finish.celebrated) return;
  finish.celebrated = true;
  vibrate([80, 40, 80, 40, 300]);
  finish.stopConfetti = launchConfetti();
}

/** The "finished" sheet (right away when a tap skips the show); the interface comes back when it goes. */
function showFinishSheet() {
  if (!finish.active || !game.canvas) return;
  cancelAnimationFrame(finish.raf);
  clearTimeout(finish.timer);
  Object.assign(view, finish.to);
  requestDraw();
  celebrate();
  const sheet = openSheet(
    `<div class="finished">🎉 ${t("fin")}</div>${canvasStatsHtml(game.canvas.stats, game.canvas)}<div class="actions">${actionButton("film", "tlapse", "fin-timelapse")}${actionButton("image", "png", "fin-png")}${actionButton("check", "done", "fin-close")}</div>`,
    () => stopFinish(true),
  );
  sheet.querySelector("#fin-timelapse").onclick = () => {
    closeSheet();
    openTimelapse();
  };
  sheet.querySelector("#fin-png").onclick = () => openPngExport(game.canvas, game.paint);
  sheet.querySelector("#fin-close").onclick = closeSheet;
}

/** Ends the show and brings the interface back (refit: the picture fits again between the bars). */
function stopFinish(refit) {
  if (!finish.active) return;
  finish.active = false;
  cancelAnimationFrame(finish.raf);
  clearTimeout(finish.timer);
  playScreen.classList.remove("finishing");
  if (refit && game.canvas) fitView();
}

/** Paints with the brush, or clears with the eraser, the square of cells around cell [x, y]. */
function stampBrush([cx, cy], color = game.selected, erase = game.tool === "eraser") {
  const r = (erase ? game.eraserSize : game.brushSize) >> 1;
  const W = game.canvas.width;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= game.canvas.height) continue;
      const i = y * W + x;
      if (erase) {
        paintCell(i, 0); // recorded like paint, so the time-lapse shows it too
        continue;
      }
      const right = game.canvas.target[i] + 1;
      if (game.paint[i] === right || !inCurrentPart(i)) continue;
      if (right !== color && !settings.wrong) continue;
      paintCell(i, color);
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
  // (no array per cell for its neighbours: a fill over a big area visits hundreds of thousands)
  const visit = (j) => {
    if (!floodSeen[j] && accept(j)) {
      floodSeen[j] = 1;
      floodQueue[tail++] = j;
    }
  };
  while (head < tail) {
    const c = floodQueue[head++];
    const x = c % W;
    if (x > 0) visit(c - 1);
    if (x < W - 1) visit(c + 1);
    if (c >= W) visit(c - W);
    if (c < W * (H - 1)) visit(c + W);
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
  const W = game.canvas.width;
  const i = y * W + x;
  game.stroke = newStroke();
  if (game.tool === "bucket") bucketFill(i);
  else if (game.tool === "wand") wandFill(i);
  // Record the fill nearest-first, so the time-lapse shows it spreading in a circle from the tap.
  // Sorting numbers in a typed array is many times faster than sorting with a compare function, which
  // matters when a fill covers a hundred thousand cells: key = distance² * 2^24 + position in the list.
  const s = game.stroke;
  const count = s.cells.length;
  if (count > 1) {
    const keys = new Float64Array(count);
    for (let m = 0; m < count; m++) {
      const c = s.cells[m];
      keys[m] = (((c % W) - x) ** 2 + (((c / W) | 0) - y) ** 2) * 16777216 + m;
    }
    keys.sort();
    const cells = new Array(count);
    const values = new Array(count);
    for (let m = 0; m < count; m++) {
      const k = keys[m] % 16777216;
      cells[m] = s.cells[k];
      values[m] = s.values[k];
    }
    s.cells = cells;
    s.values = values;
  }
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
  if (!game.selected) pickColor(game.canvas.target[best] + 1);
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
  ["eraser", "eraser"],
  ["bucket", "bucket"],
  ["wand", "wand"],
  ["bulb", "hint"],
];
for (const [iconName, tool] of TOOLS) {
  const b = document.createElement("button");
  b.className = "tool" + (tool === "brush" ? " on" : "");
  b.innerHTML = icon(iconName);
  b.dataset.tool = tool;
  b.onclick = () => {
    if (tool === "hint") return showHint();
    if (game.tool === tool && (tool === "brush" || tool === "eraser" || tool === "wand")) return openToolOptions();
    setTool(tool);
  };
  $("#toolbar").append(b);
}

/**
 * Takes a tool. With "color with the brush only" (settings.bonly) a color is chosen only while the brush is
 * out: other tools act without one (no highlight), and the brush gets its color back when taken again (or
 * color n, when it is taken by picking a color).
 */
function setTool(tool, n = 0) {
  const wasBrush = game.tool === "brush";
  game.tool = tool;
  $$("#toolbar .tool").forEach((x) => x.classList.toggle("on", x.dataset.tool === tool));
  if (!settings.bonly) return n && selectColor(n);
  if (wasBrush && tool !== "brush") {
    game.brushColor = game.selected;
    selectColor(0);
  } else if (tool === "brush") {
    let color = n || (wasBrush ? game.selected : game.brushColor);
    // finished meanwhile (the bucket or the wand did it): the next one, as when the brush finishes a color
    if (color && !n && !(remainingOf(color - 1) > 0 && (game.part < 0 || game.partColorCount[color - 1])))
      color = nextColorAfter(color);
    selectColor(color);
  }
}

export function openToolOptions() {
  const sheet = openSheet(
    `<b>${t("size")}</b><div class="chips">${[1, 3, 5, 9].map((n) => `<button class="chip ${n === game.brushSize ? "on" : ""}" data-size="${n}">${n}</button>`).join("")}</div>` +
      `<b>${t("esize")}</b><div class="chips">${[1, 3, 5, 9].map((n) => `<button class="chip ${n === game.eraserSize ? "on" : ""}" data-esize="${n}">${n}</button>`).join("")}</div>` +
      `<div class="chips"><button class="chip ${game.wandConnected ? "" : "on"}" data-wand="0">${t("wall")}</button><button class="chip ${game.wandConnected ? "on" : ""}" data-wand="1">${t("wcon")}</button></div>` +
      `<div class="field"><span>${t("tol")}</span><b>${game.wandTolerance}</b><div class="range" data-min="0" data-max="120" data-v="${game.wandTolerance}" data-step="1"></div></div>` +
      `<button class="chip primary" data-close>${t("done")}</button>`,
  );
  sheet.onclick = (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    if ("close" in b.dataset) return closeSheet();
    if (b.dataset.size) game.brushSize = +b.dataset.size;
    else if (b.dataset.esize) game.eraserSize = +b.dataset.esize;
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
  requestAnimationFrame(() => drawQueued && draw());
}

/** The GL canvas matches the screen in device pixels. */
function applyGlSize() {
  if (glView) glView.resize(Math.round(screen.width * screen.dpr), Math.round(screen.height * screen.dpr));
}

/**
 * Draws right now instead of at the next animation frame. A finger touching down is reported between
 * frames; waiting for the next frame would show the first dab of paint one frame late.
 */
function drawNow() {
  if (game.canvas) draw();
}

const dockHeight = () => (game.dockHidden && !game.splitting ? 0 : $("#play-dock").offsetHeight);
const placeMinimap = () => ($("#minimap").style.bottom = dockHeight() + 10 + "px");

export function updateLayout() {
  $("#toolbar").hidden = game.splitting;
  $("#palette").hidden = game.splitting;
  $("#split-bar").hidden = !game.splitting;
  $("#play-dock").classList.toggle("hidden", game.dockHidden && !game.splitting);
  // "hide everything": only the (faint) panel button stays, to bring the interface back
  $("#play-wrap").classList.toggle("bare", game.dockHidden && !game.splitting && !!settings.hall);
  if (game.dockHidden && settings.hall) closePartMenu();
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
  applyGlSize();
  placeMinimap();
  draw();
}
if (window.ResizeObserver) new ResizeObserver(handleResize).observe($("#play-wrap"));

/** Height taken by the round buttons at the top, including the camera cutout / status bar inset above them. */
const topBarHeight = () => $("#play-top").offsetTop + 56;
export function fitView() {
  const TOP_BAR = topBarHeight();
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
  const top = topBarHeight() + 56;
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

/** True where nothing separates two cells: painted, hidden (another part, not shown) or outside the picture. */
function isFilled(x, y) {
  const { width: W, height: H, partOf } = game.canvas;
  if (x < 0 || y < 0 || x >= W || y >= H) return true;
  const i = y * W + x;
  return !!game.paint[i] || (game.part >= 0 && partOf[i] !== game.part && !settings.oth);
}

let overlayUsed = false; // something is drawn on the 2D canvas above the WebGL picture
let overlayShown = true; // the 2D canvas is visible (opacity) at all
/** When the swatches and the percentage were last brought up to date while a finger paints. */
let liveProgressAt = 0;
const LIVE_PROGRESS_MS = 150;
const fades = { cell: 0, number: 0, grid: 0, contrastNumbers: false, silBoost: 1 };
/** How much stronger the silhouette gets when zoomed in (modes that keep it under the numbers). */
const SILHOUETTE_BOOST = { light: 1.5, dark: 1.3 };

function draw() {
  drawQueued = false;
  if (!game.canvas || !game.buffer || !screen.width) return;
  const s = view.scale;
  // details fade in with zoom: flat cell color, then grid, then numbers
  // canvas.mode: "n" numbers (the silhouette gives way to plain cells with numbers when zoomed in),
  //              "s" silhouette only, "b" both (numbers on top of the silhouette)
  const mode = game.canvas.mode;
  fades.cell = mode === "n" && settings.sil ? smoothstep(4, 16, s) : 0;
  fades.number = mode !== "s" ? smoothstep(10, 18, s) : 0;
  fades.grid = settings.grid ? smoothstep(5, 10, s) : 0;
  // over a silhouette every number picks black or white, whichever reads better on its cell
  fades.contrastNumbers = mode === "b";
  // where the silhouette stays when zoomed in, it gets more contrast as its cells grow (pale big cells
  // read as almost flat)
  const boost = game.theme.dark ? SILHOUETTE_BOOST.dark : SILHOUETTE_BOOST.light;
  fades.silBoost = settings.sil && mode !== "n" ? 1 + (boost - 1) * smoothstep(4, 16, s) : 1;
  const withGl = !!(game.useGl && glView.ready && drawGl(fades));
  if (glCanvas.hidden === withGl) glCanvas.hidden = !withGl;
  if (game.stroke && game.touchedColors.size && performance.now() - liveProgressAt > LIVE_PROGRESS_MS) {
    // the finger is still down: keep the progress rings and the percentage up to date as it paints (a few
    // times a second: every frame, the restyling of the strip costs a weak phone frames)
    liveProgressAt = performance.now();
    game.touchedColors.forEach(updateSwatchProgress);
    updateProgressPill();
  }
  ctx.setTransform(screen.dpr, 0, 0, screen.dpr, 0, 0);
  ctx.globalAlpha = 1;
  if (!withGl) {
    draw2d(fades);
    overlayUsed = true;
  } else if (overlayUsed) {
    ctx.clearRect(0, 0, screen.width, screen.height);
    overlayUsed = false;
  }
  if (game.hintCell != null) {
    const W = game.canvas.width;
    // white outside, navy inside: readable on any picture
    const hx = view.x + (game.hintCell % W) * s;
    const hy = view.y + ((game.hintCell / W) | 0) * s;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(hx - 4, hy - 4, s + 8, s + 8);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#23265a";
    ctx.strokeRect(hx - 1.5, hy - 1.5, s + 3, s + 3);
    overlayUsed = true;
  }
  if (game.splitting) {
    drawSplitOverlay(ctx);
    overlayUsed = true;
  }
  // An empty 2D canvas over the WebGL picture still costs the GPU a whole screen of blending every frame:
  // while nothing is drawn on it, it is made fully transparent, which the browser skips (it still gets the
  // touches)
  if (overlayShown !== overlayUsed) {
    overlayShown = overlayUsed;
    playCanvas.style.opacity = overlayUsed ? "" : "0";
  }
  drawMinimap();
}

/**
 * The CELL bits of the cells in rect and one cell around it (their grid lines depend on their neighbours):
 * painted, in another part, hidden, and on which sides a grid line is needed. Returns that larger rectangle.
 */
let filledScratch = new Uint8Array(0);
function updateCellStates(rect) {
  const { width: W, height: H, partOf } = game.canvas;
  const { paint, flags: states, part } = game;
  const hideOthers = !settings.oth;
  const x0 = Math.max(0, rect[0] - 1);
  const y0 = Math.max(0, rect[1] - 1);
  const x1 = Math.min(W - 1, rect[2] + 1);
  const y1 = Math.min(H - 1, rect[3] + 1);
  // filled, for those cells and one more around: no grid line is needed between two filled cells (painted,
  // hidden, or outside the picture)
  const fw = x1 - x0 + 3;
  const fh = y1 - y0 + 3;
  if (filledScratch.length < fw * fh) filledScratch = new Uint8Array(fw * fh);
  const filled = filledScratch;
  for (let fy = 0, y = y0 - 1; fy < fh; fy++, y++)
    for (let fx = 0, x = x0 - 1; fx < fw; fx++, x++) {
      const i = y * W + x;
      filled[fy * fw + fx] =
        x < 0 || y < 0 || x >= W || y >= H || paint[i] !== 0 || (hideOthers && part >= 0 && partOf[i] !== part) ? 1 : 0;
    }
  for (let y = y0; y <= y1; y++)
    for (let x = x0, j = (y - y0 + 1) * fw + 1; x <= x1; x++, j++) {
      const i = y * W + x;
      const outside = part >= 0 && partOf[i] !== part;
      const self = filled[j];
      let s = (paint[i] ? CELL.PAINTED : 0) | (outside ? CELL.OUTSIDE : 0) | (outside && hideOthers ? CELL.HIDDEN : 0);
      if (!(self && filled[j - 1])) s |= CELL.LINE_LEFT;
      if (!(self && filled[j + 1])) s |= CELL.LINE_RIGHT;
      if (!(self && filled[j - fw])) s |= CELL.LINE_TOP;
      if (!(self && filled[j + fw])) s |= CELL.LINE_BOTTOM;
      states[i] = s;
    }
  return [x0, y0, x1, y1];
}

/** What glView.draw gets, filled in every frame (one object, not a new one every frame). */
const glFrame = {};

/** WebGL path: send what changed to the GPU, draw the screen in one call. Returns false if it could not draw. */
function drawGl(fades) {
  const rect = game.buffer.take("gl");
  if (rect) glView.upload(game.buffer.pixels, game.flags, updateCellStates(rect));
  const f = glFrame;
  f.x = view.x;
  f.y = view.y;
  f.scale = view.scale;
  f.dpr = glCanvas.width / screen.width; // device pixels per CSS pixel of the GL canvas
  f.theme = game.theme;
  f.cellFade = fades.cell;
  f.gridFade = fades.grid;
  f.numberFade = fades.number;
  f.contrastNumbers = fades.contrastNumbers;
  f.silBoost = fades.silBoost;
  f.selected = settings.hl ? game.selected : 0;
  return glView.draw(f);
}

/**
 * Fallback without WebGL: the same picture drawn with the 2D canvas API (slow when many cells are visible:
 * a call per cell).
 */
function draw2d(fades) {
  const { width: W, height: H, target } = game.canvas;
  const theme = game.theme;
  const s = view.scale;
  game.buffer.flush();
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
  if (x1 <= x0 || y1 <= y0) return;
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

  if (fades.cell > 0) {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (game.paint[i]) continue;
        const outside = game.part >= 0 && game.canvas.partOf[i] !== game.part;
        if (outside && !settings.oth) continue;
        const X = view.x + x * s;
        const Y = view.y + y * s;
        ctx.globalAlpha = fades.cell;
        ctx.fillStyle = !outside && settings.hl && target[i] + 1 === game.selected ? theme.highlight : theme.cell;
        ctx.fillRect(X, Y, s, s);
        if (outside) {
          ctx.globalAlpha = 0.62 * fades.cell;
          ctx.fillStyle = theme.bg;
          ctx.fillRect(X, Y, s, s);
        }
      }
    ctx.globalAlpha = 1;
  }

  if (fades.grid > 0) {
    // a line only where at least one of the two cells it separates is still empty; neighbouring pieces of
    // one line are joined into a single stroke
    ctx.globalAlpha = fades.grid;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      let from = -1;
      for (let y = y0; y <= y1; y++) {
        const needed = y < y1 && !(isFilled(x - 1, y) && isFilled(x, y));
        if (needed && from < 0) from = y;
        if (!needed && from >= 0) {
          ctx.moveTo(view.x + x * s, view.y + from * s);
          ctx.lineTo(view.x + x * s, view.y + y * s);
          from = -1;
        }
      }
    }
    for (let y = y0; y <= y1; y++) {
      let from = -1;
      for (let x = x0; x <= x1; x++) {
        const needed = x < x1 && !(isFilled(x, y - 1) && isFilled(x, y));
        if (needed && from < 0) from = x;
        if (!needed && from >= 0) {
          ctx.moveTo(view.x + from * s, view.y + y * s);
          ctx.lineTo(view.x + x * s, view.y + y * s);
          from = -1;
        }
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (fades.number > 0) {
    ctx.globalAlpha = fades.number;
    ctx.font = `${s * 0.5}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.number;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (game.paint[i] || !inCurrentPart(i)) continue;
        if (fades.contrastNumbers) {
          const c = game.buffer.pixels[i];
          const luma = 0.3 * (c & 255) + 0.59 * ((c >> 8) & 255) + 0.11 * ((c >> 16) & 255);
          ctx.fillStyle = luma > 140 ? "#14151f" : "#f4f4fa";
        }
        ctx.fillText(target[i] + 1, view.x + (x + 0.5) * s, view.y + (y + 0.5) * s);
      }
    ctx.globalAlpha = 1;
  }
}

const minimapElement = $("#minimap");
/** The minimap picture, kept between frames; only the part over changed cells is redrawn. */
const minimapCache = {
  canvas: createCanvas(1, 1),
  ctx: null,
  image: null, // ImageData of the whole minimap
  out: null, // the same pixels as Uint32Array
  full: true, // redraw everything next time
  nw: 0,
  nh: 0,
  k: 1,
  ox: 0,
  oy: 0,
  background: "",
};
/** Panel color of the current app theme as [r, g, b] (the minimap frame uses it). */
const panelColor = { theme: "", rgb: [29, 31, 59] };
function panelRgb() {
  const theme = document.documentElement.dataset.theme || "";
  if (panelColor.theme !== theme) {
    // (read once per theme: a computed style is costly to ask for every frame)
    panelColor.theme = theme;
    const hex = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
    const full = hex.length === 4 ? "#" + [...hex.slice(1)].map((c) => c + c).join("") : hex;
    const n = parseInt(full.slice(1), 16);
    if (!Number.isNaN(n)) panelColor.rgb = [n >> 16, (n >> 8) & 255, n & 255];
  }
  return panelColor.rgb;
}

/** Longest side of the minimap in CSS pixels (the other side follows the picture's proportions). */
const MINIMAP_SIDE = 84;
/** What the minimap shows: the whole canvas, or the bounding box of the part being colored. */
const minimapRegion = { key: "", x: 0, y: 0, w: 1, h: 1, cssW: MINIMAP_SIDE, cssH: MINIMAP_SIDE };
function updateMinimapRegion() {
  const { width: W, height: H, partOf, id } = game.canvas;
  const region = minimapRegion;
  const key = `${id}:${game.part}:${game.part < 0 ? 0 : game.partTotal}:${W}x${H}`;
  if (region.key === key) return;
  region.key = key;
  let x0 = 0;
  let y0 = 0;
  let x1 = W - 1;
  let y1 = H - 1;
  if (game.part >= 0) {
    x0 = W;
    y0 = H;
    x1 = y1 = -1;
    for (let i = 0; i < partOf.length; i++) {
      if (partOf[i] !== game.part) continue;
      const x = i % W;
      const y = (i / W) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) [x0, y0, x1, y1] = [0, 0, W - 1, H - 1]; // empty part: show everything
  }
  region.x = x0;
  region.y = y0;
  region.w = x1 - x0 + 1;
  region.h = y1 - y0 + 1;
  // the longer side gets MINIMAP_SIDE; the shorter one is never thinner than a third of it
  const scale = MINIMAP_SIDE / Math.max(region.w, region.h);
  region.cssW = Math.max(MINIMAP_SIDE / 3, Math.round(region.w * scale));
  region.cssH = Math.max(MINIMAP_SIDE / 3, Math.round(region.h * scale));
  minimapElement.style.width = region.cssW + "px";
  minimapElement.style.height = region.cssH + "px";
  minimapCache.full = true;
}

/**
 * Draws minimap pixels u0..u1-1 x v0..v1-1 into the cached image, straight from the pixel array: each
 * minimap pixel is the average of 4 cells under it. Only the changed area is redrawn while painting, so
 * the cost follows what changed, not the size of the canvas.
 */
function renderMinimapPixels(u0, v0, u1, v1) {
  const cache = minimapCache;
  const { width: W, target, partOf } = game.canvas;
  const region = minimapRegion;
  const { out, nw, k, ox, oy } = cache;
  const px = game.buffer.pixels;
  const paint = game.paint;
  const bg = game.backgroundPixel;
  // with WebGL the highlight is not in the pixel buffer (see cellPixel): add it here
  const selected = game.useGl && settings.hl ? game.selected : 0;
  const highlight = selected ? game.highlightPixel[selected - 1] : 0;
  const part = game.part;
  const xEnd = ox + region.w * k;
  const yEnd = oy + region.h * k;
  for (let v = v0; v < v1; v++)
    for (let u = u0; u < u1; u++) {
      if (u < ox || v < oy || u + 1 > xEnd || v + 1 > yEnd) {
        out[v * nw + u] = bg; // margin around a picture that does not fill the minimap
        continue;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      for (let n = 0; n < 4; n++) {
        const cx = region.x + Math.min(region.w - 1, ((u + 0.25 + (n & 1) * 0.5 - ox) / k) | 0);
        const cy = region.y + Math.min(region.h - 1, ((v + 0.25 + (n >> 1) * 0.5 - oy) / k) | 0);
        const i = cy * W + cx;
        let c = px[i] || bg; // 0 = hidden cell: background
        if (selected && !paint[i] && target[i] + 1 === selected && (part < 0 || partOf[i] === part)) c = highlight;
        r += c & 255;
        g += (c >> 8) & 255;
        b += (c >> 16) & 255;
      }
      out[v * nw + u] = 0xff000000 | ((b >> 2) << 16) | ((g >> 2) << 8) | (r >> 2);
    }
}

function drawMinimap() {
  const mm = minimapElement;
  const { width: W, height: H } = game.canvas;
  const s = view.scale;
  // visible part of the canvas, in cells
  const a = Math.max(0, -view.x / s);
  const b = Math.max(0, -view.y / s);
  const c = Math.min(W, (screen.width - view.x) / s);
  const d = Math.min(H, (screen.height - view.y) / s);
  // "!!": settings.mini is 0 or 1, and mm.hidden must be compared with a real boolean
  const visible = !!(settings.mini && !game.splitting && s >= 16 && (c - a) * (d - b) < 0.9 * W * H);
  if (mm.hidden === visible) mm.hidden = !visible;
  const cache = minimapCache;
  if (!visible) {
    cache.full = true; // changes are not followed while hidden: start from scratch when it comes back
    return;
  }
  updateMinimapRegion();
  const region = minimapRegion;
  const dpr = screen.dpr;
  const nw = Math.round(region.cssW * dpr);
  const nh = Math.round(region.cssH * dpr);
  if (mm.width !== nw || mm.height !== nh) {
    mm.width = nw;
    mm.height = nh;
  }
  const k = Math.min(nw / region.w, nh / region.h);
  const ox = (nw - region.w * k) / 2;
  const oy = (nh - region.h * k) / 2;

  const changed = game.buffer.take("mini");
  // nothing painted and the view the same as last time: the minimap on screen is still right
  const viewKey = `${a},${b},${c},${d},${nw},${nh},${game.selected}`;
  if (!changed && !cache.full && cache.viewKey === viewKey && cache.background === game.theme.bg) return;
  cache.viewKey = viewKey;
  if (cache.full || cache.nw !== nw || cache.nh !== nh || cache.background !== game.theme.bg) {
    cache.full = false;
    cache.background = game.theme.bg;
    cache.nw = cache.canvas.width = nw;
    cache.nh = cache.canvas.height = nh;
    cache.ctx = cache.canvas.getContext("2d");
    cache.image = cache.ctx.createImageData(nw, nh);
    cache.out = new Uint32Array(cache.image.data.buffer);
    Object.assign(cache, { k, ox, oy });
    renderMinimapPixels(0, 0, nw, nh);
    cache.ctx.putImageData(cache.image, 0, 0);
  } else if (changed) {
    // minimap pixels that cover the changed cells (+1 pixel around: each pixel samples its neighbourhood)
    const u0 = Math.max(0, Math.floor(ox + (changed[0] - region.x) * k) - 1);
    const v0 = Math.max(0, Math.floor(oy + (changed[1] - region.y) * k) - 1);
    const u1 = Math.min(nw, Math.ceil(ox + (changed[2] + 1 - region.x) * k) + 1);
    const v1 = Math.min(nh, Math.ceil(oy + (changed[3] + 1 - region.y) * k) + 1);
    if (u1 > u0 && v1 > v0) {
      renderMinimapPixels(u0, v0, u1, v1);
      cache.ctx.putImageData(cache.image, 0, 0, u0, v0, u1 - u0, v1 - v0);
    }
  }
  const mctx = mm.getContext("2d");
  mctx.drawImage(cache.canvas, 0, 0);
  // Where you are: a frame in the panel color around the visible area, at its true size and position
  // (cut off at the minimap's edge). The smaller the visible area, the thinner the line, so the frame
  // never covers what it points at; drawn just outside the area for the same reason.
  const x0 = Math.max(0, ox + (a - region.x) * k);
  const y0 = Math.max(0, oy + (b - region.y) * k);
  const x1 = Math.min(nw, ox + (c - region.x) * k);
  const y1 = Math.min(nh, oy + (d - region.y) * k);
  if (x1 <= x0 || y1 <= y0) return; // looking at another part of the canvas
  const line = Math.max(1, Math.min(1.5 * dpr, Math.min(x1 - x0, y1 - y0) / 8));
  const [pr, pg, pb] = panelRgb();
  mctx.lineWidth = line;
  mctx.strokeStyle = `rgb(${pr},${pg},${pb})`;
  mctx.strokeRect(x0 - line / 2, y0 - line / 2, x1 - x0 + line, y1 - y0 + line);
}

/* ---------- touch / mouse input ---------- */

const pointers = new Map(); // pointerId -> [x, y]
const input = {
  panning: false,
  multiTouch: false, // a second finger joined during this gesture
  downAt: [0, 0], // where the finger went down
  moved: 0, // farthest the finger got from there, CSS px
  dragging: false, // the picture follows the finger (it moved past TAP_SLOP)
  lastCell: null,
  pinchDist: 0,
  pinchCenter: null,
  lastTapTime: -1e9, // first tap of a possible double tap: event time, place, cell
  lastTapAt: [0, 0],
  lastTapCell: -1,
  doubleTap: false, // this touch is the second tap of a double tap
  heldStart: null, // this touch's first cell, not painted yet: it may be a double tap's first tap (see heldTap)
};
/**
 * A finger that stays within TAP_SLOP of where it went down is a tap, and does not move the picture: a
 * picture shaken by a trembling finger would put the second tap of a double tap on another cell.
 */
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 400; // from the first tap's lift to the second touch
const DOUBLE_TAP_PX = 30; // the second tap may land this far from the first (zoomed out, cells are tiny)

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

const brushActive = () => game.tool === "brush" || game.tool === "eraser"; // tools that paint along a stroke

/** Aim assist reach in screen pixels for settings.aim = 0..3 (off, light, medium, strong). */
const AIM_REACH = [0, 10, 17, 24];
/** ...and in cells: the most a touch is corrected by, for the first touch of a stroke and while dragging. */
const AIM_CELLS_TAP = 0.85;
const AIM_CELLS_DRAG = 0.45;

/**
 * Cell the brush should act on for a touch at screen point (px, py).
 * Normally the cell under the finger. With aim assist on, a touch that lands on a cell of ANOTHER number,
 * close to a cell the selected color can paint, counts as that cell: like a phone keyboard, the cells you
 * probably mean have a slightly bigger invisible hit area.
 * It must stay unnoticeable, so:
 *   - on a cell of the selected number (painted or not) nothing is corrected: dragging along a row of your
 *     color never spills into the rows beside it;
 *   - the correction is at most AIM_REACH screen pixels and never more than a part of one cell
 *     (dragging: AIM_CELLS_DRAG, the first touch of a stroke: AIM_CELLS_TAP), however far out you zoom.
 */
function aimCell(px, py, dragging = false) {
  const { width: W, height: H, target } = game.canvas;
  const s = view.scale;
  const fx = (px - view.x) / s;
  const fy = (py - view.y) / s;
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  const under = cx >= 0 && cy >= 0 && cx < W && cy < H ? [cx, cy] : null;
  const reach = AIM_REACH[settings.aim] || 0;
  if (!reach || !game.selected || settings.wrong) return under;
  const wanted = (x, y) => {
    const i = y * W + x;
    return target[i] + 1 === game.selected && game.paint[i] !== game.selected && inCurrentPart(i);
  };
  if (under && target[cy * W + cx] + 1 === game.selected) return under;
  const r = Math.min(reach / s, dragging ? AIM_CELLS_DRAG : AIM_CELLS_TAP); // reach in cells
  let best = null;
  let bestD = r * r;
  for (let y = Math.max(0, Math.floor(fy - r)); y <= Math.min(H - 1, Math.floor(fy + r)); y++)
    for (let x = Math.max(0, Math.floor(fx - r)); x <= Math.min(W - 1, Math.floor(fx + r)); x++) {
      // distance from the finger to the nearest point of the cell's square
      const dx = Math.max(x - fx, 0, fx - (x + 1));
      const dy = Math.max(y - fy, 0, fy - (y + 1));
      const d = dx * dx + dy * dy;
      if (d < bestD && wanted(x, y)) {
        bestD = d;
        best = [x, y];
      }
    }
  return best || under;
}

/** Cell a brush or eraser touch acts on: aim assist helps the brush only. */
const strokeCell = (px, py, dragging) =>
  game.tool === "eraser" ? cellAt({ offsetX: px, offsetY: py }) : aimCell(px, py, dragging);

function brushCanStartAt(c) {
  if (game.tool === "eraser") return !!c && !!game.paint[c[1] * game.canvas.width + c[0]];
  if (!c || !game.selected) return false;
  const i = c[1] * game.canvas.width + c[0];
  const right = game.canvas.target[i] + 1;
  if (game.paint[i] === right || !inCurrentPart(i)) return false;
  return right === game.selected || !!settings.wrong;
}

playCanvas.oncontextmenu = (e) => e.preventDefault();
// Chrome on Android holds back a finger's first few pixels of movement while it decides whether the page
// wants the touch. Claiming the touch right away makes painting and panning start without that pause.
playCanvas.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
playCanvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    noteActivity();
    zoomAround(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    requestDraw();
  },
  { passive: false },
);

playCanvas.addEventListener("pointerdown", (e) => {
  if (!game.canvas) return;
  if (finish.active) return showFinishSheet(); // a tap during the end of a picture skips to its sheet
  noteActivity();
  playCanvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  game.hintCell = null;
  if (pointers.size > 1) {
    input.heldStart = null; // a pinch, not a tap
    commitStroke();
    input.panning = true;
    input.dragging = true; // the finger left after a pinch moves the picture right away
    input.pinchDist = 0;
    input.multiTouch = true;
    if (game.splitting) splitPointerDown(null);
    return;
  }
  input.multiTouch = false;
  input.downAt = [e.offsetX, e.offsetY];
  input.moved = 0;
  input.dragging = false;
  if (game.splitting && e.button < 1) return splitPointerDown(e);
  input.doubleTap = e.button < 1 && doubleTapDown(e);
  if (!input.doubleTap) flushHeldTap(); // a new touch: the tap waiting for a second one was a single tap
  input.panning = game.tool === "hand" || e.button > 0 || (brushActive() && !settings.slide);
  // One finger moves the picture instead of painting when the brush would do nothing where it starts:
  // no color chosen, outside the picture, an already finished cell, or a cell of another number
  // (for the eraser: a cell with no paint on it).
  const start = brushActive() ? strokeCell(e.offsetX, e.offsetY) : null;
  if (!input.panning && brushActive() && !brushCanStartAt(start)) input.panning = true;
  input.heldStart = null;
  if (!input.panning && brushActive()) {
    if (!game.stroke) game.stroke = newStroke(); // after a double tap: one action with its cell
    // after a double tap only its own cell is painted: the finger paints on once it really moves (pointermove)
    input.lastCell = input.doubleTap ? null : start;
    if (input.doubleTap) {
      // (nothing more: its cell is painted)
    } else if (mayBeFirstTap(e))
      input.heldStart = start; // painted once it moves, or later (see heldTap)
    else {
      stampBrush(start);
      drawNow();
    }
  } else if (input.doubleTap && !(brushActive() && !settings.slide)) commitStroke();
  // (brush without sliding: the double tap's cell joins the stamp this tap makes when the finger lifts)
});

/**
 * Double tap: picks the number of the first tap's cell and paints that cell (brush, bucket, wand; not the hand
 * or the eraser; with "color with the brush only", the brush only). It acts as soon as the second tap touches,
 * like Android's own double tap, so it feels instant; the finger may then keep going (brush: paints on with
 * the new color once it moves past TAP_SLOP). Only that one cell is painted: a first tap that would have
 * painted another cell was held back (see heldTap) and is dropped. A cell that is already done, or outside
 * the part being colored, picks nothing. Leaves game.stroke open.
 */
function doubleTapDown(e) {
  if (!settings.dbl || !doubleTapTools().includes(game.tool)) return false;
  if (input.lastTapCell < 0 || input.lastTapCell >= cellCount()) return false;
  const c = cellAt(e);
  const sameCell = c && c[1] * game.canvas.width + c[0] === input.lastTapCell;
  const near = sameCell || Math.hypot(e.offsetX - input.lastTapAt[0], e.offsetY - input.lastTapAt[1]) < DOUBLE_TAP_PX;
  // timed with the events' own times: a busy moment between the taps must not make them too far apart
  if (e.timeStamp - input.lastTapTime >= DOUBLE_TAP_MS || !near) return false;
  input.lastTapTime = -1e9; // a third tap starts a new double tap
  // the cell of the first tap: at small zoom the two taps often hit neighbouring cells
  const i = input.lastTapCell;
  const number = game.canvas.target[i] + 1;
  if (game.paint[i] === number || !inCurrentPart(i)) return false;
  dropHeldTap(); // what the first tap would have painted elsewhere never shows
  selectColor(number);
  game.stroke = newStroke();
  paintCell(i, number);
  drawNow();
  return true;
}

/** Tools a double tap picks a color with. */
const doubleTapTools = () => (settings.bonly ? ["brush"] : ["brush", "bucket", "wand"]);

/**
 * True if a brush touch here may be the first tap of a double tap: the cell under the finger is of another
 * number, which a second tap would pick. Painting it at once (where aim assist puts it, on a cell of the
 * selected color beside the finger, or a wrong number) and taking it back when the second tap came made a
 * cell flash; such a touch waits instead: see heldTap. A touch on a cell of the selected number paints at
 * once, as always (a double tap there picks nothing new).
 */
function mayBeFirstTap(e) {
  if (!settings.dbl || game.tool !== "brush") return false;
  const c = cellAt(e);
  if (!c) return false;
  const i = c[1] * game.canvas.width + c[0];
  const number = game.canvas.target[i] + 1;
  return number !== game.selected && game.paint[i] !== number && inCurrentPart(i);
}

/**
 * A brush tap that may be the first half of a double tap (see mayBeFirstTap): its paint waits until no
 * second tap can come (DOUBLE_TAP_MS after it), or until the next touch shows it was a single tap. If the
 * second tap comes, it is dropped and never shows.
 */
const heldTap = { cell: null, color: 0, timer: 0 };
function holdTap(cell) {
  flushHeldTap();
  heldTap.cell = cell;
  heldTap.color = game.selected;
  heldTap.timer = setTimeout(flushHeldTap, DOUBLE_TAP_MS);
}
function flushHeldTap() {
  clearTimeout(heldTap.timer);
  const cell = heldTap.cell;
  heldTap.cell = null;
  if (!cell || !game.canvas) return;
  const own = !game.stroke; // (a stroke already open takes it in)
  if (own) game.stroke = newStroke();
  stampBrush(cell, heldTap.color, false); // a brush tap, whatever tool is out by now
  if (own) commitStroke();
  drawNow();
}
function dropHeldTap() {
  clearTimeout(heldTap.timer);
  heldTap.cell = null;
}

playCanvas.addEventListener("pointermove", (e) => {
  const old = pointers.get(e.pointerId);
  if (!old) return;
  noteActivity();
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
  input.moved = Math.max(input.moved, Math.hypot(now[0] - input.downAt[0], now[1] - input.downAt[1]));
  if (game.splitting && splitPointerMove(e)) return;
  if (input.panning || !brushActive()) {
    if (input.dragging) {
      view.x += now[0] - old[0];
      view.y += now[1] - old[1];
    } else if (input.moved > TAP_SLOP) {
      // past the slop: from now on the picture follows the finger, from where it went down
      input.dragging = true;
      view.x += now[0] - input.downAt[0];
      view.y += now[1] - input.downAt[1];
    } else return;
    requestDraw();
  } else if (game.stroke && brushActive()) {
    // a double tap's finger, or one that may be a first tap (see heldTap), paints only once it moves
    if ((input.doubleTap || input.heldStart) && input.moved <= TAP_SLOP) return;
    input.heldStart = null; // a stroke after all: brushLine paints its first cell too
    // The browser hands over one move per frame; the finger's positions in between come with it, so a
    // fast curve is followed as drawn rather than cut short by straight lines.
    const points = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    let from = old;
    for (const point of points.length ? points : [e]) {
      const to = [point.offsetX, point.offsetY];
      brushPath(from, to);
      from = to;
    }
  }
});

/** Paints along the finger's path from screen point a to b, in steps of about half a cell (aim assist sees every spot). */
function brushPath(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const steps = Math.max(1, Math.min(64, Math.ceil(Math.hypot(dx, dy) / Math.max(2, view.scale / 2))));
  for (let n = 1; n <= steps; n++) {
    const c = strokeCell(a[0] + (dx * n) / steps, a[1] + (dy * n) / steps, true);
    if (c && input.lastCell) brushLine(input.lastCell, c);
    input.lastCell = c || input.lastCell;
  }
}

function pointerUp(e) {
  if (!pointers.delete(e.pointerId) || pointers.size) return;
  if (game.splitting && splitPointerUp()) return;
  const c = cellAt(e);
  // a touch the system took away (pointercancel) is no tap
  const isTap = e.type === "pointerup" && input.moved <= TAP_SLOP && !input.multiTouch && c;
  if (input.panning) {
    // brush without "sliding": a tap paints one stamp (a double tap has painted its cell already)
    if (isTap && !input.doubleTap && brushActive() && !settings.slide && (game.selected || game.tool === "eraser")) {
      const cell = strokeCell(e.offsetX, e.offsetY) || c;
      if (mayBeFirstTap(e)) holdTap(cell);
      else {
        if (!game.stroke) game.stroke = newStroke();
        stampBrush(cell);
      }
    }
    if (game.stroke) {
      commitStroke();
      drawNow();
    }
  } else if (brushActive()) {
    if (input.heldStart && isTap) holdTap(input.heldStart);
    input.heldStart = null;
    commitStroke();
  } else if (isTap) tapCell(c);

  // a tap that may become the first half of a double tap (the second half acts when it touches: doubleTapDown)
  if (isTap && !input.doubleTap && settings.dbl && doubleTapTools().includes(game.tool)) {
    input.lastTapTime = e.timeStamp;
    input.lastTapAt = [e.offsetX, e.offsetY];
    input.lastTapCell = c[1] * game.canvas.width + c[0];
  }
  input.doubleTap = false;
  input.panning = false;
  input.pinchDist = 0;
  if (autosaveDue) {
    autosaveDue = false;
    setTimeout(autosave, 700); // once the lifted finger's last frames are drawn
  }
}
playCanvas.addEventListener("pointerup", pointerUp);
playCanvas.addEventListener("pointercancel", pointerUp);

/* ---------- top bar & menu ---------- */

$("#play-back").onclick = () => closeGame();
$("#play-panel-toggle").onclick = () => {
  game.dockHidden = !game.dockHidden;
  updateLayout();
  // everything is gone, the button too (it still works where it was): say so the first few times
  if (game.dockHidden && settings.hall && settings.hallTips < 3) {
    settings.hallTips++;
    saveSettings();
    toast(t("hall_back"), 3500);
  }
  // while the panel was hidden the strip was not scrolled: put the selected color back in the middle
  if (!game.dockHidden && game.selected) scrollPaletteTo(swatches[game.selected - 1], "auto");
};

/** The custom canvas color (setting) of the same kind, light or dark, as the canvas theme in use. */
const customCanvasKey = () => (canvasTheme().dark ? "ccd" : "ccl");

/** The eye button cycles: numbers -> silhouette with numbers -> silhouette only -> numbers. */
const NEXT_MODE = { n: "b", b: "s", s: "n" };
/** Label of the button = the mode it switches to. */
const NEXT_MODE_LABEL = { n: "mboth", b: "msil", s: "mn" };

$("#play-more").onclick = () => {
  const toggle = (key) =>
    `<label class="check-row"><span>${t(key)}</span><label class="toggle"><input type="checkbox" data-setting="${key}" ${settings[key] ? "checked" : ""}><i></i></label></label>`;
  const options = (keys, current, labelKey) =>
    keys
      .map((v) => `<option value="${v}" ${current === v ? "selected" : ""}>${t(labelKey)}: ${t(v)}</option>`)
      .join("");
  const sheet = openSheet(
    `<div class="actions">` +
      actionButton("eye", NEXT_MODE_LABEL[game.canvas.mode] || "mboth", "menu-mode") +
      actionButton("split", "parts", "menu-parts") +
      actionButton("cut", "split", "menu-split") +
      actionButton("film", "tlapse", "menu-timelapse") +
      actionButton("wand", "tset", "menu-tools") +
      actionButton("image", "png", "menu-png") +
      `</div>${toggle("sil")}` +
      `<div class="chips nowrap"><select id="menu-sil-tint">${options(["sg", "se", "sb", "sm", "sr", "sv", "cus"], settings.sit, "sit")}</select>${colorButtonHtml("menu-sil-color", settings.sic)}</div>` +
      `<div class="chips nowrap"><select id="menu-canvas-theme">${options(CANVAS_THEMES, settings.ct, "ct")}</select>${colorButtonHtml("menu-canvas-color", settings[customCanvasKey()])}</div>` +
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
  sheet.querySelector("#menu-sil-color").onclick = (e) =>
    openColorPicker({
      value: settings.sic,
      title: t("sic"),
      onDone: (hex) => {
        settings.sic = hex;
        settings.sit = "cus";
        sheet.querySelector("#menu-sil-tint").value = "cus";
        e.target.style.background = hex;
        applyColors();
      },
    });
  sheet.querySelector("#menu-canvas-theme").onchange = (e) => {
    settings.ct = e.target.value;
    sheet.querySelector("#menu-canvas-color").style.background = settings[customCanvasKey()];
    applyColors();
  };
  // the color button sets the custom theme of the same kind (light or dark) as the one in use
  sheet.querySelector("#menu-canvas-color").onclick = (e) => {
    const key = customCanvasKey();
    openColorPicker({
      value: settings[key],
      title: t(key),
      onDone: (hex) => {
        settings[key] = hex;
        settings.ct = key === "ccd" ? "cusd" : "cusl";
        sheet.querySelector("#menu-canvas-theme").value = settings.ct;
        e.target.style.background = hex;
        applyColors();
      },
    });
  };
  sheet.querySelector("#menu-mode").onclick = () => {
    game.canvas.mode = NEXT_MODE[game.canvas.mode] || "b";
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
