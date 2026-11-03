'use strict';

// Speeds up repeat launches (notably the Android app on mobile networks): static files are answered
// from the cache at once and refreshed in the background, so code and assets stop depending on the
// network. API calls, the websocket, federation and private attachments are never touched.
const CACHE = 'mc-static-v1';
const MAX_ENTRIES = 700;
const CACHEABLE = [
  /^\/m\/(?!.*\/api\/)/, /^\/css\//, /^\/js\//, /^\/vendor\//, /^\/lang\//, /^\/assets\//,
  /^\/uploads\/(avatars|servericons|channelicons|roleicons|foldericons|emoji|stickers|sounds)\//,
];
const PRECACHE = ['/m/', '/css/base.css', '/css/auth.css', '/css/chat.css', '/css/modals.css', '/m/css/m.css', '/m/main.js', '/m/boot.js'];

function cacheable(url) {
  return url.origin === self.location.origin && CACHEABLE.some((re) => re.test(url.pathname));
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

async function refresh(request, cache) {
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') {
    await cache.put(request, res.clone());
    trim(cache);
  }
  return res;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(PRECACHE.map((u) => refresh(new Request(u), cache).catch(() => {})))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (!cacheable(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request, { ignoreSearch: false });
    const network = refresh(request, cache);
    if (hit) {
      event.waitUntil(network.catch(() => {}));
      return hit;
    }
    return network;
  })());
});

// The page lists what it already loaded (before this worker took control) so the next launch has it all.
self.addEventListener('message', (event) => {
  const urls = event.data && event.data.precache;
  if (!Array.isArray(urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of urls) {
      const url = new URL(u, self.location.origin);
      if (!cacheable(url) || await cache.match(url.href)) continue;
      await refresh(new Request(url.href), cache).catch(() => {});
    }
  })());
});
