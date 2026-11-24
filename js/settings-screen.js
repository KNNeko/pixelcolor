// Settings screen: one row per setting, plus backup export/import.
import { $, showScreen, translatePage, syncFullscreen, download, setBusy, yieldToBrowser, toast } from "./ui.js";
import { t } from "./i18n.js";
import {
  settings,
  saveSettings,
  applyAppTheme,
  upgradeSettings,
  CANVAS_THEMES,
  SILHOUETTE_THEMES,
} from "./settings.js";
import { exportBackup, importBackup, requestPersistence } from "./storage.js";
import { refreshLibrary, renderSortOptions, clearThumbCache } from "./library.js";
import { restartAutosave } from "./game.js";
import { openColorPicker, colorButtonHtml } from "./colorpicker.js";
import { totalsHtml } from "./stats.js";

/** Picking a custom color also switches its theme select to "custom", so the color is actually used. */
const COLOR_SELECT = { ccl: ["ct", "cusl"], ccd: ["ct", "cusd"], sic: ["sit", "cus"] };

// [key, kind, options]: kind = toggle | select | color; a plain string starts a group (its title's key)
const ROWS = [
  "g_look",
  ["lang", "select", ["en", "ru"]],
  ["ap", "select", ["sys", "light", "dark"]],
  ["ct", "select", CANVAS_THEMES],
  ["ccl", "color"],
  ["ccd", "color"],
  ["sil", "toggle"],
  ["sit", "select", SILHOUETTE_THEMES],
  ["sic", "color"],
  ["grid", "toggle"],
  ["mini", "toggle"],
  ["hall", "toggle"],
  ["full", "toggle"],
  "g_paint",
  ["slide", "toggle"],
  ["two", "toggle"],
  ["dbl", "toggle"],
  ["bonly", "toggle"],
  ["hl", "toggle"],
  ["aim", "select", [0, 1, 2, 3]],
  ["hide", "toggle"],
  ["oth", "toggle"],
  ["wrong", "toggle"],
  ["vib", "toggle"],
  "g_app",
  ["asv", "select", [1, 2, 5]],
  ["gl", "toggle"],
];

const NUMERIC = ["asv", "aim"]; // selects whose value is stored as a number
const optionLabel = (key, v) =>
  key === "lang" ? { en: "English", ru: "Русский" }[v] : key === "asv" ? v : key === "aim" ? t("aim_" + v) : t(v);

function renderSettings() {
  const list = $("#settings-list");
  list.innerHTML = "";
  for (const entry of ROWS) {
    if (typeof entry === "string") {
      const title = document.createElement("h3");
      title.className = "settings-group";
      title.textContent = t(entry);
      list.append(title);
      continue;
    }
    const [key, kind, options] = entry;
    const row = document.createElement("div");
    row.className = "row";
    const control =
      kind === "toggle"
        ? `<label class="toggle"><input type="checkbox" ${settings[key] ? "checked" : ""}><i></i></label>`
        : kind === "select"
          ? `<select>${options.map((v) => `<option value="${v}" ${settings[key] == v ? "selected" : ""}>${optionLabel(key, v)}</option>`).join("")}</select>`
          : colorButtonHtml("set-" + key, settings[key]);
    row.innerHTML = `<span>${t(key)}</span>${control}`;
    if (kind === "color") {
      row.querySelector(".color-btn").onclick = () =>
        openColorPicker({
          value: settings[key],
          title: t(key),
          onDone: (hex) => {
            settings[key] = hex;
            const [selectKey, value] = COLOR_SELECT[key] || [];
            if (selectKey) settings[selectKey] = value;
            saveSettings();
            renderSettings();
          },
        });
      list.append(row);
      continue;
    }
    const input = row.querySelector("input,select");
    input.onchange = () => {
      settings[key] = kind === "toggle" ? +input.checked : NUMERIC.includes(key) ? +input.value : input.value;
      saveSettings();
      if (key === "lang") {
        translatePage();
        renderSortOptions();
        renderSettings();
        refreshLibrary();
      }
      if (key === "ap") applyAppTheme();
      if (key === "asv") restartAutosave();
      if (key === "full") syncFullscreen(true);
    };
    list.append(row);
  }
  list.append(statsRow(), backupRow());
}

/** Lifetime statistics, folded away until tapped. */
function statsRow() {
  const row = document.createElement("details");
  row.className = "row stats-row";
  row.innerHTML = `<summary>${t("st_title")}</summary>${totalsHtml()}`;
  return row;
}

function backupRow() {
  const row = document.createElement("div");
  row.className = "row wrap";
  row.innerHTML =
    `<span class="full-width">${t("pst")}: <b data-persist>…</b></span>` +
    `<button class="chip" data-export>${t("exp")}</button><button class="chip" data-import>${t("imp")}</button>` +
    `<input type="file" accept=".json,application/json" hidden>`;
  requestPersistence().then((ok) => (row.querySelector("[data-persist]").textContent = t(ok ? "pst1" : "pst0")));
  row.querySelector("[data-export]").onclick = async () => {
    setBusy(true);
    await yieldToBrowser();
    try {
      download(await exportBackup(settings), `pixel-color-backup-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e) {
      toast(String(e));
    }
    setBusy(false);
  };
  const fileInput = row.querySelector("input[type=file]");
  row.querySelector("[data-import]").onclick = () => fileInput.click();
  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    await yieldToBrowser();
    try {
      const saved = await importBackup(file);
      if (saved) {
        Object.assign(settings, saved);
        upgradeSettings(settings);
        if (!saved.tot) settings.tot = null; // a backup from before statistics: count again from the library
        saveSettings();
        applyAppTheme();
        translatePage();
        renderSortOptions();
      }
      toast(t("impd"));
      clearThumbCache();
      refreshLibrary();
      renderSettings();
    } catch (err) {
      toast(t("err") + ": " + (err.message || err));
    }
    setBusy(false);
  };
  return row;
}

$("#btn-settings").onclick = () => {
  renderSettings();
  showScreen("screen-settings");
};
$("#settings-back").onclick = () => showScreen("screen-home");
