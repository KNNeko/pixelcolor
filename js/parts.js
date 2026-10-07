// Parts: a big canvas can be cut into rectangles ("parts") that are colored one at a time.
// canvas.partOf[i] is the part id of cell i (0 = not in any part); canvas.parts lists {id, name}.
import { $, icon, toast, openSheet, closeSheet, showScreen } from "./ui.js";
import { t } from "./i18n.js";
import {
  game,
  rawCellAt,
  requestDraw,
  redrawAll,
  renderPalette,
  recountProgress,
  updateStatus,
  updateLayout,
  fitView,
  fitToBox,
  markCanvasChanged,
} from "./game.js";

const SNAP_STEPS = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256];
const split = {
  drag: null, // { a: [x, y], b: [x, y] } rectangle being drawn, in cells
  snap: 16,
  history: [], // list of part-id lists, for undo
};

/* ---------- chips above the picture ---------- */

export function renderPartChips() {
  const el = $("#part-chips");
  const canvas = game.canvas;
  if (!canvas.parts.length || game.splitting) {
    el.innerHTML = "";
    return;
  }
  const ids = canvas.parts.map((p) => p.id);
  if (game.partCells[0] > 0) ids.unshift(0); // cells left outside any part
  const percent = (id) => (game.partCells[id] ? Math.floor((game.partCorrectCells[id] / game.partCells[id]) * 100) : 0);
  el.innerHTML =
    `<button class="chip ${game.part < 0 ? "on" : ""}" data-part="-1">${t("whole")}</button>` +
    ids
      .map((id) => {
        const name = id ? canvas.parts.find((p) => p.id === id).name : t("rest");
        return `<button class="chip ${game.part === id ? "on" : ""}" data-part="${id}">${name} ${percent(id)}%</button>`;
      })
      .join("");
}

$("#part-chips").onclick = (e) => {
  const b = e.target.closest("[data-part]");
  if (b) selectPart(+b.dataset.part);
};

/** Switches to working on one part (-1 = whole picture). */
export function selectPart(part) {
  const { width: W, height: H, target, partOf } = game.canvas;
  const K = game.canvas.palette.length / 3;
  game.part = part;
  game.partColorCount = new Array(K).fill(0);
  game.partRemaining = new Array(K).fill(0);
  game.partCorrect = 0;
  game.partTotal = 0;
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = 0;
  let y1 = 0;
  if (part >= 0)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (partOf[i] !== part) continue;
        const k = target[i];
        game.partColorCount[k]++;
        game.partTotal++;
        if (game.paint[i] === k + 1) game.partCorrect++;
        else game.partRemaining[k]++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (game.selected && part >= 0 && !game.partColorCount[game.selected - 1]) game.selected = 0;
  renderPalette();
  redrawAll();
  renderPartChips();
  updateStatus();
  if (part >= 0) fitToBox(x0, y0, x1, y1);
  else fitView();
}

/* ---------- split mode ---------- */

function defaultSnap() {
  const longest = Math.max(game.canvas.width, game.canvas.height);
  let s = 1;
  while (s * 20 < longest && s < 256) s *= 2;
  return s;
}

function renderSplitBar() {
  $("#split-bar").innerHTML =
    `<button class="chip" data-act="undo">${icon("undo")}</button>` +
    `<button class="chip" data-act="grid">${t("gridb")}</button>` +
    `<button class="chip" data-act="snap">${t("snapl")}: ${split.snap || t("off")}</button>` +
    `<button class="chip primary" data-act="done">${t("done")}</button>`;
  $('#split-bar [data-act="undo"]').disabled = !split.history.length;
}

$("#split-bar").onclick = (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "done") stopSplitMode();
  else if (act === "undo") undoSplit();
  else if (act === "grid") openGridDialog();
  else if (act === "snap") {
    split.snap = SNAP_STEPS[(SNAP_STEPS.indexOf(split.snap) + 1) % SNAP_STEPS.length];
    renderSplitBar();
    requestDraw();
  }
};

