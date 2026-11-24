// WebGL renderer for the coloring screen.
//
// The old way drew every visible cell with separate canvas calls (a rectangle per empty cell, a fillText per
// number): thousands of calls per frame when zoomed in, and all numbers re-rasterized on every zoom step.
// Here the whole screen is one triangle and a fragment shader works out every screen pixel by itself:
//   - which cell it is in, and that cell's color (texture uColor = the game's pixel buffer);
//   - its color number and whether it is empty / highlighted / in another part (texture uInfo);
//   - whether it lies on a grid line (only next to at least one empty cell: game.js marks the sides);
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

/**
 * State of a cell, as game.js sets it (blue channel of the info texture). The line bits say on which sides
 * of the cell a grid line is needed: only next to at least one empty cell (so finished areas look clean).
 */
export const CELL = {
  PAINTED: 1,
  OUTSIDE: 2, // belongs to another part than the one being colored
  HIDDEN: 4, // ...and other parts are not shown
  LINE_LEFT: 8,
  LINE_RIGHT: 16,
  LINE_TOP: 32,
  LINE_BOTTOM: 64,
};

/*
 * The fragment shader comes in three variants, by what the zoom shows: PLAIN (zoomed out: cell colors and
 * the highlight only), CELLS (+ empty cells turning into flat cells, grid lines) and NUMBERS (+ digits).
 * One shader with everything switched off at run time cost nearly as much as with everything on: the GPU
 * reserves registers for all of its code, and a phone's GPU then runs fewer pixels at once.
 */
