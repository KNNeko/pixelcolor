// Small DOM helpers shared by every screen: lookups, icons, toasts, bottom sheets, dialogs, sliders.
import { settings } from "./settings.js";
import { t } from "./i18n.js";

export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => [...document.querySelectorAll(selector)];

export function createCanvas(width, height) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

/** Let the browser repaint / handle input before continuing a long job. */
export const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve));

export function vibrate(pattern) {
  if (settings.vib && navigator.vibrate) navigator.vibrate(pattern);
}

/* ---------- icons ---------- */

const ICON_PATHS = {
  back: "M19 12H5M12 19l-7-7 7-7",
  next: "M5 12h14M12 5l7 7-7 7",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  eraser:
    "M7 21l-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21zM22 21H7M5 11l9 9",
  chev: "M6 9l6 6 6-6",
  bucket:
    "m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11ZM5 2l5 5M2 13h15M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z",
  wand: "m21.6 3.6-1.3-1.3a1.2 1.2 0 0 0-1.7 0L2.4 18.6a1.2 1.2 0 0 0 0 1.7l1.3 1.3a1.2 1.2 0 0 0 1.7 0L21.6 5.4a1.2 1.2 0 0 0 0-1.8ZM14 7l3 3M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9",
  bulb: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  move: "M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  plus: "M12 5v14M5 12h14",
  set: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  check: "M20 6 9 17l-5-5",
  rot: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  flip: "M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3M12 20v2M12 14v2M12 8v2M12 2v2",
  flipv:
    "M3 8V5a2 2 0 0 1 2-2h14c1.1 0 2 .9 2 2v3M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M20 12h2M14 12h2M8 12h2M2 12h2",
  crop: "M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2",
  shapes: "M3 3h9v9H3zM16.5 12a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z",
  swap: "M7 3v18M3 7l4-4 4 4M17 21V3M13 17l4 4 4-4",
  drop: "M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 5.5 12 3c-.5 2.5-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7z",
  stamp:
    "M5 22h14M5 18h14v-2.5a2.5 2.5 0 0 0-2.5-2.5h-9A2.5 2.5 0 0 0 5 15.5zM14 13V9.5C14 8 15 7 15 5a3 3 0 0 0-6 0c0 2 1 3 1 4.5V13",
  pipette:
    "M2 22l1-1h3l9-9M3 21v-3l9-9M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3z",
  minus: "M5 12h14",
  sh_rect: "M4 6h16v12H4z",
  sh_oval: "M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z",
  sh_line: "M5 19 19 5",
  sh_tri: "M12 4l9 16H3z",
  sh_diamond: "M12 3l9 9-9 9-9-9z",
  sh_hex: "M7 4h10l5 8-5 8H7l-5-8z",
  sh_star: "M12 3l2.7 5.6 6.1.8-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1-4.4-4.3 6.1-.8z",
  sh_heart: "M12 20s-8-4.6-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.4 12 20 12 20z",
  sh_arrow: "M3 9h10V5l8 7-8 7v-4H3z",
  close: "M18 6 6 18M6 6l12 12",
  cut: "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12",
  fit: "M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3",
  film: "M3 3h18v18H3zM7 3v18M17 3v18M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4",
  split: "M3 3h18v18H3zM12 3v18M3 12h18",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  play: "M5 3l14 9-14 9z",
  reset: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
  panel: "M3 3h18v18H3zM3 15h18",
  sort: "M4 6h16M7 12h10M10 18h4",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  folderPlus: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5",
  image: "M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 15l-5-5L5 21",
};

export const icon = (name) => `<svg class="icon" viewBox="0 0 24 24"><path d="${ICON_PATHS[name]}"/></svg>`;

/** Pixel-art paw shown on finished canvases: a 32x32 bitmap packed as hex, turned into one SVG path. */
const PAW_HEX =
  "000000000000000000000000000000000000000000381c00007c3e00007c3e00007e7e00007e7e00067c3e600f7c3ef01fb81df81f8001f81f8001f80f0000f00f0ff0f0001ff800003ffc00007ffe00007ffe0000ffff0000ffff00007ffe00007ffe00003ffc00001ff800000e700000000000000000000000000000000000";
