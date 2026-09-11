/* ============================================================
   SYGENOP — Service Worker (PWA) : rend l'application chargeable
   et utilisable hors-ligne après une première visite.
   Stratégie : cache-first pour les assets (app shell), network-first
   avec fallback cache pour les requêtes API.
   ============================================================ */
const CACHE = 'sygenop-v4';
const APP_SHELL = ['/', '/index.html', '/homme.png', '/femme.png'];

// Installation : pré-cache du shell de l'application.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// Activation : nettoie les anciens caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch : assets en cache-first, API en network-first (avec fallback cache).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ne pas intercepter les requêtes non-GET ni les origines tierces (Supabase, fonts…)
  if (event.request.method !== 'GET') return;

  // API Supabase : network-first puis cache.
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(event.request).then((m) => m || Response.error()))
    );
    return;
  }

  // Assets de l'application : network-first (toujours servir la version la
  // plus récente quand on est en ligne ; le cache ne sert qu'en secours hors
  // ligne). Évite que les mises à jour (avatars, code…) soient invisibles.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(event.request).then((m) => m || Response.error()))
    );
    return;
  }

  // Autres (fonts, etc.) : cache-first opportuniste.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

