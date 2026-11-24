// Home screen: canvases and folders, search, sorting, canvas actions.
// Thumbnails live in their own store and are loaded only when a card scrolls into view.
import {
  $,
  icon,
  PAW_PATH,
  openSheet,
  closeSheet,
  actionButton,
  confirmDialog,
  promptText,
  setBusy,
  toast,
  createCanvas,
} from "./ui.js";
import { t } from "./i18n.js";
import { settings, saveSettings } from "./settings.js";
import {
  listLibrary,
  putLibraryEntry,
  getThumbs,
  loadCanvas,
  saveCanvas,
  renameCanvas,
  deleteCanvas,
  setFolder,
  deleteFolderEntry,
  getSource,
  setColorStats,
} from "./storage.js";
import { startWizard } from "./wizard.js";
import { renderThumbnails } from "./render.js";
import { openGame } from "./game.js";
import { openTimelapse } from "./timelapse.js";
import { ensureTotals, canvasStatsHtml, emptyStats } from "./stats.js";
import { openPngExport } from "./export-png.js";

export const library = { folderId: "", search: "" };

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const SORTS = {
  rec: (a, b) => b.updated - a.updated,
  new: (a, b) => b.id - a.id, // ids are creation timestamps
  nm: byName,
  pr: (a, b) => b.progress - a.progress || b.updated - a.updated,
};

/* ---------- thumbnails (lazy) ---------- */

// id -> { updated, record } ; record = { main, parts } as stored (Blob or data URL string)
const thumbCache = new Map();

/** Forget cached thumbnails (after importing a backup, which may replace them). */
export function clearThumbCache() {
  for (const { record } of thumbCache.values()) [record.main, ...(record.parts || [])].forEach(forgetUrl);
  thumbCache.clear();
}
const objectUrls = new Map(); // Blob -> object URL (so each Blob gets one URL)

function urlFor(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (!objectUrls.has(value)) objectUrls.set(value, URL.createObjectURL(value));
  return objectUrls.get(value);
}

async function thumbsOf(entry) {
  const cached = thumbCache.get(entry.id);
  if (cached && cached.updated === entry.updated) return cached.record;
  const record = (await getThumbs(entry.id)) || { main: null, parts: [] };
  if (cached) [cached.record.main, ...(cached.record.parts || [])].forEach(forgetUrl);
  thumbCache.set(entry.id, { updated: entry.updated, record });
  return record;
}

function forgetUrl(value) {
  if (value instanceof Blob && objectUrls.has(value)) {
    URL.revokeObjectURL(objectUrls.get(value));
    objectUrls.delete(value);
  }
}

const entriesById = new Map();
const lazyLoader = new IntersectionObserver(
  (items) => {
    for (const item of items) {
      if (!item.isIntersecting) continue;
      const img = item.target;
      lazyLoader.unobserve(img);
      const entry = entriesById.get(img.dataset.thumb);
      if (!entry) continue;
      if (entry.done) img.onload = () => inkStamp(img);
      thumbsOf(entry).then((rec) => (img.src = urlFor(rec.main)));
    }
  },
  { rootMargin: "300px" },
);

const lazyImg = (entry) => `<img data-thumb="${entry.id}" alt="">`;

/*
 * A finished canvas gets a stamp in its picture's corner: a paw in a double ring, in the app's accent ink,
 * tilted a few degrees (every canvas its own way), with slightly worn edges and gaps in the ink like a real
 * rubber stamp.
 * The wear comes from SVG noise filters, a few variants so stamps side by side differ. The ink is the dark
 * accent on a light corner and the light one on a dark corner (see inkStamp).
 */
