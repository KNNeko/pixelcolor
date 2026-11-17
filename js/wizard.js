// New-canvas wizard: 1) crop + touch-up brush, 2) color adjustments, 3) pixelize (style, size, colors).
// The heavy pixelization runs in engine.worker.js; this file only sends jobs and shows results.
import {
  $,
  $$,
  icon,
  createCanvas,
  toast,
  showScreen,
  setBusy,
  setBusyText,
  yieldToBrowser,
  sliderHtml,
  setSlider,
  initRangeSlider,
  translatePage,
} from "./ui.js";
import { t } from "./i18n.js";
import {
  boxScale,
  applyAdjustments,
  MODES,
  DEFAULT_CLEAN,
  NO_ADJUST,
  normalizeParams,
  kmeansPalette,
} from "./engine.js";
import { paletteOrder } from "./colorsort.js";
import { openColorPicker, colorButtonHtml, hexToRgb, rgbToHex } from "./colorpicker.js";
import { coverScale, floodFillMask, blendMask, recolor, edgeColor } from "./editops.js";
import { formatCount } from "./stats.js";
import { settings, saveSettings } from "./settings.js";
import { openGame, saveGame } from "./game.js";
import { putSource, deleteCanvas } from "./storage.js";
import { library } from "./library.js";

const ADJUSTMENTS = [
  // [key, min, max, default]
  ["enh", 0, 10, 0],
  ["bri", 50, 150, 100],
  ["con", 50, 150, 100],
  ["sat", 0, 200, 100],
  ["tmp", -50, 50, 0],
  ["shp", 0, 150, 0],
  ["blk", 0, 40, 0],
  ["wht", 200, 255, 255],
];
const RATIOS = [
  [0, "free"],
  [1, "sq"],
  [-1, "orig"], // -1 = the photo's own ratio
  [4 / 3, "4:3"],
  [3 / 4, "3:4"],
  [16 / 9, "16:9"],
  [9 / 16, "9:16"],
];
const MAX_SOURCE_PIXELS = 12e6;
const clampSize = (v) => Math.max(1, Math.min(4000, Math.round(v) || 1));

/* ---------- state ---------- */

let wiz = {}; // reset for every new photo, see startWizard
let history = []; // undo stack: {geometry: json} | {stroke: true} | {strokesBefore: [...]}

// `photo` is the rotated/mirrored photo with touch-up strokes; everything downstream reads from it.
let photo = null;

const cropCanvas = $("#crop-canvas");
const cropCtx = cropCanvas.getContext("2d");
const adjustCanvas = $("#adjust-canvas");
const previewCanvas = $("#preview-canvas");
const previewWrap = $("#preview-wrap");

/* ---------- panels ---------- */

// [tool, icon]; under the grid only the active tool's options are shown
const EDIT_TOOLS = [
  ["crop", "crop"],
  ["pan", "move"],
  ["brush", "pen"],
  ["shape", "shapes"],
  ["fill", "bucket"],
  ["recolor", "swap"],
  ["blur", "drop"],
  ["clone", "stamp"],
  ["rest", "reset"],
  ["pick", "pipette"],
];
$("#panel-crop").innerHTML =
  `<div class="tool-grid" id="editor-tools">${EDIT_TOOLS.map(([k, ic]) => `<button class="tool-tile" data-tool="${k}">${icon(ic)}<span data-i="et_${k}"></span></button>`).join("")}</div>` +
  `<div id="editor-hint"></div>` +
  `<div class="panel" id="frame-options"><div class="chips" id="ratio-chips"></div>` +
  `<div class="tile-row"><button class="action" id="btn-mirror"></button><button class="action" id="btn-flipv"></button><button class="action" id="btn-rotate"></button></div>` +
  sliderHtml("tilt", "tilt", -45, 45, 0, 0.5) +
  `</div>` +
  `<div class="chips" id="shape-kinds">${["rect", "oval", "line"].map((k) => `<button class="chip" data-shape="${k}" data-i="sh_${k}"></button>`).join("")}</div>` +
  `<div class="option-row" id="paint-options">${colorButtonHtml("brush-color", "#ffffff")}<button class="chip" id="btn-clone-source" data-i="cl_src"></button>` +
  `<div class="option-sliders">${sliderHtml("brush-size", "e_size", 2, 160, 28)}${sliderHtml("tol", "tol", 2, 120, 24)}</div></div>` +
  `<div class="option-row view-row"><div class="chips segmented" id="crop-zoom"><button class="chip" data-zoom="-1">${icon("minus")}</button><button class="chip" data-zoom="1">${icon("plus")}</button><button class="chip" data-zoom="0">${icon("fit")}</button></div>` +
  `<button class="chip" id="btn-edit-reset">${icon("reset")}<span data-i="e_reset"></span></button></div>`;

$("#panel-adjust").innerHTML =
  ADJUSTMENTS.map(([key, min, max, v]) => sliderHtml("adj-" + key, key, min, max, v)).join("") +
  `<button class="chip" id="btn-auto-enhance" data-i="auto"></button>`;

$("#panel-pixel").innerHTML =
  `<div id="palette-strip"></div><div id="style-list"></div>` +
  `<div class="chips"><label class="field grow"><span data-i="w"></span><input id="px-width" type="number" min="1" max="4000"></label>` +
  `<label class="field grow"><span data-i="h"></span><input id="px-height" type="number" min="1" max="4000"></label></div>` +
  `<div class="inline-row"><span data-i="lock"></span><label class="toggle"><input id="keep-ratio" type="checkbox" checked><i></i></label></div>` +
  `<div class="field"><span data-i="pxc"></span><b id="pixel-count-value"></b><div class="range" id="pixel-count" data-min="0" data-max="1000" data-v="0" data-step="1"></div></div>` +
  sliderHtml("colors", "cols", 2, 1000, 32) +
  `<div class="chips"><label class="field grow"><span data-i="cn"></span><input id="colors-exact" type="number" min="2" max="1000" value="32"></label></div>` +
  `<button class="chip" id="btn-auto-colors" data-i="autoc"></button>` +
  sliderHtml("clean", "clean", 0, 10, DEFAULT_CLEAN);

$$("#panel-crop .range,#panel-adjust .range,#panel-pixel .range").forEach(initRangeSlider);

/* ---------- start / steps ---------- */

$("#file-input").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) startWizard(file);
};

/**
 * Opens the wizard for an image File/Blob (from the + button or shared from the gallery).
 * restore = { state, replaceId?, folderId } reopens a stored canvas's photo with its old settings
 * (see sourceState) at the pixelize step; with replaceId the result replaces that canvas.
 */
export async function startWizard(file, restore = null) {
  let image;
  try {
    image = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      image = await createImageBitmap(file);
    } catch (y) {
      toast(String(y));
      return;
    }
  }
  wiz = {
    image,
    rotation: 0, // quarter turns
    mirrored: false,
    angle: 0, // fine tilt in degrees (-45..45), after the quarter turns
    pad: { on: false, color: null }, // margins: the crop frame may reach beyond the photo, filled with color
    strokes: [], // edits (brush, shapes, fill, ...), in original photo coordinates
    color: "#ffffff", // color of the brush, shapes, fill and color replace
    shape: "rect", // rect | oval | line
    tol: 24, // tolerance of fill and color replace, in gray levels
    clone: null, // clone tool: { source: [x, y] (original photo coordinates), off, shift }
    prevTool: null, // tool to return to after the eyedropper
    editVersion: 0, // bumps on every change to the photo pixels
    step: 1,
    gray: true, // preview in gray (judge shapes, not colors)
    adjust: { ...NO_ADJUST },
    style: settings.pm, // the mode and cleanliness used last time
    tool: "crop",
    brushSize: 28,
    zoom: 1, // crop view zoom/pan
    panX: 0,
    panY: 0,
    previewZoom: 1,
    previewX: 0,
    previewY: 0,
    compare: 0.5, // before/after divider position (0..1 of the preview width)
    replaceId: restore?.replaceId || null,
    folderId: restore ? restore.folderId : null,
  };
  history = [];
  originalKey = "";
  $("#wiz-undo").disabled = true;
  ADJUSTMENTS.forEach(([key, , , v]) => setSlider("adj-" + key, v));
  setSlider("clean", settings.pcl);
  setSlider("tol", wiz.tol);
  syncTiltSlider();
  resetOrientation();
  showScreen("screen-wizard");
  if (restore) applyState(restore.state);
  goToStep(restore ? 3 : 1);
  translateWizard();
}

/** Everything needed to rebuild this canvas later: orientation, touch-ups, crop, adjustments, pixelize settings. */
function sourceState(params, scale) {
  return {
    rotation: wiz.rotation,
    mirrored: wiz.mirrored,
    strokes: wiz.strokes.map((s) => scaleEdit(s, scale)),
    angle: wiz.angle,
    pad: { ...wiz.pad },
    rect: { x: wiz.rect.x * scale, y: wiz.rect.y * scale, w: wiz.rect.w * scale, h: wiz.rect.h * scale },
    ratio: wiz.ratio,
    adjust: { ...wiz.adjust },
    params,
  };
}

/** An edit with its coordinates and sizes multiplied by k (the stored photo may be smaller than the original). */
const scaleEdit = (s, k) => ({
  ...s,
  ...(s.radius != null && { radius: s.radius * k }),
  points: s.points.map((v) => v * k),
  ...(s.off && { off: s.off.map((v) => v * k) }),
});

function applyState(st) {
  wiz.rotation = st.rotation;
  wiz.mirrored = st.mirrored;
  wiz.angle = st.angle || 0;
  wiz.pad = st.pad ? { ...st.pad } : { on: false, color: null };
  wiz.strokes = st.strokes.map((s) => scaleEdit(s, 1));
  syncTiltSlider();
  buildPhoto();
  wiz.rect = { ...st.rect };
  wiz.ratio = st.ratio;
  highlightRatio();
  wiz.adjust = { ...NO_ADJUST, ...st.adjust };
  ADJUSTMENTS.forEach(([key]) => setSlider("adj-" + key, wiz.adjust[key]));
  const p = normalizeParams(st.params); // canvases made by older versions stored other style ids and sliders
  $("#px-width").value = p.width;
  $("#px-height").value = p.height;
  setSlider("colors", p.colors);
  $("#colors-exact").value = p.colors;
  setSlider("clean", p.clean);
  wiz.style = p.style;
  wiz.sized = true;
}

/** The (rotated-before) photo as a JPEG of at most 12 MP, and the factor it was scaled by. */
async function encodeSourcePhoto() {
  const im = wiz.image;
  const scale = Math.min(1, Math.sqrt(MAX_SOURCE_PIXELS / (im.width * im.height)));
  const c = createCanvas(Math.round(im.width * scale), Math.round(im.height * scale));
  const x = c.getContext("2d");
  x.fillStyle = "#fff";
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(im, 0, 0, c.width, c.height);
  const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.92));
  return { blob, scale: c.width / im.width };
}

