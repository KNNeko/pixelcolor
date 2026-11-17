// WebGL renderer for the coloring screen.
//
// The old way drew every visible cell with separate canvas calls (a rectangle per empty cell, a fillText per
// number): thousands of calls per frame when zoomed in, and all numbers re-rasterized on every zoom step.
// Here the whole screen is one triangle and a fragment shader works out every screen pixel by itself:
//   - which cell it is in, and that cell's color (texture uColor = the game's pixel buffer);
//   - whether the cell is empty / highlighted / in another part (textures uFlags, uTarget);
//   - whether it lies on a grid line (only next to at least one empty cell);
//   - whether it lies on a digit of the cell's number (digits come from a small atlas texture, uGlyphs).
// The cost of a frame depends on the screen size only, not on the canvas size or the zoom level.
//
// game.js owns all state; this file only mirrors it into textures and draws. If WebGL 2 is missing or the
// canvas is larger than the GPU's texture limit, createGlView / setCanvas return null / false and game.js
// falls back to its 2D drawing code.

const VERTEX = `#version 300 es
void main() {
  // one triangle covering the screen, no vertex buffers needed
  gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uColor;   // W x H, what every cell looks like (premultiplied; alpha 0 = hidden cell)
uniform sampler2D uFlags;   // W x H, bit 0: painted, bit 1: belongs to another part than the one being colored
uniform sampler2D uTarget;  // W x H, color index of the cell (low byte, high byte)
uniform sampler2D uGlyphs;  // digits 0-9 in a row
uniform sampler2D uHiPal;   // K x 1: the "highlighted" shade of every color number (index = number - 1)
uniform vec2 uView;         // screen position of the picture's top-left corner, device pixels
uniform float uK;           // device pixels per cell
uniform vec2 uSize;         // picture size in cells
uniform vec2 uScreen;       // screen size, device pixels
uniform vec3 uBg0;          // background gradient, start
uniform vec3 uBg1;          // background gradient, end (same as uBg0 for a plain background)
uniform vec3 uCell;         // empty cell color when zoomed in
uniform vec3 uHighlight;    // empty cell of the selected number when zoomed in
uniform vec3 uNumber;       // digit color
uniform vec4 uGrid;         // grid line color; alpha already includes the zoom fade (0 = no grid)
uniform float uCellFade;    // 0..1: empty cells turn from the silhouette shade into uCell / uHighlight
uniform float uNumberFade;  // 0..1: numbers fade in
uniform float uNumberAuto;  // 1: every number is black or white, whichever contrasts with its cell
uniform int uSelected;      // selected color number (1-based), 0 = none or highlighting is off
uniform float uShowOthers;  // 1: cells of other parts are shown dimmed, 0: they are hidden
uniform float uLine;        // half the width of a grid line, device pixels
uniform vec4 uGlyph;        // digit advance (cells), digit box height (cells), advance and padding (atlas u)
uniform float uGlyphPx;     // digit box height in atlas pixels
out vec4 outColor;

const int POW10[4] = int[4](1, 10, 100, 1000);

int flagsAt(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uSize.x) || c.y >= int(uSize.y)) return -1;
  return int(texelFetch(uFlags, c, 0).r * 255.0 + 0.5);
}
// No grid line is needed between two cells that are both "filled": painted, hidden, or outside the picture.
bool filled(int f) {
  return f < 0 || (f & 1) != 0 || ((f & 2) != 0 && uShowOthers < 0.5);
}

void main() {
  vec2 P = vec2(gl_FragCoord.x, uScreen.y - gl_FragCoord.y); // y down, like the 2D canvas
  vec2 dir = vec2(0.35 * uScreen.x, uScreen.y);
  vec3 bg = mix(uBg0, uBg1, clamp(dot(P, dir) / dot(dir, dir), 0.0, 1.0));
  vec3 col = bg;

  vec2 c = (P - uView) / uK; // position in cells
  ivec2 ci = ivec2(floor(c));
  int f = flagsAt(ci);
  if (f >= 0) {
    vec2 fr = c - floor(c);
    // Zoomed in: each cell is one flat color with a 1-pixel smooth edge (no shimmer at fractional zooms).
    // Zoomed out below one pixel per cell: ordinary smooth downscaling (mipmaps).
    vec2 uv = uK >= 1.0
      ? (floor(c) + 0.5 + clamp(fr * uK, 0.0, 0.5) - clamp((1.0 - fr) * uK, 0.0, 0.5)) / uSize
      : c / uSize;
    // explicit mip level: the automatic one is undefined inside a branch
    vec4 px = textureLod(uColor, uv, uK >= 1.0 ? 0.0 : log2(1.0 / uK));
    col = px.rgb + bg * (1.0 - px.a);
    bool painted = (f & 1) != 0;
    bool outside = (f & 2) != 0;
    int n = 0; // number of an empty, visible cell (0 = painted or hidden)
    if (!painted && !(outside && uShowOthers < 0.5) && (uSelected > 0 || uCellFade > 0.0 || uNumberFade > 0.0)) {
      vec2 tg = texelFetch(uTarget, ci, 0).rg * 255.0 + 0.5;
      n = int(tg.x) + int(tg.y) * 256 + 1;
    }
    // Empty cells of the selected number. Done here rather than stored in uColor, so choosing another
    // color changes one uniform instead of re-sending every cell of both colors to the GPU.
    // (Zoomed out below one pixel per cell it is skipped: a single cell would only flicker.)
    if (n > 0 && n == uSelected && !outside && uK >= 1.0) col = texelFetch(uHiPal, ivec2(n - 1, 0), 0).rgb;
    if (n > 0 && (uCellFade > 0.0 || uNumberFade > 0.0)) {
      if (uCellFade > 0.0) {
        col = mix(col, (!outside && n == uSelected) ? uHighlight : uCell, uCellFade);
        if (outside) col = mix(col, bg, 0.62 * uCellFade);
      }
      if (uNumberFade > 0.0 && !outside) {
        int digits = n < 10 ? 1 : n < 100 ? 2 : n < 1000 ? 3 : 4;
        float fit = min(1.0, 0.88 / (float(digits) * uGlyph.x)); // long numbers shrink to stay inside the cell
        float tx = (fr.x - 0.5) / (uGlyph.x * fit) + float(digits) * 0.5; // 0..digits across the number
        float ty = (fr.y - 0.5) / (uGlyph.y * fit) + 0.5;                 // 0..1 down the digit box
        if (tx >= 0.0 && tx < float(digits) && ty >= 0.0 && ty <= 1.0) {
          int slot = int(tx);
          int digit = (n / POW10[digits - 1 - slot]) % 10;
          vec2 guv = vec2(float(digit) * 0.1 + uGlyph.w + fract(tx) * uGlyph.z, ty);
          // atlas pixels per screen pixel decide the mip level (computed by hand: the automatic choice
          // breaks at the seams between digits, where the texture coordinate jumps)
          float lod = log2(max(1.0, uGlyphPx / (uGlyph.y * fit * uK)));
          vec3 ink = uNumber;
          if (uNumberAuto > 0.5) ink = dot(col, vec3(0.3, 0.59, 0.11)) > 0.55 ? vec3(0.08, 0.08, 0.12) : vec3(0.96, 0.96, 0.98);
          col = mix(col, ink, textureLod(uGlyphs, guv, lod).r * uNumberFade);
        }
      }
    }
  }

  if (uGrid.a > 0.0) {
    vec2 b = floor(c + 0.5);       // nearest cell border on each axis
    vec2 d = abs(c - b) * uK;      // distance to it, device pixels
    float cover = 0.0;
    if (d.x < uLine + 0.5) {
      ivec2 right = ivec2(int(b.x), ci.y);
      if (!(filled(flagsAt(right - ivec2(1, 0))) && filled(flagsAt(right)))) cover = clamp(uLine + 0.5 - d.x, 0.0, 1.0);
    }
    if (d.y < uLine + 0.5) {
      ivec2 below = ivec2(ci.x, int(b.y));
      if (!(filled(flagsAt(below - ivec2(0, 1))) && filled(flagsAt(below))))
        cover = max(cover, clamp(uLine + 0.5 - d.y, 0.0, 1.0));
    }
    col = mix(col, uGrid.rgb, uGrid.a * cover);
  }
  outColor = vec4(col, 1.0);
}`;

