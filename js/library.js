// Home screen: canvases and folders, search, sorting, canvas actions.
// Thumbnails live in their own store and are loaded only when a card scrolls into view.
import {
  $,
  icon,
  PAW_SVG,
  openSheet,
  closeSheet,
  actionButton,
  confirmDialog,
  promptText,
  setBusy,
  toast,
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
} from "./storage.js";
import { renderThumbnails } from "./render.js";
import { openGame } from "./game.js";
import { startSplitMode } from "./parts.js";
import { openTimelapse } from "./timelapse.js";
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
      if (entry) thumbsOf(entry).then((rec) => (img.src = urlFor(rec.main)));
    }
  },
  { rootMargin: "300px" },
);

const lazyImg = (entry) => `<img data-thumb="${entry.id}" alt="">`;

/* ---------- list ---------- */

export async function refreshLibrary() {
  const all = await listLibrary();
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
    card.innerHTML = `${lazyImg(entry)}<b></b><span>${Math.floor(entry.progress * 100)}%</span>${entry.done ? `<i class="paw">${PAW_SVG}</i>` : ""}`;
    card.querySelector("b").textContent = entry.name;
    card.onclick = () => openCanvasMenu(entry);
    grid.append(card);
  }
  grid.querySelectorAll("img[data-thumb]").forEach((img) => lazyLoader.observe(img));
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
      `<span class="muted">${entry.width}×${entry.height} · ${Math.floor(entry.progress * 100)}% ${t("pct")}</span>` +
      `<div class="actions">` +
      actionButton("play", "cont", "act-continue") +
      actionButton("film", "tlapse", "act-timelapse") +
      actionButton("split", "split", "act-split") +
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
  sheet.querySelector("#act-split").onclick = async () => {
    closeSheet();
    await openStored(entry.id);
    startSplitMode();
  };
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
          meta: { ...entry, progress: 0, done: false, updated: Date.now() },
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
