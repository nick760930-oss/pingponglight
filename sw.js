// PingPongLight service worker: offline support for the static site.
const CACHE = 'ppl-v29';
const PRECACHE = [
  './',
  'index.html',
  'songs.js',
  'game.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'credits.html',
  'privacy.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('ppl-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isPageRequest(req, url) {
  return req.mode === 'navigate'
    || url.pathname.endsWith('/')
    || url.pathname.endsWith('/index.html');
}

// Network first; fall back to cache when offline.
function networkFirst(req) {
  return fetch(req)
    .then((res) => {
      if (res.status !== 200) return res;
      return caches.open(CACHE)
        .then((cache) => cache.put(req, res.clone()))
        .catch(() => {})
        .then(() => res);
    })
    .catch(() => caches.match(req, { ignoreSearch: true })
      .then((hit) => hit || caches.match('index.html')));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Instrument samples never change: cache first (also keeps them available offline)
  if (url.pathname.includes('/inst/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.status === 200) { const c = res.clone(); caches.open(CACHE).then((cache) => cache.put(req, c)).catch(() => {}); }
      return res;
    })));
    return;
  }
  // Network first for everything (always the latest deploy online); the cache is the offline fallback.
  if (isPageRequest(req, url)) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(fetch(req).then((res) => {
      if (res.status === 200) { const c = res.clone(); caches.open(CACHE).then((cache) => cache.put(req, c)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req)));
  }
});
