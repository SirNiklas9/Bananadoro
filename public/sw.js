// Bananadoro service worker.
//  - Web Push: shows the phase-end ding even when the app is closed.
//  - App-shell cache: the PWA opens (and runs solo, offline) without a network.
//    Bump CACHE on any shell change to invalidate the old cache.
const CACHE = 'bananadoro-v1';
const SHELL = [
  '/',
  '/style.css?v=3.0.0',
  '/auth-ui/styles.css',
  '/auth-ui/index.js',
  '/images/BananadoroLogo.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Navigations: network-first (always fresh online), fall back to the cached
// shell offline. Other same-origin GETs: cache-first with network fallback.
// API calls (/app/*, /auth/*) are never cached — they're live state.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/app/') || url.pathname.startsWith('/auth/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => hit))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'Bananadoro';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/images/BananadoroLogo.png',
    badge: '/images/BananadoroLogo.png',
    tag: 'bananadoro-timer',
    renotify: true,
    data: { mode: data.mode },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) return w.focus(); }
    if (clients.openWindow) return clients.openWindow('/');
  })());
});
