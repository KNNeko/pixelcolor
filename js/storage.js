// IndexedDB storage.
//
// Database "pxc3", version 2. Object stores:
//   p   canvases  { id, fid, name, W, H, mode, pal, idx, done, parts:[{id,n}], pm }   (pixel data, rarely rewritten)
//   m   library   { id, name, W, H, pct, done, fid, ts }  or folders { id, folder:1, name, ts }   (small, listed often)
//   ev  events    { id, seq, cells: Int32Array, values: Uint16Array }   one record per paint action, append-only
//   th  thumbnails{ id, main, parts:[...] }   Blob (new) or data-URL string (migrated), loaded lazily
//
// Version 1 kept events inside "p" and thumbnails inside "m", so every autosave rewrote everything and
// opening the library loaded every thumbnail. The upgrade below moves them out without losing anything.
//
// The short field names (W, pal, pm, fid...) are what is already on disk; toCanvas/toMeta translate
// them into readable names for the rest of the app.

const DB_NAME = "pxc3";
const DB_VERSION = 2;
const CANVASES = "p";
const LIBRARY = "m";
const EVENTS = "ev";
const THUMBS = "th";

const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = (e) => {
    const db = req.result;
    const tx = req.transaction;
    if (e.oldVersion < 1) {
      db.createObjectStore(CANVASES, { keyPath: "id" });
      db.createObjectStore(LIBRARY, { keyPath: "id" });
    }
    if (e.oldVersion < 2) {
      db.createObjectStore(EVENTS, { keyPath: ["id", "seq"] });
      db.createObjectStore(THUMBS, { keyPath: "id" });
      if (e.oldVersion >= 1) migrateFromV1(tx);
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

function migrateFromV1(tx) {
  const events = tx.objectStore(EVENTS);
  const thumbs = tx.objectStore(THUMBS);
  tx.objectStore(CANVASES).openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    const rec = cursor.value;
    if (rec.ev) {
      rec.ev.forEach((ev, seq) => events.put({ id: rec.id, seq, cells: ev.c, values: ev.n }));
      delete rec.ev;
      cursor.update(rec);
    }
    cursor.continue();
  };
  tx.objectStore(LIBRARY).openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    const rec = cursor.value;
    if (rec.thumbs) {
      thumbs.put({ id: rec.id, main: rec.thumbs[0], parts: rec.thumbs.slice(1) });
      delete rec.thumbs;
      cursor.update(rec);
    }
    cursor.continue();
  };
}

/** Runs fn(tx) in a transaction; resolves with fn's request result (if it returned one) when the transaction commits. */
async function run(stores, mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const req = fn(tx);
    tx.oncomplete = () => resolve(req && "result" in req ? req.result : undefined);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const eventRange = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);

/* ---------- format translation ---------- */

function toCanvas(rec) {
  return {
    id: rec.id,
    folderId: rec.fid || "",
    name: rec.name,
    width: rec.W,
    height: rec.H,
    mode: rec.mode, // "n" = numbers, "s" = silhouette only
    palette: rec.pal, // RGB bytes, 3 per color
    target: rec.idx, // palette index of every cell
    done: !!rec.done,
    parts: (rec.parts || []).map((p) => ({ id: p.id, name: p.n })),
    partOf: rec.pm || null, // part id of every cell (0 = no part)
  };
}

function fromCanvas(c) {
  return {
    id: c.id,
    fid: c.folderId || "",
    name: c.name,
    W: c.width,
    H: c.height,
    mode: c.mode,
    pal: c.palette,
    idx: c.target,
    done: c.done ? 1 : 0,
    parts: c.parts.map((p) => ({ id: p.id, n: p.name })),
    pm: c.parts.length ? c.partOf : null,
  };
}

function toMeta(rec) {
  if (rec.folder) return { id: rec.id, folder: true, name: rec.name, updated: rec.ts };
  return {
    id: rec.id,
    name: rec.name,
    width: rec.W,
    height: rec.H,
    progress: rec.pct || 0,
    done: !!rec.done,
    folderId: rec.fid || "",
    updated: rec.ts,
  };
}

