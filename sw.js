// Offline support: keeps a copy of the app (and the Supabase library) on the phone,
// so the app still opens at a venue with no data. Live data is not cached here —
// app.js keeps its own saved copy of each tournament.
const CACHE = 'hankook-shell-v1';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.json', 'logo.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// the app sends the library files it loaded before this helper was running
self.addEventListener('message', (e) => {
  const urls = (e.data && e.data.cacheUrls) || [];
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(urls.map((u) => c.match(u).then((hit) => hit || c.add(u).catch(() => {}))))));
});

// give up on the network after a few seconds — a crowded venue often hangs instead of failing
const fetchWithTimeout = (req, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), ms);
  fetch(req).then((r) => { clearTimeout(t); resolve(r); }, (err) => { clearTimeout(t); reject(err); });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isLib = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !isLib) return; // Supabase API calls go straight to the network

  // library (fixed version on the CDN): saved copy first, network only the first time
  if (isLib) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // our own files: try the network briefly (so updates show up), otherwise the saved copy
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(
    fetchWithTimeout(req, 3500)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
        return res;
      })
      .catch(async () => (await caches.match(key, { ignoreSearch: true })) || Response.error()),
  );
});
