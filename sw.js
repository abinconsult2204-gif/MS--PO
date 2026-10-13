// Offline support: keeps the app files on the phone so it opens without internet.
const CACHE = 'ms-po-v1.0.1';
const FILES = ['./', './index.html', './styles.css', './config.js', './db.js', './pdf.js', './app.js', './manifest.webmanifest',
  './jspdf.umd.min.js', './jspdf.plugin.autotable.min.js', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // server calls go straight to the network
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;   // show cached copy instantly; refresh it in the background
  }));
});
