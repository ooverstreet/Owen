// Car Audio Tuner — Service Worker
const CACHE_NAME = 'car-audio-tuner-v2';

// All paths relative to the GitHub Pages deployment at /Owen/
const SHELL_URLS = [
  '/Owen/',
  '/Owen/index.html',
  '/Owen/manifest.json',
  '/Owen/icon.svg',
  '/Owen/icon-192.png',
  '/Owen/icon-512.png',
  '/Owen/icon-maskable-192.png',
  '/Owen/icon-maskable-512.png',
  '/Owen/privacy.html',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Add what we can; ignore individual failures so install always succeeds
      return Promise.allSettled(SHELL_URLS.map(url => cache.add(url)));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Only handle same-origin GET requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached index for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/Owen/index.html');
        }
      });
    })
  );
});
