/* Service worker: app-shell caching + Web Share Target handling.
   Shared files are written to the IndexedDB outbox BEFORE responding,
   so a marked-up document is never lost even if the app closes. */
importScripts('js/db.js');

const CACHE = 'atp-v5';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/db.js',
  'js/transfer.js',
  'js/main.js',
  'vendor/peerjs.min.js',
  'vendor/qrcode.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Android share target: intercept the POST, queue the files durably, bounce back to the app.
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(event));
    return;
  }

  if (event.request.method !== 'GET') return;

  // Network-first for the app shell so updates land, cache fallback for offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })
        .then((cached) => cached || caches.match('index.html')))
  );
});

async function handleShareTarget(event) {
  try {
    const formData = await event.request.formData();
    const files = formData.getAll('file');
    // Shared files go to whichever peer is currently selected in the app.
    const target = await self.ATPDB.kvGet('activePeer') || null;
    for (const file of files) {
      if (!(file instanceof File)) continue;
      await self.ATPDB.add('outbox', {
        id: crypto.randomUUID(),
        name: file.name || 'shared-document',
        mime: file.type || 'application/octet-stream',
        size: file.size,
        blob: file,
        target,
        addedAt: Date.now(),
      });
    }
    // Nudge any open window to refresh its queue and start sending.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.postMessage('outbox-updated');
  } catch (e) {
    // Even on error, land the user in the app rather than an error page.
  }
  return Response.redirect('./?shared=1', 303);
}
