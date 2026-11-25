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
import { t, plural } from "./i18n.js";
import {
  boxScale,
  applyAdjustments,
  MODES,
  DEFAULT_CLEAN,
  DEFAULT_BLEND,
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
/**
 * Bigger photos are worked on at this size. A canvas uses up to 4 x 4 photo pixels a cell (3.2 MP for the
 * default 200 000 cells, 5.8 MP for 800 x 800 at 3 x 3); beyond that the photo only cost memory: every
 * full-size copy of a 48 MP photo took about 190 MB, and the editor keeps several.
 */
const WORK_PIXELS = 6e6;
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

const SHAPES = ["rect", "oval", "line", "tri", "diamond", "hex", "star", "heart", "arrow"];
const BLUR_STYLES = ["soft", "smart", "motion", "mosaic", "smudge"];
const DEFAULT_PIXELS = 200000; // a new canvas: about 450 x 450 cells
const DEFAULT_COLORS = 128;

// [tool, icon]; under the grid only the active tool's options are shown
const EDIT_TOOLS = [
  ["crop", "crop"],
  ["pan", "move"],
  ["brush", "pen"],
  ["shape", "shapes"],
  ["fill", "bucket"],
  ["recolor", "swap"],
  ["blur", "drop"],
  ["flat", "flat"],
  ["clone", "stamp"],
  ["mark", "focus"],
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
  `<div id="shape-options"><div class="shape-grid" id="shape-kinds">${SHAPES.map((k) => `<button class="tool-tile" data-shape="${k}" aria-label="${k}">${icon("sh_" + k)}</button>`).join("")}</div>` +
  `<div class="chips segmented" id="shape-mode"><button class="chip" data-outline="0" data-i="sh_fill"></button><button class="chip" data-outline="1" data-i="sh_outline"></button></div></div>` +
  `<div class="chips" id="blur-styles">${BLUR_STYLES.map((k) => `<button class="chip" data-blur="${k}" data-i="bl_${k}"></button>`).join("")}</div>` +
  `<div class="chips segmented" id="mark-mode"><button class="chip" data-erase="0" data-i="mk_on"></button><button class="chip" data-erase="1" data-i="mk_off"></button></div>` +
  `<div class="option-row" id="paint-options">${colorButtonHtml("brush-color", "#ffffff")}<button class="chip" id="btn-clone-source" data-i="cl_src"></button>` +
  `<div class="option-sliders">${sliderHtml("brush-size", "e_size", 2, 160, 28)}${sliderHtml("strength", "e_str", 1, 100, 50)}${sliderHtml("feather", "e_feather", 0, 100, 35)}${sliderHtml("tol", "tol", 2, 120, 24)}</div></div>` +
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
  sliderHtml("clean", "clean", 0, 10, DEFAULT_CLEAN) +
  `<div id="blend-field">${sliderHtml("blend", "blend", 0, 3, DEFAULT_BLEND)}</div>`;

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
  let loadScale = 1; // the photo as worked on / as stored in the file
  if (image.width * image.height > WORK_PIXELS) {
    const f = Math.sqrt(WORK_PIXELS / (image.width * image.height));
    const w = Math.max(1, Math.round(image.width * f));
    const h = Math.max(1, Math.round(image.height * f));
    let small;
    try {
      small = await createImageBitmap(image, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
    } catch {
      small = createCanvas(w, h);
      const x = small.getContext("2d");
      x.imageSmoothingQuality = "high";
      x.drawImage(image, 0, 0, w, h);
    }
    loadScale = w / image.width;
    if (image.close) image.close();
    image = small;
  }
  wiz = {
    image,
    loadScale,
    rotation: 0, // quarter turns
    mirrored: false,
    angle: 0, // fine tilt in degrees (-45..45), after the quarter turns
    pad: { on: false, color: null }, // margins: the crop frame may reach beyond the photo, filled with color
    strokes: [], // edits (brush, shapes, fill, ...), in original photo coordinates
    color: "#ffffff", // color of the brush, shapes, fill and color replace
    shape: "rect", // one of SHAPES
    tol: 24, // tolerance of fill and color replace, in gray levels
    stamp: null, // stamp tool: { points } the lasso around what it copies (original photo coordinates)
    shapeOutline: false, // shapes: outline only (as thick as the brush) instead of filled
    blur: "soft", // blur brush style: soft | smart | motion | mosaic | smudge
    strength: 50, // blur brush strength, 1..100
    feather: 35, // stamp and blur brush: soft edge, 0..100
    markErase: false, // "important" tool: removes marks instead of adding them
    prevTool: null, // tool to return to after the eyedropper
    editVersion: 0, // bumps on every change to the photo pixels
    step: 1,
    gray: settings.pgr !== 0, // preview in gray (judge shapes, not colors); as last time
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
    compare: settings.pcmp ?? 0.5, // before/after divider position (0..1 of the preview width); as last time
    drawn: false, // a preview of this picture is on screen (until then its original is shown)
    replaceId: restore?.replaceId || null,
    folderId: restore ? restore.folderId : null,
  };
  history = [];
  originalKey = "";
  $("#wiz-undo").disabled = true;
  ADJUSTMENTS.forEach(([key, , , v]) => setSlider("adj-" + key, v));
  setSlider("clean", settings.pcl);
  setBlend(settings.pbl ?? DEFAULT_BLEND);
  // the number of colors: the user's own from last time, or "Auto colors" (see goToStep)
  const colors = settings.pcol > 1 ? settings.pcol : DEFAULT_COLORS;
  setSlider("colors", colors);
  $("#colors-exact").value = colors;
  if (settings.pcol > 1) wiz.colorsSet = true;
  $("#keep-ratio").checked = true; // (a canvas made again sets its own, see applyState)
  setSlider("tol", wiz.tol);
  setSlider("strength", wiz.strength);
  setSlider("feather", wiz.feather);
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
    keepRatio: $("#keep-ratio").checked,
  };
}

/** An edit with its coordinates and sizes multiplied by k (the stored photo may be smaller than the original). */
const scaleEdit = (s, k) => ({
  ...s,
  ...(s.radius != null && { radius: s.radius * k }),
  ...(s.feather != null && { feather: s.feather * k }),
  points: s.points.map((v) => v * k),
  ...(s.off && { off: s.off.map((v) => v * k) }),
});

function applyState(st) {
  // the stored photo may have been bigger than the size it is worked on now (see WORK_PIXELS)
  const k = wiz.loadScale;
  wiz.rotation = st.rotation;
  wiz.mirrored = st.mirrored;
  wiz.angle = st.angle || 0;
  wiz.pad = st.pad ? { ...st.pad } : { on: false, color: null };
  wiz.strokes = st.strokes.map((s) => scaleEdit(s, k));
  syncTiltSlider();
  buildPhoto();
  wiz.rect = { x: st.rect.x * k, y: st.rect.y * k, w: st.rect.w * k, h: st.rect.h * k };
  wiz.ratio = st.ratio;
  highlightRatio();
  wiz.adjust = { ...NO_ADJUST, ...st.adjust };
  ADJUSTMENTS.forEach(([key]) => setSlider("adj-" + key, wiz.adjust[key]));
  const p = normalizeParams(st.params); // canvases made by older versions stored other style ids and sliders
  $("#px-width").value = p.width;
  $("#px-height").value = p.height;
  setSlider("colors", p.colors);
  $("#colors-exact").value = p.colors;
  wiz.colorsSet = true; // a canvas made again keeps its number of colors
  wiz.autoColors = false;
  setSlider("clean", p.clean);
  setBlend(p.blend);
  wiz.style = p.style;
  wiz.sized = true;
  wiz.sizedRatio = cropRatio();
  // "keep proportions" as it was; canvases from before it was stored: on if the size has the frame's proportions
  const r = cropRatio();
  $("#keep-ratio").checked =
    st.keepRatio ?? (Math.abs(p.width - p.height * r) <= 1 || Math.abs(p.height - p.width / r) <= 1);
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
  showBlendValue();
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
  if (n !== 1) freeEditorCanvases(); // the next steps (and the worker) want the memory
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
      // a new canvas starts with as many cells as the last one (the first: DEFAULT_PIXELS), in the frame's
      // proportions
      const r = cropRatio();
      const n = settings.pcells || DEFAULT_PIXELS;
      $("#px-width").value = clampSize(Math.sqrt(n * r));
      $("#px-height").value = clampSize(Math.sqrt(n / r));
      wiz.sized = true;
      wiz.sizedRatio = r;
    } else if (Math.abs(cropRatio() / wiz.sizedRatio - 1) > 1e-3) {
      // the frame's proportions changed since (a square instead of the photo's own ones): with "keep
      // proportions" on, the same number of cells in the new ones, not the picture squeezed into the old ones
      const r = cropRatio();
      wiz.sizedRatio = r;
      const n = clampSize($("#px-width").value) * clampSize($("#px-height").value);
      const W = clampSize(Math.sqrt(n * r));
      const H = clampSize(n / W);
      if (
        $("#keep-ratio").checked &&
        (Math.abs(W - $("#px-width").value) > 1 || Math.abs(H - $("#px-height").value) > 1)
      ) {
        $("#px-width").value = W;
        $("#px-height").value = H;
      }
    }
    syncPixelCount();
    applyPreviewZoom();
    renderStyleList();
    if (!wiz.colorsSet) {
      // a new picture: the number of colors is "Auto colors" (see autoKey) until the user sets one
      wiz.colorsSet = true;
      wiz.autoColors = true;
    }
    // until its first preview is ready, a picture shows its original (later, the last preview stays up while
    // the next one is made: what changed shows the moment it comes)
    if (!wiz.drawn) {
      const p = pixelParams();
      drawOriginal(p.width, p.height);
      placeDivider();
    }
    if (wiz.autoColors && autoKey(pixelParams()) !== wiz.autoKey) {
      // first time here, or the picture changed since the count (the crop, an edit, an adjustment): count again
      autoColors(true);
    } else runPreview();
  }
}

