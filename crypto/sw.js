const CACHE = 'crypto-signal-v2';
const URLS  = ['/Owen/crypto/','/Owen/crypto/index.html','/Owen/crypto/manifest.json','/Owen/crypto/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(URLS.map(u => c.add(u)))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Never cache third-party live data/scripts
  if (
    e.request.url.includes('api.exchange.coinbase.com') ||
    e.request.url.includes('ws-feed.exchange.coinbase.com') ||
    e.request.url.includes('unpkg.com')
  ) return;

  // Always prefer fresh HTML so UI updates (like exchange + bot controls) appear immediately.
  const isHtml = e.request.mode === 'navigate' || (e.request.headers.get('accept') || '').includes('text/html');
  if (isHtml) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('/Owen/crypto/index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }))
  );
});
