// Time-lapse: replays the paint event log into a picture; preview, MP4 video or GIF.
//
// MP4: frames are encoded with the browser's own video encoder (WebCodecs; H.264, or VP9 if there is no
// H.264 encoder) and packed into an .mp4 file
// by mp4-muxer (js/vendor). This works on old Chrome versions that cannot record MP4 with MediaRecorder,
// and is faster than real time. If WebCodecs is missing, it falls back to MediaRecorder (real time, WebM).
// GIF: at most 256 colors, so the palette is built from the canvas's own colors (exact when it has
// 255 or fewer, otherwise reduced to the best 255 by weighted k-means) plus white for unpainted cells.
import { $, toast, setBusy, setBusyText, download, createCanvas, yieldToBrowser } from "./ui.js";
import { t } from "./i18n.js";
import { game, PixelBuffer, commitStroke } from "./game.js";
import { srgbToLab } from "./engine.js";

const WHITE = 0xffffffff;
const replay = {
  buffer: null,
  values: null, // current value of every cell: 0 = unpainted, k + 1 = color k
  event: 0, // next event to apply
  cell: 0, // cells of that event already applied
  timeline: [0], // cumulative weight before each event
  stopped: true,
};

/** Big actions (bucket of 5000 cells) shouldn't take 5000x longer than a single tap: weight grows with log. */
const eventWeight = (e) => 1 + Math.log2(e.cells.length);

function resetReplay() {
  const { width, height } = game.canvas;
  replay.buffer = new PixelBuffer(width, height);
  replay.buffer.pixels.fill(WHITE);
  replay.buffer.markAll();
  replay.values = new Uint16Array(width * height);
  replay.event = 0;
  replay.cell = 0;
  replay.timeline = [0];
  for (const e of game.events) replay.timeline.push(replay.timeline[replay.timeline.length - 1] + eventWeight(e));
}

function applyCells(e, from, to) {
  for (let k = from; k < to; k++) {
    const v = e.values[k];
    replay.values[e.cells[k]] = v;
    replay.buffer.set(e.cells[k], v ? game.colorPixel[v - 1] : WHITE);
  }
}

/** Advances the replay to fraction f (0..1) of the timeline. Only moves forward. */
function seek(f) {
  const target = f * replay.timeline[replay.timeline.length - 1];
  const events = game.events;
  while (replay.event < events.length && replay.timeline[replay.event + 1] <= target) {
    applyCells(events[replay.event], replay.cell, events[replay.event].cells.length);
    replay.event++;
    replay.cell = 0;
  }
  if (replay.event < events.length) {
    const e = events[replay.event];
    const n = Math.floor(((target - replay.timeline[replay.event]) / eventWeight(e)) * e.cells.length);
    if (n > replay.cell) {
      applyCells(e, replay.cell, n);
      replay.cell = n;
    }
  }
}

/** Output canvas about `size` px on the long side (whole-number scale when upscaling; even sizes for video). */
function outputCanvas(size) {
  const { width: W, height: H } = game.canvas;
  const longest = Math.max(W, H);
  const s = longest <= size ? Math.floor(size / longest) : size / longest;
  return createCanvas(Math.max(2, Math.round(W * s) & ~1), Math.max(2, Math.round(H * s) & ~1));
}

function drawFrame(out) {
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = out.width < game.canvas.width;
  replay.buffer.flush();
  ctx.drawImage(replay.buffer.canvas, 0, 0, out.width, out.height);
}

const durationMs = () => $("#tl-duration").value * 1000;
const showProgress = (label, f) => setBusyText(`${label} ${Math.round(f * 100)}%`);

export function openTimelapse() {
  if (!game.canvas || !game.events.length) return toast(t("empty"));
  commitStroke();
  $("#timelapse").hidden = false;
  replay.stopped = false;
  resetReplay();
  seek(1);
  const view = $("#timelapse-canvas");
  const c = outputCanvas(720);
  view.width = c.width;
  view.height = c.height;
  drawFrame(view);
}

$("#tl-close").onclick = () => {
  $("#timelapse").hidden = true;
  replay.stopped = true;
};
$("#tl-duration").oninput = (e) => ($("#tl-duration-value").textContent = e.target.value);

$("#tl-preview").onclick = () => {
  replay.stopped = false;
  resetReplay();
  const view = $("#timelapse-canvas");
  const start = performance.now();
  const total = durationMs();
  const frame = () => {
    const f = Math.min(1, (performance.now() - start) / total);
    seek(f);
    drawFrame(view);
    if (f < 1 && !replay.stopped) requestAnimationFrame(frame);
  };
  frame();
};

/* ---------- video ---------- */

const FPS = 30;
const HOLD_LAST_FRAME = 0.8; // seconds the finished picture stays on screen