export function translateWizard() {
  translatePage();
  $("#btn-mirror").innerHTML = icon("flip") + `<span>${t("mir")}</span>`;
  $("#btn-flipv").innerHTML = icon("flipv") + `<span>${t("flipv")}</span>`;
  $("#btn-rotate").innerHTML = icon("rot") + `<span>${t("rotb")}</span>`;
  $("#wiz-back").innerHTML = icon("back");
  $("#wiz-undo").innerHTML = icon("undo");
  $("#preview-gray").textContent = t(wiz.gray ? "gray" : "color");
  if (wiz.step) updateEditorUi();
}

function goToStep(n) {
  wiz.step = n;
  cropCanvas.hidden = n !== 1;
  adjustWrap.hidden = n !== 2;
  previewWrap.hidden = n !== 3;
  ["crop", "adjust", "pixel"].forEach((name, i) => ($("#panel-" + name).hidden = i + 1 !== n));
  $("#wiz-title").textContent = t(["", "crop", "adj", "pix"][n]);
  $("#wiz-next").innerHTML = icon(n < 3 ? "next" : "check");
  $("#wiz-undo").hidden = n > 2;
  $("#preview-gray").textContent = t(wiz.gray ? "gray" : "color");
  if (n === 1) {
    updateEditorUi();
    requestAnimationFrame(drawCrop);
  }
  if (n === 2) {
    adjView.zoom = 1;
    requestAnimationFrame(drawAdjustPreview);
  } else adjRegions.clear(); // free the preview's pixel copies
  if (n === 3) {
    if (!wiz.sized) {
      const r = cropRatio();
      $("#px-width").value = Math.max(1, r >= 1 ? 96 : Math.round(96 * r));
      $("#px-height").value = Math.max(1, r >= 1 ? Math.round(96 / r) : 96);
      wiz.sized = true;
    }
    syncPixelCount();
    applyPreviewZoom();
    renderStyleList();
    runPreview();
  }
}

$("#wiz-back").onclick = () => {
  if (wiz.step > 1) return goToStep(wiz.step - 1);
  wiz = {};
  history = [];
  photo = null;
  showScreen("screen-home");
};
$("#wiz-next").onclick = () => (wiz.step < 3 ? goToStep(wiz.step + 1) : createCanvasFromResult());
addEventListener("resize", () => {
  drawCrop();
  if (wiz.step === 2) scheduleAdjust();
  if (wiz.step === 3) applyPreviewZoom();
});

/* ---------- undo ---------- */

function pushHistory(entry) {
  history.push(entry);
  if (history.length > 80) history.shift();
  $("#wiz-undo").disabled = false;
}

/** Remembers crop/rotation/margins/adjustments before a change. */
const snapshot = () =>
  pushHistory({
    geometry: JSON.stringify({
      rect: wiz.rect,
      rotation: wiz.rotation,
      mirrored: wiz.mirrored,
      angle: wiz.angle,
      pad: wiz.pad,
      ratio: wiz.ratio,
      adjust: wiz.adjust,
    }),
  });

function undo() {
  const e = history.pop();
  if (!e) return;
  if (e.stroke) {
    wiz.strokes.pop();
    replayEdits();
  } else if (e.strokesBefore) {
    wiz.strokes = e.strokesBefore;
    replayEdits();
  } else {
    const s = JSON.parse(e.geometry);
    const turned = s.rotation !== wiz.rotation || s.mirrored !== wiz.mirrored || (s.angle || 0) !== wiz.angle;
    wiz.rotation = s.rotation;
    wiz.mirrored = s.mirrored;
    wiz.angle = s.angle || 0;
    wiz.pad = s.pad || { on: false, color: null };
    if (turned) buildPhoto();
    wiz.rect = s.rect;
    wiz.ratio = s.ratio;
    wiz.adjust = s.adjust;
    ADJUSTMENTS.forEach(([key]) => setSlider("adj-" + key, wiz.adjust[key]));
    highlightRatio();
    syncTiltSlider();
  }
  photoChanged();
  if (wiz.step === 1) drawCrop();
  else drawAdjustPreview();
  $("#wiz-undo").disabled = !history.length;
}
$("#wiz-undo").onclick = undo;

/* ---------- photo (rotation, mirror, tilt, edits) ----------
   wiz.base  = the photo turned by quarter turns, mirrored, tilted (and enlarged so the tilt leaves no corners);
   photo     = base with all edits (wiz.strokes) applied in order. Edits are stored in original-photo
   coordinates ("source"), so turning the photo or undoing replays them in the right place. */

/** Fine-tilt transform: [cos * k, sin * k, k], k = enlargement that hides the corners. */
function tiltMatrix() {
  if (!wiz.angle) return [1, 0, 1];
  const k = coverScale(wiz.base.width, wiz.base.height, wiz.angle);
  const a = (wiz.angle * Math.PI) / 180;
  return [Math.cos(a) * k, Math.sin(a) * k, k];
}

function buildPhoto() {
  const im = wiz.image;
  const sideways = wiz.rotation % 2;
  const c = createCanvas(sideways ? im.height : im.width, sideways ? im.width : im.height);
  const x = c.getContext("2d");
  x.fillStyle = "#fff"; // transparent PNGs get a white background
  x.fillRect(0, 0, c.width, c.height);
  x.translate(c.width / 2, c.height / 2);
  if (wiz.angle) {
    const k = coverScale(c.width, c.height, wiz.angle);
    x.rotate((wiz.angle * Math.PI) / 180);
    x.scale(k, k);
    x.imageSmoothingQuality = "high";
  }
  x.rotate((wiz.rotation * Math.PI) / 2);
  if (wiz.mirrored) x.scale(-1, 1);
  x.drawImage(im, -im.width / 2, -im.height / 2);
  wiz.base = photo = c;
  if (wiz.strokes.length) replayEdits();
  photoChanged();
}

function resetOrientation() {
  buildPhoto();
  wiz.rect = { x: 0, y: 0, w: photo.width, h: photo.height };
  wiz.ratio = 0;
  highlightRatio();
}

/** Pixels of the photo changed: cached crop pixels and preview are outdated. */
function photoChanged() {
  wiz.editVersion++;
  wiz.source = null;
  wiz.result = null;
}

/**
 * Turns or flips the photo as shown on screen, keeping the crop frame on the same part of the picture.
 *   "rot":   90° clockwise;  "flipH": left-right;  "flipV": upside down.
 * In terms of the stored transform (mirror first, then quarter turns, then tilt): a flip on screen
 * reverses the quarter turns and the tilt and toggles the mirror (flipV = flipH + half a turn).
 */
function turnPhoto(kind) {
  snapshot();
  const PW = photo.width;
  const PH = photo.height;
  const r = wiz.rect;
  if (kind === "rot") {
    wiz.rotation = (wiz.rotation + 1) % 4;
    wiz.rect = { x: PH - (r.y + r.h), y: r.x, w: r.h, h: r.w };
    if (wiz.ratio) wiz.ratio = 1 / wiz.ratio;
  } else {
    wiz.rotation = ((kind === "flipV" ? 6 : 4) - wiz.rotation) % 4;
    wiz.mirrored = !wiz.mirrored;
    wiz.angle = -wiz.angle || 0;
    if (kind === "flipH") wiz.rect = { ...r, x: PW - r.x - r.w };
    else wiz.rect = { ...r, y: PH - r.y - r.h };
    syncTiltSlider();
  }
  buildPhoto();
  highlightRatio();
  drawCrop();
}
$("#btn-rotate").onclick = () => turnPhoto("rot");
$("#btn-mirror").onclick = () => turnPhoto("flipH");
$("#btn-flipv").onclick = () => turnPhoto("flipV");

/* tilt slider: rebuilding a big photo takes a moment, so at most once per frame */
let tiltFrame = 0;
function syncTiltSlider() {
  setSlider("tilt", wiz.angle || 0);
  $("#tilt").previousElementSibling.textContent = (wiz.angle || 0) + "°";
}
$("#panel-crop").addEventListener(
  "pointerdown",
  (e) => {
    if (e.target.closest("#tilt")) snapshot();
  },
  true,
);
$("#panel-crop").addEventListener("input", (e) => {
  if (e.target.id !== "tilt") return;
  e.target.previousElementSibling.textContent = e.target.value + "°";
  wiz.angle = +e.target.value;
  cancelAnimationFrame(tiltFrame);
  tiltFrame = requestAnimationFrame(() => {
    buildPhoto();
    drawCrop();
  });
});

/* ---------- crop rectangle ---------- */

for (const [value, label] of RATIOS) {
  const b = document.createElement("button");
  b.className = "chip";
  b.dataset.ratio = value;
  if (label.includes(":")) b.textContent = label;
  else b.dataset.i = label;
  b.onclick = () => {
    snapshot();
    if (value < 0) {
      wiz.ratio = photo.width / photo.height;
      wiz.rect = { x: 0, y: 0, w: photo.width, h: photo.height };
    } else {
      wiz.ratio = value;
      fitRectToRatio();
    }
    highlightRatio();
    photoChanged();
    drawCrop();
  };
  $("#ratio-chips").append(b);
}

/* margins ("Поля"): the frame may reach beyond the photo; what is outside is filled with one color */
{
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.id = "btn-pad";
  chip.dataset.i = "pad";
  chip.onclick = () => {
    snapshot();
    wiz.pad = { ...wiz.pad, on: !wiz.pad.on };
    if (wiz.pad.on && !wiz.pad.color) wiz.pad.color = photoEdgeColor();
    if (wiz.pad.on) {
      if (wiz.ratio)
        fitRectToRatio(); // with a ratio chosen: the whole photo inside, margins around it
      else toast(t("h_pad"));
    } else clampRectToPhoto();
    highlightRatio();
    photoChanged();
    drawCrop();
  };
  $("#ratio-chips").append(chip, Object.assign(document.createElement("span"), { id: "pad-color-slot" }));
  $("#pad-color-slot").outerHTML = colorButtonHtml("pad-color", "#ffffff", "hidden");
  $("#pad-color").onclick = async () =>
    openColorPicker({
      value: wiz.pad.color || "#ffffff",
      title: t("pad"),
      rows: [{ label: t("cp_photo"), colors: [...new Set([photoEdgeColor(), ...(await photoColors())])] }],
      onDone: (hex) => {
        snapshot();
        wiz.pad = { ...wiz.pad, color: hex };
        highlightRatio();
        photoChanged();
        drawCrop();
      },
    });
}