export function startSplitMode() {
  game.splitting = true;
  split.drag = null;
  game.part = -1;
  split.history = [];
  split.snap = defaultSnap();
  renderPalette();
  showScreen("screen-play");
  renderSplitBar();
  updateLayout();
  $("#part-chips").innerHTML = "";
  redrawAll();
}

export function stopSplitMode() {
  game.splitting = false;
  split.drag = null;
  updateLayout();
  redrawAll();
  recountProgress();
  renderPartChips();
  updateStatus();
}

/** Cell rectangle [x0, y0, x1, y1] between two corners, clamped and snapped to the grid. */
function snappedRect(a, b) {
  const { width: W, height: H } = game.canvas;
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  const s = split.snap;
  let x0 = clamp(Math.min(a[0], b[0]), W - 1);
  let x1 = clamp(Math.max(a[0], b[0]), W - 1);
  let y0 = clamp(Math.min(a[1], b[1]), H - 1);
  let y1 = clamp(Math.max(a[1], b[1]), H - 1);
  if (s > 0) {
    x0 = Math.floor(x0 / s) * s;
    y0 = Math.floor(y0 / s) * s;
    x1 = Math.min(W - 1, Math.floor(x1 / s) * s + s - 1);
    y1 = Math.min(H - 1, Math.floor(y1 / s) * s + s - 1);
  }
  return [x0, y0, x1, y1];
}

/** Turns the free cells inside a rectangle into a new part. Returns its id, or 0. */
function createPart(x0, y0, x1, y1) {
  const canvas = game.canvas;
  const id = canvas.parts.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  if (id > 250) {
    toast(t("maxparts"));
    return 0;
  }
  let claimed = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * canvas.width + x;
      if (!canvas.partOf[i]) {
        canvas.partOf[i] = id;
        claimed++;
      }
    }
  if (!claimed) return 0;
  canvas.parts.push({ id, name: t("part") + " " + id });
  markCanvasChanged();
  return id;
}

function undoSplit() {
  const ids = split.history.pop();
  if (!ids) return;
  const remove = new Uint8Array(256);
  ids.forEach((k) => (remove[k] = 1));
  const canvas = game.canvas;
  for (let i = 0; i < canvas.partOf.length; i++) if (remove[canvas.partOf[i]]) canvas.partOf[i] = 0;
  canvas.parts = canvas.parts.filter((p) => !remove[p.id]);
  markCanvasChanged();
  redrawAll();
  renderSplitBar();
}

function openGridDialog() {
  const sheet = openSheet(
    `<label class="field"><span>${t("rows")}</span><input id="grid-rows" type="number" value="2" min="1" max="15"></label>` +
      `<label class="field"><span>${t("cl")}</span><input id="grid-cols" type="number" value="2" min="1" max="15"></label>` +
      `<button class="chip primary" data-ok>${t("done")}</button>`,
  );
  sheet.querySelector("[data-ok]").onclick = () => {
    const { width: W, height: H } = game.canvas;
    const rows = Math.max(1, +sheet.querySelector("#grid-rows").value | 0);
    const cols = Math.max(1, +sheet.querySelector("#grid-cols").value | 0);
    const ids = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const id = createPart(
          Math.floor((c * W) / cols),
          Math.floor((r * H) / rows),
          Math.floor(((c + 1) * W) / cols) - 1,
          Math.floor(((r + 1) * H) / rows) - 1,
        );
        if (id) ids.push(id);
      }
    if (ids.length) split.history.push(ids);
    closeSheet();
    redrawAll();
    renderSplitBar();
  };
}

/* ---------- pointer handling while splitting (called from game.js) ---------- */