/**
 * First video configuration this browser can encode into MP4: H.264 (high -> main -> baseline profile),
 * or VP9 if there is no H.264 encoder. Returns { config, muxerCodec } or null.
 */
async function findVideoConfig(width, height) {
  if (!window.VideoEncoder) return null;
  const options = [
    ["avc1.640028", "avc"],
    ["avc1.4d0028", "avc"],
    ["avc1.420028", "avc"],
    ["avc1.42001f", "avc"],
    ["vp09.00.40.08", "vp9"],
  ];
  for (const [codec, muxerCodec] of options) {
    const config = { codec, width, height, bitrate: 6e6, framerate: FPS };
    if (muxerCodec === "avc") config.avc = { format: "avc" };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, muxerCodec };
    } catch {
      /* try the next one */
    }
  }
  return null;
}

async function encodeMp4(out, { config, muxerCodec }) {
  const { Muxer, ArrayBufferTarget } = await import("./vendor/mp4-muxer.mjs");
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: muxerCodec, width: out.width, height: out.height },
    fastStart: "in-memory",
  });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  encoder.configure(config);
  const moving = Math.round((durationMs() / 1000) * FPS);
  const total = moving + Math.round(HOLD_LAST_FRAME * FPS);
  resetReplay();
  for (let i = 0; i < total; i++) {
    if (failure) throw failure;
    seek(Math.min(1, i / moving));
    drawFrame(out);
    const frame = new VideoFrame(out, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
    if (i % 5 === 0) {
      showProgress(t("vid"), i / total);
      await yieldToBrowser();
    }
  }
  await encoder.flush();
  if (failure) throw failure;
  encoder.close();
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}

/** Fallback for browsers without WebCodecs: records the canvas in real time. */
async function recordRealtime(out) {
  if (!window.MediaRecorder) throw new Error("No video support in this browser");
  const mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) =>
    MediaRecorder.isTypeSupported(m),
  );
  const recorder = new MediaRecorder(out.captureStream(FPS), { mimeType: mime, videoBitsPerSecond: 6e6 });
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const finished = new Promise((resolve) => (recorder.onstop = resolve));
  resetReplay();
  drawFrame(out);
  recorder.start();
  const total = durationMs();
  const start = performance.now();
  await new Promise((resolve) => {
    const frame = () => {
      const f = Math.min(1, (performance.now() - start) / total);
      seek(f);
      drawFrame(out);
      showProgress(t("vid"), f);
      if (f < 1) requestAnimationFrame(frame);
      else setTimeout(resolve, HOLD_LAST_FRAME * 1000);
    };
    frame();
  });
  recorder.stop();
  await finished;
  return new Blob(chunks, { type: mime.split(";")[0] });
}

$("#tl-video").onclick = async () => {
  replay.stopped = true;
  const out = outputCanvas(1080);
  setBusy(true, t("vid") + " 0%");
  await yieldToBrowser();
  try {
    const found = await findVideoConfig(out.width, out.height);
    const blob = found ? await encodeMp4(out, found) : await recordRealtime(out);
    download(blob, "timelapse." + (blob.type.includes("mp4") ? "mp4" : "webm"));
  } catch (e) {
    toast(t("err") + ": " + (e.message || e));
  }
  setBusy(false);
};

/* ---------- GIF ---------- */

/**
 * Appends one GIF frame (graphic control + image descriptor + LZW image data) to bytes.
 * frame: Uint8Array of indices into the global palette. delay in 1/100 s.
 */
function encodeGifFrame(bytes, frame, width, height, delay) {
  const word = (n) => bytes.push(n & 255, n >> 8);
  bytes.push(33, 249, 4, 0);
  word(delay);
  bytes.push(0, 0, 44);
  word(0);
  word(0);
  word(width);
  word(height);
  bytes.push(0, 8); // no local palette, LZW min code size 8

  const CLEAR = 256;
  const END = 257;
  let codeBits = 9;
  let nextCode = 258;
  let dict = new Map();
  let bitBuffer = 0;
  let bitCount = 0;
  let block = [];
  const flushBlock = () => {
    bytes.push(block.length, ...block);
    block = [];
  };
  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeBits;
    while (bitCount >= 8) {
      block.push(bitBuffer & 255);
      bitBuffer >>>= 8;
      bitCount -= 8;
      if (block.length === 255) flushBlock();
    }
  };

  emit(CLEAR);
  let prefix = frame[0];
  for (let i = 1; i < frame.length; i++) {
    const c = frame[i];
    const key = (prefix << 8) | c;
    const code = dict.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix);
    if (nextCode > (1 << codeBits) - 1 && codeBits < 12) codeBits++;
    if (nextCode < 4096) dict.set(key, nextCode++);
    else {
      emit(CLEAR);
      dict = new Map();
      nextCode = 258;
      codeBits = 9;
    }
    prefix = c;
  }
  emit(prefix);
  emit(END);
  if (bitCount > 0) block.push(bitBuffer & 255);
  if (block.length) flushBlock();
  bytes.push(0);
}

