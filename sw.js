// Service worker: offline cache (network first, cache as fallback) + "Share to Pixel Color" from the gallery.
const VERSION = "pxc-v17";
const SHARE_CACHE = "pxc-share"; // holds a shared image until the page picks it up
const APP_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./js/main.js",
  "./js/i18n.js",
  "./js/settings.js",
  "./js/ui.js",
  "./js/engine.js",
  "./js/engine.worker.js",
  "./js/colorsort.js",
  "./js/storage.js",
  "./js/render.js",
  "./js/export-png.js",
  "./js/library.js",
  "./js/settings-screen.js",
  "./js/wizard.js",
  "./js/game.js",
  "./js/parts.js",
  "./js/timelapse.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

/** The gallery POSTs the shared file here (see share_target in manifest.webmanifest). */
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const file = form.get("image");
    if (file && file.size) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put("shared-image", new Response(file, { headers: { "Content-Type": file.type || "image/*" } }));
    }
  } catch {
    /* nothing usable was shared: just open the app */
  }
  return Response.redirect("./?share=1", 303);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== "GET") return;
  // cache: "no-cache" = always ask the server whether the file changed (cheap 304 if not).
  // Without it the browser may keep serving old files for ~10 minutes after an update on GitHub Pages.
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html"))),
  );
});
