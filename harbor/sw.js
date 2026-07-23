const CACHE = 'harbor-v72';
const URLS  = [
  '/Owen/harbor/',
  '/Owen/harbor/index.html',
  '/Owen/harbor/manifest.json',
  '/Owen/harbor/icon.svg',
  '/Owen/harbor/config.js',
  '/Owen/harbor/db.js',
  '/Owen/harbor/auth.js',
  '/Owen/harbor/angel.js',
  '/Owen/harbor/moderation.js',
  '/Owen/harbor/privacy.html',
  '/Owen/harbor/terms.html',
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

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isAppShell = e.request.mode === 'navigate'
    || url.pathname.endsWith('/harbor/')
    || url.pathname.endsWith('/harbor/index.html')
    || url.pathname.endsWith('/harbor/config.js')
    || url.pathname.endsWith('/harbor/db.js')
    || url.pathname.endsWith('/harbor/auth.js')
    || url.pathname.endsWith('/harbor/angel.js')
    || url.pathname.endsWith('/harbor/moderation.js')
    || url.pathname.endsWith('/harbor/sw.js');

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
