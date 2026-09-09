const VERSION='zombie-shell-v36.1';
const APP_SHELL=['./','./index.html','./style.css?v=36.1','./app.js?v=36.1','./manifest.webmanifest?v=36.1','./zombie-icon-180.png?v=15','./zombie-icon-192.png?v=15','./zombie-icon-512.png?v=15'];
self.addEventListener('install',(event)=>event.waitUntil(caches.open(VERSION).then((cache)=>cache.addAll(APP_SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',(event)=>event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key!==VERSION).map((key)=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',(event)=>{
  if(event.request.method!=='GET')return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request).catch(()=>caches.match('./')));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached)=>cached||fetch(event.request)));
});
