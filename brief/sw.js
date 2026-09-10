const CACHE = 'subnet-brief-v21';
const URLS = [
  './', './index.html', './manifest.json', './chain.js',
  './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './snapshot.json'
];

function isAppShell(url) {
  try {
    const p = new URL(url).pathname;
    return p === '/' || p.endsWith('/chain.js') || p.endsWith('/index.html') || p.endsWith('/sw.js') || p.endsWith('/brief/') || p.endsWith('/brief');
  } catch {
    return false;
  }
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(URLS.map(u => c.add(u)))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('metagraph.sh') || url.includes('googleapis') || url.includes('gstatic')) return;
  if (url.startsWith('wss:') || url.includes('opentensor.ai') || url.includes('latent.to') || url.includes('onfinality.io')) return;
  if (isAppShell(url) || url.includes('chain.js')) {
    e.respondWith(
      fetch(new Request(e.request, { cache: 'reload' })).then(r => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
