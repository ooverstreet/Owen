const CACHE = 'crypto-signal-v1';
const URLS  = ['/Owen/crypto/','/Owen/crypto/index.html','/Owen/crypto/manifest.json','/Owen/crypto/icon.svg'];
self.addEventListener('install', e=>{e.waitUntil(caches.open(CACHE).then(c=>Promise.allSettled(URLS.map(u=>c.add(u)))));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  // Don't cache Binance API calls — always fetch live
  if(e.request.url.includes('binance.com')||e.request.url.includes('unpkg.com'))return;
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
