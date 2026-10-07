// Settings screen: one row per setting, plus backup export/import.
import { $, showScreen, translatePage, syncFullscreen, download, setBusy, yieldToBrowser, toast } from "./ui.js";
import { t } from "./i18n.js";
import { settings, saveSettings, applyAppTheme } from "./settings.js";
import { exportBackup, importBackup, requestPersistence } from "./storage.js";
import { refreshLibrary, renderSortOptions, clearThumbCache } from "./library.js";
import { restartAutosave } from "./game.js";

// [key, kind, options]: kind = toggle | select | color
const ROWS = [
  ["lang", "select", ["en", "ru"]],
  ["ap", "select", ["sys", "light", "dark"]],
  ["ct", "select", ["cw", "clg", "gl1", "gl2", "cd", "cb", "gd1", "gd2", "cus"]],
  ["cc", "color"],
  ["hide", "toggle"],
  ["slide", "toggle"],
  ["two", "toggle"],
  ["hl", "toggle"],
  ["dbl", "toggle"],
  ["sil", "toggle"],
  ["sit", "select", ["sg", "se", "sb", "sm", "sr", "sv", "cus"]],
  ["sic", "color"],
  ["oth", "toggle"],
  ["mini", "toggle"],
  ["vib", "toggle"],
  ["wrong", "toggle"],
  ["grid", "toggle"],
  ["asv", "select", [1, 2, 5]],
  ["full", "toggle"],
];

const optionLabel = (key, v) => (key === "lang" ? { en: "English", ru: "Русский" }[v] : key === "asv" ? v : t(v));

function renderSettings() {
  const list = $("#settings-list");
  list.innerHTML = "";
  for (const [key, kind, options] of ROWS) {
    const row = document.createElement("div");
    row.className = "row";
    const control =
      kind === "toggle"
        ? `<label class="toggle"><input type="checkbox" ${settings[key] ? "checked" : ""}><i></i></label>`
        : kind === "select"
          ? `<select>${options.map((v) => `<option value="${v}" ${settings[key] == v ? "selected" : ""}>${optionLabel(key, v)}</option>`).join("")}</select>`
          : `<input type="color" value="${settings[key]}">`;
    row.innerHTML = `<span>${t(key)}</span>${control}`;
    const input = row.querySelector("input,select");
    input.onchange = () => {
      settings[key] = kind === "toggle" ? +input.checked : key === "asv" ? +input.value : input.value;
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
  list.append(backupRow());
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
