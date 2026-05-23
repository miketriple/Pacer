/* ============================================================
   PACER — sw.js
   Service worker: cache-first for app shell, network for API.
   ============================================================ */

const CACHE = 'pacer-v4';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/utils.js',
  '/pace.js',
  '/timer.js',
  '/cues.js',
  '/manifest.json',
  '/templates.json',
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Barlow+Condensed:wght@300;400;500;600;700&family=Barlow:wght@300;400;500&display=swap',
];

// Install: cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Activate: remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for shell assets, network-first for API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET and API requests (let them go straight to network)
  if (event.request.method !== 'GET' || url.pathname.startsWith('/workouts')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful same-origin and font requests
        if (response.ok && (url.origin === self.location.origin || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com')) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback: return cached index.html for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});