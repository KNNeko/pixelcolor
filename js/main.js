// Entry point: wires the screens together and starts the app.
import { $, $$, toast, translatePage, syncFullscreen, initRangeSlider } from "./ui.js";
import { t } from "./i18n.js";
import { applyAppTheme } from "./settings.js";
import { requestPersistence } from "./storage.js";
import { refreshLibrary, renderSortOptions } from "./library.js";
import { startWizard, translateWizard, redrawWizard } from "./wizard.js";
import { game, saveGame, handleResize } from "./game.js";
import "./settings-screen.js";
import "./timelapse.js";

/* ---------- errors are shown instead of failing silently ---------- */
window.onerror = (message, file, line) => toast(`${t("err")}: ${message} @${line}`);
addEventListener("unhandledrejection", (e) => toast(t("err") + ": " + ((e.reason && e.reason.message) || e.reason)));

/* ---------- saving when the app goes to the background ---------- */
addEventListener("visibilitychange", () => document.hidden && saveGame(true));
addEventListener("pagehide", () => saveGame(false));

/* ---------- after unlocking the phone some browsers show a blank canvas: redraw everything ---------- */
function wake() {
  if (document.hidden) return;
  if (game.canvas && game.buffer && $("#screen-play").classList.contains("on")) {
    game.buffer.markAll();
    handleResize();
  }
  redrawWizard();
  const root = document.documentElement;
  root.style.transform = "translateZ(0)";
  requestAnimationFrame(() => (root.style.transform = ""));
}
for (const ev of ["visibilitychange", "pageshow", "focus", "fullscreenchange", "orientationchange"])
  addEventListener(ev, () => {
    wake();
    setTimeout(wake, 150);
    setTimeout(wake, 600);
  });

/* ---------- fullscreen + storage permission need a user gesture ---------- */
addEventListener(
  "pointerup",
  () => {
    syncFullscreen(false);
    requestPersistence();
  },
  { once: true, capture: true },
);

/* ---------- photo shared from the gallery ("Share -> Pixel Color") ----------
   The service worker receives the shared file, keeps it in the "pxc-share" cache and
   redirects here with ?share=1. */
async function takeSharedImage() {
  if (!new URLSearchParams(location.search).has("share")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("pxc-share");
    const response = await cache.match("shared-image");
    if (!response) return;
    const blob = await response.blob();
    await cache.delete("shared-image");
    await startWizard(blob);
  } catch {
    toast(t("share_err"));
  }
}

/* ---------- boot ---------- */
$$(".range").forEach(initRangeSlider);
applyAppTheme();
translatePage();
translateWizard();
renderSortOptions();
refreshLibrary().catch((e) => toast(String(e)));
takeSharedImage();
matchMedia("(prefers-color-scheme:dark)").addEventListener?.("change", applyAppTheme);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