function fromMeta(m) {
  if (m.folder) return { id: m.id, folder: 1, name: m.name, ts: m.updated };
  return {
    id: m.id,
    name: m.name,
    W: m.width,
    H: m.height,
    pct: m.progress,
    done: m.done,
    fid: m.folderId,
    ts: m.updated,
  };
}

/* ---------- library ---------- */

/** All library entries (canvases and folders). Small records only: no pixels, no thumbnails. */
export async function listLibrary() {
  const all = await run([LIBRARY], "readonly", (tx) => tx.objectStore(LIBRARY).getAll());
  return all.map(toMeta);
}

export const putLibraryEntry = (meta) =>
  run([LIBRARY], "readwrite", (tx) => tx.objectStore(LIBRARY).put(fromMeta(meta)));

export async function getThumbs(id) {
  return (await run([THUMBS], "readonly", (tx) => tx.objectStore(THUMBS).get(id))) || null;
}

export async function setFolder(ids, folderId) {
  await run([CANVASES, LIBRARY], "readwrite", (tx) => {
    for (const id of ids)
      for (const name of [CANVASES, LIBRARY]) {
        const store = tx.objectStore(name);
        const get = store.get(id);
        get.onsuccess = () => {
          if (!get.result) return;
          get.result.fid = folderId;
          store.put(get.result);
        };
      }
  });
}

export async function renameCanvas(id, name) {
  await run([CANVASES, LIBRARY], "readwrite", (tx) => {
    for (const storeName of [CANVASES, LIBRARY]) {
      const store = tx.objectStore(storeName);
      const get = store.get(id);
      get.onsuccess = () => {
        if (!get.result) return;
        get.result.name = name;
        store.put(get.result);
      };
    }
  });
}

export async function deleteCanvas(id) {
  await run([CANVASES, LIBRARY, EVENTS, THUMBS], "readwrite", (tx) => {
    tx.objectStore(CANVASES).delete(id);
    tx.objectStore(LIBRARY).delete(id);
    tx.objectStore(THUMBS).delete(id);
    tx.objectStore(EVENTS).delete(eventRange(id));
  });
}

export const deleteFolderEntry = (id) => run([LIBRARY], "readwrite", (tx) => tx.objectStore(LIBRARY).delete(id));

/* ---------- canvases ---------- */

/** Full canvas plus its paint events: { canvas, events: [{cells, values}] }. */
export async function loadCanvas(id) {
  let rec;
  let events;
  await run([CANVASES, EVENTS], "readonly", (tx) => {
    const a = tx.objectStore(CANVASES).get(id);
    a.onsuccess = () => (rec = a.result);
    const b = tx.objectStore(EVENTS).getAll(eventRange(id));
    b.onsuccess = () => (events = b.result);
  });
  if (!rec) throw new Error("canvas not found");
  return { canvas: toCanvas(rec), events: events.map((e) => ({ cells: e.cells, values: e.values })) };
}

/**
 * Saves a canvas.
 *   events, savedCount  only events[savedCount..] are written (append-only log)
 *   rewriteEvents       delete the stored log first and write all events (after a reset)
 *   writeCanvas         also rewrite the big pixel record (only when parts/mode/name/done changed)
 *   meta                small library entry (always written)
 *   thumbs              { main, parts } Blobs, optional
 * Returns how many events are now stored.
 */
export async function saveCanvas({ canvas, writeCanvas, meta, events, savedCount = 0, rewriteEvents, thumbs }) {
  const stores = [LIBRARY, EVENTS];
  if (writeCanvas) stores.push(CANVASES);
  if (thumbs) stores.push(THUMBS);
  let written = 0; // counted inside the transaction: events added while it runs are saved next time
  await run(stores, "readwrite", (tx) => {
    written = events.length;
    const store = tx.objectStore(EVENTS);
    let from = savedCount;
    if (rewriteEvents) {
      store.delete(eventRange(canvas.id));
      from = 0;
    }
    for (let seq = from; seq < written; seq++)
      store.put({ id: canvas.id, seq, cells: events[seq].cells, values: events[seq].values });
    if (writeCanvas) tx.objectStore(CANVASES).put(fromCanvas(canvas));
    tx.objectStore(LIBRARY).put(fromMeta(meta));
    if (thumbs) tx.objectStore(THUMBS).put({ id: canvas.id, main: thumbs.main, parts: thumbs.parts });
  });
  return written;
}

