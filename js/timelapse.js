// Time-lapse: replays the paint event log into a picture; preview, video (MediaRecorder) or GIF.
import { $, toast, setBusy, setBusyText, download, createCanvas, yieldToBrowser } from "./ui.js";
import { t } from "./i18n.js";
import { game, PixelBuffer, commitStroke } from "./game.js";

const WHITE = 0xffffffff;
const replay = {
  buffer: null,
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
  replay.event = 0;
  replay.cell = 0;
  replay.timeline = [0];
  for (const e of game.events) replay.timeline.push(replay.timeline[replay.timeline.length - 1] + eventWeight(e));
}

function applyCells(e, from, to) {
  for (let k = from; k < to; k++) replay.buffer.set(e.cells[k], e.values[k] ? game.colorPixel[e.values[k] - 1] : WHITE);
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

export function openTimelapse() {
  if (!game.canvas || !game.events.length) return toast(t("empty"));
  commitStroke();
  $("#timelapse").hidden = false;
  replay.stopped = false;
  resetReplay();
  seek(1);
  const view = $("#timelapse-canvas");
  const c = outputCanvas(480);
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

$("#tl-video").onclick = async () => {
  if (!window.MediaRecorder) return toast("MediaRecorder?");
  replay.stopped = true;
  const total = durationMs();
  const out = outputCanvas(1080);
  const mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) =>
    MediaRecorder.isTypeSupported(m),
  );
  const recorder = new MediaRecorder(out.captureStream(30), { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const finished = new Promise((resolve) => (recorder.onstop = resolve));
  setBusy(true, t("vid"));
  resetReplay();
  drawFrame(out);
  recorder.start();
  const start = performance.now();
  await new Promise((resolve) => {
    const frame = () => {
      const f = Math.min(1, (performance.now() - start) / total);
      seek(f);
      drawFrame(out);
      if (f < 1) requestAnimationFrame(frame);
      else setTimeout(resolve, 600); // hold the last frame a moment
    };
    frame();
  });
  recorder.stop();
  await finished;
  setBusy(false);
  download(new Blob(chunks, { type: mime.split(";")[0] }), "timelapse." + (mime.includes("mp4") ? "mp4" : "webm"));
};

/* ---------- GIF ---------- */

/**
 * Appends one GIF frame (graphic control + image descriptor + LZW image data) to bytes.
 * frame: Uint8Array of color indices into the global 216-color "web safe" palette. delay in 1/100 s.
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

$("#tl-gif").onclick = async () => {
  replay.stopped = true;
  const FPS = 10;
  const frames = $("#tl-duration").value * FPS;
  const out = outputCanvas(480);
  const { width: w, height: h } = out;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  // header + logical screen + 256-entry global palette (6x6x6 color cube) + loop forever
  const header = [71, 73, 70, 56, 57, 97, w & 255, w >> 8, h & 255, h >> 8, 0xf7, 0, 0];
  for (let i = 0; i < 256; i++)
    header.push(i < 216 ? ((i / 36) | 0) * 51 : 0, i < 216 ? (((i / 6) | 0) % 6) * 51 : 0, i < 216 ? (i % 6) * 51 : 0);
  header.push(33, 255, 11, ..."NETSCAPE2.0".split("").map((c) => c.charCodeAt()), 3, 1, 0, 0, 0);
  const chunks = [new Uint8Array(header)];
  setBusy(true, "GIF");
  resetReplay();
  for (let i = 1; i <= frames; i++) {
    seek(i / frames);
    drawFrame(out);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const indices = new Uint8Array(w * h);
    for (let j = 0; j < indices.length; j++) {
      const p = j * 4;
      indices[j] = Math.round(rgba[p] / 51) * 36 + Math.round(rgba[p + 1] / 51) * 6 + Math.round(rgba[p + 2] / 51);
    }
    const bytes = [];
    encodeGifFrame(bytes, indices, w, h, i === frames ? 250 : 100 / FPS);
    chunks.push(new Uint8Array(bytes));
    if (i % 4 === 0) {
      setBusyText("GIF " + Math.round((i / frames) * 100) + "%");
      await yieldToBrowser();
    }
  }
  chunks.push(new Uint8Array([59]));
  setBusy(false);
  download(new Blob(chunks, { type: "image/gif" }), "timelapse.gif");
};
