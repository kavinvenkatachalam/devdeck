// devdeck as an installed app. It's live-only: every request goes to the Mac, nothing is served from a cache, except
// one page: opening the app while the Mac can't be reached (asleep, devdeck stopped, Tailscale off) shows offline.html
// instead of the browser's error. Bump the cache name when offline.html or its icon change.
const CACHE = 'devdeck-offline-1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/offline.html', '/icons/icon-192.png'])));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return; // straight to the network, as without a service worker
  e.respondWith(fetch(e.request).catch(async () => (await caches.match('/offline.html')) || Response.error()));
});