export const PAW_SVG = (() => {
  const bit = (i) => (parseInt(PAW_HEX[i >> 2], 16) >> (3 - (i & 3))) & 1;
  let path = "";
  for (let y = 0; y < 32; y++) {
    let x = 0;
    while (x < 32) {
      if (!bit(y * 32 + x)) {
        x++;
        continue;
      }
      let end = x;
      while (end < 32 && bit(y * 32 + end)) end++;
      path += `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  }
  return `<svg viewBox="0 0 32 32" shape-rendering="crispEdges" fill="currentColor"><path d="${path}"/></svg>`;
})();

/* ---------- screens, toast, busy overlay ---------- */

export function showScreen(id) {
  $$("section.screen").forEach((s) => s.classList.toggle("on", s.id === id));
}

let toastTimer = 0;
export function toast(text, ms = 1400) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

export function setBusy(on, text) {
  $("#busy").hidden = !on;
  $("#busy-text").textContent = text || t("busy");
}
export const setBusyText = (text) => ($("#busy-text").textContent = text);

/* ---------- bottom sheet + dialogs ---------- */

/** Opens a bottom sheet with the given HTML and returns the sheet element. Tap outside closes it. */
export function openSheet(html) {
  const overlay = $("#modal");
  overlay.innerHTML = `<div class="sheet">${html}</div>`;
  overlay.hidden = false;
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.hidden = true;
  };
  overlay.querySelectorAll(".range").forEach(initRangeSlider);
  return overlay.firstChild;
}
export const closeSheet = () => ($("#modal").hidden = true);

/** Big icon+label button used in action grids. */
export const actionButton = (iconName, labelKey, id, extraClass = "") =>
  `<button class="action ${extraClass}" id="${id}">${icon(iconName)}<span>${t(labelKey)}</span></button>`;

export function confirmDialog(message, onOk) {
  const sheet = openSheet(
    `<b></b><div class="chips"><button class="chip primary" data-ok>${t("ok")}</button><button class="chip" data-cancel>${t("cancel")}</button></div>`,
  );
  sheet.querySelector("b").textContent = message;
  sheet.querySelector("[data-ok]").onclick = () => {
    closeSheet();
    onOk();
  };
  sheet.querySelector("[data-cancel]").onclick = closeSheet;
}

export function promptText(message, initial, onOk) {
  const sheet = openSheet(
    `<b></b><input type="text"><div class="chips"><button class="chip primary" data-ok>${t("ok")}</button><button class="chip" data-cancel>${t("cancel")}</button></div>`,
  );
  sheet.querySelector("b").textContent = message;
  const input = sheet.querySelector("input");
  input.value = initial;
  sheet.querySelector("[data-ok]").onclick = () => {
    closeSheet();
    if (input.value.trim()) onOk(input.value.trim());
  };
  sheet.querySelector("[data-cancel]").onclick = closeSheet;
}

export function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/* ---------- custom range slider ----------
   <div class="range" data-min data-max data-v data-step> becomes a touch-friendly slider.
   It exposes .value and fires "input" and "change" like a real <input type=range>. */

export function initRangeSlider(el) {
  if (el._ready) return;
  el._ready = true;
  el.type = "range";
  const min = +el.dataset.min;
  const max = +el.dataset.max;
  const step = +el.dataset.step || 1;
  el.innerHTML = '<i class="range-track"></i><i class="range-fill"></i><i class="range-thumb"></i>';
  const thumb = el.querySelector(".range-thumb");
  const fill = el.querySelector(".range-fill");
  let value = +el.dataset.v;
  let dragging = false;

  const paint = () => {
    const f = (value - min) / (max - min);
    fill.style.width = `calc((100% - 28px) * ${f})`;
    thumb.style.left = `calc(14px + (100% - 28px) * ${f})`;
  };
  Object.defineProperty(el, "value", {
    get: () => value,
    set: (v) => {
      value = Math.max(min, Math.min(max, +v));
      paint();
    },
  });
  paint();

  let startValue = value;
  thumb.addEventListener("pointerdown", (e) => {
    thumb.setPointerCapture(e.pointerId);
    dragging = true;
    startValue = value;
    e.preventDefault();
  });
  thumb.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left - 14) / (r.width - 28)));
    const v = +(Math.round((min + f * (max - min)) / step) * step).toFixed(4);
    if (v !== value) {
      value = v;
      paint();
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  // "change" when the finger lifts, like a real range input
  const stop = () => {
    if (dragging && value !== startValue) el.dispatchEvent(new Event("change", { bubbles: true }));
    dragging = false;
  };
  thumb.addEventListener("pointerup", stop);
  thumb.addEventListener("pointercancel", stop);
}

/** Slider with a label and live value, as an HTML string. */
export const sliderHtml = (id, labelKey, min, max, value, step = 1) =>
  `<div class="field"><span data-i="${labelKey}"></span><b>${value}</b><div class="range" id="${id}" data-min="${min}" data-max="${max}" data-v="${value}" data-step="${step}"></div></div>`;

/** Sets a slider created by sliderHtml and its visible number. */
export function setSlider(id, value) {
  const el = $("#" + id);
  el.value = value;
  el.previousElementSibling.textContent = el.value;
}

/** Fills every [data-i] element with its translation and every [data-ic] element with its icon. */
export function translatePage() {
  document.documentElement.lang = settings.lang;
  $$("[data-i]").forEach((e) => (e.textContent = t(e.dataset.i)));
  $$("[data-ic]").forEach((e) => (e.innerHTML = icon(e.dataset.ic)));
}

/* ---------- fullscreen ---------- */

/** Installed with "display": "fullscreen": the system already keeps the app fullscreen by itself. */
const systemFullscreen = () => matchMedia("(display-mode: fullscreen)").matches;

let fullscreenTried = false;
export function syncFullscreen(force) {
  const root = document.documentElement;
  if (!root.requestFullscreen || systemFullscreen()) return;
  if (settings.full) {
    if (!document.fullscreenElement && (force || !fullscreenTried)) {
      fullscreenTried = true;
      try {
        root.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
      } catch {
        /* not allowed right now */
      }
    }
  } else if (document.fullscreenElement) document.exitFullscreen();
}

// Switching to another app (or the recent-apps list) drops fullscreen, and a page may only ask for it again
// from inside a touch. So when the app comes back without fullscreen, the next touch restores it.
function restoreFullscreenOnTouch() {
  if (document.hidden || !settings.full || document.fullscreenElement || systemFullscreen()) return;
  addEventListener("pointerup", () => syncFullscreen(true), { once: true, capture: true });
}
addEventListener("visibilitychange", restoreFullscreenOnTouch);
addEventListener("pageshow", restoreFullscreenOnTouch);
