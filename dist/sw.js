// sw.js - minimal service worker to cache app shell assets for offline usage.
// CACHENAME and assets should be kept in sync with files in /dist

const CACHE_NAME = 'savant-journal-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/crypto.js',
  '/db.js',
  '/qr.js',
  '/exporter.html',
  '/manifest.json',
  'localforage.min.js',   
  'jszip.min.js',
  'qrcode.min.js',
];

// Install - cache app shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS.map(p => new Request(p, { cache: 'reload' })));
    })
  );
});

// Activate - cleanup
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Fetch - network-first for dynamic, cache-first for shell
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // If request is for same-origin and in ASSETS, serve cache-first
  if (ASSETS.includes(url.pathname) || ASSETS.includes(url.pathname + '/')) {
    event.respondWith(caches.match(req).then(resp => resp || fetch(req)));
    return;
  }
  // Otherwise network-first with fallback to cache
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