/*
 * "Auto colors" follows the picture: while the number of colors is its count (wiz.autoColors: from a new
 * picture's first visit to this step, or the button, until the user moves the colors slider or types a
 * number), a change of size, style or cleanliness, or of the picture itself, counts it again. autoKey: what
 * the count depends on (in art mode not the cleanliness: it only cleans the finished cells); wiz.autoKey: what
 * it was counted for.
 */
const autoKey = (p) =>
  JSON.stringify([
    exceptColors({ ...p, clean: p.style === "art" ? 0 : p.clean }),
    wiz.rect,
    wiz.editVersion,
    wiz.adjust,
  ]);

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
  if (activeStroke || pendingStroke) return; // (another finger on the button while drawing)
  const e = history.pop();
  if (!e) return;
  if (e.stroke) {
    if (wiz.strokes.pop().kind === "mark") rebuildMarks();
    else replayEdits();
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
  else rebuildMarks();
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
  if (wiz.step !== 1 || !photo) {
    loupe.hidden = true;
    return;
  }
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
  if (wiz.tool === "mark" && marksOn) {
    x.globalAlpha = 0.45;
    x.drawImage(markMask, g.ox, g.oy, PW, PH);
    x.globalAlpha = 1;
  }
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
    drawBrushRing(x);
    drawLoupe();
    return;
  }
  loupe.hidden = true;
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
     shape    { kind: "shape", shape (one of SHAPES), outline, color, radius, points }
              line: its two ends; the others: the four corners of their box (top-left, top-right, bottom-right,
              bottom-left; an arrow lists them turned so the first side runs the way it points)
     fill     { kind: "fill", color, tol, seed: [r, g, b], points: [x, y] }
     recolor  { kind: "recolor", color, tol, from: [r, g, b], points: [x, y] }
     blur     { kind: "blur", style, strength, soft, radius, points }  (no style: older soft blur)
              soft: 0..100, the outer share of the radius over which the stroke fades out
     stamp    { kind: "stamp", points (the lasso), off: [dx, dy], feather }  copies what the lasso holds,
              shifted by off, with edges fading out over `feather`
     clone    { kind: "clone", radius, points, off: [dx, dy] }  (older canvases) copies from (point + off)
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
/** Blur radius of the older blur brush (edits without a style), in photo pixels, for a brush of radius r. */
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

/* ---------- "Important" marks ----------
   Marked parts of the picture get more palette colors and are left alone by the clean-up (small eyes,
   fingers, a highlight). The marks are strokes like the others (saved with the canvas, undone, turned with
   the photo), but they are drawn into markMask, a reduced copy of the photo's shape, never into the photo. */
const MARK_SIDE = 1024;
const MARK_COLOR = "#ff2e88";
const markMask = createCanvas(1, 1);
let marksOn = false; // something is marked: the marks go to the engine with the picture

function markMaskSize() {
  const s = Math.min(1, MARK_SIDE / Math.max(photo.width, photo.height));
  return [Math.max(1, Math.round(photo.width * s)), Math.max(1, Math.round(photo.height * s))];
}

/** Draws all mark strokes afresh (after undo, a turn of the photo, a restored canvas). */
function rebuildMarks() {
  marksOn = false;
  markMask.width = markMask.height = 1;
  for (const op of wiz.strokes) if (op.kind === "mark") drawMark(op, opPoints(op), op.radius * tiltMatrix()[2]);
}

/** One mark stroke (or a piece of it) in photo coordinates. */
function drawMark(op, p, r) {
  const [w, h] = markMaskSize();
  if (markMask.width !== w || markMask.height !== h) {
    markMask.width = w;
    markMask.height = h;
  }
  const ctx = markMask.getContext("2d");
  ctx.save();
  ctx.scale(w / photo.width, h / photo.height);
  ctx.globalCompositeOperation = op.erase ? "destination-out" : "source-over";
  ctx.fillStyle = ctx.strokeStyle = MARK_COLOR;
  tracePath(ctx, p, r);
  ctx.restore();
  if (!op.erase) marksOn = true;
}

/** The marks under the crop frame R (photo coordinates) as w x h strengths 0..255, or null without marks. */
function sourceMask(R, w, h) {
  if (!marksOn) return null;
  const s = Math.min(1, MARK_SIDE / Math.max(w, h)); // the engine needs about one value per cell
  const mw = Math.max(1, Math.round(w * s));
  const mh = Math.max(1, Math.round(h * s));
  const c = createCanvas(mw, mh).getContext("2d");
  c.drawImage(markMask, (-R.x * mw) / R.w, (-R.y * mh) / R.h, (photo.width * mw) / R.w, (photo.height * mh) / R.h);
  const d = c.getImageData(0, 0, mw, mh).data;
  const data = new Uint8Array(mw * mh);
  let any = false;
  for (let i = 0; i < data.length; i++) if ((data[i] = d[i * 4 + 3])) any = true;
  return any ? { data, width: mw, height: mh } : null;
}

const scratch = createCanvas(1, 1);
// The smoothing style reads it back every time: kept in memory from the start. (Chrome would otherwise move it
// there by itself after some reads, and the same stroke could come out a little different on undo / redo.)
scratch.getContext("2d", { willReadFrequently: true });

/*
 * Big brushes on big photos would make each finger move redraw millions of pixels (and the smoothing style
 * read them all into JavaScript): the phone froze. The blur styles therefore work on a copy at most about
 * WORK_SIDE pixels across, 1/d of the photo's size, and draw the result back enlarged. d is a whole number that
 * depends on the brush only, and the copy starts on a multiple of d, so all segments of a stroke (and its replay)
 * see the same grid. A blurred result loses nothing by this; at d > 1 a pixel of the copy is still far smaller
 * than a cell of the coloring.
 */
const WORK_SIDE = 360;
const workScale = (r, extra) => Math.max(1, Math.ceil((2 * (r + extra) + 4) / WORK_SIDE));

/** Bounding box of a path's points: [minX, minY, maxX, maxY]. */
function pathBox(p) {
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
  return [minX, minY, maxX, maxY];
}

/**
 * The pieces of a brush operation around path p (radius r): `inner`, the photo pixels it may change, and
 * `outer`, that plus `m` pixels of surroundings, on a grid of d: { X0, Y0, w, h, OX, OY, W, H } where (OX, OY)
 * is the photo position of the work copy and W x H its size in work pixels. null: nothing on the photo.
 */
function brushArea(p, r, m, d) {
  const [minX, minY, maxX, maxY] = pathBox(p);
  const X0 = Math.max(0, Math.floor(minX - r - 2));
  const Y0 = Math.max(0, Math.floor(minY - r - 2));
  const X1 = Math.min(photo.width, Math.ceil(maxX + r + 2));
  const Y1 = Math.min(photo.height, Math.ceil(maxY + r + 2));
  if (X1 - X0 < 1 || Y1 - Y0 < 1) return null;
  const OX = Math.floor((X0 - m) / d) * d;
  const OY = Math.floor((Y0 - m) / d) * d;
  const W = Math.ceil((X1 + m - OX) / d);
  const H = Math.ceil((Y1 + m - OY) / d);
  return { X0, Y0, w: X1 - X0, h: Y1 - Y0, OX, OY, W, H };
}

/** Draws the work copy c (of area a, scale d) back onto the photo over the area's inner part. */
function drawBack(c, a, d, alpha = 1, crisp = false) {
  const ctx = photo.getContext("2d");
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = !crisp;
  ctx.drawImage(c.canvas, (a.X0 - a.OX) / d, (a.Y0 - a.OY) / d, a.w / d, a.h / d, a.X0, a.Y0, a.w, a.h);
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = 1;
}

/**
 * Copies picture `src` onto the photo, but only under the brush path p (radius r): restore copies the
 * untouched photo, clone copies the photo shifted by (dx, dy), blur copies a blurred photo.
 * process(ctx, w, h, x, y, d), if given, changes the copied piece (with `margin` pixels of surroundings around
 * it; at photo position x, y; d photo pixels to one of its pixels) before it is cut to the brush: the blur
 * styles (src null: process draws the piece itself). fast: work at a reduced scale for big brushes (blur
 * styles only; restore and clone stay exact).
 */
function drawFrom(src, dx, dy, p, r, blur = 0, alpha = 1, process = null, margin = 0, soft = 0, fast = false) {
  // the surroundings come along, so pixels near the edge of the brush blur with real neighbours
  const m = Math.ceil(Math.max(blur * 3, margin));
  const d = fast ? workScale(r, m) : 1;
  const a = brushArea(p, r, m, d);
  if (!a) return;
  scratch.width = a.W;
  scratch.height = a.H;
  const c = scratch.getContext("2d");
  c.imageSmoothingQuality = "high";
  if (blur) c.filter = `blur(${blur / d}px)`;
  if (src) c.drawImage(src, a.OX + dx, a.OY + dy, a.W * d, a.H * d, 0, 0, a.W, a.H);
  c.filter = "none";
  if (process) process(c, a.W, a.H, a.OX, a.OY, d);
  c.globalCompositeOperation = "destination-in";
  c.fillStyle = c.strokeStyle = "#000";
  // soft: the brush fades out over its outer `soft` pixels (a smaller brush, blurred, still ends at r)
  if (soft > 0.5) c.filter = `blur(${soft / 2.5 / d}px)`;
  c.setTransform(1 / d, 0, 0, 1 / d, 0, 0);
  tracePath(c, p, Math.max(0.5, r - soft), a.OX, a.OY);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.filter = "none";
  c.globalCompositeOperation = "source-over";
  drawBack(c, a, d, alpha);
}

