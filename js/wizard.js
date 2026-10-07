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
import { boxScale, applyAdjustments, STYLE_GROUPS, NO_ADJUST } from "./engine.js";
import { openGame, saveGame } from "./game.js";
import { library } from "./library.js";

const ADJUSTMENTS = [
  // [key, min, max, default]
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

$("#panel-crop").innerHTML =
  `<div class="chips" id="ratio-chips"></div>` +
  `<div class="chips"><button class="chip" id="btn-mirror"></button><button class="chip" id="btn-rotate"></button></div>` +
  `<div class="chips" id="editor-tools">${["crop", "pan", "brush", "rest", "pick"].map((k) => `<button class="chip" data-tool="${k}" data-i="e_${k}"></button>`).join("")}</div>` +
  `<div id="editor-hint"></div>` +
  `<div class="chips"><input type="color" id="brush-color" value="#ffffff"><button class="chip" data-zoom="1">＋</button><button class="chip" data-zoom="-1">－</button><button class="chip" data-zoom="0" data-i="e_fit"></button><button class="chip" id="btn-edit-reset" data-i="e_reset"></button></div>` +
  sliderHtml("brush-size", "e_size", 2, 160, 28);

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
  sliderHtml("denoise", "dn", 0, 5, 2) +
  sliderHtml("specks", "simp", 0, 12, 3);

$$("#panel-crop .range,#panel-adjust .range,#panel-pixel .range").forEach(initRangeSlider);

/* ---------- start / steps ---------- */

$("#file-input").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) startWizard(file);
};

/** Opens the wizard for an image File/Blob (from the + button or shared from the gallery). */
export async function startWizard(file) {
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
    strokes: [], // touch-up strokes, in original photo coordinates
    editVersion: 0, // bumps on every change to the photo pixels
    step: 1,
    gray: true, // preview in gray (judge shapes, not colors)
    adjust: { ...NO_ADJUST },
    style: "smooth",
    tool: "crop",
    brushSize: 28,
    zoom: 1, // crop view zoom/pan
    panX: 0,
    panY: 0,
    previewZoom: 1,
    previewX: 0,
    previewY: 0,
  };
  history = [];
  $("#wiz-undo").disabled = true;
  ADJUSTMENTS.forEach(([key, , , v]) => setSlider("adj-" + key, v));
  resetOrientation();
  showScreen("screen-wizard");
  goToStep(1);
  translateWizard();
}

export function translateWizard() {
  translatePage();
  $("#btn-mirror").innerHTML = icon("flip") + " " + t("mir");
  $("#btn-rotate").innerHTML = icon("rot") + " " + t("rotb");
  $("#wiz-back").innerHTML = icon("back");
  $("#wiz-undo").innerHTML = icon("undo");
  $("#preview-gray").textContent = t(wiz.gray ? "gray" : "color");
  if (wiz.step) updateEditorUi();
}

function goToStep(n) {
  wiz.step = n;
  cropCanvas.hidden = n !== 1;
  adjustCanvas.hidden = n !== 2;
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
  if (n === 2) drawAdjustPreview();
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
  if (wiz.step === 3) applyPreviewZoom();
});

/* ---------- undo ---------- */

function pushHistory(entry) {
  history.push(entry);
  if (history.length > 80) history.shift();
  $("#wiz-undo").disabled = false;
}

/** Remembers crop/rotation/adjustments before a change. */
const snapshot = () =>
  pushHistory({
    geometry: JSON.stringify({
      rect: wiz.rect,
      rotation: wiz.rotation,
      mirrored: wiz.mirrored,
      ratio: wiz.ratio,
      adjust: wiz.adjust,
    }),
  });

