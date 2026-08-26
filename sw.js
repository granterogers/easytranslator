// App-shell service worker. Only caches this app's own static files so the
// UI and saved history stay usable offline; translation requests always go
// straight to the network (never cached, never intercepted here).
//
// Strategy is network-first with `cache: 'no-store'` for every shell file:
// when online, each launch always fetches the current files straight from
// GitHub Pages (bypassing the HTTP cache too, not just the SW cache) so a
// new deploy is picked up immediately. The cache is purely an offline
// fallback for when the network is unreachable.
//
// Keep APP_VERSION in sync with js/version.js (this file can't import it —
// it runs as a classic worker script, not a module) — bump both on deploy.
const APP_VERSION = '1.11.2';
const CACHE_PREFIX = 'translate-history-v';
const CACHE_NAME = `${CACHE_PREFIX}${APP_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/main.js',
  './js/db.js',
  './js/api.js',
  './js/version.js',
  './js/transliterate.js',
  './js/dictionary.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Only ever delete OUR OWN old versioned caches — never touch a
      // Cache Storage entry that doesn't start with our own prefix, in
      // case something else on the origin ever uses Cache Storage too.
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch the translation API

  const isNavigation = request.mode === 'navigate';

  event.respondWith(
    fetch(request, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then((cached) => cached || (isNavigation ? caches.match('./index.html') : undefined)))
  );
});
