// "Export PNG" sheet: every cell becomes an exact N x N block, so the image stays sharp at any zoom.
import { openSheet, closeSheet, setBusy, download, toast, yieldToBrowser } from "./ui.js";
import { t } from "./i18n.js";
import { renderPng, maxCellSize } from "./render.js";

const CELL_SIZES = [1, 4, 8, 16, 32, 64];

export function openPngExport(canvas, paint) {
  const limit = maxCellSize(canvas);
  const sizes = CELL_SIZES.filter((s) => s <= limit);
  if (!sizes.includes(limit) && limit < 64) sizes.push(limit);
  // default: about 2000 px on the long side
  let cellSize = sizes.reduce((best, s) =>
    Math.abs(s * Math.max(canvas.width, canvas.height) - 2000) <
    Math.abs(best * Math.max(canvas.width, canvas.height) - 2000)
      ? s
      : best,
  );
  let finished = true;
  let grid = false;

  const sheet = openSheet(
    `<b>${t("png")}</b>` +
      `<div class="chips segmented" data-group="mode"><button class="chip" data-mode="1">${t("png_full")}</button><button class="chip" data-mode="0">${t("png_prog")}</button></div>` +
      `<span class="hint">${t("png_cell")}</span>` +
      `<div class="chips" data-group="size">${sizes.map((s) => `<button class="chip" data-size="${s}">${s}</button>`).join("")}</div>` +
      `<label class="check-row"><span>${t("png_grid")}</span><label class="toggle"><input type="checkbox" data-grid><i></i></label></label>` +
      `<span class="hint" data-dims></span>` +
      `<button class="btn" data-save>${t("png_save")}</button>`,
  );
  const refresh = () => {
    sheet.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", +b.dataset.mode === +finished));
    sheet.querySelectorAll("[data-size]").forEach((b) => b.classList.toggle("on", +b.dataset.size === cellSize));
    sheet.querySelector("[data-dims]").textContent = `${canvas.width * cellSize} × ${canvas.height * cellSize} px`;
  };
  refresh();
  sheet.onclick = (e) => {
    const b = e.target.closest("[data-mode],[data-size]");
    if (!b) return;
    if (b.dataset.mode != null) finished = b.dataset.mode === "1";
    else cellSize = +b.dataset.size;
    refresh();
  };
  sheet.querySelector("[data-grid]").onchange = (e) => (grid = e.target.checked);
  sheet.querySelector("[data-save]").onclick = async () => {
    closeSheet();
    setBusy(true);
    await yieldToBrowser();
    try {
      const blob = await renderPng(canvas, paint, { cellSize, finished, grid });
      download(blob, `${canvas.name.replace(/[^\w\u0400-\u04ff ×-]+/g, "_")}${finished ? "" : "-progress"}.png`);
    } catch (err) {
      toast(String(err));
    }
    setBusy(false);
  };
}