function undo() {
  const e = history.pop();
  if (!e) return;
  if (e.stroke) {
    wiz.strokes.pop();
    replayStrokes();
  } else if (e.strokesBefore) {
    wiz.strokes = e.strokesBefore;
    replayStrokes();
  } else {
    const s = JSON.parse(e.geometry);
    const turned = s.rotation !== wiz.rotation || s.mirrored !== wiz.mirrored;
    wiz.rotation = s.rotation;
    wiz.mirrored = s.mirrored;
    if (turned) buildPhoto();
    wiz.rect = s.rect;
    wiz.ratio = s.ratio;
    wiz.adjust = s.adjust;
    ADJUSTMENTS.forEach(([key]) => setSlider("adj-" + key, wiz.adjust[key]));
    highlightRatio();
  }
  photoChanged();
  if (wiz.step === 1) drawCrop();
  else drawAdjustPreview();
  $("#wiz-undo").disabled = !history.length;
}
$("#wiz-undo").onclick = undo;

/* ---------- photo (rotation, mirror, touch-up strokes) ---------- */

/** Draws the photo rotated/mirrored into wiz.base; photo = base + stroke overlay. */
function buildPhoto() {
  const im = wiz.image;
  const sideways = wiz.rotation % 2;
  const c = createCanvas(sideways ? im.height : im.width, sideways ? im.width : im.height);
  const x = c.getContext("2d");
  x.fillStyle = "#fff"; // transparent PNGs get a white background
  x.fillRect(0, 0, c.width, c.height);
  x.translate(c.width / 2, c.height / 2);
  x.rotate((wiz.rotation * Math.PI) / 2);
  if (wiz.mirrored) x.scale(-1, 1);
  x.drawImage(im, -im.width / 2, -im.height / 2);
  wiz.base = photo = c;
  wiz.overlay = null;
  if (wiz.strokes.length) replayStrokes();
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

$("#btn-rotate").onclick = () => {
  snapshot();
  wiz.rotation = (wiz.rotation + 1) % 4;
  resetOrientation();
  drawCrop();
};
$("#btn-mirror").onclick = () => {
  snapshot();
  wiz.mirrored = !wiz.mirrored;
  resetOrientation();
  drawCrop();
};

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

function highlightRatio() {
  $$("#ratio-chips .chip").forEach((b) => {
    const v = +b.dataset.ratio;
    const r = wiz.ratio;
    const on = v === 0 ? !r : v > 0 ? Math.abs(v - r) < 1e-6 : !!r && Math.abs(r - photo.width / photo.height) < 1e-6;
    b.classList.toggle("on", on);
  });
}

/** Largest rectangle of the chosen ratio, centered where the current one is. */
function fitRectToRatio() {
  const R = wiz.ratio;
  if (!R) return;
  const r = wiz.rect;
  let w;
  let h;
  if (photo.width / photo.height > R) {
    h = photo.height;
    w = h * R;
  } else {
    w = photo.width;
    h = w / R;
  }
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  wiz.rect = {
    w,
    h,
    x: Math.min(photo.width - w, Math.max(0, cx - w / 2)),
    y: Math.min(photo.height - h, Math.max(0, cy - h / 2)),
  };
}

const cropRatio = () => wiz.rect.w / wiz.rect.h;

/** Where the photo sits on screen: screen = offset + photoPixel * scale. */
function cropGeometry() {
  const w = cropCanvas.clientWidth;
  const h = cropCanvas.clientHeight;
  const scale = Math.min(w / photo.width, h / photo.height) * 0.94 * wiz.zoom;
  return {
    scale,
    ox: (w - photo.width * scale) / 2 + wiz.panX,
    oy: (h - photo.height * scale) / 2 + wiz.panY,
    w,
    h,
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
  x.drawImage(photo, g.ox, g.oy, PW, PH);
  const r = wiz.rect;
  const X = g.ox + r.x * g.scale;
  const Y = g.oy + r.y * g.scale;
  const RW = r.w * g.scale;
  const RH = r.h * g.scale;
  // darken outside the crop
  x.fillStyle = "rgba(0,0,0,.55)";
  x.fillRect(g.ox, g.oy, PW, Y - g.oy);
  x.fillRect(g.ox, Y + RH, PW, g.oy + PH - Y - RH);
  x.fillRect(g.ox, Y, X - g.ox, RH);
  x.fillRect(X + RW, Y, g.ox + PW - X - RW, RH);
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
  const right = corner[1] === "r";
  const bottom = corner[0] === "b";
  const anchorX = right ? r.x : r.x + r.w;
  const anchorY = bottom ? r.y : r.y + r.h;
  const px = Math.max(0, Math.min(photo.width, (right ? r.x + r.w : r.x) + dx));
  const py = Math.max(0, Math.min(photo.height, (bottom ? r.y + r.h : r.y) + dy));
  let w = Math.max(12, Math.abs(px - anchorX));
  let h = Math.max(12, Math.abs(py - anchorY));
  if (R) {
    const roomX = right ? photo.width - anchorX : anchorX;
    const roomY = bottom ? photo.height - anchorY : anchorY;
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
  if (cropPointers.size > 1) {
    // pinch resizes the crop around its center
    const [a, b] = [...cropPointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinchDist) {
      const s = Math.min(pinchDist / d, photo.width / r.w, photo.height / r.h);
      const w = r.w * s;
      const h = r.h * s;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      wiz.rect = {
        w,
        h,
        x: Math.max(0, Math.min(photo.width - w, cx - w / 2)),
        y: Math.max(0, Math.min(photo.height - h, cy - h / 2)),
      };
    }
    pinchDist = d;
  } else if (cropMode === "move") {
    wiz.rect.x = Math.max(0, Math.min(photo.width - r.w, r.x + (now[0] - old[0]) / k));
    wiz.rect.y = Math.max(0, Math.min(photo.height - r.h, r.y + (now[1] - old[1]) / k));
  } else if (cropMode) resizeCrop(cropMode, (now[0] - old[0]) / k, (now[1] - old[1]) / k);
  if (cropMode) photoChanged();
  drawCrop();
});

const cropPointerUp = (e) => {
  cropPointers.delete(e.pointerId);
  if (!cropPointers.size) {
    cropMode = null;
    cropSnapshotTaken = false;
  }
};
cropCanvas.addEventListener("pointerup", cropPointerUp);
cropCanvas.addEventListener("pointercancel", cropPointerUp);

/* ---------- touch-up editor (pan / brush / restore / eyedropper on the crop canvas) ----------
   Strokes are stored in original-photo coordinates so rotate/mirror/undo can replay them.
   photo = base (clean rotated photo) + overlay (strokes); "restore" strokes erase the overlay. */

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
  return [a + photo.width / 2, b + photo.height / 2];
}
function photoToSource(x, y) {
  const { width: w, height: h } = wiz.image;
  let [u, v] = turn(x - photo.width / 2, y - photo.height / 2, 4 - (wiz.rotation & 3));
  if (wiz.mirrored) u = -u;
  return [u + w / 2, v + h / 2];
}

function ensureOverlay() {
  if (wiz.overlay) return;
  const b = wiz.base;
  wiz.overlay = createCanvas(b.width, b.height);
  photo = createCanvas(b.width, b.height);
  photo.getContext("2d").drawImage(b, 0, 0);
}

/** Draws stroke s along points p (photo coordinates, flat [x, y, ...]) onto the overlay. */
function paintStroke(s, p) {
  const x = wiz.overlay.getContext("2d");
  x.save();
  x.globalCompositeOperation = s.restore ? "destination-out" : "source-over";
  x.fillStyle = x.strokeStyle = s.restore ? "#000" : s.color;
  x.lineWidth = s.radius * 2;
  x.lineCap = x.lineJoin = "round";
  x.beginPath();
  if (p.length < 4) {
    x.arc(p[0], p[1], s.radius, 0, 7);
    x.fill();
  } else {
    x.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) x.lineTo(p[i], p[i + 1]);
    x.stroke();
  }
  x.restore();
}