/** Average color along the photo's edge (the default margin color: the picture seems to continue). */
function photoEdgeColor() {
  const n = 96;
  const c = createCanvas(n, n).getContext("2d");
  c.drawImage(photo, 0, 0, n, n);
  return rgbToHex(...edgeColor(c.getImageData(0, 0, n, n).data, n, n));
}

function highlightRatio() {
  $$("#ratio-chips .chip[data-ratio]").forEach((b) => {
    const v = +b.dataset.ratio;
    const r = wiz.ratio;
    const on = v === 0 ? !r : v > 0 ? Math.abs(v - r) < 1e-6 : !!r && Math.abs(r - photo.width / photo.height) < 1e-6;
    b.classList.toggle("on", on);
  });
  $("#btn-pad").classList.toggle("on", !!wiz.pad.on);
  const padColor = $("#pad-color");
  padColor.hidden = !wiz.pad.on;
  padColor.style.background = wiz.pad.color || "#ffffff";
}

/** Where the frame may go: the photo, or with margins on, up to half its longer side beyond each edge. */
function cropBounds() {
  const m = wiz.pad.on ? Math.max(photo.width, photo.height) / 2 : 0;
  return { x0: -m, y0: -m, x1: photo.width + m, y1: photo.height + m };
}

/** Margins turned off: the frame goes back inside the photo. */
function clampRectToPhoto() {
  const r = wiz.rect;
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(photo.width, r.x + r.w);
  const y1 = Math.min(photo.height, r.y + r.h);
  wiz.rect =
    x1 - x0 >= 12 && y1 - y0 >= 12
      ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      : { x: 0, y: 0, w: photo.width, h: photo.height };
  if (wiz.ratio) fitRectToRatio();
}

/**
 * Frame of the chosen ratio. Without margins: the largest one inside the photo, centered where the current
 * one is. With margins: the smallest one that holds the whole photo (the rest becomes margin).
 */
function fitRectToRatio() {
  const R = wiz.ratio;
  if (!R) return;
  const PW = photo.width;
  const PH = photo.height;
  let w;
  let h;
  if (wiz.pad.on) {
    if (PW / PH > R) {
      w = PW;
      h = w / R;
    } else {
      h = PH;
      w = h * R;
    }
    wiz.rect = { w, h, x: (PW - w) / 2, y: (PH - h) / 2 };
    return;
  }
  if (PW / PH > R) {
    h = PH;
    w = h * R;
  } else {
    w = PW;
    h = w / R;
  }
  const r = wiz.rect;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  wiz.rect = {
    w,
    h,
    x: Math.min(PW - w, Math.max(0, cx - w / 2)),
    y: Math.min(PH - h, Math.max(0, cy - h / 2)),
  };
}

const cropRatio = () => wiz.rect.w / wiz.rect.h;

/** Area the view fits on screen: the photo, plus the frame where it reaches into the margins. */
let frozenBox = null; // kept while the frame is being dragged, so the view does not jump under the finger
function viewBox() {
  if (!wiz.pad.on) return { x0: 0, y0: 0, x1: photo.width, y1: photo.height };
  if (frozenBox) return frozenBox;
  const r = wiz.rect;
  return {
    x0: Math.min(0, r.x),
    y0: Math.min(0, r.y),
    x1: Math.max(photo.width, r.x + r.w),
    y1: Math.max(photo.height, r.y + r.h),
  };
}

/** Where the photo sits on screen: screen = offset + photoPixel * scale. */
function cropGeometry() {
  const w = cropCanvas.clientWidth;
  const h = cropCanvas.clientHeight;
  const b = viewBox();
  const BW = b.x1 - b.x0;
  const BH = b.y1 - b.y0;
  const scale = Math.min(w / BW, h / BH) * 0.94 * wiz.zoom;
  return {
    scale,
    ox: (w - BW * scale) / 2 - b.x0 * scale + wiz.panX,
    oy: (h - BH * scale) / 2 - b.y0 * scale + wiz.panY,
    w,
    h,
    box: b,
  };
}

function drawCrop() {
  if (wiz.step !== 1 || !photo) return;
  const g = cropGeometry();
  const dpr = devicePixelRatio || 1;
  if (cropCanvas.width !== Math.round(g.w * dpr) || cropCanvas.height !== Math.round(g.h * dpr)) {
    cropCanvas.width = Math.round(g.w * dpr);
    cropCanvas.height = Math.round(g.h * dpr);
  }
  const x = cropCtx;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, g.w, g.h);
  const PW = photo.width * g.scale;
  const PH = photo.height * g.scale;
  const r = wiz.rect;
  const X = g.ox + r.x * g.scale;
  const Y = g.oy + r.y * g.scale;
  const RW = r.w * g.scale;
  const RH = r.h * g.scale;
  if (wiz.pad.on) {
    x.fillStyle = wiz.pad.color || "#fff";
    x.fillRect(X, Y, RW, RH);
  }
  x.drawImage(photo, g.ox, g.oy, PW, PH);
  // darken the photo outside the crop
  x.save();
  x.beginPath();
  x.rect(g.ox, g.oy, PW, PH);
  x.clip();
  x.beginPath();
  x.rect(g.ox, g.oy, PW, PH);
  x.rect(X, Y, RW, RH);
  x.fillStyle = "rgba(0,0,0,.55)";
  x.fill("evenodd");
  x.restore();
  drawEditorOverlay(x, g);
  if (wiz.tool !== "crop") {
    x.strokeStyle = "#fff";
    x.globalAlpha = 0.6;
    x.lineWidth = 1;
    x.strokeRect(X, Y, RW, RH);
    x.globalAlpha = 1;
    return;
  }
  // frame, rule-of-thirds lines, corner handles
  x.strokeStyle = "#fff";
  x.lineWidth = 1.5;
  x.strokeRect(X, Y, RW, RH);
  x.globalAlpha = 0.5;
  x.beginPath();
  for (let i = 1; i < 3; i++) {
    x.moveTo(X + (RW * i) / 3, Y);
    x.lineTo(X + (RW * i) / 3, Y + RH);
    x.moveTo(X, Y + (RH * i) / 3);
    x.lineTo(X + RW, Y + (RH * i) / 3);
  }
  x.stroke();
  x.globalAlpha = 1;
  x.fillStyle = "#fff";
  for (const [a, b] of [
    [X, Y],
    [X + RW, Y],
    [X, Y + RH],
    [X + RW, Y + RH],
  ]) {
    x.beginPath();
    x.arc(a, b, 9, 0, 7);
    x.fill();
  }
}

/** Drags corner "tl" | "tr" | "bl" | "br" by (dx, dy) photo pixels, keeping the ratio if one is set. */
function resizeCrop(corner, dx, dy) {
  const r = wiz.rect;
  const R = wiz.ratio;
  const b = cropBounds();
  const right = corner[1] === "r";
  const bottom = corner[0] === "b";
  const anchorX = right ? r.x : r.x + r.w;
  const anchorY = bottom ? r.y : r.y + r.h;
  const px = Math.max(b.x0, Math.min(b.x1, (right ? r.x + r.w : r.x) + dx));
  const py = Math.max(b.y0, Math.min(b.y1, (bottom ? r.y + r.h : r.y) + dy));
  let w = Math.max(12, Math.abs(px - anchorX));
  let h = Math.max(12, Math.abs(py - anchorY));
  if (R) {
    const roomX = right ? b.x1 - anchorX : anchorX - b.x0;
    const roomY = bottom ? b.y1 - anchorY : anchorY - b.y0;
    w = Math.min(w, roomX, roomY * R);
    h = w / R;
  }
  wiz.rect = { x: right ? anchorX : anchorX - w, y: bottom ? anchorY : anchorY - h, w, h };
}

const cropPointers = new Map();
let cropMode = null; // "tl" | "tr" | "bl" | "br" | "move" | "pinch"
let pinchDist = 0;
let cropSnapshotTaken = false;

cropCanvas.addEventListener("pointerdown", (e) => {
  cropCanvas.setPointerCapture(e.pointerId);
  cropPointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  frozenBox = frozenBox || viewBox();
  if (cropPointers.size > 1) {
    cropMode = "pinch";
    pinchDist = 0;
    return;
  }
  const g = cropGeometry();
  const r = wiz.rect;
  const X = g.ox + r.x * g.scale;
  const Y = g.oy + r.y * g.scale;
  const RW = r.w * g.scale;
  const RH = r.h * g.scale;
  cropMode = null;
  for (const [a, b, corner] of [
    [X, Y, "tl"],
    [X + RW, Y, "tr"],
    [X, Y + RH, "bl"],
    [X + RW, Y + RH, "br"],
  ])
    if (Math.hypot(e.offsetX - a, e.offsetY - b) < 34) cropMode = corner;
  if (!cropMode && e.offsetX > X && e.offsetX < X + RW && e.offsetY > Y && e.offsetY < Y + RH) cropMode = "move";
});

cropCanvas.addEventListener("pointermove", (e) => {
  const old = cropPointers.get(e.pointerId);
  if (!old) return;
  const now = [e.offsetX, e.offsetY];
  cropPointers.set(e.pointerId, now);
  if (cropMode && !cropSnapshotTaken) {
    snapshot();
    cropSnapshotTaken = true;
  }
  const k = cropGeometry().scale;
  const r = wiz.rect;
  const b = cropBounds();
  if (cropPointers.size > 1) {
    // pinch resizes the crop around its center
    const [p, q] = [...cropPointers.values()];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (pinchDist) {
      const s = Math.min(pinchDist / d, (b.x1 - b.x0) / r.w, (b.y1 - b.y0) / r.h);
      const w = Math.max(12, r.w * s);
      const h = Math.max(12, r.h * s);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      wiz.rect = {
        w,
        h,
        x: Math.max(b.x0, Math.min(b.x1 - w, cx - w / 2)),
        y: Math.max(b.y0, Math.min(b.y1 - h, cy - h / 2)),
      };
    }
    pinchDist = d;
  } else if (cropMode === "move") {
    wiz.rect.x = Math.max(b.x0, Math.min(b.x1 - r.w, r.x + (now[0] - old[0]) / k));
    wiz.rect.y = Math.max(b.y0, Math.min(b.y1 - r.h, r.y + (now[1] - old[1]) / k));
  } else if (cropMode) resizeCrop(cropMode, (now[0] - old[0]) / k, (now[1] - old[1]) / k);
  if (cropMode) photoChanged();
  drawCrop();
});

const cropPointerUp = (e) => {
  cropPointers.delete(e.pointerId);
  if (!cropPointers.size) {
    cropMode = null;
    cropSnapshotTaken = false;
    frozenBox = null;
    drawCrop(); // the view may now fit the margins differently
  }
};
cropCanvas.addEventListener("pointerup", cropPointerUp);
cropCanvas.addEventListener("pointercancel", cropPointerUp);

