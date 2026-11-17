// Color picker used everywhere a color is chosen (settings, the coloring screen menu, the photo editor).
// Replaces the browser's <input type="color">, which on Android is a few fixed boxes and RGB sliders.
//
//   saturation/brightness square + hue bar (HSV), a HEX field, recently picked colors, and optional extra
//   rows (for example the main colors of the photo being edited) and an eyedropper button.
//
// The pure conversion functions are exported for tests.

import { t } from "./i18n.js";
import { settings, saveSettings } from "./settings.js";

const RECENT_MAX = 14;

/* ---------- conversions ---------- */

/** "#rrggbb" (or "rrggbb", "#rgb") -> [r, g, b], or null if it is not a color. */
export function hexToRgb(text) {
  let s = String(text).trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) s = [...s].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  const n = parseInt(s, 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (r, g, b) =>
  "#" +
  [r, g, b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

/** [r, g, b] 0..255 -> [hue 0..360, saturation 0..1, value 0..1]. */
export function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

/** [hue 0..360, saturation 0..1, value 0..1] -> [r, g, b] 0..255 (rounded). */
export function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

/** Puts a color at the front of the "recent" list (stored in the settings). */
export function rememberColor(hex) {
  const list = Array.isArray(settings.rc) ? settings.rc : [];
  settings.rc = [hex, ...list.filter((c) => c !== hex)].slice(0, RECENT_MAX);
  saveSettings();
}

/* ---------- the sheet ---------- */

let overlay = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.id = "picker";
  overlay.hidden = true;
  document.body.append(overlay);
  return overlay;
}

const swatchRow = (label, colors) =>
  colors.length
    ? `<span class="picker-label">${label}</span><div class="picker-swatches">${colors
        .map((c) => `<button data-color="${c}" style="background:${c}" aria-label="${c}"></button>`)
        .join("")}</div>`
    : "";

/**
 * Opens the picker.
 *   value         starting color "#rrggbb"
 *   title         heading (optional)
 *   rows          extra swatch rows: [{ label, colors: ["#rrggbb", ...] }]
 *   onEyedropper  if given, an "Eyedropper" button closes the picker and calls it
 *   onDone(hex)   called with the chosen color when "Done" is pressed
 */
export function openColorPicker({ value = "#ffffff", title = "", rows = [], onEyedropper = null, onDone }) {
  const el = ensureOverlay();
  const start = hexToRgb(value) || [255, 255, 255];
  let [h, s, v] = rgbToHsv(...start);
  const recent = (Array.isArray(settings.rc) ? settings.rc : []).filter((c) => hexToRgb(c));
  el.innerHTML =
    `<div class="sheet picker">` +
    `<div class="picker-head"><b>${title || t("cp_title")}</b><span class="picker-preview"><i data-old></i><i data-new></i></span></div>` +
    `<div class="picker-sv"><i class="picker-thumb"></i></div>` +
    `<div class="picker-hue"><i class="picker-thumb"></i></div>` +
    `<input type="text" class="picker-hex" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off">` +
    rows.map((r) => swatchRow(r.label, r.colors)).join("") +
    swatchRow(t("cp_recent"), recent) +
    `<div class="chips">` +
    (onEyedropper ? `<button class="chip" data-eye>${t("e_pick")}</button>` : "") +
    `<button class="chip" data-cancel>${t("cancel")}</button><button class="chip primary" data-done>${t("done")}</button>` +
    `</div></div>`;
  el.hidden = false;

  const sheet = el.firstChild;
  const sv = sheet.querySelector(".picker-sv");
  const hue = sheet.querySelector(".picker-hue");
  const svThumb = sv.firstChild;
  const hueThumb = hue.firstChild;
  const hexField = sheet.querySelector(".picker-hex");
  sheet.querySelector("[data-old]").style.background = rgbToHex(...start);

  const current = () => rgbToHex(...hsvToRgb(h, s, v));
  /** Redraws everything from h, s, v; the HEX field only if it is not being typed in. */
  function render(updateField = true) {
    const hex = current();
    sv.style.backgroundColor = `hsl(${h} 100% 50%)`;
    svThumb.style.left = s * 100 + "%";
    svThumb.style.top = (1 - v) * 100 + "%";
    svThumb.style.background = hex;
    hueThumb.style.left = (h / 360) * 100 + "%";
    hueThumb.style.background = `hsl(${h} 100% 50%)`;
    sheet.querySelector("[data-new]").style.background = hex;
    if (updateField) hexField.value = hex;
  }
  render();

  /** Pointer dragging on an element: fn(x, y) gets the position as 0..1 of its width and height. */
  const drag = (target, fn) => {
    const move = (e) => {
      const r = target.getBoundingClientRect();
      fn(
        Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
      );
      render();
    };
    target.addEventListener("pointerdown", (e) => {
      target.setPointerCapture(e.pointerId);
      target.dragging = true;
      move(e);
    });
    target.addEventListener("pointermove", (e) => target.dragging && move(e));
    const up = () => (target.dragging = false);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  drag(sv, (x, y) => {
    s = x;
    v = 1 - y;
  });
  drag(hue, (x) => (h = Math.min(359.9, x * 360)));

  const setColor = (rgb, updateField = true) => {
    const [nh, ns, nv] = rgbToHsv(...rgb);
    // gray has no hue of its own: keep the current one so the square does not jump to red
    if (ns > 0 && nv > 0) h = nh;
    s = ns;
    v = nv;
    render(updateField);
  };
  hexField.addEventListener("input", () => {
    const rgb = hexToRgb(hexField.value);
    if (rgb) setColor(rgb, false);
  });
  hexField.addEventListener("blur", () => render());
  sheet.querySelectorAll("[data-color]").forEach((b) => (b.onclick = () => setColor(hexToRgb(b.dataset.color))));

  const close = () => (el.hidden = true);
  el.onclick = (e) => e.target === el && close();
  sheet.querySelector("[data-cancel]").onclick = close;
  sheet.querySelector("[data-done]").onclick = () => {
    const hex = current();
    rememberColor(hex);
    close();
    onDone(hex);
  };
  const eye = sheet.querySelector("[data-eye]");
  if (eye)
    eye.onclick = () => {
      close();
      onEyedropper();
    };
}

/** A small square button showing a color (open the picker from its onclick). */
export const colorButtonHtml = (id, hex, extra = "") =>
  `<button class="color-btn" id="${id}" style="background:${hex}" ${extra} aria-label="${hex}"></button>`;