const UNIFORMS = [
  "uColor",
  "uFlags",
  "uTarget",
  "uGlyphs",
  "uHiPal",
  "uView",
  "uK",
  "uSize",
  "uScreen",
  "uBg0",
  "uBg1",
  "uCell",
  "uHighlight",
  "uNumber",
  "uGrid",
  "uCellFade",
  "uNumberFade",
  "uNumberAuto",
  "uSelected",
  "uShowOthers",
  "uLine",
  "uGlyph",
  "uGlyphPx",
];

/** Digits 0-9 drawn once into a strip; the shader composes cell numbers from it. */
function makeGlyphAtlas() {
  const FONT = 64; // px
  const PAD = 6; // empty margin around every digit, so neighbours never bleed in when scaled down
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = `${FONT}px system-ui, sans-serif`;
  ctx.font = font;
  // Digits sit a little closer than the font's own spacing (ink width plus a small gap): three-digit numbers
  // then fit a cell the way proportional text does.
  let advance = 0;
  let ascent = 0;
  let descent = 0;
  for (let d = 0; d < 10; d++) {
    const m = ctx.measureText(String(d));
    advance = Math.max(advance, m.actualBoundingBoxLeft + m.actualBoundingBoxRight);
    ascent = Math.max(ascent, m.actualBoundingBoxAscent);
    descent = Math.max(descent, m.actualBoundingBoxDescent);
  }
  advance = Math.ceil(advance + FONT * 0.06);
  const boxWidth = advance + PAD * 2;
  const boxHeight = Math.ceil(ascent + descent) + PAD * 2;
  canvas.width = boxWidth * 10;
  canvas.height = boxHeight;
  ctx.fillStyle = "#000"; // white on black: the red channel is then the glyph coverage
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = font; // resizing a canvas resets its state
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#fff";
  for (let d = 0; d < 10; d++) ctx.fillText(String(d), boxWidth * d + boxWidth / 2, PAD + ascent);
  return {
    canvas,
    // on screen a digit is drawn with a font size of half a cell
    advanceCells: (0.5 * advance) / FONT,
    heightCells: (0.5 * boxHeight) / FONT,
    advanceU: advance / canvas.width,
    padU: PAD / canvas.width,
    boxHeight,
  };
}

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
/** "rgba(r,g,b,a)" -> [r, g, b, a] with all values 0..1. */
const rgbaToVec = (text) => {
  const v = text.match(/[\d.]+/g).map(Number);
  return [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1];
};