/* ---------- photo editor (pan / brush / shapes / fill / color replace / blur / clone / restore / eyedropper)
   Every edit is one entry of wiz.strokes:
     brush    { color, radius, points }            (older canvases: same, restore: true = restore stroke)
     restore  { restore: true, radius, points }    copies the untouched photo back
     shape    { kind: "shape", shape: "rect" | "oval" | "line", color, radius, points }
              rect/oval: the four corners (top-left, top-right, bottom-right, bottom-left), line: two ends
     fill     { kind: "fill", color, tol, seed: [r, g, b], points: [x, y] }
     recolor  { kind: "recolor", color, tol, from: [r, g, b], points: [x, y] }
     blur     { kind: "blur", radius, points }
     clone    { kind: "clone", radius, points, off: [dx, dy] }  copies from (point + off)
   points, radius and off are in original-photo coordinates. */

const turn = (u, v, quarter) =>
  [
    [u, v],
    [-v, u],
    [-u, -v],
    [v, -u],
  ][quarter & 3];
function sourceToPhoto(x, y) {
  const { width: w, height: h } = wiz.image;
  let u = x - w / 2;
  if (wiz.mirrored) u = -u;
  const [a, b] = turn(u, y - h / 2, wiz.rotation);
  const [c, s] = tiltMatrix();
  return [a * c - b * s + wiz.base.width / 2, a * s + b * c + wiz.base.height / 2];
}
function photoToSource(x, y) {
  const { width: w, height: h } = wiz.image;
  const [c, s, k] = tiltMatrix();
  const X = x - wiz.base.width / 2;
  const Y = y - wiz.base.height / 2;
  let [u, v] = turn((X * c + Y * s) / (k * k), (-X * s + Y * c) / (k * k), 4 - (wiz.rotation & 3));
  if (wiz.mirrored) u = -u;
  return [u + w / 2, v + h / 2];
}

const editKind = (op) => op.kind || (op.restore ? "restore" : "brush");
/** All points of an edit in photo coordinates, flat [x, y, x, y, ...]. */
function opPoints(op) {
  const p = [];
  for (let i = 0; i < op.points.length; i += 2) p.push(...sourceToPhoto(op.points[i], op.points[i + 1]));
  return p;
}
/** Blur radius of the blur brush, in photo pixels, for a brush of radius r. */
const blurPx = (r) => Math.max(1, r * 0.25);

/** Draws a round-capped line through flat points p (one point = a dot). */
function tracePath(ctx, p, r, dx = 0, dy = 0) {
  ctx.lineWidth = 2 * r;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.beginPath();
  if (p.length <= 2) {
    ctx.arc(p[0] - dx, p[1] - dy, r, 0, 7);
    ctx.fill();
    return;
  }
  ctx.moveTo(p[0] - dx, p[1] - dy);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] - dx, p[i + 1] - dy);
  ctx.stroke();
}

const scratch = createCanvas(1, 1);
/**
 * Copies picture `src` onto the photo, but only under the brush path p (radius r): restore copies the
 * untouched photo, clone copies the photo shifted by (dx, dy), blur copies a blurred photo.
 */
function drawFrom(src, dx, dy, p, r, blur = 0) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    minX = Math.min(minX, p[i]);
    maxX = Math.max(maxX, p[i]);
    minY = Math.min(minY, p[i + 1]);
    maxY = Math.max(maxY, p[i + 1]);
  }
  const X0 = Math.max(0, Math.floor(minX - r - 2));
  const Y0 = Math.max(0, Math.floor(minY - r - 2));
  const X1 = Math.min(photo.width, Math.ceil(maxX + r + 2));
  const Y1 = Math.min(photo.height, Math.ceil(maxY + r + 2));
  const w = X1 - X0;
  const h = Y1 - Y0;
  if (w < 1 || h < 1) return;
  scratch.width = w;
  scratch.height = h;
  const c = scratch.getContext("2d");
  // with blur, also take the surroundings, so pixels near the edge of the brush blur with real neighbours
  const m = blur ? Math.ceil(blur * 3) : 0;
  if (blur) c.filter = `blur(${blur}px)`;
  c.drawImage(src, X0 + dx - m, Y0 + dy - m, w + 2 * m, h + 2 * m, -m, -m, w + 2 * m, h + 2 * m);
  c.filter = "none";
  c.globalCompositeOperation = "destination-in";
  c.fillStyle = c.strokeStyle = "#000";
  tracePath(c, p, r, X0, Y0);
  c.globalCompositeOperation = "source-over";
  photo.getContext("2d").drawImage(scratch, X0, Y0);
}

function drawShape(ctx, op, p) {
  ctx.fillStyle = ctx.strokeStyle = op.color;
  if (op.shape === "line") {
    tracePath(ctx, p, op.radius * tiltMatrix()[2]);
    return;
  }
  ctx.beginPath();
  if (op.shape === "rect") {
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < 8; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.closePath();
  } else {
    // ellipse inside the four corners: a unit circle stretched along the two sides
    ctx.save();
    ctx.transform(
      (p[2] - p[0]) / 2,
      (p[3] - p[1]) / 2,
      (p[6] - p[0]) / 2,
      (p[7] - p[1]) / 2,
      (p[0] + p[4]) / 2,
      (p[1] + p[5]) / 2,
    );
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.restore();
  }
  ctx.fill();
}

/** Fill and color replace work on the pixels of the whole photo. */
function applyPixelEdit(op) {
  const W = photo.width;
  const H = photo.height;
  const ctx = photo.getContext("2d");
  const img = ctx.getImageData(0, 0, W, H);
  const color = hexToRgb(op.color);
  if (op.kind === "fill") {
    const [x, y] = sourceToPhoto(op.points[0], op.points[1]).map(Math.floor);
    blendMask(img.data, floodFillMask(img.data, W, H, x, y, op.seed, op.tol), color);
  } else recolor(img.data, op.from, color, op.tol);
  ctx.putImageData(img, 0, 0);
}

/** Applies one whole edit to the photo (replaying; while drawing, strokes go segment by segment). */
function applyEdit(op) {
  const ctx = photo.getContext("2d");
  const kind = editKind(op);
  const p = opPoints(op);
  const r = (op.radius || 0) * tiltMatrix()[2];
  if (kind === "brush") {
    ctx.fillStyle = ctx.strokeStyle = op.color;
    tracePath(ctx, p, r);
  } else if (kind === "restore") drawFrom(wiz.base, 0, 0, p, r);
  else if (kind === "blur") drawFrom(photo, 0, 0, p, r, blurPx(r));
  else if (kind === "clone") {
    const [dx, dy] = cloneShift(op);
    drawFrom(photo, dx, dy, p, r);
  } else if (kind === "shape") drawShape(ctx, op, p);
  else applyPixelEdit(op);
}

/** Clone offset of an edit, in photo pixels (the same everywhere: the photo transform is linear). */
function cloneShift(op) {
  const a = sourceToPhoto(op.points[0], op.points[1]);
  const b = sourceToPhoto(op.points[0] + op.off[0], op.points[1] + op.off[1]);
  return [b[0] - a[0], b[1] - a[1]];
}

/** photo = base + all edits. */
function replayEdits() {
  if (!wiz.strokes.length) {
    photo = wiz.base;
    return;
  }
  photo = createCanvas(wiz.base.width, wiz.base.height);
  photo.getContext("2d").drawImage(wiz.base, 0, 0);
  for (const op of wiz.strokes) applyEdit(op);
}

/** Before the first edit photo is the base itself; edits must not change the base. */
function ensureOwnPhoto() {
  if (photo !== wiz.base) return;
  photo = createCanvas(wiz.base.width, wiz.base.height);
  photo.getContext("2d").drawImage(wiz.base, 0, 0);
}

/* tools that need a color, a size, a tolerance, a shape kind or a clone source */
const COLOR_TOOLS = ["brush", "shape", "fill", "recolor", "pick"];
const SIZE_TOOLS = ["brush", "shape", "blur", "clone", "rest"];
const TOL_TOOLS = ["fill", "recolor"];

