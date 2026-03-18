// MuDi Service Worker — PWA offline support
const CACHE = 'mudi-v1';
const PRECACHE = ['/', '/login'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache API, socket.io, transfer routes
  if (url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/transfer') ||
      url.pathname.startsWith('/api') ||
      url.pathname.startsWith('/auth')) {
    return;
  }
  // Network first for HTML, cache first for assets
  if (e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/'))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }))
    );
  }
});