/**
 * Creates the renderer on a canvas element. Returns null if WebGL 2 is not available.
 * Methods: setCanvas, upload, draw, resize; field `ready` is false while the GPU context is lost.
 */
export function createGlView(element, onRestored) {
  const options = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" };
  const gl = element.getContext("webgl2", options);
  if (!gl) return null;

  const view = { ready: false, maxSize: 0 };
  let program = null;
  let uniform = {};
  let textures = null; // { color, flags, target, glyphs }
  let glyphs = null;
  let size = null; // { width, height } of the canvas the textures hold
  let mipsStale = true;
  let sentTheme = null; // theme object whose colors are currently in the shader
  let gridColor = [0, 0, 0, 0];

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function init() {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    uniform = {};
    for (const name of UNIFORMS) uniform[name] = gl.getUniformLocation(program, name);
    gl.bindVertexArray(gl.createVertexArray());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    view.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    glyphs = makeGlyphAtlas();
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, glyphs.canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // highlight shades: filled in by setHighlightColors
    const hiPal = gl.createTexture();
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, hiPal);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    textures = { glyphs: tex, hiPal, color: null, flags: null, target: null };
    gl.uniform1i(uniform.uColor, 0);
    gl.uniform1i(uniform.uFlags, 1);
    gl.uniform1i(uniform.uTarget, 2);
    gl.uniform1i(uniform.uGlyphs, 3);
    gl.uniform1i(uniform.uHiPal, 4);
    gl.uniform4f(uniform.uGlyph, glyphs.advanceCells, glyphs.heightCells, glyphs.advanceU, glyphs.padU);
    gl.uniform1f(uniform.uGlyphPx, glyphs.boxHeight);
    size = null;
    sentTheme = null;
  }

  function makeTexture(unit, format, width, height, levels, filter) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, format, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /**
   * Prepares textures for a canvas of width x height cells; target[i] = color index of cell i.
   * Returns false if the canvas does not fit into a texture on this device.
   */
  view.setCanvas = (width, height, target) => {
    if (!view.ready || width > view.maxSize || height > view.maxSize) return false;
    for (const name of ["color", "flags", "target"]) if (textures[name]) gl.deleteTexture(textures[name]);
    const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
    textures.color = makeTexture(0, gl.RGBA8, width, height, levels, gl.LINEAR);
    textures.flags = makeTexture(1, gl.R8, width, height, 1, gl.NEAREST);
    textures.target = makeTexture(2, gl.RG8, width, height, 1, gl.NEAREST);
    const bytes = new Uint8Array(width * height * 2);
    for (let i = 0; i < target.length; i++) {
      bytes[i * 2] = target[i] & 255;
      bytes[i * 2 + 1] = target[i] >> 8;
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RG, gl.UNSIGNED_BYTE, bytes);
    size = { width, height };
    mipsStale = true;
    return true;
  };

  /**
   * Copies the rectangle [x0, y0, x1, y1] (inclusive, in cells) of the game's arrays to the GPU.
   * pixels: Uint32Array (the pixel buffer), flags: Uint8Array, both width * height long.
   */
  view.upload = (pixels, flags, [x0, y0, x1, y1]) => {
    if (!view.ready || !size) return;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    // ROW_LENGTH + SKIP_*: upload a sub-rectangle straight out of the full-size array, no copying
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, size.width);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
    gl.activeTexture(gl.TEXTURE0);
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.activeTexture(gl.TEXTURE1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RED, gl.UNSIGNED_BYTE, flags);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    mipsStale = true;
  };

  /**
   * The shade an empty cell of each number gets while that number is selected (pixels as in the pixel
   * buffer: 0xAABBGGRR). Sent once per canvas / theme change; selecting a number then costs nothing.
   */
  view.setHighlightColors = (pixels) => {
    if (!view.ready || !pixels.length) return;
    const data = Uint32Array.from(pixels);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, textures.hiPal);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      data.length,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(data.buffer),
    );
  };

  /** Matches the drawing buffer to the element's size in device pixels. */
  view.resize = (width, height) => {
    if (element.width !== width) element.width = width;
    if (element.height !== height) element.height = height;
  };

  /**
   * Draws a frame.
   * p: { x, y, scale (CSS px), dpr, theme, cellFade, gridFade, numberFade, contrastNumbers, selected, showOthers }
   */
  view.draw = (p) => {
    if (!view.ready || !size) return false;
    const k = p.scale * p.dpr;
    if (k < 1 && mipsStale) {
      // only needed when zoomed far out, and only after the picture changed
      gl.activeTexture(gl.TEXTURE0);
      gl.generateMipmap(gl.TEXTURE_2D);
      mipsStale = false;
    }
    gl.viewport(0, 0, element.width, element.height);
    gl.uniform2f(uniform.uView, p.x * p.dpr, p.y * p.dpr);
    gl.uniform1f(uniform.uK, k);
    gl.uniform2f(uniform.uSize, size.width, size.height);
    gl.uniform2f(uniform.uScreen, element.width, element.height);
    const theme = p.theme;
    if (theme !== sentTheme) {
      // theme colors are parsed and sent only when the theme object changes, not every frame
      sentTheme = theme;
      const [bg0, bg1] = theme.gradient || [theme.bg, theme.bg];
      gl.uniform3fv(uniform.uBg0, hexToRgb(bg0));
      gl.uniform3fv(uniform.uBg1, hexToRgb(bg1));
      gl.uniform3fv(uniform.uCell, hexToRgb(theme.cell));
      gl.uniform3fv(uniform.uHighlight, hexToRgb(theme.highlight));
      gl.uniform3fv(uniform.uNumber, hexToRgb(theme.number));
      gridColor = rgbaToVec(theme.grid);
    }
    gl.uniform4f(uniform.uGrid, gridColor[0], gridColor[1], gridColor[2], gridColor[3] * p.gridFade);
    gl.uniform1f(uniform.uCellFade, p.cellFade);
    gl.uniform1f(uniform.uNumberFade, p.numberFade);
    gl.uniform1f(uniform.uNumberAuto, p.contrastNumbers ? 1 : 0);
    gl.uniform1i(uniform.uSelected, p.selected);
    gl.uniform1f(uniform.uShowOthers, p.showOthers ? 1 : 0);
    gl.uniform1f(uniform.uLine, p.dpr / 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  };

  // The browser may take the GPU context away (app in the background, memory pressure) and give it back later.
  element.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    view.ready = false;
  });
  element.addEventListener("webglcontextrestored", () => {
    try {
      init();
      view.ready = true;
      onRestored();
    } catch {
      view.ready = false;
    }
  });

  try {
    init();
    view.ready = true;
  } catch (e) {
    console.warn("WebGL renderer unavailable:", e);
    return null;
  }
  return view;
}
