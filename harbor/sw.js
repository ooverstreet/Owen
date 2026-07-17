const CACHE = 'harbor-v5';
const URLS  = [
  '/Owen/harbor/',
  '/Owen/harbor/index.html',
  '/Owen/harbor/manifest.json',
  '/Owen/harbor/icon.svg',
  '/Owen/harbor/config.js',
  '/Owen/harbor/db.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(URLS.map(u => c.add(u)))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isAppShell = e.request.mode === 'navigate'
    || url.pathname.endsWith('/harbor/')
    || url.pathname.endsWith('/harbor/index.html')
    || url.pathname.endsWith('/harbor/config.js')
    || url.pathname.endsWith('/harbor/db.js');

  // Always prefer network for app shell so phones don't stick on old Harbor builds
  if (isAppShell) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('/Owen/harbor/index.html')))
    );
    return;
  }

  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
    if (res && res.status === 200 && res.type === 'basic') {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
    }
    return res;
  }).catch(() => caches.match('/Owen/harbor/index.html'))));
});
