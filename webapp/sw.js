// Service worker: the app works with no signal once it has loaded once.
// Bump VERSION when you deploy so phones pick up the new files.
const VERSION = 'v0.5.0';
const SHELL = `shell-${VERSION}`;
const RUNTIME = 'runtime-v1';   // Leaflet, fonts
const TILES = 'tiles-v1';       // satellite imagery you've looked at
const MAX_TILES = 4000;         // roughly 60–100 MB of imagery

const LOCAL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/db.js', './js/geo.js', './js/gps.js', './js/map.js', './js/stats.js',
  './js/ui.js', './js/config.js', './js/export.js', './js/sg.js', './js/handicap.js', './js/greens.js', './js/scorecards.js', './js/transport.js', './js/share.js', './js/coursemerge.js', './js/holemap.js', './js/capturelog.js',
  './js/views/hole.js', './js/views/card.js', './js/views/stats.js', './js/views/courses.js', './js/views/green.js', './js/views/review.js', './js/views/tracker.js', './js/views/holeart.js', './js/views/capture.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
const REMOTE = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet-rotate@0.2.8/dist/leaflet-rotate.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(LOCAL.map((u) => new Request(u, { cache: 'reload' })));
    const rt = await caches.open(RUNTIME);
    await Promise.all(REMOTE.map((u) => rt.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

let tilePuts = 0;
async function trimTiles() {
  if (++tilePuts % 200) return;
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

async function cacheFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') c.put(req, res.clone());
  return res;
}

// Local files: serve the cached copy straight away, refresh it in the
// background so the next launch gets any update.
async function staleWhileRevalidate(req) {
  const c = await caches.open(SHELL);
  const hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
  return hit ?? (await net) ?? (await c.match('./index.html'));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(staleWhileRevalidate(req));
  } else if (url.hostname === 'server.arcgisonline.com') {
    e.respondWith(cacheFirst(req, TILES).then((r) => { trimTiles(); return r; }).catch(() => new Response('', { status: 504 })));
  } else if (url.hostname === 'unpkg.com' || url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
    e.respondWith(cacheFirst(req, RUNTIME).catch(() => new Response('', { status: 504 })));
  }
});