/** e = null cancels the rectangle (a second finger arrived). */
export function splitPointerDown(e) {
  if (!e) {
    split.drag = null;
    return;
  }
  const c = rawCellAt(e);
  split.drag = { a: c, b: c };
  requestDraw();
}
export function splitPointerMove(e) {
  if (!split.drag) return false;
  split.drag.b = rawCellAt(e);
  requestDraw();
  return true;
}
export function splitPointerUp() {
  const drag = split.drag;
  if (!drag) return false;
  split.drag = null;
  const r = snappedRect(drag.a, drag.b);
  const id = createPart(...r);
  if (id) {
    split.history.push([id]);
    redrawAll();
  }
  renderSplitBar();
  requestDraw();
  return true;
}

/** Snap grid and the rectangle being drawn. */
export function drawSplitOverlay(ctx) {
  const { x: vx, y: vy, scale } = game.view;
  const { width: sw, height: sh } = game.screen;
  const { width: W, height: H } = game.canvas;
  const s = split.snap;
  if (s > 0 && s * scale >= 8) {
    ctx.strokeStyle = "rgba(255,45,85,.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += s) {
      const X = vx + x * scale;
      if (X < 0 || X > sw) continue;
      ctx.moveTo(X, Math.max(0, vy));
      ctx.lineTo(X, Math.min(sh, vy + H * scale));
    }
    for (let y = 0; y <= H; y += s) {
      const Y = vy + y * scale;
      if (Y < 0 || Y > sh) continue;
      ctx.moveTo(Math.max(0, vx), Y);
      ctx.lineTo(Math.min(sw, vx + W * scale), Y);
    }
    ctx.stroke();
  }
  if (split.drag) {
    const r = snappedRect(split.drag.a, split.drag.b);
    const X = vx + r[0] * scale;
    const Y = vy + r[1] * scale;
    const w = (r[2] - r[0] + 1) * scale;
    const h = (r[3] - r[1] + 1) * scale;
    ctx.fillStyle = "rgba(255,45,85,.22)";
    ctx.fillRect(X, Y, w, h);
    ctx.strokeStyle = "#ff2d55";
    ctx.lineWidth = 2;
    ctx.strokeRect(X, Y, w, h);
  }
}

/* ---------- merge dialog ---------- */

export function openPartsDialog() {
  recountProgress();
  const canvas = game.canvas;
  if (!canvas.parts.length) return toast(t("parts") + ": 0");
  const ids = canvas.parts.map((p) => p.id);
  if (game.partCells[0] > 0) ids.unshift(0);
  const percent = (id) => (game.partCells[id] ? Math.floor((game.partCorrectCells[id] / game.partCells[id]) * 100) : 0);
  const sheet = openSheet(
    `<b>${t("parts")}</b>` +
      ids
        .map(
          (id) =>
            `<label class="check-row"><input type="checkbox" data-id="${id}"><span>${id ? canvas.parts.find((p) => p.id === id).name : t("rest")}</span><b>${percent(id)}%</b></label>`,
        )
        .join("") +
      `<div class="chips"><button class="chip primary" data-merge>${t("mergeS")}</button><button class="chip" data-merge-all>${t("mergeA")}</button></div>`,
  );
  const finish = () => {
    markCanvasChanged();
    closeSheet();
    recountProgress();
    selectPart(-1);
  };
  sheet.querySelector("[data-merge]").onclick = () => {
    const chosen = [...sheet.querySelectorAll("input:checked")].map((i) => +i.dataset.id);
    if (chosen.length < 2) return;
    const into = Math.min(...chosen);
    const remap = new Uint8Array(256);
    for (let k = 0; k < 256; k++) remap[k] = k;
    chosen.forEach((k) => (remap[k] = into));
    for (let i = 0; i < canvas.partOf.length; i++) canvas.partOf[i] = remap[canvas.partOf[i]];
    canvas.parts = canvas.parts.filter((p) => p.id === into || !chosen.includes(p.id));
    finish();
  };
  sheet.querySelector("[data-merge-all]").onclick = () => {
    canvas.partOf.fill(0);
    canvas.parts = [];
    finish();
  };
}