function updateEditorUi() {
  $$("#editor-tools [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === wiz.tool));
  const cloneReady = wiz.tool === "clone" && wiz.clone;
  $("#editor-hint").textContent = t("h_" + wiz.tool + (cloneReady ? "2" : ""));
  const tool = wiz.tool;
  $("#frame-options").hidden = tool !== "crop";
  $("#brush-color").hidden = !COLOR_TOOLS.includes(tool);
  $("#brush-color").style.background = wiz.color;
  $("#shape-kinds").hidden = tool !== "shape";
  $$("#shape-kinds [data-shape]").forEach((b) => b.classList.toggle("on", b.dataset.shape === wiz.shape));
  $("#btn-clone-source").hidden = tool !== "clone";
  $("#brush-size").closest(".field").hidden = !SIZE_TOOLS.includes(tool);
  $("#tol").closest(".field").hidden = !TOL_TOOLS.includes(tool);
  $("#paint-options").hidden = ![...COLOR_TOOLS, ...SIZE_TOOLS].includes(tool);
  $("#btn-edit-reset").hidden = tool === "crop";
  drawCrop();
}

/** Zoom the crop view by factor s around screen point (mx, my). */
function zoomCropView(s, mx, my) {
  const g = cropGeometry();
  const z = Math.max(1, Math.min(40, wiz.zoom * s));
  const k = g.scale * (z / wiz.zoom);
  const u = (mx - g.ox) / g.scale;
  const v = (my - g.oy) / g.scale;
  const b = g.box;
  wiz.zoom = z;
  wiz.panX = mx - u * k - ((g.w - (b.x1 - b.x0) * k) / 2 - b.x0 * k);
  wiz.panY = my - v * k - ((g.h - (b.y1 - b.y0) * k) / 2 - b.y0 * k);
  if (z === 1) wiz.panX = wiz.panY = 0;
  drawCrop();
}

const pointerToPhoto = (e) => {
  const g = cropGeometry();
  return [(e.offsetX - g.ox) / g.scale, (e.offsetY - g.oy) / g.scale];
};
const insidePhoto = ([x, y]) => x >= 0 && y >= 0 && x < photo.width && y < photo.height;
function photoPixel([x, y]) {
  const d = photo.getContext("2d").getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  return [d[0], d[1], d[2]];
}

function setEditColor(hex) {
  wiz.color = hex;
  $("#brush-color").style.background = hex;
}

function pickColor(e) {
  const p = pointerToPhoto(e);
  if (insidePhoto(p)) setEditColor(rgbToHex(...photoPixel(p)));
}

/** Main colors of the photo (for the color picker), recomputed when the photo changes. */
async function photoColors() {
  if (wiz.photoColors && wiz.photoColors.key === wiz.editVersion) return wiz.photoColors.colors;
  const n = 64;
  const c = createCanvas(n, n).getContext("2d");
  c.drawImage(photo, 0, 0, n, n);
  const pal = await kmeansPalette(c.getImageData(0, 0, n, n).data, n * n, 12);
  const bytes = Uint8Array.from(pal);
  const colors = [
    ...new Set(paletteOrder(bytes, "col").map((k) => rgbToHex(bytes[k * 3], bytes[k * 3 + 1], bytes[k * 3 + 2]))),
  ];
  wiz.photoColors = { key: wiz.editVersion, colors };
  return colors;
}

$("#brush-color").onclick = async () => {
  const colors = await photoColors();
  openColorPicker({
    value: wiz.color,
    rows: [{ label: t("cp_photo"), colors }],
    onEyedropper: () => {
      if (wiz.tool !== "pick") wiz.prevTool = wiz.tool;
      wiz.tool = "pick";
      updateEditorUi();
    },
    onDone: setEditColor,
  });
};

/* things drawn over the photo while editing: shape being dragged, clone source, brush outline */
function drawEditorOverlay(x, g) {
  const toScreen = ([px, py]) => [g.ox + px * g.scale, g.oy + py * g.scale];
  const d = editDraft;
  if (d && d.end) {
    const op = shapeEdit(d.start, d.end);
    const p = [];
    for (let i = 0; i < op.photoPoints.length; i += 2) p.push(...toScreen([op.photoPoints[i], op.photoPoints[i + 1]]));
    x.save();
    x.globalAlpha = 0.85;
    drawShape(x, { ...op, radius: op.radius * g.scale }, p);
    x.restore();
  }
  if (wiz.tool === "clone" && wiz.clone) {
    // where the clone copies from right now
    const at =
      wiz.clone.off && lastPoint
        ? [lastPoint[0] + wiz.clone.shift[0], lastPoint[1] + wiz.clone.shift[1]]
        : sourceToPhoto(...wiz.clone.source);
    const [sx, sy] = toScreen(at);
    const rr = Math.max(6, wiz.brushSize / 2);
    x.lineWidth = 2;
    for (const [color, w] of [
      ["#000a", 4],
      ["#fff", 2],
    ]) {
      x.strokeStyle = color;
      x.lineWidth = w;
      x.beginPath();
      x.arc(sx, sy, rr, 0, 7);
      x.moveTo(sx - rr - 6, sy);
      x.lineTo(sx + rr + 6, sy);
      x.moveTo(sx, sy - rr - 6);
      x.lineTo(sx, sy + rr + 6);
      x.stroke();
    }
  }
}

/** A shape edit from two photo points (rect/oval: axis-aligned on screen; line: the two points). */
function shapeEdit(a, b) {
  const corners =
    wiz.shape === "line"
      ? [a, b]
      : [
          [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
          [Math.max(a[0], b[0]), Math.min(a[1], b[1])],
          [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
          [Math.min(a[0], b[0]), Math.max(a[1], b[1])],
        ];
  return {
    kind: "shape",
    shape: wiz.shape,
    color: wiz.color,
    radius: wiz.brushSize / 2 / cropGeometry().scale / tiltMatrix()[2],
    points: corners.flatMap((q) => photoToSource(q[0], q[1])),
    photoPoints: corners.flat(),
  };
}

const editPointers = new Map();
let activeStroke = null; // edit being drawn with the finger
let strokeSource = null; // picture the clone/blur stroke copies from (the photo as it was when it started)
let lastPoint = null;
let editPinch = 0;
let editDraft = null; // { start, end } of a shape being dragged
let tapStart = null; // [x, y] screen position of a touch that may turn out to be a tap

/** One piece of the stroke being drawn, from photo point a to b. */
function strokeSegment(op, a, b) {
  const kind = editKind(op);
  const r = op.radius * tiltMatrix()[2];
  const p = a === b ? [a[0], a[1]] : [a[0], a[1], b[0], b[1]];
  if (kind === "brush") {
    const ctx = photo.getContext("2d");
    ctx.fillStyle = ctx.strokeStyle = op.color;
    tracePath(ctx, p, r);
  } else if (kind === "restore") drawFrom(wiz.base, 0, 0, p, r);
  else if (kind === "blur") drawFrom(strokeSource, 0, 0, p, r, blurPx(r));
  else if (kind === "clone") drawFrom(strokeSource, wiz.clone.shift[0], wiz.clone.shift[1], p, r);
}

// These run in the capture phase, before the crop handlers, and stop them unless the crop tool is active.
cropCanvas.addEventListener(
  "pointerdown",
  (e) => {
    const tool = wiz.tool;
    if (tool === "crop") return;
    e.stopImmediatePropagation();
    cropCanvas.setPointerCapture(e.pointerId);
    editPointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (editPointers.size > 1) {
      // second finger: this is a pinch, drop the dot the first finger just painted
      const top = history[history.length - 1];
      if (activeStroke && activeStroke.points.length <= 4 && top && top.stroke) {
        wiz.strokes.pop();
        history.pop();
        replayEdits();
        photoChanged();
        $("#wiz-undo").disabled = !history.length;
      }
      activeStroke = editDraft = tapStart = null;
      editPinch = 0;
      return drawCrop();
    }
    tapStart = [e.offsetX, e.offsetY];
    const p = pointerToPhoto(e);
    if (tool === "pick") return pickColor(e);
    if (tool === "shape") {
      editDraft = { start: p, end: null };
      return;
    }
    const radius = wiz.brushSize / 2 / cropGeometry().scale / tiltMatrix()[2];
    let op = null;
    if (tool === "brush") op = { color: wiz.color, radius, points: photoToSource(...p) };
    else if (tool === "rest") op = { restore: true, radius, points: photoToSource(...p) };
    else if (tool === "blur") op = { kind: "blur", radius, points: photoToSource(...p) };
    else if (tool === "clone" && wiz.clone) {
      const start = photoToSource(...p);
      if (!wiz.clone.off) wiz.clone.off = [wiz.clone.source[0] - start[0], wiz.clone.source[1] - start[1]];
      op = { kind: "clone", radius, points: start, off: [...wiz.clone.off] };
      wiz.clone.shift = cloneShift(op);
    }
    if (!op) return;
    ensureOwnPhoto();
    if (tool === "blur" || tool === "clone") {
      strokeSource = createCanvas(photo.width, photo.height);
      strokeSource.getContext("2d").drawImage(photo, 0, 0);
    }
    wiz.strokes.push(op);
    pushHistory({ stroke: true });
    activeStroke = op;
    lastPoint = p;
    strokeSegment(op, p, p);
    photoChanged();
    drawCrop();
  },
  true,
);

cropCanvas.addEventListener(
  "pointermove",
  (e) => {
    const tool = wiz.tool;
    if (tool === "crop" || !editPointers.has(e.pointerId)) return;
    e.stopImmediatePropagation();
    const old = editPointers.get(e.pointerId);
    const now = [e.offsetX, e.offsetY];
    editPointers.set(e.pointerId, now);
    if (tapStart && Math.hypot(now[0] - tapStart[0], now[1] - tapStart[1]) > 10) tapStart = null;
    if (editPointers.size > 1) {
      const [a, b] = [...editPointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (editPinch) zoomCropView(d / editPinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      editPinch = d;
      wiz.panX += (now[0] - old[0]) / 2;
      wiz.panY += (now[1] - old[1]) / 2;
      return drawCrop();
    }
    if (tool === "pan" || ((tool === "fill" || tool === "recolor" || (tool === "clone" && !wiz.clone)) && !tapStart)) {
      // tap tools: a drag moves the picture instead
      wiz.panX += now[0] - old[0];
      wiz.panY += now[1] - old[1];
      drawCrop();
    } else if (tool === "pick") pickColor(e);
    else if (tool === "shape" && editDraft) {
      editDraft.end = pointerToPhoto(e);
      drawCrop();
    } else if (activeStroke) {
      const q = pointerToPhoto(e);
      strokeSegment(activeStroke, lastPoint, q);
      activeStroke.points.push(...photoToSource(q[0], q[1]));
      lastPoint = q;
      photoChanged();
      drawCrop();
    }
  },
  true,
);

const editPointerUp = (e) => {
  if (wiz.tool === "crop") return;
  e.stopImmediatePropagation();
  const single = editPointers.size === 1 && editPointers.has(e.pointerId);
  editPointers.delete(e.pointerId);
  if (single) finishEdit(e);
  if (!editPointers.size) {
    activeStroke = editDraft = tapStart = strokeSource = null;
    editPinch = 0;
    drawCrop();
  }
};
cropCanvas.addEventListener("pointerup", editPointerUp, true);
cropCanvas.addEventListener(
  "pointercancel",
  (e) => {
    tapStart = editDraft = null;
    editPointerUp(e);
  },
  true,
);

/** The finger was lifted: commit a shape, apply a tap tool, end the eyedropper. */
async function finishEdit(e) {
  const tool = wiz.tool;
  const tapped = !!tapStart;
  if (tool === "pick") {
    wiz.tool = wiz.prevTool || "brush";
    wiz.prevTool = null;
    return updateEditorUi();
  }
  if (tool === "shape" && editDraft && editDraft.end) {
    const op = shapeEdit(editDraft.start, editDraft.end);
    delete op.photoPoints;
    editDraft = null;
    return commitEdit(op);
  }
  if (!tapped) return;
  const p = pointerToPhoto(e);
  if (tool === "clone" && !wiz.clone) {
    if (!insidePhoto(p)) return;
    wiz.clone = { source: photoToSource(...p), off: null, shift: [0, 0] };
    return updateEditorUi();
  }
  if ((tool === "fill" || tool === "recolor") && insidePhoto(p)) {
    const color = photoPixel(p);
    const op =
      tool === "fill"
        ? { kind: "fill", color: wiz.color, tol: wiz.tol, seed: color, points: photoToSource(...p) }
        : { kind: "recolor", color: wiz.color, tol: wiz.tol, from: color, points: photoToSource(...p) };
    setBusy(true);
    await yieldToBrowser();
    commitEdit(op);
    setBusy(false);
  }
}

function commitEdit(op) {
  ensureOwnPhoto();
  wiz.strokes.push(op);
  pushHistory({ stroke: true });
  applyEdit(op);
  photoChanged();
  drawCrop();
}

cropCanvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomCropView(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.offsetX, e.offsetY);
  },
  { passive: false },
);

$("#panel-crop").addEventListener("click", (e) => {
  const toolBtn = e.target.closest("#editor-tools [data-tool]");
  const zoomBtn = e.target.closest("[data-zoom]");
  const shapeBtn = e.target.closest("[data-shape]");
  if (toolBtn) {
    wiz.tool = toolBtn.dataset.tool;
    wiz.prevTool = null;
    updateEditorUi();
  }
  if (shapeBtn) {
    wiz.shape = shapeBtn.dataset.shape;
    updateEditorUi();
  }
  if (zoomBtn) {
    const g = cropGeometry();
    if (zoomBtn.dataset.zoom === "0") {
      wiz.zoom = 1;
      wiz.panX = wiz.panY = 0;
      drawCrop();
    } else zoomCropView(zoomBtn.dataset.zoom > 0 ? 1.4 : 1 / 1.4, g.w / 2, g.h / 2);
  }
});
$("#btn-clone-source").onclick = () => {
  wiz.clone = null;
  updateEditorUi();
};
$("#panel-crop").addEventListener("input", (e) => {
  if (e.target.id === "brush-size") {
    e.target.previousElementSibling.textContent = e.target.value;
    wiz.brushSize = +e.target.value;
  }
  if (e.target.id === "tol") {
    e.target.previousElementSibling.textContent = e.target.value;
    wiz.tol = +e.target.value;
  }
});
$("#btn-edit-reset").onclick = () => {
  if (!wiz.strokes.length) return;
  pushHistory({ strokesBefore: wiz.strokes });
  wiz.strokes = [];
  replayEdits();
  photoChanged();
  drawCrop();
};

/* ---------- step 2: adjustments ---------- */

/** Cropped photo pixels (at most 12 MP), cached until the photo or crop changes. */
function sourcePixels() {
  const R = wiz.rect;
  const margins = wiz.pad.on && (R.x < 0 || R.y < 0 || R.x + R.w > photo.width || R.y + R.h > photo.height);
  const key = [wiz.editVersion, R.x, R.y, R.w, R.h, margins && wiz.pad.color].join();
  if (wiz.source && wiz.source.key === key) return wiz.source;
  if (margins) {
    // a canvas of the frame's size in the margin color, with the photo drawn where it lies
    const s = Math.min(1, Math.sqrt(MAX_SOURCE_PIXELS / (R.w * R.h)));
    const w = Math.max(1, Math.round(R.w * s));
    const h = Math.max(1, Math.round(R.h * s));
    const c = createCanvas(w, h).getContext("2d");
    c.fillStyle = wiz.pad.color || "#fff";
    c.fillRect(0, 0, w, h);
    c.imageSmoothingQuality = "high";
    c.drawImage(photo, Math.round(-R.x * s), Math.round(-R.y * s), photo.width * s, photo.height * s);
    const source = { data: c.getImageData(0, 0, w, h).data, width: w, height: h, key };
    return (wiz.source = source);
  }
  const sx = Math.min(photo.width - 1, Math.round(R.x));
  const sy = Math.min(photo.height - 1, Math.round(R.y));
  const sw = Math.max(1, Math.min(photo.width - sx, Math.round(R.w)));
  const sh = Math.max(1, Math.min(photo.height - sy, Math.round(R.h)));
  let source;
  if (sw * sh <= MAX_SOURCE_PIXELS) {
    source = { data: photo.getContext("2d").getImageData(sx, sy, sw, sh).data, width: sw, height: sh };
  } else {
    const s = Math.sqrt(MAX_SOURCE_PIXELS / (sw * sh));
    const w = Math.round(sw * s);
    const h = Math.round(sh * s);
    const c = createCanvas(w, h).getContext("2d");
    c.imageSmoothingQuality = "high";
    c.drawImage(photo, sx, sy, sw, sh, 0, 0, w, h);
    source = { data: c.getImageData(0, 0, w, h).data, width: w, height: h };
  }
  source.key = key;
  return (wiz.source = source);
}

/* ---------- step 2: preview with zoom and a before/after divider ----------
   The preview is drawn at the screen's real resolution: the visible part of the frame is drawn straight from
   the photo (the browser resamples it on the GPU) at exactly the screen pixels it covers, never more than the
   photo has there. Left of the divider it is shown as it is, right of it with the adjustments, which a Web
   Worker applies so that sliders and gestures never wait for them. When adjusting the whole preview is slow
   (the "enhance" filter), slider drags are previewed at reduced resolution, sharp again when the finger lifts.
   While pinching or dragging, the pictures already drawn are only moved and scaled; they are redrawn after.
   Coordinates are frame pixels: (0, 0) is the frame's top left corner, 1 unit = 1 photo pixel. */

const adjustWrap = $("#adjust-wrap");
const adjustOrig = $("#adjust-orig");
const adjView = { zoom: 1, cx: 0.5, cy: 0.5 }; // zoom and view center (0..1 of the frame)
const adjParts = { orig: null, origKey: "", result: null }; // part of the frame each canvas shows now
const adjRegions = new Map(); // unadjusted pixels of a part: key -> data (the last two)
let adjSliding = false; // a slider is being dragged
let adjSlow = false; // adjusting the full preview took long last time
let adjustFrame = 0;
const adjWorker = new Worker(new URL("./adjust.worker.js", import.meta.url), { type: "module" });
let adjBusy = false; // a job is in the worker
let adjNext = null; // the newest job, waiting for the worker
const adjScratch = createCanvas(1, 1);

const frameKey = () => {
  const R = wiz.rect;
  return [wiz.editVersion, R.x, R.y, R.w, R.h, wiz.pad.on && wiz.pad.color].join();
};

/** Where the frame goes at the current zoom: visible part [x0, x1) x [y0, y1), k = CSS px per frame px. */
function adjustLayout() {
  const W = adjustWrap.clientWidth;
  const H = adjustWrap.clientHeight;
  const fw = wiz.rect.w;
  const fh = wiz.rect.h;
  const k = Math.min(W / fw, H / fh) * adjView.zoom;
  const halfW = W / 2 / k;
  const halfH = H / 2 / k;
  // the picture covers the whole stage when it is bigger than it, and is centered when smaller
  const cx = fw * k > W ? Math.max(halfW, Math.min(fw - halfW, adjView.cx * fw)) : fw / 2;
  const cy = fh * k > H ? Math.max(halfH, Math.min(fh - halfH, adjView.cy * fh)) : fh / 2;
  adjView.cx = cx / fw;
  adjView.cy = cy / fh;
  return {
    k,
    fw,
    fh,
    key: frameKey(),
    x0: Math.max(0, cx - halfW),
    y0: Math.max(0, cy - halfH),
    x1: Math.min(fw, cx + halfW),
    y1: Math.min(fh, cy + halfH),
  };
}

/** Draws part of the frame into a w x h canvas context, margins included. */
function drawFramePart(ctx, w, h, part) {
  const R = wiz.rect;
  ctx.fillStyle = (wiz.pad.on && wiz.pad.color) || "#fff"; // margins, and the photo's own white background
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // a source rectangle reaching past the photo (margins) is clipped by drawImage in proportion
  ctx.drawImage(photo, R.x + part.x0, R.y + part.y0, part.x1 - part.x0, part.y1 - part.y0, 0, 0, w, h);
}

function sizeCanvas(canvas, w, h) {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

/** Puts each canvas where the part of the frame it shows lies on screen at the current zoom and center. */
function placeAdjustCanvases(L = adjustLayout()) {
  const W = adjustWrap.clientWidth;
  const H = adjustWrap.clientHeight;
  for (const [canvas, part] of [
    [adjustOrig, adjParts.orig],
    [adjustCanvas, adjParts.result],
  ]) {
    // a picture of another frame or photo (undo went back to a step-1 change) waits hidden for its update
    canvas.style.visibility = part && part.key === L.key ? "" : "hidden";
    if (!part) continue;
    Object.assign(canvas.style, {
      left: W / 2 + (part.x0 - adjView.cx * L.fw) * L.k + "px",
      top: H / 2 + (part.y0 - adjView.cy * L.fh) * L.k + "px",
      width: (part.x1 - part.x0) * L.k + "px",
      height: (part.y1 - part.y0) * L.k + "px",
    });
  }
  $("#adjust-fit").hidden = adjView.zoom < 1.01;
}

function drawAdjustPreview() {
  if (wiz.step !== 2 || !adjustWrap.clientWidth || !photo) return;
  const L = adjustLayout();
  const part = { x0: L.x0, y0: L.y0, x1: L.x1, y1: L.y1, key: L.key };
  const pw = L.x1 - L.x0;
  const ph = L.y1 - L.y0;
  // canvas pixels for the part: one per screen pixel, at most one per photo pixel
  const size = (quality) => {
    const s = Math.min(1, L.k * (devicePixelRatio || 1) * quality);
    return [Math.max(1, Math.round(pw * s)), Math.max(1, Math.round(ph * s))];
  };
  const [w, h] = size(1);
  const partKey = [L.key, L.x0, L.y0, pw, ph].join();
  if (adjParts.origKey !== partKey + w) {
    adjParts.origKey = partKey + w;
    sizeCanvas(adjustOrig, w, h);
    drawFramePart(adjustOrig.getContext("2d"), w, h, part);
    adjParts.orig = part;
  }
  if (!adjParts.result || adjParts.result.key !== part.key) {
    // nothing adjusted to show yet: the photo itself until the worker answers
    sizeCanvas(adjustCanvas, w, h);
    adjustCanvas.getContext("2d").drawImage(adjustOrig, 0, 0);
    adjParts.result = part;
  }
  const lowRes = adjSliding && adjSlow;
  const [jw, jh] = lowRes ? size(0.45) : [w, h];
  const regionKey = partKey + "/" + jw + "x" + jh;
  let pixels = adjRegions.get(regionKey);
  if (!pixels) {
    sizeCanvas(adjScratch, jw, jh);
    const ctx = adjScratch.getContext("2d");
    drawFramePart(ctx, jw, jh, part);
    pixels = ctx.getImageData(0, 0, jw, jh).data;
    adjRegions.set(regionKey, pixels);
    if (adjRegions.size > 2) adjRegions.delete(adjRegions.keys().next().value);
  }
  adjNext = {
    data: new Uint8ClampedArray(pixels),
    width: jw,
    height: jh,
    adjust: { ...wiz.adjust },
    part,
    full: !lowRes,
  };
  pumpAdjust();
  placeAdjustCanvases(L);
  placeAdjustDivider();
}

function pumpAdjust() {
  if (adjBusy || !adjNext) return;
  const job = adjNext;
  adjNext = null;
  adjBusy = true;
  adjWorker.postMessage(job, [job.data.buffer]);
}

adjWorker.onmessage = (e) => {
  adjBusy = false;
  const job = e.data;
  if (job.full) adjSlow = job.ms > 60;
  if (wiz.step === 2 && job.part.key === frameKey()) {
    sizeCanvas(adjustCanvas, job.width, job.height);
    adjustCanvas.getContext("2d").putImageData(new ImageData(job.data, job.width, job.height), 0, 0);
    adjParts.result = job.part;
    placeAdjustCanvases();
  }
  pumpAdjust();
};

function scheduleAdjust() {
  cancelAnimationFrame(adjustFrame);
  adjustFrame = requestAnimationFrame(drawAdjustPreview);
}

/* sliders */
$("#panel-adjust").addEventListener(
  "pointerdown",
  (e) => {
    if (e.target.closest(".range")) snapshot();
  },
  true,
);
$("#panel-adjust").addEventListener("input", (e) => {
  const el = e.target;
  if (el.type !== "range") return;
  el.previousElementSibling.textContent = el.value;
  wiz.adjust[el.id.slice(4)] = +el.value; // "adj-bri" -> "bri"
  wiz.result = null;
  adjSliding = true;
  scheduleAdjust();
});
// the finger left the slider: full resolution again
$("#panel-adjust").addEventListener("change", () => {
  adjSliding = false;
  scheduleAdjust();
});

/* before/after divider */
function placeAdjustDivider() {
  const x = Math.round((wiz.adjCompare ?? 0.5) * adjustWrap.clientWidth);
  $("#adjust-clip").style.width = x + "px";
  $("#adjust-line").style.left = x + "px";
}
const adjustKnob = $("#adjust-knob");
adjustKnob.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  adjustKnob.setPointerCapture(e.pointerId);
  adjustKnob.dragging = true;
});
adjustKnob.addEventListener("pointermove", (e) => {
  if (!adjustKnob.dragging) return;
  const r = adjustWrap.getBoundingClientRect();
  wiz.adjCompare = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  placeAdjustDivider();
});
const adjustKnobUp = () => (adjustKnob.dragging = false);
adjustKnob.addEventListener("pointerup", adjustKnobUp);
adjustKnob.addEventListener("pointercancel", adjustKnobUp);

/* zoom: pinch, drag, double tap, mouse wheel */
const adjPointers = new Map();
let adjPinch = 0;
let adjLastTap = 0;
let adjMoved = 0;

/** Zooms by factor f keeping screen point (sx, sy) over the same spot of the frame. */
function zoomAdjust(f, sx, sy) {
  const L = adjustLayout();
  const W = adjustWrap.clientWidth;
  const H = adjustWrap.clientHeight;
  const px = adjView.cx * L.fw + (sx - W / 2) / L.k; // frame point under the finger
  const py = adjView.cy * L.fh + (sy - H / 2) / L.k;
  const zoom = Math.max(1, Math.min(24, adjView.zoom * f));
  const k = (L.k / adjView.zoom) * zoom;
  adjView.zoom = zoom;
  adjView.cx = (px - (sx - W / 2) / k) / L.fw;
  adjView.cy = (py - (sy - H / 2) / k) / L.fh;
}

const stagePoint = (e) => {
  const r = adjustWrap.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
adjustWrap.addEventListener("pointerdown", (e) => {
  adjustWrap.setPointerCapture(e.pointerId);
  adjPointers.set(e.pointerId, stagePoint(e));
  adjPinch = 0;
  if (adjPointers.size === 1) adjMoved = 0;
});
adjustWrap.addEventListener("pointermove", (e) => {
  const old = adjPointers.get(e.pointerId);
  if (!old) return;
  const now = stagePoint(e);
  adjPointers.set(e.pointerId, now);
  adjMoved += Math.hypot(now[0] - old[0], now[1] - old[1]);
  if (adjPointers.size > 1) {
    const [a, b] = [...adjPointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (adjPinch) zoomAdjust(d / adjPinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    adjPinch = d;
  } else {
    const L = adjustLayout();
    adjView.cx -= (now[0] - old[0]) / L.k / L.fw;
    adjView.cy -= (now[1] - old[1]) / L.k / L.fh;
  }
  placeAdjustCanvases();
});
const adjustPointerUp = (e) => {
  if (!adjPointers.delete(e.pointerId)) return;
  adjPinch = 0;
  if (adjPointers.size) return;
  const now = performance.now();
  if (adjMoved < 10) {
    // double tap: zoom in 3x at that spot, or back to the whole picture
    if (now - adjLastTap < 320) {
      if (adjView.zoom > 1.01) adjView.zoom = 1;
      else zoomAdjust(3, ...stagePoint(e));
      adjLastTap = 0;
    } else adjLastTap = now;
  }
  scheduleAdjust();
};
adjustWrap.addEventListener("pointerup", adjustPointerUp);
adjustWrap.addEventListener("pointercancel", adjustPointerUp);
adjustWrap.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomAdjust(e.deltaY < 0 ? 1.2 : 1 / 1.2, ...stagePoint(e));
    placeAdjustCanvases();
    clearTimeout(adjustWrap.wheelTimer);
    adjustWrap.wheelTimer = setTimeout(scheduleAdjust, 150);
  },
  { passive: false },
);
$("#adjust-fit").addEventListener("pointerdown", (e) => e.stopPropagation());
$("#adjust-fit").onclick = () => {
  adjView.zoom = 1;
  scheduleAdjust();
};

/** Auto enhance: stretch levels so 1% of pixels are black / white, slight contrast + saturation boost. */
$("#btn-auto-enhance").onclick = () => {
  snapshot();
  const img = boxScale(sourcePixels(), 160, 160);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < img.length; i += 4) histogram[Math.round(0.3 * img[i] + 0.59 * img[i + 1] + 0.11 * img[i + 2])]++;
  const cut = 160 * 160 * 0.01;
  let sum = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++)
    if ((sum += histogram[i]) > cut) {
      lo = i;
      break;
    }
  sum = 0;
  for (let i = 255; i >= 0; i--)
    if ((sum += histogram[i]) > cut) {
      hi = i;
      break;
    }
  Object.assign(wiz.adjust, {
    blk: Math.min(40, Math.round(lo / 2.55)),
    wht: Math.max(200, hi),
    con: 108,
    sat: 112,
    enh: 4,
  });
  ADJUSTMENTS.forEach(([key]) => setSlider("adj-" + key, wiz.adjust[key]));
  wiz.result = null;
  drawAdjustPreview();
};

/* ---------- step 3: pixelize ---------- */

function renderStyleList() {
  const list = $("#style-list");
  if (!list.firstChild)
    list.innerHTML = MODES.map(
      (id) =>
        `<button class="style-row" data-style="${id}"><b data-i="m_${id}">${t("m_" + id)}</b><span data-i="d_${id}">${t("d_" + id)}</span></button>`,
    ).join("");
  $$("#style-list .style-row").forEach((b) => b.classList.toggle("on", b.dataset.style === wiz.style));
}
$("#style-list").onclick = (e) => {
  const b = e.target.closest(".style-row");
  if (!b) return;
  wiz.style = b.dataset.style;
  renderStyleList();
  schedulePreview();
};

/** Settings for the engine, read from the panel. */
function pixelParams() {
  const exact = $("#colors-exact");
  if (document.activeElement !== exact) exact.value = $("#colors").value;
  const width = clampSize($("#px-width").value);
  const height = clampSize($("#px-height").value);
  return {
    width,
    height,
    colors: Math.max(2, Math.min(+$("#colors").value, width * height)),
    style: wiz.style,
    clean: +$("#clean").value,
  };
}

// Pixel-count slider is logarithmic: 0..1000 maps to 256 .. 16M cells.
const MIN_CELLS = 256;
const MAX_CELLS = 16e6;
const LOG_SPAN = Math.log(MAX_CELLS) - Math.log(MIN_CELLS);
const sliderToCells = (v) => Math.round(Math.exp(Math.log(MIN_CELLS) + (LOG_SPAN * v) / 1000));
const cellsToSlider = (n) => Math.round((1000 * (Math.log(Math.max(MIN_CELLS, n)) - Math.log(MIN_CELLS))) / LOG_SPAN);

function syncPixelCount() {
  const n = clampSize($("#px-width").value) * clampSize($("#px-height").value);
  $("#pixel-count").value = cellsToSlider(n);
  $("#pixel-count-value").textContent = formatCount(n) + " px";
}

function setPixelCount(v) {
  const n = sliderToCells(v);
  const ratio = $("#keep-ratio").checked
    ? cropRatio()
    : clampSize($("#px-width").value) / clampSize($("#px-height").value);
  const W = clampSize(Math.sqrt(n * ratio));
  const H = clampSize(n / W);
  $("#px-width").value = W;
  $("#px-height").value = H;
  $("#pixel-count-value").textContent = formatCount(W * H) + " px";
}

$("#panel-pixel").addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "pixel-count") {
    setPixelCount(+el.value);
    return schedulePreview();
  }
  if (el.id === "colors-exact") {
    const n = Math.round(+el.value);
    if (n >= 2) setSlider("colors", Math.min(1000, n));
    return schedulePreview();
  }
  if (el.type === "range") el.previousElementSibling.textContent = el.value;
  if (el.id === "px-width" && $("#keep-ratio").checked)
    $("#px-height").value = clampSize($("#px-width").value / cropRatio());
  if (el.id === "px-height" && $("#keep-ratio").checked)
    $("#px-width").value = clampSize($("#px-height").value * cropRatio());
  if (el.id === "px-width" || el.id === "px-height") syncPixelCount();
  schedulePreview();
});
$("#colors-exact").addEventListener("change", (e) => (e.target.value = $("#colors").value));