/* Blur brush styles. strength 1..100; r = brush radius, in photo pixels.
     soft    plain blur
     smart   smooths noise, grain and fine texture, keeps edges and lines (a guided filter)
     motion  smears along the direction of the stroke
     mosaic  squares of one color (aligned to the photo, so overlapping strokes match)
     smudge  drags the colors under the finger along with it */
const blurRadius = (strength, r) => Math.max(0.5, (strength / 100) * r * 0.6);

/** Applies a blur-brush segment from photo point a to b (a === b: a dot). src: the photo before the stroke. */
function blurSegment(op, src, a, b, r) {
  const style = op.style || "soft";
  const strength = op.strength ?? 50;
  const soft = ((op.soft || 0) / 100) * r; // width of the fading edge, photo pixels
  const p = a === b ? [a[0], a[1]] : [a[0], a[1], b[0], b[1]];
  if (style === "soft") areaSegment(src, p, r, soft, blurRadius(strength, r));
  else if (style === "smart") {
    const { radius, eps } = surfaceParams(strength);
    areaSegment(src, p, r, soft, 0, (c, w, h, x, y, d) => smoothSurface(c, w, h, radius / d, eps), radius * 2);
  } else if (style === "flat") {
    const { radius, eps, step } = flatParams(strength);
    areaSegment(src, p, r, soft, 0, (c, w, h, x, y, d) => flatten(c, w, h, radius / d, eps, step), radius * 2 + 2);
  } else if (style === "mosaic") {
    // squares of whole work pixels: the size is a multiple of the work scale the brush uses
    const raw = Math.max(2, Math.round(2 + (strength / 100) * r * 0.8));
    const d = workScale(r, Math.ceil(Math.max(raw, soft > 0.5 ? (soft / 2.5) * 3 : 0)));
    const size = Math.max(d, Math.round(raw / d) * d);
    areaSegment(src, p, r, soft, 0, (c, w, h, x, y) => mosaic(c, w, h, x, y, size, d), size, true, d);
  } else if (style === "motion") {
    if (a === b) return; // no direction yet
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const reach = Math.max(1, (strength / 100) * r * 1.5);
    drawFrom(
      null,
      0,
      0,
      p,
      r,
      0,
      1,
      (c, w, h, x, y, d) => {
        // average of the piece shifted back and forth along the stroke (each draw weighs 1/(n+1): a running mean)
        // enough copies that they merge into a smear, not a row of ghosts (what gap is left between them is
        // closed by one slight blur at the end)
        const small = workCopyFor(src, d).small;
        const spread = (2 * reach) / d;
        const steps = Math.min(32, Math.max(12, Math.ceil(spread / 2)));
        for (let i = 0; i <= steps; i++) {
          const t = (i / steps - 0.5) * 2 * reach;
          c.globalAlpha = 1 / (i + 1);
          c.drawImage(small, (x + ux * t) / d, (y + uy * t) / d, w, h, 0, 0, w, h);
        }
        c.globalAlpha = 1;
        const gap = spread / steps;
        if (gap > 1.5) {
          maskScratch.width = w;
          maskScratch.height = h;
          const k = maskScratch.getContext("2d");
          k.filter = `blur(${gap / 2.5}px)`;
          k.drawImage(c.canvas, 0, 0);
          k.filter = "none";
          c.clearRect(0, 0, w, h);
          c.drawImage(maskScratch, 0, 0);
        }
      },
      reach + 1,
      soft,
      true,
    );
  } else if (style === "smudge") {
    // in short steps (a few pixels, so the dabs merge into a smear), each carries a bit of the color it
    // starts from to where it ends
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) return;
    const d = workScale(r, 0);
    const steps = Math.min(32, Math.max(1, Math.ceil(len / Math.max(1, Math.min(r / 4, 4 * d)))));
    const alpha = 0.25 + (strength / 100) * 0.7;
    for (let i = 0; i < steps; i++) {
      const q0 = [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps];
      const q1 = [a[0] + ((b[0] - a[0]) * (i + 1)) / steps, a[1] + ((b[1] - a[1]) * (i + 1)) / steps];
      if (d === 1) drawFrom(photo, q0[0] - q1[0], q0[1] - q1[1], [q1[0], q1[1]], r, 0, alpha, null, 0, soft);
      else smudgeDab(workCopyFor(src, d), q0, q1, r, soft, alpha);
    }
  }
}

/**
 * One smudge dab of a big brush: the stroke's reduced copy is smudged (the brush picks its colors there, so
 * nothing big is read back from the photo), and the dab goes onto the photo enlarged.
 */
function smudgeDab(wc, q0, q1, r, soft, alpha) {
  const d = wc.d;
  const a = brushArea([q1[0], q1[1]], r, 0, d);
  if (!a) return;
  scratch.width = a.W;
  scratch.height = a.H;
  const c = scratch.getContext("2d");
  c.drawImage(wc.small, (a.OX + q0[0] - q1[0]) / d, (a.OY + q0[1] - q1[1]) / d, a.W, a.H, 0, 0, a.W, a.H);
  c.globalCompositeOperation = "destination-in";
  c.fillStyle = c.strokeStyle = "#000";
  if (soft > 0.5) c.filter = `blur(${soft / 2.5 / d}px)`;
  c.setTransform(1 / d, 0, 0, 1 / d, 0, 0);
  tracePath(c, [q1[0], q1[1]], Math.max(0.5, r - soft), a.OX, a.OY);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.filter = "none";
  c.globalCompositeOperation = "source-over";
  const g = wc.small.getContext("2d");
  g.globalAlpha = alpha;
  g.drawImage(scratch, a.OX / d, a.OY / d);
  g.globalAlpha = 1;
  drawBack(c, a, d, alpha);
}

/*
 * Blur styles that change an area (soft, smart, mosaic) keep the stroke's path so far in blurMask (its core,
 * without the fading edge). Each segment rebuilds the photo around it from the stroke's starting picture:
 * the changed picture where the blurred mask says so, the starting one elsewhere. The edge then fades evenly
 * however often the finger went over a spot (drawing soft dabs on top of each other would harden it).
 */
const blurMask = createCanvas(1, 1);
const maskScratch = createCanvas(1, 1);
/** The stroke's reduced copies: { src, d, small (src at 1/d), mask (the stroke's core so far, at 1/d) }. */
let workCopy = null;

/** A new blur stroke begins. */
function beginBlurMask() {
  workCopy = null;
}

/** The editor's full-size helper canvases are made again when needed. */
function freeEditorCanvases() {
  workCopy = null;
  for (const c of [blurMask, photoCopyCanvas, scratch, maskScratch, edgeScratch]) c.width = c.height = 1;
}

/** The reduced copies for picture src at scale d, made once per stroke. */
function workCopyFor(src, d) {
  if (workCopy && workCopy.src === src && workCopy.d === d) return workCopy;
  let small = src;
  let mask = blurMask;
  if (d > 1) {
    const W = Math.ceil(photo.width / d);
    const H = Math.ceil(photo.height / d);
    small = createCanvas(W, H);
    const g = small.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, W * d, H * d, 0, 0, W, H);
    mask = createCanvas(W, H);
  } else if (blurMask.width !== photo.width || blurMask.height !== photo.height) {
    blurMask.width = photo.width;
    blurMask.height = photo.height;
  } else blurMask.getContext("2d").clearRect(0, 0, blurMask.width, blurMask.height);
  workCopy = { src, d, small, mask };
  return workCopy;
}

/**
 * One segment (path p, flat photo points) of an area blur style, fading out over the outer `soft` pixels.
 * crisp: draw the result back without smoothing (mosaic squares keep sharp sides).
 */
function areaSegment(src, p, r, soft, blur = 0, process = null, margin = 0, crisp = false, scale = 0) {
  const core = Math.max(0.5, r - soft);
  const sigma = soft > 0.5 ? soft / 2.5 : 0;
  const m = Math.ceil(Math.max(blur * 3, margin, sigma * 3));
  const d = scale || workScale(r, m);
  const wc = workCopyFor(src, d);
  const mc = wc.mask.getContext("2d");
  mc.fillStyle = mc.strokeStyle = "#000";
  mc.setTransform(1 / d, 0, 0, 1 / d, 0, 0);
  tracePath(mc, p, core);
  mc.setTransform(1, 0, 0, 1, 0, 0);
  const a = brushArea(p, r, m, d);
  if (!a) return;
  // the changed picture
  scratch.width = a.W;
  scratch.height = a.H;
  const c = scratch.getContext("2d");
  if (blur) c.filter = `blur(${blur / d}px)`;
  c.drawImage(edgeExtended(wc.small, a.OX / d, a.OY / d, a.W, a.H), 0, 0); // at the border it blurs with itself
  c.filter = "none";
  if (process) process(c, a.W, a.H, a.OX, a.OY, d);
  // its mask: the stroke's core, blurred (past the photo's border the mask goes on as at the border, so a
  // stroke along the border does not fade towards it)
  maskScratch.width = a.W;
  maskScratch.height = a.H;
  const k = maskScratch.getContext("2d");
  if (sigma) k.filter = `blur(${sigma / d}px)`;
  k.drawImage(edgeExtended(wc.mask, a.OX / d, a.OY / d, a.W, a.H), 0, 0);
  k.filter = "none";
  c.globalCompositeOperation = "destination-in";
  c.drawImage(maskScratch, 0, 0);
  c.globalCompositeOperation = "source-over";
  photo.getContext("2d").drawImage(src, a.X0, a.Y0, a.w, a.h, a.X0, a.Y0, a.w, a.h);
  drawBack(c, a, d, 1, crisp);
}