/* ---------- persistence permission ---------- */

export async function requestPersistence() {
  try {
    const s = navigator.storage;
    if (s && s.persist) return (await s.persisted()) || (await s.persist());
  } catch {
    /* unsupported */
  }
  return false;
}

/* ---------- backup ---------- */
// JSON file. Typed arrays become { $: "Uint8Array", b: base64 }, Blob thumbnails become data URLs.
// Format v2: { app, v: 2, settings, canvases: [db record + ev], library: [...], thumbs: [...] }
// Format v1 (old app): { app, v: 1, st, p: [record with ev:[{c,n}]], m: [entry with thumbs] }

const TYPED_ARRAYS = { Uint8Array, Uint16Array, Int32Array, Uint32Array, Float32Array };

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 30000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 30000));
  return btoa(s);
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export async function exportBackup(settings) {
  const getAll = (name) => run([name], "readonly", (tx) => tx.objectStore(name).getAll());
  const [canvases, library, events, thumbs] = await Promise.all([
    getAll(CANVASES),
    getAll(LIBRARY),
    getAll(EVENTS),
    getAll(THUMBS),
  ]);
  const byCanvas = new Map();
  for (const e of events) {
    if (!byCanvas.has(e.id)) byCanvas.set(e.id, []);
    byCanvas.get(e.id)[e.seq] = { c: e.cells, n: e.values };
  }
  for (const rec of canvases) rec.ev = (byCanvas.get(rec.id) || []).filter(Boolean);
  const toUrl = (v) => (v instanceof Blob ? blobToDataUrl(v) : v);
  for (const th of thumbs) {
    th.main = await toUrl(th.main);
    th.parts = await Promise.all((th.parts || []).map(toUrl));
  }
  const json = JSON.stringify({ app: "pxc", v: 2, settings, canvases, library, thumbs }, (key, value) =>
    ArrayBuffer.isView(value)
      ? {
          $: value.constructor.name,
          b: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
        }
      : value,
  );
  return new Blob([json], { type: "application/json" });
}

/** Imports a v1 or v2 backup file. Returns the settings stored in it (or null). */
export async function importBackup(file) {
  const data = JSON.parse(await file.text(), (key, value) => {
    if (!value || typeof value !== "object" || typeof value.$ !== "string") return value;
    const Type = TYPED_ARRAYS[value.$];
    if (!Type) throw new Error("Unknown data type in backup: " + value.$);
    return new Type(Uint8Array.from(atob(value.b), (c) => c.charCodeAt(0)).buffer);
  });
  if (data.app !== "pxc") throw new Error("Not a backup file");

  let canvases;
  let library;
  let thumbs;
  if (data.v === 2) {
    ({ canvases, library, thumbs } = data);
  } else {
    canvases = data.p;
    library = data.m;
    thumbs = [];
    for (const m of library)
      if (m.thumbs) {
        thumbs.push({ id: m.id, main: m.thumbs[0], parts: m.thumbs.slice(1) });
        delete m.thumbs;
      }
  }
  if (!canvases || !library) throw new Error("Not a backup file");

  await run([CANVASES, LIBRARY, EVENTS, THUMBS], "readwrite", (tx) => {
    for (const rec of canvases) {
      const events = rec.ev || [];
      delete rec.ev;
      tx.objectStore(CANVASES).put(rec);
      tx.objectStore(EVENTS).delete(eventRange(rec.id));
      events.forEach((e, seq) => tx.objectStore(EVENTS).put({ id: rec.id, seq, cells: e.c, values: e.n }));
    }
    for (const m of library) tx.objectStore(LIBRARY).put(m);
    for (const th of thumbs || []) tx.objectStore(THUMBS).put(th);
  });
  return data.settings || data.st || null;
}
