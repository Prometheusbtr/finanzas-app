// App shell cache so the Home Screen app opens fast and shows a clear message without signal.
// F42 (audit Nov 25 2026): each version's shell is stored whole, in one step, when this worker installs, and served
// from that version's cache first. A page therefore always gets one version's files: never a new module next to
// an old one (which broke the module graph and left "Cargando…" up). A deploy that changes any shell file must
// change CACHE; the browser then installs the new set in the background and the next launch opens it.
// deploy.sh and deploy-wave2.sh stop when a shell file differs from the live app under the same CACHE
// (scripts/shell-check.mjs).
// Only the files listed in SHELL are ever stored, so money data (/api), exports and anything else never land in
// the cache.
const CACHE = "fz-shell-v14"; // v14: Análisis total in a solid card; live runs v13
// /import/ (the statement readers) and /vendor/ (pdf.js, the Face ID library) are left out on purpose:
// loaded only on the import screen, or by passkey.js when a Face ID prompt opens.
const MODULES = ["api", "charts", "data", "format", "fx", "i18n", "lock", "look", "motion", "numbers", "passkey", "router", "state", "ui"].map((m) => `/js/${m}.js`)
  .concat(["add", "alertas", "analisis", "cuenta", "extras", "home", "importar", "login", "mas", "movements", "pasos", "personas", "recurrentes",
    "review", "settings", "signup", "tarjetas"].map((m) => `/js/screens/${m}.js`));
const SHELL = ["/", "/app.css", "/app.js", "/theme.js", "/boot-check.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon.svg", "/icons.svg", ...MODULES];
const SHELL_SET = new Set(SHELL);

self.addEventListener("install", (e) => {
  // cache: "reload" skips the browser's HTTP cache, so the set is this deploy's files and nothing older
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const inShell = SHELL_SET.has(url.pathname) && url.search === "";
  // Not a shell file: the browser fetches it normally. Only a page load gets the offline fallback.
  if (!inShell && e.request.mode !== "navigate") return;
  if (!inShell) {
    // a page address that is not the shell (a sign-up or reset link): the network, or the app's page offline
    e.respondWith(fetch(e.request).catch(() => caches.open(CACHE).then((c) => c.match("/")).then((hit) => hit || Response.error())));
    return;
  }
  e.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(url.pathname).then((hit) => {
        if (hit) return hit;
        // not stored (the install did not finish, or "Recargar" cleared it): the network, kept for next time
        return fetch(e.request).then((res) => {
          if (res.ok && !res.redirected && res.type === "basic") e.waitUntil(c.put(url.pathname, res.clone()));
          return res;
        });
      }),
    ),
  );
});

// Funciones (Wave 2): Web Push. The server sends at most one a day: { title, body, open, tag }, with no shop, amount
// or name in it. A tap opens one of a few fixed screens of this app, never an address taken from the payload.
const OPEN = { card: "#/mas/tarjetas", limit: "#/", week: "#/analisis?p=semana", cash: "#/agregar", home: "#/" };
const openKey = (k) => (typeof k === "string" && Object.prototype.hasOwnProperty.call(OPEN, k) ? k : "home");
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {}
  const open = openKey(d && d.open);
  e.waitUntil(
    self.registration.showNotification(text(d && d.title, 120) || "Finanzas", {
      body: text(d && d.body, 300), tag: text(d && d.tag, 32) || "fz", data: { open }, icon: "/icons/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const open = openKey(e.notification.data && e.notification.data.open);
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const win = list.find((c) => new URL(c.url).origin === self.location.origin);
      // An open app keeps its page (and its Face ID unlock): it is told which screen to show (js/screens/alertas.js).
      if (win) return win.focus().then((w) => (w || win).postMessage({ type: "fz-open", open }));
      return self.clients.openWindow("/" + OPEN[open]);
    }),
  );
});