const edgeScratch = createCanvas(1, 1);
/** The W x H piece of canvas src at (x, y); where it reaches past src's sides, their edge pixels repeat. */
function edgeExtended(src, x, y, W, H) {
  edgeScratch.width = W;
  edgeScratch.height = H;
  const e = edgeScratch.getContext("2d");
  e.imageSmoothingEnabled = false;
  // inside part
  const ix0 = Math.max(0, x);
  const iy0 = Math.max(0, y);
  const ix1 = Math.min(src.width, x + W);
  const iy1 = Math.min(src.height, y + H);
  if (ix1 <= ix0 || iy1 <= iy0) return edgeScratch;
  e.drawImage(src, ix0, iy0, ix1 - ix0, iy1 - iy0, ix0 - x, iy0 - y, ix1 - ix0, iy1 - iy0);
  // stretch the edge rows and columns over what lies outside (first left/right, then top/bottom with corners)
  const L = ix0 - x;
  const R = x + W - ix1;
  const T = iy0 - y;
  const B = y + H - iy1;
  const iw = ix1 - ix0;
  const ih = iy1 - iy0;
  if (L > 0) e.drawImage(edgeScratch, L, T, 1, ih, 0, T, L, ih);
  if (R > 0) e.drawImage(edgeScratch, L + iw - 1, T, 1, ih, L + iw, T, R, ih);
  if (T > 0) e.drawImage(edgeScratch, 0, T, W, 1, 0, 0, W, T);
  if (B > 0) e.drawImage(edgeScratch, 0, T + ih - 1, W, 1, 0, T + ih, W, B);
  return edgeScratch;
}

/**
 * "Smooth" style: how coarse a texture it flattens (radius, photo pixels, about 0.6..2.5 cells of a default
 * coloring) and how strong a texture still counts as one (eps: variance; stronger contrast is an edge and
 * stays). Both grow with the strength.
 */
function surfaceParams(strength) {
  const s = strength / 100;
  const cell = Math.max(1, Math.sqrt((wiz.base.width * wiz.base.height) / DEFAULT_PIXELS));
  const level = 4 + 36 * s; // spread of brightness (0..255) still smoothed away
  return { radius: Math.max(1, cell * (0.6 + 1.9 * s)), eps: level * level };
}

/**
 * "Simplify" (its own tool): a much stronger smoothing, then the brightness rounded to a few levels, so a busy
 * background turns into a few large even patches (fewer stray cells in the coloring). Grows with strength.
 */
function flatParams(strength) {
  const s = strength / 100;
  const cell = Math.max(1, Math.sqrt((wiz.base.width * wiz.base.height) / DEFAULT_PIXELS));
  const level = 12 + 48 * s;
  return { radius: Math.max(1, cell * (1.5 + 4.5 * s)), eps: level * level, step: 10 + 22 * s };
}

/** "Simplify" on the w x h piece in c: smooth (as smoothSurface), round the brightness, tidy the patch borders. */
function flatten(c, w, h, radius, eps, step) {
  smoothSurface(c, w, h, radius, eps);
  smoothSurface(c, w, h, radius, eps);
  const img = c.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  // only the brightness is rounded (to the same grid everywhere, so pieces of a stroke agree); rounding the
  // channels on their own tinted grey backgrounds pink and green
  const level = new Int32Array(n);
  const cb = new Float32Array(n);
  const cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    level[i] = Math.round(y / step);
    cb[i] = d[i * 4 + 2] - y;
    cr[i] = d[i * 4] - y;
  }
  // each pixel takes the most common level around it: no single-pixel specks along the patch borders
  const out = new Int32Array(level);
  const seen = new Int32Array(9);
  const count = new Int32Array(9);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const v = level[(y + dy) * w + x + dx];
          let j = 0;
          while (j < m && seen[j] !== v) j++;
          if (j === m) {
            seen[m] = v;
            count[m++] = 0;
          }
          count[j]++;
        }
      let best = 0;
      for (let j = 1; j < m; j++) if (count[j] > count[best]) best = j;
      out[y * w + x] = seen[best];
    }
  for (let i = 0; i < n; i++) {
    const y = out[i] * step;
    const r = y + cr[i];
    const b = y + cb[i];
    d[i * 4] = r; // (clamped by the array)
    d[i * 4 + 1] = (y - 0.299 * r - 0.114 * b) / 0.587;
    d[i * 4 + 2] = b;
  }
  c.putImageData(img, 0, 0);
}

/**
 * Edge-preserving smoothing of the w x h piece in c (He et al.'s guided filter, each channel guided by
 * itself): where a window's colors spread less than sqrt(eps) they are replaced by its mean, where they spread
 * more (an edge, a line) they stay. Costs a few passes over the piece, whatever the radius.
 */
function smoothSurface(c, w, h, radius, eps) {
  const r = Math.max(1, Math.round(radius));
  const img = c.getImageData(0, 0, w, h);
  const data = img.data;
  const n = w * h;
  const I = new Float32Array(n);
  const mean = new Float32Array(n);
  const sq = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  const tmp = new Float32Array(n);
  for (let ch = 0; ch < 3; ch++) {
    for (let i = 0; i < n; i++) {
      const v = data[i * 4 + ch];
      I[i] = v;
      sq[i] = v * v;
    }
    boxMean(I, mean, w, h, r, tmp);
    boxMean(sq, sq, w, h, r, tmp);
    for (let i = 0; i < n; i++) {
      const variance = Math.max(0, sq[i] - mean[i] * mean[i]);
      const a = variance / (variance + eps);
      A[i] = a;
      B[i] = mean[i] * (1 - a);
    }
    boxMean(A, A, w, h, r, tmp);
    boxMean(B, B, w, h, r, tmp);
    for (let i = 0; i < n; i++) data[i * 4 + ch] = A[i] * I[i] + B[i];
  }
  c.putImageData(img, 0, 0);
}

/** Mean over the (2r+1)^2 window around each pixel (fewer at the sides); src may be dst. */
function boxMean(src, dst, w, h, r, tmp) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x < Math.min(r, w); x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) sum += src[row + x + r];
      if (x - r - 1 >= 0) sum -= src[row + x - r - 1];
      tmp[row + x] = sum / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y < Math.min(r, h); y++) sum += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) sum += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) sum -= tmp[(y - r - 1) * w + x];
      dst[y * w + x] = sum / (Math.min(h - 1, y + r) - Math.max(0, y - r) + 1);
    }
  }
}

/**
 * Mosaic of the w x h piece in c (at photo position X0, Y0, d photo pixels a pixel): squares of `size` photo
 * pixels (a multiple of d) on the photo's own grid, so overlapping strokes match.
 */
function mosaic(c, w, h, X0, Y0, size, d = 1) {
  const s = size / d;
  const ox = ((((X0 / d) % s) + s) % s) | 0;
  const oy = ((((Y0 / d) % s) + s) % s) | 0;
  const cols = Math.ceil((w + ox) / s);
  const rows = Math.ceil((h + oy) / s);
  const small = createCanvas(cols, rows);
  const g = small.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(c.canvas, -ox, -oy, cols * s, rows * s, 0, 0, cols, rows);
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, w, h);
  c.drawImage(small, 0, 0, cols, rows, -ox, -oy, cols * s, rows * s);
  c.imageSmoothingEnabled = true;
}

/** Stamp: the lasso piece of the photo (feathered), drawn shifted by (dx, dy). The piece comes from `src`. */
function drawStamp(target, src, lasso, dx, dy, feather) {
  const piece = stampPiece(src, lasso, feather);
  if (piece) target.drawImage(piece.canvas, piece.x + dx, piece.y + dy);
}

/** The lasso piece of `src` with its edge fading out over `feather` px: { canvas, x, y } (its photo position). */
function stampPiece(src, lasso, feather) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < lasso.length; i += 2) {
    minX = Math.min(minX, lasso[i]);
    maxX = Math.max(maxX, lasso[i]);
    minY = Math.min(minY, lasso[i + 1]);
    maxY = Math.max(maxY, lasso[i + 1]);
  }
  const m = Math.ceil(feather * 2) + 2;
  const X0 = Math.floor(minX) - m;
  const Y0 = Math.floor(minY) - m;
  const w = Math.ceil(maxX) + m - X0;
  const h = Math.ceil(maxY) + m - Y0;
  if (w < 1 || h < 1 || w * h > 40e6) return null;
  // mask: the lasso filled, its edge blurred into a fade
  const mask = createCanvas(w, h);
  const mc = mask.getContext("2d");
  if (feather > 0.5) mc.filter = `blur(${feather / 2}px)`;
  mc.fillStyle = "#000";
  mc.beginPath();
  mc.moveTo(lasso[0] - X0, lasso[1] - Y0);
  for (let i = 2; i < lasso.length; i += 2) mc.lineTo(lasso[i] - X0, lasso[i + 1] - Y0);
  mc.closePath();
  mc.fill();
  const piece = createCanvas(w, h);
  const c = piece.getContext("2d");
  c.drawImage(src, X0, Y0, w, h, 0, 0, w, h);
  c.globalCompositeOperation = "destination-in";
  c.drawImage(mask, 0, 0);
  return { canvas: piece, x: X0, y: Y0 };
}

