// Service worker: guarda en el dispositivo las páginas, Bootstrap e iconos para abrir casi al instante.
// Las llamadas a Google Apps Script NO se tocan (siempre van a la red).
const CACHE = "licoreria-static-v1";
const PRECACHE = [
  "index.html", "productos.html", "ventas.html", "inventario.html",
  "reportes.html", "caja.html", "app.js", "manifest.json", "icon.svg",
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("script.google.com") || url.hostname.endsWith("googleusercontent.com")) return;

  // Responde con lo guardado y actualiza en segundo plano
  e.respondWith(
    caches.match(req).then(cached => {
      const red = fetch(req).then(res => {
        if (res && (res.ok || res.type === "opaque")) {
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(req, copia));
        }
        return res;
      }).catch(() => cached);
      return cached || red;
    })
  );
});