let previewTimer = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  const p = pixelParams();
  previewTimer = setTimeout(runPreview, p.width * p.height > 1e6 ? 900 : 450);
}

/* ---------- worker client ---------- */

const worker = new Worker(new URL("./engine.worker.js", import.meta.url), { type: "module" });
const jobs = new Map(); // id -> { resolve, reject, onProgress }
let lastJob = 0;
let sentSourceKey = null;

worker.onmessage = (e) => {
  const msg = e.data;
  const job = jobs.get(msg.id);
  if (!job) return;
  if (msg.type === "progress") return job.onProgress && job.onProgress(msg.value);
  jobs.delete(msg.id);
  if (msg.type === "done") job.resolve(msg.result);
  else if (msg.type === "cancelled") job.resolve(null);
  else job.reject(new Error(msg.message));
};
worker.onerror = (e) => toast(t("err") + ": " + e.message);

/** Sends a job to the worker. A newer job makes older ones resolve to null. */
function runJob(type, params, onProgress) {
  const source = sourcePixels();
  if (source.key !== sentSourceKey) {
    worker.postMessage({
      type: "source",
      key: source.key,
      data: source.data,
      width: source.width,
      height: source.height,
    });
    sentSourceKey = source.key;
  }
  const id = ++lastJob;
  for (const [oldId, job] of jobs) {
    job.resolve(null);
    jobs.delete(oldId);
  }
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress });
    worker.postMessage({ type, id, params, adjust: { ...wiz.adjust } });
  });
}