/** Feather of a new stamp in photo pixels: the slider's share of a quarter of the lasso's smaller side. */
function stampFeather(lasso) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < lasso.length; i += 2) {
    minX = Math.min(minX, lasso[i]);
    maxX = Math.max(maxX, lasso[i]);
    minY = Math.min(minY, lasso[i + 1]);
    maxY = Math.max(maxY, lasso[i + 1]);
  }
  return (wiz.feather / 100) * 0.25 * Math.min(maxX - minX, maxY - minY);
}

/** Outlines of the shapes in a unit box (u: 0..1 along the first side, v: 0..1 along the second). */
const STAR = (() => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const R = i % 2 ? 0.2 : 0.5;
    pts.push([0.5 + R * Math.cos(a), 0.5 + R * Math.sin(a)]);
  }
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const sx = Math.max(...xs) - x0;
  const sy = Math.max(...ys) - y0;
  return pts.map(([x, y]) => [(x - x0) / sx, (y - y0) / sy]);
})();
const UNIT_POLYGONS = {
  rect: [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
  tri: [
    [0.5, 0],
    [1, 1],
    [0, 1],
  ],
  diamond: [
    [0.5, 0],
    [1, 0.5],
    [0.5, 1],
    [0, 0.5],
  ],
  hex: [
    [0.25, 0],
    [0.75, 0],
    [1, 0.5],
    [0.75, 1],
    [0.25, 1],
    [0, 0.5],
  ],
  star: STAR,
  arrow: [
    [0, 0.32],
    [0.58, 0.32],
    [0.58, 0.06],
    [1, 0.5],
    [0.58, 0.94],
    [0.58, 0.68],
    [0, 0.68],
  ],
};

function drawShape(ctx, op, p) {
  const r = op.radius * tiltMatrix()[2];
  ctx.fillStyle = ctx.strokeStyle = op.color;
  if (op.shape === "line") {
    tracePath(ctx, p, r);
    return;
  }
  // the unit shape stretched onto the box: u along the first side, v along the last one
  ctx.save();
  ctx.transform(p[2] - p[0], p[3] - p[1], p[6] - p[0], p[7] - p[1], p[0], p[1]);
  ctx.beginPath();
  if (op.shape === "oval") ctx.ellipse(0.5, 0.5, 0.5, 0.5, 0, 0, Math.PI * 2);
  else if (op.shape === "heart") {
    ctx.moveTo(0.5, 1);
    ctx.bezierCurveTo(0.1, 0.72, 0, 0.5, 0, 0.3);
    ctx.bezierCurveTo(0, 0.12, 0.14, 0, 0.29, 0);
    ctx.bezierCurveTo(0.4, 0, 0.48, 0.07, 0.5, 0.17);
    ctx.bezierCurveTo(0.52, 0.07, 0.6, 0, 0.71, 0);
    ctx.bezierCurveTo(0.86, 0, 1, 0.12, 1, 0.3);
    ctx.bezierCurveTo(1, 0.5, 0.9, 0.72, 0.5, 1);
  } else {
    const poly = UNIT_POLYGONS[op.shape] || UNIT_POLYGONS.rect;
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  }
  ctx.closePath();
  ctx.restore(); // the path stays where it was drawn; the outline width is not stretched with it
  if (op.outline) {
    ctx.lineWidth = Math.max(1, 2 * r);
    ctx.lineJoin = "round";
    ctx.stroke();
  } else ctx.fill();
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
  else if (kind === "blur") {
    if (!op.style) drawFrom(photo, 0, 0, p, r, blurPx(r));
    else replayBlur(op, p, r);
  } else if (kind === "clone") {
    const [dx, dy] = cloneShift(op);
    drawFrom(photo, dx, dy, p, r);
  } else if (kind === "stamp") {
    const [dx, dy] = cloneShift(op);
    drawStamp(ctx, photo, p, dx, dy, op.feather * tiltMatrix()[2]);
  } else if (kind === "shape") drawShape(ctx, op, p);
  else if (kind !== "mark") applyPixelEdit(op); // marks live in markMask, not in the photo
}

/** A blur stroke replayed the way it was drawn: a dot, then piece by piece (motion and smudge need that). */
function replayBlur(op, p, r) {
  const style = op.style;
  // the styles that copy from the photo as it was when the stroke started work from a snapshot of it
  const src = style === "smudge" ? photo : photoCopy();
  beginBlurMask();
  if (style === "soft" || style === "smart" || style === "mosaic" || style === "flat") {
    const first = [p[0], p[1]];
    blurSegment(op, src, first, first, r); // a dot, as the stroke began (the same object twice: see blurSegment)
    for (let i = 2; i < p.length; i += 2) blurSegment(op, src, [p[i - 2], p[i - 1]], [p[i], p[i + 1]], r);
    return;
  }
  for (let i = 2; i < p.length; i += 2) blurSegment(op, src, [p[i - 2], p[i - 1]], [p[i], p[i + 1]], r);
}

/** Clone offset of an edit, in photo pixels (the same everywhere: the photo transform is linear). */
function cloneShift(op) {
  const a = sourceToPhoto(op.points[0], op.points[1]);
  const b = sourceToPhoto(op.points[0] + op.off[0], op.points[1] + op.off[1]);
  return [b[0] - a[0], b[1] - a[1]];
}

/** photo = base + all edits. The photo's own canvas is reused: a new one each time cost 4 bytes a pixel. */
function replayEdits() {
  if (!wiz.strokes.length) {
    photo = wiz.base;
    rebuildMarks();
    return;
  }
  if (photo === wiz.base || photo.width !== wiz.base.width || photo.height !== wiz.base.height)
    photo = createCanvas(wiz.base.width, wiz.base.height);
  const g = photo.getContext("2d");
  g.globalCompositeOperation = "copy";
  g.drawImage(wiz.base, 0, 0);
  g.globalCompositeOperation = "source-over";
  for (const op of wiz.strokes) applyEdit(op);
  rebuildMarks();
}

/**
 * The photo as it is now, in one canvas kept for this (a big photo takes tens of MB; a new copy for every
 * stroke and every replayed blur stroke filled the phone's memory). Valid until the next call.
 */
const photoCopyCanvas = createCanvas(1, 1);
function photoCopy() {
  if (photoCopyCanvas.width !== photo.width || photoCopyCanvas.height !== photo.height) {
    photoCopyCanvas.width = photo.width;
    photoCopyCanvas.height = photo.height;
  }
  const g = photoCopyCanvas.getContext("2d");
  g.globalCompositeOperation = "copy";
  g.drawImage(photo, 0, 0);
  g.globalCompositeOperation = "source-over";
  return photoCopyCanvas;
}

/** Before the first edit photo is the base itself; edits must not change the base. */
function ensureOwnPhoto() {
  if (photo !== wiz.base) return;
  photo = createCanvas(wiz.base.width, wiz.base.height);
  photo.getContext("2d").drawImage(wiz.base, 0, 0);
}

/* tools that need a color, a size, a tolerance, a shape kind or a clone source */
const COLOR_TOOLS = ["brush", "shape", "fill", "recolor", "pick"];
const SIZE_TOOLS = ["brush", "shape", "blur", "flat", "mark", "rest"];
const TOL_TOOLS = ["fill", "recolor"];

function updateEditorUi() {
  $$("#editor-tools [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === wiz.tool));
  const stampReady = wiz.tool === "clone" && wiz.stamp;
  const tool = wiz.tool;
  $("#editor-hint").textContent = t(tool === "blur" ? "h_blur_" + wiz.blur : "h_" + wiz.tool + (stampReady ? "2" : ""));
  $("#frame-options").hidden = tool !== "crop";
  $("#brush-color").hidden = !COLOR_TOOLS.includes(tool);
  $("#brush-color").style.background = wiz.color;
  $("#shape-options").hidden = tool !== "shape";
  $$("#shape-kinds [data-shape]").forEach((b) => b.classList.toggle("on", b.dataset.shape === wiz.shape));
  $$("#shape-mode [data-outline]").forEach((b) =>
    b.classList.toggle("on", (b.dataset.outline === "1") === wiz.shapeOutline),
  );
  $("#shape-mode").hidden = wiz.shape === "line";
  $("#blur-styles").hidden = tool !== "blur";
  $("#mark-mode").hidden = tool !== "mark";
  $$("#mark-mode [data-erase]").forEach((b) => b.classList.toggle("on", (b.dataset.erase === "1") === wiz.markErase));
  $$("#blur-styles [data-blur]").forEach((b) => b.classList.toggle("on", b.dataset.blur === wiz.blur));
  $("#btn-clone-source").hidden = !stampReady;
  // filled shapes need no size: only lines and outlines have a thickness
  const sized = SIZE_TOOLS.includes(tool) && !(tool === "shape" && wiz.shape !== "line" && !wiz.shapeOutline);
  $("#brush-size").closest(".field").hidden = !sized;
  $("#strength").closest(".field").hidden = tool !== "blur" && tool !== "flat";
  $("#feather").closest(".field").hidden = tool !== "clone" && tool !== "blur" && tool !== "flat";
  $("#tol").closest(".field").hidden = !TOL_TOOLS.includes(tool);
  $("#paint-options").hidden = ![...COLOR_TOOLS, ...SIZE_TOOLS, "clone"].includes(tool);
  $("#btn-edit-reset").hidden = tool === "crop";
  fitToolLabels();
  drawCrop();
}

/** Tool names too long for their tile ("Упростить") get a slightly smaller font instead of an ellipsis. */
function fitToolLabels() {
  for (const s of $$("#editor-tools .tool-tile span")) {
    if (s.dataset.fit === s.textContent) continue; // measured already
    s.style.fontSize = "";
    for (let f = 10.5; f >= 9 && s.scrollWidth > s.clientWidth; f -= 0.5) s.style.fontSize = f + "px";
    if (s.clientWidth) s.dataset.fit = s.textContent;
  }
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
  if (wiz.tool === "clone") {
    // the lasso being drawn or the outline of what the stamp copies, and the copy under the finger
    const lasso = lassoDraft ? lassoDraft.flat() : wiz.stamp ? opPoints(wiz.stamp) : null;
    if (stampPlace && stampPreview) {
      const [ax, ay] = toScreen([stampPreview.x + stampPlace.dx, stampPreview.y + stampPlace.dy]);
      x.drawImage(
        stampPreview.canvas,
        ax,
        ay,
        stampPreview.canvas.width * g.scale,
        stampPreview.canvas.height * g.scale,
      );
    }
    if (lasso && lasso.length >= 4) {
      x.save();
      x.setLineDash([6, 5]);
      for (const [color, width, offset] of [
        ["#000a", 3, 0],
        ["#fff", 1.5, 5.5],
      ]) {
        x.strokeStyle = color;
        x.lineWidth = width;
        x.lineDashOffset = offset;
        x.beginPath();
        const [sx, sy] = toScreen([lasso[0], lasso[1]]);
        x.moveTo(sx, sy);
        for (let i = 2; i < lasso.length; i += 2) x.lineTo(...toScreen([lasso[i], lasso[i + 1]]));
        if (!lassoDraft) x.closePath();
        x.stroke();
      }
      x.restore();
    }
  }
}

/**
 * A shape edit from two photo points (a box upright on screen; a line: the two points). An arrow points the way
 * the finger moved (right, left, up or down): its corners are listed turned that way.
 */
function shapeEdit(a, b) {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  let corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  if (wiz.shape === "line") corners = [a, b];
  else if (wiz.shape === "arrow") {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const turn = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : dy >= 0 ? 1 : 3; // right, down, left, up
    corners = [0, 1, 2, 3].map((i) => corners[[i, (i + 1) % 4, (i + 2) % 4, (i + 3) % 4][turn]]);
  }
  return {
    kind: "shape",
    shape: wiz.shape,
    outline: wiz.shape !== "line" && wiz.shapeOutline,
    color: wiz.color,
    radius: wiz.brushSize / 2 / cropGeometry().scale / tiltMatrix()[2],
    points: corners.flatMap((q) => photoToSource(q[0], q[1])),
    photoPoints: corners.flat(),
  };
}

/* ---------- brush ring and loupe ----------
   While a finger paints with a brush tool, a thin black ring shows the brush around it, and a loupe above the
   finger shows that spot magnified (the finger itself hides it). The eyedropper gets the loupe too. */
const RING_TOOLS = new Set(["brush", "rest", "blur", "flat", "mark"]);
const LOUPE_TOOLS = new Set([...RING_TOOLS, "pick"]);
const LOUPE_SIZE = 128; // CSS px, as in style.css
const LOUPE_ZOOM = 2.5;
const LOUPE_GAP = 56; // CSS px between the finger and the loupe
const loupe = $("#edit-loupe");
let brushAt = null; // [x, y] screen point of the finger painting with a ring or loupe tool, or null

function drawBrushRing(x) {
  if (!brushAt || !RING_TOOLS.has(wiz.tool)) return;
  const r = wiz.brushSize / 2;
  x.lineWidth = 1;
  // a faint light rim outside the black ring keeps it visible on dark parts of the picture
  x.strokeStyle = "rgba(255,255,255,.55)";
  x.beginPath();
  x.arc(brushAt[0], brushAt[1], r + 1, 0, 7);
  x.stroke();
  x.strokeStyle = "#000";
  x.beginPath();
  x.arc(brushAt[0], brushAt[1], r, 0, 7);
  x.stroke();
}

function drawLoupe() {
  const on = !!brushAt && LOUPE_TOOLS.has(wiz.tool);
  loupe.hidden = !on;
  if (!on) return;
  const dpr = devicePixelRatio || 1;
  const n = Math.round(LOUPE_SIZE * dpr);
  if (loupe.width !== n) loupe.width = loupe.height = n;
  const c = loupe.getContext("2d");
  const [x, y] = brushAt;
  const span = LOUPE_SIZE / LOUPE_ZOOM; // CSS px of the picture it shows
  c.fillStyle = "#222";
  c.fillRect(0, 0, n, n);
  c.drawImage(cropCanvas, (x - span / 2) * dpr, (y - span / 2) * dpr, span * dpr, span * dpr, 0, 0, n, n);
  if (wiz.tool === "pick") {
    // the eyedropper's spot: a small cross in the middle
    const m = n / 2;
    const a = 7 * dpr;
    c.lineWidth = 3 * dpr;
    c.strokeStyle = "#fff";
    c.beginPath();
    c.moveTo(m - a, m);
    c.lineTo(m + a, m);
    c.moveTo(m, m - a);
    c.lineTo(m, m + a);
    c.stroke();
    c.lineWidth = 1 * dpr;
    c.strokeStyle = "#000";
    c.stroke();
  }
  // above the finger; below it where there is no room above
  const W = cropCanvas.clientWidth;
  const H = cropCanvas.clientHeight;
  let top = y - LOUPE_GAP - LOUPE_SIZE;
  if (top < 4) top = y + LOUPE_GAP;
  loupe.style.left = Math.max(4, Math.min(W - LOUPE_SIZE - 4, x - LOUPE_SIZE / 2)) + "px";
  loupe.style.top = Math.max(4, Math.min(H - LOUPE_SIZE - 4, top)) + "px";
}

const editPointers = new Map();
let activeStroke = null; // edit being drawn with the finger
let strokeSource = null; // picture the clone/blur stroke copies from (the photo as it was when it started)
let lastPoint = null;
let editPinch = 0;
let editDraft = null; // { start, end } of a shape being dragged
let lassoDraft = null; // stamp: [[x, y], ...] the lasso being drawn (photo coordinates)
let stampPlace = null; // stamp: { dx, dy } shift of the copy being placed, in photo pixels
let stampPreview = null; // stamp: the piece shown under the finger ({ canvas, x, y }, see stampPiece)
let tapStart = null; // [x, y] screen position of a touch that may turn out to be a tap
// A brush / restore / blur stroke begins only once the finger has moved a little and a moment has passed: when a
// second finger lands first (a pinch), nothing was drawn and nothing has to be taken back.
let pendingStroke = null; // { op, points: [[x, y], ...] photo points so far, t: time, at: [x, y] screen }
let strokeStarted = 0; // time the active stroke began
let strokeAt = null; // [x, y] screen point where its finger came down
const STROKE_SLOP = 8; // screen px
const STROKE_DELAY = 80; // ms

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
  else if (kind === "blur") blurSegment(op, strokeSource, a, b, r);
  else if (kind === "mark") drawMark(op, p, r);
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
      // Second finger: this is a pinch. A stroke that has not begun is dropped; one that began a moment ago is
      // taken back from the copy of the photo made when it began (replaying all the edits instead could take
      // seconds and a lot of memory with big blur strokes).
      const top = history[history.length - 1];
      const first = [...editPointers.values()][0];
      const young =
        e.timeStamp - strokeStarted < 300 ||
        (strokeAt && Math.hypot(first[0] - strokeAt[0], first[1] - strokeAt[1]) < 40);
      if (activeStroke && strokeSource && young && top && top.stroke) {
        const g = photo.getContext("2d");
        g.globalCompositeOperation = "copy";
        g.drawImage(strokeSource, 0, 0);
        g.globalCompositeOperation = "source-over";
        const popped = wiz.strokes.pop();
        history.pop();
        if (popped.kind === "mark") rebuildMarks();
        photoChanged();
        $("#wiz-undo").disabled = !history.length;
      }
      pendingStroke = activeStroke = strokeSource = editDraft = tapStart = lassoDraft = stampPlace = brushAt = null;
      editPinch = 0;
      return drawCrop();
    }
    tapStart = [e.offsetX, e.offsetY];
    if (LOUPE_TOOLS.has(tool)) brushAt = [e.offsetX, e.offsetY];
    const p = pointerToPhoto(e);
    if (tool === "pick") {
      pickColor(e);
      return drawCrop();
    }
    if (tool === "shape") {
      editDraft = { start: p, end: null };
      return;
    }
    if (tool === "clone") {
      if (!wiz.stamp)
        lassoDraft = [p]; // first: draw the lasso around what to copy
      else {
        // then: the copy appears centered under the finger and moves with it
        const lasso = opPoints(wiz.stamp);
        stampPreview = stampPiece(photo, lasso, stampFeather(lasso));
        const c = lassoCenter(lasso);
        stampPlace = { dx: p[0] - c[0], dy: p[1] - c[1] };
      }
      return drawCrop();
    }
    const radius = wiz.brushSize / 2 / cropGeometry().scale / tiltMatrix()[2];
    let op = null;
    if (tool === "brush") op = { color: wiz.color, radius, points: photoToSource(...p) };
    else if (tool === "rest") op = { restore: true, radius, points: photoToSource(...p) };
    else if (tool === "blur" || tool === "flat")
      op = {
        kind: "blur",
        style: tool === "flat" ? "flat" : wiz.blur,
        strength: wiz.strength,
        soft: wiz.feather,
        radius,
        points: photoToSource(...p),
      };
    else if (tool === "mark") op = { kind: "mark", erase: wiz.markErase, radius, points: photoToSource(...p) };
    if (!op) return;
    pendingStroke = { op, points: [p], t: e.timeStamp, at: [e.offsetX, e.offsetY] };
    drawCrop(); // the ring and the loupe show at once
  },
  true,
);