const STAMP_FILTERS = 4;
document.body.insertAdjacentHTML(
  "beforeend",
  `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${[...Array(STAMP_FILTERS).keys()]
    .map(
      (n) =>
        `<filter id="stamp-ink-${n}" x="-8%" y="-8%" width="116%" height="116%">` +
        // ragged edges: the outline pushed about by fine noise
        `<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="${n * 7 + 3}" result="edge"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="edge" scale="1.6" xChannelSelector="R" yChannelSelector="G" result="ragged"/>` +
        // patchy ink: coarser noise turned into an alpha mask with some light spots and a few gaps
        `<feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="3" seed="${n * 11 + 5}" result="ink"/>` +
        `<feColorMatrix in="ink" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -3.4 0 0 0 2.75" result="mask"/>` +
        `<feComposite in="ragged" in2="mask" operator="in"/></filter>`,
    )
    .join("")}</svg>`,
);
/** A number from a canvas id that stays the same every time (the stamp's tilt and wear). */
function idHash(id) {
  let h = 2166136261;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
const stampHtml = (entry) => {
  const h = idHash(entry.id);
  const tilt = -4 + (h % 8); // degrees: -4..3, nearly straight
  // a third of the picture's width, but not more than about 60% of its height (wide pictures); in plain
  // percentages, which every browser knows
  const side = Math.min(33, 62 / (entry.width / entry.height || 1));
  return (
    `<i class="stamp" style="width:${side.toFixed(1)}%;--tilt:${tilt}deg"><svg viewBox="0 0 100 100">` +
    `<g filter="url(#stamp-ink-${(h >> 8) % STAMP_FILTERS})" fill="none" stroke="currentColor">` +
    `<circle cx="50" cy="50" r="45" stroke-width="6"/><circle cx="50" cy="50" r="36.5" stroke-width="2"/>` +
    `<path d="${PAW_PATH}" fill="currentColor" stroke="none" transform="translate(50 52) scale(2.35) translate(-16 -16)"/>` +
    `</g></svg></i>`
  );
};

/** Picks the stamp's ink by how light the picture is under it, once the thumbnail has loaded. */
function inkStamp(img) {
  const stamp = img.nextElementSibling;
  if (!stamp || !img.naturalWidth) return;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const side = Math.min(0.33 * w, 0.62 * h); // as in stampHtml
  const probe = createCanvas(8, 8);
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, w - side, h - side, side, side, 0, 0, 8, 8);
  const d = ctx.getImageData(0, 0, 8, 8).data;
  // the ink that differs more from what is under it, on average (luma of the two inks: 27 and 203)
  let dark = 0;
  let light = 0;
  for (let i = 0; i < d.length; i += 4) {
    const L = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    dark += Math.abs(L - 27);
    light += Math.abs(L - 203);
  }
  stamp.classList.toggle("light-ink", light > dark);
}

/** The card's picture: kept in its own proportions inside the card's frame, so the stamp sits on its corner. */
const cardPicture = (entry) =>
  `<div class="thumb"><div class="pic" style="--ar:${(entry.width / entry.height || 1).toFixed(4)}">${lazyImg(entry)}${entry.done ? stampHtml(entry) : ""}</div></div>`;

/** "12% · 34/180 colors": progress, then finished colors / all colors. */
const statsText = (entry) =>
  `${Math.floor(entry.progress * 100)}%` + (entry.colors ? ` · ${entry.colorsDone}/${entry.colors} ${t("clr")}` : "");

/* ---------- color counters for canvases saved before they were stored ---------- */

const statsQueue = [];
let statsRunning = false;
async function fillMissingStats() {
  if (statsRunning) return;
  statsRunning = true;
  while (statsQueue.length) {
    const entry = statsQueue.shift();
    try {
      const { canvas, events } = await loadCanvas(entry.id);
      const paint = paintFromEvents(canvas, events);
      const left = new Uint32Array(canvas.palette.length / 3);
      for (let i = 0; i < paint.length; i++) if (paint[i] !== canvas.target[i] + 1) left[canvas.target[i]]++;
      entry.colors = left.length;
      entry.colorsDone = left.reduce((n, v) => n + (v === 0), 0);
      await setColorStats(entry.id, entry.colors, entry.colorsDone);
      const span = document.querySelector(`.card[data-id="${entry.id}"] > span`);
      if (span) span.textContent = statsText(entry);
    } catch {
      /* canvas vanished meanwhile: nothing to count */
    }
    await new Promise((resolve) => setTimeout(resolve, 30)); // keep the home screen responsive
  }
  statsRunning = false;
}

/* ---------- list ---------- */

export async function refreshLibrary() {
  const all = await listLibrary();
  ensureTotals(all);
  const query = library.search.trim().toLowerCase();
  const folders = all.filter((m) => m.folder);
  const canvases = all.filter((m) => !m.folder);
  entriesById.clear();
  canvases.forEach((m) => entriesById.set(m.id, m));
  if (library.folderId && !folders.some((f) => f.id === library.folderId)) library.folderId = "";

  const shown = canvases
    .filter((m) => (query ? m.name.toLowerCase().includes(query) : m.folderId === library.folderId))
    .sort(SORTS[settings.so] || SORTS.rec);
  const shownFolders = (
    library.folderId ? [] : folders.filter((f) => !query || f.name.toLowerCase().includes(query))
  ).sort(byName);

  const grid = $("#library-grid");
  const crumb = $("#folder-crumb");
  grid.innerHTML = "";
  crumb.innerHTML = "";
  const currentFolder = folders.find((f) => f.id === library.folderId);
  if (currentFolder) {
    crumb.innerHTML = `<button class="chip" data-up>${icon("back")}<span></span></button><button class="icon-btn" data-menu>${icon("more")}</button>`;
    crumb.querySelector("span").textContent = currentFolder.name;
    crumb.querySelector("[data-up]").onclick = () => {
      library.folderId = "";
      refreshLibrary();
    };
    crumb.querySelector("[data-menu]").onclick = () => openFolderMenu(currentFolder);
  }
  $("#library-empty").hidden = all.length > 0;

  for (const folder of shownFolders) {
    const inside = canvases.filter((m) => m.folderId === folder.id).sort(SORTS.rec);
    const preview = inside.slice(0, 4);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      `<div class="folder-thumb${preview.length ? " preview" : ""}">` +
      (preview.length ? preview.map(lazyImg).join("") + "<i></i>".repeat(4 - preview.length) : icon("folder")) +
      `</div><b></b><span>${inside.length} ${t("itm")}</span><button class="icon-btn card-menu">${icon("more")}</button>`;
    card.querySelector("b").textContent = folder.name;
    card.querySelector(".card-menu").onclick = (e) => {
      e.stopPropagation();
      openFolderMenu(folder);
    };
    card.onclick = () => {
      library.folderId = folder.id;
      refreshLibrary();
    };
    grid.append(card);
  }
  for (const entry of shown) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = entry.id;
    card.innerHTML = `${cardPicture(entry)}<b></b><span>${statsText(entry)}</span>`;
    card.querySelector("b").textContent = entry.name;
    if (!entry.colors && !statsQueue.some((e) => e.id === entry.id)) statsQueue.push(entry);
    card.onclick = () => openCanvasMenu(entry);
    grid.append(card);
  }
  grid.querySelectorAll("img[data-thumb]").forEach((img) => lazyLoader.observe(img));
  fillMissingStats();
}

export function renderSortOptions() {
  $("#library-search").placeholder = t("srch");
  $("#library-sort").innerHTML = ["rec", "new", "nm", "pr"]
    .map((o) => `<option value="${o}" ${settings.so === o ? "selected" : ""}>${t("o_" + o)}</option>`)
    .join("");
}

$("#library-search").oninput = (e) => {
  library.search = e.target.value;
  refreshLibrary();
};
$("#library-sort").onchange = (e) => {
  settings.so = e.target.value;
  saveSettings();
  refreshLibrary();
};
$("#btn-new-folder").onclick = () =>
  promptText(t("nf"), "", async (name) => {
    await putLibraryEntry({ id: "f" + Date.now(), folder: true, name, updated: Date.now() });
    refreshLibrary();
  });

/* ---------- canvas actions ---------- */

async function openStored(id) {
  setBusy(true);
  try {
    const { canvas, events } = await loadCanvas(id);
    await openGame(canvas, events);
  } catch (e) {
    setBusy(false);
    toast(String(e));
  }
}

function paintFromEvents(canvas, events) {
  const paint = new Uint16Array(canvas.width * canvas.height);
  for (const e of events) for (let k = 0; k < e.cells.length; k++) paint[e.cells[k]] = e.values[k];
  return paint;
}

async function openCanvasMenu(entry) {
  const sheet = openSheet(
    `<div class="carousel"></div><b></b>` +
      `<span class="muted">${entry.width}×${entry.height} · ${statsText(entry)}</span>` +
      canvasStatsHtml(entry.stats, entry) +
      `<div class="actions">` +
      actionButton("play", "cont", "act-continue") +
      actionButton("film", "tlapse", "act-timelapse") +
      (entry.hasSource
        ? actionButton("rot", "recreate", "act-recreate") + actionButton("plus", "copyp", "act-copy")
        : "") +
      actionButton("image", "png", "act-png") +
      actionButton("pen", "ren", "act-rename") +
      actionButton("reset", "reset", "act-reset") +
      actionButton("folder", "mv", "act-move") +
      actionButton("trash", "del", "act-delete", "danger") +
      `</div>`,
  );
  sheet.querySelector("b").textContent = entry.name;
  thumbsOf(entry).then((rec) => {
    sheet.querySelector(".carousel").innerHTML = [rec.main, ...(rec.parts || [])]
      .filter(Boolean)
      .map((v) => `<img src="${urlFor(v)}" alt="">`)
      .join("");
  });

  sheet.querySelector("#act-continue").onclick = () => {
    closeSheet();
    openStored(entry.id);
  };
  sheet.querySelector("#act-timelapse").onclick = async () => {
    closeSheet();
    await openStored(entry.id);
    openTimelapse();
  };
  /** Reopens the stored photo in the wizard with this canvas's settings. */
  const reopen = async (replace) => {
    closeSheet();
    const src = await getSource(entry.id);
    if (!src) return toast(t("err"));
    startWizard(src.image, { state: src.state, replaceId: replace ? entry.id : null, folderId: entry.folderId });
  };
  if (entry.hasSource) {
    sheet.querySelector("#act-recreate").onclick = () => confirmDialog(t("recq"), () => reopen(true));
    sheet.querySelector("#act-copy").onclick = () => reopen(false);
  }
  sheet.querySelector("#act-png").onclick = async () => {
    const { canvas, events } = await loadCanvas(entry.id);
    openPngExport(canvas, paintFromEvents(canvas, events));
  };
  sheet.querySelector("#act-rename").onclick = () =>
    promptText(t("ren"), entry.name, async (name) => {
      await renameCanvas(entry.id, name);
      refreshLibrary();
    });
  sheet.querySelector("#act-reset").onclick = () =>
    confirmDialog(t("resq"), async () => {
      setBusy(true);
      try {
        const { canvas } = await loadCanvas(entry.id);
        canvas.done = false;
        const thumbs = await renderThumbnails(canvas, new Uint16Array(canvas.width * canvas.height));
        await saveCanvas({
          canvas,
          writeCanvas: true,
          meta: { ...entry, progress: 0, colorsDone: 0, done: false, updated: Date.now(), stats: emptyStats() },
          events: [],
          rewriteEvents: true,
          thumbs,
        });
      } catch (e) {
        toast(String(e));
      }
      setBusy(false);
      refreshLibrary();
    });
  sheet.querySelector("#act-move").onclick = () => openMoveDialog(entry);
  sheet.querySelector("#act-delete").onclick = () =>
    confirmDialog(t("delq"), async () => {
      await deleteCanvas(entry.id);
      thumbCache.delete(entry.id);
      refreshLibrary();
    });
}

async function openMoveDialog(entry) {
  const folders = (await listLibrary()).filter((m) => m.folder);
  const sheet = openSheet(`<b>${t("mv")}</b><div class="chips"></div>`);
  const list = sheet.querySelector(".chips");
  const addChoice = (folderId, name, current) => {
    const b = document.createElement("button");
    b.className = "chip" + (current ? " on" : "");
    b.textContent = name;
    b.onclick = async () => {
      await setFolder([entry.id], folderId);
      closeSheet();
      refreshLibrary();
    };
    list.append(b);
  };
  addChoice("", t("root"), !entry.folderId);
  folders.forEach((f) => addChoice(f.id, f.name, entry.folderId === f.id));
  const newFolder = document.createElement("button");
  newFolder.className = "chip";
  newFolder.textContent = "+ " + t("nf");
  newFolder.onclick = () =>
    promptText(t("nf"), "", async (name) => {
      const id = "f" + Date.now();
      await putLibraryEntry({ id, folder: true, name, updated: Date.now() });
      await setFolder([entry.id], id);
      refreshLibrary();
    });
  list.append(newFolder);
}

function openFolderMenu(folder) {
  const sheet = openSheet(
    `<b></b><div class="actions two">${actionButton("pen", "ren", "folder-rename")}${actionButton("trash", "del", "folder-delete", "danger")}</div>`,
  );
  sheet.querySelector("b").textContent = folder.name;
  sheet.querySelector("#folder-rename").onclick = () =>
    promptText(t("ren"), folder.name, async (name) => {
      await putLibraryEntry({ ...folder, name });
      refreshLibrary();
    });
  sheet.querySelector("#folder-delete").onclick = () =>
    confirmDialog(t("fdel"), async () => {
      const inside = (await listLibrary()).filter((m) => m.folderId === folder.id).map((m) => m.id);
      await setFolder(inside, "");
      await deleteFolderEntry(folder.id);
      if (library.folderId === folder.id) library.folderId = "";
      refreshLibrary();
    });
}