const fragmentSource = (cells, numbers) => `#version 300 es
precision highp float;
precision highp int;
#define CELLS ${cells ? 1 : 0}
#define NUMBERS ${numbers ? 1 : 0}
uniform sampler2D uColor;   // W x H, what every cell looks like (premultiplied; alpha 0 = hidden cell)
uniform sampler2D uInfo;    // W x H: color index of the cell (red: low byte, green: high byte), state (blue)
uniform sampler2D uGlyphs;  // digits 0-9 in a row
uniform sampler2D uSel;     // W x H (mipmapped): 1 = empty cell of the selected number (see uSelMip)
uniform float uSelMip;      // 1: zoomed out below one pixel per cell, uSel is up to date
uniform vec2 uView;         // screen position of the picture's top-left corner, device pixels
uniform float uK;           // device pixels per cell
uniform float uInvK;        // cells per device pixel
uniform float uLod;         // mip level of uColor (zoomed out below one pixel per cell), else 0
uniform vec2 uSize;         // picture size in cells
uniform vec2 uInvSize;
uniform float uScreenH;     // screen height, device pixels
uniform vec3 uBg0;          // background gradient, start
uniform vec3 uBg1;          // background gradient, end (same as uBg0 for a plain background)
uniform vec2 uBgDir;        // gradient direction divided by its squared length
uniform vec3 uHiSel;        // empty cell of the selected number (its highlight shade)
uniform int uSelected;      // selected color number (1-based), 0 = none or highlighting is off
uniform float uSilBoost;    // contrast of the silhouette's shades around uSilRef (1 = as stored)
uniform vec3 uSilRef;       // the shade a silhouette fades into (white on a light canvas)
#if CELLS
uniform vec3 uCell;         // empty cell color when zoomed in
uniform vec3 uHighlight;    // empty cell of the selected number when zoomed in
uniform float uCellFade;    // 0..1: empty cells turn from the silhouette shade into uCell / uHighlight
uniform vec4 uGrid;         // grid line color; alpha already includes the zoom fade (0 = no grid)
uniform float uLine;        // half the width of a grid line, device pixels
#endif
#if NUMBERS
uniform vec3 uNumber;       // digit color
uniform float uNumberFade;  // 0..1: numbers fade in
uniform float uNumberAuto;  // 1: every number is black or white, whichever contrasts with its cell
uniform vec2 uGlyph;        // advance and padding of a digit in the atlas (u)
uniform vec4 uGlyphX;       // for numbers of 1, 2, 3 and 4 digits: digit advances per cell width
uniform vec4 uGlyphY;       // ...digit boxes per cell height
uniform vec4 uGlyphLod;     // ...mip level of the digits
#endif
out vec4 outColor;

const uint PAINTED = ${CELL.PAINTED}u;
const uint OUTSIDE = ${CELL.OUTSIDE}u;
const uint HIDDEN = ${CELL.HIDDEN}u;

#if CELLS
float lineCover(uint state, vec2 fr) {
  vec2 d0 = fr * uK;          // device pixels to the left / top border of the cell
  vec2 d1 = (1.0 - fr) * uK;  // ...to the right / bottom one
  float w = uLine + 0.5;
  float cover = 0.0;
  if ((state & ${CELL.LINE_LEFT}u) != 0u) cover = max(cover, w - d0.x);
  if ((state & ${CELL.LINE_RIGHT}u) != 0u) cover = max(cover, w - d1.x);
  if ((state & ${CELL.LINE_TOP}u) != 0u) cover = max(cover, w - d0.y);
  if ((state & ${CELL.LINE_BOTTOM}u) != 0u) cover = max(cover, w - d1.y);
  return clamp(cover, 0.0, 1.0);
}

// Just outside the picture: the outer half of its border lines (where the edge cell is still empty)
vec3 edgeLine(vec2 c, vec3 bg) {
  vec2 away = max(-c, c - uSize) * uK; // device pixels outside, per axis (negative: inside on that axis)
  float w = uLine + 0.5;
  if (uGrid.a <= 0.0 || max(away.x, away.y) >= w || min(away.x, away.y) > 0.0) return bg;
  ivec2 edge = ivec2(clamp(floor(c), vec2(0.0), uSize - 1.0));
  uint state = uint(texelFetch(uInfo, edge, 0).b * 255.0 + 0.5);
  uint side = c.x < 0.0 ? ${CELL.LINE_LEFT}u : c.x >= uSize.x ? ${CELL.LINE_RIGHT}u
    : c.y < 0.0 ? ${CELL.LINE_TOP}u : ${CELL.LINE_BOTTOM}u;
  if ((state & side) == 0u) return bg;
  return mix(bg, uGrid.rgb, uGrid.a * clamp(w - max(away.x, away.y), 0.0, 1.0));
}
#endif

#if NUMBERS
vec3 number(vec3 col, int n, vec2 fr) {
  // (most of a cell is beside its number: that is found out first and cheaply)
  if (abs(fr.y - 0.5) * uGlyphY.x > 0.5) return col;
  int digits = n < 10 ? 1 : n < 100 ? 2 : n < 1000 ? 3 : 4;
  float fd = float(digits);
  float ty = (fr.y - 0.5) * uGlyphY[digits - 1] + 0.5;  // 0..1 down the digit box
  float tx = (fr.x - 0.5) * uGlyphX[digits - 1] + fd * 0.5; // 0..digits across the number
  if (tx < 0.0 || tx >= fd || ty < 0.0 || ty > 1.0) return col;
  float slot = floor(tx);
  float power = fd - 1.0 - slot; // of ten, for this digit
  float unit = power < 0.5 ? 1.0 : power < 1.5 ? 10.0 : power < 2.5 ? 100.0 : 1000.0;
  float digit = mod(floor((float(n) + 0.5) / unit), 10.0); // float math: integer division is slow on phones
  vec2 guv = vec2(digit * 0.1 + uGlyph.y + (tx - slot) * uGlyph.x, ty);
  vec3 ink = uNumber;
  if (uNumberAuto > 0.5) ink = dot(col, vec3(0.3, 0.59, 0.11)) > 0.55 ? vec3(0.08, 0.08, 0.12) : vec3(0.96, 0.96, 0.98);
  // mip level by hand: the automatic choice breaks at the seams between digits, where u jumps
  return mix(col, ink, textureLod(uGlyphs, guv, uGlyphLod[digits - 1]).r * uNumberFade);
}
#endif

void main() {
  vec2 P = vec2(gl_FragCoord.x, uScreenH - gl_FragCoord.y); // y down, like the 2D canvas
  vec3 bg = mix(uBg0, uBg1, clamp(dot(P, uBgDir), 0.0, 1.0));
  vec2 c = (P - uView) * uInvK; // position in cells
  vec2 cf = floor(c);
  if (cf.x < 0.0 || cf.y < 0.0 || cf.x >= uSize.x || cf.y >= uSize.y) {
#if CELLS
    outColor = vec4(edgeLine(c, bg), 1.0);
#else
    outColor = vec4(bg, 1.0);
#endif
    return;
  }
  ivec2 ci = ivec2(cf);
  uvec3 info = uvec3(texelFetch(uInfo, ci, 0).rgb * 255.0 + 0.5);
  uint state = info.b;
  vec2 fr = c - cf;
  // Zoomed in: each cell is one flat color with a 1-pixel smooth edge (no shimmer at fractional zooms).
  // Zoomed out below one pixel per cell: ordinary smooth downscaling (mipmaps).
  vec2 uv = uK >= 1.0 ? (cf + 0.5 + clamp(fr * uK, 0.0, 0.5) - clamp((1.0 - fr) * uK, 0.0, 0.5)) * uInvSize
                      : c * uInvSize;
  vec4 px = textureLod(uColor, uv, uLod);
  vec3 col = px.rgb + bg * (1.0 - px.a);
  // Zoomed out below one pixel per cell, one screen pixel covers several cells: it shows the highlight in
  // the share of those cells that are empty cells of the selected number (a single cell would flicker)
  if (uSelMip > 0.5) col = mix(col, uHiSel, textureLod(uSel, uv, uLod).r);
  if ((state & (PAINTED | HIDDEN)) == 0u) {
    // an empty cell that is shown
    int n = int(info.r + info.g * 256u) + 1;
    bool outside = (state & OUTSIDE) != 0u;
    bool selected = n == uSelected && !outside;
    // Empty cells of the selected number: done here rather than stored in uColor, so choosing another
    // color changes one uniform instead of re-sending every cell of both colors to the GPU.
    // (Zoomed out below one pixel per cell, see above.)
    if (selected && uK >= 1.0) col = uHiSel;
    if (uSilBoost > 1.0 && px.a > 0.5) col = clamp(uSilRef + (col - uSilRef) * uSilBoost, 0.0, 1.0);
#if CELLS
    col = mix(col, selected ? uHighlight : uCell, uCellFade);
    if (outside) col = mix(col, bg, 0.62 * uCellFade);
#endif
#if NUMBERS
    if (!outside) col = number(col, n, fr);
#endif
  }
#if CELLS
  if (uGrid.a > 0.0) col = mix(col, uGrid.rgb, uGrid.a * lineCover(state, fr));
#endif
  outColor = vec4(col, 1.0);
}`;

