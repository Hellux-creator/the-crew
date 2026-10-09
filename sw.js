// App-shell cache. Bump VERSION whenever you change app files so phones pick up the update.
const VERSION = "thecrew-v19";
const SHELL = ["./", "index.html", "styles.css", "app.js", "geo.js", "store-firebase.js", "store-demo.js", "firebase-config.js", "push-config.js", "manifest.webmanifest", "icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // never cache Firebase or map tiles
  // network first so updates land straight away; cache keeps the app opening with bad signal
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
});

// ---------- notifications ----------
self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: "THE CREW", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || "THE CREW", {
    body: m.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: m.tag || undefined,
    renotify: !!m.tag,
    data: { url: m.url || "./" },
    vibrate: [120, 60, 120],
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { await w.focus(); w.postMessage({ type: "open", url: target }); return; }
    }
    await self.clients.openWindow(target);
  })());
});
