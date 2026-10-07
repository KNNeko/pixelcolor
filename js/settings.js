// User settings (persisted in localStorage) and theme colors.

const STORAGE_KEY = "pxs";

export const DEFAULTS = {
  lang: /^ru/.test(navigator.language) ? "ru" : "en",
  ap: "sys", // app theme: sys | light | dark
  ct: "cw", // canvas theme
  cc: "#cfe3ff", // custom canvas color
  hide: 0, // hide finished colors in the palette
  slide: 1, // paint by sliding a finger
  two: 1, // pan with two fingers while zooming
  hl: 1, // highlight cells of the selected number
  dbl: 1, // double-tap a cell to pick its color
  mini: 1, // minimap
  vib: 1, // vibration
  wrong: 0, // allow painting wrong numbers
  grid: 1, // grid lines
  asv: 2, // autosave interval, minutes
  full: 1, // fullscreen
  sil: 1, // silhouette (tinted unpainted cells)
  oth: 1, // show other parts while working on one part
  ps: "num", // palette sort: num | col | cnt
  sit: "sg", // silhouette tint
  sic: "#8a6fd6", // custom silhouette tint
  so: "rec", // library sort
};

export const settings = { ...DEFAULTS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
} catch {
  /* corrupted settings: keep defaults */
}

export function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Perceived brightness of "#rrggbb", 0..255. */
export function hexLuma(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.3 * (n >> 16) + 0.59 * ((n >> 8) & 255) + 0.11 * (n & 255);
}

/** "#rrggbb" -> 32-bit pixel value as stored in a Uint32Array over ImageData (little-endian ABGR). */
export function hexToPixel(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0xff000000 | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | (n >> 16);
}

export function applyAppTheme() {
  const dark = settings.ap === "dark" || (settings.ap === "sys" && matchMedia("(prefers-color-scheme:dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector("meta[name=theme-color]").content = dark ? "#13142a" : "#f3f1ff";
}

const SOLID_THEMES = { cw: ["#ffffff", 0], clg: ["#e6e8ee", 0], cd: ["#171923", 1], cb: ["#000000", 1] };
const GRADIENT_THEMES = {
  gl1: ["#f7f3ff", "#d6e6fb", 0],
  gl2: ["#fff4ee", "#f8d9ea", 0],
  gd1: ["#262a58", "#0b0c20", 1],
  gd2: ["#14414d", "#090d28", 1],
};

/** Colors used to draw the coloring canvas for the current canvas theme. */
export function canvasTheme() {
  let bg;
  let gradient = null;
  let dark;
  if (GRADIENT_THEMES[settings.ct]) {
    const g = GRADIENT_THEMES[settings.ct];
    gradient = [g[0], g[1]];
    bg = g[0];
    dark = g[2];
  } else if (settings.ct === "cus") {
    bg = settings.cc;
    dark = hexLuma(bg) < 110 ? 1 : 0;
  } else {
    [bg, dark] = SOLID_THEMES[settings.ct] || SOLID_THEMES.cw;
  }
  return dark
    ? { bg, gradient, dark, cell: "#222636", number: "#d2d6ea", grid: "rgba(255,255,255,.16)", highlight: "#59607a" }
    : { bg, gradient, dark, cell: "#ffffff", number: "#2b2b3a", grid: "rgba(0,0,0,.22)", highlight: "#a4a8b6" };
}
