const CACHE = 'chess-io-v4';          // Increment version to force update
const ASSETS = [
  '/',
  '/index.html',                      // or '/main.html' – match your actual file name
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/assets/capture.mp3',
  '/assets/castle.mp3',
  '/assets/chat.mp3',
  '/assets/clock-low.mp3',
  '/assets/game-end.mp3',
  '/assets/game-start.mp3',
  '/assets/move.mp3',
  '/assets/move-check.mp3',
  '/assets/promote.mp3',
  '/assets/move-illegal.mp3',
  '/assets/move-opponent.mp3'
];

// Install – cache core files (fail gracefully)
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      return Promise.all(
        ASSETS.map(url => cache.add(url).catch(err => console.warn(`Failed to cache ${url}:`, err)))
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate – clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch – network first, fall back to cache (but never cache 206 responses)
self.addEventListener('fetch', e => {
  // Skip socket.io and non-GET requests
  if (e.request.url.includes('socket.io') || e.request.method !== 'GET') return;

  // Avoid range requests (they return 206 Partial Content)
  const isRangeRequest = e.request.headers.has('Range');

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Only cache complete, successful responses (status 200) and skip range requests
        if (!isRangeRequest && res.status === 200 && res.type !== 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then(cache => {
            cache.put(e.request, copy).catch(err => console.warn('Cache put failed:', err));
          });
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});