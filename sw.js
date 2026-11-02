/* GVSMARTPAY — service worker PWA (agar bisa dipasang & dibuka seperti aplikasi) */
const V='gvsp-v4',SHELL=['/','/manifest.webmanifest','/icon-192.png','/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).catch(()=>{}));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
  if(u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
  if(r.mode==='navigate'){e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(V).then(h=>h.put('/',c));return x}).catch(()=>caches.match('/')));return}
  e.respondWith(caches.match(r).then(h=>h||fetch(r).then(x=>{if(x.ok){const c=x.clone();caches.open(V).then(k=>k.put(r,c))}return x})));
});
self.addEventListener('notificationclick',e=>{e.notification.close();let url=(e.notification.data&&e.notification.data.url)||'/';try{const u=new URL(url,self.location.origin);url=u.origin===self.location.origin?u.pathname+u.search+u.hash:'/'}catch(x){url='/'}
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus' in c){try{c.postMessage({go:url})}catch(x){}return c.focus()}}return self.clients.openWindow?self.clients.openWindow(url):null}))});