const resultKey = (p) => JSON.stringify([p, wiz.rect, wiz.editVersion, wiz.adjust]);

async function runPreview() {
  if (wiz.step !== 3 || wiz.creating) return;
  const p = pixelParams();
  const big = p.width * p.height > 1e6;
  if (big) setBusy(true);
  else $("#preview-info").textContent = "…";
  let result;
  try {
    result = await runJob("generate", p, (v) => big && setBusyText(t("busy") + " " + Math.round(v * 100) + "%"));
  } catch (e) {
    setBusy(false);
    return toast(String(e));
  }
  if (big) setBusy(false);
  if (!result) return; // replaced by a newer preview
  wiz.result = { key: resultKey(p), result };
  showPreview();
}

function showPreview() {
  const { width: W, height: H, idx, pal } = wiz.result.result;
  const ctx = previewCanvas.getContext("2d");
  const K = pal.length / 3;
  const colors = [];
  const counts = new Uint32Array(K);
  for (let i = 0; i < idx.length; i++) counts[idx[i]]++;
  let strip = "";
  for (let k = 0; k < K; k++) {
    let r = pal[k * 3];
    let g = pal[k * 3 + 1];
    let b = pal[k * 3 + 2];
    if (wiz.gray) r = g = b = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
    colors.push(0xff000000 | (b << 16) | (g << 8) | r);
    strip += `<span style="background:rgb(${r},${g},${b});color:${0.3 * r + 0.59 * g + 0.11 * b > 140 ? "#000" : "#fff"}">${k + 1}<i>${counts[k]}</i></span>`;
  }
  previewCanvas.width = W;
  previewCanvas.height = H;
  const img = ctx.createImageData(W, H);
  const px = new Uint32Array(img.data.buffer);
  for (let i = 0; i < W * H; i++) px[i] = colors[idx[i]];
  ctx.putImageData(img, 0, 0);
  $("#palette-strip").innerHTML = strip;
  $("#preview-info").textContent = `${K} ${t("ncol")} · ${W}×${H}`;
  $("#preview-gray").textContent = t(wiz.gray ? "gray" : "color");
  drawOriginal(W, H);
  applyPreviewZoom();
}

