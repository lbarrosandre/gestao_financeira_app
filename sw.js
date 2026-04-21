/* =====================================================
   BÚSSOLA — Service Worker v1.4
   Altere CACHE_VERSION a cada deploy para forçar
   atualização automática no celular.
   ===================================================== */

const CACHE_VERSION = 'bussola-v1.5';

const CACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-64.png',
  './icon-192.png',
  './icon-512.png'
];

/* INSTALL: abre novo cache e já sinaliza skip */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(CACHE_ASSETS))
      .then(() => self.skipWaiting()) // assume controle imediatamente
  );
});

/* ACTIVATE: apaga caches antigos e assume todos os clientes */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim()) // controla todas as abas abertas
  );
});

/* FETCH: network-first para HTML (sempre busca versão nova),
   cache-first para assets estáticos */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Ignora requisições não-GET e externas (Google Fonts etc.)
  if (event.request.method !== 'GET') return;
  if (!url.origin.startsWith(self.location.origin.split('/')[0])) {
    // Permite fonts/CDN passar direto sem cache
    if (url.hostname !== self.location.hostname) return;
  }

  // Navegação (HTML): sempre tenta rede primeiro
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          // Atualiza cache com resposta nova
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Assets: cache-first com fallback para rede
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
        }
        return resp;
      });
    })
  );
});

/* MENSAGEM: permite a página pedir reload manual */
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