/** The pending stroke begins: drawn up to where the finger is now. */
function beginStroke(t) {
  const { op, points, at } = pendingStroke;
  pendingStroke = null;
  strokeAt = at;
  ensureOwnPhoto();
  strokeSource = photoCopy(); // blur strokes copy from it; a pinch right after takes the stroke back with it
  if (op.kind === "blur") beginBlurMask();
  wiz.strokes.push(op);
  pushHistory({ stroke: true });
  activeStroke = op;
  strokeStarted = t;
  let last = points[0];
  strokeSegment(op, last, last);
  for (let i = 1; i < points.length; i++) {
    strokeSegment(op, last, points[i]);
    op.points.push(...photoToSource(points[i][0], points[i][1]));
    last = points[i];
  }
  lastPoint = last;
  photoChanged();
  drawCrop();
}

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
    if (brushAt && editPointers.size === 1) brushAt = now;
    if (editPointers.size > 1) {
      const [a, b] = [...editPointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (editPinch) zoomCropView(d / editPinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      editPinch = d;
      wiz.panX += (now[0] - old[0]) / 2;
      wiz.panY += (now[1] - old[1]) / 2;
      return drawCrop();
    }
    if (tool === "clone") {
      const q = pointerToPhoto(e);
      if (lassoDraft) {
        const last = lassoDraft[lassoDraft.length - 1];
        if (Math.hypot(q[0] - last[0], q[1] - last[1]) * cropGeometry().scale > 3) lassoDraft.push(q);
      } else if (stampPlace) {
        const c = lassoCenter(opPoints(wiz.stamp));
        stampPlace.dx = q[0] - c[0];
        stampPlace.dy = q[1] - c[1];
      }
      return drawCrop();
    }
    if (tool === "pan" || ((tool === "fill" || tool === "recolor") && !tapStart)) {
      // tap tools: a drag moves the picture instead
      wiz.panX += now[0] - old[0];
      wiz.panY += now[1] - old[1];
      drawCrop();
    } else if (tool === "pick") {
      pickColor(e);
      drawCrop();
    } else if (tool === "shape" && editDraft) {
      editDraft.end = pointerToPhoto(e);
      drawCrop();
    } else if (pendingStroke) {
      pendingStroke.points.push(pointerToPhoto(e));
      const moved = Math.hypot(now[0] - pendingStroke.at[0], now[1] - pendingStroke.at[1]);
      if (moved >= STROKE_SLOP && e.timeStamp - pendingStroke.t >= STROKE_DELAY) beginStroke(e.timeStamp);
      else drawCrop(); // (the ring follows the finger)
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
  if (single && pendingStroke) beginStroke(e.timeStamp); // a tap: one dot
  if (single) finishEdit(e);
  if (!editPointers.size) {
    pendingStroke = activeStroke = editDraft = tapStart = strokeSource = lassoDraft = stampPlace = stampPreview = null;
    brushAt = null;
    editPinch = 0;
    drawCrop();
  }
};
cropCanvas.addEventListener("pointerup", editPointerUp, true);
cropCanvas.addEventListener(
  "pointercancel",
  (e) => {
    tapStart = editDraft = pendingStroke = null;
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
  if (tool === "clone") return finishStamp();
  if (!tapped) return;
  const p = pointerToPhoto(e);
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

/** Stamp, finger lifted: a finished lasso becomes the source; a placed copy becomes an edit. */
function finishStamp() {
  if (lassoDraft) {
    const lasso = lassoDraft.flat();
    lassoDraft = null;
    // a scribble with almost no area inside is no selection
    let area = 0;
    for (let i = 0; i < lasso.length; i += 2) {
      const j = (i + 2) % lasso.length;
      area += lasso[i] * lasso[j + 1] - lasso[j] * lasso[i + 1];
    }
    const g = cropGeometry();
    if (Math.abs(area / 2) * g.scale * g.scale < 100) return drawCrop();
    wiz.stamp = { points: toSourcePoints(lasso) };
    return updateEditorUi();
  }
  if (stampPlace && wiz.stamp) {
    const lasso = opPoints(wiz.stamp);
    const c = lassoCenter(lasso);
    const from = photoToSource(c[0], c[1]);
    const to = photoToSource(c[0] + stampPlace.dx, c[1] + stampPlace.dy);
    stampPlace = stampPreview = null;
    commitEdit({
      kind: "stamp",
      points: wiz.stamp.points.slice(),
      off: [to[0] - from[0], to[1] - from[1]],
      feather: stampFeather(lasso) / tiltMatrix()[2],
    });
  }
}

/** Photo points [x, y, x, y, ...] in original-photo coordinates. */
function toSourcePoints(p) {
  const out = [];
  for (let i = 0; i < p.length; i += 2) out.push(...photoToSource(p[i], p[i + 1]));
  return out;
}

/** Middle of a lasso's bounding box (photo coordinates). */
function lassoCenter(p) {
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
  return [(minX + maxX) / 2, (minY + maxY) / 2];
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
  const outlineBtn = e.target.closest("[data-outline]");
  if (outlineBtn) {
    wiz.shapeOutline = outlineBtn.dataset.outline === "1";
    updateEditorUi();
  }
  const blurBtn = e.target.closest("[data-blur]");
  if (blurBtn) {
    wiz.blur = blurBtn.dataset.blur;
    updateEditorUi();
  }
  const markBtn = e.target.closest("[data-erase]");
  if (markBtn) {
    wiz.markErase = markBtn.dataset.erase === "1";
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
  wiz.stamp = null;
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
  if (e.target.id === "strength") {
    e.target.previousElementSibling.textContent = e.target.value;
    wiz.strength = +e.target.value;
  }
  if (e.target.id === "feather") {
    e.target.previousElementSibling.textContent = e.target.value;
    wiz.feather = +e.target.value;
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
    source.mask = sourceMask(R, w, h);
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
  source.mask = sourceMask(R, source.width, source.height);
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

/**
 * Auto enhance. Changes only what the picture clearly lacks, and only part of the way, so a picture that is fine
 * stays as it is (drawn art with pure black lines and a white background is usually fine):
 *   - levels: only if the darkest / lightest 0.5% are far from black / white;
 *   - contrast: only for a flat, washed-out picture; brightness: only for a dark one;
 *   - saturation: only for dull colors (not for a gray picture);
 *   - "enhance" (clean-up of compression noise): only if there is such noise at the size the canvas will be.
 * Every slider starts from neutral; a message says what was changed.
 */
function autoAdjustments() {
  const src = sourcePixels();
  const k = Math.min(1, 256 / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const img = boxScale(src, w, h);
  const n = w * h;
  const hist = new Uint32Array(256);
  let sum = 0;
  let sum2 = 0;
  let chroma = 0;
  let colored = 0;
  for (let i = 0; i < img.length; i += 4) {
    const r = img[i];
    const g = img[i + 1];
    const b = img[i + 2];
    const y = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
    hist[y]++;
    sum += y;
    sum2 += y * y;
    const hi = Math.max(r, g, b);
    if (hi > 30) {
      chroma += hi - Math.min(r, g, b);
      colored++;
    }
  }
  const percentile = (f) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= f * n) return v;
    return 255;
  };
  const mean = sum / n;
  const spread = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const lo = percentile(0.005);
  const hiLevel = percentile(0.995);
  const a = { ...NO_ADJUST };
  if (lo > 14) a.blk = Math.round(Math.min(20, (lo - 6) * 0.5) / 2.55);
  if (hiLevel < 238) a.wht = Math.round(Math.max(200, 255 - (255 - hiLevel - 4) * 0.5));
  if (spread < 45) a.con = Math.round(100 + Math.min(12, (45 - spread) * 0.6));
  if (mean < 90) a.bri = Math.round(100 + Math.min(12, (90 - mean) * 0.25));
  const meanChroma = colored ? chroma / colored : 0;
  if (meanChroma > 8 && meanChroma < 45) a.sat = Math.round(100 + Math.min(15, (45 - meanChroma) * 0.5));
  // compression noise, measured where the picture is smooth, at the size of a default canvas
  const noise = noiseLevel(src) / Math.max(1, src.width / (Math.sqrt(DEFAULT_PIXELS * (src.width / src.height)) * 4));
  if (noise > 3) a.enh = Math.min(4, Math.max(1, Math.round((noise - 2) * 1.2)));
  return a;
}

/**
 * Noise of the picture in gray levels (sigma), from a 384 px piece of its middle: the mean response of a
 * Laplacian-like kernel where there is no edge (Immerkaer's estimate, edges left out).
 */
function noiseLevel(src) {
  const size = Math.min(384, src.width - 2, src.height - 2);
  if (size < 16) return 0;
  const x0 = (src.width - size) >> 1;
  const y0 = (src.height - size) >> 1;
  const Y = (x, y) => {
    const p = ((y0 + y) * src.width + x0 + x) * 4;
    return 0.3 * src.data[p] + 0.59 * src.data[p + 1] + 0.11 * src.data[p + 2];
  };
  let total = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y++)
    for (let x = 1; x < size - 1; x++) {
      const gx = Y(x + 1, y) - Y(x - 1, y);
      const gy = Y(x, y + 1) - Y(x, y - 1);
      if (Math.abs(gx) + Math.abs(gy) > 24) continue; // an edge, not noise
      const lap =
        Y(x - 1, y - 1) +
        Y(x + 1, y - 1) +
        Y(x - 1, y + 1) +
        Y(x + 1, y + 1) -
        2 * (Y(x, y - 1) + Y(x - 1, y) + Y(x + 1, y) + Y(x, y + 1)) +
        4 * Y(x, y);
      total += Math.abs(lap);
      count++;
    }
  return count ? (Math.sqrt(Math.PI / 2) / 6) * (total / count) : 0;
}

$("#btn-auto-enhance").onclick = () => {
  snapshot();
  const before = { ...wiz.adjust };
  wiz.adjust = autoAdjustments();
  ADJUSTMENTS.forEach(([key]) => setSlider("adj-" + key, wiz.adjust[key]));
  wiz.result = null;
  drawAdjustPreview();
  const changed = ADJUSTMENTS.filter(([key]) => wiz.adjust[key] !== NO_ADJUST[key]).map(([key]) => {
    const d = wiz.adjust[key] - NO_ADJUST[key];
    return t(key).split(" (")[0].toLowerCase() + " " + (d > 0 ? "+" : "") + d;
  });
  toast(changed.length ? t("auto") + ": " + changed.join(", ") : t("auto_ok"));
  if (ADJUSTMENTS.every(([key]) => before[key] === wiz.adjust[key])) history.pop(); // nothing to undo
  $("#wiz-undo").disabled = !history.length;
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
  $("#blend-field").hidden = wiz.style !== "art"; // transition dithering: the art mode's own
}

/** The transition dithering slider (art mode, 0..3), shown in words. */
function setBlend(v) {
  setSlider("blend", v);
  showBlendValue();
}
const showBlendValue = () => ($("#blend").previousElementSibling.textContent = t("tdl_" + $("#blend").value));
$("#style-list").onclick = (e) => {
  const b = e.target.closest(".style-row");
  if (!b) return;
  wiz.style = b.dataset.style;
  renderStyleList();
  schedulePreview();
  rememberPixelSettings();
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
    blend: wiz.style === "art" ? +$("#blend").value : 0,
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
  if (el.id === "colors-exact" || el.id === "colors") wiz.autoColors = false; // the user's own number now
  if (el.id === "colors-exact") {
    const n = Math.round(+el.value);
    if (n >= 2) setSlider("colors", Math.min(1000, n));
    return schedulePreview();
  }
  if (el.type === "range") el.previousElementSibling.textContent = el.value;
  if (el.id === "blend") showBlendValue();
  if (el.id === "px-width" && $("#keep-ratio").checked)
    $("#px-height").value = clampSize($("#px-width").value / cropRatio());
  if (el.id === "px-height" && $("#keep-ratio").checked)
    $("#px-width").value = clampSize($("#px-height").value * cropRatio());
  if (el.id === "px-width" || el.id === "px-height") syncPixelCount();
  schedulePreview();
});
$("#colors-exact").addEventListener("change", (e) => (e.target.value = $("#colors").value));
$("#panel-pixel").addEventListener("input", () => rememberPixelSettings());

/*
 * The next picture starts this step with what was used last: the size (as a number of cells, in the new frame's
 * proportions), the colors ("Auto colors" or the user's own number), mode, cleanliness, transition dithering,
 * the gray view and the divider. Saved on every change, not only when a canvas is made.
 */
function rememberPixelSettings() {
  const p = pixelParams();
  settings.pm = p.style;
  settings.pcl = p.clean;
  if (p.style === "art") settings.pbl = p.blend;
  settings.pcells = p.width * p.height;
  settings.pcol = wiz.autoColors ? 0 : p.colors;
  settings.pgr = wiz.gray ? 1 : 0;
  settings.pcmp = wiz.compare ?? 0.5;
  saveSettings();
}

let previewTimer = 0;
const exceptColors = (p) => JSON.stringify([p.width, p.height, p.style, p.clean, p.blend]);

/*
 * A change makes a new preview after a short pause. There is no rough draft in between: the last preview
 * stays on screen until the new one is ready, so what the change did shows at once.
 */
function schedulePreview() {
  clearTimeout(previewTimer);
  const p = pixelParams();
  // the colors follow "Auto colors" (see autoKey): the real preview comes after counting them again
  const next = wiz.autoColors && autoKey(p) !== wiz.autoKey ? () => autoColors(true) : runPreview;
  previewTimer = setTimeout(next, p.width * p.height > 1e6 ? 900 : 450);
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
      mask: source.mask,
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

/**
 * Gray of a color in the gray view: the formula of CSS grayscale(), which grays the original half (Rec. 709
 * weights). With other weights the two halves differed: red and pink came out up to ~15 levels lighter in the
 * pixel half, green darker.
 */
const grayOf = (r, g, b) => Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);

/** Puts a result's cells on the preview canvas (no palette strip). */
function drawCells({ width: W, height: H, idx, pal }) {
  wiz.drawn = true;
  const K = pal.length / 3;
  const colors = new Uint32Array(K);
  for (let k = 0; k < K; k++) {
    let r = pal[k * 3];
    let g = pal[k * 3 + 1];
    let b = pal[k * 3 + 2];
    if (wiz.gray) r = g = b = grayOf(r, g, b);
    colors[k] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  previewCanvas.width = W;
  previewCanvas.height = H;
  const ctx = previewCanvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const px = new Uint32Array(img.data.buffer);
  for (let i = 0; i < W * H; i++) px[i] = colors[idx[i]];
  ctx.putImageData(img, 0, 0);
  drawOriginal(W, H);
  applyPreviewZoom();
}

function showPreview() {
  const { width: W, height: H, idx, pal } = wiz.result.result;
  const K = pal.length / 3;
  const counts = new Uint32Array(K);
  for (let i = 0; i < idx.length; i++) counts[idx[i]]++;
  let strip = "";
  for (let k = 0; k < K; k++) {
    let r = pal[k * 3];
    let g = pal[k * 3 + 1];
    let b = pal[k * 3 + 2];
    if (wiz.gray) r = g = b = grayOf(r, g, b);
    strip += `<span style="background:rgb(${r},${g},${b});color:${grayOf(r, g, b) > 140 ? "#000" : "#fff"}">${k + 1}<i>${counts[k]}</i></span>`;
  }
  drawCells(wiz.result.result);
  $("#palette-strip").innerHTML = strip;
  $("#preview-info").textContent = `${plural(K, "ncol")} · ${W}×${H}`;
  $("#preview-gray").textContent = t(wiz.gray ? "gray" : "color");
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
  // before the picture's first preview: its original, whole; then the divider (none while a new one is made)
  const whole = !wiz.drawn;
  const x = whole ? previewWrap.clientWidth : Math.round((wiz.compare ?? 0.5) * previewWrap.clientWidth);
  $("#compare-clip").style.width = x + "px";
  $("#compare-line").style.left = x + "px";
  $("#compare-clip").hidden = !whole && !wiz.result;
  $("#compare-line").hidden = whole || !wiz.result;
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
const knobUp = () => {
  if (knob.dragging) rememberPixelSettings();
  knob.dragging = false;
};
knob.addEventListener("pointerup", knobUp);
knob.addEventListener("pointercancel", knobUp);

$("#preview-gray").onclick = () => {
  wiz.gray = !wiz.gray;
  rememberPixelSettings();
  if (wiz.result) showPreview();
  else $("#preview-gray").textContent = t(wiz.gray ? "gray" : "color");
};

$("#btn-auto-colors").onclick = () => {
  autoColors(false); // (turns "Auto colors" on before it waits for anything)
  rememberPixelSettings();
};

/**
 * "Auto colors": picks the number of colors, then shows the preview with it. quiet: the automatic run when a
 * new picture first reaches this step: no busy screen, the progress shows under the preview, and anything
 * the user changes meanwhile simply takes over (its preview replaces this job in the worker).
 */
async function autoColors(quiet) {
  if (quiet && !wiz.autoColors) return; // the user set a number of their own since this was planned
  wiz.autoColors = true; // (the button: follow the size again from now on)
  const label = t("autoc");
  const status = (text) => (quiet ? ($("#preview-info").textContent = text) : setBusyText(text));
  if (quiet) status(label + "…");
  else setBusy(true, label);
  const p = pixelParams();
  try {
    const best = await runJob("suggest", p, (mid) => status(label + " · " + mid));
    if (!quiet) setBusy(false);
    // replaced by a newer job, or the user set a number of their own meanwhile
    if (best == null || !wiz.autoColors) return;
    wiz.autoKey = autoKey(p);
    setSlider("colors", best);
    if (!quiet) toast(label + ": " + best);
    runPreview();
  } catch (e) {
    if (!quiet) setBusy(false);
    toast(String(e));
  }
}

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
    rememberPixelSettings();
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
