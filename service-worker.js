
const CACHE_NAME = 'cipex-manager-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://aistudiocdn.com/react-dom@^19.2.1/',
  'https://aistudiocdn.com/react@^19.2.1/',
  'https://aistudiocdn.com/lucide-react@^0.556.0'
];

// Install Event - Cache Files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate Event - Clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

// Fetch Event - Serve from Cache, then Network
self.addEventListener('fetch', (event) => {
  // Skip cross-origin requests specifically for Google Scripts or API calls if needed
  // But generally we try to cache everything for offline first experience
  
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Return cached response if found
      if (cachedResponse) {
        return cachedResponse;
      }

      // Otherwise fetch from network
      return fetch(event.request).then((response) => {
        // Don't cache valid API responses from Google Script to ensure fresh data logic applies
        // But do cache CDN assets
        if (!response || response.status !== 200 || response.type !== 'basic' && !event.request.url.includes('cdn')) {
          return response;
        }

        // Clone response to cache it
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return response;
      });
    })
  );
});
