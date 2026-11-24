// User settings (persisted in localStorage) and theme colors.

const STORAGE_KEY = "pxs";

export const DEFAULTS = {
  lang: /^ru/.test(navigator.language) ? "ru" : "en",
  ap: "sys", // app theme: sys | light | dark
  ct: "cw", // canvas theme
  ccl: "#cfe3ff", // background of the custom light canvas theme
  ccd: "#1f2430", // background of the custom dark canvas theme
  rc: [], // recently picked colors (color picker)
  hide: 0, // hide finished colors in the palette
  slide: 1, // paint by sliding a finger
  two: 1, // pan with two fingers while zooming
  hl: 1, // highlight cells of the selected number
  dbl: 1, // double-tap a cell to pick its color
  bonly: 1, // a color is chosen only while the brush is out (other tools: no color, no highlight)
  mini: 1, // minimap
  vib: 1, // vibration
  wrong: 0, // allow painting wrong numbers
  aim: 2, // brush aim assist: 0 off, 1 light, 2 medium, 3 strong
  grid: 1, // grid lines
  asv: 2, // autosave interval, minutes
  full: 1, // fullscreen
  hall: 0, // the panel button hides the whole interface (top buttons, minimap, itself), not only the bottom panel
  hallTips: 0, // times the "how to bring it back" hint was shown
  gl: 1, // draw the coloring screen with WebGL (fast); off = old 2D drawing
  sil: 1, // silhouette (tinted unpainted cells)
  oth: 1, // show other parts while working on one part
  ps: "num", // palette sort: num | col | cnt
  sit: "sg", // silhouette tint
  sic: "#8a6fd6", // custom silhouette tint
  so: "rec", // library sort
  pm: "art", // pixelization mode used last (art | photo | dither)
  pcl: 3, // pixelization "cleanliness" used last, 0..10
  pbl: 1, // transition dithering of the art mode used last, 0..3
  tot: null, // lifetime painting statistics (stats.js); null until first counted
};

export const settings = { ...DEFAULTS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
} catch {
  /* corrupted settings: keep defaults */
}
upgradeSettings(settings);

/**
 * Settings saved by older versions (also from a backup): one custom canvas color whose brightness decided
 * whether the canvas was light or dark became two custom themes, a light and a dark one, each with its color.
 */
export function upgradeSettings(s) {
  if (typeof s.cc === "string") {
    const dark = hexLuma(s.cc) < 110;
    s[dark ? "ccd" : "ccl"] = s.cc;
    if (s.ct === "cus") s.ct = dark ? "cusd" : "cusl";
    delete s.cc;
  }
  delete s.mq; // resolution while moving, learned by v36; gone
}

export function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Perceived brightness of "#rrggbb", 0..255. */
export function hexLuma(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return 255;
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

const SOLID_THEMES = { cw: ["#ffffff", 0], clg: ["#e6e8ee", 0], cd: ["#161616", 1], cb: ["#000000", 1] };
/** Canvas themes in the order the menus list them. */
export const CANVAS_THEMES = ["cw", "clg", "gl1", "gl2", "cusl", "cd", "cb", "gd1", "gd2", "cusd"];
const GRADIENT_THEMES = {
  gl1: ["#f7f3ff", "#d6e6fb", 0],
  gl2: ["#fff4ee", "#f8d9ea", 0],
  gd1: ["#262a58", "#0b0c20", 1],
  gd2: ["#14414d", "#090d28", 1],
};

/**
 * Colors used to draw the coloring canvas for the current canvas theme. Light or dark decides the cells,
 * numbers, grid and silhouette; for the custom themes that is the user's choice, whatever the color.
 * base: brightness of the background (0..255; a gradient's average), what the dark silhouette starts from.
 */
export function canvasTheme() {
  let bg;
  let gradient = null;
  let dark;
  if (GRADIENT_THEMES[settings.ct]) {
    const g = GRADIENT_THEMES[settings.ct];
    gradient = [g[0], g[1]];
    bg = g[0];
    dark = g[2];
  } else if (settings.ct === "cusl" || settings.ct === "cusd") {
    dark = settings.ct === "cusd" ? 1 : 0;
    bg = dark ? settings.ccd : settings.ccl;
    if (!/^#[0-9a-f]{6}$/i.test(bg)) bg = dark ? DEFAULTS.ccd : DEFAULTS.ccl;
  } else {
    [bg, dark] = SOLID_THEMES[settings.ct] || SOLID_THEMES.cw;
  }
  const base = gradient ? (hexLuma(gradient[0]) + hexLuma(gradient[1])) / 2 : hexLuma(bg);
  // dark: neutral grays (no blue cast); the selected number's empty cells go almost black
  return dark
    ? {
        bg,
        gradient,
        dark,
        base,
        cell: "#2a2a2a",
        number: "#c8c8c8",
        grid: "rgba(255,255,255,.12)",
        highlight: "#0e0e0e",
      }
    : { bg, gradient, dark, base, cell: "#ffffff", number: "#2b2b3a", grid: "rgba(0,0,0,.22)", highlight: "#a4a8b6" };
}
