// Web Worker: runs the pixelization off the main thread so the interface never freezes.
//
// Messages in:
//   { type: "source", key, data, width, height }      cropped photo pixels (sent once per crop)
//   { type: "generate", id, params, adjust }           build a canvas
//   { type: "suggest", id, params, adjust }            find a good number of colors
// Messages out:
//   { type: "progress", id, value }
//   { type: "done", id, result }   /   { type: "cancelled", id }   /   { type: "error", id, message }
//
// Only the newest job matters: when a new job arrives, the running one notices on its next pause and stops.
import { generate, suggestColorCount } from "./engine.js";

let source = null;
let latestJob = 0;

const pauseFor = (id) => () => new Promise((resolve) => setTimeout(() => resolve(id === latestJob)));

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "source") {
    source = { key: msg.key, data: msg.data, width: msg.width, height: msg.height };
    return;
  }
  const id = msg.id;
  latestJob = id;
  const hooks = {
    pause: pauseFor(id),
    progress: (value) => self.postMessage({ type: "progress", id, value }),
  };
  try {
    if (!source) throw new Error("no source image");
    if (msg.type === "generate") {
      const result = await generate(source, msg.params, msg.adjust, hooks);
      if (!result) return self.postMessage({ type: "cancelled", id });
      self.postMessage({ type: "done", id, result }, [result.idx.buffer, result.pal.buffer]);
    } else if (msg.type === "suggest") {
      const result = await suggestColorCount(source, msg.params, msg.adjust, hooks);
      self.postMessage({ type: "done", id, result });
    }
  } catch (err) {
    if (id !== latestJob) return self.postMessage({ type: "cancelled", id });
    self.postMessage({ type: "error", id, message: String((err && err.message) || err) });
  }
};