/**
 * GIF palette for the current canvas: 255 colors + white (index 255, unpainted cells).
 * Returns { table: 768 RGB bytes, lut: Uint8Array mapping cell value (0 or k + 1) -> GIF index }.
 */
function gifPalette() {
  const pal = game.canvas.palette;
  const K = pal.length / 3;
  const lut = new Uint8Array(K + 1);
  const table = new Uint8Array(768);
  table.set([255, 255, 255], 255 * 3);
  lut[0] = 255;
  if (K <= 255) {
    table.set(pal.subarray(0, K * 3));
    for (let k = 0; k < K; k++) lut[k + 1] = k;
    return { table, lut };
  }
  // weighted k-means in Lab: colors covering many cells pull the 255 GIF colors towards themselves
  const N = 255;
  const lab = new Float32Array(K * 3);
  for (let k = 0; k < K; k++) srgbToLab(pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2], lab, k * 3);
  const weight = game.totalOfColor.map((n) => n + 1);
  const order = [...Array(K).keys()].sort((a, b) => weight[b] - weight[a]);
  const centers = new Float32Array(N * 3);
  for (let c = 0; c < N; c++) centers.set(lab.subarray(order[c] * 3, order[c] * 3 + 3), c * 3);
  const assign = new Int32Array(K);
  const nearest = (k) => {
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < N; c++) {
      const a = lab[k * 3] - centers[c * 3];
      const b = lab[k * 3 + 1] - centers[c * 3 + 1];
      const d3 = lab[k * 3 + 2] - centers[c * 3 + 2];
      const d = a * a + b * b + d3 * d3;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  };
  for (let it = 0; it < 10; it++) {
    for (let k = 0; k < K; k++) assign[k] = nearest(k);
    const sum = new Float64Array(N * 4);
    for (let k = 0; k < K; k++) {
      const c = assign[k];
      for (let j = 0; j < 3; j++) sum[c * 4 + j] += lab[k * 3 + j] * weight[k];
      sum[c * 4 + 3] += weight[k];
    }
    for (let c = 0; c < N; c++)
      if (sum[c * 4 + 3]) for (let j = 0; j < 3; j++) centers[c * 3 + j] = sum[c * 4 + j] / sum[c * 4 + 3];
  }
  // final GIF colors: weighted RGB average of the canvas colors in each group (so they stay real colors)
  const rgb = new Float64Array(N * 4);
  for (let k = 0; k < K; k++) {
    const c = assign[k];
    for (let j = 0; j < 3; j++) rgb[c * 4 + j] += pal[k * 3 + j] * weight[k];
    rgb[c * 4 + 3] += weight[k];
    lut[k + 1] = c;
  }
  for (let c = 0; c < N; c++)
    if (rgb[c * 4 + 3]) for (let j = 0; j < 3; j++) table[c * 3 + j] = Math.round(rgb[c * 4 + j] / rgb[c * 4 + 3]);
  return { table, lut };
}

$("#tl-gif").onclick = async () => {
  replay.stopped = true;
  const GIF_FPS = 10;
  const frames = $("#tl-duration").value * GIF_FPS;
  const { width: W, height: H } = game.canvas;
  const { width: w, height: h } = outputCanvas(480);
  setBusy(true, "GIF 0%");
  await yieldToBrowser();
  const { table, lut } = gifPalette();
  // which cell every output pixel shows (nearest cell: no blending, so colors stay exact)
  const cellOf = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = Math.min(H - 1, Math.floor((y * H) / h)) * W;
    for (let x = 0; x < w; x++) cellOf[y * w + x] = row + Math.min(W - 1, Math.floor((x * W) / w));
  }
  // header + logical screen + 256-color global palette + loop forever
  const header = [71, 73, 70, 56, 57, 97, w & 255, w >> 8, h & 255, h >> 8, 0xf7, 0, 0, ...table];
  header.push(33, 255, 11, ..."NETSCAPE2.0".split("").map((c) => c.charCodeAt()), 3, 1, 0, 0, 0);
  const chunks = [new Uint8Array(header)];
  resetReplay();
  const indices = new Uint8Array(w * h);
  for (let i = 1; i <= frames; i++) {
    seek(i / frames);
    for (let o = 0; o < indices.length; o++) indices[o] = lut[replay.values[cellOf[o]]];
    const bytes = [];
    encodeGifFrame(bytes, indices, w, h, i === frames ? 250 : 100 / GIF_FPS);
    chunks.push(new Uint8Array(bytes));
    if (i % 3 === 0) {
      showProgress("GIF", i / frames);
      await yieldToBrowser();
    }
  }
  chunks.push(new Uint8Array([59]));
  setBusy(false);
  download(new Blob(chunks, { type: "image/gif" }), "timelapse.gif");
};