/** photo = base + overlay, inside the given rectangle only. */
function composite(x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(photo.width, Math.ceil(x1));
  y1 = Math.min(photo.height, Math.ceil(y1));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 1 || h < 1) return;
  const c = photo.getContext("2d");
  c.drawImage(wiz.base, x0, y0, w, h, x0, y0, w, h);
  c.drawImage(wiz.overlay, x0, y0, w, h, x0, y0, w, h);
}

function replayStrokes() {
  if (!wiz.strokes.length && !wiz.overlay) return;
  ensureOverlay();
  wiz.overlay.getContext("2d").clearRect(0, 0, wiz.overlay.width, wiz.overlay.height);
  for (const s of wiz.strokes) {
    const p = [];
    for (let i = 0; i < s.points.length; i += 2) p.push(...sourceToPhoto(s.points[i], s.points[i + 1]));
    paintStroke(s, p);
  }
  composite(0, 0, photo.width, photo.height);
}

function updateEditorUi() {
  $$("#editor-tools [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === wiz.tool));
  $("#editor-hint").textContent = t("h_" + wiz.tool);
}

/** Zoom the crop view by factor s around screen point (mx, my). */
function zoomCropView(s, mx, my) {
  const g = cropGeometry();
  const z = Math.max(1, Math.min(40, wiz.zoom * s));
  const k = g.scale * (z / wiz.zoom);
  const u = (mx - g.ox) / g.scale;
  const v = (my - g.oy) / g.scale;
  wiz.zoom = z;
  wiz.panX = mx - u * k - (g.w - photo.width * k) / 2;
  wiz.panY = my - v * k - (g.h - photo.height * k) / 2;
  if (z === 1) wiz.panX = wiz.panY = 0;
  drawCrop();
}

const pointerToPhoto = (e) => {
  const g = cropGeometry();
  return [(e.offsetX - g.ox) / g.scale, (e.offsetY - g.oy) / g.scale];
};

function pickColor(e) {
  const [x, y] = pointerToPhoto(e);
  if (x < 0 || y < 0 || x >= photo.width || y >= photo.height) return;
  const d = photo.getContext("2d").getImageData(x | 0, y | 0, 1, 1).data;
  $("#brush-color").value = "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
}

const editPointers = new Map();
let activeStroke = null;
let lastPoint = null;
let editPinch = 0;

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
        replayStrokes();
        photoChanged();
        drawCrop();
        $("#wiz-undo").disabled = !history.length;
      }
      activeStroke = null;
      editPinch = 0;
      return;
    }
    if (tool === "pick") {
      pickColor(e);
      wiz.tool = "brush";
      return updateEditorUi();
    }
    if (tool === "brush" || tool === "rest") {
      ensureOverlay();
      const radius = wiz.brushSize / 2 / cropGeometry().scale;
      const p = pointerToPhoto(e);
      const s = { restore: tool === "rest", color: $("#brush-color").value, radius, points: photoToSource(p[0], p[1]) };
      wiz.strokes.push(s);
      pushHistory({ stroke: true });
      activeStroke = s;
      lastPoint = p;
      paintStroke(s, p);
      composite(p[0] - radius - 2, p[1] - radius - 2, p[0] + radius + 2, p[1] + radius + 2);
      photoChanged();
      drawCrop();
    }
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
    if (editPointers.size > 1) {
      const [a, b] = [...editPointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (editPinch) zoomCropView(d / editPinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      editPinch = d;
      wiz.panX += (now[0] - old[0]) / 2;
      wiz.panY += (now[1] - old[1]) / 2;
      return drawCrop();
    }
    if (tool === "pan") {
      wiz.panX += now[0] - old[0];
      wiz.panY += now[1] - old[1];
      drawCrop();
    } else if (tool === "pick") pickColor(e);
    else if (activeStroke) {
      const q = pointerToPhoto(e);
      const a = lastPoint;
      const r = activeStroke.radius + 2;
      paintStroke(activeStroke, [a[0], a[1], q[0], q[1]]);
      composite(Math.min(a[0], q[0]) - r, Math.min(a[1], q[1]) - r, Math.max(a[0], q[0]) + r, Math.max(a[1], q[1]) + r);
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
  editPointers.delete(e.pointerId);
  if (!editPointers.size) {
    activeStroke = null;
    editPinch = 0;
  }
};
cropCanvas.addEventListener("pointerup", editPointerUp, true);
cropCanvas.addEventListener("pointercancel", editPointerUp, true);
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
  if (toolBtn) {
    wiz.tool = toolBtn.dataset.tool;
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
$("#panel-crop").addEventListener("input", (e) => {
  if (e.target.id !== "brush-size") return;
  e.target.previousElementSibling.textContent = e.target.value;
  wiz.brushSize = +e.target.value;
});
$("#btn-edit-reset").onclick = () => {
  if (!wiz.strokes.length) return;
  pushHistory({ strokesBefore: wiz.strokes });
  wiz.strokes = [];
  replayStrokes();
  photoChanged();
  drawCrop();
};

/* ---------- step 2: adjustments ---------- */

/** Cropped photo pixels (at most 12 MP), cached until the photo or crop changes. */
function sourcePixels() {
  const R = wiz.rect;
  const key = [wiz.editVersion, R.x, R.y, R.w, R.h].join();
  if (wiz.source && wiz.source.key === key) return wiz.source;
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

function drawAdjustPreview() {
  const R = wiz.rect;
  const L = 640;
  const w = R.w >= R.h ? L : Math.round((L * R.w) / R.h);
  const h = R.w >= R.h ? Math.round((L * R.h) / R.w) : L;
  const rgba = boxScale(sourcePixels(), w, h);
  applyAdjustments(rgba, w, h, wiz.adjust);
  adjustCanvas.width = w;
  adjustCanvas.height = h;
  adjustCanvas.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
}

let adjustFrame = 0;
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
  cancelAnimationFrame(adjustFrame);
  adjustFrame = requestAnimationFrame(drawAdjustPreview);
});

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
  Object.assign(wiz.adjust, { blk: Math.min(40, Math.round(lo / 2.55)), wht: Math.max(200, hi), con: 108, sat: 112 });
  ADJUSTMENTS.forEach(([key]) => setSlider("adj-" + key, wiz.adjust[key]));
  wiz.result = null;
  drawAdjustPreview();
};

/* ---------- step 3: pixelize ---------- */

function renderStyleList() {
  const list = $("#style-list");
  if (!list.firstChild)
    list.innerHTML = STYLE_GROUPS.map(
      ([group, ids]) =>
        `<div class="style-group" data-i="${group}">${t(group)}</div>` +
        ids
          .map(
            (id) =>
              `<button class="style-row" data-style="${id}"><b data-i="${id}">${t(id)}</b><span data-i="d_${id}">${t("d_" + id)}</span></button>`,
          )
          .join(""),
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
    specks: +$("#specks").value,
    denoise: +$("#denoise").value,
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
  $("#pixel-count-value").textContent = n.toLocaleString() + " px";
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
  $("#pixel-count-value").textContent = (W * H).toLocaleString() + " px";
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
  let strip = "";
  for (let k = 0; k < K; k++) {
    let r = pal[k * 3];
    let g = pal[k * 3 + 1];
    let b = pal[k * 3 + 2];
    if (wiz.gray) r = g = b = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
    colors.push(0xff000000 | (b << 16) | (g << 8) | r);
    strip += `<span style="background:rgb(${r},${g},${b});color:${0.3 * r + 0.59 * g + 0.11 * b > 140 ? "#000" : "#fff"}">${k + 1}</span>`;
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
}

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
    wiz = {};
    history = [];
    photo = null;
    const canvas = {
      id: String(Date.now()),
      folderId: library.folderId,
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
