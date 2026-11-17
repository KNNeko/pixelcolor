// Web Worker: applies the «Настройка» adjustments to the preview off the main thread, so sliders and zoom
// gestures stay smooth while a large preview is recalculated.
//
// Message in and out: { data, width, height, adjust, ... } — the pixels come back adjusted, with the time it
// took in ms; any other fields are passed back unchanged.
import { applyAdjustments } from "./engine.js";

self.onmessage = (e) => {
  const job = e.data;
  const start = performance.now();
  applyAdjustments(job.data, job.width, job.height, job.adjust);
  job.ms = performance.now() - start;
  self.postMessage(job, [job.data.buffer]);
};
