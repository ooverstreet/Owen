const CACHE = 'freq-simon-v1';
const URLS  = ['/Owen/simon/','/Owen/simon/index.html','/Owen/simon/manifest.json','/Owen/simon/icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c=>Promise.allSettled(URLS.map(u=>c.add(u))))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => { if(e.request.method!=='GET')return; e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{ if(res&&res.status===200&&res.type==='basic'){const c=res.clone();caches.open(CACHE).then(cache=>cache.put(e.request,c));} return res; }).catch(()=>caches.match('/Owen/simon/index.html')))); });