/** Uniforms of every variant (those a variant lacks just have no location). */
const UNIFORMS = [
  "uView",
  "uK",
  "uInvK",
  "uLod",
  "uSize",
  "uInvSize",
  "uScreenH",
  "uBg0",
  "uBg1",
  "uBgDir",
  "uHiSel",
  "uSelected",
  "uSelMip",
  "uSilBoost",
  "uSilRef",
  "uCell",
  "uHighlight",
  "uCellFade",
  "uGrid",
  "uLine",
  "uNumber",
  "uNumberFade",
  "uNumberAuto",
  "uGlyph",
  "uGlyphX",
  "uGlyphY",
  "uGlyphLod",
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

const PAINTED_HIDDEN_OUTSIDE = CELL.PAINTED | CELL.HIDDEN | CELL.OUTSIDE;

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
 * Methods: setCanvas, upload, setHighlightColors, draw, resize; field `ready` is false while the GPU context
 * is lost.
 */
export function createGlView(element, onRestored) {
  const options = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" };
  const gl = element.getContext("webgl2", options);
  if (!gl) return null;

  const view = { ready: false, maxSize: 0 };
  let programs = null; // [plain, cells, numbers]: { program, uniform }
  let textures = null; // { color, info, glyphs }
  let glyphs = null;
  let size = null; // { width, height } of the canvas the textures hold
  let info = null; // the info texture's bytes (see uInfo): color index, state
  let mipsStale = true;
  let highlight = []; // highlight shade of every number (pixels 0xAABBGGRR)
  // Zoomed out below one pixel per cell: which cells are empty cells of the selected number (255), as a
  // mipmapped texture, so a screen pixel can show the highlight in proportion. Built when first needed.
  let selMask = null;
  let selFor = 0; // the number selMask was made for, 0 = not made
  let selMipsStale = true;
  let themeOf = null; // theme object whose colors are parsed into themeVec
  let themeVec = null;
  const glyphLod = new Float32Array(4);

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function link(cells, numbers) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource(cells, numbers)));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const uniform = {};
    const values = {}; // what each uniform was last set to (see set)
    for (const name of UNIFORMS) {
      uniform[name] = gl.getUniformLocation(program, name);
      values[name] = new Float64Array(4).fill(NaN);
    }
    gl.uniform1i(gl.getUniformLocation(program, "uColor"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uInfo"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "uGlyphs"), 2);
    gl.uniform1i(gl.getUniformLocation(program, "uSel"), 3);
    if (numbers) {
      gl.uniform2f(uniform.uGlyph, glyphs.advanceU, glyphs.padU);
      gl.uniform4fv(
        uniform.uGlyphX,
        glyphs.fit.map((f) => 1 / (glyphs.advanceCells * f)),
      );
      gl.uniform4fv(
        uniform.uGlyphY,
        glyphs.fit.map((f) => 1 / (glyphs.heightCells * f)),
      );
    }
    return { program, uniform, values };
  }

  /**
   * Sets uniform `name` of program `prog` (in use) to n numbers (n = -1: one integer), unless it holds them
   * already: most of them stay the same from frame to frame, and every call costs a weak phone time.
   */
  function set(prog, name, n, x, y = 0, z = 0, w = 0) {
    const loc = prog.uniform[name];
    if (!loc) return;
    const v = prog.values[name];
    if (v[0] === x && v[1] === y && v[2] === z && v[3] === w) return;
    v[0] = x;
    v[1] = y;
    v[2] = z;
    v[3] = w;
    if (n === -1) gl.uniform1i(loc, x);
    else if (n === 1) gl.uniform1f(loc, x);
    else if (n === 2) gl.uniform2f(loc, x, y);
    else if (n === 3) gl.uniform3f(loc, x, y, z);
    else gl.uniform4f(loc, x, y, z, w);
  }
  const set3 = (prog, name, rgb) => set(prog, name, 3, rgb[0], rgb[1], rgb[2]);

  function init() {
    view.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.bindVertexArray(gl.createVertexArray());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    glyphs = makeGlyphAtlas();
    // per number length (1-4 digits): long numbers shrink to stay inside the cell
    glyphs.fit = [1, 2, 3, 4].map((d) => Math.min(1, 0.88 / (d * glyphs.advanceCells)));
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, glyphs.canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    textures = { glyphs: tex, color: null, info: null, sel: null };
    programs = [link(false, false), link(true, false), link(true, true)];
    size = null;
    themeOf = null;
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
    for (const name of ["color", "info", "sel"]) if (textures[name]) gl.deleteTexture(textures[name]);
    textures.sel = selMask = null;
    selFor = 0;
    const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
    textures.color = makeTexture(0, gl.RGBA8, width, height, levels, gl.LINEAR);
    textures.info = makeTexture(1, gl.RGBA8, width, height, 1, gl.NEAREST);
    info = new Uint8Array(width * height * 4);
    for (let i = 0; i < target.length; i++) {
      info[i * 4] = target[i] & 255;
      info[i * 4 + 1] = target[i] >> 8;
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, info);
    size = { width, height };
    mipsStale = true;
    return true;
  };

  /**
   * Copies the rectangle [x0, y0, x1, y1] (inclusive, in cells) of the game's arrays to the GPU.
   * pixels: Uint32Array (the pixel buffer), states: Uint8Array of CELL bits, both width * height long.
   */
  view.upload = (pixels, states, [x0, y0, x1, y1]) => {
    if (!view.ready || !size) return;
    const W = size.width;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    for (let y = y0; y <= y1; y++)
      for (let i = y * W + x0, end = y * W + x1; i <= end; i++) info[i * 4 + 2] = states[i];
    // ROW_LENGTH + SKIP_*: upload a sub-rectangle straight out of the full-size array, no copying
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, W);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures.color);
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, textures.info);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, info);
    if (selFor) {
      fillSelMask(x0, y0, x1, y1);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, textures.sel);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RED, gl.UNSIGNED_BYTE, selMask);
      selMipsStale = true;
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    mipsStale = true;
  };

  /** selMask over the cell rectangle x0..x1, y0..y1 (inclusive) from the info bytes, for number selFor. */
  function fillSelMask(x0, y0, x1, y1) {
    const W = size.width;
    for (let y = y0; y <= y1; y++)
      for (let i = y * W + x0, end = y * W + x1; i <= end; i++) {
        const o = i * 4;
        selMask[i] =
          (info[o + 2] & PAINTED_HIDDEN_OUTSIDE) === 0 && info[o] + info[o + 1] * 256 + 1 === selFor ? 255 : 0;
      }
  }

  /** Brings the highlight mask up to date for number n (zoomed out below one pixel per cell). */
  function prepareSelMask(n) {
    const { width: W, height: H } = size;
    if (!textures.sel) {
      textures.sel = makeTexture(3, gl.R8, W, H, Math.floor(Math.log2(Math.max(W, H))) + 1, gl.LINEAR);
      selMask = new Uint8Array(W * H);
      selFor = 0;
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, textures.sel);
    if (selFor !== n) {
      selFor = n;
      fillSelMask(0, 0, W - 1, H - 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, selMask);
      selMipsStale = true;
    }
    if (selMipsStale) {
      gl.generateMipmap(gl.TEXTURE_2D);
      selMipsStale = false;
    }
  }

  /**
   * The shade an empty cell of each number gets while that number is selected (pixels as in the pixel
   * buffer: 0xAABBGGRR). Only the selected number's goes to the shader, as one uniform.
   */
  view.setHighlightColors = (pixels) => {
    highlight = Array.from(pixels);
  };

  /** Matches the drawing buffer to the element's size in device pixels. */
  view.resize = (width, height) => {
    if (element.width !== width) element.width = width;
    if (element.height !== height) element.height = height;
  };

  /**
   * Draws a frame.
   * p: { x, y, scale (CSS px), dpr, theme, cellFade, gridFade, numberFade, contrastNumbers, silBoost, selected }
   */
  view.draw = (p) => {
    if (!view.ready || !size) return false;
    const k = p.scale * p.dpr;
    if (k < 1 && mipsStale) {
      // only needed when zoomed far out, and only after the picture changed
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textures.color);
      gl.generateMipmap(gl.TEXTURE_2D);
      mipsStale = false;
    }
    const theme = p.theme;
    if (theme !== themeOf) {
      // theme colors are parsed only when the theme object changes, not every frame
      themeOf = theme;
      const [bg0, bg1] = theme.gradient || [theme.bg, theme.bg];
      themeVec = {
        bg0: hexToRgb(bg0),
        bg1: hexToRgb(bg1),
        cell: hexToRgb(theme.cell),
        highlight: hexToRgb(theme.highlight),
        number: hexToRgb(theme.number),
        grid: rgbaToVec(theme.grid),
        silRef: theme.dark ? [theme.base / 255, theme.base / 255, theme.base / 255] : [1, 1, 1],
      };
    }
    const gridA = themeVec.grid[3] * p.gridFade;
    const prog = programs[p.numberFade > 0 ? 2 : p.cellFade > 0 || gridA > 0 ? 1 : 0];
    gl.useProgram(prog.program);
    gl.viewport(0, 0, element.width, element.height);
    set(prog, "uView", 2, p.x * p.dpr, p.y * p.dpr);
    set(prog, "uK", 1, k);
    set(prog, "uInvK", 1, 1 / k);
    set(prog, "uLod", 1, k >= 1 ? 0 : Math.log2(1 / k));
    set(prog, "uSize", 2, size.width, size.height);
    set(prog, "uInvSize", 2, 1 / size.width, 1 / size.height);
    set(prog, "uScreenH", 1, element.height);
    set3(prog, "uBg0", themeVec.bg0);
    set3(prog, "uBg1", themeVec.bg1);
    // the background gradient runs along (0.35 * width, height): its direction over its squared length
    const dx = 0.35 * element.width;
    const dy = element.height;
    const len2 = dx * dx + dy * dy;
    set(prog, "uBgDir", 2, dx / len2, dy / len2);
    const hi = highlight[p.selected - 1] || 0;
    set(prog, "uHiSel", 3, (hi & 255) / 255, ((hi >> 8) & 255) / 255, ((hi >> 16) & 255) / 255);
    set(prog, "uSelected", -1, p.selected);
    const selMip = k < 1 && p.selected > 0;
    if (selMip) prepareSelMask(p.selected);
    set(prog, "uSelMip", 1, selMip ? 1 : 0);
    set(prog, "uSilBoost", 1, p.silBoost || 1);
    set3(prog, "uSilRef", themeVec.silRef);
    set3(prog, "uCell", themeVec.cell);
    set3(prog, "uHighlight", themeVec.highlight);
    set(prog, "uCellFade", 1, p.cellFade);
    set(prog, "uGrid", 4, themeVec.grid[0], themeVec.grid[1], themeVec.grid[2], gridA);
    set(prog, "uLine", 1, p.dpr / 2);
    if (prog.uniform.uNumber) {
      set3(prog, "uNumber", themeVec.number);
      set(prog, "uNumberFade", 1, p.numberFade);
      set(prog, "uNumberAuto", 1, p.contrastNumbers ? 1 : 0);
      // digits are drawn at their atlas size or smaller: atlas pixels per screen pixel give the mip level
      for (let d = 0; d < 4; d++)
        glyphLod[d] = Math.log2(Math.max(1, glyphs.boxHeight / (glyphs.heightCells * glyphs.fit[d] * k)));
      set(prog, "uGlyphLod", 4, glyphLod[0], glyphLod[1], glyphLod[2], glyphLod[3]);
    }
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