/* ---------- step 3: before/after divider ----------
   The original photo (cropped + adjusted) is drawn into #original-canvas with the same aspect ratio as the
   pixel preview, positioned exactly like it, and clipped to the part left of the divider. */

const originalCanvas = $("#original-canvas");
let originalKey = "";

function drawOriginal(W, H) {
  originalCanvas.style.filter = wiz.gray ? "grayscale(1)" : "";
  const key = JSON.stringify([wiz.rect, wiz.editVersion, wiz.adjust, W, H]);
  if (key === originalKey) return;
  originalKey = key;
  const L = 1024;
  const w = W >= H ? L : Math.max(1, Math.round((L * W) / H));
  const h = W >= H ? Math.max(1, Math.round((L * H) / W)) : L;
  const rgba = boxScale(sourcePixels(), w, h);
  applyAdjustments(rgba, w, h, wiz.adjust);
  originalCanvas.width = w;
  originalCanvas.height = h;
  originalCanvas.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
}

function placeDivider() {
  const x = Math.round((wiz.compare ?? 0.5) * previewWrap.clientWidth);
  $("#compare-clip").style.width = x + "px";
  $("#compare-line").style.left = x + "px";
  const hide = !wiz.result;
  $("#compare-clip").hidden = hide;
  $("#compare-line").hidden = hide;
}

const knob = $("#compare-knob");
knob.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  knob.setPointerCapture(e.pointerId);
  knob.dragging = true;
});
knob.addEventListener("pointermove", (e) => {
  if (!knob.dragging) return;
  const r = previewWrap.getBoundingClientRect();
  wiz.compare = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  placeDivider();
});
const knobUp = () => (knob.dragging = false);
knob.addEventListener("pointerup", knobUp);
knob.addEventListener("pointercancel", knobUp);

$("#preview-gray").onclick = () => {
  wiz.gray = !wiz.gray;
  if (wiz.result) showPreview();
  else $("#preview-gray").textContent = t(wiz.gray ? "gray" : "color");
};

$("#btn-auto-colors").onclick = async () => {
  setBusy(true, t("autoc"));
  try {
    const best = await runJob("suggest", pixelParams(), (mid) => setBusyText(t("autoc") + " · " + mid));
    setBusy(false);
    if (best == null) return;
    setSlider("colors", best);
    toast(t("autoc") + ": " + best);
    runPreview();
  } catch (e) {
    setBusy(false);
    toast(String(e));
  }
};

/** Builds the final canvas (reusing the preview if nothing changed) and opens it for coloring. */
async function createCanvasFromResult() {
  // a preview scheduled by the last edit must not start (it would cancel this job)
  clearTimeout(previewTimer);
  wiz.creating = true;
  setBusy(true);
  await yieldToBrowser();
  try {
    const p = pixelParams();
    const r = wiz.result && wiz.result.key === resultKey(p) ? wiz.result.result : await runJob("generate", p);
    if (!r) {
      wiz.creating = false;
      return setBusy(false);
    }
    const id = String(Date.now());
    settings.pm = p.style;
    settings.pcl = p.clean;
    saveSettings();
    const { blob, scale } = await encodeSourcePhoto();
    const state = sourceState(p, scale);
    const replaceId = wiz.replaceId;
    const folderId = wiz.folderId ?? library.folderId;
    wiz = {};
    history = [];
    photo = null;
    if (replaceId) await deleteCanvas(replaceId);
    await putSource(id, blob, state);
    const canvas = {
      id,
      folderId,
      name: `${r.width}×${r.height}`,
      width: r.width,
      height: r.height,
      mode: "n",
      palette: r.pal,
      target: r.idx,
      done: false,
      parts: [],
      partOf: null,
    };
    await openGame(canvas, [], true);
    await saveGame(true);
  } catch (e) {
    wiz.creating = false;
    setBusy(false);
    toast(String(e));
  }
}

/* ---------- step 3: zoom / pan of the preview ----------
   The preview canvas is resized in layout (not CSS-transformed) so image-rendering:pixelated stays crisp. */

const zoomPointers = new Map();
let zoomPinch = 0;
let zoomMoved = 0;
let zoomLastTap = 0;
let zoomCenter = null;

function applyPreviewZoom() {
  const w = previewWrap.clientWidth;
  const h = previewWrap.clientHeight;
  if (!w) return;
  const z = wiz.previewZoom || 1;
  wiz.previewX = Math.min(0, Math.max(w - w * z, wiz.previewX || 0));
  wiz.previewY = Math.min(0, Math.max(h - h * z, wiz.previewY || 0));
  const s = previewCanvas.style;
  s.left = wiz.previewX + "px";
  s.top = wiz.previewY + "px";
  s.width = w * z + "px";
  s.height = h * z + "px";
  originalCanvas.style.cssText = s.cssText + (wiz.gray ? ";filter:grayscale(1)" : "");
  placeDivider();
  $("#preview-fit").hidden = z < 1.01;
}

function zoomPreview(factor, mx, my) {
  const w = previewWrap.clientWidth;
  const h = previewWrap.clientHeight;
  const cellOnScreen = Math.min(w / (previewCanvas.width || 1), h / (previewCanvas.height || 1));
  const maxZoom = Math.min(64, Math.max(4, 48 / cellOnScreen)); // up to ~48 px per cell
  const z0 = wiz.previewZoom || 1;
  const z = Math.max(1, Math.min(maxZoom, z0 * factor));
  const k = z / z0;
  wiz.previewX = mx - (mx - (wiz.previewX || 0)) * k;
  wiz.previewY = my - (my - (wiz.previewY || 0)) * k;
  wiz.previewZoom = z;
  applyPreviewZoom();
}

const fitPreview = () => {
  wiz.previewZoom = 1;
  wiz.previewX = wiz.previewY = 0;
  applyPreviewZoom();
};
const localPoint = (e) => {
  const r = previewWrap.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};

previewWrap.addEventListener("pointerdown", (e) => {
  if (e.target.closest("button")) return;
  previewWrap.setPointerCapture(e.pointerId);
  zoomPointers.set(e.pointerId, localPoint(e));
  zoomMoved = zoomPointers.size > 1 ? 99 : 0; // two fingers never count as a tap
  zoomPinch = 0;
  zoomCenter = null;
});
previewWrap.addEventListener("pointermove", (e) => {
  const old = zoomPointers.get(e.pointerId);
  if (!old) return;
  const now = localPoint(e);
  zoomPointers.set(e.pointerId, now);
  if (zoomPointers.size > 1) {
    const [a, b] = [...zoomPointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (zoomPinch && zoomCenter) {
      wiz.previewX += m[0] - zoomCenter[0];
      wiz.previewY += m[1] - zoomCenter[1];
      zoomPreview(d / zoomPinch, m[0], m[1]);
    }
    zoomPinch = d;
    zoomCenter = m;
    return;
  }
  zoomMoved += Math.abs(now[0] - old[0]) + Math.abs(now[1] - old[1]);
  if (wiz.previewZoom > 1) {
    wiz.previewX += now[0] - old[0];
    wiz.previewY += now[1] - old[1];
    applyPreviewZoom();
  }
});
const zoomPointerUp = (e) => {
  const p = zoomPointers.get(e.pointerId);
  if (!p) return;
  zoomPointers.delete(e.pointerId);
  if (zoomPointers.size) {
    zoomPinch = 0;
    zoomCenter = null;
    return;
  }
  if (zoomMoved >= 10) return;
  const now = Date.now();
  if (now - zoomLastTap < 320) {
    zoomLastTap = 0;
    if (wiz.previewZoom > 1.01) fitPreview();
    else zoomPreview(4, p[0], p[1]);
  } else zoomLastTap = now;
};
previewWrap.addEventListener("pointerup", zoomPointerUp);
previewWrap.addEventListener("pointercancel", zoomPointerUp);
previewWrap.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const p = localPoint(e);
    zoomPreview(e.deltaY < 0 ? 1.2 : 1 / 1.2, p[0], p[1]);
  },
  { passive: false },
);
$("#preview-fit").onclick = fitPreview;

/** Re-draws whatever step is visible (after the phone wakes up, etc.). */
export function redrawWizard() {
  if (!photo) return;
  if (wiz.step === 1) drawCrop();
  else if (wiz.step === 2) drawAdjustPreview();
  else if (wiz.step === 3 && wiz.result) showPreview();
}
